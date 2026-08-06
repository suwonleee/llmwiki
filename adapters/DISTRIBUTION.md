# Distribution map — where llmwiki is submitted, and what must be green first

Five hosts, three different answers: two take a submission, one needs none, two need work before a
submission is even possible. Field values for the two real submissions live in
[`PLUGIN_SUBMISSION.md`](../PLUGIN_SUBMISSION.md); this file is the router and the gate list.

Status as of llmwiki 0.11.2 (`df636d5`).

| Host | Where you submit | Gate that must pass first | Status |
| --- | --- | --- | --- |
| **Claude Code** | Console form (web) | `claude plugin validate . --strict` | ready — submit |
| **Codex / ChatGPT** | `platform.openai.com/plugins` | `validate_plugin.py .` + verified identity | ready — identity first |
| **Orca** | nothing to submit | be installed in Claude Code or Codex | already works |
| **Hermes** | agentskills.io catalog (optional) | engine reachable without a clone | blocked on npm |
| **OpenClaw** | ClawHub (`clawhub` CLI) | live Gateway run + engine reachable | blocked on npm + a live run |

---

## 1. Claude Code — submit now

**Path.** [`platform.claude.com/plugins/submit`](https://platform.claude.com/plugins/submit) — the
Console form, for an individual author. The claude.ai form
(`claude.ai/admin-settings/directory/submissions/plugins/new`) is the same pipeline but requires a
Team or Enterprise organization with directory-management access. Pull requests opened against
`anthropics/claude-plugins-community` are closed automatically; the form is the only route.

**Gate.** The review pipeline runs the same validator you can run locally, plus automated safety
screening:

```bash
claude plugin validate . --strict     # expect: ✔ Validation passed
bun src/plugin/preflight.ts <public clone>   # expect: ✅ safe to publish
```

**What to enter.** Repository `https://github.com/suwonleee/llmwiki`, plugin name `llmwiki`, plugin
root = repository root, description from `.claude-plugin/plugin.json`, license Apache-2.0.

**After approval.** The plugin is pinned to a commit SHA in `anthropics/claude-plugins-community`,
and **CI bumps that pin automatically as you push** — a version bump does not need re-submission.
The public catalog syncs nightly, so listing lags approval. Check whether it landed by searching
the name in
[the community catalog](https://github.com/anthropics/claude-plugins-community/blob/main/.claude-plugin/marketplace.json).

The curated `claude-plugins-official` marketplace has no application process and this form does not
feed it.

## 2. Codex / ChatGPT — verify identity first, then submit

One submission lists the plugin on **both** ChatGPT and Codex surfaces.

**Prerequisites (do these before opening the form — they involve review time you do not control):**

1. `platform.openai.com` → Settings → Organization → **Verify identity**. Choose *individual*
   verification so the publisher name matches the manifests and policy pages, which are all in
   `suwonleee`'s name. A mismatch here is a rejection.
2. Settings → Roles → **Apps Management = Write** for your own role. Without it the portal will not
   let you create a plugin draft at all.

**Gate.** The directory's own ingestion validator, from the `openai/codex` checkout:

```bash
python3 codex-rs/skills/src/assets/samples/plugin-creator/scripts/validate_plugin.py <public clone>
# expect: Plugin validation passed
```

Two schema rules this repository already satisfies, both of which are silent rejections if broken:
`.codex-plugin/plugin.json` must carry **no `hooks` key** (hooks load from the default
`hooks/hooks.json`), and it must contain only the accepted fields. `tests/plugin-assets.test.ts`
enforces both on every commit.

**Path.** `platform.openai.com/plugins` → **Create plugin** → type **Skills only** → tabs in order
**Info → Skills → Prompts → Testing → Global → Submit**.

- *Skills tab* uploads a bundle, not a repository link. Build it from the published tag so the
  upload and the public repository are the same bytes:
  ```bash
  git -C <public clone> archive --format=zip -o llmwiki-0.11.2.zip v0.11.2
  ```
  Upload the whole tree, not just `skills/` — the skills invoke the engine that ships beside them.
- *Global tab* asks for availability regions. There is no repository answer to this; it is a
  publisher decision. The plugin makes no network calls and holds no accounts, so nothing
  constrains it technically.
- *Submit tab* needs release notes — reuse the `## Release notes` section of `PLUGIN_SUBMISSION.md`.

**After approval.** Approval is not publication: you publish from the portal yourself.

## 3. Orca — nothing to submit

Orca is an orchestrator, not a harness: it runs Codex, Claude Code, OpenCode and Pi in per-worktree
sessions. It has no plugin registry, and it does not need one — it reads the harnesses' own plugin
state.

**Criterion: llmwiki is installed in Claude Code or Codex on that machine.** That is the whole
requirement.

Verified by running Orca's own discovery code
(`src/main/skills/claude-plugin-skill-sources.ts`) against a home holding a GitHub-sourced install:

```
orca reads     : <home>/.claude/plugins/installed_plugins.json
scan root      : <home>/plugins/cache/llmwiki/llmwiki/0.11.2/skills (sourceKind=plugin)
skills visible : wiki-ask, wiki-deep, wiki-doctor, wiki-quiz, wiki-save
```

Details and the failure checklist: [`orca/README.md`](orca/README.md).

## 4. Hermes — usable today by copy; catalog submission is optional and blocked

Hermes has **no plugin registry**. Its plugins are in-tree Python and its `SECURITY.md` places
third-party plugins outside the trusted boundary. What is open to third parties is skills, via the
[agentskills.io](https://agentskills.io) open standard that Hermes advertises compatibility with.

**Today, without any submission:** copy the five skill folders into `$HERMES_HOME/skills` and set
`LLMWIKI_ROOT` (or put `llmwiki` on PATH). Steps in [`hermes/README.md`](hermes/README.md).

**Filing a Hermes session into the wiki** is a two-step command pair, because Hermes is not a
capture source:

```bash
llmwiki hermes-export <repo>                    # reads $HERMES_HOME/state.db read-only
llmwiki ingest <repo> <exported.md> --commit
```

Verified against Hermes' **verbatim published schema** — the `sessions` (55 columns) and `messages`
(23 columns) `CREATE TABLE` statements extracted from `hermes_state_common.py` — not a
hand-transcribed fixture.

**Blocker for a catalog submission.** Publishing the skills to agentskills.io / skills.sh means
users install them with `npx skills add`, which lands the folder in the host's own skills root.
Step 1 of the skills' engine resolution ("two levels above the skill folder") then points at the
host's directory, and there is no engine there. The later steps cover it only if the user already
has `LLMWIKI_ROOT` or `llmwiki` on PATH — which a catalog installer does not give them. **Publish
the engine to npm first**; see §6.

## 5. OpenClaw — ClawHub, blocked on two things

ClawHub is a real registry with the same shape as the two directories: owner-scoped publishing,
automated security scanning, releases hidden until review completes.

**Two publishing surfaces, both via the standalone `clawhub` CLI** (`clawhub login`, then):

- `clawhub skill publish <path>` → `clawhub.ai/<owner>/<slug>`, for the skills alone.
- `clawhub package publish <source>` → npm-style `@owner/package-name`, for the hook adapter.
  The package scope must match the publishing owner, so the name must be `@suwonleee/...`.

A separate route exists without publishing anything: ClawHub resolves
`skills-sh:<owner>/<repo>/<slug>` to a commit-pinned GitHub source, so `suwonleee/llmwiki` skills
are installable by address once they are catalog-listed (§4).

**Blocker 1 — engine delivery.** The adapter shells out to the engine (`bun:sqlite` is imported by
15+ engine modules, so an in-process Node import is impossible). A ClawHub package must therefore
find an engine on the machine: npm, §6.

**Blocker 2 — a live Gateway run.** The adapter is verified under real Node (all four behaviours:
silent when unenrolled, cold start injected, silent turn adds nothing, matching turn appends
pointers), but it has never been loaded by an actual OpenClaw Gateway. Two things also change at
publish time: OpenClaw's guidance is that published plugins point `openclaw.extensions` at built
JavaScript rather than the `.ts` entry the example manifest uses, and the Gateway is where the
manifest shape and `activation.onStartup` are actually exercised.

Requirements for that run on this machine: **Node ≥ 22.22.3** (currently 22.20.0) and an OpenClaw
install. Details and the manifest examples: [`openclaw/README.md`](openclaw/README.md).

Note also that the OpenClaw **write** loop is not blocked by effort but by their data model — their
session rows carry no `cwd`/`git_repo_root`, so a session cannot be routed back to a repository.
Read injection works; `/wiki-save` there does not.

## 6. The one shared prerequisite — publish the engine to npm

Hermes' catalog route and OpenClaw's ClawHub route are blocked by the same thing: a user who
installs *only* skills or *only* an adapter has no engine. `package.json` already declares
`"bin": { "llmwiki": "src/cli.ts" }`, and the name is unclaimed on the registry.

Doing it once unblocks three paths at the same time — Hermes catalog, ClawHub, and the OpenCode
npm install that was already planned. It also makes step 3 of the skills' engine resolution
(`llmwiki` on PATH) true for users who never cloned anything.

Work involved: a `files` allowlist so the published package is the engine and not the test suite,
and confirming the `bin` entry resolves under Bun when installed globally.
