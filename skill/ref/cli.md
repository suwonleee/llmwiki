# cli — what the close-out engine calls do

Reference for the commands `/wiki-save` and `/wiki-deep` run. `llmwiki` here means the engine invocation your skill resolved.

- `llmwiki update-status <repo>` — list unprocessed transcripts (only those with tail after the watermark).
- `llmwiki update-next <repo> <transcript>` — extract **only the unprocessed part** (incremental, cheap). First line: `cwd/session/new_offset`. It also registers the transcript it processes as a citable source.
- `llmwiki update-done <repo> <transcript> <offset>` — advance the watermark (processed). `--skipped` for noise.
- `llmwiki consolidate <repo>` — plain = dry-run: surface this session's topic candidates. `--commit` runs the gated unattended merge (strong-model write → independent verify → grounding → lint); a warm close-out uses the dry-run, then authors/merges the pages itself.
- `llmwiki topics <repo>` — deterministic topic view (pages clustered by shared tag/citation; no LLM, regenerable).
- `llmwiki index <repo>` — incremental index; it rebuilds the refs graph too.
- `llmwiki lint <repo> [--path <page>] [--errors-only]` — `--path` scopes lint to one page (write-time validation); `--errors-only` prints errors in full and collapses warnings to per-code counts.
- `llmwiki review <repo> --commit --if-due` — semantic review behind the engine-enforced cadence gate (`LLMWIKI_REVIEW_INTERVAL_DAYS`, default 7; `--force` overrides). The engine stamps a launch marker and reports `prev_launch_incomplete` on its next invocation if a backgrounded run died before committing.
- `llmwiki reconcile <repo> --commit` — advance the capture watermark for sessions a wiki page now cites (a warm close-out doesn't auto-advance it).
- `llmwiki register-transcript <repo>` — register this session's transcripts as **citable sources**. `update-next` already registers the one it processes; needed only when a page was written outside that flow.
- `llmwiki excerpt <transcript.jsonl> [--kind judgment|fact] [--limit N]` — candidate evidence excerpts (verbatim, capped, secret-screened).
- `llmwiki digest <repo>` — deterministic relational digest (hubs · freshness · 0_review · contributors from git history). No LLM, regenerable.
