// Direction drafts go to 0_review, a directory the normal linter intentionally skips. The
// autoupdate transaction must lint the underlying candidate first and leave no file/watermark
// change when it is malformed.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateOne } from "../src/engine/autoupdate.ts";
import * as capture from "../src/engine/capture.ts";
import { LLM_CMD_ENV } from "../src/engine/claude.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { ensureSkeleton } from "../src/engine/update.ts";

let scratch = "";
let previousCommand: string | undefined;
let previousState = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "llmwiki-direction-update-"));
  previousCommand = process.env[LLM_CMD_ENV];
  previousState = capture.stateDir();
  capture.setStateDir(join(scratch, "state"));
});

afterEach(() => {
  if (previousCommand === undefined) delete process.env[LLM_CMD_ENV];
  else process.env[LLM_CMD_ENV] = previousCommand;
  capture.setStateDir(previousState);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("a lint-invalid direction candidate is omitted and remains pending", async () => {
  const repo = join(scratch, "repo");
  mkdirSync(repo);
  const idx = new WikiIndex(repo);
  idx.init();
  ensureSkeleton(repo);

  const transcript = join(scratch, "session.md");
  writeFileSync(transcript, "We decided to keep local-only storage and review the direction with a human.\n");
  capture.enqueue(transcript, "direction-session", repo, 1, "plain");

  const counter = join(scratch, "provider-count");
  const provider = join(scratch, "fake-provider");
  writeFileSync(
    provider,
    "#!/bin/sh\n" +
      `COUNT_FILE=${JSON.stringify(counter)}\n` +
      "n=0\n" +
      "[ -f \"$COUNT_FILE\" ] && n=$(cat \"$COUNT_FILE\")\n" +
      "n=$((n + 1))\n" +
      "printf '%s' \"$n\" > \"$COUNT_FILE\"\n" +
      "if [ \"$n\" -eq 1 ]; then\n" +
      "  printf -- '---\\ndescription: missing title\\ndate:\\ntags: [direction, security]\\nstatus: ready\\ndomain: direction\\nsource: session.md\\n---\\n\\n## TL;DR\\n\\nKeep storage local.[^1]\\n\\n[^1]: session.md\\n'\n" +
      "else\n" +
      "  printf 'VERIFIED\\n'\n" +
      "fi\n",
  );
  chmodSync(provider, 0o755);
  process.env[LLM_CMD_ENV] = `${provider} {prompt}`;

  const result = await updateOne(repo, transcript, true, "light-test", "heavy-test");

  expect(result.verdict).toBe("rejected");
  expect(result.lint_errors).toEqual(expect.arrayContaining([expect.stringContaining("missing-title")]));
  expect(existsSync(join(repo, String(result.dest)))).toBe(false);
  expect(capture.getOffset(transcript)).toBe(0);
  expect(capture.pending(repo).map((row) => row.transcript_path)).toContain(transcript);
});
