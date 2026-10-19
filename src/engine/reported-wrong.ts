// Compact explicit-feedback state only: never a harness/transcript scan on the hot path.
import { createHash } from "node:crypto";
import { projectStateIsRegularFile, readProjectState } from "./project-state.ts";
import { readRepoFileBytes, repoFileMetadata } from "./repo-write.ts";

export interface RecheckedPage {
  page: string; sha256: string; evidence: { path: string; signature: string }[];
}

/** Bound hot-path work to metadata probes. A touch may conservatively reopen a check;
 * ctime also detects content edits whose caller restored the old mtime and size. */
export function recheckEvidenceSignature(root: string, path: string): string | null {
  const meta = repoFileMetadata(root, path);
  return meta && meta.size <= 1024 * 1024 && meta.mtimeNs > 0n && meta.ctimeNs > 0n
    ? `${meta.size}:${meta.mtimeNs}:${meta.ctimeNs}` : null;
}

export function reportedWrongPages(root: string): Set<string> {
  const out = new Set<string>();
  try {
    if (!projectStateIsRegularFile(root, "observe", "usage-affinity.json")) return out;
    const state = JSON.parse(readProjectState(root, "observe/usage-affinity.json", 1024 * 1024) ?? "null");
    if (state?.version !== 1 || !Array.isArray(state.wrong)) return out;
    const signatures = new Map<string, string | null>();
    const signature = (path: string): string | null => {
      if (signatures.has(path)) return signatures.get(path)!;
      if (signatures.size >= 64) return null;
      const value = recheckEvidenceSignature(root, path);
      signatures.set(path, value);
      return value;
    };
    for (const item of [...state.wrong.slice(0, 512), ...(Array.isArray(state.rechecked) ? state.rechecked.slice(0, 512) : [])]) {
      if (typeof item?.page !== "string" || !item.page.startsWith("docs/wiki/") || !/^[a-f0-9]{64}$/.test(item.sha256)) continue;
      const bytes = readRepoFileBytes(root, item.page);
      if (bytes === null || createHash("sha256").update(bytes).digest("hex") !== item.sha256) continue;
      // Legacy wrong entries have no evidence and remain pending. New accepted checks retain
      // their bounded evidence signatures; missing/unsafe/changed evidence reopens the warning.
      const accepted = Array.isArray(item.evidence) && item.evidence.length >= 1 && item.evidence.length <= 8 &&
        item.evidence.every((e: any) => typeof e?.path === "string" && typeof e.signature === "string" &&
          signature(e.path) !== null && signature(e.path) === e.signature);
      if (!accepted) out.add(item.page);
    }
  } catch { /* missing or malformed state is not evidence */ }
  return out;
}
