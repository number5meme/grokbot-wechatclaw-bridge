#!/usr/bin/env node
'use strict';
// Interactive configuration: writes .env in this bridge folder (next to package.json).
const path = require('node:path');
const { COMMON_QUESTIONS, runSetup } = require('../src/setup-common');

runSetup({ questions: COMMON_QUESTIONS, file: path.join(__dirname, '..', '.env') })
  .then(() => console.log('Next: ./login.sh (scan the QR code with WeChat), then ./start.sh'))
  .catch((e) => { console.error(e.message); process.exit(1); });
