// The quiz's structured-ask contract, held to what the harnesses actually do.
//
// `/wiki-quiz` asks its questions through whatever structured prompt the host offers, and each
// host constrains that differently. The skill is the only place those constraints are written
// down, so a wrong sentence here is not a typo — it silently degrades every quiz session on that
// harness. The Codex clauses in particular were wrong for six weeks: the skill said to fall back
// "if the tool is not in your tool list", but Codex registers `request_user_input` in EVERY
// session and refuses the call instead, so the documented trigger never fired and the model had
// no instruction for the error it actually got.
//
// Measured against Codex 0.153.4 (source tag rust-v0.153.4 + three live app-server runs,
// 2026-09-06); re-measure with `bun src/dev/codex-rui-smoke.ts` when Codex moves.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
// Source and bundle both: a plugin install never runs the skill writers, so the published
// surface has to carry the same contract the clone does.
const SURFACES = ["skill/wiki-quiz.md", "skills/wiki-quiz/SKILL.md"] as const;

describe("wiki-quiz structured-ask contract", () => {
  for (const relative of SURFACES) {
    const text = () => readFileSync(join(ROOT, relative), "utf8");

    test(`${relative} states each harness's per-call cap`, () => {
      const body = text();
      expect(body).toContain("max 4 questions per call"); // Claude Code, AskUserQuestion
      expect(body).toContain("max 3 questions per call"); // Codex, request_user_input
      expect(body).toContain("⌈N/3⌉");
    });

    test(`${relative} triggers the Codex fallback on the ERROR, not on tool absence`, () => {
      const body = text();
      // The exact string Codex returns to the model outside Plan mode without the flag.
      expect(body).toContain("request_user_input is unavailable in Default mode");
      expect(body).toContain("ALWAYS in your tool list");
      expect(body).toContain("do **not** retry");
      // The retired trigger. Its return means someone reinstated a fallback that never fires.
      expect(body).not.toContain("if the tool is not in your tool list");
    });

    test(`${relative} names the flag that unlocks Default mode, as optional`, () => {
      const body = text();
      expect(body).toContain("codex features enable default_mode_request_user_input");
      expect(body).toContain("suppress_unstable_features_warning");
    });

    test(`${relative} decodes every Codex answer shape, expiry included`, () => {
      const body = text();
      expect(body).toContain("None of the above"); // the free-form row Codex appends itself
      expect(body).toContain("user_note:"); // free recall arrives prefixed
      expect(body).toContain("EXPIRED, not skipped"); // the auto-resolve case, graded separately
    });

    test(`${relative} forbids the two options that leak the answer`, () => {
      const body = text();
      // Codex's own schema asks for a "(Recommended)" suffix and a per-option description.
      // Both name the correct option in a quiz, so the skill overrides the schema's advice.
      expect(body).toContain("Never suffix `(Recommended)`");
      expect(body).toContain("`description` is the EMPTY string");
    });
  }
});
