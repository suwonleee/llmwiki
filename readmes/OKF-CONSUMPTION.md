# Consuming OKF structure

Research and implementation note, 2026-10-15. The reference specification examined was
[OKF v0.2 at ad30107](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md).
The format supplies interoperable metadata and links; it does not promise better model answers.

## What the official format enables

| Structure | Official contract | llmwiki use |
| --- | --- | --- |
| `type`, `tags` | §4.1: routing, filtering and cross-cutting categories; unknown types remain consumable | Search matches tags on every page. Descriptive types are preserved without automatically biasing ranking by question wording. |
| `sources[].id` | §5.1: footnote labels join to sources by ID, not list position or footnote prose | Citation graph and lint resolve the same declared resource. Reordering sources or rewriting a display label preserves the edge. |
| Markdown links | §6: document-relative and bundle-absolute paths; surrounding prose carries relationship meaning | Existing graph resolves local links. No automatic traversal is added in this change. |
| `status`, `stale_after` | §5.4–5.5: currency, distinct from verification | Existing automatic context excludes retired pages and marks stale knowledge. |
| `verified`, `generated` | §5.2–5.3: verification is independent of authorship | A `stable` page is not proof of correctness. This change does not assign trust scores or fabricate verification. |
| `index.md` | §8: progressive disclosure through directory listings | Existing generated indexes remain navigation; they are not competing knowledge pages in search. |

The official [reference document reader](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/src/reference_agent/bundle/document.py)
and [viewer](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/src/reference_agent/viewer/generator.py)
show how metadata and links can be consumed. The specification governs interoperability when
a proof-of-concept implementation differs from it.

## Authoring a useful concept

Use a descriptive type and title; give the page a one-sentence description and a few specific
tags that a future request might use. Keep explanations in topic pages and the reason for a
choice in decision pages, connected by a normal Markdown link. Preserve arbitrary types used
by other producers. Type names such as `Decision` and `Topic` are llmwiki conventions, not a
closed OKF taxonomy.

Declare sources by stable IDs, and use the IDs in claim footnotes:

```markdown
---
type: Decision
title: Retry only idempotent requests
tags: [http, retries, idempotency]
sources:
  - id: retry-policy
    resource: /references/retry-policy.md
---
Retry only requests that the service documents as idempotent.[^retry-policy]

[^retry-policy]: Service retry policy, reviewed example
```

The footnote is a display label; its prose does not have to look like a filename. Declared local
resources resolve by path, without a same-basename fallback. External URLs and non-file scope
descriptions remain provenance metadata: the engine neither fetches them nor claims they exist
locally. Duplicate IDs are ambiguous and do not bind to an arbitrary source. A missing local
artifact is reported. Legacy filename footnotes continue to work when no matching source ID is
declared. Exact repository code paths produced by older llmwiki conversion remain supported.

For actionable rules, `x-llmwiki.applies_to`, `rule` and `recall` remain the existing extension
for file scope and trigger phrases. A topic link alone does not establish that every linked
rule applies to the current edit.

## Ranking boundaries

Tags have a lower match weight than titles and are not presented as title matches. An initial 15% type
preference was removed during pre-merge review: causal “why” questions do not necessarily ask
for decisions, and “explain” can ask for a decision. Type labels alone do not change ranking.
Unknown types remain eligible. The existing relevance gate, three-page and character budgets,
session deduplication and retired-page exclusion remain.

This implementation uses local text and metadata only. There is no embedding model, network
lookup or additional LLM invocation in the retrieval path.

## Evidence and remaining work

The [reproducible diagnostic](../evals/okf-consumer/README.md) records frozen fixtures and both
versions' outputs. Final synthetic top-1 retrieval improved from 10/15 to 11/15 and top-3 from 14/15
to 15/15. Seven forbidden rule checks and one filler check stayed clear. Twenty-eight historical
questions evaluated on the same current corpus snapshots had identical target-page ranks and
context hit counts before and after the change. The original historical corpus was unavailable, so this is
not an exact replay of the earlier experiment.

These results establish added metadata retrieval behavior and no observed regression in that
sample. They do not establish improved coding accuracy, net token savings or external-user
productivity. The linked-rule, type-intent and current-status diagnostics remain unmet; broader traversal
and any future type policies need independent evaluation. The initial 14/15 result included
three type-only tie wins and does not describe the merged candidate. Sources-ID correctness is covered by
graph/lint regression tests, independently of retrieval scores. Three synthetic source-ID joins
resolve 0/3 before the change and 3/3 afterwards, with false missing-source warnings falling
from three to zero.

## Evidence-use guidance and public handoff (2026-10-15)

Runtime main includes `837fad4`, which changes Korean and English wording in
`src/engine/context.ts` and `src/engine/turncontext.ts`: excerpts are navigation leads;
read the relevant section before using wiki facts or decisions, cite only material read,
and do not treat a source link alone as verification. This is an evidence-use instruction
change, separate from the OKF retrieval/graph changes above. It adds no ranking heuristic,
embedding infrastructure, mandatory retrieval for every question, or new tool call.

The [aggregate evaluation record](evidence-guidance-validation.json) compares
`3514f47` with `837fad4`, using the same frozen private project, Codex model
`gpt-6.1-sol` at medium effort, and two repetitions per question. Questions, gold facts,
source hashes and grading rules were frozen before execution. Both studies use blinded
independent grading of factual answers and adjudication of disagreements. The controls
received a separate manual blind review, not double grading.

| Study | Complete-fact answers, before / after | Mean required-fact coverage, before / after |
| --- | --- | --- |
| Initial challenge: 7 valid questions | 5/14 / 7/14 | 84.82% / 83.75% |
| Fresh additional validation: 8 questions | 13/16 / 14/16 | 97.66% / 98.44% |

The initial study excluded one invalid gold question equally across all arms after finding
a conflict with current code; its original inputs/results remain preserved privately. The
additional study had no exclusions. Its difference came from one question; seven tied.
The exploratory question-cluster interval for the complete-answer difference was
0 to +18.75 percentage points, including no difference. Execution-time medians increased
from 53.14 to 55.06 seconds and uncached input tokens from 616,829 to 646,627 in that study.
Eight self-contained control runs answered correctly without shell calls, but still received
1,384–1,494 characters of unnecessary turn context.

Retain the bounded guidance change with these limits. These small, authored, single-project
trials do not establish general accuracy gains, token savings, coding-task success, Claude Code
performance, or longitudinal compounding. Do not combine the suites into a headline success
rate. Keep raw corpus, questions, answers, grades and execution traces in private storage;
only the aggregate record here is intended for public transfer.

For the public llmwiki checkout, inspect whether the four guidance strings from `837fad4`
are already present. If absent, port that commit's two-file diff onto a compatible base,
preserving any later changes. Copy this report and its aggregate JSON together. Do not copy
the runtime checkout wholesale: its wiki and private artifacts are outside the release boundary.
After porting, run `bun run check:quick` while iterating and `bun run check` on the public
release tree. This handoff does not certify that a public release has passed those gates.
