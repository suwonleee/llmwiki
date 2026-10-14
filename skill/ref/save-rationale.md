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

- It restarts a capture daemon older than the engine code, so the day's fixes run now.
- Observed 2026-08-21: a live daemon ran the day's fixes 209 minutes late because restarting relied on a human remembering launchctl.
- The close-out is where upkeep latency is already consented to — never fail the close-out over it.

## 8. Why subagents write long returns to a file

- Issue-#956 class failure: long inline returns from a subagent intermittently collapse into summaries and the original is unrecoverable.

## 9. Why active rules stay in L0, untrimmed

- A standing convention or prohibition the human set (a `3_decision/` page) gets ONE line in L0's Active rules section, after Direction: the rule itself, concrete enough to apply without opening the page (names, formats, the forbidden default), plus a link to the decision.
- Measured 2026-10-14 (real harness, 2 repos × 4 scenarios): once now/next moved on, a decision that lived only in pages was applied 0/8 times by later coding sessions; kept as an Active rules line, 8/8. Coding sessions opened no wiki page in 24 runs; L0 is the channel that reaches them.
- The line goes when its decision is deprecated or replaced. Past ~8 lines, fold related ones into one line linking a `5_topic/` conventions page.
- A rule whose scope is a set of code paths also rides on its decision page as `x-llmwiki: { applies_to: ["src/adapters/**"], rule: "<the same one line>" }` (≤ 300 chars; globs relative to the repo root — a pattern without `/` matches a file name at any depth). The PreToolUse hook delivers it at the moment an Edit/Write targets a matching file, once per session, at most 3 per edit — so path-scoped rules need not all fit in L0's ~1,600 chars. Measured: agents ignore "search before editing" instructions; injection is the channel that reaches them. Retiring the decision (`status: deprecated`) retires the injection; lint warns on a malformed shape.
- `recall` (optional, same mapping): 2–5 short phrases a FUTURE request would contain — task nouns, API/tool names, file or feature names (`["Figma 연동", "fetch_nodes", "외부 API 클라이언트"]`), not the rule's own words, which already match. The per-turn hook matches them like the page title at a higher weight and, for a page it selects, injects the rule line itself (else the best-matching section, ≤ 500 chars). Measured 2026-10-14: prompts naming the task ("Figma fetch_nodes 추가") shared no words with the deciding rule (outbound httpx User-Agent), so the per-turn hook found it 0/4 times; and pointer lines alone were never followed — only text already in context changed behaviour.
- Retired pages (`status: deprecated`/`superseded`, or any page with `superseded_by`) are never injected — not per turn, not in cold-start lists, not as edit rules; `llmwiki search` still finds them, marked `(deprecated)`. An Active rules line linking one is lint `l0-rule-deprecated`: restate it from the successor or drop it.
