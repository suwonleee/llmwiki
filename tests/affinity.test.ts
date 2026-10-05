// Page affinity — the read loop's memory of which pointers get opened. Pinned here: the aggregate
// (observed sessions only, session as the unit, per channel, edits reset, window, caps), the
// daemon's once-a-day refresh that never counts as project use, and the consumer contract — RERANK
// ONLY: the same number of pointers, no new text, bounded slot changes, the newest pages never
// displaced, relevance strictly dominating per turn, and any missing/corrupt/stale/sub-threshold
// file byte-identical to having no affinity at all.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  adjustedScore,
  AFFINITY_MAX_PAGES,
  AFFINITY_WRITE_MAX_BYTES,
  affinityMultiplier,
  computeAffinity,
  loadAffinity,
  RECENT_POLICY,
  refreshAffinity,
  refreshDueAffinity,
  rerankByAffinity,
  resetAffinityCache,
  SPINE_POLICY,
  type AffinityFile,
  type ChannelAffinity,
  type ReadSources,
} from "../src/engine/affinity.ts";
import { buildContext } from "../src/engine/context.ts";
import { pickRecentTranscripts, scanTranscript } from "../src/engine/downstream-read.ts";
import { buildTurnContext } from "../src/engine/turncontext.ts";
import { buildSpine } from "../src/engine/synthesis.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { recordEmission, type Emission, type LedgerRead } from "../src/engine/observe.ts";
import {
  ensureProjectStateDir,
  markProjectUsed,
  projectStatePath,
  resetProjectStateCache,
  writeProjectStateQuietly,
} from "../src/engine/project-state.ts";
import { setEffectiveStateRoot } from "../src/engine/state-dir.ts";
import { disable, resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { _resetForTests } from "../src/engine/config.ts";
import { makeEnrolledRepo, tempDir } from "./support/git-repo.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 5, 12);
const made: string[] = [];
let stateRoot = "";

beforeEach(() => {
  stateRoot = tempDir("llmwiki-aff-state-");
  setEffectiveStateRoot(stateRoot);
  resetProjectStateCache();
  resetAffinityCache();
  resetEnrollmentCache();
});

afterEach(() => {
  setEffectiveStateRoot(null);
  resetProjectStateCache();
  resetAffinityCache();
  resetEnrollmentCache();
  _resetForTests();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  rmSync(stateRoot, { recursive: true, force: true });
});

function repo(): string {
  const r = makeEnrolledRepo("llmwiki-aff-repo-");
  made.push(r);
  return r;
}

function scratch(): string {
  const d = tempDir("llmwiki-aff-scratch-");
  made.push(d);
  return d;
}

const sources = (over: Partial<ReadSources> = {}): ReadSources => ({
  claudeTranscripts: [],
  codexRollouts: [],
  opencode: () => [],
  ...over,
});

function em(over: Partial<Emission>): Emission {
  return { ts: NOW - DAY, session: "s1", channel: "cold_start", root: "/w/r", pages: ["docs/wiki/a.md"], ...over };
}

function rd(over: Partial<LedgerRead>): LedgerRead {
  return { ts: NOW - DAY + 1, session: "s1", root: "/w/r", page: "docs/wiki/a.md", harness: "claude", ...over };
}

const ev = (sessions: number, opened: number, days: number): ChannelAffinity => ({ sessions, opened, days });
const coldDemoted = { cold_start: ev(12, 0, 3) };
const coldOpened = { cold_start: ev(3, 3, 2) };
const turnDemoted = { turn_context: ev(12, 0, 3) };
const turnOpened = { turn_context: ev(3, 3, 2) };
const coldOnce = { cold_start: ev(1, 1, 1) }; // a single open — an anecdote, not a promotion
const coldUnopened = { cold_start: ev(2, 0, 2) }; // weakly evidenced as unopened — may be overtaken

/** Backdate a file so the refresh does not treat it as a session still being written. */
function settle(f: string, at = Date.now() - 60 * 60 * 1000): string {
  utimesSync(f, at / 1000, at / 1000);
  return f;
}

function affOf(pages: AffinityFile["pages"], generatedAt = Date.now()): AffinityFile {
  return { version: 2, generatedAt, windowDays: 30, emissions: 1, observedEmissions: 1, pages };
}

/** Write an aggregate directly — the consumer tests are about reranking, not about computing. */
function writeAffinity(root: string, pages: AffinityFile["pages"], generatedAt = Date.now()): void {
  ensureProjectStateDir(root, "observe");
  expect(writeProjectStateQuietly(root, ["observe", "affinity.json"], JSON.stringify(affOf(pages, generatedAt)))).toBe(true);
  resetAffinityCache();
}

function writeRaw(root: string, text: string): void {
  ensureProjectStateDir(root, "observe");
  writeProjectStateQuietly(root, ["observe", "affinity.json"], text);
  resetAffinityCache();
}

const pointers = (out: string) => out.split("\n").filter((l) => l.includes("→"));
const pathsOf = (out: string) => pointers(out).map((l) => l.split("→ ")[1]!.trim().split(/\s/)[0]!);

describe("computeAffinity", () => {
  test("counts observed SESSIONS per channel, with observe's match rule", () => {
    const aff = computeAffinity(
      [
        em({}),
        em({ ts: NOW - DAY + 10 }), // same session again → still one session
        em({ session: "s2", channel: "turn_context" }),
        em({ session: "s3", pages: ["docs/wiki/b.md"] }),
        em({ session: "ghost" }), // its reads were never observed → not evidence at all
      ],
      [
        rd({ ts: NOW - DAY + 50 }), // answers s1
        rd({ session: "s2", ts: NOW - DAY - 5 }), // BEFORE the emission → not an answer
        rd({ session: "s3", page: "docs/wiki/other.md" }), // another page → not an answer
      ],
      new Set(["s1", "s2", "s3"]),
      NOW,
    );
    expect(aff.pages["docs/wiki/a.md"]).toEqual({ cold_start: ev(1, 1, 1), turn_context: ev(1, 0, 1) });
    expect(aff.pages["docs/wiki/b.md"]).toEqual({ cold_start: ev(1, 0, 1) });
    expect(aff.emissions).toBe(5);
    expect(aff.observedEmissions).toBe(4);
  });

  test("distinct days are counted, and a page edited after it was pointed at starts over", () => {
    const sessions = ["d1", "d2", "d3"];
    const emissions = sessions.map((s, i) => em({ session: s, ts: NOW - (3 - i) * DAY }));
    const observed = new Set(sessions);
    expect(computeAffinity(emissions, [], observed, NOW).pages["docs/wiki/a.md"]).toEqual({ cold_start: ev(3, 0, 3) });
    // edited between the 2nd and 3rd day → only the 3rd counts
    const edited = computeAffinity(emissions, [], observed, NOW, () => NOW - 1.5 * DAY);
    expect(edited.pages["docs/wiki/a.md"]).toEqual({ cold_start: ev(1, 0, 1) });
    // deleted page → dropped
    expect(computeAffinity(emissions, [], observed, NOW, () => null).pages).toEqual({});
  });

  test("only the recent window counts, and the table is capped in entries and bytes", () => {
    const old = computeAffinity([em({ ts: NOW - 31 * DAY })], [], new Set(["s1"]), NOW);
    expect(old.emissions).toBe(0);
    expect(old.pages).toEqual({});

    const many = Array.from({ length: AFFINITY_MAX_PAGES + 40 }, (_, i) => `docs/wiki/p${i}.md`);
    const capped = computeAffinity(
      [em({ pages: many }), em({ session: "s2", pages: ["docs/wiki/p7.md"] })],
      [],
      new Set(["s1", "s2"]),
      NOW,
    );
    expect(Object.keys(capped.pages).length).toBe(AFFINITY_MAX_PAGES);
    expect(capped.pages["docs/wiki/p7.md"]?.cold_start?.sessions).toBe(2); // most-evidenced kept first

    const long = Array.from({ length: AFFINITY_MAX_PAGES }, (_, i) => `docs/wiki/${"x".repeat(300)}${i}.md`);
    const trimmed = computeAffinity([em({ pages: long })], [], new Set(["s1"]), NOW);
    expect(Buffer.byteLength(JSON.stringify(trimmed))).toBeLessThanOrEqual(AFFINITY_WRITE_MAX_BYTES);
    expect(Object.keys(trimmed.pages).length).toBeGreaterThan(0);
  });
});

describe("scoring", () => {
  test("turn multiplier: turn evidence only, needs sessions on two days, bounded to [0.9, 1.15]", () => {
    expect(affinityMultiplier(null, "x")).toBe(1);
    expect(affinityMultiplier(affOf({ x: { turn_context: ev(7, 0, 3) } }), "x")).toBe(1);
    expect(affinityMultiplier(affOf({ x: { turn_context: ev(20, 0, 1) } }), "x")).toBe(1); // one day only
    expect(affinityMultiplier(affOf({ x: coldDemoted }), "x")).toBe(1); // cold-start evidence is not turn evidence
    expect(affinityMultiplier(affOf({ x: turnDemoted }), "x")).toBe(0.9);
    expect(affinityMultiplier(affOf({ x: { turn_context: ev(1, 1, 1) } }), "x")).toBe(1); // one open boosts nothing
    expect(affinityMultiplier(affOf({ x: { turn_context: ev(5, 2, 1) } }), "x")).toBe(1); // two opens, one day
    const boost = affinityMultiplier(affOf({ x: turnOpened }), "x");
    expect(boost).toBeGreaterThan(1);
    expect(boost).toBeLessThanOrEqual(1.15);
  });

  test("a score gap of two or more never flips, whatever the evidence", () => {
    const aff = affOf({ up: { turn_context: ev(1000, 1000, 30) }, down: turnDemoted });
    for (let low = 2; low <= 60; low += 1) {
      expect(adjustedScore(low + 2, aff, "down")).toBeGreaterThan(adjustedScore(low, aff, "up"));
    }
    expect(adjustedScore(5, null, "up")).toBe(5);
  });

  test("recent-pages policy: newest two protected, at most two slots change, never excluded", () => {
    const items = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const id = (x: string) => x;
    expect(rerankByAffinity(items, 6, null, id, RECENT_POLICY)).toEqual(items.slice(0, 6));
    // everything demoted: a, b protected; only two of c..f yield, the lowest-ranked first
    const all = affOf(Object.fromEntries(items.slice(0, 6).map((x) => [x, coldDemoted])));
    expect(rerankByAffinity(items, 6, all, id, RECENT_POLICY)).toEqual(["a", "b", "c", "d", "g", "h"]);
    // no replacement candidates → nothing yields
    expect(rerankByAffinity(items.slice(0, 6), 6, all, id, RECENT_POLICY)).toEqual(items.slice(0, 6));
    // turn evidence does not steer the cold start
    expect(rerankByAffinity(items, 6, affOf({ c: turnDemoted }), id, RECENT_POLICY)).toEqual(items.slice(0, 6));
    // a promotable page overtakes an entry evidenced as unopened that ranks below its landing spot
    expect(rerankByAffinity(items, 6, affOf({ g: coldOpened, f: coldUnopened }), id, RECENT_POLICY)).toEqual(["a", "b", "c", "d", "e", "g"]);
    // …but never an entry with no evidence, nor one ranked above where it lands (g lands at index 4)
    expect(rerankByAffinity(items, 6, affOf({ g: coldOpened }), id, RECENT_POLICY)).toEqual(items.slice(0, 6));
    expect(rerankByAffinity(items, 6, affOf({ g: coldOpened, d: coldUnopened }), id, RECENT_POLICY)).toEqual(items.slice(0, 6));
    // a page two places below the cut lands ON the last slot, so it has nobody below it to overtake
    expect(rerankByAffinity(items, 6, affOf({ h: coldOpened, f: coldUnopened }), id, RECENT_POLICY)).toEqual(items.slice(0, 6));
  });

  test("review repros: one open never displaces anything", () => {
    const p = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const id = (x: string) => x;
    // p3–p5 opened, p6 opened once → p2 (no evidence) used to be displaced
    const a = affOf({ p3: coldOpened, p4: coldOpened, p5: coldOpened, p6: coldOnce });
    expect(rerankByAffinity(p, 6, a, id, RECENT_POLICY)).toEqual(p.slice(0, 6));
    // a single open of p7 used to displace p5
    expect(rerankByAffinity(p, 6, affOf({ p7: coldOnce }), id, RECENT_POLICY)).toEqual(p.slice(0, 6));
  });

  test("spine policy: one slot at most, native order kept", () => {
    const items = ["h1", "h2", "h3", "h4", "h5", "h6"];
    const aff = affOf({ h1: coldDemoted, h2: coldDemoted });
    expect(rerankByAffinity(items, 4, aff, (x) => x, SPINE_POLICY)).toEqual(["h1", "h3", "h4", "h5"]);
  });
});

describe("refresh", () => {
  const PAGE = "docs/wiki/3_decision/a.md";
  const banner = `----- [llmwiki] index -----\n  • A  →  ${PAGE}`;

  function withPage(r: string): void {
    const f = join(r, PAGE);
    mkdirSync(join(r, "docs", "wiki", "3_decision"), { recursive: true });
    writeFileSync(f, "---\ntitle: A\n---\nbody\n");
    const t = (Date.now() - 10 * DAY) / 1000;
    utimesSync(f, t, t);
  }

  /** A Claude transcript for `session` that opened PAGE in `r` (or opened nothing). */
  function claudeTranscript(dir: string, session: string, r: string | null): string {
    const f = join(dir, `${session}.jsonl`);
    const line = r
      ? JSON.stringify({
          type: "assistant",
          timestamp: new Date(Date.now() + 1000).toISOString(),
          cwd: r,
          message: { content: [{ type: "tool_use", name: "Read", input: { file_path: join(r, PAGE) } }] },
        })
      : JSON.stringify({ type: "user", message: { content: "hi" } });
    writeFileSync(f, line + "\n");
    return settle(f);
  }

  test("only observed sessions count; the file is private and refreshing is not project use", () => {
    const r = repo();
    withPage(r);
    recordEmission(r, "sess-open", "cold_start", banner);
    recordEmission(r, "sess-none", "cold_start", banner);
    recordEmission(r, "sess-unseen", "cold_start", banner); // no transcript anywhere
    const long = new Date(Date.now() - 40 * DAY);
    markProjectUsed(r, long);
    const dir = scratch();
    const files = [claudeTranscript(dir, "sess-open", r), claudeTranscript(dir, "sess-none", null)];

    const res = refreshAffinity(r, Date.now() + 2000, sources({ claudeTranscripts: files }));

    expect(res.status).toBe("written");
    if (res.status !== "written") return;
    expect(res.affinity.pages[PAGE]?.cold_start).toEqual(ev(2, 1, 1));
    expect(res.affinity.observedEmissions).toBe(2);
    const file = projectStatePath(r, "observe", "affinity.json");
    expect(JSON.parse(readFileSync(file, "utf-8")).pages[PAGE].cold_start.sessions).toBe(2);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const meta = JSON.parse(readFileSync(projectStatePath(r, "meta.json"), "utf-8"));
    expect(meta.lastUsed).toBe(long.toISOString());
  });

  test("a transcript still being written is left for the next refresh (unobserved)", () => {
    const r = repo();
    withPage(r);
    recordEmission(r, "sess-live", "cold_start", banner);
    const f = claudeTranscript(scratch(), "sess-live", r);
    settle(f, Date.now()); // touched just now — the session may not be over
    const res = refreshAffinity(r, Date.now() + 2000, sources({ claudeTranscripts: [f] }));
    expect(res.status === "written" && res.affinity.observedEmissions).toBe(0);
  });

  test("a locked/unreadable OpenCode store observes nothing, so nothing is demoted", () => {
    const r = repo();
    withPage(r);
    for (let i = 0; i < 10; i += 1) recordEmission(r, `oc-${i}`, "cold_start", banner);
    const res = refreshAffinity(r, Date.now() + 2000, sources({ opencode: () => [] }));
    expect(res.status === "written" && res.affinity.pages).toEqual({});
  });

  test("no engine state vs no ledger are told apart", () => {
    const bare = repo();
    expect(refreshAffinity(bare, Date.now(), sources()).status).toBe("no-state");
    const stateful = repo();
    ensureProjectStateDir(stateful, "observe");
    expect(refreshAffinity(stateful, Date.now(), sources()).status).toBe("no-ledger");
  });

  test("the daemon pass refreshes each enrolled project once a day, and isolates failures", () => {
    const a = repo();
    const b = repo();
    const off = repo();
    for (const r of [a, b, off]) recordEmission(r, "sess-1", "cold_start", banner);
    disable(off);
    let discoveries = 0;
    const discover = () => {
      discoveries += 1;
      return sources();
    };
    const t0 = Date.now() + 1000;

    expect(refreshDueAffinity(t0, discover)).toEqual({ refreshed: 2, failed: [] });
    expect(refreshDueAffinity(t0 + 60 * 60 * 1000, discover)).toEqual({ refreshed: 0, failed: [] });
    expect(discoveries).toBe(1); // nothing due → the harness stores are not even discovered
    expect(existsSync(projectStatePath(off, "observe", "affinity.json"))).toBe(false);

    // b's aggregate path is now unwritable: b fails, a still refreshes, the pass completes
    rmSync(projectStatePath(b, "observe", "affinity.json"));
    mkdirSync(join(projectStatePath(b, "observe", "affinity.json"), "blocker"), { recursive: true });
    const next = refreshDueAffinity(t0 + 25 * 60 * 60 * 1000, discover);
    expect(next.refreshed).toBe(1);
    expect(next.failed.map((f) => f.worktree)).toEqual([b]);
  });

  test("an in-repo .llmwiki/ affinity file is never read — a repository cannot steer its injection", () => {
    const plain = scratch(); // not a git worktree: readProjectState would fall back to .llmwiki/
    mkdirSync(join(plain, ".llmwiki", "observe"), { recursive: true });
    writeFileSync(join(plain, ".llmwiki", "observe", "affinity.json"), JSON.stringify(affOf({ x: coldDemoted })));
    expect(loadAffinity(plain)).toBeNull();
    const r = repo(); // a git worktree with no engine identity yet
    mkdirSync(join(r, ".llmwiki", "observe"), { recursive: true });
    writeFileSync(join(r, ".llmwiki", "observe", "affinity.json"), JSON.stringify(affOf({ x: coldDemoted })));
    expect(loadAffinity(r)).toBeNull();
  });

  test("the reads-only line prefilter keeps Windows and docs-relative Read paths", () => {
    const dir = scratch();
    const f = join(dir, "s.jsonl");
    const read = (file_path: string, cwd: string) =>
      JSON.stringify({ type: "assistant", cwd, message: { content: [{ type: "tool_use", name: "Read", input: { file_path } }] } });
    writeFileSync(
      f,
      [read("C:\\Users\\me\\repo\\docs\\wiki\\a.md", "C:\\Users\\me\\repo"), read("wiki/b.md", "/w/repo/docs"), "{}"].join("\n") + "\n",
    );
    const full = scanTranscript(f).reads.map((x) => x.page);
    expect(full).toEqual(["docs/wiki/a.md", "docs/wiki/b.md"]);
    expect(scanTranscript(f, true).reads.map((x) => x.page)).toEqual(full);
  });

  test("the transcript byte budget skips an oversized file instead of stopping at it", () => {
    const dir = scratch();
    const big = join(dir, "big.jsonl");
    writeFileSync(big, "x".repeat(4096));
    settle(big, Date.now() - 1000);
    const small = join(dir, "small.jsonl");
    writeFileSync(small, "y");
    settle(small, Date.now() - 2000);
    expect(pickRecentTranscripts([big, small], 0, 100)).toEqual([small]);
    expect(pickRecentTranscripts([big, small], 0, 1e6, Date.now() - 1500)).toEqual([small]); // untilMs
  });

  test("loading on a repository with no state creates nothing", () => {
    const r = repo();
    expect(loadAffinity(r)).toBeNull();
    expect(existsSync(join(r, ".git", "llmwiki", "index-id"))).toBe(false);
    expect(existsSync(join(stateRoot, "projects"))).toBe(false);
  });
});

describe("cold start reranks without adding context", () => {
  // Eight pages with equal-length titles and paths, newest first p1…p8, so a swap of WHICH page
  // fills a slot cannot change the byte count.
  function wikiRepo(): string {
    const r = repo();
    const dir = join(r, "docs", "wiki", "3_decision");
    mkdirSync(dir, { recursive: true });
    for (let i = 1; i <= 8; i += 1) {
      const f = join(dir, `p${i}.md`);
      writeFileSync(f, `---\ntitle: Page ${i}\n---\nbody ${i}\n`);
      const t = (Date.now() - 10 * DAY - i * 60_000) / 1000;
      utimesSync(f, t, t);
    }
    return r;
  }
  const P = (i: number) => `docs/wiki/3_decision/p${i}.md`;

  test("a never-opened page yields its slot, the newest never do; a well-opened page is promoted", () => {
    const r = wikiRepo();
    const base = buildContext(r);
    expect(pathsOf(base)).toEqual([1, 2, 3, 4, 5, 6].map(P));

    writeAffinity(r, { [P(1)]: coldDemoted, [P(3)]: coldDemoted });
    const demoted = buildContext(r);
    expect(pathsOf(demoted)).toEqual([1, 2, 4, 5, 6, 7].map(P)); // p1 protected, p3 yielded to p7
    expect(Buffer.byteLength(demoted)).toBeLessThanOrEqual(Buffer.byteLength(base));

    writeAffinity(r, { [P(7)]: coldOpened, [P(6)]: coldUnopened });
    const promoted = buildContext(r);
    expect(pathsOf(promoted)).toEqual([1, 2, 3, 4, 5, 7].map(P));
    expect(Buffer.byteLength(promoted)).toBeLessThanOrEqual(Buffer.byteLength(base));
  });

  test("missing, corrupt, stale, or sub-threshold affinity is byte-identical to the baseline", () => {
    const r = wikiRepo();
    const base = buildContext(r);
    writeRaw(r, "{not json");
    expect(buildContext(r)).toBe(base);
    writeAffinity(r, { [P(3)]: coldDemoted }, Date.now() - 8 * DAY);
    expect(buildContext(r)).toBe(base);
    expect(loadAffinity(r)).toBeNull();
    writeAffinity(r, { [P(3)]: { cold_start: ev(7, 0, 5) }, [P(4)]: { cold_start: ev(30, 0, 1) } });
    expect(buildContext(r)).toBe(base);
    writeAffinity(r, { [P(3)]: coldDemoted });
    expect(buildContext(r, { affinity: null })).toBe(base); // the bench seam ignores the live file
  });

  test("simulation: 3 daily refreshes × 10 sessions/day × 0 opens keeps the newest page and moves ≤ 2 slots", () => {
    const r = wikiRepo();
    const base = pathsOf(buildContext(r));
    ensureProjectStateDir(r, "observe");
    const ledger = projectStatePath(r, "observe", "emissions.jsonl");
    const dir = scratch();
    const transcripts: string[] = [];
    const now = Date.now();
    for (let day = 0; day < 3; day += 1) {
      const dayStart = now - (3 - day) * DAY;
      for (let s = 0; s < 10; s += 1) {
        resetAffinityCache();
        const out = buildContext(r);
        const session = `sim-${day}-${s}`;
        appendFileSync(
          ledger,
          JSON.stringify({ ts: dayStart + s * 60_000, session, channel: "cold_start", root: r, pages: pathsOf(out), bytes: Buffer.byteLength(out) }) + "\n",
        );
        const t = join(dir, `${session}.jsonl`);
        writeFileSync(t, JSON.stringify({ type: "user", message: { content: "nothing opened" } }) + "\n");
        settle(t, dayStart + 11 * 60 * 60 * 1000); // the session ended before that day's refresh
        transcripts.push(t);
      }
      expect(refreshAffinity(r, dayStart + 12 * 60 * 60 * 1000, sources({ claudeTranscripts: transcripts })).status).toBe("written");
    }
    resetAffinityCache();
    const final = pathsOf(buildContext(r));
    expect(final.length).toBe(base.length);
    expect(final[0]).toBe(P(1));
    expect(final).toContain(P(2));
    expect(final.filter((p) => !base.includes(p)).length).toBeLessThanOrEqual(2);
    // …and the loop did act: day 1 alone (one day of evidence) moved nothing, by day 2 the never-
    // opened p3…p6 qualified and the two lowest yielded to p7/p8, which then had only one day.
    expect(final).toEqual([1, 2, 3, 4, 7, 8].map(P));
  });

  test("the spine keeps its size, its order, and lets at most one never-opened hub yield", () => {
    const r = repo();
    const dir = join(r, "docs", "wiki", "4_insight");
    mkdirSync(dir, { recursive: true });
    const names = ["h1", "h2", "h3", "h4", "h5", "s1", "s2", "s3", "s4", "s5", "s6"];
    for (const n of names) writeFileSync(join(dir, `${n}.md`), `---\ntitle: T ${n}\n---\nbody ${n}\n`);
    const idx = new WikiIndex(r);
    idx.indexAll();
    const db = idx.connect();
    const docs = idx.listDocumentsWithContent(db);
    const id = (fn: string) => String(docs.find((d) => String(d.filename) === fn)!.id);
    // h1 has 6 inbound, h2 5, … h5 2 — a strict in-degree order
    ["h1", "h2", "h3", "h4", "h5"].forEach((h, i) => {
      for (let k = 1; k <= 6 - i; k += 1) idx.upsertReference(db, id(`s${k}.md`), id(`${h}.md`), "cites", null);
    });
    db.close();
    const hub = (h: string) => `docs/wiki/4_insight/${h}.md`;

    const base = buildSpine(r, 4, null).join("\n");
    const demoted = buildSpine(r, 4, affOf({ [hub("h1")]: coldDemoted, [hub("h2")]: coldDemoted })).join("\n");
    expect(pathsOf(base)).toEqual(["h1", "h2", "h3", "h4"].map(hub));
    expect(pathsOf(demoted)).toEqual(["h1", "h3", "h4", "h5"].map(hub));
  });
});

describe("turn context reranks within relevance", () => {
  function turnRepo(): string {
    const r = repo();
    const dir = join(r, "docs", "wiki", "3_decision");
    mkdirSync(dir, { recursive: true });
    for (const n of ["qa", "qb", "qc", "qd"]) {
      writeFileSync(
        join(dir, `${n}.md`),
        `---\ntitle: Rollout ${n}\n---\n` + "rollout pipeline stages gate deployment canary. ".repeat(10),
      );
    }
    writeFileSync(
      join(dir, "zz.md"),
      "---\ntitle: Unrelated zz\n---\n" + "gardening tomatoes watering schedule notes. ".repeat(10),
    );
    new WikiIndex(r).indexAll();
    return r;
  }
  const PROMPT = "how does the rollout pipeline gate a canary deployment";

  test("a demoted near-tie yields to the 4th; an opened page is promoted; never an irrelevant one", () => {
    const r = turnRepo();
    const base = buildTurnContext(r, PROMPT);
    const top = pathsOf(base);
    expect(top.length).toBe(3);
    const fourth = ["qa", "qb", "qc", "qd"].map((n) => `docs/wiki/3_decision/${n}.md`).find((p) => !top.includes(p))!;

    writeAffinity(r, { [top[0]!]: coldDemoted }); // cold-start evidence does not steer turns
    expect(buildTurnContext(r, PROMPT)).toBe(base);

    writeAffinity(r, { [top[0]!]: turnDemoted });
    const demoted = buildTurnContext(r, PROMPT);
    expect(pathsOf(demoted).length).toBe(3);
    expect(pathsOf(demoted)).not.toContain(top[0]!);
    expect(pathsOf(demoted)).toContain(fourth);
    expect(Buffer.byteLength(demoted)).toBeLessThanOrEqual(Buffer.byteLength(base));

    writeAffinity(r, { [fourth]: turnOpened, "docs/wiki/3_decision/zz.md": turnOpened });
    const promoted = buildTurnContext(r, PROMPT);
    expect(pathsOf(promoted)[0]).toBe(fourth);
    expect(pathsOf(promoted).length).toBe(3);
    expect(promoted).not.toContain("zz.md"); // affinity never admits a page relevance rejected
    expect(Buffer.byteLength(promoted)).toBeLessThanOrEqual(Buffer.byteLength(base));
  });

  test("missing, corrupt, stale, or sub-threshold affinity is byte-identical to the baseline", () => {
    const r = turnRepo();
    const base = buildTurnContext(r, PROMPT);
    expect(base).not.toBe("");
    const top = pathsOf(base)[0]!;
    writeRaw(r, JSON.stringify({ version: 2, generatedAt: "x", pages: [] }));
    expect(buildTurnContext(r, PROMPT)).toBe(base);
    writeAffinity(r, { [top]: turnDemoted }, Date.now() - 8 * DAY);
    expect(buildTurnContext(r, PROMPT)).toBe(base);
    writeAffinity(r, { [top]: { turn_context: ev(7, 0, 4) } });
    expect(buildTurnContext(r, PROMPT)).toBe(base);
    writeAffinity(r, { [top]: turnDemoted });
    expect(buildTurnContext(r, PROMPT, "", { affinity: null })).toBe(base); // the bench seam
  });
});

describe("surfaces", () => {
  test("the daemon loop refreshes affinity on its own daily clock, not at startup", () => {
    const watch = readFileSync(join(import.meta.dir, "..", "src", "daemon", "watch.ts"), "utf-8");
    const loop = watch.slice(watch.indexOf("async function pollLoop"), watch.indexOf("await Bun.sleep"));
    expect(loop).toContain("refreshAffinityIfDue();");
    expect(watch).toContain("const AFFINITY_INTERVAL_MS = 24 * 60 * 60 * 1000;");
    expect(watch).toContain("let lastAffinityAt = Date.now() - AFFINITY_INTERVAL_MS + AFFINITY_STARTUP_DELAY_MS;");
  });

  test("bench measures with affinity pinned off", () => {
    for (const f of ["bench.ts", "bench-scale.ts"]) {
      const src = readFileSync(join(import.meta.dir, "..", "src", "engine", f), "utf-8");
      for (const call of src.match(/build(?:Turn)?Context\([^)]*\)/g) ?? []) expect(call).toContain("affinity: null");
    }
  });

  function cli(args: string[]) {
    const home = scratch();
    // Every harness location points into an empty temp home: the refresh must not read the
    // developer's real transcript stores.
    return Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
      env: {
        ...process.env,
        LLMWIKI_STATE_DIR: stateRoot,
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CONFIG_HOME: join(home, ".config"),
        OPENCODE_DB: join(home, "opencode.db"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  }

  test("downstream-read --refresh-affinity refreshes one enrolled repo on demand", () => {
    const r = repo();
    recordEmission(r, "sess-1", "cold_start", "----- [llmwiki] index -----\n  • A  →  docs/wiki/3_decision/a.md");
    const result = cli(["downstream-read", r, "--refresh-affinity"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("page affinity: 0/1 emission(s) in the last 30d observed");
    expect(JSON.parse(readFileSync(projectStatePath(r, "observe", "affinity.json"), "utf-8")).emissions).toBe(1);
  });

  test("downstream-read --refresh-affinity refuses an unenrolled repo", () => {
    const r = repo();
    recordEmission(r, "sess-1", "cold_start", "----- [llmwiki] index -----\n  • A  →  docs/wiki/3_decision/a.md");
    disable(r);
    const result = cli(["downstream-read", r, "--refresh-affinity"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("not enrolled");
    expect(existsSync(projectStatePath(r, "observe", "affinity.json"))).toBe(false);
  });
});
