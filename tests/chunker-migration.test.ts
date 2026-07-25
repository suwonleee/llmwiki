// Chunk boundaries are a function of how tokens are counted, so changing that count leaves every
// existing chunk cut to the old rule. Indexing is incremental by content hash, and the files did
// not change — without an explicit invalidation a wiki would keep its old chunking forever and
// end up with a permanent mix of two chunk sizes.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiIndex } from "../src/engine/db.ts";

describe("chunker version migration", () => {
  let root: string;
  let idx: WikiIndex;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-chunkmig-"));
    const wiki = join(root, "docs", "wiki");
    mkdirSync(wiki, { recursive: true });
    writeFileSync(join(wiki, "a.md"), "# Alpha\n\n" + "alpha keyword content ".repeat(40));
    idx = new WikiIndex(root);
    const conn = idx.connect();
    idx.indexAll(conn);
    conn.close();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("an unchanged wiki is not re-chunked when the counting rule is the same", () => {
    const conn = idx.connect();
    expect(idx.indexAll(conn)).toEqual([0, 0]);
    conn.close();
  });

  test("a stale build marker re-chunks every page even though no file changed", () => {
    let conn = idx.connect();
    conn.run("UPDATE index_build SET value = 'chunker-from-an-older-release' WHERE key = 'chunker'");
    const before = (conn.query("SELECT count(*) c FROM document_chunks").get() as { c: number }).c;
    expect(before).toBeGreaterThan(0);
    conn.close();

    conn = idx.connect(); // migration runs here
    expect((conn.query("SELECT count(*) c FROM document_chunks").get() as { c: number }).c).toBe(0);
    const [, updated] = idx.indexAll(conn);
    expect(updated).toBe(1);
    expect((conn.query("SELECT count(*) c FROM document_chunks").get() as { c: number }).c).toBeGreaterThan(0);
    conn.close();

    // …and it settles: the marker is current again, so the next open is a no-op.
    conn = idx.connect();
    expect(idx.indexAll(conn)).toEqual([0, 0]);
    conn.close();
  });
});
