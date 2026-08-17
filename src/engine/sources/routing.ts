// Shared stage-1 routing primitives for the file-based transcript adapters.
//
// This module is a LEAF on purpose: it imports nothing but types. The adapters need these values
// at module-evaluation time, and source.ts imports the adapters to build its registry — so if the
// constants lived in source.ts the import graph would close a value-level cycle and whichever
// module happened to be entered first would read the registry before it was initialized.
//
// The budget itself is the security property: routing runs over every transcript on the machine,
// including sessions belonging to repositories the user never enrolled, so it may spend only a
// bounded prefix of a file to answer "which repository is this?" and nothing more.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { DiscoveredRoute, DiscoveredSession, TranscriptSource } from "../source.ts";

// Work cap, not a disclosure cap: scanIdentity decodes only declared identity leaves, so reading
// further reveals nothing more — it only costs more. 64 KiB was measured to lose 68 of 2,687 real
// Claude sessions whose identity sits in record 3 behind a large first record (median 76 KiB in);
// 128 KiB recovered every one of them. The RECORD budget below is the meaningful bound on how much
// of a conversation routing walks.
export const ROUTE_MAX_BYTES = 131_072;
export const ROUTE_MAX_RECORDS = 64;

const ROUTE_READ_CHUNK_BYTES = 1024;

// Identity scanning limits. A key or an identity value longer than this is not metadata any
// adapter writes, so the record is abandoned rather than accumulated.
const MAX_KEY_BYTES = 4096;
const MAX_IDENTITY_BYTES = 4096;
// Declared metadata containers nest shallowly (`payload.git.repository_path` is the deepest any
// adapter needs). Anything deeper is malformed for our purposes → fail closed.
const MAX_CONTAINER_DEPTH = 8;
// Depth guard while skipping a value we refuse to interpret. Deeper than this and the record is
// abandoned; we never allocate per level, so this only bounds pathological input.
const MAX_SKIP_DEPTH = 512;

/**
 * Stream the bounded prefix as bytes. Consumers that handle records containing both identity
 * and message text can tokenize only metadata fields without ever building/decoding the body.
 */
export function* boundedRouteBytes(path: string): Generator<number> {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(ROUTE_READ_CHUNK_BYTES);
    let bytesRead = 0;
    let records = 0;
    while (bytesRead < ROUTE_MAX_BYTES && records < ROUTE_MAX_RECORDS) {
      const remaining = ROUTE_MAX_BYTES - bytesRead;
      const n = readSync(fd, buf, 0, Math.min(buf.length, remaining), bytesRead);
      if (n <= 0) break;
      bytesRead += n;
      for (let i = 0; i < n; i++) {
        const byte = buf[i]!;
        yield byte;
        if (byte === 0x0a) {
          records += 1;
          if (records >= ROUTE_MAX_RECORDS) return;
        }
      }
    }
  } catch {
    return;
  } finally {
    closeSync(fd);
  }
}

/**
 * Where an adapter's transcript format keeps routing identity, as dotted key paths.
 *
 * Paths are matched against the position in the record, so `payload.cwd` matches only a `cwd`
 * inside a top-level `payload` object — never a `cwd` that happens to appear inside message text
 * or a tool result.
 *
 * Array order is PRIORITY, not a hint, and it is resolved within a record: a Codex rollout forked
 * from another thread carries `payload.session_id` (the parent) physically before `payload.id`
 * (this rollout), so byte order would answer with the wrong session. The earliest record that
 * yields a field wins; inside that record, the highest-priority path wins.
 */
export interface IdentitySpec {
  readonly cwd: readonly string[];
  readonly session: readonly string[];
}

export interface RouteIdentity {
  cwd: string | null;
  session: string | null;
}

type ScanMode =
  | "seek-object"
  | "seek-key"
  | "key"
  | "after-key"
  | "seek-value"
  | "identity"
  | "skip-string"
  | "skip-complex"
  | "skip-scalar"
  | "ignore-record";

/**
 * THE stage-1 boundary, shared by every file-based adapter.
 *
 * Answers "which repository is this session's?" from a bounded prefix, under one rule:
 *
 *   descend only into DECLARED metadata containers · decode only DECLARED identity leaves ·
 *   skip everything else without interpreting it.
 *
 * A skipped value is walked byte-by-byte to find where it ends — the same bytes the record
 * separator scan already crosses — but its contents are never decoded, concatenated, retained,
 * logged or measured. So a message body, a tool result, or a pasted secret in an UNENROLLED
 * repository's transcript costs exactly what a newline costs: nothing observable.
 *
 * Why skipping rather than abandoning the record: an earlier revision gave up on the whole record
 * as soon as an unknown complex value appeared. That looked stricter but bought no privacy — the
 * abandoned bytes were still streamed to find the newline — while making real transcripts
 * unroutable, because every harness writes `message` before `cwd`. Fail-closed has to mean "learn
 * nothing you were not promised", not "learn nothing at all".
 */
export function scanIdentity(path: string, spec: IdentitySpec): RouteIdentity {
  const rank = (paths: readonly string[]): Map<string, number> =>
    new Map(paths.map((p, i) => [p, i]));
  const cwdRanks = rank(spec.cwd);
  const sessionRanks = rank(spec.session);
  // Every strict prefix of a declared path is a container we are allowed to enter.
  const containers = new Set<string>();
  for (const declared of [...spec.cwd, ...spec.session]) {
    const parts = declared.split(".");
    for (let i = 1; i < parts.length; i++) containers.add(parts.slice(0, i).join("."));
  }

  let cwd: string | null = null;
  let session: string | null = null;
  // Best candidate seen in the record currently being scanned, with its priority.
  let cwdSeen: string | null = null;
  let cwdSeenRank = Infinity;
  let sessionSeen: string | null = null;
  let sessionSeenRank = Infinity;

  let mode: ScanMode = "seek-object";
  let stack: string[] = [];
  let key = "";
  let token: number[] = [];
  let escaped = false;
  let skipDepth = 0;
  let inSkippedString = false;

  // Commit the record's best candidates. An earlier record always wins over a later one, so a
  // field that is already decided is never overwritten.
  const flushRecord = (): void => {
    if (cwd === null && cwdSeen !== null) cwd = cwdSeen;
    if (session === null && sessionSeen !== null) session = sessionSeen;
    cwdSeen = null;
    cwdSeenRank = Infinity;
    sessionSeen = null;
    sessionSeenRank = Infinity;
  };
  const resetRecord = (): void => {
    mode = "seek-object";
    stack = [];
    key = "";
    token = [];
    escaped = false;
    skipDepth = 0;
    inSkippedString = false;
  };
  const keyPath = (): string => (stack.length ? `${stack.join(".")}.${key}` : key);
  const decodeToken = (): string | null => {
    try {
      const value = JSON.parse(Buffer.from(token).toString("utf-8"));
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  };
  const complete = (): boolean => cwd !== null && session !== null;

  for (const byte of boundedRouteBytes(path)) {
    if (byte === 0x0a) {
      // Record separator. A raw newline cannot occur inside a JSON string, so this is always a
      // boundary — no state from the previous record survives it.
      flushRecord();
      if (complete()) break;
      resetRecord();
      continue;
    }
    if (mode === "ignore-record") continue;
    const whitespace = byte === 0x20 || byte === 0x09 || byte === 0x0d;

    if (mode === "seek-object") {
      if (whitespace) continue;
      mode = byte === 0x7b ? "seek-key" : "ignore-record"; // {
      continue;
    }

    if (mode === "seek-key") {
      if (whitespace || byte === 0x2c) continue; // ,
      if (byte === 0x7d) {
        // } — the current object ended. Inside a declared container that means "back to the
        // parent"; at the top level it means the record is over.
        if (stack.length) stack.pop();
        else mode = "ignore-record";
        continue;
      }
      if (byte !== 0x22) {
        mode = "ignore-record";
        continue;
      }
      token = [byte];
      escaped = false;
      mode = "key";
      continue;
    }

    if (mode === "key" || mode === "identity") {
      token.push(byte);
      if (token.length > (mode === "key" ? MAX_KEY_BYTES : MAX_IDENTITY_BYTES)) {
        mode = "ignore-record";
        token = [];
        continue;
      }
      if (escaped) {
        escaped = false;
        continue;
      }
      if (byte === 0x5c) {
        escaped = true;
        continue;
      }
      if (byte !== 0x22) continue;
      const value = decodeToken();
      token = [];
      if (mode === "key") {
        if (value === null) mode = "ignore-record";
        else {
          key = value;
          mode = "after-key";
        }
        continue;
      }
      if (value !== null) {
        const at = keyPath();
        const cr = cwdRanks.get(at);
        if (cr !== undefined && cr < cwdSeenRank) {
          cwdSeen = value;
          cwdSeenRank = cr;
        }
        const sr = sessionRanks.get(at);
        if (sr !== undefined && sr < sessionSeenRank) {
          sessionSeen = value;
          sessionSeenRank = sr;
        }
      }
      // Both fields at their top preference: nothing later in this record can improve on it.
      if (cwdSeenRank === 0 && sessionSeenRank === 0) {
        flushRecord();
        break;
      }
      mode = "seek-key";
      continue;
    }

    if (mode === "after-key") {
      if (whitespace) continue;
      mode = byte === 0x3a ? "seek-value" : "ignore-record"; // :
      continue;
    }

    if (mode === "seek-value") {
      if (whitespace) continue;
      const at = keyPath();
      if (byte === 0x22) {
        if (cwdRanks.has(at) || sessionRanks.has(at)) {
          token = [byte];
          escaped = false;
          mode = "identity";
        } else {
          escaped = false;
          mode = "skip-string";
        }
        continue;
      }
      if (byte === 0x7b && containers.has(at) && stack.length < MAX_CONTAINER_DEPTH) {
        stack.push(key);
        mode = "seek-key";
        continue;
      }
      if (byte === 0x7b || byte === 0x5b) {
        // Not a declared container (and arrays never carry identity): walk to its end without
        // interpreting anything inside it.
        skipDepth = 1;
        inSkippedString = false;
        escaped = false;
        mode = "skip-complex";
        continue;
      }
      mode = "skip-scalar";
      continue;
    }

    if (mode === "skip-string") {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) mode = "seek-key";
      continue;
    }

    if (mode === "skip-complex") {
      // String-aware so a brace inside skipped text cannot unbalance the walk. Bytes are compared,
      // never collected.
      if (inSkippedString) {
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        else if (byte === 0x22) inSkippedString = false;
        continue;
      }
      if (byte === 0x22) {
        inSkippedString = true;
        escaped = false;
        continue;
      }
      if (byte === 0x7b || byte === 0x5b) {
        skipDepth += 1;
        if (skipDepth > MAX_SKIP_DEPTH) mode = "ignore-record";
        continue;
      }
      if (byte === 0x7d || byte === 0x5d) {
        skipDepth -= 1;
        if (skipDepth <= 0) mode = "seek-key";
      }
      continue;
    }

    if (mode === "skip-scalar") {
      if (byte === 0x2c) mode = "seek-key";
      else if (byte === 0x7d) {
        if (stack.length) {
          stack.pop();
          mode = "seek-key";
        } else mode = "ignore-record";
      } else if (byte === 0x5d) mode = "ignore-record";
      continue;
    }
  }

  // A prefix that ends without a trailing newline still committed complete identity strings.
  flushRecord();
  return { cwd, session };
}

/**
 * Stage-2 work measurement: newline counting over chunks. No JSON parsing and no message text —
 * an enrolled session's size is known without anything being interpreted or retained.
 */
export function countLines(path: string): number {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return 0;
  }
  try {
    const buf = Buffer.alloc(64 * 1024);
    let total = 0;
    let read = 0;
    let position = 0;
    let lastByte = 0;
    while ((read = readSync(fd, buf, 0, buf.length, position)) > 0) {
      for (let i = 0; i < read; i++) if (buf[i] === 0x0a) total += 1;
      lastByte = buf[read - 1]!;
      position += read;
    }
    if (position > 0 && lastByte !== 0x0a) total += 1; // unterminated final line still counts
    return total;
  } catch {
    return 0;
  } finally {
    closeSync(fd);
  }
}

/**
 * `discover()` for adapters that implement the two stages: route, then materialize every route.
 * The DAEMON never uses this — it applies the enrollment predicate between the stages, which is
 * the entire point of splitting them. Explicit commands and tests do.
 */
export function discoverViaRoutes(source: TranscriptSource): DiscoveredSession[] {
  const routes = source.discoverRoutes();
  if (source.materializeMany) {
    const results = source.materializeMany(routes);
    const failed = results.find((result) => result.error !== undefined);
    if (failed?.error) throw failed.error;
    return results.flatMap((result) => (result.session ? [result.session] : []));
  }
  const out: DiscoveredSession[] = [];
  for (const route of routes) {
    const session = source.materialize(route);
    if (session) out.push(session);
  }
  return out;
}

/**
 * Poll revision gate. File-backed sources use size; database-backed sources can provide a
 * harness-owned logical revision because SQLite may update only its WAL. A source without either
 * reliable signal explicitly opts into materialization every sweep.
 */
export function routeNeedsMaterialization(
  route: DiscoveredRoute,
  lastRevisions?: Record<string, string | number>,
): boolean {
  if (!lastRevisions || route.alwaysMaterialize) return true;
  if (route.revision !== undefined) {
    if (lastRevisions[route.path] === route.revision) return false;
    lastRevisions[route.path] = route.revision;
    return true;
  }
  const observedPath = route.changePath ?? route.path;
  let size: number;
  try {
    size = statSync(observedPath).size;
  } catch {
    return true;
  }
  if (lastRevisions[observedPath] === size) return false;
  lastRevisions[observedPath] = size;
  return true;
}
