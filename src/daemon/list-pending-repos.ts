#!/usr/bin/env bun
// list-pending-repos.ts — print distinct pending repos from the central capture queue
// that exist on disk and aren't the home directory. Used by daemon/autoupdate-all.sh
// to drain pending sessions per-repo. Cheap read-only query (no LLM, no writes).
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { getDbPath } from "../engine/capture.ts";

const dbPath = getDbPath();
// no capture DB yet → no pending repos (daemon never ran). exit silently.
if (!existsSync(dbPath)) process.exit(0);

const db = new Database(dbPath);
const rows = db
  .query("SELECT DISTINCT repo FROM capture_queue WHERE status='pending' AND repo IS NOT NULL")
  .all() as { repo: string }[];
db.close();

const home = homedir();
for (const r of rows) {
  try {
    if (r.repo && statSync(r.repo).isDirectory() && r.repo !== home) {
      console.log(r.repo);
    }
  } catch {
    // path missing or unreadable — skip
  }
}
