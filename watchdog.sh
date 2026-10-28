#!/usr/bin/env bash
# Optional supervisor loop. Every WATCHDOG_INTERVAL seconds it runs the health check and restarts the
# bridge when it is not running (1) or stale (3). It never restarts on fatal states (2), such as an
# expired session or bad credentials; those are logged and left for a human.
# Only one watchdog runs per bridge folder (state/watchdog.pid).
# Run: nohup ./watchdog.sh >/dev/null 2>&1 &
cd "$(dirname "$0")" || exit 1
# shellcheck source-path=SCRIPTDIR source=bin/common.sh
. bin/common.sh
load_paths || exit 1
INTERVAL="${WATCHDOG_INTERVAL:-60}"
MAX_PER_HOUR="${WATCHDOG_MAX_RESTARTS_PER_HOUR:-6}"
LOG="$LOG_DIR/watchdog.log"
WD_PIDFILE="$STATE_DIR/watchdog.pid"
mkdir -p "$LOG_DIR" "$STATE_DIR" && chmod 700 "$LOG_DIR" "$STATE_DIR"
OTHER="$(head -n 1 "$WD_PIDFILE" 2>/dev/null)"
if [ -n "$OTHER" ] && [ "$OTHER" != "$$" ] && pid_runs "$OTHER" watchdog.sh; then
  echo "watchdog already running (pid $OTHER)"; exit 0
fi
( umask 077; echo "$$" > "$WD_PIDFILE" )
trap 'rm -f "$WD_PIDFILE"; exit 0' INT TERM
RESTARTS=()
log() { ( umask 077; echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$LOG" ); }
log "watchdog started (interval ${INTERVAL}s, max ${MAX_PER_HOUR} restarts/hour)"
LAST_FATAL=""
while true; do
  OUT=$(./healthcheck.sh 2>&1); RC=$?
  case "$RC" in
    0) LAST_FATAL="" ;;
    1|3)
      NOW=$(date +%s); KEEP=()
      for t in "${RESTARTS[@]}"; do [ $((NOW - t)) -lt 3600 ] && KEEP+=("$t"); done
      RESTARTS=("${KEEP[@]}")
      if [ "${#RESTARTS[@]}" -ge "$MAX_PER_HOUR" ]; then
        log "restart limit reached, not restarting: $OUT"
      else
        log "restarting: $OUT"
        ./stop.sh >> "$LOG" 2>&1
        ./start.sh >> "$LOG" 2>&1
        RESTARTS+=("$NOW")
      fi ;;
    *)
      if [ "$OUT" != "$LAST_FATAL" ]; then log "needs human action, not restarting: $OUT"; LAST_FATAL="$OUT"; fi ;;
  esac
  sleep "$INTERVAL" &
  wait $!
done
