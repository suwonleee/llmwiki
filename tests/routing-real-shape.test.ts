// Stage-1 routing against REAL transcript shapes.
//
// The fixtures here are not authored: tests/support/derive-fixture.ts produced them from actual
// Claude and Codex transcripts, keeping key order, nesting, types and string lengths while
// discarding every value. That distinction is the whole point of this file. A previous revision of
// the router abandoned a record as soon as an unknown complex value appeared, which every
// hand-written fixture happened to satisfy and no real transcript did — 2,665 of 2,687 real Claude
// sessions silently stopped being captured while the suite stayed green.
//
// Anything that changes how routing reads a record must keep passing here, or capture is dead for
// that harness in the field regardless of what the synthetic tests say.
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeJsonlSource } from "../src/engine/sources/claude.ts";
import { codexSource } from "../src/engine/sources/codex.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "real-shape");
const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "llmwiki-real-shape-"));
  dirs.push(d);
  return d;
}

function place(fixture: string, target: string): string {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(FIXTURES, fixture), target);
  return target;
}

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("routing resolves the shapes real transcripts actually have", () => {
  test("Claude: identity behind a complex value still routes", () => {
    const home = scratch();
    setEnv("HOME", home);
    setEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
    const path = place(
      "claude-session.jsonl",
      join(home, ".claude", "projects", "-fixture-claude-repo", "session.jsonl"),
    );

    const route = claudeJsonlSource.discoverRoutes().find((r) => r.path === path);

    // In this fixture `cwd` arrives in record 3, after an `attachment` object — the shape that
    // made the record-abandoning router return null for essentially every real session.
    expect(route?.repo).toBe("/fixture/claude-repo");
    expect(route?.sessionId).toBe("fixture-claude-session");
  });

  test("Codex: a forked rollout routes to its OWN session, not its parent", () => {
    const home = scratch();
    setEnv("HOME", home);
    setEnv("CODEX_HOME", join(home, ".codex"));
    const path = place(
      "codex-rollout.jsonl",
      join(home, ".codex", "sessions", "2026", "07", "24", "rollout-2026-07-24T08-16-03-fixture.jsonl"),
    );

    const route = codexSource.discoverRoutes().find((r) => r.path === path);

    // `payload.session_id` (the parent thread) is physically BEFORE `payload.id` (this rollout) in
    // a forked rollout, so byte order answers with the wrong session. Declared priority wins.
    expect(route?.repo).toBe("/fixture/codex-repo");
    expect(route?.sessionId).toBe("fixture-codex-session");
  });

  test("no fixture carries transcript content — only shape", () => {
    // The derivation replaces every string value; if someone regenerates a fixture without it,
    // this catches the leak before it is committed.
    for (const name of ["claude-session.jsonl", "codex-rollout.jsonl"]) {
      const body = readFileSync(join(FIXTURES, name), "utf-8");
      for (const record of body.split("\n").filter(Boolean)) {
        for (const value of collectStrings(JSON.parse(record))) {
          const allowed = value.startsWith("/fixture/") || value.startsWith("fixture-");
          expect(allowed || /^x*$/.test(value)).toBe(true);
        }
      }
    }
  });
});

function collectStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const item of node) collectStrings(item, out);
  else if (node && typeof node === "object")
    for (const value of Object.values(node as Record<string, unknown>)) collectStrings(value, out);
  return out;
}
