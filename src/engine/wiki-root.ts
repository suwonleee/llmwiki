// Which repository's wiki a directory belongs to.
//
// "This directory is trusted" and "this directory holds the wiki" are different questions.
// Enrollment answers the first, and it answers it for the WORKTREE, because `git rev-parse` walks
// up. A session's cwd is routinely below that root — an agent launched in <repo>/src — and reading
// <repo>/src/docs/wiki finds nothing and stays silent, a failure indistinguishable from "this
// project has no wiki". So the reads resolve the wiki root separately, by walking up.
//
// The walk stops at two boundaries, and both matter:
//   1. The enrolled worktree. Consent stops there, so the search does too — a directory never
//      reaches a wiki the human did not enroll.
//   2. A nested project that HAS its own docs/wiki. It keeps its own wiki even though git (and
//      therefore enrollment) resolved to the parent. Not hypothetical: a home directory that is
//      itself a git repository absorbs every non-git project under it into one worktree.
import { realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { inspectEnrollment } from "./enrollment.ts";
import { repoDirExists } from "./repo-write.ts";

/** Same literal the readers use; a wiki lives at <root>/docs/wiki or it does not exist. */
const WIKI_REL = "docs/wiki";
/** A path can only nest so far before "keep walking up" stops being a sane answer. */
const MAX_DEPTH = 32;

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Where a session's capture rows are FILED — the same repository its reads bind to.
 *
 * The bucket key is what `update-status` and the cold-start backlog query by, and they query by
 * the WIKI ROOT. A row keyed by the session's bare cwd (a subdirectory, a non-git folder inside
 * an enrolled worktree) is therefore invisible: captured, but surfaced to no one — and a session
 * nobody can see is a session nobody can CHOOSE to file. Self-selection requires visibility;
 * before this rule, 29 live rows on the author's machine sat in buckets no query ever read, aging
 * toward deletion as if the human had judged them not worth keeping, which no one ever did.
 *
 * Same answer as the read side (`wikiRootFor`), same fail-closed edges: no wiki anywhere within
 * the enrolled worktree → the worktree itself (where `llmwiki init` will put one); not enrolled
 * at all → the cwd unchanged (never invent a parent for a repository the human did not consent to).
 */
export function captureBucket(cwd: string): string {
  // One spelling per location, or the key stops being a key: macOS hands sessions `/var/...`
  // while git answers `/private/var/...`, and a bucket split across the two spellings is two
  // buckets, each hiding half the rows. Canonicalize first; a path that no longer exists is
  // returned as given (a dead bucket cannot be normalized, only left intact).
  let canonical: string;
  try {
    canonical = realpathSync(cwd);
  } catch {
    return cwd;
  }
  const st = inspectEnrollment(canonical);
  const root = wikiRootFor(canonical, st.worktree);
  if (repoDirExists(root, WIKI_REL)) return root;
  return st.worktree ?? root;
}

/**
 * The nearest ancestor of `dir` (including itself) that holds a wiki, never above `worktree`.
 * Falls back to `dir` — which reads as "no wiki here", the same silence as before.
 */
export function wikiRootFor(dir: string, worktree: string | null): string {
  const start = resolve(dir);
  const stop = worktree ? resolve(worktree) : null;
  let cur = start;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (repoDirExists(cur, WIKI_REL)) return cur;
    if (!stop || cur === stop) break;
    const parent = dirname(cur);
    // Stop at the filesystem root, and stop the moment the parent would leave the enrolled
    // worktree — including the case where the two paths are simply not comparable (one canonical,
    // one not), where the only safe answer is "don't walk".
    if (parent === cur || !isWithin(stop, parent)) break;
    cur = parent;
  }
  return start;
}
