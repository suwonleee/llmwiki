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
- **pennywise**: single-binary CLI for bank CSV import, transaction categorization, and monthly-spend reporting
    - Storage: SQLite
    - Core path: parse → categorize → dedup → persist

## Next
- Merchant-alias brittleness in the rule-based categorizer
    - Candidate: learned fallback
- Missing multi-currency support
    - Current assumption: one account currency

## Entry
check `llmwiki doctor` · ask `/wiki-ask` · close out `/wiki-save` · deep pass `/wiki-deep`
