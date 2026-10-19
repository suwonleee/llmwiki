// Citation discovery is advisory. Only an exact, accepted reflection receipt may advance a
// capture watermark; a bare citation cannot establish how much of a growing session was read.
import { openSync, closeSync, readSync, fstatSync, constants, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve, sep } from "node:path";
import * as capture from "./capture.ts";
import { getConfig } from "./config.ts";
import { readRepoDir, readRepoFile, ensureRepoDir, createRepoFile } from "./repo-write.ts";
import { parseFrontmatter } from "./frontmatter.ts";

function walkMarkdown(repo: string, relativeDir: string, out: string[]): void {
  for (const e of readRepoDir(repo, relativeDir)) {
    const rel = join(relativeDir, e.name);
    if (e.isDirectory) walkMarkdown(repo, rel, out);
    else if (e.isFile && e.name.endsWith(".md")) out.push(rel);
  }
}

// Transcript basenames cited anywhere in the repo's wiki — scanned only on footnote-definition
// lines (`[^n]: …`) and frontmatter `source:` lines, so a `.jsonl` merely mentioned in prose is
// not mistaken for a citation.
export function citedTranscripts(repo: string): Set<string> {
  const files: string[] = [];
  walkMarkdown(repo, join("docs", "wiki"), files);
  // The quiz layer is the HUMAN's notebook, not wiki coverage: a transcript cited inside a
  // quiz record must never mark that session as reflected — it would advance the capture
  // watermark and silently suppress the backlog nag (quiz.ts one-directional contract).
  const cfg = getConfig(repo);
  const quizRoot = join("docs", "wiki", cfg.quizDir) + sep;
  const reviewRoot = join("docs", "wiki", cfg.queueDir) + sep;
  const cited = new Set<string>();
  for (const f of files) {
    if (f.startsWith(quizRoot) || f.startsWith(reviewRoot)) continue;
    const text = readRepoFile(repo, f);
    if (text === null || parseFrontmatter(text).status === "draft") continue;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!/^(\[\^[^\]]+\]:|source:)/.test(t)) continue;
      const m = t.match(/([^\s/\\]+\.jsonl)\b/i); // case-insensitive, matching the rest of the engine
      if (m) cited.add(m[1]!.toLowerCase());
    }
    // OKF `sources:` — a list of `{ id, resource }` (a bare mapping is one entry).
    const sources = parseFrontmatter(text).data.sources;
    for (const e of Array.isArray(sources) ? sources : sources ? [sources] : []) {
      const resource = typeof e === "object" && e !== null ? (e as { resource?: unknown }).resource : e;
      const m = typeof resource === "string" ? resource.match(/([^\s/\\]+\.jsonl)\b/i) : null;
      if (m) cited.add(m[1]!.toLowerCase());
    }
  }
  return cited;
}

/** Evidence from a warm task that actually read [start,end) and accepted this exact page.
 * The caller must hash the source snapshot it used, not fetch fresh bytes after generation.
 * prefix_sha256 covers [0,end), detecting truncation/rewrite as well as a changed increment. */
export interface ReflectionReceipt {
  version: 1;
  transcript_path: string;
  page: string;
  start: number;
  end: number;
  prefix_sha256: string;
  page_sha256: string;
}

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const receiptDir = (repo: string, transcript: string) => join("reflections", digest(resolve(repo)), digest(transcript));
const MAX_PREFIX_BYTES = 256 * 1024 * 1024;
const MAX_RECEIPTS = 512;

// Constant memory, a finite work budget, and no device/pipe/symlink source reads.
function prefixMatches(transcript: string, end: number, expected: string): boolean {
  if (end > MAX_PREFIX_BYTES || !/^[a-f0-9]{64}$/.test(expected)) return false;
  let fd: number | undefined;
  try {
    fd = openSync(transcript, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.size < end) return false;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(end, 64 * 1024));
    for (let offset = 0; offset < end;) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (n === 0) return false;
      hash.update(buffer.subarray(0, n));
      offset += n;
    }
    return hash.digest("hex") === expected;
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function storedReceipts(repo: string, transcript: string): ReflectionReceipt[] {
  const dir = receiptDir(repo, transcript);
  const files = readRepoDir(capture.stateDir(), dir).filter(e => e.isFile && e.name.endsWith(".json"));
  if (files.length > MAX_RECEIPTS) return []; // fail closed instead of unbounded replay work
  const receipts: ReflectionReceipt[] = [];
  for (const file of files) {
    const text = readRepoFile(capture.stateDir(), join(dir, file.name));
    if (text === null || text.length > 8192) continue;
    try { const value = JSON.parse(text); if (value && Number.isSafeInteger(value.end)) receipts.push(value); } catch { /* invalid receipt */ }
  }
  return receipts.sort((a, b) => b.end - a.end);
}

function validReceipt(repo: string, receipt: ReflectionReceipt, transcript: string, offset: number): boolean {
  if (receipt?.version !== 1 || receipt.transcript_path !== transcript ||
      !Number.isSafeInteger(receipt.start) || !Number.isSafeInteger(receipt.end) ||
      receipt.start < 0 || receipt.start > offset || receipt.end <= offset ||
      receipt.end <= receipt.start || typeof receipt.page !== "string") return false;
  const pagePath = receipt.page.replaceAll("\\", "/");
  const cfg = getConfig(repo);
  if (!pagePath.startsWith("docs/wiki/") || !pagePath.endsWith(".md") ||
      pagePath.startsWith(`docs/wiki/${cfg.queueDir}/`) ||
      pagePath.startsWith(`docs/wiki/${cfg.quizDir}/`)) return false;
  const page = readRepoFile(repo, receipt.page);
  if (page === null || parseFrontmatter(page).status === "draft" || digest(page) !== receipt.page_sha256) return false;
  return prefixMatches(transcript, receipt.end, receipt.prefix_sha256);
}

/** Store a receipt only for a known pending session and currently accepted unchanged page.
 * It does not advance the queue: reconciliation rechecks both hashes immediately before marking. */
export function recordReflection(repo: string, receipt: ReflectionReceipt): boolean {
  if (!receipt || receipt.version !== 1 || typeof receipt.transcript_path !== "string") return false;
  const row = capture.pending(repo).find((r) => r.transcript_path === receipt.transcript_path);
  if (!row || !validReceipt(repo, receipt, row.transcript_path, row.byte_offset)) return false;
  // Immutable content-addressed records keep concurrent acceptances from replacing each other.
  const dir = receiptDir(repo, receipt.transcript_path);
  const content = JSON.stringify(receipt);
  const path = join(dir, `${receipt.end}-${digest(content)}.json`);
  if (content.length > 8192) return false;
  try {
    ensureRepoDir(capture.stateDir(), dir);
    if (readRepoFile(capture.stateDir(), path) === content) return true;
    if (readRepoDir(capture.stateDir(), dir).length >= MAX_RECEIPTS) return false;
    return createRepoFile(capture.stateDir(), path, content, 0o600);
  } catch { return false; }
}

export interface ReconcileResult {
  reconciled: string[]; // exact accepted receipt → advances only to its recorded end
  deferred: string[]; // cited, but no valid coverage receipt; remains pending
  backlog: string[]; // un-cited pending sessions
  commit: boolean;
}

export function reconcileReflected(repo: string, commit = false): ReconcileResult {
  const citedSet = citedTranscripts(repo);
  const reconciled: string[] = [];
  const deferred: string[] = [];
  const backlog: string[] = [];
  for (const row of capture.pending(repo)) {
    const bn = basename(row.transcript_path);
    const cited = citedSet.has(bn.toLowerCase());
    const receipt = storedReceipts(repo, row.transcript_path)
      .find((candidate) => validReceipt(repo, candidate, row.transcript_path, row.byte_offset));
    if (receipt) {
      const marked = !commit || capture.markIfOffset(row.transcript_path, row.byte_offset, receipt.end,
        statSync(row.transcript_path).size > receipt.end ? "pending" : "distilled");
      if (marked) reconciled.push(bn);
      else deferred.push(bn);
    } else if (cited) {
      deferred.push(bn); // citation alone does not establish accepted byte coverage
    } else {
      backlog.push(bn); // genuinely un-cited — the real backlog
    }
  }
  return { reconciled, deferred, backlog, commit };
}

// The human-facing backlog: pending sessions that NO wiki page cites yet. The cold-start nag counts
// THIS (not raw capture.pending), so a cited-but-partial session (byte_offset>0, tail deferred to
// autoupdate/deep) and a cited session whose live transcript is still growing never inflate the
// first impression. Returns full rows so callers keep recap/mtime metadata. Same citation scan as
// reconcile — one source of truth for "is this session represented in the wiki?".
export function uncitedPending(repo: string): ReturnType<typeof capture.pending> {
  const citedSet = citedTranscripts(repo);
  return capture
    .pending(repo)
    .filter((row) => !citedSet.has(basename(row.transcript_path).toLowerCase()));
}
