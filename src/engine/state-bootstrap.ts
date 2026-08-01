#!/usr/bin/env bun
// The installer asks the ENGINE where state belongs rather than deciding for itself.
//
// install.sh used to hardcode `<clone>/.state`, which quietly defeated the whole point of moving
// the default off the clone: every fresh install went back inside the disposable directory no
// matter what the engine's own resolution said. With no argument this now returns
// effectiveStateRoot() — which already prefers an existing clone-local root (so upgrades keep
// theirs) and otherwise picks the platform data directory.
import { bootstrapStateRoot, effectiveStateRoot } from "./state-dir.ts";

const requested = process.argv[2]?.trim();

try {
  console.log(bootstrapStateRoot(requested && requested.length > 0 ? requested : effectiveStateRoot()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
