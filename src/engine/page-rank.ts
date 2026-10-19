// Wiki page ranking for natural-language questions — the retrieval behind turn-context pointers
// and `llmwiki search --kind wiki`.
//
// Why not the FTS index alone: its trigram tokenizer cannot see a two-character word, and two
// characters is what most Korean technical vocabulary is (토큰·배포·검수); a strict all-terms MATCH
// almost never holds for a whole sentence; and its OR fallback weighs a particle-glued token
// ("파일을") like a content word. Measured on 4 long-lived project wikis (120 dev questions, one per
// sampled page; 28 held-out questions written blind from the same wikis): the FTS path found the
// right page in its top 5 for 69% / 75%; this ranker for 92% / 89%.
//
// How: parsed pages are cached behind a per-file metadata fingerprint; each prompt term
// is matched by SUBSTRING (so a josa-free stem matches its glued forms and 2-char words count), and
// the score is BM25-shaped — term rarity across the wiki (idf) × saturating in-page frequency with
// mild length normalization — plus a bonus when the term names the page itself (title · filename ·
// description). Deterministic, no index, no model.
//
// Trigger text: a page may declare what a FUTURE request would say, not just what the page is
// called — `x-llmwiki: { rule, recall: [...] }` (an OKF producer extension, edit-rules.ts). Measured
// 2026-10-14: on 4 e2e scenarios the prompt and the deciding page shared no title words ("Figma
// fetch_nodes 추가" vs a rule about outbound httpx User-Agent), so the decision was pointed at 0/4.
// The rule line and the recall phrases are matched like identity, at a higher weight: an author
// wrote them as triggers. Page metadata invalidates the parse cache, so a new recall line works
// at once — there is no index to rebuild (the trigram FTS is not this ranker's input).
import { sourceChangedPages } from "./source-freshness.ts";
import { reportedWrongPages } from "./reported-wrong.ts";
import { posix } from "node:path";
import { getConfig, type WikiConfig } from "./config.ts";
import { EDIT_RULE_KEY, RULE_MAX_CHARS } from "./edit-rules.ts";
import { isRetired, isStale, parseYamlBlock, splitFrontmatter, type YamlMap } from "./okf.ts";
import { readRepoFile } from "./repo-write.ts";
import { cachedWikiPages, type ParsedWikiPage } from "./wiki-page-cache.ts";
import { extractTerms, subFloorTerms, termWeight } from "./query-terms.ts";

const WIKI_REL = "docs/wiki";
const K1 = 1.2;
const B = 0.25; // length normalization: wiki pages vary a lot in length, but a long page is rarely padding
const REF_LEN = 3000; // characters; the reference body length the normalization is relative to
const IDENTITY_BONUS = 1.5; // a term in the title/filename/description, on top of body frequency
// A term in the declared trigger text (x-llmwiki rule · recall). Twice identity: one rare trigger
// hit alone must clear the relevance floor (1.5·ln(1+N)) on a few-hundred-page wiki, which an
// identity hit (1.5·idf) does not — a recall phrase exists precisely for the prompt that shares
// nothing else with the page.
const TRIGGER_BONUS = 3;
const TAG_BONUS = 1; // explicit topic metadata, below title/description identity weight

export type WikiPage = {
  readonly rel: string; // bundle-relative, e.g. 3_decision/x.md
  readonly title: string;
  readonly description: string;
  readonly type?: string; // OKF descriptive type; absent/unknown types remain searchable
  readonly tags?: string; // lower-cased descriptive tags, kept separate from title provenance
  readonly status: string;
  readonly identity: string; // lower-cased title · filename · description, plus a despaced copy
  readonly trigger: string; // lower-cased x-llmwiki rule · recall phrases, plus a despaced copy
  readonly rule: string; // the x-llmwiki rule line as written (whitespace collapsed), or ""
  readonly retired: boolean; // deprecated / superseded / has a successor (okf.ts isRetired)
  readonly stale: boolean; // OKF stale_after has passed
  readonly sourceChanged?: boolean; // indexed cited/linked source changed; needs verification, not proven false
  readonly reportedWrong?: boolean; // explicit self-assessment; awaits grounded recheck
  readonly snippetBody?: string; // original casing for display; never populated for cold-tier bodies
  readonly body: string; // lower-cased body without evidence-excerpt lines
};

export type RankedPage = {
  readonly page: WikiPage;
  /** BM25-shaped relevance; the order key. */
  readonly relevance: number;
  /** The historical confidence gate's score: distinct matched terms, identity terms worth 2. */
  readonly coverage: number;
  /** Matched terms (lower-cased). */
  readonly terms: ReadonlySet<string>;
  /** Matched terms at or above the trigram floor that name the page itself. */
  readonly idTerms: ReadonlySet<string>;
  /** Every matched term found in the page identity (for the pointer's "why"). */
  readonly shownIdTerms: ReadonlySet<string>;
};

const EVIDENCE_LINE = /^[ \t]{2,}>[ \t].*$/gm;

const despaced = (s: string): string => `${s} ${s.replace(/[\s-]+/g, "")}`;

/** The page's `x-llmwiki` rule and recall phrases; malformed shapes contribute nothing. */
function triggersOf(fm: YamlMap): { rule: string; recall: string[] } {
  const x = fm[EDIT_RULE_KEY];
  if (typeof x !== "object" || x === null || Array.isArray(x)) return { rule: "", recall: [] };
  const v = x as YamlMap;
  let rule = typeof v.rule === "string" ? v.rule.trim().replace(/\s+/g, " ") : "";
  if (rule.length > RULE_MAX_CHARS) rule = ""; // Never inject an instruction with its exception truncated.
  const recall = [v.recall].flat().filter((r): r is string => typeof r === "string" && r.trim() !== "").map((r) => r.trim());
  return { rule, recall };
}

/** Parse all non-hidden Markdown, independent of the caller's config and skip list. */
function parseWikiPages(root: string, paths: readonly string[]): ParsedWikiPage[] {
  const out: ParsedWikiPage[] = [];
  for (const child of paths) {
    const name = posix.basename(child);
    const text = readRepoFile(root, `${WIKI_REL}/${child}`);
    if (text === null) continue;
    const { block, body } = splitFrontmatter(text);
    const fm = block === null ? {} : parseYamlBlock(block).data;
    const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : posix.basename(name, ".md");
    const description = typeof fm.description === "string" ? fm.description : "";
    // Cold-tier pages remain discoverable by identity, tags and keywords; bodies stay hidden.
    const cold = fm.tier === "cold";
    const extra = cold ? ` ${[fm.keywords].flat().filter((x) => typeof x === "string").join(" ")}` : "";
    const tags = [fm.tags].flat().filter((x): x is string => typeof x === "string").join(" ").toLowerCase();
    const id = `${title} ${name.replace(/\.md$/, "")} ${description}${extra}`.toLowerCase();
    const { rule, recall } = triggersOf(fm);
    const trig = [rule, ...recall].join(" ").toLowerCase();
    const snippetBody = cold ? "" : body.replace(EVIDENCE_LINE, "");
    out.push({
      rel: child, title, description,
      type: typeof fm.type === "string" ? fm.type.trim() : "",
      tags: tags ? despaced(tags) : "",
      status: String(fm.status ?? ""),
      identity: despaced(id), trigger: trig ? despaced(trig) : "", rule,
      retired: isRetired(fm),
      ...(typeof fm.stale_after === "string" ? { staleAfter: fm.stale_after } : {}),
      snippetBody, body: snippetBody.toLowerCase(),
    });
  }
  return out;
}

/** The wiki's knowledge pages: reserved files, the queue and the quiz layer excluded. */
export function loadWikiPages(root: string, cfg: WikiConfig = getConfig(root), skip: ReadonlySet<string> = new Set()): WikiPage[] {
  const hiddenDirs = new Set([cfg.queueDir, cfg.quizDir]);
  const reserved = new Set(["index.md", "log.md", "cold-index.md", cfg.files.log]);
  const changedSources = sourceChangedPages(root);
  const reportedWrong = reportedWrongPages(root);
  return cachedWikiPages(root, parseWikiPages)
    .filter((p) => !hiddenDirs.has(p.rel.split("/")[0]!) && !reserved.has(posix.basename(p.rel)) && !skip.has(posix.basename(p.rel)))
    .map(({ staleAfter, ...p }) => ({
      ...p,
      stale: isStale({ stale_after: staleAfter }),
      sourceChanged: changedSources.has(`${WIKI_REL}/${p.rel}`),
      ...(reportedWrong.has(`${WIKI_REL}/${p.rel}`) ? { reportedWrong: true } : {}),
    }));
}

function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) n += 1;
  return n;
}

/** The terms a prompt is ranked by: the trigram-floor terms plus the two-character words below it. */
export function promptTerms(prompt: string): { terms: string[]; subFloor: string[] } {
  const terms = extractTerms(prompt ?? "");
  const subFloor = subFloorTerms(prompt ?? "", terms);
  return { terms, subFloor };
}

/**
 * Rank `pages` for the given terms. Only pages matching at least one term are returned, best first.
 * `carried` terms (earlier turns of the session) add relevance but are never shown as a reason.
 */
export function rankPages(pages: readonly WikiPage[], queryTerms: readonly string[]): RankedPage[] {
  const terms = [...new Set(queryTerms.map((t) => t.toLowerCase()))].filter(Boolean);
  if (!terms.length || !pages.length) return [];
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, pages.filter((p) => p.identity.includes(t) || p.trigger.includes(t) || p.tags?.includes(t) || p.body.includes(t)).length);
  const n = pages.length;
  const out: RankedPage[] = [];
  for (const page of pages) {
    let relevance = 0;
    let coverage = 0;
    const matched = new Set<string>();
    const idTerms = new Set<string>();
    const shownIdTerms = new Set<string>();
    const lengthNorm = 1 - B + (B * page.body.length) / REF_LEN;
    for (const t of terms) {
      const inIdentity = page.identity.includes(t);
      const inTrigger = page.trigger.includes(t);
      const inTags = page.tags?.includes(t) ?? false;
      const tf = occurrences(page.body, t);
      if (!inIdentity && !inTrigger && !inTags && !tf) continue;
      const idf = Math.log(1 + n / (1 + (df.get(t) ?? 0)));
      const named = inTrigger ? TRIGGER_BONUS : inIdentity ? IDENTITY_BONUS : inTags ? TAG_BONUS : 0;
      relevance += idf * (named + (tf ? (tf * (K1 + 1)) / (tf + K1 * lengthNorm) : 0));
      matched.add(t);
      // The confidence gate keeps its measured rules: identity promotion only at or above the
      // trigram floor (a 2-char word in a title is everyday vocabulary, a measured false positive).
      // A trigger or explicit tag identifies the page. The pointer's "titled:" reason stays
      // title-only — a recall phrase is not what the page is called.
      const promoted = (inIdentity || inTrigger || inTags) && [...t].length >= (/^[\x00-\x7F]+$/.test(t) ? 4 : 3);
      if (promoted) idTerms.add(t);
      if (inIdentity) shownIdTerms.add(t);
      coverage += promoted ? 2 : termWeight(t);
    }
    if (matched.size) out.push({ page, relevance, coverage, terms: matched, idTerms, shownIdTerms });
  }
  return out.sort((a, b) => b.relevance - a.relevance || b.coverage - a.coverage || (a.page.rel < b.page.rel ? -1 : 1));
}

/** `llmwiki search --kind wiki`: the top pages for a natural-language query, best first. */
export function searchWiki(root: string, query: string, limit: number): RankedPage[] {
  const { terms, subFloor } = promptTerms(query);
  return rankPages(loadWikiPages(root), [...terms, ...subFloor]).slice(0, limit);
}

/** The body line that best shows why a page matched: the line holding the most matched terms. */
export function matchSnippet(page: WikiPage, terms: ReadonlySet<string>, max = 200): string {
  let best = "";
  let bestHits = 0;
  for (const line of (page.snippetBody ?? page.body).split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("[^")) continue;
    const hits = [...terms].filter((t) => l.toLowerCase().includes(t.toLowerCase())).length;
    if (hits > bestHits) {
      best = l;
      bestHits = hits;
    }
  }
  return (best || page.description).replace(/\s+/g, " ").slice(0, max);
}
