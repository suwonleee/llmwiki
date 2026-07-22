<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
    <img src="assets/banner.png" alt="Quiz_wiki" width="100%">
  </picture>
</p>

# llmwiki · Quiz_wiki — a local-first compounding engineering logbook + topic encyclopedia that quizzes you back

*Also known as: quiz wiki · llmwiki quiz · Quiz_wiki — the spaced-repetition layer that quizzes you on your own past decisions.*

**English** · [한국어](README.ko.md)

> Whatever the project, whatever terminal (default/tmux/iTerm2) or coding agent (Claude Code · Codex · OpenCode) you use,
> project-specific LLM knowledge **compounds**.
> An LLM-maintained project wiki for agentic environments —
> it sources from work transcripts and splits labor into **fact = unattended / judgment = human-present**.
> And the loop closes on the human too — a daily forgetting-curve quiz (`/wiki-quiz`) keeps your memory of your own decisions as sharp as the model's context.
> The structure is **two layers** — a per-session *logbook* (time axis: `2_milestone`·`3_decision`·`4_insight`) + a per-concept *topic encyclopedia* (`5_topic`, topic axis·in-place consolidation). Both are re-derived only from raw transcripts (no wiki→wiki).

The engine is a **local library** — SQLite index·deterministic lint·citation/cross-reference graph·content-hash
increments — with **an automatic capture daemon + transcript compounding + labor split (fact = AI / judgment = human) + a human-side memory quiz (`/wiki-quiz`)** on top. **No MCP registration required.**

The core idea — a project wiki that the LLM maintains and the human only steers — comes from [Andrej Karpathy's LLM-wiki note](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). That note is the only outside reference: the design and code here are original.

## Codex quick start (5 minutes)

```bash
git clone https://github.com/suwonleee/llmwiki-runtime.git llmwiki_runtime
cd llmwiki_runtime
./setup.sh --harness codex
export PATH="$HOME/.local/bin:$PATH"  # setup prints this only when your PATH needs it

# One-time activation: start Codex in any project, open /hooks, and trust both llmwiki hooks.
cd /path/to/your-project
llmwiki init .
codex
```

Inside Codex, type **`$wiki-fast`** after a meaningful work session. Use
`$wiki-deep` periodically, `$wiki-ask` to query/file back, and `$wiki-quiz`
for recall. `setup.sh` installs these as Codex skills under `~/.agents/skills`, merges
the native hooks without replacing unrelated hooks, and installs `llmwiki` in
`~/.local/bin`. If that directory is not on `PATH`, setup prints the exact fix.
Re-running setup safely migrates earlier `$llmwiki-*` installs to the shorter `$wiki-*` names.

Verify with `llmwiki doctor`. Before hook review it reports **one-time action required**;
it does not claim that injection is already active. Codex owns the current hook-trust
verdict, so `/hooks` is the source of truth after hook changes.

## OpenCode quick start (5 minutes)

```bash
git clone https://github.com/suwonleee/llmwiki-runtime.git llmwiki_runtime
cd llmwiki_runtime
./setup.sh --harness opencode

cd /path/to/your-project
llmwiki init .
opencode
```

OpenCode uses the same **`/wiki-fast`**, `/wiki-deep`, `/wiki-ask`, and `/wiki-quiz`
syntax as Claude Code. Setup installs global custom commands and the read-injection
plugin under `$XDG_CONFIG_HOME/opencode/` (default `~/.config/opencode/`).

## The Compounding Loop

| Stage | What | Automatic? | Implementation |
|------|------|:---:|------|
| **Capture** | Every session transcript → central queue | ✔ | `src/daemon/watch.ts` (terminal/profile-agnostic) |
| **Condense (update)** | Queue → that repo's `docs/wiki/` **log layer** (incremental append) | 1 command | Codex: `$wiki-fast` / `$wiki-deep` · Claude/OpenCode: `/wiki-fast` / `/wiki-deep` + `src/engine/update.ts` |
| **Consolidate** | Log → per-concept **topic encyclopedia** `5_topic/` (in-place merge·raw re-grounding) | 1 command | Codex: `$wiki-fast` / `$wiki-deep` · Claude/OpenCode: `/wiki-fast` / `/wiki-deep` + `src/engine/consolidate.ts` |
| **Read** | Cold-start injection + per-turn related-page pointers | ✔ | `hooks/sessionstart-inject.sh` · `hooks/userpromptsubmit-inject.sh` (Claude Code; Codex/OpenCode → `adapters/`) |
| **Quiz (human memory)** | Wiki's judgment layer → day-granular spaced-repetition quiz **for the human** (`6_quiz/` records — never indexed/searched; cold-start shows a due-count line) | 1 command | Codex: `$wiki-quiz` · Claude/OpenCode: `/wiki-quiz` + `src/engine/quiz.ts` (`quiz-status`·`quiz-next`·`quiz-record`) |
| **Self-healing** | Structural (orphan·stale·dangling) = deterministic `lint` / semantic (contradiction·stale claim·missing concept) = generative `review` (auto on sync — engine-gated cadence `--if-due`, default 7d·scoped+cached) → gaps land in `gaps`'s self-closing queue (`0_review/gap-queue.md`) | 1 command → auto | `lint`·`review`·`gaps` (`src/engine/{lint,review,gaps}.ts`) |

### The human memory loop (`/wiki-quiz`)
Every other stage keeps the **model** grounded; this one keeps the **human** sharp. The labor split leaves exactly one non-delegable duty — direction + contradiction judgment — and that judgment decays with the human's memory of their own past decisions. `/wiki-quiz` runs a few minutes of active recall over the wiki's judgment layer (direction > decision > insight·topic > milestone, newest first): the engine schedules deterministically on a day-granular forgetting curve (boxes 1·3·7·16·35·60 days; wrong/skip → back to 1 day; an item is never asked twice in one day), the session authors and gist-grades the questions warm, grounded in the pages. Wrong answers come back first the next day. Records live in `docs/wiki/6_quiz/` (ledger + per-day session notes) — a **human-only layer excluded from indexing/search/cold-start**, so the LLM never feeds on its own quiz output: strictly one-directional, wiki → human.

A quiz session is **pre-authored in one batch**: the engine picks the due items, the session reads those pages together and writes every question up front, so answering one question shows the next immediately — no per-question wait. Session size is `[quiz] questions` in `llmwiki.config.toml` (default **3**, raise it with an argument like `/wiki-quiz 5`, capped at **7** by the engine — a quiz people skip reinforces nothing).

### Evidence that travels with the page (page format v3)
A citation like `[^s1]: <session>.jsonl` points at a transcript that lives on **one machine** — so a teammate can read your conclusion but not the grounding behind it. v3 puts 1–2 lines of the evidence itself on an indented continuation line under the footnote:

```markdown
- We kept the log layer and added the topic layer on top of it [^s1]

[^s1]: 3bd9cac5-….jsonl
    > [2026-06-29 14:02 user] "keep the log as-is and layer on top — replacing it is the risky part"
```

The footnote definition line stays byte-identical to before (four parsers read it, and one of them is what keeps a teammate's citation from erroring). Excerpts come from `llmwiki excerpt` — **verbatim, length-capped, and secret-screened**, because the raw material is a session transcript and those routinely contain credentials. Judgment claims quote the human; factual claims carry a machine tool-record. Lint verifies a quote really appears in the transcript **where that transcript is readable**, and stays silent on a clone where it isn't — "can't check" must never read as "wrong". Excerpts are excluded from the search index and from the topic-page budget, so adding evidence costs neither retrieval quality nor prose room.

### Self-healing flow (the human only fills in)
At close-out (`/wiki-fast`) and on the deep pass (`/wiki-deep`): ① deterministic `lint` (structure) → ② generative `review` (semantics — auto-run via `--if-due`, but the **engine enforces the cadence** (default 7 days, `LLMWIKI_REVIEW_INTERVAL_DAYS`); input is scoped to recent+tag-neighbor pages and skipped if nothing changed; the deep pass runs it unconditionally) → ③ the *missing concepts·follow-up questions* `review` surfaces get stacked by `gaps` into a **tracking queue**. A gap gets filled once someone **works that topic once, or the `/wiki-deep` deep pass fills it**, and **auto-closes** from the queue if `review` fails to surface it twice in a row. In other words, the wiki tells you *what's missing* on its own — the human only supplies the judgment to fill it in. Gaps are deliberately **not auto-generated** — so pages don't get invented from thin evidence.

## Structure

```
setup.sh       one-click onboarding (path-agnostic: doctor→daemon→hooks·commands→index)
src/           TypeScript engine (Bun runtime, bun:sqlite built in — zero node_modules·build)
  cli.ts       CLI dispatcher: init·index·reindex·refs·lint·search·update-*·skeleton·autoupdate·consolidate·topics·ingest·register-transcript·review·gaps·distill-verify·git-rules·overview·reconcile·doctor·context·digest·context-audit·config·conventions·migrate·quiz-*·bench·compare-arm·compare-verdict
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
skill/         wiki-fast(fast session close-out)·wiki-deep(periodic deep pass)·wiki-ask·wiki-quiz(human memory) (/commands)
examples/      sample-wiki/ — a finished wiki example (read-only illustration). Not indexed by the engine (IGNORE_DIRS). **Do not copy** — real wikis are auto-generated under each project's docs/wiki. See examples/README.md
tests/         bun:test suite (chunker·refs·lint·extract·capture·db·source·review-scope·overview·gaps·quiz·migrations) — `bun test`
package.json·tsconfig.json   Bun metadata (for typecheck; the runtime executes .ts directly)
```

Storage principle: **capture queue = central (`<clone>/.state/capture.db`) / content = each repo's `docs/wiki/` (co-located, markdown = source of truth) / index = `<repo>/.llmwiki/index.db` (regenerable)**.

## Prerequisites

| | Required | Notes |
|---|---|---|
| **Bun ≥ 1.1** | ✔ required | Single binary (`curl -fsSL https://bun.sh/install \| bash`). Runs `.ts` directly, and `bun:sqlite` bundles FTS5 — zero build·`node_modules`. Running the engine and `bun test` work with no install; only `bun run typecheck` (tsc) needs a one-time `bun install` (dev-only). |
| **Codex CLI** | ✔ for the Codex quick start | `codex` must be on `PATH` with lifecycle-hook support and the stable `hooks` feature enabled. Setup checks support—and an existing feature setting—before changing hooks, skills, or services. |
| **LLM CLI** | only for the generative pass | Capture·read-injection·`/wiki-*`·`ingest` (capture-only, queues pending updates) work without it. `autoupdate·review` and `ingest`'s consolidation call an LLM CLI, so they need one — default `claude -p` ([install](https://docs.claude.com/en/docs/claude-code/setup)), or point `LLMWIKI_LLM_CMD` at a different CLI/provider. |
| **OS** | macOS / Linux | macOS=launchd, Linux=systemd (`--user`), falls back to cron+nohup if systemd is unavailable. Daemon details in [`daemon/README.md`](daemon/README.md) |

### Harness·OS notes (Claude Code / Codex / Windows)

- **Claude Code**: `git clone … && ./setup.sh` → done. Capture·read-injection·`/wiki-*` are all wired automatically.
- **Codex (OpenAI)**: `./setup.sh --harness codex` installs the user CLI, four `$wiki-*` skills, and merges native `SessionStart`/`UserPromptSubmit` hooks into `$CODEX_HOME/hooks.json`. Start Codex once and use `/hooks` to review the exact commands; new or changed hooks stay skipped until trusted. Capture watches `$CODEX_HOME/sessions/**/*.jsonl[.zst]`. Warm skills work with Codex itself; unattended `autoupdate`/`review` still need `LLMWIKI_LLM_CMD` when Claude CLI is absent.
- **OpenCode**: `./setup.sh --harness opencode` installs global `/wiki-*` custom commands, a clone-pinned read-injection plugin, and the user CLI. Capture reads the SQLite session store; setup preserves `XDG_DATA_HOME`/`OPENCODE_DB` in the daemon environment.
- **Windows**: Bun·`bun:sqlite` run natively and path matching normalizes backslashes. But native Windows needs (a) **Git Bash** for the `.sh` scripts, and (b) manual **Task Scheduler/NSSM** registration since there's no launchd/systemd/cron for the daemon. → **WSL2 is recommended** (launchd→systemd·bash·paths all work unmodified; this also matches the official Claude Code·Codex recommendation).

## Install / Usage

**Clone this repo anywhere, under any name, and run `./setup.sh`** — that makes it the engine for that machine. Re-run setup after moving or updating the clone; it refreshes generated skills and wiring idempotently.
All wiring (daemon·hooks·CLI·`/wiki-*` commands) is **derived from the clone location itself**, so there's no need
for a fixed path like `~/llmwiki` (the clone folder can have any name). With just Bun, `.ts` runs as-is via `bun` with no extra dependencies (no bundle·build step).

```bash
# 0) clone the runtime engine (once, one per machine) — location/name doesn't matter
git clone https://github.com/suwonleee/llmwiki-runtime.git llmwiki_runtime
cd llmwiki_runtime

# 1) one-shot install — doctor → capture daemon (OS auto-detect) → Codex hooks + skills + CLI → doctor
./setup.sh --harness codex               # use --harness auto when Claude Code is also installed
# OpenCode only: ./setup.sh --harness opencode

# 2) just work — sessions are captured automatically in any folder/terminal
#    to use it manually in another project, from that folder:
#    bun <clone>/src/cli.ts init|index|search|lint <repo>

# 3) in Codex, close out/tidy up the session (type these in the Codex prompt)
$wiki-fast                              # FAST close-out: this meaningful session + topics + L0 + lint
$wiki-deep                              # periodic DEEP pass: backlog + review + gaps + re-distill
$wiki-quiz                              # human memory loop over your own decisions/direction
```

> To run individual steps: `bun <clone>/src/cli.ts doctor` · `bash <clone>/daemon/install.sh` ·
> `bun <clone>/src/daemon/wire-codex.ts`. To revert Codex wiring:
> `bun <clone>/src/daemon/wire-codex.ts --revert`. Claude Code uses `wire.ts` separately.

## Configuration (environment variables) — provider·model·CLI agnostic

The generative pass (autoupdate/review) uses `claude -p` + the latest Claude model by default, but everything can be swapped via env vars (with no configuration at all, behavior is identical to the stock defaults):

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
| `LLMWIKI_REVIEW_INTERVAL_DAYS` | `7` | Cadence gate for `review --if-due` — it runs only when this many days have passed since the last committed review (before that it skips deterministically in ~0.03s). Makes the fast close-out's review cost zero by default. |
| `LLMWIKI_TOPIC_BUDGET` | `10000` | Character budget for the `topic-oversize` advisory warning on `5_topic` pages — over budget, the deep pass rewrites the page from its cited transcripts, gated by `distill-verify` (the citation set must not shrink). |
| `LLMWIKI_OVERVIEW_BUDGET` | `8000` | Character budget for overview.md at which `overview --normalize` warns (watches for entry-point bloat). |
| `LLMWIKI_L0_BUDGET` | `1600` | Character **standard** for the cold-start L0 (current-state). Injection **never cuts**: an over-standard page is injected whole with a one-line notice appended (nudging the next close-out to trim); the `oversized-l0` lint warns from 1.25×. |

Bump each tier to "whatever top-tier model just shipped," or swap in a non-Anthropic model/endpoint.

**Harness-agnostic reading**: `bun <clone>/src/cli.ts context <repo>` prints the cold-start context, and `... turn-context <repo>` (hook stdin JSON or `--prompt`) prints per-turn related-page pointers (≤3 lines, silent unless confident). Claude Code wires both automatically (SessionStart·UserPromptSubmit hooks); recent Codex can run the same hook scripts natively (`adapters/codex/`), OpenCode via a one-file plugin (`adapters/opencode/`). Other harnesses invoke the same commands from AGENTS.md/a startup prompt. Per-turn injection is a progressive enhancement — the cold-start + `search` baseline is identical everywhere.

## Team use (sharing one project's wiki)

Solo is the default and needs none of this — everything below is additive and silent for a single user.

When several people work on one project, each person runs their own local engine (own capture daemon, own queue) and condenses **their own sessions** into the shared `docs/wiki/`; sharing is plain git. What the engine does for you:

- **Scaffold safety**: the skeleton ensures `.gitignore` (`.llmwiki/` — the derived index is never committed) and `.gitattributes` (`docs/wiki/log.md merge=union` — concurrent appends merge cleanly instead of conflicting).
- **Attribution**: unattended writes stamp `author:` (from git `user.name`) into page frontmatter; a `0_review` question can carry `owner: <name>` and cold-start shows it as `[→ name]` so teammates skip questions that aren't theirs.
- **Teammate citations**: a footnote citing a transcript from another machine self-heals — every clean cited `.jsonl` is registered as a virtual source on index rebuild (transcripts rotate anyway), so a teammate's citation never breaks your `lint` gate. Malformed citations still error.
- **Continuity**: cold-start prints one line when your clone is behind origin (a teammate may have merged context — pull before starting).
- **Review flow**: treat wiki commits like code — same branch, same PR; the PR review *is* the human gate for AI-written pages. If `gap-queue.md`/`overview.md` ever conflict, take either side and re-run `llmwiki gaps` / `llmwiki overview --normalize` (they converge); never hand-merge their generated bodies.
- **`current-state.md` (L0) conflicts**: taking either side is safe — the next `/wiki-fast` freshness step re-derives Now/Next from the wiki state and converges. Prefer the union of both sides' **Next** bullets (never lose a pending action).
- **Same `5_topic` page, concurrent appends**: keep **both sides' bullets**. Topic pages are additive by format rule (existing lines are immutable; merges only add), so the union is always the correct merge.

## Team conventions — `llmwiki.config.toml` (optional)

The stock category structure (`0_review · 1_direction · 2_milestone · 3_decision · 4_insight · 5_topic`) is the built-in default — **without a config file nothing changes, byte-identically** (the rendered prompts/rules are pinned to the historical text by tests). To run a different team format, copy `llmwiki.config.example.toml` to `llmwiki.config.toml` at the clone root and declare your categories:

```toml
[[category]]
dir = "1_goal"     # folder under docs/wiki
domain = "goal"    # frontmatter domain routed here
review = "human"   # human → 0_review queue · model → strong-model adjudication
guide = "Quarterly goals; changes need human sign-off."
```

- **Single source of truth**: the WRITE prompts, cold-start operating rules, and `llmwiki conventions <repo>` (which the `/wiki-*` skills defer to) are all rendered from this file — no prose duplicates to drift.
- **Per-repo configs** (optional): put multiple `*.toml` files under `<clone>/configs/`. A file with a top-level `applies_to = ["<folder>", ...]` governs those folders and everything under them (segment-safe prefix, most-specific match wins, `~` expands); a file without `applies_to` is the default for all repos (canonical: `configs/default.toml`). Precedence: named match → `configs/` default → root `llmwiki.config.toml` → built-in defaults. Matching uses the path the session hook passes (`CLAUDE_PROJECT_DIR`/cwd).
- **Check** with `llmwiki config [workspace]` — shows which file was selected and why (validates; an invalid or unreadable file falls back safely with a warning, never breaks a session).
- **Restructure an existing wiki** with `llmwiki migrate <repo>` (dry-run) → `--commit`: folder renames with every wikilink/relative link rewritten, frontmatter `domain:` updated, `.schema-version` stamped. Never runs automatically — cold-start only *detects* drift (both directions: wiki newer than your engine config, or config newer than the wiki) and suggests it.
- **Team distribution**: commit the config to your team's engine fork; members `git pull`, one person runs `migrate`, the result merges by PR like any other change.
- **Compatibility discipline**: config keys are only removed after a deprecation window with a lint warning and a `migrate` step — never silently.

## Regression measurement (engine-dev tools — never part of the daily loop)

- **`llmwiki bench <repo>`** — deterministic retrieval benchmark (zero LLM, runs in ms). Golden query set at `<repo>/docs/wiki/.bench/golden.toml` (≤20 per repo, any language) → search any-hit `r@k` + turn-context pointer-hit/silence (a refusal query is correct when turn-context stays silent — structural, language-neutral). Seeded tune/sealed split via `--tune-only` / `--sealed` (tune = iterate freely; every look at sealed results weakens it as a regression guard — final checks only).
- **`llmwiki compare-arm <repo> --corpus <dir> --label <name>`** → **`llmwiki compare-verdict A.json B.json`** — frozen-corpus A/B: build an isolated temp wiki per config/git-state from the same transcript corpus (the arm build is the only LLM step), then judge the two labeled results with sequential gates (regression-block first → keep/adopt/undecided, zero LLM). Run only when prompts/models change.

## Principles
- transcript = raw and immutable (citation only, no wiki→wiki re-derivation). Incremental = process only what's past the watermark.
- fact = automatic by AI / judgment (decision Why·What·Alt·direction) = human (`status: draft` flag).
- git markdown = single source of truth. Commits = under a single author's identity (the repo owner).
- No over-engineering: under 100k tokens, no vector DB·RAG needed (index.md navigation suffices).

## License
[Apache License 2.0](LICENSE) © 2026 suwonleee.
