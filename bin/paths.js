#!/usr/bin/env node
'use strict';
// Prints the absolute STATE_DIR and LOG_DIR (one per line) as the bridge resolves them: real environment first,
// then .env, then the defaults. Used by the shell scripts so they find the same pid file and logs as the bridge.
const path = require('node:path');
const { loadDotEnv } = require('../src/env');

const root = path.join(__dirname, '..');
const env = { ...process.env };
loadDotEnv(path.join(root, '.env'), env);
process.stdout.write(`${path.resolve(root, env.STATE_DIR || 'state')}\n${path.resolve(root, env.LOG_DIR || 'logs')}\n`);
