#!/bin/bash
# autoupdate-all.sh — drain the central capture queue unattended, FACTS ONLY (OPT-IN).
# For every repo with pending sessions, run the gated autoupdate (write → 2nd-model
# verify → lint gate). Accepted FACT pages land in docs/wiki (2_milestone etc.); doubtful
# ones quarantine to docs/wiki/0_review/ (human-judgment queue). The judgment layer
# (current-state.md) is never touched.
#
# CUT-LINE: the unattended path does *fact bookkeeping only*. Integration
# (synthesize) and judgment are JUDGMENT — they stay WARM (run /wiki-fast, or the /wiki-deep
# deep pass, in a human-present session), because unattended judgment measured 0 accepted core
# pages. So this
# script no longer runs synthesize; it only accumulates verified facts.
#
#   bash <clone>/daemon/autoupdate-all.sh [--commit] [--per-repo N]
# Without --commit it is a DRY-RUN (shows verdicts, writes nothing).
set -e
# ROOT = this clone, resolved from the script's own location (path/name-agnostic).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
COMMIT=""; PER=3
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) COMMIT="--commit";;
    --per-repo) PER="$2"; shift;;
  esac; shift
done

REPOS=$("$(command -v bun)" "$ROOT/src/daemon/list-pending-repos.ts")

[ -z "$COMMIT" ] && echo "### DRY-RUN (no --commit) — nothing will be written ###"
for repo in $REPOS; do
    echo "=== $repo ==="
    # accumulate ONLY — drain pending transcripts into dated milestones (verified facts).
    # NO integration pass here: integration is judgment → warm-only. Run
    # `/wiki-fast` (or the `/wiki-deep` deep pass) in a human-present session for that.
    "$(command -v bun)" "$ROOT/src/cli.ts" autoupdate "$repo" $COMMIT --limit "$PER" 2>&1 | sed 's/^/  /'
done
echo "### done (facts only). review: <repo>/docs/wiki/0_review/ — spot-check. 통합은 웜 /wiki-fast·/wiki-deep. ###"
