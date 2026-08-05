# Hermes adapter — skills only

Hermes (Nous Research) is compatible with the [agentskills.io](https://agentskills.io) open
standard: a skill is a folder with a `SKILL.md` carrying `name` and `description` frontmatter.
The five llmwiki skills already have exactly that shape, so no conversion is needed.

Hermes' third-party surface is skills. Its plugins are in-tree Python packages
(`plugins/memory`, `plugins/context_engine`, …) and its `SECURITY.md` places third-party plugins
outside the trusted boundary, so there is **no hook equivalent** — no session-start injection and
no per-turn pointers. What you get is the command half: `/wiki-save`, `/wiki-deep`, `/wiki-ask`,
`/wiki-doctor`, `/wiki-quiz` work when invoked; the reading loop does not run by itself.

## Install

Skills resolve the engine through the ordered rule generated into every `SKILL.md`
(`src/plugin/build-assets.ts`). Step 1 — "two levels above the skill folder" — is the plugin and
clone layout and **does not hold here**, because Hermes copies skill folders into its own home.
So set one of the later steps before installing:

```bash
export LLMWIKI_ROOT=/absolute/path/to/llmwiki      # step 2
# ...or have `llmwiki` on PATH (setup.sh writes ~/.local/bin/llmwiki)   # step 3
```

Hermes reads `$HERMES_HOME/skills` (default `~/.hermes/skills`, `hermes_constants.get_skills_dir`):

```bash
cp -R <clone>/skills/wiki-save   ~/.hermes/skills/
cp -R <clone>/skills/wiki-deep   ~/.hermes/skills/
cp -R <clone>/skills/wiki-ask    ~/.hermes/skills/
cp -R <clone>/skills/wiki-doctor ~/.hermes/skills/
cp -R <clone>/skills/wiki-quiz   ~/.hermes/skills/
```

Then reload skills from the Hermes CLI. The same shape applies to any other agentskills.io host —
`openclaw skills install`, `npx skills add`, `~/.claude/skills`, `~/.codex/skills` — which is why
the resolution rule lives in the skill body rather than in a harness-specific installer.

## Why the engine variable matters

Without `LLMWIKI_ROOT` or a `llmwiki` on PATH, step 1 resolves to the host's own skills root
(`~/.hermes/`), where there is no engine. The generated rule tells the model to say so once and
stop rather than guess a path — a guessed root writes wiki pages into the wrong repository, which
is worse than not running.

## Not covered — transcript capture

The engine's capture sources are Claude (JSONL), Codex and OpenCode; a Hermes session is not yet a
source, so `/wiki-save` there cannot file the session it just ran. Where to start when it is worth
building: Hermes keeps session state in **SQLite at `$HERMES_HOME/state.db`**
(`hermes_state.py:250`, FTS5-indexed per `hermes_state_schema.py`) — the same shape as the
existing OpenCode source (`src/engine/sources/opencode.ts`), which also reads a SQLite database
rather than a JSONL file. That is the template; a new source registers in
`src/engine/source.ts`.
