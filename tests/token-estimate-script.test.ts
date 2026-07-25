// Token estimation decides how big a retrieval unit is, and it was calibrated on English alone
// (chars ÷ 4). Korean, Japanese and Chinese cost roughly one token per CHARACTER, so the same
// budget bought a CJK chunk three to four times larger in real tokens than the English chunk it
// was meant to match. The reader never sees a number — they just pay more context per hit,
// forever, for writing in their own language.
import { test, expect, describe } from "bun:test";
import { chunkText, estimateTokens, CHUNK_SIZE } from "../src/engine/chunker.ts";

const maxChars = (text: string) => Math.max(...chunkText(text).map((c) => c.content.length));

describe("estimateTokens across scripts", () => {
  test("Latin text is unchanged — four characters to a token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("")).toBe(1); // floor
  });

  test("a CJK character is about a token, not a quarter of one", () => {
    for (const word of ["언어설정하기", "言語設定する", "语言设置修改"]) {
      expect(estimateTokens(word)).toBeGreaterThanOrEqual(word.length);
    }
  });

  test("mixed text counts each script at its own rate", () => {
    expect(estimateTokens("언어" + "a".repeat(40))).toBe(2 + 10);
  });

  test("Hangul jamo (decomposed Korean) counts like composed Korean", () => {
    const composed = "언어설정하기";
    expect(estimateTokens(composed.normalize("NFD"))).toBeGreaterThanOrEqual(estimateTokens(composed));
  });

  test("prose saying the same thing in either language now costs comparably", () => {
    const en = "The engine writes the overview pointer line in the language this wiki is configured for.";
    const ko = "엔진은 이 위키에 설정된 언어로 overview 포인터 줄을 쓴다.";
    const ratio = estimateTokens(en) / estimateTokens(ko);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2); // was ~2.3 when every character counted as a quarter token
  });
});

describe("chunk size across scripts", () => {
  test("a Korean page no longer chunks into units several times an English page's real size", () => {
    const en = ("The wiki records what the team decided and why it decided that. ".repeat(4) + "\n\n").repeat(30);
    const ko = ("위키는 팀이 무엇을 결정했고 왜 그렇게 결정했는지를 기록한다. ".repeat(4) + "\n\n").repeat(30);
    // Chunks are bounded in ESTIMATED tokens, so an honest estimate makes the Korean chunk
    // land near the same real size — which means FEWER characters, not more.
    expect(maxChars(ko)).toBeLessThan(maxChars(en));
    expect(maxChars(ko)).toBeLessThanOrEqual(CHUNK_SIZE * 1.5);
  });
});
