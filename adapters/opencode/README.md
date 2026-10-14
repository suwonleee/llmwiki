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

**OpenCode 1.x and 2.x.** The plugin file's default export carries both entry points:
`server` for 1.x and `setup` for 2.x, and each version reads only its own (measured on 1.19.0
and 2.0.27). OpenCode 2 keeps the binary name, the config folder and `commands/`, so the same
install serves both. On 2.x a `/wiki-*` command reaches the plugin as its expanded template, so
the session id is attached by recognizing the managed marker in the template instead of a
command hook. A plugin installed before this port has only the 1.x entry point; `llmwiki doctor`
reports it as stale and re-running the installer fixes it.

OpenCode 2 migrates its database in place: sessions move to `session_v2` with message ids kept,
and the legacy tables stop updating. Capture reads `session_v2` when it exists, and a session
that was exported under 1.x and continued under 2.x switches to the new cursor without
re-exporting what it already filed.
