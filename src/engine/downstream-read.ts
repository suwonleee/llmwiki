// downstream-read.ts — did an injected pointer actually get OPENED?
//
// `reach` (bench.ts) answers "did a pointer arrive". This answers the next question: within the
// same session, did the model then Read the page that pointer named. It is computed OFFLINE from
// captured transcripts — never on the turn path, never from a live hook — so it keeps bench's
// engine-dev contract: zero per-session cost.
//
// Declared blind spots. They are REPORTED, never folded silently into the rate:
//   • a page read inside a subagent thread (isSidechain) — the pointer went to the main thread
//   • harnesses whose transcript shape this parser does not read yet (Codex, OpenCode)
//   • a Bash command that only greps a DIRECTORY — an open counts only when the command names a
//     concrete `docs/wiki/….md` path (the same rule the Codex observer applies to shell opens)
// And a page can be USED without being opened: a pointer line carries the page TITLE, and a title
// alone often answers the question. So this is a read-through rate, not a value measure — a low
// number is a prompt to look, not a verdict.
//
// Anti-self-pollution is structural, not regex-based. A transcript contains the injected banner
// AND every tool result that ever grepped for it, so matching `docs/wiki/...` anywhere would count
// the observer's own output as an injection. Only records the harness itself wrote as an
// attachment (where hook stdout lands) are read as injections.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { claudeProjectDirs, discoverClaudeRoutes } from "./sources/claude.ts";

export type Channel = "turn_context" | "cold_start";

export interface PointerOccurrence {
  seq: number;
  channel: Channel;
  root: string; // absolute repo root the relative path belongs to ("" when unknowable)
  page: string; // repo-relative, e.g. docs/wiki/5_topic/x.md
}

export interface ReadOccurrence {
  seq: number;
  ts: number; // ms epoch from the record's timestamp; 0 when the record carries none
  root: string;
  page: string;
  via: "read" | "bash"; // which tool opened it — reported separately, matched identically
}

export interface TranscriptScan {
  path: string;
  pointers: PointerOccurrence[];
  reads: ReadOccurrence[];
  malformed: number; // lines that were not JSON — counted, never fatal
}

export interface ChannelStat {
  injected: number;
  matched: number;
  reach: number;
}

export interface DownstreamReadReport {
  transcripts: number;
  injected: number; // pointer OCCURRENCES recognised (a page pointed at twice counts twice)
  matched: number; // occurrences followed by a Read of that same page, later in that session
  pointer_reach: number; // matched / injected
  unique_injected_pages: number;
  unique_matched_pages: number;
  read_events: number; // Read tool calls on wiki pages, main thread only
  bash_open_events: number; // Bash commands naming a concrete wiki page, main thread only
  malformed_lines: number;
  by_channel: Record<Channel, ChannelStat>;
  blind_spots: string[];
}

const WIKI_SEG = "/docs/wiki/";
const TURN_MARK = "[llmwiki turn-context]";
const ANY_MARK = "[llmwiki";

// The banner names its repo (`----- [llmwiki turn-context] ~/repo — …`), but only since the
// version that added it. Older transcripts have no root in the banner and fall back to the
// record's cwd, so historical sessions stay measurable instead of being dropped.
const BANNER_ROOT_RE = /\[llmwiki turn-context\]\s+(\S+)\s+—/;

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return `${homedir()}/${p.slice(2)}`;
  return p;
}

function norm(p: string): string {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
}

// Split an absolute wiki page path into (repo root, repo-relative path). Returns null for a path
// that is not inside a docs/wiki tree, which is how non-wiki Reads are dropped.
export function splitWikiPath(abs: string): { root: string; page: string } | null {
  const p = norm(abs);
  const i = p.lastIndexOf(WIKI_SEG);
  if (i < 0) return null;
  return { root: p.slice(0, i), page: p.slice(i + 1) };
}

// Pointer lines are `  • Title  →  docs/wiki/a/b.md` (the spine variant appends `(10x)`), so the
// path is the first whitespace-delimited token after the arrow. A cold-start L0 body carries
// wikilinks and provenance strings too — neither has an arrow, so neither is counted.
function pointerPathOn(line: string): string | null {
  const i = line.indexOf("→");
  if (i < 0) return null;
  const rest = line.slice(i + 1).trim();
  const tok = rest.split(/\s+/)[0] ?? "";
  return tok.includes("docs/wiki/") && tok.endsWith(".md") ? norm(tok) : null;
}

// Every string the harness stored in an attachment record, in order. Hook stdout lands in
// `attachment.stdout` (cold start) or `attachment.content[]` (per-turn), and the shape has
// changed before — so walk the attachment rather than naming one field.
function attachmentStrings(rec: any, out: string[]): void {
  const seen = new Set<any>();
  const walk = (v: any): void => {
    if (typeof v === "string") {
      out.push(v);
      return;
    }
    if (!v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(rec.attachment);
}

export function pointersIn(rec: any, seq: number): PointerOccurrence[] {
  // Injections are what the HARNESS attached. An assistant message or tool result that merely
  // contains the banner text is the observer looking at itself.
  if (rec?.type !== "attachment") return [];
  const cwd = norm(rec.cwd ?? "");
  const blobs: string[] = [];
  attachmentStrings(rec, blobs);
  const out: PointerOccurrence[] = [];
  for (const blob of blobs) {
    if (!blob.includes(ANY_MARK)) continue;
    let channel: Channel | null = null;
    let root = "";
    for (const line of blob.split("\n")) {
      if (line.includes(ANY_MARK)) {
        // A banner line switches channels: the per-turn block is its own channel, every other
        // llmwiki block in an attachment belongs to the cold start (index, spine, notices).
        if (line.includes(TURN_MARK)) {
          channel = "turn_context";
          const m = BANNER_ROOT_RE.exec(line);
          root = m ? norm(expandHome(m[1]!)) : cwd;
        } else {
          channel = "cold_start";
          root = cwd;
        }
        continue;
      }
      if (!channel) continue;
      const page = pointerPathOn(line);
      if (page) out.push({ seq, channel, root, page });
    }
  }
  return out;
}

// Claude opens wiki pages with Bash too (`cat`, `sed -n`, `grep -n … page.md`) — the same signal
// the Codex observer already counts as a read, with the same rule: only a command that names a
// concrete page counts, a directory grep does not. The command string is the MODEL's own tool_use
// input, never a tool result, so the anti-self-pollution stance is preserved.
const BASH_PAGE_RE = /(?:[A-Za-z]:)?[^\s"'`\\)]*docs\/wiki\/[^\s"'`\\)]+\.md/g;

export function readsIn(rec: any, seq: number): ReadOccurrence[] {
  // A subagent's thread never received the pointer, so its Reads cannot answer it.
  if (rec?.isSidechain === true) return [];
  const content = rec?.message?.content;
  if (!Array.isArray(content)) return [];
  const cwd = norm(rec.cwd ?? "");
  const ts = Date.parse(String(rec?.timestamp ?? "")) || 0;
  const out: ReadOccurrence[] = [];
  for (const c of content) {
    if (c?.type !== "tool_use") continue;
    if (c?.name === "Read") {
      const fp = String(c?.input?.file_path ?? "");
      if (!fp) continue;
      const abs = fp.startsWith("/") || /^[A-Za-z]:/.test(fp) ? fp : `${cwd}/${fp}`;
      const split = splitWikiPath(abs);
      if (split) out.push({ seq, ts, via: "read", ...split });
    } else if (c?.name === "Bash") {
      const cmd = String(c?.input?.command ?? "");
      if (!cmd.includes("docs/wiki/")) continue;
      for (const m of cmd.match(BASH_PAGE_RE) ?? []) {
        const raw = expandHome(norm(m));
        const abs = raw.startsWith("/") || /^[A-Za-z]:/.test(raw) ? raw : `${cwd}/${raw}`;
        const split = splitWikiPath(abs);
        if (split) out.push({ seq, ts, via: "bash", ...split });
      }
    }
  }
  return out;
}

export function scanTranscript(path: string): TranscriptScan {
  const scan: TranscriptScan = { path, pointers: [], reads: [], malformed: 0 };
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return scan; // unreadable (deleted, compressed) → not measurable, not zero
  }
  let seq = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    seq += 1;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      scan.malformed += 1; // one bad line must not end the scan
      continue;
    }
    scan.pointers.push(...pointersIn(rec, seq));
    scan.reads.push(...readsIn(rec, seq));
  }
  return scan;
}

// A pointer is answered by a Read of the SAME page in the SAME clone, strictly LATER in the
// session. Root equality is what stops two repos' identically-named pages from being merged (a
// home wiki and a runtime wiki both have current-state.md, and both get read in the same session).
// An occurrence whose root could not be determined falls back to path-only matching — recorded
// here rather than dropped, because dropping it would silently deflate the denominator.
function matchScan(scan: TranscriptScan, into: Record<Channel, ChannelStat>, pages: { injected: Set<string>; matched: Set<string> }): void {
  const byKey = new Map<string, number[]>();
  for (const r of scan.reads) {
    for (const key of [`${r.root}::${r.page}`, `::${r.page}`]) {
      const arr = byKey.get(key) ?? [];
      arr.push(r.seq);
      byKey.set(key, arr);
    }
  }
  for (const p of scan.pointers) {
    const stat = into[p.channel];
    stat.injected += 1;
    pages.injected.add(`${p.root}::${p.page}`);
    const seqs = byKey.get(p.root ? `${p.root}::${p.page}` : `::${p.page}`) ?? [];
    if (seqs.some((s) => s > p.seq)) {
      stat.matched += 1;
      pages.matched.add(`${p.root}::${p.page}`);
    }
  }
}

// `root` keeps only the pointers that named one clone — the honest way to ask "how is MY repo's
// injection doing" on a machine that serves several wikis from the same sessions.
export function summarizeDownstreamRead(
  scans: readonly TranscriptScan[],
  root = "",
): DownstreamReadReport {
  if (root) {
    const want = norm(resolve(root));
    scans = scans.map((s) => ({ ...s, pointers: s.pointers.filter((p) => p.root === want) }));
  }
  return summarize(scans);
}

function summarize(scans: readonly TranscriptScan[]): DownstreamReadReport {
  const by: Record<Channel, ChannelStat> = {
    turn_context: { injected: 0, matched: 0, reach: 0 },
    cold_start: { injected: 0, matched: 0, reach: 0 },
  };
  const pages = { injected: new Set<string>(), matched: new Set<string>() };
  let reads = 0;
  let bashOpens = 0;
  let malformed = 0;
  for (const s of scans) {
    matchScan(s, by, pages);
    for (const r of s.reads) r.via === "bash" ? (bashOpens += 1) : (reads += 1);
    malformed += s.malformed;
  }
  for (const c of Object.keys(by) as Channel[]) {
    const e = by[c];
    e.reach = e.injected ? e.matched / e.injected : 0;
  }
  const injected = by.turn_context.injected + by.cold_start.injected;
  const matched = by.turn_context.matched + by.cold_start.matched;
  return {
    transcripts: scans.length,
    injected,
    matched,
    pointer_reach: injected ? matched / injected : 0,
    unique_injected_pages: pages.injected.size,
    unique_matched_pages: pages.matched.size,
    read_events: reads,
    bash_open_events: bashOpens,
    malformed_lines: malformed,
    by_channel: by,
    blind_spots: [
      "Bash opens count only when the command names a concrete page (.md) — directory greps don't",
      "subagent (sidechain) reads are not counted — the pointer went to the main thread",
      "Codex and OpenCode transcripts are not parsed yet",
      "a pointer's TITLE can answer a prompt without the page being opened",
    ],
  };
}

/**
 * The transcripts belonging to ONE repository, newest first.
 *
 * Without this, asking "how is my repo's injection doing" scanned the newest N transcripts
 * MACHINE-WIDE and only then filtered the pointers to that repo — so the sample was whatever
 * repository happened to be busiest lately. Measured 2026-08-21 on the largest wiki here: 54 sessions
 * and only 5 of them were inside the newest 30, making a "0.0% (0/18)" headline that described
 * 6% of the repo's history while reading as a verdict on all of it.
 *
 * The repo of a transcript is read from the transcript itself (`discoverClaudeRoutes`, which is
 * byte-capped), not guessed from Claude's encoded directory name — that encoding is the
 * harness's, and a lossy guess here would silently drop sessions rather than fail loudly.
 * Returns [] when the repo has no sessions, which the caller must report as not-measured.
 */
export function claudeTranscriptsForRepo(root: string): string[] {
  const want = norm(resolve(root));
  const out: string[] = [];
  for (const r of discoverClaudeRoutes()) {
    if (!r.repo) continue;
    if (norm(resolve(r.repo)) === want) out.push(resolve(r.path));
  }
  return out;
}

// Claude session transcripts on this machine. Subagent files are excluded for the same reason
// their Reads are: a sidechain never received the injection.
export function discoverClaudeTranscripts(): string[] {
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
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
    }
  };
  for (const proj of claudeProjectDirs()) walk(proj);
  return out.filter((p) => !p.replace(/\\/g, "/").includes("/subagents/"));
}

// Pick the transcripts to scan. Newest first and capped, because this walks whole session files
// and the machine holds hundreds; the cap is reported so a partial scan never reads as a total.
export function pickTranscripts(candidates: readonly string[], limit: number): string[] {
  const stamped = candidates
    .map((p) => {
      try {
        return { p, m: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { p: string; m: number } => x !== null)
    .sort((a, b) => b.m - a.m || a.p.localeCompare(b.p));
  return stamped.slice(0, Math.max(1, limit)).map((x) => resolve(x.p));
}
