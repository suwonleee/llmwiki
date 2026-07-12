---
title: Overview — pennywise
description: Front page / entry point for the pennywise wiki
date: 2026-01-10
tags: [overview, meta]
---

This wiki is the living knowledge of **pennywise** (a personal-finance CLI). It compounds
as you work — the LLM writes it, you curate direction. Quick status: see [[current-state]] (L0).

## Key Findings

### Storage & data
- Transactions are stored in SQLite, not JSON files — chosen for query-ability and FTS. ([[3_decision/2026-01-12-storage-sqlite-over-json]])
- CSV import normalizes dates to UTC at the boundary; mixed-timezone CSVs were silently off by a day. ([[4_insight/2026-01-14-timezone-bug-in-date-parsing]])

### Import pipeline
- The import path (parse → categorize → dedup → persist) is the core seam. ([[5_topic/transaction-import]])

## Recent Updates

세션별 변경 이력은 [[log.md]] 참조 (overview는 엔트리포인트 — 세션 단락 누적 금지).
