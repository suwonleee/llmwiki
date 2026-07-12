---
title: Transaction import (parse → categorize → dedup → persist)
description: the core import seam — how a bank CSV becomes categorized, deduplicated rows
date: 2026-01-12
updated: 2026-01-15
tags: [import, topic]
status: ready
domain: topic
source: session-2026-01-12.jsonl
---

TL;DR — the import path is the project's spine: parse CSV → normalize dates (UTC) → categorize → dedup → persist to SQLite.

- Dates are normalized to UTC at the parse boundary (a naive-local bug shifted months). [^s1]
- Categorization is a merchant-substring rule table; alias collapse is the known weak spot. [^s2]
- Dedup keys on (date, amount, normalized-merchant) to survive re-imports of overlapping statements. [^s2]

## Related
- [[3_decision/2026-01-12-storage-sqlite-over-json]] — grounds
- [[2_milestone/2026-01-15-csv-import-and-categorization]] — exemplifies

[^s1]: session-2026-01-14.jsonl
[^s2]: session-2026-01-15.jsonl
