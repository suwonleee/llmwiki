# distill — re-distilling an oversized topic page (the `/wiki-deep` D3 moment)

Use this when lint reports `topic-oversize`. `llmwiki` below — including inside the `$(…)` snippet — means the engine invocation your skill resolved (e.g. `bun "<root>/src/cli.ts"`); `llmwiki` on PATH exists only after a clone `setup.sh` or an npm install. Enumerate the targets with a plain `llmwiki lint <repo>` (the close-out's `--errors-only` output only shows the count, not the paths). Then, for each oversized page:

1. **Snapshot FIRST**: `D=$(llmwiki state-path <repo> distill --ensure) && cp <page> "$D/<filename>.<YYYY-MM-DD>.md"`.
    - Derived state is engine-held, so this never writes into the repository.
    - The recovery net must hold the page's CURRENT state — git history cannot: commits happen only when instructed, so bullets accreted by recent per-session close-outs are routinely uncommitted, and a git diff would never show them being dropped.
2. **Rebuild only from its cited transcripts** (raw re-grounding — the one rewrite the anti-drift rule allows; never from other wiki pages), collapsing accreted bullets into a current synthesis.
    - `status: superseded`/`superseded_by` frontmatter is preserved verbatim.
3. **Engine-verified no-loss gate (hard)**: `llmwiki distill-verify <snapshot> <page>` must pass.
    - It deterministically checks that the **citation set did not shrink** — every `[^sN]` source on the snapshot is still cited. Merging true duplicate footnotes is fine (set semantics), but say so in the report.
    - It checks that every **`> [conflict]` callout survived verbatim**.
    - Do not proceed on failure (exit 1); restore the dropped items.
4. **Claim check against the snapshot**: diff the new page against the SNAPSHOT (not git) and confirm every grounded claim is still represented and still attached to its own citation. Then run the scoped lint (validate-as-you-write).

Keep the snapshot file until the distilled page has been committed to git; from then on git history really is the recovery net and the snapshot may be deleted.
