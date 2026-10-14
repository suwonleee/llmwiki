# OpenCode adapter — global plugin + slash commands

The supported installation path is:

```bash
./setup.sh --harness opencode
```

It installs three user-level surfaces:

- `$XDG_CONFIG_HOME/opencode/plugin/llmwiki.ts` (default
  `~/.config/opencode/plugin/llmwiki.ts`) for cold-start and per-turn read injection.
- `$XDG_CONFIG_HOME/opencode/commands/wiki-{save,deep,doctor,ask,quiz}.md` for
  `/wiki-save`, `/wiki-deep`, `/wiki-doctor`, `/wiki-ask`, and `/wiki-quiz`.
- `~/.local/bin/llmwiki`, unless `LLMWIKI_BIN_DIR` selects another user bin directory.

The installer preserves unrelated files, refuses name collisions, re-points managed
surfaces after a clone move, and supports a dry run and clone-aware revert:

```bash
bun <clone>/src/daemon/wire-opencode.ts --dry-run
bun <clone>/src/daemon/wire-opencode.ts
llmwiki doctor --harness opencode
bun <clone>/src/daemon/wire-opencode.ts --revert
```

The plugin caches cold-start context per process and keeps the latest prompt per OpenCode
session before requesting precision-first turn pointers from the shared engine. Failures
remain silent so llmwiki cannot break an OpenCode turn.

**OpenCode 1.x only.** OpenCode 1.19 offers `/update` / `opencode upgrade --major` to
OpenCode 2, which keeps the `opencode` binary and config folder but does not load 1.x
plugins — injection stops without an error. `llmwiki doctor` reports a 2.x CLI; stay on
1.x (npm `opencode-ai`) until the plugin is ported.
