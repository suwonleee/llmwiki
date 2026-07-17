---
title: Current State — pennywise (L0)
description: Cold-start snapshot injected first each session — keep short
date: 2026-01-10
updated: 2026-01-15
tags: [current-state, L0, meta]
status: ready
---

> L0 — injected before overview at session start. Keep it tight; detail lives in milestones/decisions.

## Now
**pennywise** = a single-binary CLI that imports bank CSVs, categorizes transactions, and
reports monthly spend. Storage is SQLite; import is the core path (parse→categorize→dedup→persist).

## Next
- Rule-based categorizer is brittle on merchant aliases — consider a learned fallback.
- No multi-currency support yet (everything assumes one account currency).

## Entry
check `llmwiki doctor` · ask `/wiki-ask` · close out `/wiki-fast` · deep pass `/wiki-deep`
