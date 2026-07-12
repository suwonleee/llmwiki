---
title: gotcha — mixed-timezone CSVs were off by a day
description: bank CSVs in local time were stored without TZ normalization, shifting some dates
date: 2026-01-14
updated: 2026-01-14
tags: [insight, gotcha, dates]
status: ready
domain: insight
source: session-2026-01-14.jsonl
---

TL;DR — normalize CSV dates to UTC at the parse boundary; storing naive local times shifted month boundaries.

- Some banks export `2026-01-31 23:30` local; stored naive, it landed in the wrong month's report. [^1]
- Fix: parse with the account's stated timezone, convert to UTC before persist. [^1]

[^1]: session-2026-01-14.jsonl
