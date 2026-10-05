# consolidate — topic-consolidation detail (select · merge · cross-link)

Use this when a pass has at least one concept to fold into `5_topic/` (the `/wiki-save` step 3 moment, or a `/wiki-deep` missing-concept gap / re-distill).

## 1. Surface

- `llmwiki consolidate <repo>` (dry-run) lists which concepts the session touches and which already have a `5_topic/` page (FTS-matched).
    - `--commit` runs the gated unattended merge (strong-model write → independent verify → grounding → lint). A warm pass uses the dry-run for candidates, then authors/merges the pages itself.
- `llmwiki topics <repo>` — deterministic topic view (pages clustered by shared tag/citation; no LLM, regenerable). Eyeball the encyclopedia's shape.

## 2. Select — the opposite of the log

Promote a concept to `5_topic/` ONLY if one holds:

- it recurs (mentioned across 2+ sessions / already has a topic page), OR
- it is explicitly durable (enriches an existing topic page), OR
- it is a concept directly tied to a decision/direction.

Everything episodic stays in the log only. When unsure, leave it in the log. Don't force-fill.

## 3. Merge — re-ground from raw (the anti-drift rule)

- **Update-vs-create by the 5-dimension overlap rubric** (compound-engineering port): ①concept/problem ②mechanism ③approach ④files/modules ⑤operating rule.
    - High (4-5 dims) = merge into the existing page.
    - Moderate (2-3) = new page + note a consolidation-review line in the close-out report.
    - Low = new page.
- Judge overlap semantically across languages — the same concept in Korean and English is ONE page (merge keeps the existing page's language; new bullets follow the session's language).
- **No page yet** → create `5_topic/<concept-slug>.md` from `llmwiki conventions <repo> --section topic-page`.
- **Page exists** → **add** the new fact as a bullet with its own citation; **preserve every existing grounded line verbatim**. Never rewrite the page from itself.
- Build the merge ONLY from the session transcript / raw evidence — **never re-summarize other wiki pages** (wiki→wiki re-derivation is forbidden; it causes drift).

## 4. Cross-link and conflicts

- Add wikilinks from the topic page to the relevant `3_decision`/`2_milestone` pages using an explicit relation word: `grounds`, `extends`, `contradicts`, `exemplifies`, `enables`.
- A new fact that **contradicts** an existing line is never overwritten — add a `> [conflict]` callout on the page, and route the resolution to `0_review` if it is a direction-level conflict (item format and `owner:` stamp: `llmwiki conventions <repo> --section review-item`).
