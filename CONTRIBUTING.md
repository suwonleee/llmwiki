# Contributing to llmwiki

Thanks for improving llmwiki. The project is local-first and deliberately conservative: Markdown
in a user's repository is durable source data, while indexes, queues, and harness wiring are
rebuildable machine state. Small, evidence-backed changes are preferred over broad rewrites.

## Start from a clean clone

Prerequisites are Git and Bun 1.1 or newer (1.2+ recommended). The engine and tests run directly
from TypeScript; there is no build step and no runtime dependency installation. Install the
development-only TypeScript tooling once, then run the quick check:

```bash
git clone https://github.com/suwonleee/llmwiki.git
cd llmwiki
bun install
bun run check:quick
```

You do not need to run `setup.sh` to develop the engine. Setup changes user-level hooks and services;
use its isolated E2E tests unless your change specifically requires a reviewed live-install check.

## Find the right change boundary

Read [ARCHITECTURE.md](ARCHITECTURE.md) before moving code or adding a command. Its module map shows
the capture, write, index, and injection paths and identifies the files that own safety boundaries.

- New or changed CLI command: update `src/commands/catalog.ts`, its handler, the flag declarations
  in `src/cli-args.ts`, and focused CLI tests.
- Repository content: read and write only through `src/engine/repo-write.ts`; never follow a
  repository symlink or construct an unchecked path around that boundary.
- Machine-local state: keep it under the owned state root and preserve marker, permission, and
  no-follow checks.
- Harness integration: preserve unenrolled-project silence and treat harness transcript stores as
  read-only inputs.
- Skills: `skill/*.md` is the source; `skills/*/SKILL.md` is generated. After editing a source, run
  `bun src/plugin/build-assets.ts` and commit both the source and deterministic output.
- Dependencies: prefer Bun and existing utilities. Do not add a runtime dependency without an
  explicit, reviewed need.

## Run the checks

Use one entry point instead of reconstructing the repository's gates from memory:

```bash
bun run check:quick   # typecheck, focused contracts, shell syntax, publish boundary, diff check
bun run check         # the same boundaries with the complete test suite
```

Run `check:quick` while iterating and `check` before requesting review. The full public release
claims and their exact evidence are defined in
[reference/RELEASE_GATES.md](reference/RELEASE_GATES.md). A failed expected artifact is evidence to
investigate, not a reason to rewrite the expected result.

## Keep changes reviewable

- Add or update a regression test before fixing a bug.
- Preserve existing output and exit codes unless the change intentionally updates the public CLI
  contract.
- Keep generated files, source files, and documentation in the same commit when they form one
  contract.
- Avoid unrelated cleanup. Separate independently reversible behavior changes into separate
  commits.
- Never commit transcripts, credentials, local state, `docs/wiki/`, or private evaluation output.

For security reports and user support, follow [SUPPORT.md](SUPPORT.md). Do not put sensitive
installation details or private transcript excerpts in a public issue.
