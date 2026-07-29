// quiz — the human memory loop: forgetting-curve scheduling, priority selection, ledger
// round-trip, and the index-exclusion contract (the quiz layer must never enter search).
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INTERVALS,
  QUIZ_MAX_QUESTIONS,
  addDays,
  dueCount,
  loadLedger,
  normalizePage,
  parseLedger,
  quizStatus,
  recordResult,
  renderLedger,
  scanCandidates,
  selectNext,
  weightFor,
  type QuizEntry,
} from "../src/engine/quiz.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { rebuildReferenceGraph } from "../src/engine/refs.ts";
import { defaults, loadFrom, _resetForTests } from "../src/engine/config.ts";
import { migrate } from "../src/engine/migrate.ts";
import { citedTranscripts } from "../src/engine/reconcile.ts";

// Ledgers are per-identity; pin it so filename assertions are machine-independent
// (the git-config fallback would resolve to whoever runs the suite).
process.env.LLMWIKI_QUIZ_IDENTITY = "tester";

const D0 = "2026-07-13"; // fixed dates — the scheduler is deterministic, tests never use real today
const D1 = "2026-07-14";

function page(front: Record<string, string>, body = "content"): string {
  const fm = Object.entries(front)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${fm}\n---\n\n${body}\n`;
}

describe("quiz", () => {
  let root: string;
  let wiki: string;

  const put = (rel: string, front: Record<string, string>) => {
    const abs = join(wiki, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, page(front));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-quiz-"));
    _resetForTests(root); // isolate from the real clone's configs/ — tests run on pure defaults
    wiki = join(root, "docs", "wiki");
    mkdirSync(wiki, { recursive: true });
    put("1_direction/dir-a.md", { title: "방향 A", date: "2026-07-01", domain: "direction", status: "ready" });
    put("3_decision/dec-b.md", { title: "결정 B", date: "2026-07-10", domain: "decision", status: "ready" });
    put("4_insight/ins-c.md", { title: "인사이트 C", date: "2026-07-12", domain: "insight", status: "ready" });
    put("2_milestone/mile-d.md", { title: "마일스톤 D", date: "2026-07-12", domain: "milestone", status: "ready" });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    _resetForTests();
  });

  // ---- primitives ------------------------------------------------------------------------

  test("addDays crosses month boundaries in UTC", () => {
    expect(addDays("2026-07-30", 3)).toBe("2026-08-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("normalizePage accepts docs/wiki-prefixed and wiki-relative paths, rejects traversal", () => {
    expect(normalizePage("docs/wiki/3_decision/x.md")).toBe("3_decision/x.md");
    expect(normalizePage("3_decision/x.md")).toBe("3_decision/x.md");
    expect(() => normalizePage("../secrets.md")).toThrow();
    expect(() => normalizePage("..\\secrets.md")).toThrow();
    expect(() => normalizePage("/etc/x.md")).toThrow();
    expect(() => normalizePage("3_decision/x.txt")).toThrow();
  });

  // The topic encyclopedia sits WITH decisions: a concept that outlived its session is the core
  // of the work, and ranking it under one-off insights is what made the ritual feel like trivia.
  test("weightFor ranks direction > decision·topic > insight > milestone", () => {
    const cfg = defaults();
    const w = (dir: string, domain: string) => weightFor(dir, domain, cfg);
    expect(w("1_direction", "direction")).toBe(4);
    expect(w("3_decision", "decision")).toBe(3);
    expect(w("5_topic", "topic")).toBe(3);
    expect(w("4_insight", "insight")).toBe(2);
    expect(w("2_milestone", "milestone")).toBe(1);
  });

  // ---- forgetting curve (record) ---------------------------------------------------------

  test("new item: correct starts at box 1, wrong/skip at box 0 (due = min 1 day)", () => {
    const a = recordResult(root, { page: "3_decision/dec-b.md", result: "correct", date: D0 });
    expect(a.entry.box).toBe(1);
    expect(a.entry.due).toBe(addDays(D0, INTERVALS[1]!));
    expect(a.isNew).toBe(true);

    const b = recordResult(root, { page: "1_direction/dir-a.md", result: "wrong", date: D0 });
    expect(b.entry.box).toBe(0);
    expect(b.entry.due).toBe(addDays(D0, 1));
  });

  test("correct chain climbs every box and clamps at the last; wrong resets to box 0", () => {
    let d = D0;
    for (let i = 1; i < INTERVALS.length; i++) {
      const r = recordResult(root, { page: "3_decision/dec-b.md", result: "correct", date: d });
      expect(r.entry.box).toBe(i);
      expect(r.entry.due).toBe(addDays(d, INTERVALS[i]!));
      d = r.entry.due;
    }
    // clamp: one more correct stays on the last box
    const top = recordResult(root, { page: "3_decision/dec-b.md", result: "correct", date: d });
    expect(top.entry.box).toBe(INTERVALS.length - 1);
    // forgetting: wrong resets the whole climb
    const reset = recordResult(root, { page: "3_decision/dec-b.md", result: "wrong", date: top.entry.due });
    expect(reset.entry.box).toBe(0);
    expect(reset.entry.due).toBe(addDays(top.entry.due, 1));
  });

  test("skip schedules like wrong but doesn't count as correct", () => {
    recordResult(root, { page: "3_decision/dec-b.md", result: "correct", date: D0 });
    const r = recordResult(root, { page: "3_decision/dec-b.md", result: "skip", date: D1 });
    expect(r.entry.box).toBe(0);
    expect(r.entry.asked).toBe(2);
    expect(r.entry.correct).toBe(1);
    expect(r.entry.lastResult).toBe("skip");
  });

  test("record validates result / date / page existence", () => {
    expect(() => recordResult(root, { page: "3_decision/dec-b.md", result: "maybe" as any, date: D0 })).toThrow();
    expect(() => recordResult(root, { page: "3_decision/dec-b.md", result: "correct", date: "13-07-2026" })).toThrow();
    expect(() => recordResult(root, { page: "3_decision/nope.md", result: "correct", date: D0 })).toThrow();
  });

  // ---- ledger ------------------------------------------------------------------------------

  test("ledger round-trips through render/parse, including '-->' sanitization in questions", () => {
    recordResult(root, { page: "3_decision/dec-b.md", result: "correct", date: D0, question: "A --> B 를 왜 택했나?" });
    recordResult(root, { page: "1_direction/dir-a.md", result: "wrong", date: D0, question: "방향은?" });
    const { entries } = loadLedger(root);
    expect(entries.length).toBe(2);
    const dec = entries.find((e) => e.page === "3_decision/dec-b.md")!;
    expect(dec.lastQ).toBe("A → B 를 왜 택했나?"); // "-->" would terminate the HTML marker
    const reparsed = parseLedger(renderLedger(entries, D0, "en"));
    expect(reparsed).toEqual([...entries].sort((a, b) => (a.due < b.due ? -1 : 1)));
  });

  test("malformed markers are skipped, valid lines survive", () => {
    const good: QuizEntry = {
      page: "3_decision/dec-b.md", box: 2, due: "2026-07-20", asked: 3, correct: 2,
      last: D0, lastResult: "correct", lastQ: "q",
    };
    const md = renderLedger([good], D0, "en") + `\n- junk <!-- quiz:{"page":"x.md","box":99} -->\n- worse <!-- quiz:{not json} -->\n`;
    expect(parseLedger(md)).toEqual([good]);
  });

  // ---- selection ---------------------------------------------------------------------------

  test("new candidates rank by weight then recency; superseded/draft excluded", () => {
    put("3_decision/dec-old.md", { title: "폐기", date: "2026-07-11", domain: "decision", status: "superseded" });
    put("4_insight/ins-draft.md", { title: "드래프트", date: "2026-07-12", domain: "insight", status: "draft" });
    const sel = selectNext(root, { limit: 10, date: D0 });
    expect(sel.picks.map((p) => p.page)).toEqual([
      "1_direction/dir-a.md", // weight 4
      "3_decision/dec-b.md", // weight 3
      "4_insight/ins-c.md", // weight 2
      "2_milestone/mile-d.md", // weight 1
    ]);
    expect(sel.newCandidates).toBe(4);
  });

  // Category alone cannot tell a landmark decision from a passing one. Within a tier the wiki's
  // own graph breaks the tie: a page other pages kept citing is what the work was built on, while
  // one nobody linked is the incidental record that made the ritual feel like trivia. Recency
  // stays the final key, so hub-ness orders first exposure without removing anything.
  test("new candidates: hubs before non-hubs within a weight tier, recency after", () => {
    // Same weight (decision), and the hub is the OLDER page — recency alone would rank it last.
    writeFileSync(join(wiki, "3_decision", "dec-hub.md"), page({ title: "허브 결정", date: "2026-07-02", domain: "decision", status: "ready" }));
    writeFileSync(join(wiki, "3_decision", "dec-lonely.md"), page({ title: "고립 결정", date: "2026-07-12", domain: "decision", status: "ready" }));
    // Two pages cite the hub → inbound 2, the same threshold the cold-start spine calls a hub.
    writeFileSync(
      join(wiki, "2_milestone", "cites-1.md"),
      page({ title: "인용 1", date: "2026-07-13", domain: "milestone", status: "ready" }, "기반: [[3_decision/dec-hub]]"),
    );
    writeFileSync(
      join(wiki, "2_milestone", "cites-2.md"),
      page({ title: "인용 2", date: "2026-07-13", domain: "milestone", status: "ready" }, "역시 [[3_decision/dec-hub]]"),
    );
    const w = new WikiIndex(root);
    w.init();
    w.indexAll();
    rebuildReferenceGraph(w);

    const cands = scanCandidates(root);
    expect(cands.find((c) => c.page === "3_decision/dec-hub.md")?.hub).toBe(true);
    expect(cands.find((c) => c.page === "3_decision/dec-lonely.md")?.hub).toBe(false);

    const decisions = selectNext(root, { limit: 10, date: D0 })
      .picks.map((p) => p.page)
      .filter((p) => p.startsWith("3_decision/"));
    expect(decisions).toEqual([
      "3_decision/dec-hub.md", // referenced twice → asked first despite being the oldest (07-02)
      "3_decision/dec-lonely.md", // unreferenced, newest (07-12) — recency still orders the rest
      "3_decision/dec-b.md", // unreferenced, older (07-10)
    ]);
  });

  test("new candidates: no index yet → selection still works, every page a non-hub", () => {
    const cands = scanCandidates(root); // beforeEach never indexes
    expect(cands.every((c) => c.refs === 0 && !c.hub)).toBe(true);
    expect(selectNext(root, { limit: 10, date: D0 }).picks.length).toBe(4);
  });

  test("priority: wrong-due before review-due before new; asked-today excluded", () => {
    recordResult(root, { page: "3_decision/dec-b.md", result: "wrong", date: "2026-07-10" }); // due 07-11
    recordResult(root, { page: "1_direction/dir-a.md", result: "correct", date: "2026-07-12" }); // box1, due 07-15
    recordResult(root, { page: "4_insight/ins-c.md", result: "correct", date: "2026-07-01" }); // box1, due 07-04
    const sel = selectNext(root, { limit: 10, date: D0 });
    expect(sel.picks.map((p) => `${p.kind}:${p.page}`)).toEqual([
      "wrong-due:3_decision/dec-b.md",
      "review-due:4_insight/ins-c.md",
      "new:2_milestone/mile-d.md", // dir-a is scheduled in the future → not selected
    ]);
    // same-day exclusion: everything asked today drops out of rotation
    recordResult(root, { page: "3_decision/dec-b.md", result: "correct", date: D0 });
    recordResult(root, { page: "4_insight/ins-c.md", result: "correct", date: D0 });
    const again = selectNext(root, { limit: 10, date: D0 });
    expect(again.picks.map((p) => p.page)).toEqual(["2_milestone/mile-d.md"]);
    expect(again.askedToday).toBe(2);
  });

  test("limit caps the pick list but counts stay global", () => {
    const sel = selectNext(root, { limit: 2, date: D0 });
    expect(sel.picks.length).toBe(2);
    expect(sel.newCandidates).toBe(4);
  });

  test("session size: no limit → config [quiz] questions (3); explicit limit clamps at the fixed ceiling", () => {
    const sel = selectNext(root, { date: D0 }); // stock default: 3 of the 4 candidates
    expect(sel.limit).toBe(3);
    expect(sel.picks.length).toBe(3);
    expect(sel.newCandidates).toBe(4); // counts stay global past the default cap
    const capped = selectNext(root, { limit: 99, date: D0 });
    expect(capped.limit).toBe(QUIZ_MAX_QUESTIONS); // ceiling, even when asked for more
    expect(quizStatus(root, { date: D0 }).questions).toBe(3);
    expect(quizStatus(root, { date: D0 }).maxQuestions).toBe(QUIZ_MAX_QUESTIONS);
  });

  test("vanished page: excluded + reported by select, pruned by the next record", () => {
    recordResult(root, { page: "4_insight/ins-c.md", result: "wrong", date: "2026-07-10" });
    unlinkSync(join(wiki, "4_insight/ins-c.md"));
    const sel = selectNext(root, { limit: 10, date: D0 });
    expect(sel.missing).toEqual(["4_insight/ins-c.md"]);
    expect(sel.picks.some((p) => p.page.includes("ins-c"))).toBe(false);
    const r = recordResult(root, { page: "3_decision/dec-b.md", result: "correct", date: D0 });
    expect(r.pruned).toEqual(["4_insight/ins-c.md"]);
    expect(loadLedger(root).entries.map((e) => e.page)).toEqual(["3_decision/dec-b.md"]);
  });

  test("ledger page that goes superseded leaves rotation silently (not 'missing')", () => {
    recordResult(root, { page: "3_decision/dec-b.md", result: "wrong", date: "2026-07-10" });
    put("3_decision/dec-b.md", { title: "결정 B", date: "2026-07-10", domain: "decision", status: "superseded" });
    const sel = selectNext(root, { limit: 10, date: D0 });
    expect(sel.missing).toEqual([]);
    expect(sel.picks.some((p) => p.page === "3_decision/dec-b.md")).toBe(false);
  });

  // ---- status + cold-start hint --------------------------------------------------------------

  test("quizStatus surfaces weak spots (<50% over 3+ asks) and nextDue", () => {
    recordResult(root, { page: "3_decision/dec-b.md", result: "wrong", date: "2026-07-01" });
    recordResult(root, { page: "3_decision/dec-b.md", result: "wrong", date: "2026-07-02" });
    recordResult(root, { page: "3_decision/dec-b.md", result: "correct", date: "2026-07-03" });
    recordResult(root, { page: "1_direction/dir-a.md", result: "correct", date: D0 }); // due 07-16
    const s = quizStatus(root, { date: D0 });
    expect(s.weak).toEqual([{ page: "3_decision/dec-b.md", asked: 3, correct: 1 }]);
    expect(s.nextDue).toBe("2026-07-16");
    expect(s.total).toBe(2);
  });

  test("dueCount: due-and-unasked-today only, vanished pages don't count, no ledger → 0", () => {
    expect(dueCount(root, D0)).toBe(0);
    recordResult(root, { page: "3_decision/dec-b.md", result: "wrong", date: "2026-07-10" }); // due 07-11
    recordResult(root, { page: "1_direction/dir-a.md", result: "wrong", date: D0 }); // due 07-14, asked today
    expect(dueCount(root, D0)).toBe(1);
    expect(dueCount(root, D1)).toBe(2);
    unlinkSync(join(wiki, "3_decision/dec-b.md"));
    expect(dueCount(root, D0)).toBe(0);
  });

  // ---- the exclusion contract (quiz layer never enters the index) ----------------------------

  test("indexAll never indexes docs/wiki/6_quiz and self-heals previously indexed rows", () => {
    recordResult(root, { page: "3_decision/dec-b.md", result: "correct", date: D0 });
    writeFileSync(join(wiki, "6_quiz", `${D0}-quiz.md`), page({ title: "quiz", date: D0, domain: "quiz" }, "세션 기록"));
    const idx = new WikiIndex(root);
    const conn = idx.connect();
    idx.indexAll(conn);
    const quizRows = conn
      .query("SELECT COUNT(*) n FROM documents WHERE relative_path LIKE 'docs/wiki/6_quiz/%'")
      .get() as { n: number };
    expect(quizRows.n).toBe(0);
    // self-heal: a row indexed before the guard existed is pruned by the next indexAll
    conn.run(
      "INSERT INTO documents (filename, relative_path, source_kind, file_type) VALUES (?, ?, ?, ?)",
      ["legacy.md", "docs/wiki/6_quiz/legacy.md", "wiki", "md"],
    );
    idx.indexAll(conn);
    const healed = conn
      .query("SELECT COUNT(*) n FROM documents WHERE relative_path LIKE 'docs/wiki/6_quiz/%'")
      .get() as { n: number };
    expect(healed.n).toBe(0);
    conn.close();
  });

  test("a custom [quiz] dir from config is excluded the same way", () => {
    const clone = mkdtempSync(join(tmpdir(), "llmwiki-quizcfg-"));
    try {
      writeFileSync(join(clone, "llmwiki.config.toml"), `config_version = 1\n\n[quiz]\ndir = "9_memory"\n`);
      _resetForTests(clone);
      mkdirSync(join(wiki, "9_memory"), { recursive: true });
      writeFileSync(join(wiki, "9_memory", "quiz-ledger.md"), "ledger body");
      const idx = new WikiIndex(root);
      const conn = idx.connect();
      idx.indexAll(conn);
      const rows = conn
        .query("SELECT COUNT(*) n FROM documents WHERE relative_path LIKE 'docs/wiki/9_memory/%'")
        .get() as { n: number };
      expect(rows.n).toBe(0);
      conn.close();
      // and the quiz commands follow the same dir
      recordResult(root, { page: "3_decision/dec-b.md", result: "wrong", date: D0 });
      expect(loadLedger(root).path.endsWith("9_memory/quiz-ledger.tester.md")).toBe(true);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test("config validation rejects a quizDir colliding with a content dir (else the category silently unindexes)", () => {
    const clone = mkdtempSync(join(tmpdir(), "llmwiki-quizcol-"));
    try {
      const toml = join(clone, "c.toml");
      writeFileSync(toml, `config_version = 1\n\n[quiz]\ndir = "3_decision"\n`);
      const cfg = loadFrom(toml);
      expect(cfg.error ?? "").toContain("quizDir collides");
      expect(cfg.quizDir).toBe("6_quiz"); // fail-safe fallback to defaults
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test("reconcile's citation scan never harvests transcripts cited inside the quiz layer", () => {
    put("2_milestone/cited.md", { title: "cited", date: D0, domain: "milestone", status: "ready", source: "real.jsonl" });
    recordResult(root, { page: "3_decision/dec-b.md", result: "correct", date: D0 }); // creates 6_quiz/
    writeFileSync(
      join(wiki, "6_quiz", `${D0}-quiz.md`),
      page({ title: "quiz", date: D0, domain: "quiz", source: "sneaky.jsonl" }, "note\n\n[^1]: sneaky2.jsonl"),
    );
    const cited = citedTranscripts(root);
    expect(cited.has("real.jsonl")).toBe(true); // real wiki citations still count
    expect(cited.has("sneaky.jsonl")).toBe(false);
    expect(cited.has("sneaky2.jsonl")).toBe(false);
  });

  test("migrate category rename remaps ledger identities — the schedule survives", () => {
    // Regression: bare-path ledger identities match none of rewriteLinks' tokens; a rename
    // used to orphan every entry ("missing" → pruned → re-quizzed from zero).
    recordResult(root, { page: "3_decision/dec-b.md", result: "wrong", date: "2026-07-10" }); // stock config
    const clone = mkdtempSync(join(tmpdir(), "llmwiki-quizren-"));
    try {
      writeFileSync(
        join(clone, "llmwiki.config.toml"),
        `config_version = 1\n\n[[category]]\ndir = "3_adr"\ndomain = "adr"\nreview = "model"\nguide = "adr"\n`,
      );
      _resetForTests(clone);
      const r = migrate(root, { commit: true });
      expect(r.verdict).toBe("migrated");
      expect(r.quizLedgerRemapped).toBe(1);
      expect(loadLedger(root).entries.map((e) => e.page)).toEqual(["3_adr/dec-b.md"]);
      const sel = selectNext(root, { limit: 10, date: D0 });
      expect(sel.missing).toEqual([]);
      expect(sel.picks.some((p) => p.kind === "wrong-due" && p.page === "3_adr/dec-b.md")).toBe(true);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test("dueCount agrees with selectNext when a due page goes superseded (no phantom nag)", () => {
    recordResult(root, { page: "3_decision/dec-b.md", result: "wrong", date: "2026-07-10" });
    expect(dueCount(root, D0)).toBe(1);
    put("3_decision/dec-b.md", { title: "결정 B", date: "2026-07-10", domain: "decision", status: "superseded" });
    expect(dueCount(root, D0)).toBe(0);
    expect(loadLedger(root).entries.length).toBe(1); // entry retained (history), just out of rotation
  });

  test("recordResult only accepts pages from quizzable dirs (not queue/L0/the ledger itself)", () => {
    mkdirSync(join(wiki, "0_review"), { recursive: true });
    writeFileSync(join(wiki, "0_review", "q.md"), page({ title: "q", date: D0 }));
    writeFileSync(join(wiki, "current-state.md"), page({ title: "L0", date: D0 }));
    expect(() => recordResult(root, { page: "0_review/q.md", result: "correct", date: D0 })).toThrow();
    expect(() => recordResult(root, { page: "current-state.md", result: "correct", date: D0 })).toThrow();
    recordResult(root, { page: "3_decision/dec-b.md", result: "wrong", date: D0 }); // creates the ledger
    expect(() => recordResult(root, { page: "6_quiz/quiz-ledger.md", result: "correct", date: D0 })).toThrow();
  });

  test("parseLedger drops non-canonical page identities (traversal guard)", () => {
    const mk = (p: string) =>
      `- x <!-- quiz:{"page":${JSON.stringify(p)},"box":0,"due":"2026-07-14","asked":1,"correct":0,"last":"2026-07-13","lastResult":"wrong","lastQ":""} -->`;
    expect(parseLedger([mk("../../etc/x.md"), mk("docs/wiki/3_decision/x.md")].join("\n"))).toEqual([]);
    expect(parseLedger(mk("3_decision/x.md")).length).toBe(1);
  });

  test("migrate never treats the quiz dir as a stray/renamable numbered dir", () => {
    // Regression: a config category numbered 7 (7_adr) + on-disk 6_quiz used to pair by
    // leading number — migrate would RENAME the quiz layer into a content category.
    const clone = mkdtempSync(join(tmpdir(), "llmwiki-quizmig-"));
    try {
      writeFileSync(
        join(clone, "llmwiki.config.toml"),
        `config_version = 1\n\n[[category]]\ndir = "7_adr"\ndomain = "adr"\nreview = "model"\nguide = "adr"\n`,
      );
      _resetForTests(clone);
      mkdirSync(join(wiki, "6_quiz"), { recursive: true });
      const r = migrate(root, {});
      expect(r.verdict).toBe("conforms"); // no rename pairs — 6_quiz is expected structure
      expect(r.strays ?? []).not.toContain("6_quiz");
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  test("scanCandidates ignores the quiz layer itself and the 0_review queue", () => {
    recordResult(root, { page: "3_decision/dec-b.md", result: "correct", date: D0 }); // creates 6_quiz/
    writeFileSync(join(wiki, "6_quiz", `${D0}-quiz.md`), page({ title: "q", date: D0, domain: "quiz" }));
    mkdirSync(join(wiki, "0_review"), { recursive: true });
    writeFileSync(join(wiki, "0_review", "question.md"), page({ title: "review Q", date: D0 }));
    const pages = scanCandidates(root).map((c) => c.page);
    expect(pages.some((p) => p.startsWith("6_quiz/") || p.startsWith("0_review/"))).toBe(false);
  });
});
