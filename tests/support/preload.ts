// Every test run gets its own state root.
//
// Derived per-project state is engine-held (engine/project-state.ts), so a test that indexes a
// repository now writes into the STATE ROOT rather than into the temp repository it just made. A
// suite that does not pin the root therefore writes into whatever the developer's machine
// resolves — and it did: a full run left 18 project directories in this clone's own `.state`,
// which is both litter and a way for one test to see another's leftovers.
//
// Pinning it here rather than in each test file also covers the subprocess half — but only with
// the spawn defaults below. Bun (measured on 1.3.6) starts a child that was given no `env` with
// the environment the PARENT PROCESS STARTED WITH, not with `process.env` as mutated since: both
// `Bun.spawn*` and `node:child_process` ignore the variable this file sets. Every test that spawns
// the CLI or a hook without an explicit env therefore resolved the machine default and wrote
// project state into the developer's real ~/.local/share/llmwiki (measured: 24 directories for
// deleted `llmwiki-sessionstart-hook-*` fixtures in one day). Defaulting the child env to the live
// `process.env` restores the documented contract once, here, instead of in ~100 call sites.
import { mkdtempSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";

function insideTempRoot(dir: string): boolean {
  try {
    const root = realpathSync(tmpdir());
    const real = realpathSync(dir);
    return real === root || real.startsWith(root + sep);
  } catch {
    return false; // absent: not yet created, so not something a test run may adopt either
  }
}

// An inherited root is adopted only when it is itself a temp directory (a nested test run). A
// developer shell that exports the real root must not turn `bun test` into a writer of it.
const inherited = process.env.LLMWIKI_STATE_DIR;
if (!inherited || !insideTempRoot(inherited)) {
  process.env.LLMWIKI_STATE_DIR = mkdtempSync(join(tmpdir(), "llmwiki-test-state-"));
}

type Options = { env?: unknown } | undefined;
const withLiveEnv = <T extends Options>(opts: T): T =>
  opts && opts.env !== undefined ? opts : ({ ...(opts ?? {}), env: process.env } as T);

// Bun.spawn(cmd[], opts?) and Bun.spawn({ cmd, ...opts }).
for (const name of ["spawn", "spawnSync"] as const) {
  const original = Bun[name] as (...args: unknown[]) => unknown;
  (Bun as unknown as Record<string, unknown>)[name] = (first: unknown, opts?: Options) =>
    Array.isArray(first)
      ? original(first, withLiveEnv(opts))
      : original(withLiveEnv(first as Options));
}

// node:child_process (file, args?, opts?, ...). The ESM namespace is read-only, but named imports
// resolve through the CommonJS module object, so patching that object reaches `import { spawnSync }`.
const childProcess = createRequire(import.meta.url)("node:child_process") as Record<string, unknown>;
const liveEnvArgs = (rest: unknown[]): unknown[] => {
  const at = Array.isArray(rest[0]) ? 1 : 0;
  const slot = rest[at];
  if (slot === undefined || (typeof slot === "object" && slot !== null)) {
    rest[at] = withLiveEnv(slot as Options);
  } else {
    rest.splice(at, 0, withLiveEnv(undefined)); // a callback sits where the options would go
  }
  return rest;
};
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"] as const) {
  type Fn = ((...args: unknown[]) => unknown) & { [promisify.custom]?: (...args: unknown[]) => unknown };
  const original = childProcess[name] as Fn;
  const patched: Fn = (file: unknown, ...rest: unknown[]) => original(file, ...liveEnvArgs(rest));
  // `promisify(execFile)` resolves `{ stdout, stderr }` only through this hook; keep it, patched.
  const custom = original[promisify.custom];
  if (custom) patched[promisify.custom] = (file: unknown, ...rest: unknown[]) => custom(file, ...liveEnvArgs(rest));
  childProcess[name] = patched;
}
