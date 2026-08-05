# OpenClaw adapter — Gateway plugin (manual install)

**Status: unverified against a live Gateway.** The hook contract this adapter targets was read
from OpenClaw's source (`src/plugins/hook-types.ts`) and its plugin docs, not measured end to end
the way the OpenCode adapter was. Treat the first live run as the verification step, and re-read
this file's assumptions if OpenClaw's plugin API moves.

There is no `setup.sh --harness openclaw`: this is deliberately a manual install until a live run
confirms the contract. Nothing in the clone install or the Claude/Codex plugin touches OpenClaw,
so adding it cannot disturb an existing installation.

## What it does

Two injections, the same ones every other harness gets:

| OpenClaw hook | llmwiki call | Where it lands |
| --- | --- | --- |
| `before_prompt_build` (first turn of a session) | `llmwiki context <dir>` | `prependSystemContext` — cacheable, byte-identical for the whole session |
| `before_prompt_build` (every turn) | `llmwiki turn-context <dir> --prompt …` | `appendContext`, omitted entirely when the engine stays silent |
| `session_start` / `session_end` | — | drops the cached cold-start for that session id |

`prependSystemContext` rather than `prependContext` is the deliberate choice: OpenClaw documents
the system variants as the provider-cacheable ones, and the cold-start blob is identical on every
turn of a session, so the per-turn variant would re-bill a constant.

## Install

The engine is Bun-bound (`bun:sqlite` in 15+ modules) and OpenClaw runs on Node, so the adapter
shells out rather than importing. Point it at an engine first — either is enough:

```bash
export LLMWIKI_ROOT=/absolute/path/to/llmwiki      # the clone
# ...or have `llmwiki` on PATH (setup.sh writes ~/.local/bin/llmwiki)
```

Then build a package around this file:

```bash
mkdir -p /tmp/openclaw-llmwiki && cd /tmp/openclaw-llmwiki
cp <clone>/adapters/openclaw/llmwiki.ts .
cp <clone>/adapters/openclaw/package.json.example package.json
cp <clone>/adapters/openclaw/openclaw.plugin.json.example openclaw.plugin.json
openclaw plugins install ./            # local path source; ClawHub publish comes later
openclaw gateway restart
```

`package.json`/`openclaw.plugin.json` ship as `.example` on purpose: a second real package
manifest inside this repo's tracked tree would be copied into every Claude Code and Codex plugin
cache (plugin install copies the tracked tree verbatim) and would be picked up by tooling that
walks for manifests.

The example points `openclaw.extensions` at `./llmwiki.ts`, which is right for a local-path
install. OpenClaw's own guidance is that **published** external plugins point runtime entries at
built JavaScript — so before `clawhub package publish`, compile the file and re-point the entry.
That step is not automated here because publishing is blocked on a prior decision anyway: the
adapter needs an engine on the machine, and the tidy answer to that is publishing the engine to
npm (the same prerequisite the OpenCode path has).

## Consent and silence

- The enrollment gate is `llmwiki enabled <dir>` and it fails **closed** — an unreachable engine,
  a missing Bun, or a timeout all read as "not enrolled", so the adapter contributes nothing.
- The project directory is `ctx.workspaceDir` (the agent's home and default cwd). OpenClaw's
  `activeProjectKeys` are normalized git origins used for ranking, not filesystem paths, so they
  cannot be handed to the engine. An agent whose workspace is not an enrolled repository gets
  zero bytes — the same as an unenrolled repository under any other harness.
- Every failure mode collapses to `""`. Timeouts are explicit (20s cold start, 10s per turn)
  because OpenClaw runs modifying hooks sequentially: a hung engine would stall a reply, not just
  lose an injection.

## Not covered here

`/wiki-save` and the other close-out skills are a separate surface — see
[`adapters/hermes/README.md`](../hermes/README.md) for the skills-only install shape, which
applies to OpenClaw's `openclaw skills install` as well.

Transcript capture is also not wired: the engine's capture sources are Claude, Codex and OpenCode
only, so an OpenClaw session cannot yet be filed into the wiki by `/wiki-save`. **Read injection
works today; the write loop does not.** Where to start when it is worth building: OpenClaw stores
sessions in SQLite (`src/config/sessions/session-accessor.sqlite.ts`), with legacy artifacts under
`~/.openclaw/agents/<agentId>/sessions/`. The existing OpenCode source
(`src/engine/sources/opencode.ts`) reads a SQLite database the same way and is the template; a new
source registers in `src/engine/source.ts`.
