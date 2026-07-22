import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as capture from "../src/engine/capture.ts";
import * as update from "../src/engine/update.ts";

describe("update-next source routing", () => {
  let dir: string;
  let workspace: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-update-source-"));
    workspace = join(dir, "repo");
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
});
