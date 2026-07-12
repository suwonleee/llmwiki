---
title: Store transactions in SQLite, not JSON files
description: pick a storage backend for transactions — chose embedded SQLite over flat JSON
date: 2026-01-12
updated: 2026-01-12
tags: [decision, adr, storage]
status: ready
domain: decision
source: session-2026-01-12.jsonl
---

TL;DR — transactions live in an embedded SQLite DB; JSON was rejected for lack of query/FTS.

## Problem
Need durable storage that supports "sum by category this month" and free-text merchant search.

## Alternatives
- **Flat JSON files** — simple, but every query loads + scans all of it; no FTS. Rejected.
- **SQLite (chosen)** — embedded, zero-server, SQL aggregation + FTS5 for merchant search. [^1]

## Related
- [[5_topic/transaction-import]] — enables

[^1]: session-2026-01-12.jsonl
