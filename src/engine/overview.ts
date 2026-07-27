// overview --normalize (P1-B2): keep overview.md a bounded entry point, structurally — not by
// discipline (ref 11: safety in structure, not the model's goodwill). overview must catalog tracks,
// not accumulate a per-session changelog: that belongs in log.md. This collapses any grown
// "Recent Updates" section body down to a single pointer line, deterministically and idempotently
// (LLM-0). Curated sections (Direction / Key Findings / Related notes — in the wiki's own language) are preserved verbatim.
import { join, resolve } from "node:path";
import { OVERVIEW_BUDGET } from "./budgets.ts";
import { resolveWikiLang, getConfig, resolveLang, type LangCatalog, type WikiLang } from "./config.ts";
import { readRepoFile, writeRepoFile } from "./repo-write.ts";

// The canonical one-line body the "Recent Updates" section is collapsed to. This is PAGE CONTENT
// committed into the user's repository, so it follows the wiki's language — and both variants
// count as canonical, so reading a Korean wiki from an English shell never rewrites it.
export const RECENT_POINTER: LangCatalog<string> = {
  en: "See [[log.md]] for the per-session change history (overview is the entry point — no session sections here).",
  ko: "세션별 변경 이력은 [[log.md]] 참조 (overview는 엔트리포인트 — 세션 단락 누적 금지).",
  ja: "セッションごとの変更履歴は [[log.md]] を参照（overview はエントリポイント — セッション段落を積まない）。",
  zh: "每次会话的变更历史见 [[log.md]]（overview 是入口 — 不在此累积会话段落）。",
};
export const RECENT_POINTER_EN = RECENT_POINTER.en;
export const RECENT_POINTER_KO = RECENT_POINTER.ko as string;

/** The pointer this wiki writes. Every language's pointer counts as canonical when reading. */
export function recentPointer(lang: WikiLang): string {
  return RECENT_POINTER[lang] ?? RECENT_POINTER.en;
}

const CANONICAL_POINTERS = new Set(Object.values(RECENT_POINTER));

// Matches the section heading in either language we emit. Body = everything until the next `## ` or EOF.
const RECENT_HEADING = /^##\s+(Recent Updates|최근 업데이트)\s*$/i;

export interface OverviewResult {
  verdict: "normalized" | "unchanged" | "skip";
  path?: string;
  before?: number;
  after?: number;
  collapsed?: boolean; // a multi-line Recent Updates body was reduced to the pointer
  oversized?: boolean; // remaining content still exceeds OVERVIEW_BUDGET (advisory)
  reason?: string;
}

// Pure transform (exported for tests): collapse the Recent Updates section body to the pointer.
// Returns the new text and whether anything changed. Leaves a file with no such section untouched.
export function normalizeOverviewText(content: string, lang: WikiLang = resolveLang()): { text: string; collapsed: boolean } {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => RECENT_HEADING.test(l));
  if (start === -1) return { text: content, collapsed: false };
  // find the end of the section (next top-level heading, or EOF)
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const canonical = [lines[start]!, "", recentPointer(lang), ""];
  // Already canonical? (heading + blank + exact pointer in EITHER language, ignoring trailing blanks)
  const cur = lines.slice(start, end).filter((l) => l.trim() !== "");
  if (cur.length === 2 && cur[1] !== undefined && CANONICAL_POINTERS.has(cur[1])) {
    return { text: content, collapsed: false }; // any language's pointer → already normalized
  }
  const next = [...lines.slice(0, start), ...canonical, ...lines.slice(end)];
  // collapse accidental >1 trailing blank lines at the splice seam
  const text = next.join("\n").replace(/\n{3,}/g, "\n\n");
  return { text, collapsed: true };
}

export function normalizeOverview(ws: string, opts: { check?: boolean } = {}): OverviewResult {
  const root = resolve(ws);
  const rel = join("docs", "wiki", "overview.md");
  const path = join(root, rel);
  const lang = resolveWikiLang(root);
  const before = readRepoFile(root, rel);
  if (before === null) return { verdict: "skip", reason: lang === "ko" ? "overview.md 없음" : "no overview.md" };
  const { text, collapsed } = normalizeOverviewText(before, lang);
  const oversized = text.length > OVERVIEW_BUDGET;
  if (!collapsed) {
    return { verdict: "unchanged", path, before: before.length, after: before.length, oversized };
  }
  if (!opts.check) writeRepoFile(root, rel, text);
  return { verdict: "normalized", path, before: before.length, after: text.length, collapsed, oversized };
}
