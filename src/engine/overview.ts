// overview --normalize (P1-B2): keep overview.md a bounded entry point, structurally — not by
// discipline (ref 11: safety in structure, not the model's goodwill). overview must catalog tracks,
// not accumulate a per-session changelog: that belongs in log.md. This collapses any grown
// "Recent Updates" section body down to a single pointer line, deterministically and idempotently
// (LLM-0). Curated sections (Direction / Key Findings / Related notes — in the wiki's own language) are preserved verbatim.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OVERVIEW_BUDGET } from "./budgets.ts";

// The canonical one-line body the "Recent Updates" section is collapsed to.
export const RECENT_POINTER =
  "세션별 변경 이력은 [[log.md]] 참조 (overview는 엔트리포인트 — 세션 단락 누적 금지).";

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
export function normalizeOverviewText(content: string): { text: string; collapsed: boolean } {
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
  const canonical = [lines[start]!, "", RECENT_POINTER, ""];
  // Already canonical? (heading + blank + exact pointer, ignoring trailing blanks)
  const cur = lines.slice(start, end).filter((l) => l.trim() !== "");
  if (cur.length === 2 && cur[1] === RECENT_POINTER) return { text: content, collapsed: false };
  const next = [...lines.slice(0, start), ...canonical, ...lines.slice(end)];
  // collapse accidental >1 trailing blank lines at the splice seam
  const text = next.join("\n").replace(/\n{3,}/g, "\n\n");
  return { text, collapsed: true };
}

export function normalizeOverview(ws: string, opts: { check?: boolean } = {}): OverviewResult {
  const root = resolve(ws);
  const path = join(root, "docs", "wiki", "overview.md");
  if (!existsSync(path)) return { verdict: "skip", reason: "overview.md 없음" };
  const before = readFileSync(path, "utf-8");
  const { text, collapsed } = normalizeOverviewText(before);
  const oversized = text.length > OVERVIEW_BUDGET;
  if (!collapsed) {
    return { verdict: "unchanged", path, before: before.length, after: before.length, oversized };
  }
  if (!opts.check) writeFileSync(path, text, "utf-8");
  return { verdict: "normalized", path, before: before.length, after: text.length, collapsed, oversized };
}
