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
      expect(body).toContain("`request_user_input is unavailable in Default mode`: same fallback, no retry");
      // The retired trigger. Its return means someone reinstated a fallback that never fires.
      expect(body).not.toContain("if the tool is not in your tool list");
    });

    test(`${relative} points the model at the tool's own description, not at the mode`, () => {
      const body = text();
      // Two live Codex sessions on 2026-09-06 settled this. A first draft said "only Plan mode may
      // call it"; with the flag ON — the call permitted — the model still refused to try and asked
      // in prose. With the flag OFF, no call is attempted either, and the app-server tool router
      // logs nothing: Codex renders the allowed modes INTO the tool description
      // (`request_user_input_tool_description`), so the model is already being told. The skill
      // therefore points at that description as the authority and forbids only the failure the
      // first draft produced — declining a call the description permits.
      expect(body).toContain("its own description names the modes allowed to call it");
      expect(body).toContain("never talk yourself out of a call it permits");
      expect(body).not.toContain("but only **Plan mode** may call it");
    });

    test(`${relative} makes the structured tool the default at the point of asking`, () => {
      const body = text();
      // Execution-rule prose was not enough. Driving the real Codex TUI — flag on, the tool's own
      // description reading "Default or Plan mode", so the call was permitted — the model still
      // typed its questions into chat. The imperative therefore lives in procedure 3, where the
      // asking happens, and names chat-instead-of-tool as a defect rather than an alternative.
      expect(body).toContain("is the default, not one of two equal options");
      expect(body).toContain("a defect, not a style choice");
    });

    test(`${relative} keeps the options when it falls back to a chat block`, () => {
      const body = text();
      // Same live session: with no explicit rule, the fallback became three open-ended prose
      // questions and no options at all — recognition replaced by free recall, on a schedule
      // calibrated for multiple choice.
      expect(body).toContain("keeping its FULL option set");
      expect(body).toContain("an open-ended prose question is not the fallback");
    });

    test(`${relative} rules out the async ask tool`, () => {
      const body = text();
      // Codex registers `request_user_input_async` alongside the synchronous tool for any model
      // whose catalog advertises send_user_message_async. That is the difference between two live
      // TUI runs: the model carrying both left the sync tool unused and typed into chat, while the
      // model carrying only the sync one always asked through the overlay. The async tool returns
      // without waiting, so a quiz turn that used it would have nothing left to grade.
      expect(body).toContain("request_user_input_async");
      expect(body).toContain("never the quiz's");
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
