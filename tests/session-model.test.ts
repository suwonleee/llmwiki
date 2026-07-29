// The generative pass runs on the model the person is actually working with.
//
// The engine used to ship model ids (`claude-sonnet-5` / `claude-opus-4-8`). That is a small piece
// of central management inside a harness-independent project, and it fails in the worst direction:
// the string ages, the provider eventually retires it, and a pass breaks for a user who changed
// nothing. (It had already aged — Opus 5 shipped while the engine still named 4.8.) So the model is
// OBSERVED from what each harness recorded about its own session, with a per-harness fallback and,
// for an unrecognized CLI, no `--model` flag at all.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";
import { dropModelFlag } from "../src/engine/claude.ts";
import {
  HARNESS_FALLBACK,
  observedModel,
  resolveGenerativeModel,
  targetHarness,
} from "../src/engine/session-model.ts";

let dir: string;
let repo: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["OPENCODE_DB", "LLMWIKI_MODEL_LIGHT", "LLMWIKI_MODEL_HEAVY"] as const;

const CLAUDE = ["claude", "-p", "{prompt}", "--model", "{model}"];

/** A Claude transcript: assistant records carry `message.model`. */
function claudeTranscript(path: string, models: string[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const lines = models.map((m) =>
    JSON.stringify({
      type: "assistant",
      cwd: repo,
      sessionId: "s1",
      message: { role: "assistant", model: m, content: [{ type: "text", text: "hi" }] },
    }),
  );
  writeFileSync(path, lines.join("\n") + "\n");
}

/** A Codex rollout: session_meta first, then the `turn_context` record that names the model. */
function codexRollout(path: string, model: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ type: "session_meta", payload: { id: "019f", cwd: repo } }) + "\n" +
      JSON.stringify({ type: "turn_context", payload: { cwd: repo, model } }) + "\n",
  );
}

/** An OpenCode export (our own format) plus the database its header points at. */
function opencodeExport(exportPath: string, dbPath: string, sessionID: string, model: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT,
      time_updated INTEGER, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
      time_updated INTEGER, data TEXT);
  `);
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?)").run(sessionID, repo, "t", 1, null);
  // Only the FIRST slash separates provider from model, and plenty of ids carry none at all
  // (Ollama's `llama3.1:8b`, Bedrock's `…-v2:0`). Splitting on every slash would rewrite the
  // fixture into something no provider emits.
  const slash = model.indexOf("/");
  const providerID = slash === -1 ? "" : model.slice(0, slash);
  const modelID = slash === -1 ? model : model.slice(slash + 1);
  db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(
    "msg_0001", sessionID, 1, 1,
    JSON.stringify({ role: "assistant", providerID, modelID, time: { created: 1, completed: 2 } }),
  );
  db.close();
  mkdirSync(join(exportPath, ".."), { recursive: true });
  writeFileSync(
    exportPath,
    JSON.stringify({ kind: "opencode-meta", sessionID, directory: repo, title: "t", sourcePath: dbPath }) +
      "\n" + JSON.stringify({ role: "assistant", text: "hi", ts: "2026-07-29T00:00" }) + "\n",
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llmwiki-sessmodel-"));
  repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  capture.setStateDir(join(dir, "state"));
  process.env.OPENCODE_DB = join(dir, "absent.db"); // never the developer's real database
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("observing the session's model", () => {
  test("Claude: reads message.model, newest wins", () => {
    const t = join(dir, "home", ".claude", "projects", "-repo", "s1.jsonl");
    claudeTranscript(t, ["claude-opus-4-8", "claude-opus-5"]);
    capture.enqueue(t, "s1", repo, 1, "claude-jsonl");
    expect(observedModel(repo, "claude")).toBe("claude-opus-5");
  });

  test("Codex: reads the rollout's model", () => {
    const t = join(dir, "home", ".codex", "sessions", "2026", "07", "29", "rollout-x-019f.jsonl");
    codexRollout(t, "gpt-5.6-sol");
    capture.enqueue(t, "019f", repo, 1, "codex");
    expect(observedModel(repo, "codex")).toBe("gpt-5.6-sol");
  });

  test("OpenCode: follows the export header into the database, provider-qualified", () => {
    // Outside the state root on purpose: writing a fixture into it before capture initializes it
    // would trip the ownership gate. What is under test is the export FORMAT and the hop into the
    // database it names — not where the file sits.
    const exp = join(dir, "exports", "abc.jsonl");
    const db = join(dir, "oc.db");
    opencodeExport(exp, db, "ses_1", "anthropic/claude-opus-5");
    capture.enqueue(exp, "ses_1", repo, 1, "opencode");
    expect(observedModel(repo, "opencode")).toBe("anthropic/claude-opus-5");
  });

  // The guard has to be generous where real ids are: rejecting one is indistinguishable from
  // observing nothing, so an over-strict pattern drops a user onto a constant — the stale
  // hardcoded id returning through another door. OpenCode is multi-provider by design.
  test.each([
    ["ollama", "llama3.1:8b"],
    ["ollama tagged", "qwen2.5-coder:7b"],
    ["bedrock", "anthropic.claude-3-5-sonnet-20241022-v2:0"],
    ["bedrock with a region prefix", "us.anthropic.claude-sonnet-4-20250514-v1:0"],
    ["openrouter", "google/gemini-2.5-pro"],
  ])("an id from a real provider survives the guard: %s", (name, model) => {
    const slug = name.replace(/\W/g, "");
    const exp = join(dir, "exports", `${slug}.jsonl`);
    opencodeExport(exp, join(dir, `oc-${slug}.db`), `ses_${slug}`, model);
    capture.enqueue(exp, `ses_${slug}`, repo, 1, "opencode");
    expect(observedModel(repo, "opencode")).toBe(model);
  });

  // A recorded id becomes a `--model` argument, so every harness path bounds its shape the way
  // the Claude pattern always did. Nothing is shell-parsed (argv array), so this is about a
  // malformed record producing a flag-shaped argument, not about injection.
  test("a malformed model id is ignored, and the pass falls back", () => {
    const cx = join(dir, "home", ".codex", "sessions", "rollout-x-01bad.jsonl");
    mkdirSync(join(cx, ".."), { recursive: true });
    writeFileSync(
      cx,
      JSON.stringify({ type: "session_meta", payload: { id: "01bad", cwd: repo } }) + "\n" +
        JSON.stringify({ type: "turn_context", payload: { cwd: repo, model: "--dangerously-skip x" } }) + "\n",
    );
    capture.enqueue(cx, "01bad", repo, 2, "codex");
    expect(observedModel(repo, "codex")).toBeNull();
    expect(
      resolveGenerativeModel({ repo, tier: "heavy", pinned: null, template: ["codex", "--model", "{model}"] }),
    ).toBe(HARNESS_FALLBACK.codex);
  });

  // A session that reads a config file full of model ids must not be mistaken for a session
  // running those models. Codex's model is taken from a `turn_context` RECORD, never from a bare
  // `"model"` key; Claude's per-record `message.model` is additionally family-prefixed.
  test("a model id quoted in the conversation does not override the session's own", () => {
    const cx = join(dir, "home", ".codex", "sessions", "rollout-x-019f.jsonl");
    mkdirSync(join(cx, ".."), { recursive: true });
    writeFileSync(
      cx,
      JSON.stringify({ type: "session_meta", payload: { id: "019f", cwd: repo } }) + "\n" +
        JSON.stringify({ type: "turn_context", payload: { cwd: repo, model: "gpt-5.6-sol" } }) + "\n" +
        JSON.stringify({
          type: "response_item",
          payload: { role: "assistant", content: [{ type: "output_text", text: 'the file said "model": "gpt-4o-mini"' }] },
        }) + "\n",
    );
    capture.enqueue(cx, "019f", repo, 2, "codex");
    expect(observedModel(repo, "codex")).toBe("gpt-5.6-sol");

    const cc = join(dir, "home", ".claude", "projects", "-repo", "s2.jsonl");
    mkdirSync(join(cc, ".."), { recursive: true });
    writeFileSync(
      cc,
      JSON.stringify({
        type: "assistant", cwd: repo, sessionId: "s2",
        message: { role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: '{"model": "not-a-claude-id"}' }] },
      }) + "\n",
    );
    capture.enqueue(cc, "s2", repo, 1, "claude-jsonl");
    expect(observedModel(repo, "claude")).toBe("claude-opus-5");
  });

  test("nothing captured for this repo → no observation (never throws)", () => {
    expect(observedModel(repo, "claude")).toBeNull();
    expect(observedModel(repo, "codex")).toBeNull();
  });
});

describe("resolution order", () => {
  test("a pin wins over observation", () => {
    const t = join(dir, "home", ".claude", "projects", "-repo", "s1.jsonl");
    claudeTranscript(t, ["claude-opus-5"]);
    capture.enqueue(t, "s1", repo, 1, "claude-jsonl");
    expect(
      resolveGenerativeModel({ repo, tier: "heavy", pinned: "my-pinned-model", template: CLAUDE }),
    ).toBe("my-pinned-model");
  });

  test("unpinned uses the observed session model", () => {
    const t = join(dir, "home", ".claude", "projects", "-repo", "s1.jsonl");
    claudeTranscript(t, ["claude-opus-5"]);
    capture.enqueue(t, "s1", repo, 1, "claude-jsonl");
    expect(resolveGenerativeModel({ repo, tier: "heavy", pinned: null, template: CLAUDE })).toBe(
      "claude-opus-5",
    );
  });

  test("nothing observed → the harness fallback, per harness", () => {
    const pick = (bin: string) =>
      resolveGenerativeModel({ repo, tier: "light", pinned: null, template: [bin, "{model}"] });
    expect(pick("claude")).toBe(HARNESS_FALLBACK.claude);
    expect(pick("codex")).toBe(HARNESS_FALLBACK.codex);
    expect(pick("opencode")).toBe(HARNESS_FALLBACK.opencode);
  });

  // The engine cannot know a third-party CLI's model vocabulary, and guessing would hand it a
  // string it may reject. Saying nothing lets that CLI use its own default — which is, by
  // construction, a model this machine can run.
  test("unrecognized CLI → null, so the caller drops the flag", () => {
    expect(resolveGenerativeModel({ repo, tier: "heavy", pinned: null, template: ["ollama", "run"] })).toBeNull();
    expect(resolveGenerativeModel({ repo, tier: "heavy", pinned: null, template: null })).toBeNull();
  });

  test("targetHarness reads the CLI name, path and extension tolerant", () => {
    expect(targetHarness(["/opt/bin/claude", "-p"])).toBe("claude");
    expect(targetHarness(["codex.exe"])).toBe("codex");
    expect(targetHarness(["opencode"])).toBe("opencode");
    expect(targetHarness(["my-wrapper.sh"])).toBeNull();
    expect(targetHarness([])).toBeNull();
  });
});

describe("dropping the model flag when nothing is known", () => {
  test("removes the flag and its value, keeping the rest of the argv", () => {
    expect(dropModelFlag(["claude", "-p", "{prompt}", "--model", "{model}", "--json"])).toEqual([
      "claude", "-p", "{prompt}", "--json",
    ]);
  });

  test("removes the `--model={model}` spelling too", () => {
    expect(dropModelFlag(["llm", "--model={model}", "-q", "{prompt}"])).toEqual(["llm", "-q", "{prompt}"]);
  });

  test("a bare interpolation is emptied, not allowed to eat a neighbour", () => {
    expect(dropModelFlag(["run", "prefix-{model}", "{prompt}"])).toEqual(["run", "prefix-", "{prompt}"]);
  });

  test("a template with no {model} is untouched", () => {
    expect(dropModelFlag(["claude", "-p", "{prompt}"])).toEqual(["claude", "-p", "{prompt}"]);
  });
});
