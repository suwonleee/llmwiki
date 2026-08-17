# llmwiki agent installation flow

Detailed execution reference for the coding agent following [`../setup_text.md`](../setup_text.md).
Read the shared flow plus the active harness section only. Treat live setup and doctor output as
the current source of truth.

Platform support and privacy invariants are defined in the machine-readable
[`support-contract.json`](support-contract.json).

Every harness install includes the same user-level `llmwiki` launcher. Setup prints the one-time
`PATH` action when necessary. Native Windows follow-ups remain explicit Bun commands because the
launcher is a POSIX shell script for Git Bash, while harness commands run through PowerShell.

## Contents

- [Source-of-truth order](#source-of-truth-order)
- [Shared flow](#shared-flow)
- [Claude Code](#claude-code)
- [Codex](#codex)
- [OpenCode](#opencode)
- [Harness data locations (nonstandard locals)](#harness-data-locations-nonstandard-locals)
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
    - Confirm the full machine + project loop with `llmwiki verify <absolute-project-path> --harness <harness>`
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
    - `llmwiki doctor --harness claude`
- Initialize a project
    - `llmwiki init "<absolute-project-path>"`
- Installed surfaces
    - Local capture daemon
    - `SessionStart` and `UserPromptSubmit` hooks
    - `/wiki-save`, `/wiki-deep`, `/wiki-doctor`, `/wiki-ask`, `/wiki-quiz`
    - User-level `llmwiki` launcher
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
- Ownership boundary
    - llmwiki does not edit `$CODEX_HOME/config.toml`, `developer_instructions`, `AGENTS.md`, or
      another orchestrator's runtime or preflight state
    - Diagnose failures from those surfaces with their owner; do not bypass or repair them by
      changing llmwiki wiring
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

## Harness data locations (nonstandard locals)

Every machine differs. Discovery is 3-tier: the engine resolves and verifies deterministically;
you are the fallback searcher; the engine stays the gate on what gets recorded.

- Tier 1 — deterministic resolution (engine)
    - Claude Code: `~/.claude*` scan plus `$CLAUDE_CONFIG_DIR`
    - Codex: `$CODEX_HOME`, default `~/.codex`
    - OpenCode: `$OPENCODE_DB`, default `$XDG_DATA_HOME/opencode/opencode*.db`
- Tier 2 — schema-signature verification (engine, read-only)
    - A candidate is judged by what is inside it, never by mere existence
    - Claude Code: a `projects/` subtree holding `*.jsonl` transcripts
    - Codex: `sessions/` rollouts or `state_*.sqlite` thread index
    - OpenCode: a SQLite database with a `session` table plus `message`/`session_message`
- Tier 2.5 — extended scan (engine, automatic)
    - Runs by itself whenever tiers 1–2 come up empty, on `locate` and on `doctor`
    - Looks where the defaults predictably miss: a mounted Windows profile under
      `/mnt/c/Users/*` (the WSL case — the harness data lives in the Windows home while the
      engine runs from a Linux one), `$XDG_CONFIG_HOME`/`~/.config`, `~/.opencode`,
      macOS Application Support
    - Every candidate still passes tier-2 verification before anything is recorded. Looking in
      more places widens what can be FOUND; it never widens what is BELIEVED
    - EXACTLY ONE verified candidate INSIDE the user's own home → connected and persisted with
      nobody asked
    - A verified candidate OUTSIDE the home (a mounted Windows profile is routinely another
      person's) → never auto-connected; reported with the exact `llmwiki connect` command.
      "Exactly one" proves unambiguity, not ownership — for foreign data the missing evidence is
      consent, and no count supplies it
    - MORE THAN ONE → nothing is connected. Those are usually different PEOPLE's profiles, and
      no automatic rule can tell which is yours; the choice is handed off
    - An env override ($CODEX_HOME, $OPENCODE_DB) that is SET but fails verification blocks
      auto-connect entirely: env wins over anything persisted, so persisting would print success
      about a path the capture loop will never read. The handoff says to fix or unset the variable
    - Runs only for a harness whose CLI is installed here, and only within the `--harness` scope
      the user asked about
    - Env vars are read through the repository-env guard: a tracked `.env` in the cwd can never
      steer what is scanned or persisted
- Tier 3 — agent fallback (you), engine-gated
    - Trigger: `llmwiki locate <harness>` prints the handoff block — tier 2.5 found nothing, or
      found several and refused to choose
    - The block states `tried:` (paths already examined — do not repeat them), `blocked:` (why no
      automatic answer was possible) and `options:` (numbered, with the exact commands)
    - Search the machine for the real location; never persist a guess from memory
    - Verify read-only: `llmwiki locate <harness> <path>`
    - Persist: `llmwiki connect <harness> <path>` — the engine refuses any path that fails
      tier-2 verification (fail-closed, the same contract as enrollment). Both commands resolve
      a relative path against the current directory before doing anything, so the location
      verified is always the location recorded
    - A connected location is READ-ONLY to the engine: capture reads transcripts there, and
      nothing is ever written into it. Wiring (a Claude profile's `settings.json` and
      `commands/`) goes only to a profile this machine owns — `~/.claude*` or
      `$CLAUDE_CONFIG_DIR`
    - Never edit the persisted `harness-paths.json` by hand
- Precedence and lifecycle
    - Env vars always win over a persisted path, so a shell override stays the strongest word
    - `llmwiki connect <harness> --forget` removes a persisted location
    - `connect` restarts the capture daemon itself, through whichever supervisor installed it —
      there is no command to copy. A restart is an optimization either way: every sweep re-reads
      the persisted locations, so a new one takes effect within one poll interval regardless;
      what the restart buys is the filesystem watch list, which is built at daemon start
    - `llmwiki doctor` re-verifies every persisted location on each run and flags one that
      vanished or changed shape

## OS and generative-pass boundaries

- macOS
    - Capture daemon through launchd
- Linux
    - User systemd when available
    - Cron/nohup fallback when user systemd is unavailable
- Windows
    - Native Windows and WSL2 are supported
    - Native Windows runs setup under Git Bash; setup registers the daemon in the unelevated
      per-user Startup folder, and generated Codex/OpenCode surfaces invoke Bun directly so they
      work under PowerShell
    - WSL2 uses the Linux systemd or cron/nohup path
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
- Harness installed but nothing captured from it
    - Run `llmwiki locate <harness>` and read the verdict lines
    - No verified location → follow the search→verify→persist steps in
      [Harness data locations](#harness-data-locations-nonstandard-locals)
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
