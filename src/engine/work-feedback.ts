// Warm close-out evidence. These are self-reported SILVER regression cases, never golden labels
// or ranking rewards. No model, shell command, daemon, or repository mutation runs here.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureProjectStateDir, projectStatePath, projectStateIsRegularFile, readProjectState } from "./project-state.ts";
import { createRepoFile, readRepoFileBytes, repoFileMetadata } from "./repo-write.ts";
import { searchWiki } from "./page-rank.ts";
import { buildTurnContext } from "./turncontext.ts";

const MAX_BYTES = 64 * 1024;
const MAX_RECEIPTS = 2000;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export interface FeedbackCase {
  query: string;
  page: string;
  outcome: "helped" | "corrected" | "missing";
  evidence: string[]; // source and executed-test output paths, not commands to execute
  required: string[]; // exact expected excerpt fragments; author assertions, not independent truth
  forbidden: string[];
}
export interface FeedbackInput { session: string; cases: FeedbackCase[] }
interface Snapshot { path: string; sha256: string }
export interface FeedbackReceipt {
  schema_version: 1;
  classification: "silver";
  session: string;
  cases: (FeedbackCase & { snapshots: Snapshot[]; page_sha256: string })[];
}

function shortText(v: unknown, max: number): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}
function fragments(v: unknown): v is string[] {
  return Array.isArray(v) && v.length <= 8 && v.every(x => shortText(x, 500));
}
function snapshot(root: string, path: string): Snapshot {
  const meta = repoFileMetadata(root, path);
  if (!meta || meta.size > 1024 * 1024) throw new Error(`evidence missing, unsafe or over 1 MiB: ${path}`);
  const bytes = readRepoFileBytes(root, path);
  if (bytes === null) throw new Error(`unreadable evidence: ${path}`);
  return { path, sha256: hash(bytes) };
}

export function prepareFeedback(root: string, input: unknown): FeedbackReceipt {
  if (!input || typeof input !== "object") throw new Error("feedback must be an object");
  const v = input as FeedbackInput;
  if (!shortText(v.session, 256) || !Array.isArray(v.cases) || v.cases.length < 1 || v.cases.length > 2)
    throw new Error("exact session and 1–2 cases required");
  const cases = v.cases.map(c => {
    if (!c || !shortText(c.query, 2000) || !shortText(c.page, 512) ||
        !/^docs\/wiki\/.+\.md$/.test(c.page) || !["helped", "corrected", "missing"].includes(c.outcome) ||
        !Array.isArray(c.evidence) || c.evidence.length < 1 || c.evidence.length > 8 ||
        !c.evidence.every(p => shortText(p, 512)) || !fragments(c.required) || !fragments(c.forbidden) ||
        c.required.length + c.forbidden.length === 0)
      throw new Error("invalid feedback case: query/page/outcome/evidence and excerpt assertions required");
    const paths = [...new Set(c.evidence)];
    if (paths.some(p => p.replaceAll("\\", "/").toLowerCase().startsWith("docs/wiki/"))) throw new Error("evidence must be raw source/test output outside the wiki");
    return { query: c.query, page: c.page, outcome: c.outcome,
      evidence: [...c.evidence], required: [...c.required], forbidden: [...c.forbidden],
      page_sha256: snapshot(root, c.page).sha256, snapshots: paths.map(p => snapshot(root, p)) };
  });
  return { schema_version: 1, classification: "silver", session: v.session, cases };
}

/** One immutable receipt per exact session, max two cases. Repeated same input is idempotent. */
export function recordFeedback(root: string, input: unknown): { path: string; duplicate: boolean } {
  const receipt = prepareFeedback(root, input);
  const text = JSON.stringify(receipt, null, 2) + "\n";
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("feedback exceeds 64 KiB");
  const dir = ensureProjectStateDir(root, "work-feedback");
  const path = join(dir, `${hash(receipt.session)}.json`);
  const prior = readProjectState(root, `work-feedback/${hash(receipt.session)}.json`, MAX_BYTES);
  if (prior !== null) {
    if (prior === text) return { path, duplicate: true };
    throw new Error("session already recorded; immutable feedback cannot be replaced");
  }
  if (readdirSync(dir).length >= MAX_RECEIPTS) throw new Error("feedback budget reached; archive before recording more");
  if (!createRepoFile(dir, `${hash(receipt.session)}.json`, text, 0o600)) {
    const concurrent = readProjectState(root, `work-feedback/${hash(receipt.session)}.json`, MAX_BYTES);
    if (concurrent === text) return { path, duplicate: true };
    throw new Error("session already recorded; immutable feedback cannot be replaced");
  }
  return { path, duplicate: false };
}

export function loadFeedbackInput(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("feedback input must be a regular file");
    // Input is explicitly selected by the caller, but bounded before parsing.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const n = readSync(fd, bytes, 0, bytes.length, 0);
    if (n > MAX_BYTES) throw new Error("feedback exceeds 64 KiB");
    return JSON.parse(bytes.subarray(0, n).toString("utf8"));
  } finally { closeSync(fd); }
}

/** Replay is diagnostic. Changed raw-evidence snapshots invalidate a case instead of silently
 * relabeling it. This is NOT task execution, semantic grading, or automatic promotion to gold. */
export function checkFeedback(root: string) {
  let names: string[];
  try { names = readdirSync(projectStatePath(root, "work-feedback")).filter(n => /^[a-f0-9]{64}\.json$/.test(n)).sort(); }
  catch { names = []; }
  if (names.length > MAX_RECEIPTS) throw new Error("feedback read budget exceeded");
  const results: { receipt: string; query?: string; status: "pass" | "fail" | "invalidated" | "invalid"; top5?: boolean; context?: boolean }[] = [];
  for (const name of names) {
    try {
      if (!projectStateIsRegularFile(root, "work-feedback", name)) throw new Error("unsafe receipt");
      const raw = readProjectState(root, `work-feedback/${name}`, MAX_BYTES);
      if (!raw || Buffer.byteLength(raw) > MAX_BYTES) throw new Error("unreadable receipt");
      const r = JSON.parse(raw) as FeedbackReceipt;
      if (r.schema_version !== 1 || r.classification !== "silver" || !Array.isArray(r.cases) || r.cases.length > 2)
        throw new Error("unsupported receipt");
      for (const c of r.cases) {
        const fresh = prepareFeedback(root, { session: r.session, cases: [c] }).cases[0]!;
        if (JSON.stringify(fresh.snapshots) !== JSON.stringify(c.snapshots)) {
          results.push({ receipt: name, query: c.query, status: "invalidated" }); continue;
        }
        const hits = searchWiki(root, c.query, 5);
        const context = buildTurnContext(root, c.query, "", { affinity: null });
        const top5 = hits.some(h => `docs/wiki/${h.page.rel}` === c.page);
        const block = context.split(/\n(?=  • )/).find(b => {
          const target = b.split("\n")[0]?.split("→")[1]?.trim();
          return target === c.page || target?.startsWith(c.page + " ");
        });
        const excerpt = block?.split("\n").slice(1).join("\n") ?? "";
        const ok = block !== undefined && c.required.every(s => excerpt.includes(s)) && c.forbidden.every(s => !excerpt.includes(s));
        results.push({ receipt: name, query: c.query, status: top5 && ok ? "pass" : "fail", top5, context: ok });
      }
    } catch { results.push({ receipt: name, status: "invalid" }); }
  }
  return { classification: "silver" as const, scope: "retrieval-and-exact-excerpt" as const, results };
}
