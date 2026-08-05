# Plugin directory submission notes

This file records the reviewer-facing cases for the skills-only llmwiki plugin. The plugin has no
MCP server, hosted service, authentication flow, or external data transfer.

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

Initial public directory submission of llmwiki 0.11.1. The plugin packages five local-first wiki
skills and two opt-in lifecycle hooks. Version 0.11.1 removes a duplicate Claude hook declaration
for current host compatibility and adds the public-directory metadata, branding, and policy pages.
