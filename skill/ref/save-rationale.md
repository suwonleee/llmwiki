# save-rationale — why the close-out is shaped the way it is

Background only; nothing here is a step. Read it when a rule in `/wiki-save` seems arbitrary, or when someone asks why.

## 1. Why a human-invoked command, not a hook

- No harness offers a reliable LLM-capable "session end" hook.
    - Claude Code's SessionEnd is shell-only with a ~1.5s budget.
    - OpenCode has no true session-close event.
    - Codex automates only via hooks.
- The warm command is the quality path; any session that skips it lands safely in the backlog for `/wiki-deep`.

## 2. Why minutes, not tens of minutes

- Close-out latency is what makes people abandon a wiki (the maintenance-burden rule), so the pass is strictly O(this session).
- Measured: draining the backlog inline costs ~40s+/session, so an 11-session backlog turns a close-out into a 10-minute wait.
- Slowness, not deferral, is what loses information: a close-out people skip records nothing.

## 3. Why deferring is safe — within the retention window

- The capture watermarks, gap queue, and lint backlog are durable, so everything deferred stays queued.
- The transcript itself is not immutable: Claude Code deletes its transcripts on `cleanupPeriodDays` (default 30); Codex keeps them. Once the harness deletes it, that session can no longer be filed.
- An un-filed session that ages out is **self-selection, not loss** — the human judged it not worth keeping (2026-07-28: for daily work the "expiring soon" band is perpetually non-empty, so the engine never pushes deadlines; retention detail is on pull only, via `llmwiki doctor`).

## 4. Why the semantic review runs in the background

- It is the one heavy step in an otherwise minutes-scale close-out, and it hits every repo's *first* close-out unconditionally (no prior state → always due).
- Inline it breaks the latency contract exactly when first impressions matter; backgrounded, cadence and wall-clock are both kept.

## 5. Why L0 is trimmed during the close-out

- L0 is injected whole at every cold start, so an over-budget L0 is a per-session tax the cold-start banner keeps flagging until someone acts.
- "Someone" is the close-out, because invoking it is the moment the human has already accepted upkeep latency (2026-08-05 direction).

## 6. Why overview stays bounded

- The entry point's size must stay O(tracks), not O(sessions), so it never approaches the context-overflow cliff (ref: LLM-Wiki-v3 namespace index, KnowledgeWeaver).

## 7. Why `daemon-sync` rides in the close-out

- Observed 2026-08-21: a live daemon ran the day's fixes 209 minutes late because restarting relied on a human remembering launchctl.
- The close-out is where upkeep latency is already consented to — never fail the close-out over it.

## 8. Why subagents write long returns to a file

- Issue-#956 class failure: long inline returns from a subagent intermittently collapse into summaries and the original is unrecoverable.
