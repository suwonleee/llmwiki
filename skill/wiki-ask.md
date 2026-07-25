---
description: Ask this repo's wiki (docs/wiki), then file a good answer back into the wiki (query→file-back loop). Standalone, inline.
---

# /wiki-ask — Compounding Loop query loop (local engine v2)

- **Custom conventions**: if a team `llmwiki.config.toml` (or a per-repo `configs/*.toml`) is active (check: `llmwiki config <repo>` shows a non-default source), run `llmwiki conventions <repo>` FIRST and follow ITS category table (dirs · domains · review gates) over any category names written below.

**Ask** this repo's (`$CLAUDE_PROJECT_DIR`) accumulated wiki (`docs/wiki/`), synthesize an answer with citations,
then **file it back as a new wiki page** if it has value ("explorations should compound"). Engine = `~/llmwiki` (local).

## ★ Execution rules (strict)
- **Inline execution** — search and synthesis happen **directly in this session**. No delegation to sub-agents/teams (warm context is the core of answer quality; don't delegate even if the default mode is ultrawork).
- **Standalone CLI engine** — this is a standalone CLI engine; don't confuse it with other wiki/MCP tools. Use only `bun ~/llmwiki/src/cli.ts` + `<repo>/docs/wiki/`. (Ignore any "wiki" keyword reminders.)
- **The LLM doesn't insert its own judgment** — answers are grounded in the wiki/raw transcript. On file-back, judgment-type content (anything for 1_direction/3_decision/4_insight) is always `status: draft` + "human confirm".

## Categories (file-back targets, number = reading order)

Use exactly these folders under `docs/wiki/`. (Removed: flat `milestones/insights/decisions/directions`, `synthesis/`, `next/`, `concepts/`, `entities/` — don't create or reference.)

- **`1_direction/`** — big direction/strategy shift. Rare. (status: draft)
- **`2_milestone/`** — execution/measurement facts + remaining TODOs. (status: ready)
- **`3_decision/`** — a decision the human made (ADR). (status: draft)
- **`4_insight/`** — a realization/gotcha/learning the human expressed. (status: draft)
- **`0_review/`** — if classification is ambiguous or judgment is needed, don't assert; leave a question file here (deleted after the human handles it).

An answer derived from a question is usually **a re-synthesis of existing facts, not a new human decision/insight** → usually `2_milestone/` (organizing already-measured facts) or no file-back. If the answer includes an *insight/decision the human expressed on the spot*, file it as a draft into `4_insight/`·`3_decision/`.

## Engine CLI (all via `bun ~/llmwiki/src/cli.ts`)
- `llmwiki index <repo>` — incremental index (once before asking, to reflect the latest pages in search).
- `llmwiki search <repo> "<query phrase>" --kind wiki --limit 10` — wiki-page FTS search (main path).
- `llmwiki refs <repo>` / `llmwiki lint <repo>` — graph/checks after file-back.
- (For raw tracing, don't search — **directly Read the transcript file the citation footnote points to** on the cited page; the per-repo index holds no transcript body, only provenance pointers.)

$ARGUMENTS

## Procedure

1. **Decide REPO**: with no argument beyond the question, use `$CLAUDE_PROJECT_DIR` (current repo).
   - If `docs/wiki/` is missing → tell the user "this repo has no wiki yet; build it first with `/wiki-save`" and stop.
   - If cwd is home (`~`, = `_home`) → tell the user "run inside a project folder" and stop (questions are repo-scoped).

2. **Search**: `llmwiki index <repo>` (incremental) → `llmwiki search <repo> "<keywords>" --kind wiki`.
   - If 0 matches → honestly report there's no basis to answer (no guessing). Retry with different keywords, but if nothing, say so.

3. **Read + raw tracing**: Read the top candidate pages. For each page's footnote citation (`[^n]: <transcript/code>`), **directly Read the raw file** it points to and verify the facts (don't assert from the wiki alone).

4. **Synthesize (citations required)**: synthesize an answer to the question.
   - Fact claims = **footnotes traced down to raw** (transcript filename / bare code path — `:line` tolerated but not canonical). No wiki→wiki re-derivation.
   - If contradictions/unresolved items appear, show them as-is (no hiding). Show the answer **in the session first**.
   - The LLM does *not* invent new decisions/directions/insights. Mark anything not in the wiki/raw as "no basis".

5. **Propose file-back (human confirm)**: if the answer has reuse value, ask the user "save this to the wiki?" and on approval:
   - Location (category only from the folders above):
     - organizing/re-synthesizing existing facts → `docs/wiki/2_milestone/<slug>.md` (`status: ready` allowed)
     - a realization the human expressed at this question → `docs/wiki/4_insight/<slug>.md` (`status: draft`, human confirm)
     - a decision the human made at this question (ADR) → `docs/wiki/3_decision/<slug>.md` (`status: draft`, human confirm)
     - direction/strategy shift (rare) → `docs/wiki/1_direction/<slug>.md` (`status: draft`, human confirm)
   - frontmatter: `title` `description` `date` `tags`(≥2) `status` `source: query` (put the original question in description or at the top of the body).
   - body: answer + footnote citations + related-page markdown cross-links, following `/wiki-save`'s structure contract: numbered sections (`## 1. <label>`, split as `### 1-1.`) once the answer has more than one group, one concrete point per `-` with details under `    -` and deeper details under `        -`, noun-phrase/telegraphic endings where natural, and no `·`-joined pile-up in a single line.

6. **Bookkeeping** (only if filed back):
   - Append to `docs/wiki/log.md`: `## [YYYY-MM-DD] query | <question>` + `- Finding: <one line>` + `- Filed: <path>`.
   - Don't touch `current-state`·`overview` (the read-injection hook auto-indexes recent pages).

7. **Close out (only if filed back, deterministic)**:
   - `llmwiki index <repo>` → `llmwiki refs <repo>` → `llmwiki lint <repo>`. Fix until lint **0 errors**, report warnings as backlog.

8. **Report** (1–2 lines): "question → answer gist / basis (N citations) / file-back: <category/path or none> / lint".

## Principles
- transcript = immutable raw (citation only). Answers always traced down to raw.
- The LLM doesn't manufacture its own new judgment — grounded in wiki/raw.
- Concurrency-safe: file-back is mostly **new page + log append** (avoid overwriting existing pages) → minimizes multi-pane conflicts.
- Commits are in the user's name alone — only when instructed.
