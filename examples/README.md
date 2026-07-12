# examples/ — read-only illustration (do NOT copy into your wiki)

**English** · [한국어](README.ko.md)

`sample-wiki/` is a **frozen example** of what a mature llmwiki wiki looks like after a few
sessions on a small fictional project — **"pennywise"**, a personal-finance CLI that imports
bank CSVs, categorizes transactions, and reports monthly spend.

It exists so newcomers can see the **shape** of the two layers, the page formats, and the
self-healing artifacts **before** generating their own.

## What's inside

```
sample-wiki/
├── current-state.md      L0 — cold-start snapshot, injected FIRST each session (keep it short)
├── overview.md           front page / entry point — links out, never accumulates session logs
├── log.md                append-only chronological ingest/update/sync record
│
│   # ── time layer (per-session logbook) ──
├── 2_milestone/          work done + what's next
│   └── 2026-01-15-csv-import-and-categorization.md
├── 3_decision/           ADR: problem · alternatives · choice (Why/What/Alt)
│   └── 2026-01-12-storage-sqlite-over-json.md
├── 4_insight/            realizations · gotchas found while working
│   └── 2026-01-14-timezone-bug-in-date-parsing.md
│
│   # ── topic layer (concept encyclopedia, in-place merge) ──
├── 5_topic/              one page per concept, re-grounded from raw transcript
│   └── transaction-import.md
│
└── 0_review/
    └── gap-queue.md      self-closing queue of gaps that `review` surfaced
                          (fill by working the topic; auto-closes after 2 absent reviews)
```

The two layers, at a glance:

- **Time layer** (`2_milestone` / `3_decision` / `4_insight`) — *chronological logbook*. One
  entry per session, append-only. "What happened, when."
- **Topic layer** (`5_topic`) — *concept encyclopedia*. One page per concept, merged in place
  across sessions. "What we know about X."

Both are re-derived only from raw session transcripts (never wiki→wiki). `current-state.md`
(L0) + `overview.md` are the entry points injected at session start.

## Important — illustration only

- **The engine never reads or writes here.** `setup.sh` only indexes `<repo>/docs/wiki`,
  never `examples/` (it's in `IGNORE_DIRS`).
- **There is nothing to copy.** Your real wikis are built automatically, one per project,
  under each project's own `docs/wiki/`. Clone the engine, run `./setup.sh`, then just work —
  your wikis fill themselves.

Browse it to learn the conventions, then ignore it.
