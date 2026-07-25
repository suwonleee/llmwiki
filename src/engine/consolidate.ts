// Topic consolidation — fold the per-session log into a living per-concept encyclopedia.
//
// The wiki has two layers on different axes:
//   • the LOG (2_milestone/3_decision/4_insight) — per-session, append-only, immutable
//     work record (built by update.ts / autoupdate.ts).
//   • the TOPIC ENCYCLOPEDIA (5_topic) — per-concept, create-or-update, MERGED in place —
//     the living page for a recurring concept, module, or pattern (built here).
//
// Consolidation is SELECTIVE (the opposite of the log): only durable/recurring concepts get
// a topic page; episodic facts stay in the log. The merge ALWAYS re-grounds from the raw
// transcript and NEVER re-summarizes other wiki pages (wiki→wiki re-derivation drifts).
//
// Safety reuses the log's gate: an independent strong-model VERIFY adjudicates only the
// ADDED claims (so old grounded lines from earlier sessions aren't re-judged), a deterministic
// grounding check rejects fabricated file paths, and lint must be clean. Default is dry-run.
//
// Consolidation keeps its OWN watermark (<repo>/.llmwiki/consolidated.json) so it runs
// independently of the log's capture-queue watermark — the same session can be both logged
// and consolidated without the two passes fighting over one offset.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative as relpath, resolve } from "node:path";
import { llm } from "./claude.ts";
import * as capture from "./capture.ts";
import { WikiIndex } from "./db.ts";
import { render, type Increment } from "./extract.ts";
import { sourceForKind } from "./source.ts";
import { collectGroundedFacts, assessGrounding } from "./grounding.ts";
import { updateReferences } from "./refs.ts";
import { appendLog, ensureSkeleton } from "./update.ts";
import { effectiveKo, getConfig, renderBodyStyleRule, type WikiConfig } from "./config.ts";
import { Linter, type LintIssue, type WikiIndexLike } from "./lint.ts";
import { MODEL_HEAVY, MODEL_LIGHT } from "./models.ts";

// WRITE drafts the merged page (cheap tier); VERIFY adjudicates the added claims (heavy tier,
// independent — same independence guarantee as the log gate). Both env-overridable via models.ts.
export const WRITE_MODEL = MODEL_LIGHT;
export const VERIFY_MODEL = MODEL_HEAVY;

// How many existing topic pages (with bodies) to show the writer so it can choose to merge
// rather than fork a near-duplicate page. Bounded to keep the prompt small at any wiki size.
const TOPIC_CONTEXT_CAP = 24;
const TOPIC_BODY_CAP = 1200; // chars of each existing topic page shown to the writer

// ---- our own watermark (independent of the capture queue) -----------------------------

interface ConsolidatedState {
  [transcriptPath: string]: number; // byte offset consolidated up to
}

function statePath(root: string): string {
  return join(root, ".llmwiki", "consolidated.json");
}

function loadState(root: string): ConsolidatedState {
  try {
    return JSON.parse(readFileSync(statePath(root), "utf-8")) as ConsolidatedState;
  } catch {
    return {};
  }
}

function saveState(root: string, st: ConsolidatedState): void {
  mkdirSync(join(root, ".llmwiki"), { recursive: true });
  writeFileSync(statePath(root), JSON.stringify(st, null, 2), "utf-8");
}

// Sessions this repo has seen whose new bytes have not yet been folded into the topic layer.
function pendingForConsolidation(root: string): { path: string; session: string | null }[] {
  const st = loadState(root);
  return capture.transcriptsForRepo(root).filter((t) => {
    if (!existsSync(t.path)) return false;
    return statSync(t.path).size > (st[t.path] ?? 0);
  });
}

// ---- helpers --------------------------------------------------------------------------

function topicSlug(name: string): string {
  // mirror the log's slug rules: lowercase, collapse non-word runs to '-', keep Hangul.
  const s = (name || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_가-힣]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 48);
}

function topicDir(root: string, cfg: WikiConfig): string {
  return join(root, "docs", "wiki", cfg.topicDir);
}

// Existing topic pages with trimmed bodies, for the writer's merge context.
function existingTopics(idx: WikiIndex, cfg: WikiConfig): { title: string; rel: string; body: string }[] {
  const conn = idx.connect();
  const rows = idx
    .listDocumentsWithContent(conn)
    .filter((d) => String(d.relative_path).includes(`docs/wiki/${cfg.topicDir}/`));
  conn.close();
  return rows.slice(0, TOPIC_CONTEXT_CAP).map((d) => ({
    title: String(d.title || basename(String(d.relative_path))),
    rel: String(d.relative_path),
    body: String(d.content || "").slice(0, TOPIC_BODY_CAP),
  }));
}

// Claim-bearing lines present in the new page but absent from the old page. These are the ONLY
// lines VERIFY/grounding judge on a merge — old lines were grounded by earlier sessions and must
// not be re-adjudicated against this session's (different) extract.
function addedClaims(oldContent: string, newPage: string): string {
  const old = new Set(oldContent.split("\n").map((l) => l.trim()));
  const added: string[] = [];
  for (const raw of newPage.split("\n")) {
    const l = raw.trim();
    if (!l || old.has(l)) continue;
    // only judge body claims (bullets / prose), not frontmatter / footnote defs / headings
    if (/^(---|#|>|\[\^|title:|description:|date:|updated:|tags:|status:|domain:|source:)/.test(l)) continue;
    if (l.length < 8) continue;
    added.push(l);
  }
  return added.join("\n");
}

function incDate(inc: Increment): string {
  for (const t of [...inc.assistants, ...inc.users]) {
    if (t.ts && t.ts.length >= 10) return t.ts.slice(0, 10);
  }
  return "0000-00-00";
}

// ---- prompts (our own; English by the prompts-stay-English convention) ----------------

const WRITE_TOPIC_PROMPT = `You maintain the TOPIC layer of an engineering wiki: one living page per durable concept,
module, or pattern (never per person, never per session). Read the session extract and decide whether it
carries a concept worth a topic page.

SELECT (be strict — most sessions add NOTHING here):
- Promote a concept ONLY if it is durable and likely to recur: a code module, a reusable pattern, a
  named technique, or a concept tied to a decision. Episodic "what happened today" facts do NOT belong here.
- If nothing in this session is a durable concept, output exactly: SKIP

If you DO select a concept, decide MERGE vs NEW against the existing topic pages listed below using
the 5-dimension overlap rubric (ported from compound-engineering's update-vs-create rule — "two
documents about the same problem WILL drift"):
  ①concept/problem ②mechanism/root-cause ③approach/solution ④files/modules touched ⑤operating rule.
- Score overlap against the closest existing page: High = 4-5 dimensions match, Moderate = 2-3, Low = 0-1.
- Judge overlap SEMANTICALLY, across languages: the same concept written in Korean and English is
  the SAME page (High) — never fork a topic per language. On a merge, keep the existing page's
  language for structure and write only the new bullets in the session's language.
- High → MERGE: output the FULL updated page — keep EVERY existing line verbatim, ADD new facts as
  new bullets, each with its own footnote citation. Set MERGE to that page's path.
- Moderate → NEW page (set MERGE to NONE) — the OVERLAP line below flags it for a later
  consolidation review.
- Low/none → NEW page (set MERGE to NONE).

OUTPUT CONTRACT (strict):
- Line 1: \`TOPIC: <concept name>\`
- Line 2: \`MERGE: <existing path from the list, or NONE>\`
- Line 3: \`OVERLAP: <High|Moderate|Low> vs=<closest existing path or NONE> dims=[<matched dimension numbers>]\`
- Then the page, whose VERY NEXT character is \`---\` (YAML frontmatter). No prose before/after, no code fences.
- Frontmatter fields: title, description (one sentence), date (YYYY-MM-DD), updated (YYYY-MM-DD),
  tags ([2+], include \`topic\`), status (ready|draft), domain: topic, source ({transcript_filename}).
- Body: a one-line TL;DR then fact bullets. EVERY new fact bullet ends with a footnote \`[^sN]\`, and the file
  ends with the matching \`[^sN]: {transcript_filename}\` definitions (keep existing ones on a merge).
${renderBodyStyleRule()}
- Ground every NEW claim ONLY in the extract below. Do not invent. Build the merge from the extract — never
  re-summarize the existing page's prose into new claims.
- Write in the SAME language as the extract.

=== EXISTING TOPIC PAGES (for merge) ===
{existing}
=== END EXISTING ===

=== SESSION EXTRACT ===
{extract}
=== END EXTRACT ===

Now output SKIP, or the contract above starting with \`TOPIC:\`:`;

const VERIFY_TOPIC_PROMPT = `You are a strict fact verifier. [EXTRACT] is the raw source of one work session. [ADDED] is the set
of NEW claim lines a wiki topic page wants to add from it. Decide whether every ADDED claim is explicitly
grounded in [EXTRACT].

- If even one ADDED claim is unsupported (absent, exaggerated, or fabricated), list those lines as bullets.
- If every ADDED claim is grounded, output exactly the single word \`VERIFIED\`.

=== EXTRACT ===
{extract}
=== ADDED ===
{added}
=== END ===`;

function fill(t: string, vars: Record<string, string>): string {
  let out = t;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(v);
  return out;
}

function extractPage(text: string): string {
  text = text.trim();
  const fence = text.match(/```(?:markdown|md)?\s*\n(---\n[\s\S]*?)\n```/);
  if (fence) return fence[1]!.trim();
  const m = text.match(/^---[ \t]*$/m);
  if (m && m.index !== undefined) return text.slice(m.index).trim();
  return text;
}

// ---- dry-run candidate surfacing (deterministic, no LLM) -------------------------------

export interface Candidate {
  transcript: string;
  nUsers: number;
  nAssistants: number;
  matchedTopics: string[]; // existing topic pages whose title appears in the session text
}

// Warm /wiki-save calls this to SEE what to consolidate. Pure deterministic: lists pending
// sessions and which existing topic pages their text already mentions (substring on titles).
// The actual concept selection/merge is the strong model's job (warm: the in-session agent).
export function surfaceCandidates(ws: string): Candidate[] {
  const root = resolve(ws);
  const cfg = getConfig(root);
  const idx = new WikiIndex(root);
  const topics = existingTopics(idx, cfg);
  const st = loadState(root);
  const out: Candidate[] = [];
  for (const t of pendingForConsolidation(root)) {
    const kind = capture.getSourceKind(t.path);
    const offset = st[t.path] ?? 0;
    let inc: Increment;
    try {
      inc = sourceForKind(kind).parse(t.path, offset);
    } catch {
      continue;
    }
    const hay = render(inc).toLowerCase();
    const matched = topics
      .filter((tp) => tp.title.length >= 3 && hay.includes(tp.title.toLowerCase()))
      .map((tp) => tp.rel);
    out.push({
      transcript: basename(t.path),
      nUsers: inc.users.length,
      nAssistants: inc.assistants.length,
      matchedTopics: matched,
    });
  }
  return out;
}

// ---- unattended gated merge (the --commit / Phase-2 path) ------------------------------

export async function consolidateOne(
  ws: string,
  transcriptPath: string,
  commit: boolean,
  writeModel: string = WRITE_MODEL,
  verifyModel: string = VERIFY_MODEL,
): Promise<Record<string, any>> {
  const root = resolve(ws);
  const cfg = getConfig(root); // per-repo conventions (configs/ → root file → defaults)
  const ko = effectiveKo(cfg);
  const fn = basename(transcriptPath);
  const st = loadState(root);
  const offset = st[transcriptPath] ?? 0;
  const kind = capture.getSourceKind(transcriptPath);
  const inc = sourceForKind(kind).parse(transcriptPath, offset);
  const minTurns = kind === "plain" ? 1 : 2;
  if (inc.users.length + inc.assistants.length < minTurns) {
    return { transcript: fn, verdict: "skip", reason: ko ? "추출 신호 부족" : "insufficient extract signal" };
  }

  const extractTxt = render(inc);
  const evidence = collectGroundedFacts(transcriptPath, offset, kind);
  const supportText = extractTxt + "\n" + evidence.corpus;

  const idx = new WikiIndex(root);
  const topics = existingTopics(idx, cfg);
  const existingBlock = topics.length
    ? topics.map((t) => `### ${t.title}  (${t.rel})\n${t.body}`).join("\n\n")
    : "(none yet)";

  // 1) WRITE (draft the merged/new page, or SKIP)
  const raw = await llm(
    fill(WRITE_TOPIC_PROMPT, { existing: existingBlock, extract: extractTxt, transcript_filename: fn }),
    writeModel,
  );
  if (raw.startsWith("__ERROR__")) {
    return { transcript: fn, verdict: "fail-write", reason: raw.slice(0, 200) };
  }
  if (/^\s*SKIP\s*$/i.test(raw) || !/TOPIC:/i.test(raw)) {
    if (commit) {
      st[transcriptPath] = inc.newOffset;
      saveState(root, st);
    }
    return { transcript: fn, verdict: "no-topic", new_offset: inc.newOffset };
  }

  const topicName = (raw.match(/^TOPIC:\s*(.+)$/m)?.[1] ?? "").trim();
  const mergeTarget = (raw.match(/^MERGE:\s*(.+)$/m)?.[1] ?? "NONE").trim();
  // Overlap audit line (P0-2): extractPage slices from the first `---`, so this line never
  // leaks into the page. Moderate = same area, different angle → surfaced in the result for
  // the warm sync to queue a consolidation review (not auto-queued: the gap queue's
  // 2-absences auto-close would silently drop it).
  const overlap = (raw.match(/^OVERLAP:\s*(.+)$/m)?.[1] ?? "").trim();
  let page = extractPage(raw);
  if (!page.startsWith("---") || !topicName) {
    return { transcript: fn, verdict: "fail-write", reason: ko ? "출력 계약 위반" : "output-contract violation" };
  }

  // Resolve destination: merge into an existing topic page, else a fresh slug.
  const merging = mergeTarget !== "NONE" && topics.some((t) => t.rel === mergeTarget);
  const dest = merging
    ? join(root, mergeTarget)
    : join(topicDir(root, cfg), `${topicSlug(topicName) || fn.slice(0, 8)}.md`);
  const oldContent = merging && existsSync(dest) ? readFileSync(dest, "utf-8") : "";

  // Only the ADDED lines face the gate (old lines were grounded by their own sessions).
  const added = addedClaims(oldContent, page);
  if (!added.trim()) {
    if (commit) {
      st[transcriptPath] = inc.newOffset;
      saveState(root, st);
    }
    return { transcript: fn, verdict: "no-new-claims", dest: relpath(root, dest), new_offset: inc.newOffset };
  }

  // 2) VERIFY (independent, adversarial — only the added claims)
  const verdict = await llm(fill(VERIFY_TOPIC_PROMPT, { extract: extractTxt, added }), verifyModel);
  const verified = /^VERIFIED[\s.!]*$/.test(verdict.trim().toUpperCase());

  // 3) deterministic grounding on the added claims (fabricated file paths → strict-gate signal)
  const grounding = assessGrounding(added, supportText);
  const groundingStrict =
    (process.env.LLMWIKI_GROUNDING_MODE ?? "advisory").trim().toLowerCase() === "strict";
  const groundedClean = grounding.unsupportedPaths.length === 0;
  const grounded = groundingStrict ? groundedClean : true;

  const result: Record<string, any> = {
    transcript: fn,
    topic: topicName,
    merging,
    overlap, // e.g. "High vs=docs/wiki/5_topic/x.md dims=[1,2,3,4]" — Moderate → consolidation-review candidate
    verdict: verified && grounded ? "verified" : "rejected",
    dest: relpath(root, dest),
    verify_note: verified ? "" : verdict.slice(0, 300),
    new_offset: inc.newOffset,
    grounding: {
      mode: groundingStrict ? "strict" : "advisory",
      unsupported_paths: grounding.unsupportedPaths,
      would_reject: !groundedClean,
    },
  };
  if (!commit) {
    result.dry_run = true;
    return result;
  }

  if (!(verified && grounded)) {
    // omit (do not write); advance our watermark so a bad session isn't retried forever (the raw
    // transcript stays immutable and can be reprocessed after a model/threshold change).
    st[transcriptPath] = inc.newOffset;
    saveState(root, st);
    result.accepted = false;
    return result;
  }

  // accepted → write, register provenance, rebuild this page's edges, lint just this page.
  mkdirSync(join(dest, ".."), { recursive: true });
  // Authorship is read from git, not cached into frontmatter (decision 2026-07-10) — a stamped
  // author goes stale the moment a teammate edits the page, and git is already the truth.
  writeFileSync(dest, page.endsWith("\n") ? page : page + "\n", "utf-8");
  idx.registerTranscript(transcriptPath, inc.sessionId);
  idx.indexAll();
  const conn = idx.connect();
  const destName = basename(dest);
  const doc = idx.listDocumentsWithContent(conn).find((d) => String(d.relative_path).endsWith(destName));
  if (doc) updateReferences(idx, conn, doc, page);
  const [issues] = new Linter(idx as unknown as WikiIndexLike, conn, cfg).run("*", "wiki");
  conn.close();
  const pageErrors: LintIssue[] = issues.filter((i) => i.severity === "error" && i.path.includes(destName));

  if (pageErrors.length) {
    // lint error → roll back the write, omit, advance watermark.
    if (!merging && existsSync(dest)) rmSync(dest);
    idx.indexAll();
    st[transcriptPath] = inc.newOffset;
    saveState(root, st);
    result.verdict = "rejected";
    result.accepted = false;
    result.lint_errors = pageErrors.map((i) => `${i.code}:${i.path}`);
    return result;
  }

  appendLog(
    root,
    "consolidate",
    topicName,
    [
      `${cfg.topicDir}/${destName} ${merging ? (ko ? "(병합)" : "(merged)") : ko ? "(신규)" : "(new)"}`,
      `${ko ? "출처" : "source"}: ${fn}`,
    ],
    incDate(inc),
    cfg,
  );
  st[transcriptPath] = inc.newOffset;
  saveState(root, st);
  result.accepted = true;
  return result;
}

export async function run(
  ws: string,
  commit = false,
  limit = 0,
  writeModel: string = WRITE_MODEL,
  verifyModel: string = VERIFY_MODEL,
): Promise<Record<string, any>[]> {
  const root = resolve(ws);
  const ko = effectiveKo(getConfig(root));
  ensureSkeleton(root); // guarantees docs/wiki/ + topic dir exist (per-repo config)
  if (writeModel === verifyModel) {
    process.stderr.write(
      (ko
        ? `⚠️  WRITE·VERIFY 모델 동일(${writeModel}) — 병합 2차검증이 자기 채점이 됨(독립성 상실).\n`
        : `⚠️  WRITE and VERIFY resolve to the same model (${writeModel}) — the merge verify is self-grading.\n`),
    );
  }
  let pend = pendingForConsolidation(root);
  if (limit) pend = pend.slice(0, limit);
  const out: Record<string, any>[] = [];
  for (const t of pend) {
    out.push(await consolidateOne(root, t.path, commit, writeModel, verifyModel));
  }
  return out;
}
