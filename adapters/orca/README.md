# Orca — no adapter needed

Orca (stablyai) is not a harness with its own extension registry; it is an **orchestrator** that
runs Codex, Claude Code, OpenCode and Pi side by side, each in its own worktree. There is nothing
to submit and nothing to install: llmwiki reaches Orca users through the harnesses Orca launches.

## Why it already works

Orca discovers skills on the runtime that actually runs them, and its source list includes the
Claude plugin cache:

- `src/main/skills/skill-discovery-sources.ts` scans `~/.codex/skills`, `~/.claude/skills`,
  `~/.agents/skills`, `~/.grok/skills`, and `~/.codex/plugins/cache`.
- `src/main/skills/claude-plugin-skill-sources.ts` reads
  `~/.claude/plugins/installed_plugins.json` (plus user/project/project-local `settings.json`) and,
  for each install, scans `join(install.installPath, 'skills')`.

Measured on a GitHub-sourced install of llmwiki 0.11.2 into an isolated `CLAUDE_CONFIG_DIR`:

```
installed_plugins.json → plugins["llmwiki@llmwiki"][0].installPath
  = <config>/plugins/cache/llmwiki/llmwiki/0.11.2
<installPath>/skills = wiki-ask wiki-deep wiki-doctor wiki-quiz wiki-save
```

That is exactly the path Orca joins, so the five skills are visible to Orca the moment the plugin
is installed in Claude Code — and the Codex plugin cache path covers the Codex-side install the
same way.

## What that means in practice

- **Injection** (cold start, per-turn pointers) runs inside the harness Orca launched, from the
  plugin's own hooks. Orca does not intercept it.
- **Skills** resolve the engine by step 1 of the generated rule ("two levels above the skill
  folder"), which holds here because the skills are still inside the plugin root. No
  `LLMWIKI_ROOT` needed.
- **Worktrees**: Orca gives each agent its own git worktree. llmwiki keys a repository by its
  normalized origin, so linked worktrees of one repository converge on one wiki rather than
  fragmenting per worktree.

## What to check if it ever looks broken

1. `claude plugin details llmwiki@llmwiki` — expect `Skills (5)` and `Hooks (2)`.
2. `<installPath>/skills` is non-empty (the path above).
3. The repository open in that Orca workspace is enrolled (`llmwiki enabled <repo>`); an
   unenrolled repository is silent by design.
