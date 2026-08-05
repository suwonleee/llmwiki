# llmwiki plugin — what it runs, what it reads, what it writes

This file is the plugin's disclosure sheet. It exists so a reviewer (or anyone reading the code
before installing) can answer "what does this thing touch?" without tracing the engine.

The plugin is the **read loop plus the `/wiki-*` skills**. The background capture daemon is NOT
part of it — that ships only with the clone install (`git clone` + `./setup.sh`).

## Components

| Component | Trigger | What it does |
|---|---|---|
| `SessionStart` hook | session start / resume / clear | prints the repository's `docs/wiki/current-state.md` plus a short index. Prints **nothing** for a repository that was never enrolled. |
| `UserPromptSubmit` hook | every prompt | prints at most 3 page pointers (title → path) when the prompt lexically matches wiki pages; silent otherwise. No LLM call, no network. |
| `skills/wiki-*` | only when the user invokes them | `wiki-save` (close out this session into the wiki), `wiki-ask`, `wiki-deep`, `wiki-quiz`, `wiki-doctor`. |

Both hooks are shell scripts that run `bun <plugin>/src/cli.ts`. Every failure path exits 0 with
empty output: a broken engine must never break a session.

## Prerequisite

[Bun](https://bun.sh) on `PATH`. The engine is TypeScript executed directly by Bun and has **zero
runtime dependencies** — no `npm install`, no `node_modules`, nothing fetched at install time.

## Consent gate — nothing happens in a repository you did not enroll

Installing the plugin does not enable it anywhere. Each repository is opt-in, once:

```
bun <plugin-root>/src/cli.ts init <repo>      # or run /wiki-doctor in a session there
```

Until then both hooks emit **zero bytes** — indistinguishable from not having the plugin
installed. Enrollment is recorded in that repository's `.git/llmwiki/` (not in the working tree,
so it is never committed) and is revoked with `llmwiki disable <repo>`.

## Data — where it lives and who reads it

**Written, always outside your repository.** Derived state lives in the platform state directory
(`$XDG_DATA_HOME/llmwiki`, default `~/.local/share/llmwiki`), one directory per project:

- `index.db` — SQLite full-text index of that repository's own wiki pages
- capture queue — which sessions have been filed into the wiki (paths and offsets, not content)
- `observe/emissions.jsonl` — which page pointers were injected, for the engine's own metrics

Inside your repository the plugin only ever writes **Markdown under `docs/wiki/`**, and only when
you run a `/wiki-*` command. No database, no dotfiles, no build artefacts.

**Read.** The wiki pages themselves, the state directory above, and — this is the part worth
being precise about — your **session transcripts**:

- the automatic hooks **stat** transcript files (modification time only, to say "N sessions not
  yet filed"); they never open their contents;
- the incremental, task-relevant part of transcript **content** is read only when you invoke
  `/wiki-save` or `/wiki-deep`, which is the whole point of those commands: they turn a session
  into a wiki page. Credential-shaped material is screened before the extract is shown to the
  model, and secret-only fragments are omitted. Transcript locations are the harness's own
  (`~/.claude*/projects`, `$CODEX_HOME/sessions`, OpenCode's database), read only, never modified.

**Sent.** Nothing. The engine makes no network requests — no telemetry, no analytics, no remote
API. (The clone install's daemon runs `git fetch` against your own clone's origin once a day to
notice new versions; the plugin has no daemon and does not do this.)

## What it does not do

- does not modify code, run builds, or touch files outside `docs/wiki/` in your repository
- does not install or upgrade anything on your machine
- does not read repositories you have not enrolled
- does not call any model — retrieval is deterministic (SQLite FTS, lexical matching only)

## Cost per session

Around 330 tokens of always-on skill metadata, plus the cold-start page (a few KB, sized by your
own L0 page) and typically 0–350 bytes per prompt, because most turns produce no pointer at all.

## Uninstall

`/plugin uninstall llmwiki@llmwiki` (Claude Code) or `codex plugin remove llmwiki` (Codex). Your
wiki is ordinary Markdown in your repository and is untouched. To also drop the derived state,
delete `~/.local/share/llmwiki`.

## Full install (optional, different thing)

The clone install adds the background capture daemon, which watches for finished sessions so
`/wiki-save` has them queued. Pick one per machine — the plugin's hooks detect a clone install and
stand down so nothing is injected twice.

```
git clone https://github.com/suwonleee/llmwiki.git && cd llmwiki && ./setup.sh
```
