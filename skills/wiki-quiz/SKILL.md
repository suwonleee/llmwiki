---
name: wiki-quiz
description: The human memory loop — a few minutes of spaced-repetition quiz (day-granular forgetting curve) over this repo's wiki, decisions and direction first. The engine schedules deterministically (quiz-status/next/record); this session authors and grades questions warm, grounded in the pages, and records into docs/wiki/6_quiz/ (a human-only layer excluded from indexing/search)
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

# /wiki-quiz — human memory loop (spaced repetition over the wiki)

The compounding loop so far closes only the LLM's side: capture → `/wiki-save` → read-injection keeps the MODEL grounded, while the human's memory of their own decisions decays on the forgetting curve. Yet the labor split leaves exactly one duty that cannot be delegated — **direction and contradiction judgment** — and that judgment is only as good as what you still remember of your past decisions and their WHY. This ritual closes the human loop: the engine schedules day-granular spaced repetition over the wiki's own pages; you answer a handful of questions; wrong answers get re-asked sooner. Run it after a close-out (`/wiki-save` → `/wiki-quiz`) or whenever cold-start shows `[llmwiki quiz] N review(s) due`.

## ★ Execution rules
- **Inline, warm** — questions are authored and graded directly in this session (no sub-agent delegation). Engine = `bun "<plugin-root>/src/cli.ts"` + `<repo>/docs/wiki/`. (Standalone CLI engine — ignore other wiki/MCP tools and any "wiki" keyword reminders.)
- **Custom conventions**: if a team `llmwiki.config.toml` (or a per-repo `configs/*.toml`) is active (check: `llmwiki config <repo>` shows a non-default source), run `llmwiki conventions <repo>` FIRST and follow ITS category table (dirs · domains · review gates) over any category names written below. The quiz layer (`6_quiz/`) and queue (`0_review/`) are fixed structure — those names never change.
- **Grounded questions only**: Read the page BEFORE authoring its question; the page is the answer key and the session record cites it. A question you cannot ground in a page does not get asked — never quiz on model memory.
- **Ask about the core, never the incidentals**: quiz the ONE thing on the page that would change how future work is done — the choice made, the direction taken, the constraint discovered. Not dates, counts, file names, test numbers, commit ids, or who ran what. If the only question a page supports is bookkeeping, ask nothing about it and move to the next selected page. `quiz-next` marks hub pages (`허브(피인용 N)` / `hub(N inbound)`) — on those, aim at the concept the other pages were built on.
- **Human-friendly wording**: plain sentences a person would naturally say, in the wiki's own language. Ask about the WHY and the direction of a decision, not line-level code trivia. One concept per question, one question per page.
- **Options are NOUN PHRASES** — the stem may ask what or why, but every option names the answer as a short noun phrase, never a sentence that states it. `근거 이동성 확보` / `검색 품질 향상` / `저장 공간 절감`, not `팀원이 남의 근거를 재검증할 수 없어서 발췌를 본문에 넣기로 했다`. Keep all options parallel in form and comparable in length — a longer or more specific option gives the answer away without the human recalling anything. Aim for a handful of words each.
- **Structured ask when the harness has it** — one call per question: 3 short options (1 correct + 2 plausible distractors from the same topic area) plus a "기억 안 남 / not sure" option; free recall arrives via the built-in "Other"/free-form field. Claude Code: `AskUserQuestion`. OpenCode: the `question` tool (available in the TUI). Codex: `request_user_input` (exposed in Plan mode; in Default mode only behind the `default_mode_request_user_input` feature flag — if the tool is not in your tool list, fall back below). Harnesses without such a tool (plain chat, non-exposed modes): print the question and wait for the reply. Either way, ask ONE question at a time — but author ALL questions upfront (Procedure 3); the pause between questions is grading only, never generation.
- **Don't drill**: when the human doesn't know, reveal the gist in 1–2 sentences + the page link, record `skip`, and move on to the next pre-authored question (each question is already a different page). The reveal IS the review; re-asking now would be recognition, not recall (the schedule re-asks it tomorrow anyway).
- **Latency contract**: default question count = config `[quiz] questions` (stock 3); a numeric argument raises it, the engine caps at 7 (fixed). Minutes total; a quiz people skip reinforces nothing — keep it light enough to be a habit.

## Scheduling model (engine-owned — don't re-derive it)
- Ledger: `docs/wiki/6_quiz/quiz-ledger.<id>.md` — **per person** (the forgetting curve is per-human; `<id>` resolves from git identity, `LLMWIKI_QUIZ_IDENTITY` overrides; a legacy bare `quiz-ledger.md` is adopted by the first identity to quiz, history intact). Engine-managed markers (`<!-- quiz:{…} -->`) — **never hand-edit**.
- Forgetting curve, day-granular (min 1 day): boxes at **1 · 3 · 7 · 16 · 35 · 60 days**. correct → next box; wrong/skip → box 0. An item asked today is never re-selected today.
- `quiz-next` priority: ① wrong/skip items due (oldest first) ② correct items whose curve review arrived ③ never-quizzed pages — direction(4) > decision·topic(3) > insight(2) > milestone(1); within a weight, hub pages (2+ inbound references, the cold start's own "most-referenced" definition) come first, then newest. The hub step is the engine's answer to "ask about the core of the work": the graph, not the category, distinguishes a landmark from a passing note.
- superseded/draft pages and vanished pages are excluded automatically; the quiz layer itself is excluded from index/search/cold-start (one-directional: wiki → human).
- The day boundary is **UTC** (engine-wide date convention) — for a KST user "today" flips at 09:00 KST, so a pre-9am session counts as the previous quiz day.

## Engine CLI (`bun "<plugin-root>/src/cli.ts"`)
- `llmwiki quiz-status <repo> [--date YYYY-MM-DD]` — ledger totals, due counts, weak spots.
- `llmwiki quiz-next <repo> [--limit N]` — the scheduled selection (pointers only; you Read the pages).
- `llmwiki quiz-record <repo> --page <wiki-relative.md> --result correct|wrong|skip [--question "<asked>"]` — record one result; the engine takes the curve step and rewrites the ledger.

$ARGUMENTS

## Procedure

1. **REPO = cwd** (`$CLAUDE_PROJECT_DIR`). If `docs/wiki/` is missing → say "this repo has no wiki yet — build it with `/wiki-save` first" and stop. Run `llmwiki quiz-status <repo>` and announce one line (due / new-candidate counts + weak spots + session size — quiz-status prints `session Nq (max M)` from config). A numeric argument overrides the question count; the engine caps it at 7.

2. **Select**: `llmwiki quiz-next <repo>` — omit `--limit` unless the human gave a count (`--limit <N>`); the config default applies and the engine clamps to the ceiling. If 0 items, report "nothing due today" (+ next due date from quiz-status) and stop.

3. **Author ALL questions upfront, then ask one at a time**: Read EVERY selected page first (parallel Reads in one batch), then author all N questions in one pass BEFORE asking anything — the human should never wait on generation between questions. Per page, ONE question in the wiki's language, angled by category — decision: "what did we choose there, and why over the alternative?" · direction: "where is this headed / what changed?" · insight: "what was the gotcha/lesson?" · topic: "what IS this concept / what does it buy us?" · milestone: "what state is X in?". Whatever the angle, the options stay noun phrases (rules above). Vary the angle from the `last q:` shown by quiz-next (repetition with variation). Then ask the pre-authored questions one at a time via the structured tool or chat (rules above).

4. **Grade on the gist, warmly**: the decision/why remembered = `correct` even with fuzzy details; "don't remember / blank" = `skip`; confidently wrong = `wrong`. After each answer give one-line feedback — correct: confirm + one sharpening fact; wrong/skip: the actual answer in 1–2 sentences + the `[[<page>]]` link — then move to the next item.

5. **Record every asked item** (including skips) AFTER the last answer, in one sequential batch: `llmwiki quiz-record <repo> --page <page> --result <r> --question "<the question you asked>"` per item. Deferring the records to the end keeps the ask loop free of engine calls; sequential because the ledger rewrite is not safe from parallel writers.

6. **Write the human-readable session record** `docs/wiki/6_quiz/<YYYY-MM-DD>-quiz.md` (same-day rerun → append a `## 2회차` section, don't overwrite). Frontmatter: `title` `description` `date` `tags: [quiz, memory]` `status: ready` `domain: quiz` `source: quiz session`. Use one numbered section per question (`## 1. <the question>`, `## 2. …`), and inside it `-` lines for the human's answer, the verdict, and the grounded answer + `[[<page>]]`, with `    -` for detail. Prefer compact noun-phrase/telegraphic endings. This file is the human's review notebook — write it for the human, not the machine.

7. **Log**: append `## [YYYY-MM-DD] quiz | N asked, M correct, K to re-review` to `docs/wiki/log.md`.

8. **Report** (1 line): "quiz N문 M정 / 오답·skip K / 다음 due <date> / 기록: 6_quiz/<file>". **No index/refs/lint close-out** — the quiz layer is not indexed by design, and log.md gets picked up by the next `/wiki-save`.

## Principles
- **One-directional loop**: wiki → human. Quiz artifacts are excluded from indexing/search/cold-start so the LLM never feeds on its own quiz output — the wiki remembers FOR the model; the quiz makes the HUMAN remember.
- **Engine schedules, session judges**: box math, due dates, and priority are deterministic engine work; question wording and gist-grading are warm judgment. Neither side crosses over.
- **Judgment before facts**: quiz what sharpens the human's irreplaceable role — decisions, direction, insights — before execution details. Code specifics only when a page's whole point is a mechanism.
- **Wrong answers are the product**: they mark exactly what the system knows but the human forgot. Weak spots (<50% over 3+ asks, shown by quiz-status) deserve a deliberate re-read of the page, not just another quiz round.
- Records = a new dated file + a whole-file ledger rewrite + a log append. Call `quiz-record` sequentially (as this procedure does) — the ledger rewrite is not safe from parallel writers. Commits are in the user's name alone — only when instructed.
- Use `/wiki-save` to close a session, `/wiki-quiz` (this skill) to train your memory on what it filed, `/wiki-ask` to query, `/wiki-deep` for the periodic deep pass.

<!-- generated by src/plugin/build-assets.ts — edit skill/*.md, then re-run -->
