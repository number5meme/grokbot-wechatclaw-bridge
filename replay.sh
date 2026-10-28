#!/usr/bin/env bash
# Resend undelivered payloads (state/undelivered.jsonl) to the webhook after fixing it.
cd "$(dirname "$0")" || exit 1
exec "${NODE:-node}" bin/replay-undelivered.js "$@"
