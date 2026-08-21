#!/usr/bin/env bun
// llmwiki — local-first compounding wiki engine (CLI).
// Markdown under <workspace>/docs/wiki is the source of truth; .llmwiki/index.db is a
// rebuildable derived index. No server, no MCP registration required.
// allow: SIZE_OK — legacy handlers remain co-located while typed parsing, declarative command/help
// metadata, and maintenance commands have dedicated boundaries; further extraction stays incremental.
import { WikiIndex, dedupeByPage } from "./engine/db.ts";
import { today } from "./engine/today.ts";
import packageJson from "../package.json" with { type: "json" };
import { commandSpec, renderCommandHelp, renderRootHelp, suggestCommands, type CommandName } from "./commands/catalog.ts";
import { MissingCliFlagValueError, UnknownCliFlagError, parseCliArgs, type ParsedCliArgs as Parsed } from "./cli-args.ts";
import { createMaintenanceHandlers } from "./commands/maintenance.ts";
import { runDoctor, type DoctorHarness } from "./engine/doctor.ts";
import * as excerpt from "./engine/excerpt.ts";
import { rebuildReferenceGraph, referenceGraphCounts } from "./engine/refs.ts";
import { effectiveKo, getConfig, isRepoKorean, CONFIG_BASENAME, CONFIGS_DIR } from "./engine/config.ts";
import { Linter, formatReport } from "./engine/lint.ts";
import * as update from "./engine/update.ts";
import { countLines, sourceForPath } from "./engine/source.ts";
import { opencodeSource, opencodeDbPaths } from "./engine/sources/opencode.ts";
import { claudeConfigDirs } from "./engine/sources/claude.ts";
import { codexHome } from "./engine/sources/codex.ts";
import {
  HARNESSES,
  connectHarnessPath,
  forgetHarnessPath,
  persistedClaudeDirs,
  persistedCodexHome,
  persistedOpencodeDb,
  verifyHarnessPath,
  type Harness,
} from "./engine/harness-locate.ts";
import { restartDaemon, watchProcessRunning } from "./engine/daemon-control.ts";
import { envValueOutsideRepoFiles } from "./engine/env-policy.ts";
import { autoConnect, renderHandoff } from "./engine/harness-autoconnect.ts";
import * as autoupdate from "./engine/autoupdate.ts";
import { review } from "./engine/review.ts";
import { buildContext } from "./engine/context.ts";
import { captureBucket, wikiRootFor } from "./engine/wiki-root.ts";
import * as enrollment from "./engine/enrollment.ts";
import { StateRootError, describeStateRoot, migrateStateRoot, purgeOwnedState } from "./engine/state-dir.ts";
import { RepoBoundaryError } from "./engine/repo-write.ts";
import { isEnrolled } from "./engine/enrollment.ts";
import { buildTurnContext } from "./engine/turncontext.ts";
import { buildDigest, buildTopicView } from "./engine/synthesis.ts";
import { auditContext, formatAudit } from "./engine/context-audit.ts";
import { ingest } from "./engine/ingest.ts";
import * as capture from "./engine/capture.ts";
import * as consolidate from "./engine/consolidate.ts";
import * as related from "./engine/related.ts";
import { reconcileReflected } from "./engine/reconcile.ts";
import * as quiz from "./engine/quiz.ts";
import { runBench, writeResults } from "./engine/bench.ts";
import { runScaleSuite } from "./engine/bench-scale.ts";
import {
  discoverClaudeTranscripts,
  pickTranscripts,
  scanTranscript,
  summarizeDownstreamRead,
} from "./engine/downstream-read.ts";
import {
  claudeLedgerReads,
  discoverCodexRollouts,
  matchEmissions,
  readEmissionsFor,
  recordEmission,
  scanCodexReads,
  scanOpenCodeReads,
} from "./engine/observe.ts";
import { verifyDistillFiles } from "./engine/distill.ts";
import { runArm, loadArm, judgeArms } from "./engine/compare.ts";
import { CLONE_ROOT } from "./engine/paths.ts";
import { existsSync, readFileSync, statSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exportHermesSession, hermesDbPath, hermesSessions } from "./engine/hermes-export.ts";
import { ensureProjectStateDir, resolveProjectStateLocation } from "./engine/project-state.ts";

// User-facing CLI output adapts to LLMWIKI_LANG (default English, Korean when set) — same
// policy as the cold-start context/digest. LLM-facing prompts stay English by design.
// Initialized from the global config; re-resolved per-workspace after arg parsing (bottom of file).
let LANG = effectiveKo() ? "ko" : "en";
let ko = LANG === "ko";

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(2);
}

const MAINTENANCE_HANDLERS = createMaintenanceHandlers({ die, isKorean: () => ko });

function idx(ws: string): WikiIndex {
  return new WikiIndex(ws);
}

// ---- command handlers ----

function cmdInit(p: Parsed) {
  const ws = p.positionals[0] ?? die("init <workspace> required");
  const w = idx(ws);
  w.init();
  // Full skeleton, not bare category dirs (config-aware: custom [[category]] conventions win).
  // Fresh-install E2E (2026-07-21) found init handing over an incomplete repo twice: first the
  // missing category dirs (a newcomer's first page write failed on folder layout), then the
  // missing team-safety seeding — without .gitignore(.llmwiki/) the adopter's very next commit
  // ships the derived SQLite index (binary merge conflicts), and without .gitattributes
  // concurrent log.md appends conflict on every merge. ensureSkeleton covers all of it —
  // dirs (private included), L0/overview/log templates, .gitignore/.gitattributes/.mailmap —
  // and is idempotent: re-running init re-creates deletions and never rewrites existing files.
  const cfg = getConfig(w.root);
  const scaffold = [cfg.queueDir, ...cfg.categories.map((c) => c.dir), cfg.topicDir];
  update.ensureSkeleton(w.root, cfg);
  const [neu] = w.indexAll();
  // Materialize the citation/link graph too (same as `index`). Without this, a fresh clone's
  // first `lint` right after setup.sh's `init` reports a spurious citation-graph-mismatch on
  // any page that has footnotes (e.g. the EXAMPLE page) — a bad first impression for adopters.
  const r = rebuildReferenceGraph(w);
  // ENROLL LAST. Everything above is bounded, repository-local work that can fail (a symlinked
  // docs/wiki, an unwritable root, a broken index) — and a half-initialized repository must not
  // end up trusted by the installed hooks. This is also the ONLY place enrollment is granted.
  const enrolled = enrollment.enroll(w.root);
  if (!enrolled.ok) {
    die(
      ko
        ? `초기 파일은 만들었지만 자동 연동을 활성화하지 못했다: ${enrolled.error}\nGit 저장소에서 다시 \`llmwiki init ${w.root}\`을 실행하면 기존 파일을 보존한 채 완료된다.`
        : `Initial files were created, but automatic integration could not be enabled: ${enrolled.error}\nRun \`llmwiki init ${w.root}\` again from a Git repository; existing files will be preserved.`,
    );
  }
  console.log(`✓ Initialized ${w.root}`);
  console.log(`  docs/wiki/ created; indexed ${neu} file(s) into ${w.dbPath}`);
  console.log(`  categories scaffolded: ${scaffold.join(" · ")}`);
  if (cfg.privateDirs.length) console.log(`  private (local-only, auto-gitignored): ${cfg.privateDirs.join(" · ")}`);
  console.log(`  skeleton: L0 · overview · log templates + .gitignore(.llmwiki/) · .gitattributes · .mailmap (idempotent)`);
  console.log(`  refs: ${r.citations} citation, ${r.links} link edge(s) across ${r.pages} page(s)`);
  console.log(
    ko
      ? `  자동 연동 활성화(이 워크트리 한정, 1회): cold-start·turn-context·캡처가 이제 이 저장소에서 동작한다`
      : `  automatic integration enabled for this worktree (one time): cold-start, turn-context and capture now run here`,
  );
}

function cmdIndex(p: Parsed) {
  const ws = p.positionals[0] ?? die("index <workspace> required");
  const w = idx(ws);
  const [neu, updated, removed] = w.indexAll();
  // A true no-op (nothing added, changed, OR deleted — deletions rewire edges too) cannot have
  // changed the reference graph, so reuse it instead of re-walking every page. This was the whole
  // cost of a no-op `index`: content_hash already skipped the pages, then the graph rebuild
  // re-parsed all of them anyway. Falls through to a rebuild when the stored graph is empty,
  // because "empty" and "never built" look the same from here.
  const r = neu + updated + removed === 0 ? referenceGraphCounts(w) ?? rebuildReferenceGraph(w) : rebuildReferenceGraph(w);
  console.log(`✓ Indexed: ${neu} new, ${updated} updated (unchanged skipped via content_hash)`);
  console.log(`  refs: ${r.citations} citation, ${r.links} link edge(s) across ${r.pages} page(s)`);
}

function cmdReindex(p: Parsed) {
  const ws = p.positionals[0] ?? die("reindex <workspace> required");
  const w = idx(ws);
  const [neu] = w.reindex();
  const r = rebuildReferenceGraph(w);
  console.log(`✓ Reindexed from disk: ${neu} file(s)`);
  console.log(`  refs: ${r.citations} citation, ${r.links} link edge(s) across ${r.pages} page(s)`);
}

function cmdRefs(p: Parsed) {
  const ws = p.positionals[0] ?? die("refs <workspace> required");
  const { citations, links, pages } = rebuildReferenceGraph(idx(ws));
  console.log(`✓ Reference graph rebuilt: ${citations} citation edge(s), ${links} link edge(s) across ${pages} page(s)`);
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
/** stat without throwing — an unreadable path is "not there" for the purposes of an error message. */
function statSafe(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function cmdExcerpt(p: Parsed) {
  const transcript = p.positionals[0] ?? die("excerpt <transcript.jsonl> [--offset N] [--kind fact|judgment]");
  // "There is no evidence here" and "you pointed me at the wrong thing" are different answers, and
  // only one of them means write the page uncited. Returning the first for a directory or a typo
  // (this command takes a TRANSCRIPT, not a repo — an easy argument to swap) told the caller the
  // session had nothing to quote, which is how a grounded page quietly becomes an ungrounded one.
  const st = statSafe(transcript);
  if (!st) die(`excerpt: no such transcript: ${transcript}`);
  if (!st.isFile()) {
    die(`excerpt: not a transcript file: ${transcript}\n  (this command takes the transcript path, not the repository)`);
  }
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

/**
 * `save-current <workspace> --session <id>` — resolve THE CURRENT SESSION's transcripts by exact
 * identity and make them selectable for a manual close-out. This is /wiki-save's selection step:
 * the skill used to say "when unsure, the newest pending entry", and in a real 44-line Claude
 * session that fallback picked a pending CODEX transcript — another harness's session filed as
 * this one's judgment. Exact match or explicit failure; recency is never an identity.
 *
 * Two deliberate policies:
 *   - A manual save is an explicit human act, so it enqueues even below the daemon's 50-line
 *     work threshold (that threshold filters PASSIVE capture, not "save this session").
 *   - Everything stays behind enrollment: unenrolled repositories die before any lookup, and a
 *     session that belongs to a DIFFERENT repository is counted, never named, never enqueued.
 */
function cmdSaveCurrent(p: Parsed) {
  const ws = p.positionals[0] ?? die("save-current <workspace> --session <id> required");
  const sid = String(p.flags["--session"] ?? "").trim();
  if (!sid) {
    die(
      ko
        ? "save-current: --session <id> 필요 — 하네스가 제공한 현재 세션 ID (Claude: $CLAUDE_CODE_SESSION_ID, OpenCode: 플러그인이 주입한 session id)"
        : "save-current: --session <id> required — the harness-provided CURRENT session id (Claude: $CLAUDE_CODE_SESSION_ID; OpenCode: the plugin-injected session id)",
    );
  }
  const status = enrollment.inspectEnrollment(ws);
  if (!status.enabled || !status.worktree) {
    die(
      ko
        ? `save-current: 등록되지 않은 저장소 (${ws}) — 먼저 llmwiki init`
        : `save-current: repository not enrolled (${ws}) — run llmwiki init first`,
    );
  }
  const bucket = captureBucket(ws);
  const found: { path: string; note: string }[] = [];
  let elsewhere = 0;
  const seen = new Set<string>();

  // 1) Hook-based harnesses (Claude/Codex): the SessionStart route hint IS the identity record —
  //    the harness itself said "this transcript is this session in this repository".
  for (const hint of capture.routeHintsForSession(sid)) {
    if (captureBucket(hint.repo) !== bucket) {
      elsewhere += 1;
      continue;
    }
    if (!existsSync(hint.transcriptPath) || seen.has(hint.transcriptPath)) continue;
    const lines = countLines(hint.transcriptPath);
    if (lines < 1) continue;
    capture.enqueue(
      hint.transcriptPath,
      sid,
      hint.repo,
      lines,
      hint.sourceKind ?? sourceForPath(hint.transcriptPath).kind,
    );
    seen.add(hint.transcriptPath);
    found.push({ path: hint.transcriptPath, note: `${lines} lines` });
  }

  // 2) Queue rows already carrying this session id (a resumed session hinted in an earlier run).
  for (const row of capture.queueRowsForSession(sid)) {
    if ((row.repo ?? "") !== bucket) {
      if (row.repo) elsewhere += 1;
      continue;
    }
    if (seen.has(row.transcript_path)) continue;
    seen.add(row.transcript_path);
    found.push({
      path: row.transcript_path,
      note: row.status === "pending" ? "pending" : `already ${row.status}`,
    });
  }

  // 3) OpenCode (no hooks): resolve the id through stage-1 routing, then materialize+enqueue.
  //    The repository gate runs BEFORE materialize — another repo's session must not even have
  //    its export refreshed on this repo's behalf; materialize re-checks enrollment itself.
  for (const route of opencodeSource.discoverRoutes()) {
    if (route.sessionId !== sid) continue;
    if (!route.repo || captureBucket(route.repo) !== bucket) {
      elsewhere += 1;
      continue;
    }
    let session = null;
    try {
      session = opencodeSource.materialize(route);
    } catch {
      session = null;
    }
    if (!session || seen.has(session.path)) continue;
    capture.enqueue(session.path, sid, session.repo, session.lines, "opencode");
    seen.add(session.path);
    found.push({ path: session.path, note: `${session.lines} lines` });
  }

  if (!found.length) {
    const hintTail = elsewhere
      ? ko
        ? ` (다른 저장소의 세션 ${elsewhere}건은 제외 — 그 저장소에서 실행할 것)`
        : ` (${elsewhere} match(es) in OTHER repositories were excluded — run save-current from there)`
      : "";
    die(
      ko
        ? `save-current: 세션 ${sid} 의 transcript 를 이 저장소에서 찾지 못함 — 추측하지 않는다. 다른 세션의 pending 을 대신 저장하지 말 것.${hintTail}`
        : `save-current: no transcript for session ${sid} in this repository — refusing to guess. Do NOT file another session's pending entry instead.${hintTail}`,
    );
  }
  console.log(
    ko
      ? `✓ 현재 세션 ${sid.slice(0, 8)}: transcript ${found.length}건 (수동 저장 — 50줄 문턱 미적용)`
      : `✓ current session ${sid.slice(0, 8)}: ${found.length} transcript(s) (manual save — 50-line threshold not applied)`,
  );
  for (const f of found) console.log(`  • ${f.path} (${f.note})`);
}

// Same-topic pending sessions, anchored on this session's transcript (close-out step 2b).
// Candidates only — deterministic, human-utterance matching, never a recommendation.
function cmdRelated(p: Parsed) {
  const ws = p.positionals[0] ?? die("related <workspace> <transcript> required");
  const transcript = p.positionals[1] ?? die("related <workspace> <transcript> required");
  const cands = related.relatedPending(ws, transcript);
  if (!cands.length) {
    console.log(ko ? "✓ 같은 주제의 미저장 세션 없음." : "✓ No pending sessions on this session's topic.");
    return;
  }
  console.log(
    ko
      ? `같은 주제의 미저장 세션 ${cands.length}건 — 후보일 뿐, 엮을지는 지금 쓰는 페이지에 보탬이 될 때만:`
      : `${cands.length} pending session(s) on this session's topic — candidates only; weave one in only if it enriches a page being written now:`,
  );
  for (const c of cands) {
    console.log(`  • sess ${(c.sessionId ?? "?").slice(0, 8)} score=${c.score} | ${c.recap ?? c.path}`);
    console.log(`      ${ko ? "엮으려면" : "to weave in"}: ${related.renderUpdateNextCommand(ws, c.path)}`);
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
  // Route check — `cwd=` above is the bucket key and matches this queue by construction; these
  // lines say where the segment's mutations actually landed (advisory when that is elsewhere).
  for (const line of update.renderRouteLines(ws, inc.touched)) console.log(line);
  // P2: surface a summary the harness ALREADY wrote (session-memory / compact / rollout
  // summary) as draft material — the condense pass must still ground claims in the raw
  // extract below (harness summary = material, wiki = record of record).
  try {
    const summary = sourceForPath(transcript).summaryFor?.(transcript);
    if (summary) {
      const screened = update.screenTranscriptMaterial(summary);
      if (screened !== null) {
        console.log(
          "=== harness summary (pre-written by the harness — reuse as draft material; ground every claim in the extract below) ===",
        );
        console.log(screened);
        console.log("=== end harness summary ===");
      }
    }
  } catch {
    /* opportunistic — never break update-next */
  }
  console.log(inc.rendered);
}

function cmdUpdateDone(p: Parsed) {
  const ws = p.positionals[0] ?? die("update-done <workspace> <transcript> <offset> required");
  const transcript = p.positionals[1] ?? die("update-done <workspace> <transcript> <offset> required");
  const offset = parseInt(p.positionals[2] ?? die("update-done <workspace> <transcript> <offset> required"), 10);
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
  const date = (p.flags["--date"] as string) || today();
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

// Hermes write loop. Hermes is not a capture source (see src/engine/hermes-export.ts for why the
// daemon deliberately does not watch it), so a session is filed in two explicit steps: export the
// transcript out of Hermes' own store, then hand the file to the existing drop-a-source path.
// Printing the follow-up command rather than running it keeps the ingest decision — and its
// --commit — with the caller.
async function cmdHermesExport(p: Parsed) {
  const repo = p.positionals[0] ?? die("hermes-export <repo> [--session <id>] [--out <file>] [--list] required");
  if (!hermesDbPath()) die("no Hermes state database found (looked for $HERMES_HOME/state.db, default ~/.hermes)");
  const sessions = hermesSessions(repo);
  if (!sessions.length) die(`no Hermes session recorded for ${repo}`);

  if (p.flags["--list"]) {
    console.log(`=== hermes sessions for ${repo} (${sessions.length}) ===`);
    for (const s of sessions.slice(0, 20)) {
      console.log(`  ${s.id}  ${s.messages} msg  ${s.title ?? ""}`.trimEnd());
    }
    return;
  }

  const wanted = (p.flags["--session"] as string) ?? sessions[0]!.id;
  const out = (p.flags["--out"] as string) ?? join(tmpdir(), `hermes-${wanted}.md`);
  const result = exportHermesSession(wanted, out);
  if (!result) die(`nothing to export for session ${wanted} (unrouted, empty, or fully screened)`);
  console.log(`=== hermes-export ${result.sessionId} → ${result.path} ===`);
  console.log(`  repo: ${result.repo} · turns: ${result.turns}${result.redacted ? " · credential-shaped material screened" : ""}`);
  console.log(`  next: llmwiki ingest ${result.repo} ${result.path} --commit`);
}

// Register session transcript(s) as citable provenance sources so decision/insight pages can
// cite the real session (not a repointed code file). With a transcript arg, registers that one;
// otherwise registers every transcript the central queue has seen for this repo whose file still
// exists. A warm /wiki-save runs this before lint so `[^1]: <transcript>.jsonl` resolves.
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

// Cold-start read-injection blob for <repo> (default: cwd). Harness-neutral: the Claude
// SessionStart hook calls this; other harnesses run it from AGENTS.md or a startup prompt.
/**
 * Wrap injected text in the hook-output envelope BOTH harnesses accept.
 *
 * Codex parses a hook's stdout as JSON and, when it is not JSON, drops it — no injection, no error,
 * no warning (codex-rs/hooks/src/events/session_start.rs: the plain-text branch does nothing). So
 * printing bare text reached the model on Claude Code, which falls back to treating stdout as text,
 * and nowhere else: a Codex install looked complete, doctor reported every surface ✅, and the wiki
 * was never in the context.
 *
 * Both harnesses declare exactly this shape — Claude Code as a zod variant per event
 * (src/types/hooks.ts) and Codex as a JSON schema with additionalProperties:false — so it is
 * written verbatim, with no extra keys:
 *
 *   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}
 *
 * Silence stays silence: an empty body prints nothing at all, never an empty envelope.
 */
const HOOK_OUTPUT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

function writeHookOutput(text: string, p: Parsed): void {
  if (!text) return; // zero bytes means zero bytes
  const event = p.flags["--hook-event"];
  if (event === undefined) {
    process.stdout.write(text + "\n");
    return;
  }
  if (typeof event !== "string" || !HOOK_OUTPUT_EVENTS.has(event)) {
    die(`--hook-event must be one of: ${[...HOOK_OUTPUT_EVENTS].join(", ")}`);
  }
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) + "\n",
  );
}

/**
 * Take the harness at its word about the session that is starting.
 *
 * Claude and Codex both put `transcript_path` (plus session_id and cwd) in every hook payload —
 * Codex's schema even marks it required. Recording that mapping means the capture loop does not
 * have to INFER, from someone else's file format, which repository the session you are sitting in
 * belongs to. Stage-1 routing still does its job for every other session on the machine; this only
 * removes the guess for the one session a harness just told us about.
 *
 * Silent and best-effort by construction: a hook must never fail a session, and an unenrolled
 * repository records nothing at all.
 *
 * Returns the cwd the harness reported, so the READ side can bind to the same repository this
 * WRITE side just filed the session under (see cmdContext).
 */
async function noteHarnessSession(repo: string): Promise<{ cwd: string | null; session: string | null }> {
  try {
    if (process.stdin.isTTY) return { cwd: null, session: null };
    const raw = await Bun.stdin.text();
    if (!raw.trim()) return { cwd: null, session: null };
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const harnessCwd = typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd.trim() : null;
    const session = typeof payload.session_id === "string" && payload.session_id.trim() ? payload.session_id : null;
    const transcript = typeof payload.transcript_path === "string" ? payload.transcript_path.trim() : "";
    if (!transcript) return { cwd: harnessCwd, session };
    // Enrollment first: the hint table must never learn about a repository the human did not enroll.
    const target = harnessCwd ?? repo;
    const status = enrollment.inspectEnrollment(target);
    if (!status.enabled || !status.worktree) return { cwd: harnessCwd, session };
    // The hint records the session's cwd, not the worktree: recordRouteHint resolves it to the
    // wiki root the session reads, and a nested project with its own wiki must keep its own bucket.
    capture.recordRouteHint(resolve(transcript), target, session, sourceKindForTranscript(transcript));
    return { cwd: harnessCwd, session };
  } catch {
    /* a malformed or absent payload simply teaches us nothing */
    return { cwd: null, session: null };
  }
}

/** Which adapter owns this path, for reporting only — the daemon matches hints by path. */
function sourceKindForTranscript(path: string): string | null {
  if (path.includes("/.codex/")) return "codex";
  if (path.endsWith(".jsonl")) return "claude-jsonl";
  return null;
}

async function cmdContext(p: Parsed) {
  const repo = p.positionals[0] || process.cwd();
  // A hook payload is read ONLY when --hook-event says this process is a harness hook. That flag
  // is the reason stdin is safe to touch: a hook's stdin is the payload pipe and the harness closes
  // it, whereas a plugin or a human at a terminal may leave it open forever.
  let target = repo;
  let hookSession = "";
  if (typeof p.flags["--hook-event"] === "string") {
    // In hook mode the harness's own cwd OUTRANKS the positional. The adapters pass
    // `${CLAUDE_PROJECT_DIR:-$PWD}`, which is the directory the session STARTED in — so a session
    // launched from ~ that works in ~/some-repo would read ~'s wiki for its entire life, while
    // capture (right above, already taking the payload's word) files it under ~/some-repo. Read and
    // write must bind to the same repository or the loop silently compounds into the wrong wiki.
    const noted = await noteHarnessSession(repo);
    target = noted.cwd ?? repo;
    hookSession = noted.session ?? "";
  }
  const out = buildContext(target);
  // Cold-start pointers enter the emission ledger too (index + spine lines) — only in hook mode,
  // where the payload names the session the pointers were emitted FOR.
  if (out && hookSession) {
    recordEmission(wikiRootFor(target, enrollment.inspectEnrollment(target).worktree), hookSession, "cold_start", out);
  }
  // Zero bytes means ZERO BYTES — not even the newline. An unenrolled repository must be
  // indistinguishable from "llmwiki is not installed" to every harness that runs this on
  // session start, so nothing is written when there is nothing to say.
  writeHookOutput(out, p);
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
      // Codex fires UserPromptSubmit for SUBAGENT threads too, and says so in the payload
      // (agent_id/agent_type — null on the main thread; Claude Code sends neither). A subagent's
      // "prompt" is the orchestrator's instruction, not the human's — wiki pointers there would
      // steer a narrow delegated task with unrelated context, so subagent turns stay silent.
      // Same principle as LLMWIKI_ENGINE_SUBPROCESS, provided by the harness instead of by us.
      if (String(payload.agent_type ?? "").trim() || String(payload.agent_id ?? "").trim()) return;
      prompt = String(payload.prompt ?? "");
      sessionId ||= String(payload.session_id ?? "");
      // Same precedence as the cold start: in hook mode the harness's cwd beats the positional,
      // which the adapter filled from the session's STARTUP directory. Outside hook mode an
      // explicit positional is a human's instruction and still wins.
      const payloadCwd = String(payload.cwd ?? "").trim();
      if (payloadCwd && (typeof p.flags["--hook-event"] === "string" || !repo)) repo = payloadCwd;
    } catch {
      /* not JSON / empty stdin → stay silent below */
    }
  }
  repo ||= process.cwd();
  // Enrollment is checked BEFORE the prompt is used for anything: an unenrolled repository gets
  // no retrieval, no session state file, and no output.
  if (!isEnrolled(repo)) return;
  // …and retrieval runs against the wiki inside what the gate approved, not a subdirectory of it.
  const root = wikiRootFor(repo, enrollment.inspectEnrollment(repo).worktree);
  const out = prompt ? buildTurnContext(root, prompt, sessionId) : "";
  // Emission ledger: the engine is the only party that reliably knows what was injected
  // (OpenCode's transform persists nothing, Codex buries it in a message). One appended line,
  // no-throw — `llmwiki downstream-read` answers it later with each harness's own read records.
  if (out) recordEmission(root, sessionId, "turn_context", out);
  writeHookOutput(out, p);
}

// Enrollment lifecycle. `init` enrolls; these three are the rest of the contract — a way to turn
// a repository off, a way to see why it is off, and the silent predicate adapters call.
function cmdDisable(p: Parsed) {
  const ws = p.positionals[0] ?? die("disable <workspace> required");
  const r = enrollment.disable(ws);
  if (!r.ok) die(`disable: ${r.error}`);
  console.log(
    ko
      ? `✓ 자동 연동 해제: ${r.worktree}\n  (위키 내용은 그대로 — 다시 켜려면 \`llmwiki init\`)`
      : `✓ automatic integration disabled for ${r.worktree}\n  (wiki content is untouched — re-enable with \`llmwiki init\`)`,
  );
}

function cmdStatus(p: Parsed) {
  const ws = p.positionals[0] || process.cwd();
  const st = enrollment.inspectEnrollment(ws);
  // Deliberately prints enrollment state and the canonical root ONLY — never page or
  // transcript content, so it stays safe to paste into a bug report.
  console.log(`${st.enabled ? "enabled" : "disabled"}  ${st.worktree ?? resolve(ws)}`);
  console.log(`  ${enrollment.explain(st, ko)}`);
  if (st.markerPath) console.log(`  marker: ${st.markerPath}`);
}

// One post-install receipt for the only state a person should care about: is the machine wiring
// healthy, is this worktree enrolled, and can a new session receive non-empty work memory? The
// command is read-only and intentionally composes existing authorities instead of inventing a
// second doctor/enrollment contract.
function cmdVerify(p: Parsed) {
  const ws = p.positionals[0] || process.cwd();
  const rawHarness = String(p.flags["--harness"] ?? "all");
  if (!(["all", "claude", "codex", "opencode"] as const).includes(rawHarness as DoctorHarness)) {
    die("verify --harness must be one of: all, codex, claude, opencode");
  }
  const harness = rawHarness as DoctorHarness;
  const machineIssues = runDoctor(false, harness, { installationOnly: true });
  const st = enrollment.inspectEnrollment(ws);
  const root = st.enabled && st.worktree ? wikiRootFor(resolve(ws), st.worktree) : resolve(ws);
  const wikiPath = join(root, "docs", "wiki");
  const wikiReady = statSafe(wikiPath)?.isDirectory() === true;
  let indexPath = "";
  let indexReady = false;
  try {
    indexPath = idx(root).dbPath;
    indexReady = statSafe(indexPath)?.isFile() === true;
  } catch {
    /* reported below */
  }
  let contextReady = false;
  if (st.enabled && wikiReady) {
    try {
      contextReady = buildContext(root).trim().length > 0;
    } catch {
      contextReady = false;
    }
  }

  console.log(`=== project work-memory readiness (${root}) ===`);
  console.log(`  [project] ${st.enabled ? "✅ enrolled" : "❌ not enrolled"}`);
  console.log(`  [wiki] ${wikiReady ? `✅ ${wikiPath}` : `❌ missing or unreadable: ${wikiPath}`}`);
  console.log(`  [index] ${indexReady ? `✅ ${indexPath}` : "❌ derived index missing — re-run llmwiki init"}`);
  console.log(`  [memory] ${contextReady ? "✅ cold-start context is non-empty" : "❌ no cold-start context"}`);
  if (harness === "codex") console.log("  [codex] • hook trust remains visible only in Codex `/hooks` (one-time install action)");
  if (harness === "opencode") console.log("  [opencode] • restart once after setup or clone re-pointing so the global plugin reloads");

  const ready = machineIssues === 0 && st.enabled && wikiReady && indexReady && contextReady;
  console.log(
    ready
      ? "=== READY: automatic work-memory read and capture mechanics are active for this project ==="
      : "=== NOT READY: fix the item(s) above, then re-run this command ===",
  );
  if (!ready) process.exitCode = 1;
}

// Local runtime state: report it, or delete exactly the artifacts llmwiki created. Reached
// through `setup.sh --uninstall [--purge-data]`; exposed here so the installed CLI can do it too.
// Where the engine keeps this project's derived state. Scripts and skills need a way to ask —
// writing into the repository to find out is exactly what this layout removes.
function cmdStatePath(p: Parsed) {
  const root = resolve(p.positionals[0] ?? die("state-path <workspace> [subpath] required"));
  const sub = p.positionals[1];
  const location = resolveProjectStateLocation(root);
  if (p.flags["--ensure"]) {
    console.log(sub ? ensureProjectStateDir(root, sub) : ensureProjectStateDir(root));
    return;
  }
  if (location === null) {
    console.error(
      ko
        ? "이 저장소에는 아직 엔진 보관 상태가 없다 — 먼저 `llmwiki index`/`init`, 또는 `--ensure` 로 생성"
        : "no engine-held state for this repository yet — run `llmwiki index`/`init` first, or pass `--ensure`",
    );
    process.exit(1);
  }
  console.log(sub ? join(location.dir, sub) : location.dir);
}

// Move the state root off the engine clone. Checked automatically (doctor says so), applied by a
// person — the same split as engine updates, and for the same reason: this touches data the user
// would not want moved behind their back.
function cmdMigrateState(p: Parsed) {
  const commit = p.flags["--commit"] === true;
  const result = migrateStateRoot(watchProcessRunning(), commit);
  const { plan } = result;
  if (result.kind === "not-needed") {
    console.log(ko ? `상태 루트 이관 불필요 — ${plan.reason}` : `no state migration needed — ${plan.reason}`);
    console.log(`  ${plan.from}`);
    return;
  }
  if (result.kind === "blocked") {
    console.error(
      ko ? "상태 루트를 옮길 수 없다:" : "cannot move the state root yet:",
    );
    for (const b of plan.blockers) console.error(`  - ${b}`);
    process.exit(1);
  }
  if (result.kind === "dry-run") {
    console.log(ko ? "상태 루트 이관 계획 (dry-run):" : "state migration plan (dry-run):");
    console.log(`  from: ${plan.summary}`);
    console.log(`  to  : ${plan.to}`);
    console.log(
      ko
        ? "  적용: `llmwiki migrate-state --commit` · 이후 `bash <clone>/daemon/install.sh` 로 서비스 정의 갱신"
        : "  apply: `llmwiki migrate-state --commit`, then re-run `bash <clone>/daemon/install.sh` so the service points at the new root",
    );
    return;
  }
  console.log(ko ? `✓ 상태 루트 이관 완료: ${plan.to}` : `✓ state root moved to ${plan.to}`);
  console.log(
    ko
      ? "  서비스 정의에 옛 경로가 구워져 있다 — `bash <clone>/daemon/install.sh` 를 재실행할 것"
      : "  the installed service still names the old path — re-run `bash <clone>/daemon/install.sh`",
  );
}

function cmdPurgeState(p: Parsed) {
  const dir = capture.stateDir();
  if (!p.flags["--confirm"]) {
    console.log(
      ko
        ? `llmwiki 로컬 상태: ${describeStateRoot(dir)}\n  (보존됨 — 삭제하려면 \`--confirm\`, 또는 \`./setup.sh --uninstall --purge-data\`)`
        : `llmwiki local state: ${describeStateRoot(dir)}\n  (retained — delete it with \`--confirm\`, or \`./setup.sh --uninstall --purge-data\`)`,
    );
    console.log(
      ko
        ? "  포함: 캡처 큐(어느 저장소에서 언제 작업했는지)·데몬 로그·OpenCode 트랜스크립트 내보내기"
        : "  contents: the capture queue (which repositories you worked in, and when), the daemon log, and OpenCode transcript exports",
    );
    return;
  }
  const result = purgeOwnedState(dir);
  if (result.error) {
    console.error(`⚠ ${result.error}`);
    console.error(
      ko ? "  (llmwiki가 만들지 않은 디렉터리는 건드리지 않는다 — 직접 확인 후 삭제할 것)" : "  (a directory llmwiki did not create is never deleted — inspect and remove it yourself)",
    );
    process.exitCode = 1;
    return;
  }
  console.log(`✓ removed ${result.removed.length} owned artifact(s): ${result.removed.join(", ") || "(none)"}`);
  console.log(
    result.rootRemoved
      ? `✓ state directory removed: ${dir}`
      : `• state directory kept (it still holds entries llmwiki does not own): ${dir}`,
  );
}

function cmdEnabled(p: Parsed) {
  // The adapter-facing predicate: no stdout at all, exit code is the whole answer.
  if (!isEnrolled(p.positionals[0] || process.cwd())) process.exit(1);
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
// (docs/wiki/5_topic). Dry-run (default) surfaces candidate concepts for a warm /wiki-save to
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
        ? "  → 웜 /wiki-save 에서 재발·내구 개념만 선별해 5_topic 페이지로 병합 (또는 --commit 로 무인 게이트 실행)."
        : "  → in a warm /wiki-save, merge only durable/recurring concepts into 5_topic (or run --commit for the gated pass).",
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

// P0-1a: deterministic retrieval benchmark (LLM-0, engine-dev tool — not part of any loop).
function cmdBench(p: Parsed) {
  const ws = p.positionals[0] ?? die("bench <workspace> [--tune-only|--sealed] required");
  const subset = p.flags["--sealed"] ? "sealed" : p.flags["--tune-only"] ? "tune" : "all";
  if (subset === "sealed") {
    console.error("⚠️  sealed subset opened — every look weakens it as a regression guard; iterate on --tune-only.");
  }
  const transcript = typeof p.flags["--transcript"] === "string" ? (p.flags["--transcript"] as string) : "";
  const limitFlag = typeof p.flags["--limit"] === "string" ? Number(p.flags["--limit"]) : NaN;
  const report = runBench(ws, subset as any, {
    downstreamRead: Boolean(p.flags["--downstream-read"]) || Boolean(transcript),
    transcripts: transcript ? [transcript] : undefined,
    transcriptLimit: Number.isFinite(limitFlag) ? limitFlag : undefined,
  });
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  console.log(`=== bench [${report.subset}] ${report.n} queries (${report.n_content} content / ${report.n_refusal} refusal) ===`);
  for (const [k, v] of Object.entries(report.recall)) console.log(`  search ${k}: ${pct(v)}`);
  console.log(`  turn-context pointer hit: ${pct(report.tc_pointer_hit)}`);
  if (report.n_refusal) console.log(`  turn-context refusal ok: ${pct(report.tc_refusal_ok)}`);
  // What a session gets without anyone running a command — the two automatic channels, priced.
  const ps = report.passive;
  const kb = (b: number) => `${(b / 1024).toFixed(1)}KB`;
  console.log(`--- passive delivery (no command, no /wiki-ask) ---`);
  console.log(`  reach (pointer arrived unasked): ${pct(ps.reach)}`);
  if (report.n_refusal) console.log(`  silence on off-topic prompts:    ${pct(ps.silence)}`);
  console.log(`  cost: ${kb(ps.coldstart_bytes)} once per session · per turn p50 ${kb(ps.turn_bytes_p50)} / p95 ${kb(ps.turn_bytes_p95)}`);
  const langs = Object.entries(ps.by_lang);
  if (langs.length) {
    console.log(`  reach by asking language:   ${langs.map(([l, v]) => `${l} ${pct(v.reach)} (n=${v.n})`).join(" · ")}`);
  }
  const langsS = Object.entries(ps.by_lang_silence);
  if (langsS.length) {
    console.log(`  silence by asking language: ${langsS.map(([l, v]) => `${l} ${pct(v.reach)} (n=${v.n})`).join(" · ")}`);
  }
  const rec = Object.entries(ps.by_recoverability);
  if (rec.length) {
    console.log(`  reach by where else the answer exists: ${rec.map(([k, v]) => `${k} ${pct(v.reach)} (n=${v.n})`).join(" · ")}`);
    console.log(`  answerable from the wiki and nowhere else: ${pct(ps.irreplaceable)}`);
  }
  // What happened after the pointer arrived. Separate block, separate denominator: this one is
  // read off real sessions on THIS machine, not off the golden set.
  const dr = report.downstream_read;
  if (dr) {
    console.log(`--- downstream read (captured sessions; Read tool only) ---`);
    if (!dr.injected) {
      console.log(`  no llmwiki injection found in ${dr.transcripts} transcript(s) — not measured`);
    } else {
      const ch = (k: "turn_context" | "cold_start") => {
        const c = dr.by_channel[k];
        return `${pct(c.reach)} (${c.matched}/${c.injected})`;
      };
      console.log(`  pointer opened later in the same session: ${pct(dr.pointer_reach)} (${dr.matched}/${dr.injected})`);
      console.log(`    turn-context ${ch("turn_context")} · cold-start ${ch("cold_start")}`);
      console.log(`    over ${dr.transcripts} transcript(s), ${dr.read_events} wiki Read(s)`);
      console.log(`  not counted: ${dr.blind_spots.join("; ")}`);
    }
  }
  const out = writeResults(ws, report);
  console.log(`  → ${out}`);
}

// Generated public scale tiers. Durations and byte distributions are evidence only: the suite's
// `gating` field states the CI contract explicitly, and no absolute timing threshold exists here.
function cmdBenchScale(p: Parsed) {
  const repeats = Number(String(p.flags["--repeats"] ?? "5"));
  if (!Number.isInteger(repeats) || repeats < 1) die("bench-scale --repeats must be a positive integer");
  console.log(JSON.stringify(runScaleSuite(repeats), null, 2));
}

// Historical-session scale: deterministic counts, observational timing. `--sessions` accepts a
// comma-separated subset so contributors can run a quick tier before the public 100/1k/10k pass.
async function cmdBenchCapture(p: Parsed) {
  const { CAPTURE_SCALE_TIERS, runCaptureScaleSuite } = await import("./engine/bench-capture.ts");
  const repeats = Number(String(p.flags["--repeats"] ?? "3"));
  if (!Number.isInteger(repeats) || repeats < 1) die("bench-capture --repeats must be a positive integer");
  const raw = typeof p.flags["--sessions"] === "string" ? String(p.flags["--sessions"]) : "";
  const tiers = raw ? raw.split(",").map((value) => Number(value.trim())) : [...CAPTURE_SCALE_TIERS];
  if (!tiers.length || tiers.some((tier) => !Number.isInteger(tier) || tier < 1)) {
    die("bench-capture --sessions must be a comma-separated list of positive integers");
  }
  console.log(JSON.stringify(runCaptureScaleSuite(repeats, tiers), null, 2));
}

// The follow-through half of the read loop, standalone. `bench` folds it in when a repo has a
// golden set; most repos never will, and the question "does anyone open what we point at" is
// worth asking without one. Reads captured transcripts only — no wiki writes, no session cost.
function cmdDownstreamRead(p: Parsed) {
  const scope = p.positionals[0] ?? "";
  const transcript = typeof p.flags["--transcript"] === "string" ? (p.flags["--transcript"] as string) : "";
  const limitFlag = typeof p.flags["--limit"] === "string" ? Number(p.flags["--limit"]) : NaN;
  const files = transcript
    ? [transcript]
    : pickTranscripts(discoverClaudeTranscripts(), Number.isFinite(limitFlag) ? limitFlag : 30);
  const r = summarizeDownstreamRead(files.map((f) => scanTranscript(f)), scope ? resolve(scope) : "");
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  console.log(`=== downstream read — ${files.length} transcript(s)${scope ? ` · ${resolve(scope)}` : " · all repos"} ===`);
  // No early return: a fresh machine has no Claude history yet, and that is exactly when the
  // ledger section below carries the whole answer.
  if (!r.injected) {
    console.log(ko ? "  주입된 포인터 없음 — 측정 불가 (0% 아님)" : "  no injected pointers found — not measured (not 0%)");
    if (scope) printLedgerSection(resolve(scope));
    return;
  }
  console.log(`  pointer opened later in the same session: ${pct(r.pointer_reach)} (${r.matched}/${r.injected})`);
  for (const k of ["turn_context", "cold_start"] as const) {
    const c = r.by_channel[k];
    if (c.injected) console.log(`    ${k.replace("_", "-")}: ${pct(c.reach)} (${c.matched}/${c.injected})`);
  }
  console.log(`  pages: ${r.unique_matched_pages}/${r.unique_injected_pages} distinct pointed pages were opened`);
  console.log(`  wiki opens seen: ${r.read_events} Read + ${r.bash_open_events} Bash${r.malformed_lines ? ` · ${r.malformed_lines} unparsable line(s)` : ""}`);
  console.log(ko ? "  집계 제외:" : "  not counted:");
  for (const b of r.blind_spots) console.log(`    - ${b}`);
  if (scope) printLedgerSection(resolve(scope));
}

// The emission-ledger view: injections come from the engine's own record (all three harnesses),
// reads from each harness's persisted tool records. Unlike the transcript scan above, this covers
// Codex (exec opens) and OpenCode (read-tool parts) — but only from the moment the ledger began.
function printLedgerSection(root: string): void {
  const emissions = readEmissionsFor(root);
  console.log(ko ? `--- 방출 원장 (3하네스 공통) ---` : `--- emission ledger (all harnesses) ---`);
  if (!emissions.length) {
    console.log(
      ko
        ? "  기록 없음 — 원장은 이 엔진 버전부터 쌓인다 (다음 세션들부터 측정 가능)"
        : "  empty — the ledger starts with this engine version (measurable from the next sessions on)",
    );
    return;
  }
  const reads = [...claudeLedgerReads(), ...scanCodexReads(discoverCodexRollouts()), ...scanOpenCodeReads()];
  const r = matchEmissions(emissions, reads);
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  console.log(`  emissions: ${r.emissions} (${r.sessions} session(s)) · pointers ${r.injected}`);
  console.log(`  opened later in the same session: ${pct(r.pointer_reach)} (${r.matched}/${r.injected})`);
  for (const k of ["turn_context", "cold_start"] as const) {
    const c = r.by_channel[k];
    if (c.injected) console.log(`    ${k.replace("_", "-")}: ${pct(c.reach)} (${c.matched}/${c.injected})`);
  }
  // The other half of the same question. Reach alone says whether a pointer paid off; it cannot
  // say what saying it COST, and injected text is re-sent with every later turn of that session.
  // Per-emission averages are what a trimming decision is actually made against, so they are what
  // gets printed — a total would grow with usage and mean nothing on its own.
  if (r.weighed) {
    const kb = (n: number) => `${(n / 1024).toFixed(1)}KB`;
    console.log(
      ko
        ? `  주입 비용 (${r.weighed}/${r.emissions}건 계측):`
        : `  injection cost (measured on ${r.weighed}/${r.emissions}):`,
    );
    for (const k of ["turn_context", "cold_start"] as const) {
      const c = r.by_channel[k];
      if (!c.weighed) continue;
      const per = c.bytes / c.weighed;
      const perPointer = c.injected ? ` · ${Math.round(c.bytes / c.injected)}B per pointer` : " · no pointers";
      console.log(`    ${k.replace("_", "-")}: ${Math.round(per)}B avg × ${c.weighed} = ${kb(c.bytes)}${perPointer}`);
    }
  } else if (r.emissions) {
    console.log(
      ko
        ? "  주입 비용: 미계측 — 원장의 기존 줄은 크기 기록 이전이다 (다음 세션들부터 측정됨)"
        : "  injection cost: not measured — these ledger lines predate the field (measured from the next sessions on)",
    );
  }
  const by = Object.entries(r.matched_by_harness);
  if (by.length) console.log(`  matched by: ${by.map(([h, n]) => `${h} ${n}`).join(" · ")}`);
  console.log(
    ko
      ? "  집계 제외: Codex는 shell 열람을 셈(전용 read 도구 없음) · OpenCode bash 열람 미포함 · 서브에이전트 미포함"
      : "  notes: Codex counts shell opens (no read tool) · OpenCode bash opens not counted · subagents not counted",
  );
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
  for (const [id, delta] of Object.entries(verdict.per_query_deltas).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (delta === 0) continue;
    console.log(`  query ${id} delta: ${delta > 0 ? "+" : ""}${delta.toFixed(3)}`);
  }
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
  console.log("frontmatter (required): title · description · date · tags(≥2) · status(ready|draft) · domain · source; queue items also stamp owner(github login); authorship comes from git history (mailmap-aware), never `author:`; optional: updated");
  if (c.bannedTerms.length) console.log(`banned terms: ${c.bannedTerms.map(([a, b]) => `${a}→${b}`).join(" · ")}`);
}

// Restructure the wiki to the effective config (folder renames + link rewriting + domain
// updates + .schema-version). Dry-run by default; --commit applies; --map old=new[,…] resolves
// ambiguous pairs. Never runs automatically — cold-start/doctor only suggest it.
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
        ? "  오늘 낼 문항 없음 — 작업을 /wiki-save 로 쌓으면 신규 후보가 생긴다."
        : "  nothing to ask today — file work with /wiki-save to grow new candidates.",
    );
    return;
  }
  sel.picks.forEach((pick, i) => {
    if (pick.kind === "new") {
      const c = pick.candidate!;
      // The hub marker tells the session WHY this page was chosen, so the question it authors
      // can aim at the concept other pages were built on rather than the page's incidentals.
      const hub = c.hub ? (ko ? ` · 허브(피인용 ${c.refs})` : ` · hub(${c.refs} inbound)`) : "";
      console.log(`${i + 1}. [new] docs/wiki/${c.page} — ${c.domain || c.dir}${c.date ? ` · ${c.date}` : ""}${hub} · "${c.title}"`);
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

// ---- harness data-location discovery (locate/connect) -------------------------------------
// Installer-facing (the agent following setup_text.md), so the output stays English by design.
// 3-tier contract: deterministic resolution → schema-signature verification → LLM fallback
// that may PROPOSE a path but can only persist one the engine has verified (fail-closed).

function asHarness(value: string | undefined): Harness | null {
  return value && (HARNESSES as readonly string[]).includes(value) ? (value as Harness) : null;
}

// One line per candidate with the tier that produced it; a harness with no verified
// candidate prints the search→verify→persist fallback contract instead of silence.
function locateReport(harness: Harness): void {
  const line = (mark: string, origin: string, path: string, detail: string) =>
    console.log(`  [${harness}] ${mark} ${path} (${origin}) — ${detail}`);
  const candidates: { origin: string; path: string }[] = [];
  if (harness === "claude") {
    const env = envValueOutsideRepoFiles("CLAUDE_CONFIG_DIR")?.trim();
    if (env) candidates.push({ origin: "env CLAUDE_CONFIG_DIR", path: env });
    for (const dir of persistedClaudeDirs()) candidates.push({ origin: "persisted", path: dir });
    for (const dir of claudeConfigDirs())
      if (!candidates.some((c) => c.path === dir)) candidates.push({ origin: "default scan", path: dir });
  } else if (harness === "codex") {
    const env = envValueOutsideRepoFiles("CODEX_HOME")?.trim();
    const persisted = persistedCodexHome();
    if (env) candidates.push({ origin: "env CODEX_HOME", path: env });
    else if (persisted) candidates.push({ origin: "persisted", path: persisted });
    else candidates.push({ origin: "default", path: codexHome() });
  } else {
    const env = envValueOutsideRepoFiles("OPENCODE_DB")?.trim();
    const persisted = persistedOpencodeDb();
    if (env) candidates.push({ origin: "env OPENCODE_DB", path: env });
    else if (persisted) candidates.push({ origin: "persisted", path: persisted });
    else for (const db of opencodeDbPaths()) candidates.push({ origin: "XDG scan", path: db });
  }
  let verified = 0;
  for (const c of candidates) {
    const v = verifyHarnessPath(harness, c.path);
    if (v.ok) verified += 1;
    line(v.ok ? "✅" : "⚠️", c.origin, c.path, v.detail);
  }
  if (verified === 0) {
    // Nothing deterministic resolved. Before asking anyone anything, look in the places the default
    // predictably misses (WSL's Windows profile, XDG variants) and persist a winner outright. Only
    // an empty or ambiguous result reaches a human, and it arrives as the one handoff format.
    const auto = autoConnect(harness);
    if (auto.status === "connected") {
      console.log(`  [${harness}] ✅ ${auto.detail}`);
      return;
    }
    for (const line of renderHandoff(auto)) console.log(line);
  }
}

function cmdLocate(p: Parsed) {
  const first = p.positionals[0];
  const harness = asHarness(first);
  if (first && !harness) die(`locate [${HARNESSES.join("|")}] [path] — unknown harness: ${first}`);
  const candidate = p.positionals[1];
  if (candidate) {
    // Resolve BEFORE verifying, and echo the resolved path in the connect line. `connect` resolves
    // against its own cwd, so verifying `./x` here and persisting `./x` from another directory used
    // to record a location that was never checked.
    const path = resolve(candidate);
    const v = verifyHarnessPath(harness!, path);
    console.log(`  [${harness}] ${v.ok ? "✅" : "❌"} ${path} — ${v.detail}`);
    if (v.ok) console.log(`  [${harness}] persist it with: llmwiki connect ${harness} ${JSON.stringify(path)}`);
    else process.exit(1);
    return;
  }
  console.log("=== llmwiki locate (harness data locations: deterministic → verified → fallback) ===");
  for (const h of harness ? [harness] : HARNESSES) locateReport(h);
}

function cmdConnect(p: Parsed) {
  const harness = asHarness(p.positionals[0]);
  if (!harness) die(`connect <${HARNESSES.join("|")}> <path> | connect <harness> --forget`);
  if (p.flags["--forget"]) {
    console.log(
      forgetHarnessPath(harness)
        ? `✓ removed the persisted ${harness} data location — deterministic resolution is back in charge`
        : `• nothing persisted for ${harness}`,
    );
    return;
  }
  const path = p.positionals[1] ?? die(`connect ${harness} <absolute-path> required`);
  const r = connectHarnessPath(harness, resolve(path));
  if (!r.ok) {
    // Fail-closed: the engine records only what its own signature check accepted.
    die(`refused: ${r.detail}\n  (nothing was persisted — verify a candidate first: llmwiki locate ${harness} <path>)`);
  }
  console.log(`✓ ${harness} data location persisted (${r.saved}) — ${r.detail}`);
  // Do the restart rather than describing one. The daemon re-reads persisted locations every sweep
  // regardless, so this is about immediacy (the watch list is built at start), and every outcome
  // here is already a working one.
  console.log(`  ${restartDaemon().detail}`);
}

// Commands the HARNESS runs automatically on every session/turn. They resolve the repository
// themselves and check enrollment before touching per-repo config, so an unenrolled repository
// never reaches config resolution (which reads repository files) at all.
const AUTOMATIC_COMMANDS = new Set(["context", "turn-context", "enabled"]);

const HANDLERS: Record<CommandName, (p: Parsed) => void | Promise<void>> = {
  init: cmdInit,
  disable: cmdDisable,
  status: cmdStatus,
  verify: cmdVerify,
  enabled: cmdEnabled,
  "purge-state": cmdPurgeState,
  "migrate-state": cmdMigrateState,
  "state-path": cmdStatePath,
  config: cmdConfig,
  conventions: cmdConventions,
  migrate: MAINTENANCE_HANDLERS.migrate,
  "db-health": MAINTENANCE_HANDLERS["db-health"],
  compact: MAINTENANCE_HANDLERS.compact,
  "wiki-clean": MAINTENANCE_HANDLERS["wiki-clean"],
  "wiki-clean-apply": MAINTENANCE_HANDLERS["wiki-clean-apply"],
  "wiki-doctor": MAINTENANCE_HANDLERS["wiki-doctor"],
  bench: cmdBench,
  "bench-scale": cmdBenchScale,
  "bench-capture": cmdBenchCapture,
  "downstream-read": cmdDownstreamRead,
  "compare-arm": cmdCompareArm,
  "compare-verdict": cmdCompareVerdict,
  index: cmdIndex,
  reindex: cmdReindex,
  refs: cmdRefs,
  lint: cmdLint,
  search: cmdSearch,
  "update-status": cmdUpdateStatus,
  "save-current": cmdSaveCurrent,
  "update-next": cmdUpdateNext,
  related: cmdRelated,
  "update-done": cmdUpdateDone,
  "update-enqueue": cmdUpdateEnqueue,
  skeleton: cmdSkeleton,
  autoupdate: cmdAutoupdate,
  ingest: cmdIngest,
  "hermes-export": cmdHermesExport,
  consolidate: cmdConsolidate,
  "distill-verify": cmdDistillVerify,
  topics: cmdTopics,
  "register-transcript": cmdRegisterTranscript,
  excerpt: cmdExcerpt,
  review: cmdReview,
  overview: MAINTENANCE_HANDLERS.overview,
  gaps: MAINTENANCE_HANDLERS.gaps,
  "git-rules": cmdGitRules,
  locate: cmdLocate,
  connect: cmdConnect,
  doctor: MAINTENANCE_HANDLERS.doctor,
  context: cmdContext,
  "turn-context": cmdTurnContext,
  digest: cmdDigest,
  "context-audit": cmdContextAudit,
  reconcile: cmdReconcile,
  "capture-prune": MAINTENANCE_HANDLERS["capture-prune"],
  "quiz-status": cmdQuizStatus,
  "quiz-next": cmdQuizNext,
  "quiz-record": cmdQuizRecord,
};

let parsed: Parsed;
try {
  parsed = parseCliArgs(process.argv.slice(2));
} catch (error) {
  if (error instanceof MissingCliFlagValueError || error instanceof UnknownCliFlagError) die(error.message);
  throw error;
}
if (parsed.cmd === "--help" || parsed.cmd === "-h") {
  process.stdout.write(renderRootHelp(packageJson.version));
  process.exit(0);
}
if (parsed.cmd === "--version") {
  process.stdout.write(`llmwiki ${packageJson.version}\n`);
  process.exit(0);
}
const spec = commandSpec(parsed.cmd);
if (spec && parsed.flags["--help"]) {
  process.stdout.write(renderCommandHelp(spec));
  process.exit(0);
}
// Per-repo language: if the first positional is an existing path, resolve that workspace's
// config (a named config may set lang); otherwise cwd. LLMWIKI_LANG env still wins.
if (!AUTOMATIC_COMMANDS.has(parsed.cmd)) {
  const wsGuess =
    parsed.positionals[0] && existsSync(parsed.positionals[0]) ? parsed.positionals[0] : process.cwd();
  LANG = isRepoKorean(wsGuess) ? "ko" : "en";
  ko = LANG === "ko";
}
const handler = HANDLERS[parsed.cmd as CommandName];
if (!handler) {
  // Bare `llmwiki` is a person asking what exists — give them the catalog. A WRONG command is
  // usually an agent mid-session, and echoing the whole catalog charges ~5.7KB of context per
  // typo; one line and a nearest match answer the actual question.
  if (!parsed.cmd) die(renderRootHelp(packageJson.version).trimEnd());
  const nearest = suggestCommands(parsed.cmd);
  die(
    [
      `unknown command: ${parsed.cmd}`,
      ...(parsed.cmd.includes(" ") ? ["  (the whole line arrived as ONE argument — check shell quoting/splitting)"] : []),
      ...(nearest.length ? [`  did you mean: ${nearest.join(", ")}?`] : []),
      "  `llmwiki --help` lists commands; `llmwiki <command> --help` explains one.",
    ].join("\n"),
  );
}
// A harness hook may now reach this CLI without going through hooks/*.sh — on Windows the Codex
// wiring calls it directly, because `bash` is not on the Windows PATH and Codex runs hook commands
// through PowerShell, where neither the bare name nor a quoted absolute path resolves (the hooks
// only ever reported "exited with code 1"). Bypassing the adapter means carrying its two
// guarantees here, or they are silently lost on exactly the platform that needed the bypass.
const asHook = typeof parsed.flags["--hook-event"] === "string";
// (1) An engine subprocess must not self-inject into its own WRITE/VERIFY prompt.
if (asHook && (process.env.LLMWIKI_ENGINE_SUBPROCESS ?? "") !== "") process.exit(0);
try {
  await handler(parsed);
} catch (e) {
  // (2) A hook never fails a session. Silence and exit 0 — the same fail-safe the shell adapters
  //     spell as `set +e` … `exit 0`.
  if (asHook) process.exit(0);
  // A refusal is a RESULT, not a crash. Both boundaries below are things a user can act on
  // (a symlinked wiki path, a state directory llmwiki did not create), so they get one clear
  // line and exit 2 instead of a stack trace.
  if (e instanceof RepoBoundaryError) {
    die(
      ko
        ? `거부됨: ${e.message}\n  (llmwiki는 저장소 밖으로 나가는 심볼릭 링크를 따라가지 않는다 — 경로를 고친 뒤 다시 실행)`
        : `refused: ${e.message}\n  (llmwiki never follows a symlink out of a repository — fix that path and re-run)`,
    );
  }
  if (e instanceof StateRootError) die(e.message);
  throw e;
}
