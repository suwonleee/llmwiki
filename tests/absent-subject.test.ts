import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { absentNames, isQuestion, writtenNames } from "../src/engine/absent-subject.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { buildTurnContext } from "../src/engine/turncontext.ts";

describe("written names", () => {
  test("names are capitalised, mixed-case or multi-word; ordinary words are not", () => {
    expect(writtenNames("TestRail로 결과를 올리나요?")).toEqual(["TestRail"]);
    expect(writtenNames("SAML 로그인과 gRPC 인터셉터")).toEqual(["SAML", "gRPC"]);
    expect(writtenNames("Microsoft Teams 채널로 보내나요?")).toContain("Microsoft Teams");
    expect(writtenNames("without changing the repo, which failures remain?")).toEqual([]);
  });

  test("a capital that opens an English sentence is grammar, not a name", () => {
    expect(writtenNames("Running the batch fails")).toEqual([]);
    expect(writtenNames("Notion 으로 넘기죠?")).toEqual(["Notion"]);
  });
});

describe("question or instruction", () => {
  test("questions end in ? or a question ending; instructions do not", () => {
    expect(isQuestion("Datadog 트레이스에 설정돼 있나요")).toBe(true);
    expect(isQuestion("Where is Terraform configured?")).toBe(true);
    expect(isQuestion("TestRail 연동 모듈을 추가해 줘")).toBe(false);
  });
});

const roots: string[] = [];
const saved = process.env.LLMWIKI_TURN_ABSENT;
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  if (saved === undefined) delete process.env.LLMWIKI_TURN_ABSENT;
  else process.env.LLMWIKI_TURN_ABSENT = saved;
});

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "llmwiki-absent-"));
  roots.push(root);
  const git = (...a: string[]) => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "notify.ts"), "export const slackWebhook = process.env.SLACK_URL; // spring-boot style config\n");
  const wiki = join(root, "docs", "wiki", "5_topic");
  mkdirSync(wiki, { recursive: true });
  const page = (t: string, b: string) => `---\ntype: Topic\ntitle: ${t}\ndescription: ${t}\ndate: 2026-10-19\ntags: [topic, test]\nstatus: stable\n---\n\n${b}\n`;
  writeFileSync(join(wiki, "notify.md"), page("알림 채널 설정", "작업이 끝나면 Slack 채널로 알림을 보낸다. 알림 채널 설정은 환경변수로 한다.\n"));
  for (let i = 0; i < 4; i++) writeFileSync(join(wiki, `other-${i}.md`), page(`설정 메모 ${i}`, "채널 알림 설정을 기록한다.\n"));
  git("add", "-A");
  git("commit", "-q", "-m", "feat(notify): Slack 알림 채널 추가");
  new WikiIndex(root).connect().close();
  return root;
}

describe("absent names against a real repository", () => {
  test("a name in no wiki page, commit or tracked file is absent; a joined spelling counts as present", () => {
    const root = project();
    expect(absentNames(root, ["Teams", "Spring Boot", "Slack"], () => false, "")).toEqual(["teams"]);
  });

  test("on: a question about an unknown tool gets the no-record line instead of near-miss pages", () => {
    const root = project();
    process.env.LLMWIKI_TURN_ABSENT = "on";
    const out = buildTurnContext(root, "작업이 끝나면 Teams 채널로 알림 보내는 설정이 있나요?", "", { affinity: null });
    expect(out).toContain("`teams`");
    expect(out).not.toContain("docs/wiki/5_topic/notify.md");
  });

  test("on: an instruction keeps its pages and adds the line", () => {
    const root = project();
    process.env.LLMWIKI_TURN_ABSENT = "on";
    const out = buildTurnContext(root, "작업이 끝나면 Teams 채널로도 알림 보내도록 알림 채널 설정을 추가해 줘", "", { affinity: null });
    expect(out).toContain("`teams`");
    expect(out).toContain("docs/wiki/5_topic/notify.md");
  });

  test("LLMWIKI_TURN_ABSENT=off disables it", () => {
    const root = project();
    process.env.LLMWIKI_TURN_ABSENT = "off";
    expect(buildTurnContext(root, "작업이 끝나면 Teams 채널로 알림 보내는 설정이 있나요?", "", { affinity: null })).not.toContain("`teams`");
  });
});
