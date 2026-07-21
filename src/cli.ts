#!/usr/bin/env bun
// llmwiki — local-first compounding wiki engine (CLI).
// Markdown under <workspace>/docs/wiki is the source of truth; .llmwiki/index.db is a
// rebuildable derived index. No server, no MCP registration required.
import { WikiIndex, dedupeByPage } from "./engine/db.ts";
import * as excerpt from "./engine/excerpt.ts";
import { updateReferences, autoRegisterCitedTranscripts } from "./engine/refs.ts";
import { effectiveKo, getConfig, CONFIG_BASENAME, CONFIGS_DIR } from "./engine/config.ts";
import { migrate } from "./engine/migrate.ts";
import { Linter, formatReport } from "./engine/lint.ts";
import * as update from "./engine/update.ts";
import { sourceForPath } from "./engine/source.ts";
import * as autoupdate from "./engine/autoupdate.ts";
import { review } from "./engine/review.ts";
import { normalizeOverview } from "./engine/overview.ts";
import { refreshGapQueue } from "./engine/gaps.ts";
import { runDoctor } from "./engine/doctor.ts";
import { buildContext } from "./engine/context.ts";
import { buildTurnContext } from "./engine/turncontext.ts";
import { buildDigest, buildTopicView } from "./engine/synthesis.ts";
import { auditContext, formatAudit } from "./engine/context-audit.ts";
import { ingest } from "./engine/ingest.ts";
import * as capture from "./engine/capture.ts";
import * as consolidate from "./engine/consolidate.ts";
import { reconcileReflected } from "./engine/reconcile.ts";
import * as quiz from "./engine/quiz.ts";
import { runBench, writeResults } from "./engine/bench.ts";
import { verifyDistillFiles } from "./engine/distill.ts";
import { runArm, loadArm, judgeArms } from "./engine/compare.ts";
import { CLONE_ROOT } from "./engine/paths.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// User-facing CLI output adapts to LLMWIKI_LANG (default English, Korean when set) — same
// policy as the cold-start context/digest. LLM-facing prompts stay English by design.
// Initialized from the global config; re-resolved per-workspace after arg parsing (bottom of file).
let LANG = effectiveKo() ? "ko" : "en";
let ko = LANG === "ko";

// ---- tiny arg parser (replaces argparse) ----
interface Parsed {
  cmd: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const cmd = argv[0] ?? "";
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  // Flags that take a value (others are boolean switches). MISSING AN ENTRY FAILS SILENTLY: the
  // flag parses as `true`, its value falls through to positionals, and the command runs happily
  // with a default — `excerpt --offset N` quoted the wrong part of a transcript and `migrate
  // --map old=new` applied no mapping, both without a word. tests/cli-flags.test.ts pins this set
  // against every flag cli.ts reads as a value, so adding a value flag without listing it fails.
  const valueFlags = new Set([
    "--path", "--scope", "--limit", "--kind", "--session", "--offset", "--map",
    "--write-model", "--verify-model", "--source", "--dest", "--model", "--date", "--min-pages",
    "--repo", "--max-pages", "--prompt", "--corpus", "--label",
    "--page", "--result", "--question",
  ]);
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      if (valueFlags.has(a)) {
        flags[a] = argv[++i] ?? "";
      } else {
        flags[a] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { cmd, positionals, flags };
}

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(2);
}

function idx(ws: string): WikiIndex {
  return new WikiIndex(ws);
}

// Rebuild the citation/link reference graph for all wiki pages. Shared by `refs`, and
// auto-run after `index`/`reindex` so a file move never leaves a stale graph (which
// surfaces as citation-graph-mismatch lint errors). Returns edge + page counts.
function rebuildRefs(w: WikiIndex): { tc: number; tl: number; pages: number } {
  autoRegisterCitedTranscripts(w); // durable provenance self-heal before materializing edges
  const conn = w.connect();
  const docs = w
    .listDocumentsWithContent(conn)
    .filter((d) => String(d.relative_path).includes("docs/wiki/"));
  let tc = 0;
  let tl = 0;
  for (const d of docs) {
    const [c, l] = updateReferences(w, conn, d as any, (d.content as string) || "");
    tc += c;
    tl += l;
  }
  conn.close();
  return { tc, tl, pages: docs.length };
}

// ---- command handlers ----

function cmdInit(p: Parsed) {
  const ws = p.positionals[0] ?? die("init <workspace> required");
  const w = idx(ws);
  w.init();
  // Scaffold the category folders (config-aware: custom [[category]] conventions win) so a
  // newcomer's first page has a place to land without first learning the folder layout —
  // fresh-install E2E (2026-07-21) showed init leaving docs/wiki/ empty and the first write
  // failing on the missing category dir. Idempotent: re-running init re-creates a deleted dir.
  const cfg = getConfig(w.root);
  const scaffold = [cfg.queueDir, ...cfg.categories.map((c) => c.dir), cfg.topicDir];
  for (const d of scaffold) mkdirSync(join(w.root, "docs", "wiki", d), { recursive: true });
  update.ensurePrivateDirs(w.root, cfg);
  const [neu] = w.indexAll();
  // Materialize the citation/link graph too (same as `index`). Without this, a fresh clone's
  // first `lint` right after setup.sh's `init` reports a spurious citation-graph-mismatch on
  // any page that has footnotes (e.g. the EXAMPLE page) — a bad first impression for adopters.
  const r = rebuildRefs(w);
  console.log(`✓ Initialized ${w.root}`);
  console.log(`  docs/wiki/ + .llmwiki/index.db created; indexed ${neu} file(s)`);
  console.log(`  categories scaffolded: ${scaffold.join(" · ")}`);
  if (cfg.privateDirs.length) console.log(`  private (local-only, auto-gitignored): ${cfg.privateDirs.join(" · ")}`);
  console.log(`  refs: ${r.tc} citation, ${r.tl} link edge(s) across ${r.pages} page(s)`);
}

function cmdIndex(p: Parsed) {
  const ws = p.positionals[0] ?? die("index <workspace> required");
  const w = idx(ws);
  const [neu, updated] = w.indexAll();
  const r = rebuildRefs(w);
  console.log(`✓ Indexed: ${neu} new, ${updated} updated (unchanged skipped via content_hash)`);
  console.log(`  refs: ${r.tc} citation, ${r.tl} link edge(s) across ${r.pages} page(s)`);
}

function cmdReindex(p: Parsed) {
  const ws = p.positionals[0] ?? die("reindex <workspace> required");
  const w = idx(ws);
  const [neu] = w.reindex();
  const r = rebuildRefs(w);
  console.log(`✓ Reindexed from disk: ${neu} file(s)`);
  console.log(`  refs: ${r.tc} citation, ${r.tl} link edge(s) across ${r.pages} page(s)`);
}

function cmdRefs(p: Parsed) {
  const ws = p.positionals[0] ?? die("refs <workspace> required");
  const { tc, tl, pages } = rebuildRefs(idx(ws));
  console.log(`✓ Reference graph rebuilt: ${tc} citation edge(s), ${tl} link edge(s) across ${pages} page(s)`);
}

function cmdLint(p: Parsed) {
  const ws = p.positionals[0] ?? die("lint <workspace> required");
  const w = idx(ws);
  const conn = w.connect();
  const path = (p.flags["--path"] as string) ?? "*";
  const scope = (p.flags["--scope"] as string) ?? "all";
  const [issues, checked] = new Linter(w as any, conn, getConfig(ws)).run(path, scope);
  conn.close();
  console.log(formatReport(issues, checked, basename(w.root), { errorsOnly: !!p.flags["--errors-only"] }));
  if (issues.some((i) => i.severity === "error")) process.exit(1);
}

// Chunk over-fetch factor for page-level results: ask for K×this chunks so that after collapsing
// to one row per page there are still K pages to show. 5 matches the factor bench.ts already used
// for the same reason; a page rarely contributes more than a handful of matching chunks.
const PAGE_FANOUT = 5;

function cmdSearch(p: Parsed) {
  const ws = p.positionals[0] ?? die("search <workspace> <query> required");
  const query = p.positionals[1] ?? die("search <workspace> <query> required");
  const limit = p.flags["--limit"] ? parseInt(p.flags["--limit"] as string, 10) : 10;
  const kind = (p.flags["--kind"] as string) ?? null;
  const w = idx(ws);
  const conn = w.connect();
  // Over-fetch chunks, then collapse to one row per page: a reader wants the top-K distinct
  // PAGES, and several chunks of one page would otherwise consume several slots (dedupeByPage).
  const rows = dedupeByPage(w.search(conn, query, limit * PAGE_FANOUT, kind), limit);
  conn.close();
  if (!rows.length) {
    console.log("(no matches)");
    return;
  }
  for (const r of rows) {
    const bc = r.header_breadcrumb ? ` [${r.header_breadcrumb}]` : "";
    console.log(`• ${r.relative_path}${bc}`);
    const snippet = String(r.content || "").split(/\s+/).filter(Boolean).join(" ").slice(0, 200);
    console.log(`    ${snippet}`);
  }
}

// Candidate evidence excerpts for a transcript (page format v3). Exists so a warm session REQUESTS
// an excerpt instead of composing one from memory: everything here is screened for secrets and
// capped by the engine, and quotes come out verbatim rather than paraphrased.
function cmdExcerpt(p: Parsed) {
  const transcript = p.positionals[0] ?? die("excerpt <transcript.jsonl> [--offset N] [--kind fact|judgment]");
  const offset = parseInt(String(p.flags["--offset"] ?? "0"), 10) || 0;
  const want = (p.flags["--kind"] as string) ?? null;
  const limit = p.flags["--limit"] ? parseInt(String(p.flags["--limit"]), 10) || 20 : undefined;
  const all = excerpt.mintExcerpts(transcript, offset, { limit });
  const rows = want ? all.filter((e) => e.kind === want) : all;
  if (!rows.length) {
    console.log(ko ? "(발췌 후보 없음)" : "(no excerpt candidates)");
    return;
  }
  for (const e of rows) console.log(`${e.kind === "fact" ? "F" : "J"} ${excerpt.renderExcerpt(e).trim()}`);
  const redacted = rows.filter((e) => e.redactions.length).length;
  if (redacted)
    console.log(
      ko
        ? `  ⚠ ${redacted}건에서 비밀정보가 가려짐(«redacted») — 그대로 사용해도 안전하다`
        : `  ⚠ ${redacted} excerpt(s) had secrets redacted («redacted») — safe to use as-is`,
    );
}

function cmdUpdateStatus(p: Parsed) {
  const ws = p.positionals[0] ?? die("update-status <workspace> required");
  const rows = update.pending(ws);
  if (!rows.length) {
    console.log("✓ No pending transcripts to update.");
    return;
  }
  console.log(`${rows.length} transcript(s) pending update:`);
  for (const r of rows) {
    console.log(`  • sess ${(r.session_id || "?").slice(0, 8)} @offset ${r.byte_offset} | ${r.transcript_path}`);
  }
}

function cmdUpdateNext(p: Parsed) {
  const ws = p.positionals[0] ?? die("update-next <workspace> <transcript> required");
  const transcript = p.positionals[1] ?? die("update-next <workspace> <transcript> required");
  update.ensureSkeleton(ws);
  const inc = update.nextIncrement(ws, transcript);
  console.log(
    `# cwd=${inc.cwd} session=${inc.sessionId} new_offset=${inc.newOffset} ` +
      `users=${inc.nUsers} assistants=${inc.nAssistants}`,
  );
  // P2: surface a summary the harness ALREADY wrote (session-memory / compact / rollout
  // summary) as draft material — the condense pass must still ground claims in the raw
  // extract below (harness summary = material, wiki = record of record).
  try {
    const summary = sourceForPath(transcript).summaryFor?.(transcript);
    if (summary) {
      console.log(
        "=== harness summary (pre-written by the harness — reuse as draft material; ground every claim in the extract below) ===",
      );
      console.log(summary);
      console.log("=== end harness summary ===");
    }
  } catch {
    /* opportunistic — never break update-next */
  }
  console.log(inc.rendered);
}

function cmdUpdateDone(p: Parsed) {
  const ws = p.positionals[0] ?? die("update-done <workspace> <transcript> <offset> required");
  const transcript = p.positionals[1] ?? die("update-done <workspace> <transcript> <offset> required");
  const offset = parseInt(p.positionals[2] ?? die("offset required"), 10);
  const skipped = !!p.flags["--skipped"];
  update.markUpdated(ws, transcript, offset, skipped);
  console.log(`✓ watermark advanced to ${offset} (${skipped ? "skipped" : "distilled"})`);
}

function cmdUpdateEnqueue(p: Parsed) {
  const ws = p.positionals[0] ?? die("update-enqueue <workspace> <transcript> required");
  const transcript = p.positionals[1] ?? die("update-enqueue <workspace> <transcript> required");
  const session = (p.flags["--session"] as string) ?? null;
  update.enqueue(ws, transcript, session);
  console.log(`✓ enqueued ${transcript}`);
}

function cmdSkeleton(p: Parsed) {
  const ws = p.positionals[0] ?? die("skeleton <workspace> required");
  update.ensureSkeleton(ws);
  console.log(`✓ wiki skeleton ensured at ${ws}/docs/wiki`);
}

async function cmdAutoupdate(p: Parsed) {
  const ws = p.positionals[0] ?? die("autoupdate <workspace> required");
  const commit = !!p.flags["--commit"];
  const limit = p.flags["--limit"] ? parseInt(p.flags["--limit"] as string, 10) : 0;
  const writeModel = (p.flags["--write-model"] as string) ?? autoupdate.WRITE_MODEL;
  const verifyModel = (p.flags["--verify-model"] as string) ?? autoupdate.VERIFY_MODEL;
  const rows = await autoupdate.run(ws, commit, limit, writeModel, verifyModel);
  if (!rows.length) {
    console.log("✓ No pending transcripts.");
    return;
  }
  const mode = commit ? "COMMIT" : "DRY-RUN";
  // Always name the TARGET REPO in the header: a write command aimed via a relative path from
  // the wrong cwd is otherwise invisible until pages land in the wrong wiki (measured friction,
  // 2026-07-07 multi-repo lifecycle test).
  console.log(`=== autoupdate [${mode}] ${rows.length} transcript(s) → ${resolve(ws)} ===`);
  for (const r of rows) {
    let line = `  [${r.verdict}] ${String(r.transcript).slice(0, 12)}`;
    if (r.dest) line += ` → ${r.dest}`;
    console.log(line);
    if (r.verify_note) console.log(`      ⚠️ ${ko ? "2차검증" : "2nd-pass verify"}: ${String(r.verify_note).slice(0, 160)}`);
    if (r.grounding) {
      const g = r.grounding;
      const bits = [`${ko ? "사실" : "facts"}=${g.fact_count}`, `overlap=${g.overlap}`];
      if (g.unsupported_paths?.length) bits.push(`${ko ? "근거없는경로" : "ungrounded-paths"}=[${g.unsupported_paths.join(", ")}]`);
      if (g.unsupported_quant?.length) bits.push(`${ko ? "근거없는수치" : "ungrounded-quant"}=[${g.unsupported_quant.join(", ")}]`);
      // advisory calibration marker: the strict gate WOULD have dropped this page
      if (g.mode === "advisory" && g.would_reject) bits.push(ko ? "⟦strict면 기각⟧" : "⟦strict→reject⟧");
      console.log(`      · ${ko ? "결속" : "grounding"}[${g.mode}]: ${bits.join("  ")}`);
    }
    if (r.lint_errors) console.log(`      ⚠️ lint: ${JSON.stringify(r.lint_errors)}`);
    if (r.reason) console.log(`      reason: ${String(r.reason).slice(0, 120)}`);
  }
  const acc = rows.filter((r) => r.accepted).length;
  const dir = rows.filter((r) => r.verdict === "direction-review").length;
  const rej = rows.filter((r) => r.verdict === "rejected").length;
  console.log(
    `--- accepted=${acc}(ready) direction-review=${dir}→0_review(${ko ? "사람" : "human"}) rejected=${rej}(omit) ` +
      (ko
        ? `(방향성만 사람 판단·나머지는 강한 모델이 판정, current-state.md 미수정)`
        : `(only direction goes to the human; the rest is adjudicated by the strong model; current-state.md untouched)`),
  );
}

async function cmdReview(p: Parsed) {
  const ws = p.positionals[0] ?? die("review <workspace> required");
  const commit = !!p.flags["--commit"];
  const date = (p.flags["--date"] as string) || new Date().toISOString().slice(0, 10);
  const r = await review(ws, {
    commit,
    minPages: p.flags["--min-pages"] ? parseInt(p.flags["--min-pages"] as string, 10) : 2,
    maxPages: p.flags["--max-pages"] ? parseInt(p.flags["--max-pages"] as string, 10) : undefined,
    force: !!p.flags["--force"],
    ifDue: !!p.flags["--if-due"],
    model: (p.flags["--model"] as string) ?? undefined,
    date,
  });
  const mode = commit ? "COMMIT" : "DRY-RUN";
  console.log(`=== review [${ko ? "의미 lint" : "semantic lint"} · ${mode}] ${ws} ===`);
  // Backgrounded runs have no terminal to error into — this line is the only place a silent
  // death becomes visible, so print it on every verdict, skip included.
  if (r.prev_launch_incomplete) {
    console.log(
      ko
        ? `  ⚠️  ${r.prev_launch_incomplete} 발사된 리뷰가 커밋 없이 종료됨 (백그라운드 사망 또는 아직 진행 중) — cadence 게이트가 재실행을 보장`
        : `  ⚠️  a review launched ${r.prev_launch_incomplete} never committed (backgrounded run died or still running) — the cadence gate guarantees a re-run`,
    );
  }
  if (r.verdict === "skip") {
    console.log(`  ⏭  ${r.reason}`);
    return;
  }
  if (r.verdict !== "reviewed") {
    console.log(`  ❌ ${r.verdict}: ${String(r.reason || "").slice(0, 200)}`);
    return;
  }
  const scopeTxt = r.scope?.bounded
    ? ko
      ? ` (범위 한정: ${r.scope.included}/${r.scope.total}p — 최근+태그이웃)`
      : ` (bounded: ${r.scope.included}/${r.scope.total}p — recent+tag-neighbors)`
    : "";
  console.log(
    `  ✅ ${r.n_pages}p ${ko ? "검사" : "checked"}${scopeTxt}` +
      (r.dry_run ? (ko ? " [dry-run, 미기록]" : " [dry-run, not written]") : ` → ${r.dest} (advisory draft)`),
  );
  if (r.preview) {
    console.log(ko ? "  --- 미리보기 ---" : "  --- preview ---");
    for (const ln of String(r.preview).split("\n").slice(0, 16)) console.log(`  ${ln}`);
  }
  console.log(
    ko
      ? "  ※ advisory — 기존 페이지를 고치지 않음. 사람이 검토 후 반영."
      : "  ※ advisory — existing pages are not edited; the human reviews and applies.",
  );
}

// Drop-a-source: condense an arbitrary file into the wiki without the daemon (and, for a
// plain file with no LLM CLI, without an LLM — debt is recorded). The adapter is inferred
// from the path (or forced with --source); --repo routes the produced page's destination.
async function cmdIngest(p: Parsed) {
  const ws = p.positionals[0] ?? die("ingest <workspace> <file> required");
  const file = p.positionals[1] ?? die("ingest <workspace> <file> required");
  const r = await ingest(ws, file, {
    repo: (p.flags["--repo"] as string) ?? undefined,
    commit: !!p.flags["--commit"],
    source: (p.flags["--source"] as string) ?? undefined,
    force: !!p.flags["--force"],
  });
  const mode = p.flags["--commit"] ? "COMMIT" : "DRY-RUN";
  console.log(`=== ingest [${mode}] ${file} (source=${r.source_kind} → repo=${r.repo}) ===`);
  console.log(`  [${r.verdict}]${r.dest ? ` → ${r.dest}` : ""}`);
  if (r.reason) console.log(`      reason: ${String(r.reason).slice(0, 160)}`);
  if (r.verify_note) console.log(`      ⚠️ ${ko ? "2차검증" : "2nd-pass verify"}: ${String(r.verify_note).slice(0, 160)}`);
  if (r.lint_errors) console.log(`      ⚠️ lint: ${JSON.stringify(r.lint_errors)}`);
}

// Register session transcript(s) as citable provenance sources so decision/insight pages can
// cite the real session (not a repointed code file). With a transcript arg, registers that one;
// otherwise registers every transcript the central queue has seen for this repo whose file still
// exists. A warm /wiki-fast runs this before lint so `[^1]: <transcript>.jsonl` resolves.
function cmdRegisterTranscript(p: Parsed) {
  const ws = p.positionals[0] ?? die("register-transcript <workspace> [transcript] required");
  const idx = new WikiIndex(ws);
  const one = p.positionals[1];
  let n = 0;
  if (one) {
    idx.registerTranscript(resolve(one), (p.flags["--session"] as string) ?? null);
    n = 1;
  } else {
    for (const t of capture.transcriptsForRepo(resolve(ws))) {
      if (existsSync(t.path)) {
        idx.registerTranscript(t.path, t.session);
        n++;
      }
    }
  }
  console.log(`✓ registered ${n} transcript(s) as citable sources in ${basename(resolve(ws))}`);
}

function cmdDoctor(p: Parsed) {
  process.exit(runDoctor(!!p.flags["--fix"]));
}

// Cold-start read-injection blob for <repo> (default: cwd). Harness-neutral: the Claude
// SessionStart hook calls this; other harnesses run it from AGENTS.md or a startup prompt.
function cmdContext(p: Parsed) {
  const repo = p.positionals[0] || process.cwd();
  process.stdout.write(buildContext(repo) + "\n");
}

// Per-turn read-injection pointers for <repo>. Harness-neutral: Claude Code /
// Codex UserPromptSubmit hooks pipe their stdin JSON ({prompt, session_id, cwd}) straight
// through; other harnesses pass --prompt. Pointers only, silent when unconfident, exit 0
// always — a turn-context failure must never break a session.
async function cmdTurnContext(p: Parsed) {
  let prompt = (p.flags["--prompt"] as string) ?? "";
  let sessionId = (p.flags["--session"] as string) ?? "";
  let repo = p.positionals[0] ?? "";
  if (!prompt && !process.stdin.isTTY) {
    try {
      const payload = JSON.parse(await Bun.stdin.text());
      prompt = String(payload.prompt ?? "");
      sessionId ||= String(payload.session_id ?? "");
      repo ||= String(payload.cwd ?? "");
    } catch {
      /* not JSON / empty stdin → stay silent below */
    }
  }
  repo ||= process.cwd();
  const out = prompt ? buildTurnContext(repo, prompt, sessionId) : "";
  if (out) process.stdout.write(out + "\n");
}

// Deterministic relational synthesis: a regenerable digest assembled
// from the grounded citation graph — links/hubs/freshness/open-items, no LLM, no new claims.
function cmdDigest(p: Parsed) {
  const repo = p.positionals[0] || process.cwd();
  process.stdout.write(buildDigest(repo) + "\n");
}

// Advisory hygiene audit of agent-config files (CLAUDE.md/AGENTS.md/MEMORY.md) that harnesses inject
// every session. Read-only — never edits them. Absent files are skipped.
function cmdContextAudit(p: Parsed) {
  const repo = resolve(p.positionals[0] || process.cwd());
  console.log(formatAudit(repo, auditContext(repo)));
}

// optional feature: print the team's git conventions doc (reference/git-strategy.md) if present.
function cmdGitRules(_p: Parsed) {
  const doc = join(CLONE_ROOT, "reference", "git-strategy.md");
  if (!existsSync(doc)) {
    // reference/ is gitignored (repo-local), so the file's absence is expected, not an
    // error — degrade gracefully instead of exit 1.
    console.log(
      ko
        ? `git-rules는 reference/git-strategy.md(팀 git 규칙 문서, 선택 사항)를 출력합니다 — 이 클론엔 그 파일이 없습니다.`
        : `git-rules prints reference/git-strategy.md (an optional team git-conventions doc) — that file is absent in this clone.`,
    );
    return;
  }
  console.log(readFileSync(doc, "utf-8"));
}

function basename(pth: string): string {
  const parts = pth.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : pth;
}

// ---- dispatch ----
async function cmdReconcile(p: Parsed) {
  const ws = p.positionals[0] ?? die("reconcile <workspace> required");
  const commit = !!p.flags["--commit"];
  const r = reconcileReflected(resolve(ws), commit);
  const mode = commit ? "COMMIT" : "DRY-RUN";
  console.log(`=== reconcile [${mode}] ${ws} ===`);
  console.log(
    ko
      ? `  인용 근거로 정산: ${r.reconciled.length}건 ${commit ? "반영 표시함" : "표시 예정"} / cited·부분 업데이트(tail은 autoupdate·deep 몫) ${r.deferred.length}건 / 진짜 백로그(미인용) ${r.backlog.length}건`
      : `  reconciled by citation: ${r.reconciled.length} ${commit ? "marked distilled" : "would mark"} / cited-but-partial (tail → autoupdate·deep) ${r.deferred.length} / true backlog (un-cited): ${r.backlog.length}`,
  );
  if (r.reconciled.length) console.log(`  ✓ ${r.reconciled.join(", ")}`);
  if (r.deferred.length)
    console.log(`  ↩ ${ko ? "cited·부분 업데이트(백로그 아님, tail 이월)" : "cited-but-partial (not backlog; tail deferred)"}: ${r.deferred.join(", ")}`);
  if (r.backlog.length) console.log(`  ⏳ ${ko ? "미반영(진짜 백로그, 미인용)" : "un-reflected (true backlog, un-cited)"}: ${r.backlog.join(", ")}`);
}

// Topic consolidation: fold the per-session log into the per-concept topic encyclopedia
// (docs/wiki/5_topic). Dry-run (default) surfaces candidate concepts for a warm /wiki-fast to
// merge by hand; --commit runs the gated unattended merge (write → independent verify →
// grounding → lint), advancing consolidate's own watermark (NOT the log's capture queue).
async function cmdConsolidate(p: Parsed) {
  const ws = p.positionals[0] ?? die("consolidate <workspace> required");
  const commit = !!p.flags["--commit"];
  const limit = p.flags["--limit"] ? parseInt(p.flags["--limit"] as string, 10) : 0;

  if (!commit) {
    const cands = consolidate.surfaceCandidates(ws);
    if (!cands.length) {
      console.log(ko ? "✓ 통합할 세션 없음 (모두 반영됨)." : "✓ No sessions to consolidate.");
      return;
    }
    console.log(
      ko
        ? `=== consolidate [후보 — 5_topic 통합 대상] ${cands.length} 세션 ===`
        : `=== consolidate [candidates — for 5_topic] ${cands.length} session(s) ===`,
    );
    for (const c of cands) {
      console.log(`  • ${c.transcript.slice(0, 16)}  users=${c.nUsers} assistants=${c.nAssistants}`);
      if (c.matchedTopics.length) {
        console.log(`      ${ko ? "기존 주제 언급" : "mentions existing topics"}: ${c.matchedTopics.join(", ")}`);
      }
    }
    console.log(
      ko
        ? "  → 웜 /wiki-fast 에서 재발·내구 개념만 선별해 5_topic 페이지로 병합 (또는 --commit 로 무인 게이트 실행)."
        : "  → in a warm /wiki-fast, merge only durable/recurring concepts into 5_topic (or run --commit for the gated pass).",
    );
    return;
  }

  const rows = await consolidate.run(ws, true, limit);
  if (!rows.length) {
    console.log(ko ? "✓ 통합할 세션 없음." : "✓ No sessions to consolidate.");
    return;
  }
  console.log(`=== consolidate [COMMIT] ${rows.length} ${ko ? "세션" : "session(s)"} ===`);
  for (const r of rows) {
    let line = `  [${r.verdict}] ${String(r.transcript).slice(0, 12)}`;
    if (r.topic) line += ` — ${r.topic}${r.merging ? (ko ? " (병합)" : " (merge)") : ""}`;
    if (r.dest) line += ` → ${r.dest}`;
    console.log(line);
    if (r.verify_note) console.log(`      ⚠️ ${ko ? "2차검증" : "verify"}: ${String(r.verify_note).slice(0, 160)}`);
    if (r.grounding?.unsupported_paths?.length) {
      console.log(`      · ${ko ? "근거없는경로" : "ungrounded-paths"}=[${r.grounding.unsupported_paths.join(", ")}]`);
    }
    if (r.lint_errors) console.log(`      ⚠️ lint: ${JSON.stringify(r.lint_errors)}`);
    if (r.reason) console.log(`      reason: ${String(r.reason).slice(0, 120)}`);
  }
  const acc = rows.filter((r) => r.accepted).length;
  const rej = rows.filter((r) => r.verdict === "rejected").length;
  const none = rows.filter((r) => r.verdict === "no-topic" || r.verdict === "no-new-claims").length;
  console.log(
    ko
      ? `--- 병합 ${acc}(ready) / 기각 ${rej}(omit) / 주제없음 ${none} (raw transcript 불변, current-state 미수정)`
      : `--- merged=${acc}(ready) rejected=${rej}(omit) no-topic=${none} (raw transcript immutable, current-state untouched)`,
  );
}

// Deterministic no-loss gate for a topic-page re-distillation (deep pass D3, LLM-0):
// verifies the rewritten page kept every citation source and every `> [conflict]` callout
// of the pre-distill snapshot. Exit 1 on any drop, so the runbook can gate on it.
function cmdDistillVerify(p: Parsed) {
  const oldPath = p.positionals[0] ?? die("distill-verify <old-snapshot.md> <new-page.md> required");
  const newPath = p.positionals[1] ?? die("distill-verify <old-snapshot.md> <new-page.md> required");
  let v;
  try {
    v = verifyDistillFiles(resolve(oldPath), resolve(newPath));
  } catch (e) {
    die(`distill-verify: cannot read input: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (v.ok) {
    console.log(
      ko
        ? `✓ 무손실 확인: 인용 소스 ${v.oldSources} → ${v.newSources} (축소 없음) · [conflict] 콜아웃 보존`
        : `✓ no-loss verified: citation sources ${v.oldSources} → ${v.newSources} (no shrink) · [conflict] callouts preserved`,
    );
    console.log(
      ko
        ? "  ※ 이 게이트는 기계적 절반만 검사 — 주장 수준 보존은 스냅샷과의 diff로 모델이 확인할 것"
        : "  ※ this gate checks the mechanical half only — verify claim-level fidelity by diffing against the snapshot",
    );
    return;
  }
  console.log(ko ? "✗ 무손실 게이트 실패:" : "✗ no-loss gate FAILED:");
  for (const s of v.droppedSources) {
    console.log(ko ? `  · 인용 소스 소실: ${s}` : `  · dropped citation source: ${s}`);
  }
  for (const c of v.droppedConflicts) {
    console.log(ko ? `  · [conflict] 콜아웃 소실: ${c.slice(0, 120)}` : `  · dropped conflict callout: ${c.slice(0, 120)}`);
  }
  console.log(
    ko
      ? "  → 새 페이지에 위 인용/콜아웃을 복원한 뒤 재검사 (진짜 중복 병합이면 스냅샷 쪽 각주를 남기고 리포트에 명시)"
      : "  → restore the dropped citations/callouts on the new page and re-run (a true duplicate merge must still cite the source; note it in the report)",
  );
  process.exit(1);
}

// Deterministic topic view (Phase-0, LLM-0): cluster wiki pages by shared tag into a regenerable
// topic map. No new claims, no merge — just the relational shape of the topic layer.
function cmdTopics(p: Parsed) {
  const repo = p.positionals[0] || process.cwd();
  process.stdout.write(buildTopicView(repo) + "\n");
}

async function cmdOverview(p: Parsed) {
  const ws = p.positionals[0] ?? die("overview <workspace> required");
  const check = !!p.flags["--check"];
  const r = normalizeOverview(ws, { check });
  if (r.verdict === "skip") {
    console.log(`  ⏭  ${r.reason}`);
    return;
  }
  if (r.verdict === "unchanged") {
    console.log(ko ? `  ✓ overview 정상 (정규화 불필요)` : `  ✓ overview already normalized`);
  } else {
    const verb = check ? (ko ? "정규화 필요" : "would normalize") : ko ? "정규화함" : "normalized";
    console.log(`  ✅ ${verb}: Recent Updates → [[log.md]] 포인터 (${r.before}B → ${r.after}B)`);
  }
  if (r.oversized) {
    console.log(
      ko
        ? `  ⚠️  overview가 여전히 예산 초과 — Key Findings를 토픽 페이지로 분산 권장`
        : `  ⚠️  overview still over budget — move Key Findings detail into topic pages`,
    );
  }
}

async function cmdGaps(p: Parsed) {
  const ws = p.positionals[0] ?? die("gaps <workspace> required");
  const date = (p.flags["--date"] as string) || new Date().toISOString().slice(0, 10);
  const r = refreshGapQueue(ws, date, { check: !!p.flags["--check"] });
  if (r.verdict === "skip") {
    console.log(`  ⏭  ${r.reason}`);
    return;
  }
  console.log(
    ko
      ? `  ✅ 갭 큐 갱신: open ${r.open} (신규 ${r.added}) · resolved ${r.resolved} → ${r.path}`
      : `  ✅ gap queue: open ${r.open} (new ${r.added}) · resolved ${r.resolved} → ${r.path}`,
  );
  if (r.open) {
    console.log(
      ko
        ? `  ※ 사실 갭(개념 페이지·교차링크)은 LLM의 북키핑 — 다음 /wiki-deep 가 직접 채움 (사람 판단은 모순·방향성만; 채워지면 자동 close)`
        : `  ※ fact gaps (concept pages·cross-links) are the LLM's bookkeeping — the next /wiki-deep fills them (humans judge only contradictions·direction; auto-closes once filled)`,
    );
  }
}

// P0-1a: deterministic retrieval benchmark (LLM-0, engine-dev tool — not part of any loop).
function cmdBench(p: Parsed) {
  const ws = p.positionals[0] ?? die("bench <workspace> [--tune-only|--sealed] required");
  const subset = p.flags["--sealed"] ? "sealed" : p.flags["--tune-only"] ? "tune" : "all";
  if (subset === "sealed") {
    console.error("⚠️  sealed subset opened — every look weakens it as a regression guard; iterate on --tune-only.");
  }
  const report = runBench(ws, subset as any);
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  console.log(`=== bench [${report.subset}] ${report.n} queries (${report.n_content} content / ${report.n_refusal} refusal) ===`);
  for (const [k, v] of Object.entries(report.recall)) console.log(`  search ${k}: ${pct(v)}`);
  console.log(`  turn-context pointer hit: ${pct(report.tc_pointer_hit)}`);
  if (report.n_refusal) console.log(`  turn-context refusal ok: ${pct(report.tc_refusal_ok)}`);
  const out = writeResults(ws, report);
  console.log(`  → ${out}`);
}

// P0-1b: frozen-corpus A/B — build+score ONE labeled arm (LLM; run per git-state/config)…
async function cmdCompareArm(p: Parsed) {
  const template = p.positionals[0] ?? die("compare-arm <repo-template> --corpus <dir> --label <name>");
  const corpusDir = (p.flags["--corpus"] as string) ?? die("--corpus <dir> required");
  const label = (p.flags["--label"] as string) ?? die("--label <name> required");
  const { result, workspace, out } = await runArm({
    label,
    corpusDir,
    templateRepo: template,
    keep: !!p.flags["--keep"],
    topic: !!p.flags["--topic"], // also run the 5_topic consolidate pass (merge-rubric test)
    writeModel: p.flags["--write-model"] as string | undefined,
    verifyModel: p.flags["--verify-model"] as string | undefined,
  });
  console.log(`=== compare-arm [${label}] corpus=${result.corpus_files} failures=${result.build_failures} pages=${result.pages} topic=${result.topic_pages} ===`);
  if (result.bench) console.log(`  r@5=${(result.bench.recall["r@5"]! * 100).toFixed(1)}% refusal_ok=${(result.bench.tc_refusal_ok * 100).toFixed(1)}%`);
  console.log(`  lint ${result.lint_errors} error / ${result.lint_warns} warn · linkIntegrity=${result.linkIntegrity.toFixed(2)}`);
  console.log(`  workspace: ${workspace}\n  → ${out}`);
}

// …then judge two arm results (deterministic, LLM-0 — kytmanov sequential gates).
function cmdCompareVerdict(p: Parsed) {
  const a = p.positionals[0] ?? die("compare-verdict <current.json> <challenger.json>");
  const b = p.positionals[1] ?? die("compare-verdict <current.json> <challenger.json>");
  const verdict = judgeArms(loadArm(a), loadArm(b));
  console.log(`=== verdict: ${verdict.verdict} ===`);
  console.log(`  reason: ${verdict.reason}`);
  if (verdict.avg_query_delta !== null) console.log(`  avg query delta: ${verdict.avg_query_delta.toFixed(3)}`);
  for (const [k, d] of Object.entries(verdict.structural_deltas)) console.log(`  ${k} delta: ${d.toFixed(3)}`);
  if (verdict.verdict === "keep") process.exit(1); // regression → non-zero for CI use
}

// Show the effective team-convention config (llmwiki.config.toml over built-in defaults) and
// validate it. Zero-config = built-in defaults = the stock structure.
function cmdConfig(p: Parsed) {
  const ws = p.positionals[0] ?? process.cwd();
  const c = getConfig(ws);
  console.log(`selected for: ${resolve(ws)}`);
  if (c.selection) console.log(`via: ${c.selection}`);
  console.log(`source: ${c.source}`);
  if (c.warning) console.log(`⚠ ${c.warning}`);
  if (c.error) {
    console.log(`✗ config INVALID — running on defaults: ${c.error}`);
  }
  console.log(`config_version: ${c.configVersion}   lang: ${c.lang || "(env/en)"}`);
  console.log("categories (reading order):");
  for (const cat of c.categories) {
    console.log(`  ${cat.dir}  domain=${cat.domain}  review=${cat.review}${cat.aliases?.length ? `  aliases=${cat.aliases.join(",")}` : ""}  — ${cat.guide}`);
  }
  console.log(`topic: ${c.topicDir}   queue: ${c.queueDir}   quiz: ${c.quizDir}`);
  console.log(`files: l0=${c.files.l0}  overview=${c.files.overview}  log=${c.files.log}`);
  console.log(`legacy scan dirs: ${c.legacyDirs.join(", ") || "(none)"}`);
  console.log(`banned terms: ${c.bannedTerms.map(([a, b]) => `${a}→${b}`).join(" · ")}`);
  if (c.source === "defaults") {
    console.log(`(customize: put ${CONFIG_BASENAME} at the engine clone root — see ${CONFIG_BASENAME.replace(".toml", ".example.toml")}; per-repo: ${CONFIGS_DIR}/*.toml with applies_to)`);
  }
}

// Print the wiki conventions an LLM/skill must follow — rendered from the effective config.
// Skills defer to this output whenever a custom llmwiki.config.toml is active, so skill prose
// never hardcodes category names (single source of truth).
function cmdConventions(p: Parsed) {
  const c = getConfig(p.positionals[0] ?? process.cwd());
  console.log(`# wiki conventions (source: ${c.source})`);
  if (c.error) console.log(`✗ config INVALID — defaults in effect: ${c.error}`);
  console.log("категories — dir | domain | review-gate | convention:".replace("категories", "categories"));
  for (const cat of c.categories) {
    console.log(`- ${cat.dir} | domain=${cat.domain} | ${cat.review === "human" ? `HUMAN (queue to ${c.queueDir}/)` : "model (status: ready, no human sign-off)"} | ${cat.guide}`);
  }
  console.log(`- ${c.topicDir} | topic encyclopedia (per-concept, create-or-update, consolidation only)`);
  console.log(`- ${c.queueDir} | human-judgment queue (Q./A. items; empty when idle)`);
  console.log(`- ${c.quizDir} | quiz layer — the HUMAN's memory loop (never indexed/searched; engine quiz-status/next/record + /wiki-quiz)`);
  console.log(`special files: L0=${c.files.l0} (human-owned) · ${c.files.overview} (entry point) · ${c.files.log} (append-only ledger)`);
  console.log("frontmatter (required): title · description · date · tags(≥2) · status(ready|draft) · domain · source; queue items also stamp owner(github login); optional: author, updated");
  if (c.bannedTerms.length) console.log(`banned terms: ${c.bannedTerms.map(([a, b]) => `${a}→${b}`).join(" · ")}`);
}

// Restructure the wiki to the effective config (folder renames + link rewriting + domain
// updates + .schema-version). Dry-run by default; --commit applies; --map old=new[,…] resolves
// ambiguous pairs. Never runs automatically — cold-start/doctor only suggest it.
function cmdMigrate(p: Parsed) {
  const ws = p.positionals[0] ?? die("migrate <workspace> [--commit] [--map old=new,old=new]");
  const map: Record<string, string> = {};
  for (const kv of String(p.flags["--map"] ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const eq = kv.indexOf("=");
    if (eq > 0) map[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  const r = migrate(ws, { commit: !!p.flags["--commit"], map });
  if (r.verdict === "skip") return console.log(`skip: ${r.reason}`);
  if (r.verdict === "conforms") {
    console.log(`✓ structure already conforms to the config${p.flags["--commit"] ? " (schema-version stamped)" : ""}`);
    if (r.strays?.length) console.log(`  ⚠ unmapped numbered dir(s) left untouched: ${r.strays.join(", ")} (use --map old=new)`);
    return;
  }
  console.log(`=== migrate [${r.verdict === "migrated" ? "COMMIT" : "DRY-RUN"}] ===`);
  for (const pair of r.pairs ?? []) console.log(`  ${pair.from} → ${pair.to}${pair.domain ? `  (domain → ${pair.domain})` : ""}`);
  if (r.strays?.length) console.log(`  ⚠ unmapped: ${r.strays.join(", ")} (use --map old=new)`);
  console.log(`  links rewritten: ${r.linksRewritten}   frontmatter domains: ${r.domainsRewritten}`);
  if (r.quizLedgerRemapped) console.log(`  quiz ledger identities remapped: ${r.quizLedgerRemapped}`);
  if (r.verdict === "migrated") console.log(`  reindexed · lint errors: ${r.lintErrors}`);
  else console.log(`  (dry-run — apply with --commit)`);
}

// ---- quiz (the human memory loop; scheduling = engine, authoring/grading = /wiki-quiz) ----

const QUIZ_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function quizDate(p: Parsed): string | undefined {
  const d = p.flags["--date"];
  if (typeof d !== "string" || !d) return undefined;
  if (!QUIZ_DATE_RE.test(d)) die("--date must be YYYY-MM-DD");
  return d;
}

// Deterministic status for the /wiki-quiz announce step (and a quick human glance).
function cmdQuizStatus(p: Parsed) {
  const ws = p.positionals[0] ?? die("quiz-status <workspace> [--date YYYY-MM-DD]");
  const s = quiz.quizStatus(ws, { date: quizDate(p) });
  const due = s.dueWrong + s.dueReview;
  console.log(
    ko
      ? `quiz: 장부 ${s.total}항목 | 오늘 due ${due}건 (오답복습 ${s.dueWrong} · 주기복습 ${s.dueReview}) | 신규 후보 ${s.newCandidates} | 오늘 출제됨 ${s.askedToday} | 세션 ${s.questions}문(최대 ${s.maxQuestions})`
      : `quiz: ledger ${s.total} item(s) | due today ${due} (wrong-review ${s.dueWrong} · curve-review ${s.dueReview}) | new candidates ${s.newCandidates} | asked today ${s.askedToday} | session ${s.questions}q (max ${s.maxQuestions})`,
  );
  if (s.nextDue && due === 0) console.log(ko ? `  다음 due: ${s.nextDue}` : `  next due: ${s.nextDue}`);
  for (const w of s.weak)
    console.log((ko ? "  약점(페이지 재독 권장): " : "  weak spot (re-read the page): ") + `${w.page} — ${w.correct}/${w.asked}`);
  if (s.missing.length)
    console.log(
      (ko ? "  ⚠ 사라진 페이지(다음 quiz-record 때 자동 정리): " : "  ⚠ vanished page(s) (auto-pruned on next quiz-record): ") +
        s.missing.join(", "),
    );
}

// The scheduled selection — pointers only; the warm session Reads each page and authors the
// question (grounding rule: the page is the answer key).
function cmdQuizNext(p: Parsed) {
  const ws = p.positionals[0] ?? die("quiz-next <workspace> [--limit N] [--date YYYY-MM-DD]");
  // No --limit → config default ([quiz] questions); the engine clamps to the fixed ceiling.
  const rawLimit = p.flags["--limit"];
  const requested = rawLimit === undefined ? undefined : Math.max(1, parseInt(String(rawLimit), 10) || 1);
  const sel = quiz.selectNext(ws, { limit: requested, date: quizDate(p) });
  console.log(
    ko
      ? `quiz-next: ${sel.picks.length}문항 선택 (전체 due — 오답복습 ${sel.dueWrong} · 주기복습 ${sel.dueReview} / 신규 후보 ${sel.newCandidates})`
      : `quiz-next: ${sel.picks.length} item(s) selected (all due — wrong-review ${sel.dueWrong} · curve-review ${sel.dueReview} / new candidates ${sel.newCandidates})`,
  );
  if (requested !== undefined && requested > sel.limit)
    console.log(
      ko
        ? `  ⚠ 요청 ${requested}문 → 세션 상한 ${sel.limit}문으로 제한됨 (엔진 고정 상한)`
        : `  ⚠ requested ${requested} → capped at the session ceiling of ${sel.limit} (fixed engine cap)`,
    );
  if (!sel.picks.length) {
    console.log(
      ko
        ? "  오늘 낼 문항 없음 — 작업을 /wiki-fast 로 쌓으면 신규 후보가 생긴다."
        : "  nothing to ask today — file work with /wiki-fast to grow new candidates.",
    );
    return;
  }
  sel.picks.forEach((pick, i) => {
    if (pick.kind === "new") {
      const c = pick.candidate!;
      console.log(`${i + 1}. [new] docs/wiki/${c.page} — ${c.domain || c.dir}${c.date ? ` · ${c.date}` : ""} · "${c.title}"`);
    } else {
      const e = pick.entry!;
      const lastQ = e.lastQ ? ` · last q: "${e.lastQ.slice(0, 80)}"` : "";
      console.log(`${i + 1}. [${pick.kind}] docs/wiki/${e.page} — box ${e.box} · due ${e.due} · ${e.correct}/${e.asked}${lastQ}`);
    }
  });
  if (sel.missing.length)
    console.log((ko ? "  ⚠ 사라진 페이지 제외됨: " : "  ⚠ vanished page(s) excluded: ") + sel.missing.join(", "));
}

// Record ONE result; the engine takes the forgetting-curve step (correct → next box,
// wrong/skip → box 0) and rewrites the ledger. One call per asked item (update-done style).
function cmdQuizRecord(p: Parsed) {
  const ws =
    p.positionals[0] ??
    die('quiz-record <workspace> --page <wiki-relative.md> --result correct|wrong|skip [--question "<asked>"] [--date YYYY-MM-DD]');
  const page = String(p.flags["--page"] ?? "");
  if (!page) die("--page <wiki-relative .md path> required");
  const result = String(p.flags["--result"] ?? "");
  if (result !== "correct" && result !== "wrong" && result !== "skip") die("--result must be correct|wrong|skip");
  const question = typeof p.flags["--question"] === "string" ? p.flags["--question"] : undefined;
  try {
    const r = quiz.recordResult(ws, { page, result, question, date: quizDate(p) });
    const e = r.entry;
    console.log(
      `✓ ${e.page}: ${result} → box ${e.box} · ${ko ? "다음 due" : "next due"} ${e.due} · ${e.correct}/${e.asked}` +
        (r.isNew ? (ko ? " · 신규 항목" : " · new item") : ""),
    );
    if (r.pruned.length) console.log((ko ? "  사라진 페이지 정리됨: " : "  pruned vanished: ") + r.pruned.join(", "));
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
}

const HANDLERS: Record<string, (p: Parsed) => void | Promise<void>> = {
  init: cmdInit,
  config: cmdConfig,
  conventions: cmdConventions,
  migrate: cmdMigrate,
  bench: cmdBench,
  "compare-arm": cmdCompareArm,
  "compare-verdict": cmdCompareVerdict,
  index: cmdIndex,
  reindex: cmdReindex,
  refs: cmdRefs,
  lint: cmdLint,
  search: cmdSearch,
  "update-status": cmdUpdateStatus,
  "update-next": cmdUpdateNext,
  "update-done": cmdUpdateDone,
  "update-enqueue": cmdUpdateEnqueue,
  skeleton: cmdSkeleton,
  autoupdate: cmdAutoupdate,
  ingest: cmdIngest,
  consolidate: cmdConsolidate,
  "distill-verify": cmdDistillVerify,
  topics: cmdTopics,
  "register-transcript": cmdRegisterTranscript,
  excerpt: cmdExcerpt,
  review: cmdReview,
  overview: cmdOverview,
  gaps: cmdGaps,
  "git-rules": cmdGitRules,
  doctor: cmdDoctor,
  context: cmdContext,
  "turn-context": cmdTurnContext,
  digest: cmdDigest,
  "context-audit": cmdContextAudit,
  reconcile: cmdReconcile,
  "quiz-status": cmdQuizStatus,
  "quiz-next": cmdQuizNext,
  "quiz-record": cmdQuizRecord,
};

const parsed = parseArgs(process.argv.slice(2));
// Per-repo language: if the first positional is an existing path, resolve that workspace's
// config (a named config may set lang); otherwise cwd. LLMWIKI_LANG env still wins.
{
  const wsGuess =
    parsed.positionals[0] && existsSync(parsed.positionals[0]) ? parsed.positionals[0] : process.cwd();
  LANG = effectiveKo(getConfig(wsGuess)) ? "ko" : "en";
  ko = LANG === "ko";
}
const handler = HANDLERS[parsed.cmd];
if (!handler) {
  die(
    `usage: llmwiki <command> ...\n` +
      `commands: ${Object.keys(HANDLERS).join(", ")}`,
  );
}
await handler(parsed);
