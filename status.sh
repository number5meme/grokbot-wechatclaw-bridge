#!/usr/bin/env bash
# Human-readable status plus the last log lines.
cd "$(dirname "$0")" || exit 1
# shellcheck source-path=SCRIPTDIR source=bin/common.sh
. bin/common.sh
load_paths || exit 1
"$NODE" bin/healthcheck.js --status
echo "--- last log lines ---"
tail -n 10 "$LOG_DIR/bridge.log" 2>/dev/null || echo "(no log yet)"
