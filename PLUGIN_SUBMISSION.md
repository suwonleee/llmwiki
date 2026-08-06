# Plugin directory submission notes

This file records the reviewer-facing cases for the skills-only llmwiki plugin. The plugin has no
MCP server, hosted service, authentication flow, or external data transfer.

For *which* host takes a submission at all, and what has to be green before each one, start at
[`adapters/DISTRIBUTION.md`](adapters/DISTRIBUTION.md) — it covers Claude Code, Codex, Orca, Hermes
and OpenClaw. This file holds the field values the two real submission forms ask for.

## Positive cases

### Positive 1 — enroll a repository

- Prompt: "Set up llmwiki in this repository and explain what will be stored."
- Expected behavior: `wiki-doctor` explains the consent boundary, initializes only after the user
  request, and reports the repository as enrolled.
- Expected result: a concise setup summary naming `docs/wiki` and the local derived-state path.
- Fixture: a temporary Git repository with Bun on `PATH`.

### Positive 2 — cold-start context

- Prompt: start a new session inside an enrolled repository with `docs/wiki/current-state.md`.
- Expected behavior: the SessionStart hook injects current state and a short wiki index once.
- Expected result: project context appears; no file is modified.
- Fixture: an enrolled repository with a small valid wiki.

### Positive 3 — relevant turn pointer

- Prompt: "What did we decide about cross-platform validation?"
- Expected behavior: the UserPromptSubmit hook emits up to three title-to-path pointers when the
  local index has a confident lexical match.
- Expected result: pointers only, with no transcript content and no network request.
- Fixture: an enrolled wiki containing a matching cross-platform validation page.

### Positive 4 — session close-out

- Prompt: "Save this session into the project wiki."
- Expected behavior: `wiki-save` identifies the current harness session, summarizes durable facts,
  updates the wiki and log, then runs wiki lint.
- Expected result: grounded Markdown under `docs/wiki` plus a validation summary.
- Fixture: an enrolled temporary repository and a short local test transcript without secrets.

### Positive 5 — decision quiz

- Prompt: "Quiz me on recent project decisions."
- Expected behavior: `wiki-quiz` selects due decision/direction material, asks a small quiz, grades
  the response, and records quiz state outside indexed wiki content.
- Expected result: a grounded question and feedback linked to the source wiki page.
- Fixture: an enrolled wiki with at least one decision page eligible for review.

## Negative cases

### Negative 1 — unenrolled repository

- Scenario: start a session or submit prompts in a repository that was never initialized.
- Expected behavior: both automatic hooks emit zero bytes and write nothing.
- Why: installation alone is not consent to inspect or modify a repository.

### Negative 2 — missing Bun

- Scenario: start a session with the plugin installed but Bun absent from `PATH`.
- Expected behavior: SessionStart prints one prerequisite notice; prompt hooks remain silent and
  the host session continues normally.
- Why: the plugin must fail open without blocking Claude Code or Codex.

### Negative 3 — secret-bearing source text

- Scenario: a requested excerpt contains a credential-shaped value.
- Expected behavior: lint/screening rejects or redacts the secret-bearing excerpt instead of
  writing it into durable wiki Markdown.
- Why: durable recall must not turn a transient credential into committed project content.

## Release notes

Initial public directory submission of llmwiki 0.11.2. The plugin packages five local-first wiki
skills and two opt-in lifecycle hooks. Version 0.11.2 makes the manifests match both directories'
ingestion schemas: the Codex manifest no longer declares a `hooks` path (the field the public
ingestion schema rejects — hooks now load from the default `hooks/hooks.json` both harnesses
discover), the listing icon ships as a 512×512 PNG, and the earlier 0.11.1 work — one hook
declaration per host, directory metadata, branding, and the policy pages — is carried forward.

## Submission packet — the values each form asks for

Both directories take submissions through an authenticated web form, so filing is a human step.
These are the answers to paste; everything they reference is in this repository at the submitted
commit.

| Field | Value |
|---|---|
| Plugin name (immutable slug) | `llmwiki` |
| Version | 0.11.2 |
| Repository | https://github.com/suwonleee/llmwiki |
| Plugin root inside the repository | the repository root (`.claude-plugin/plugin.json` at top level) |
| Display name / short description | llmwiki — "A wiki that compounds" |
| Category | Developer Tools (Codex) · productivity (Claude marketplace entry) |
| Author / developer | suwonleee, https://github.com/suwonleee |
| License | Apache-2.0 |
| Website | https://github.com/suwonleee/llmwiki |
| Support | https://github.com/suwonleee/llmwiki/issues (see SUPPORT.md) |
| Privacy policy | https://github.com/suwonleee/llmwiki/blob/main/PRIVACY.md |
| Terms of service | https://github.com/suwonleee/llmwiki/blob/main/TERMS.md |
| Data/permission disclosure | https://github.com/suwonleee/llmwiki/blob/main/PLUGIN.md |
| Logo / composer icon | `assets/llmwiki-plugin.png` (512×512) |
| Brand color | `#111827` |
| Starter prompts | the three `interface.defaultPrompt` entries in `.codex-plugin/plugin.json` |
| Test cases | the five positive and three negative cases above |
| MCP server | none — this plugin ships skills and two hooks only |
| Authentication / demo credentials | none — no account, no hosted service, no network calls |

**Claude Code (community marketplace).** Form: `platform.claude.com/plugins/submit` for an
individual author, or `claude.ai/admin-settings/directory/submissions/plugins/new` from a Team or
Enterprise organization with directory-management access. The review pipeline runs
`claude plugin validate` plus automated safety screening; run it locally first:

```
claude plugin validate . --strict
```

Approved plugins are pinned to a commit SHA in `anthropics/claude-plugins-community` and the public
catalog syncs nightly, so listing lags approval. The separately curated
`claude-plugins-official` marketplace has no application process.

**Codex / ChatGPT (universal plugin directory).** Portal: `platform.openai.com/plugins`. It
requires completed identity verification in the submitting organization and Apps Management write
access. One submission lists the plugin on both surfaces. Approval does not auto-publish; the
author publishes from the portal. Preflight with the ingestion validator from
`openai/codex` (`codex-rs/skills/src/assets/samples/plugin-creator/scripts/validate_plugin.py`):

```
python3 validate_plugin.py .
```
