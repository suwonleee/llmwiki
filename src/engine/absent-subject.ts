// "Nothing here is about that": a prompt whose subject this project has never mentioned.
//
// Lexical scores cannot tell an unanswerable question from an answerable one — a question about a
// tool the project never used still shares its everyday words with dozens of pages. What does tell
// them apart is the subject itself: on one project's held-out set, the names in unanswerable
// questions (a tracker, an IaC tool, a message broker) appeared in no wiki page, no commit message
// and no tracked file, while every unfamiliar word in an answerable question appeared in the code.
//
// Only ASCII names are tested: they carry product and API names, and a missing Hangul inflection
// (받던데 · 예전에) is not a missing subject. Read-only; one bounded `git grep` per turn, and only
// when a name is unknown to the wiki and the commit log, which is rare.
import { spawnSync } from "node:child_process";

const MIN_CHARS = 4;
const MAX_CANDIDATES = 6;

/** Names from `terms` that occur in no wiki text, commit message, or tracked file of `repo`. */
export function absentNames(repo: string, terms: readonly string[], wikiText: (t: string) => boolean, logText: string): string[] {
  const log = logText.toLowerCase();
  // A spaced name is spelled joined in code and config (Spring Boot → spring-boot · springboot).
  const spellings = (t: string) => (t.includes(" ") ? [t, t.replace(/ /g, "-"), t.replace(/ /g, "_"), t.replace(/ /g, "")] : [t]);
  const cand = [...new Set(terms.map((t) => t.toLowerCase()))]
    .filter((t) => /^[a-z][a-z0-9_. -]*$/.test(t) && t.length >= MIN_CHARS - 1)
    .filter((t) => spellings(t).every((s) => !wikiText(s) && !log.includes(s)))
    .slice(0, MAX_CANDIDATES);
  if (!cand.length) return [];
  const all = cand.flatMap(spellings);
  const r = spawnSync("git", ["-C", repo, "grep", "-I", "-i", "-F", "-o", "-h", "-m", "1", ...all.flatMap((t) => ["-e", t]), "HEAD", "--"], {
    encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024,
  });
  // status 1 = no match at all; anything else but 0 is an error, and an error proves nothing.
  if (r.status === 1) return cand;
  if (r.status !== 0 || typeof r.stdout !== "string") return [];
  const found = new Set(r.stdout.split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean));
  return cand.filter((t) => spellings(t).every((s) => !found.has(s)));
}

/** Words the prompt writes as names: an inner capital or digit (GraphQL · gRPC · S3), all caps
 * (SAML), or a capital that does not merely start a sentence (… Notion 으로). A lowercase word is
 * ordinary vocabulary — "changing" is absent from a Korean Kotlin repo without being a subject. */
export function writtenNames(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(/[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*/g)) {
    const before = prompt.slice(0, m.index).trimEnd();
    // A capital that opens an ENGLISH sentence is grammar; one opening a Korean sentence is a name.
    const after = prompt.slice(m.index! + m[0].length);
    const sentenceStart = (before === "" || /[.!?。？！:]$/.test(before)) && /^\s*[A-Za-z]/.test(after);
    for (const part of m[0].split("-")) {
      const inner = /[a-z][A-Z]|[0-9]/.test(part) || /^[A-Z]{3,}$/.test(part);
      const capital = /^[A-Z][a-z]/.test(part) && !(sentenceStart && part === m[0].split("-")[0]);
      if (part.length >= MIN_CHARS - 1 && (inner || capital)) out.push(part);
    }
  }
  // A multi-word name (Microsoft Teams · Apple Pay) is a subject of its own even when every word
  // occurs somewhere in the code.
  for (const m of prompt.matchAll(/\b(?:[A-Z][A-Za-z0-9]*|[A-Z]{2,})(?: (?:[A-Z][A-Za-z0-9]*|[A-Z]{2,}))+\b/g)) out.push(m[0]);
  return [...new Set(out)];
}

/** A question asks; an instruction may name something that does not exist yet on purpose. */
export function isQuestion(prompt: string): boolean {
  const p = prompt.trim();
  if (/[?？]\s*$/.test(p) || /[?？]/.test(p)) return true;
  return /(?:나요|까요|가요|ㄹ까|는지|었죠|했죠|인가|어요|에요)\s*[.!]?\s*$/u.test(p);
}

export function absenceLine(names: readonly string[], ko: boolean): string {
  const list = names.map((n) => `\`${n}\``).join(", ");
  return ko
    ? `  • ${list} — 이 저장소의 위키·커밋 메시지·추적 파일 어디에도 없음 (이 주제의 기록이 없다)`
    : `  • ${list} — not found in this repository's wiki, commit messages, or tracked files (no record on this subject)`;
}
