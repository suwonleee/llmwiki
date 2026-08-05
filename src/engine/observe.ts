// observe.ts — the emission ledger, and the per-harness read observers that answer it.
//
// downstream-read.ts reconstructs injections by PARSING what a harness happened to persist.
// That only works for Claude, whose transcript stores hook output as attachment records.
// OpenCode's injection is a per-request transform that is never written anywhere, and Codex
// buries it inside a model message — so for two of the three harnesses the injection side of
// "was the pointer opened?" cannot be recovered from their records at all.
//
// The fix is to stop asking the harness. THE ENGINE is the one that emitted the pointers: at
// emission time it knows the session, the channel, and the exact pages. This module records that
// one line into the repo's engine-held state (the same machine-local state the turn path already
// writes its session cache into — never the repository), and the per-harness observers then only
// have to answer the HALF the harness genuinely owns: which wiki pages its tools opened, when.
//
//   emission ledger  (engine truth)   projects/<id>/observe/emissions.jsonl
//   Claude reads     (Read tool)      parsed from ~/.claude*/projects JSONL (downstream-read.ts)
//   Codex reads      (exec calls)     parsed from $CODEX_HOME/sessions rollouts — Codex has no
//                                     file-read tool, the shell IS its reader
//   OpenCode reads   (read tool)      read straight out of opencode.db's part table (read-only)
//
// Everything here is offline bench tooling except recordEmission, which runs on the turn path —
// so it is one appendFileSync behind a try/catch, and a failure means a lost ledger line, never
// a lost turn.
import { appendFileSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { ensureProjectStateDir } from "./project-state.ts";
import { openReadonlyDatabase } from "./sqlite-open.ts";
import { opencodeDbPaths } from "./sources/opencode.ts";
import { codexHome } from "./sources/codex.ts";
import {
  discoverClaudeTranscripts,
  pickTranscripts,
  scanTranscript,
  type Channel,
} from "./downstream-read.ts";

export interface Emission {
  ts: number; // ms epoch, stamped at emission
  session: string; // harness session id, exactly as the hook/plugin handed it over
  channel: Channel;
  root: string; // wiki root the pointers are relative to
  pages: string[]; // repo-relative docs/wiki paths
}

export interface LedgerRead {
  ts: number;
  session: string;
  root: string; // clone the opened file belongs to ("" when the record could not say)
  page: string;
  harness: "claude" | "codex" | "opencode";
}

export interface LedgerChannelStat {
  injected: number;
  matched: number;
  reach: number;
}

export interface LedgerReport {
  emissions: number; // ledger lines considered
  sessions: number; // distinct sessions in the ledger
  injected: number; // pointer occurrences across all emissions
  matched: number;
  pointer_reach: number;
  by_channel: Record<Channel, LedgerChannelStat>;
  matched_by_harness: Record<string, number>; // which observer answered ("claude"|"codex"|"opencode")
}

const LEDGER_NAME = "emissions.jsonl";
// One rotation, size-capped: pointer turns are rare and a line is ~200 bytes, so this is years
// of headroom — the cap exists so a pathological loop cannot grow state without bound.
export const LEDGER_MAX_BYTES = 4 * 1024 * 1024;

const PAGE_RE = /→\s+(docs\/wiki\/[^\s"'`\\]+\.md)/g;

// ---- writing (the one turn-path function) -----------------------------------------------

/**
 * Record "these pointers were just emitted for this session". Called by the context and
 * turn-context CLI paths right after they produce non-empty output. Absolutely no-throw:
 * the ledger is observability, the turn is the product.
 */
export function recordEmission(
  root: string,
  session: string,
  channel: Channel,
  emittedText: string,
  maxBytes = LEDGER_MAX_BYTES,
): void {
  try {
    if (!session.trim()) return; // unmatchable — a session-less line is noise, not data
    const pages = [...emittedText.matchAll(PAGE_RE)].map((m) => m[1]!);
    if (!pages.length) return;
    const dir = ensureProjectStateDir(root, "observe");
    const file = join(dir, LEDGER_NAME);
    try {
      if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
    } catch {
      /* first write */
    }
    const line = JSON.stringify({
      ts: Date.now(),
      session: session.trim(),
      channel,
      root: resolve(root).replace(/\\/g, "/"),
      pages,
    });
    appendFileSync(file, line + "\n");
  } catch {
    /* never surface into the session */
  }
}

// ---- reading the ledger -------------------------------------------------------------------

export function readEmissionsFor(root: string): Emission[] {
  const out: Emission[] = [];
  let dir: string;
  try {
    dir = ensureProjectStateDir(root, "observe");
  } catch {
    return out;
  }
  for (const name of [`${LEDGER_NAME}.1`, LEDGER_NAME]) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (
          typeof e?.ts === "number" &&
          typeof e?.session === "string" &&
          (e?.channel === "turn_context" || e?.channel === "cold_start") &&
          Array.isArray(e?.pages)
        ) {
          out.push({
            ts: e.ts,
            session: e.session,
            channel: e.channel,
            root: String(e.root ?? ""),
            pages: e.pages.filter((p: unknown) => typeof p === "string"),
          });
        }
      } catch {
        /* one bad line is not a broken ledger */
      }
    }
  }
  return out;
}

// ---- OpenCode observer ----------------------------------------------------------------------
//
// OpenCode persists every tool part in opencode.db (part.data → {"type":"tool","tool":"read",
// "state":{"input":{"filePath":…}}}). The DB is opened read-only, the same discipline as the
// capture adapter; schema churn degrades to "no reads", never to a crash.

export function scanOpenCodeReads(dbPath?: string): LedgerRead[] {
  const out: LedgerRead[] = [];
  const paths = dbPath ? [dbPath] : opencodeDbPaths();
  for (const p of paths) {
    let db: Database | null = null;
    try {
      db = openReadonlyDatabase(p);
      if (!db) continue;
      const rows = db
        .query(
          "SELECT session_id AS s, time_created AS t, data AS d FROM part WHERE data LIKE '%docs/wiki/%' AND data LIKE '%\"tool\"%'",
        )
        .all() as { s: string; t: number; d: string }[];
      for (const row of rows) {
        try {
          const part = JSON.parse(row.d);
          if (part?.type !== "tool" || part?.tool !== "read") continue;
          const fp = String(part?.state?.input?.filePath ?? "");
          const split = splitWiki(fp);
          if (!split) continue;
          out.push({ ts: Number(row.t) || 0, session: String(row.s), harness: "opencode", ...split });
        } catch {
          /* skip unparsable part */
        }
      }
    } catch {
      /* schema drift / locked DB → nothing to report from this path */
    } finally {
      try {
        db?.close();
      } catch {
        /* already closed */
      }
    }
  }
  return out;
}

// ---- Codex observer ---------------------------------------------------------------------------
//
// Codex has no file-read tool: the model opens files with shell commands (`sed -n … docs/wiki/…`,
// `cat …`), recorded as custom_tool_call / function_call / local_shell_call response items. So
// FOR CODEX a shell open is the read signal, not a blind spot. Relative paths resolve against the
// session_meta cwd. `.zst`-compressed rollouts are skipped (declared, not silently zero).

const CODEX_CALL_TYPES = new Set(["custom_tool_call", "function_call", "local_shell_call"]);
const CODEX_PATH_RE = /(?:[A-Za-z]:)?[^\s"'`\\]*docs\/wiki\/[^\s"'`\\]+\.md/g;

export function discoverCodexRollouts(rootDir?: string): string[] {
  const base = rootDir ?? join(codexHome(), "sessions");
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(base);
  return out;
}

export function scanCodexReads(files: readonly string[]): LedgerRead[] {
  const out: LedgerRead[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    let session = "";
    let cwd = "";
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const payload = rec?.payload ?? {};
      if (rec?.type === "session_meta") {
        session = String(payload.id ?? payload.session_id ?? "");
        cwd = String(payload.cwd ?? "").replace(/\\/g, "/");
        continue;
      }
      if (rec?.type !== "response_item" || !CODEX_CALL_TYPES.has(String(payload.type ?? ""))) continue;
      // The command lives in `input` (custom_tool_call) or `arguments` (function_call) as a
      // string, or as an argv array — serializing the payload once covers every spelling.
      const blob = JSON.stringify(payload.input ?? payload.arguments ?? payload.action ?? payload);
      const ts = Date.parse(String(rec.timestamp ?? "")) || 0;
      for (const m of blob.match(CODEX_PATH_RE) ?? []) {
        const raw = m.replace(/\\/g, "/");
        const abs = raw.startsWith("/") || /^[A-Za-z]:/.test(raw) ? raw : cwd ? `${cwd}/${raw}` : raw;
        const split = splitWiki(abs);
        if (split && session) out.push({ ts, session, harness: "codex", ...split });
      }
    }
  }
  return out;
}

// ---- Claude observer -----------------------------------------------------------------------
//
// Claude's reads are already extracted by downstream-read.ts; this just re-keys them into the
// ledger's shape (session id = transcript filename stem) so all three harnesses answer the same
// emission ledger with the same record type.

export function claudeLedgerReads(limit = 30): LedgerRead[] {
  const out: LedgerRead[] = [];
  for (const f of pickTranscripts(discoverClaudeTranscripts(), limit)) {
    const session = basename(f).replace(/\.jsonl$/, "");
    for (const r of scanTranscript(f).reads) {
      out.push({ ts: r.ts, session, root: r.root, page: r.page, harness: "claude" });
    }
  }
  return out;
}

// ---- matching -----------------------------------------------------------------------------

function splitWiki(abs: string): { root: string; page: string } | null {
  const p = abs.replace(/\\/g, "/");
  const i = p.lastIndexOf("/docs/wiki/");
  if (i < 0) return p.startsWith("docs/wiki/") && p.endsWith(".md") ? { root: "", page: p } : null;
  return p.endsWith(".md") ? { root: p.slice(0, i), page: p.slice(i + 1) } : null;
}

/**
 * Answer each ledger emission with the harness reads. Same-session + same page + strictly later.
 * Root must agree when both sides know it; a read whose clone could not be determined matches by
 * path alone (recorded, not dropped — dropping would deflate honestly-earned matches).
 */
export function matchEmissions(emissions: readonly Emission[], reads: readonly LedgerRead[]): LedgerReport {
  const by: Record<Channel, LedgerChannelStat> = {
    turn_context: { injected: 0, matched: 0, reach: 0 },
    cold_start: { injected: 0, matched: 0, reach: 0 },
  };
  const matchedByHarness: Record<string, number> = {};
  const bySession = new Map<string, LedgerRead[]>();
  for (const r of reads) {
    const arr = bySession.get(r.session) ?? [];
    arr.push(r);
    bySession.set(r.session, arr);
  }
  const sessions = new Set<string>();
  let injected = 0;
  let matched = 0;
  for (const e of emissions) {
    sessions.add(e.session);
    const candidates = bySession.get(e.session) ?? [];
    for (const page of e.pages) {
      by[e.channel].injected += 1;
      injected += 1;
      const hit = candidates.find(
        (r) => r.page === page && r.ts >= e.ts && (!r.root || !e.root || r.root === e.root),
      );
      if (hit) {
        by[e.channel].matched += 1;
        matched += 1;
        matchedByHarness[hit.harness] = (matchedByHarness[hit.harness] ?? 0) + 1;
      }
    }
  }
  for (const c of Object.keys(by) as Channel[]) {
    const e = by[c];
    e.reach = e.injected ? e.matched / e.injected : 0;
  }
  return {
    emissions: emissions.length,
    sessions: sessions.size,
    injected,
    matched,
    pointer_reach: injected ? matched / injected : 0,
    by_channel: by,
    matched_by_harness: matchedByHarness,
  };
}
