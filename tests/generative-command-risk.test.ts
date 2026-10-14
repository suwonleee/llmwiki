// The generative child reads transcript-derived prompts, so the tool surface it runs with is the
// whole prompt-injection story. Since Claude Code 2.1.285 `claude -p` can start in auto mode, which
// makes a denylist (the old recommendation) leave MCP and web tools auto-approvable.
import { describe, expect, test } from "bun:test";
import { RECOMMENDED_CLAUDE_CMD, claudeCommandRisk } from "../src/engine/claude.ts";
import { opencodeMajor } from "../src/engine/doctor.ts";

const split = (cmd: string) => cmd.split(/\s+/).filter(Boolean);

describe("claudeCommandRisk", () => {
  test("the recommended command is safe after the engine's whitespace split", () => {
    expect(claudeCommandRisk(split(RECOMMENDED_CLAUDE_CMD))).toBeNull();
  });

  test("the old denylist recommendation is flagged", () => {
    const old = "claude -p {prompt} --model {model} --disallowedTools Write Edit NotebookEdit Bash";
    expect(claudeCommandRisk(split(old))).toContain("no `--tools` allowlist");
  });

  test("an allowlist that names tools is flagged", () => {
    expect(claudeCommandRisk(split("claude -p {prompt} --tools Read"))).toContain("--tools Read");
    expect(claudeCommandRisk(split("claude -p {prompt} --tools=Bash"))).toContain("--tools Bash");
  });

  test("an empty allowlist in JSON-array form is safe", () => {
    expect(claudeCommandRisk(["claude", "-p", "{prompt}", "--tools", "", "--strict-mcp-config"])).toBeNull();
  });

  // `--tools` limits built-ins only; measured with `--tools=` alone: 171 mcp__* tools, auto mode.
  test("an empty allowlist that keeps MCP servers is flagged", () => {
    expect(claudeCommandRisk(split("claude -p {prompt} --tools="))).toContain("--strict-mcp-config");
    expect(claudeCommandRisk(split("claude -p {prompt} --tools= --safe-mode"))).toBeNull();
    expect(
      claudeCommandRisk(split("claude -p {prompt} --tools= --strict-mcp-config --mcp-config /x.json")),
    ).toContain("--mcp-config");
  });

  // Measured: `--tools --strict-mcp-config` ran with 171 MCP tools — the flag became the tool value.
  test("a bare --tools that swallows the next flag is flagged", () => {
    expect(claudeCommandRisk(split("claude -p {prompt} --tools --strict-mcp-config"))).toContain("swallows");
    expect(claudeCommandRisk(split("claude -p {prompt} --strict-mcp-config --tools"))).toContain("--tools=");
  });

  test("the last --tools wins, as in Claude Code", () => {
    expect(claudeCommandRisk(split("claude -p {prompt} --tools= --tools Bash --strict-mcp-config"))).toContain("Bash");
  });

  test("variadic values after an empty one are seen", () => {
    expect(claudeCommandRisk(["claude", "-p", "{prompt}", "--tools", "", "Read", "--strict-mcp-config"])).toContain(
      "Read",
    );
  });

  test("launchers and Windows shims are still judged", () => {
    expect(claudeCommandRisk(["/opt/bin/claude", "-p", "{prompt}"])).not.toBeNull();
    expect(claudeCommandRisk(split("env FOO=1 claude -p {prompt}"))).not.toBeNull();
    expect(claudeCommandRisk(split("npx -y @anthropic-ai/claude-code -p {prompt}"))).not.toBeNull();
    expect(claudeCommandRisk(["C:\\tools\\claude.exe", "-p", "{prompt}"])).not.toBeNull();
    expect(claudeCommandRisk(split("timeout 300 claude -p {prompt}"))).not.toBeNull();
  });

  test("other CLIs and an unset command are not judged", () => {
    expect(claudeCommandRisk(split("codex exec {prompt}"))).toBeNull();
    expect(claudeCommandRisk(split("llm -m claude {prompt}"))).toBeNull();
    expect(claudeCommandRisk(null)).toBeNull();
  });
});

describe("opencodeMajor", () => {
  test("reads the major version from either output shape", () => {
    expect(opencodeMajor("1.19.0\n")).toBe(1);
    expect(opencodeMajor("opencode 2.0.27")).toBe(2);
  });

  test("an upgrade notice before the version is not read as the version", () => {
    expect(opencodeMajor("OpenCode 2.0.3 available — run /update\n1.19.0\n")).toBe(1);
  });

  test("unparseable output is null, not a guess", () => {
    expect(opencodeMajor("")).toBeNull();
    expect(opencodeMajor("dev build")).toBeNull();
  });
});
