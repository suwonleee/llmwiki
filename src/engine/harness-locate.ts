// Harness data-location discovery: machine-local overrides + read-only verification.
//
// Discovery is 3-tier by design (2026-07-29):
//   ① deterministic resolution — each source's built-in defaults plus its env override
//      ($OPENCODE_DB, $CODEX_HOME, $CLAUDE_CONFIG_DIR); covers the standard local.
//   ② schema-signature verification — a candidate is judged by what is actually inside it
//      (tables with rows, a projects/ tree, rollout files), never by mere existence.
//   ③ LLM fallback at install time — on a nonstandard local the installing agent searches,
//      proposes a path (`llmwiki locate <harness> <path>`), and the engine persists it
//      (`llmwiki connect <harness> <path>`) ONLY after ② passes. An unverified path is
//      refused, never recorded — same fail-closed contract as enrollment.
//
// Persisted overrides live in <state>/harness-paths.json: machine-local, never committed,
// visible to the CLI, the doctor, and the daemon alike (they share this state root). Env
// vars still win over a persisted path so a shell override remains the strongest word.
import { Database } from "bun:sqlite";
import { chmodSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { effectiveStateRoot, bootstrapStateRoot } from "./state-dir.ts";

/**
 * A persisted location is only ever an absolute path.
 *
 * Both ends of the file are guarded, not just the write: a relative entry that reached the file
 * some other way would be resolved against whatever cwd the reader happens to have — the CLI's,
 * the daemon's — so the same recorded string would name different directories to different
 * processes. Rejecting it on read means a hand-edited or half-written file degrades to "no
 * persisted location" (discovery falls back to env and defaults) instead of to an ambiguous one.
 */
function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && isAbsolute(value);
}

export type Harness = "claude" | "codex" | "opencode";
export const HARNESSES: readonly Harness[] = ["claude", "codex", "opencode"];

interface HarnessPathsFile {
  version: 1;
  opencodeDb?: string;
  codexHome?: string;
  claudeConfigDirs?: string[];
}

function pathsFile(): string {
  return join(effectiveStateRoot(), "harness-paths.json");
}

// The claude adapter asks per transcript during a sweep — cache by mtime so a hot scan
// costs one stat, while a test (or `connect`) that rewrites the file is seen immediately.
let _cache: { path: string; mtimeMs: number; value: HarnessPathsFile } | null = null;

export function readHarnessPaths(): HarnessPathsFile {
  const path = pathsFile();
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { version: 1 };
  }
  if (_cache && _cache.path === path && _cache.mtimeMs === mtimeMs) return _cache.value;
  let value: HarnessPathsFile = { version: 1 };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    if (raw && typeof raw === "object" && raw.version === 1) {
      value = {
        version: 1,
        ...(absolutePath(raw.opencodeDb) ? { opencodeDb: raw.opencodeDb } : {}),
        ...(absolutePath(raw.codexHome) ? { codexHome: raw.codexHome } : {}),
        ...(Array.isArray(raw.claudeConfigDirs)
          ? { claudeConfigDirs: raw.claudeConfigDirs.filter(absolutePath) }
          : {}),
      };
    }
  } catch {
    /* unreadable → behave as absent; locate/doctor surface the file, never a crash */
  }
  _cache = { path, mtimeMs, value };
  return value;
}

export function persistedOpencodeDb(): string | null {
  return readHarnessPaths().opencodeDb?.trim() || null;
}
export function persistedCodexHome(): string | null {
  return readHarnessPaths().codexHome?.trim() || null;
}
export function persistedClaudeDirs(): string[] {
  return (readHarnessPaths().claudeConfigDirs ?? []).map((d) => d.replace(/[\\/]+$/, "")).filter(Boolean);
}

export interface Verdict {
  ok: boolean;
  detail: string; // the evidence line — what the signature check actually saw
}

// ---- ② schema-signature verification (read-only, fail-closed) ----------------------------
//
// How strong a signature has to be depends on what carries it. A SQL schema is unique enough to
// identify a harness on its own: nothing but OpenCode creates a `session` table alongside
// `message`/`session_message`, so an empty-but-well-formed database still IS that harness's store.
// A DIRECTORY NAME carries no such uniqueness — `projects/` and `sessions/` are among the most
// common folder names there are, and the first E2E on a nonstandard local duly verified a plain
// home directory as a Claude profile because it happened to contain `projects/`. So the two
// name-based checks require the data itself (a transcript, a rollout) as their evidence, not the
// folder that would hold it. The cost is that a never-used profile fails verification — correct:
// `connect` exists to reach data that EXISTS, and persisting an empty guess is the false
// confidence this whole tier is here to prevent.
const FILE_SCAN_CAP = 2000;

/** Bounded recursive count of matching files — evidence that data is there, not an inventory. */
function countFiles(root: string, match: (name: string) => boolean): number {
  let n = 0;
  const walk = (dir: string): void => {
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (n >= FILE_SCAN_CAP) return;
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.isFile() && match(e.name)) n += 1;
    }
  };
  walk(root);
  return n;
}

function verifyOpencodeDb(path: string): Verdict {
  let st;
  try {
    st = statSync(path);
  } catch {
    return { ok: false, detail: "path does not exist" };
  }
  if (!st.isFile()) return { ok: false, detail: "not a file (expected a SQLite database)" };
  let db: Database | null = null;
  try {
    db = new Database(path, { readonly: true });
    const tables = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    if (!tables.has("session")) return { ok: false, detail: "no `session` table — not an OpenCode database" };
    const count = (table: string): number =>
      tables.has(table) ? (db!.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n : -1;
    const legacy = count("message");
    const projected = count("session_message");
    if (legacy < 0 && projected < 0)
      return { ok: false, detail: "no `message` or `session_message` table — not an OpenCode database" };
    const show = (n: number) => (n < 0 ? "absent" : String(n));
    return {
      ok: true,
      detail: `session=${count("session")} · legacy message=${show(legacy)} · session_message=${show(projected)}`,
    };
  } catch (e) {
    return { ok: false, detail: `cannot read as SQLite: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    db?.close();
  }
}

function verifyCodexHome(path: string): Verdict {
  let st;
  try {
    st = statSync(path);
  } catch {
    return { ok: false, detail: "path does not exist" };
  }
  if (!st.isDirectory()) return { ok: false, detail: "not a directory (expected $CODEX_HOME)" };
  let entries: string[] = [];
  try {
    entries = readdirSync(path);
  } catch {
    return { ok: false, detail: "directory is not readable" };
  }
  const stateDbs = entries.filter((e) => /^state_.*\.sqlite$/.test(e));
  const rollouts = countFiles(join(path, "sessions"), (name) => name.startsWith("rollout-") && name.includes(".jsonl"));
  if (rollouts === 0 && stateDbs.length === 0)
    return {
      ok: false,
      detail:
        "no rollout-*.jsonl under sessions/ and no state_*.sqlite — no Codex data here " +
        "(a directory merely named sessions/ is not evidence; an unused Codex has nothing to capture yet)",
    };
  return {
    ok: true,
    detail: `${rollouts >= FILE_SCAN_CAP ? `${FILE_SCAN_CAP}+` : rollouts} rollout(s) · ${stateDbs.length} state_*.sqlite`,
  };
}

function verifyClaudeConfigDir(path: string): Verdict {
  let st;
  try {
    st = statSync(path);
  } catch {
    return { ok: false, detail: "path does not exist" };
  }
  if (!st.isDirectory()) return { ok: false, detail: "not a directory (expected a Claude config dir)" };
  const proj = join(path, "projects");
  try {
    if (!statSync(proj).isDirectory())
      return { ok: false, detail: "projects/ is not a directory — not a Claude config dir" };
  } catch {
    return { ok: false, detail: "no projects/ subtree — not a Claude config dir (transcripts live under projects/)" };
  }
  const n = countFiles(proj, (name) => name.endsWith(".jsonl"));
  if (n === 0)
    return {
      ok: false,
      detail:
        "projects/ holds no *.jsonl transcript — no Claude data here " +
        "(any folder can contain a projects/ dir; an unused profile has nothing to capture yet)",
    };
  return { ok: true, detail: `projects/ present · ${n >= FILE_SCAN_CAP ? `${FILE_SCAN_CAP}+` : n} transcript(s)` };
}

export function verifyHarnessPath(harness: Harness, path: string): Verdict {
  switch (harness) {
    case "opencode":
      return verifyOpencodeDb(path);
    case "codex":
      return verifyCodexHome(path);
    case "claude":
      return verifyClaudeConfigDir(path);
  }
}

// ---- ③ persistence — only after ② passes ---------------------------------------------------

function writePathsFile(value: HarnessPathsFile): string {
  bootstrapStateRoot(); // 0700 state root; refuses one llmwiki did not create
  const path = pathsFile();
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600); // `mode` applies to creation only — an existing file keeps its old bits
  _cache = null;
  return path;
}

export function connectHarnessPath(harness: Harness, path: string): Verdict & { saved?: string } {
  if (!absolutePath(path))
    return { ok: false, detail: "not an absolute path — a persisted location must not depend on a cwd" };
  const verdict = verifyHarnessPath(harness, path);
  if (!verdict.ok) return verdict; // fail-closed: an unverified path is never recorded
  const current = readHarnessPaths();
  if (harness === "opencode") current.opencodeDb = path;
  else if (harness === "codex") current.codexHome = path;
  else {
    const dirs = new Set(current.claudeConfigDirs ?? []);
    dirs.add(path.replace(/[\\/]+$/, ""));
    current.claudeConfigDirs = [...dirs].sort();
  }
  return { ...verdict, saved: writePathsFile(current) };
}

export function forgetHarnessPath(harness: Harness): boolean {
  const current = readHarnessPaths();
  const had =
    harness === "opencode" ? current.opencodeDb !== undefined
    : harness === "codex" ? current.codexHome !== undefined
    : (current.claudeConfigDirs?.length ?? 0) > 0;
  if (!had) return false;
  if (harness === "opencode") delete current.opencodeDb;
  else if (harness === "codex") delete current.codexHome;
  else delete current.claudeConfigDirs;
  // Nothing left to say → say nothing. A `{version:1}` husk in the state root reads like a
  // setting someone made, and the state root is a place other code inspects for ownership.
  if (Object.keys(current).length === 1) {
    try {
      unlinkSync(pathsFile());
    } catch {
      /* already gone */
    }
    _cache = null;
  } else writePathsFile(current);
  return true;
}
