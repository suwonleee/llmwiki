---
description: Periodic deep pass (day end · weekly · when a fast close-out recommends it) — drain the transcript backlog, run the semantic review, work the gap queue, re-distill oversized topic pages. The lossless catch-up safety net; the per-session close-out is `/wiki-update`
---

# /wiki-sync — periodic deep pass (backlog · review · gaps · re-distill)

The **volume half** of the two-pass model: `/wiki-update` closes each session fast (warm, O(this session)); `/wiki-sync` periodically consumes everything deferred. Run it at day end, weekly, or whenever a fast close-out's report recommends it. **This pass is the safety net that makes deferral lossless**: a session that never got a warm close-out is still captured in the transcript backlog (byte watermarks), and this pass drains it — the session-start hint ("N un-updated sessions → `/wiki-sync`") points here. Gap-filling and backlog grunt work are the LLM's bookkeeping, not the human's (humans abandon wikis when maintenance lands on them) — just never in the latency-critical per-session close-out.

**Prerequisite — Read the fast skill FIRST**: the execution rules, categories, writing philosophy, filing procedure, topic-consolidation rubric, page formats, and close-out checks are all defined in the `/wiki-update` skill and are used by every step below. If it is not already in context, Read `~/llmwiki/skill/wiki-update.md` before starting. This file adds only the deep extras.

(`deep` as an argument is accepted for backward compatibility — it is now the default and only mode of this command.)

$ARGUMENTS

## Procedure

0. **Announce scope first (the bail-out gate)**: before doing anything, print the workload so the human can bail to `/wiki-update` if they only wanted a quick session close: pending backlog count (`llmwiki update-status <repo>`), open gap count (from `0_review/gap-queue.md`), oversized topic count (plain `llmwiki lint <repo>` → `topic-oversize`), and a wall-clock estimate (measured ~40s+/pending session). REPO = cwd (`$CLAUDE_PROJECT_DIR`); if `docs/wiki/` is missing, `llmwiki skeleton <repo>` then proceed.

1. **Run the full fast close-out for THIS session** — `/wiki-update` steps 1b–9 (0_review Q./A. items → file this session → consolidate its topics → L0 → overview → log → deterministic close-out). Deep is a superset: everything below expands on those steps. In the `log.md` line (step 6 there), use the marker `## [YYYY-MM-DD] sync | <one-line>` instead.

D1. **Drain the full backlog** (expands filing beyond this session): process EVERY pending transcript per the `/wiki-update` filing procedure (step 2 there), **oldest first** — `update-next` → route by category → write pages (validate-as-you-write) → `update-done`. If the backlog is repeatedly large, propose enabling the unattended fact-layer daemon (`bash <clone>/daemon/autoupdate-schedule.sh` — gated write→independent-verify→grounding→lint, default OFF) — volume belongs there, judgment stays warm.
   - **Per-session scope judgment (mandatory)**: capture buckets a session by its START cwd, so a session that began in this repo but `cd`'d into a nested subproject lands here anyway. Before filing, check the `cwd=` on the `update-next` header: if the session's real working project is a DIFFERENT project (a nested subdir with its own identity — its own `.git`/`AGENTS.md`, or clearly another repo's work) rather than THIS wiki's project, do NOT file it here — `update-done <repo> <transcript> <offset> --skipped` and note it in the report (one line: `skipped N cross-project: <names>`). Draining cross-project sessions into this wiki is mis-filing; the transcript stays immutable for that project's own wiki. This scope gate is warm-only (LLM judgment) — an unattended daemon has no such judgment, so cross-scope wikis are not yet safe to automate.

D2. **Full semantic review + work the gap queue**: run `llmwiki review <repo> --commit` (no `--if-due`; the no-change cache still applies, `--force` only if you must). Announce findings in chat; for a real *contradiction*, add a `> [conflict] …` callout to the relevant `5_topic` page (never overwrite); route only **direction-level** conflicts to `0_review`. Then `llmwiki gaps <repo>` to fold findings into the self-closing queue, and **fill up to 5 open gaps, oldest first**: a `missing-concept` gap → create-or-update the `5_topic/` page by the **topic-consolidation rules** (re-ground from transcripts/raw evidence — never re-summarize other wiki pages); a `next-question` cross-link gap → add the wikilinks with explicit relation words. Near-duplicate gaps are filled ONCE. Leave open only what genuinely needs human judgment (contradictory measurements, direction calls) — announce those. Never hand-edit the queue's `<!-- gap:… -->` markers.

D3. **Re-distill oversized topic pages**: enumerate targets with a plain `llmwiki lint <repo>` (the close-out's `--errors-only` output only shows the `topic-oversize` count, not the paths). Then, for each oversized page:
   1. **Snapshot FIRST**: `mkdir -p <repo>/.llmwiki/distill && cp <page> <repo>/.llmwiki/distill/<filename>.<YYYY-MM-DD>.md`. The recovery net must hold the page's CURRENT state — git history cannot (commits happen only when instructed, so bullets accreted by recent fast close-outs are routinely uncommitted; a git diff would never show them being dropped).
   2. **Rebuild only from its cited transcripts** (raw re-grounding — the one rewrite the anti-drift rule allows; never from other wiki pages), collapsing accreted bullets into a current synthesis. `status: superseded`/`superseded_by` frontmatter is preserved verbatim.
   3. **Engine-verified no-loss gate (hard)**: `llmwiki distill-verify <snapshot> <page>` must pass — it deterministically checks that the **citation set did not shrink** (every `[^sN]` source on the snapshot is still cited; merging true duplicate footnotes is fine — set semantics — but say so in the report) and that every **`> [conflict]` callout survived verbatim**. Do not proceed on failure; restore the dropped items.
   4. **Claim check against the snapshot**: diff the new page against the SNAPSHOT (not git) and confirm every grounded claim is still represented and still attached to its own citation. Then run the scoped lint (validate-as-you-write).
   Keep the snapshot file until the distilled page has been committed to git; from then on git history really is the recovery net and the snapshot may be deleted.

R. **Report** — the fast report line plus the deep extras: "backlog drained N / review: findings F / gaps filled K (open M) / topics distilled D (distill-verify: pass) / L0 refreshed / lint error·warn counts".

## Deep-specific engine CLI (`bun ~/llmwiki/src/cli.ts`; the rest is listed in `/wiki-update`)
- `llmwiki review <repo> --commit` — full semantic review (deep runs it WITHOUT `--if-due`; the fast close-out relies on the cadence gate).
- `llmwiki distill-verify <snapshot.md> <page.md>` — deterministic no-loss gate for a topic re-distill (D3): fails (exit 1) if the new page dropped any citation source or `> [conflict]` callout present in the pre-distill snapshot.
- `llmwiki lint <repo>` (plain, no `--errors-only`) — enumerate `topic-oversize` paths for D3.
- `llmwiki gaps <repo>` — fold review findings into the tracked, self-closing `0_review/gap-queue.md`.

## Principles
- All `/wiki-update` principles apply (supersession, anti-drift re-grounding, routine judgment vs human direction, defer-never-drop, commits in the user's name only when instructed, team merge recovery).
- **Deferral is lossless only because this pass exists** — transcripts are immutable and watermarks/queue/backlog are durable, but something must eventually consume them. If deep passes stop happening, propose the unattended daemon rather than letting the backlog silently grow.
- Volume here, judgment warm: this pass does the grunt work (backlog, gaps, re-distill), but direction shifts and unresolved contradictions still go to `0_review` for the human — never auto-resolve them.
- Use `/wiki-update` to close out a session (fast), `/wiki-ask` for a question, `/wiki-sync` (this skill) for the periodic deep pass.
