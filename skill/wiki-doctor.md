---
description: Diagnose and repair the active llmwiki installation and this repository's wiki — owned wiring first, then deterministic state and evidence-aware page repair
---

# /wiki-doctor — repair the active installation and this repository's wiki

Make the active llmwiki wiring and the current repository's `docs/wiki/` operational and
trustworthy. This workflow runs two distinct checks in order: `llmwiki doctor` for the
machine-level installation, then `llmwiki wiki-doctor` plus an evidence-aware agent repair pass for
the current project.

$ARGUMENTS

## Safety boundary

- The CLI owns safe, deterministic repairs only: missing skeleton files/directories, the
  rebuildable `.llmwiki/index.db`, citation/link graph, the bounded generated overview section, fully
  reflected capture watermarks, and eligible derived-database compaction.
- Markdown pages are the source of truth. Never rewrite a claim, delete provenance, resolve a
  contradiction, or choose project direction merely to make the report green.
- Preserve unrelated dirty-worktree changes. Do not commit or push unless the human explicitly
  asks.
- Installation repair is limited to llmwiki-owned hooks, skills, commands, launchers, and daemon
  wiring. Never overwrite a conflicting user-owned file.
- Human judgment is required only for direction shifts and genuinely unresolved contradictions.
  Ordinary lint repair, source lookup, cross-linking, and filing are the agent's work.
- Custom conventions: if `llmwiki config <repo>` shows a non-default source, run
  `llmwiki conventions <repo>` FIRST and follow ITS category table (dirs · domains · review
  gates) over any category names written in this workflow. The queue (`0_review/`) and quiz
  (`6_quiz/`) folders are fixed structure — those names never change.

## Procedure

1. Identify the harness running this workflow. Check only that harness's installation; do not infer
   the scope from every CLI installed on the machine. Never run the installation doctor without an
   explicit `--harness`.

   - Codex:

     ```sh
     llmwiki doctor --harness codex
     ```

   - Claude Code:

     ```sh
     bun ~/llmwiki/src/cli.ts doctor --harness claude --fix
     ```

   - OpenCode:

     ```sh
     llmwiki doctor --harness opencode
     ```

   The installation doctor can exit 1 for operational findings outside the selected harness, such
   as unenrolled repositories or capture backlog. A nonzero exit alone does not mean the active
   harness wiring is broken. Read the named findings: continue to the project check when the
   selected harness's llmwiki-owned files are current, and carry trust, enrollment, and backlog
   warnings into the final report.

   Claude's scoped `--fix` restores missing owned hooks and command files. If the report instead
   shows a wrong-clone hook, or Codex/OpenCode reports missing or stale owned wiring, run only the
   matching clone-pinned repair:

   - Claude Code:

     ```sh
     bun ~/llmwiki/src/daemon/wire.ts
     ```

   - Codex:

     ```sh
     bun ~/llmwiki/src/daemon/wire-codex.ts
     ```

   - OpenCode:

     ```sh
     bun ~/llmwiki/src/daemon/wire-opencode.ts
     ```

   Re-run the same scoped installation doctor after a repair. Stop at an unrelated-file conflict
   instead of overwriting it. Codex hook trust remains a user-owned `/hooks` action; report it
   explicitly and do not claim the hooks are active before that verdict.

2. Set REPO to the current project root (`$CLAUDE_PROJECT_DIR` when available, otherwise cwd).
   Run:

   ```sh
   llmwiki wiki-doctor <repo> --fix
   ```

   Continue even when it exits 1: that means deterministic repair completed but one or more
   evidence-bearing problems still need this agent's judgment. Read the entire report.

3. Repair every blocking lint error without weakening the underlying knowledge:

   - `page-secret`: remove only the credential or private value. Preserve the useful statement and
     its citation.
   - `unresolved-citation`: locate the real source. A human statement/decision cites its session
     transcript; a code fact cites one existing repo-relative path. Never delete the footnote or
     claim merely to silence lint.
   - missing/duplicate footnote definitions: repair the definition mechanically while preserving
     the claim-to-source relation.
   - dangling links: point to the intended existing page only when the relationship is evident;
     otherwise remove the broken navigation token without inventing a relationship.
   - missing or invalid frontmatter: derive fields from the page body and active
     `llmwiki conventions <repo>` output. Do not invent a decision, status, or date.
   - invalid supersession: find the actual newer page and repair `superseded_by`; never fabricate a
     target.

   Validate each edited page immediately:

   ```sh
   llmwiki index <repo> >/dev/null
   llmwiki lint <repo> --path '<path under docs/wiki>' --errors-only
   ```

4. Triage warnings by meaning, not by count:

   - `missing-excerpt`: add an excerpt only from the cited source via `llmwiki excerpt`; never
     synthesize a quotation.
   - orphan/cross-link warnings: add a link only when an explicit relationship exists in the
     evidence or page text.
   - stale/supersession warnings: require a newer authority. Preserve the old body and mark
     supersession; do not rewrite history.
   - terminology warnings: make a wording-only substitution that does not change the claim.
   - newly written repair text: use `/wiki-save`'s structure contract — numbered sections (`## 1.`, `### 1-1.`) when the page holds several groups, then `-` → `    -` → `        -`
     and noun-phrase/telegraphic endings where natural. Never reformat an existing grounded page
     solely for style.
   - oversized topics, recurring concepts, backlog, and open gaps: report them as `/wiki-deep`
     work. Do not perform a broad topic rewrite inside doctor.
   - advisory no-citation warnings on navigation or direction pages may remain when they contain
     no factual claim.

5. If the report says semantic review is due, run:

   ```sh
   llmwiki review <repo> --commit --if-due
   llmwiki gaps <repo>
   ```

   If it says a prior launch is incomplete, rerun the review with
   `llmwiki review <repo> --commit --force`, then run `llmwiki gaps <repo>`.
   Apply grounded stale-claim and cross-link findings. Put only unresolved contradictions or
   direction choices into `docs/wiki/0_review/`; never auto-resolve them.

6. Re-run `llmwiki wiki-doctor <repo> --fix`. Repeat the blocking repair pass at most three times.
   Stop once there are zero blocking problem groups. Do not loop just to erase advisory warnings.

## Report

Return: installation doctor verdict and owned wiring repairs; deterministic project repairs applied;
page files changed and why; blocking problems remaining; warning groups intentionally deferred;
semantic review/gap status; final project `wiki-doctor` verdict. If a blocker remains, name the
exact installation surface or page, evidence needed, and why guessing would be unsafe.
