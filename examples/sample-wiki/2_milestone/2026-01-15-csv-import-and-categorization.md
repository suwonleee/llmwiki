---
title: CSV import + rule-based categorization + monthly report
description: importer parses bank CSVs, categorizes by merchant rules, reports monthly spend
date: 2026-01-15
updated: 2026-01-15
tags: [milestone, import, categorization]
status: ready
domain: milestone
source: session-2026-01-15.jsonl
---

TL;DR — end-to-end import (CSV → categorized transactions → monthly report) works for one currency.

- CSV importer handles the 3 common bank export shapes; dates normalized to UTC at parse time. [^1]
- Categorizer is a rule table (merchant substring → category); ~80% of test rows auto-categorized. [^1]
- `pennywise report --month 2026-01` prints per-category totals. [^1]

## Next
- Merchant aliases ("AMZN" vs "Amazon") break rules — needs normalization or a learned fallback.

## Related
- [[3_decision/2026-01-12-storage-sqlite-over-json]] — grounds
- [[5_topic/transaction-import]] — exemplifies

[^1]: session-2026-01-15.jsonl
