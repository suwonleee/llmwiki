#!/usr/bin/env bun
// Plugin publish preflight — "what would a user actually receive?"
//
// Installing a plugin from a git marketplace copies the repository's TRACKED tree into the
// harness's plugin cache. That makes `git ls-files` the shipping manifest, and it makes one
// mistake catastrophic in a way disk size never is: publishing from the wrong clone would hand
// every installer this project's private working wiki. The runtime clone tracks exactly that, so
// the guard is not advisory — the private surface is an ERROR, and the check is the same list the
// pre-push hook enforces (githooks/pre-push), expressed once more at the moment of publication.
//
//   bun src/plugin/preflight.ts            # this clone
//   bun src/plugin/preflight.ts ~/llmwiki  # the public clone — the real publish target
//
// Exit 1 on any private-surface hit or manifest mismatch. Dead weight (tests, examples, assets)
// is REPORTED, never fatal: it costs a few MB of cache and nothing else, and the decision to trim
// it belongs to a human looking at the number.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLONE_ROOT } from "../engine/paths.ts";

/** Paths that must never reach an installer. Mirrors githooks/pre-push PRIVATE_SURFACE. */
const PRIVATE_SURFACE: readonly RegExp[] = [
  /^docs\/wiki\//, // this project's own working wiki
  /^docs\/eval-results\//, // measurement artefacts
  /^githooks\//, // team-only hooks
  /^\.mailmap$/, // real names and company e-mail
  /^reference\//, // internal notes — only exact reviewed public contracts ship, see PRIVATE_ALLOW
  /^experiments\//, // engine-dev scratch
  /^configs\/team-/, // team-specific config
  /^\.omc\//,
  /^\.omx\//,
  /^\.omo\//, // agent-harness working dirs
  /^\.idea\//, // IDE state
  /^\.env/, // never, under any spelling
  /^HANDOFF-/, // session handoff notes
];

/** Exact reviewed public contracts inside reference/. Everything else remains private by default. */
export const PUBLIC_REFERENCE_FILES: readonly string[] = [
  "reference/INSTALLATION_FLOW.md",
  "reference/support-contract.json",
  "reference/USABILITY_STUDY.md",
  "reference/usability-study-event.schema.json",
  "reference/usability-study-run.template.json",
  "reference/usability-study-task.md",
  "reference/RELEASE_GATES.md",
] as const;
const PRIVATE_ALLOW = new Set(PUBLIC_REFERENCE_FILES);

/** Not needed to RUN the plugin. Reported with sizes so the cost is visible, never fatal. */
const DEAD_WEIGHT: readonly RegExp[] = [/^tests\//, /^examples\//, /^assets\//, /^readmes\//];

/** Required at runtime by the plugin surfaces (hooks, skills, engine). */
const REQUIRED: readonly string[] = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".codex-plugin/plugin.json", // Codex reads this in preference to the Claude manifest (measured)
  "hooks/hooks.json", // the one hook config BOTH harnesses discover by default

  "hooks/sessionstart-inject.sh",
  "hooks/userpromptsubmit-inject.sh",
  "src/cli.ts",
  "package.json",
  "PLUGIN.md", // the disclosure sheet both manifests point reviewers at
];

export interface PreflightReport {
  files: number;
  bytes: number;
  privateHits: string[];
  missing: string[];
  deadWeight: { prefix: string; files: number; bytes: number }[];
  byTop: { name: string; files: number; bytes: number }[];
  versionMismatch: string | null;
  /** Top-level names present but NOT tracked. Measured: a marketplace added from a LOCAL PATH is
   * copied as a directory, so these ship too (`.omc/`, `node_modules/` observed); a marketplace
   * added from a GitHub URL is git-cloned, so only tracked files exist to copy. */
  localOnly: string[];
}

export function isPrivate(path: string): boolean {
  if (PRIVATE_ALLOW.has(path)) return false;
  return PRIVATE_SURFACE.some((re) => re.test(path));
}

export function trackedFiles(root: string): string[] {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

/** Top-level entries that exist in the working tree but are not tracked (untracked + ignored). */
export function untrackedTops(root: string): string[] {
  let out = "";
  try {
    out = execFileSync("git", ["-C", root, "ls-files", "-z", "--others"], {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const tops = new Set<string>();
  for (const f of out.split("\0")) {
    if (!f) continue;
    tops.add(f.includes("/") ? `${f.split("/")[0]}/` : f);
  }
  return [...tops].sort();
}

function sizeOf(root: string, rel: string): number {
  try {
    return statSync(join(root, rel)).size;
  } catch {
    return 0; // tracked but absent (sparse checkout) — counts as nothing, never throws
  }
}

export function classify(root: string, files: readonly string[], localOnly: string[] = []): PreflightReport {
  const sizes = new Map<string, number>();
  let bytes = 0;
  for (const f of files) {
    const s = sizeOf(root, f);
    sizes.set(f, s);
    bytes += s;
  }
  const bucket = (matcher: (p: string) => boolean) => {
    let n = 0;
    let b = 0;
    for (const f of files) {
      if (!matcher(f)) continue;
      n += 1;
      b += sizes.get(f) ?? 0;
    }
    return { files: n, bytes: b };
  };
  const byTopMap = new Map<string, { files: number; bytes: number }>();
  for (const f of files) {
    const top = f.includes("/") ? `${f.split("/")[0]}/` : f;
    const e = byTopMap.get(top) ?? { files: 0, bytes: 0 };
    e.files += 1;
    e.bytes += sizes.get(f) ?? 0;
    byTopMap.set(top, e);
  }
  // Versions are compared at HEAD, not in the working tree: HEAD is what a marketplace clone
  // would fetch. Each manifest is read on its own so one absent file reports as "missing"
  // (above) instead of masking a real version drift in the others.
  const atHead = (rel: string): any | null => {
    try {
      return JSON.parse(execFileSync("git", ["-C", root, "show", `HEAD:${rel}`], { encoding: "utf-8" }));
    } catch {
      return null;
    }
  };
  let versionMismatch: string | null = null;
  const pkg = atHead("package.json");
  const plug = atHead(".claude-plugin/plugin.json");
  const codex = atHead(".codex-plugin/plugin.json");
  const mkt = atHead(".claude-plugin/marketplace.json");
  if (!pkg || !plug) {
    versionMismatch = "could not read package.json / .claude-plugin/plugin.json at HEAD";
  } else if (pkg.version !== plug.version) {
    versionMismatch = `package.json ${pkg.version} ≠ plugin.json ${plug.version}`;
  } else if (codex && codex.version !== plug.version) {
    // Codex installs from ITS manifest, so a drift here ships two different versions.
    versionMismatch = `.codex-plugin ${codex.version} ≠ .claude-plugin ${plug.version}`;
  } else if (mkt) {
    // The same check `claude plugin tag` makes before cutting a release tag.
    const entry = (mkt.plugins ?? []).find((p: any) => p?.name === plug.name);
    if (!entry) versionMismatch = `marketplace.json has no entry named "${plug.name}"`;
    else if (entry.version && entry.version !== plug.version) {
      versionMismatch = `marketplace entry ${entry.version} ≠ plugin.json ${plug.version}`;
    }
  }
  return {
    files: files.length,
    bytes,
    privateHits: files.filter(isPrivate),
    missing: REQUIRED.filter((r) => !files.includes(r)),
    deadWeight: DEAD_WEIGHT.map((re) => ({ prefix: String(re).slice(2, -1).replace(/\\\//g, "/"), ...bucket((p) => re.test(p)) })).filter(
      (d) => d.files > 0,
    ),
    byTop: [...byTopMap.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.bytes - a.bytes),
    versionMismatch,
    localOnly,
  };
}

function kb(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? CLONE_ROOT);
  const report = classify(root, trackedFiles(root), untrackedTops(root));
  console.log(`=== plugin publish preflight — ${root} ===`);
  console.log(`  ships ${report.files} tracked file(s), ${kb(report.bytes)}`);
  for (const t of report.byTop.slice(0, 10)) console.log(`    ${t.name.padEnd(20)} ${String(t.files).padStart(4)} files  ${kb(t.bytes)}`);
  if (report.deadWeight.length) {
    const total = report.deadWeight.reduce((s, d) => s + d.bytes, 0);
    console.log(`  not needed at runtime (advisory, ${kb(total)}): ${report.deadWeight.map((d) => `${d.prefix} ${kb(d.bytes)}`).join(" · ")}`);
  }
  if (report.localOnly.length) {
    console.log(
      `  untracked here (${report.localOnly.length}): ${report.localOnly.slice(0, 8).join(" ")}${report.localOnly.length > 8 ? " …" : ""}`,
    );
    console.log(`    ↳ a GitHub-sourced install never sees these; adding this clone as a LOCAL-PATH marketplace ships them.`);
  }
  let failed = false;
  if (report.privateHits.length) {
    failed = true;
    console.error(`\n🔴 PRIVATE SURFACE WOULD SHIP — ${report.privateHits.length} file(s). Publish from the PUBLIC clone.`);
    for (const p of report.privateHits.slice(0, 10)) console.error(`     ${p}`);
    if (report.privateHits.length > 10) console.error(`     … +${report.privateHits.length - 10} more`);
  }
  if (report.missing.length) {
    failed = true;
    console.error(`\n🔴 missing required plugin file(s): ${report.missing.join(", ")}`);
  }
  if (report.versionMismatch) {
    failed = true;
    console.error(`\n🔴 version: ${report.versionMismatch}`);
  }
  if (!failed) console.log(`\n✅ safe to publish: no private surface, manifests present, versions agree`);
  process.exit(failed ? 1 : 0);
}
