// Codex adapter — proves the TranscriptSource interface generalizes to a second harness.
// parse() is exercised against both Codex shapes (nested response_item/payload + flat
// message); probe()/watchRoots() guard the ~/.codex boundary. No live ~/.codex needed.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSource } from "../src/engine/sources/codex.ts";
import { sources, sourceForKind, discoverableSources } from "../src/engine/source.ts";
import { zstdCompressFixture } from "./support/zstd-fixture.ts";

function writeJsonl(path: string, records: any[]): Buffer {
  const data = Buffer.from(records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  writeFileSync(path, data);
  return data;
}

describe("codex registry wiring", () => {
  test("registered, plain still last, codex is discoverable", () => {
    const ks = sources().map((s) => s.kind);
    expect(ks).toEqual(["claude-jsonl", "codex", "opencode", "plain"]);
    expect(sourceForKind("codex").kind).toBe("codex");
    expect(discoverableSources().map((s) => s.kind)).toEqual(["claude-jsonl", "codex", "opencode"]);
  });

  test("watchRoots is empty when ~/.codex is absent (byte-identical daemon)", () => {
    // CI/dev machines without Codex: no roots → daemon behaves as claude-only.
    expect(Array.isArray(codexSource.watchRoots!())).toBe(true);
  });
});

describe("codex parse", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "llmwiki-cx-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("nested response_item/payload shape: roles, cwd, session, filters", () => {
    const records = [
      { type: "session_meta", payload: { id: "cx-1", git: { repository_path: "/repo/cx" } } },
      {
        type: "response_item",
        timestamp: "2026-06-20T10:00:00Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "please refactor the parser" }] },
      },
      {
        type: "response_item",
        timestamp: "2026-06-20T10:01:00Z",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "B".repeat(200) }] },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "tiny" }] },
      },
    ];
    const path = join(dir, "rollout.jsonl");
    writeJsonl(path, records);

    const inc = codexSource.parse(path, 0);
    expect(inc.users.length).toBe(1);
    expect(inc.users[0]!.text).toContain("refactor");
    expect(inc.assistants.length).toBe(1); // short assistant filtered (<180)
    expect(inc.cwd).toBe("/repo/cx");
    expect(inc.sessionId).toBe("cx-1");
  });

  test("flat message shape + string content also parses", () => {
    const records = [
      { type: "message", role: "user", cwd: "/repo/flat", id: "cx-2", message: { content: "do the thing here now" } },
    ];
    const path = join(dir, "flat.jsonl");
    writeJsonl(path, records);
    const inc = codexSource.parse(path, 0);
    expect(inc.users.length).toBe(1);
    expect(inc.cwd).toBe("/repo/flat");
    expect(inc.sessionId).toBe("cx-2");
  });

  test("byte-offset watermark advances on bytes (multibyte safe)", () => {
    const first = { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "가나다 첫 지시" }] } };
    const second = { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "라마바 둘째 지시" }] } };
    const path = join(dir, "k.jsonl");
    writeJsonl(path, [first, second]);
    const firstBytes = Buffer.from(JSON.stringify(first), "utf-8").length + 1; // +newline
    const inc = codexSource.parse(path, firstBytes);
    expect(inc.users.length).toBe(1);
    expect(inc.users[0]!.text).toContain("둘째");
  });

  test("probe rejects a path that is not under ~/.codex/sessions", () => {
    const path = join(dir, "rollout.jsonl");
    writeJsonl(path, [{ type: "message", role: "user", message: { content: "hi there" } }]);
    expect(codexSource.probe(path)).toBeNull(); // dir is a tmp path, not ~/.codex
  });
});

// P3a — zstd-compressed cold rollouts (foo.jsonl.zst) and the rename fallback.
import { resolveRolloutPath } from "../src/engine/sources/codex.ts";
import { renameSync } from "node:fs";

describe("codex .zst rollouts", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "llmwiki-cxz-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const RECORDS = [
    { type: "session_meta", payload: { id: "cx-z", git: { repository_path: "/repo/z" } } },
    {
      type: "response_item",
      timestamp: "2026-07-10T10:00:00Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "compressed session ask" }] },
    },
    {
      type: "response_item",
      timestamp: "2026-07-10T10:01:00Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Z".repeat(200) }] },
    },
  ];

  function writeZst(path: string): number {
    const plain = Buffer.from(RECORDS.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
    writeFileSync(path, zstdCompressFixture(plain));
    return plain.length; // decompressed byte length = expected watermark
  }

  test("parse decompresses .zst; watermark is over decompressed bytes", () => {
    const p = join(dir, "rollout-old.jsonl.zst");
    const plainLen = writeZst(p);
    const inc = codexSource.parse(p, 0);
    expect(inc.users.length).toBe(1);
    expect(inc.users[0]!.text).toContain("compressed");
    expect(inc.assistants.length).toBe(1);
    expect(inc.newOffset).toBe(plainLen);
    // second pass from the watermark: nothing new (immutable cold file)
    const again = codexSource.parse(p, inc.newOffset);
    expect(again.users.length).toBe(0);
    expect(again.newOffset).toBe(plainLen);
  });

  test("queued .jsonl path renamed to .jsonl.zst resolves to the sibling", () => {
    const plainPath = join(dir, "rollout-r.jsonl");
    writeJsonl(plainPath, RECORDS);
    const first = codexSource.parse(plainPath, 0);
    expect(first.users.length).toBe(1);
    // Codex compresses the cold file in place
    const zstPath = `${plainPath}.zst`;
    writeZst(zstPath);
    rmSync(plainPath);
    expect(resolveRolloutPath(plainPath)).toBe(zstPath);
    const inc = codexSource.parse(plainPath, 0); // old queue row still parses
    expect(inc.users.length).toBe(1);
  });
});
