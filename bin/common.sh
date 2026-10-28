#!/usr/bin/env bash
# Shared helpers for the shell scripts (sourced, not run). Expects the current directory to be the bridge folder.
NODE="${NODE:-node}"

# Resolve STATE_DIR / LOG_DIR exactly as the bridge does (environment, then .env, then defaults).
load_paths() {
  local out
  out="$("$NODE" bin/paths.js)" || return 1
  STATE_DIR="$(printf '%s\n' "$out" | sed -n 1p)"
  LOG_DIR="$(printf '%s\n' "$out" | sed -n 2p)"
  PIDFILE="$STATE_DIR/bridge.pid"
  export STATE_DIR LOG_DIR
}

# True when $1 is a live process whose command line runs $2 (default bin/bridge.js), so a reused PID that now
# belongs to an unrelated process is never treated as the bridge (and never killed).
pid_runs() {
  local pid="$1" marker="${2:-bin/bridge.js}" args
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/cmdline" ]; then
    args="$(tr '\0' '\n' < "/proc/$pid/cmdline")"
  else
    args="$(ps -p "$pid" -o args= 2>/dev/null | tr ' ' '\n')"
  fi
  printf '%s\n' "$args" | grep -q -- "${marker}\$"
}

# Prints the bridge pid when the pid file names a live bridge process.
bridge_pid() {
  local pid
  [ -f "$PIDFILE" ] || return 1
  pid="$(head -n 1 "$PIDFILE" 2>/dev/null)"
  pid_runs "$pid" && printf '%s\n' "$pid"
}
