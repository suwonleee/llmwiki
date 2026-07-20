// Secret screening — the gate every v3 excerpt passes before it can reach a wiki page.
//
// The headline fixture is the real shape that nearly leaked during this engine's own development:
// a shell command carrying AWS credentials inline, which grounding.ts records verbatim as a
// `shell_run` fact.
//
// Fixture values are AWS's own published documentation placeholders, and every other sample is
// obviously-fake filler. That precision matters: an earlier draft of this file "anonymized" a real
// key by editing only its tail, which left 17/20 of the access key id and 32/40 of the secret
// intact — a test guarding against credential leaks must not itself carry one. Never derive a
// fixture from a real secret; take it from vendor docs or type random bytes.
//
// Fixtures must also be obviously fake to OTHER people's scanners, not just to a reader. A
// realistic-looking Slack fixture (xoxb- followed by numeric ids) was rejected by GitHub push
// protection: the shape alone is enough to be treated as a live credential. So each sample here
// matches OUR pattern in screen.ts while staying visibly a placeholder. Widen screen.ts if real
// coverage is missing — never make a fixture more realistic to prove the point.
import { test, expect, describe } from "bun:test";
import { screenSecrets, hasSecret, REDACTED } from "../src/engine/screen.ts";

describe("screenSecrets — real leak shapes", () => {
  test("the AWS-credentials shell command: keys redacted, the evidential command survives", () => {
    const fact =
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE AWS_SECRET_ACCESS_KEY='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' aws sts get-caller-identity";
    const r = screenSecrets(fact);

    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.text).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(r.text).toContain("aws sts get-caller-identity"); // evidence value preserved
    expect(r.redactions.length).toBeGreaterThan(0);
  });

  test("a redacted excerpt never carries the secret onward (hasSecret is idempotent)", () => {
    const once = screenSecrets("token: ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(hasSecret(once.text)).toBe(false);
    expect(screenSecrets(once.text).text).toBe(once.text);
  });

  test.each([
    ["aws access key id", "id is AKIAIOSFODNN7EXAMPLE here"],
    ["github token", "use ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["slack token", "xoxb-EXAMPLE-NOT-A-REAL-TOKEN"],
    ["anthropic key", "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaa"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["bearer header", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"],
    ["url userinfo", "psql postgres://admin:hunter2hunter2@db.internal/app"],
    ["named password assignment", 'DB_PASSWORD="Sup3rSecret!@#"'],
    ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"],
  ])("blocks %s", (_label, sample) => {
    expect(hasSecret(sample)).toBe(true);
    expect(screenSecrets(sample).text).toContain(REDACTED);
  });
});

describe("screenSecrets — must not eat real evidence", () => {
  test.each([
    ["a decision quote", "로그는 그대로 두고 그 위에 주제층을 얹자. 교체는 model-collapse 위험이 있다"],
    ["a test result", "bun test → 272 pass, 0 fail across 38 files"],
    ["file paths", "edit src/engine/grounding.ts and tests/quiz.test.ts"],
    ["a commit line", "git commit -m 'fix(engine): bucket plain-drop ingests'"],
    ["a long identifier", "session 3bd9cac5-8e77-462e-b86b-b5b94871981e.jsonl"],
    ["a plain command", "bun src/cli.ts quiz-next ~/work/app --limit 5"],
  ])("leaves %s untouched", (_label, sample) => {
    const r = screenSecrets(sample);
    expect(r.text).toBe(sample);
    expect(r.redactions).toEqual([]);
  });
});

describe("screenSecrets — gutted signal", () => {
  test("a line that is almost entirely secret is flagged gutted (caller drops the excerpt)", () => {
    expect(screenSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789").gutted).toBe(true);
  });

  test("a mostly-prose line keeps its excerpt", () => {
    const r = screenSecrets(
      "자격증명을 확인하려고 AWS_SECRET_ACCESS_KEY='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' 를 넣어 호출했고 계정이 확인됐다",
    );
    expect(r.redactions.length).toBeGreaterThan(0);
    expect(r.gutted).toBe(false);
  });

  test("clean text is never gutted", () => {
    expect(screenSecrets("아무 비밀도 없는 평범한 근거 문장").gutted).toBe(false);
  });

  // Regression (2026-07-20): the original ratio-only rule dropped this exact Korean sentence at
  // 0.47 while keeping its English twin, because a fixed-length key is a larger FRACTION of an
  // equally-informative Korean sentence. Same evidence, different verdict by language — not
  // acceptable in a language-neutral engine.
  test("equivalent evidence survives regardless of language density", () => {
    const KEY = "AWS_SECRET_ACCESS_KEY='wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'";
    const ko = screenSecrets(`자격증명 ${KEY} 로 계정을 확인했다`);
    const en = screenSecrets(`checked the account identity by passing ${KEY} to the call`);

    expect(ko.redactions.length).toBeGreaterThan(0);
    expect(en.redactions.length).toBeGreaterThan(0);
    expect(ko.gutted).toBe(false);
    expect(en.gutted).toBe(false);
    expect(ko.gutted).toBe(en.gutted);
  });
});
