import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";
import * as update from "../src/engine/update.ts";
import { REDACTED } from "../src/engine/screen.ts";

describe("update-next source routing", () => {
  let dir: string;
  let workspace: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-update-source-"));
    workspace = join(dir, "repo");
    // The repository root must EXIST before the engine touches it: the boundary resolves the
    // canonical root instead of creating whatever path it was handed.
    mkdirSync(workspace, { recursive: true });
    capture.setStateDir(join(dir, "state"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("uses the queued Codex adapter instead of the legacy Claude parser", () => {
    const transcript = join(dir, "rollout.jsonl");
    const records = [
      { type: "session_meta", payload: { id: "codex-session", cwd: workspace } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "record this Codex session in the project wiki" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "A".repeat(220) }],
        },
      },
    ];
    writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    capture.enqueue(transcript, "codex-session", workspace, records.length, "codex");

    const increment = update.nextIncrement(workspace, transcript);

    expect(increment.nUsers).toBe(1);
    expect(increment.nAssistants).toBe(1);
    expect(increment.cwd).toBe(workspace);
    expect(increment.sessionId).toBe("codex-session");
  });

  test("manual enqueue records the detected plain-text adapter", () => {
    mkdirSync(workspace, { recursive: true });
    const transcript = join(dir, "notes.txt");
    writeFileSync(transcript, "A plain transcript that should not be decoded as Claude JSONL.\n");

    update.enqueue(workspace, transcript, "plain-session");

    expect(capture.getSourceKind(transcript)).toBe("plain");
    expect(update.nextIncrement(workspace, transcript).rendered).toContain("A plain transcript");
  });

  test("screens transcript material before any harness can print it back into model context", () => {
    const transcript = join(dir, "rollout.jsonl");
    const credential = `AKIA${"A".repeat(16)}`;
    const records = [
      { type: "session_meta", payload: { id: "codex-secret", cwd: workspace } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `Keep the decision, but never retain ${credential}.` }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: credential.repeat(12) }],
        },
      },
    ];
    writeFileSync(transcript, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    capture.enqueue(transcript, "codex-secret", workspace, records.length, "codex");

    const increment = update.nextIncrement(workspace, transcript);

    expect(increment.rendered).not.toContain(credential);
    expect(increment.rendered).toContain(REDACTED);
    expect(increment.nUsers).toBe(1);
    expect(increment.nAssistants).toBe(0); // secret-only material is not useful after screening
  });
});
