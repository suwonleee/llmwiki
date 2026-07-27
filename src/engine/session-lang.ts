// "What language is this session working in?" — answered from what the session already produced.
//
// The engine is a CLI with no view of the conversation, so it reads the two artefacts a session
// leaves behind, in order of authority:
//
//   1. the wiki's own CONTENT pages — written by earlier sessions in their own language. Using
//      these first also makes the answer sticky: a wiki cannot flip language between runs, which
//      matters on a team where one member types Korean and another English.
//   2. the human's own utterances in this repo's captured transcripts — all a brand-new wiki has.
//
// Engine-authored files (skeleton, log, ledgers, cold index) are excluded on purpose: an English
// skeleton seeded on day one must never lock a Korean team into English.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { detectLangOfMany } from "./lang-detect.ts";
import type { WikiLang, WikiConfig } from "./config.ts";

const MAX_PAGES = 12; // newest pages sampled — enough that one stray page cannot decide
const MAX_TRANSCRIPTS = 3;
const MAX_UTTERANCE_CHARS = 4000;
// Read only the tail of a transcript: a language needs a few sentences, not a whole session, and
// sessions reach many megabytes. The tail is also the most recent part, which is what we want.
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/**
 * Human-written wiki pages — the category folders and the topic encyclopedia only, newest first.
 *
 * Newest matters: a wiki that ran in English for a year and switched to Korean last month should
 * follow the switch, not be outvoted by its own history. Sampling the most recent pages also keeps
 * this cheap on a large wiki.
 */
function contentPages(root: string, cfg: WikiConfig): string[] {
  const wiki = join(root, "docs", "wiki");
  const dirs = [...cfg.categories.map((c) => c.dir), cfg.topicDir];
  const files: { path: string; mtime: number }[] = [];
  for (const dir of dirs) {
    const full = join(wiki, dir);
    if (!existsSync(full)) continue;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const path = join(full, entry.name);
      try {
        files.push({ path, mtime: statSync(path).mtimeMs });
      } catch {
        /* vanished mid-scan → skip */
      }
    }
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_PAGES)
    .map((f) => f.path);
}

function readAll(paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const path of paths) {
    try {
      out.push(readFileSync(path, "utf-8"));
    } catch {
      /* vanished mid-read → skip */
    }
  }
  return out;
}

/** The human's own turns from this repo's captured sessions (never the assistant's). */
function humanUtterances(root: string): string[] {
  try {
    // Imported lazily: an existing wiki answers from its pages and never needs the queue module.
    // The read-only query below also refuses to create a queue on a fresh installation.
    const capture = require("./capture.ts") as typeof import("./capture.ts");
    const extract = require("./extract.ts") as typeof import("./extract.ts");
    const transcripts = capture.transcriptsForRepoReadOnly(root).slice(-MAX_TRANSCRIPTS);
    const said: string[] = [];
    for (const { path } of transcripts) {
      if (!existsSync(path)) continue;
      let start = 0;
      try {
        const size = statSync(path).size;
        start = size > TRANSCRIPT_TAIL_BYTES ? size - TRANSCRIPT_TAIL_BYTES : 0;
      } catch {
        continue;
      }
      const text = extract
        .extractIncrement(path, start) // a truncated first line simply fails to parse and is skipped
        .users.map((turn) => turn.text)
        .join("\n")
        .slice(0, MAX_UTTERANCE_CHARS);
      if (text.trim()) said.push(text);
    }
    return said;
  } catch {
    return []; // no queue, no transcripts, unreadable state → simply no opinion from this tier
  }
}

/** The session's language, or null when neither tier has enough prose to tell. */
export function detectSessionLang(root: string, cfg: WikiConfig): WikiLang | null {
  return detectLangOfMany(readAll(contentPages(root, cfg))) ?? detectLangOfMany(humanUtterances(root));
}
