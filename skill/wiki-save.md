---
description: Session close-out (warm, O(this session)) — file THIS session into the log, consolidate its durable concepts into the topic encyclopedia (5_topic), refresh L0 (current-state), finish with overview·lint. The every-session habit; volume work (backlog · review · gaps · re-distill) defers to the periodic `/wiki-deep` deep pass
---

# /wiki-save — session close-out (warm, human-present)

Close the session by filing **THIS session's** work into durable knowledge, **right here (warm context)**, and keep the **reading input (L0) fresh**. This is the primary integration path — warm, human-present, not an unattended cron. **Minutes, not tens of minutes**: close-out latency is what makes people abandon a wiki (the maintenance-burden rule), so this pass is strictly O(this session). Everything heavier — the transcript backlog, the gap queue, topic re-distillation — belongs to the periodic **`/wiki-deep`** deep pass (the semantic review is the one exception: the close-out *launches* it in the background behind the engine's cadence gate, step 8, precisely so it never adds wall-clock here), and **deferring it loses nothing**: transcripts are immutable and the capture watermarks, gap queue, and lint backlog are all durable; everything deferred stays queued until some pass consumes it.

(Why a human-invoked command and not a hook: no harness offers a reliable LLM-capable "session end" hook — Claude Code's SessionEnd is shell-only with a ~1.5s budget, OpenCode has no true session-close event, Codex automates only via hooks. The warm command is the quality path; any session that skips it lands safely in the backlog for `/wiki-deep`.)

## Two passes, two scopes

| Pass | Scope | When | Work |
|------|-------|------|------|
| **`/wiki-save`** (this skill) | THIS session | every session close | file the session into the log + fold its durable concepts into `5_topic` + L0 freshness + deterministic checks |
| **`/wiki-deep`** (deep) | everything queued | day end · weekly · when the close-out report recommends it | drain the whole transcript backlog + semantic review + gap queue + re-distill oversized topics |

The wiki itself has two layers on different axes: the **log** (`2_milestone`·`3_decision`·`4_insight` — time axis, one immutable entry per session, append-only) and the **topic encyclopedia** (`5_topic` — concept axis, one living page per recurring concept, create-or-update merged in place). A close-out writes the session's log entry AND selectively folds its durable concepts into `5_topic`. Promotion is one-directional (log → topic), never the reverse.

## ★ Execution rules
- **Custom conventions**: if a team `llmwiki.config.toml` (or a per-repo `configs/*.toml`) is active (check: `llmwiki config <repo>` shows a non-default source), run `llmwiki conventions <repo>` FIRST and follow ITS category table (dirs · domains · review gates) over any category names written below.
- **Scratch-artifact protocol for subagents** (issue-#956 class failure): a subagent asked to return a long document must WRITE it to a scratchpad file and return only the path — long inline returns intermittently collapse into summaries and the original is unrecoverable. The orchestrator Reads the file; inline return is the fallback only when the file is missing/empty.
- **Inline, warm** — done directly in this session. No sub-agent delegation (context is quality).
- **Standalone CLI engine** — only `bun ~/llmwiki/src/cli.ts` + `<repo>/docs/wiki/`. Don't confuse it with other wiki/MCP tools.
- **Routine judgment by the strong model, only direction by the human**: the LLM decides classification, grounding checks, topic merges, and decision/insight confirmation *directly* as `status: ready`. Don't check with the human one by one. But **never fabricate ungrounded claims — omit** them. Only **direction shifts** and **unresolved contradictions** go to `0_review` for the human.
- **Latency contract**: this close-out is O(this session), not O(backlog) or O(wiki). Defer volume work (backlog drain, gap queue, topic distill) to `/wiki-deep` or the unattended `autoupdate` daemon instead of doing it inline, and run the one heavy in-pass step (semantic review, step 8) **in the background, never waited on** — deferral is safe by design (durable queues); slowness is not (it kills the habit, and an unused wiki records nothing).
- **Single-purpose close-out**: this ritual only maintains the wiki. Don't absorb unrelated tail work mid-run (applying code-review findings, running test suites, committing code) — finish or queue that BEFORE starting /wiki-save.
- **Validate as you write** (kills the write→lint→fix rework loop): immediately after writing or editing each page, run `llmwiki index <repo> >/dev/null && llmwiki lint <repo> --path '<page path under docs/wiki>' --errors-only` and fix findings NOW, while the file is still in context. The close-out lint then confirms instead of repairs.
- **Secrets never enter a page** (a git-connected wiki is clone-distributed; a pushed credential cannot be recalled): never reproduce credential/token values, private endpoints, or personal data in page prose or 0_review drafts — name the thing and describe or cite it instead of quoting the value (`SLACK_TOKEN: issued, stored in 1Password` passes; the value itself never does; config placeholders like `API_KEY=<your-key>` are fine). The `page-secret`/`excerpt-secret` lint errors enforce this deterministically at close-out — fix by removing the VALUE, never by deleting the claim or its citation.
- **Routine filing needs routine reasoning**: most of this ritual is mechanical (classify, cite, cross-link). Don't deliberate at length over routine filing; reserve depth for contradictions, judgment-bearing merges, and direction shifts.

## Categories (number = reading order)

Use exactly these folders under `docs/wiki/`.

- **`1_direction/`** — big direction/strategy (and this session's shift: from→to, why). Rare. **Human-judgment area** → file into `0_review` to confirm. `status: draft`.
- **`2_milestone/`** — work progress + what's next (built/changed/measured + remaining TODOs). `status: ready`.
- **`3_decision/`** — a problem the human faced → alternatives → choice (ADR: context · decision · alternatives · consequences). Strong-model-confirmed after a grounding check. `status: ready`.
- **`4_insight/`** — realizations·gotchas·wins gained while working with the human. Strong-model-confirmed. `status: ready`.
- **`5_topic/`** — **the topic encyclopedia** (concept/module/pattern pages, NOT people). Built only by consolidation; create-or-update; merged in place. See "Topic consolidation" below.
- **`0_review/`** (human-judgment queue) — **direction shifts + unresolved contradictions only**. Everything else the strong model decides directly. Once the human resolves an item, apply it and delete the file.

Don't create or reference other folders (`concepts/`, `entities/`, `synthesis/`, `next/`, flat `milestones/…`). If a category has no real content this session, don't write it.

## Writing philosophy (most important)

- The human doesn't hand-write the wiki. **The LLM writes all categories** — by *summarizing* what the human decided/realized this session, grounded in the transcript.
- **But never *fabricate* opinions or decisions**: `decision`/`insight` capture only decisions/realizations *the human expressed*. If not grounded, omit it rather than write it. (No model-collapse — keep the loop warm and human-present, not a self-feeding cron.)
- Judge everything by **is this useful to the next session**. No filler, no obvious restatement.
- Write pages in the SAME language as the session/conversation (or the existing wiki pages) — do not force or translate to a fixed language; instructions are English but content matches the source.
- Regardless of the prose language, keep code identifiers, file paths, function/API names, CLI commands, config keys, and error strings VERBATIM (never translate/transliterate) — they are the language-invariant search anchors of the wiki.
- Terminology (lint-enforced, advisory): avoid jargon a person wouldn't naturally say — e.g. when writing Korean prefer `방향성` over 진북/북극성, `업데이트` over distill.
- **Body structure**: use compact hierarchical Markdown bullets — one concrete claim, decision, result, or action per `-` line; supporting detail at four spaces (`    -`); deeper detail at eight (`        -`).
- **Endings**: prefer noun phrases or telegraphic endings natural to the page language; avoid polite/full-sentence endings and abstract framing. Keep verbs when actor, action, condition, or outcome would otherwise be unclear.
- **Density**: keep each bullet to one useful line when possible; do not restate the heading/TL;DR or add a child that merely paraphrases its parent. Frontmatter, evidence/quotes, code, conflict/Q&A callouts, and the one-line TL;DR are exempt.

## Topic consolidation (the heart of this ritual)

Turn this session's durable concepts into living `5_topic/` pages. Four moves:

1. **Surface candidates.** Run `llmwiki consolidate <repo>` (dry-run) to list which concepts this session touches and which already have a `5_topic/` page (FTS-matched). Also eyeball `llmwiki topics <repo>` (the deterministic topic view).
2. **Select (be selective — this is the opposite of the log).** Promote a concept to `5_topic/` ONLY if one holds:
   - it recurs (mentioned across 2+ sessions / already has a topic page), OR
   - it is explicitly durable (enriches an existing topic page), OR
   - it is a concept directly tied to a decision/direction.
   Everything episodic stays in the log only. When unsure, leave it in the log.
3. **Merge (re-ground from raw — the anti-drift rule).** For each selected concept:
   - **Update-vs-create by the 5-dimension overlap rubric** (compound-engineering port): ①concept/problem ②mechanism ③approach ④files/modules ⑤operating rule. High(4-5 dims)=merge into the existing page, Moderate(2-3)=new page + note a consolidation-review line in the close-out report, Low=new page. Judge overlap semantically across languages — the same concept in Korean and English is ONE page (merge keeps the existing page's language; new bullets follow the session's language).
   - **No page yet** → create `5_topic/<concept-slug>.md` (format below).
   - **Page exists** → **add** the new fact as a bullet with its own citation; **preserve every existing grounded line verbatim**. Never rewrite the page from itself.
   - Build the merge ONLY from the session transcript / raw evidence — **never re-summarize other wiki pages** (wiki→wiki re-derivation is forbidden; it causes drift).
4. **Cross-link + conflicts.** Add wikilinks from the topic page to the relevant `3_decision`/`2_milestone` pages using an explicit relation word (`grounds`, `extends`, `contradicts`, `exemplifies`, `enables`). If the new fact **contradicts** an existing line, do NOT overwrite — add a conflict callout on the page and route the resolution to `0_review` if it is a direction-level conflict.

### `5_topic/` page format
```markdown
---
title: <concept / module / pattern name>
description: <one sentence>
date: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [<hub>, topic]
status: ready          # if direction-tied/unresolved → draft + 0_review
domain: topic
source: <transcript>.jsonl
---

TL;DR — one line.

- <core fact / mechanism> [^s1]
    - <supporting condition / result> [^s1]
        - <deeper implementation detail, only when useful> [^s1]
- <a later session adds this; existing lines stay untouched> [^s2]

> [conflict] <other-page> claims X; this session says Y — needs human review

## Related
- [[3_decision/<page>]] — grounds
- [[2_milestone/<page>]] — exemplifies

[^s1]: <transcript-1>.jsonl
    > [2026-06-29 14:02 user] "<the human's own words, verbatim>"
[^s2]: <transcript-2>.jsonl
    > [tool a3f9c2d1] bun test → 272 pass
```
Each fact keeps its own footnote, so a topic page accumulates `[^s1] [^s2] …` from many sessions — provenance is per-claim, traceable down to the real transcript.

**Evidence excerpts (page format v3)** — the indented `>` line under a footnote carries 1–2 lines of the evidence itself, so a teammate who does NOT have your transcript can still read what grounds the claim:
- **Get it from the engine, never from memory**: `llmwiki excerpt <transcript.jsonl> [--kind judgment|fact]`. It quotes verbatim, caps length, and screens secrets — a hand-written excerpt does all three wrong.
- **Judgment claims** (decision · direction) take a `user` quote — what the human actually said. **Fact claims** (milestone · insight) take a tool record (`[tool <hash>]`). Lint verifies judgment quotes really appear in the transcript.
- **The footnote definition line itself never changes** — the excerpt goes on the NEXT line, indented 4 spaces. Appending to the definition line silently breaks teammate citations (`tests/page-format-v3.test.ts` pins this).
- Excerpts are excluded from the search index and from the topic-page budget, so adding evidence never costs retrieval quality or squeezes prose.

## Page frontmatter (required)
`title` `description` `date` `tags`(≥2) `status`(ready|draft) `domain`(direction|milestone|decision|insight|topic) `source`. Every fact/judgment claim needs a footnote `[^1]: <transcript filename or bare code path>` (a `:line` suffix is tolerated — the engine absorbs it — but the bare path is canonical: line numbers rot as code moves, and the verbatim grounding lives on the v3 evidence line). Cross-link related pages.
**Never add `author:`** — authorship is read from git, never cached in frontmatter (decision 2026-07-10): a stamped author goes stale the moment a teammate edits the page, and git already knows. `llmwiki digest` renders contributors from git history (mailmap-aware; `ensureSkeleton` seeds a `.mailmap` so one person's several git identities count once). Legacy pages that still carry `author:` are left as-is — historical records, not a format to continue. On a `0_review` item, **always** stamp `owner: <github login>` — the file owner whose judgment is awaited (cold-start shows `[→ owner]`). Resolve the login as `gh api user --jq .login` → else `git config user.email` local-part → else `git config user.name`. Stamp it regardless of solo/team (not reliably distinguishable, and a file owner is useful either way).

## Engine CLI (`bun ~/llmwiki/src/cli.ts`)
- `llmwiki update-status <repo>` — list unprocessed transcripts (only those with tail after the watermark).
- `llmwiki update-next <repo> <transcript>` — extract **only the unprocessed part** of that transcript (incremental, cheap). First line: `cwd/session/new_offset`.
- `llmwiki update-done <repo> <transcript> <offset>` — advance the watermark (processed). Use `--skipped` for noise.
- `llmwiki consolidate <repo>` — surface topic candidates for this session (dry-run); `--commit` runs the gated unattended merge (strong-model write→independent verify→grounding→lint). In a warm close-out, use dry-run to see candidates, then author/merge the pages yourself.
- `llmwiki topics <repo>` — deterministic topic view (pages clustered by shared tag/citation; no LLM, regenerable). Eyeball the encyclopedia's shape.
- `llmwiki index <repo>` / `lint <repo> [--path <page>] [--errors-only]` — close-out checks (`index` rebuilds the refs graph too). `--path` scopes lint to one page (write-time validation); `--errors-only` prints errors in full and collapses warnings to per-code counts (the backlog stays visible, context stays small).
- `llmwiki review <repo> --commit --if-due` — semantic review behind the engine-enforced cadence gate: skips deterministically unless `LLMWIKI_REVIEW_INTERVAL_DAYS` (default 7) have passed since the last committed review (`--force` overrides). In a per-session close-out this is **launched in the background** (step 8) so the close-out never stalls on it; the engine stamps a launch marker and reports `prev_launch_incomplete` on its next invocation if a backgrounded run died before committing.
- `llmwiki reconcile <repo> --commit` — advance the capture watermark for sessions a wiki page now cites (a warm close-out doesn't auto-advance it).
- `llmwiki register-transcript <repo>` — register this session's transcripts as **citable sources** so pages can cite the real session (`[^1]: <transcript>.jsonl`) instead of code. `update-next` already registers the transcript it processes; run this only if you wrote a page outside that flow.
- `llmwiki excerpt <transcript.jsonl> [--kind judgment|fact] [--limit N]` — candidate **evidence excerpts** for the v3 footnote continuation line (verbatim, capped, secret-screened). `judgment` = the human's own words (decision · direction pages); `fact` = tool records (milestone · insight).
- `llmwiki digest <repo>` — deterministic relational digest (hubs · freshness · 0_review). No LLM, regenerable.

$ARGUMENTS

## Procedure (minutes, O(this session))

1. **REPO = cwd** (`$CLAUDE_PROJECT_DIR`; argument none/`here` = current repo, or pass another repo's path). If `docs/wiki/` is missing, create it with `llmwiki skeleton <repo>` then proceed.

1b. **0_review first (announce, apply, delete)**: if `docs/wiki/0_review/*.md` exist, announce them in chat first ("0_review: N items — <titles>"). **Two files are engine-managed and are NOT Q./A. items — never delete them here**: `gap-queue.md` (persistent self-closing backlog) and `semantic-review-*.md` reports (inputs to `llmwiki gaps`; a review report is deleted only after its gaps have been folded into the queue in step 8). Skip both and process the rest. For each, check the `A.` line — **if an answer is written**, apply the `Draft`/resolution into the right category (or discard) and **delete the file**; **if empty**, show the `Q.` and get the answer, then apply and delete. After processing, `0_review/` should hold no Q./A. items.

2. **File THIS session into the log**: `llmwiki update-status <repo>` → pick the **current session's** transcript(s) (match by session id; when unsure, the newest pending entry) → for each, `llmwiki update-next <repo> <transcript>` (judge from the extract alone — never load the full transcript into context; `update-next` prints a harness-summary block when one exists — use it as draft material but ground every claim in the raw extract). From the extract, pick out **only what the human actually said/decided/realized**; discard model-generated analysis. Route by category (create a page only for categories that have content):
   - execution/measurement results + remaining TODOs → `2_milestone/` (include numbers in the 1-line TL;DR if any, `status: ready`)
   - a realization/gotcha/learning the human expressed → `4_insight/` (grounded → **the strong model confirms `status: ready`** — no human sign-off)
   - a decision the human made → `3_decision/` (ADR form; grounded → **the strong model confirms `status: ready`**)
   - **ambiguous classification → don't ask the human; the strong model confirms into the best-fit folder** (not 0_review).
   - **only when direction/strategy actually shifted** → file a Q./A. question/draft (format below) into `0_review/` for the human. The transcript that produced a question file **does not advance its watermark** (unresolved, so it reappears next time).
   - not grounded → omit. Noise (trivial Q&A, no record value) → no page, `update-done --skipped`.
   Then advance the watermark: `llmwiki update-done <repo> <transcript> <new_offset>`. **Leave the rest of the backlog pending and report the count** — it is safely queued behind byte watermarks for `/wiki-deep` or the unattended `autoupdate` daemon. Do NOT drain it inline: measured cost is ~40s+/session, so an 11-session backlog turns a close-out into a 10-minute wait. If 0 pending, skip.

3. **Consolidate the topic encyclopedia (5_topic)** — per the "Topic consolidation" section above: dry-run `llmwiki consolidate <repo>` → select durable/recurring concepts only → create-or-update `5_topic/<slug>.md` pages (add new facts with their own citations, preserve existing lines, build from the transcript/raw only) → cross-link with explicit relation words; flag contradictions as callouts (direction-level → `0_review`).

4. **Refresh L0 freshness** (the reading input — most important):
   - Read `docs/wiki/current-state.md` and propose updating **only the 'now (TL;DR)' and 'next (remaining work)' sections** from this session + recent milestones + new topic pages.
   - Apply the compact hierarchy contract above to Now/Next: main state or task on `-`, evidence/owner/blocker under `    -`, and only necessary deeper detail under `        -`.
   - **L0 is the team handoff packet**: on a shared wiki, write 'now/next' assuming the NEXT reader may be a teammate's session, not yours — name the owner on a 'next' item when it belongs to someone (`- <task> (→ name)`).
   - Direction and absolute rules are the human's. A direction change → propose a `1_direction/` draft + a draft-marked direction section. Show as a diff; record after approval. Refresh `updated:`.

5. **Update overview (keep it bounded — entry point, not a changelog)**: refresh `docs/wiki/overview.md` **Key Findings only** (concept/topic pointers — one line + link each). Do **NOT** prepend a per-session paragraph. Session-by-session history lives in `log.md` (step 6) and the milestone pages — overview must not duplicate it. Then run **`llmwiki overview --normalize <repo>`** to enforce this **structurally** (it collapses any grown "Recent Updates" section to a single `[[log.md]]` pointer, preserves curated sections, and warns if the page is over budget — LLM-0, idempotent). Rationale: the entry point's size must stay O(tracks), not O(sessions), so it never approaches the context-overflow cliff (ref: LLM-Wiki-v3 namespace index, KnowledgeWeaver).

6. **Log**: append `## [YYYY-MM-DD] update | <one-line session>` to `docs/wiki/log.md` (include topic pages touched).

7. **Close out (deterministic)**: `llmwiki register-transcript <repo>` → `llmwiki index <repo>` → `llmwiki reconcile <repo> --commit` → `llmwiki lint <repo> --errors-only`. Thanks to validate-as-you-write this should **confirm** 0 errors, not open a repair phase; fix any residue until **0 errors**. Warnings arrive collapsed to per-code counts — report the counts as advisory backlog, don't over-format to silence them.
   - **Unresolved-citation guard (never strip to silence):** if lint flags `unresolved-citation`, **fix** the footnote — never delete it (deleting only downgrades to a `no-citation` warning and discards provenance). First decide the claim's KIND: **a human decision / judgment / statement** → the source is the **session transcript**, NOT code (normally already citable via `update-next`; else `llmwiki register-transcript <repo>`), cite `[^n]: <transcript>.jsonl` — **never repoint a decision to a code file**; **a factual claim about code** → cite **one repo-relative path that exists**. One path per footnote (no globs/commas/parentheticals); one footnote per source. **Keep the definition LINE to the bare source** — an evidence excerpt belongs on the indented line below it (v3), never appended to the definition, which would break teammate citations. Only if no real source exists, drop the underlying claim.
   - **Maintenance signal (cheap; never repair here)**: run exactly this opt-in notice after lint. It records the notification cooldown but does not compact, VACUUM, or alter wiki pages:
     ```sh
     llmwiki db-health <repo> --notice
     ```
     If the CLI emits threshold guidance, report the measured `databaseBytes`, `freeBytes`, and `freeRatio = freeBytes / databaseBytes`, then name **`/wiki-deep`** as the exact next pass. Otherwise report `maintenance: no action`. Never run `compact`, `VACUUM`, `wiki-clean`, or `wiki-clean-apply` from `/wiki-save`.

8. **Semantic review — engine-gated, launched in the background**: whenever this session created or updated pages, launch `llmwiki review <repo> --commit --if-due` **in the background** (harness background execution) and **continue to the report immediately — never wait for it**. Rationale: the review is the one heavy step in an otherwise minutes-scale close-out, and it hits every repo's *first* close-out unconditionally (no prior state → always due) — inline it breaks the latency contract exactly when first impressions matter; backgrounded, cadence and wall-clock are both kept. The engine skips it deterministically unless the cadence interval (~7 days, `LLMWIKI_REVIEW_INTERVAL_DAYS`) has passed since the last committed review — trust the gate; don't re-derive it from `log.md` and don't `--force` in a per-session close-out.
   - **Silent-death check (required with backgrounding)**: if any review output you DO see carries `prev_launch_incomplete`, report it in chat ("이전 백그라운드 리뷰가 커밋 없이 종료") — the cadence gate makes the died review due again, so this launch already re-runs it; the flag exists so a background death is never invisible.
   - **Findings are durable, warmth is optional**: the advisory draft lands in `0_review/` (never edits live pages) and the next session's cold-start surfaces the `0_review` count — nothing is lost by not waiting. If the background run happens to finish while this session is still open, handle findings warm: **announce them in chat**; for a real *contradiction*, add a `> [conflict] …` callout to the relevant `5_topic` page (never overwrite), and route only **direction-level** conflicts to `0_review` for the human. Otherwise that handling falls to the next close-out or `/wiki-deep`.
   - Then run **`llmwiki gaps <repo>`** (fast, deterministic — folds committed reviews to date; today's backgrounded findings get folded on the next pass) to keep the tracked, self-closing `0_review/gap-queue.md` current (a gap auto-closes once review stops re-flagging it for 2 runs; review is bounded+cached by P1-A2).
   - **Fast gap quota — fill at most 2 quick gaps now**, oldest first, and only the cheap kinds: a `next-question` cross-link gap → add the wikilinks with explicit relation words, or the `> [conflict]` callout. *Missing-concept* pages and the rest of the queue are **`/wiki-deep`'s** job — announce the open count. A deferred gap is never lost: it stays tracked in the queue until some pass fills it (never hand-edit the queue's `<!-- gap:… -->` markers).

9. **Report** (1–2 lines): "log reflected N (this session) / **backlog deferred: B sessions** / **topic pages: created A, updated B** / **gaps filled K (open M)** / 0_review pending N / L0 refreshed: yes/no / lint error·warn counts / review: launched-bg|not-due|prev-incomplete / maintenance: no-action|db <databaseBytes>B free <freeBytes>B ratio <freeRatio> → `/wiki-deep` / **deep pass (`/wiki-deep`) recommended: yes/no (why)**". Recommend `/wiki-deep` when any of these holds: pending backlog ≥ 5 sessions · lint shows `topic-oversize` · open gaps keep being deferred · the maintenance notice emits threshold guidance.

### 0_review file format — Q./A. form (no emojis)
After the routine-judgment rule, `0_review` is almost entirely **direction-shift confirmation**. Labels/guidance in English; content (question + draft) in the wiki's own language. Separate paragraphs with blank lines so the human can write the answer directly under `A.`:
```
---
title: "[review] <short title>"
kind: direction       # direction-shift confirmation (human-owned)
status: pending
created: <YYYY-MM-DD>
owner: <github login>   # always stamp — file owner whose judgment is awaited; cold-start shows [→ owner]
source: <transcript filename>
---

Q. This session looks like a direction shift from <from> → <to>. Confirm?

A. (write your decision below; on the next /wiki-save or /wiki-deep the LLM applies it and deletes this file)


Draft (candidate 1_direction page; moved into 1_direction/ once confirmed):
<transcript-grounded summary + draft of the direction page to move on confirmation>
```

## Principles
- **Supersession (never delete or rewrite a decision)**: when a new decision replaces an old one, write a NEW page and mark the old page in place — body untouched, frontmatter `status: superseded` + `superseded_by: <new page path>` + `superseded_at: YYYY-MM-DD` (lint errors without the pointer). Search/turn-context auto-demote superseded pages, so never move them to an archive folder. Numeric confidence values (`confidence: 0.85`) are banned — certainty is expressed only through footnoted evidence chains.
- Two layers: the log is immutable per-session truth; the topic encyclopedia is the living, merged synthesis. Promotion is one-directional (log → topic), never the reverse.
- Topic merges re-ground from the raw transcript, never from other wiki pages. transcript = immutable raw (citation only). Incremental: process only past the watermark → zero re-cost.
- Routine judgment (classification, grounding, topic merge) is the strong model's; direction and unresolved contradictions are the human's (omit, never fabricate).
- Be selective with `5_topic` (opposite of the log): only durable/recurring concepts. Don't force-fill. Don't over-format to silence warnings.
- **Defer, never drop**: this pass defers volume work because deferral is lossless by construction — transcripts are immutable; watermarks, the gap queue, and the lint backlog are durable and self-tracking. Slowness, not deferral, is what loses information: a close-out people skip records nothing.
- Concurrency-safe: mostly new pages + appends. Commits are in the user's name alone — only when instructed.
- Team merge recovery: `log.md` merges automatically (`merge=union` via the skeleton's `.gitattributes`). `gap-queue.md` and `overview.md` are whole-file regenerated — on a git conflict, take either side, then re-run `llmwiki gaps <repo>` / `llmwiki overview --normalize <repo>`; both converge. Never hand-merge their generated bodies.
- Use `/wiki-save` to close out a session (this skill), `/wiki-ask` for a question, `/wiki-deep` for the periodic deep pass (backlog · review · gaps · re-distill).
