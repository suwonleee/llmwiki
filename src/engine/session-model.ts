// Which model the generative passes should use: the one the person is actually working with.
//
// Every warm pass (/wiki-save, /wiki-deep) is already written BY the session's own model — it runs
// inline. Exactly one thing in this engine picks a model on its own: the subprocess the generative
// passes launch (semantic review, and the unattended autoupdate daemon). That pick used to be a
// hardcoded id, which is a small piece of central management inside a project whose whole direction
// is harness independence — and it fails in the worst direction: the string ages, and one day the
// provider retires it, so a pass breaks for a user who changed nothing. (Decision 2026-07-20; the
// hardcoded `claude-opus-4-8` had already gone stale by the time this landed, which is the argument
// making itself.)
//
// So the model is OBSERVED, not declared. Every harness records the model it used, in data llmwiki
// already captures:
//
//   Claude Code   assistant records carry `message.model`            → claude-opus-5
//   Codex         the rollout carries `"model"`                      → gpt-5.6-sol
//   OpenCode      each assistant row carries providerID + modelID    → anthropic/claude-opus-4-7
//
// A model that just produced a session is, by definition, one this machine can reach and this
// person chose — a better answer than any constant we could ship, and it needs no network to learn.
//
// Reading it does NOT depend on where the harness keeps its data: observation goes through the
// capture queue (already repo-scoped) and the engine's resolved data locations, so a nonstandard
// install is handled by the same 3-tier discovery as everything else (engine/harness-locate.ts).
//
// Resolution order: env (LLMWIKI_MODEL_*) > toml [models] > observed session model > harness
// fallback. `null` means "we could not tell" — the caller then drops the `--model` flag entirely
// and lets the harness CLI use its own default, which is the decision's original shape.
import { Database } from "bun:sqlite";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { getSourceKind, transcriptsForRepoReadOnly } from "./capture.ts";
import { llmTemplate } from "./claude.ts";
import { opencodeDbPaths } from "./sources/opencode.ts";
import { openReadonlyDatabase } from "./sqlite-open.ts";

export type Harness = "claude" | "codex" | "opencode";
export type ModelTier = "light" | "heavy";

/**
 * Last resort per harness, used only when nothing was observed (a repo whose first session is
 * still running, a fresh clone). Deliberately a live, mid-tier model rather than the top one: the
 * fallback runs when we know least, and an unknown-cost default should be the modest one.
 * OpenCode is multi-provider, so its own fallback prefers the machine's most recent model over any
 * constant — see observedModel().
 */
export const HARNESS_FALLBACK: Record<Harness, string> = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-luna",
  opencode: "anthropic/claude-sonnet-5",
};

/** Which harness CLI the configured LLMWIKI_LLM_CMD template drives, if we recognize it. */
export function targetHarness(template: readonly string[] | null): Harness | null {
  const bin = template?.[0];
  if (!bin) return null;
  const name = basename(bin).replace(/\.(exe|cmd|sh)$/i, "").toLowerCase();
  if (name === "claude") return "claude";
  if (name === "codex") return "codex";
  if (name === "opencode") return "opencode";
  return null; // `llm`, `ollama`, a wrapper script — we cannot know its model vocabulary
}

// Bounded tail read: the newest records sit at the end, and a transcript can be megabytes.
const TAIL_BYTES = 64 * 1024;

function readSlice(path: string, where: "head" | "tail"): string {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const start = where === "head" ? 0 : Math.max(0, size - TAIL_BYTES);
    const len = Math.min(size, TAIL_BYTES);
    if (len === 0) return "";
    const buf = Buffer.alloc(len);
    fd = openSync(path, "r");
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf-8");
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The repo's captured transcripts for one harness, newest first.
 *
 * The harness comes from the KIND the queue recorded at enqueue time, not from re-probing the
 * path: probing asks "does this sit under a `.claude` profile inside $HOME?", which is a second,
 * weaker copy of the discovery the capture layer already did — and which answers "no" for exactly
 * the nonstandard install locations `llmwiki connect` exists to support.
 */
function transcriptsFor(repo: string, kind: string): string[] {
  let rows: { path: string }[];
  try {
    rows = transcriptsForRepoReadOnly(repo);
  } catch {
    return []; // no capture db yet
  }
  return rows
    .map((r) => r.path)
    .filter((p) => {
      try {
        return getSourceKind(p) === kind;
      } catch {
        return false;
      }
    })
    .map((p) => ({ p, m: mtimeOf(p) }))
    .filter((x) => x.m > 0)
    .sort((a, b) => b.m - a.m)
    .map((x) => x.p);
}

// A model id is the one field we take out of a transcript here — never message content. Both
// harnesses write it as a plain JSON string value, so a bounded regex over one slice is enough and
// avoids parsing (and thus holding) conversation text.
//
// Each harness records the model somewhere different, and reading the wrong place picks a model id
// out of the CONVERSATION instead of the session — a transcript is full of them the moment the
// session reads a config file.
//
//   Claude  — every assistant record carries `message.model`, so the LAST one in the TAIL is the
//             model in force right now (right even when the person switched models mid-session).
//             The `claude-` family prefix keeps an unrelated `"model"` key out.
//   Codex   — the model lives on `turn_context` records, which sit wherever the turn began: on a
//             real rollout the only one was ~97KB in, past any header window. So we look in the
//             tail first (newest turn wins, which also handles a mid-session model switch), then
//             the head, and we require the record TYPE rather than trusting a bare `"model"` key.
const CLAUDE_MODEL_RE = /"model"\s*:\s*"(claude-[A-Za-z0-9._-]+)"/g;

/**
 * The shape a model id may have before it becomes a `--model` argument.
 *
 * Nothing here is shell-parsed (the subprocess is spawned from an argv array), so this is not an
 * injection fix — the work is done by the leading alphanumeric anchor, which keeps a malformed or
 * hostile record from becoming a FLAG-shaped argument, and by the length bound.
 *
 * The character set has to be generous, because being too strict fails in the exact direction
 * this file exists to prevent: a rejected id is silently indistinguishable from "nothing
 * observed", so the pass falls back to a constant — the stale-hardcoded-id failure coming back
 * through another door. `:` is in real ids from more than one ecosystem (Ollama's
 * `llama3.1:8b`, Bedrock's `…-v2:0`), and OpenCode is multi-provider by design, so leaving it
 * out would have quietly downgraded those users.
 */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;

function asModelId(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : "";
  return MODEL_ID_RE.test(s) ? s : null;
}

function pickMatch(text: string, re: RegExp, which: "first" | "last"): string | null {
  let found: string | null = null;
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    found = m[1] ?? found;
    if (which === "first" && found) return found;
  }
  return found;
}

/** The model on a Codex `turn_context` record. Slices may cut lines; unparseable ones are skipped. */
function codexModelIn(text: string, which: "first" | "last"): string | null {
  let found: string | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes("turn_context")) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // truncated at a slice boundary
    }
    if (o?.type !== "turn_context") continue;
    const model = asModelId(o.payload?.model ?? o.model);
    if (model) {
      found = model;
      if (which === "first") return found;
    }
  }
  return found;
}

/** OpenCode's export header carries the DB it came from and the session it belongs to. */
function opencodeExportMeta(path: string): { sourcePath?: string; sessionID?: string } | null {
  const head = readSlice(path, "head"); // the meta is line 1
  const line = head.split("\n").find((l) => l.includes('"opencode-meta"'));
  if (!line) return null;
  try {
    const meta = JSON.parse(line);
    return { sourcePath: meta.sourcePath, sessionID: meta.sessionID };
  } catch {
    return null;
  }
}

/** Newest assistant model in an OpenCode database, optionally scoped to one session. */
function opencodeDbModel(dbPath: string, sessionID?: string): string | null {
  let db: Database | null = null;
  try {
    db = openReadonlyDatabase(dbPath);
    if (db === null) return null;
    // v1 (`message`) is the schema every installed OpenCode actually writes; the event-sourced
    // `session_message` projection is checked second for forward compatibility. Both store the
    // model on the assistant row's JSON, so neither read touches message text.
    const queries = sessionID
      ? [
          ["SELECT data FROM message WHERE session_id = ? ORDER BY id DESC LIMIT 40", [sessionID]],
          ["SELECT data FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 40", [sessionID]],
        ]
      : [
          ["SELECT data FROM message ORDER BY time_created DESC LIMIT 80", []],
          ["SELECT data FROM session_message ORDER BY time_created DESC LIMIT 80", []],
        ];
    for (const [sql, args] of queries as [string, unknown[]][]) {
      let rows: { data: string }[];
      try {
        rows = db.query(sql).all(...(args as [])) as { data: string }[];
      } catch {
        continue; // table absent in this schema generation
      }
      for (const row of rows) {
        try {
          const d = JSON.parse(String(row.data ?? "{}"));
          const info = d.info ?? d; // session_message wraps the message under `info`
          if (info?.role !== "assistant") continue;
          const provider = asModelId(info.providerID);
          const model = asModelId(info.modelID);
          if (model) return provider ? `${provider}/${model}` : model;
        } catch {
          /* skip malformed row */
        }
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * The model this repo's most recent session on `harness` actually ran on, or null.
 *
 * Never throws: a missing capture db, a vanished transcript, or an unreadable OpenCode database
 * all mean "unknown", and the caller falls through to the next layer.
 */
export function observedModel(repo: string, harness: Harness): string | null {
  if (harness === "claude") {
    for (const path of transcriptsFor(repo, "claude-jsonl").slice(0, 5)) {
      // The family prefix already narrows this one, but it carries no length bound — so the
      // same guard runs here too, and "all three paths" is true of the code and not just the
      // sentence describing it.
      const model = asModelId(pickMatch(readSlice(path, "tail"), CLAUDE_MODEL_RE, "last"));
      if (model) return model;
    }
    return null;
  }
  if (harness === "codex") {
    for (const path of transcriptsFor(repo, "codex").slice(0, 5)) {
      const model =
        codexModelIn(readSlice(path, "tail"), "last") ?? codexModelIn(readSlice(path, "head"), "first");
      if (model) return model;
    }
    return null;
  }
  // OpenCode: the queue holds our own export, whose header names the database and session it came
  // from — the model lives there, not in the export body.
  for (const path of transcriptsFor(repo, "opencode").slice(0, 5)) {
    const meta = opencodeExportMeta(path);
    if (!meta?.sourcePath) continue;
    const model = opencodeDbModel(meta.sourcePath, meta.sessionID);
    if (model) return model;
  }
  // Multi-provider harness: "what did this machine last actually run" beats any constant we could
  // ship, and a model that just ran is one that currently works.
  for (const dbPath of opencodeDbPaths()) {
    const model = opencodeDbModel(dbPath);
    if (model) return model;
  }
  return null;
}

/**
 * The model for a generative pass: env > toml > observed session model > harness fallback.
 *
 * Returns null only when the target CLI is not one we recognize AND nothing is pinned — the caller
 * then launches the command with no `--model` flag at all, letting that CLI use its own default.
 */
export function resolveGenerativeModel(opts: {
  repo: string;
  tier: ModelTier;
  pinned?: string | null; // already env>toml resolved (config.models[tier])
  template: readonly string[] | null;
}): string | null {
  if (opts.pinned) return opts.pinned;
  const harness = targetHarness(opts.template);
  if (!harness) return null;
  return observedModel(opts.repo, harness) ?? HARNESS_FALLBACK[harness];
}

/** resolveGenerativeModel against the machine's configured LLM command. The call sites' form. */
export function generativeModel(repo: string, tier: ModelTier, pinned?: string | null): string | null {
  return resolveGenerativeModel({ repo, tier, pinned, template: llmTemplate() });
}
