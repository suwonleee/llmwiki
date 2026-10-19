// Compact explicit-feedback state only: never a harness/transcript scan on the hot path.
import { createHash } from "node:crypto";
import { projectStateIsRegularFile, readProjectState } from "./project-state.ts";
import { readRepoFileBytes } from "./repo-write.ts";

export function reportedWrongPages(root: string): Set<string> {
  const out = new Set<string>();
  try {
    if (!projectStateIsRegularFile(root, "observe", "usage-affinity.json")) return out;
    const state = JSON.parse(readProjectState(root, "observe/usage-affinity.json", 256 * 1024) ?? "null");
    if (state?.version !== 1 || !Array.isArray(state.wrong)) return out;
    for (const item of state.wrong.slice(0, 512)) {
      if (typeof item?.page !== "string" || !item.page.startsWith("docs/wiki/") || !/^[a-f0-9]{64}$/.test(item.sha256)) continue;
      const bytes = readRepoFileBytes(root, item.page);
      if (bytes !== null && createHash("sha256").update(bytes).digest("hex") === item.sha256) out.add(item.page);
    }
  } catch { /* missing or malformed state is not evidence */ }
  return out;
}
