// llmwiki migrate — restructure an existing wiki to the effective config: folder renames with
// referential integrity (every [[wikilink]]/markdown link retargeted), frontmatter `domain:`
// updates, and a committed `.schema-version` snapshot so structure drift is detectable on every
// machine the wiki travels to.
//
// Safety model (prior art from the 2026-07-07 ecosystem survey):
//   • dry-run is the DEFAULT; --commit applies (ilya-epifanov rename).
//   • never auto-runs on config change — cold-start/doctor only DETECT drift and suggest this
//     command (an unattended folder rename is how wikis get destroyed).
//   • .schema-version travels with the repo (LLM-Wiki-v3 pattern): a teammate whose engine
//     config is older/newer than the wiki's structure gets warned in cold-start.
//
// Pairing rule: an on-disk `N_*` dir not in the config maps to the config dir with the SAME
// leading number (1_direction → 1_goal). Ambiguity (no counterpart) is reported, never guessed;
// explicit pairs via `--map old=new[,old=new…]` win over the heuristic.
import { join, resolve } from "node:path";
import { effectiveKo, getConfig, resolveLang, type WikiConfig } from "./config.ts";
import { parseLedger, renderLedger, type QuizEntry } from "./quiz.ts";
import { today } from "./today.ts";
import { WikiIndex } from "./db.ts";
import { updateReferences, autoRegisterCitedTranscripts } from "./refs.ts";
import { Linter, type WikiIndexLike } from "./lint.ts";
import { readRepoDir, readRepoFile, removeEmptyRepoDir, renameRepoPath, repoDirExists, repoFileExists, repoRelative, writeRepoFile } from "./repo-write.ts";

export const SCHEMA_VERSION_FILE = ".schema-version";

interface Pair {
  from: string;
  to: string;
  domain?: string; // the new domain for pages in this dir (category renames only)
}

export interface MigrateResult {
  verdict: "conforms" | "planned" | "migrated" | "skip";
  pairs?: Pair[];
  strays?: string[]; // on-disk numbered dirs with no config counterpart (left untouched)
  straysRemoved?: string[]; // EMPTY unmapped dirs dropped on commit (nothing to lose, git never tracked them)
  linksRewritten?: number;
  domainsRewritten?: number;
  quizLedgerRemapped?: number; // ledger page identities moved to renamed category dirs
  lintErrors?: number;
  reason?: string;
}

// Serializable snapshot of the structural conventions — what .schema-version records.
export function schemaSnapshot(cfg: WikiConfig): string {
  return JSON.stringify(
    {
      config_version: cfg.configVersion,
      categories: cfg.categories.map((c) => ({ dir: c.dir, domain: c.domain, review: c.review })),
      topic: cfg.topicDir,
      queue: cfg.queueDir,
    },
    null,
    2,
  );
}

function wikiDir(ws: string): string {
  return join(resolve(ws), "docs", "wiki");
}

function numberedDirsOnDisk(root: string): string[] {
  return readRepoDir(root, join("docs", "wiki"))
    .filter((entry) => entry.isDirectory && /^\d+_/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function leadingNum(dir: string): string {
  return dir.split("_", 1)[0]!;
}

// All .md files under docs/wiki (recursive) — link rewriting scans everything, including the
// queue and topic layers, so no page keeps a dangling link after a rename.
function allPages(root: string, dir = join("docs", "wiki"), out: string[] = []): string[] {
  for (const e of readRepoDir(root, dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) allPages(root, p, out);
    else if (e.isFile && e.name.endsWith(".md")) out.push(p.replace(/\\/g, "/"));
  }
  return out;
}

function planPairs(root: string, cfg: WikiConfig, explicit: Record<string, string>): { pairs: Pair[]; strays: string[] } {
  // quizDir is expected structure too (never a stray): without it, a numbered quiz folder
  // could pair-by-leading-number with a missing category and get RENAMED into content.
  // (It stays out of schemaSnapshot deliberately — adding it would flag reverse-drift on
  // every wiki whose .schema-version predates the quiz layer.)
  const expected = new Set([...cfg.categories.map((c) => c.dir), cfg.topicDir, cfg.queueDir, cfg.quizDir]);
  const onDisk = numberedDirsOnDisk(root);
  const strayDirs = onDisk.filter((d) => !expected.has(d));
  const missing = [...expected].filter((d) => !onDisk.includes(d));
  const pairs: Pair[] = [];
  const strays: string[] = [];
  const domainOf = (dir: string) => cfg.categories.find((c) => c.dir === dir)?.domain;
  for (const s of strayDirs) {
    const explicitTo = explicit[s];
    const to = explicitTo ?? missing.find((m) => leadingNum(m) === leadingNum(s));
    if (to && expected.has(to)) {
      pairs.push({ from: s, to, domain: domainOf(to) });
    } else {
      strays.push(s);
    }
  }
  return { pairs, strays };
}

// Rewrite link tokens for one rename across a page body. Three forms carry structure:
// [[old/… wikilinks, ](old/… markdown links, and literal docs/wiki/old/ path mentions.
function rewriteLinks(content: string, from: string, to: string): [string, number] {
  let n = 0;
  for (const [a, b] of [
    [`[[${from}/`, `[[${to}/`],
    [`](${from}/`, `](${to}/`],
    [`docs/wiki/${from}/`, `docs/wiki/${to}/`],
  ] as const) {
    const parts = content.split(a);
    n += parts.length - 1;
    content = parts.join(b);
  }
  return [content, n];
}

// On commit, drop unmapped numbered dirs that hold NOTHING: an empty dir carries no knowledge
// (git never tracked it) but would re-print "⚠ unmapped" on every later dry-run — the husk
// problem, generalized. Dry-run keeps reporting them so the plan shows the full picture.
function dropEmptyStrays(ws: string, root: string, strays: string[], commit: boolean): { kept: string[]; removed: string[] } {
  if (!commit) return { kept: strays, removed: [] };
  const removed: string[] = [];
  for (const s of strays) {
    if (!readRepoDir(root, join("docs", "wiki", s)).length && removeEmptyRepoDir(ws, join("docs", "wiki", s))) removed.push(s);
  }
  return { kept: strays.filter((s) => !removed.includes(s)), removed };
}

export function migrate(
  ws: string,
  opts: { commit?: boolean; map?: Record<string, string> } = {},
  cfg: WikiConfig = getConfig(ws),
): MigrateResult {
  const wiki = wikiDir(ws);
  const root = resolve(ws);
  if (!repoDirExists(root, join("docs", "wiki"))) return { verdict: "skip", reason: "no docs/wiki" };
  const { pairs, strays } = planPairs(root, cfg, opts.map ?? {});

  if (!pairs.length) {
    // structure already conforms → just (re)stamp the snapshot on commit so reverse-drift
    // detection has a baseline even for wikis created before this feature.
    if (opts.commit) writeRepoFile(ws, join("docs", "wiki", SCHEMA_VERSION_FILE), schemaSnapshot(cfg) + "\n");
    const swept = dropEmptyStrays(ws, root, strays, Boolean(opts.commit));
    return { verdict: "conforms", strays: swept.kept, straysRemoved: swept.removed };
  }

  // plan: count link rewrites without touching disk
  let links = 0;
  let domains = 0;
  const pageEdits: { path: string; content: string }[] = [];
  for (const rel of allPages(root)) {
    let content = readRepoFile(root, rel);
    if (content === null) continue;
    let touched = false;
    for (const pair of pairs) {
      const [next, n] = rewriteLinks(content, pair.from, pair.to);
      if (n) {
        content = next;
        links += n;
        touched = true;
      }
    }
    // frontmatter domain update — only pages living inside a renamed category dir
    const owner = pairs.find((pair) => rel.startsWith(`docs/wiki/${pair.from}/`));
    if (owner?.domain) {
      const next = content.replace(/^domain:\s*\S+$/m, `domain: ${owner.domain}`);
      if (next !== content) {
        content = next;
        domains += 1;
        touched = true;
      }
    }
    if (touched) pageEdits.push({ path: join(root, rel), content });
  }

  // The quiz ledger stores page identities as BARE wiki-relative paths — none of rewriteLinks'
  // three token forms. Without a remap, every renamed category's entries turn "missing", get
  // pruned, and restart as new: silent loss of the box/due history the quiz layer exists to
  // accumulate (quiz.ts). Ledgers are per person (quiz-ledger.<id>.md; the bare pre-identity
  // name included) — every one found is remapped. Planned here, written after the dir renames.
  const quizDirPath = join(wiki, cfg.quizDir);
  const ledgers: { file: string; entries: QuizEntry[]; remapped: number }[] = [];
  if (repoDirExists(root, join("docs", "wiki", cfg.quizDir))) {
    for (const f of readRepoDir(root, join("docs", "wiki", cfg.quizDir))
      .filter((entry) => entry.isFile && /^quiz-ledger.*\.md$/.test(entry.name))
      .map((entry) => entry.name)) {
      const file = join(quizDirPath, f);
      try {
        const body = readRepoFile(root, repoRelative(root, file));
        if (body === null) continue;
        const entries = parseLedger(body);
        let remapped = 0;
        for (const e of entries) {
          const owner = pairs.find((pair) => e.page.startsWith(pair.from + "/"));
          if (owner) {
            e.page = owner.to + e.page.slice(owner.from.length);
            remapped += 1;
          }
        }
        if (remapped) ledgers.push({ file, entries, remapped });
      } catch {
        // fail-safe: an unparsable ledger never aborts a migrate; its entries stay untouched
      }
    }
  }
  const ledgerRemapped = ledgers.reduce((n, l) => n + l.remapped, 0);

  if (!opts.commit) {
    return { verdict: "planned", pairs, strays, linksRewritten: links, domainsRewritten: domains, quizLedgerRemapped: ledgerRemapped };
  }

  // apply: page rewrites first (paths still old), then dir renames, then snapshot + reindex + lint
  for (const e of pageEdits) writeRepoFile(ws, repoRelative(ws, e.path), e.content);
  for (const pair of pairs) {
    const from = join(wiki, pair.from);
    const to = join(wiki, pair.to);
    // Both sides go through the boundary: a category folder is repository content, and a
    // symlinked one must not be renamed (or written through) during a migration.
    if (repoDirExists(root, join("docs", "wiki", pair.to))) {
      // target exists (partially migrated) → move children instead of clobbering, then drop the
      // emptied husk — left behind it would nag as "unmapped" on every later dry-run forever
      for (const entry of readRepoDir(root, join("docs", "wiki", pair.from))) {
        renameRepoPath(ws, join("docs", "wiki", pair.from, entry.name), join("docs", "wiki", pair.to, entry.name));
      }
      removeEmptyRepoDir(ws, join("docs", "wiki", pair.from));
    } else {
      renameRepoPath(ws, join("docs", "wiki", pair.from), join("docs", "wiki", pair.to));
    }
  }
  for (const l of ledgers) {
    writeRepoFile(ws, repoRelative(ws, l.file), renderLedger(l.entries, today(), resolveLang(cfg)));
  }
  writeRepoFile(ws, join("docs", "wiki", SCHEMA_VERSION_FILE), schemaSnapshot(cfg) + "\n");
  const swept = dropEmptyStrays(ws, root, strays, true);

  const idx = new WikiIndex(ws);
  idx.indexAll();
  autoRegisterCitedTranscripts(idx);
  const conn = idx.connect();
  for (const d of idx.listDocumentsWithContent(conn).filter((x) => String(x.relative_path).includes("docs/wiki/"))) {
    updateReferences(idx, conn, d as any, (d.content as string) || "");
  }
  const [issues] = new Linter(idx as unknown as WikiIndexLike, conn, cfg).run();
  conn.close();
  return {
    verdict: "migrated",
    pairs,
    strays: swept.kept,
    straysRemoved: swept.removed,
    linksRewritten: links,
    domainsRewritten: domains,
    quizLedgerRemapped: ledgerRemapped,
    lintErrors: issues.filter((i) => i.severity === "error").length,
  };
}

// One-line structure-drift detection for cold-start/doctor. Two directions:
//   forward:  on-disk numbered dirs differ from the config (someone changed the config) → migrate
//   reverse:  the wiki's committed .schema-version differs from MY engine's config (I am the
//             stale one) → pull the team engine fork (or migrate if the config is the newer truth)
// Returns null when clean. Fail-safe by construction (pure reads).
export function detectConfigDrift(ws: string, cfg: WikiConfig = getConfig(ws)): string | null {
  const wiki = wikiDir(ws);
  const root = resolve(ws);
  if (!repoDirExists(root, join("docs", "wiki"))) return null;
  const { pairs } = planPairs(root, cfg, {});
  if (pairs.length) {
    const preview = pairs.map((p) => `${p.from}→${p.to}`).join(", ");
    return `structure drift: ${preview} — run \`llmwiki migrate <repo>\` (dry-run) then \`--commit\``;
  }
  const svPath = join(wiki, SCHEMA_VERSION_FILE);
  if (repoFileExists(root, join("docs", "wiki", SCHEMA_VERSION_FILE))) {
    try {
      const body = readRepoFile(root, join("docs", "wiki", SCHEMA_VERSION_FILE));
      if (body === null) return null;
      const disk = JSON.stringify(JSON.parse(body));
      if (disk !== JSON.stringify(JSON.parse(schemaSnapshot(cfg)))) {
        return `wiki ${SCHEMA_VERSION_FILE} differs from this engine's config — pull the team engine fork, or run \`llmwiki migrate\` if the config is the newer truth`;
      }
    } catch {
      /* unreadable snapshot → stay silent */
    }
  }
  return null;
}
