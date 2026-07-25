// Two boundaries that hold even when something on the machine is hostile or mistyped.
//
// 1. The per-turn state file lives at a DERIVABLE path in a shared temp dir (name = hash of
//    session id + repo). Writing it with a plain write follows a symlink planted there by
//    another local user, turning read-injection into an arbitrary-file write as the victim.
// 2. `wiki-clean-apply --review <file>` reads a file, applies its accepted candidates, and then
//    DELETES it. A path outside the repository must be refused before anything is deleted —
//    a mistyped flag should not remove one of the user's files.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTurnContext, _turnStatePath } from "../src/engine/turncontext.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { applyWikiCleanReview, WikiCleanReviewError } from "../src/engine/wiki-clean.ts";

const roots: string[] = [];
const strays: string[] = [];

function mkWiki(): string {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-hardening-"));
  roots.push(root);
  const dir = join(root, "docs", "wiki", "3_decision");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "parse-amount.md"),
    "---\ntitle: Amount parsing\ndescription: fixture\ndate: 2026-07-25\ntags: [fixture, parse]\nstatus: ready\n---\n\n- `parseAmount` strips separators before Number() in src/parser.ts\n",
    "utf8",
  );
  new WikiIndex(root).indexAll();
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const stray of strays.splice(0)) rmSync(stray, { recursive: true, force: true });
});

describe("local hardening", () => {
  test("per-turn state never writes through a symlink planted in the temp dir", () => {
    const root = mkWiki();
    const sessionId = "session-hardening-1";
    const statePath = _turnStatePath(root, sessionId);
    rmSync(statePath, { force: true });

    // another local user got there first: the state path is a symlink to a file of theirs
    const decoyDir = mkdtempSync(join(tmpdir(), "llmwiki-decoy-"));
    strays.push(decoyDir, statePath);
    const decoy = join(decoyDir, "victim.txt");
    writeFileSync(decoy, "untouched\n", "utf8");
    symlinkSync(decoy, statePath);

    // a confident prompt: this turn both emits pointers and persists state
    const out = buildTurnContext(root, "where does parseAmount handle separators in src/parser.ts?", sessionId);

    expect(out).toContain("parse-amount.md"); // the feature still works
    expect(readFileSync(decoy, "utf8")).toBe("untouched\n"); // the symlink target is not clobbered
  });

  // A WELL-FORMED review outside the repository is the case that matters: parsing succeeds, so
  // without a containment check the apply pass rewrites the page and then unlinks a file that
  // lives outside the project. Only the path check can stop it.
  test("wiki-clean-apply refuses a well-formed review file outside the repository and deletes nothing", () => {
    const root = mkWiki();
    const pagePath = join(root, "docs", "wiki", "3_decision", "parse-amount.md");
    const pageBefore = readFileSync(pagePath, "utf8");
    const review = [
      "---",
      "title: Wiki cleanup review",
      "description: Human approval for ambiguous reversible lifecycle tier changes.",
      "date: 2026-07-25",
      "tags: [cleanup, review, maintenance]",
      "status: draft",
      "kind: cleanup",
      "owner: human",
      "source: wiki-clean",
      "---",
      "",
      "## Candidates",
      "",
      `- candidate: 0123456789ab | path: docs/wiki/3_decision/parse-amount.md | hash: ${createHash("sha256").update(pageBefore).digest("hex")} | action: warm | reason: stale-link-graph | risk: reversible-tier-only`,
      "",
      "## Decision",
      "",
      "A. accepted IDs: 0123456789ab",
      "",
    ].join("\n");

    const outsideDir = mkdtempSync(join(tmpdir(), "llmwiki-outside-"));
    strays.push(outsideDir);
    const outside = join(outsideDir, "wiki-clean-2026-07-25.md");
    writeFileSync(outside, review, "utf8");

    expect(() => applyWikiCleanReview(root, { reviewPath: outside })).toThrow(WikiCleanReviewError);
    expect(existsSync(outside)).toBe(true); // nothing outside the project is deleted
    expect(readFileSync(pagePath, "utf8")).toBe(pageBefore); // and no page was rewritten

    // the same review, in the place the engine actually writes it, still applies
    const inside = join(root, "docs", "wiki", "0_review", "wiki-clean-2026-07-25.md");
    mkdirSync(join(root, "docs", "wiki", "0_review"), { recursive: true });
    writeFileSync(inside, review, "utf8");
    expect(applyWikiCleanReview(root, { reviewPath: inside }).applied).toEqual(["0123456789ab"]);
    expect(existsSync(inside)).toBe(false); // consumed, as designed
  });
});
