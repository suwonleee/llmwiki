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
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveStateRoot, bootstrapStateRoot } from "./state-dir.ts";

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
        ...(typeof raw.opencodeDb === "string" ? { opencodeDb: raw.opencodeDb } : {}),
        ...(typeof raw.codexHome === "string" ? { codexHome: raw.codexHome } : {}),
        ...(Array.isArray(raw.claudeConfigDirs)
          ? { claudeConfigDirs: raw.claudeConfigDirs.filter((d: unknown) => typeof d === "string") }
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
  const hasSessions = (() => {
    try {
      return statSync(join(path, "sessions")).isDirectory();
    } catch {
      return false;
    }
  })();
  const stateDbs = entries.filter((e) => /^state_.*\.sqlite$/.test(e));
  if (!hasSessions && stateDbs.length === 0)
    return {
      ok: false,
      detail: "no sessions/ dir and no state_*.sqlite — not a Codex home (note: a never-used Codex creates sessions/ on the first message)",
    };
  return {
    ok: true,
    detail: `${hasSessions ? "sessions/ present" : "sessions/ absent"} · ${stateDbs.length} state_*.sqlite`,
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
  // Bounded transcript count: evidence, not an inventory.
  let n = 0;
  const CAP = 2000;
  const walk = (dir: string): void => {
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      if (n >= CAP) return;
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.isFile() && e.name.endsWith(".jsonl")) n += 1;
    }
  };
  walk(proj);
  return { ok: true, detail: `projects/ present · ${n >= CAP ? `${CAP}+` : n} transcript(s)` };
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
  _cache = null;
  return path;
}

export function connectHarnessPath(harness: Harness, path: string): Verdict & { saved?: string } {
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
  writePathsFile(current);
  return true;
}
