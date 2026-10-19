// autoupdate writes OKF v0.2 pages: the category is routed by the page's `type` (legacy `domain`
// as the fallback), and the frontmatter's provenance is stamped by the engine, never taken from
// the model — `generated` is the WRITE pass, `verified` only the independent VERIFY pass that
// passed, `sources` keyed to the footnotes the body actually carries.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _category, okfStamp, updateOne } from "../src/engine/autoupdate.ts";
import * as capture from "../src/engine/capture.ts";
import { LLM_CMD_ENV } from "../src/engine/claude.ts";
import { defaults, loadFrom } from "../src/engine/config.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { isIsoDateTime, parseYamlBlock, splitFrontmatter, type YamlMap } from "../src/engine/okf.ts";
import { ensureSkeleton } from "../src/engine/update.ts";

let scratch = "";
let previousCommand: string | undefined;
let previousState = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "llmwiki-autoupdate-okf-"));
  previousCommand = process.env[LLM_CMD_ENV];
  previousState = capture.stateDir();
  capture.setStateDir(join(scratch, "state"));
});

afterEach(() => {
  if (previousCommand === undefined) delete process.env[LLM_CMD_ENV];
  else process.env[LLM_CMD_ENV] = previousCommand;
  capture.setStateDir(previousState);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function frontmatter(content: string): YamlMap {
  const { block } = splitFrontmatter(content);
  expect(block).not.toBeNull();
  const parsed = parseYamlBlock(block!);
  expect(parsed.error).toBeNull();
  return parsed.data;
}

// A provider that answers the WRITE call with `page` and every later call (VERIFY) with `verdict`.
function fakeProvider(page: string, verdict: string): void {
  const counter = join(scratch, "provider-count");
  const pageFile = join(scratch, "page.md");
  writeFileSync(pageFile, page);
  const provider = join(scratch, "fake-provider");
  writeFileSync(
    provider,
    "#!/bin/sh\n" +
      `COUNT_FILE=${JSON.stringify(counter)}\n` +
      "n=0\n" +
      '[ -f "$COUNT_FILE" ] && n=$(cat "$COUNT_FILE")\n' +
      "n=$((n + 1))\n" +
      'printf \'%s\' "$n" > "$COUNT_FILE"\n' +
      `if [ "$n" -eq 1 ]; then cat ${JSON.stringify(pageFile)}; else printf '%s\\n' ${JSON.stringify(verdict)}; fi\n`,
  );
  chmodSync(provider, 0o755);
  process.env[LLM_CMD_ENV] = `${provider} {prompt}`;
}

function repoWithTranscript(): { repo: string; transcript: string } {
  const repo = join(scratch, "repo");
  mkdirSync(repo);
  new WikiIndex(repo).init();
  ensureSkeleton(repo);
  const transcript = join(scratch, "session.md");
  writeFileSync(transcript, "We decided to keep storage local-only because the data must not leave the machine.\n");
  capture.enqueue(transcript, "okf-session", repo, 1, "plain");
  return { repo, transcript };
}

const page = (head: string) =>
  `---\n${head}title: T\ndescription: d\ndate: 2026-07-08\ntags: [a, b]\nstatus: stable\n---\n\nbody [^s1]\n\n[^s1]: x.jsonl\n`;

test("_category routes by OKF type, with the legacy domain as the fallback", () => {
  const c = defaults();
  expect(_category(page("type: Decision\n"), c)).toBe("3_decision");
  expect(_category(page("type: direction\n"), c)).toBe("1_direction"); // case-insensitive type key
  expect(_category(page("type: Insight\ndomain: milestone\n"), c)).toBe("4_insight"); // type wins
  expect(_category(page("type: Note\ndomain: decision\n"), c)).toBe("3_decision"); // unknown type → domain
  expect(_category(page("domain: decision\n"), c)).toBe("3_decision"); // legacy page
  expect(_category(page(""), c)).toBe("2_milestone"); // neither → first model-review category

  const p = join(mkdtempSync(join(tmpdir(), "llmwiki-okf-cfg-")), "llmwiki.config.toml");
  writeFileSync(
    p,
    `[[category]]\ndir = "1_goal"\ndomain = "goal"\nreview = "human"\nguide = "goal"\n` +
      `[[category]]\ndir = "2_lesson"\ndomain = "lesson"\nreview = "model"\nguide = "lesson"\n`,
  );
  const custom = loadFrom(p);
  expect(_category(page("type: Goal\n"), custom)).toBe("1_goal");
  expect(_category(page("type: Lesson\n"), custom)).toBe("2_lesson");
});

test("okfStamp replaces model-written provenance and drops legacy keys", () => {
  const root = join(scratch, "stamp");
  mkdirSync(root);
  ensureSkeleton(root);
  const modelPage =
    "---\ntitle: \"PASS\"는 착각\ndescription: d\ndate: 2026-07-08\ntags: [a, b]\nstatus: ready\ndomain: decision\n" +
    "source: x.jsonl\nupdated: 2026-07-09\ngenerated: { by: me, at: 2020-01-01T00:00:00Z }\nverified: { by: human:forged, at: 2020-01-01T00:00:00Z }\n" +
    "sources: [{ id: s1, resource: wrong.jsonl }]\n---\n\nbody [^s1]\n\n[^s1]: x.jsonl\n";
  const out = okfStamp(root, "3_decision/2026-07-08-x.md", modelPage, defaults(), {
    actor: "llmwiki-autoupdate/light",
    set: { type: "Decision" },
  });
  const data = frontmatter(out);
  expect(data.type).toBe("Decision");
  expect(data.title).toBe("\"PASS\"는 착각"); // a value strict YAML rejected survives, now quoted
  expect(data.status).toBe("stable");
  for (const k of ["domain", "source", "updated", "verified"]) expect(data[k]).toBeUndefined();
  expect(data.sources).toEqual([{ id: "s1", resource: "x.jsonl" }]); // from the footnote, not the model
  const g = data.generated as YamlMap;
  expect(g.by).toBe("llmwiki-autoupdate/light");
  expect(isIsoDateTime(g.at)).toBe(true);
});

test("a VERIFY pass that passed stamps verified + generated on the accepted page", async () => {
  const { repo, transcript } = repoWithTranscript();
  fakeProvider(
    "---\ntype: Decision\ntitle: Keep storage local\ndescription: Storage stays local-only.\ndate:\n" +
      "tags: [storage, privacy]\nstatus: stable\ndomain: decision\nsource: session.md\n---\n\n" +
      "Storage stays local-only.[^s1]\n\n[^s1]: session.md\n",
    "VERIFIED",
  );

  const result = await updateOne(repo, transcript, true, "light-test", "heavy-test");

  expect(result.category).toBe("3_decision");
  expect(String(result.dest)).toContain(join("docs", "wiki", "3_decision"));
  expect(result.verdict).toBe("verified");
  expect(result.accepted).toBe(true);
  const data = frontmatter(readFileSync(join(repo, String(result.dest)), "utf-8"));
  expect(data.type).toBe("Decision");
  expect(data.domain).toBeUndefined();
  expect(data.source).toBeUndefined();
  expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // blank date stamped deterministically
  expect(data.sources).toEqual([{ id: "s1", resource: "session.md" }]);
  expect((data.generated as YamlMap).by).toBe("llmwiki-autoupdate/light-test");
  const verified = data.verified as YamlMap;
  expect(verified.by).toBe("llmwiki-verify/heavy-test");
  expect(isIsoDateTime(verified.at)).toBe(true);
});

test("a direction draft lands in the queue as an OKF Review Item, unverified until the human confirms", async () => {
  const { repo, transcript } = repoWithTranscript();
  fakeProvider(
    "---\ntype: Direction\ntitle: Local-first storage\ndescription: The product keeps data local.\ndate: 2026-07-08\n" +
      "tags: [direction, storage]\nstatus: draft\n---\n\nData stays local.[^s1]\n\n[^s1]: session.md\n",
    "VERIFIED",
  );

  const result = await updateOne(repo, transcript, true, "light-test", "heavy-test");

  expect(result.verdict).toBe("direction-review");
  const item = readFileSync(join(repo, String(result.dest)), "utf-8");
  const data = frontmatter(item);
  expect(data.type).toBe("Review Item");
  expect(data.status).toBe("draft");
  expect(data.kind).toBe("question");
  expect(data.title).toBe("[review] Local-first storage");
  expect((data.generated as YamlMap).by).toBe("llmwiki-autoupdate/light-test");
  expect(data.verified).toBeUndefined();
  expect(data.source).toBeUndefined();
  // the embedded candidate is already in its destination's OKF form
  expect(item).toContain("type: Direction");
  expect(item).not.toContain("verified:");
  expect(existsSync(join(repo, "docs", "wiki", "1_direction", "2026-07-08-local-first-storage.md"))).toBe(false);
});

for (const verdict of ["VERIFIED", "REJECTED: unsupported claim"]) {
  test(`a ${verdict.startsWith("VERIFIED") ? "verified" : "rejected"} candidate never replaces a preexisting destination`, async () => {
    const { repo, transcript } = repoWithTranscript();
    const candidate = "---\ntype: Decision\ntitle: Keep storage local\ndescription: Storage stays local-only.\ndate: 2026-07-08\ntags: [storage, privacy]\nstatus: stable\n---\n\nStorage stays local-only.[^s1]\n\n[^s1]: session.md\n";
    const dest = join(repo, `docs/wiki/3_decision/${new Date().toISOString().slice(0, 10)}-keep-storage-local.md`);
    const original = "Existing carefully reviewed content.\n";
    writeFileSync(dest, original);
    fakeProvider(candidate, verdict);
    const result = await updateOne(repo, transcript, true, "light-test", "heavy-test");
    expect(result.accepted).toBe(false);
    expect(readFileSync(dest, "utf8")).toBe(original);
    if (verdict === "VERIFIED") {
      expect(result.verdict).toBe("conflict");
      expect(capture.getOffset(transcript)).toBe(0);
    }
  });
}
