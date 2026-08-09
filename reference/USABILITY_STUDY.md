# Local-first observed-user usability study protocol

Protocol version: 1. This is a study plan and recording format, not collected participant data.
Do not commit study manifests, event logs, recordings, notes, or identity keys to this repository.

## Question and scope

Can a person go from a named llmwiki clone through verified installation, deterministic close-out,
and seeded-decision retrieval in a new clean session using one documented onboarding path, without
an unsafe facilitator intervention? Study only the frozen
synthetic fixture repository. The engine clone is the absolute path recorded in the local run
manifest; do not substitute another clone after the session starts.

Treat `windows-native` and `windows-wsl2` as different targets. Native Windows runs setup in Git
Bash and uses the per-user Startup folder; WSL2 uses its Linux shell and systemd or cron/nohup.
Never pool their results into one “Windows” row.

## Freeze before recruitment

Copy [`usability-study-run.template.json`](usability-study-run.template.json) outside the clone and
replace every placeholder. Freeze and hash all of these before the pilot:

- llmwiki release/tag, commit, and absolute clone path
- platform target and OS version; Git Bash version for native Windows, or WSL distribution/version
- harness name/version and the selected model identifier plus settings digest
- synthetic fixture commit/content digest and the path/version/digest of the meaningful frozen
  [`usability-study-task.md`](usability-study-task.md)
- the synthetic decision/rationale answer-key digest; the facilitator keeps its content in an
  access-controlled local location outside both the llmwiki engine clone and synthetic fixture
  repository. The public manifest retains the digest only—never a path, key, decision, or rationale
- study arm, arm order, protocol version, and event-schema version

Any change creates a new run ID. Do not combine events from different manifests in one arm result.

## Consent and local-only recording

Before observation, explain the task, exact fields recorded, local storage location, timebox, and
the right to pause, withdraw, or request deletion without consequence. Record `consent` only after
an affirmative answer. No consent means no observation and no event log.

Use [`usability-study-event.schema.json`](usability-study-event.schema.json) as newline-delimited
JSON stored on the facilitator's local machine. It permits coded funnel events only: no names,
emails, usernames, raw paths, repository names, prompts, transcript or wiki text, credentials,
free-text notes, screen/audio capture, telemetry, or network upload. Keep the participant-code key
separately; delete both local files on withdrawal or deletion request. Publish only aggregate cells
with at least five consented participants, and never publish raw events.

## Procedure and funnel

Use a fresh study-specific HOME/profile/state directory and the frozen synthetic fixture. Record
one `entered` event and one terminal `completed`, `blocked`, or `stopped` event per stage, in order:

1. `consent`
2. `prerequisites`
3. `clone-located`
4. `dry-run`
5. `install`
6. `doctor`
7. `harness-activation` — Codex trusts both hooks; OpenCode restarts; Claude has no manual action
8. `fixture-enrollment`
9. `first-context`
10. `fixture-task`
11. `deterministic-close-out`
12. `close-out-artifact`
13. `clean-session-start` — fully exit; never resume or paste the prior session
14. `seeded-decision-retrieval` — the facilitator scores against the external answer key and records only coded
    retrieval evidence, without decision/rationale/query/result text
15. `comprehension-check` — record only one correct/incorrect boolean for each frozen item

The facilitator may restate the frozen task once. Every further hint is an `intervention` event;
record every incompatible platform/harness command as `wrong-command`, never its text. Never silently
repair the participant's environment. End after the comprehension check or the stop rule, then offer
local deletion before closing the session. Validate each local JSONL file before analysis with:

`bun src/engine/usability-study-validate.ts <local-events.jsonl>`

## Stop rules

Stop immediately and record only the applicable reason code when the participant withdraws or asks
for deletion; a real/private repository or transcript is opened; credential-shaped content appears;
the task would mutate outside the frozen clone, synthetic fixture, or study-specific state; the
participant shows distress; or the 45-minute timebox expires. These conditions map respectively to
`participant-withdrew`, `deletion-requested`, `private-data-exposed`, `credential-risk`,
`unsafe-mutation-risk`, `participant-distress`, and `timebox-expired`; each must be recorded as the
immediate `stopped` event with outcome `stopped`, and no later event is valid. Also stop after two
facilitator safety interventions. The second `intervention` event must be followed immediately, in
the same stage, by `stopped` with outcome `stopped` and reason `facilitator-safety-stop`. Do not
record a third intervention, a successful stage completion, or any later event. Do not work around
a stop condition to complete the funnel.

## Pilot gate

Run a five-user pilot for every harness in every planned platform/arm stratum. Pilot events are
labeled `pilot` and excluded from comparative results. Recruitment opens only when all five logs
validate, at least 80% complete the full loop unaided, median time to first value is at most 20
minutes, nearest-rank p90 time to first value is at most 30 minutes, median wrong-command count is at
most 1, every comprehension item is correct in at least 80% of completed checks, and there is no
privacy/safety stop. Otherwise revise the protocol/schema/task, increment the affected version,
create new manifests, and repeat the five-user pilot.

## Comparative design and analysis

The two pre-registered arms are `agent-guided` (`setup_text.md`) and `manual-fallback` (the active
README language). Use the same frozen release, harness, model, fixture, and platform within a pair;
reset HOME/profile/state and the fixture between arms; counterbalance arm order. Analyze each
platform × harness cell separately. No arm can be called a winner before it has at least 15 valid,
completed runs in that cell; consented stops remain in funnel and safety denominators.

For each arm and cell, sort by `participant_code`, then `sequence`. Reject duplicate or decreasing
sequence numbers, decreasing `monotonic_ms`, events with a different `manifest_digest`, or stages
after a terminal `stopped` event. Report:

- funnel completion: participants completing each stage / participants completing `consent`
- unaided full loop: eligible runs completing `comprehension-check` with zero `intervention` events /
  runs completing `prerequisites`; target ≥80%
- time to first value: `close-out-artifact` completion minus `clone-located` entry, excluding consent
  and prerequisites; median target ≤20 minutes and nearest-rank p90 target ≤30 minutes
- friction: median count of `blocked` plus `intervention` events per participant
- wrong-command target: median count per eligible run; target ≤1
- comprehension target: correctness percentage for each of the five frozen item IDs among completed
  checks; every item target ≥80% (never substitute an aggregate score)
- safety: count by stop reason, reported even when zero

After the 15-completed-run gate, the agent-guided arm wins only if its final-stage completion rate is
not lower, its median task time and friction are not higher, it meets the ≥80% unaided-loop, ≤20-minute
median, ≤30-minute p90, ≤1 median wrong-command, and ≥80%-for-each-comprehension-item targets, and it
has no additional privacy/safety stops versus manual fallback.
A tie is reported as a tie; missing, validator-rejected, under-15-completed, or mixed-manifest cells
are `insufficient`, never silently dropped or pooled. This protocol defines analysis; it does not
authorize collecting or uploading participant data.
