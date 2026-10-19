---
name: wiki-save
disable-model-invocation: true
description: Fast warm close-out — preserve THIS session’s decisions, contracts, failure lessons and evidence; refresh L0 and active rules, append the log, run deterministic checks. Topic consolidation, overview, review and gaps belong to `/wiki-deep`
---

> Engine invocation — resolve it ONCE, in this order, and use the first that exists:
> 1. `bun "<plugin-root>/src/cli.ts"`, where `<plugin-root>` is the directory TWO levels above
>    this skill's base directory (skills/<name>/ → plugin root). This is the plugin and clone
>    install — the normal case. Stop here when that file exists.
> 2. `bun "$LLMWIKI_ROOT/src/cli.ts"` when `LLMWIKI_ROOT` is set — a host that copied this
>    skill folder OUT of the plugin (OpenClaw, Hermes, `skills add`) leaves step 1 pointing at
>    that host's skills directory, not at an engine.
> 3. `llmwiki` on PATH — the launcher `setup.sh` writes to `~/.local/bin`, or the npm bin.
>
> If none of the three resolve, say so once and stop. Do NOT guess a path: the engine writes
> into a repository, and a guessed root writes into the wrong one. Every `llmwiki …` or
> engine-CLI reference below means the invocation you resolved here.

# /wiki-save — session close-out (warm, human-present)

File **THIS session** in warm context and refresh **L0**. Volume work belongs to `/wiki-deep`; an un-filed session ageing out is self-selection (save-rationale §3).

Load named sections only when needed (`llmwiki conventions <repo> --section <name>`). Rationale: `llmwiki conventions <repo> --section save-rationale`; command semantics: `llmwiki conventions <repo> --section cli`.

Two layers: the **log** (`2_milestone`·`3_decision`·`4_insight` — one immutable entry per session) and the **topic encyclopedia** (`5_topic` — one living page per concept, merged in place). Promotion is log → topic only.

## ★ Execution rules
- **Custom conventions**: if a team `llmwiki.config.toml` (or a per-repo `configs/*.toml`) is active (check: `llmwiki config <repo>` shows a non-default source), run `llmwiki conventions <repo>` FIRST and follow ITS category table (dirs · types · review gates) over any category names written below and in any `--section` output.
- **Inline, warm** — no sub-agent delegation (context is quality). A subagent asked for a long document WRITES it to a scratchpad file and returns only the path (inline return only if that file is missing/empty).
- **This is the write moment**: cold-start rule 3 defers ALL mid-session page-writing to here, so sweep the WHOLE session.
- **Standalone CLI engine** — only `bun "<plugin-root>/src/cli.ts"` (`llmwiki` below) + `<repo>/docs/wiki/`; no other wiki/MCP tools.
- **Routine judgment by the strong model, only direction by the human**: classification, grounding checks, topic merges, and decision/insight confirmation are decided *directly* as `status: stable` — no one-by-one checks with the human. **Never fabricate ungrounded claims — omit** them. Only **direction shifts** and **unresolved contradictions** go to `0_review`.
- **Latency contract**: O(this session), never O(backlog)/O(wiki). Topic consolidation, overview, semantic review and gaps run only in `/wiki-deep`, never in this fast lane. No unattended transcript consumption or background model call.
- **Single-purpose**: finish or queue unrelated work (review fixes, tests, commits) BEFORE starting. If the user declines a save offer, record `llmwiki save-event <repo> --session <exact id> --event declined` once; do not ask again. A missing exact ID means skip the event, never infer one.
- **Validate as you write**: after each page write, `llmwiki lint <repo> --path '<page path under docs/wiki>' --errors-only`; fix findings NOW.
- **Secrets never enter a page**: no credential/token values, private endpoints, or personal data in prose or 0_review drafts — name and cite the thing instead (`SLACK_TOKEN: issued, stored in 1Password`; placeholders like `API_KEY=<your-key>` are fine). `page-secret`/`excerpt-secret` lint errors are fixed by removing the VALUE, never the claim or its citation.
- **Routine filing, routine reasoning**; depth only for contradictions, judgment-bearing merges, direction shifts.

## Categories (number = reading order)

Exactly these folders under `docs/wiki/` — never `concepts/`, `entities/`, `synthesis/`, `next/`, `milestones/`. Empty → no page.

- **`1_direction/`** — big direction/strategy shift (from→to, why). Rare. **Human-judgment** → confirm via `0_review`. `status: draft`.
- **`2_milestone/`** — progress + what's next (built/changed/measured + remaining TODOs). `status: stable`.
- **`3_decision/`** — problem → alternatives → choice (ADR: context · decision · alternatives · consequences). Strong-model-confirmed after a grounding check. `status: stable`.
- **`4_insight/`** — realizations·gotchas·wins. Strong-model-confirmed. `status: stable`.
- **`5_topic/`** — **topic encyclopedia** (concepts/modules/patterns, NOT people). Built only by consolidation.
- **`0_review/`** — **direction shifts + unresolved contradictions only**; resolved → apply, delete the file. Every item stamps `owner:` (`gh api user --jq .login` → git fallbacks); format: `llmwiki conventions <repo> --section review-item`.

## Writing rules (every page)

- The human doesn't hand-write the wiki. **The LLM writes all categories** — *summarizing* what the human decided/realized, grounded in the transcript. **Never *fabricate***: `decision`/`insight` hold only what *the human expressed*. Test: **useful to the next session?** No filler.
- SAME language as the session (or existing pages) — never translate; code identifiers, paths, API names, CLI commands, config keys, error strings stay VERBATIM, never transliterated.
- **Body**: numbered sections `## 1. <label>` (`### 1-1. <label>` only for real parts); one point per `-` line, supporting detail at `    -`, deeper detail at `        -`, no fourth level; more than three enumerated items → child bullets; a short single-group page stays a bare bullet list. Prefer noun phrases or telegraphic endings. Before the first page of this pass: `llmwiki conventions <repo> --section writing`.
- **Frontmatter** (OKF v0.2): `type` (the folder's) `title` `description` `date` `tags`(≥2) `status`(stable|draft|deprecated) `generated` `sources` — shapes: citations section; **never `author:`** (git owns authorship); no `domain:`/`source:`/`updated:`. **Links**: relative markdown `[Label](../5_topic/x.md)`, never `[[wikilinks]]`; cross-link related pages.
- **Citations**: every fact/judgment claim has a footnote `[^1]: <transcript>.jsonl` or one bare repo-relative path; the definition line stays bare. The evidence quote goes on the NEXT line, indented 4 spaces, from `llmwiki excerpt <transcript.jsonl> --kind judgment|fact` — never from memory. Before the first footnote of this pass: `llmwiki conventions <repo> --section citations`.

## Topic consolidation

In `/wiki-deep`, at the first candidate concept: `llmwiki conventions <repo> --section consolidate`. Its invariants always hold:
- **Selective** — only recurring, explicitly durable, or decision/direction-tied concepts; episodic stays in the log (unsure → log).
- **Add, never rewrite** — new fact = new bullet with its own citation; every existing grounded line preserved verbatim.
- **Re-ground from raw** — transcript / raw evidence only, **never re-summarize other wiki pages**.
- **Never overwrite a contradiction** — `> [conflict]` callout; direction-level → `0_review`.

$ARGUMENTS

## Procedure (warm close-out)

1. **REPO = the repo this session's WORK concerned** — normally cwd (`$CLAUDE_PROJECT_DIR`; argument none/`here` = current repo, or another repo's path). Work from a catch-basin cwd into another enrolled repo files into THAT repo. No `docs/wiki/` → `llmwiki skeleton <repo>`, then proceed.

1b. **0_review first (announce, apply, delete)**: announce existing `docs/wiki/0_review/*.md` ("0_review: N items — <titles>"). **Engine-managed, NOT Q./A. items — never delete here**: `gap-queue.md`, `semantic-review-*.md`. Every other item: `A.` answered → apply its `Draft`/resolution (or discard) and **delete the file**; empty → show the `Q.`, get the answer, apply, delete. A human-confirmed direction in `1_direction/` stamps `verified: { by: human:<owner login>, at: <ISO> }` — never for your own confirmation. Afterwards `0_review/` holds no Q./A. items.

2. **File THIS session into the log** — selection is **EXACT, never nearest**:
   - **Resolve the current session id** (harness-provided, never inferred from recency):
     - Claude Code: run `printf '%s\n' "${CLAUDE_SESSION_ID:-$CLAUDE_CODE_SESSION_ID}"` in Bash.
     - OpenCode: the `[llmwiki] current OpenCode session id: …` line the plugin injected.
     - Codex: `session_id` from the hook payload in context.
   - `llmwiki save-current <repo> --session <that id>` — exact-identity resolve + enqueue (no 50-line threshold); prints the paths.
   - **save-current fails (no exact match) → file NOTHING for this session**; report it and continue. Never fall back to the newest pending entry or another transcript.
   - `llmwiki update-status <repo>` → **only the path(s) save-current printed** → `llmwiki update-next <repo> <transcript>` (unprocessed part only; first line `cwd/session/new_offset`). Judge from the extract alone — never load the full transcript into context; a harness-summary block is draft material, every claim is grounded in the raw extract.
   - **Route check first**: `# touched:` lists the git roots this segment mutated; `# ⚠ route:` means the dominant root is NOT this repo → file into that repo's wiki, then `llmwiki update-done <bucket-repo> <transcript> <offset>` where it is queued.
   - Take **only what the human said/decided/realized**; discard model analysis. Route:
     - results/measurements + remaining TODOs → `2_milestone/` (numbers in the TL;DR)
     - a realization/gotcha → `4_insight/`; a decision → `3_decision/` (ADR) — grounded → **the strong model confirms `status: stable`**
     - **ambiguous classification → the strong model picks the best-fit folder** (not 0_review)
     - **only an actual direction shift** → a Q./A. item in `0_review/` (`llmwiki conventions <repo> --section review-item`); its transcript **does not advance its watermark** (it reappears)
     - not grounded → omit; noise → no page, `update-done --skipped`
   - `llmwiki update-done <repo> <transcript> <new_offset>`. **Leave the rest of the backlog pending, report its count** — never drain it inline.


3. **Keep the fast lane scoped**: preserve only this session’s durable decisions, contracts, failure lessons and supporting evidence. Topic consolidation is explicitly deferred to `/wiki-deep` D1b; do not run `consolidate` or `topics` here. A concrete correction to a page already used in this task can be repaired with raw evidence, preserving history.

4. **Refresh L0** (most important): in `docs/wiki/current-state.md` update **'now (TL;DR)' and 'next'** from this session and the existing now/next only; do not scan recent milestones or topics. **L0 is the team handoff packet** — name owners (`- <task> (→ name)`). **Trim to ~1,600 chars**: displaced detail moves to `current-state-detail.md` (linked from L0) — **move, never delete**; keep only now+next in L0. Direction and absolute rules are the human's — propose, the human confirms: a direction change → a `1_direction/` draft + draft-marked section as a diff; record after approval. **Active rules** (after Direction, never trimmed): a convention/prohibition the human set this session → one concrete line + decision link; one scoped to code paths also gets `x-llmwiki: { applies_to, rule, recall }` on its decision page (recall: 2–5 phrases a future request would use; save-rationale §9).

5. **Defer overview**: `/wiki-deep` D1c owns Key Findings and overview normalization. Do not rewrite the overview on an ordinary session close-out.

6. **Log**: `llmwiki log-append <repo> update "<one-line session>" "<page touched>"…` — engine-formatted (dated, newest first); never hand-edit `log.md`.

6b. **Optional feedback**: for at most **2 concrete cases** witnessed in this task, follow `llmwiki conventions <repo> --section work-feedback` (exact session ID). Use task regression cases or version-bound injected-page judgments; never rate every page merely because it was shown. No evidence → skip; a broader feedback pass belongs to deep.

7. **Close out (deterministic)**: `llmwiki register-transcript <repo>` → `llmwiki okf <repo> --commit --if-okf` (fills `sources`/`generated`, re-stamps `generated.at` — never hand-maintain timestamps) → `llmwiki index <repo>` (regenerates each folder's `index.md`; never hand-edit) → `llmwiki reconcile <repo> --commit` → `llmwiki lint <repo> --errors-only` → `llmwiki daemon-sync` (always exit 0 — never fail the close-out over it). Lint must reach **0 errors**; warnings are advisory — never over-format to silence them. A not-yet-OKF wiki gets a one-line hint; converting is the person's call (`llmwiki okf <repo>` dry-run, then `--commit`), never yours.
   - **`unresolved-citation` → fix the footnote, never delete it**: `llmwiki conventions <repo> --section citations` §3.
   - **Maintenance signal (never repair here)**: run exactly this opt-in notice after lint:
     ```sh
     llmwiki db-health <repo> --notice
     ```
     Threshold guidance → report `databaseBytes`, `freeBytes`, `freeRatio` and name **`/wiki-deep`**; else `maintenance: no action`. Never run `compact`, `VACUUM`, `wiki-clean`, or `wiki-clean-apply` from `/wiki-save`.

8. **Mark actual completion**: only after filing, L0/log and deterministic checks succeeded, record `llmwiki save-event <repo> --session <exact id> --event completed`. `save-current` only enqueues, and `update-done` only advances a consumed range; neither proves the whole close-out succeeded. If exact resolution failed or lint errors remain, leave completion unrecorded. Never equate a queued session with a saved one.

9. **Report** (1–2 lines): "log reflected N (this session) / backlog deferred B sessions / L0 refreshed yes/no / lint errors N, warnings M / feedback recorded N|skipped (reason) / maintenance no-action|db D free F ratio R → `/wiki-deep` / deep recommended yes/no (reason)". Recommend deep only for wiki maintenance already witnessed: `topic-oversize`, repeatedly deferred gaps or db-health guidance. The pending-backlog count is a bare fact, never debt or a recommendation trigger. Review and gap filling remain in deep, with a relation word (grounds · extends · contradicts · exemplifies · enables) on new cross-links; do not inspect them to justify a recommendation here.

## Principles
- **Supersession (never delete or rewrite a decision)**: a replacing decision gets a NEW page; the old one keeps its body and gains `status: deprecated` + `superseded_by: <new page path>` + `superseded_at: YYYY-MM-DD` (lint errors without the pointer). Never move it to an archive. Numeric `confidence:` values are banned — certainty lives only in footnoted evidence.
- transcript = immutable raw (citation only); process only past the watermark → zero re-cost.
- Commits are in the user's name alone — only when instructed. A git conflict in `docs/wiki/` → `llmwiki conventions <repo> --section team-merge`.
- `/wiki-ask` answers questions; `/wiki-deep` is the deep pass.

<!-- generated by src/plugin/build-assets.ts — edit skill/*.md, then re-run -->
