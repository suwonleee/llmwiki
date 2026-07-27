// review — generative/semantic wiki health check (the judgment half of lint).
//
// Deterministic `llmwiki lint` covers STRUCTURE. The semantic half is bigger:
// cross-page contradictions, stale claims, missing-concept pages, missing cross-references
// and suggested next questions. That needs a model, not a regex.
//
// ADVISORY ONLY: review never edits existing pages. It emits a report (default: print;
// --commit writes docs/wiki/0_review/semantic-review-<date>.md, status: draft) for a
// human to act on. Single WRITE pass (no VERIFY second model).
import { getConfig, isRepoKorean, renderBodyStyleRule } from "./config.ts";
import { today as todayLocal } from "./today.ts";
import { createHash } from "node:crypto";
import { basename, join, relative as relpath, resolve } from "node:path";
import { UNAVAILABLE, llm, llmAvailable, screenOutbound } from "./claude.ts";
import { WikiIndex, type DocRow } from "./db.ts";
import { appendLog } from "./update.ts";
import { MODEL_HEAVY } from "./models.ts";
import { ensureRepoDir, readRepoFile, repoFileExists, writeRepoFile } from "./repo-write.ts";

// review is the JUDGMENT half (semantic lint + grounding adjudication). It is the place
// where real judgment is needed, so it runs on the heavy tier (strongest model): deterministic
// `lint` stays cheap/zero-cost (runs every sync), and the expensive model call lives here,
// on demand. Env-overridable via LLMWIKI_MODEL_HEAVY — see models.ts.
export const MODEL = MODEL_HEAVY;
export const EXCERPT_CHARS = 500; // body excerpt per page, bounded — enough to spot claims

// P1-A2: bound the single-pass review input so the prompt can't overflow as the wiki grows
// (the ~100-page cliff). When pages exceed this cap, review scopes to the most-recent pages
// plus their tag-neighbors (where contradiction/stale signal concentrates) instead of dumping
// every page into one prompt. Env-overridable; floored so a hostile/typo'd env can't starve it.
export const MAX_REVIEW_PAGES = Math.max(
  20,
  parseInt(process.env.LLMWIKI_REVIEW_MAX_PAGES ?? "80", 10) || 80,
);

// P1-B: deterministic cadence gate for the close-out auto-run. The "~every 7 days" rule used
// to live only in skill prose, and a prose gate is enforced at the model's whim (observed:
// re-ran 4 days after the last review). With `--if-due`, the engine itself skips when the
// last committed review is younger than the interval — cadence becomes a property of the
// engine, and the warm close-out stays cheap by default. Env-overridable; floored at 1 day.
export const REVIEW_INTERVAL_DAYS = Math.max(
  1,
  parseInt(process.env.LLMWIKI_REVIEW_INTERVAL_DAYS ?? "7", 10) || 7,
);

// Pure day-diff gate (exported for tests): due when there is no prior committed review, a
// date fails to parse (fail-open — a corrupt state file must never silence review forever),
// or `today` is at least `intervalDays` after `lastDate`.
export function _isDue(lastDate: string | undefined, today: string, intervalDays: number): boolean {
  if (!lastDate) return true;
  const last = Date.parse(lastDate);
  const now = Date.parse(today);
  if (Number.isNaN(last) || Number.isNaN(now)) return true;
  return (now - last) / 86_400_000 >= intervalDays;
}

// Silent-failure detector for backgrounded commit runs (pure, exported for tests). A commit run
// stamps `launched` right before the heavy LLM call; only a COMPLETED commit overwrites the state
// with a launch-free `{hash, date, dest}` stamp. So "launched present, and no completion on or
// after it" means a run started and died without a trace — the exact success-looking failure a
// backgrounded review would otherwise hide. Visibility only: the cadence gate keys off `date`,
// so a died run leaves the review due and the next close-out re-runs it (self-healing).
export function _launchIncomplete(st: { date?: string; launched?: string }): boolean {
  if (!st.launched) return false;
  return !st.date || st.date < st.launched;
}

const _PROMPT = `You are the **semantic self-healing (semantic lint)** checker for an LLM Wiki. Below are one
project's ({repo}) wiki pages (title, date, gist, excerpt, cites=footnote-citation count). Look for these 5 things:

1. **Contradiction** — two pages assert the same fact, number, or direction differently. (Name both pages.)
2. **Stale claim** — an older page's claim has been updated or retired by a newer page (or by current-state / overview).
3. **Missing page** — a core concept that is repeatedly referenced across pages but has no page of its own.
4. **Cross-reference / next questions** — page pairs that should be linked, or questions and sources worth investigating.
5. **Grounding / citation adequacy** — a page that asserts concrete facts, numbers, or decisions but carries **no or too few citations** (see \`cites=\`), OR whose stated claims look ungrounded (an opinion/decision presented as fact the human did not state). This is a judgment call — flag only pages that genuinely make factual/decision claims without backing; a pure direction statement or a navigation page needs none. Name the page and say what should be cited or downgraded to draft.

Rules (strict):
- **Use only what the provided text visibly grounds.** No guessing or fabrication. When unsure, omit.
- If current-state or overview exists, it is the **latest authority** — an old claim that conflicts with it is the #1 'stale' candidate.
- Keep each finding to 1–2 lines and always point to the relevant page with \`[[link]]\` (use the link value from the input below).
- If a section has no findings, put exactly \`(none)\` (or its equivalent in the report's language) in that section's body.

Output format (strict): the ENTIRE output is saved verbatim as a \`.md\` file. No preamble, closing, or "I wrote ..." sentences, and no code fences.
- **Write the report body in the SAME language as the wiki pages below** (match them; use English if the language is unclear).
- **The first character MUST be \`---\`** (YAML frontmatter) with the fields: title, description (one sentence), date: {date},
  tags: [review, semantic, meta], status: draft, source: semantic-lint.
- Body sections (these 5, in fixed order, no emoji), headings written in the report's language: Contradiction / Stale claim / Missing concept page / Cross-references & next questions / Grounding & citations. (Korean example: \`## 모순\` · \`## 낡은 주장\` · \`## 개념 누락\` · \`## 교차참조·다음 질문\` · \`## 근거·인용 부실\`.)
${renderBodyStyleRule()}
- Terminology (lint-enforced, advisory): avoid jargon a person wouldn't say — e.g. when writing Korean prefer \`방향성\` (not 진북/북극성/north-star) and \`업데이트\`/\`update\` (not distill).

{scopenote}=== INPUT: wiki pages ===
{pages}
=== END INPUT ===

Now output only the report, starting with \`---\`:`;

// coordinate import: when autoupdate.ts is ported, replace local _extractPage with
// `import { _extractPage } from "./autoupdate.ts";`
function _extractPage(text: string): string {
  text = text.trim();
  const fence = text.match(/```(?:markdown|md)?\s*\n(---\n[\s\S]*?)\n```/);
  if (fence) return fence[1]!.trim();
  const m = text.match(/^---[ \t]*$/m);
  if (m && m.index !== undefined) return text.slice(m.index).trim();
  return text; // no frontmatter found → caller rejects
}

// local TL;DR extractor (first non-empty line under a TL;DR heading).
function _tldr(content: string): string {
  const m = content.match(/^##+\s*TL;?DR\s*$/im);
  if (m && m.index !== undefined) {
    const rest = content.slice(m.index + m[0].length).replace(/^\n+/, "");
    for (const line of rest.split("\n")) {
      const s = line.trim();
      if (s) return s.slice(0, 280);
    }
  }
  const body = content.replace(/^---[\s\S]*?---\s*/, "");
  for (const line of body.split("\n")) {
    const s = line.trim();
    if (s && !s.startsWith("#")) return s.slice(0, 280);
  }
  return "";
}

function _excerpt(content: string): string {
  // Body excerpt after frontmatter, whitespace-collapsed, bounded — for claim spotting.
  const body = content.replace(/^---[\s\S]*?---\s*/, "");
  const collapsed = body.split(/\s+/).filter((s) => s).join(" ");
  return collapsed.slice(0, EXCERPT_CHARS);
}

interface Brief {
  link: string;
  title: string;
  date: string;
  tldr: string;
  excerpt: string;
  cites: number; // footnote-citation definitions on the page — signal for grounding check
  tags: string[]; // frontmatter tags — used for tag-neighbor scope selection (P1-A2)
}

// Normalize DocRow.tags (stored as JSON string, or already-parsed array) → string[].
function _normTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t));
  if (typeof raw === "string" && raw.trim()) {
    try {
      const a = JSON.parse(raw);
      return Array.isArray(a) ? a.map((t) => String(t)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// footnote DEFINITION counter (mirrors lint.ts FOOTNOTE_DEF) — `[^id]: ...` at line start.
function _citeCount(content: string): number {
  const m = content.match(/^\[\^([^\]]+)\]:\s*(.+)$/gm);
  return m ? m.length : 0;
}

function _briefs(ws: string): Brief[] {
  const idx = new WikiIndex(ws);
  idx.indexAll();
  const db = idx.connect();
  let docs: DocRow[];
  try {
    docs = idx.listDocumentsWithContent(db);
  } finally {
    db.close();
  }
  const out: Brief[] = [];
  for (const d of docs) {
    const rel = (d.relative_path as string) || "";
    if (!rel.includes("docs/wiki/")) continue;
    const wikiRel = rel.split("docs/wiki/", 2)[1]!;
    if (!wikiRel.endsWith(".md") || wikiRel.endsWith("README.md")) continue;
    if (wikiRel.startsWith("0_review/") || wikiRel.includes("/0_review/")) continue;
    const content = (d.content as string) || "";
    out.push({
      link: wikiRel.slice(0, -3),
      title: ((d.title as string) || wikiRel).trim(),
      date: ((d.date as string) || "").trim(),
      tldr: _tldr(content),
      excerpt: _excerpt(content),
      cites: _citeCount(content),
      tags: _normTags((d as any).tags),
    });
  }
  out.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.link < b.link ? -1 : a.link > b.link ? 1 : 0;
  });
  return out;
}

function _title(page: string): string {
  const m = page.match(/^title:\s*(.+)$/m);
  if (!m) return "";
  return m[1]!.trim().replace(/^"|"$/g, "");
}

// P1-A2 scope selection: when the wiki exceeds maxPages, review only the most-recent pages
// (where new/changed claims live) plus their tag-neighbors (the older pages a new claim is most
// likely to contradict or supersede). Returns the bounded subset + a note for the prompt so the
// model knows it's a partial view (and won't false-flag "missing page"). Stable asc-by-date order.
export function _selectScope(briefs: Brief[], maxPages: number): { scoped: Brief[]; note: string } {
  if (briefs.length <= maxPages) return { scoped: briefs, note: "" };
  const byRecent = [...briefs].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : a.link < b.link ? 1 : -1,
  );
  const coreN = Math.max(1, Math.floor(maxPages * 0.7));
  const core = byRecent.slice(0, coreN);
  const coreTags = new Set<string>();
  for (const b of core) for (const t of b.tags) coreTags.add(t);
  const chosen = new Set(core.map((b) => b.link));
  const neighbors: Brief[] = [];
  for (const b of byRecent.slice(coreN)) {
    if (core.length + neighbors.length >= maxPages) break;
    if (b.tags.some((t) => coreTags.has(t))) {
      neighbors.push(b);
      chosen.add(b.link);
    }
  }
  const scoped = [...core, ...neighbors].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.link < b.link ? -1 : 1,
  );
  const note =
    `NOTE: This is a BOUNDED review view — the ${scoped.length} most-recent + tag-related pages ` +
    `out of ${briefs.length} total. Older unrelated pages are omitted this run; do NOT report ` +
    `"missing page" for a concept that may already have a page outside this subset.\n\n`;
  return { scoped, note };
}

// Whole-run cache (the single-pass analogue of wikimind's pair-cache): hash the in-scope briefs;
// if unchanged since the last committed review and that report still exists, skip the LLM call.
export function _runHash(briefs: Brief[]): string {
  const h = createHash("sha256");
  for (const b of briefs) h.update(`${b.link}|${b.date}|${b.cites}|${b.excerpt}\n`);
  return h.digest("hex").slice(0, 16);
}
const REVIEW_STATE_REL = join(".llmwiki", "review-state.json");
function _readState(root: string): { hash?: string; date?: string; dest?: string; launched?: string } {
  try {
    const raw = readRepoFile(root, REVIEW_STATE_REL);
    return raw === null ? {} : JSON.parse(raw);
  } catch {
    return {};
  }
}

export interface ReviewHealth {
  readonly due: boolean;
  readonly incompleteLaunch: boolean;
  readonly lastCompletedDate: string | null;
  readonly launchedDate: string | null;
  readonly reportPath: string | null;
  readonly intervalDays: number;
}

/** Inspect semantic-review cadence without building briefs, reindexing, or invoking an LLM. */
export function inspectReviewHealth(ws: string, today = todayLocal()): ReviewHealth {
  const root = resolve(ws);
  const state = _readState(root);
  return {
    due: _isDue(state.date, today, REVIEW_INTERVAL_DAYS),
    incompleteLaunch: _launchIncomplete(state),
    lastCompletedDate: state.date ?? null,
    launchedDate: state.launched ?? null,
    reportPath: state.dest ?? null,
    intervalDays: REVIEW_INTERVAL_DAYS,
  };
}
// Stamp "a commit run is past all gates and about to spend the LLM call". Merges into the
// existing state so the last completed stamp stays readable; the completion _writeState
// overwrites with a launch-free object, which is what clears the marker.
function _markLaunched(root: string, date: string): void {
  ensureRepoDir(root, ".llmwiki");
  writeRepoFile(root, REVIEW_STATE_REL, JSON.stringify({ ..._readState(root), launched: date }, null, 2));
}
// A completion writes a launch-free object — this is what clears the `launched` marker, and it
// also clears any CONCURRENT run's marker (two same-repo close-outs racing): acceptable, because
// the erasing run is itself a completed review and the cadence gate re-runs on schedule anyway.
function _writeState(root: string, st: { hash: string; date: string; dest: string }): void {
  ensureRepoDir(root, ".llmwiki");
  writeRepoFile(root, REVIEW_STATE_REL, JSON.stringify(st, null, 2));
}

// The two lines appended to log.md when a report lands. This is page content in the user's
// repository, so it follows the wiki's language (exported for the language contract test).
export function _reviewLogEntry(dest: string, scoped: number, total: number, bounded: boolean, ko: boolean): string[] {
  const scopeMsg = bounded
    ? ko
      ? `${scoped}/${total}p 검사(범위 한정), advisory draft`
      : `${scoped}/${total}p checked (scoped), advisory draft`
    : ko
      ? `${scoped}p 검사, advisory draft`
      : `${scoped}p checked, advisory draft`;
  return [`${dest} (${scopeMsg})`, ko ? "의미 lint — 사람이 검토 후 반영" : "semantic lint — apply after human review"];
}

export interface ReviewOpts {
  commit?: boolean;
  minPages?: number;
  maxPages?: number; // scope cap (P1-A2); default MAX_REVIEW_PAGES
  force?: boolean; // bypass the no-change skip cache AND the --if-due cadence gate
  ifDue?: boolean; // cadence gate (P1-B): skip unless REVIEW_INTERVAL_DAYS have passed
  model?: string;
  date: string;
}

export async function review(ws: string, opts: ReviewOpts): Promise<Record<string, any>> {
  const { commit = false, minPages = 2, maxPages = MAX_REVIEW_PAGES, force = false, ifDue = false, date } = opts;
  const root = resolve(ws);
  const name = basename(root);
  // Heavy tier for the judgment pass: explicit opts.model wins, else config-resolved
  // (env LLMWIKI_MODEL_HEAVY > toml [models].heavy > builtin).
  const model = opts.model ?? getConfig(root).models.heavy;

  // Backgrounded runs fail silently by construction (no terminal to error into) — surface a
  // prior launch that never committed on EVERY exit path, so whichever call the next close-out
  // makes reports it. Detection only; the cadence gate below still re-runs the died review.
  const st0 = _readState(root);
  const prevIncomplete = _launchIncomplete(st0)
    ? { prev_launch_incomplete: st0.launched, prev_launch_note: `a review launched ${st0.launched} never committed (backgrounded run died or is still running)` }
    : {};

  // Cadence gate first — cheaper than building briefs (which reindexes). Only committed runs
  // stamp the state, so the gate keys off the last *committed* review, matching the close-out
  // auto-run it exists for.
  if (ifDue && !force) {
    const st = _readState(root);
    if (!_isDue(st.date, date, REVIEW_INTERVAL_DAYS)) {
      return {
        verdict: "skip",
        due: false,
        ...prevIncomplete,
        reason: `not due: last review ${st.date} is younger than ${REVIEW_INTERVAL_DAYS}d (interval via LLMWIKI_REVIEW_INTERVAL_DAYS; --force to override).`,
      };
    }
  }

  const briefs = _briefs(ws);
  if (briefs.length < minPages) {
    const ko = isRepoKorean(root);
    return {
      verdict: "skip",
      n_pages: briefs.length,
      ...prevIncomplete,
      reason: ko
        ? `검사 재료 부족: ${briefs.length} < min_pages ${minPages}. 페이지 더 쌓인 뒤 재시도.`
        : `too little to review: ${briefs.length} < min_pages ${minPages}. Retry once more pages have accumulated.`,
    };
  }

  // P1-A2: bound the input (recent + tag-neighbors) so the prompt stays small as the wiki grows.
  const { scoped, note } = _selectScope(briefs, maxPages);

  // No-change skip: if the in-scope pages are byte-identical to the last committed review, don't
  // burn a heavy LLM call. This is what makes step-8 auto-run cheap to leave on (P0 wired it on).
  const runHash = _runHash(scoped);
  if (!force) {
    const st = _readState(root);
    if (st.hash === runHash && st.dest && repoFileExists(root, st.dest)) {
      return {
        verdict: "skip",
        n_pages: scoped.length,
        cached: true,
        ...prevIncomplete,
        reason: `no page changes since last review (${st.date}); ${scoped.length}/${briefs.length} in scope. --force to re-run.`,
      };
    }
  }

  const pagesTxt = scoped
    .map((b) => `- [${b.date}] [[${b.link}]] — ${b.title} (cites=${b.cites})\n    Gist: ${b.tldr}\n    Excerpt: ${b.excerpt}`)
    .join("\n");

  // The brief carries page excerpts — repository text — so it is screened before it becomes a
  // prompt. Screened to nothing means no call at all, not a redacted call.
  const screened = screenOutbound({ pages: pagesTxt });
  if (!screened) {
    return {
      verdict: "skipped-screened",
      n_pages: scoped.length,
      ...prevIncomplete,
      reason: "outbound data screened to nothing (secrets); no generative call was made",
    };
  }
  const prompt = _PROMPT.replace("{repo}", name).replace("{date}", date).replace("{scopenote}", note).replace("{pages}", screened.pages!);
  // An absent or invalid provider is a configuration skip, not evidence that a background
  // process launched and died. Resolve that state before writing the crash-detection marker.
  if (!llmAvailable()) {
    const unavailable = await llm(prompt, model);
    if (unavailable.startsWith(UNAVAILABLE)) {
      return {
        verdict: "skipped-no-provider",
        n_pages: scoped.length,
        ...prevIncomplete,
        reason: unavailable.slice(UNAVAILABLE.length + 1),
      };
    }
    return {
      verdict: "fail",
      n_pages: scoped.length,
      ...prevIncomplete,
      reason: unavailable.slice(0, 200),
    };
  }
  // Past every gate, about to spend the heavy call: stamp the launch (commit runs only — a
  // dry-run never commits by design, so a launch marker there would be a permanent false
  // positive). A successful commit's _writeState below overwrites launch-free = completion.
  if (commit) _markLaunched(root, date);
  const raw = await llm(prompt, model);
  if (raw.startsWith(UNAVAILABLE)) {
    return {
      verdict: "skipped-no-provider",
      n_pages: scoped.length,
      ...prevIncomplete,
      reason: raw.slice(UNAVAILABLE.length + 1),
    };
  }
  const page = _extractPage(raw);
  if (raw.startsWith("__ERROR__") || !page.startsWith("---")) {
    return { verdict: "fail", n_pages: scoped.length, ...prevIncomplete, reason: raw.slice(0, 200) };
  }

  const result: Record<string, any> = {
    verdict: "reviewed",
    n_pages: scoped.length,
    ...prevIncomplete,
    scope: { included: scoped.length, total: briefs.length, bounded: scoped.length < briefs.length },
  };
  const destRel = join("docs", "wiki", getConfig(root).queueDir, `semantic-review-${date}.md`);
  const dest = join(root, destRel);
  result.dest = relpath(root, dest);
  if (!commit) {
    result.dry_run = true;
    result.preview = page.slice(0, 900);
    return result;
  }

  // advisory report → always lands in 0_review/ (human-judgment queue; never edits live
  // pages). status: draft.
  ensureRepoDir(root, join("docs", "wiki", getConfig(root).queueDir));
  writeRepoFile(root, destRel, page + (page.endsWith("\n") ? "" : "\n"));
  _writeState(root, { hash: runHash, date, dest: result.dest as string });
  new WikiIndex(ws).indexAll();
  appendLog(
    ws,
    "review",
    _title(page) || "semantic-review",
    _reviewLogEntry(result.dest as string, scoped.length, briefs.length, result.scope.bounded, isRepoKorean(root)),
    date,
  );
  result.accepted = true; // accepted = report written (not auto-applied to wiki)
  return result;
}
