// Did an injected pointer actually get opened? The parser's whole job is to answer that WITHOUT
// counting itself: a transcript holds the injection, every tool result that ever grepped for it,
// and the assistant's own prose about it. Most of these cases are that distinction.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverClaudeTranscripts,
  pickTranscripts,
  scanTranscript,
  splitWikiPath,
  summarizeDownstreamRead,
} from "../src/engine/downstream-read.ts";

const REPO = "/work/repo";
const OTHER = "/work/other";

function turnBanner(root: string, pages: string[]): string {
  return [
    `----- [llmwiki turn-context] ${root} — 이 프롬프트와 관련된 위키 페이지 (포인터 — 필요 시 Read) -----`,
    ...pages.map((p) => `  • Title of ${p}  →  ${p}`),
  ].join("\n");
}

function coldBanner(pages: string[]): string {
  return [
    `----- [llmwiki 인덱스] 이 레포 위키 최근 페이지 (필요 시 Read) -----`,
    ...pages.map((p) => `  • Title of ${p}  →  ${p}  (10x)`),
  ].join("\n");
}

function attachment(text: string, cwd = REPO): any {
  return { type: "attachment", cwd, attachment: { content: [text] } };
}

function readRec(file: string, cwd = REPO, extra: Record<string, any> = {}): any {
  return {
    type: "assistant",
    cwd,
    message: { content: [{ type: "tool_use", name: "Read", input: { file_path: file } }] },
    ...extra,
  };
}

function scanOf(records: any[]): ReturnType<typeof scanTranscript> {
  const dir = mkdtempSync(join(tmpdir(), "llmwiki-dsr-"));
  const p = join(dir, "session.jsonl");
  writeFileSync(p, records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n"));
  return scanTranscript(p);
}

function reachOf(records: any[]): ReturnType<typeof summarizeDownstreamRead> {
  return summarizeDownstreamRead([scanOf(records)]);
}

const PAGE = "docs/wiki/5_topic/a.md";
const PAGE2 = "docs/wiki/3_decision/b.md";

describe("downstream-read", () => {
  test("a pointer opened later in the session counts", () => {
    const r = reachOf([attachment(turnBanner(REPO, [PAGE])), readRec(`${REPO}/${PAGE}`)]);
    expect(r.injected).toBe(1);
    expect(r.matched).toBe(1);
    expect(r.pointer_reach).toBe(1);
  });

  test("the banner's `~` is the same root the Read spells out in full", () => {
    const home = homedir();
    const r = reachOf([
      attachment(turnBanner("~/clone", [PAGE]), home),
      readRec(`${home}/clone/${PAGE}`, home),
    ]);
    expect(r.matched).toBe(1);
    // …and it is still a different clone from the one the record's cwd names.
    expect(reachOf([attachment(turnBanner("~/clone", [PAGE]), home), readRec(`${home}/${PAGE}`, home)]).matched).toBe(0);
  });

  test("a pointer nobody opened counts as injected but unmatched", () => {
    const r = reachOf([attachment(turnBanner(REPO, [PAGE]))]);
    expect(r.injected).toBe(1);
    expect(r.matched).toBe(0);
    expect(r.pointer_reach).toBe(0);
  });

  test("a Read BEFORE the pointer does not answer it", () => {
    const r = reachOf([readRec(`${REPO}/${PAGE}`), attachment(turnBanner(REPO, [PAGE]))]);
    expect(r.injected).toBe(1);
    expect(r.matched).toBe(0);
  });

  test("cold-start index pointers are their own channel", () => {
    const r = reachOf([attachment(coldBanner([PAGE])), readRec(`${REPO}/${PAGE}`)]);
    expect(r.by_channel.cold_start.injected).toBe(1);
    expect(r.by_channel.cold_start.matched).toBe(1);
    expect(r.by_channel.turn_context.injected).toBe(0);
  });

  test("the same page in another clone is not the same page", () => {
    const r = reachOf([attachment(turnBanner(REPO, [PAGE]), REPO), readRec(`${OTHER}/${PAGE}`)]);
    expect(r.injected).toBe(1);
    expect(r.matched).toBe(0);
  });

  test("a banner without a root falls back to the record's cwd", () => {
    const legacy = [
      `----- [llmwiki turn-context] 이 프롬프트와 관련된 위키 페이지 (포인터 — 필요 시 Read) -----`,
      `  • Title  →  ${PAGE}`,
    ].join("\n");
    const hit = reachOf([attachment(legacy, REPO), readRec(`${REPO}/${PAGE}`)]);
    expect(hit.matched).toBe(1);
    const miss = reachOf([attachment(legacy, REPO), readRec(`${OTHER}/${PAGE}`)]);
    expect(miss.matched).toBe(0);
  });

  test("a tool result that merely quotes the banner is not an injection", () => {
    const quoted = {
      type: "user",
      cwd: REPO,
      toolUseResult: { stdout: turnBanner(REPO, [PAGE]) },
      message: { content: [{ type: "tool_result", content: turnBanner(REPO, [PAGE]) }] },
    };
    expect(reachOf([quoted, readRec(`${REPO}/${PAGE}`)]).injected).toBe(0);
  });

  test("assistant prose naming a page is not a Read", () => {
    const prose = { type: "assistant", cwd: REPO, message: { content: [{ type: "text", text: `see ${REPO}/${PAGE}` }] } };
    const r = reachOf([attachment(turnBanner(REPO, [PAGE])), prose]);
    expect(r.matched).toBe(0);
    expect(r.read_events).toBe(0);
  });

  test("Bash cat of a concrete page answers the pointer — Codex-observer symmetry", () => {
    const bash = {
      type: "assistant",
      cwd: REPO,
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: `cat ${REPO}/${PAGE}` } }] },
    };
    const r = reachOf([attachment(turnBanner(REPO, [PAGE])), bash]);
    expect(r.matched).toBe(1);
    expect(r.read_events).toBe(0);
    expect(r.bash_open_events).toBe(1);
  });

  test("a Bash directory grep is not an open — only a named page counts", () => {
    const bash = {
      type: "assistant",
      cwd: REPO,
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: `grep -rn foo ${REPO}/docs/wiki/` } }] },
    };
    const r = reachOf([attachment(turnBanner(REPO, [PAGE])), bash]);
    expect(r.matched).toBe(0);
    expect(r.bash_open_events).toBe(0);
  });

  test("a relative Bash open resolves against the record's cwd", () => {
    const bash = {
      type: "assistant",
      cwd: REPO,
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: `sed -n '1,40p' ${PAGE}` } }] },
    };
    const r = reachOf([attachment(turnBanner(REPO, [PAGE])), bash]);
    expect(r.matched).toBe(1);
  });

  test("a subagent's Read does not answer the main thread's pointer", () => {
    const r = reachOf([
      attachment(turnBanner(REPO, [PAGE])),
      readRec(`${REPO}/${PAGE}`, REPO, { isSidechain: true }),
    ]);
    expect(r.matched).toBe(0);
    expect(r.read_events).toBe(0);
  });

  test("a malformed line is counted, not fatal", () => {
    const scan = scanOf([attachment(turnBanner(REPO, [PAGE])), "{not json", readRec(`${REPO}/${PAGE}`)]);
    expect(scan.malformed).toBe(1);
    expect(summarizeDownstreamRead([scan]).matched).toBe(1);
  });

  test("occurrences are counted per injection, unique pages separately", () => {
    const r = reachOf([
      attachment(turnBanner(REPO, [PAGE])),
      attachment(turnBanner(REPO, [PAGE])),
      readRec(`${REPO}/${PAGE}`),
    ]);
    // Both injections precede the Read, so both are answered by it.
    expect(r.injected).toBe(2);
    expect(r.matched).toBe(2);
    expect(r.unique_injected_pages).toBe(1);
    expect(r.unique_matched_pages).toBe(1);
  });

  test("a transcript with no injection reports not-measured, not zero reach", () => {
    const r = reachOf([readRec(`${REPO}/${PAGE}`)]);
    expect(r.injected).toBe(0);
    expect(r.pointer_reach).toBe(0);
    expect(r.read_events).toBe(1); // the read happened; there was just nothing to credit it to
  });

  test("pointers from different sessions never match each other", () => {
    const a = scanOf([attachment(turnBanner(REPO, [PAGE]))]);
    const b = scanOf([readRec(`${REPO}/${PAGE}`)]);
    expect(summarizeDownstreamRead([a, b]).matched).toBe(0);
  });

  test("non-wiki reads and non-pointer lines are ignored", () => {
    const r = reachOf([
      attachment([turnBanner(REPO, [PAGE]), "  • no arrow here docs/wiki/x.md", "[[docs/wiki/y.md]]"].join("\n")),
      readRec(`${REPO}/src/engine/db.ts`),
    ]);
    expect(r.injected).toBe(1);
    expect(r.read_events).toBe(0);
  });

  test("a second pointer in the same banner is its own occurrence", () => {
    const r = reachOf([attachment(turnBanner(REPO, [PAGE, PAGE2])), readRec(`${REPO}/${PAGE2}`)]);
    expect(r.injected).toBe(2);
    expect(r.matched).toBe(1);
  });

  test("splitWikiPath separates clone root from repo-relative page", () => {
    expect(splitWikiPath(`${REPO}/${PAGE}`)).toEqual({ root: REPO, page: PAGE });
    expect(splitWikiPath("/work/repo/src/db.ts")).toBeNull();
  });

  test("pickTranscripts caps the scan and drops unreadable paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "llmwiki-pick-"));
    const files = ["a.jsonl", "b.jsonl", "c.jsonl"].map((n) => join(dir, n));
    for (const f of files) writeFileSync(f, "{}");
    const picked = pickTranscripts([...files, join(dir, "missing.jsonl")], 2);
    expect(picked.length).toBe(2);
    expect(picked.every((p) => files.includes(p))).toBe(true);
  });

  test("discovery never returns subagent transcripts", () => {
    expect(discoverClaudeTranscripts().some((p) => p.includes("/subagents/"))).toBe(false);
  });

  test("an unreadable transcript is empty, not a crash", () => {
    const scan = scanTranscript(join(mkdtempSync(join(tmpdir(), "llmwiki-gone-")), "missing.jsonl"));
    expect(scan.pointers.length).toBe(0);
    expect(scan.reads.length).toBe(0);
  });
});
