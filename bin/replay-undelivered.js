#!/usr/bin/env node
'use strict';
// Resend the payloads in <STATE_DIR>/undelivered.jsonl to FORWARD_WEBHOOK_URL (after fixing the webhook).
// Lines that fail again stay in undelivered.jsonl. Prints "sent=N failed=N invalid=N"; exit 0 when nothing failed.
const C = require('../src/config');
const F = require('../src/files');
const { postWebhook } = require('../src/webhook');
const { replayUndelivered } = require('../src/replay');

async function main() {
  let cfg;
  try { cfg = C.loadConfig({ requireApp: false }); } catch (e) { console.log('ERROR CONFIG'); console.error(e.message); process.exit(2); }
  const P = C.paths(cfg);
  const log = F.makeLogger(P.log);
  const post = (p) => postWebhook(p, { url: cfg.webhookUrl, auth: cfg.webhookAuth, logFn: log });
  const r = await F.withFileLock(`${P.undelivered}.lock`, () => replayUndelivered(P.undelivered, post, { logFn: log }));
  console.log(`sent=${r.sent} failed=${r.failed} invalid=${r.invalid}`);
  process.exit(r.failed ? 1 : 0);
}
main().catch((e) => { console.log('ERROR INTERNAL'); console.error(e.message); process.exit(1); });
