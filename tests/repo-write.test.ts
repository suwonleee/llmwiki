// The repository I/O boundary's RUNTIME contract (not just its types).
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoFileMetadata } from "../src/engine/repo-write.ts";

describe("repoFileMetadata runtime contract (floor-runtime regression)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-meta-"));
    mkdirSync(join(root, "docs", "wiki"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("mtimeNs is ALWAYS a bigint, whatever the runtime's stat fills in", () => {
    // bun 1.2.x returns undefined for fstatSync(...).mtimeNs (statSync is fine, 1.3 fixed it).
    // The declared type said bigint, so indexing crashed on the floor runtime with
    // "undefined is not an object" while every macOS run passed. The boundary owns this now.
    writeFileSync(join(root, "docs", "wiki", "p.md"), "# P\n\nbody");
    const meta = repoFileMetadata(root, "docs/wiki/p.md");
    expect(meta).not.toBeNull();
    expect(typeof meta!.mtimeNs).toBe("bigint");
    expect(typeof meta!.mtimeMs).toBe("number");
    expect(meta!.mtimeNs > 0n).toBe(true);
  });

  test("the derived value is stable across calls — the stat fast-path compares it for equality", () => {
    writeFileSync(join(root, "docs", "wiki", "q.md"), "# Q\n\nbody");
    const a = repoFileMetadata(root, "docs/wiki/q.md")!;
    const b = repoFileMetadata(root, "docs/wiki/q.md")!;
    expect(a.mtimeNs).toBe(b.mtimeNs); // an unstable derivation would disable skipping forever
  });
});
