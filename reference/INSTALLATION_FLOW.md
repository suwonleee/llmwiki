# llmwiki agent installation flow

Detailed execution reference for the coding agent following [`../setup_text.md`](../setup_text.md).
Read the shared flow plus the active harness section only. Treat live setup and doctor output as
the current source of truth.

## Contents

- [Source-of-truth order](#source-of-truth-order)
- [Shared flow](#shared-flow)
- [Claude Code](#claude-code)
- [Codex](#codex)
- [OpenCode](#opencode)
- [OS and generative-pass boundaries](#os-and-generative-pass-boundaries)
- [Recovery rules](#recovery-rules)
- [Successful handoff format](#successful-handoff-format)

## Source-of-truth order

- Live `setup.sh` output
    - Exact clone path, detected capability, conflict, and `PATH` action
- Harness-scoped installation doctor
    - Installed daemon, hooks/plugin, commands/skills, and CLI surface
- This reference
    - Expected sequence, harness differences, and recovery boundaries
- README
    - Human entry point, not the detailed execution contract

## Shared flow

- Phase 1 — locate the engine
    - Run from the clone containing `setup_text.md` and `setup.sh`
    - Resolve and retain the absolute clone path
    - Quote the absolute path in every manually constructed command
- Phase 2 — select one harness
    - Current Claude Code session → `claude`
    - Current Codex session → `codex`
    - Current OpenCode session → `opencode`
    - `auto` or `all` only when the human explicitly requests every available harness
- Phase 3 — preflight
    - Confirm `git`
    - Confirm Bun 1.1 or newer
    - Confirm the selected harness CLI on `PATH`
    - Run `./setup.sh --dry-run --harness <harness>`
    - Stop before mutation on a reported conflict, unsupported CLI, or missing prerequisite
- Phase 4 — install
    - Run `./setup.sh --harness <harness>`
    - Preserve the complete output
    - Do not replace, delete, or hand-merge unrelated user configuration
- Phase 5 — verify
    - Apply only the exact `PATH` command printed by setup, when present
    - Run the harness-scoped doctor command below
    - Treat a nonzero doctor result as incomplete installation
    - Treat Codex hook trust as a separate UI-owned action, not a doctor failure
- Phase 6 — enroll the named project
    - Installation is machine-level and INERT until a repository is enrolled
    - Enrollment action: `llmwiki init <absolute-project-path>` (one time, per worktree)
    - The target must be a git worktree; automatic integration is git-only
    - Enrollment is granted only after the bounded skeleton/index work succeeds
    - Confirm with `llmwiki status <absolute-project-path>`
    - Never enroll a repository the human did not name; `docs/wiki/` presence is not consent
- Phase 7 — handoff
    - Report absolute engine path and selected harness
    - Report installed daemon and harness surfaces
    - Report doctor result and remaining manual action
    - Report which repositories are enrolled, and that no others are active
    - Report the uninstall path: `./setup.sh --uninstall [--purge-data]`, run from this clone
      before the clone is moved or deleted
    - Do not initialize an unspecified project

## Claude Code

- Install
    - `./setup.sh --harness claude`
- Verify
    - `bun "<absolute-clone-path>/src/cli.ts" doctor --harness claude`
- Initialize a project
    - `bun "<absolute-clone-path>/src/cli.ts" init "<absolute-project-path>"`
- Installed surfaces
    - Local capture daemon
    - `SessionStart` and `UserPromptSubmit` hooks
    - `/wiki-save`, `/wiki-deep`, `/wiki-doctor`, `/wiki-ask`, `/wiki-quiz`
- CLI distinction
    - Claude-only setup does not install the user-level `llmwiki` launcher
    - Use the clone-pinned Bun command unless Codex or OpenCode setup also installed the launcher
- Profile handling
    - Honor `CLAUDE_CONFIG_DIR`
    - Preserve unrelated hooks and permissions

## Codex

- Install
    - `./setup.sh --harness codex`
- Verify
    - `llmwiki doctor --harness codex`
- Initialize a project
    - `llmwiki init "<absolute-project-path>"`
- Installed surfaces
    - Local capture daemon
    - Native `SessionStart` and `UserPromptSubmit` hooks in `$CODEX_HOME/hooks.json`
    - `$wiki-save`, `$wiki-deep`, `$wiki-doctor`, `$wiki-ask`, `$wiki-quiz`
    - User-level `llmwiki` launcher
- Required manual activation
    - Start Codex inside an initialized project
    - Open `/hooks`
    - Inspect and trust both current llmwiki hook hashes
    - Start a new project session after trust to exercise `SessionStart`
- Trust boundary
    - Trust is per user installation
    - New or changed hook commands can require trust again
    - Codex UI owns the verdict; doctor intentionally reports the review action conservatively

## OpenCode

- Install
    - `./setup.sh --harness opencode`
- Verify
    - `llmwiki doctor --harness opencode`
- Initialize a project
    - `llmwiki init "<absolute-project-path>"`
- Installed surfaces
    - Local capture daemon
    - Global read-injection plugin under `$XDG_CONFIG_HOME/opencode/plugin/`
    - `/wiki-save`, `/wiki-deep`, `/wiki-doctor`, `/wiki-ask`, `/wiki-quiz`
    - User-level `llmwiki` launcher
- Activation
    - Restart OpenCode after initial setup or clone re-pointing
    - No hook-trust UI action
- Environment handling
    - Preserve `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `OPENCODE_DB`

## OS and generative-pass boundaries

- macOS
    - Capture daemon through launchd
- Linux
    - User systemd when available
    - Cron/nohup fallback when user systemd is unavailable
- Windows
    - WSL2 recommended
    - Native Windows requires Git Bash plus separate service registration
- Generative maintenance
    - Warm `/wiki-*` or `$wiki-*` workflows run on the active coding agent
    - Unattended `autoupdate` and semantic `review` launch a subprocess ONLY when
      `LLMWIKI_LLM_CMD` is set in the machine environment; unset is the default and sends nothing
    - An unset value is never an installation failure — those passes report unavailable and skip
    - Report `LLMWIKI_LLM_CMD` as an explicit, human-made shell-environment opt-in; never set it
      from a repository file, a `.env`, or a config on the human's behalf

## Recovery rules

- Setup reports a collision or unsupported version
    - Stop at the reported boundary
    - Preserve existing configuration
    - Explain the exact file, command, or capability involved
- Setup or doctor interrupted
    - Re-run the same harness setup
    - Rely on idempotent managed wiring
- Clone moved, renamed, or updated
    - Re-run the same harness setup from the new clone path
    - Re-run the harness-scoped doctor
    - Re-check Codex `/hooks` after hook command changes
- `llmwiki` absent after Codex/OpenCode setup
    - Apply the exact printed `PATH` command
    - Open a new shell when required
    - Re-run the harness-scoped doctor
- Read injection absent in a fresh initialized project
    - Confirm `docs/wiki/` exists
    - Restart the harness
    - Run the harness-scoped doctor
    - For Codex, verify `/hooks` trust before any wiring repair
- Existing wiki or custom conventions
    - Do not migrate automatically
    - Show migration dry-run and obtain explicit human approval
    - Create `llmwiki.config.toml` only on explicit customization request

## Successful handoff format

- Engine
    - Absolute clone path
- Harness
    - Selected harness and setup command
- Installed
    - Daemon plus harness-owned hooks/plugin and commands/skills
- Verification
    - Exact doctor command and result
- Manual action
    - `none`, exact `PATH` command, or Codex `/hooks` review
- First project
    - Exact initialization command
- Ongoing use
    - Claude/OpenCode: `/wiki-save`, `/wiki-deep`, `/wiki-doctor`
    - Codex: `$wiki-save`, `$wiki-deep`, `$wiki-doctor`
