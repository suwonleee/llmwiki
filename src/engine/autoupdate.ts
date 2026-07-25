// autoupdate — unattended update with a safety gate (the direction's last mile).
//
// Unattended update was deliberately deferred for fear of model-collapse / low-trust KB.
// This closes that gap *safely* — an independent second model reviews every write:
//
//   1. WRITE   — claude -p produces a grounded wiki page from the transcript extract
//                (cites the transcript; judgment → status: draft).
//   2. VERIFY  — an INDEPENDENT second model (Opus) adversarially checks every claim
//                against the extract. Any unsupported claim → reject.
//   3. LINT    — deterministic gate (frontmatter, citation resolution, links).
//
// Routing: the human queue (0_review) is reserved for STRATEGIC DIRECTION
// only. A page whose domain is `direction` is wrapped into 0_review for the human to
// confirm (watermark stays pending). Every other domain (milestone/decision/insight) is
// adjudicated by the independent Opus VERIFY pass: grounded + lint-clean → accepted as
// `ready` (no human); ungrounded or lint-error → REJECTED/omitted (not escalated to the
// human) with the watermark advanced as `skipped`. Opus adjudicates; it never fabricates.
//
// NEVER writes the judgment layer (current-state.md) — that stays human.
// Default is dry-run; commit=true applies the gated results.
//
// Returned dict keys are kept snake_case (cli.ts prints them by name).
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, relative as relpath, resolve } from "node:path";
import { llm } from "./claude.ts";
import * as capture from "./capture.ts";
import * as update from "./update.ts";
import {
  domainToDir, effectiveKo, getConfig, isHumanReviewDir, isStockConventions,
  renderBodyStyleRule, renderDomainBullets, renderDomainList, renderGroundingRule, renderTerminologyLine,
  type WikiConfig,
} from "./config.ts";

// WRITE_PROMPT's terminology line historically used slightly different wording than _SCHEMA's
// ("wouldn't say"/"(not …)") — kept verbatim for stock conventions (byte-stability contract).
const _terminologyWrite = (cfg: WikiConfig) =>
  isStockConventions(cfg)
    ? "- Terminology (lint-enforced, advisory): avoid jargon a person wouldn't say — e.g. when writing Korean prefer \`방향성\` (not 진북/북극성/north-star) and \`업데이트\`/\`update\` (not distill)."
    : renderTerminologyLine(cfg);
import { WikiIndex } from "./db.ts";
import { render, type Increment } from "./extract.ts";
import { sourceForKind } from "./source.ts";
import { collectGroundedFacts, assessGrounding } from "./grounding.ts";
import { ensureExcerpts } from "./excerpt.ts";
import { updateReferences } from "./refs.ts";
import { Linter, type LintIssue, type WikiIndexLike } from "./lint.ts";
import { MODEL_HEAVY, MODEL_LIGHT } from "./models.ts";
import { writeRepoFile } from "./repo-write.ts";

// WRITE = light tier (cheap, high-volume drafting). VERIFY = heavy tier — the adversarial
// gate uses the strongest model; volume is small (one call per pending transcript), so it
// is affordable and catches more than a cheap model. Both tiers are env-overridable
// (LLMWIKI_MODEL_LIGHT / LLMWIKI_MODEL_HEAVY) — see models.ts.
export const WRITE_MODEL = MODEL_LIGHT;
export const VERIFY_MODEL = MODEL_HEAVY;

// log.md bookkeeping bullets adapt to LLMWIKI_LANG (default English, Korean when set) —
// resolved per repo inside updateOne/run. The LLM-facing WRITE/VERIFY prompts stay English
// by design regardless.

// Rendered per resolved config (per-repo). The canonical stock contract is pinned by
// tests/config-render.test.ts so every writer receives intentional format changes together.
export function schemaText(cfg: WikiConfig = getConfig()): string {
  return `Wiki page rules (strict):
- Begin the file with a YAML frontmatter block containing: title, description (one sentence), date (YYYY-MM-DD), tags ([2+ entries]), status (ready|draft), domain, source.
- Choose ONE domain for this page and set the \`domain:\` field to it:
${renderDomainBullets(cfg)}
- Every factual claim must carry a footnote citation \`[^1]\`, and the file must end with \`[^1]: <TRANSCRIPT_FILENAME>\`.
${renderGroundingRule(cfg)}
- Usefulness rule: everything written must help the NEXT work session. No filler, no restating the obvious.
${renderBodyStyleRule()}
- Write the page body in the SAME language as the session transcript / conversation (match the source; do not force or translate to a fixed language). Use English if the source language is unclear.
- Regardless of the prose language, keep code identifiers, file paths, function/API names, CLI commands, config keys, and error strings VERBATIM in their original form (do not translate or transliterate them) — they are the language-invariant search anchors of this wiki.
${renderTerminologyLine(cfg)}`;
}

// Small format helper that mirrors Python `str.format(**kwargs)` — only the named
// `{key}` placeholders are substituted, and literal braces inside `{...}` content
// in our prompts are preserved as-is (we only replace explicit known keys).
function formatPrompt(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(v);
  }
  return out;
}

export function writePromptTemplate(cfg: WikiConfig = getConfig()): string {
  return `You are the update writer for an LLM Wiki. Read the session transcript extract below
(user utterances and assistant conclusions) and produce ONE wiki page capturing the single most
useful takeaway from this session for future work. Pick the domain that fits best
(${renderDomainList(cfg)}) and set the \`domain:\` frontmatter field.

{schema}

Output format (strict): your ENTIRE output is saved verbatim as a \`.md\` file.
- Do not include explanation, preamble, closing remarks, or "I wrote ..." sentences. Do not use code fences (\`\`\`).
- **The very first character MUST be \`---\`** (YAML frontmatter). Emit no text before it.
- The footnote \`[^1]:\` must contain ONLY the bare filename \`{transcript_filename}\` — never append "(project: ...)" or any parenthetical. (For your context only, this session's project is: {repo_name}.)
- Be concise: a TL;DR followed by key-fact bullets. Do not invent anything that is not in the transcript.
- **Write the page body in the SAME language as the transcript / conversation** (match the source; do not translate to a fixed language). Use English if the source language is unclear.
${_terminologyWrite(cfg)}

=== TRANSCRIPT EXTRACT ===
{extract}
=== END EXTRACT ===

Now output only the page, starting with \`---\`:`;
}

const VERIFY_PROMPT = `You are a strict fact verifier. Below, [EXTRACT] is the raw source of one work session,
and [PAGE] is a wiki document that claims to summarize it. Decide whether every factual claim in
[PAGE] is **explicitly grounded** in [EXTRACT].

- If even one claim is unsupported (absent from the extract, exaggerated, or fabricated), list those claims as bullets.
- If every claim is grounded in the extract, output exactly the single word \`VERIFIED\`.

If the page contains judgment, interpretation, or decision sentences (which are not facts), flag those as well.

=== EXTRACT ===
{extract}
=== PAGE ===
{page}
=== END ===`;

/** Pull the wiki page out of a model reply, tolerating conversational wrapping.
 *
 * Headless models sometimes prepend a preamble (e.g. Korean "위키 페이지를 작성했습니다…" = "I wrote the wiki page…") or wrap
 * the page in a ```markdown fence. Locate the YAML frontmatter block and take from
 * the opening `---` line; if the page is fenced, prefer the fenced body. */
function _extractPage(text: string): string {
  text = text.trim();
  // Python: re.search(r"```(?:markdown|md)?\s*\n(---\n.*?)\n```", text, re.DOTALL)
  const fence = text.match(/```(?:markdown|md)?\s*\n(---\n[\s\S]*?)\n```/);
  if (fence) {
    return fence[1]!.trim();
  }
  // Python: re.search(r"(?m)^---[ \t]*$", text)
  const m = text.match(/^---[ \t]*$/m);
  if (m && m.index !== undefined) {
    return text.slice(m.index).trim();
  }
  return text; // no frontmatter found → caller rejects
}

export function _category(page: string, cfg: WikiConfig): string {
  // Map the page's declared domain to a category folder — config-driven (llmwiki.config.toml);
  // the default config reproduces the historical routing (fallback = 2_milestone).
  const m = page.match(/^domain:\s*(\w+)/m);
  return domainToDir(m ? m[1]! : "", cfg);
}

function _title(page: string): string {
  const m = page.match(/^title:\s*(.+)$/m);
  return m ? m[1]!.trim() : "";
}

function _slug(page: string): string {
  const t = _title(page);
  // Python: re.sub(r"[^\w가-힣]+", "-", ...) — \w in Python matches Unicode word chars
  // by default. In JS we need the `u` flag and \p{L}\p{N}_ to match. Keep 가-힣 explicit.
  const s = (t || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_가-힣]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, 48);
}

function _date(inc: Increment): string {
  for (const t of [...inc.assistants, ...inc.users]) {
    if (t.ts && t.ts.length >= 10) {
      return t.ts.slice(0, 10);
    }
  }
  return "0000-00-00";
}

function _stampDate(page: string, inc: Increment): string {
  // Python: re.sub(r"^date:\s*$", f"date: {_date(inc)}", page, flags=re.MULTILINE)
  return page.replace(/^date:\s*$/gm, `date: ${_date(inc)}`);
}

// Build a uniform human-review item for docs/wiki/0_review/: a plain Q./A. file the human
// reads and answers inline. On resolution the candidate is finalized into its category and
// this file is deleted — 0_review stays empty when idle. Labels and the question are English
// (scaffolding); the draft body matches the source language (content). Same shape the skills author.
export function _reviewWrapper(o: {
  kind: "quarantine" | "question";
  title: string;
  date: string;
  source: string;
  question: string;
  candidate: string;
}): string {
  return (
    `---\n` +
    `title: "[review] ${o.title.replace(/"/g, "'")}"\n` +
    `kind: ${o.kind}\n` +
    `status: pending\n` +
    `created: ${o.date}\n` +
    `source: ${o.source}\n` +
    `---\n\n` +
    `Q. ${o.question}\n\n` +
    `A. (write your decision below; on the next /wiki-save or /wiki-deep the LLM applies it and deletes this file)\n\n\n` +
    `Draft (candidate page; moved into the chosen N_category once confirmed):\n${o.candidate}\n`
  );
}

export async function updateOne(
  ws: string,
  transcriptPath: string,
  commit: boolean,
  writeModel?: string,
  verifyModel?: string,
): Promise<Record<string, any>> {
  const root = resolve(ws);
  const cfg = getConfig(root); // per-repo conventions (configs/ → root file → defaults)
  // An explicitly-passed model wins; otherwise fall back to the config-resolved tier
  // (env > toml [models] > builtin). Keeps default behavior byte-identical.
  const wm = writeModel ?? cfg.models.light;
  const vm = verifyModel ?? cfg.models.heavy;
  const ko = effectiveKo(cfg);
  const name = basename(root);
  const fn = basename(transcriptPath);
  const offset = capture.getOffset(transcriptPath);
  // Route to the parser the capture row was enqueued with. Legacy/claude rows →
  // extractIncrement (byte-identical to before); a `plain` drop → whole-tail-as-one-turn.
  const kind = capture.getSourceKind(transcriptPath);
  const inc = sourceForKind(kind).parse(transcriptPath, offset);
  // A claude extract needs ≥2 turns to be worth a page (its old guard). A `plain` drop is a
  // single document — one substantive turn is the whole point, so require only ≥1.
  const minTurns = kind === "plain" ? 1 : 2;
  if (inc.users.length + inc.assistants.length < minTurns) {
    return { transcript: fn, verdict: "skip", reason: ko ? "추출 신호 부족" : "insufficient extract signal" };
  }

  const extractTxt = render(inc);

  // Evidence layer: pull machine-recorded facts (files edited, commands
  // run, check results) from the SAME byte window's tool events. These are not LLM prose, so
  // they ground the draft against something the writer model could not fabricate.
  const evidence = collectGroundedFacts(transcriptPath, offset, kind);
  const supportText = extractTxt + "\n" + evidence.corpus;

  // 1) WRITE
  const raw = await llm(
    formatPrompt(writePromptTemplate(cfg), {
      schema: schemaText(cfg),
      transcript_filename: fn,
      repo_name: name,
      extract: extractTxt,
    }),
    wm,
  );
  let page = _extractPage(raw);
  if (raw.startsWith("__ERROR__") || !page.startsWith("---")) {
    return { transcript: fn, verdict: "fail-write", reason: raw.slice(0, 200) };
  }

  // Deterministic grounding check: a file path the page asserts that is
  // absent from ALL evidence (prose extract + tool events) is a fabrication signal — the hard
  // gate. Quantitative claims + lexical overlap are advisory (logged for calibration; VERIFY
  // already adjudicates them). No LLM, no embeddings.
  const grounding = assessGrounding(page, supportText);

  // 2) VERIFY (independent second model, adversarial)
  const verdict = await llm(
    formatPrompt(VERIFY_PROMPT, { extract: extractTxt, page }),
    vm,
  );
  // The prompt's contract: a fully-grounded page yields *exactly* the token VERIFIED and
  // nothing else; any unsupported claim is returned as bullets. So a reply that merely
  // *starts* with VERIFIED but carries caveats ("VERIFIED, but claim 3 is unsupported…")
  // is a FAILURE, not a pass. Accept only VERIFIED alone (tolerating trailing punctuation /
  // whitespace); any additional words mean findings → reject. (hardens the safety gate)
  const verified = /^VERIFIED[\s.!]*$/.test(verdict.trim().toUpperCase());

  // date stamp the page deterministically if model left it blank
  page = _stampDate(page, inc);

  // choose destination. By design, ONLY direction shifts (1_direction) go to the human
  // queue (0_review). milestone/decision/insight are adjudicated by the independent Opus
  // VERIFY pass — accepted as `ready` when grounded, otherwise rejected (omitted). Quality
  // failures never land in the human queue, which is reserved for strategic direction.
  const cat = _category(page, cfg);
  const isDirection = isHumanReviewDir(cat, cfg); // review="human" categories route to the queue
  const titleSlug = _slug(page) || fn.slice(0, 8);
  const subdir = isDirection ? cfg.queueDir : cat;
  const dest = join(root, "docs", "wiki", subdir, `${_date(inc)}-${titleSlug}.md`);

  // Grounding gate: Phase A is the MEASUREMENT phase — the grounding signal is
  // recorded and surfaced but does NOT block acceptance by default (advisory), so we can
  // calibrate false-reject/accept before it ever drops a page (avoiding the earlier failure mode
  // of silently quarantining good work). Only LLMWIKI_GROUNDING_MODE=strict turns it into a
  // hard gate (Phase C, after calibration). In advisory mode `grounded` is always true.
  const groundingStrict =
    (process.env.LLMWIKI_GROUNDING_MODE ?? "advisory").trim().toLowerCase() === "strict";
  const groundedClean = grounding.unsupportedPaths.length === 0;
  const grounded = groundingStrict ? groundedClean : true;

  const result: Record<string, any> = {
    transcript: fn,
    verdict: isDirection ? "direction-review" : verified && grounded ? "verified" : "rejected",
    dest: relpath(root, dest),
    category: cat,
    verify_note: verified ? "" : verdict.slice(0, 300),
    new_offset: inc.newOffset,
    grounding: {
      mode: groundingStrict ? "strict" : "advisory",
      fact_count: evidence.facts.length,
      unsupported_paths: grounding.unsupportedPaths,
      unsupported_quant: grounding.unsupportedQuant,
      overlap: grounding.overlap,
      // in advisory mode, would the strict gate have rejected this page? (calibration signal)
      would_reject: !groundedClean,
    },
  };
  if (!commit) {
    result.dry_run = true;
    return result;
  }

  const idx = new WikiIndex(ws);
  idx.registerTranscript(transcriptPath, inc.sessionId);

  // 3a) DIRECTION → human queue. The human owns strategic direction: wrap the
  // candidate as a Q./A. review item in 0_review and DO NOT advance the watermark (it stays
  // pending so it resurfaces until the human confirms it into 1_direction/).
  if (isDirection) {
    // Prose names the category from config (stock: "direction shift … `1_direction/`", byte-identical).
    const catDomain = cfg.categories.find((c) => c.dir === cat)?.domain ?? cat;
    const qdest = join(root, "docs", "wiki", cfg.queueDir, `${_date(inc)}-${titleSlug}.md`);
    mkdirSync(join(qdest, ".."), { recursive: true });
    writeFileSync(
      qdest,
      _reviewWrapper({
        kind: "question",
        title: _title(page) || fn.slice(0, 8),
        date: _date(inc),
        source: fn,
        question: `A ${catDomain} shift (from→to) appears in this session. Confirm and promote to \`${cat}/\`, or discard?`,
        candidate: page,
      }),
      "utf-8",
    );
    idx.indexAll();
    result.dest = relpath(root, qdest);
    result.accepted = false;
    return result;
  }

  // 3b) NON-DIRECTION → write to its category, register provenance, run deterministic LINT.
  mkdirSync(join(dest, ".."), { recursive: true });
  // Attach portable evidence before the page leaves this machine — the transcript is open right
  // here, and on any other clone it will not be readable at all (page format v3).
  // (Authorship is deliberately NOT stamped: git already records it — decision 2026-07-10.)
  page = ensureExcerpts(page, transcriptPath, offset);
  writeRepoFile(dest, page + (page.endsWith("\n") ? "" : "\n"));
  idx.indexAll();
  const conn = idx.connect();
  const destName = basename(dest);
  const doc = idx
    .listDocumentsWithContent(conn)
    .find((d) => String(d.relative_path).endsWith(destName));
  if (doc) {
    updateReferences(idx, conn, doc, page);
  }
  // WikiIndex's row type (DocRow = open-shape) is wider than Linter's WikiDoc; the
  // runtime rows have all required fields. Cast at the boundary, no runtime cost.
  const [issues] = new Linter(idx as unknown as WikiIndexLike, conn, cfg).run("*", "wiki");
  conn.close();
  const pageErrors: LintIssue[] = issues.filter(
    (i) => i.severity === "error" && i.path.includes(destName),
  );

  // Accept when Opus-verified AND lint-clean AND grounded (no fabricated file paths) →
  // `ready`, no human.
  if (verified && grounded && pageErrors.length === 0) {
    update.appendLog(
      ws,
      "autoupdate",
      _title(page) || fn.slice(0, 8),
      [
        `${subdir}/${destName} ${ko ? "(Opus 확정·ready)" : "(strong-model confirmed·ready)"}`,
        `${ko ? "출처" : "source"}: ${fn}`,
      ],
      _date(inc),
    );
    capture.mark(transcriptPath, inc.newOffset, "distilled");
    result.accepted = true;
    return result;
  }

  // Opus rejected (ungrounded) or lint error → omit. By design, do NOT escalate to the
  // human queue (0_review is direction-only). Remove the page, log the reason, and advance
  // the watermark as 'skipped' (the raw transcript is preserved immutably and can be
  // reprocessed). This supersedes the earlier rule that rejection never advanced the watermark.
  const reasonBits: string[] = [];
  if (!verified) reasonBits.push(`${ko ? "2차검증 실패" : "2nd-pass verify failed"} — ${verdict.trim().slice(0, 200)}`);
  if (!grounded)
    reasonBits.push(
      `${ko ? "근거 없는 파일경로" : "ungrounded file path(s)"} — ${grounding.unsupportedPaths.join(", ")}`,
    );
  if (pageErrors.length > 0) reasonBits.push(`${ko ? "lint 오류" : "lint error"} — ${pageErrors.map((i) => i.code).join(", ")}`);
  if (existsSync(dest)) rmSync(dest);
  idx.indexAll();
  update.appendLog(
    ws,
    "autoupdate",
    _title(page) || fn.slice(0, 8),
    [`${ko ? "기각(omit)" : "rejected (omit)"} — ${reasonBits.join(" / ")}`, `${ko ? "출처" : "source"}: ${fn}`],
    _date(inc),
  );
  capture.mark(transcriptPath, inc.newOffset, "skipped");
  result.verdict = "rejected";
  result.accepted = false;
  if (pageErrors.length > 0) {
    result.lint_errors = pageErrors.map((i) => `${i.code}:${i.path}`);
  }
  return result;
}

export async function run(
  ws: string,
  commit = false,
  limit = 0,
  writeModel?: string,
  verifyModel?: string,
): Promise<Record<string, any>[]> {
  const cfg = getConfig(ws);
  const ko = effectiveKo(cfg);
  // An explicitly-passed model wins; otherwise use the config-resolved tier
  // (env > toml [models] > builtin).
  const wm = writeModel ?? cfg.models.light;
  const vm = verifyModel ?? cfg.models.heavy;
  // The adversarial gate's whole premise is that VERIFY is an *independent* second model.
  // If both tiers resolve to the same model, WRITE is grading its own work and
  // the gate adds no independent check. We don't hard-fail (a single capable model is a legitimate budget
  // setup), but we surface it so the operator knows the independence guarantee is void.
  if (wm === vm) {
    process.stderr.write(
      (ko
        ? `⚠️  WRITE·VERIFY 모델이 동일(${wm}) — 2차검증이 자기 채점이 됨(독립성 상실). ` +
          `LLMWIKI_MODEL_HEAVY 를 다른 tier 로 두는 것을 권장.\n`
        : `⚠️  WRITE and VERIFY resolve to the same model (${wm}) — the 2nd-pass verify is ` +
          `self-grading (independence lost). Point LLMWIKI_MODEL_HEAVY at a different tier.\n`),
    );
  }
  let pend = update.pending(ws);
  if (limit) {
    pend = pend.slice(0, limit);
  }
  const out: Record<string, any>[] = [];
  for (const r of pend) {
    out.push(await updateOne(ws, r.transcript_path, commit, wm, vm));
  }
  return out;
}
