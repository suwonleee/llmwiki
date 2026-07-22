# Codex adapter — native hooks + skills

The supported path is automatic and merge-safe:

```bash
./setup.sh --harness codex
```

This installs three user-level surfaces:

- `$CODEX_HOME/hooks.json`: merges llmwiki `SessionStart` and `UserPromptSubmit`
  handlers while preserving unrelated hooks.
- `$HOME/.agents/skills/wiki-{save,deep,ask,quiz}/SKILL.md`: Codex-native
  reusable workflows, invoked as `$wiki-save`, `$wiki-deep`,
  `$wiki-ask`, and `$wiki-quiz`.
- `$HOME/.local/bin/llmwiki`: a path-independent launcher for this clone.

After install, start interactive Codex and open `/hooks`. Review and trust the
two llmwiki commands once. Codex records trust against the current hook hash, so
changed or re-pointed handlers require another review. `llmwiki doctor` reports
whether the exact handlers and review records exist, but `/hooks` remains the
source of truth for the current-hash verdict.

Current Codex accepts an optional top-level `description` in `hooks.json`.
Commands run with the session cwd, and hook stdout on exit 0 is injected into
the model context. The shared scripts therefore work without a Codex-specific
fork:

- `hooks/sessionstart-inject.sh` — cold-start L0 and wiki index
- `hooks/userpromptsubmit-inject.sh` — related-page pointers per turn

## Manual and recovery commands

```bash
bun <clone>/src/daemon/wire-codex.ts --dry-run
bun <clone>/src/daemon/wire-codex.ts
llmwiki doctor
bun <clone>/src/daemon/wire-codex.ts --revert
```

The example [`hooks.json.example`](hooks.json.example) remains for users who
want repo-local/manual wiring. Replace `__LLMWIKI_ROOT__` with the clone's
absolute path, then review it in `/hooks`.

## Coexistence with OMX

The installer removes and re-points only commands containing llmwiki's two hook
script markers. Other hook groups, including OMX plugin hooks, are preserved.
If OMX's own wiki is enabled, both systems may inject a cold-start summary;
disable one wiki surface if the duplicate context is not useful.
