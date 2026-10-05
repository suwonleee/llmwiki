---
name: wiki-deep
disable-model-invocation: true
description: Periodic deep pass (day end · weekly · when a close-out report recommends it) — file what is important from the transcript backlog and skip the rest, run the semantic review, work the gap queue, re-distill oversized topic pages. Unfiled records expire by design; the per-session close-out is `/wiki-save`
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

# /wiki-deep — periodic deep pass (backlog · review · gaps · re-distill)

The **volume half** of the two-pass model: `/wiki-save` closes each session warm, O(this session); `/wiki-deep` periodically consumes everything deferred. Run it at day end, weekly, or whenever a close-out report recommends it. A session that never got a warm close-out is still in the transcript backlog (byte watermarks); this pass files what in it is **important** — decisions, direction changes, root causes, measured results, contradictions — and explicitly skips the rest. **The backlog is raw material, not debt**: unfiled records expiring is by design, and marking sessions done without reading them is worse than an honest skip. Gap-filling and backlog grunt work are the LLM's bookkeeping, not the human's (humans abandon wikis when maintenance lands on them) — just never in the latency-critical per-session close-out.

**Prerequisite — Read the /wiki-save skill FIRST**: the execution rules, categories, writing rules, filing procedure, topic-consolidation invariants, and close-out checks are all defined in the `/wiki-save` skill and are used by every step below. If it is not already in context, Read `<plugin-root>/skill/wiki-save.md` before starting. This file adds only the deep extras. Detail both passes share (page formats, the consolidation rubric, review findings, re-distill) prints on demand with `llmwiki conventions <repo> --section <name>` — fetch each section only at the step that names it.

(`deep` as an argument is accepted for backward compatibility — it is now the default and only mode of this command.)

$ARGUMENTS

## Procedure

0. **Announce scope first (the bail-out gate)**: before doing anything, print the workload so the human can bail to `/wiki-save` if they only wanted a quick session close: pending backlog count (`llmwiki update-status <repo>`), open gap count (from `0_review/gap-queue.md`), oversized topic count (plain `llmwiki lint <repo>` → `topic-oversize`), and a wall-clock estimate (measured ~40s+/pending session). REPO = cwd (`$CLAUDE_PROJECT_DIR`); if `docs/wiki/` is missing, `llmwiki skeleton <repo>` then proceed.

0b. **Structure-drift preflight (before ANY writing)**: run `llmwiki migrate <repo>` — the dry-run doubles as the detector. If it plans renames (or cold-start showed a `[llmwiki config drift]` line), resolve that FIRST: this pass writes pages into category folders, and writing on a drifted structure grows the split-brain (new pages land in the config's dirs while old pages sit in the old ones) — and deferred drift degrades from automatic pairing to manual `--map`. Show the human the dry-run plan, get ONE OK, then `llmwiki migrate <repo> --commit` (add `--map old=new` for any `⚠ unmapped` dir that still holds pages; empty ones are cleaned automatically). Reverse drift (".schema-version differs from this engine's config") means YOUR engine clone is the stale side — `git pull` the engine clone instead of migrating. Never migrate without the human's OK; never defer it until after the volume work.

1. **Run the full `/wiki-save` close-out for THIS session** — its steps 1b–9 (0_review Q./A. items → file this session → consolidate its topics → L0 → overview → log → deterministic close-out). Deep is a superset: everything below expands on those steps. In the `log.md` line (step 6 there), use the marker `## [YYYY-MM-DD] sync | <one-line>` instead.

D1. **File what matters from the backlog** (expands filing beyond this session), oldest first, per the `/wiki-save` filing procedure (step 2 there): `update-next` → read the extract → file only the important items (validate-as-you-write) → `update-done`; a session with nothing important → `update-done … --skipped`. Sub-agent/fork threads never reach this list (the engine records them as skipped).
   - **Never mark `update-done` without `--skipped` on a session whose extract you did not read.** The engine accepts only the `new_offset` its last `update-next` issued for that transcript; do not work around the refusal.
   - **Large backlog (more than ~20 pending, or more than the time the human accepted in step 0) → triage deterministically first**: per transcript, read only the extract header (`llmwiki update-next <repo> <transcript> | head -3` → `users=` human-turn count, `# touched:` roots, `# ⚠ route:`). Read in full only sessions with substantive human text; `--skipped` the rest at the header's `new_offset`. Then decide file-or-skip one session at a time — never batch-mark.
   - If the backlog is repeatedly large, propose enabling the unattended fact-layer daemon (`bash <clone>/daemon/autoupdate-schedule.sh` — gated write→independent-verify→grounding→lint, default OFF) — volume belongs there, judgment stays warm.
   - **Per-session scope judgment (mandatory)**: capture buckets a session by its START cwd, so a session that began in this repo (or an enrolled home) while working on ANOTHER project lands here anyway — and `cwd=` on the header cannot detect it, because bucket and cwd agree by construction. Read the deterministic signal instead: the header's `# touched:` line (git roots where the segment's file mutations landed) and the `# ⚠ route:` advisory that appears when the dominant root is not this repo. Then choose:
     - dominant root is another repo **you maintain** (enrolled) → file the session into THAT repo's wiki (per `/wiki-save` step 2) and advance the watermark here: `update-done <this-repo> <transcript> <offset>`;
     - genuinely foreign work (someone else's project, a throwaway clone) → `update-done <repo> <transcript> <offset> --skipped` and note it in the report (one line: `skipped N cross-project: <names>`);
     - no mutations at all (chat-only) → it belongs to this bucket; file or skip on content as usual.
     Every `⚠ route` session goes into the report with what was done with it. Filing cross-project sessions into this wiki is mis-filing; the transcript stays immutable for that project's own wiki. This scope gate is warm-only (LLM judgment on top of the deterministic line) — an unattended daemon has no such judgment, so cross-scope wikis are not yet safe to automate.

D2. **Full semantic review + work the gap queue**: run `llmwiki review <repo> --commit` (no `--if-due`; the no-change cache still applies, `--force` only if you must), then `llmwiki conventions <repo> --section review-findings` and follow it: announce findings, `> [conflict]` callouts for real contradictions (never overwrite), only **direction-level** conflicts to `0_review` (item format: `llmwiki conventions <repo> --section review-item`). Then `llmwiki gaps <repo>` and **fill up to 5 open gaps, oldest first** — a `missing-concept` gap by the topic-consolidation rules (`llmwiki conventions <repo> --section consolidate`; re-ground from transcripts/raw evidence — never re-summarize other wiki pages), a `next-question` gap by wikilinks with explicit relation words. Near-duplicate gaps are filled ONCE; leave open only what genuinely needs human judgment, and announce those. Never hand-edit the queue's `<!-- gap:… -->` markers.

D3. **Re-distill oversized topic pages**: when lint shows `topic-oversize`, run `llmwiki conventions <repo> --section distill` and follow it page by page. Its hard gates, which no page skips: **snapshot FIRST** into `llmwiki state-path <repo> distill --ensure`, rebuild **only from the page's cited transcripts**, and `llmwiki distill-verify <snapshot> <page>` must pass before moving on.

D4. **Prune dead capture rows** (deterministic, zero LLM): `llmwiki capture-prune`. Pending rows whose transcript — and `.zst` sibling — is gone past the 30-day age guard (`--older-than N`) become `lost` tombstones; rows of deleted temp-root repos and sub-agent/fork threads become `skipped`. Rows stay on the books, distilled rows are never touched. The daemon runs the same prune daily; this is the explicit catch-up.

D5. **Index maintenance escalation (deterministic; no semantic cleanup)**: rebuild the fresh index and finish its structural lint before consulting the health signal:
    ```sh
    llmwiki index <repo>
    llmwiki lint <repo> --errors-only
    llmwiki db-health <repo> --notice
    ```
    - Record the pre-maintenance `databaseBytes`, `freeBytes`, `freeRatio = freeBytes / databaseBytes`, and `liveIndexedBytes`. **Only** when the CLI reports compaction eligible, run the bounded storage repair, then recheck:
      ```sh
      llmwiki compact <repo> --commit
      llmwiki db-health <repo>
      ```
      Otherwise report `action: no-action`; do not run `compact` just because a database exists.
    - Compare the before/after measurements. If compaction cleared a free-ratio-only pressure, report `action: compacted; wiki-clean: not recommended` — no semantic cleanup follows storage-only reclamation.
    - Recommend cleanup only when the **post-compact** `liveIndexedBytes` remains above 30 MiB. Print this exact manual, dry-run command in the report; do **not** execute it, do not add `--commit`, and do not run `wiki-clean-apply`:
      ```sh
      llmwiki wiki-clean <repo>
      ```
      `wiki-clean` is a reversible tiering review, not a deep-pass side effect: dirty worktrees, protected pages, ambiguous cases, and human approval remain its own command's responsibility.

R. **Report** — the /wiki-save report line plus the deep extras: "backlog filed F · skipped S · pending left P (F and S = the difference of the `ledger:` line of `llmwiki update-status <repo>` before vs after this pass — engine counts, never your own tally) / ⚠ route sessions: <transcript → filed into <repo> | skipped> each / review: findings F / gaps filled K (open M) / topics distilled D (distill-verify: pass) / capture pruned P / maintenance before: db D free F ratio R live L / after: db D free F ratio R live L / action: no-action|compacted|recommend `llmwiki wiki-clean <repo>` / L0 refreshed / lint error·warn counts".

## Deep-specific engine CLI (`bun "<plugin-root>/src/cli.ts"`; what the shared close-out calls do: `llmwiki conventions <repo> --section cli`)
- `llmwiki review <repo> --commit` — full semantic review (deep runs it WITHOUT `--if-due`; the per-session close-out relies on the cadence gate).
- `llmwiki distill-verify <snapshot.md> <page.md>` — deterministic no-loss gate for a topic re-distill (D3): fails (exit 1) if the new page dropped any citation source or `> [conflict]` callout present in the pre-distill snapshot.
- `llmwiki lint <repo>` (plain, no `--errors-only`) — enumerate `topic-oversize` paths for D3.
- `llmwiki gaps <repo>` — fold review findings into the tracked, self-closing `0_review/gap-queue.md`.
- `llmwiki capture-prune [--older-than N]` — tombstone pending rows whose transcript is gone past the age guard, skip dead temp-repo and sub-agent rows (D4; default 30 days).
- `llmwiki db-health <repo> [--notice]` — cheap storage/integrity report; plain health is read-only, while `--notice` records the maintenance-notice cooldown used by D5.
- `llmwiki compact <repo>` / `--commit` — default dry-run versus the D5-only committed FTS optimize + VACUUM after the CLI marks compaction eligible.
- `llmwiki wiki-clean <repo>` — manual, reversible dry-run tiering review; D5 may recommend it only after post-compact live indexed bytes remain above 30 MiB.

## Principles
- All `/wiki-save` principles apply (supersession, anti-drift re-grounding, routine judgment vs human direction, defer-don't-drain, commits in the user's name only when instructed, team merge recovery).
- **Important, not everything**: file what matters, skip the rest explicitly, let unfiled records expire. An honest skip is a result; an unread session marked filed is a false record. If deep passes stop happening, propose the unattended daemon rather than bulk-marking the backlog.
- Volume here, judgment warm: this pass does the grunt work (backlog, gaps, re-distill), but direction shifts and unresolved contradictions still go to `0_review` for the human — never auto-resolve them.
- Use `/wiki-save` to close out a session, `/wiki-ask` for a question, `/wiki-deep` (this skill) for the periodic deep pass.

<!-- generated by src/plugin/build-assets.ts — edit skill/*.md, then re-run -->
