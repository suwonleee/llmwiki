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
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getConfig, type WikiConfig } from "./config.ts";
import { WikiIndex } from "./db.ts";
import { updateReferences, autoRegisterCitedTranscripts } from "./refs.ts";
import { Linter, type WikiIndexLike } from "./lint.ts";

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
  linksRewritten?: number;
  domainsRewritten?: number;
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

function numberedDirsOnDisk(wiki: string): string[] {
  try {
    // sorted → deterministic pairing/reporting regardless of filesystem readdir order
    return readdirSync(wiki)
      .filter((d) => /^\d+_/.test(d) && statSync(join(wiki, d)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

function leadingNum(dir: string): string {
  return dir.split("_", 1)[0]!;
}

// All .md files under docs/wiki (recursive) — link rewriting scans everything, including the
// queue and topic layers, so no page keeps a dangling link after a rename.
function allPages(wiki: string, dir = wiki, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) allPages(wiki, p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

function planPairs(wiki: string, cfg: WikiConfig, explicit: Record<string, string>): { pairs: Pair[]; strays: string[] } {
  const expected = new Set([...cfg.categories.map((c) => c.dir), cfg.topicDir, cfg.queueDir]);
  const onDisk = numberedDirsOnDisk(wiki);
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

export function migrate(
  ws: string,
  opts: { commit?: boolean; map?: Record<string, string> } = {},
  cfg: WikiConfig = getConfig(ws),
): MigrateResult {
  const wiki = wikiDir(ws);
  if (!existsSync(wiki)) return { verdict: "skip", reason: "no docs/wiki" };
  const { pairs, strays } = planPairs(wiki, cfg, opts.map ?? {});

  if (!pairs.length) {
    // structure already conforms → just (re)stamp the snapshot on commit so reverse-drift
    // detection has a baseline even for wikis created before this feature.
    if (opts.commit) writeFileSync(join(wiki, SCHEMA_VERSION_FILE), schemaSnapshot(cfg) + "\n", "utf-8");
    return { verdict: "conforms", strays };
  }

  // plan: count link rewrites without touching disk
  let links = 0;
  let domains = 0;
  const pageEdits: { path: string; content: string }[] = [];
  for (const p of allPages(wiki)) {
    let content = readFileSync(p, "utf-8");
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
    const owner = pairs.find((pair) => p.startsWith(join(wiki, pair.from) + "/"));
    if (owner?.domain) {
      const next = content.replace(/^domain:\s*\S+$/m, `domain: ${owner.domain}`);
      if (next !== content) {
        content = next;
        domains += 1;
        touched = true;
      }
    }
    if (touched) pageEdits.push({ path: p, content });
  }

  if (!opts.commit) {
    return { verdict: "planned", pairs, strays, linksRewritten: links, domainsRewritten: domains };
  }

  // apply: page rewrites first (paths still old), then dir renames, then snapshot + reindex + lint
  for (const e of pageEdits) writeFileSync(e.path, e.content, "utf-8");
  for (const pair of pairs) {
    const from = join(wiki, pair.from);
    const to = join(wiki, pair.to);
    if (existsSync(to)) {
      // target exists (partially migrated) → move children instead of clobbering
      for (const f of readdirSync(from)) renameSync(join(from, f), join(to, f));
    } else {
      renameSync(from, to);
    }
  }
  writeFileSync(join(wiki, SCHEMA_VERSION_FILE), schemaSnapshot(cfg) + "\n", "utf-8");

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
    strays,
    linksRewritten: links,
    domainsRewritten: domains,
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
  if (!existsSync(wiki)) return null;
  const { pairs } = planPairs(wiki, cfg, {});
  if (pairs.length) {
    const preview = pairs.map((p) => `${p.from}→${p.to}`).join(", ");
    return `structure drift: ${preview} — run \`llmwiki migrate <repo>\` (dry-run) then \`--commit\``;
  }
  const svPath = join(wiki, SCHEMA_VERSION_FILE);
  if (existsSync(svPath)) {
    try {
      const disk = JSON.stringify(JSON.parse(readFileSync(svPath, "utf-8")));
      if (disk !== JSON.stringify(JSON.parse(schemaSnapshot(cfg)))) {
        return `wiki ${SCHEMA_VERSION_FILE} differs from this engine's config — pull the team engine fork, or run \`llmwiki migrate\` if the config is the newer truth`;
      }
    } catch {
      /* unreadable snapshot → stay silent */
    }
  }
  return null;
}
