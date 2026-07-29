# llmwiki installation contract for coding agents

You are installing the public `llmwiki` repository for the human who opened this coding-agent session. Treat this file as an execution contract, not as user-facing marketing copy.

## Objective

Install this clone as the local llmwiki engine for the coding agent currently running, verify the installation, and give the human the shortest accurate next steps.

Use [`reference/INSTALLATION_FLOW.md`](reference/INSTALLATION_FLOW.md) for the shared sequence,
the active harness branch, and recovery rules. Read only the relevant harness section unless the
human explicitly requests multiple harnesses.

**Claude-only installs have no `llmwiki` launcher** (the launcher is installed by the Codex and
OpenCode wiring). On such an install, read every `llmwiki <args>` in this contract as
`bun <absolute-clone-path>/src/cli.ts <args>` — the subcommands and flags are identical.

## Boundaries

- Work from the repository clone that contains this file. Confirm the absolute clone path before running setup.
- Read `README.md`, `setup.sh`, `llmwiki.config.example.toml`, and the relevant section of
  `reference/INSTALLATION_FLOW.md` before changing anything.
- Do not commit or push.
- Do not add an MCP server, Docker service, external database, vector database, cloud service, or new project dependency.
- Do not overwrite unrelated user configuration. The setup scripts already merge or reject conflicts at their owned boundaries.
- Do not copy private project files, transcripts, credentials, or wiki content into this public engine clone.
- Do not create `llmwiki.config.toml` unless the human asks for custom conventions.
- Do not migrate an existing wiki unless the human explicitly approves the migration after seeing the dry-run.

## Procedure

- Locate and select
    - Confirm the clone containing `setup_text.md` and record its absolute path
    - Identify the active harness: Claude Code, Codex, or OpenCode
    - Read the shared flow and only that harness branch in `reference/INSTALLATION_FLOW.md`
- Check prerequisites
    - `git`
    - Bun 1.1 or newer
    - Active harness CLI: `claude`, `codex`, or `opencode`
    - Missing prerequisite → stop before mutation and report the exact item
- Run the read-only preflight
    - Claude Code: `./setup.sh --dry-run --harness claude`
    - Codex: `./setup.sh --dry-run --harness codex`
    - OpenCode: `./setup.sh --dry-run --harness opencode`
- Install from the clone root
    - Claude Code: `./setup.sh --harness claude`
    - Codex: `./setup.sh --harness codex`
    - OpenCode: `./setup.sh --harness opencode`
    - `--harness auto` only on an explicit request for every detected harness
- Preserve setup evidence
    - Keep the complete output
    - Conflict or unsupported CLI → stop at the exact boundary without bypass
- Verify the selected harness
    - Printed `PATH` action → apply that exact command first
    - Codex: `llmwiki doctor --harness codex`
    - OpenCode: `llmwiki doctor --harness opencode`
    - Claude-only: `bun <absolute-clone-path>/src/cli.ts doctor --harness claude`
- Confirm the harness data location (3-tier discovery)
    - Run `llmwiki locate <harness>` (Claude-only: `bun <absolute-clone-path>/src/cli.ts locate claude`)
    - A ✅ line means deterministic discovery verified the location — nothing more to do
    - No verified location while the harness IS installed here → this local is nonstandard: search
      the machine yourself (locate prints per-harness hints on what the location must contain),
      verify a candidate read-only with `llmwiki locate <harness> <path>`, then persist it with
      `llmwiki connect <harness> <path>`
    - `connect` records only an absolute path that passes the engine's schema-signature
      verification (fail-closed) — never bypass it by editing state files by hand, and never
      persist a guess
    - A connected location is read-only: capture reads transcripts from it and the engine never
      writes into it (hook wiring stays in the profiles this machine owns)
    - After a successful `connect`, restart the capture daemon and re-run the harness doctor
    - Details and per-harness signatures: `reference/INSTALLATION_FLOW.md` § Harness data locations
- Enroll the project (the one project-level trust decision)
    - Machine-level installation is INERT until a repository is enrolled: no cold-start context,
      no per-turn injection, no captured sessions
    - Run `llmwiki init <absolute-project-path>` once per repository (Claude-only installs:
      `bun <absolute-clone-path>/src/cli.ts init <absolute-project-path>`)
    - The target must be a git worktree; automatic integration is git-only and per-worktree
    - Confirm with `llmwiki status <absolute-project-path>` — it prints enabled/disabled and why
    - Never enroll a repository the human did not name, and never enroll one just because it
      already contains `docs/wiki/` (that arrives with any clone)
- Generative passes stay off unless the human asks
    - `autoupdate`/`review` launch a subprocess only when `LLMWIKI_LLM_CMD` is set in the machine
      environment; unset means nothing is sent anywhere
    - Do not set it in a repository file, a `.env`, or a config — it is a shell-environment
      decision the human makes explicitly, and llmwiki ignores repository-supplied values
- Handle Codex trust
    - Start Codex in an initialized project
    - Open `/hooks`
    - Inspect and trust both current llmwiki hook hashes
    - Never claim active hooks before the Codex UI verdict
- Report
    - Installed surfaces and health-check result
    - Which repositories were enrolled, and that no others are active
    - Remaining manual action
    - The uninstall path, verbatim: `./setup.sh --uninstall` (add `--purge-data` to delete local
      runtime state), run from this clone BEFORE the clone is moved or deleted
    - Exact wired clone path
    - Exact project initialization command
    - No initialization of an unspecified project

## Tell the human how to use it

After a successful installation, give these instructions:

- First project
    - Initialize with the exact harness command from `reference/INSTALLATION_FLOW.md`
    - Start the same coding agent inside that project
    - Wiki location: `<project>/docs/wiki/`
- Normal operation
    - Local capture without MCP
    - Session close-out: Claude/OpenCode `/wiki-save`; Codex `$wiki-save`
    - Periodic backlog pass: Claude/OpenCode `/wiki-deep`; Codex `$wiki-deep`
- Project repair
    - Claude/OpenCode `/wiki-doctor`; Codex `$wiki-doctor`
    - Engine-only check: `llmwiki wiki-doctor <project-path>`
    - Safe derived-state repair: add `--fix`
- Custom conventions
    - Copy `llmwiki.config.example.toml` to `llmwiki.config.toml` only on request
    - Codex/OpenCode check: `llmwiki config <project-path>`
    - Claude-only check: `bun <absolute-clone-path>/src/cli.ts config <project-path>`
    - Show the result before any migration

## Local architecture to describe accurately

llmwiki requires Bun and uses local lifecycle hooks, a local capture daemon, local SQLite state/indexes, and plain git markdown in each project. It does not require an MCP server, Docker, an external or vector database, or a cloud service.
