import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureExcerpts, mintExcerpts, verifyExcerpt } from "../src/engine/excerpt.ts";
import { REDACTED } from "../src/engine/screen.ts";
import { effectiveExportDir, effectiveStateRoot, setEffectiveStateRoot } from "../src/engine/state-dir.ts";

const QUOTE = "Expire queue entries before the next shift, leaving time for cleanup.";
let dir: string;
let path: string;
let originalHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llmwiki-excerpt-harness-"));
  originalHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(dir, "relocated-codex");
  const sessions = join(process.env.CODEX_HOME, "sessions");
  mkdirSync(sessions, { recursive: true });
  path = join(sessions, "rollout-fixture.jsonl");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
  rmSync(dir, { recursive: true, force: true });
});

function rollout(text: string): string {
  return [
    { type: "session_meta", payload: { id: "fixture-session", cwd: dir } },
    {
      timestamp: "2026-09-26T10:15:00Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n";
}

test("Codex judgment evidence is minted, attached, and checked against its own adapter", () => {
  writeFileSync(path, rollout(QUOTE));
  const judgments = mintExcerpts(path).filter((e) => e.kind === "judgment");
  expect(judgments).toHaveLength(1);
  expect(judgments[0]!.text).toBe(QUOTE);
  expect(judgments[0]!.locator).toBe("2026-09-26 10:15 user");
  expect(verifyExcerpt(QUOTE, path)).toBe(true);
  expect(verifyExcerpt("Keep queue entries forever without any expiry.", path)).toBe(false);
  expect(ensureExcerpts("---\ndomain: decision\n---\n\n[^s1]: rollout-fixture.jsonl\n", path)).toContain(QUOTE);
});

test("Codex excerpts retain secret screening and byte-window selection", () => {
  const first = rollout("An earlier decision outside the selected byte window.");
  writeFileSync(path, first + rollout(`Keep credentials local: DB_PASSWORD='Not-A-Real-Value-123'; never publish them.`));
  const judgments = mintExcerpts(path, Buffer.byteLength(first)).filter((e) => e.kind === "judgment");
  expect(judgments).toHaveLength(1);
  expect(judgments[0]!.text).toContain(REDACTED);
  expect(judgments[0]!.text).not.toContain("Not-A-Real-Value-123");
  expect(verifyExcerpt(judgments[0]!.text, path, Buffer.byteLength(first))).toBe(true);
});

test("Codex's injected AGENTS instructions are not evidence of a human decision", () => {
  writeFileSync(path, rollout("# AGENTS.md instructions\n<INSTRUCTIONS>\nUse the repository conventions.\n</INSTRUCTIONS>") + rollout(QUOTE));
  const judgments = mintExcerpts(path).filter((e) => e.kind === "judgment");
  expect(judgments.map((e) => e.text)).toEqual([QUOTE]);
  expect(ensureExcerpts("---\ndomain: decision\n---\n\n[^s1]: rollout-fixture.jsonl\n", path)).toContain(QUOTE);
});

test("quote verification does not truncate valid evidence at the summary extract cap", () => {
  writeFileSync(path, rollout("Earlier context. ".repeat(80) + QUOTE));
  expect(verifyExcerpt(QUOTE, path)).toBe(true);
  expect(verifyExcerpt("A fabricated policy that the user never chose.", path)).toBe(false);
});

test("compressed Codex rollouts retain verifiable judgment evidence", () => {
  if (typeof Bun.zstdCompressSync !== "function") return;
  const compressed = path + ".zst";
  writeFileSync(compressed, Bun.zstdCompressSync(Buffer.from(rollout(QUOTE))));
  expect(mintExcerpts(compressed).some((e) => e.text === QUOTE)).toBe(true);
  expect(verifyExcerpt(QUOTE, compressed)).toBe(true);
  expect(verifyExcerpt("An invented statement absent from the rollout.", compressed)).toBe(false);
});

test("OpenCode exports use their own adapter for both minting and verification", () => {
  const previousRoot = effectiveStateRoot();
  try {
    setEffectiveStateRoot(join(dir, "state"));
    mkdirSync(effectiveExportDir(), { recursive: true });
    const exported = join(effectiveExportDir(), "fixture-session.jsonl");
    writeFileSync(exported, [
      { kind: "opencode-meta", sessionID: "fixture-session", directory: dir, title: "Fixture" },
      { role: "user", ts: "2026-09-26T10:15", text: QUOTE },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    expect(mintExcerpts(exported).some((e) => e.kind === "judgment" && e.text === QUOTE)).toBe(true);
    expect(verifyExcerpt(QUOTE, exported)).toBe(true);
    expect(verifyExcerpt("A decision absent from this OpenCode session.", exported)).toBe(false);
  } finally {
    setEffectiveStateRoot(previousRoot);
  }
});
