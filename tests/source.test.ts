// TranscriptSource abstraction — registry routing, plain adapter parse (byte-offset on
// multibyte), and claude probe rejection of non-~/.claude paths.
import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sources, sourceForKind, sourceForPath, routeHintKind, ROUTE_MAX_BYTES } from "../src/engine/source.ts";
import { plainSource } from "../src/engine/sources/plain.ts";
import { claudeJsonlSource } from "../src/engine/sources/claude.ts";

describe("source registry", () => {
  test("registry order: greedy plain is LAST", () => {
    const ks = sources().map((s) => s.kind);
    expect(ks).toContain("claude-jsonl");
    expect(ks[ks.length - 1]).toBe("plain");
  });

  test("sourceForKind: known + unknown→claude fallback", () => {
    expect(sourceForKind("plain").kind).toBe("plain");
    expect(sourceForKind("claude-jsonl").kind).toBe("claude-jsonl");
    expect(sourceForKind("does-not-exist").kind).toBe("claude-jsonl");
  });

  test("plain never auto-discovers", () => {
    expect(plainSource.discover()).toEqual([]);
  });
});

describe("plain adapter", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "llmwiki-plain-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("probe claims a non-empty file, rejects a missing one", () => {
    const p = join(dir, "drop.md");
    writeFileSync(p, "# Title\nbody\n");
    const d = plainSource.probe(p);
    expect(d).not.toBeNull();
    expect(d!.sessionId).toBeNull();
    expect(d!.lines).toBe(3); // 2 newlines + 1
    expect(plainSource.probe(join(dir, "nope.md"))).toBeNull();
  });

  test("parse = whole tail as one user turn", () => {
    const p = join(dir, "drop.md");
    writeFileSync(p, "alpha beta gamma");
    const inc = plainSource.parse(p, 0);
    expect(inc.users.length).toBe(1);
    expect(inc.assistants.length).toBe(0);
    expect(inc.users[0]!.text).toBe("alpha beta gamma");
    expect(inc.sessionId).toBeNull();
  });

  test("byte-offset watermark honored on multibyte (한글)", () => {
    const p = join(dir, "k.md");
    const first = "가나다\n"; // 3×3 bytes + newline = 10 bytes
    writeFileSync(p, first + "라마바");
    const firstBytes = Buffer.from(first, "utf-8").length;
    expect(firstBytes).toBe(10);

    const full = plainSource.parse(p, 0);
    expect(full.newOffset).toBe(Buffer.from(first + "라마바", "utf-8").length);

    const tail = plainSource.parse(p, firstBytes);
    expect(tail.users[0]!.text).toBe("라마바"); // resumes cleanly on a char boundary
  });
});

describe("claude adapter probe", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "llmwiki-cl-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("rejects a .jsonl that is NOT under ~/.claude*/projects", () => {
    const p = join(dir, "fake.jsonl");
    writeFileSync(p, '{"type":"user","message":{"content":"hi"}}\n');
    expect(claudeJsonlSource.probe(p)).toBeNull();
  });

  test("rejects an arbitrary .md", () => {
    const p = join(dir, "notes.md");
    writeFileSync(p, "# notes\n");
    expect(claudeJsonlSource.probe(p)).toBeNull();
  });

  test("sourceForPath falls back to plain for both", () => {
    const j = join(dir, "fake.jsonl");
    const m = join(dir, "notes.md");
    writeFileSync(j, '{"type":"user","message":{"content":"hi"}}\n');
    writeFileSync(m, "# notes\n");
    expect(sourceForPath(j).kind).toBe("plain");
    expect(sourceForPath(m).kind).toBe("plain");
  });
});

describe("routeHintKind — the kind a SessionStart hint records", () => {
  // The SessionStart route hint is what `save-current` enqueues under, and the condense pass picks
  // its parser from that kind. A Codex rollout recorded as claude-jsonl is parsed by the Claude
  // parser and extracts ZERO turns. The classifier must therefore go through the registry probe —
  // which knows every home an adapter owns — not a path substring: Codex Desktop relocates
  // CODEX_HOME per signed-in account (…/orca/codex-accounts/<uuid>/home/sessions/…), so a genuine
  // Codex rollout path never contains "/.codex/".
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "llmwiki-hintkind-"))));
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const setEnv = (name: string, value: string): void => {
    if (!(name in saved)) saved[name] = process.env[name];
    process.env[name] = value;
  };

  test("a relocated-home Codex rollout is classified codex, not claude-jsonl", () => {
    // A CODEX_HOME whose path does NOT contain ".codex": the exact shape of a desktop-app home.
    const codexHome = join(dir, "relocated-home");
    const day = join(codexHome, "sessions", "2026", "09", "05");
    mkdirSync(day, { recursive: true });
    const rollout = join(day, "rollout-2026-09-05T20-01-56-01a00000-0000-7000-8000-00000000000a.jsonl");
    writeFileSync(
      rollout,
      JSON.stringify({ type: "session_meta", payload: { id: "01a00000", cwd: dir } }) + "\n",
    );
    expect(rollout.includes("/.codex/")).toBe(false); // the old substring test would have missed it
    setEnv("CODEX_HOME", codexHome);
    expect(routeHintKind(rollout)).toBe("codex");
  });

  test("a Claude transcript stays claude-jsonl; an unowned file is null", () => {
    const claudeCfg = join(dir, ".claude");
    const projects = join(claudeCfg, "projects", "p");
    mkdirSync(projects, { recursive: true });
    const jsonl = join(projects, "s.jsonl");
    writeFileSync(jsonl, '{"type":"user","message":{"role":"user","content":"hi"},"cwd":"' + dir + '"}\n');
    setEnv("CLAUDE_CONFIG_DIR", claudeCfg);
    expect(routeHintKind(jsonl)).toBe("claude-jsonl");
    // An arbitrary markdown file belongs to no harness → no hint kind (never the plain fallback).
    const md = join(dir, "notes.md");
    writeFileSync(md, "# notes\n");
    expect(routeHintKind(md)).toBeNull();
  });

  test("a rollout in a home this process cannot see still classifies by the harness layout", () => {
    // The hook inherits whatever CODEX_HOME the launching app exported (Codex Desktop: its runtime
    // home), so a ~/.codex rollout is outside every home the registry knows about here.
    const elsewhere = join(dir, "orca-runtime-home");
    mkdirSync(join(elsewhere, "sessions"), { recursive: true });
    setEnv("CODEX_HOME", elsewhere);
    const day = join(dir, "dot-codex", "sessions", "2026", "10", "05");
    mkdirSync(day, { recursive: true });
    const rollout = join(day, "rollout-2026-10-05T09-30-00-01c00000-0000-7000-8000-00000000000c.jsonl");
    writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: "01c00000", cwd: dir } }) + "\n");
    expect(routeHintKind(rollout)).toBe("codex");
    expect(routeHintKind(`${rollout}.zst`)).toBe("codex");
    const claudeElsewhere = join(dir, "other", ".claude", "projects", "-Users-x-repo");
    mkdirSync(claudeElsewhere, { recursive: true });
    const jsonl = join(claudeElsewhere, "0a1b2c3d-0000-4000-8000-00000000000d.jsonl");
    writeFileSync(jsonl, "{}\n");
    setEnv("CLAUDE_CONFIG_DIR", join(dir, "unrelated-claude"));
    expect(routeHintKind(jsonl)).toBe("claude-jsonl");
    // Lookalikes that are not the layout stay unowned.
    const loose = join(dir, "rollout-notes.jsonl");
    writeFileSync(loose, "{}\n");
    expect(routeHintKind(loose)).toBeNull();
  });

  test("classification reads a bounded head, never the whole transcript", () => {
    // SessionStart re-runs on every resume/compact; a whole-file read there is hook latency that
    // grows with the session. A transcript far past the routing budget, whose tail is not even
    // JSON, must classify from its head alone — and without a single whole-file read.
    const codexHome = join(dir, "relocated-home");
    const day = join(codexHome, "sessions", "2026", "10", "05");
    mkdirSync(day, { recursive: true });
    const rollout = join(day, "rollout-2026-10-05T09-00-00-01b00000-0000-7000-8000-00000000000b.jsonl");
    writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: "01b00000", cwd: dir } }) + "\n");
    appendFileSync(rollout, Buffer.alloc(ROUTE_MAX_BYTES * 4, 0xff));
    expect(statSync(rollout).size).toBeGreaterThan(ROUTE_MAX_BYTES * 4);
    setEnv("CODEX_HOME", codexHome);
    const whole = spyOn(fs, "readFileSync");
    try {
      expect(routeHintKind(rollout)).toBe("codex");
      expect(whole.mock.calls.filter(([p]) => String(p) === rollout)).toEqual([]);
    } finally {
      whole.mockRestore();
    }
  });
});
