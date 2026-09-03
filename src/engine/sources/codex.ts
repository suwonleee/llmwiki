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
import { persistedCodexHome } from "../harness-locate.ts";
import { openReadonlyDatabase } from "../sqlite-open.ts";
import { envValueOutsideRepoFiles } from "../env-policy.ts";

// Codex honors $CODEX_HOME (falling back to ~/.codex) for its state dir — mirror that so a
// user who relocates CODEX_HOME is still captured. (openai/codex utils/home-dir.)
//
// Read LAZILY, like summaryFor already did: a module-level snapshot silently ignores an
// environment set after import, which in practice meant a test pointed at a fixture still
// scanned the real ~/.codex.
function home(): string {
  return process.env.HOME?.trim() || homedir();
}
export function codexHome(): string {
  // env > persisted (`llmwiki connect codex <dir>`, verified at connect time) > ~/.codex.
  //
  // The env read goes through the repository-env guard: Bun autoloads `.env` from the cwd, and the
  // cwd here is the user's repository. Without the guard a tracked `.env` could redeclare
  // CODEX_HOME and redirect which sessions this engine reads — a decision that must come from the
  // machine, never from a file that arrives with a clone.
  return envValueOutsideRepoFiles("CODEX_HOME")?.trim() || persistedCodexHome() || join(home(), ".codex");
}

// ---- every Codex home this machine owns -------------------------------------------------
//
// $CODEX_HOME is the primary, but it stopped being the ONLY one. Codex Desktop (which ships as
// the `orca` app) runs each signed-in account against its own relocated home and exports
// CODEX_HOME into the processes it launches. A detached daemon never sees that export, so a
// capture pinned to one home goes blind the moment work moves into the app — and does so
// silently, reporting "nothing captured" rather than "I am looking in the wrong place".
//
// Measured on the author's machine (2026-09-03): ~/.codex/sessions froze at 2026-08-22, its
// rollouts hardlinked into the account home at migration time, while the account home kept
// writing. 40 rollouts had no counterpart under ~/.codex — 6 of them in enrolled repositories,
// none of them ever captured. Injection was unaffected (hooks live in each home's hooks.json)
// and skills too (they install under ~/.agents/skills, which is HOME-relative), so exactly the
// half of the loop that goes through CODEX_HOME broke.
//
// Discovery is signature-verified, never name-guessed, and never leaves $HOME.

/** Where the desktop app keeps its per-account state, per platform. */
function orcaDataRoots(): string[] {
  const h = home();
  if (process.platform === "darwin") return [join(h, "Library", "Application Support", "orca")];
  if (process.platform === "win32") {
    const appData = envValueOutsideRepoFiles("APPDATA")?.trim();
    return appData ? [join(appData, "orca")] : [];
  }
  const xdg = envValueOutsideRepoFiles("XDG_CONFIG_HOME")?.trim() || join(h, ".config");
  return [join(xdg, "orca")];
}

/** A Codex home is judged by what is inside it: a sessions/ dir or a state_*.sqlite. */
function looksLikeCodexHome(dir: string): boolean {
  try {
    if (statSync(join(dir, "sessions")).isDirectory()) return true;
  } catch {
    /* no sessions/ yet — a fresh home creates it on the first user message */
  }
  try {
    return readdirSync(dir).some((n) => /^state_[A-Za-z0-9_.-]+\.sqlite$/.test(n));
  } catch {
    return false;
  }
}

/**
 * Desktop-app homes. Two layouts are known: one home per signed-in account, plus a shared
 * runtime home. Account homes carry a `.orca-managed-home` marker holding the account UUID; the
 * runtime home does NOT, so the marker cannot be the test — the Codex-home signature is, and the
 * candidate paths are already confined to the app's own directory.
 */
function orcaCodexHomes(): string[] {
  const out: string[] = [];
  for (const root of orcaDataRoots()) {
    const candidates = [join(root, "codex-runtime-home", "home")];
    try {
      for (const name of readdirSync(join(root, "codex-accounts"))) {
        candidates.push(join(root, "codex-accounts", name, "home"));
      }
    } catch {
      /* no accounts dir — the app is not installed, or has never signed in */
    }
    for (const dir of candidates) if (looksLikeCodexHome(dir)) out.push(dir);
  }
  return out;
}

/**
 * Every Codex home to READ, primary first, de-duplicated by real path. Mirrors the Claude side,
 * which has always returned a list (claudeConfigDirs) — Codex was the odd one out at a single
 * string, and that asymmetry is what let the desktop migration go unnoticed.
 */
export function codexHomes(): string[] {
  const configured = codexHome();
  const fallback = join(home(), ".codex");
  // An override is EXCLUSIVE. Pointing CODEX_HOME (or `llmwiki connect codex`) somewhere is a
  // deliberate statement about which sessions this machine reads, and quietly sweeping other
  // homes alongside it would override that decision — the same reason the env read is guarded
  // against a repository's own .env.
  //
  // "Override" means a value that differs from the plain ~/.codex default. The daemon's service
  // definition bakes `CODEX_HOME=${CODEX_HOME:-$HOME/.codex}` at install time (daemon/install.sh),
  // so a machine that had nothing set ends up exporting the DEFAULT as if it were a choice. That
  // frozen default is not a decision, and treating it as one is precisely what kept the daemon
  // pinned to a home Codex had stopped writing to.
  const candidates = sameDir(configured, fallback)
    ? [fallback, ...orcaCodexHomes()]
    : [configured];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of candidates) {
    if (!dir) continue;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue; // a configured home that does not exist is simply not read
    }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(dir);
  }
  return out;
}

/** Same directory, comparing real paths where both resolve (a symlinked home is still that home). */
function sameDir(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function sessionsRoot(): string {
  return join(codexHome(), "sessions");
}

/** Every sessions/ root to sweep, in codexHomes() order. */
function sessionsRoots(): string[] {
  return codexHomes().map((dir) => join(dir, "sessions"));
}

/**
 * Inode identity of one rollout, or null when it cannot be stat'd. Two homes that hardlink the
 * same rollout share this; two genuinely different rollouts never do. Null keeps the caller's
 * previous behavior (accept the route) rather than dropping a file over a transient stat error.
 */
function rolloutIdentity(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
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
/** State indexes across every home, each paired with the home it belongs to. */
function stateDbPaths(): { home: string; path: string }[] {
  const out: { home: string; path: string }[] = [];
  for (const dir of codexHomes()) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^state_[A-Za-z0-9_.-]+\.sqlite$/.test(name)) continue;
      const path = join(dir, name);
      try {
        const st = lstatSync(path);
        if (st.isFile() && !st.isSymbolicLink()) out.push({ home: dir, path: realpathSync(path) });
      } catch {
        /* raced with Codex cleanup */
      }
    }
  }
  return out;
}

function indexedCompressedRoutes(): DiscoveredRoute[] {
  const byPath = new Map<string, DiscoveredRoute>();
  for (const { home: homeDir, path: dbPath } of stateDbPaths()) {
    // The logical path must be rebuilt under the home THIS index belongs to, not the primary one.
    const root = join(homeDir, "sessions");
    let db: Database | null = null;
    try {
      db = openReadonlyDatabase(dbPath);
      if (db === null) continue; // unreadable state index → the uncompressed rollouts still route
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
          const rel = relative(realpathSync(root), path);
          if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) continue;
          logicalPath = join(root, rel).slice(0, -".zst".length);
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
// Decompression is feature-detected down three rungs, because the runtime floor this engine
// advertises (Bun 1.1) predates in-process zstd entirely:
//
//   Bun.zstdDecompressSync — Bun 1.2+
//   node:zlib zstd         — newer Node-compat surfaces
//   the `zstd` binary      — present wherever Codex itself compressed these files, and the only
//                            rung a Bun 1.1 machine has
//
// Missing all three is not a crash and not a lost session: readRollout returns null, the session is
// simply not enqueued this pass, and the next sweep tries again. What it WAS, before the third rung
// and `zstdAvailable()`, is invisible — every cold Codex session silently absent while doctor
// reported a healthy Codex.
let zstdBinary: string | null | undefined;

function zstdViaBinary(buf: Buffer): Buffer | null {
  if (zstdBinary === undefined) zstdBinary = Bun.which("zstd");
  if (!zstdBinary) return null;
  try {
    const r = Bun.spawnSync([zstdBinary, "-d", "-c"], {
      stdin: buf,
      stdout: "pipe",
      stderr: "ignore",
      timeout: 15_000,
    });
    return r.exitCode === 0 ? Buffer.from(r.stdout) : null;
  } catch {
    return null;
  }
}

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
  return zstdViaBinary(buf);
}

/** Can this machine read compressed rollouts at all, and by which route? For doctor. */
export function zstdAvailability(): { available: boolean; via: string } {
  const b: any = globalThis.Bun;
  if (typeof b?.zstdDecompressSync === "function") return { available: true, via: "Bun.zstdDecompressSync" };
  try {
    const zlib = require("node:zlib");
    if (typeof zlib.zstdDecompressSync === "function") return { available: true, via: "node:zlib" };
  } catch {
    /* unavailable */
  }
  if (zstdBinary === undefined) zstdBinary = Bun.which("zstd");
  if (zstdBinary) return { available: true, via: `${zstdBinary} (external)` };
  return { available: false, via: "none" };
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

/** Plain-rollout discovery seam for deterministic tests/benchmarks. Compressed routes stay indexed. */
export function discoverCodexFileRoutes(root: string = sessionsRoot()): DiscoveredRoute[] {
  const files: string[] = [];
  walkJsonl(root, files);
  const out: DiscoveredRoute[] = [];
  for (const path of files) {
    if (path.endsWith(".zst")) continue;
    const { cwd, session } = routeMeta(path);
    out.push({ path, sessionId: session, repo: cwd });
  }
  return out;
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
  try {
    realPath = realpathSync(path);
  } catch {
    /* a raced path is rejected by its caller; keep lexical paths for the cheap probe guard */
  }
  const p = realPath.replace(/\\/g, "/");
  // Under ANY owned home, not just the primary: a desktop-app rollout is as much a Codex
  // transcript as a CLI one, and rejecting it here would make discovery find files that probe()
  // then disowns.
  for (const candidate of sessionsRoots()) {
    let realRoot = candidate;
    try {
      realRoot = realpathSync(candidate);
    } catch {
      /* home without a sessions/ dir yet */
    }
    const root = realRoot.replace(/\\/g, "/");
    if (p === root || p.startsWith(root + "/")) return true;
  }
  return false;
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
    // Codex resolves the memories root as $CODEX_HOME/memories (memories/read/src/lib.rs
    // memory_root), so a relocated home moves the summaries with it — search EVERY owned home,
    // for the same reason discovery does. Reads stay lazy so tests can point CODEX_HOME at a
    // fixture.
    for (const codexDir of codexHomes()) {
      const dir = join(codexDir, "memories", "rollout_summaries");
      let entries: string[];
      try {
        entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
      } catch {
        continue; // memories feature off / never consolidated in this home — normal
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
    const out: DiscoveredRoute[] = [];
    // Two homes can expose the SAME rollout. Codex Desktop hardlinked ~/.codex/sessions into the
    // account home when it migrated — verified on disk: identical inode, link count 3. The capture
    // queue is keyed by PATH (capture_queue.transcript_path), so sweeping both homes naively would
    // enqueue one conversation twice and file it into the wiki twice. A hardlink is precisely a
    // shared inode, so inode identity is the right and cheap de-duplicator; the first home wins,
    // and codexHomes() puts the configured/primary one first.
    const seen = new Set<string>();
    const keep = (route: DiscoveredRoute): void => {
      const id = rolloutIdentity(route.sourcePath ?? resolveRolloutPath(route.path));
      if (id !== null) {
        if (seen.has(id)) return;
        seen.add(id);
      }
      out.push(route);
    };
    for (const root of sessionsRoots()) for (const route of discoverCodexFileRoutes(root)) keep(route);
    for (const route of indexedCompressedRoutes()) keep(route);
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
