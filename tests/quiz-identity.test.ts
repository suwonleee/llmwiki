// Per-person quiz ledger — the forgetting curve is per-HUMAN.
//
// A single shared quiz-ledger.md in a team repo interleaves everyone's review history into
// everyone's scheduling (someone else's "correct" advances MY box). The ledger is therefore
// per-identity: quiz-ledger.<id>.md, with <id> resolved deterministically and offline
// (LLMWIKI_QUIZ_IDENTITY env → git email local-part → git user.name → "me"). The contract
// under test: identities are isolated; the pre-identity bare ledger is adopted ONCE with its
// history intact; solo use keeps exactly one file and never notices the mechanism.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadLedger, quizIdentity, recordResult } from "../src/engine/quiz.ts";
import { _resetForTests } from "../src/engine/config.ts";

const tmps: string[] = [];
function mkRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-qid-"));
  tmps.push(root);
  // a quizzable page (recordResult validates the page exists under a category dir)
  mkdirSync(join(root, "docs", "wiki", "3_decision"), { recursive: true });
  writeFileSync(join(root, "docs", "wiki", "3_decision", "d.md"), "---\ntitle: d\n---\n\n- x\n");
  return root;
}

let envBefore: string | undefined;
beforeEach(() => {
  envBefore = process.env.LLMWIKI_QUIZ_IDENTITY;
});
afterEach(() => {
  if (envBefore === undefined) delete process.env.LLMWIKI_QUIZ_IDENTITY;
  else process.env.LLMWIKI_QUIZ_IDENTITY = envBefore;
  _resetForTests();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("quiz ledger identity", () => {
  test("env identity is sanitized into a safe filename token", () => {
    process.env.LLMWIKI_QUIZ_IDENTITY = "Ada Lovelace!";
    expect(quizIdentity("/anywhere")).toBe("ada-lovelace");
  });

  test("two identities keep isolated ledgers — one person's result never enters the other's curve", () => {
    const root = mkRoot();
    process.env.LLMWIKI_QUIZ_IDENTITY = "alice";
    recordResult(root, { page: "3_decision/d.md", result: "wrong", date: "2026-07-21" });
    expect(loadLedger(root).entries.length).toBe(1);

    process.env.LLMWIKI_QUIZ_IDENTITY = "bob";
    expect(loadLedger(root).path.endsWith("quiz-ledger.bob.md")).toBe(true);
    expect(loadLedger(root).entries.length).toBe(0); // bob starts fresh

    process.env.LLMWIKI_QUIZ_IDENTITY = "alice";
    expect(loadLedger(root).entries.length).toBe(1); // alice's history untouched
  });

  test("the pre-identity bare ledger is adopted once, history intact", () => {
    const root = mkRoot();
    process.env.LLMWIKI_QUIZ_IDENTITY = "alice";
    // create a real ledger under the legacy name by writing through the engine, then renaming back
    recordResult(root, { page: "3_decision/d.md", result: "wrong", date: "2026-07-21" });
    const dir = join(root, "docs", "wiki", "6_quiz");
    writeFileSync(join(dir, "quiz-ledger.md"), readFileSync(join(dir, "quiz-ledger.alice.md"), "utf-8"));
    rmSync(join(dir, "quiz-ledger.alice.md"));

    process.env.LLMWIKI_QUIZ_IDENTITY = "carol";
    const led = loadLedger(root);
    expect(led.path.endsWith("quiz-ledger.carol.md")).toBe(true);
    expect(led.entries.length).toBe(1); // history carried over
    expect(existsSync(join(dir, "quiz-ledger.md"))).toBe(false); // adopted, not copied
  });
});
