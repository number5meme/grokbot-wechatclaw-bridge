#!/usr/bin/env bash
# Stop the background bridge. It gets up to STOP_WAIT seconds (default 15) to finish messages in flight.
cd "$(dirname "$0")" || exit 1
# shellcheck source-path=SCRIPTDIR source=bin/common.sh
. bin/common.sh
load_paths || exit 1
WAIT="${STOP_WAIT:-15}"
if PID="$(bridge_pid)"; then
  kill "$PID"
  for _ in $(seq 1 $((WAIT * 4))); do pid_runs "$PID" || break; sleep 0.25; done
  if pid_runs "$PID"; then kill -9 "$PID"; echo "killed (pid $PID, did not stop within ${WAIT}s)"; else echo "stopped (pid $PID)"; fi
  rm -f "$PIDFILE"
else
  [ -f "$PIDFILE" ] && rm -f "$PIDFILE"
  echo "not running"
fi
