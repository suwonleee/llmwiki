#!/usr/bin/env bun
import { bootstrapStateRoot } from "./state-dir.ts";

const requested = process.argv[2];
if (!requested) {
  console.error("usage: state-bootstrap.ts <state-directory>");
  process.exit(2);
}

try {
  console.log(bootstrapStateRoot(requested));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
