# llmwiki architecture

llmwiki is a local TypeScript engine, not a server. Harness transcripts remain in their original
stores, project knowledge lives as Git Markdown, and SQLite is rebuildable derived state.

## Data flow

```text
Claude / Codex / OpenCode transcript stores (read-only)
                    │
                    ▼
      src/engine/sources/* + src/daemon/watch.ts
                    │
                    ▼
       owned machine state: capture queue + indexes
                    │
          warm close-out command / skill
                    ▼
       src/engine/repo-write.ts safety boundary
                    │
                    ▼
          <project>/docs/wiki/*.md (source of truth)
                    │
          index / search / context assembly
                    ▼
       SessionStart context + per-turn page pointers
```

Enrollment under the worktree's `.git/llmwiki/` directory gates both automatic reads and capture.
A clone containing `docs/wiki/` is inert until `llmwiki init` succeeds.

## Module map

| Area | Owner | Contract |
|---|---|---|
| CLI discovery and parsing | `src/commands/catalog.ts`, `src/cli-args.ts` | Every registered command has side-effect-free help; unknown flags fail before dispatch. |
| CLI dispatch | `src/cli.ts`, `src/commands/maintenance.ts` | Handlers preserve documented output, exit codes, enrollment, and dry-run defaults. |
| Repository I/O | `src/engine/repo-write.ts` | Canonical containment, ancestor and leaf symlink refusal, atomic writes. |
| Durable project content | `<project>/docs/wiki/` | Plain Git Markdown is the source of truth. |
| Derived project state | `src/engine/project-state.ts`, `src/engine/db.ts` | Machine-local indexes can be rebuilt; worktrees never share an index. |
| Capture ledger | `src/engine/capture.ts`, `src/daemon/watch.ts` | Records routing and watermarks without owning harness transcripts. |
| Harness readers | `src/engine/sources/` | Read external stores defensively and never write into them. |
| Read injection | `src/engine/context.ts`, `src/engine/turncontext.ts` | Unenrolled or irrelevant sessions are silent. |
| Installation wiring | `src/daemon/wire*.ts`, `setup.sh`, `daemon/` | Merge only owned surfaces and preserve unrelated user configuration. |
| Skill distribution | `skill/`, `src/plugin/build-assets.ts`, `skills/` | One source renders deterministic Claude/Codex plugin assets. |
| Public boundary | `src/plugin/preflight.ts`, `tests/release-boundary.test.ts` | Private runtime material and unreviewed reference files never ship. |

## Change recipes

### Add a CLI command

1. Add its usage, summary, and group to `src/commands/catalog.ts`.
2. Implement or register the handler in `src/cli.ts` or a focused `src/commands/` module.
3. Declare every value or boolean flag in `src/cli-args.ts`.
4. Add behavior tests. The CLI drift tests verify that handler, catalog, and flag surfaces remain
   synchronized.

### Change repository content

Use the helpers in `src/engine/repo-write.ts`. Direct filesystem access under a project must not be
added to an engine module; the static I/O-boundary tests require every exceptional machine-local
reader or writer to be named and justified.

### Change a skill or harness

Edit the canonical `skill/*.md` source and rebuild generated plugin assets. Harness changes must
retain three invariants: no enrollment means zero output, hook failures never break a user session,
and external transcript stores remain read-only.

### Change release behavior

Update the machine-readable support contract and the matching docs/tests together. Automated gates
prove only their declared claim; observed-user usability and untested native platforms remain
explicitly deferred rather than inferred.
