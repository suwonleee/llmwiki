// Every test run gets its own state root.
//
// Derived per-project state is engine-held (engine/project-state.ts), so a test that indexes a
// repository now writes into the STATE ROOT rather than into the temp repository it just made. A
// suite that does not pin the root therefore writes into whatever the developer's machine
// resolves — and it did: a full run left 18 project directories in this clone's own `.state`,
// which is both litter and a way for one test to see another's leftovers.
//
// Pinning it here rather than in each test file also fixes the subprocess half: tests that spawn
// the CLI pass `{...process.env}`, so the child resolves the same root as its parent instead of
// falling back to the machine default and finding no index.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.LLMWIKI_STATE_DIR) {
  process.env.LLMWIKI_STATE_DIR = mkdtempSync(join(tmpdir(), "llmwiki-test-state-"));
}
