// A disposable, prompt-only reminder. Never open a transcript or equate enqueue with save.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalRoot } from "./repo-write.ts";

export type SaveNudgeEvent = "completed" | "declined";
interface NudgeState { turns: number; signal: boolean; last: string; emitted: boolean; terminal?: SaveNudgeEvent }
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_BYTES = 2048;
const MIN_TURNS = 8;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export const saveNudgeEnabled = () => (process.env.LLMWIKI_SAVE_NUDGE ?? "").trim().toLowerCase() !== "off";
export const _saveNudgeDir = (repo: string, session: string) => join(tmpdir(), `llmwiki-save-nudge-${digest(`${canonicalRoot(repo)}\n${session}`).slice(0, 24)}`);
const own = (st: Stats) => typeof process.getuid !== "function" || st.uid === process.getuid();

function directory(repo: string, session: string): string | null {
  if (!session.trim() || session.length > 512) return null;
  const path = _saveNudgeDir(repo, session);
  try { mkdirSync(path, { mode: 0o700 }); } catch { /* existing; validate below */ }
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink() && own(st) && (st.mode & 0o077) === 0 ? path : null;
  } catch { return null; }
}

// Serialize competing hooks and claim emission under the same lock. An interrupted writer
// leaves a lock and silences reminders for that session; duplicate reminders are worse.
function change(repo: string, session: string, apply: (st: NudgeState) => string): { ok: boolean; text: string } {
  const dir = directory(repo, session);
  if (!dir) return { ok: false, text: "" };
  const lock = join(dir, "lock");
  let locked = false;
  let fd: number | null = null;
  try {
    closeSync(openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600));
    locked = true;
    const path = join(dir, "state.json");
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | NOFOLLOW, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || !own(stat) || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > MAX_BYTES) return { ok: false, text: "" };
    let st: NudgeState = { turns: 0, signal: false, last: "", emitted: false };
    if (stat.size) {
      const parsed = JSON.parse(readFileSync(fd, "utf8"));
      if (!Number.isSafeInteger(parsed.turns) || parsed.turns < 0 || parsed.turns > 1_000_000 || typeof parsed.signal !== "boolean" || typeof parsed.emitted !== "boolean" || typeof parsed.last !== "string" || !/^[a-f0-9]{64}$/.test(parsed.last) || (parsed.terminal !== undefined && !["completed", "declined"].includes(parsed.terminal))) return { ok: false, text: "" };
      st = parsed;
    }
    const text = apply(st);
    // Explicit position: readFileSync has advanced the descriptor to EOF.
    const bytes = Buffer.from(JSON.stringify(st));
    writeSync(fd, bytes, 0, bytes.length, 0);
    ftruncateSync(fd, bytes.length);
    return { ok: true, text };
  } catch { return { ok: false, text: "" }; }
  finally {
    if (fd !== null) closeSync(fd);
    if (locked) { try { unlinkSync(lock); } catch { /* fail quiet */ } }
  }
}

/** Generic synthetic signals, never actual user utterances. Only the incoming prompt is read. */
export function hasSaveSignal(prompt: string): boolean {
  return /앞으로|하지\s*마|이걸로\s*가자|그게\s*아니라|정정|결정|\b(?:from now on|do not|don't|we decided|let['’]s use|correction|instead of)\b|今後|しないで|ではなく|以后|不要|决定/iu.test(prompt);
}

/** Model context only. The caller must deliver the returned hint; no human systemMessage. */
export function observeSaveNudge(repo: string, prompt: string, session: string, opts: { ko?: boolean } = {}): string {
  if (!saveNudgeEnabled() || !prompt.trim() || !session.trim() || /^\s*\/wiki-(?:save|deep)\b/i.test(prompt)) return "";
  return change(repo, session, st => {
    if (st.terminal || st.emitted) return "";
    const last = digest(prompt);
    if (st.last === last) return ""; // a retried delivery is not another user turn
    st.last = last;
    st.turns = Math.min(st.turns + 1, 1_000_000);
    st.signal ||= hasSaveSignal(prompt);
    if (st.turns < MIN_TURNS || !st.signal) return "";
    st.emitted = true;
    return opts.ko
      ? "[llmwiki save hint — 모델용] 의미 있는 결정이 있었다면 작업을 마칠 때 `/wiki-save`를 한 번 제안하라. 사용자가 원하지 않으면 다시 제안하지 마라."
      : "[llmwiki save hint — model only] If this work produced a meaningful decision, offer `/wiki-save` once when wrapping up. If the user declines, do not offer again.";
  }).text;
}

/** Explicit warm assertion, after successful close-out or a clear refusal. Enqueue is neither. */
export function recordSaveNudgeEvent(repo: string, session: string, event: SaveNudgeEvent): boolean {
  if (event !== "completed" && event !== "declined") return false;
  return change(repo, session, st => {
    st.terminal = event;
    if (!st.last) st.last = digest("");
    return "";
  }).ok;
}
