// Unset `lang` means "the language of this session" — not English.
//
// The engine is a CLI: it cannot see the conversation. But it can see what the conversation already
// PRODUCED — the wiki's own content pages — and, before any page exists, the human's own utterances
// in this repo's captured transcripts. Those two, in that order, are the session language; English
// remains the last resort.
//
// Detection reads prose, never code: identifiers, paths, commands and fenced blocks are stripped
// first, so a Korean sentence full of English API names is still Korean.
//
// Order overall: LLMWIKI_LANG → an explicit `[wiki] lang` → detected → English. Explicit always
// wins, so a team can pin a language and never think about this again.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetForTests, resolveWikiLang } from "../src/engine/config.ts";
import { detectLang } from "../src/engine/lang-detect.ts";
import { ensureSkeleton } from "../src/engine/update.ts";
import { normalizeOverview } from "../src/engine/overview.ts";
import * as capture from "../src/engine/capture.ts";

const roots: string[] = [];
let langBefore: string | undefined;
let stateDir: string;

function mkRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-session-lang-"));
  roots.push(root);
  mkdirSync(join(root, "docs", "wiki", "3_decision"), { recursive: true });
  return root;
}

function page(root: string, name: string, body: string): void {
  writeFileSync(
    join(root, "docs", "wiki", "3_decision", name),
    `---\ntitle: A page\ndescription: fixture\ndate: 2026-07-25\ntags: [fixture, lang]\nstatus: ready\ndomain: decision\nsource: sess.jsonl\n---\n\n${body}`,
    "utf8",
  );
}

/** A captured session for this repo whose USER turns are in `text`. */
function capturedSession(root: string, text: string): void {
  const transcript = join(root, "sess.jsonl");
  const lines = [
    { type: "user", timestamp: "2026-07-25T10:00:00Z", cwd: root, message: { role: "user", content: text } },
    { type: "user", timestamp: "2026-07-25T10:01:00Z", cwd: root, message: { role: "user", content: text } },
  ];
  writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  capture.enqueue(transcript, "sess", root, 2, "claude-jsonl");
}

beforeEach(() => {
  langBefore = process.env.LLMWIKI_LANG;
  delete process.env.LLMWIKI_LANG;
  stateDir = mkdtempSync(join(tmpdir(), "llmwiki-session-lang-state-"));
  roots.push(stateDir);
  capture.setStateDir(stateDir);
  _resetForTests();
});

afterEach(() => {
  if (langBefore === undefined) delete process.env.LLMWIKI_LANG;
  else process.env.LLMWIKI_LANG = langBefore;
  _resetForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("detectLang — prose only, never code", () => {
  test("reads the script of the prose", () => {
    expect(detectLang("이 결정은 파싱을 한 곳으로 모으기 위한 것이다. 앞으로도 그렇게 간다.")).toBe("ko");
    expect(detectLang("この決定はパースを一箇所にまとめるためのものです。今後もそうします。")).toBe("ja");
    expect(detectLang("这个决定是为了把解析集中到一个地方，以后也这样做。")).toBe("zh");
    expect(detectLang("This decision exists to keep parsing in one place, and it stays that way.")).toBe("en");
  });

  test("code terms never decide the language", () => {
    const koreanWithCode =
      "`parseAmount` 를 `src/parser.ts` 안에서만 호출하도록 정리했다. `Number()` 앞에서 구분자를 제거한다.\n\n```ts\nexport const parseAmount = (raw: string) => Number(raw);\n```\n";
    expect(detectLang(koreanWithCode)).toBe("ko");

    // pure code / no prose → no opinion, so the caller can fall back
    expect(detectLang("```ts\nexport const a = 1;\n```\n")).toBeNull();
    expect(detectLang("src/engine/db.ts · llmwiki index <repo>")).toBeNull();
  });
});

describe("the session language becomes the default", () => {
  test("with no config, the engine follows the language the wiki is already written in", () => {
    const root = mkRepo();
    page(root, "결정.md", "TL;DR — 파서는 하나.\n\n- `parseAmount` 가 구분자를 제거한 뒤 호출된다. 앞으로 모든 임포트는 이 경로를 쓴다.\n");
    writeFileSync(
      join(root, "docs", "wiki", "overview.md"),
      "---\ntitle: Overview\n---\n\n## Recent Updates\n- 2026-07-24 — 긴 세션 단락\n- 2026-07-23 — 또 하나\n",
      "utf8",
    );

    expect(resolveWikiLang(root)).toBe("ko");

    normalizeOverview(root);
    expect(readFileSync(join(root, "docs", "wiki", "overview.md"), "utf8")).toContain("세션별 변경 이력");
  });

  test("before any page exists, the human's own utterances decide it", () => {
    const root = mkRepo();
    capturedSession(root, "이번 세션에서는 결제 모듈의 파싱 경로를 정리하자. 중복 로직을 하나로 합치고 싶다.");

    expect(resolveWikiLang(root)).toBe("ko");

    ensureSkeleton(root);
    expect(readFileSync(join(root, "docs", "wiki", "current-state.md"), "utf8")).toContain("## 지금 (TL;DR)");
  });

  test("an explicit config language always wins over detection", () => {
    const root = mkRepo();
    page(root, "결정.md", "TL;DR — 파서는 하나.\n\n- 한국어로 가득한 페이지다. 그래도 설정이 우선한다.\n");
    writeFileSync(join(root, "llmwiki.config.toml"), 'config_version = 1\n\n[wiki]\nlang = "en"\n', "utf8");
    // the engine reads its config from the CLONE root, so point the resolver at a config object
    expect(resolveWikiLang(root, { lang: "en" })).toBe("en");
    expect(resolveWikiLang(root, { lang: "auto" })).toBe("ko"); // "auto" = detect
    expect(resolveWikiLang(root, { lang: "" })).toBe("ko"); // unset = detect
  });

  test("the env override still beats everything", () => {
    const root = mkRepo();
    page(root, "결정.md", "TL;DR — 파서는 하나.\n\n- 한국어 페이지지만 환경변수가 이긴다.\n");
    process.env.LLMWIKI_LANG = "ja";
    expect(resolveWikiLang(root)).toBe("ja");
  });

  test("nothing to go on → English, exactly as before", () => {
    const root = mkRepo();
    expect(resolveWikiLang(root)).toBe("en");
    ensureSkeleton(root);
    expect(readFileSync(join(root, "docs", "wiki", "current-state.md"), "utf8")).toContain("## Now (TL;DR)");
  });

  // "Whichever language is used most" — one vote per page, and when a wiki has been going for a
  // while, the sample is the MOST RECENT pages, so a wiki that switched language follows the switch
  // instead of being outvoted by its own history.
  test("the majority of pages decides, and a language switch is followed", () => {
    const root = mkRepo();
    page(root, "혼합-1.md", "TL;DR — 한국어 페이지.\n\n- 결제 파싱 경로를 한 곳으로 모았고, 앞으로도 이 경로만 쓴다.\n");
    page(root, "혼합-2.md", "TL;DR — 한국어 페이지.\n\n- 중복 로직을 제거했고 테스트로 고정했다. 다음 세션도 여기서 이어간다.\n");
    page(root, "혼합-3.md", "TL;DR — 한국어 페이지.\n\n- 카테고리 구조를 정리했다. 읽는 순서는 그대로 유지한다.\n");
    page(root, "mixed-4.md", "TL;DR — an English page.\n\n- One page in English does not decide the language of the whole wiki here.\n");
    expect(resolveWikiLang(root)).toBe("ko"); // 3 of 4 pages

    // a wiki that ran in English for a long time and has now switched to Korean
    const switched = mkRepo();
    const old = Date.UTC(2026, 0, 1) / 1000;
    for (let i = 0; i < 14; i++) {
      const name = `z-old-english-${String(i).padStart(2, "0")}.md`;
      page(switched, name, `TL;DR — an English page.\n\n- This wiki spent a long time being written in English, page ${i}.\n`);
      utimesSync(join(switched, "docs", "wiki", "3_decision", name), old, old);
    }
    for (let i = 0; i < 6; i++) {
      page(switched, `a-새-한국어-${i}.md`, `TL;DR — 한국어로 전환했다.\n\n- 이제부터 이 위키는 한국어로 쓴다. ${i}번째 페이지.\n`);
    }
    _resetForTests();
    expect(resolveWikiLang(switched)).toBe("ko"); // the recent pages carry it
  });

  test("engine-authored files never vote — only what a human's session produced", () => {
    const root = mkRepo();
    // an English skeleton seeded earlier must not lock the wiki into English forever
    ensureSkeleton(root);
    expect(resolveWikiLang(root)).toBe("en");

    page(root, "결정.md", "TL;DR — 파서는 하나.\n\n- 이제 한국어로 페이지를 쌓기 시작했다. 다음 글도 한국어로 간다.\n");
    _resetForTests();
    expect(resolveWikiLang(root)).toBe("ko");
  });
});
