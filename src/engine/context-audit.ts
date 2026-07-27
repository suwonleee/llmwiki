// context-audit — advisory hygiene check for agent-config files (CLAUDE.md / AGENTS.md / MEMORY.md).
//
// These files are injected into EVERY Claude Code / Codex session, so bloat is a fixed per-session
// context tax (cf. "Stop Using /init for AGENTS.md", 2026: auto-generated overviews duplicate what the
// agent can already grep and inflate cost 20%+). This is a DETERMINISTIC, READ-ONLY advisory — it never
// edits the files. They shape agent behavior across ALL future sessions, so pruning is human judgment,
// the same stance as `review` (advisory → human applies). Absent files are skipped
// (never created). Conceptually this is the lint operation extended to the schema layer.
import { getConfig, isRepoKorean } from "./config.ts";
import { join, relative as relpath } from "node:path";
import { readRepoFile, readRepoRoot, repoFileExists, repoRelative } from "./repo-write.ts";

// Message language resolves per repo at call time (per-repo config).
const _ko = (repo: string) => isRepoKorean(repo);

// Rough token estimate (word count × 4/3) — same heuristic used for the doc metrics; exact tokens
// don't matter for an advisory, only the order of magnitude.
function estTokens(s: string): number {
  const words = s.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil((words * 4) / 3);
}

export interface AuditFinding {
  file: string; // repo-relative path
  tokens: number;
  issues: string[]; // human-readable advisory lines (never auto-applied)
}

// Section headers an agent can rediscover by reading the repo → discoverable noise (the article's
// core filter: "can the agent find this by reading the code? if yes, delete it").
const OVERVIEW_PATTERNS: RegExp[] = [
  /^#{1,4}\s.*(아키텍처|architecture)/im,
  /^#{1,4}\s.*(기술\s*스택|tech\s*stack)/im,
  /^#{1,4}\s.*(디렉터리|디렉토리|directory|폴더\s*구조|project\s*structure|디렉토리\s*구조)/im,
  /^#{1,4}\s.*(코드\s*스타일|code\s*style|네이밍|naming|컨벤션|convention)/im,
  /^#{1,4}\s.*(빌드|build|설치\s|install|테스트\s*명령|test\s*command|^#{1,4}\s*commands?\b)/im,
  /^#{1,4}\s.*(프로젝트\s*개요|project\s*overview|^#{1,4}\s*overview\b)/im,
  /^#{1,4}\s.*(모델\s*id|model\s*config|환경\s*변수|environment\s*variable)/im,
];

// NOTE: no opinionated terminology check here — what counts as "stale wording" is project-specific,
// and this is a public, clone-anywhere template. The signals below are universal (size / discoverable
// overview / wiki redundancy), so an adopter inherits the *concept* without our local preferences.
const SIZE_WARN_TOKENS = 800;

// Config files that harnesses auto-inject. Absent ones are silently skipped.
function targetFiles(repo: string): string[] {
  const out: string[] = [];
  const cands = [
    "CLAUDE.md", ".claude/CLAUDE.md",
    "AGENTS.md", ".claude/AGENTS.md",
    "MEMORY.md", ".claude/MEMORY.md",
  ];
  for (const c of cands) {
    if (repoFileExists(repo, c)) out.push(join(repo, c));
  }
  // Hierarchical AGENTS.md: scan immediate subdirs (one level) for nested files.
  for (const e of readRepoRoot(repo)) {
    if (e.isDirectory && !e.name.startsWith(".") && !["node_modules", "docs", "dist", "build"].includes(e.name)) {
      const rel = join(e.name, "AGENTS.md");
      if (repoFileExists(repo, rel)) out.push(join(repo, rel));
    }
  }
  return out;
}

function auditFile(repo: string, path: string): AuditFinding {
  const ko = _ko(repo);
  const content = readRepoFile(repo, repoRelative(repo, path)) ?? "";
  const tokens = estTokens(content);
  const issues: string[] = [];

  if (tokens > SIZE_WARN_TOKENS) {
    issues.push(
      ko
        ? `~${tokens}토큰 (>${SIZE_WARN_TOKENS}) — 매 세션 고정 주입되는 비용`
        : `~${tokens} tokens (>${SIZE_WARN_TOKENS}) — fixed cost injected every session`,
    );
  }

  const overview = OVERVIEW_PATTERNS.filter((re) => re.test(content)).length;
  if (overview > 0) {
    issues.push(
      ko
        ? `발견가능 overview 섹션 ${overview}종 — 코드/README로 grep 가능, 핵심 경고만 남기길`
        : `${overview} discoverable overview section(s) — agent can grep these; keep critical warnings only`,
    );
  }

  // Wiki redundancy: if this repo has an llmwiki L0 that the cold-start hook already injects, an
  // overview-laden config file double-injects the same orientation.
  if (
    repoFileExists(repo, join("docs", "wiki", "current-state.md")) &&
    /current-state|docs\/wiki/i.test(content) &&
    overview > 0
  ) {
    issues.push(
      ko
        ? `docs/wiki/current-state 와 중복 가능 — 콜드스타트 훅이 이미 현황을 주입함`
        : `may duplicate docs/wiki/current-state — already injected by the cold-start hook`,
    );
  }

  return { file: relpath(repo, path), tokens, issues };
}

/** Audit a repo's agent-config files. Returns only files that have at least one finding. Read-only. */
export function auditContext(repo: string): AuditFinding[] {
  return targetFiles(repo)
    .map((p) => auditFile(repo, p))
    .filter((f) => f.issues.length > 0);
}

/** One-line cold-start nudge (consumed by context.ts). Empty string if nothing to flag. Fail-safe. */
export function auditNudge(repo: string): string {
  try {
    const ko = _ko(repo);
    const findings = auditContext(repo);
    if (!findings.length) return "";
    const total = findings.reduce((a, x) => a + x.tokens, 0);
    const names = findings.map((x) => x.file).join(", ");
    return ko
      ? `----- [llmwiki context-audit] 설정파일 ${findings.length}개 ~${total}토큰/세션 (${names}) — overview 군더더기 점검: \`llmwiki context-audit\` -----`
      : `----- [llmwiki context-audit] ${findings.length} config file(s) ~${total} tokens/session (${names}) — trim with \`llmwiki context-audit\` -----`;
  } catch {
    return "";
  }
}

/** Pretty advisory report for the CLI (print-only; never edits the files). */
export function formatAudit(repo: string, findings: AuditFinding[]): string {
  const ko = _ko(repo);
  const L: string[] = [];
  L.push(ko ? `=== context-audit (advisory · 비편집) ${repo} ===` : `=== context-audit (advisory · read-only) ${repo} ===`);
  if (!findings.length) {
    L.push(ko ? "  ✓ 설정파일 깨끗 (또는 없음 — skip)" : "  ✓ config files clean (or absent — skipped)");
    return L.join("\n");
  }
  const total = findings.reduce((a, x) => a + x.tokens, 0);
  L.push(ko ? `  ${findings.length}개 파일 · 합 ~${total}토큰/세션` : `  ${findings.length} file(s) · ~${total} tokens/session total`);
  for (const f of findings) {
    L.push(`  • ${f.file}  (~${f.tokens}t)`);
    for (const i of f.issues) L.push(`      - ${i}`);
  }
  L.push(
    ko
      ? "  ※ advisory — 엔진은 이 파일들을 고치지 않음. 사람이 핵심 경고만 남기고 직접 정리.\n  ※ 필터: 코드를 grep해 알 수 있으면 적지 않는다. 파일 없으면 무시."
      : "  ※ advisory — the engine never edits these. The human trims to critical warnings only.\n  ※ filter: if the agent can grep it, don't write it. Absent files are ignored.",
  );
  return L.join("\n");
}
