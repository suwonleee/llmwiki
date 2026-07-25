import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type MaintenanceState = {
  readonly lastNoticeAt: string;
  readonly compactionEligible: boolean;
  readonly liveIndexedBytes: number;
};

const STATE_PATH = join(".llmwiki", "maintenance-state.json");
const SEVEN_DAYS = 7 * 86_400_000;

function isMaintenanceState(value: unknown): value is MaintenanceState {
  return (
    typeof value === "object" && value !== null &&
    "lastNoticeAt" in value && typeof value.lastNoticeAt === "string" &&
    "compactionEligible" in value && typeof value.compactionEligible === "boolean" &&
    "liveIndexedBytes" in value && typeof value.liveIndexedBytes === "number"
  );
}

function parseState(root: string): MaintenanceState | null {
  const path = join(root, STATE_PATH);
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isMaintenanceState(value)) return value;
  } catch {
    return null;
  }
  return null;
}

function writeState(root: string, state: MaintenanceState): void {
  const path = join(root, STATE_PATH);
  mkdirSync(join(root, ".llmwiki"), { recursive: true });
  const temp = `${path}.tmp-${crypto.randomUUID()}`;
  writeFileSync(temp, JSON.stringify(state), "utf8");
  renameSync(temp, path);
}

export function maintenanceNotice(root: string, report: { readonly compactionEligible: boolean; readonly liveIndexedBytes: number }, now = new Date()): boolean {
  const previous = parseState(root);
  const elapsed = previous === null ? Number.POSITIVE_INFINITY : now.getTime() - Date.parse(previous.lastNoticeAt);
  const thresholdCrossed = previous === null || previous.compactionEligible !== report.compactionEligible;
  const grew = previous !== null && report.liveIndexedBytes > previous.liveIndexedBytes * 1.1;
  const full = thresholdCrossed || grew || elapsed >= SEVEN_DAYS;
  writeState(root, {
    lastNoticeAt: full ? now.toISOString() : previous?.lastNoticeAt ?? now.toISOString(),
    compactionEligible: report.compactionEligible,
    liveIndexedBytes: report.liveIndexedBytes,
  });
  return full;
}
