<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
    <img src="assets/banner.png" alt="Quiz_wiki" width="100%">
  </picture>
</p>

# llmwiki · Quiz_wiki

A project wiki that your coding agent maintains — with quizzes to help you remember your decisions.

**English** · [한국어](readmes/README.ko.md) · [日本語](readmes/README.ja.md) · [中文](readmes/README.zh.md)

llmwiki turns coding sessions into a wiki in `docs/wiki/`. Claude Code, Codex and OpenCode can share it, retrieve relevant context in later sessions, and quiz you on past decisions.

- **Remember the work:** save decisions, insights and project context with `/wiki-save`.
- **Use it next time:** session-start context and per-prompt excerpts; path-specific rules before edits in Claude Code.
- **Own the files:** Markdown in git, using Open Knowledge Format (OKF v0.2).
- **Stay in control:** each project is off until `llmwiki init`; storage and search run locally with Bun and SQLite.

## Quick start

You need Git, [Bun](https://bun.sh) **1.2.21 or newer**, and one coding agent. No build or runtime dependency install.

### 1. Install

```bash
cd ~
git clone https://github.com/suwonleee/llmwiki.git
cd ~/llmwiki
```

Start `claude`, `codex` or `opencode` from this folder and paste:

```text
Read setup_text.md and install llmwiki for this machine and the coding agent I am currently using. Follow the file exactly, run the health checks, and tell me about any manual step that remains.
```

For a pinned install, choose a tag from [Releases](https://github.com/suwonleee/llmwiki/releases) before setup.

### 2. Enable a project

After setup reports healthy, stay in the same setup session and ask the agent to initialize your project, or run:

```bash
llmwiki init /absolute/path/to/my-project
```

**OpenCode:** restart it once after setup. **Codex:** review and trust the hooks in `/hooks` when setup requests it. On native Windows, use `bun <clone>/src/cli.ts init <repo>` from PowerShell.

### 3. Use it

Work from your project directory. Close out meaningful sessions before the coding agent rotates their transcripts.

| When | Claude Code / OpenCode | Codex |
|---|---|---|
| End of a meaningful session | `/wiki-save` | `$wiki-save` |
| Now and then (backlog, deeper cleanup) | `/wiki-deep` | `$wiki-deep` |
| Ask the wiki a question | `/wiki-ask` | `$wiki-ask` |
| The wiki looks wrong | `/wiki-doctor` | `$wiki-doctor` |
| Quiz yourself | `/wiki-quiz` | `$wiki-quiz` |

```bash
llmwiki status /absolute/path/to/my-project
llmwiki --help
llmwiki --version
```

`llmwiki <command> --help`

Per-prompt retrieval includes wiki excerpts and related commit messages, and can report when a named subject is absent from the checked records. Disable these channels with `LLMWIKI_TURN_COMMITS=off` or `LLMWIKI_TURN_ABSENT=off`. Parsed wiki pages use a private temporary cache (`LLMWIKI_PAGE_CACHE=off` disables it).

`/wiki-save` files this session's durable decisions and refreshes the handoff; topic consolidation, overview updates and semantic review belong to `/wiki-deep`. A session with decision signals may receive one model-facing save hint after eight turns (`LLMWIKI_SAVE_NUDGE=off` disables it). Saving remains your choice; unfiled sessions may expire. At explicit close-out, optional version-bound page feedback steers future ranking; unknown feedback is neutral and wrong claims await a separate recheck. If no review provider is configured, the current session can review `review-input` and submit `review-import`.

## Portable wiki: OKF v0.2

Since v0.14.0, new wikis use [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md): typed YAML frontmatter, source provenance, relative Markdown links, folder indexes and a dated log. Your knowledge stays readable outside llmwiki. Existing wikis are converted only when you choose.

```bash
llmwiki okf /path/to/project            # preview changes
llmwiki okf /path/to/project --commit   # apply after reviewing
llmwiki okf --bundle /path/to/project/docs/wiki  # check a bundle
```

## Update or uninstall

Updates are manual. Re-run setup after pulling: the daemon and installed OpenCode plugin need refreshing. Restart OpenCode afterwards.

```bash
cd ~/llmwiki
git pull && ./setup.sh
```

```bash
./setup.sh --uninstall
```

Uninstall before moving or deleting the clone. Wiki files stay in your repositories; add `--purge-data` only to remove local runtime state too.

## Documentation

- [User guide](readmes/GUIDE.md) — plugin/manual installation, configuration, team use, troubleshooting and measurement results.
- [Installation details](reference/INSTALLATION_FLOW.md) · [setup_text.md](setup_text.md)
- [Contributing](CONTRIBUTING.md) · [Architecture](ARCHITECTURE.md) · [Support](SUPPORT.md)
- [Privacy](PRIVACY.md) · [License: Apache-2.0](LICENSE)

The engine stores and searches locally. Your coding agent still follows its own provider settings. Additional engine-launched generation is off unless you set `LLMWIKI_LLM_CMD`.

The guide includes small controlled experiments and one developer’s daily-use measurements, with their limits. They are not a general accuracy guarantee.
