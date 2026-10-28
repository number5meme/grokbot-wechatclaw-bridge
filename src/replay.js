'use strict';
// Replay payloads from undelivered.jsonl (and its rotated .1 file) to the webhook. Lines that fail again are
// appended back to undelivered.jsonl. Uses the same postWebhook as the bridge: no secrets on any command line.
const fs = require('node:fs');
const F = require('./files');

/**
 * file: path of undelivered.jsonl; post(payload) -> Promise<boolean>.
 * Returns { sent, failed, invalid }.
 */
async function replayUndelivered(file, post, { logFn = () => {} } = {}) {
  const work = `${file}.replay`;
  const sources = [];
  if (fs.existsSync(work)) sources.push(work); // left over from an interrupted replay
  for (const f of [`${file}.1`, file]) {
    if (!fs.existsSync(f)) continue;
    const tmp = `${work}.${sources.length}`;
    fs.renameSync(f, tmp); sources.push(tmp);
  }
  const r = { sent: 0, failed: 0, invalid: 0 };
  for (const src of sources) {
    const lines = fs.readFileSync(src, 'utf8').split('\n').filter((l) => l.trim());
    for (const line of lines) {
      let payload;
      try { payload = JSON.parse(line); } catch { r.invalid++; F.appendSecure(`${file}.invalid`, line + '\n'); continue; }
      let ok = false;
      try { ok = await post(payload); } catch { ok = false; }
      if (ok) r.sent++;
      else { r.failed++; F.appendSecure(file, JSON.stringify(payload) + '\n'); }
    }
    fs.unlinkSync(src);
  }
  logFn(`replay undelivered: sent=${r.sent} failed=${r.failed} invalid=${r.invalid}`);
  return r;
}

module.exports = { replayUndelivered };
