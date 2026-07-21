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
    const once = screenSecrets("token: ghp_NOTAREALTOKENNOTAREALTOKEN0000000000");
    expect(hasSecret(once.text)).toBe(false);
    expect(screenSecrets(once.text).text).toBe(once.text);
  });

  test.each([
    ["aws access key id", "id is AKIAIOSFODNN7EXAMPLE here"],
    ["github token", "use ghp_NOTAREALTOKENNOTAREALTOKEN0000000000"],
    ["slack token", "xoxb-EXAMPLE-NOT-A-REAL-TOKEN"],
    ["anthropic key", "sk-ant-NOT-A-REAL-KEY-000000000000"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["bearer header", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"],
    ["url userinfo", "psql postgres://admin:hunter2hunter2@db.internal/app"],
    ["named password assignment", 'DB_PASSWORD="Not-A-Real-Value-123"'],
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

// Regression (2026-07-20, found by `llmwiki excerpt` emitting one in the clear): the AWS and GCP
// patterns pinned an EXACT length and closed with \b. A look-alike longer than the real spec
// matched the first N chars, failed the boundary on char N+1, and passed through unredacted —
// the one outcome a screener must never have. Both are open-ended now, like the other shapes.
describe("screenSecrets — over-length look-alikes must not slip through", () => {
  test.each([
    ["aws id at spec length (20)", "AKIAIOSFODNN7EXAMPLE"],
    ["aws id longer than spec", "AKIAIOSFODNN7EXAMPLEEXTRA"],
    ["aws sts prefix, over-length", "ASIAIOSFODNN7EXAMPLEEXTRA"],
    ["gcp key longer than spec", `AIza${"a".repeat(40)}`],
  ])("redacts %s", (_label, sample) => {
    expect(hasSecret(sample)).toBe(true);
    expect(screenSecrets(sample).text).not.toContain(sample);
  });

  test("redacts even when the shape is embedded in a command, not assigned to a name", () => {
    const cmd = `perl -pi -e "s/AKIAIOSFODNN7EXAMPLEEXTRA/x/g" fixtures.ts`;
    const r = screenSecrets(cmd);
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLEEXTRA");
    expect(r.text).toContain("perl"); // the evidential command survives
  });
});

describe("screenSecrets — gutted signal", () => {
  test("a line that is almost entirely secret is flagged gutted (caller drops the excerpt)", () => {
    expect(screenSecrets("ghp_NOTAREALTOKENNOTAREALTOKEN0000000000").gutted).toBe(true);
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

// Placeholder values are documentation, not leaks. The named-assignment rule fires on the NAME,
// so without this carve-out every setup example in a wiki page (`API_KEY=<your-key>`) would trip
// the page-secret/excerpt-secret gate and cost a close-out. The carve-out is shape-proven only:
// anything the placeholder list can't recognize still redacts (deny-by-shape stays the default).
describe("screenSecrets — placeholder assignments stay untouched", () => {
  const silent = [
    ["angle-bracketed", "LLMWIKI_API_KEY=<your-key>"],
    ["shell var reference", "GITHUB_TOKEN=$GITHUB_TOKEN"],
    ["braced shell var", "AUTH_TOKEN=${CI_AUTH_TOKEN}"],
    ["ellipsis", "OPENAI_API_KEY=..."],
    ["unicode ellipsis", "DB_PASSWORD=…"],
    ["x-run", "SLACK_TOKEN=xxxxx"],
    ["star-run", "PASSWORD: ***"],
    ["self-describing word", "API_KEY=your-key-here"],
    ["changeme", 'ADMIN_PASSWORD="changeme"'],
  ] as const;
  for (const [label, sample] of silent) {
    test(`${label}: not a redaction`, () => {
      const r = screenSecrets(sample);
      expect(r.redactions).toEqual([]);
      expect(r.text).toBe(sample);
    });
  }

  test("inside backticks the wrapping punctuation does not defeat the carve-out", () => {
    expect(hasSecret("설정은 `LLMWIKI_API_KEY=<your-key>` 한 줄이면 된다")).toBe(false);
  });

  test("a real-looking value right next to a placeholder still redacts", () => {
    const r = screenSecrets('API_KEY=<your-key> DB_PASSWORD="Not-A-Real-Value-123"');
    expect(r.text).toContain("API_KEY=<your-key>");
    expect(r.text).not.toContain("Not-A-Real-Value");
    expect(r.redactions).toEqual(["named-assignment"]);
  });
});

// A non-ASCII value is prose, not key material — every machine credential alphabet (base64,
// hex, provider token charsets) is ASCII. The natural Korean wiki idiom `NAME: 상태 설명` was
// the observed false-positive class (2026-07-21 trial): it punished exactly the
// security-conscious phrasing ("값은 1Password 보관") the screen exists to encourage.
describe("screenSecrets — non-ASCII assignment values are prose", () => {
  test("Korean status after a token name: silent", () => {
    expect(hasSecret("SLACK_TOKEN: 미설정 (발급 대기)")).toBe(false);
    expect(hasSecret("GITHUB_TOKEN: 팀 계정으로 발급 완료, 값은 1Password 보관")).toBe(false);
  });

  test("an ASCII credential right after Korean prose still redacts", () => {
    expect(hasSecret('앞은 산문이지만 DB_PASSWORD="Not-A-Real-Value-123" 는 값이다')).toBe(true);
  });
});
