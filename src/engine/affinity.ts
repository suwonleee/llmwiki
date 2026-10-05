// affinity.ts — the read loop's memory of which pointers get opened.
//
// The emission ledger and the per-harness read observers (observe.ts) already answer "was this
// pointer opened later in the same session?", but only as an offline report: nothing fed the
// answer back into WHICH pages get pointed at. Measured on the author's machine, 1.9% of injected
// pointers were opened (cold start 1.3%, per-turn 4.0%), so the same never-opened pages kept
// taking the same slots session after session.
//
// This module closes that loop in two halves that never meet on the hot path:
//
//   refresh (daemon, daily)  ledger + harness reads over a bounded recent window
//                            → projects/<id>/observe/affinity.json (compact, capped, atomic, 0600)
//   consume (every session)  one small JSON read, cached per process → RERANK ONLY
//
// Reranking is the whole contract. A consumer picks the same NUMBER of entries it always did and
// prints the same line shapes; affinity only decides which candidates fill those slots. The
// injection therefore cannot grow with use. And "never opened" is weak evidence — a pointer's
// TITLE can answer a prompt without the page being opened — so the signal is deliberately timid:
//
//   • only OBSERVED sessions count. A session whose transcript was not scanned (budget, unreadable,
//     a harness without an observer, a locked opencode.db) is missing data, not "never opened".
//   • the unit is the SESSION, not the emission: the cold start points at the same pages every
//     session, so counting emissions would condemn every page within days.
//   • channels are judged separately. Cold-start lists use cold_start evidence, per-turn ranking
//     uses turn_context evidence; they are never summed.
//   • a page edited after it was pointed at starts over: the evidence was about the old text.
//     "Edited" is the file's mtime (repoFileMtime) — no content hashing. Two consequences, accepted
//     on purpose: (1) a `git checkout`/`pull` that rewrites a page also resets it, so evidence
//     rebuilds more slowly but never wrongly; (2) the cold-start "recent pages" list is ORDERED by
//     mtime, so its entries are by construction the most recently touched pages and rarely gather
//     enough post-edit evidence to be demoted — there, affinity mostly acts on long-untouched pages
//     that are still among the newest few (a quiet wiki), and on the spine, whose order is in-degree.
//   • demotion needs DEMOTE_MIN_SESSIONS sessions on ≥ 2 distinct days, with zero opens, and even
//     then only yields a bounded number of slots (see the policies below) — never excludes.
//   • promotion needs opens in ≥ 2 sessions over ≥ 2 days, and a promoted page may only overtake a
//     page that is itself evidenced as unopened (≥ 2 sessions over ≥ 2 days, zero opens) and ranked
//     below where the promoted page lands. A single open moves nothing.
//   • a transcript modified in the last AFFINITY_ACTIVE_MS is still being written, so it is left for
//     the next refresh rather than read half-finished.
//
// Missing, corrupt or stale data means exactly today's behavior.
import { basename } from "node:path";
import {
  answeringRead,
  claudeLedgerReads,
  discoverCodexRollouts,
  readEmissionsFor,
  scanCodexReads,
  scanOpenCodeReads,
  type Emission,
  type LedgerRead,
} from "./observe.ts";
import { discoverClaudeTranscripts, pickRecentTranscripts, type Channel } from "./downstream-read.ts";
import { isEnrolledFresh } from "./enrollment.ts";
import {
  listProjectStates,
  projectStateIsRegularFile,
  readProjectState,
  resolveProjectStateLocation,
  writeProjectStateQuietly,
} from "./project-state.ts";
import { repoFileMtime } from "./repo-write.ts";

export const AFFINITY_VERSION = 2;
const AFFINITY_FILE = ["observe", "affinity.json"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- bounds (the aggregate must not grow with use either) ---------------------------------

/** Only this recent a slice of the ledger counts: old behavior should stop steering new sessions. */
export const AFFINITY_WINDOW_DAYS = 30;
/** Newest emissions considered inside the window. ~200 bytes a line: a hard cap on work, not data. */
export const AFFINITY_MAX_EMISSIONS = 5000;
/** Pages kept in the file — the most-evidenced ones. */
export const AFFINITY_MAX_PAGES = 512;
/** The written file is trimmed (least evidence first) to stay well under the reader's cap. */
export const AFFINITY_WRITE_MAX_BYTES = 128 * 1024;
const AFFINITY_READ_MAX_BYTES = 256 * 1024;
/**
 * Transcript bytes read per harness per project per refresh. Candidates are already narrowed to
 * sessions the ledger names and to files modified inside the window; whatever the budget leaves out
 * is unobserved, so its emissions simply do not count.
 */
export const AFFINITY_SCAN_MAX_BYTES = 256 * 1024 * 1024;
/** Transcripts touched this recently belong to a session that may not be over; skipped (unobserved). */
export const AFFINITY_ACTIVE_MS = 10 * 60 * 1000;
/** The daemon refreshes a project whose file is at least this old (a day, with clock jitter room). */
export const AFFINITY_REFRESH_AFTER_MS = 20 * 60 * 60 * 1000;
/** A file the daemon has not refreshed in this long is ignored: no daemon, no steering. */
export const AFFINITY_MAX_AGE_MS = 7 * DAY_MS;

// ---- policy (why these numbers) -----------------------------------------------------------
//
// Laplace-smoothed open rate r = (opened + 1) / (sessions + 2): one open in one session is not a
// 100% page, and zero evidence sits at a neutral 0.5 instead of at an extreme.
//
// Demotion: ≥ 8 distinct observed sessions on ≥ 2 distinct days, zero opens (r ≤ 0.1). Below that
// a page is untouched.
//
// Promotion: opens in ≥ 2 sessions, pointed on ≥ 2 days — one open is an anecdote. A promoted page
// can only overtake a page with ≥ 2 unopened sessions over ≥ 2 days, ranked below its landing spot.
//
// Per turn: a ×0.9 (demoted) … ×(1 + 0.15r) (promotable) multiplier, and its effect on the score is
// additionally capped below one point. Scores are sums of integer term weights, so a gap of two or
// more points can never flip — relevance strictly dominates; affinity only orders near-ties.
export const DEMOTE_MIN_SESSIONS = 8;
export const DEMOTE_MIN_DAYS = 2;
export const PROMOTE_MIN_OPENED = 2;
export const PROMOTE_MIN_DAYS = 2;
const OVERTAKE_MIN_SESSIONS = 2;
const OVERTAKE_MIN_DAYS = 2;
export const TURN_DEMOTE_FACTOR = 0.9;
export const TURN_BOOST_MAX = 0.15;
const TURN_MAX_SHIFT = 0.95;
const LIST_BOOST_MAX_POSITIONS = 2;

/** How much a cold-start list may move. Counted against the list's own native top-N. */
export interface ListPolicy {
  /** The first `protectTop` native entries are never displaced (the newest pages stay visible). */
  protectTop: number;
  /** At most this many native entries are displaced, by demotion and promotion together. */
  maxChanged: number;
}
/** "Recent pages": the newest two never move; at most two of the six slots change at once. */
export const RECENT_POLICY: ListPolicy = { protectTop: 2, maxChanged: 2 };
/** Spine: in-degree order kept; at most one hub yields or is overtaken. */
export const SPINE_POLICY: ListPolicy = { protectTop: 0, maxChanged: 1 };

export interface ChannelAffinity {
  sessions: number; // distinct OBSERVED sessions that were pointed at this page
  opened: number; // of those, sessions in which a read of the page answered the pointer
  days: number; // distinct UTC days those sessions' pointers fell on
}

export type PageAffinity = Partial<Record<Channel, ChannelAffinity>>;

export interface AffinityFile {
  version: number;
  generatedAt: number; // ms epoch
  windowDays: number;
  emissions: number; // ledger lines inside the window
  observedEmissions: number; // of those, lines whose session's reads were actually observed
  pages: Record<string, PageAffinity>;
}

// ---- computing (pure) ----------------------------------------------------------------------

/**
 * Fold the ledger and the harness reads into per-page, per-channel SESSION counts. Pure.
 *
 * `observed` is the set of sessions whose reads were actually scanned; an emission from any other
 * session is skipped (missing data is not evidence). `modifiedAt` lets a page edited after it was
 * pointed at start over: only emissions at or after its mtime count, and a page that no longer
 * exists (null) is dropped. The match rule is observe.ts's own (`answeringRead`).
 */
export function computeAffinity(
  emissions: readonly Emission[],
  reads: readonly LedgerRead[],
  observed: ReadonlySet<string>,
  now: number,
  modifiedAt: (page: string) => number | null = () => 0,
  windowDays = AFFINITY_WINDOW_DAYS,
): AffinityFile {
  const since = now - windowDays * DAY_MS;
  const recent = emissions
    .filter((e) => e.ts >= since && e.ts <= now)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, AFFINITY_MAX_EMISSIONS);
  const seen = recent.filter((e) => observed.has(e.session));
  const bySession = new Map<string, LedgerRead[]>();
  for (const r of reads) {
    const arr = bySession.get(r.session) ?? [];
    arr.push(r);
    bySession.set(r.session, arr);
  }
  const mtimes = new Map<string, number | null>();
  const mtime = (page: string): number | null => {
    if (!mtimes.has(page)) mtimes.set(page, modifiedAt(page));
    return mtimes.get(page) ?? null;
  };
  // page → channel → session → { opened, days }
  const acc = new Map<string, Map<Channel, Map<string, { opened: boolean; days: Set<number> }>>>();
  for (const e of seen) {
    const candidates = bySession.get(e.session) ?? [];
    for (const page of e.pages) {
      const m = mtime(page);
      if (m === null || e.ts < m) continue;
      const channels = acc.get(page) ?? new Map();
      const sessions = channels.get(e.channel) ?? new Map();
      const s = sessions.get(e.session) ?? { opened: false, days: new Set<number>() };
      s.days.add(Math.floor(e.ts / DAY_MS));
      if (!s.opened && answeringRead(e, page, candidates)) s.opened = true;
      sessions.set(e.session, s);
      channels.set(e.channel, sessions);
      acc.set(page, channels);
    }
  }
  let entries = [...acc.entries()].map(([page, channels]) => {
    const a: PageAffinity = {};
    let weight = 0;
    for (const [channel, sessions] of channels) {
      const days = new Set<number>();
      let opened = 0;
      for (const s of sessions.values()) {
        if (s.opened) opened += 1;
        for (const d of s.days) days.add(d);
      }
      a[channel] = { sessions: sessions.size, opened, days: days.size };
      weight += sessions.size;
    }
    return { page, a, weight };
  });
  entries.sort((x, y) => y.weight - x.weight || x.page.localeCompare(y.page));
  entries = entries.slice(0, AFFINITY_MAX_PAGES);
  const build = (kept: typeof entries): AffinityFile => ({
    version: AFFINITY_VERSION,
    generatedAt: now,
    windowDays,
    emissions: recent.length,
    observedEmissions: seen.length,
    pages: Object.fromEntries(kept.map((k) => [k.page, k.a])),
  });
  let out = build(entries);
  while (entries.length && Buffer.byteLength(JSON.stringify(out)) > AFFINITY_WRITE_MAX_BYTES) {
    entries = entries.slice(0, Math.floor(entries.length * 0.9));
    out = build(entries);
  }
  return out;
}

// ---- refreshing (daemon / explicit CLI — never the hot path) --------------------------------

/** Harness record locations, discovered once per refresh pass and narrowed per project. */
export interface ReadSources {
  claudeTranscripts: readonly string[];
  codexRollouts: readonly string[];
  /** Scan opencode.db; `observed` receives every session id it knows. Locked/drifted → nothing. */
  opencode: (observed: Set<string>) => LedgerRead[];
}

export function discoverReadSources(): ReadSources {
  let cached: { reads: LedgerRead[]; sessions: Set<string> } | null = null;
  return {
    claudeTranscripts: discoverClaudeTranscripts(),
    codexRollouts: discoverCodexRollouts(),
    opencode: (observed) => {
      if (!cached) {
        const sessions = new Set<string>();
        cached = { reads: scanOpenCodeReads(undefined, sessions), sessions };
      }
      for (const s of cached.sessions) observed.add(s);
      return cached.reads;
    },
  };
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The reads that can answer these sessions, and the sessions whose reads were actually observed.
 * Only transcripts of ledger sessions, modified inside the window, within the byte budget, are
 * opened at all.
 */
export function observeSessions(
  sessions: ReadonlySet<string>,
  src: ReadSources,
  sinceMs: number,
  untilMs = Number.POSITIVE_INFINITY,
): { reads: LedgerRead[]; observed: Set<string> } {
  const observed = new Set<string>();
  if (!sessions.size) return { reads: [], observed };
  const claude = pickRecentTranscripts(
    src.claudeTranscripts.filter((f) => sessions.has(basename(f).replace(/\.jsonl$/, ""))),
    sinceMs,
    AFFINITY_SCAN_MAX_BYTES,
    untilMs,
  );
  const codex = pickRecentTranscripts(
    src.codexRollouts.filter((f) => {
      const id = UUID_RE.exec(basename(f))?.[0];
      return id !== undefined && sessions.has(id);
    }),
    sinceMs,
    AFFINITY_SCAN_MAX_BYTES,
    untilMs,
  );
  const reads = [
    ...(claude.length ? claudeLedgerReads(claude.length, claude, observed) : []),
    ...(codex.length ? scanCodexReads(codex, observed) : []),
    ...src.opencode(observed).filter((r) => sessions.has(r.session)),
  ];
  return { reads, observed };
}

export type RefreshResult =
  | { status: "written"; affinity: AffinityFile }
  | { status: "no-ledger" }
  | { status: "no-state" } // no engine-held state for this project yet
  | { status: "not-central" }; // a non-git directory (legacy in-repo layout): never written to

/** Recompute one project's aggregate and write it beside the ledger. */
export function refreshAffinity(root: string, now = Date.now(), src?: ReadSources): RefreshResult {
  let location;
  try {
    location = resolveProjectStateLocation(root);
  } catch {
    location = null;
  }
  if (location === null) return { status: "no-state" };
  if (!location.central) return { status: "not-central" };
  const emissions = readEmissionsFor(root);
  if (!emissions.length) return { status: "no-ledger" };
  const since = now - AFFINITY_WINDOW_DAYS * DAY_MS;
  const sessions = new Set(emissions.filter((e) => e.ts >= since).map((e) => e.session));
  const { reads, observed } = observeSessions(sessions, src ?? discoverReadSources(), since, now - AFFINITY_ACTIVE_MS);
  const affinity = computeAffinity(emissions, reads, observed, now, (page) => repoFileMtime(root, page));
  return writeProjectStateQuietly(root, AFFINITY_FILE, JSON.stringify(affinity) + "\n")
    ? { status: "written", affinity }
    : { status: "no-state" };
}

export interface AffinityRefreshOutcome {
  refreshed: number;
  failed: { worktree: string; error: string }[];
}

/**
 * The daemon's daily pass: every enrolled project with a ledger whose aggregate is missing or at
 * least a day old. One project's failure is recorded and the pass continues — its file stays old,
 * so the next daily pass retries it. Harness stores are discovered once, lazily, and only when some
 * project is actually due.
 */
export function refreshDueAffinity(now = Date.now(), sourcesFor: () => ReadSources = discoverReadSources): AffinityRefreshOutcome {
  const out: AffinityRefreshOutcome = { refreshed: 0, failed: [] };
  let src: ReadSources | null = null;
  for (const entry of listProjectStates()) {
    const worktree = entry.worktree;
    if (worktree === null || entry.orphaned) continue;
    try {
      if (!isEnrolledFresh(worktree)) continue;
      if (!projectStateIsRegularFile(worktree, "observe", "emissions.jsonl")) continue;
      const prior = parseAffinity(readProjectState(worktree, AFFINITY_FILE.join("/"), AFFINITY_READ_MAX_BYTES));
      if (prior && now - prior.generatedAt < AFFINITY_REFRESH_AFTER_MS && prior.generatedAt <= now) continue;
      src ??= sourcesFor();
      if (refreshAffinity(worktree, now, src).status === "written") out.refreshed += 1;
    } catch (e) {
      out.failed.push({ worktree, error: String(e) });
    }
  }
  return out;
}

// ---- consuming (hot path: one cached read, rerank only) ------------------------------------

function parseAffinity(text: string | null): AffinityFile | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text);
    if (
      v?.version !== AFFINITY_VERSION ||
      typeof v.generatedAt !== "number" ||
      !Number.isFinite(v.generatedAt) ||
      !v.pages ||
      typeof v.pages !== "object" ||
      Array.isArray(v.pages)
    ) {
      return null;
    }
    return v as AffinityFile;
  } catch {
    return null;
  }
}

const cache = new Map<string, AffinityFile | null>();

/** Test/embedded-process reset; a hook process reads at most once per root anyway. */
export function resetAffinityCache(): void {
  cache.clear();
}

/**
 * This project's aggregate, or null — and null means "behave exactly as before". Absent, corrupt,
 * future-dated, or older than AFFINITY_MAX_AGE_MS (the daemon stopped refreshing) are all null.
 * Only ENGINE-HELD state is read: without a central location, readProjectState would fall back to
 * an in-repo `.llmwiki/` file, and a repository must never be able to steer its own injection.
 * Never throws, never creates state.
 */
export function loadAffinity(root: string, now = Date.now()): AffinityFile | null {
  if (cache.has(root)) return cache.get(root) ?? null;
  let aff: AffinityFile | null = null;
  try {
    if (resolveProjectStateLocation(root)?.central !== true) throw new Error("no engine-held state");
    aff = parseAffinity(readProjectState(root, AFFINITY_FILE.join("/"), AFFINITY_READ_MAX_BYTES));
    if (aff && (now - aff.generatedAt > AFFINITY_MAX_AGE_MS || aff.generatedAt - now > DAY_MS)) aff = null;
  } catch {
    aff = null;
  }
  cache.set(root, aff);
  return aff;
}

const NONE: ChannelAffinity = { sessions: 0, opened: 0, days: 0 };

function evidence(aff: AffinityFile | null, page: string, channel: Channel): ChannelAffinity {
  if (!aff || !Object.prototype.hasOwnProperty.call(aff.pages, page)) return NONE;
  const c = aff.pages[page]?.[channel];
  // A hand-edited or half-written entry must degrade to "no evidence", never to NaN ordering.
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
  return c && ok(c.sessions) && ok(c.opened) && ok(c.days) ? c : NONE;
}

function smoothedRate(e: ChannelAffinity): number {
  return (e.opened + 1) / (e.sessions + 2);
}

function demoted(e: ChannelAffinity): boolean {
  return e.opened === 0 && e.sessions >= DEMOTE_MIN_SESSIONS && e.days >= DEMOTE_MIN_DAYS;
}

function promotable(e: ChannelAffinity): boolean {
  return e.opened >= PROMOTE_MIN_OPENED && e.days >= PROMOTE_MIN_DAYS;
}

/** Evidenced as unopened — the only kind of entry a promoted page may overtake. */
function overtakable(e: ChannelAffinity): boolean {
  return e.opened === 0 && e.sessions >= OVERTAKE_MIN_SESSIONS && e.days >= OVERTAKE_MIN_DAYS;
}

/** Per-turn multiplier in [0.9, 1.15] from turn_context evidence only; exactly 1 without enough. */
export function affinityMultiplier(aff: AffinityFile | null, page: string): number {
  const e = evidence(aff, page, "turn_context");
  if (demoted(e)) return TURN_DEMOTE_FACTOR;
  if (promotable(e)) return 1 + TURN_BOOST_MAX * Math.min(1, smoothedRate(e));
  return 1;
}

/**
 * A relevance score adjusted by affinity. The shift is the multiplier's, capped below one point
 * either way, so two pages whose scores differ by ≥ 2 keep their order whatever the evidence says.
 * With no affinity the score comes back unchanged.
 */
export function adjustedScore(score: number, aff: AffinityFile | null, page: string): number {
  const m = affinityMultiplier(aff, page);
  if (m === 1) return score;
  return score + Math.max(-TURN_MAX_SHIFT, Math.min(TURN_MAX_SHIFT, score * (m - 1)));
}

/**
 * Choose `n` of `items` (in their native order) using cold_start evidence, within `policy`:
 * up to `maxChanged` of the native top-n are displaced — demoted ones first (lowest-ranked first),
 * then, with any budget left, an entry evidenced as unopened that a promotable candidate (at most
 * two places below the cut) overtakes by landing ABOVE it. The first `protectTop` entries never move, a demoted entry stays when
 * there is no replacement, and the result keeps native order. With no evidence: `items.slice(0, n)`.
 */
export function rerankByAffinity<T>(
  items: readonly T[],
  n: number,
  aff: AffinityFile | null,
  pageOf: (item: T) => string,
  policy: ListPolicy,
): T[] {
  if (!aff) return items.slice(0, n);
  const at = (item: T, i: number) => ({ item, i, e: evidence(aff, pageOf(item), "cold_start") });
  const top = items.slice(0, n).map(at);
  const lift = (e: ChannelAffinity) =>
    promotable(e) ? Math.min(LIST_BOOST_MAX_POSITIONS, Math.ceil(LIST_BOOST_MAX_POSITIONS * smoothedRate(e))) : 0;
  // Replacements: never a demoted page; promotable pages first (by lifted position), then native order.
  const pool = items
    .slice(n)
    .map((item, k) => at(item, n + k))
    .filter((x) => !demoted(x.e))
    .sort((a, b) => a.i - lift(a.e) - (b.i - lift(b.e)) || lift(b.e) - lift(a.e) || a.i - b.i);
  const movable = top.filter((x) => x.i >= policy.protectTop);
  const removed = new Set<number>();
  const added: typeof top = [];
  let budget = policy.maxChanged;
  for (const x of movable.filter((m) => demoted(m.e)).sort((a, b) => b.i - a.i)) {
    if (budget <= 0 || !pool.length) break;
    removed.add(x.i);
    added.push(pool.shift()!);
    budget -= 1;
  }
  const victims = movable.filter((m) => !removed.has(m.i) && overtakable(m.e)).sort((a, b) => b.i - a.i);
  for (const p of pool.filter((c) => lift(c.e) > 0 && c.i - lift(c.e) < n)) {
    if (budget <= 0) break;
    const landing = p.i - lift(p.e);
    const at = victims.findIndex((v) => v.i > landing); // lowest-ranked first; only below the landing
    if (at < 0) continue;
    const [victim] = victims.splice(at, 1);
    removed.add(victim!.i);
    added.push(p);
    budget -= 1;
  }
  return [...top.filter((x) => !removed.has(x.i)), ...added].sort((a, b) => a.i - b.i).map((x) => x.item);
}
