'use strict';
// Preloaded with `--require` (NODE_OPTIONS) in process-level tests: a fake iLink server, CDN and webhook.
// No network. getupdates returns FAKE_SCRIPT steps in order, then idles (empty polls) until aborted.
//  FAKE_SEND       'ok' (default) or 'minus2': answer for sendmessage
//  FAKE_WEBHOOK_MS delay before the webhook answers
//  FAKE_DUMP       directory: every request is written there as one JSON file (url, body)
const fs = require('node:fs');
const path = require('node:path');
const script = JSON.parse(process.env.FAKE_SCRIPT || '[]');
let n = 0;
function dump(obj) {
  if (!process.env.FAKE_DUMP) return;
  fs.mkdirSync(process.env.FAKE_DUMP, { recursive: true });
  fs.writeFileSync(path.join(process.env.FAKE_DUMP, `${process.pid}-${Date.now()}-${String(n++).padStart(4, '0')}.json`), JSON.stringify(obj));
}
const res = (status, body, headers = {}) => ({ ok: status < 300, status, headers: new Headers(headers), type: 'basic',
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
});
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  let body; try { body = typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined; } catch { body = undefined; }
  dump({ url: u, body });
  if (u.startsWith('https://hook')) { await wait(Number(process.env.FAKE_WEBHOOK_MS) || 0, opts.signal); return res(200, 'ok'); }
  if (u.includes('/ilink/bot/getupdates')) {
    if (script.length) return res(200, script.shift());
    await wait(500, opts.signal);
    return res(200, { ret: 0, msgs: [] });
  }
  if (u.includes('/ilink/bot/sendmessage')) return res(200, process.env.FAKE_SEND === 'minus2' ? { ret: -2 } : { ret: 0 });
  if (u.includes('/ilink/bot/getuploadurl')) return res(200, { ret: 0, upload_param: 'UP' });
  if (u.includes('cdn.weixin.qq.com') && opts.method === 'POST') return res(200, '', { 'x-encrypted-param': 'DOWNLOAD_PARAM' });
  return res(404, {});
};
