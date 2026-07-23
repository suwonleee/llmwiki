# llmwiki installation contract for coding agents

You are installing the public `llmwiki` repository for the human who opened this coding-agent session. Treat this file as an execution contract, not as user-facing marketing copy.

## Objective

Install this clone as the local llmwiki engine for the coding agent currently running, verify the installation, and give the human the shortest accurate next steps.

## Boundaries

- Work from the repository clone that contains this file. Confirm the absolute clone path before running setup.
- Read `README.md`, `setup.sh`, and `llmwiki.config.example.toml` before changing anything.
- Do not commit or push.
- Do not add an MCP server, Docker service, external database, vector database, cloud service, or new project dependency.
- Do not overwrite unrelated user configuration. The setup scripts already merge or reject conflicts at their owned boundaries.
- Do not copy private project files, transcripts, credentials, or wiki content into this public engine clone.
- Do not create `llmwiki.config.toml` unless the human asks for custom conventions.
- Do not migrate an existing wiki unless the human explicitly approves the migration after seeing the dry-run.

## Procedure

1. Confirm that this shell is inside the llmwiki clone and record its absolute path.
2. Identify the active harness from the current session: Claude Code, Codex, or OpenCode. Do not guess when the current harness is already evident.
3. Check the required local tools:
   - `git`
   - Bun 1.1 or newer
   - the CLI for the active harness: `claude`, `codex`, or `opencode`
4. If Bun or the active harness CLI is missing, stop before mutation and tell the human exactly what is missing. Do not install unrelated tools.
5. Run the installer for the active harness from the clone root:

   ```bash
   ./setup.sh --harness claude
   # or, when this is a Codex session:
   ./setup.sh --harness codex
   # or, when this is an OpenCode session:
   ./setup.sh --harness opencode
   ```

   Use `--harness auto` only when the human explicitly wants every detected harness wired on this machine.

6. Preserve the complete setup output. If setup reports a conflict or unsupported CLI version, stop and explain the exact boundary instead of bypassing it.
7. Run the appropriate health check:
   - If setup reports that `~/.local/bin` is not on `PATH`, apply the exact `export PATH=...` command it printed first.
   - Codex or OpenCode installation: `llmwiki doctor`
   - Claude-only installation: `bun <absolute-clone-path>/src/cli.ts doctor --harness claude`
8. For Codex, tell the human about the required one-time manual action: start Codex in a project, open `/hooks`, inspect the two llmwiki hooks, and trust them. Never claim the hooks are active before Codex confirms that trust.
9. Report what setup installed, the health-check result, any remaining manual action, and the exact clone path now used by the wiring.

## Tell the human how to use it

After a successful installation, give these instructions:

1. Move to any project and start the same coding agent there.
2. Work normally. llmwiki captures locally; no MCP connection is needed.
3. Close a meaningful session with `/wiki-save` in Claude Code or OpenCode, or `$wiki-save` in Codex.
4. Run `/wiki-deep` in Claude Code or OpenCode, or `$wiki-deep` in Codex, periodically for backlog and deeper maintenance.
5. Project wiki pages accumulate under that project's `docs/wiki/`.
6. To customize conventions, copy `llmwiki.config.example.toml` to `llmwiki.config.toml`, edit only that config, run the config check, and show the human the result before any migration.

## Local architecture to describe accurately

llmwiki requires Bun and uses local lifecycle hooks, a local capture daemon, local SQLite state/indexes, and plain git markdown in each project. It does not require an MCP server, Docker, an external or vector database, or a cloud service.
