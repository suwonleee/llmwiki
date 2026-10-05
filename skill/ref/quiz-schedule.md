# quiz-schedule — the `/wiki-quiz` scheduling model (engine-owned)

Reference only: the engine computes all of this (`quiz-status` / `quiz-next` / `quiz-record`). Read it when the human asks how scheduling works or a due date looks wrong — never to re-derive a schedule by hand.

- Ledger: `docs/wiki/6_quiz/quiz-ledger.<id>.md` — **per person** (the forgetting curve is per-human; `<id>` resolves from git identity, `LLMWIKI_QUIZ_IDENTITY` overrides; a legacy bare `quiz-ledger.md` is adopted by the first identity to quiz, history intact). Engine-managed markers (`<!-- quiz:{…} -->`) — **never hand-edit**.
- Forgetting curve, day-granular (min 1 day): boxes at **1 · 3 · 7 · 16 · 35 · 60 days**. correct → next box; wrong/skip → box 0. An item asked today is never re-selected today.
- `quiz-next` priority: ① wrong/skip items due (oldest first) ② correct items whose curve review arrived ③ never-quizzed pages — direction(4) > decision·topic(3) > insight(2) > milestone(1); within a weight, hub pages (2+ inbound references, the cold start's own "most-referenced" definition) come first, then newest. The hub step is the engine's answer to "ask about the core of the work": the graph, not the category, distinguishes a landmark from a passing note.
- superseded/draft pages and vanished pages are excluded automatically; the quiz layer itself is excluded from index/search/cold-start (one-directional: wiki → human).
- The day boundary is **UTC** (engine-wide date convention) — for a KST user "today" flips at 09:00 KST, so a pre-9am session counts as the previous quiz day.
