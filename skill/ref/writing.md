# writing — page prose and body-structure detail

Use this before writing your first page of a pass, and whenever lint flags `dense-bullet` or a banned term. The always-on rules (who writes, no fabrication, page language, verbatim identifiers, the numbered-section shape) live in the skill itself; this is their full detail.

## 1. Body structure

- Numbered sections holding a hierarchical bullet outline — write for a person scanning the page, not for a parser.
    - `## 1. <label>`, `## 2. <label>` … in reading order; split a section as `### 1-1. <label>` only when it genuinely has parts.
    - Use sections once a page carries more than one group of points (roughly 6+ top-level bullets). A short single-group page stays a bare bullet list under the TL;DR — no ceremony.
    - Inside a section: one concrete claim, decision, result, or action per `-` line; supporting detail at `    -`; deeper detail at `        -`. No fourth level — that means the section wants splitting.
- **One point per line**: a bullet that enumerates more than three items becomes a parent line plus one child bullet per item. Never a `·`/`/`-joined pile-up that a human has to re-parse (lint flags it as `dense-bullet`).

## 2. Endings and density

- **Endings**: prefer noun phrases or telegraphic endings natural to the page language; avoid polite/full-sentence endings and abstract framing. Keep verbs when actor, action, condition, or outcome would otherwise be unclear.
- **Density**: keep each bullet to one useful line when possible; do not restate the heading/TL;DR or add a child that merely paraphrases its parent.
    - Exempt: frontmatter, evidence/quotes, code, conflict/Q&A callouts, and the one-line TL;DR.

## 3. Terminology

- Lint-enforced, advisory: avoid jargon a person wouldn't naturally say — e.g. when writing Korean prefer `방향성` over 진북/북극성, `업데이트` over distill.
- A team config's banned terms print with `llmwiki conventions <repo>`.
