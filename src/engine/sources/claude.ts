// Claude Code transcript adapter (kind="claude-jsonl").
//
// Owns every Claude-specific bit that used to be inlined in daemon/watch.ts and
// engine/extract.ts: where transcripts live (~/.claude*/projects/**/*.jsonl) and how to
// read their meta. parse() delegates to extractIncrement (the canonical Claude jsonl
// parser), so the daemon's default behavior stays byte-identical to before the refactor.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DiscoveredRoute, DiscoveredSession, ParseOpts, TranscriptSource } from "../source.ts";
import { countLines, discoverViaRoutes, scanIdentity, type IdentitySpec } from "./routing.ts";
import { extractIncrement, type Increment } from "../extract.ts";

// Respect an explicitly isolated HOME (fresh-install tests, containers, CI). On macOS
// os.homedir() can resolve the account database home even when HOME was overridden,
// which made a disposable setup test discover and rewrite the real user profile.
// Read LAZILY: a module-level snapshot ignores a HOME set after import, so an isolated test (or
// a container that exports HOME late) silently scanned the real profile instead of the fixture.
function home(): string {
  return process.env.HOME?.trim() || homedir();
}

// Every Claude config dir: ~/.claude* plus an explicit $CLAUDE_CONFIG_DIR override
// (which may live outside $HOME or not match the .claude* naming). Without the env
// check, such a setup was misread as "no Claude here" — wire skipped the hooks
// silently and capture discovered no transcripts. Shared by wire.ts and doctor.ts.
export function claudeConfigDirs(root: string = home()): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  const candidates = entries.filter((d) => d.startsWith(".claude")).map((d) => join(root, d));
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim().replace(/[\\/]+$/, "");
  if (cfg) candidates.push(cfg.startsWith("~/") ? join(root, cfg.slice(2)) : cfg);
  const out: string[] = [];
  for (const p of candidates) {
    if (out.includes(p)) continue;
    try {
      if (statSync(p).isDirectory()) out.push(p);
    } catch {
      /* skip */
    }
  }
  return out.sort();
}

// Every Claude profile dir (~/.claude, ~/.claude-foo, $CLAUDE_CONFIG_DIR) that has a projects/ subtree.
export function claudeProjectDirs(): string[] {
  const dirs: string[] = [];
  for (const cfg of claudeConfigDirs()) {
    const proj = join(cfg, "projects");
    try {
      if (statSync(proj).isDirectory()) dirs.push(proj);
    } catch {
      /* skip */
    }
  }
  return dirs;
}

function walkJsonl(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
}

function scanTranscripts(): string[] {
  const found: string[] = [];
  for (const proj of claudeProjectDirs()) walkJsonl(proj, found);
  // subagent transcripts are not standalone sessions → never condensed on their own.
  // Normalize separators so the match holds on Windows (backslash) paths too.
  return found.filter((p) => !p.replace(/\\/g, "/").includes("/subagents/"));
}

// ---- stage 1: routing metadata, under a hard budget -------------------------------------
//
// This runs over EVERY Claude transcript on the machine, including sessions from repositories
// the user never enrolled. It may therefore learn only two things — which repository, which
// session — and it must stop reading the moment it knows them. The caps are absolute: at most
// ROUTE_MAX_BYTES from the head of the file, at most ROUTE_MAX_RECORDS complete JSON records
// scanned out of that slice. Raw bytes stay bounded; message values are never decoded, parsed,
// retained, logged, or counted here.
// If the repository is not identifiable inside both budgets, the session is skipped (fail
// closed) rather than read further.
// Claude writes routing identity at the top level of a record; the body lives under `message`
// (and friends), which the shared scanner walks past without interpreting.
const CLAUDE_IDENTITY: IdentitySpec = {
  cwd: ["cwd"],
  session: ["sessionId", "session_id"],
};

function routeMeta(path: string): { cwd: string | null; session: string | null } {
  return scanIdentity(path, CLAUDE_IDENTITY);
}

// Cheap meta read (cwd, sessionId, line count) used by probe() on an explicit path.
function parseMeta(path: string): { cwd: string | null; session: string | null; lines: number } {
  let cwd: string | null = null;
  let session: string | null = null;
  let n = 0;
  try {
    const text = readFileSync(path, "utf-8");
    for (const line of text.split("\n")) {
      if (line === "") continue;
      n += 1;
      if (cwd && session) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      cwd = cwd || o.cwd || null;
      session = session || o.sessionId || o.session_id || null;
    }
  } catch {
    return { cwd, session, lines: n };
  }
  return { cwd, session, lines: n };
}

// A path is a Claude transcript iff it sits under ~/.claude*/projects/** (or
// $CLAUDE_CONFIG_DIR/projects/**) as a .jsonl and is not a subagent transcript. This keeps
// probe() from greedily claiming arbitrary .jsonl files (the design's "claude.probe must
// reject non-~/.claude").
function isClaudeTranscript(path: string): boolean {
  if (!path.endsWith(".jsonl")) return false;
  // Normalize separators so these checks hold on Windows, where os.homedir()/path.join
  // yield backslash paths (e.g. C:\Users\me\.claude\projects\…): the forward-slash literals
  // and the regex below would otherwise never match and capture would find nothing.
  const p = path.replace(/\\/g, "/");
  const homeDir = home().replace(/\\/g, "/");
  if (p.includes("/subagents/")) return false;
  if ((p.startsWith(homeDir + "/") || p === homeDir) && /\/\.claude[^/]*\/projects\//.test(p)) return true;
  // Explicit config dir: accept <cfg>/projects/** wherever cfg lives (may be outside $HOME).
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim().replace(/[\\/]+$/, "");
  if (cfg) {
    const cfgN = (cfg.startsWith("~/") ? join(home(), cfg.slice(2)) : cfg).replace(/\\/g, "/");
    if (p.startsWith(cfgN + "/projects/")) return true;
  }
  return false;
}

// ---- recap: reuse what Claude Code already wrote (P0 "yesterday bridge") -----------------
// CC appends meta records to the session jsonl: {"type":"ai-title","aiTitle":…} (auto title)
// and {"type":"last-prompt","lastPrompt":…} (latest prompt preview). Reading those beats
// re-deriving a summary — deterministic, 0 LLM. Bounded I/O: head 16KB + tail 64KB only,
// so a 5MB transcript costs the same as a tiny one.
const RECAP_HEAD_BYTES = 16 * 1024;
const RECAP_TAIL_BYTES = 64 * 1024;
const RECAP_MAX_CHARS = 72;

function readSlice(path: string, start: number, len: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, start);
    return buf.toString("utf-8", 0, n);
  } finally {
    closeSync(fd);
  }
}

function cleanRecap(s: string): string | null {
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > RECAP_MAX_CHARS ? `${t.slice(0, RECAP_MAX_CHARS - 1)}…` : t;
}

// Whole lines only: drop the partial first line of a tail slice / partial last line of a head
// slice so JSON.parse never sees a cut record.
function recapScan(lines: string[]): { aiTitle?: string; lastPrompt?: string; firstUser?: string } {
  const out: { aiTitle?: string; lastPrompt?: string; firstUser?: string } = {};
  for (const line of lines) {
    if (line === "") continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "ai-title" && typeof o.aiTitle === "string") out.aiTitle = o.aiTitle;
    else if (o.type === "last-prompt" && typeof o.lastPrompt === "string")
      out.lastPrompt = o.lastPrompt; // keep LAST occurrence (latest prompt)
    else if (!out.firstUser && o.type === "user") {
      const c = o.message?.content;
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.find((p: any) => p?.type === "text")?.text
            : null;
      // skip harness-injected pseudo-user lines (hook output, system reminders)
      if (typeof text === "string" && !/^<|^\[/.test(text.trim())) out.firstUser = text;
    }
  }
  return out;
}

// ---- summaryFor: reuse a summary Claude Code already generated (P2) ----------------------
// Two harness artifacts, in preference order:
//   1. {projectDir}/{sessionId}/session-memory/summary.md — background-written structured
//      summary. Feature-gated (often absent) → existence guard, never assumed.
//   2. inline /compact summary — a user record flagged isCompactSummary:true in the jsonl
//      (tail-scanned; the LAST one is the latest compaction).
const SUMMARY_MAX_CHARS = 4000;

function summaryFor(path: string): string | null {
  try {
    // (1) session-memory/summary.md sibling dir named after the session id
    const base = path.slice(0, -".jsonl".length);
    const smPath = join(base, "session-memory", "summary.md");
    try {
      const text = readFileSync(smPath, "utf-8").trim();
      if (text) return text.length > SUMMARY_MAX_CHARS ? text.slice(0, SUMMARY_MAX_CHARS) : text;
    } catch {
      /* gate off / not written — fall through to compact scan */
    }
    // (2) latest inline compact summary from the tail
    const size = statSync(path).size;
    if (size === 0) return null;
    const start = Math.max(0, size - RECAP_TAIL_BYTES);
    const lines = readSlice(path, start, size - start).split("\n");
    if (start > 0) lines.shift();
    let latest: string | null = null;
    for (const line of lines) {
      if (!line.includes('"isCompactSummary":true')) continue;
      try {
        const o: any = JSON.parse(line);
        if (o.type !== "user" || o.isCompactSummary !== true) continue;
        const c = o.message?.content;
        const text =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c.find((p: any) => p?.type === "text")?.text
              : null;
        if (typeof text === "string" && text.trim()) latest = text.trim();
      } catch {
        continue;
      }
    }
    if (!latest) return null;
    return latest.length > SUMMARY_MAX_CHARS ? latest.slice(0, SUMMARY_MAX_CHARS) : latest;
  } catch {
    return null; // summary is opportunistic — absence must never break the condense flow
  }
}

function recapFor(path: string): string | null {
  try {
    const size = statSync(path).size;
    if (size === 0) return null;
    // head: first whole lines (ai-title often lands early; first user utterance fallback)
    const headLines = readSlice(path, 0, Math.min(RECAP_HEAD_BYTES, size)).split("\n");
    if (size > RECAP_HEAD_BYTES) headLines.pop(); // drop cut last line
    const head = recapScan(headLines);
    // tail: latest whole lines (last-prompt / late ai-title win)
    let tail: ReturnType<typeof recapScan> = {};
    if (size > RECAP_HEAD_BYTES) {
      const start = Math.max(0, size - RECAP_TAIL_BYTES);
      const tailLines = readSlice(path, start, size - start).split("\n");
      if (start > 0) tailLines.shift(); // drop cut first line
      tail = recapScan(tailLines);
    }
    const pick = tail.aiTitle ?? head.aiTitle ?? tail.lastPrompt ?? head.lastPrompt ?? head.firstUser;
    return pick ? cleanRecap(pick) : null;
  } catch {
    return null; // recap must never break cold-start
  }
}

/**
 * How long Claude Code keeps a transcript before deleting it.
 *
 * Claude Code's own cleanup pass removes `projects/**\/*.jsonl` older than
 * `settings.cleanupPeriodDays` (default 30). That number is the real deadline on this machine's
 * capture backlog: a session not condensed before it passes is gone, because the transcript — not
 * the queue row — is the evidence. Assuming 30 is wrong for anyone who tuned it, in either
 * direction, so read it.
 *
 * Returns the SHORTEST period across installed profiles (the first deadline that bites), or the
 * documented default when no profile sets one.
 */
export const CLAUDE_DEFAULT_RETENTION_DAYS = 30;

export function claudeRetentionDays(): { days: number; configured: boolean } {
  let shortest: number | null = null;
  for (const dir of claudeConfigDirs()) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, "settings.json"), "utf-8");
    } catch {
      continue;
    }
    let value: unknown;
    try {
      value = (JSON.parse(raw) as Record<string, unknown>)?.cleanupPeriodDays;
    } catch {
      continue; // a settings file we cannot parse is not a retention claim
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    shortest = shortest === null ? value : Math.min(shortest, value);
  }
  return shortest === null
    ? { days: CLAUDE_DEFAULT_RETENTION_DAYS, configured: false }
    : { days: shortest, configured: true };
}

export const claudeJsonlSource: TranscriptSource = {
  kind: "claude-jsonl",
  recapFor,
  summaryFor,

  discoverRoutes(): DiscoveredRoute[] {
    const out: DiscoveredRoute[] = [];
    for (const path of scanTranscripts()) {
      const { cwd, session } = routeMeta(path);
      out.push({ path, sessionId: session, repo: cwd });
    }
    return out;
  },

  materialize(route: DiscoveredRoute): DiscoveredSession | null {
    if (!route.repo) return null;
    return { path: route.path, sessionId: route.sessionId, repo: route.repo, lines: countLines(route.path) };
  },

  routeFor(path: string): DiscoveredRoute | null {
    if (!isClaudeTranscript(path)) return null;
    const { cwd, session } = routeMeta(path);
    return { path, sessionId: session, repo: cwd };
  },

  discover(): DiscoveredSession[] {
    return discoverViaRoutes(claudeJsonlSource);
  },

  probe(path: string): DiscoveredSession | null {
    if (!isClaudeTranscript(path)) return null;
    const { cwd, session, lines } = parseMeta(path);
    return { path, sessionId: session, repo: cwd, lines };
  },

  parse(path: string, startOffset: number, opts?: ParseOpts): Increment {
    return extractIncrement(path, startOffset, opts?.minChars ?? 180, opts?.cap ?? 700);
  },

  watchRoots(): string[] {
    return claudeProjectDirs();
  },
};
