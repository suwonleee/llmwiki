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

## Filing a Hermes session into the wiki

Hermes is **not** a capture source — the daemon does not watch it — so filing is two explicit
steps instead of automatic:

```bash
llmwiki hermes-export <repo> --list             # sessions Hermes recorded for this repository
llmwiki hermes-export <repo>                    # newest one; --session <id> to pick another
llmwiki ingest <repo> <exported.md> --commit    # the existing drop-a-source path
```

`hermes-export` reads `$HERMES_HOME/state.db` **read-only** (`hermes_state.py:250`), routes the
session by its `git_repo_root` column (falling back to `cwd`), and writes one Markdown transcript.
Rewound (`active = 0`), already-compacted, and tool rows are left out — only conversation turns
are exported — and credential-shaped material is screened on the way out, with secret-only turns
dropped entirely. The export file is written `0600`.

### Why an exporter and not a capture source

Every registered `TranscriptSource` materializes into the state root's export directory, and that
directory is load-bearing security machinery: ownership detection, permission re-assertion, and
TTL cleanup all key on the single `EXPORT_DIR_NAME` constant. A second export directory means
editing all three, and those paths guard the user's existing local state on every daemon sweep.
Hermes has not earned that risk: it is a personal-assistant runtime where repo-scoped coding
sessions are the secondary use case, and there is no live installation here to verify an adapter
against. A guard test asserts that nothing registers a `hermes` source and that
`EXPORT_DIR_NAME` stays single.

Promote it to a real source when Hermes proves worth it — the schema reading is the hard part and
carries over to `src/engine/sources/`.
