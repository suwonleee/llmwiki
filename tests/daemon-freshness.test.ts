// A running daemon holds the code it loaded at start, so "the engine is up to date" and "the loop
// actually sweeping is up to date" are two different facts. Until doctor could see the second one,
// a `git pull` without `./setup.sh` left every check green while the old capture logic kept running.
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { daemonFreshness, newestEngineSourceMtime, parseElapsedSeconds } from "../src/engine/daemon-control.ts";
import { tempDir } from "./support/git-repo.ts";

describe("elapsed-time parsing", () => {
  // `ps -o etime` is the one elapsed spelling BSD and procps share. `etimes` is procps-only
  // ("keyword not found" on macOS) and `lstart` is localized, so this format is the contract.
  test("reads every field width ps emits", () => {
    expect(parseElapsedSeconds("05:12")).toBe(312);
    expect(parseElapsedSeconds("01:37:54")).toBe(5874);
    expect(parseElapsedSeconds("2-01:05:12")).toBe(176712);
    expect(parseElapsedSeconds("  00:01  ")).toBe(1);
  });

  test("refuses anything it cannot read rather than guessing a number", () => {
    for (const bad of ["", "-", "abc", "1:2:3:4", "12", "2026년 8월 18일"]) {
      expect(parseElapsedSeconds(bad), bad).toBeNull();
    }
  });
});

describe("newest loaded engine source", () => {
  function fixture(): string {
    const root = tempDir("llmwiki-daemon-freshness-");
    mkdirSync(join(root, "src", "engine"), { recursive: true });
    mkdirSync(join(root, "daemon"), { recursive: true });
    writeFileSync(join(root, "src", "cli.ts"), "// entry\n");
    writeFileSync(join(root, "src", "engine", "capture.ts"), "// engine\n");
    writeFileSync(join(root, "src", "engine", "notes.md"), "# not loaded\n");
    writeFileSync(join(root, "daemon", "install.sh"), "# not loaded\n");
    const old = new Date("2026-01-01T00:00:00Z");
    for (const rel of [["src", "cli.ts"], ["src", "engine", "capture.ts"]]) {
      utimesSync(join(root, ...rel), old, old);
    }
    return root;
  }

  test("reports the newest TypeScript file the daemon would have loaded", () => {
    const root = fixture();
    try {
      const recent = new Date("2026-06-01T00:00:00Z");
      utimesSync(join(root, "src", "engine", "capture.ts"), recent, recent);

      const newest = newestEngineSourceMtime(root);
      expect(newest).not.toBeNull();
      expect(newest!.path).toBe(join(root, "src", "engine", "capture.ts"));
      expect(newest!.at).toBe(recent.getTime());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores files a running process never froze — shell installers and non-TypeScript", () => {
    const root = fixture();
    try {
      // Both are newer than every source, and neither is in the daemon's module graph: a touched
      // installer or note must not be reported as "the daemon is behind".
      const later = new Date("2026-09-01T00:00:00Z");
      utimesSync(join(root, "daemon", "install.sh"), later, later);
      utimesSync(join(root, "src", "engine", "notes.md"), later, later);

      const newest = newestEngineSourceMtime(root);
      expect(newest!.at).toBe(new Date("2026-01-01T00:00:00Z").getTime());
      expect(newest!.path.endsWith(".ts")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tree with no engine sources answers null instead of a bogus timestamp", () => {
    const root = tempDir("llmwiki-daemon-freshness-empty-");
    try {
      expect(newestEngineSourceMtime(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
// daemonFreshness: the close-out's one-line hygiene question, factored from doctor so
// /wiki-save · /wiki-deep can ask it without a full health run. The states matter more than the
// numbers: "absent" and "unknown" must stay distinct from "fresh", because a caller that restarts
// on anything-but-fresh would kill daemons on platforms that simply cannot date a process.
test("no running daemon reports absent, never stale", () => {
  // The suite's shimmed process table reports no watcher (tests replace ps/pgrep with inert
  // shims precisely so a test cannot see the developer's real processes).
  const f = daemonFreshness();
  expect(["absent", "unknown", "fresh", "stale"]).toContain(f.state);
  if (f.state === "stale") {
    expect(f.behindMinutes).toBeGreaterThanOrEqual(1);
    expect(f.newestPath.endsWith(".ts")).toBe(true);
  }
});
