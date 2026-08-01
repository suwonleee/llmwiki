import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as capture from "../src/engine/capture.ts";
import { enrollRepo, makeGitRepo } from "./support/git-repo.ts";

// The distilled-row reopen must not hang on stat identity alone. On Linux runtimes without statx
// birthtime, birthtimeMs is 0 and a delete+recreate routinely reuses the freed inode, so both
// generations stat to the same `dev:ino:0` and the identity comparison never fires — the session
// silently stops being captured. Rewriting IN PLACE reproduces that degenerate identity
// deterministically on every platform: same inode, same birthtime — only the shrunken
// append-only body is left as evidence of the new generation.
describe("capture reopen evidence", () => {
  test("a same-identity regeneration reopens through the size watermark", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmwiki-reopen-"));
    try {
      const repo = realpathSync(enrollRepo(makeGitRepo(join(dir, "repo"))));
      const transcript = join(dir, "export.jsonl");
      writeFileSync(transcript, '{"n":1}\n{"n":2}\n{"n":3}\n{"n":4}\n');
      capture.enqueue(transcript, "s-reopen", repo, 4, "opencode");
      capture.mark(transcript, statSync(transcript).size, "distilled");
      expect(capture.pending(repo)).toEqual([]);

      writeFileSync(transcript, '{"n":5}\n'); // truncate-rewrite: same inode, smaller body
      capture.enqueue(transcript, "s-reopen", repo, 1, "opencode");
      expect(capture.pending(repo).map((r) => r.transcript_path)).toEqual([transcript]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
