// Privacy-safe public-artifact oracles for the Claude Code path.
//
// The artifact is a deterministic local bare remote + explicit release tag. That gives CI the
// public tracked-file boundary without depending on network availability, ignored files, or the
// active worktree's uncommitted contents. The generative /wiki-save middle remains out of scope:
// one test ends at update-next, and a separate test begins from an explicitly seeded close-out.
import { expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { inertSupervisorBin } from "./support/inert-supervisor.ts";
import { supervisorStubs } from "./support/service-definition.ts";

const ROOT = join(import.meta.dir, "..");
const RELEASE_TAG = "g002-public-fixture-v1";
const HOST_POISON_MARKER = "HOST-WORKTREE-MUST-NOT-LEAK-G002";
const HOST_POISON_CREDENTIAL = `ghp_${"P".repeat(36)}`;
const PUBLIC_DECISION =
  "For the public fixture, use the cobalt ledger as the single restart record and keep the amber ledger only as a read-only fallback.";

function output(result: ReturnType<typeof Bun.spawnSync>): string {
  return (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  return files;
}

interface Scenario {
  scratch: string;
  clone: string;
  repo: string;
  state: string;
  claude: string;
  transcriptDir: string;
  transcript: string;
  sessionId: string;
  installedCli: string;
  sessionHook: string;
  turnHook: string;
  offset: string;
  outputs: string[];
  mustRun(command: string[], cwd?: string, stdin?: string): string;
}

function prepareCapturedReleaseScenario(): Scenario {
  const scratch = mkdtempSync(join(tmpdir(), "llmwiki-pinned-public-loop-"));
  try {
    const remote = join(scratch, "public-release.git");
    const clone = join(scratch, "public release checkout");
    const home = join(scratch, "home");
    const claude = join(scratch, "claude profile");
    const state = join(scratch, "state");
    const temp = join(scratch, "tmp");
    const bin = join(scratch, "bin");
    for (const dir of [home, claude, state, temp, bin]) mkdirSync(dir, { recursive: true });

    inertSupervisorBin(bin, {
      claude: "#!/bin/sh\nexit 0\n",
      ...supervisorStubs(),
    });
    // Deliberate allowlist: no ambient auth, proxy, harness, state, or repository variables cross
    // into the tested release. The poison values prove unknown host env does not get serialized.
    const env: Record<string, string> = {
      HOME: home,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: join(scratch, "codex"),
      XDG_CONFIG_HOME: join(scratch, "config"),
      XDG_DATA_HOME: join(scratch, "data"),
      XDG_STATE_HOME: join(scratch, "xdg-state"),
      LLMWIKI_STATE_DIR: state,
      LLMWIKI_LANG: "en",
      TMPDIR: temp,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      USER: "public-loop-fixture",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      HOST_POISON_MARKER,
      HOST_POISON_CREDENTIAL,
    };
    const outputs: string[] = [];
    const spawn = (command: string[], cwd = clone, stdin?: string) =>
      Bun.spawnSync(command, {
        cwd,
        env,
        stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
    const mustRun = (command: string[], cwd = clone, stdin?: string): string => {
      const result = spawn(command, cwd, stdin);
      const text = output(result);
      outputs.push(text);
      expect(result.exitCode, text).toBe(0);
      return text;
    };

    // Freeze committed HEAD into a bare remote, add an explicit release-fixture tag there, and
    // exercise only the checkout of that tag. The dirty active worktree is never copied.
    const pinnedSha = mustRun(["git", "-C", ROOT, "rev-parse", "HEAD"], scratch).trim();
    mustRun(["git", "clone", "-q", "--bare", "--no-hardlinks", ROOT, remote], scratch);
    mustRun(["git", "--git-dir", remote, "tag", "-f", RELEASE_TAG, pinnedSha], scratch);
    mustRun(["git", "clone", "-q", "--branch", RELEASE_TAG, "--single-branch", "--no-hardlinks", remote, clone], scratch);
    expect(mustRun(["git", "rev-parse", "HEAD"]).trim()).toBe(pinnedSha);
    expect(mustRun(["git", "describe", "--tags", "--exact-match"]).trim()).toBe(RELEASE_TAG);
    expect(mustRun(["git", "remote", "get-url", "origin"]).trim()).toBe(remote);

    expect(mustRun(["bash", join(clone, "setup.sh"), "--harness", "claude"])).toContain("setup installed");
    const installedCli = join(clone, "src", "cli.ts");
    expect(mustRun([process.execPath, installedCli, "doctor", "--harness", "claude"])).toContain("turn-context hook present");

    const repo = join(scratch, "fixture project");
    mkdirSync(repo, { recursive: true });
    mustRun(["git", "init", "-q", repo], scratch);
    mustRun(["git", "-C", repo, "config", "user.email", "fixture@example.invalid"], scratch);
    mustRun(["git", "-C", repo, "config", "user.name", "public fixture"], scratch);
    mustRun(["git", "-C", repo, "config", "commit.gpgsign", "false"], scratch);
    mustRun(["git", "-C", repo, "config", "core.hooksPath", "/dev/null"], scratch);
    mustRun(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "root"], scratch);
    expect(mustRun([process.execPath, installedCli, "init", repo])).toContain("automatic integration enabled");
    expect(mustRun([process.execPath, installedCli, "status", repo])).toContain("enabled");

    const sessionId = "public-claude-session";
    const transcriptDir = join(claude, "projects", "public-fixture");
    const transcript = join(transcriptDir, `${sessionId}.jsonl`);
    mkdirSync(transcriptDir, { recursive: true });
    // Fixture bytes come from the pinned checkout being tested, never the active source tree.
    const scrubbed = readFileSync(join(clone, "tests", "fixtures", "real-shape", "claude-session.jsonl"), "utf8")
      .replaceAll("/fixture/claude-repo", repo)
      .replaceAll("fixture-claude-session", sessionId);
    writeFileSync(transcript, scrubbed);

    const semanticRecords: string[] = [];
    for (let i = 0; i < 22; i++) {
      const human = i === 0
        ? PUBLIC_DECISION
        : `Public fixture checkpoint ${i}: the cobalt restart record remains canonical, the amber record remains fallback-only, and the next session must recover that boundary.`;
      semanticRecords.push(JSON.stringify({
        type: "user",
        timestamp: `2026-08-09T01:${String(i).padStart(2, "0")}:00.000Z`,
        cwd: repo,
        sessionId,
        message: { role: "user", content: human },
      }));
      semanticRecords.push(JSON.stringify({
        type: "assistant",
        timestamp: `2026-08-09T01:${String(i).padStart(2, "0")}:30.000Z`,
        cwd: repo,
        sessionId,
        message: {
          role: "assistant",
          content: `Checkpoint ${i} confirms the public fixture boundary. The cobalt ledger is the only restart record that may drive recovery, while the amber ledger remains read-only fallback evidence. This synthetic conclusion is deliberately long enough to exercise the same substantive extraction branch as an ordinary Claude Code work session.`,
        },
      }));
    }
    appendFileSync(transcript, semanticRecords.join("\n") + "\n");

    const settings = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
    const sessionHook = settings.hooks.SessionStart
      .flatMap((group: any) => group.hooks)
      .find((hook: any) => String(hook.command).includes("sessionstart-inject.sh"))?.command;
    const turnHook = settings.hooks.UserPromptSubmit
      .flatMap((group: any) => group.hooks)
      .find((hook: any) => String(hook.command).includes("userpromptsubmit-inject.sh"))?.command;
    expect(sessionHook).toBeString();
    expect(turnHook).toBeString();

    const firstColdStart = mustRun(
      ["bash", "-c", sessionHook],
      repo,
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: sessionId,
        transcript_path: transcript,
        cwd: repo,
        source: "startup",
      }),
    );
    expect(firstColdStart).toContain("Current State");
    const swept = mustRun([process.execPath, join(clone, "src", "daemon", "watch.ts"), "--once"]);
    expect(swept).toContain("enqueued=1");
    expect(swept).toContain("failed=0");
    const selected = mustRun([process.execPath, installedCli, "save-current", repo, "--session", sessionId]);
    expect(selected).toContain(transcript);
    expect(selected).toContain("current session public-c");
    const increment = mustRun([process.execPath, installedCli, "update-next", repo, transcript]);
    expect(increment).toContain(PUBLIC_DECISION);
    expect(increment).toContain(`session=${sessionId}`);
    const offset = increment.match(/new_offset=(\d+)/)?.[1];
    expect(offset).toBeTruthy();

    return {
      scratch, clone, repo, state, claude, transcriptDir, transcript, sessionId, installedCli,
      sessionHook, turnHook, offset: offset!, outputs, mustRun,
    };
  } catch (error) {
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

function assertNoHostLeak(scenario: Scenario): void {
  const generated = filesUnder(join(scenario.repo, "docs", "wiki"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const stateBytes = filesUnder(scenario.state)
    .map((path) => readFileSync(path).toString("utf8"))
    .join("\n");
  const exposed = [...scenario.outputs, generated, stateBytes].join("\n");
  expect(exposed).not.toContain(HOST_POISON_MARKER);
  expect(exposed).not.toContain(HOST_POISON_CREDENTIAL);
  expect(exposed).not.toContain(ROOT);
  expect(exposed).not.toMatch(/ghp_[A-Za-z0-9]{30,}/);
}

test("pinned local release tag captures and extracts one exact Claude session", () => {
  const scenario = prepareCapturedReleaseScenario();
  try {
    assertNoHostLeak(scenario);
  } finally {
    rmSync(scenario.scratch, { recursive: true, force: true });
  }
}, 60_000);

test("seeded close-out boundary runs deterministic tail and next-session retrieval", () => {
  const scenario = prepareCapturedReleaseScenario();
  try {
    const { repo, transcript, transcriptDir, sessionId, installedCli, sessionHook, turnHook, offset, mustRun } = scenario;
    // Explicit boundary input: this page is a known-good synthetic close-out artifact. Its content
    // is not claimed to have been generated by update-next or by an LLM; this test owns only the
    // deterministic orchestration after authoring.
    const transcriptName = basename(transcript);
    const decisionRel = join("docs", "wiki", "3_decision", "cobalt-restart-record.md");
    writeFileSync(
      join(repo, decisionRel),
      [
        "---",
        "title: Cobalt Restart Record",
        "description: Public fixture decision for deterministic restart recovery",
        "date: 2026-08-09",
        "tags: [restart, recovery]",
        "status: ready",
        "domain: decision",
        `source: ${transcriptName}`,
        "---",
        "",
        "## TL;DR",
        "",
        "Use the cobalt ledger as the single restart record; the amber ledger stays read-only fallback evidence. [^1]",
        "",
        "## Decision",
        "",
        "- Recovery reads the cobalt ledger first and never promotes the amber fallback into a competing source of truth. [^1]",
        "",
        `[^1]: ${transcriptName}`,
        `    > [2026-08-09 01:00 user] \"${PUBLIC_DECISION}\"`,
        "",
      ].join("\n"),
    );
    const currentStatePath = join(repo, "docs", "wiki", "current-state.md");
    writeFileSync(
      currentStatePath,
      readFileSync(currentStatePath, "utf8")
        .replace("- <current core state in one line>", "- Cobalt ledger restart recovery is the active public-fixture state.")
        .replace("- <immediate next action>", "- Recover the cobalt restart record in the next clean session."),
    );
    appendFileSync(
      join(repo, "docs", "wiki", "log.md"),
      "\n## [2026-08-09] update | Cobalt restart record\n\n- Added [[3_decision/cobalt-restart-record]].\n",
    );

    mustRun([process.execPath, installedCli, "update-done", repo, transcript, offset]);
    expect(mustRun([process.execPath, installedCli, "register-transcript", repo, transcript, "--session", sessionId])).toContain(
      "registered 1 transcript",
    );
    expect(mustRun([process.execPath, installedCli, "index", repo])).toContain("Indexed:");
    expect(mustRun([process.execPath, installedCli, "reconcile", repo, "--commit"])).toContain("true backlog (un-cited): 0");
    expect(mustRun([process.execPath, installedCli, "lint", repo, "--errors-only"])).toContain("Lint passed");

    const nextSessionId = "public-next-session";
    const nextColdStart = mustRun(
      ["bash", "-c", sessionHook],
      repo,
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: nextSessionId,
        transcript_path: join(transcriptDir, `${nextSessionId}.jsonl`),
        cwd: repo,
        source: "startup",
      }),
    );
    expect(nextColdStart).toContain("Cobalt ledger restart recovery is the active public-fixture state");
    const turnContext = mustRun(
      ["bash", "-c", turnHook],
      repo,
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: nextSessionId,
        cwd: repo,
        prompt: "Where is the cobalt ledger restart record decision?",
      }),
    );
    expect(turnContext).toContain("[llmwiki turn-context]");
    expect(turnContext).toContain(decisionRel);
    assertNoHostLeak(scenario);
  } finally {
    rmSync(scenario.scratch, { recursive: true, force: true });
  }
}, 60_000);
