---
title: Cobalt capture routing
description: cobaltroutingmarker routes captured sessions to their enrolled repository
date: 2026-08-09
tags: [capture, routing]
status: ready
domain: topic
---

The cobaltroutingmarker binds a captured session to the enrolled repository named by harness metadata.
The routing stage reads bounded identity fields before any transcript body is materialized.
Enrollment is checked after routing and before capture writes to the queue.
An unresolved repository stays outside the capture queue and contributes only an aggregate counter.
The same route remains stable when the deterministic benchmark is repeated on another machine.
The public baseline uses distinct vocabulary so unrelated pages cannot tie its retrieval rank.
