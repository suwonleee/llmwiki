import { describe, expect, test } from "bun:test";
import { pageExcerpt } from "../src/engine/turncontext.ts";

const cost = (lines: string[]) => lines.reduce((n, line) => n + 7 + line.length, 0);
const intro = "Historical context about the old interface. ".repeat(12);

describe("query-relevant excerpt windows", () => {
  test("a later matching paragraph survives an oversized unrelated introduction", () => {
    const answer = "The runner calls dispatch_job before collecting the final result.";
    const body = `## Execution\n${intro}\n\n${answer}`;
    const out = pageExcerpt(body, { terms: ["dispatch_job"], max: 150 });
    expect(out).toEqual(["§ Execution", answer]);
    expect(cost(out)).toBeLessThanOrEqual(150);
  });

  test("a fitting section retains its original order and all context", () => {
    const body = "## Execution\nBackground context.\n\nThe dispatch_job function starts execution.";
    expect(pageExcerpt(body, { terms: ["dispatch_job"], max: 500 })).toEqual([
      "§ Execution", "Background context.", "The dispatch_job function starts execution.",
    ]);
  });

  test("a later list item carries its nested exception and wrapped continuation", () => {
    const item = ["- Enable journal replay for recovery.", "  - Except when the checksum fails:", "    keep the original journal untouched."];
    const body = `## Recovery\n${intro}\n\n${item.join("\n")}\n- Archive old logs.`;
    const out = pageExcerpt(body, { terms: ["replay"], max: 170 });
    expect(out).toEqual(["§ Recovery", ...item]);
    expect(cost(out)).toBeLessThanOrEqual(170);
    // This budget fits the parent claim but cannot fit its exception: withhold the block.
    expect(pageExcerpt(body, { terms: ["replay"], max: 100 })).toEqual([]);
  });

  test("a blank line does not sever a nested exception from its list item", () => {
    const body = `## Recovery\n${intro}\n\n- Enable journal replay.\n\n  Except when the checksum fails; preserve the journal unchanged.`;
    expect(pageExcerpt(body, { terms: ["replay"], max: 90 })).toEqual([]);
  });

  test("wrapped paragraph qualifications are never truncated", () => {
    const body = `## Policy\n${intro}\n\nEnable journal replay.\nExcept when the checksum fails; preserve the journal unchanged.`;
    expect(pageExcerpt(body, { terms: ["replay"], max: 90 })).toEqual([]);
  });

  test("no matching block preserves summary and description fallback", () => {
    const body = "## Other\nUnrelated detail.\n\n## Summary\nA short overview.";
    expect(pageExcerpt(body, { terms: ["absent"], max: 100 })).toEqual(["§ Summary", "A short overview."]);
    expect(pageExcerpt("## Other\nUnrelated detail.", { terms: [], description: "A description.", max: 100 })).toEqual(["A description."]);
  });

  test("a code sample is atomic even when it contains headings and blank lines", () => {
    const code = ["# journal sample", "replay_journal()", "preserve_original_on_error()"];
    const body = `## Example\n${intro}\n\n\`\`\`python\n${code[0]}\n${code[1]}\n\n${code[2]}\n\`\`\``;
    expect(pageExcerpt(body, { terms: ["replay_journal"], max: 120 })).toEqual(["§ Example", ...code]);
    expect(pageExcerpt(body, { terms: ["replay_journal"], max: 80 })).toEqual([]);
  });

  test("page identity matches weigh less than task-specific block matches", () => {
    const body = `## Details\n${intro}\n\nJournal settings are described here.\n\nCall dispatch_job to execute the worker.`;
    expect(pageExcerpt(body, { terms: ["journal", "dispatch_job"], named: ["journal"], max: 100 })).toEqual([
      "§ Details", "Call dispatch_job to execute the worker.",
    ]);
  });

  test("indented sibling list items form separate windows without dropping child exceptions", () => {
    const body = `## Recovery\n  - ${intro}\n  - Replay journal entries.\n    - Except invalid checksums; retain originals.`;
    expect(pageExcerpt(body, { terms: ["replay"], max: 150 })).toEqual([
      "§ Recovery", "  - Replay journal entries.", "    - Except invalid checksums; retain originals.",
    ]);
  });

  test("a paragraph after a list is independently retrievable and all budgets hold", () => {
    const body = `## Recovery\n- ${intro}\n\nReplay journal entries only after checksum verification.`;
    for (let max = 0; max <= 500; max++) {
      const out = pageExcerpt(body, { terms: ["replay"], max });
      expect(cost(out)).toBeLessThanOrEqual(max);
      if (max >= 100) expect(out).toContain("Replay journal entries only after checksum verification.");
    }
  });

  test("a later matching paragraph never drops its same-line qualification", () => {
    const body = `## Recovery\n${intro}\n\nRun purge_cache to recover disk space. Never run this in production or on a shared cache.`;
    expect(pageExcerpt(body, { terms: ["purge_cache"], max: 90 })).toEqual([]);
  });

  test("declared rules remain atomic even when body offers a shorter match", () => {
    const rule = "Enable replay unless the journal fails checksum verification; then preserve every original entry.";
    expect(pageExcerpt("Replay is supported.", { rule, terms: ["replay"], max: 80 })).toEqual([]);
  });
});

describe("rarity-weighted blocks across sections", () => {
  test("a cause and its fix in two sections both come through, in page order", () => {
    const body = "## 원인\n\n일반 설명 문단이다. 결과 실행 결과.\n\n- kaptKotlin 이 Homebrew 17 JDK 를 잡았다\n\n## 해소\n\n- ./gradlew --stop 후 JAVA_HOME 고정\n\n## 기타\n\n결과 실행 결과 실행.\n";
    const weights = new Map([["kaptkotlin", 4], ["gradlew", 4], ["결과", 0.2], ["실행", 0.2]]);
    const out = pageExcerpt(body, { terms: ["kaptKotlin", "gradlew", "결과", "실행"], max: 400, weights });
    expect(out).toEqual(["§ 원인", "- kaptKotlin 이 Homebrew 17 JDK 를 잡았다", "§ 해소", "- ./gradlew --stop 후 JAVA_HOME 고정"]);
  });

  test("without weights the single-section behaviour is unchanged", () => {
    const body = "## A\n\n- alpha replay\n\n## B\n\n- beta replay\n";
    expect(pageExcerpt(body, { terms: ["replay", "alpha"], max: 400 })).toEqual(["§ A", "- alpha replay"]);
  });
});
