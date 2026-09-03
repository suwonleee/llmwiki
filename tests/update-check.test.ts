// Engine update notice — automatic CHECK, manual APPLY.
//
// The security posture under test: the check may talk to the network (daemon-side, daily) but
// must never run remote code (fetch + object reads only), and the notice may enter a session's
// context but must never carry an unvalidated remote string. Every fixture below is a LOCAL git
// repository standing in for origin — no test touches the network, which is also why the daemon
// runs this from its loop and never from `--once`.
import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  INSTALL_RECEIPT_FILE,
  UPDATE_CHECK_FILE,
  checkEngineUpdate,
  liveEngineVersion,
  readUpdateCheck,
  recordInstallReceipt,
  updateAvailable,
} from "../src/engine/update-check.ts";
import { setEffectiveStateRoot } from "../src/engine/state-dir.ts";
import { buildContext } from "../src/engine/context.ts";
import { ensureSkeleton } from "../src/engine/update.ts";
import { _resetForTests } from "../src/engine/config.ts";
import { resetEnrollmentCache } from "../src/engine/enrollment.ts";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";

const tmps: string[] = [];
const savedLang = process.env.LLMWIKI_LANG;

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

function sh(args: string[], cwd: string): void {
  const r = spawnSync(args[0]!, args.slice(1), { cwd, encoding: "utf8" });
  expect(`${args.join(" ")} → ${r.status}\n${r.stderr}`).toContain("→ 0");
}

/** A local git repo standing in for the public origin, at a given version. */
function mkOrigin(version: string): string {
  const d = tmp("llmwiki-upd-origin-");
  sh(["git", "init", "-q", "-b", "main"], d);
  // Isolate from the developer's global hooks: this project installs a commit-message hook via a
  // machine-level `core.hooksPath`, and it would reject these fixture commits (tests/support/git-repo.ts
  // does the same).
  sh(["git", "config", "core.hooksPath", "/dev/null"], d);
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "llmwiki", version }));
  sh(["git", "add", "-A"], d);
  sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init"], d);
  return d;
}

function bumpOrigin(origin: string, version: string): void {
  writeFileSync(join(origin, "package.json"), JSON.stringify({ name: "llmwiki", version }));
  sh(["git", "add", "-A"], origin);
  sh(["git", "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "bump"], origin);
}

function cloneOf(origin: string): string {
  const d = tmp("llmwiki-upd-clone-");
  sh(["git", "-c", "protocol.file.allow=always", "clone", "-q", origin, join(d, "c")], d);
  return join(d, "c");
}

afterEach(() => {
  setEffectiveStateRoot(null);
  _resetForTests();
  resetEnrollmentCache();
  if (savedLang === undefined) delete process.env.LLMWIKI_LANG;
  else process.env.LLMWIKI_LANG = savedLang;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("check records local, remote and behind-count after origin moves", () => {
  const origin = mkOrigin("0.1.0");
  const clone = cloneOf(origin);
  bumpOrigin(origin, "0.2.0");
  const state = tmp("llmwiki-upd-state-");

  const rec = checkEngineUpdate(clone, state);

  expect(rec).toEqual(
    expect.objectContaining({ localVersion: "0.1.0", remoteVersion: "0.2.0", behind: 1 }),
  );
  expect(readUpdateCheck(state)).toEqual(rec);
});

test("notice stays actionable after pull until setup records the installed HEAD", () => {
  const origin = mkOrigin("0.1.0");
  const clone = cloneOf(origin);
  bumpOrigin(origin, "0.2.0");
  const state = tmp("llmwiki-upd-state-");
  checkEngineUpdate(clone, state);

  expect(updateAvailable(clone, state)).toEqual(
    expect.objectContaining({ localVersion: "0.1.0", remoteVersion: "0.2.0" }),
  );

  // Pull updates only the clone. Copied skills/plugins and the long-running daemon still belong to
  // the previous setup, so the cold-start reminder must remain until setup succeeds.
  sh(["git", "pull", "-q"], clone);
  expect(liveEngineVersion(clone)).toBe("0.2.0");
  expect(updateAvailable(clone, state)).toEqual(
    expect.objectContaining({ kind: "setup-required", localVersion: "0.2.0", remoteVersion: "0.2.0" }),
  );

  expect(recordInstallReceipt(clone, state)).toBe(true);
  expect(existsSync(join(state, INSTALL_RECEIPT_FILE))).toBe(true);
  expect(updateAvailable(clone, state)).toBeNull();
});

test("a receipt from another clone never certifies this clone's installed surfaces", () => {
  const origin = mkOrigin("0.1.0");
  const installedClone = cloneOf(origin);
  const otherClone = cloneOf(origin);
  const state = tmp("llmwiki-upd-state-");
  checkEngineUpdate(otherClone, state);
  expect(recordInstallReceipt(installedClone, state)).toBe(true);

  expect(updateAvailable(otherClone, state)).toEqual(
    expect.objectContaining({ kind: "setup-required", localVersion: "0.1.0", remoteVersion: "0.1.0" }),
  );
});

test("a partial setup updates only its selected harness and preserves stale component evidence", () => {
  const origin = mkOrigin("0.1.0");
  const clone = cloneOf(origin);
  const state = tmp("llmwiki-upd-state-");
  checkEngineUpdate(clone, state);
  expect(recordInstallReceipt(clone, state)).toBe(true);

  writeFileSync(join(clone, "receipt-change.txt"), "next\n");
  sh(["git", "add", "receipt-change.txt"], clone);
  sh(["git", "commit", "-qm", "advance clone"], clone);
  expect(recordInstallReceipt(clone, state, ["common", "codex"])).toBe(true);

  expect(updateAvailable(clone, state)).toEqual(
    expect.objectContaining({ kind: "setup-required", localVersion: "0.1.0", remoteVersion: "0.1.0" }),
  );
  expect(recordInstallReceipt(clone, state, ["claude", "opencode"])).toBe(true);
  expect(updateAvailable(clone, state)).toBeNull();
});

test("setup receipt refuses a non-file target instead of replacing unrelated state", () => {
  const origin = mkOrigin("0.1.0");
  const clone = cloneOf(origin);
  const state = tmp("llmwiki-upd-state-");
  mkdirSync(join(state, INSTALL_RECEIPT_FILE));

  expect(recordInstallReceipt(clone, state)).toBe(false);
});

test("a hostile remote version never survives into the record", () => {
  const origin = mkOrigin("0.1.0");
  const clone = cloneOf(origin);
  bumpOrigin(origin, "0.2.0; rm -rf ~");
  const state = tmp("llmwiki-upd-state-");

  expect(checkEngineUpdate(clone, state)).toBeNull();
  expect(existsSync(join(state, UPDATE_CHECK_FILE))).toBe(false);
});

test("the record is re-validated on READ — a tampered state file answers nothing", () => {
  const state = tmp("llmwiki-upd-state-");
  writeFileSync(
    join(state, UPDATE_CHECK_FILE),
    JSON.stringify({ checkedAt: "x", localVersion: "0.1.0", remoteVersion: "99.0.0`touch pwned`", behind: 1 }),
  );
  expect(readUpdateCheck(state)).toBeNull();
});

test("an unreachable origin answers nothing and throws nothing", () => {
  const origin = mkOrigin("0.1.0");
  const clone = cloneOf(origin);
  sh(["git", "remote", "set-url", "origin", join(tmp("llmwiki-upd-gone-"), "nonexistent")], clone);
  const state = tmp("llmwiki-upd-state-");

  expect(checkEngineUpdate(clone, state)).toBeNull();
  expect(existsSync(join(state, UPDATE_CHECK_FILE))).toBe(false);
});

test("a local version ahead of origin is not 'an update' (author machines, forks)", () => {
  const origin = mkOrigin("0.5.0");
  const clone = cloneOf(origin);
  const state = tmp("llmwiki-upd-state-");
  checkEngineUpdate(clone, state);
  expect(recordInstallReceipt(clone, state)).toBe(true);
  writeFileSync(join(clone, "package.json"), JSON.stringify({ name: "llmwiki", version: "9.0.0" }));

  expect(updateAvailable(clone, state)).toBeNull();
});

test("a missing state root records nothing — root creation belongs to the bootstrap", () => {
  const origin = mkOrigin("0.1.0");
  const clone = cloneOf(origin);
  const ghost = join(tmp("llmwiki-upd-ghost-"), "never-made");

  expect(checkEngineUpdate(clone, ghost)).toBeNull();
  expect(existsSync(ghost)).toBe(false);
});

// The cold-start integration: the notice line rides the same context the hooks inject, in the
// session's language, and only when the recorded origin version beats THIS clone's live one.
// (The fabricated record says 99.0.0, which beats any real version of this repository.)
function mkEnrolledRepo(): string {
  const d = tmp("llmwiki-upd-repo-");
  const repo = enrollRepo(makeGitRepo(join(d, "repo")));
  ensureSkeleton(repo);
  return repo;
}

function fabricateAvailable(state: string): void {
  writeFileSync(
    join(state, UPDATE_CHECK_FILE),
    JSON.stringify({ checkedAt: new Date().toISOString(), localVersion: "0.0.1", remoteVersion: "99.0.0", behind: 3 }),
  );
}

test("cold start carries the one-line remote notice in English", () => {
  process.env.LLMWIKI_LANG = "en";
  const repo = mkEnrolledRepo();
  const state = tmp("llmwiki-upd-state-");
  setEffectiveStateRoot(state);

  fabricateAvailable(state);
  const cs = buildContext(repo);
  expect(cs).toContain("engine update available");
  expect(cs).toContain("→ v99.0.0");
  expect(cs).toContain("the engine never updates itself");
});

test("cold start requires setup without a network record when no matching receipt exists", () => {
  process.env.LLMWIKI_LANG = "en";
  const repo = mkEnrolledRepo();
  const state = tmp("llmwiki-upd-state-");
  setEffectiveStateRoot(state);

  expect(buildContext(repo)).toContain("engine files changed since the last successful install");
  expect(existsSync(join(state, UPDATE_CHECK_FILE))).toBe(false);
});

test("a malformed network record cannot hide local setup drift", () => {
  process.env.LLMWIKI_LANG = "en";
  const repo = mkEnrolledRepo();
  const state = tmp("llmwiki-upd-state-");
  setEffectiveStateRoot(state);
  writeFileSync(join(state, UPDATE_CHECK_FILE), "not-json");

  expect(buildContext(repo)).toContain("engine files changed since the last successful install");
});

test("cold start carries the notice in Korean", () => {
  process.env.LLMWIKI_LANG = "ko";
  const repo = mkEnrolledRepo();
  const state = tmp("llmwiki-upd-state-");
  setEffectiveStateRoot(state);
  fabricateAvailable(state);

  const cs = buildContext(repo);
  expect(cs).toContain("엔진 업데이트 있음");
  expect(cs).toContain("엔진이 스스로를 갱신하는 일은 없다");
});

test("cold start keeps a setup-only reminder after the clone catches up", () => {
  process.env.LLMWIKI_LANG = "en";
  const repo = mkEnrolledRepo();
  const state = tmp("llmwiki-upd-state-");
  setEffectiveStateRoot(state);
  const local = liveEngineVersion();
  expect(local).not.toBeNull();
  writeFileSync(
    join(state, UPDATE_CHECK_FILE),
    JSON.stringify({ checkedAt: new Date().toISOString(), localVersion: local, remoteVersion: local, behind: 0 }),
  );

  const cs = buildContext(repo);
  expect(cs).toContain("engine files changed since the last successful install");
  expect(cs).toContain("./setup.sh");
});

// ---- the one line a PERSON sees -----------------------------------------------------------
//
// The cold-start payload has always carried the notice as additionalContext, which reaches the
// model; a person heard about an update only if the model mentioned it or they ran doctor. This
// line is the same fact for the surfaces that show text to a human (hook systemMessage, OpenCode
// toast, CLI stderr). One sentence, one command, gated where the command would be wrong.
import { humanUpdateLine, inPluginContext } from "../src/engine/update-check.ts";

test("humanUpdateLine renders one actionable sentence per notice kind, in both languages", () => {
  const base = { checkedAt: "2026-09-03T00:00:00.000Z", localVersion: "0.12.0", remoteVersion: "0.13.0" };
  const clone = "/x/llmwiki";
  const en = (n: any) => humanUpdateLine(n, { ko: false, pluginContext: false, clone });
  const ko = (n: any) => humanUpdateLine(n, { ko: true, pluginContext: false, clone });

  expect(en({ kind: "update", ...base })).toBe(
    "[llmwiki] engine update available: v0.12.0 → v0.13.0 — apply: cd /x/llmwiki && git pull && ./setup.sh",
  );
  expect(ko({ kind: "update", ...base })).toContain("v0.12.0 → v0.13.0");
  expect(en({ kind: "commits-behind", ...base, remoteVersion: "0.12.0", behind: 3 })).toContain("3 commit(s) behind");
  expect(en({ kind: "setup-required", ...base, remoteVersion: "0.12.0" })).toBe(
    "[llmwiki] engine files changed since the last install — finish applying them: cd /x/llmwiki && ./setup.sh",
  );
  expect(en(null)).toBe("");
  for (const n of [{ kind: "update", ...base }, { kind: "setup-required", ...base }]) {
    expect(en(n)).not.toContain("\n"); // a banner, never a paragraph
  }
});

test("a plugin install is told nothing: every line ends in a clone command it does not have", () => {
  // A plugin updates through the harness's plugin manager and never runs setup.sh, so both
  // "git pull && ./setup.sh" and "./setup.sh" would be wrong instructions there — not merely noisy.
  const base = { checkedAt: "", localVersion: "0.12.0" };
  expect(humanUpdateLine({ kind: "setup-required", ...base, remoteVersion: "0.12.0" }, { ko: false, pluginContext: true })).toBe("");
  expect(humanUpdateLine({ kind: "update", ...base, remoteVersion: "0.13.0" }, { ko: false, pluginContext: true })).toBe("");
  expect(humanUpdateLine({ kind: "commits-behind", ...base, remoteVersion: "0.12.0", behind: 2 }, { ko: false, pluginContext: true })).toBe("");
});

test("plugin context is exactly the variable both harnesses export to plugin hooks", () => {
  expect(inPluginContext({})).toBe(false);
  expect(inPluginContext({ CLAUDE_PLUGIN_ROOT: "" })).toBe(false);
  expect(inPluginContext({ CLAUDE_PLUGIN_ROOT: "/cache/llmwiki/0.12.0" })).toBe(true);
});
