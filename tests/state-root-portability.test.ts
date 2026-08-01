// The state root has to survive the clone changing address (src/engine/state-dir.ts).
//
// The ownership marker records the path it was written for, which is the right instinct — "we only
// touch what we own" is what stops this engine from adopting, chmodding and later deleting a
// directory it did not create. But the check was strict enough to fire on the case it should have
// welcomed: a clone that MOVED. Rename the directory, check the repository out at a different path
// on another machine, or bind-mount it into a container at /w, and the marker's recorded root no
// longer matches — so the state root was refused, and the refusal named llmwiki's OWN marker as an
// "unrecognized entry", sending the reader hunting for a foreign file that did not exist.
//
// Found by running the engine in a Linux container against a macOS checkout. That is the exact
// shape of "clone it in a different environment", which is the thing this engine is supposed to be
// good at.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_MARKER, ensureOwnedStateRoot, probeStateRoot, stateMarkerBytes } from "../src/engine/state-dir.ts";

const POSIX = process.platform !== "win32";
const scratches: string[] = [];

afterEach(() => {
  while (scratches.length) rmSync(scratches.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "llmwiki-state-portability-"));
  scratches.push(dir);
  return dir;
}

/** A state root whose marker was written for some OTHER path — a clone that has since moved. */
function movedStateRoot(extra: Record<string, string> = {}): string {
  const root = join(scratch(), "state");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = join(root, STATE_MARKER);
  writeFileSync(marker, stateMarkerBytes("/somewhere/else/.state"), { mode: 0o600 });
  if (POSIX) chmodSync(marker, 0o600);
  for (const [name, contents] of Object.entries(extra)) {
    const path = join(root, name);
    writeFileSync(path, contents, { mode: 0o600 });
    if (POSIX) chmodSync(path, 0o600);
  }
  return root;
}

describe("a state root whose clone moved", () => {
  test("is adopted and re-pointed instead of refused", () => {
    const root = movedStateRoot();
    const canonical = ensureOwnedStateRoot(root);
    // The marker now names where it actually is, so the next run takes the ordinary owned path.
    expect(readFileSync(join(root, STATE_MARKER), "utf-8")).toBe(stateMarkerBytes(canonical));
  });

  test("is re-pointed even with our own artifacts alongside the marker", () => {
    const root = movedStateRoot({ "daemon.log": "sweep 1\n", "update-check.json": "{}\n" });
    const canonical = ensureOwnedStateRoot(root);
    expect(readFileSync(join(root, STATE_MARKER), "utf-8")).toBe(stateMarkerBytes(canonical));
    // Nothing of ours was removed to make that happen.
    expect(readFileSync(join(root, "daemon.log"), "utf-8")).toBe("sweep 1\n");
  });

  test("reads as usable to doctor, with the reason stated", () => {
    const probe = probeStateRoot(movedStateRoot());
    expect(probe.usable).toBe(true);
    expect(probe.detail).toContain("moved");
  });

  test("is idempotent — the second call is an ordinary owned root", () => {
    const root = movedStateRoot();
    ensureOwnedStateRoot(root);
    const first = readFileSync(join(root, STATE_MARKER), "utf-8");
    ensureOwnedStateRoot(root);
    expect(readFileSync(join(root, STATE_MARKER), "utf-8")).toBe(first);
    expect(probeStateRoot(root).detail).toBe("owned");
  });
});

describe("what re-pointing must NOT do", () => {
  test("a directory holding a file we cannot account for is still refused", () => {
    // The relaxation is "our marker names another path", never "there is a marker, so take the
    // directory". A stranger's file in there still stops everything.
    const root = movedStateRoot({ "someones-notes.txt": "not ours\n" });
    expect(() => ensureOwnedStateRoot(root)).toThrow(/cannot prove it owns/);
  });

  test("the refusal no longer blames our own marker", () => {
    const root = movedStateRoot({ "someones-notes.txt": "not ours\n" });
    let message = "";
    try {
      ensureOwnedStateRoot(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("someones-notes.txt");
    // Naming the marker here is what made the old message unactionable.
    expect(message).not.toContain(STATE_MARKER);
  });

  test("a DIRECTORY wearing the marker-temp name does not make a root read as empty", () => {
    // The in-flight-marker exclusion filters entries by NAME, and a directory (holding anything)
    // with that name used to vanish from the emptiness check — so a non-empty root was adopted as
    // "empty". In-flight now additionally means: a regular, non-symlink file, written seconds ago.
    const root = join(scratch(), "state");
    mkdirSync(join(root, `.${STATE_MARKER}.tmp-1`), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, `.${STATE_MARKER}.tmp-1`, "victim-secrets.txt"), "not ours\n");
    expect(probeStateRoot(root).usable).toBe(false);
    expect(() => ensureOwnedStateRoot(root)).toThrow(/cannot prove it owns/);
  });

  test("a marker that is not ours in shape is not a marker at all", () => {
    const root = join(scratch(), "state");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const marker = join(root, STATE_MARKER);
    // Right filename, wrong schema — an extra key means this file was not written by this engine.
    writeFileSync(marker, JSON.stringify({ version: 1, root, extra: true }) + "\n", { mode: 0o600 });
    expect(() => ensureOwnedStateRoot(root)).toThrow(/cannot prove it owns/);
  });

  test.if(POSIX)("a group- or world-readable marker is not trusted for adoption", () => {
    // A 0644 marker is one some OTHER account could have written, and this verdict authorizes a
    // chmod and, later, a purge delete — so a loose-moded marker at a FOREIGN path is refused
    // outright. (A loose marker naming the CURRENT root stays repairable via markerContentMatches:
    // its exact content still proves this root was ours.)
    const root = movedStateRoot();
    chmodSync(join(root, STATE_MARKER), 0o644);
    expect(() => ensureOwnedStateRoot(root)).toThrow(/cannot prove it owns/);
  });

  test("a planted marker beside a stranger's log file does not authorize adoption", () => {
    // The exact shape of the demonstrated attack: a well-formed marker dropped into a directory
    // that also holds a log the engine never wrote. The broad any-*.log allowance applies only to
    // the canonical clone-local default; a moved root gets the strict list.
    const root = movedStateRoot({ "production.log": "the victim's own log\n" });
    expect(() => ensureOwnedStateRoot(root)).toThrow(/cannot prove it owns/);
    expect(readFileSync(join(root, "production.log"), "utf-8")).toBe("the victim's own log\n");
  });
});
