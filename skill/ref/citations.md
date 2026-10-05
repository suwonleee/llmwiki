# citations — footnotes, evidence excerpts, frontmatter detail

Use this when writing a page's footnotes and evidence lines, and whenever lint flags `unresolved-citation`.

## 1. Footnotes and frontmatter

- Every fact/judgment claim needs a footnote `[^1]: <transcript filename or bare code path>`.
    - A `:line` suffix is tolerated — the engine absorbs it — but the bare path is canonical: line numbers rot as code moves, and the verbatim grounding lives on the v3 evidence line.
- Required frontmatter: `title` `description` `date` `tags`(≥2) `status`(ready|draft) `domain`(direction|milestone|decision|insight|topic) `source`. Cross-link related pages.
- **Never add `author:`** — authorship is read from git, never cached in frontmatter (decision 2026-07-10).
    - A stamped author goes stale the moment a teammate edits the page, and git already knows.
    - `llmwiki digest` renders contributors from git history (mailmap-aware; `ensureSkeleton` seeds a `.mailmap` so one person's several git identities count once).
    - Legacy pages that still carry `author:` are left as-is — historical records, not a format to continue.
- `0_review` items additionally stamp `owner:` — see `llmwiki conventions <repo> --section review-item`.

## 2. Evidence excerpts (page format v3)

The indented `>` line under a footnote carries 1–2 lines of the evidence itself, so a teammate who does NOT have your transcript can still read what grounds the claim.

- **Get it from the engine, never from memory**: `llmwiki excerpt <transcript.jsonl> [--kind judgment|fact] [--limit N]`. It quotes verbatim, caps length, and screens secrets — a hand-written excerpt does all three wrong.
- **Judgment claims** (decision · direction) take a `user` quote — what the human actually said. **Fact claims** (milestone · insight) take a tool record (`[tool <hash>]`). Lint verifies judgment quotes really appear in the transcript.
- **The footnote definition line itself never changes** — the excerpt goes on the NEXT line, indented 4 spaces. Appending to the definition line silently breaks teammate citations (`tests/page-format-v3.test.ts` pins this).
- Excerpts are excluded from the search index and from the topic-page budget, so adding evidence never costs retrieval quality or squeezes prose.

## 3. Unresolved-citation guard (never strip to silence)

If lint flags `unresolved-citation`, **fix** the footnote — never delete it (deleting only downgrades to a `no-citation` warning and discards provenance).

- First decide the claim's KIND:
    - **a human decision / judgment / statement** → the source is the **session transcript**, NOT code (normally already citable via `update-next`; else `llmwiki register-transcript <repo>`), cite `[^n]: <transcript>.jsonl` — **never repoint a decision to a code file**;
    - **a factual claim about code** → cite **one repo-relative path that exists**.
- One path per footnote (no globs/commas/parentheticals); one footnote per source.
- **Keep the definition LINE to the bare source** — an evidence excerpt belongs on the indented line below it (v3), never appended to the definition, which would break teammate citations.
- Only if no real source exists, drop the underlying claim.
