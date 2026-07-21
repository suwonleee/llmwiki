// Evidence excerpts (v3): minting from a transcript, rendering, reading back, and verification.
//
// The contract that matters most here is the ASYMMETRY: on the author's machine the transcript is
// present and a quote can be proven; on a teammate's machine it is absent and verification must
// return "undecidable", never "false". Getting that backwards would make every shared page fail
// lint — the exact failure v3 exists to prevent.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXCERPT_MAX,
  ensureExcerpts,
  mintExcerpts,
  parseExcerpts,
  renderExcerpt,
  verifyExcerpt,
  type Excerpt,
} from "../src/engine/excerpt.ts";
import { REDACTED } from "../src/engine/screen.ts";

const QUOTE = "로그는 그대로 두고 그 위에 주제층을 얹자. 교체는 model-collapse 위험이 있다";

// A minimal claude-jsonl session: one human utterance, one edit, one bash run, one test result.
function transcript(extraUser?: string): string {
  const lines = [
    { type: "user", timestamp: "2026-06-29T14:02:11Z", cwd: "/repo", message: { role: "user", content: QUOTE } },
    {
      type: "assistant",
      timestamp: "2026-06-29T14:02:30Z",
      uuid: "u1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Edit", input: { file_path: "/repo/src/engine/db.ts" } }],
      },
    },
    {
      type: "assistant",
      timestamp: "2026-06-29T14:03:00Z",
      uuid: "u2",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "bun test" } }],
      },
    },
    {
      type: "user",
      timestamp: "2026-06-29T14:03:05Z",
      message: { role: "user", content: [{ type: "tool_result", content: "272 pass, 0 fail" }] },
    },
  ];
  if (extraUser) {
    lines.push({
      type: "user",
      timestamp: "2026-06-29T14:04:00Z",
      cwd: "/repo",
      message: { role: "user", content: extraUser },
    } as any);
  }
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

describe("excerpt", () => {
  let dir: string;
  let path: string;
  const write = (body: string) => writeFileSync((path = join(dir, "sess.jsonl")), body);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llmwiki-excerpt-"));
    write(transcript());
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // ---- mint --------------------------------------------------------------------------------

  // A UTF-16 slice cap landing inside a surrogate pair (any emoji in the utterance) minted a lone
  // surrogate, which becomes U+FFFD when the page is written as UTF-8 — and the corrupted
  // excerpt then fails its own verbatim check (unverified-excerpt). Cut on a code-point boundary.
  test("cap landing inside an emoji backs off — no lone surrogate persisted", () => {
    // clip() cuts at index EXCERPT_MAX-1; place the emoji's high surrogate exactly at the edge
    write(transcript("a".repeat(EXCERPT_MAX - 2) + "🚀 그리고 한참 이어지는 판단 발화"));
    const judged = mintExcerpts(path).filter((e) => e.kind === "judgment");
    const long = judged.find((e) => e.text.endsWith("…"))!;
    expect(long).toBeDefined();
    // no unpaired surrogate half anywhere in the capped text
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(long.text)).toBe(false);
    // survives a UTF-8 write→read round-trip byte-identically (what persisting to a page does)
    expect(Buffer.from(long.text, "utf8").toString("utf8")).toBe(long.text);
    expect(long.text.length).toBeLessThanOrEqual(EXCERPT_MAX);
  });

  test("mints both classes: machine facts from tool events, verbatim judgment from the human", () => {
    const all = mintExcerpts(path);
    const facts = all.filter((e) => e.kind === "fact");
    const judgments = all.filter((e) => e.kind === "judgment");

    expect(facts.map((f) => f.text).join(" ")).toContain("db.ts");
    expect(facts.every((f) => f.locator.startsWith("tool "))).toBe(true);
    expect(judgments.map((j) => j.text)).toContain(QUOTE);
    expect(judgments[0]!.locator).toBe("2026-06-29 14:02 user"); // timestamp is readable, not a uuid
  });

  test("caps every excerpt at EXCERPT_MAX so a fully-cited page's evidence stays bounded", () => {
    write(transcript("가".repeat(2000)));
    for (const e of mintExcerpts(path)) expect(e.text.length).toBeLessThanOrEqual(EXCERPT_MAX);
  });

  test("secrets never reach a minted excerpt (the gate is inside mint, not left to callers)", () => {
    write(transcript(`키를 확인하려고 AWS_SECRET_ACCESS_KEY='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' 로 호출했다`));
    const all = mintExcerpts(path);
    expect(all.length).toBeGreaterThan(0);
    for (const e of all) expect(e.text).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(all.some((e) => e.text.includes(REDACTED))).toBe(true);
  });

  test("an unreadable transcript yields nothing instead of throwing into a close-out", () => {
    expect(mintExcerpts(join(dir, "missing.jsonl"))).toEqual([]);
  });

  // Regression (2026-07-20, found against a real 4MB session): facts outnumber judgments ~10:1,
  // so a limit shared across both classes filled up on facts and returned ZERO judgments — losing
  // exactly the evidence a decision page needs.
  test("the limit is per class, so abundant facts never starve scarce judgments", () => {
    const noisy = transcript();
    const many = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-29T14:05:00Z",
        uuid: `f${i}`,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Bash", input: { command: `bun test tests/case-${i}.test.ts --coverage` } }],
        },
      }),
    ).join("\n");
    write(noisy + many + "\n");

    const out = mintExcerpts(path, 0, { limit: 5 });
    expect(out.filter((e) => e.kind === "fact")).toHaveLength(5);
    expect(out.filter((e) => e.kind === "judgment").length).toBeGreaterThan(0);
  });

  // ---- render / parse ----------------------------------------------------------------------

  test("render → parse round-trips, attributing evidence to its footnote", () => {
    const e: Excerpt = { kind: "judgment", locator: "2026-06-29 14:02 user", text: QUOTE, redactions: [] };
    const page = `- 주제층을 얹는다 [^s1]\n\n[^s1]: abc.jsonl\n${renderExcerpt(e)}\n`;
    const parsed = parseExcerpts(page);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.footnote).toBe("s1");
    expect(parsed[0]!.locator).toBe("2026-06-29 14:02 user");
    expect(parsed[0]!.text).toBe(QUOTE); // surrounding quotes stripped
  });

  test("evidence attaches to the nearest footnote above and never drifts across body content", () => {
    const page = [
      `[^s1]: a.jsonl`,
      `    > [ts user] "첫째"`,
      `[^s2]: b.jsonl`,
      `    > [ts user] "둘째"`,
      ``,
      `> [conflict] 이건 본문 콜아웃이다`,
      `    > [ts user] "본문 뒤라 어느 각주에도 붙지 않는다"`,
    ].join("\n");
    const parsed = parseExcerpts(page);

    expect(parsed.map((p) => `${p.footnote}:${p.text}`)).toEqual(["s1:첫째", "s2:둘째"]);
  });

  // ---- ensureExcerpts (deterministic attach on the unattended WRITE path) --------------------

  test("attaches evidence to a bare footnote, preferring a human quote on a decision page", () => {
    const draft = `---\ndomain: decision\n---\n\n- 주제층을 얹기로 했다 [^1]\n\n[^1]: sess.jsonl\n`;
    const out = ensureExcerpts(draft, path);

    expect(out).toContain(`[^1]: sess.jsonl\n    > [2026-06-29 14:02 user]`);
    expect(out).toContain(QUOTE); // the human's own words, not a tool record
    expect(parseExcerpts(out)).toHaveLength(1);
  });

  test("never overwrites an excerpt a warm session already chose", () => {
    const chosen = `---\ndomain: decision\n---\n\n- x [^1]\n\n[^1]: sess.jsonl\n    > [ts user] "사람이 고른 인용"\n`;
    expect(ensureExcerpts(chosen, path)).toBe(chosen);
  });

  test("leaves the page untouched when the transcript is gone (additive, never a blocker)", () => {
    const draft = `---\ndomain: decision\n---\n\n- x [^1]\n\n[^1]: sess.jsonl\n`;
    expect(ensureExcerpts(draft, join(dir, "gone.jsonl"))).toBe(draft);
  });

  // ---- verify ------------------------------------------------------------------------------

  test("a real quote verifies; an invented one does not", () => {
    expect(verifyExcerpt(QUOTE, path)).toBe(true);
    expect(verifyExcerpt("우리는 로그층을 전부 폐기하기로 했다", path)).toBe(false);
  });

  test("verification is redaction-aware — a screened quote still checks its surviving segments", () => {
    write(transcript(`자격증명 AWS_SECRET_ACCESS_KEY='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' 로 계정을 확인했다`));
    const screened = mintExcerpts(path).find((e) => e.text.includes(REDACTED));
    expect(screened).toBeDefined();
    expect(verifyExcerpt(screened!.text, path)).toBe(true);
  });

  test("MISSING transcript is undecidable (null), not a failure — the teammate-machine contract", () => {
    expect(verifyExcerpt(QUOTE, join(dir, "gone.jsonl"))).toBeNull();
  });

  test("machine facts verify against the tool-event corpus too", () => {
    const fact = mintExcerpts(path).find((e) => e.kind === "fact" && e.text.includes("db.ts"));
    expect(verifyExcerpt(fact!.text, path)).toBe(true);
  });
});
