// `init` scaffolds the category folders — newcomer-friction guard.
//
// Fresh-install E2E (2026-07-21): init created an EMPTY docs/wiki/, so a newcomer's very first
// page write failed on the missing category dir — they had to learn the folder conventions
// before recording anything. init now creates the config-resolved category dirs up front
// (custom [[category]] conventions win over the defaults), and re-running init self-heals a
// deleted dir. Exercised through the real CLI so the whole cmdInit path is covered.
import { test, expect, describe } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "llmwiki-init-"));
  const git = Bun.spawnSync(["git", "-C", ws, "init", "-q"]);
  expect(git.exitCode).toBe(0);
  return ws;
}

// The assertions below quote the CLI's English sentences, so the spawned process must not inherit
// whatever language the developer's shell happens to export: with LLMWIKI_LANG=ko in the
// environment (a Korean author's normal setup) `init` answers in Korean and this file failed on a
// tree that was otherwise green. Pin the language at the spawn — the behaviour under test is the
// exit code and the refusal to claim success, not which language says so.
function runInit(ws: string): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(["bun", CLI, "init", ws], { env: { ...process.env, LLMWIKI_LANG: "en" } });
}

function output(r: ReturnType<typeof Bun.spawnSync>): string {
  return (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "");
}

function runInitOutput(ws: string): string {
  const r = runInit(ws);
  expect(r.exitCode).toBe(0);
  return output(r);
}

describe("init scaffolds category folders", () => {
  test("default conventions: queue + categories + topic dirs exist after init", () => {
    const ws = workspace();
    try {
      const out = runInitOutput(ws);
      expect(out).toContain("categories scaffolded:");
      for (const d of ["0_review", "1_direction", "2_milestone", "3_decision", "4_insight", "5_topic"]) {
        expect(existsSync(join(ws, "docs", "wiki", d))).toBe(true);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("re-running init re-creates a deleted category dir (self-heal, idempotent)", () => {
    const ws = workspace();
    try {
      runInitOutput(ws);
      rmSync(join(ws, "docs", "wiki", "2_milestone"), { recursive: true });
      runInitOutput(ws);
      expect(existsSync(join(ws, "docs", "wiki", "2_milestone"))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// init must hand over a COMPLETE wiki-ready repo, team-safety included: without the .gitignore
// seed the adopter's very next commit ships the derived SQLite index (binary merge conflicts),
// and without .gitattributes concurrent log.md appends conflict on every merge — the exact
// failures ensureSkeleton's seeding exists to prevent, previously unreachable from `init`.
describe("init seeds the full skeleton", () => {
  test("team-safety files and the L0/overview/log templates exist after init", () => {
    const ws = workspace();
    try {
      runInitOutput(ws);
      expect(readFileSync(join(ws, ".gitignore"), "utf-8")).toContain(".llmwiki/");
      expect(readFileSync(join(ws, ".gitattributes"), "utf-8")).toContain("docs/wiki/log.md merge=union");
      for (const f of ["current-state.md", "overview.md", "log.md"]) {
        expect(existsSync(join(ws, "docs", "wiki", f))).toBe(true);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("a non-Git target never prints success or exits zero", () => {
    const ws = mkdtempSync(join(tmpdir(), "llmwiki-init-nongit-"));
    try {
      const result = runInit(ws);
      expect(result.exitCode).not.toBe(0);
      expect(output(result)).not.toContain("✓ Initialized");
      expect(result.stderr?.toString() ?? "").toContain("automatic integration could not be enabled");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
