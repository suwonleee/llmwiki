// Personal overlay — [private] dirs are full local wiki citizens that never ship.
//
// The mixed mode ("read the team's committed wiki, keep my own pages local") previously required
// manual git fencing: untracked-file noise forever, and one `git add .` away from publishing
// personal pages. The engine now owns the fencing: a declared private dir is scaffolded and
// idempotently added to .gitignore. The contract under test: declared → dir exists + exactly one
// ignore line no matter how often the skeleton runs; undeclared (default) → nothing changes.
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureSkeleton, ensurePrivateDirs } from "../src/engine/update.ts";
import { defaults } from "../src/engine/config.ts";

const tmps: string[] = [];
function mk(): string {
  const d = mkdtempSync(join(tmpdir(), "llmwiki-private-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("declared private dir: scaffolded + gitignored, idempotently", () => {
  const ws = mk();
  const cfg = { ...defaults(), privateDirs: ["9_personal"] };
  ensureSkeleton(ws, cfg);
  ensureSkeleton(ws, cfg); // re-run must not duplicate the ignore line
  expect(existsSync(join(ws, "docs", "wiki", "9_personal"))).toBe(true);
  const ignore = readFileSync(join(ws, ".gitignore"), "utf-8");
  expect(ignore.split("\n").filter((l) => l === "docs/wiki/9_personal/").length).toBe(1);
});

test("default (no private dirs): .gitignore carries no private lines", () => {
  const ws = mk();
  ensureSkeleton(ws, defaults());
  const ignore = readFileSync(join(ws, ".gitignore"), "utf-8");
  expect(ignore).not.toContain("9_personal");
  expect(ignore).toContain(".llmwiki/"); // the existing seeding is untouched
});

test("ensurePrivateDirs alone (the init path) creates dir + ignore line", () => {
  const ws = mk();
  ensurePrivateDirs(ws, { ...defaults(), privateDirs: ["8_scratch"] });
  expect(existsSync(join(ws, "docs", "wiki", "8_scratch"))).toBe(true);
  expect(readFileSync(join(ws, ".gitignore"), "utf-8")).toContain("docs/wiki/8_scratch/");
});
