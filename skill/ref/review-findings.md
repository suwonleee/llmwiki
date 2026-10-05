# review-findings — handling semantic-review output and the gap queue

Use this when `llmwiki review` output reaches the session (a backgrounded `/wiki-save` run that finished while the session is open, or `/wiki-deep`'s full review), and before filling gaps.

## 1. Findings

- The advisory draft lands in `0_review/` (never edits live pages), and the next session's cold-start surfaces the `0_review` count — nothing is lost by not waiting for a backgrounded run.
- **Announce findings in chat.**
- A real *contradiction* → add a `> [conflict] …` callout to the relevant `5_topic` page (never overwrite).
- Route only **direction-level** conflicts to `0_review` for the human — never auto-resolve them (item format and `owner:` stamp: `llmwiki conventions <repo> --section review-item`).
- `prev_launch_incomplete` in any review output → report it in chat ("이전 백그라운드 리뷰가 커밋 없이 종료"). The cadence gate makes the died review due again, so the current launch already re-runs it; the flag exists so a background death is never invisible.

## 2. Gap queue

- `llmwiki gaps <repo>` (fast, deterministic) folds committed reviews to date into the tracked, self-closing `0_review/gap-queue.md`.
    - Today's backgrounded findings get folded on the next pass.
    - A `semantic-review-*.md` report is deleted only after its gaps have been folded into the queue.
    - A gap auto-closes once review stops re-flagging it for 2 runs (review is bounded + cached).
- Filling a gap:
    - a `next-question` cross-link gap → add the wikilinks with explicit relation words;
    - a contradiction gap → the `> [conflict]` callout;
    - a `missing-concept` gap → create-or-update the `5_topic/` page by `llmwiki conventions <repo> --section consolidate` (re-ground from transcripts/raw evidence — never re-summarize other wiki pages).
- Near-duplicate gaps are filled ONCE. Leave open only what genuinely needs human judgment (contradictory measurements, direction calls) — announce those.
- A deferred gap is never lost: it stays tracked in the queue until some pass fills it. **Never hand-edit the queue's `<!-- gap:… -->` markers.**
