// Edit-time path rules through the Bash tool (engine/bash-writes.ts + edit-rules.ts + hook-cli).
//
// Measured: agents edited through Bash in 15/24 runs and the Edit-only hook never fired. The
// contract pinned here: a command that WRITES a file a rule covers gets the same once-per-session
// gate as an Edit (sharing its dedupe), and every read-only command — however many matching paths
// it names — is zero bytes, decided from the string alone.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { bashWriteTargets } from "../src/engine/bash-writes.ts";
import { buildEditRules, expandBashTargets } from "../src/engine/edit-rules.ts";
import { _resetForTests } from "../src/engine/config.ts";
import { enrollRepo, makeGitRepo, tempDir } from "./support/git-repo.ts";

const HOOK_CLI = join(import.meta.dir, "..", "src", "hook-cli.ts");
const dirs: string[] = [];
afterEach(() => {
  _resetForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RULE = "어댑터 모듈은 맨 위 _USER_AGENT 상수를 쓸 것";
const sid = () => `test-${randomUUID()}`;

function page(root: string, rel: string, globs: string[], rule: string): void {
  const p = join(root, "docs", "wiki", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `---\ntitle: r\nstatus: ready\nx-llmwiki: { applies_to: ${JSON.stringify(globs)}, rule: ${JSON.stringify(rule)} }\n---\nbody\n`);
}

// The measured shape: a python heredoc that reads, replaces and writes back.
const PY_HEREDOC = `python3 - <<'EOF'
p = "src/adapters/x.py"
s = open(p).read()
s = s.replace("a > b", "c")
open(p, "w").write(s)
EOF`;

describe("write detection (pure string scan)", () => {
  const writes: [string, string[]][] = [
    [PY_HEREDOC, ["src/adapters/x.py"]],
    [`python3 -c "open('src/adapters/x.py', 'a').write('x')"`, ["src/adapters/x.py"]],
    [`cat <<'EOF' | python3\nfrom pathlib import Path\nPath('src/adapters/q.py').write_text('x')\nEOF`, ["src/adapters/q.py"]],
    [`node -e "require('fs').writeFileSync('src/adapters/n.js', 'x')"`, ["src/adapters/n.js"]],
    [`bun -e "await Bun.write('src/adapters/b.ts', 'x')"`, ["src/adapters/b.ts"]],
    [`ruby -e "File.write('src/adapters/r.rb', 'x')"`, ["src/adapters/r.rb"]],
    [`sed -i 's/a/b/' src/adapters/x.py`, ["src/adapters/x.py"]],
    [`sed -i '' -e 's/a/b/' src/adapters/x.py src/y.py`, ["src/adapters/x.py", "src/y.py"]],
    [`sed -E -i.bak 's/a/b/' src/adapters/x.py`, ["src/adapters/x.py"]],
    [`perl -pi -e 's/a/b/' src/adapters/x.py`, ["src/adapters/x.py"]],
    [`echo hi > src/adapters/x.py`, ["src/adapters/x.py"]],
    [`echo hi>>src/adapters/x.py 2>/dev/null`, ["src/adapters/x.py"]],
    [`cat > src/adapters/new.py <<'EOF'\nif a > b:\n    open(x, 'w')\nEOF`, ["src/adapters/new.py"]],
    [`printf 'x' | tee -a src/adapters/x.py >/dev/null`, ["src/adapters/x.py"]],
    [`cp /tmp/a.py src/adapters/`, ["src/adapters/", "src/adapters/a.py"]],
    [`cd src && echo x >> adapters/z.py`, ["src/adapters/z.py"]],
    [`bash -c 'sed -i "s/a/b/" src/adapters/x.py'`, ["src/adapters/x.py"]],
  ];
  for (const [cmd, want] of writes) {
    test(`write: ${cmd.split("\n")[0]}`, () => {
      expect(bashWriteTargets(cmd)).toEqual(want);
    });
  }

  const reads = [
    "cat src/adapters/x.py",
    "grep -rn foo src/adapters/x.py 2>/dev/null | head",
    "rg -n 'a > b' src/adapters",
    "sed -n '1,20p' src/adapters/x.py",
    "sed 's/a/b/' src/adapters/x.py",
    "git log --oneline -- src/adapters/x.py 2>&1 | tail",
    "git diff src/adapters/x.py > /dev/null",
    "git show HEAD:src/adapters/x.py &>/dev/null",
    'echo "a > b" src/adapters/x.py',
    `python3 -c "print(open('src/adapters/x.py').read())"`,
    `python3 -c "import sys; sys.stdout.write(open('src/adapters/x.py').read())"`,
    `python3 - <<'EOF'\nprint(open("src/adapters/x.py").read())\nEOF`,
    "bun test tests/x.test.ts 2>&1 | tail -5",
    "ls src/adapters # > not a redirect in a comment",
    "",
  ];
  for (const cmd of reads) {
    test(`read-only: ${JSON.stringify(cmd.split("\n")[0])}`, () => {
      expect(bashWriteTargets(cmd)).toEqual([]);
    });
  }

  test("a write whose target is not spelled out falls back to every path-like word", () => {
    const t = bashWriteTargets("find src/adapters -name '*.py' | xargs sed -i 's/a/b/'");
    expect(t).toContain("src/adapters");
  });
});

describe("path resolution", () => {
  test("relative targets resolve against cwd; globs and directories expand to files", () => {
    const root = tempDir("llmwiki-bashwrites-");
    dirs.push(root);
    mkdirSync(join(root, "src", "adapters"), { recursive: true });
    writeFileSync(join(root, "src", "adapters", "a.py"), "");
    writeFileSync(join(root, "src", "adapters", "b.py"), "");
    expect(expandBashTargets(["src/adapters/new.py"], root)).toEqual([join(root, "src", "adapters", "new.py")]);
    expect(expandBashTargets(["src/adapters/*.py"], root).sort()).toEqual([
      join(root, "src", "adapters", "a.py"),
      join(root, "src", "adapters", "b.py"),
    ]);
    expect(expandBashTargets(["src/adapters"], root)).toContain(join(root, "src", "adapters", "b.py"));
    const home = process.env.HOME ?? "";
    if (home) expect(expandBashTargets(["~/x.py"], root)).toEqual([join(home, "x.py")]);
    for (const v of ["$PWD", "${PWD}", "$(pwd)"]) {
      expect(expandBashTargets([`${v}/src/adapters/new.py`], root)).toEqual([join(root, "src", "adapters", "new.py")]);
    }
  });
});

describe("delivery through Bash shares the Edit dedupe", () => {
  function wiki(): string {
    const root = tempDir("llmwiki-bashwrites-wiki-");
    dirs.push(root);
    page(root, "3_decision/2026-10-01-ua.md", ["src/adapters/**"], RULE);
    return root;
  }
  const viaBash = (root: string, cmd: string, s: string, mode: "gate" | "advise" = "gate") =>
    buildEditRules({ root, sessionId: s, filePath: "", bashTargets: bashWriteTargets(cmd), cwd: root, mode });
  const viaEdit = (root: string, rel: string, s: string) =>
    buildEditRules({ root, sessionId: s, filePath: join(root, rel), cwd: root, mode: "gate" });

  test("gate once via Bash with the command retry text; the retry and a later Edit are silent", async () => {
    const root = wiki();
    const s = sid();
    const first = await viaBash(root, PY_HEREDOC, s);
    expect(first?.deny).toBe(true);
    expect(first!.text).toContain(RULE);
    expect(first!.text).toContain("src/adapters/x.py");
    expect(first!.text.endsWith("Apply these, then retry the same command.")).toBe(true);
    expect(await viaBash(root, PY_HEREDOC, s)).toBeNull();
    expect(await viaEdit(root, "src/adapters/y.py", s)).toBeNull();
  });

  test("a rule shown via Edit is not shown again via Bash", async () => {
    const root = wiki();
    const s = sid();
    expect((await viaEdit(root, "src/adapters/x.py", s))?.deny).toBe(true);
    expect(await viaBash(root, "sed -i 's/a/b/' src/adapters/x.py", s)).toBeNull();
  });

  test("a write outside the rule's scope, or outside the repo, is silent", async () => {
    const root = wiki();
    expect(await viaBash(root, "echo x > src/other.py", sid())).toBeNull();
    expect(await viaBash(root, "echo x > /tmp/elsewhere.py", sid())).toBeNull();
  });

  test("advise never blocks", async () => {
    const out = await viaBash(wiki(), "echo x > src/adapters/x.py", sid(), "advise");
    expect(out?.deny).toBe(false);
    expect(out!.text).toContain(RULE);
  });
});

describe("edit-context-hook entrypoint with a Bash payload", () => {
  function enrolledRepo(): string {
    const repo = enrollRepo(makeGitRepo(tempDir("llmwiki-bashwrites-hook-")));
    dirs.push(repo);
    page(repo, "3_decision/2026-10-01-ua.md", ["src/adapters/**"], RULE);
    return repo;
  }
  function hook(repo: string, payload: Record<string, unknown>, env: Record<string, string> = {}) {
    const r = Bun.spawnSync(["bun", HOOK_CLI, "edit-context-hook", repo], {
      stdin: Buffer.from(JSON.stringify(payload)),
      env: { ...process.env, LLMWIKI_LANG: "en", ...env },
    });
    return { out: r.stdout?.toString() ?? "", code: r.exitCode };
  }
  const bash = (repo: string, command: string, s = sid()) => ({
    session_id: s,
    cwd: repo,
    tool_name: "Bash",
    tool_input: { command, description: "x" },
  });

  test("a matching write is denied once with the rule; the same command retried is silent", () => {
    const repo = enrolledRepo();
    const p = bash(repo, PY_HEREDOC);
    const first = hook(repo, p);
    expect(first.code).toBe(0);
    const out = JSON.parse(first.out).hookSpecificOutput;
    expect(out.permissionDecision).toBe("deny");
    expect(out.permissionDecisionReason).toContain(RULE);
    expect(out.permissionDecisionReason.endsWith("retry the same command.")).toBe(true);
    expect(hook(repo, p).out).toBe("");
  });

  test("read-only commands naming matching paths, off mode and a missing command are silent", () => {
    const repo = enrolledRepo();
    for (const cmd of ["cat src/adapters/x.py", "git log -- src/adapters/x.py", "grep -n a src/adapters/x.py", ""]) {
      const r = hook(repo, bash(repo, cmd));
      expect(r.out).toBe("");
      expect(r.code).toBe(0);
    }
    expect(hook(repo, bash(repo, "echo x > src/adapters/x.py"), { LLMWIKI_EDIT_RULES: "off" }).out).toBe("");
  });
});
