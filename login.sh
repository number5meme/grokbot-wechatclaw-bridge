#!/usr/bin/env bash
# QR login. Run in a terminal to see the QR code; headless: nohup ./login.sh > login.out 2>&1 &
cd "$(dirname "$0")" || exit 1
exec "${NODE:-node}" bin/login.js "$@"
