#!/usr/bin/env bash
# Exit 0 healthy, 1 not running, 2 needs human action (do not restart), 3 stale. Prints the reason.
cd "$(dirname "$0")" || exit 1
exec "${NODE:-node}" bin/healthcheck.js "$@"
