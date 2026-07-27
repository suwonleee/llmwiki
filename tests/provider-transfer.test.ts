// Sending session content to another program is the one thing this engine does that leaves the
// machine. It is therefore OFF unless the human turned it on in their own shell environment, and
// even then nothing unscreened is ever interpolated into a prompt.
//
// The fake provider here records only invocation COUNTS and the bytes it received, and the
// assertions check for the absence of a secret fixture rather than printing anything.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLM_CMD_ENV, UNAVAILABLE, llm, llmAvailable, llmTemplate, screenOutbound } from "../src/engine/claude.ts";
import { inspectReviewHealth, review } from "../src/engine/review.ts";

const dirs: string[] = [];
const SECRET_FIXTURE = "AKIAIOSFODNN7EXAMPLE"; // AWS's own documentation example pair — never a real key
let envBefore: string | undefined;
let pathBefore: string | undefined;
let cwdBefore: string | undefined;

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "llmwiki-provider-"));
  dirs.push(d);
  return d;
}

/** A provider stand-in that records each invocation (argv + stdin) and prints a fixed page. */
function fakeProvider(): { bin: string; dir: string; log: string; calls: () => string[] } {
  const dir = scratch();
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const log = join(dir, "calls.log");
  const bin = join(binDir, "fake-llm");
  writeFileSync(
    bin,
    `#!/bin/sh\n{ printf 'CALL '; printf '%s ' "$@"; cat; printf '\\n'; } >> ${JSON.stringify(log)}\n` +
      `printf -- '---\\ntitle: T\\n---\\n'\n`,
  );
  chmodSync(bin, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  return {
    bin,
    dir,
    log,
    calls: () => (existsSync(log) ? readFileSync(log, "utf-8").split("CALL ").slice(1) : []),
  };
}

afterEach(() => {
  if (envBefore === undefined) delete process.env[LLM_CMD_ENV];
  else process.env[LLM_CMD_ENV] = envBefore;
  envBefore = undefined;
  if (pathBefore !== undefined) process.env.PATH = pathBefore;
  if (cwdBefore !== undefined) process.chdir(cwdBefore);
  cwdBefore = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function withEnv(value: string | undefined): void {
  envBefore = process.env[LLM_CMD_ENV];
  pathBefore = process.env.PATH;
  if (value === undefined) delete process.env[LLM_CMD_ENV];
  else process.env[LLM_CMD_ENV] = value;
}

describe("generative transfer is off by default", () => {
  test("no command configured → no subprocess and a deterministic unavailable result", async () => {
    const provider = fakeProvider();
    withEnv(undefined);

    expect(llmTemplate()).toBeNull();
    expect(llmAvailable()).toBe(false);

    const out = await llm("some prompt", "model-x");
    expect(out.startsWith(UNAVAILABLE)).toBe(true);
    expect(out).toContain(LLM_CMD_ENV); // says how to enable it
    expect(provider.calls()).toEqual([]); // nothing was launched
  });

  test("an empty value is the same as unset", async () => {
    withEnv("   ");
    expect(llmTemplate()).toBeNull();
    expect((await llm("p", "m")).startsWith(UNAVAILABLE)).toBe(true);
  });

  test("a committed review with no provider does not leave a false incomplete-launch marker", async () => {
    const repo = scratch();
    const wiki = join(repo, "docs", "wiki", "2_lesson");
    mkdirSync(wiki, { recursive: true });
    for (const [name, title] of [["one.md", "One"], ["two.md", "Two"]] as const) {
      writeFileSync(
        join(wiki, name),
        `---\ntitle: ${title}\ndescription: ${title} page\ndate: 2026-07-25\ntags: [test]\nstatus: ready\n---\n\n## TL;DR\n\n${title} is grounded locally.\n`,
      );
    }
    withEnv(undefined);

    const result = await review(repo, { date: "2026-07-25", commit: true, minPages: 2 });
    expect(result.verdict).toBe("skipped-no-provider");
    expect(existsSync(join(repo, ".llmwiki", "review-state.json"))).toBe(false);
    expect(inspectReviewHealth(repo, "2026-07-25").incompleteLaunch).toBe(false);
  });

  test("a repository .env cannot enable it — env-file autoload is not consent", async () => {
    const provider = fakeProvider();
    const repo = scratch();
    // Bun autoloads .env from the CWD, so a tracked file in a cloned repository would otherwise
    // land straight in process.env and point the generative passes wherever it liked.
    writeFileSync(join(repo, ".env"), `${LLM_CMD_ENV}=${provider.bin} {prompt}\n`);
    cwdBefore = process.cwd();
    process.chdir(repo);
    withEnv(`${provider.bin} {prompt}`); // simulate the autoload having reached process.env

    expect(llmTemplate()).toBeNull();
    const out = await llm("p", "m");
    expect(out.startsWith(UNAVAILABLE)).toBe(true);
    expect(provider.calls()).toEqual([]);
  });

  test("a symlinked repository .env also cannot enable it", async () => {
    const provider = fakeProvider();
    const repo = scratch();
    writeFileSync(join(repo, "payload.env"), `${LLM_CMD_ENV}=${provider.bin} {prompt}\n`);
    symlinkSync("payload.env", join(repo, ".env"));
    cwdBefore = process.cwd();
    process.chdir(repo);
    withEnv(`${provider.bin} {prompt}`); // simulate Bun following the link before our code starts

    expect(llmTemplate()).toBeNull();
    const out = await llm("p", "m");
    expect(out.startsWith(UNAVAILABLE)).toBe(true);
    expect(provider.calls()).toEqual([]);
  });

  test("an explicit process-environment value IS the opt-in", async () => {
    const provider = fakeProvider();
    withEnv(`${provider.bin} {prompt}`);

    expect(llmTemplate()).toEqual([provider.bin, "{prompt}"]);
    const out = await llm("hello provider", "model-x");
    expect(out).toContain("title: T");
    expect(provider.calls().length).toBe(1);
    expect(provider.calls()[0]).toContain("hello provider");
  });
});

describe("only screened data is ever interpolated", () => {
  test("a secret in the outbound block is redacted before the prompt is built", async () => {
    const provider = fakeProvider();
    withEnv(`${provider.bin} {prompt}`);

    const blocks = screenOutbound({
      extract: `user ran: AWS_ACCESS_KEY_ID=${SECRET_FIXTURE} aws sts get-caller-identity to check the role`,
    });
    expect(blocks).not.toBeNull();
    expect(blocks!.extract).not.toContain(SECRET_FIXTURE);
    expect(blocks!.extract).toContain("aws sts get-caller-identity"); // the evidence survives

    await llm(`prompt with ${blocks!.extract}`, "m");
    const sent = provider.calls().join("");
    expect(sent).not.toContain(SECRET_FIXTURE);
    expect(sent).toContain("get-caller-identity");
  });

  test("a block that screens down to nothing yields null — the caller launches nothing", async () => {
    const provider = fakeProvider();
    withEnv(`${provider.bin} {prompt}`);

    // Nothing but credential material: redaction leaves no evidence behind.
    const blocks = screenOutbound({ extract: `${SECRET_FIXTURE} ${SECRET_FIXTURE} ${SECRET_FIXTURE}` });
    expect(blocks).toBeNull();
    expect(provider.calls()).toEqual([]);
  });

  test("one gutted block blocks the whole call, even beside a clean one", () => {
    const blocks = screenOutbound({
      clean: "a perfectly ordinary sentence about the build pipeline",
      dirty: `${SECRET_FIXTURE}${SECRET_FIXTURE}`,
    });
    expect(blocks).toBeNull();
  });
});
