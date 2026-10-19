# llmwiki — User guide

[Quick start](../README.md)

[Other ways to install](#other-ways-to-install) · [How it works](#how-it-works) · [Does it help?](#does-it-help) · [Configuration](#configuration) · [Team use](#team-use) · [Updating](#updating) · [Uninstall](#uninstall) · [Data on your machine](#data-on-your-machine) · [Prerequisites](#prerequisites) · [Troubleshooting](#troubleshooting) · [Project structure](#project-structure) · [Regression tools (for engine development)](#regression-tools-for-engine-development) · [Contributing](#contributing) · [Principles](#principles) · [License](#license)

## Other ways to install

### Plugin install (no clone)

The repository is also a Claude Code / Codex plugin marketplace.

```bash
# Claude Code
claude plugin marketplace add suwonleee/llmwiki
claude plugin install llmwiki@llmwiki

# Codex (review the llmwiki hooks in /hooks afterwards)
codex plugin marketplace add https://github.com/suwonleee/llmwiki
codex plugin add llmwiki@llmwiki
```

- The plugin carries the read loop and the `/wiki-*` skills.
- The background capture daemon ships **only with the clone install**. Pick one path per machine; the hooks detect a clone install and defer to it.
- Enroll each repository: run `/wiki-doctor` in a session there, or `bun <plugin-root>/src/cli.ts init <repo>`. Repositories you never enroll get no injection.
- Bun is still required. Without it, the plugin says so once at session start and stays silent.
- Cost: about 330 tokens of always-on skill metadata per session.
- Before installing, review the [plugin disclosure](../PLUGIN.md), [privacy policy](../PRIVACY.md), [terms](../TERMS.md) and [support guidance](../SUPPORT.md).

### Manual fallback

Use this only when you want to install without an agent. Pick one harness. `auto` wires every detected harness.

```bash
./setup.sh --harness claude
# or: ./setup.sh --harness codex
# or: ./setup.sh --harness opencode
```

- Follow the exact next command printed by setup
    - macOS, Linux, or WSL2: user-level `llmwiki …` for every harness
    - Native Windows, every harness: explicit `bun <clone>/src/cli.ts …`; the optional `llmwiki` launcher is a Git Bash-only shell script, while Codex/OpenCode use PowerShell
- Complete any printed manual action
    - Codex only: review and trust the current llmwiki hooks in `/hooks`
    - OpenCode: restart it after initial setup or clone re-pointing
- Full branch and recovery reference: [`reference/INSTALLATION_FLOW.md`](../reference/INSTALLATION_FLOW.md)
- `./setup.sh --dry-run` prints the plan without changing files or services.
- The clone can live anywhere, under any name. Every hook, command and service is derived from its location.
- Re-run setup after moving or updating the clone. It is safe to run again.
- Single steps: `bun <clone>/src/cli.ts doctor` · `bash <clone>/daemon/install.sh` · `bun <clone>/src/daemon/wire.ts` (Claude) · `wire-codex.ts` / `wire-opencode.ts`. Each wire script takes `--revert` to undo its own changes.

## How it works

The loop has six stages. Two run on their own; the rest are one command each.

1. **Capture** (automatic) — a background daemon queues every session transcript, in any folder or terminal.
2. **Update** (`/wiki-save`) — new parts of the queue are appended to the project's log layer: `2_milestone`, `3_decision`, `4_insight`.
3. **Consolidate** (`/wiki-deep`) — the log is merged into one page per concept in `5_topic/`; overview updates also belong to this pass.
4. **Read** (automatic) — session start gets L0 and page pointers; each prompt gets up to three related pointers or excerpts; an edit to a governed file gets its rule first (Claude Code).
5. **Quiz** (`/wiki-quiz`) — spaced-repetition questions for you, drawn from the wiki's decisions.
6. **Self-healing** — `/wiki-save` runs structural `lint`; `/wiki-deep` reviews meaning and works the gap queue. Without a review provider, the current session uses `review-input` and `review-import` to submit an advisory draft bound to unchanged pages.

Who does what:

- **Facts and routine decisions** — grounded and filed by the AI when you invoke a wiki command.
- **Direction and unresolved contradictions** — a person's judgment.
- **Your memory of your decisions** — kept fresh by `/wiki-quiz`.
- Pages are derived only from raw transcripts, never from other wiki pages.

Wiki excerpts and commit messages share a fixed per-turn budget. Disable commit retrieval with
`LLMWIKI_TURN_COMMITS=off`, absent-subject notes with `LLMWIKI_TURN_ABSENT=off`, the private parsing
cache with `LLMWIKI_PAGE_CACHE=off`, or the one-time save hint with `LLMWIKI_SAVE_NUDGE=off`.
Optional `injected`/`injected-feedback` commands collect version-bound self-assessments during
explicit close-out. Missing/unknown judgments are neutral; `wrong` claims enter `recheck` and
require raw evidence to resolve. `llmwiki status <repo> --details` expands folded housekeeping.

Transcripts belong to the agent, not to llmwiki:

- They rotate on each agent's schedule (Claude Code keeps about 30 days; Codex compresses finished sessions to `.zst`). llmwiki does not copy them.
- Close out sessions worth keeping with `/wiki-save` before they age out. The deep pass prunes queue rows whose transcript is gone (`capture-prune`, 30-day guard).

[Andrej Karpathy: LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) · [Open Knowledge Format](https://github.com/GoogleCloudPlatform/open-knowledge-format)

### The quiz (`/wiki-quiz`)

The other stages keep the **model** grounded. This one keeps the **person** sharp: judgment fades along with your memory of past decisions.

- **Scheduling** — done by the engine, with no LLM.
    - Day-based forgetting curve: boxes of 1, 3, 7, 16, 35 and 60 days.
    - Wrong or skipped → back to 1 day. An item is never asked twice in one day.
    - Priority: direction > decision > insight and topic > milestone, newest first.
- **A session**
    - The engine picks the due items. The agent reads those pages and writes all questions up front, so the next one appears without waiting.
    - Answers are graded on the gist, against the pages. Wrong answers come back first the next day.
    - Size: `[quiz] questions` in `llmwiki.config.toml`. Default **3**, raise per run (`/wiki-quiz 5`), capped at **7**.
    - Where questions appear: Claude Code `AskUserQuestion` (4 per call) · OpenCode `question` · Codex `request_user_input` (3 per call; outside Plan mode only after `codex features enable default_mode_request_user_input`). Elsewhere, as one numbered block.
- **Records** — `docs/wiki/6_quiz/` (ledger and daily notes). This folder is for people only: never indexed, searched or injected.

### Evidence that travels with the page (page format v3)

A citation like `[^s1]: <session>.jsonl` points at a transcript on **one machine**. A teammate can read your conclusion but not its grounding. v3 puts one or two lines of the evidence under the footnote:

```markdown
- We kept the log layer and added the topic layer on top of it [^s1]

[^s1]: 3bd9cac5-….jsonl
    > [2026-06-29 14:02 user] "keep the log as-is and layer on top — replacing it is the risky part"
```

- **Format**
    - The footnote line itself is unchanged; four parsers read it.
    - Excerpts come only from `llmwiki excerpt`: verbatim, length-capped and screened for secrets.
    - Judgment claims quote the person; factual claims cite a tool record.
- **Page body**
    - Numbered sections in reading order (`## 1. <label>`, `### 1-1. <label>`). A short page can be a plain bullet list.
    - One point per `-` line, detail at `    -`, deeper detail at `        -` (no fourth level).
    - A bullet listing more than three items becomes a parent with one child per item (lint: `dense-bullet`).
    - Short noun-phrase endings where natural. No restating the parent or the title (lint: `flat-body` for a long page with no sections).
- **Lint** checks a quote only where its transcript is readable. On other clones it stays silent: "can't check" must not read as "wrong".
- **Search** ignores excerpts, so evidence costs no retrieval quality or page budget.

### Open Knowledge Format (OKF v0.2)

Since v0.14.0, new wikis use [Open Knowledge Format v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md): typed YAML frontmatter, source provenance, relative Markdown links, folder indexes and a dated log. Your knowledge stays readable outside llmwiki. Existing wikis are converted only when you choose.

- Every page has `type` (`Decision` · `Topic` · `Current State` …), `status` (`stable` · `draft` · `deprecated`), `generated: { by, at }` and one `sources` entry per footnote.
- Links are relative Markdown links, not `[[wikilinks]]`.
- Each folder gets a generated `index.md`. `log.md` holds dated groups, newest first (`llmwiki log-append`).
- An existing wiki converts once, when you decide: `llmwiki okf <repo>` (dry run) → `--commit`. `llmwiki okf --bundle docs/wiki` checks conformance.
- Tested with outside readers: Google's reference parser and viewer, `W4G1/okf`, `okf-rs` and `okf-studio` open the bundles with 0 errors (Korean filenames included).
- llmwiki's own fields live in one extension key, `x-llmwiki`. Other readers ignore it; `llmwiki okf` keeps it.

### Self-healing

For source-ID resolution, tag search and their measured limits,
see [Consuming OKF structure](OKF-CONSUMPTION.md).

The wiki reports what is missing. A person supplies the judgment.

- On `/wiki-save` and `/wiki-deep`:
    1. `lint` (deterministic) — structure: orphan, stale and dangling pages.
    2. `review` (generative) — meaning: contradictions, stale claims, missing concepts. On close-out it runs only when due (`--if-due`, every 7 days by default, `LLMWIKI_REVIEW_INTERVAL_DAYS`) and only on recent and related pages. The deep pass always runs it.
    3. `gaps` — collects the missing concepts and follow-up questions into `0_review/gap-queue.md`.
- A gap closes when someone works on that topic, when the deep pass fills it, or when `review` stops reporting it twice in a row.
- Pages are never generated from thin evidence.

## Does it help?

### Does the agent apply past decisions? — controlled runs

Writing a wiki is easy. Getting a coding agent to act on it is not. We measured it with real Claude Code sessions on two private work repositories (2026-10-13/14):

1. One session settles a project rule in conversation and closes out.
2. A later, fresh session gets a different task where that rule applies.
3. A blind grader checks whether the change follows the rule.

| What the agent had | Applied the earlier decision |
| --- | --- |
| No wiki | — (Q&A: accuracy 0.57, hallucination 23%) |
| The wiki (Q&A questions) | accuracy 0.73–0.78, hallucination 4–8% (480 runs) |
| A decision kept only in wiki pages (coding tasks) | **0/8** — in 32 coding runs agents opened no wiki page and ran no wiki search |
| The decision as an L0 "Active rules" line | **8/8** |
| The decision only in its page, delivered at edit time + in the per-prompt excerpt | **8/8** (excerpt alone 4/8, edit-time gate alone 7/8) |

What changed in v0.14.0 as a result:

- A rule a person sets is written as one concrete line, kept in L0, and tagged with the paths it governs (`x-llmwiki: { applies_to, rule, recall }`).
- The per-prompt block carries the rule text, not just a title.
- An edit to a governed file — through the Edit tool or a Bash write — shows the rule to the agent before the edit (Claude Code).

Read these numbers with care:

- The samples are small: 2 repositories, 4 scenarios, 8 runs per arm, one grader model.
- Tasks were built so that the obvious change breaks the rule. The runs show the delivery works, not how often your own rules matter.
- Converting to OKF alone did not change answer accuracy (+0.03, within noise). The gains come from what reaches the agent.
- A new-user run from a fresh clone in an isolated home (`./setup.sh` → `llmwiki init` → session → `/wiki-save` → new session) applied the rule in 2/2 scenarios: once via the edit-time gate, once because the per-prompt excerpt led the agent to open the decision page.

### 11 weeks of daily use

One developer, one machine, 19 repositories, 997 pages — measured 2026-08-21, not projected. The engine reports these numbers about itself; `llmwiki doctor`, `llmwiki bench` and `llmwiki downstream-read` print them for your own wiki.

| Observed | Measured | Why it matters |
| --- | --- | --- |
| Session cost does not grow with the wiki | 6.7KB injected at session start on the largest repo (236 pages) | Pointer counts are capped, not proportional |
| Retrieval stays fast | search 0.11s · per-prompt hook 0.16s, same repo | The loop runs on every prompt |
| Derived data is cheap to rebuild | full reindex 6.9s | The wiki is Markdown in git; the index is disposable |
| Local state stays bounded | 167MB across all 19 wikis | Capture expires with the harness's own retention |
| One wiki, more than one agent | opens recorded from both Codex and Claude Code on the same repo | Switching agents does not restart the knowledge |
| Delivery is measured, even when low | pointer open-through 2.1% | Reported, not assumed. The same instrument caught its own sampling bug (a "0%" that had read 5 of 54 sessions) |

These are one person's numbers on one machine, on wikis in that person's languages. They show the engine stays cheap and honest at this scale. They are not a claim about teams, other corpora or answer quality.

### What the release checks cover

- Every release candidate is tested from fresh, pinned clones: Claude hooks, Codex hooks, OpenCode plugin callbacks, enrollment, capture, close-out, restart and next-session retrieval.
- Retrieval fixtures gate correctness at 10, 100 and 1,000 generated pages.
- Checks cover the documented macOS, Linux, native-Windows and WSL2 branches, local-only data boundaries, and the exact files in the public package.
- Not claimed: that a live model always writes a good page, or that a new person understands the workflow unaided. The usability study is preregistered and has no participant results yet.
- Exact boundaries: [release gates](../reference/RELEASE_GATES.md), [support contract](../reference/support-contract.json), [usability-study protocol](../reference/USABILITY_STUDY.md).

## Configuration

### Config file (`llmwiki.config.toml`)

Everything below lives in one file. The engine code stays untouched.

```bash
cd ~/llmwiki
cp llmwiki.config.example.toml llmwiki.config.toml   # English, fully commented
```

| Setting | What it changes |
|---|---|
| `[wiki] lang` | The language the **engine** writes in. Unset = follows your session (existing pages, then what you type). Pin with `en` · `ko` · `ja` · `zh`. Your pages always follow your conversation |
| `[[category]]` | Wiki folders and what belongs in each |
| `[quiz] questions` | Questions per quiz session. The `5_topic` · `0_review` · `6_quiz` folders are fixed |
| `[private] dirs` | Folders indexed for you but never committed |
| `[models]` | Which model drafts (`light`) and which verifies (`heavy`) |
| `legacy_dirs` | Old folders to keep scanning after a rename. The core files (`current-state` · `overview` · `log`) are fixed |
| `[lint.banned_terms]` | Wording to warn about (advice only) |

- Easiest path: tell your agent what you want and ask it to edit only `llmwiki.config.toml`. Check the result with `llmwiki config <project-path>`.
- Existing pages are never migrated without your explicit approval.

### Environment variables

The generative pass (`autoupdate`, `review`) is **off until you enable it**.

- With no configuration, llmwiki starts no subprocess and sends nothing to any provider.
- Setting `LLMWIKI_LLM_CMD` in your machine's environment is the one-time opt-in. A repository config, a Markdown page, a tracked file or an autoloaded `.env` cannot set it.
- Once enabled, every block taken from transcripts or pages is screened for secrets before it enters a prompt. A block that screens down to nothing cancels the call.

| env | default | purpose |
|---|---|---|
| `LLMWIKI_LLM_CMD` | **unset — no subprocess, no network** | Command template for the LLM call. `{prompt}` and `{model}` are substituted token by token (no shell parsing). Without `{prompt}`, the prompt goes to stdin. For quoted multi-word values, use a JSON array (`["my-llm","--q","{prompt}"]`). Any CLI works (Codex, `llm`, ollama…) |
| `LLMWIKI_MODEL_HEAVY` | `claude-opus-4-8` | Reasoning tier — VERIFY and `review` |
| `LLMWIKI_MODEL_LIGHT` | `claude-sonnet-5` | Draft tier — WRITE (page generation) |
| `CLAUDE_CONFIG_DIR` | (Claude Code standard) | Also treated as a Claude profile by wiring, capture and doctor |
| `LLMWIKI_STATE_DIR` | `$XDG_DATA_HOME/llmwiki` (or an existing `<clone>/.state`) | Machine-local state location. A repository `.env` cannot change it. A custom path must be new, empty or already owned by llmwiki |
| `LLMWIKI_LANG` | `en` | Language of session-start rules and headers (`ko` for Korean). Wiki text is not changed |
| `LLMWIKI_SEARCH_RELAX` | (on) | `off` disables the fallback that retries a zero-hit query once with its terms OR-joined. For A/B measurement |
| `LLMWIKI_MAX_SOURCE_BYTES` | `262144` (256KB) | Size cap per source file. Larger files are findable by name only. Wiki pages are exempt |
| `LLMWIKI_REVIEW_MAX_PAGES` | `80` | Input cap for one `review`. Larger wikis review recent and tag-related pages only |
| `LLMWIKI_REVIEW_INTERVAL_DAYS` | `7` | `review --if-due` runs only after this many days since the last review; before that it skips in ~0.03s |
| `LLMWIKI_TOPIC_BUDGET` | `10000` | Character budget for `5_topic` pages (`topic-oversize`, advisory). Over budget, the deep pass rewrites the page from its sources, gated by `distill-verify` (citations must not shrink) |
| `LLMWIKI_OVERVIEW_BUDGET` | `8000` | Character budget at which `overview` warns (`--check` previews without writing) |
| `LLMWIKI_L0_BUDGET` | `1600` | Character **target** for L0 (`current-state`). Injection never cuts: a longer page is injected whole with a one-line notice. The `oversized-l0` lint warns from 1.25× |

- Point each tier at the newest top model, or at a non-Anthropic model or endpoint.

Reading works in any harness:

- `bun <clone>/src/cli.ts context <repo>` prints the session-start context. `… turn-context <repo>` (hook stdin JSON or `--prompt`) prints up to three related pointers, and stays silent unless confident.
- Claude Code wires both hooks. Recent Codex runs the same hook scripts natively (`adapters/codex/`). OpenCode injects through a one-file plugin (`adapters/opencode/`).
- Any other harness can call the same commands from AGENTS.md or a startup prompt.
- Per-prompt injection is an extra. The session-start context and `search` work the same everywhere.
- The read loop learns which pointers get opened, and uses that **only to reorder** — never to add text.
    - Once a day, the daemon folds the emission ledger and each harness's read records into a small per-project `affinity.json`.
    - A page pointed at in 8+ sessions over 2+ days and never opened may give up its slot. A page opened in 2+ sessions over 2+ days may move up.
    - Limits at session start: the two newest pages never move; at most two of six recent slots and one spine slot change. Per prompt: a nudge that never overturns a relevance gap of two points.
    - A page modified since it was pointed at starts over (by mtime, so `git checkout`/`pull` resets it too).
    - No file means the old ranking. Refresh on demand: `llmwiki downstream-read <repo> --refresh-affinity`.

### Index maintenance

- `/wiki-save` only runs `llmwiki db-health <repo> --notice`. It records a health signal (with a cooldown) and may recommend `/wiki-deep`. It never compacts SQLite or cleans pages.
- `/wiki-deep` refreshes the index and lint, compacts only when `db-health` marks the database eligible, then checks again.
- It recommends the manual, dry-run `llmwiki wiki-clean <repo>` only when live indexed data still exceeds 30 MiB **after** compaction.
- Fixed defaults (no environment override yet):
    - Compaction needs all three: **30 MiB** database, **10%** free pages, and at least **1 MiB** free.
    - The notice cools down for **7 days**, unless eligibility changes or indexed bytes grow by 10%.
    - The cleanup classifier considers pages older than **180 days**. Gap reports keep the **20** most recent resolved rows.
- `wiki-clean --date YYYY-MM-DD` only fixes the review date. Neither `wiki-clean --commit` nor `wiki-clean-apply` is part of save or deep automation.

## Team use

### Sharing one project's wiki

Solo use needs none of this. Everything here is additive and silent for one user.

Each person runs their own engine (own daemon, own queue) and files **their own sessions** into the shared `docs/wiki/`. Sharing is plain git.

- **Safe scaffolding**
    - `.gitignore` lists `.llmwiki/`, so an index written by an older engine is never committed.
    - `.gitattributes` sets `merge=union` for `docs/wiki/log.md` and `docs/wiki/**/index.md`, so concurrent appends merge cleanly.
- **Attribution**
    - authorship is derived from git history (`.mailmap`-aware); pages never stamp `author:` into frontmatter.
    - A `0_review` question carries `owner: <GitHub login>`. Session start shows it as `[→ login]`, so others can skip it.
- **Teammate citations**
    - On index rebuild, every well-formed cited `.jsonl` is registered as a virtual source.
    - A teammate's citation never breaks your `lint`. Malformed citations still fail.
- **Staying current** — session start prints one line when your clone is behind origin. Pull before you start.
- **Review** — wiki commits ride the same branch and PR as code. The PR review is the human check on AI-written pages.
- **Merge conflicts**
    - `gap-queue.md` / `overview.md`: take either side, then re-run `llmwiki gaps` / `llmwiki overview`. Do not hand-merge them.
    - `current-state.md` (L0): either side is safe; the next `/wiki-save` re-derives it. Keep the union of both sides' **Next** bullets.
    - The same `5_topic` page: keep **both sides' bullets**. Topic pages only grow, so the union is always correct.

### Team conventions (`llmwiki.config.toml`, optional)

The built-in folders are `0_review · 1_direction · 2_milestone · 3_decision · 4_insight · 5_topic`. **Without a config file, nothing changes** — tests pin the rendered prompts and rules byte for byte.

To use a different team format, copy `llmwiki.config.example.toml` to `llmwiki.config.toml` at the clone root and declare your categories:

```toml
[[category]]
dir = "1_goal"     # folder under docs/wiki
domain = "goal"    # category slug — pages here get `type: Goal`
review = "human"   # human → 0_review queue · model → strong-model adjudication
guide = "Quarterly goals; changes need human sign-off."
```

- **One source** — the WRITE prompts, session-start rules and `llmwiki conventions <repo>` (which the `/wiki-*` skills use) all render from this file.
- **Per-repo configs** (optional)
    - Put several `*.toml` files under `<clone>/configs/`. A file with `applies_to = ["<folder>", …]` governs those folders and everything below them (most specific match wins; `~` expands).
    - A file without `applies_to` is the default for all repos (`configs/default.toml`; shipped as `configs/default.toml.example`).
    - Order: named match → `configs/` default → root `llmwiki.config.toml` → built-in defaults. Matching uses the path the session hook passes (`CLAUDE_PROJECT_DIR`/cwd).
- **Check** — `llmwiki config [workspace]` shows which file was chosen and why. An invalid file falls back safely with a warning.
- **Restructure an existing wiki** — `llmwiki migrate <repo>` (dry run) → `--commit`.
    - Renames folders, rewrites links, updates `domain:`, and stamps `.schema-version`.
    - Never automatic. Drift in either direction is reported at session start, in `llmwiki doctor`, and before `/wiki-deep` · `/wiki-doctor`. Applying it always takes an explicit `--commit`.
- **Distribution** — commit the config to your team's engine fork; members `git pull`; one person runs `migrate`; the result merges by PR. `configs/*.toml` is gitignored, so track a team config with `git add -f configs/<team>.toml`. The root `llmwiki.config.toml` commits normally.
- **Compatibility** — a config key is removed only after a deprecation window with a lint warning and a `migrate` step.

## Updating

Updates are manual. The engine never updates itself.

- The daemon checks origin once a day. When a newer version exists, your next session starts with a one-line notice and the exact command.
- **You** see the notice, not only the agent: Claude Code and Codex show a hook system message, OpenCode shows a toast, and each `llmwiki` command prints it once on stderr.
- It also catches newer code on origin under the same version number.

```bash
cd ~/llmwiki
git pull && ./setup.sh          # pull alone is not enough — see below
```

`git pull` changes only the clone. The daemon keeps running the code it started with, and the OpenCode plugin is a copy in your config directory. Re-running `setup.sh` re-points them and restarts the daemon. It is safe to run again.

`llmwiki doctor` reports what is behind:

- `[update] ⚠️ v… → v… available` — the clone is behind `origin`.
- `[update] ⚠️ N commit(s) behind origin at the same version` — origin has newer code without a version bump.
- `[update] ⚠️ clone files changed after the last successful install` — `git pull` ran but setup has not refreshed the installed surfaces and daemon yet. Clears after a successful setup.
- `[daemon] ⚠️ running code older than this clone` — the daemon predates your pull. `llmwiki daemon-sync` restarts it when it is behind, and `llmwiki doctor --fix` does the same in a full health run. You rarely need either: `/wiki-save` and `/wiki-deep` run `daemon-sync` as their last step.
- `[opencode] ⚠️ plugin stale` — the installed plugin copy is older than the clone's adapter.

## Uninstall

```bash
cd ~/llmwiki
./setup.sh --uninstall                 # remove every llmwiki-owned hook, plugin, command, launcher and service
./setup.sh --uninstall --purge-data    # …and delete llmwiki's local runtime state as well
```

- Run it from the installed clone **before** you move or delete the clone.
- Removal is by ownership, not by restoring a backup. Only entries llmwiki installed are removed; the rest of your harness config stays as is (including hooks you added in between).
- Your wikis are never touched. `docs/wiki/` is ordinary Markdown in your repositories.
- Without `--purge-data`, local state is kept and its location reported. `--purge-data` deletes only what llmwiki created.
- Enrollment markers in each repo's `.git/llmwiki/` do nothing without the engine. Remove one with `llmwiki disable <repo>`.

## Data on your machine

| What | Where | Kept |
|---|---|---|
| Capture queue (which repositories you worked in, and when — metadata only) | `<state>/capture.db` | until `--purge-data` |
| Daemon log (counts only; never paths of unenrolled projects) | `<state>/daemon.log` | until `--purge-data` |
| OpenCode transcript exports (conversation text — the only bodies llmwiki stores) | `<state>/opencode-export/` | **deleted after 30 days** |
| Per-project index and caches (rebuildable) | `<state>/projects/<id>/` | compacted; dropped after 60 idle days |

- `<state>` defaults to `$XDG_DATA_HOME/llmwiki`. An existing `<clone>/.state` from an older install keeps being used; `llmwiki migrate-state` moves it.
- The state directory and its files are created private (`0700` / `0600`).
- Claude and Codex transcripts are read in place from the harness's store. llmwiki makes no copy.
- Three homes, one owner each:
    - capture queue — central, under `<state>`
    - content — each repo's own `docs/wiki/` (Markdown is the source of truth)
    - index — one directory per project under `<state>` (`llmwiki state-path <repo>`), rebuildable at any time; the repository carries only `docs/wiki/`

## Prerequisites

The machine-readable platform, runtime, CI and privacy contract is [`reference/support-contract.json`](../reference/support-contract.json).

| | Required | Notes |
|---|---|---|
| **Bun ≥ 1.2.21** | ✔ required | Single binary. POSIX: `curl -fsSL https://bun.sh/install \| bash`. Native Windows, in PowerShell: `irm bun.sh/install.ps1 \| iex`. Runs `.ts` directly; `bun:sqlite` includes FTS5 — no build, no `node_modules`. Only `bun run typecheck` needs a one-time `bun install` (dev only). |
| **git** | ✔ required | Capture asks git whether a directory is a worktree. Setup also looks beyond `PATH` (Homebrew, MacPorts, Nix, `~/.local/bin`) and stops before changing anything if git is missing. `llmwiki doctor` reports the path under `[deps]`. |
| **Codex · OpenCode CLI** | only for those harnesses | `codex` / `opencode` on `PATH`. Codex also needs lifecycle-hook support with the stable `hooks` feature enabled. Setup checks this before changing hooks, skills or services. |
| **LLM CLI** | optional, opt-in | Capture, read injection, `/wiki-*` and `ingest` (capture only) work without it, and **nothing is sent anywhere by default**. `autoupdate`, `review` and `ingest`'s consolidation start a subprocess only when you set `LLMWIKI_LLM_CMD` in your shell (e.g. `export LLMWIKI_LLM_CMD='claude -p {prompt} --model {model} --tools= --permission-mode dontAsk --strict-mcp-config --safe-mode --no-session-persistence'`). Unset, those passes report "unavailable" and skip. |
| **OS** | macOS / Linux / Windows | Daemon and unattended updates: macOS = launchd; Linux = systemd (`--user`), falling back to cron+nohup; Windows = per-user Startup folder. macOS and Linux run the full suite in CI. Windows runs a platform-contract job; the rest is verified by hand. Details: [`daemon/README.md`](../daemon/README.md) |

### Harness and OS notes

- **Claude Code** — `./setup.sh --harness claude`. Capture, read injection and `/wiki-*` commands are wired automatically.
- **Codex** — `./setup.sh --harness codex`
    - Installs the user CLI and five `$wiki-*` skills, and merges `SessionStart`/`UserPromptSubmit` hooks into `$CODEX_HOME/hooks.json`.
    - Once: start Codex and review the exact commands in `/hooks`. New or changed hooks are skipped until trusted.
    - Capture watches `$CODEX_HOME/sessions/**/*.jsonl[.zst]`.
    - Codex Desktop's own homes (runtime and per-account) are swept too. A rollout hardlinked into several of them stays **one** queue row and is never filed twice.
    - Skills run on Codex itself. Unattended `autoupdate`/`review` run only when `LLMWIKI_LLM_CMD` is set.
- **OpenCode** — `./setup.sh --harness opencode`
    - Installs global `/wiki-*` commands, a read-injection plugin pinned to the clone, and the user CLI.
    - Capture reads OpenCode's SQLite session store. `XDG_DATA_HOME`/`OPENCODE_DB` are kept in the daemon environment.
- **Windows** — native and WSL2 are both supported.
    - Under WSL2 everything runs unchanged. This is also what Claude Code and Codex recommend.
    - Bun and `bun:sqlite` run natively (FTS5 trigram included). Path matching normalizes backslashes.
    - Native: install Bun and Git, then run `./setup.sh --harness claude` (or `all`) from Git Bash. Claude Code runs the hook scripts itself, even without `bash` on the Windows `PATH`.
    - Codex and OpenCode hand shell commands to PowerShell, and `bash` is not on the Windows `PATH`. So on Windows their hooks and skills call `bun <clone>/src/cli.ts` directly — no interpreter, no `PATH` entry.
    - The `llmwiki` launcher in `~/.local/bin` is a `#!/bin/sh` script. It works from Git Bash (add the folder to `PATH` yourself), not from PowerShell or `cmd`. Nothing the harnesses install depends on it.
    - The capture daemon registers in your per-user **Startup folder** and runs hidden. No admin rights are needed (a Task Scheduler logon entry would need them).
    - It starts at logon and does **not** restart on crash, like the Linux `cron @reboot` fallback. `llmwiki doctor` reports "starts at logon" and "running" separately.

## Troubleshooting

Two doctors, two jobs:

- `llmwiki doctor` checks the installation: engine files, daemon, hooks, installed skills and the user CLI. `--fix` repairs wiring.
- `llmwiki wiki-doctor <repo>` checks one project's `docs/wiki/`, read-only by default: structure, index freshness, SQLite health, lint, capture continuity, gap queue and review cadence. `--fix` rebuilds only safe derived state.
- `/wiki-doctor` (Codex: `$wiki-doctor`) runs the full repair. After the engine repair, the agent fixes page content from the lint and review evidence, without deleting sources or inventing project direction.

When the agent's data is not where expected:

- If the default locations are empty, the engine also checks common alternatives: a mounted Windows profile under `/mnt/c/Users/*` (WSL), XDG variants, `~/.opencode`, and the per-account homes Codex Desktop keeps.
- Each candidate is verified by its schema. One verified candidate **inside your home** is connected without asking.
- Anything outside your home is never connected automatically (a mounted Windows profile is often someone else's). You get the exact `llmwiki connect` command instead.
- An explicit `CODEX_HOME` stays exclusive, unless it is one of Codex Desktop's own homes (the app exports it into its terminals).
- `llmwiki locate <harness>` shows what was found. When it cannot act, it lists what it tried, what blocked it, and your options.
- `llmwiki connect <harness> <path>` records a path only if verification accepts it.

Other signs:

- `# ⚠ route:` on a close-out extract — the session's edits went to a different enrolled repo. Its record is routed to that wiki.
- Setup prints a one-time `PATH` line when your shell does not include the `llmwiki` launcher yet.

## Project structure

```
setup.sh       one-click onboarding (path-agnostic: doctor→daemon→hooks·commands→index)
src/           TypeScript engine (Bun runtime, bun:sqlite built in — zero node_modules·build)
  cli.ts       CLI dispatcher — 40+ subcommands: init·status·disable·index·search·lint·doctor·wiki-doctor·db-health·daemon-sync·wiki-clean·locate·connect·save-current·update-*·quiz-*·autoupdate·consolidate·review·gaps·overview·ingest·bench·… (full registry: HANDLERS at the bottom of this file)
  engine/
    schema.sql   per-repo index schema (documents·chunks·FTS5·references)
    db.ts        WikiIndex: indexing (content_hash incremental)·search·graph·staleness
    chunker.ts   FTS chunking (~512 tokens)         refs.ts    citations·links → graph edges
    lint.ts      structural check (deterministic)   review.ts  semantic lint (generative, scoped, cached)
    gaps.ts      review gaps → self-closing queue 0_review/gap-queue.md (LLM-free)
    quiz.ts      quiz scheduling + 6_quiz/quiz-ledger.md (LLM-free; /wiki-quiz writes and grades)
    overview.ts  overview entry-point normalization (LLM-free, idempotent)
    synthesis.ts deterministic topic view (tag clusters, consolidation gaps) — LLM-free, rebuildable
    extract.ts   transcript incremental extraction (watermark)   update.ts  log-layer orchestration
    autoupdate.ts  unattended fact update (write→second check→lint gate)
    consolidate.ts log→topic pages (5_topic) (write→independent VERIFY→grounding→lint)
    source.ts    transcript source abstraction (harness-agnostic)
    sources/     claude.ts · codex.ts (incl. .zst) · opencode.ts (SQLite→export) · plain.ts (any file)
    ingest.ts    condense one file with no daemon (`llmwiki ingest`)
    capture.ts   central capture queue (source_kind)   doctor.ts   wiring check
    config.ts    team conventions — llmwiki.config.toml + configs/*.toml resolver
    migrate.ts   restructure a wiki to the config (dry-run default, link rewriting, drift detection)
  daemon/
    watch.ts     capture daemon (sweeps every source)
    wire.ts      Claude hook·command wiring (~/.claude* + $CLAUDE_CONFIG_DIR)
    wire-codex.ts Codex hook merge + ~/.agents/skills + ~/.local/bin/llmwiki
    wire-opencode.ts OpenCode global plugin + /wiki-* + shared CLI
    list-pending-repos.ts  print pending repos from the queue (for schedulers)
daemon/        install.sh (launchd/systemd/cron auto-detect) + autoupdate-*.sh (unattended fact pass)
hooks/         sessionstart-inject.sh (session start) · userpromptsubmit-inject.sh (per prompt) · pretooluse-inject.sh (edit-time rules)
adapters/      codex/ (hooks.json template) · opencode/ (single-file plugin)
skill/         wiki-save · wiki-deep · wiki-doctor · wiki-ask · wiki-quiz (/commands)
examples/      sample-wiki/ — a finished wiki to look at. Not indexed. Do not copy; real wikis are generated under each project's docs/wiki. See examples/README.md
tests/         bun:test suite — `bun test`
package.json·tsconfig.json   Bun metadata (for typecheck; the runtime executes .ts directly)
```

## Regression tools (for engine development)

These are never part of the daily loop.

- **`llmwiki bench <repo>`** — deterministic retrieval benchmark (no LLM, runs in ms).
    - Golden queries in `<repo>/docs/wiki/.bench/golden.toml` (≤20 per repo, any language).
    - Scores search any-hit `r@k` and per-prompt pointer hits. A refusal query passes when the per-prompt hook stays silent.
    - Seeded tune/sealed split: `--tune-only` to iterate, `--sealed` for final checks only (each look weakens it).
- **`llmwiki compare-arm <repo> --corpus <dir> --label <name>`** → **`llmwiki compare-verdict A.json B.json`** — frozen-corpus A/B.
    - Builds an isolated temporary wiki per configuration from the same transcripts. Only the build uses an LLM.
    - Validates both reports before judging. Malformed or incompatible evidence results in `keep`.
    - Judges with ordered gates: regression block first, then keep / adopt / undecided. No LLM.
    - Run only when prompts or models change.
- **`llmwiki bench-scale --repeats 2`** — generated-corpus scale report.
    - Runs the 10/100/1000-page tiers and gates search and context correctness.
    - Timing and disk numbers are observations, never release thresholds.
- **`llmwiki bench-capture --repeats 2 [--sessions 100,1000,10000]`** — historical-session scale report.
    - Compares Claude, Codex and OpenCode discovery and bounded sample materialization.
    - Measures the lightweight hook entry point (session start, empty prompt, enrollment probe). Full CLI startup is reported separately.
    - Counts are deterministic; timings remain observations.

The full reproducible commands and the claims each result permits: [`reference/RELEASE_GATES.md`](../reference/RELEASE_GATES.md).

## Contributing

- Start with [CONTRIBUTING.md](../CONTRIBUTING.md): clean-clone workflow and checks.
- [ARCHITECTURE.md](../ARCHITECTURE.md) shows which module owns a change and its safety boundary.
- `bun run check:quick` while iterating; `bun run check` before review.

## Principles

- Transcripts are raw and immutable. Pages cite them; no page is derived from another page. Updates process only what is past the watermark.
- Facts are written by the AI. Judgment (a decision's why, what and alternatives; direction) belongs to a person. AI proposals stay `status: draft` until a person confirms them.
- Git Markdown is the single source of truth. Commits go under one author: the repository owner.
- No over-engineering. Under 100k tokens, no vector DB or RAG is needed; `index.md` navigation is enough.
- Context cost must not grow with use. Injection budgets are capped. The `/wiki-*` skills keep only the procedure loaded (`/wiki-save` ≤ 15KB) and fetch detail when a step needs it (`llmwiki conventions <repo> --section <name>`). The read loop reorders from use instead of adding text.

## License

[Apache License 2.0](../LICENSE) © 2026 suwonleee.
