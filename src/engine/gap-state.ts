import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Gap } from "./gaps.ts";

export const GAP_STATE_RELATIVE_PATH = join(".llmwiki", "gap-queue-state.json");

type GapState = {
  readonly version: 1;
  readonly resolved: readonly Gap[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResolvedGap(value: unknown): Gap | null {
  if (!isRecord(value)) return null;
  const { hash, type, text, status, absent, firstSeen, lastSeen, resolvedAt } = value;
  if (
    typeof hash !== "string" ||
    typeof type !== "string" ||
    typeof text !== "string" ||
    status !== "resolved" ||
    typeof absent !== "number" ||
    !Number.isInteger(absent) ||
    typeof firstSeen !== "string" ||
    typeof lastSeen !== "string" ||
    (resolvedAt !== undefined && typeof resolvedAt !== "string")
  ) {
    return null;
  }
  const gap: Gap = { hash, type, text, status, absent, firstSeen, lastSeen };
  if (typeof resolvedAt === "string") gap.resolvedAt = resolvedAt;
  return gap;
}

function parseGapState(value: unknown): readonly Gap[] | null {
  if (!isRecord(value) || value["version"] !== 1 || !Array.isArray(value["resolved"])) return null;
  const resolved = value["resolved"].map(parseResolvedGap);
  return resolved.every((gap): gap is Gap => gap !== null) ? resolved : null;
}

export function gapStatePath(root: string): string {
  return join(root, GAP_STATE_RELATIVE_PATH);
}

export function loadResolvedGapState(path: string): readonly Gap[] | null {
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return parseGapState(value);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function writeResolvedGapState(path: string, gaps: readonly Gap[]): void {
  const resolved = gaps
    .filter((gap) => gap.status === "resolved")
    .sort((a, b) => a.hash.localeCompare(b.hash));
  const state: GapState = { version: 1, resolved };
  writeFileSync(path, JSON.stringify(state), "utf-8");
}
