// The daemon's breadcrumb: where the RUNNING capture process actually looks.
//
// The daemon and an interactive `llmwiki` command are different processes with different
// environments. daemon/install.sh freezes CODEX_HOME / CLAUDE_CONFIG_DIR / OPENCODE_DB into the
// service definition at install time; a shell inherits whatever launched it. When Codex Desktop
// relocated CODEX_HOME per account the two disagreed silently — `locate` reported the app's
// account home while the daemon swept a ~/.codex the harness had stopped writing to — and the
// only symptom was "nothing captured in 11 days", with no cause attached.
//
// These pin the contract doctor relies on: the record survives a round trip, a damaged or absent
// record degrades to "no opinion" rather than a crash or a false alarm, and only the direction
// that actually loses data counts as drift.
import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DAEMON_RESOLVED_FILE,
  missedByDaemon,
  readDaemonResolved,
  writeDaemonResolved,
} from "../src/engine/daemon-resolved.ts";

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "llmwiki-resolved-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("daemon resolved-location breadcrumb", () => {
  test("round-trips what the daemon swept", () => {
    const root = scratch();
    writeDaemonResolved(
      { codexHomes: ["/a/.codex", "/a/app/home"], claudeDirs: ["/a/.claude"], opencodeDbs: ["/a/oc.db"] },
      root,
    );
    const back = readDaemonResolved(root)!;
    expect(back.codexHomes).toEqual(["/a/.codex", "/a/app/home"]);
    expect(back.claudeDirs).toEqual(["/a/.claude"]);
    expect(back.opencodeDbs).toEqual(["/a/oc.db"]);
    expect(back.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(back.at))).toBe(false);
  });

  test("absent or damaged records read as 'no opinion', never as a crash or a false alarm", () => {
    const root = scratch();
    expect(readDaemonResolved(root)).toBeNull(); // nothing written yet — an older daemon
    writeFileSync(join(root, DAEMON_RESOLVED_FILE), "{not json");
    expect(readDaemonResolved(root)).toBeNull();
    writeFileSync(join(root, DAEMON_RESOLVED_FILE), JSON.stringify({ pid: 1 })); // no timestamp
    expect(readDaemonResolved(root)).toBeNull();
    // a record whose arrays are the wrong shape keeps its timestamp but claims no locations,
    // which would report every location as missed — so non-strings are dropped, not coerced
    writeFileSync(
      join(root, DAEMON_RESOLVED_FILE),
      JSON.stringify({ at: "2026-09-03T00:00:00.000Z", codexHomes: [1, "", "/real"], claudeDirs: "nope" }),
    );
    const back = readDaemonResolved(root)!;
    expect(back.codexHomes).toEqual(["/real"]);
    expect(back.claudeDirs).toEqual([]);
  });

  test("an unwritable state root never fails the sweep", () => {
    expect(() =>
      writeDaemonResolved({ codexHomes: [], claudeDirs: [], opencodeDbs: [] }, join(scratch(), "missing", "deeper")),
    ).not.toThrow();
  });

  test("only locations the daemon MISSED count as drift", () => {
    // the real case: this shell resolves the app's account home, the daemon froze on ~/.codex
    expect(missedByDaemon(["/a/app/home"], ["/a/.codex"])).toEqual(["/a/app/home"]);
    // agreement is silent
    expect(missedByDaemon(["/a/.codex"], ["/a/.codex"])).toEqual([]);
    // the daemon seeing MORE is normal — it runs with the service environment, not this shell's
    expect(missedByDaemon(["/a/.codex"], ["/a/.codex", "/a/app/home"])).toEqual([]);
    // order is not agreement
    expect(missedByDaemon(["/b", "/a"], ["/a", "/b"])).toEqual([]);
  });

  test("the record is written 0600 — it names directories on this machine", () => {
    const root = scratch();
    writeDaemonResolved({ codexHomes: ["/a"], claudeDirs: [], opencodeDbs: [] }, root);
    const { mode } = require("node:fs").statSync(join(root, DAEMON_RESOLVED_FILE));
    expect(mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(join(root, DAEMON_RESOLVED_FILE), "utf8")).codexHomes).toEqual(["/a"]);
  });
});
