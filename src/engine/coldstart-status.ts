// Cold-start housekeeping has a shared 600-character budget. L0, operating rules,
// navigation and human judgment items are deliberately outside it: none may be cut.
import { splitFrontmatter } from "./okf.ts";
export const COLDSTART_STATUS_BUDGET = 600;

export interface StatusBlock {
  start: number;
  end: number;
  priority: number;
}

/** Fold whole low-priority blocks, preserving every byte when already within budget. */
export function budgetStatus(lines: string[], blocks: StatusBlock[], ko: boolean, budget = COLDSTART_STATUS_BUDGET): string {
  const size = (kept: Set<StatusBlock>) => blocks.filter((b) => kept.has(b))
    .map((b) => lines.slice(b.start, b.end).join("\n")).join("\n").length;
  const kept = new Set(blocks);
  if (size(kept) <= budget) return lines.join("\n");
  let folded = 0;
  const pointer = () => ko
    ? "[llmwiki] 상태 " + folded + "건 접음 → llmwiki status . --details"
    : "[llmwiki] " + folded + " status item(s) folded → llmwiki status . --details";
  for (const block of [...blocks].sort((a, b) => a.priority - b.priority || b.start - a.start)) {
    kept.delete(block);
    folded++;
    if (size(kept) + pointer().length + 1 <= budget) break;
  }
  const omitted = new Set<number>();
  for (const block of blocks) if (!kept.has(block)) {
    for (let i = block.start; i < block.end; i++) omitted.add(i);
  }
  return [...lines.filter((_, i) => !omitted.has(i)), pointer()].join("\n");
}

const TEMPLATE_HEADINGS = new Set([
  "Direction (human-confirmed)", "Active rules (human-confirmed)", "Now (TL;DR)", "Next (remaining work)",
  "방향성 (사람 확정)", "유효 규칙 (사람 확정)", "지금 (TL;DR)", "다음 (남은 작업)",
  "方向性（人が確定）", "有効なルール（人が確定）", "現在 (TL;DR)", "次 (残りの作業)",
  "方向（由人确认）", "有效规则（由人确认）", "现在 (TL;DR)", "下一步 (剩余工作)",
]);
const TEMPLATE_GUIDANCE = [
  "> **L0 (current state) is the judgment layer", "> updates during /wiki-save·/wiki-deep; direction",
  "> **L0(현재 상태)는 판단층", "> 갱신을 *제안*만 하고, 방향성",
  "> **L0（現在の状態）は判断層", "> 更新を*提案*するだけで、方向性",
  "> **L0（当前状态）是判断层", "> 更新；方向与绝对规则",
];

/** The init scaffold is metadata, headings, guidance and angle-bracket placeholders.
 * Strip only the known scaffold; any actual prose line opts into normal, whole injection. */
export function hasL0Content(body: string): boolean {
  const text = splitFrontmatter(body).body.replace(/<!--[\s\S]*?-->/g, "");
  return text.split(/\r?\n/).some((line) => {
    const s = line.trim();
    if (!s || TEMPLATE_HEADINGS.has(s.replace(/^#{1,6}\s+/, ""))) return false;
    if (TEMPLATE_GUIDANCE.some((prefix) => s.startsWith(prefix))) return false;
    // Placeholder-only bullets (including the two-placeholders standing-rule line).
    if (/^[-*]\s/.test(s) && !s.replace(/<[^<>]+>/g, "").replace(/[-*—–\s]/g, "")) return false;
    return true;
  });
}
