// Grounding — deterministic evidence extraction + claim/evidence overlap check.
//
// Phase A of the "evidence-bound condense" design. Our raw source is the
// LLM's own session transcript, which can be wrong — so before a drafted page is accepted
// we anchor it to evidence that the LLM did NOT author: the structured tool events in the
// .jsonl (which files were actually edited, which shell commands actually ran). Those are
// machine records, not prose, so they cannot be hallucinated.
//
// Two jobs, both deterministic (no LLM, no embeddings — keeps the engine zero-dep):
//   1. collectGroundedFacts — parse tool_use / tool_result events from the same byte window
//      the condenser reads, into a list of fact cards + a raw evidence corpus.
//   2. assessGrounding — check a drafted page body against that evidence. A file path the
//      page asserts but that appears NOWHERE in the evidence is a fabrication signal
//      (the hard gate). Quantitative claims and lexical overlap are reported as advisory
//      signals for calibration, not hard-failed (they are noisier; VERIFY already covers them).
import { createHash } from "node:crypto";
import { readTail } from "./extract.ts";

// A single machine-recorded fact pulled from a tool event. `detail` is human-readable;
// `spanHash` fingerprints the originating raw event line so the fact stays traceable even
// after the transcript rotates away (the excerpt can be persisted into the page footnotes).
export interface GroundedFact {
  kind: "file_touch" | "shell_run" | "check_result" | "vcs_commit";
  detail: string;
  turnRef: string; // session-relative locator (uuid or index)
  spanHash: string; // sha256(raw event line), first 16 hex
}

export interface Evidence {
  facts: GroundedFact[];
  // Raw text of every tool input + tool result in the window. Used as the "supported"
  // corpus for substring checks — it captures ground truth the prose extract omits.
  corpus: string;
}

export interface GroundingReport {
  // Strict-gate signal: file-path tokens the page asserts that are absent from ALL evidence.
  // (Only blocks acceptance when LLMWIKI_GROUNDING_MODE=strict; advisory by default.)
  unsupportedPaths: string[];
  // ADVISORY: numeric/quantitative claims absent from evidence (noisier, logged only).
  unsupportedQuant: string[];
  // ADVISORY: shingle Jaccard overlap of the page body against the evidence (0..1).
  overlap: number;
}

const TOOL_FILE = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function span(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function firstChars(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) : one;
}

// Parse the same byte window the condenser reads (from the watermark to EOF) for the
// claude-jsonl format. Non-claude kinds have no structured tool events here, so they return
// empty evidence and the gate degrades gracefully to checking against the prose extract only.
export function collectGroundedFacts(
  path: string,
  startOffset = 0,
  kind = "claude-jsonl",
): Evidence {
  const facts: GroundedFact[] = [];
  const corpusParts: string[] = [];
  if (kind !== "claude-jsonl") return { facts, corpus: "" };

  let raw: Buffer;
  try {
    ({ raw } = readTail(path, startOffset));
  } catch {
    return { facts, corpus: "" };
  }
  const text = raw.toString("utf-8");

  const seenFile = new Set<string>();
  const seenCmd = new Set<string>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let o: any;
    try {
      o = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const turnRef = String(o.uuid ?? o.timestamp ?? "");
    const content = o.message?.content;
    // Claude messages carry content as EITHER a string (plain user/assistant text) or a list
    // of blocks (tool_use / tool_result / text). String form has no tool events but may name a
    // file the work then touched — keep it in the corpus so the substring check still sees it.
    if (typeof content === "string") {
      if (content) corpusParts.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;

    for (const p of content) {
      if (!p || typeof p !== "object") continue;

      if (p.type === "tool_use") {
        const name = String(p.name ?? "");
        const input = p.input ?? {};
        if (TOOL_FILE.has(name) && typeof input.file_path === "string") {
          corpusParts.push(input.file_path);
          if (!seenFile.has(input.file_path)) {
            seenFile.add(input.file_path);
            facts.push({
              kind: "file_touch",
              detail: `${name.toLowerCase()} ${input.file_path}`,
              turnRef,
              spanHash: span(trimmed),
            });
          }
        } else if (name === "Bash" && typeof input.command === "string") {
          const cmd: string = input.command;
          corpusParts.push(cmd);
          const isCommit = /\bgit\s+commit\b/.test(cmd);
          if (!seenCmd.has(cmd)) {
            seenCmd.add(cmd);
            facts.push({
              kind: isCommit ? "vcs_commit" : "shell_run",
              detail: firstChars(cmd, 120),
              turnRef,
              spanHash: span(trimmed),
            });
          }
        }
      } else if (p.type === "tool_result") {
        // Tool results are ground truth (command output, test counts). Keep their text in the
        // corpus so the page may restate them, and mint a check_result card for test/build-like
        // output so a "77 pass" claim in the page has a structured anchor.
        let rt = "";
        if (typeof p.content === "string") rt = p.content;
        else if (Array.isArray(p.content)) {
          for (const c of p.content) if (c?.type === "text") rt += c.text ?? "";
        }
        if (!rt) continue;
        corpusParts.push(rt);
        // Don't mint a check_result card from an errored tool result — its text ("test failed:
        // ENOENT") would falsely anchor a "tests passed" claim (the fail/pass regex matches both).
        if (!p.is_error && /\b(\d+\s*(pass|fail|passed|failed|error|test)|✓|✗|PASS|FAIL)\b/.test(rt)) {
          facts.push({
            kind: "check_result",
            detail: firstChars(rt, 120),
            turnRef,
            spanHash: span(trimmed),
          });
        }
      }
    }
  }

  return { facts, corpus: corpusParts.join("\n") };
}

// ---- claim/evidence overlap -------------------------------------------------

// File-path-like tokens (the high-precision fabrication signal): a name with a known code/doc
// extension, optionally with a path. Hallucinating a wrong filename is the most common and
// most checkable error class.
const PATH_TOKEN =
  /[\w./@-]*\b[\w-]+\.(ts|tsx|js|jsx|mjs|cjs|py|md|sql|sh|bash|go|rs|json|jsonl|toml|ya?ml|txt|lock|rb|java|kt|c|cpp|h)\b/gi;

// Quantitative claims: a number bound to a unit a summary would assert.
const QUANT_TOKEN =
  /\b\d[\d,.]*\s?(%|x|ms|pass|passed|fail|failed|tests?|pages?|개|건|줄|배|초|점)\b/gi;

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ");
}

function shingles(s: string, n = 3): Set<string> {
  const toks = normalize(s)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= toks.length; i++) out.add(toks.slice(i, i + n).join(" "));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function uniqMatches(re: RegExp, text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(m[0]);
  return [...out];
}

// Strip metadata that is NOT a factual body claim before extracting anchors:
//  - the YAML frontmatter block (title/source/tags — e.g. `source: <transcript>.jsonl` is the
//    page's own provenance pointer, not an assertion about a file the work touched);
//  - footnote definitions (`[^1]: <transcript>.jsonl`), same reason;
//  - URLs and markdown link targets (`](path)`) — citations, not new claims, and a URL path
//    fragment like `.../spec.md` would otherwise read as a fabricated file path.
function stripMetadata(body: string): string {
  let b = body;
  if (b.startsWith("---")) {
    const end = b.indexOf("\n---", 3);
    if (end !== -1) {
      const after = b.indexOf("\n", end + 1);
      b = after !== -1 ? b.slice(after + 1) : "";
    }
  }
  b = b.replace(/^\[\^[^\]]+\]:.*$/gm, ""); // footnote definitions
  return stripLinks(b);
}

function stripLinks(s: string): string {
  return s
    .replace(/https?:\/\/\S+/gi, " ") // bare URLs
    .replace(/\]\([^)]*\)/g, "] "); // markdown link targets [label](target)
}

// Path comparison keys robust to absolute-vs-relative mismatch: a claude tool event stores an
// ABSOLUTE file_path while a wiki page usually writes the RELATIVE one. Compare on the trailing
// path segments (and the bare basename) so `/repo/src/db.ts` and `src/db.ts` match either way.
function pathVariants(p: string): string[] {
  const segs = p
    .replace(/^[./\\]+/, "")
    .split(/[/\\]/)
    .filter(Boolean)
    .map((x) => x.toLowerCase());
  const out = new Set<string>([p.toLowerCase()]);
  if (segs.length) out.add(segs[segs.length - 1]!); // basename
  if (segs.length >= 2) out.add(segs.slice(-2).join("/"));
  if (segs.length >= 3) out.add(segs.slice(-3).join("/"));
  return [...out];
}

// Check a drafted page body against the evidence (prose extract + structured corpus). A path
// or number is "supported" if it (or a path variant) appears anywhere in the evidence
// (case-insensitive). Only unsupported FILE PATHS feed the strict gate; quantitative + lexical
// are advisory. URLs/links are stripped from both sides first (citations, not claims).
export function assessGrounding(pageBody: string, supportText: string): GroundingReport {
  const body = stripMetadata(pageBody);
  const support = stripLinks(supportText);
  const hay = normalize(support);

  // every path variant present anywhere in the evidence
  const supported = new Set<string>();
  for (const sp of uniqMatches(PATH_TOKEN, support)) {
    for (const v of pathVariants(sp)) supported.add(v);
  }

  const unsupportedPaths = uniqMatches(PATH_TOKEN, body).filter(
    (p) => !hay.includes(normalize(p)) && !pathVariants(p).some((v) => supported.has(v)),
  );
  const unsupportedQuant = uniqMatches(QUANT_TOKEN, body).filter(
    (q) => !hay.includes(normalize(q)),
  );
  const overlap = jaccard(shingles(body), shingles(support));

  return {
    unsupportedPaths,
    unsupportedQuant,
    overlap: Math.round(overlap * 1000) / 1000,
  };
}
