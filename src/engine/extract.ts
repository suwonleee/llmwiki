// Incremental transcript extractor — cheap tier-1 of the 2-tier update.
// Reads a Claude Code session .jsonl from a byte offset (watermark) forward and
// pulls only the signal needed to file-back: user instructions + substantive
// assistant conclusions.
//
// CRITICAL: offsets are BYTE positions. new_offset = start + raw.length must be
// computed on the Buffer (bytes), never on a decoded string (JS strings are UTF-16).
import { readFileSync } from "node:fs";

export interface Turn {
  ts: string;
  role: string;
  text: string;
}

export interface Increment {
  users: Turn[];
  assistants: Turn[];
  newOffset: number; // byte offset to persist as the new watermark
  cwd: string | null; // working directory of the session (repo routing key)
  sessionId: string | null;
}

// Shared byte-tail read used by every source adapter: read from `startOffset` (the
// watermark) to EOF and report the new watermark. CRITICAL: the new offset is computed on
// the Buffer (bytes), never on a decoded string (JS strings are UTF-16).
export function readTail(path: string, startOffset = 0): { raw: Buffer; newOffset: number } {
  const buf = readFileSync(path);
  const raw = buf.subarray(startOffset); // bytes from watermark → EOF
  return { raw, newOffset: startOffset + raw.length };
}

export function extractIncrement(
  path: string,
  startOffset = 0,
  minChars = 180,
  cap = 700,
): Increment {
  const users: Turn[] = [];
  const assistants: Turn[] = [];
  let cwd: string | null = null;
  let sessionId: string | null = null;

  const { raw, newOffset } = readTail(path, startOffset);

  // Split bytes on \n then decode (0x0a never occurs inside a UTF-8 multibyte seq).
  const text = raw.toString("utf-8"); // invalid sequences → U+FFFD (≈ errors="replace")
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    cwd = o.cwd || cwd;
    sessionId = o.sessionId || o.session_id || sessionId;

    const typ = o.type;
    const msg = o.message || {};
    const content = msg.content;
    let t = "";
    if (typeof content === "string") {
      t = content;
    } else if (Array.isArray(content)) {
      for (const p of content) {
        if (p && typeof p === "object" && p.type === "text") t += p.text ?? "";
      }
    }
    t = t.split(/\s+/).filter(Boolean).join(" ").trim();
    if (!t) continue;
    const ts = String(o.timestamp ?? "").slice(0, 16);

    if (typ === "user") {
      if (t.startsWith("<") || t.slice(0, 40).includes("system-reminder")) continue;
      users.push({ ts, role: "user", text: t.slice(0, cap) });
    } else if (typ === "assistant") {
      if (t.length >= minChars) assistants.push({ ts, role: "assistant", text: t.slice(0, cap) });
    }
  }

  return { users, assistants, newOffset, cwd, sessionId };
}

export function render(inc: Increment): string {
  // English labels: this rendered extract is embedded in the (English) WRITE prompt and shown
  // by `update-next`; keeping it language-neutral matches the prompts-stay-English policy.
  const lines = [`=== user utterances (instructions): ${inc.users.length} ===`];
  for (const t of inc.users) lines.push(`[${t.ts}] ${t.text}`);
  lines.push(`\n=== assistant substantive conclusions: ${inc.assistants.length} ===`);
  for (const t of inc.assistants) lines.push(`\n[${t.ts}] ${t.text}`);
  return lines.join("\n");
}
