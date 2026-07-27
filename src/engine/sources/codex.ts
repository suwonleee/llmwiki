// Codex CLI transcript adapter (kind="codex") — proves the TranscriptSource interface
// generalizes to a second harness with ZERO changes to the watermark / queue / condense
// core. Codex (OpenAI) writes session rollouts as JSONL under
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, with a more nested shape than Claude's
// (response items wrap a `payload.message`, content parts are input_text/output_text).
//
// The parser is deliberately tolerant of Codex version drift: it pulls a role + text out of
// whatever nesting a line uses and otherwise skips. Discovery mirrors the claude adapter.
//
// NOTE: validated against the research-confirmed Codex rollout schema (openai/codex Rust
// source) and exercised via a virtual run over realistic fixtures of BOTH on-disk formats —
// the current `{timestamp,type,payload}` envelope and the legacy bare-record format. The
// modern Codex keeps a SQLite thread index (~/.codex/state_*.sqlite) whose `rollout_path`
// still points at the jsonl rollouts this adapter reads; sessions/ is created lazily on the
// first user message, so a freshly-installed (unused) Codex has no sessions/ dir yet.
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { DiscoveredRoute, DiscoveredSession, ParseOpts, TranscriptSource } from "../source.ts";
import { countLines, discoverViaRoutes, scanIdentity, type IdentitySpec } from "./routing.ts";
import { readTail, type Increment, type Turn } from "../extract.ts";
import { canonicalWorktree } from "../enrollment.ts";

// Codex honors $CODEX_HOME (falling back to ~/.codex) for its state dir — mirror that so a
// user who relocates CODEX_HOME is still captured. (openai/codex utils/home-dir.)
//
// Read LAZILY, like summaryFor already did: a module-level snapshot silently ignores an
// environment set after import, which in practice meant a test pointed at a fixture still
// scanned the real ~/.codex.
function home(): string {
  return process.env.HOME?.trim() || homedir();
}
function codexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(home(), ".codex");
}
function sessionsRoot(): string {
  return join(codexHome(), "sessions");
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
    // Codex compresses cold rollouts to .jsonl.zst (rollout/src/compression.rs) — both
    // spellings are live sessions; missing the .zst ones silently drops old sessions.
    else if (e.isFile() && (e.name.endsWith(".jsonl") || e.name.endsWith(".jsonl.zst")))
      out.push(full);
  }
}

// Modern Codex records thread identity separately from the rollout body. That index is the only
// privacy-preserving way to route a rollout that Codex compressed before llmwiki's first sweep:
// reading a .zst header requires decompressing the whole conversation. Query exactly the three
// identity columns needed for routing, and accept only real compressed files below sessions/.
function stateDbPaths(): string[] {
  let names: string[];
  try {
    names = readdirSync(codexHome());
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (!/^state_[A-Za-z0-9_.-]+\.sqlite$/.test(name)) continue;
    const path = join(codexHome(), name);
    try {
      const st = lstatSync(path);
      if (st.isFile() && !st.isSymbolicLink()) out.push(realpathSync(path));
    } catch {
      /* raced with Codex cleanup */
    }
  }
  return out;
}

function indexedCompressedRoutes(): DiscoveredRoute[] {
  const byPath = new Map<string, DiscoveredRoute>();
  for (const dbPath of stateDbPaths()) {
    let db: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const rows = db.query("SELECT id, rollout_path, cwd FROM threads").all() as {
        id: unknown;
        rollout_path: unknown;
        cwd: unknown;
      }[];
      for (const row of rows) {
        if (typeof row.rollout_path !== "string") continue;
        const candidate = resolveRolloutPath(row.rollout_path);
        if (!candidate.endsWith(".jsonl.zst")) continue;
        let path: string;
        try {
          const st = lstatSync(candidate);
          if (!st.isFile() || st.isSymbolicLink()) continue;
          path = realpathSync(candidate);
        } catch {
          continue;
        }
        if (!isCodexTranscript(path)) continue;
        const sessionId = typeof row.id === "string" && row.id ? row.id : null;
        const repo = typeof row.cwd === "string" && row.cwd ? row.cwd : null;
        if (!sessionId || !repo) continue;
        let logicalPath: string;
        try {
          const rel = relative(realpathSync(sessionsRoot()), path);
          if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) continue;
          logicalPath = join(sessionsRoot(), rel).slice(0, -".zst".length);
        } catch {
          continue;
        }
        // Queue identity must survive Codex's in-place `foo.jsonl` → `foo.jsonl.zst` rotation.
        // Existing rows use the lexical path beneath the configured CODEX_HOME, even when that
        // root is a symlink. Rebuild that same logical path from the validated real file.
        byPath.set(path, { path: logicalPath, sessionId, repo, sourcePath: path, changePath: path });
      }
    } catch {
      /* schema drift or a transient lock: the next sweep retries */
    } finally {
      db?.close();
    }
  }
  return [...byPath.values()];
}

// ---- zstd-transparent reading -------------------------------------------------------
// Cold rollouts get compressed in place (foo.jsonl → foo.jsonl.zst). Two consequences:
// (a) discovery/parse must decompress .zst; (b) a row queued as foo.jsonl may now exist
// only as foo.jsonl.zst — resolve to the sibling instead of dropping the session.
// Decompression is feature-detected (Bun.zstdDecompressSync, then node:zlib) so an old
// runtime degrades to "skip compressed files" rather than crashing.
function zstdDecompress(buf: Buffer): Buffer | null {
  try {
    const b: any = globalThis.Bun;
    if (typeof b?.zstdDecompressSync === "function") return Buffer.from(b.zstdDecompressSync(buf));
  } catch {
    /* fall through */
  }
  try {
    // node:zlib gained zstd in newer runtimes; require lazily so older ones stay clean.
    const zlib = require("node:zlib");
    if (typeof zlib.zstdDecompressSync === "function") return zlib.zstdDecompressSync(buf);
  } catch {
    /* unavailable */
  }
  return null;
}

// A queued path may have been compressed after enqueue — return the path that exists now.
export function resolveRolloutPath(path: string): string {
  if (existsSync(path)) return path;
  if (!path.endsWith(".zst") && existsSync(`${path}.zst`)) return `${path}.zst`;
  return path;
}

// Full decompressed content of a rollout, or null when unreadable/undecompressable.
function readRollout(path: string): Buffer | null {
  const real = resolveRolloutPath(path);
  try {
    const raw = readFileSync(real);
    if (!real.endsWith(".zst")) return raw;
    return zstdDecompress(raw);
  } catch {
    return null;
  }
}

// Pull (cwd, sessionId, role, text) out of one parsed rollout line, tolerating Codex's
// response_item/payload nesting and the flatter message shape alike.
function fields(o: any): { cwd: string | null; session: string | null; role: string | null; text: string } {
  const cwd =
    o.cwd || o.payload?.cwd || o.git?.repository_path || o.payload?.git?.repository_path || null;
  const session = o.id || o.session_id || o.payload?.id || o.payload?.session_id || null;

  // role and content can live at different depths across Codex versions — look each up
  // independently rather than committing to one "message" object.
  const role =
    o.payload?.role ||
    o.message?.role ||
    o.role ||
    (o.type === "user" || o.type === "assistant" ? o.type : null) ||
    null;
  const content = o.payload?.content ?? o.message?.content ?? o.content;

  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const p of content) {
      if (p && typeof p === "object" && typeof p.text === "string") text += p.text; // input_text/output_text/text
    }
  }
  return { cwd, session, role, text };
}

// Routing has a stricter data boundary than parsing. Do not reuse `fields()` here: that helper
// intentionally walks message content and assembles text for an enrolled/explicit parse, while
// stage 1 is allowed to inspect identity fields only.
// Stage-1 routing under the same hard budget as the Claude adapter: at most ROUTE_MAX_BYTES from
// the head, at most ROUTE_MAX_RECORDS complete records, cwd/session only, stop as soon as both
// are known. Codex puts identity in a `session_meta` record at the very top of a rollout, so this
// almost always resolves within the first record.
// Codex identity, declared for the shared scanner so that stage-1 never
// decodes a rollout's body. The previous implementation JSON.parsed each bounded record, which
// materialized message text for repositories the user had not enrolled — the Claude adapter
// already refused to. One scanner now gives both adapters the identical guarantee.
const CODEX_IDENTITY: IdentitySpec = {
  cwd: ["cwd", "payload.cwd", "git.repository_path", "payload.git.repository_path"],
  session: ["id", "session_id", "payload.id", "payload.session_id"],
};

function routeMeta(path: string): { cwd: string | null; session: string | null } {
  return scanIdentity(path, CODEX_IDENTITY);
}

function probeMeta(path: string): { cwd: string | null; session: string | null; lines: number } {
  let cwd: string | null = null;
  let session: string | null = null;
  let n = 0;
  try {
    const content = readRollout(path);
    if (!content) return { cwd, session, lines: n };
    for (const line of content.toString("utf-8").split("\n")) {
      if (line === "") continue;
      n += 1;
      if (cwd && session) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const f = fields(o);
      cwd = cwd || f.cwd;
      session = session || f.session;
    }
  } catch {
    return { cwd, session, lines: n };
  }
  return { cwd, session, lines: n };
}

// Path containment that holds on Windows too: os/path produce backslash-separated paths
// there, so compare on a forward-slash-normalized form (both / and \ are accepted).
function isCodexTranscript(path: string): boolean {
  if (!path.endsWith(".jsonl") && !path.endsWith(".jsonl.zst")) return false;
  let realPath = path;
  let realRoot = sessionsRoot();
  try {
    realPath = realpathSync(path);
    realRoot = realpathSync(sessionsRoot());
  } catch {
    /* a raced path is rejected by its caller; keep lexical paths for the cheap probe guard */
  }
  const p = realPath.replace(/\\/g, "/");
  const root = realRoot.replace(/\\/g, "/");
  return p === root || p.startsWith(root + "/");
}

// ---- summaryFor: reuse a summary Codex already generated (P2) ----------------------------
// Codex's memories pipeline (Phase 2) writes one Markdown per selected rollout under
// $CODEX_HOME/memories/rollout_summaries/, headed by thread_id/rollout_path/cwd. Match by
// the thread UUID embedded in the rollout filename. Entries are pruned/rotated by Codex —
// absence is normal; this is opportunistic material, never required.
const CODEX_SUMMARY_MAX_CHARS = 4000;
const THREAD_ID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i;

function summaryFor(path: string): string | null {
  try {
    const m = path.replace(/\\/g, "/").match(THREAD_ID_RE);
    if (!m) return null;
    const threadId = m[1]!.toLowerCase();
    // env read is LAZY (unlike sessionsRoot()) so tests can point CODEX_HOME at a fixture.
    const codexDir = codexHome();
    const dir = join(codexDir, "memories", "rollout_summaries");
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      return null; // memories feature off / never consolidated — normal
    }
    for (const f of entries) {
      let text: string;
      try {
        text = readFileSync(join(dir, f), "utf-8");
      } catch {
        continue;
      }
      // header block carries thread_id — cheap containment check on the head only
      if (text.slice(0, 600).toLowerCase().includes(threadId)) {
        const t = text.trim();
        return t.length > CODEX_SUMMARY_MAX_CHARS ? t.slice(0, CODEX_SUMMARY_MAX_CHARS) : t;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export const codexSource: TranscriptSource = {
  kind: "codex",
  summaryFor,

  // Routing reads the HEAD of a plain rollout under the shared byte/record budget, and does not
  // touch compressed ones at all: decompressing a .zst means materializing an entire conversation
  // in memory just to learn which repository it belonged to — the exact work this stage exists to
  // avoid for repositories that were never enrolled. A rollout that is already in the capture
  // queue keeps resolving its .zst sibling through the condense path, and an explicit `ingest`
  // remains an intentional full read.
  discoverRoutes(): DiscoveredRoute[] {
    const files: string[] = [];
    walkJsonl(sessionsRoot(), files);
    const out: DiscoveredRoute[] = [];
    for (const path of files) {
      if (path.endsWith(".zst")) continue;
      const { cwd, session } = routeMeta(path);
      out.push({ path, sessionId: session, repo: cwd });
    }
    out.push(...indexedCompressedRoutes());
    return out;
  },

  materialize(route: DiscoveredRoute): DiscoveredSession | null {
    if (!route.repo) return null;
    if (resolveRolloutPath(route.path).endsWith(".zst")) {
      // Enrollment has already been checked by the daemon. Now full decompression is allowed, but
      // revalidate the index metadata against the rollout before the content can enter the queue.
      const meta = probeMeta(route.path);
      const transcriptRepo = meta.cwd ? canonicalWorktree(meta.cwd) : null;
      const routedRepo = canonicalWorktree(route.repo);
      if (
        !meta.session ||
        !route.sessionId ||
        meta.session !== route.sessionId ||
        !transcriptRepo ||
        transcriptRepo !== routedRepo
      ) {
        return null;
      }
      return { path: route.path, sessionId: route.sessionId, repo: transcriptRepo, lines: meta.lines };
    }
    return { path: route.path, sessionId: route.sessionId, repo: route.repo, lines: countLines(route.path) };
  },

  routeFor(path: string): DiscoveredRoute | null {
    if (!isCodexTranscript(path)) return null;
    if (path.endsWith(".zst")) {
      let real = path;
      try {
        real = realpathSync(path);
      } catch {
        return null;
      }
      return indexedCompressedRoutes().find((route) => route.sourcePath === real) ?? null;
    }
    const { cwd, session } = routeMeta(path);
    return { path, sessionId: session, repo: cwd };
  },

  discover(): DiscoveredSession[] {
    return discoverViaRoutes(codexSource);
  },

  probe(path: string): DiscoveredSession | null {
    if (!isCodexTranscript(path)) return null;
    const { cwd, session, lines } = probeMeta(path);
    return { path, sessionId: session, repo: cwd, lines };
  },

  parse(path: string, startOffset: number, opts?: ParseOpts): Increment {
    const minChars = opts?.minChars ?? 180;
    const cap = opts?.cap ?? 700;
    // .zst rollouts are finished/immutable: decompress whole, watermark over DECOMPRESSED
    // bytes (monotonic — after one full pass newOffset ≥ compressed size, so the row never
    // re-pends). Plain .jsonl keeps the cheap incremental readTail path unchanged.
    const real = resolveRolloutPath(path);
    let raw: Buffer;
    let newOffset: number;
    if (real.endsWith(".zst")) {
      const content = readRollout(real);
      if (!content)
        return { users: [], assistants: [], newOffset: startOffset, cwd: null, sessionId: null };
      raw = content.subarray(Math.min(startOffset, content.length));
      newOffset = content.length;
    } else {
      const r = readTail(real, startOffset);
      raw = r.raw;
      newOffset = r.newOffset;
    }
    const users: Turn[] = [];
    const assistants: Turn[] = [];
    let cwd: string | null = null;
    let sessionId: string | null = null;

    for (let line of raw.toString("utf-8").split("\n")) {
      line = line.trim();
      if (!line) continue;
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const f = fields(o);
      cwd = cwd || f.cwd;
      sessionId = sessionId || f.session;
      let t = f.text.split(/\s+/).filter(Boolean).join(" ").trim();
      if (!t) continue;
      const ts = String(o.timestamp ?? o.payload?.timestamp ?? "").slice(0, 16);
      if (f.role === "user") {
        if (t.startsWith("<") || t.slice(0, 40).includes("system-reminder")) continue;
        users.push({ ts, role: "user", text: t.slice(0, cap) });
      } else if (f.role === "assistant") {
        if (t.length >= minChars) assistants.push({ ts, role: "assistant", text: t.slice(0, cap) });
      }
    }
    return { users, assistants, newOffset, cwd, sessionId };
  },

  watchRoots(): string[] {
    try {
      return statSync(sessionsRoot()).isDirectory() ? [sessionsRoot()] : [];
    } catch {
      return []; // no ~/.codex → nothing to watch (byte-identical to claude-only daemon)
    }
  },
};
