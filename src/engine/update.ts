// Update orchestration — deterministic scaffolding around the LLM write step.
// Owns only deterministic parts: watermark state, incremental extraction, wiki
// skeleton + log bookkeeping.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import * as capture from "./capture.ts";
import { getConfig, logDirs, pickLangValue, resolveWikiLang, type WikiConfig } from "./config.ts";
import { render } from "./extract.ts";
import { sourceForKind, sourceForPath } from "./source.ts";
import { WikiIndex } from "./db.ts";
import { appendRepoFile, readRepoFile, repoFileExists, writeRepoFile } from "./repo-write.ts";

// Wiki categories: numbered by reading order.
// The LLM writes all of these by summarizing what the HUMAN decided/realized in the
// session — useful for next work, not noise.
//   1_direction = the project's big direction/strategy (and shifts in it)
//   2_milestone = work progress + what's next (execution/measurement facts + TODOs)
//   3_decision  = ADR — a problem the human faced, alternatives weighed, the choice made
//   4_insight   = realizations/lessons while working with the human (what made results better)
// Plus a special human-judgment queue (not a content category):
//   0_review    = items needing human judgment (auto-quarantine + LLM-posed questions);
//                 resolved files are deleted. Always surfaced to the terminal.
// All of these come from the resolved config (per repo): log categories = logDirs(cfg),
// queue = cfg.queueDir, topic encyclopedia = cfg.topicDir (built by consolidate.ts).

function basename(p: string): string {
  const parts = resolve(p).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : p;
}

export function enqueue(ws: string, transcriptPath: string, sessionId: string | null): void {
  const source = sourceForPath(transcriptPath);
  capture.enqueue(transcriptPath, sessionId, resolve(ws), 0, source.kind);
}

export function pending(ws: string): capture.CaptureRow[] {
  return capture.pending(resolve(ws));
}

export interface NextIncrement {
  rendered: string;
  newOffset: number;
  cwd: string | null;
  sessionId: string | null;
  nUsers: number;
  nAssistants: number;
}

export function nextIncrement(ws: string, transcriptPath: string): NextIncrement {
  const offset = capture.getOffset(transcriptPath);
  // Capture-time source_kind is the queue contract. This keeps update-next harness-neutral
  // even after a transcript moves or the user's active harness profile changes.
  const source = sourceForKind(capture.getSourceKind(transcriptPath));
  const inc = source.parse(transcriptPath, offset);
  new WikiIndex(ws).registerTranscript(transcriptPath, inc.sessionId);
  return {
    rendered: render(inc),
    newOffset: inc.newOffset,
    cwd: inc.cwd,
    sessionId: inc.sessionId,
    nUsers: inc.users.length,
    nAssistants: inc.assistants.length,
  };
}

export function markUpdated(ws: string, transcriptPath: string, newOffset: number, skipped = false): void {
  capture.mark(transcriptPath, newOffset, skipped ? "skipped" : "distilled");
}

export function ensureSkeleton(ws: string, cfg: WikiConfig = getConfig(resolve(ws))): void {
  const root = resolve(ws);
  const wiki = join(root, "docs", "wiki");
  // Skeleton template language adapts to LLMWIKI_LANG (default English, Korean when set) — a
  // fresh adopter's wiki should start in their language. (Page CONTENT later matches the conversation.)
  mkdirSync(wiki, { recursive: true });
  for (const c of logDirs(cfg)) mkdirSync(join(wiki, c), { recursive: true });
  mkdirSync(join(wiki, cfg.queueDir), { recursive: true });
  // The topic encyclopedia (5_topic): per-concept living pages built by consolidate.ts.
  // A different axis from the numbered log categories — created here so a fresh wiki is ready.
  mkdirSync(join(wiki, cfg.topicDir), { recursive: true });
  // The quiz layer (6_quiz): the HUMAN-side memory loop (ledger + session records, written by
  // /wiki-quiz + quiz-record). Deliberately excluded from index/search/cold-start — see quiz.ts.
  mkdirSync(join(wiki, cfg.quizDir), { recursive: true });
  const name = basename(root);
  const today = new Date().toISOString().slice(0, 10);
  const lang = resolveWikiLang(root, cfg); // unset config → this session's own language
  const overview = join(wiki, cfg.files.overview);
  if (!repoFileExists(overview) && !repoFileExists(join(wiki, cfg.files.l0))) {
    writeRepoFile(
      overview,
      `---\ntitle: Overview — ${name}\ndescription: Front page / cold-start context for ${name}\n` +
        `date: ${today}\ntags: [overview, meta]\n---\n\n` +
        pickLangValue<(project: string) => string>(
          {
            en: (project) =>
              `This wiki is the living knowledge of the **${project}** project (it auto-accumulates as you work).\n\n` +
              "## Direction (human-confirmed)\n\n## Key Findings\n\nNo sources condensed yet.\n\n## Recent Updates\n\n",
            ko: (project) =>
              `이 위키는 **${project}** 프로젝트의 살아있는 지식이다 (작업할수록 자동 누적).\n\n` +
              "## 방향성 (사람 확인)\n\n## Key Findings\n\n아직 update된 소스 없음.\n\n## Recent Updates\n\n",
            ja: (project) =>
              `このウィキは **${project}** プロジェクトの生きた知識です（作業するほど自動で蓄積されます）。\n\n` +
              "## 方向性（人が確認）\n\n## Key Findings\n\nまだ要約されたソースはありません。\n\n## Recent Updates\n\n",
            zh: (project) =>
              `本 wiki 是 **${project}** 项目的活知识（随着工作自动积累）。\n\n` +
              "## 方向（由人确认）\n\n## Key Findings\n\n尚未归纳任何来源。\n\n## Recent Updates\n\n",
          },
          lang,
        )(name),
    );
  }
  const cs = join(wiki, cfg.files.l0);
  if (!repoFileExists(cs)) {
    writeRepoFile(
      cs,
      `---\ntitle: Current State — ${name} (L0)\n` +
        pickLangValue(
          {
            en: "description: cold-start L0 — a one-glance snapshot of 'now' and 'next' (human-owned)\n",
            ko: "description: cold-start L0 — '지금'과 '다음'의 한눈 스냅샷 (사람이 소유·승격)\n",
            ja: "description: cold-start L0 — 「現在」と「次」の一目スナップショット（人が所有）\n",
            zh: "description: cold-start L0 — “现在”与“下一步”的一眼快照（由人所有）\n",
          },
          lang,
        ) +
        `updated: ${today}\ntags: [current-state, L0, meta]\n---\n\n` +
        pickLangValue(
          {
            en:
              "> **L0 (current state) is the judgment layer — the human owns it.** The LLM only *proposes* 'now/next'\n" +
              "> updates during /wiki-save·/wiki-deep; direction and absolute rules are confirmed by the human. (fork template placeholder)\n\n" +
              "## Direction (human-confirmed)\n\n- <big project direction — human changes only>\n\n" +
              "## Now (TL;DR)\n\n- <current core state in one line>\n    - <necessary evidence or condition>\n\n" +
              "## Next (remaining work)\n\n- <immediate next action>\n    - <owner, blocker, or completion condition>\n",
            ko:
              "> **L0(현재 상태)는 판단층 — 사람이 소유한다.** LLM은 `/wiki-save`·`/wiki-deep` 때 '지금/다음'\n" +
              "> 갱신을 *제안*만 하고, 방향성·절대 규칙은 사람이 확정한다. (포크용 템플릿 플레이스홀더)\n\n" +
              "## 방향성 (사람 확정)\n\n- <프로젝트의 큰 방향 — 사람만 변경>\n\n" +
              "## 지금 (TL;DR)\n\n- <현재 핵심 상태 한 줄>\n    - <필요한 근거·조건>\n\n" +
              "## 다음 (남은 작업)\n\n- <바로 다음 할 일>\n    - <담당·차단 요인·완료 조건>\n",
            ja:
              "> **L0（現在の状態）は判断層 — 人が所有します。** LLM は `/wiki-save`・`/wiki-deep` の際に「現在/次」の\n" +
              "> 更新を*提案*するだけで、方向性と絶対ルールは人が確定します。（フォーク用テンプレートのプレースホルダ）\n\n" +
              "## 方向性（人が確定）\n\n- <プロジェクトの大きな方向 — 人のみ変更>\n\n" +
              "## 現在 (TL;DR)\n\n- <現在の核心状態を一行で>\n    - <必要な根拠・条件>\n\n" +
              "## 次 (残りの作業)\n\n- <すぐ次にやること>\n    - <担当・ブロッカー・完了条件>\n",
            zh:
              "> **L0（当前状态）是判断层 — 由人所有。** LLM 只在 `/wiki-save`·`/wiki-deep` 时*建议*“现在/下一步”的\n" +
              "> 更新；方向与绝对规则由人确认。（供 fork 使用的模板占位）\n\n" +
              "## 方向（由人确认）\n\n- <项目的大方向 — 仅由人修改>\n\n" +
              "## 现在 (TL;DR)\n\n- <用一行写清当前核心状态>\n    - <必要的依据或条件>\n\n" +
              "## 下一步 (剩余工作)\n\n- <紧接着要做的事>\n    - <负责人·阻塞点·完成条件>\n",
          },
          lang,
        ),
    );
  }
  const log = join(wiki, cfg.files.log);
  if (!repoFileExists(log)) {
    writeRepoFile(
      log,
      `---\ntitle: Log\ndescription: ${pickLangValue(LOG_DESCRIPTION, lang)}\ndate: ${today}\ntags: [log, meta]\n---\n\n` +
        pickLangValue(LOG_BODY, lang),
    );
  }
  // Team-safety files (idempotent; harmless solo). Without these, a shared project commits the
  // SQLite index (binary merge conflicts) and concurrent log.md appends conflict on every merge.
  //   .gitignore    — .llmwiki/ is a derived, regenerable index; never commit it.
  //   .gitattributes — log.md is append-only, so merge=union concatenates concurrent appends
  //                    instead of conflicting (ecosystem-proven: OmegaWiki/AutoSci).
  _ensureLine(join(root, ".gitignore"), ".llmwiki/");
  _ensureLine(join(root, ".gitattributes"), "docs/wiki/log.md merge=union");
  //   .mailmap — authorship is READ from git rather than cached in frontmatter (decision
  //              2026-07-10), and git's own answer is wrong by default: one person committing
  //              from a work and a personal profile shows up as two contributors. .mailmap is
  //              git's built-in fix, and `%aN`/`%aE` honor it everywhere. Seeded with this
  //              machine's identity as a worked example the team can extend.
  _ensureMailmap(root);
  ensurePrivateDirs(root, cfg);
}

// Personal overlay (config [private] dirs): full local wiki citizens — indexed, searched,
// quizzed, linted — that never ship. The engine owns the git fencing (idempotent ignore lines),
// so "shared wiki, personal pages" costs no manual .gitignore discipline and no `git add .`
// accident surface; a committed config makes the convention team-wide. An empty list (the
// default) changes nothing — the team feature stays additive and silent for solo use.
export function ensurePrivateDirs(root: string, cfg: WikiConfig): void {
  for (const d of cfg.privateDirs) {
    mkdirSync(join(root, "docs", "wiki", d), { recursive: true });
    _ensureLine(join(root, ".gitignore"), `docs/wiki/${d}/`);
  }
}

// Seed .mailmap with a commented example plus this machine's identity, so `git log --format=%aN`
// (and anything reading it) collapses a person's several git identities into one. Idempotent and
// additive: an existing file is never rewritten, and a missing git identity writes only the note.
const LOG_DESCRIPTION = {
  en: "chronological ingest/update/lint record",
  ko: "시간순 ingest/update/lint 기록",
  ja: "時系列の ingest/update/lint 記録",
  zh: "按时间顺序的 ingest/update/lint 记录",
};

const LOG_BODY = {
  en: "chronological record of ingest·update·lint·decide (append-only).\n",
  ko: "ingest·update·lint·decide 의 시간순 기록 (append-only).\n",
  ja: "ingest·update·lint·decide の時系列記録（追記のみ）。\n",
  zh: "ingest·update·lint·decide 的时间顺序记录（仅追加）。\n",
};

function _ensureMailmap(root: string): void {
  const path = join(root, ".mailmap");
  if (repoFileExists(path)) return;
  const name = _gitConfig("user.name");
  const email = _gitConfig("user.email");
  const header =
    "# Canonical identities for `git log --format=%aN` (authorship is read from git, never cached\n" +
    "# in page frontmatter). One line per alias:  Canonical Name <canonical@email>  Alias <alias@email>\n";
  const seed = name && email ? `${name} <${email}> ${name} <${email}>\n` : "";
  try {
    writeRepoFile(path, header + seed);
  } catch {
    /* unwritable repo root → skip; scaffolding must never break a close-out */
  }
}

function _gitConfig(key: string): string {
  try {
    const r = spawnSync("git", ["config", key], { encoding: "utf-8" });
    return r.status === 0 ? (r.stdout ?? "").replace(/[\r\n]+/g, " ").trim() : "";
  } catch {
    return "";
  }
}

// Append `line` to `file` unless an identical line already exists; create the file if missing.
// Never rewrites existing content — safe on user-owned files.
function _ensureLine(file: string, line: string): void {
  try {
    const cur = readRepoFile(file);
    if (cur !== null) {
      if (cur.split("\n").some((l) => l.trim() === line)) return;
      appendRepoFile(file, (cur.endsWith("\n") || cur === "" ? "" : "\n") + line + "\n");
    } else {
      writeRepoFile(file, line + "\n");
    }
  } catch {
    /* fail-safe: never let a bookkeeping nicety break skeleton creation */
  }
}

export function appendLog(ws: string, kind: string, title: string, bullets: string[], date: string, cfg: WikiConfig = getConfig(resolve(ws))): void {
  const log = join(resolve(ws), "docs", "wiki", cfg.files.log);
  if (!repoFileExists(log)) ensureSkeleton(ws, cfg);
  const block = [`\n## [${date}] ${kind} | ${title}`];
  for (const b of bullets) block.push(`- ${b}`);
  appendRepoFile(log, block.join("\n") + "\n");
}
