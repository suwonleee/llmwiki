# team-merge — git conflict recovery on a shared wiki

Use this when a git merge or rebase conflicts inside `docs/wiki/`.

- `log.md` merges automatically (`merge=union` via the skeleton's `.gitattributes`).
- `gap-queue.md` and `overview.md` are whole-file regenerated — on a git conflict, take either side, then re-run `llmwiki gaps <repo>` / `llmwiki overview --normalize <repo>`; both converge.
- Never hand-merge their generated bodies.
- Everything else is mostly new pages + appends (concurrency-safe by construction); resolve a real page conflict like any other content conflict, keeping every grounded line and its citation.
