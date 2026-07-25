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

## 1. Problem

- Durable storage for two access patterns
    - "sum by category this month"
    - free-text merchant search

## 2. Alternatives

- Flat JSON files — rejected
    - every query loads and scans the whole file
    - no full-text search
- SQLite — chosen [^1]
    - embedded, zero-server
    - SQL aggregation for the monthly sums
    - FTS5 for merchant search

## 3. Consequences

- One file to back up, one schema to migrate
- A query layer now exists for later reports

## Related
- [[5_topic/transaction-import]] — enables

[^1]: session-2026-01-12.jsonl
