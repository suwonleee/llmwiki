import { join } from "node:path";
import type { Gap } from "./gaps.ts";
import { projectStatePath, readProjectState, writeProjectState } from "./project-state.ts";

export const GAP_STATE_NAME = "gap-queue-state.json";

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
  return projectStatePath(root, GAP_STATE_NAME);
}

// Derived state is engine-held (project-state.ts). A non-git directory keeps the legacy in-repo
// layout, and there the boundary still applies: a `.llmwiki` symlink planted by someone else's
// commit must neither be read through nor written through.
export function loadResolvedGapState(root: string): readonly Gap[] | null {
  const raw = readProjectState(root, GAP_STATE_NAME);
  if (raw === null) return null;
  try {
    return parseGapState(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export function writeResolvedGapState(root: string, gaps: readonly Gap[]): void {
  const resolved = gaps
    .filter((gap) => gap.status === "resolved")
    .sort((a, b) => a.hash.localeCompare(b.hash));
  const state: GapState = { version: 1, resolved };
  writeProjectState(root, GAP_STATE_NAME, JSON.stringify(state));
}
