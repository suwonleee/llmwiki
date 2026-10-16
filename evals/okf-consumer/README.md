# OKF consumer diagnostic

These frozen synthetic inputs check metadata retrieval and source-ID resolution. They do not
estimate model accuracy, coding success or external-user productivity. Keep fixture labels
unchanged when comparing engines. Reports include the fixture SHA-256.

Run from the repository root, placing raw output in local scratch storage:

```sh
bun evals/okf-consumer/run.ts /absolute/path/to/baseline-engine /tmp/okf-baseline.json
bun evals/okf-consumer/run.ts /absolute/path/to/changed-engine /tmp/okf-changed.json
bun evals/okf-consumer/provenance.ts /absolute/path/to/baseline-engine /tmp/source-baseline.json
bun evals/okf-consumer/provenance.ts /absolute/path/to/changed-engine /tmp/source-changed.json
```

The runners build temporary isolated wiki/index state and remove it afterwards. They do not
install hooks, read a live project corpus, or invoke an LLM. Raw retrieval reports contain
local engine and temporary-directory paths; do not commit them. The checked-in
`retrieval-summary.json` contains only aggregate measurements. The two provenance reports
contain three synthetic examples and no private corpus material.

The 16 cases include English/Korean type intent, tags, lexical matches, unknown types,
current status, a desired linked rule, and unrelated/retired/stale/path-escape/filler checks.
The final engine deliberately does not infer ranking preference from document type alone.

| Metric | Baseline | Final |
| --- | ---: | ---: |
| Top-1 retrieval | 10/15 | 11/15 |
| Top-3 retrieval | 14/15 | 15/15 |
| Desired linked rule delivered | 0/1 | 0/1 |
| Forbidden rules delivered | 0/7 | 0/7 |
| Filler activation | 0/1 | 0/1 |
| Source-ID joins resolved | 0/3 | 3/3 |
| False missing-source warnings | 3 | 0 |

The retrieval improvement is tag discovery; linked-rule delivery remains an unmet diagnostic.
Timing and character counts describe the recorded run, not reliable latency or token savings.
Additional code regressions cover corrected heading breadcrumbs, source locators, and rebuilding
derived chunks on upgrade. No private evaluation questions, source documents or raw agent
answers ship with this diagnostic. See [OKF consumption](../../readmes/OKF-CONSUMPTION.md)
for the implementation contract and separate aggregate agent-evaluation limits.
