# Evaluation and release gates

This file defines what the completed G001–G004 work can prove before release and what remains
deferred. Run it against one frozen commit. A green automated gate supports only the claim in its
row; it does not substitute for observed-user evidence.

| gate ID | disposition | claim permitted by fresh evidence |
|---|---|---|
| `support-contract` | `automated-pass-required` | The documented OS × harness install, verify, init, surfaces, and manual actions match the public contract and setup wiring. |
| `full-loop-oracle` | `automated-pass-required` | A pinned local release exercises installed Claude hooks, Codex hooks, and OpenCode plugin callbacks through enrollment, capture, and exact-session close-out selection; the seeded deterministic tail proves restart retrieval without host-private leakage. The generative middle is not claimed by this oracle. |
| `retrieval-baseline` | `automated-pass-required` | The tracked correctness-only retrieval fixture matches its frozen expected result. |
| `retrieval-scale` | `automated-pass-required` | Generated 10/100/1000-page fixtures retain complete search/context correctness. Timing/resource distributions are observational, not release thresholds. |
| `privacy-boundary` | `automated-pass-required` | Static write boundaries, provider opt-in, public-artifact poison scans, and usability-event privacy validation pass. |
| `docs-semantics` | `automated-pass-required` | All public onboarding languages preserve enrollment, commands, native-Windows/WSL distinctions, activation actions, and privacy semantics. |
| `external-usability` | `external-evidence-required` | Deferred: no participant results exist. No onboarding-arm winner or information-architecture change may be claimed. |

## Reproducible release checklist

Record the commit SHA, Bun version, OS, and command output locally. Any failure blocks release until
fixed or explicitly removed from scope in a reviewed follow-up; never rewrite the expected artifact
to make an unexplained regression green.

1. Support contract and harness onboarding

   `bun test tests/support-contract.test.ts tests/setup-claude-e2e.test.ts tests/setup-codex-e2e.test.ts tests/setup-opencode-e2e.test.ts`

2. Privacy-safe pinned full-loop oracle

   `bun test tests/fresh-public-loop.test.ts tests/fresh-public-harness-loop.test.ts`

   This is a deterministic automation oracle. It deliberately seeds the close-out artifact and is
   not evidence that an LLM authored a good page or that a person understood the workflow.

3. Retrieval correctness baseline and generated scale

   `bun test tests/bench.test.ts tests/bench-baseline.test.ts tests/bench-scale.test.ts`

   When prompts, models, or consolidation rules change, also run the frozen-corpus comparison and
   retain its artifacts locally:

   `bun test tests/compare.test.ts tests/compare-cli.test.ts`

4. Privacy and local-write scan

   `bun test tests/repo-io-static-boundary.test.ts tests/provider-transfer.test.ts tests/plugin-assets.test.ts tests/usability-study-protocol.test.ts tests/usability-study-validator.test.ts`

   Run the real publish preflight against this release tree, then verify the tracked release boundary:

   `bun src/plugin/preflight.ts`

   `bun test tests/release-boundary.test.ts`

5. Public documentation semantics

   `bun test tests/onboarding-docs.test.ts tests/support-contract.test.ts`

6. Repository-wide regression checks

   `bun test`

   `bun run typecheck`

   `git diff --check`

7. External observed-user gate

   Status for this release artifact: `deferred-no-results`. Do not collect or upload data as part of
   the release command loop. If a separately approved local study is later run, freeze the protocol
   manifest and validate each local event file first:

   `bun src/engine/usability-study-validate.ts <local-events.jsonl>`

   Apply the preregistered thresholds in [`USABILITY_STUDY.md`](USABILITY_STUDY.md): five-user pilot
   per harness/stratum, at least 15 valid completed comparative runs per arm/cell, ≥80% unaided full
   loop, median first value ≤20 minutes, nearest-rank p90 ≤30 minutes excluding prerequisites,
   median wrong-command count ≤1, and ≥80% correctness for every comprehension item. Until valid
   aggregate results clear those gates, retain the current IA and report onboarding alternatives
   descriptively—never as a winner.

## Release decision boundary

Safe completed improvements are the support contract/docs reconciliation, deterministic full-loop
oracle, retrieval correctness/scale fixtures, privacy-safe study tooling, and their regression tests.
Deferred decisions are onboarding-arm preference, IA hierarchy/order/removal, model-authored page
quality, and observed native-platform usability. No external results means no winner claim and no IA
restructure; defer rather than infer.
