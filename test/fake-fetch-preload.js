'use strict';
// Preloaded with `node -r` in end-to-end tests: replaces global fetch with a scripted fake. No network.
// FAKE_SCRIPT: JSON array of iLink responses returned in order for getupdates calls.
// Webhook POSTs (any URL containing "hooks.example.com") are recorded to FAKE_DUMP and answered 200.
// CDN GETs (any URL containing "cdn.example.com") are recorded and answered with FAKE_CDN_B64 (base64 bytes).
const fs = require('node:fs');
const script = JSON.parse(process.env.FAKE_SCRIPT || '[]');
const dump = process.env.FAKE_DUMP;
const record = (entry) => {
  if (!dump) return;
  const all = fs.existsSync(dump) ? JSON.parse(fs.readFileSync(dump, 'utf8')) : [];
  all.push(entry); fs.writeFileSync(dump, JSON.stringify(all));
};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('hooks.example.com')) {
    record({ kind: 'webhook', headers: opts.headers, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, text: async () => '' };
  }
  if (u.includes('cdn.example.com')) {
    record({ kind: 'cdn', path: new URL(u).pathname });
    const b = Buffer.from(process.env.FAKE_CDN_B64 || '', 'base64');
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '', arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  }
  record({ kind: 'ilink', path: new URL(u).pathname });
  const step = script.shift() || { ret: -14, errcode: -14 };
  return { ok: true, status: 200, text: async () => JSON.stringify(step) };
};
