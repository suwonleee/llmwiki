<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
    <img src="assets/banner.png" alt="Quiz_wiki" width="100%">
  </picture>
</p>

# llmwiki · Quiz_wiki — a lightweight, local-first project wiki that compounds, and quizzes you back

*Also known as: quiz wiki · llmwiki quiz · Quiz_wiki — the spaced-repetition layer that quizzes you on your own past decisions.*

**English** · [한국어](readmes/README.ko.md) · [日本語](readmes/README.ja.md) · [中文](readmes/README.zh.md)

Whatever project, terminal (default/tmux/iTerm2), or coding agent (Claude Code · Codex · OpenCode) you work in, project-specific LLM knowledge **compounds** instead of evaporating.

## Everything you need to do

Already have Git, [Bun](https://bun.sh), and one coding agent installed? The rest is one clone and one prompt.

```bash
cd ~
git clone https://github.com/suwonleee/llmwiki.git
cd ~/llmwiki
```

Start **one** agent from this folder:

```bash
claude
# or: codex
# or: opencode
```

Paste this into the agent:

```text
Read setup_text.md and install llmwiki for this machine and the coding agent I am currently using. Follow the file exactly, run the health checks, and tell me about any manual step that remains.
```

This is the recommended installation path. The README stays human-facing; exact harness branches,
health checks, `PATH` handling, hook trust, OS notes, and recovery rules live in the
agent contract [`setup_text.md`](setup_text.md) and its
[installation-flow reference](reference/INSTALLATION_FLOW.md).

After setup reports healthy, stay in the same setup session and tell the agent:

```text
Initialize llmwiki for /absolute/path/to/my-project using the engine you just installed. Verify the project wiki, then tell me the close-out command for this coding agent.
```

Then open that project with your coding agent and work as usual. At the end of a meaningful session, use `/wiki-save` in Claude Code or
OpenCode, and `$wiki-save` in Codex. Run `/wiki-deep` (Codex: `$wiki-deep`) periodically for
the backlog and deeper maintenance. If a project wiki looks unhealthy, run `/wiki-doctor`
(Codex: `$wiki-doctor`).

To check that the wiki is compounding, paste this in that project's agent session:

```text
Run /wiki-doctor for this project. Repair safe generated state and evidence-grounded page problems, then summarize what was fixed and what still needs attention. In Codex, run $wiki-doctor.
```

### Want it another way? One file

The engine code stays untouched — everything below lives in one config:

```bash
cd ~/llmwiki
cp llmwiki.config.example.toml llmwiki.config.toml   # English, fully commented
```

| Setting | What it changes |
|---|---|
| `[wiki] lang` | the language the **engine** writes in. Unset = follows your session (the wiki's own pages, then what you type to your agent); pin it with `en` · `ko` · `ja` · `zh`. Your pages always follow your conversation either way |
| `[[category]]` | the wiki folders and what belongs in each |
| `[topic]` `[queue]` `[quiz]` | those folder names, and how many questions a quiz session asks |
| `[private] dirs` | folders indexed for you but never committed |
| `[models]` | which model drafts (`light`) and which verifies (`heavy`) |
| `[files]` · `legacy_dirs` | the three special file names, and old folders to keep scanning after a rename |
| `[lint.banned_terms]` | wording to warn about (advisory only) |

Easiest path: tell your agent what you want and ask it to edit only `llmwiki.config.toml`, then check the result with `llmwiki config <project-path>`. Existing pages are never migrated without your explicit approval.

No MCP server, Docker, external database, vector database, or cloud service is required. llmwiki uses Bun, local hooks, a local capture daemon, local SQLite, and git markdown. See [`setup_text.md`](setup_text.md) for the installation contract the agent follows.

- **What it is**
    - an LLM-maintained project wiki for agentic environments — sourced from your work transcripts, stored as plain git markdown
    - engine = a local library: SQLite index · deterministic lint · citation/cross-reference graph · content-hash increments
    - on top: an automatic capture daemon + transcript compounding — **no MCP registration**
- **Labor split**
    - fact — written unattended, by the AI
    - judgment (direction · decisions · contradictions) — always human-present
    - human memory — a daily forgetting-curve quiz (`/wiki-quiz`), keeping your recall of your own decisions as sharp as the model's context
- **Two layers, one source**
    - per-session *logbook* — time axis: `2_milestone` · `3_decision` · `4_insight`
    - per-concept *topic encyclopedia* — `5_topic`, topic axis, in-place consolidation
    - both re-derived from raw transcripts only — no wiki→wiki

The core idea — a project wiki that the LLM maintains and the human only steers — comes from [Andrej Karpathy's LLM-wiki note](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). That note is the only outside reference: the design and code here are original.

## Manual fallback

Use this only when you intentionally want to install without an agent. Select one harness;
do not use `auto` unless you want every detected harness wired.

```bash
./setup.sh --harness claude
# or: ./setup.sh --harness codex
# or: ./setup.sh --harness opencode
```

- Follow the exact next command printed by setup
    - Claude-only: clone-pinned `bun <clone>/src/cli.ts …`
    - Codex/OpenCode: user-level `llmwiki …`
- Complete any printed manual action
    - Codex only: review and trust the two current llmwiki hooks in `/hooks`
- Full branch and recovery reference: [`reference/INSTALLATION_FLOW.md`](reference/INSTALLATION_FLOW.md)

## The Compounding Loop

Six stages — two fully unattended, the rest one command each.

| Stage | What | Automatic? | Implementation |
|------|------|:---:|------|
| **Capture** | Every session transcript → central queue | ✔ | `src/daemon/watch.ts` (terminal/profile-agnostic) |
| **Condense (update)** | Queue → that repo's `docs/wiki/` **log layer** (incremental append) | 1 command | Codex: `$wiki-save` / `$wiki-deep` · Claude/OpenCode: `/wiki-save` / `/wiki-deep` + `src/engine/update.ts` |
| **Consolidate** | Log → per-concept **topic encyclopedia** `5_topic/` (in-place merge·raw re-grounding) | 1 command | Codex: `$wiki-save` / `$wiki-deep` · Claude/OpenCode: `/wiki-save` / `/wiki-deep` + `src/engine/consolidate.ts` |
| **Read** | Cold-start injection + per-turn related-page pointers | ✔ | `hooks/sessionstart-inject.sh` · `hooks/userpromptsubmit-inject.sh` (Claude Code; Codex/OpenCode → `adapters/`) |
| **Quiz (human memory)** | Wiki's judgment layer → day-granular spaced-repetition quiz **for the human** (`6_quiz/` records — never indexed/searched; cold-start shows a due-count line) | 1 command | Codex: `$wiki-quiz` · Claude/OpenCode: `/wiki-quiz` + `src/engine/quiz.ts` (`quiz-status`·`quiz-next`·`quiz-record`) |
| **Self-healing** | Structural (orphan·stale·dangling) = deterministic `lint` / semantic (contradiction·stale claim·missing concept) = generative `review` (auto on sync — engine-gated cadence `--if-due`, default 7d·scoped+cached) → gaps land in `gaps`'s self-closing queue (`0_review/gap-queue.md`) | 1 command → auto | `lint`·`review`·`gaps` (`src/engine/{lint,review,gaps}.ts`) |

- **Transcript retention** — transcripts are the agent's files, not llmwiki's
    - they rotate on each agent's own schedule (Claude Code defaults to ~30 days; Codex compresses finished sessions to `.zst`) — llmwiki never copies them
    - close out sessions worth keeping with `/wiki-save` before they age out; queue rows whose transcript is already gone are pruned by the deep pass (`capture-prune`, 30-day guard)

### The human memory loop (`/wiki-quiz`)

Every other stage keeps the **model** grounded; this one keeps the **human** sharp.

- **Why it exists**
    - the labor split leaves the human exactly one non-delegable duty — direction + contradiction judgment
    - that judgment decays together with your memory of your own past decisions
- **How it schedules** — deterministic, engine-side, zero LLM
    - day-granular forgetting curve: boxes of 1·3·7·16·35·60 days
    - wrong or skipped → back to 1 day; an item is never asked twice in one day
    - scope: the wiki's judgment layer — direction > decision > insight·topic > milestone, newest first
- **How a session runs** — pre-authored in one batch
    - the engine picks the due items; the session reads those pages together and writes every question up front — answering one shows the next with no wait
    - answers are gist-graded warm, grounded in the pages; wrong answers come back first the next day
    - size: `[quiz] questions` in `llmwiki.config.toml` — default **3**, raise per run like `/wiki-quiz 5`, engine-capped at **7** (a quiz people skip reinforces nothing)
- **Where records live**
    - `docs/wiki/6_quiz/` — ledger + per-day session notes
    - a human-only layer excluded from indexing/search/cold-start — the LLM never feeds on its own quiz output: strictly wiki → human

### Evidence that travels with the page (page format v3)

A citation like `[^s1]: <session>.jsonl` points at a transcript that lives on **one machine** — a teammate can read your conclusion but not the grounding behind it. v3 puts 1–2 lines of the evidence itself right under the footnote:

```markdown
- We kept the log layer and added the topic layer on top of it [^s1]

[^s1]: 3bd9cac5-….jsonl
    > [2026-06-29 14:02 user] "keep the log as-is and layer on top — replacing it is the risky part"
```

- **Format contract**
    - the footnote definition line stays byte-identical to before — four parsers read it, and one of them keeps a teammate's citation from erroring
    - excerpts come only from `llmwiki excerpt` — verbatim, length-capped, secret-screened (raw transcripts routinely contain credentials)
    - judgment claims quote the human; factual claims carry a machine tool-record
- **Scannable page body**
    - numbered sections in reading order — `## 1. <label>`, split as `### 1-1. <label>` when a section has parts; a short single-group page stays a bare bullet list
    - inside a section: one concrete point per `-` line; supporting detail at `    -`; deeper detail at `        -` (no fourth level)
    - one point per line: a bullet enumerating more than three items becomes a parent plus one child per item, never a `·`-joined pile-up (lint: `dense-bullet`)
    - noun-phrase or telegraphic endings where natural; verbs retained when needed for an unambiguous actor, action, condition, or outcome
    - no abstract framing, paragraph repetition, or child bullet that merely restates its parent (lint: `flat-body` when a long page has no sections)
- **Lint stance**
    - a quote is verified against the transcript only **where that transcript is readable**; on other clones lint stays silent — "can't check" must never read as "wrong"
- **Zero retrieval cost**
    - excerpts are excluded from the search index and the topic-page budget — evidence costs neither retrieval quality nor prose room

### Self-healing flow (the human only fills in)

The wiki reports what's missing on its own; the human supplies only the judgment that fills it.

- **At close-out (`/wiki-save`) and on the deep pass (`/wiki-deep`)**
    - ① deterministic `lint` — structure (orphan · stale · dangling)
    - ② generative `review` — semantics (contradiction · stale claim · missing concept); auto via `--if-due` with an engine-enforced cadence (default 7 days, `LLMWIKI_REVIEW_INTERVAL_DAYS`), input scoped to recent + tag-neighbor pages, skipped when nothing changed; the deep pass runs it unconditionally
    - ③ `gaps` — stacks the *missing concepts · follow-up questions* that `review` surfaced into a tracking queue (`0_review/gap-queue.md`)
- **How a gap closes**
    - filled once someone works that topic once, or the deep pass fills it
    - auto-closes when `review` fails to surface it twice in a row
- **Deliberately not auto-generated** — pages never get invented from thin evidence

## Structure

```
setup.sh       one-click onboarding (path-agnostic: doctor→daemon→hooks·commands→index)
src/           TypeScript engine (Bun runtime, bun:sqlite built in — zero node_modules·build)
  cli.ts       CLI dispatcher: init·index·reindex·refs·lint·search·update-*·skeleton·autoupdate·consolidate·topics·ingest·register-transcript·review·gaps·distill-verify·git-rules·overview·reconcile·doctor·context·digest·context-audit·config·conventions·migrate·quiz-*·capture-prune·bench·compare-arm·compare-verdict
  engine/
    schema.sql   per-repo index schema (documents·chunks·FTS5·references)
    db.ts        WikiIndex: indexing(content_hash incremental)·search·graph·staleness
    chunker.ts   FTS chunking (~512 tokens)         refs.ts    citations·links → graph edges
    lint.ts      structural hygiene check (deterministic)      review.ts  semantic lint (generative·auto on sync·scoped+unchanged-skip cache)
    gaps.ts      review gaps (missing concepts·follow-up questions) → self-closing queue 0_review/gap-queue.md (LLM-free; closes after 2 absences)
    quiz.ts      human memory loop — forgetting-curve scheduling + priority selection + 6_quiz/quiz-ledger.md (LLM-free; /wiki-quiz authors·grades warm)
    overview.ts  overview entry-point normalization (Recent Updates→log pointer·budget warning, LLM-free·idempotent)
    synthesis.ts deterministic relational synthesis + topic view (tag clusters·consolidation gaps, `topics`) — LLM-free·regenerable (`digest`/`topics`+cold-start spine)
    extract.ts   transcript incremental extraction (watermark)   update.ts  log-layer orchestration
    autoupdate.ts  unattended fact update (write→secondary verification→lint gate)
    consolidate.ts log→topic encyclopedia (5_topic) consolidation (write→independent VERIFY(added claims)→grounding→lint, independent watermark)
    source.ts    transcript source abstraction (discover/probe/parse adapters — harness-agnostic)
    sources/     claude.ts(claude-jsonl) · codex.ts(Codex rollout, incl. .zst) · opencode.ts(OpenCode SQLite→export) · plain.ts(arbitrary file drop)
    ingest.ts    condense a single file with no daemon (`llmwiki ingest` — drop a source)
    capture.ts   central capture queue (.state/capture.db, source_kind)   doctor.ts   wiring check
    config.ts    team conventions — llmwiki.config.toml + configs/*.toml per-repo resolver (applies_to prefix; zero-config = stock structure; single source prompts/rules render from)
    migrate.ts   restructure wiki to the config (dry-run default·link rewriting·.schema-version·drift detection)
  daemon/
    watch.ts     capture daemon (sweeps sources() — default Claude profile transcripts)
    wire.ts      Claude hook·command wiring (~/.claude* + $CLAUDE_CONFIG_DIR)
    wire-codex.ts Codex hook merge + ~/.agents/skills + ~/.local/bin/llmwiki
    wire-opencode.ts OpenCode global plugin + /wiki-* + shared CLI
    list-pending-repos.ts  print only pending repos from the queue (for schedulers)
daemon/        install.sh (launchd/systemd/cron auto-detect) + autoupdate-*.sh (unattended fact pass)
hooks/         sessionstart-inject.sh (cold-start) · userpromptsubmit-inject.sh (per-turn pointers)
adapters/      codex/ (native-hook hooks.json template) · opencode/ (single-file plugin)
skill/         wiki-save(session close-out)·wiki-deep(periodic deep pass)·wiki-doctor(diagnose/repair)·wiki-ask·wiki-quiz(human memory) (/commands)
examples/      sample-wiki/ — a finished wiki example (read-only illustration). Not indexed by the engine (IGNORE_DIRS). **Do not copy** — real wikis are auto-generated under each project's docs/wiki. See examples/README.md
tests/         bun:test suite (chunker·refs·lint·extract·capture·db·source·review-scope·overview·gaps·quiz·migrations) — `bun test`
package.json·tsconfig.json   Bun metadata (for typecheck; the runtime executes .ts directly)
```

Storage principle — three homes, one owner each:

- capture queue — central: `<clone>/.state/capture.db`
- content — each repo's own `docs/wiki/` (co-located; markdown = source of truth)
- index — `<repo>/.llmwiki/index.db` (regenerable at any time)

## Prerequisites

| | Required | Notes |
|---|---|---|
| **Bun ≥ 1.1** | ✔ required | Single binary (`curl -fsSL https://bun.sh/install \| bash`). Runs `.ts` directly, and `bun:sqlite` bundles FTS5 — zero build·`node_modules`. Running the engine and `bun test` work with no install; only `bun run typecheck` (tsc) needs a one-time `bun install` (dev-only). |
| **Codex · OpenCode CLI** | their quick starts only | `codex` / `opencode` on `PATH`. Codex additionally needs lifecycle-hook support with the stable `hooks` feature enabled. Setup checks support — and any existing feature setting — before changing hooks, skills, or services. |
| **LLM CLI** | only for the generative pass | Capture·read-injection·`/wiki-*`·`ingest` (capture-only, queues pending updates) work without it. `autoupdate·review` and `ingest`'s consolidation call an LLM CLI — default `claude -p` ([install](https://docs.claude.com/en/docs/claude-code/setup)), or point `LLMWIKI_LLM_CMD` at a different CLI/provider. |
| **OS** | macOS / Linux | macOS=launchd, Linux=systemd (`--user`), falls back to cron+nohup if systemd is unavailable. Daemon details in [`daemon/README.md`](daemon/README.md) |

### Harness · OS notes (Claude Code / Codex / OpenCode / Windows)

- **Claude Code** — `git clone … && ./setup.sh`, done
    - capture · read-injection · `/wiki-*` commands all wired automatically
- **Codex (OpenAI)** — `./setup.sh --harness codex`
    - installs the user CLI + five `$wiki-*` skills, and merges native `SessionStart`/`UserPromptSubmit` hooks into `$CODEX_HOME/hooks.json`
    - one-time: start Codex and review the exact commands in `/hooks` — new or changed hooks stay skipped until trusted
    - capture watches `$CODEX_HOME/sessions/**/*.jsonl[.zst]`
    - warm skills run on Codex itself; unattended `autoupdate`/`review` still need `LLMWIKI_LLM_CMD` when the Claude CLI is absent
- **OpenCode** — `./setup.sh --harness opencode`
    - installs global `/wiki-*` custom commands, a clone-pinned read-injection plugin, and the user CLI
    - capture reads the SQLite session store; `XDG_DATA_HOME`/`OPENCODE_DB` are preserved in the daemon environment
- **Windows** — WSL2 recommended
    - Bun·`bun:sqlite` run natively, and path matching normalizes backslashes
    - native Windows still needs Git Bash for the `.sh` scripts, plus manual Task Scheduler/NSSM registration (no launchd/systemd/cron)
    - under WSL2 everything runs unmodified (launchd→systemd·bash·paths) — also the official Claude Code·Codex recommendation

## Install / Usage

**Clone this repo anywhere, under any name, and run `./setup.sh`** — that makes it the engine for that machine.

- every wire (daemon · hooks · CLI · `/wiki-*` commands) is derived from the clone location itself — no fixed path like `~/llmwiki`, any folder name
- with just Bun, `.ts` runs as-is — no bundle, no build step
- after moving or updating the clone, re-run setup — it refreshes generated skills and wiring idempotently

```bash
# 0) clone the engine (once, one per machine) — location/name doesn't matter
git clone https://github.com/suwonleee/llmwiki.git
cd llmwiki

# 1) one-shot install — doctor → capture daemon (OS auto-detect) → harness wiring → doctor
./setup.sh --harness auto                # or pin one: claude · codex · opencode

# 2) just work — sessions are captured automatically in any folder/terminal
#    manual per-repo commands: bun <clone>/src/cli.ts init|index|search|lint <repo>

# 3) close out the session in your agent's prompt
/wiki-save                               # close out this session (Codex: $wiki-save)
/wiki-deep                               # periodic DEEP pass (Codex: $wiki-deep)
/wiki-doctor                             # diagnose + repair this wiki (Codex: $wiki-doctor)
/wiki-quiz                               # human memory loop (Codex: $wiki-quiz)
```

> Individual steps: `bun <clone>/src/cli.ts doctor` · `bash <clone>/daemon/install.sh` ·
> `bun <clone>/src/daemon/wire.ts` (Claude) · `wire-codex.ts` / `wire-opencode.ts` (Codex/OpenCode) —
> each wire script also takes `--revert` to undo its own changes.

### Installation doctor vs project wiki doctor

- `llmwiki doctor` checks the llmwiki installation: engine files, daemon, hooks, installed skills,
  and the user CLI. Its `--fix` repairs wiring.
- `llmwiki wiki-doctor <repo>` diagnoses one project's `docs/wiki/` read-only by default:
  structure, exact index freshness, SQLite integrity/storage, lint, capture continuity, gap queue,
  and semantic-review cadence. Add `--fix` to rebuild only safe derived/generated state.
- `/wiki-doctor` (Codex: `$wiki-doctor`) runs the full repair workflow. After the deterministic
  engine repair, the active agent reads the remaining lint/review evidence and fixes page content
  without deleting provenance or inventing project direction.

## Configuration (environment variables) — provider · model · CLI agnostic

The generative pass (autoupdate/review) defaults to `claude -p` + the built-in pinned model IDs listed below; with no configuration at all, behavior is identical to stock.

| env | default | purpose |
|---|---|---|
| `LLMWIKI_MODEL_HEAVY` | `claude-opus-4-8` | reasoning-tier — VERIFY (adversarial gate)·review (semantic check) |
| `LLMWIKI_MODEL_LIGHT` | `claude-sonnet-5` | draft-tier — WRITE (page generation) |
| `CLAUDE_CONFIG_DIR` | (Claude Code standard) | If set, that directory is also recognized as a Claude profile — hook wiring (wire)·capture (claude source)·doctor all honor it. |
| `LLMWIKI_LLM_CMD` | `claude -p {prompt} --model {model} --disallowedTools …` | argv template for the LLM call. `{prompt}`·`{model}` are substituted token-by-token (no shell parsing). If `{prompt}` is absent, the prompt is sent via stdin. For multi-word values needing quotes, use a JSON array (`["my-llm","--q","{prompt}"]`). Any CLI works — Codex·`llm`·ollama, etc. |
| `LLMWIKI_LANG` | `en` | Language for cold-start operating rules/headers. `ko` for Korean. (The wiki body itself stays as written — only the UI copy switches.) |
| `LLMWIKI_SEARCH_RELAX` | (on) | Set `off` to disable the relaxed-recall fallback — when a natural-language query strict-AND matches 0 rows, search retries ONCE with the same terms OR-joined (trigram-safe, Unicode/CJK-aware, no stopword lists). Kill-switch for A/B measurement. |
| `LLMWIKI_MAX_SOURCE_BYTES` | `262144` (256KB) | Per-file content cap for SOURCE files. Larger files (multi-MB yaml/json fixtures) are registered metadata-only — findable by name, but not full-text indexed. Wiki pages are exempt. Keeps the index compact and search fast on fixture-heavy repos, with no quality change on search/turn-context. |
| `LLMWIKI_REVIEW_MAX_PAGES` | `80` | Input cap for a single `review` pass. If the wiki exceeds this, only recent+tag-neighbor pages are reviewed (to avoid prompt overflow). |
| `LLMWIKI_REVIEW_INTERVAL_DAYS` | `7` | Cadence gate for `review --if-due` — it runs only when this many days have passed since the last committed review (before that it skips deterministically in ~0.03s). Makes the per-session close-out's review cost zero by default. |
| `LLMWIKI_TOPIC_BUDGET` | `10000` | Character budget for the `topic-oversize` advisory warning on `5_topic` pages — over budget, the deep pass rewrites the page from its cited transcripts, gated by `distill-verify` (the citation set must not shrink). |
| `LLMWIKI_OVERVIEW_BUDGET` | `8000` | Character budget for overview.md at which `overview --normalize` warns (watches for entry-point bloat). |
| `LLMWIKI_L0_BUDGET` | `1600` | Character **standard** for the cold-start L0 (current-state). Injection **never cuts**: an over-standard page is injected whole with a one-line notice appended (nudging the next close-out to trim); the `oversized-l0` lint warns from 1.25×. |

- bump each tier to whatever top-tier model just shipped, or swap in a non-Anthropic model/endpoint
- **Harness-agnostic reading**
    - `bun <clone>/src/cli.ts context <repo>` — the cold-start context · `… turn-context <repo>` (hook stdin JSON or `--prompt`) — per-turn related-page pointers (≤3 lines, silent unless confident)
    - Claude Code wires both hooks automatically; recent Codex runs the same hook scripts natively (`adapters/codex/`); OpenCode injects via a one-file plugin (`adapters/opencode/`)
    - any other harness calls the same commands from AGENTS.md or a startup prompt
    - per-turn injection is a progressive enhancement — the cold-start + `search` baseline is identical everywhere

### Index maintenance escalation (bounded, opt-in)

`/wiki-save` only calls `llmwiki db-health <repo> --notice`: it records a cooldown-governed health signal and may recommend `/wiki-deep`; it never compacts SQLite or runs semantic cleanup. `/wiki-deep` refreshes the index and lint first, compacts only after the health command marks the database eligible, then rechecks. It recommends the manual, dry-run `llmwiki wiki-clean <repo>` only when **post-compact** live indexed bytes still exceed 30 MiB. A free-ratio-only pressure resolved by compaction is reported as no cleanup action.

The defaults are intentionally conservative and currently have no environment override: compaction requires all of **30 MiB database size**, **10% free-page ratio**, and a **1 MiB free-page floor**. The notice state cools down for **7 days** (unless eligibility changes or indexed bytes grow by 10%). The reversible cleanup classifier considers eligible old pages after **180 days**; gap reporting retains the **20** most-recent resolved rows. `wiki-clean --date YYYY-MM-DD` only supplies a deterministic review date — neither `wiki-clean --commit` nor `wiki-clean-apply` is ever part of save/deep automation.

## Team use (sharing one project's wiki)

Solo is the default and needs none of this — everything below is additive and silent for a single user. With several people on one project, each runs their own local engine (own capture daemon, own queue) and condenses **their own sessions** into the shared `docs/wiki/`; sharing is plain git.

- **Scaffold safety**
    - `.gitignore` seeded — `.llmwiki/` (the derived index) never gets committed
    - `.gitattributes` seeded — `docs/wiki/log.md merge=union`, so concurrent appends merge instead of conflicting
- **Attribution**
    - authorship is derived from git history (`.mailmap`-aware); pages never stamp `author:` into frontmatter
    - a `0_review` question carries `owner: <GitHub login>` — cold-start shows it as `[→ login]`, so teammates skip questions that aren't theirs
- **Teammate citations self-heal**
    - every clean cited `.jsonl` is registered as a virtual source on index rebuild (transcripts rotate anyway)
    - a teammate's citation never breaks your `lint` gate; malformed citations still error
- **Continuity**
    - cold-start prints one line when your clone is behind origin — a teammate may have merged context; pull before starting
- **Review flow**
    - wiki commits ride the same branch and PR as code — the PR review *is* the human gate for AI-written pages
    - `gap-queue.md` / `overview.md` conflicts: take either side, re-run `llmwiki gaps` / `llmwiki overview --normalize` (they converge) — never hand-merge their generated bodies
- **Known-safe conflicts**
    - `current-state.md` (L0): either side is safe — the next `/wiki-save` re-derives Now/Next from the wiki state; prefer the union of both sides' **Next** bullets (never lose a pending action)
    - same `5_topic` page, concurrent appends: keep **both sides' bullets** — topic pages are additive by format rule (existing lines immutable, merges only add), so the union is always the correct merge

## Team conventions — `llmwiki.config.toml` (optional)

The stock category structure (`0_review · 1_direction · 2_milestone · 3_decision · 4_insight · 5_topic`) is the built-in default — **without a config file nothing changes, byte-identically** (the rendered prompts/rules are pinned to the historical text by tests). To run a different team format, copy `llmwiki.config.example.toml` to `llmwiki.config.toml` at the clone root and declare your categories:

```toml
[[category]]
dir = "1_goal"     # folder under docs/wiki
domain = "goal"    # frontmatter domain routed here
review = "human"   # human → 0_review queue · model → strong-model adjudication
guide = "Quarterly goals; changes need human sign-off."
```

- **Single source of truth**
    - the WRITE prompts, cold-start operating rules, and `llmwiki conventions <repo>` (which the `/wiki-*` skills defer to) all render from this file — no prose duplicates to drift
- **Per-repo configs** (optional)
    - multiple `*.toml` files under `<clone>/configs/` — a file with `applies_to = ["<folder>", …]` governs those folders and everything under them (segment-safe prefix, most-specific match wins, `~` expands)
    - a file without `applies_to` = the default for all repos (canonical: `configs/default.toml`)
    - precedence: named match → `configs/` default → root `llmwiki.config.toml` → built-in defaults; matching uses the path the session hook passes (`CLAUDE_PROJECT_DIR`/cwd)
- **Check** — `llmwiki config [workspace]`
    - shows which file was selected and why (with validation); an invalid or unreadable file falls back safely with a warning — never breaks a session
- **Restructure an existing wiki** — `llmwiki migrate <repo>` (dry-run) → `--commit`
    - folder renames with every wikilink/relative link rewritten, frontmatter `domain:` updated, `.schema-version` stamped
    - never runs automatically — cold-start only detects drift (both directions: wiki newer than your engine config, or config newer than the wiki) and suggests it
- **Team distribution**
    - commit the config to your team's engine fork; members `git pull`, one person runs `migrate`, the result merges by PR like any other change
- **Compatibility discipline**
    - config keys are removed only after a deprecation window with a lint warning and a `migrate` step — never silently

## Regression measurement (engine-dev tools — never part of the daily loop)

- **`llmwiki bench <repo>`** — deterministic retrieval benchmark (zero LLM, runs in ms)
    - golden query set at `<repo>/docs/wiki/.bench/golden.toml` (≤20 per repo, any language)
    - scores search any-hit `r@k` + turn-context pointer-hit/silence — a refusal query is correct when turn-context stays silent (structural, language-neutral)
    - seeded tune/sealed split — `--tune-only` to iterate freely, `--sealed` for final checks only (every look at sealed results weakens it as a regression guard)
- **`llmwiki compare-arm <repo> --corpus <dir> --label <name>`** → **`llmwiki compare-verdict A.json B.json`** — frozen-corpus A/B
    - builds an isolated temp wiki per config/git-state from the same transcript corpus — the arm build is the only LLM step
    - judges the two labeled results with sequential gates: regression-block first → keep/adopt/undecided, zero LLM
    - run only when prompts/models change

## Principles

- transcript = raw and immutable — citation only, no wiki→wiki re-derivation; incremental = only what's past the watermark
- fact = automatic by AI / judgment (decision Why·What·Alt·direction) = human — the `status: draft` flag
- git markdown = single source of truth — commits under a single author's identity (the repo owner)
- no over-engineering — under 100k tokens, no vector DB·RAG needed (index.md navigation suffices)

## License

[Apache License 2.0](LICENSE) © 2026 suwonleee.
