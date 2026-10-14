# review-item — the `0_review` Q./A. file format (no emojis)

Use this when writing a `0_review/` item. After the routine-judgment rule, `0_review` is almost entirely **direction-shift confirmation** (plus unresolved direction-level contradictions). Labels/guidance in English; content (question + draft) in the wiki's own language. Separate paragraphs with blank lines so the human can write the answer directly under `A.`:

```
---
type: Review Item
title: "[review] <short title>"
description: <one sentence: the direction question>
date: <YYYY-MM-DD>
tags: [review, direction]
status: draft
kind: direction       # direction-shift confirmation (human-owned)
owner: <github login>   # always stamp — file owner whose judgment is awaited; cold-start shows [→ owner]
generated: { by: <harness>/<model id> }   # `at` is stamped by `llmwiki okf`
sources:
  - { id: s1, resource: <transcript filename> }   # the Draft cites it as [^s1]
---

Q. This session looks like a direction shift from <from> → <to>. Confirm?

A. (write your decision below; on the next close-out or deep pass the LLM applies it and deletes this file)


Draft (candidate 1_direction page; moved into 1_direction/ once confirmed):
<transcript-grounded summary + draft of the direction page to move on confirmation>
```

On confirmation the recorded `1_direction/` page stamps `verified: { by: human:<owner login>, at: <ISO now> }` — the human's answer is the verification; a model's own confirmation never is.

## `owner:` — always stamp it

- The file owner whose judgment is awaited (cold-start shows `[→ owner]`).
- Resolve the login as `gh api user --jq .login` → else `git config user.email` local-part → else `git config user.name`.
- Stamp it regardless of solo/team (not reliably distinguishable, and a file owner is useful either way).
