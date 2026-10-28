#!/usr/bin/env bash
# Start the bridge in the background (idempotent). Outbound connections only; no ports are opened.
# STATE_DIR / LOG_DIR are read from the environment or .env, exactly as the bridge reads them.
cd "$(dirname "$0")" || exit 1
# shellcheck source-path=SCRIPTDIR source=bin/common.sh
. bin/common.sh
load_paths || { echo "not started: cannot resolve paths"; exit 2; }
mkdir -p "$STATE_DIR" "$LOG_DIR" && chmod 700 "$STATE_DIR" "$LOG_DIR"
if PID="$(bridge_pid)"; then
  echo "already running (pid $PID)"; exit 0
fi
"$NODE" bin/bridge.js --check || { echo "not started"; exit 2; }
nohup "$NODE" bin/bridge.js >>"$LOG_DIR/bridge.out" 2>&1 < /dev/null &
NEWPID=$!
# Wait up to START_WAIT seconds (default 10) for RUNNING, a fatal exit, or a crash.
WAIT="${START_WAIT:-10}"
STATUS=""
for _ in $(seq 1 $((WAIT * 4))); do
  sleep 0.25
  kill -0 "$NEWPID" 2>/dev/null || break
  STATUS="$(cat "$STATE_DIR/STATUS" 2>/dev/null)"
  [ "$STATUS" = "RUNNING" ] && break
done
if kill -0 "$NEWPID" 2>/dev/null; then
  echo "started (pid $NEWPID, status ${STATUS:-none})"
else
  wait "$NEWPID" 2>/dev/null; RC=$?
  echo "failed to start (exit $RC, status: $(cat "$STATE_DIR/STATUS" 2>/dev/null || echo none)); see $LOG_DIR/bridge.log"
  tail -n 5 "$LOG_DIR/bridge.log" 2>/dev/null; exit 1
fi
