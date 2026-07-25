// The same CJK name exists in two byte forms, and which one lands on disk is not the author's
// choice: macOS Finder, `unzip` and iCloud/Dropbox sync decompose (NFD), while a keyboard and git
// generally compose (NFC). A wiki shared between a Mac and a Linux checkout therefore ends up with
// "언어-설정.md" on disk and "[[언어-설정]]" in the prose that are, byte for byte, different names.
// Nothing about that is visible to the reader — the link simply produces no edge and the page
// quietly reads as an orphan.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { WikiIndex } from "../src/engine/db.ts";
import { buildLinkIndex, lookupKey, resolveWikiLink, updateReferences } from "../src/engine/refs.ts";

const NFC = "언어-설정";
const NFD = NFC.normalize("NFD");

const doc = (id: string, name: string) => ({
  id,
  filename: `${name}.md`,
  relative_path: `docs/wiki/5_topic/${name}.md`,
  title: null,
});

describe("unicode normalization in link resolution", () => {
  test("the two byte forms really are different strings", () => {
    expect(NFD).not.toBe(NFC); // guard: without this the rest of the file proves nothing
    expect([...NFD].length).toBeGreaterThan([...NFC].length);
  });

  test("both forms of a name share one lookup key", () => {
    expect(lookupKey(NFD)).toBe(lookupKey(NFC));
  });

  test("a composed link finds a decomposed file, and the reverse", () => {
    expect(resolveWikiLink(`5_topic/${NFC}`, buildLinkIndex([doc("1", NFD)]))?.id).toBe("1");
    expect(resolveWikiLink(`5_topic/${NFD}`, buildLinkIndex([doc("2", NFC)]))?.id).toBe("2");
  });

  test("case folding still applies alongside normalization", () => {
    const index = buildLinkIndex([doc("3", "Language-Settings")]);
    expect(resolveWikiLink("5_topic/language-settings", index)?.id).toBe("3");
  });
});

describe("normalization end to end", () => {
  let root: string;
  let wiki: string;
  let idx: WikiIndex;
  let conn: Database;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "llmwiki-nfd-"));
    wiki = join(root, "docs", "wiki");
    mkdirSync(join(wiki, "5_topic"), { recursive: true });
    mkdirSync(join(wiki, "3_decision"), { recursive: true });
    idx = new WikiIndex(root);
    conn = idx.connect();
  });

  afterEach(() => {
    conn.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a decomposed filename still produces a links_to edge from a composed link", () => {
    // The filesystem may normalize the name it stores; if it does, this case degenerates to the
    // ordinary one and still passes. Where it does not (Linux, and APFS which preserves what it
    // is given), this is the real cross-checkout scenario.
    writeFileSync(join(wiki, "5_topic", `${NFD}.md`), "# 언어 설정\n\n" + "언어 설정에 관한 문서. ".repeat(20));
    const linker = join(wiki, "3_decision", "links.md");
    writeFileSync(linker, `# 결정\n\n[[5_topic/${NFC}]] 를 근거로 삼는다.\n\n` + "본문. ".repeat(40));
    idx.indexAll(conn);

    const source = idx.listDocuments(conn).find((d) => d.filename === "links.md")!;
    const [, links] = updateReferences(idx, conn, source as any, readFileSync(linker, "utf-8"));
    expect(links).toBe(1);
  });
});
