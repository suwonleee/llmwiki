// Incremental transcript extractor — cheap tier-1 of the 2-tier update.
// Reads a Claude Code session .jsonl from a byte offset (watermark) forward and
// pulls only the signal needed to file-back: user instructions + substantive
// assistant conclusions.
//
// CRITICAL: offsets are BYTE positions. new_offset = start + raw.length must be
// computed on the Buffer (bytes), never on a decoded string (JS strings are UTF-16).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Turn {
  ts: string;
  role: string;
  text: string;
}

export interface Increment {
  users: Turn[];
  assistants: Turn[];
  newOffset: number; // byte offset to persist as the new watermark
  cwd: string | null; // working directory of the session (repo routing key)
  sessionId: string | null;
  /**
   * Git roots of the files this segment MUTATED (root → tool-call count). The routing question a
   * close-out actually asks is "where did the work happen?", and `cwd` cannot answer it: capture
   * buckets by session cwd, so for a session started in an enrolled home (or any ancestor repo)
   * the bucket and the cwd agree BY CONSTRUCTION while every edit went somewhere else — observed
   * 2026-07-27, when a session run from `~` produced three releases in `~/llmwiki-runtime` and
   * nothing in its own extract said so. Mutations only (Edit/Write/…): reads roam everywhere;
   * where you changed files is where the record belongs. Optional — the Claude adapter fills it;
   * adapters that don't simply leave the route check silent.
   */
  touched?: Record<string, number>;
}

// The mutation tools whose file_path names "the work". Read/Grep/Glob roam across repos during
// any investigation and would drown the signal; Bash is a string (unparseable cwd side effects).
const MUTATION_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Nearest ancestor containing `.git` (dir OR file — linked worktrees use a file). Cached. */
function gitRootOf(dir: string, cache: Map<string, string | null>): string | null {
  const seen: string[] = [];
  let d = dir;
  for (;;) {
    const hit = cache.get(d);
    if (hit !== undefined) {
      for (const s of seen) cache.set(s, hit);
      return hit;
    }
    seen.push(d);
    if (existsSync(join(d, ".git"))) {
      for (const s of seen) cache.set(s, d);
      return d;
    }
    const parent = dirname(d);
    if (parent === d) {
      for (const s of seen) cache.set(s, null);
      return null;
    }
    d = parent;
  }
}

// Shared byte-tail read used by every source adapter: read from `startOffset` (the
// watermark) to EOF and report the new watermark. CRITICAL: the new offset is computed on
// the Buffer (bytes), never on a decoded string (JS strings are UTF-16).
export function readTail(path: string, startOffset = 0): { raw: Buffer; newOffset: number } {
  const buf = readFileSync(path);
  const raw = buf.subarray(startOffset); // bytes from watermark → EOF
  return { raw, newOffset: startOffset + raw.length };
}

/**
 * "Long enough to be a conclusion", measured in meaning rather than in characters.
 *
 * A raw character count is a different bar in every script. Hangul and Han carry roughly twice the
 * meaning per character that English does, so one number silently holds CJK sessions to twice the
 * standard — the same distortion turn-context's term weighting already corrects for. Measured on
 * this author's own transcripts (275 Korean assistant messages): 27.6% clear 180, and a further
 * 17.8% sit between 90 and 180. Those are conclusions, dropped for being written densely.
 */
export function substantiveFloor(text: string, minChars: number): number {
  return /[^\x00-\x7F]/.test(text) ? Math.ceil(minChars / 2) : minChars;
}

export function extractIncrement(
  path: string,
  startOffset = 0,
  minChars = 180,
  cap = 700,
): Increment {
  const users: Turn[] = [];
  const assistants: Turn[] = [];
  let cwd: string | null = null;
  let sessionId: string | null = null;
  const touched: Record<string, number> = {};
  const rootCache = new Map<string, string | null>();

  const { raw, newOffset } = readTail(path, startOffset);

  // Split bytes on \n then decode (0x0a never occurs inside a UTF-8 multibyte seq).
  const text = raw.toString("utf-8"); // invalid sequences → U+FFFD (≈ errors="replace")
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    cwd = o.cwd || cwd;
    sessionId = o.sessionId || o.session_id || sessionId;

    // Rows that parse as ordinary turns but are nobody's words. A compact-summary row is the
    // harness's machine-written recap of the previous context window, and a sidechain row belongs
    // to a subagent's thread — its "user" turn is the orchestrator's task prompt. Both would flow
    // downstream into `excerpt --kind judgment`, whose whole promise is "a verbatim HUMAN
    // utterance"; a decision page quoting either would be grounded on something no human said.
    // (Subagent threads live in subagents/ files today, which discovery already excludes — this
    // guard covers the rows older sessions carried inline, and the summary rows every compacted
    // session still carries.)
    if (o.isSidechain === true || o.isCompactSummary === true) continue;

    const typ = o.type;
    const msg = o.message || {};
    const content = msg.content;
    let t = "";
    if (typeof content === "string") {
      t = content;
    } else if (Array.isArray(content)) {
      for (const p of content) {
        if (!p || typeof p !== "object") continue;
        if (p.type === "text") t += p.text ?? "";
        // Collected here, BEFORE the empty-text `continue` below: a tool_use-only assistant row
        // carries no text at all, which is exactly the row the route signal lives in.
        else if (p.type === "tool_use" && MUTATION_TOOLS.has(p.name)) {
          const fp = p.input && typeof p.input === "object" ? p.input.file_path : null;
          if (typeof fp === "string" && fp.startsWith("/")) {
            const root = gitRootOf(dirname(fp), rootCache);
            if (root) touched[root] = (touched[root] ?? 0) + 1;
          }
        }
      }
    }
    t = t.split(/\s+/).filter(Boolean).join(" ").trim();
    if (!t) continue;
    const ts = String(o.timestamp ?? "").slice(0, 16);

    if (typ === "user") {
      if (t.startsWith("<") || t.slice(0, 40).includes("system-reminder")) continue;
      users.push({ ts, role: "user", text: t.slice(0, cap) });
    } else if (typ === "assistant") {
      if (t.length >= substantiveFloor(t, minChars)) {
        assistants.push({ ts, role: "assistant", text: t.slice(0, cap) });
      }
    }
  }

  return { users, assistants, newOffset, cwd, sessionId, touched };
}

export function render(inc: Increment): string {
  // English labels: this rendered extract is embedded in the (English) WRITE prompt and shown
  // by `update-next`; keeping it language-neutral matches the prompts-stay-English policy.
  const lines = [`=== user utterances (instructions): ${inc.users.length} ===`];
  for (const t of inc.users) lines.push(`[${t.ts}] ${t.text}`);
  lines.push(`\n=== assistant substantive conclusions: ${inc.assistants.length} ===`);
  for (const t of inc.assistants) lines.push(`\n[${t.ts}] ${t.text}`);
  return lines.join("\n");
}
