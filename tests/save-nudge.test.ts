import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _saveNudgeDir, observeSaveNudge, recordSaveNudgeEvent } from "../src/engine/save-nudge.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { _turnStatePath, buildTurnContext } from "../src/engine/turncontext.ts";
const cleanup: string[] = [];
const previous = process.env.LLMWIKI_SAVE_NUDGE;
afterEach(() => { for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true }); if (previous === undefined) delete process.env.LLMWIKI_SAVE_NUDGE; else process.env.LLMWIKI_SAVE_NUDGE = previous; });
function fixture() {
  delete process.env.LLMWIKI_SAVE_NUDGE;
  const root = mkdtempSync(join(tmpdir(), "llmwiki-nudge-test-"));
  const session = `${root}-session`;
  cleanup.push(root, _saveNudgeDir(root, session), _turnStatePath(root, session));
  return { root, session };
}
function turns(root: string, session: string, n = 8) {
  return Array.from({ length: n }, (_, i) => observeSaveNudge(root, i === 0 ? "From now on use the documented retry policy." : `Continue task ${i}.`, session));
}
test("signal plus eight distinct prompt deliveries emits once without reading transcripts", () => {
  const { root, session } = fixture();
  const outputs = turns(root, session);
  expect(outputs.slice(0, 7).every(s => s === "")).toBe(true);
  expect(outputs[7]).toContain("model only");
  expect(outputs[7]).toContain("/wiki-save");
  expect(observeSaveNudge(root, "correction apply new settings", session)).toBe("");
  const state = readFileSync(join(_saveNudgeDir(root, session), "state.json"), "utf8");
  expect(state).not.toContain("retry policy");
  expect(lstatSync(_saveNudgeDir(root, session)).mode & 0o077).toBe(0);
});
test("ordinary prompts alone never emit, a later correction can trigger", () => {
  const { root, session } = fixture();
  for (let i = 0; i < 12; i++) expect(observeSaveNudge(root, `Inspect case ${i}`, session)).toBe("");
  expect(observeSaveNudge(root, "정정: 다음 설정 적용", session, { ko: true })).toContain("모델용");
});
test("duplicate hook retries do not manufacture user turns", () => {
  const { root, session } = fixture();
  for (let i = 0; i < 15; i++) expect(observeSaveNudge(root, "From now on use retry policy", session)).toBe("");
  expect(turns(root, session).filter(Boolean)).toHaveLength(1);
});
for (const event of ["completed", "declined"] as const) test(`explicit ${event} before or after emission suppresses subsequent reminders`, () => {
  const { root, session } = fixture();
  expect(recordSaveNudgeEvent(root, session, event)).toBe(true);
  expect(turns(root, session, 20).filter(Boolean)).toHaveLength(0);
});
test("empty session, empty prompt, and disabled setting create no state", () => {
  const { root, session } = fixture();
  expect(observeSaveNudge(root, "from now on", "")).toBe("");
  expect(recordSaveNudgeEvent(root, "", "declined")).toBe(false);
  expect(observeSaveNudge(root, "", session)).toBe("");
  process.env.LLMWIKI_SAVE_NUDGE = "off";
  expect(turns(root, session).filter(Boolean)).toHaveLength(0);
  expect(() => lstatSync(_saveNudgeDir(root, session))).toThrow();
});
test("preplanted directory symlink cannot produce hints or alter target", () => {
  const { root, session } = fixture();
  const target = join(root, "target");
  mkdirSync(target, { mode: 0o700 });
  writeFileSync(join(target, "state.json"), "sensitive unchanged");
  symlinkSync(target, _saveNudgeDir(root, session));
  expect(turns(root, session).filter(Boolean)).toHaveLength(0);
  expect(recordSaveNudgeEvent(root, session, "completed")).toBe(false);
  expect(readFileSync(join(target, "state.json"), "utf8")).toBe("sensitive unchanged");
});
test("state symlink, permissive state, and malformed state fail quietly", () => {
  for (const kind of ["symlink", "permissive", "malformed"]) {
    const { root, session } = fixture();
    const dir = _saveNudgeDir(root, session);
    mkdirSync(dir, { mode: 0o700 });
    const target = join(root, "target");
    writeFileSync(target, "sensitive unchanged");
    const path = join(dir, "state.json");
    if (kind === "symlink") symlinkSync(target, path);
    else { writeFileSync(path, "broken"); chmodSync(path, kind === "permissive" ? 0o644 : 0o600); }
    expect(turns(root, session).filter(Boolean)).toHaveLength(0);
    expect(readFileSync(target, "utf8")).toBe("sensitive unchanged");
  }
});
test("turn context reserves a hint inside the 1600 character contract", () => {
  const { root, session } = fixture();
  turns(root, session, 7);
  const out = buildTurnContext(root, "correct the final step", session);
  expect(out).toContain("save hint");
  expect(out.length).toBeLessThanOrEqual(1600);
});

test("explicit save/deep commands are not an occasion to suggest saving", () => {
  const { root, session } = fixture();
  turns(root, session, 7);
  expect(observeSaveNudge(root, "/wiki-save", session)).toBe("");
  expect(observeSaveNudge(root, "/wiki-deep", session)).toBe("");
  // Starting a save is not successful completion; a later ordinary turn may still remind.
  expect(observeSaveNudge(root, "Proceed with remaining work", session)).toContain("save hint");
});

test("dense wiki excerpts and the once hint share the original turn budget", () => {
  const { root, session } = fixture();
  const dir = join(root, "docs/wiki/5_topic");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 3; i++) writeFileSync(join(dir, `router-${i}.md`), `---
title: Zephyr Quartz router ${i}
---
## Zephyr Quartz retry
${Array.from({ length: 9 }, (_, n) => `- Zephyr Quartz retry configuration clause ${i}-${n} keeps the complete exception beside the decision.`).join("\n")}
`);
  new WikiIndex(root).connect().close();
  turns(root, session, 7);
  const out = buildTurnContext(root, "Inspect Zephyr Quartz retry configuration", session);
  expect(out).toContain("router-");
  expect(out).toContain("save hint");
  expect(out.length).toBeLessThanOrEqual(1600);
});
