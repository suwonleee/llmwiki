// Plain-text / markdown adapter (kind="plain") — the daemon-free, Claude-free
// "drop a source" path (drop a doc into raw and let the wiki condense it).
//
// It is never auto-discovered (discover() returns []) — a plain file only enters the
// pipeline via an explicit `llmwiki ingest <file>`. parse() treats the whole byte-tail as
// ONE user turn: the dropped document IS the material to condense. It still honors the
// byte-offset watermark, so re-ingesting an unchanged file is a no-op (use --force to
// re-read an edited drop from the top).
import { existsSync, readFileSync, statSync } from "node:fs";
import type { DiscoveredSession, TranscriptSource } from "../source.ts";
import { readTail, type Increment } from "../extract.ts";

export const plainSource: TranscriptSource = {
  kind: "plain",

  discover(): DiscoveredSession[] {
    return []; // ingest-only; the daemon never auto-captures arbitrary files
  },

  // Greedy: claims any readable, non-empty regular file. MUST be probed last (see
  // source.ts REGISTRY ordering) so real formats win first.
  probe(path: string): DiscoveredSession | null {
    if (!existsSync(path)) return null;
    try {
      if (!statSync(path).isFile()) return null;
    } catch {
      return null;
    }
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      return null;
    }
    if (text.length === 0) return null;
    let lines = 1;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x0a) lines++;
    return { path, sessionId: null, repo: null, lines };
  },

  parse(path: string, startOffset: number): Increment {
    const { raw, newOffset } = readTail(path, startOffset);
    const text = raw.toString("utf-8").trim();
    // A dropped file carries no session timestamp; stamp the ingest moment so the page
    // gets a sensible date (filename prefix + _date fallback) instead of 0000-00-00.
    const ts = new Date().toISOString().slice(0, 16);
    const users = text ? [{ ts, role: "user", text }] : [];
    return { users, assistants: [], newOffset, cwd: null, sessionId: null };
  },
};
