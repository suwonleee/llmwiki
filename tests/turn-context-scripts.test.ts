// Per-turn injection is the read half of the loop: what the wiki says gets in front of the model
// on every prompt. It runs off terms pulled out of that prompt — and the two patterns doing the
// pulling recognised ASCII and CJK only. A Russian, Thai, Hindi, Arabic, Greek or Hebrew prompt
// produced NO terms at all, so the feature was structurally dead for those readers: not degraded,
// never fired. Japanese and Chinese failed the other way — with no spaces to break on, a whole
// clause came out as one term, and a whole clause is a literal substring no page contains.
import { test, expect, describe } from "bun:test";
import { extractTerms } from "../src/engine/turncontext.ts";

const has = (terms: string[], needle: string) => terms.some((t) => t.includes(needle));

describe("term extraction across writing systems", () => {
  test("scripts that are neither ASCII nor CJK produce terms at all", () => {
    const cases: Record<string, string> = {
      Cyrillic: "что делает конвейер развёртывания с миграциями",
      Thai: "ไปป์ไลน์การปรับใช้ทำอะไรกับการย้ายฐานข้อมูล",
      Devanagari: "इस परियोजना में भाषा सेटिंग कैसे काम करती है",
      Arabic: "كيف يعمل إعداد اللغة في هذا المشروع",
      Greek: "πώς λειτουργεί η ρύθμιση γλώσσας",
      Hebrew: "איך עובדת הגדרת השפה בפרויקט הזה",
    };
    for (const [script, prompt] of Object.entries(cases)) {
      expect(extractTerms(prompt).length, script).toBeGreaterThan(0);
    }
  });

  test("a diacritic no longer splits a Latin word in half", () => {
    // "überhaupt" used to arrive as "berhaupt": the ASCII pattern cannot start on ü.
    expect(extractTerms("wie funktioniert das überhaupt")).toContain("überhaupt");
    expect(has(extractTerms("cài đặt ngôn ngữ hoạt động"), "ngôn")).toBe(true);
    expect(has(extractTerms("configuración del idioma"), "configuración")).toBe(true);
  });

  test("a clause in an unspaced script becomes word-sized terms, not one clause", () => {
    const terms = extractTerms("デプロイのパイプラインはマイグレーションをどうしますか");
    expect(terms.length).toBeGreaterThan(1);
    // Every term has to be short enough to actually occur inside a page.
    expect(Math.max(...terms.map((t) => [...t].length))).toBeLessThanOrEqual(6);
    expect(has(terms, "パイプ")).toBe(true);
    const zh = extractTerms("部署流水线怎么处理数据库迁移");
    expect(zh.length).toBeGreaterThan(1);
    expect(has(zh, "流水线")).toBe(true);
  });

  test("Korean is a spaced script and keeps whole words", () => {
    const terms = extractTerms("배포 파이프라인은 마이그레이션을 어떻게 하나");
    expect(terms).toContain("파이프라인은");
    expect(terms).toContain("마이그레이션을");
  });

  test("identifiers and paths still survive whole", () => {
    const terms = extractTerms("why does src/engine/db.ts call parseAmount with --dry-run");
    expect(terms).toContain("src/engine/db.ts");
    expect(terms).toContain("parseAmount");
  });

  test("plain English is unchanged", () => {
    const terms = extractTerms("what does the deployment pipeline do with migrations");
    expect(terms).toContain("deployment");
    expect(terms).toContain("pipeline");
    expect(terms).toContain("migrations");
  });

  test("a prompt still yields a bounded number of terms", () => {
    const terms = extractTerms("デプロイのパイプラインはマイグレーションをどうしますか ".repeat(20));
    expect(terms.length).toBeLessThanOrEqual(12);
  });
});
