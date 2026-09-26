// Lifecycle for engine-held project state — the capability that moving it out of repositories
// bought.
//
// While every index lived inside its own repository, nothing could maintain it. The engine had no
// way to enumerate the indexes it had created, so the daemon (central, already sweeping every
// minute) could not touch them, and the only maintenance path was a human running /wiki-deep
// inside that specific repository — which for most repositories never happens. Measured before
// this change, on a machine with four indexes: live indexed bytes were 5–16% of file size, one
// index was 8.9MB and had not been opened in days, and the shared compaction policy's 30 MiB floor
// meant not one of them would ever become eligible no matter how much slack accumulated.
//
// Three operations, in increasing order of how much they throw away:
//   compact  — reclaim free pages in place. Nothing is lost.
//   evict    — delete the index and its cache for a project nobody has opened lately. Regenerable
//              in seconds; refs.ts re-registers cited transcripts on the next build, so even
//              provenance survives. This is what bounds total disk by ACTIVITY rather than by the
//              number of projects ever touched.
//   collect  — remove the directory of a project that no longer exists, after a grace period.
//
// Everything here is skip-on-doubt: a busy database is left alone, an unreadable directory is left
// alone, and a project whose worktree merely cannot be reached right now is not an orphan.
import { Database } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  compactDatabase,
  inspectDatabaseHealth,
  type DatabaseCompactionPolicy,
} from "./db-maintenance.ts";
import {
  evictRegenerable,
  listProjectStates,
  removeProjectState,
  type ProjectStateEntry,
} from "./project-state.ts";

/**
 * Tuned for index stores, not for the shared default. The 30 MiB floor exists to stop VACUUM
 * churn on databases where reclaiming is pointless; per-project indexes are an order of magnitude
 * smaller than that and still accumulate a third of their file in free pages, so the floor has to
 * come down or compaction never runs at all.
 */
export const INDEX_STORE_POLICY: DatabaseCompactionPolicy = {
  minimumDatabaseBytes: 4 * 1024 * 1024,
  minimumFreeRatio: 0.2,
  minimumFreeBytes: 1024 * 1024,
};

/** Default idleness before an index is dropped. Regenerable, so this is a cost knob, not a risk one. */
export const DEFAULT_EVICT_AFTER_DAYS = 60;
/**
 * A vanished worktree's state is collected only after this long without use. Git worktrees are
 * created and deleted within a day, so the
 * window only has to outlast a moved or briefly detached checkout. `LLMWIKI_ORPHAN_GRACE_DAYS`.
 */
export const DEFAULT_ORPHAN_GRACE_DAYS = 7;

export function orphanGraceDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LLMWIKI_ORPHAN_GRACE_DAYS?.trim();
  const days = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(days) && days >= 0 ? days : DEFAULT_ORPHAN_GRACE_DAYS;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// Directories other volumes are mounted under. When the nearest ancestor of a missing worktree
// that still exists is one of these (or the filesystem root), the likelier story is "the volume
// is not mounted right now" than "the project was deleted" — and that is not evidence to delete on.
// `/media` and `/run/media` hold one directory per user, and the volumes sit one level below it.
const MOUNT_PARENTS = new Set(["/", "/Volumes", "/media", "/mnt", "/run/media"]);
const PER_USER_MOUNT_PARENTS = new Set(["/media", "/run/media"]);

/** Could the worktree be missing only because its volume is detached? Skip-on-doubt. */
export function mayBeOnDetachedVolume(worktree: string): boolean {
  let dir = dirname(resolve(worktree));
  while (!pathExists(dir)) {
    const up = dirname(dir);
    if (up === dir) return true; // not even a root exists (an absent Windows drive)
    dir = up;
  }
  return MOUNT_PARENTS.has(dir) || PER_USER_MOUNT_PARENTS.has(dirname(dir));
}

export type OrphanVerdict =
  | { readonly collect: true; readonly reason: "gone" }
  | { readonly collect: false; readonly reason: "live" | "unknown-worktree" | "worktree-present" | "detached-volume" | "grace" };

/**
 * May this project directory be deleted? Only on positive evidence that its worktree is gone:
 * recorded in meta.json, absent from disk, on a volume that is present, and unused for the grace
 * window. Distilled history lives in capture.db, never here, so collecting touches none of it.
 */
export function orphanVerdict(entry: ProjectStateEntry, now: number, graceDays: number): OrphanVerdict {
  if (!entry.orphaned) return { collect: false, reason: "live" };
  if (entry.worktree === null) return { collect: false, reason: "unknown-worktree" };
  if (pathExists(entry.worktree)) return { collect: false, reason: "worktree-present" };
  if (mayBeOnDetachedVolume(entry.worktree)) return { collect: false, reason: "detached-volume" };
  if (ageDays(entry.lastUsed, now) < graceDays) return { collect: false, reason: "grace" };
  return { collect: true, reason: "gone" };
}

export type ProjectStoreSummary = {
  readonly projects: number;
  readonly bytes: number;
  readonly orphans: number;
  readonly orphanBytes: number;
  readonly evictableBytes: number;
};

export type MaintenanceOutcome = {
  readonly compacted: number;
  readonly reclaimedBytes: number;
  readonly evicted: number;
  readonly evictedBytes: number;
  readonly collected: number;
  readonly collectedBytes: number;
};

function ageDays(iso: string | null, now: number): number {
  if (iso === null) return Number.POSITIVE_INFINITY;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return (now - t) / 86_400_000;
}

/** What the store holds right now — the question nobody could answer while state was scattered. */
export function summarizeProjectStore(
  entries: readonly ProjectStateEntry[] = listProjectStates(),
  now = Date.now(),
  evictAfterDays = DEFAULT_EVICT_AFTER_DAYS,
): ProjectStoreSummary {
  let bytes = 0;
  let orphans = 0;
  let orphanBytes = 0;
  let evictableBytes = 0;
  for (const entry of entries) {
    bytes += entry.bytes;
    if (entry.orphaned) {
      orphans += 1;
      orphanBytes += entry.bytes;
      continue;
    }
    if (ageDays(entry.lastUsed, now) >= evictAfterDays) evictableBytes += entry.bytes;
  }
  return { projects: entries.length, bytes, orphans, orphanBytes, evictableBytes };
}

/**
 * Reclaim free pages. A database another process is using is skipped rather than waited on:
 * VACUUM takes an exclusive lock, and blocking a foreground search to tidy a background file is
 * the wrong trade every time.
 */
function compactOne(dir: string): number {
  const path = join(dir, "index.db");
  let db: Database | null = null;
  try {
    db = new Database(path);
    db.exec("PRAGMA busy_timeout=250");
    const before = inspectDatabaseHealth(db, INDEX_STORE_POLICY);
    if (!before.integrity.ok || !before.compactionEligible) return 0;
    const result = compactDatabase(db, { commit: true, policy: INDEX_STORE_POLICY });
    if (result.kind !== "compacted") return 0;
    return Math.max(0, result.before.storage.databaseBytes - result.after.storage.databaseBytes);
  } catch {
    return 0; // absent, busy, or not a database — all "leave it alone"
  } finally {
    db?.close();
  }
}

/**
 * One maintenance pass over the whole store. Called by the daemon on a long interval and by
 * `doctor --fix`; both are safe to run at any moment because every step declines when unsure.
 */
export function runProjectMaintenance(
  opts: {
    readonly now?: number;
    readonly evictAfterDays?: number;
    readonly orphanGraceDays?: number;
    readonly commit?: boolean;
  } = {},
): MaintenanceOutcome {
  const now = opts.now ?? Date.now();
  const evictAfterDays = opts.evictAfterDays ?? DEFAULT_EVICT_AFTER_DAYS;
  const graceDays = opts.orphanGraceDays ?? orphanGraceDays();
  const commit = opts.commit !== false;
  let compacted = 0;
  let reclaimedBytes = 0;
  let evicted = 0;
  let evictedBytes = 0;
  let collected = 0;
  let collectedBytes = 0;

  for (const entry of listProjectStates()) {
    const age = ageDays(entry.lastUsed, now);
    if (entry.orphaned) {
      if (!orphanVerdict(entry, now, graceDays).collect) continue; // doubt → keep
      if (commit && removeProjectState(entry.dir)) {
        collected += 1;
        collectedBytes += entry.bytes;
      }
      continue;
    }
    if (age >= evictAfterDays) {
      if (commit) {
        const freed = evictRegenerable(entry.dir);
        if (freed > 0) {
          evicted += 1;
          evictedBytes += freed;
        }
      }
      continue; // no point compacting what was just dropped
    }
    if (commit) {
      const freed = compactOne(entry.dir);
      if (freed > 0) {
        compacted += 1;
        reclaimedBytes += freed;
      }
    }
  }
  return { compacted, reclaimedBytes, evicted, evictedBytes, collected, collectedBytes };
}
