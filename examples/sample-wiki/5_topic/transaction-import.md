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

## 1. Parse boundary

- Dates normalized to UTC at the parse boundary [^s1]
    - cause: a naive-local read shifted month boundaries
        - month-end rows landed in the previous month
- Amount strings routed through one parser
    - separators stripped before `Number()`

## 2. Categorization

- Merchant-substring rule table decides the category [^s2]
    - alias collapse: the known weak spot
        - `AMZN MKTP` and `Amazon Marketplace` count as different merchants
    - candidate: a learned fallback for unmatched merchants

## 3. Dedup and persistence

- Dedup key: (date, amount, normalized-merchant) [^s2]
    - survives re-imports of overlapping statements
- One transaction per imported file
    - a failed file leaves no partial import

## Related
- [[3_decision/2026-01-12-storage-sqlite-over-json]] — grounds
- [[2_milestone/2026-01-15-csv-import-and-categorization]] — exemplifies

[^s1]: session-2026-01-14.jsonl
[^s2]: session-2026-01-15.jsonl
