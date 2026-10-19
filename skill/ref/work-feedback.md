# Bounded work feedback

At warm close-out, save at most **two concrete cases from this task**, only when a wiki claim
helped, was corrected, or lacked needed detail. Do not scan other sessions or invoke another
model. An exact harness-provided session ID is required; if absent, skip and report why.

1. Read the raw code/test output that supports the correction. Repair only affected facts in
   pages already in scope, preserving grounded history and marking contradictions. Do not
   rewrite human directions, infer correctness from a click, or change golden labels.
2. Save this JSON to a temporary file and call `llmwiki work-feedback <repo> --source <file>`:

```json
{
  "session": "exact-harness-session-id",
  "cases": [{
    "query": "Gateway retry policy",
    "page": "docs/wiki/3_decision/retries.md",
    "outcome": "corrected",
    "evidence": ["src/policy.ts", "test-results/retries.txt"],
    "required": ["3 retries"],
    "forbidden": ["99 retries"]
  }]
}
```

Use actual existing repository-relative source/test output paths (not wiki summaries), and
short exact excerpt assertions supported by those files. Outcomes are `helped`, `corrected`,
or `missing`; a missing-evidence case still identifies an existing relevant page. Never invent
a test log or mark an unexecuted test successful. No suitable existing page/evidence → skip.
The command hashes the evidence and current page; one immutable record per session lives in
machine-local project state. It does not execute supplied commands or alter repository files.

3. `llmwiki work-feedback <repo> --check` replays all retained **silver** cases against current
   retrieval and excerpts (up to 2,000 session records). For ordinary close-out, record only;
   run replay during a scoped retrieval change or deep pass, not every task. A changed wiki is
   tested against the original assertions. Changed raw evidence invalidates the case, rather
   than silently changing its answer. Failure/invalidated records cause exit 1.

These are diagnostic regression cases, not independent golden data or proof of task success.
Do not promote them into heldout data or ranking rewards automatically. Keep existing goldens
frozen; evaluate new proposals against a separately reviewed, time-separated holdout.

## Source-change warning

A page flagged `source changed; recheck required` remains findable and its factual excerpt carries an explicit source-change warning.
Its prescriptive rule is withheld; treat the excerpt as a lead and verify current code before relying on it. Editing the page does not clear the flag. After reading the current cited sources,
correcting affected claims and running relevant checks, use `llmwiki freshness <repo> --page
<docs/wiki/path.md>` to capture the current verification snapshot. Save it with a `verification`
object containing `verifiedBy` and `evidence` as described by `llmwiki freshness --help`, then
submit with `--source`. The snapshot must still match at acknowledgement. This records the
warm verifier's attestation; hashes prove unchanged inputs, not semantic truth. If verification
is incomplete, leave the warning and record the concrete missing evidence.

## Exact reflection coverage

`update-done` remains an explicit warm close-out operation using the offset returned by
`update-next`. Reconciliation no longer infers whole-session completion from a citation.
For deferred reconciliation, `reflection-receipt --source FILE` accepts:
`{version:1, transcript_path, page, start, end, prefix_sha256, page_sha256}`.
Use the exact queued absolute transcript path, consumed byte range, SHA-256 of source bytes
`[0,end)` as actually read, and SHA-256 of the accepted page bytes. Do not hash a later source
snapshot and claim it was consumed. Draft/review/quiz pages cannot establish coverage. A later
`reconcile --commit` revalidates both snapshots and advances only to `end`; a growing tail stays
pending. Ordinary `update-done` does not need a redundant receipt.

## Version-bound injected-page feedback

Optional at a warm close-out, at most **2 concrete cases** actually witnessed in this task;
a broader pass belongs to the explicit deep command. Run `llmwiki injected <repo> --session
<exact id>` to obtain the emitted page/channel/version list. Never infer an ID from recency.
Read the relevant current page and actual task evidence before judging it. Only judge pages
and versions in that exact emission list; a later rewrite is not the page the model saw.

Save the CLI's version identifiers and short evidence in JSON, then call `llmwiki
injected-feedback <repo> --source <file>` (exact schema: `llmwiki injected-feedback --help`).
Judgments: `used` means the claim visibly informed this work; `irrelevant` means a concrete
mismatch with this task, never merely no Read; `wrong` means a sourced contradiction;
`unknown` means usage/correctness cannot be established. A wrong claim can still have been
used: record both the usage and correctness fields the CLI supports, never hide that overlap.
Skip uncertain evidence rather than manufacturing a judgment. Receipts are immutable and
version-bound; they do not rewrite page bodies or golden answers. Small samples do not alter
ranking. `wrong` enters the engine-owned factual `recheck` queue, not a human-direction item.
A changed page/source requires fresh verification before closing a recheck.
