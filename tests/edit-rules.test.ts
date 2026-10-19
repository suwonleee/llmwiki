// Edit-time path rules (engine/edit-rules.ts + the `edit-context-hook` entrypoint).
//
// The contract these tests pin: a human-confirmed rule whose `applies_to` globs match the file an
// agent is about to edit reaches it BEFORE the edit (gate: one deny, then the retry passes), at most
// once per session, never more than three at a time; everything else is zero bytes and the edit
// runs. Deprecated pages, malformed rules, unenrolled repositories, engine subprocesses and files
// outside the repository are all silence.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_EDIT_RULES_CHARS,
  buildEditRules,
  globMatches,
  loadEditRules,
  repoRelativePath,
  rulesFor,
  type EditRulesMode,
} from "../src/engine/edit-rules.ts";
import { preToolUseEnvelope } from "../src/engine/hook-envelope.ts";
import { parseYamlBlock, splitFrontmatter } from "../src/engine/okf.ts";
import { okfApply } from "../src/engine/okf-bundle.ts";
import { _resetForTests, defaults } from "../src/engine/config.ts";
import { WikiIndex } from "../src/engine/db.ts";
import { Linter } from "../src/engine/lint.ts";
import { freshnessSnapshot, acknowledgeFreshness } from "../src/engine/source-freshness.ts";
import { rebuildReferenceGraph } from "../src/engine/refs.ts";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const HOOK_CLI = join(import.meta.dir, "..", "src", "hook-cli.ts");
const dirs: string[] = [];
afterEach(() => {
  _resetForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const UA = "외부 httpx 요청에 User-Agent: example-app/<어댑터명> — 모듈 맨 위 _USER_AGENT 상수";

function page(root: string, rel: string, frontmatter: string, body = "\nbody\n"): void {
  const p = join(root, "docs", "wiki", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `---\n${frontmatter}\n---\n${body}`);
}

function ruleFm(globs: string[], rule: string, extra = "status: ready"): string {
  return `title: rule\n${extra}\nx-llmwiki: { applies_to: ${JSON.stringify(globs)}, rule: ${JSON.stringify(rule)} }`;
}

function wikiRoot(): string {
  const root = tempDir("llmwiki-editrules-");
  dirs.push(root);
  return root;
}

const sid = () => `test-${randomUUID()}`;

async function build(root: string, file: string, session: string, mode: EditRulesMode = "gate", agentId = "") {
  return buildEditRules({ root, sessionId: session, agentId, filePath: file, cwd: root, mode });
}

describe("glob semantics", () => {
  test("exact path, dir/**, nested wildcards", () => {
    expect(globMatches("src/a.ts", "src/a.ts")).toBe(true);
    expect(globMatches("src/a.ts", "src/b.ts")).toBe(false);
    expect(globMatches("src/adapters/**", "src/adapters/x.py")).toBe(true);
    expect(globMatches("src/adapters/**", "src/adapters/a/b/c.py")).toBe(true);
    expect(globMatches("src/adapters/**", "src/adaptersX/x.py")).toBe(false);
    expect(globMatches("packages/*/src/**/*.py", "packages/core/src/x/y.py")).toBe(true);
    expect(globMatches("packages/*/src/**/*.py", "packages/core/lib/y.py")).toBe(false);
  });

  test("a slash-free pattern matches the file name at any depth; ./, leading / and trailing / normalize", () => {
    expect(globMatches("*.sql", "q.sql")).toBe(true);
    expect(globMatches("*.sql", "db/migrations/001.sql")).toBe(true);
    expect(globMatches("*.sql", "db/q.sqlx")).toBe(false);
    expect(globMatches("Makefile", "tools/Makefile")).toBe(true);
    expect(globMatches("./src/a.ts", "src/a.ts")).toBe(true);
    expect(globMatches("/src/a.ts", "src/a.ts")).toBe(true);
    expect(globMatches("src/", "src/deep/a.ts")).toBe(true);
    expect(globMatches("", "src/a.ts")).toBe(false);
  });

  test("absolute and cwd-relative targets normalize to repo-relative; outside → null", () => {
    const root = wikiRoot();
    expect(repoRelativePath(root, join(root, "src", "a.ts"))).toBe("src/a.ts");
    expect(repoRelativePath(root, "a.ts", join(root, "src"))).toBe("src/a.ts");
    expect(repoRelativePath(root, join(root, "..", "elsewhere", "a.ts"))).toBeNull();
    expect(repoRelativePath(root, "/etc/hosts")).toBeNull();
    expect(repoRelativePath(root, root)).toBeNull();
  });

  test("the /var vs /private/var spelling of one directory does not decide the answer", () => {
    // mkdtempSync returns the un-canonical spelling on macOS; tempDir() the canonical one.
    const raw = mkdtempSync(join(tmpdir(), "llmwiki-editrules-alias-"));
    dirs.push(raw);
    const real = realpathSync(raw);
    expect(repoRelativePath(real, join(raw, "src", "new-file.ts"))).toBe("src/new-file.ts"); // not yet created
    expect(repoRelativePath(raw, join(real, "src", "x.ts"))).toBe("src/x.ts");
  });
});

describe("loading", () => {
  test("deprecated/superseded pages, the review queue and malformed rules are never loaded", async () => {
    const root = wikiRoot();
    page(root, "3_decision/2026-10-01-live.md", ruleFm(["src/**"], "live rule"));
    page(root, "3_decision/2026-09-01-old.md", ruleFm(["src/**"], "old rule", "status: deprecated"));
    page(root, "3_decision/2026-08-01-older.md", ruleFm(["src/**"], "older rule", "status: superseded"));
    page(root, "3_decision/2026-07-01-archived.md", ruleFm(["src/**"], "archived rule", "status: archived"));
    page(root, "3_decision/2026-06-01-replaced.md", ruleFm(["src/**"], "replaced rule", "superseded_by: 2026-10-01-live.md"));
    page(root, "0_review/q.md", ruleFm(["src/**"], "unconfirmed rule"));
    page(root, "3_decision/2026-10-02-bad.md", "title: bad\nx-llmwiki: { applies_to: [], rule: x }");
    page(root, "3_decision/2026-10-03-nokey.md", "title: plain page");
    const rules = await loadEditRules(root);
    expect(rules.map((r) => r.rule)).toEqual(["live rule"]);
    expect(rules[0]!.page).toBe("docs/wiki/3_decision/2026-10-01-live.md");
  });

  test("block-style YAML is read the same as the flow form", async () => {
    const root = wikiRoot();
    page(root, "3_decision/a.md", `title: a\nx-llmwiki:\n  applies_to:\n    - "src/**"\n    - "*.sql"\n  rule: block rule`);
    expect((await rulesFor(root, "db/q.sql")).map((r) => r.rule)).toEqual(["block rule"]);
  });

  test("the cache follows the wiki: an edited rule is re-read, an unchanged wiki is not re-parsed", async () => {
    const root = wikiRoot();
    const rel = "3_decision/a.md";
    page(root, rel, ruleFm(["src/**"], "first wording"));
    expect((await loadEditRules(root))[0]!.rule).toBe("first wording");
    page(root, rel, ruleFm(["src/**"], "second wording, longer"));
    const p = join(root, "docs", "wiki", rel);
    utimesSync(p, new Date(), new Date(Date.now() + 5000)); // guarantee a distinct mtime
    expect((await loadEditRules(root))[0]!.rule).toBe("second wording, longer");
  });

  test("an over-long rule is still delivered, cut to the budget", async () => {
    const root = wikiRoot();
    page(root, "3_decision/a.md", ruleFm(["src/**"], "x".repeat(400)));
    const [rule] = await loadEditRules(root);
    expect(rule!.rule.length).toBe(300);
    expect(rule!.rule.endsWith("…")).toBe(true);
  });
});

describe("delivery", () => {
  test("gate: the first matching edit is denied once; the retry and later matches are silent", async () => {
    const root = wikiRoot();
    page(root, "3_decision/2026-10-01-ua.md", ruleFm(["src/adapters/**"], UA));
    const s = sid();
    const first = await build(root, join(root, "src", "adapters", "x.py"), s);
    expect(first?.deny).toBe(true);
    expect(first!.text).toContain(`- ${UA} — docs/wiki/3_decision/2026-10-01-ua.md`);
    expect(first!.text).toContain("src/adapters/x.py");
    expect(await build(root, join(root, "src", "adapters", "x.py"), s)).toBeNull(); // the retry
    expect(await build(root, join(root, "src", "adapters", "y.py"), s)).toBeNull(); // another file, same rule
    expect(await build(root, join(root, "src", "other.py"), s)).toBeNull(); // no match
    // a new session hears it again
    expect((await build(root, join(root, "src", "adapters", "y.py"), sid()))?.deny).toBe(true);
  });

  test("cap 3 per edit; the overflow surfaces on the retry as context, never a second deny", async () => {
    const root = wikiRoot();
    for (let i = 1; i <= 5; i += 1) page(root, `3_decision/2026-10-0${i}-r${i}.md`, ruleFm(["src/**"], `rule ${i}`));
    const s = sid();
    const file = join(root, "src", "a.ts");
    const first = await build(root, file, s);
    expect(first?.deny).toBe(true);
    expect(first!.text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
    expect(first!.text).toContain("rule 5"); // newest first
    const retry = await build(root, file, s);
    expect(retry?.deny).toBe(false); // same path → never denied twice
    expect(retry!.text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2, 8))).toEqual(["rule 2", "rule 1"]);
    expect(await build(root, file, s)).toBeNull();
  });

  test("the whole block stays within the character budget", async () => {
    const root = wikiRoot();
    for (let i = 1; i <= 4; i += 1) page(root, `3_decision/r${i}.md`, ruleFm(["src/**"], `${i} ${"y".repeat(290)}`));
    const out = await build(root, join(root, "src", "a.ts"), sid());
    expect(out!.text.length).toBeLessThanOrEqual(MAX_EDIT_RULES_CHARS);
    expect(out!.text.split("\n").filter((l) => l.startsWith("- ")).length).toBeGreaterThanOrEqual(1);
  });

  test("advise never blocks; off and a session-less payload are silent", async () => {
    const root = wikiRoot();
    page(root, "3_decision/a.md", ruleFm(["src/**"], "advise me"));
    const advise = await build(root, join(root, "src", "a.ts"), sid(), "advise");
    expect(advise?.deny).toBe(false);
    expect(advise!.text).toContain("advise me");
    expect(advise!.text).not.toContain("retry");
    expect(await build(root, join(root, "src", "a.ts"), sid(), "off")).toBeNull();
    expect(await build(root, join(root, "src", "a.ts"), "")).toBeNull(); // no dedupe scope → never gate
    expect(await build(root, "/etc/hosts", sid())).toBeNull();
  });

  test("a subagent is its own dedupe scope — it has not seen what the main thread saw", async () => {
    const root = wikiRoot();
    page(root, "3_decision/a.md", ruleFm(["src/**"], "subagents too"));
    const s = sid();
    expect((await build(root, join(root, "src", "a.ts"), s))?.deny).toBe(true);
    expect((await build(root, join(root, "src", "a.ts"), s, "gate", "agent-1"))?.deny).toBe(true);
    expect(await build(root, join(root, "src", "a.ts"), s, "gate", "agent-1")).toBeNull();
  });

  test("the header follows the wiki language; the greppable tag does not", async () => {
    const root = wikiRoot();
    page(root, "3_decision/a.md", ruleFm(["src/**"], UA));
    const prev = process.env.LLMWIKI_LANG;
    process.env.LLMWIKI_LANG = "ko";
    try {
      const out = await build(root, join(root, "src", "a.ts"), sid());
      expect(out!.text.startsWith("----- [llmwiki edit rules] src/a.ts 에 적용되는 프로젝트 규칙")).toBe(true);
      expect(out!.text.endsWith("같은 편집을 다시 시도할 것.")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LLMWIKI_LANG;
      else process.env.LLMWIKI_LANG = prev;
    }
  });

  test("the envelope carries exactly the declared PreToolUse keys", () => {
    expect(JSON.parse(preToolUseEnvelope("R", true))).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "R" },
    });
    expect(JSON.parse(preToolUseEnvelope("R", false))).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "R" },
    });
    expect(preToolUseEnvelope("", true)).toBe("");
  });
});

describe("edit-context-hook entrypoint", () => {
  function enrolledRepo(): string {
    const repo = enrollRepo(makeGitRepo(tempDir("llmwiki-editrules-hook-")));
    dirs.push(repo);
    page(repo, "3_decision/2026-10-01-ua.md", ruleFm(["src/adapters/**"], UA));
    return repo;
  }

  function hook(repo: string, payload: Record<string, unknown>, env: Record<string, string> = {}): { out: string; code: number | null } {
    const r = Bun.spawnSync(["bun", HOOK_CLI, "edit-context-hook", repo], {
      stdin: Buffer.from(JSON.stringify(payload)),
      env: { ...process.env, LLMWIKI_LANG: "en", ...env },
    });
    return { out: r.stdout?.toString() ?? "", code: r.exitCode };
  }

  const payload = (repo: string, extra: Record<string, unknown> = {}) => ({
    session_id: sid(),
    cwd: repo,
    tool_name: "Edit",
    tool_input: { file_path: join(repo, "src", "adapters", "x.py"), old_string: "a", new_string: "b" },
    ...extra,
  });

  test("gate: deny once with the rule as the reason, then zero bytes on the retry", () => {
    const repo = enrolledRepo();
    const p = payload(repo);
    const first = hook(repo, p);
    expect(first.code).toBe(0);
    const parsed = JSON.parse(first.out);
    expect(Object.keys(parsed)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(parsed.hookSpecificOutput).sort()).toEqual(["hookEventName", "permissionDecision", "permissionDecisionReason"]);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
    const reason: string = parsed.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("[llmwiki edit rules]");
    expect(reason).toContain(UA);
    expect(reason.endsWith("Apply these, then retry the same edit.")).toBe(true);
    expect(hook(repo, p).out).toBe("");
  });

  test("advise mode and a subagent payload (Write, notebook path too) are served", () => {
    const repo = enrolledRepo();
    const advise = hook(repo, payload(repo, { agent_id: "a1", agent_type: "executor" }), { LLMWIKI_EDIT_RULES: "advise" });
    expect(JSON.parse(advise.out).hookSpecificOutput.additionalContext).toContain(UA);
    const nb = hook(repo, payload(repo, { tool_name: "NotebookEdit", tool_input: { notebook_path: join(repo, "src", "adapters", "n.ipynb") } }));
    expect(JSON.parse(nb.out).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("silence: off, engine subprocess, unenrolled repo, no file path, no session, unrelated file", () => {
    const repo = enrolledRepo();
    expect(hook(repo, payload(repo), { LLMWIKI_EDIT_RULES: "off" }).out).toBe("");
    expect(hook(repo, payload(repo), { LLMWIKI_ENGINE_SUBPROCESS: "1" }).out).toBe("");
    expect(hook(repo, payload(repo, { tool_input: {} })).out).toBe("");
    expect(hook(repo, payload(repo, { session_id: "" })).out).toBe("");
    expect(hook(repo, payload(repo, { tool_input: { file_path: join(repo, "README.md") } })).out).toBe("");
    const cold = makeGitRepo(tempDir("llmwiki-editrules-cold-"));
    dirs.push(cold);
    page(cold, "3_decision/a.md", ruleFm(["src/**"], "never"));
    const r = hook(cold, { ...payload(cold), tool_input: { file_path: join(cold, "src", "a.ts") } });
    expect(r.out).toBe("");
    expect(r.code).toBe(0);
  });

  test("a garbage payload is silent success, never a blocked edit", () => {
    const r = Bun.spawnSync(["bun", HOOK_CLI, "edit-context-hook", "/nonexistent"], { stdin: Buffer.from("{not json") });
    expect(r.stdout?.toString()).toBe("");
    expect(r.exitCode).toBe(0);
  });
});

describe("x-llmwiki survives the OKF writers", () => {
  function git(repo: string, ...args: string[]): void {
    const r = Bun.spawnSync(["git", "-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "user.email=k@example.com", "-c", "user.name=K", ...args]);
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  }

  test("`llmwiki okf --commit` normalization round-trips the key and the hook still reads it", async () => {
    const repo = mkdtempSync(join(tmpdir(), "llmwiki-editrules-okf-"));
    dirs.push(repo);
    git(repo, "init", "-q");
    page(repo, "current-state.md", "title: Current State\nupdated: 2026-10-01\ntags: [current-state, L0]");
    // flow form, legacy page (no type, no generated) — normalization MUST rewrite this page
    page(repo, "3_decision/2026-10-01-flow.md", `title: Flow\ndescription: d\ndate: 2026-10-01\ntags: [a, b]\nstatus: ready\n${ruleFm(["src/adapters/**", "*.sql"], UA, "").split("\n").slice(2).join("\n")}`);
    // block form
    page(
      repo,
      "3_decision/2026-10-02-block.md",
      `title: Block\ndescription: d\ndate: 2026-10-02\ntags: [a, b]\nstatus: ready\nx-llmwiki:\n  applies_to: ["packages/*/src/**/*.py"]\n  rule: "모듈 맨 위 상수: _X = 1"`,
    );
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    const before = await loadEditRules(repo);

    expect(okfApply(repo, { commit: true }).verdict).toBe("applied");
    const flow = readFileSync(join(repo, "docs", "wiki", "3_decision", "2026-10-01-flow.md"), "utf-8");
    expect(flow).toContain("type: Decision"); // it really was rewritten (re-emitted in block style)
    const data = parseYamlBlock(splitFrontmatter(flow).block!).data;
    expect(data["x-llmwiki"]).toEqual({ applies_to: ["src/adapters/**", "*.sql"], rule: UA });
    const after = await loadEditRules(repo);
    expect(after).toEqual(before);
    expect(after).toHaveLength(2);
    // a second pass is a no-op
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "okf");
    expect(okfApply(repo, { commit: true }).verdict).toBe("conforms");
  });
});

describe("lint", () => {
  function lint(frontmatter: string): { code: string; severity: string }[] {
    const root = wikiRoot();
    page(root, "3_decision/page.md", `description: fixture\ndate: 2026-10-01\ntags: [a, b]\n${frontmatter}`, "\n- claim\n");
    const w = new WikiIndex(root);
    w.indexAll();
    rebuildReferenceGraph(w);
    const conn = w.connect();
    try {
      const [issues] = new Linter(w as any, conn, defaults()).run("*", "all");
      return issues.filter((i) => i.path.includes("3_decision/page.md") && i.code.startsWith("edit-rule"));
    } finally {
      conn.close();
    }
  }

  test("a valid rule is clean; malformed shapes and deprecated carriers are warnings, never errors", () => {
    expect(lint(ruleFm(["src/**"], "ok"))).toEqual([]);
    const shape = lint(`title: t\nx-llmwiki: { applies_to: "src/**", rule: ${JSON.stringify("z".repeat(301))} }`);
    expect(shape.map((i) => i.code)).toEqual(["edit-rule-shape", "edit-rule-shape"]);
    expect(lint("title: t\nx-llmwiki: { applies_to: [src/**] }").map((i) => i.code)).toEqual(["edit-rule-shape"]);
    expect(lint("title: t\nx-llmwiki: nope").map((i) => i.code)).toEqual(["edit-rule-shape"]);
    const dep = lint(`${ruleFm(["src/**"], "ok", "status: deprecated\nsuperseded_by: 3_decision/x.md")}`);
    expect(dep.map((i) => i.code)).toEqual(["edit-rule-deprecated"]);
    for (const i of [...shape, ...dep]) expect(i.severity).toBe("warn");
  });
});

describe("stale marker and cache sweep", () => {
  test("removes only our own expired markers and caches; keeps fresh ones and foreign names", async () => {
    const { pruneStale } = await import("../src/engine/edit-rules.ts");
    const base = mkdtempSync(join(tmpdir(), "llmwiki-sweep-"));
    dirs.push(base);
    const prev = process.env.LLMWIKI_EDITRULES_TMPDIR;
    process.env.LLMWIKI_EDITRULES_TMPDIR = base;
    try {
      const old = (Date.now() - 10 * 24 * 3600 * 1000) / 1000;
      const mk = (name: string, dir: boolean, aged: boolean) => {
        const p = join(base, name);
        if (dir) mkdirSync(p);
        else writeFileSync(p, "{}");
        if (aged) utimesSync(p, old, old);
        return p;
      };
      mk("llmwiki-editrules-0123456789abcdef", true, true); // expired marker
      mk("llmwiki-editrules-cache-0123456789abcdef.json", false, true); // expired cache
      mk("llmwiki-editrules-fedcba9876543210", true, false); // fresh marker
      mk("llmwiki-editrules-alias-XYZ", true, true); // not our exact name
      mk("other-file.json", false, true);
      expect(pruneStale()).toBe(2);
      expect(readdirSync(base).sort()).toEqual(["llmwiki-editrules-alias-XYZ", "llmwiki-editrules-fedcba9876543210", "other-file.json"]);
    } finally {
      if (prev === undefined) delete process.env.LLMWIKI_EDITRULES_TMPDIR;
      else process.env.LLMWIKI_EDITRULES_TMPDIR = prev;
    }
  });
});


test("source-only changes withhold cached edit rules until revision-bound verification", async () => {
  const root = wikiRoot();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/policy.ts"), "export const LIMIT = 1;\n");
  page(root, "3_decision/retry.md", ruleFm(["src/**"], "Allow exactly ONE_ATTEMPT.",
    "status: stable\nsources:\n  - id: policy\n    resource: src/policy.ts"), "Retry policy.[^policy]\n\n[^policy]: implementation\n");
  const index = new WikiIndex(root);
  index.indexAll(); rebuildReferenceGraph(index);
  expect(await rulesFor(root, "src/worker.ts")).toHaveLength(1); // primes unchanged-wiki cache
  expect(await build(root, "src/worker.ts", sid())).not.toBeNull();
  writeFileSync(join(root, "src/policy.ts"), "export const LIMIT = 100;\n");
  index.indexAll();
  expect(await loadEditRules(root)).toEqual([]);
  expect(await rulesFor(root, "src/worker.ts")).toEqual([]);
  expect(await build(root, "src/worker.ts", sid())).toBeNull();
  const snapshot = freshnessSnapshot(root, "docs/wiki/3_decision/retry.md");
  acknowledgeFreshness(root, snapshot, { verifiedBy: "test", evidence: "Policy rule remains the intended constraint after source review" });
  expect(await rulesFor(root, "src/worker.ts")).toHaveLength(1); // cache kept raw declarations
  expect(await build(root, "src/worker.ts", sid())).not.toBeNull();
});
