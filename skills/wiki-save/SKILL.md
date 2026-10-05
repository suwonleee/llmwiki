---
name: wiki-save
disable-model-invocation: true
description: Session close-out (warm, O(this session)) — file THIS session into the log, consolidate its durable concepts into the topic encyclopedia (5_topic), refresh L0 (current-state), finish with overview·lint. The every-session habit; volume work (backlog · review · gaps · re-distill) defers to the periodic `/wiki-deep` deep pass
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

File **THIS session's** work into durable knowledge **right here (warm context)** and keep the **reading input (L0) fresh** — the primary path, not a cron. **Minutes, not tens of minutes.** Deferring volume work to **`/wiki-deep`** is safe: watermarks, gap queue, and lint backlog are durable; the backlog is raw material, not debt, and a session that ages out of the harness's retention window un-filed is **self-selection, not loss**.

Steps name a reference section (`llmwiki conventions <repo> --section <name>`) only where needed — never pre-load. Rationale: `llmwiki conventions <repo> --section save-rationale`; command semantics: `llmwiki conventions <repo> --section cli`.

Two layers: the **log** (`2_milestone`·`3_decision`·`4_insight` — one immutable entry per session, append-only) and the **topic encyclopedia** (`5_topic` — one living page per concept, merged in place). Promotion is log → topic only.

## ★ Execution rules
- **Custom conventions**: if a team `llmwiki.config.toml` (or a per-repo `configs/*.toml`) is active (check: `llmwiki config <repo>` shows a non-default source), run `llmwiki conventions <repo>` FIRST and follow ITS category table (dirs · domains · review gates) over any category names written below and in any `--section` output.
- **Inline, warm** — no sub-agent delegation (context is quality). A subagent asked for a long document WRITES it to a scratchpad file and returns only the path (inline return only if that file is missing/empty).
- **This is the write moment**: cold-start rule 3 defers ALL mid-session page-writing to here, so sweep the WHOLE session — the first hour's decision lands here too.
- **Standalone CLI engine** — only `bun "<plugin-root>/src/cli.ts"` (`llmwiki` below) + `<repo>/docs/wiki/`; no other wiki/MCP tools.
- **Routine judgment by the strong model, only direction by the human**: classification, grounding checks, topic merges, and decision/insight confirmation are decided *directly* as `status: ready` — no one-by-one checks with the human. **Never fabricate ungrounded claims — omit** them. Only **direction shifts** and **unresolved contradictions** go to `0_review`.
- **Latency contract**: O(this session), never O(backlog)/O(wiki). Volume work goes to `/wiki-deep` or the unattended `autoupdate` daemon; the semantic review runs **in the background, never waited on**.
- **Single-purpose**: finish or queue unrelated work (review fixes, tests, commits) BEFORE starting.
- **Validate as you write**: after each page write, `llmwiki index <repo> >/dev/null && llmwiki lint <repo> --path '<page path under docs/wiki>' --errors-only`; fix findings NOW, while the file is in context.
- **Secrets never enter a page**: no credential/token values, private endpoints, or personal data in prose or 0_review drafts — name and cite the thing instead (`SLACK_TOKEN: issued, stored in 1Password`; placeholders like `API_KEY=<your-key>` are fine). `page-secret`/`excerpt-secret` lint errors are fixed by removing the VALUE, never the claim or its citation.
- **Routine filing, routine reasoning**; depth only for contradictions, judgment-bearing merges, direction shifts.

## Categories (number = reading order)

Exactly these folders under `docs/wiki/` — never `concepts/`, `entities/`, `synthesis/`, `next/`, `milestones/`. Empty → no page.

- **`1_direction/`** — big direction/strategy shift (from→to, why). Rare. **Human-judgment** → confirm via `0_review`. `status: draft`.
- **`2_milestone/`** — progress + what's next (built/changed/measured + remaining TODOs). `status: ready`.
- **`3_decision/`** — problem → alternatives → choice (ADR: context · decision · alternatives · consequences). Strong-model-confirmed after a grounding check. `status: ready`.
- **`4_insight/`** — realizations·gotchas·wins. Strong-model-confirmed. `status: ready`.
- **`5_topic/`** — **topic encyclopedia** (concepts/modules/patterns, NOT people). Built only by consolidation.
- **`0_review/`** — **direction shifts + unresolved contradictions only**; resolved → apply, delete the file. Every item stamps `owner:` (`gh api user --jq .login` → else `git config user.email` local-part → else `git config user.name`); format: `llmwiki conventions <repo> --section review-item`.

## Writing rules (every page)

- The human doesn't hand-write the wiki. **The LLM writes all categories** — *summarizing* what the human decided/realized, grounded in the transcript. **Never *fabricate***: `decision`/`insight` hold only what *the human expressed*. Test: **useful to the next session?** No filler.
- SAME language as the session (or existing pages) — never translate; code identifiers, paths, API names, CLI commands, config keys, error strings stay VERBATIM, never transliterated.
- **Body**: numbered sections `## 1. <label>` (`### 1-1. <label>` only for real parts); one point per `-` line, supporting detail at `    -`, deeper detail at `        -`, no fourth level; more than three enumerated items → child bullets; a short single-group page stays a bare bullet list. Prefer noun phrases or telegraphic endings. Before the first page of this pass: `llmwiki conventions <repo> --section writing`.
- **Frontmatter**: `title` `description` `date` `tags`(≥2) `status`(ready|draft) `domain` `source`; **never `author:`** (git owns authorship). Cross-link related pages.
- **Citations**: every fact/judgment claim has a footnote `[^1]: <transcript>.jsonl` or one bare repo-relative path; the definition line stays bare. The evidence quote goes on the NEXT line, indented 4 spaces, from `llmwiki excerpt <transcript.jsonl> --kind judgment|fact` — never from memory. Before the first footnote of this pass: `llmwiki conventions <repo> --section citations`.

## Topic consolidation (the heart of this ritual)

At the first candidate concept: `llmwiki conventions <repo> --section consolidate`. Its invariants always hold:
- **Selective** — only recurring, explicitly durable, or decision/direction-tied concepts; episodic stays in the log (unsure → log).
- **Add, never rewrite** — new fact = new bullet with its own citation; every existing grounded line preserved verbatim.
- **Re-ground from raw** — transcript / raw evidence only, **never re-summarize other wiki pages**.
- **Never overwrite a contradiction** — `> [conflict]` callout; direction-level → `0_review`.

$ARGUMENTS

## Procedure (minutes, O(this session))

1. **REPO = the repo this session's WORK concerned** — normally cwd (`$CLAUDE_PROJECT_DIR`; argument none/`here` = current repo, or another repo's path). Work from a catch-basin cwd into another enrolled repo files into THAT repo. No `docs/wiki/` → `llmwiki skeleton <repo>`, then proceed.

1b. **0_review first (announce, apply, delete)**: announce existing `docs/wiki/0_review/*.md` ("0_review: N items — <titles>"). **Engine-managed, NOT Q./A. items — never delete here**: `gap-queue.md` and `semantic-review-*.md` Every other item: `A.` answered → apply its `Draft`/resolution (or discard) and **delete the file**; empty → show the `Q.`, get the answer, apply, delete. Afterwards `0_review/` holds no Q./A. items.

2. **File THIS session into the log** — selection is **EXACT, never nearest**:
   - **Resolve the current session id** (harness-provided, never inferred from recency):
     - Claude Code: run `printf '%s\n' "${CLAUDE_SESSION_ID:-$CLAUDE_CODE_SESSION_ID}"` in Bash — the harness substitutes the first form inside command files, and the Bash subprocess env var covers every other case.
     - OpenCode: use the `[llmwiki] current OpenCode session id: …` line injected into this command's prompt by the llmwiki plugin.
     - Codex: `session_id` from the hook payload in context (it is also the rollout transcript's filename).
   - `llmwiki save-current <repo> --session <that id>` — exact-identity resolve + enqueue (no 50-line threshold); prints the paths.
   - **save-current fails (no exact match) → file NOTHING for this session**; report it and continue. Never fall back to the newest pending entry or another transcript.
   - `llmwiki update-status <repo>` → **only the path(s) save-current printed** → `llmwiki update-next <repo> <transcript>` (unprocessed part only; first line `cwd/session/new_offset`). Judge from the extract alone — never load the full transcript into context; a harness-summary block is draft material, every claim is grounded in the raw extract.
   - **Route check first**: `# touched:` lists the git roots this segment mutated; `# ⚠ route:` means the dominant root is NOT this repo → file into that repo's wiki, then `llmwiki update-done <bucket-repo> <transcript> <offset>` where it is queued (`cwd=` cannot catch this).
   - Take **only what the human said/decided/realized**; discard model analysis. Route:
     - results/measurements + remaining TODOs → `2_milestone/` (numbers in the TL;DR)
     - a realization/gotcha → `4_insight/`; a decision → `3_decision/` (ADR) — grounded → **the strong model confirms `status: ready`**
     - **ambiguous classification → the strong model picks the best-fit folder** (not 0_review)
     - **only an actual direction shift** → a Q./A. item in `0_review/` (`llmwiki conventions <repo> --section review-item`); its transcript **does not advance its watermark** (it reappears)
     - not grounded → omit; noise → no page, `update-done --skipped`
   - `llmwiki update-done <repo> <transcript> <new_offset>`. **Leave the rest of the backlog pending, report its count** — never drain it inline.

2b. **Same-topic weave-in (optional)**: `llmwiki related <repo> <this session's transcript>` (deterministic; human utterances only). Mention candidates once; weave one in ONLY if it enriches a page this close-out already writes, via `update-next → file → update-done` (own log entry). **Skipping is the default and final for today** — never debt, never a `/wiki-deep` reason.

3. **Consolidate**: dry-run `llmwiki consolidate <repo>` (+ `llmwiki topics <repo>`) → select → create-or-update `5_topic/<slug>.md` (a NEW page: `llmwiki conventions <repo> --section topic-page`) → cross-link.

4. **Refresh L0** (the reading input — most important): in `docs/wiki/current-state.md` update **only 'now (TL;DR)' and 'next'** from this session + recent milestones + new topic pages (state/task on `-`, evidence/owner/blocker on `    -`). **L0 is the team handoff packet** — write for a teammate's next session; name owners (`- <task> (→ name)`). **Trim to ~1,600 chars**: displaced detail moves to `current-state-detail.md` (create beside L0, link from L0) — **move, never delete**; keep only now+next in L0. Direction and absolute rules are the human's — propose, the human confirms: a direction change → a `1_direction/` draft + draft-marked section as a diff; record after approval. Refresh `updated:`.

5. **Overview (entry point, not a changelog)**: refresh `docs/wiki/overview.md` **Key Findings only** (one line + link each); **never prepend a per-session paragraph**. Then **`llmwiki overview --normalize <repo>`** (collapses "Recent Updates" to one `[[log.md]]` pointer, keeps curated sections, warns over budget; idempotent).

6. **Log**: append `## [YYYY-MM-DD] update | <one-line session>` to `docs/wiki/log.md` (name topic pages touched).

7. **Close out (deterministic)**: `llmwiki register-transcript <repo>` → `llmwiki index <repo>` → `llmwiki reconcile <repo> --commit` → `llmwiki lint <repo> --errors-only` → `llmwiki daemon-sync` (always exit 0; restarts the capture daemon only if it predates the code; never fail the close-out over it). Lint should **confirm** 0 errors; fix residue to **0 errors**. Warning counts are advisory; never over-format to silence them.
   - **`unresolved-citation` → fix the footnote, never delete it**: `llmwiki conventions <repo> --section citations` §3.
   - **Maintenance signal (never repair here)**: run exactly this opt-in notice after lint:
     ```sh
     llmwiki db-health <repo> --notice
     ```
     Threshold guidance → report `databaseBytes`, `freeBytes`, `freeRatio = freeBytes / databaseBytes` and name **`/wiki-deep`**; else `maintenance: no action`. Never run `compact`, `VACUUM`, `wiki-clean`, or `wiki-clean-apply` from `/wiki-save`.

8. **Semantic review — engine-gated, background**: if this session created or updated pages, launch `llmwiki review <repo> --commit --if-due` **in the background** and **continue immediately — never wait**. The gate (`LLMWIKI_REVIEW_INTERVAL_DAYS`, default 7) decides; don't re-derive it and don't `--force` here. Output carrying `prev_launch_incomplete` → report it in chat (a background death must never be invisible); for that and for findings arriving while this session is open → `llmwiki conventions <repo> --section review-findings`. Then **`llmwiki gaps <repo>`**, and fill **at most 2 quick gaps** (oldest first; `next-question` cross-links with a relation word (grounds · extends · contradicts · exemplifies · enables) or `> [conflict]` callouts only) — the rest is `/wiki-deep`'s; announce the open count. Never hand-edit `<!-- gap:… -->` markers.

9. **Report** (1–2 lines): "log reflected N (this session) / **backlog deferred: B sessions** / **topic pages: created A, updated B** / **gaps filled K (open M)** / 0_review pending N / L0 refreshed: yes/no / lint error·warn counts / review: launched-bg|not-due|prev-incomplete / maintenance: no-action|db <databaseBytes>B free <freeBytes>B ratio <freeRatio> → `/wiki-deep` / **deep pass (`/wiki-deep`) recommended: yes/no (why)**". Recommend `/wiki-deep` only for WIKI-maintenance signals (lint `topic-oversize` · gaps repeatedly deferred · maintenance guidance). The pending-backlog count is NEVER a reason — report it as a bare fact.

## Principles
- **Supersession (never delete or rewrite a decision)**: a replacing decision gets a NEW page; the old one keeps its body and gains `status: superseded` + `superseded_by: <new page path>` + `superseded_at: YYYY-MM-DD` (lint errors without the pointer). Never move it to an archive. Numeric `confidence:` values are banned — certainty lives only in footnoted evidence.
- transcript = immutable raw (citation only); process only past the watermark → zero re-cost.
- Commits are in the user's name alone — only when instructed. A git conflict in `docs/wiki/` → `llmwiki conventions <repo> --section team-merge`.
- `/wiki-ask` answers a question; `/wiki-deep` is the periodic deep pass (backlog · review · gaps · re-distill).

<!-- generated by src/plugin/build-assets.ts — edit skill/*.md, then re-run -->
