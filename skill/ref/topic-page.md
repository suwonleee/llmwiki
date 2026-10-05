# topic-page — the `5_topic/` page format

Use this when creating a NEW `5_topic/<concept-slug>.md` page. Merging into an existing page follows that page's shape: add the new fact as a bullet with its own citation and preserve every existing grounded line verbatim.

```markdown
---
title: <concept / module / pattern name>
description: <one sentence>
date: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [<hub>, topic]
status: ready          # if direction-tied/unresolved → draft + 0_review
domain: topic
source: <transcript>.jsonl
---

TL;DR — one line.

## 1. <first group — what it is / what changed>

- <core fact / mechanism> [^s1]
    - <supporting condition / result> [^s1]
        - <deeper implementation detail, only when useful> [^s1]
- <a later session adds this; existing lines stay untouched> [^s2]

## 2. <second group — consequence / remaining work>

- <concrete point> [^s2]

### 2-1. <only when this group has parts>

- <concrete point> [^s2]

> [conflict] <other-page> claims X; this session says Y — needs human review

## Related
- [[3_decision/<page>]] — grounds
- [[2_milestone/<page>]] — exemplifies

[^s1]: <transcript-1>.jsonl
    > [2026-06-29 14:02 user] "<the human's own words, verbatim>"
[^s2]: <transcript-2>.jsonl
    > [tool a3f9c2d1] bun test → 272 pass
```

Each fact keeps its own footnote, so a topic page accumulates `[^s1] [^s2] …` from many sessions — provenance is per-claim, traceable down to the real transcript. The evidence lines under each footnote follow `llmwiki conventions <repo> --section citations`.
