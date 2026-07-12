// Chunker — assert the engine's current behavior.
import { test, expect, describe } from "bun:test";
import { chunkText, estimateTokens, MIN_CHUNK_TOKENS, MAX_CHUNK_CHARS } from "../src/engine/chunker.ts";

describe("estimateTokens", () => {
  test("empty → floor at 1", () => expect(estimateTokens("")).toBe(1));
  test("short → 1", () => expect(estimateTokens("abcd")).toBe(1));
  test("formula", () => {
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("a".repeat(7))).toBe(Math.max(1, Math.floor(7 / 4)));
  });
});

describe("chunkText", () => {
  test("empty input", () => expect(chunkText("")).toEqual([]));
  test("whitespace only", () => expect(chunkText("   \n\n   ")).toEqual([]));

  test("small paragraph below min tokens → no chunk", () => {
    const text = "hello world this is a small paragraph";
    expect(estimateTokens(text)).toBeLessThan(MIN_CHUNK_TOKENS);
    expect(chunkText(text)).toEqual([]);
  });

  test("header breadcrumb", () => {
    const doc = "# Title\n\n" + "word ".repeat(40);
    const chunks = chunkText(doc);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.headerBreadcrumb).toContain("Title");
  });

  test("oversized single paragraph split", () => {
    const big = "This is a sentence. ".repeat(800); // ~16000 chars
    expect(big.length).toBeGreaterThan(MAX_CHUNK_CHARS);
    const chunks = chunkText(big);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= MAX_CHUNK_CHARS)).toBe(true);
  });
});
