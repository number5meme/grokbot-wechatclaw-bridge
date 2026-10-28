#!/usr/bin/env node
'use strict';
// WeChat ClawBot QR login.
// Shows the QR code in the terminal, saves it as state/qr.png, and writes the fallback link to state/qr-link.txt.
// Progress: one status word per line on stdout, also in state/LOGIN_STATE (current) and state/login-status.txt (history).
// On success the bot credentials are saved to state/credentials.json (mode 600). Nothing secret is printed.
const fs = require('node:fs');
const readline = require('node:readline/promises');
const C = require('../src/config');
const F = require('../src/files');
const ilink = require('../src/ilink');

const BOT_TYPE = '3';
const QR_TTL_MS = 5 * 60_000; // matches the official client
const MAX_QR = 3;
const POLL_TIMEOUT_MS = 35_000;

let cfg;
try { cfg = C.loadConfig({ requireWebhook: false }); } catch (e) {
  if (e instanceof C.ConfigError) { console.error(`ERROR ${e.message}`); process.exit(C.EXIT.CONFIG); }
  throw e;
}
const P = C.paths(cfg);
F.ensureDir(cfg.stateDir);

function status(word, detail = '') {
  const line = `${word}${detail ? ' ' + detail : ''}`;
  F.appendSecure(P.loginLog, `${new Date().toISOString()} ${line}\n`);
  F.writeSecure(P.loginState, word + '\n');
  process.stdout.write(line + '\n');
}

let QRCode = null;
try { QRCode = require('qrcode'); } catch { /* optional: fall back to the link only */ }

async function fetchQr() {
  const existing = F.readJson(P.creds, null);
  const r = await ilink.ilinkPost({
    baseUrl: ilink.DEFAULT_BASE_URL, endpoint: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
    body: { local_token_list: existing && existing.bot_token ? [existing.bot_token] : [] }, timeoutMs: 30_000, label: 'get_bot_qrcode',
  });
  if (!r.qrcode || !r.qrcode_img_content) throw new Error(`get_bot_qrcode: missing fields (ret=${r.ret ?? 'n/a'})`);
  const link = String(r.qrcode_img_content); // a URL that must be encoded into the QR image
  if (!/^https?:\/\//.test(link)) throw new Error('get_bot_qrcode: qrcode_img_content is not a URL');
  F.writeSecure(P.qrLink, link + '\n');
  if (QRCode) {
    await QRCode.toFile(P.qrPng, link, { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'M' });
    try { fs.chmodSync(P.qrPng, 0o600); } catch { /* ignore */ }
    if (process.stdout.isTTY) process.stdout.write(await QRCode.toString(link, { type: 'terminal', small: true }));
  }
  process.stdout.write(`Scan with WeChat${QRCode ? ` (QR image: ${P.qrPng})` : ''}. If scanning fails, open this link inside WeChat:\n${link}\n`);
  return { qrcode: r.qrcode, startedAt: Date.now() };
}

async function pollStatus(baseUrl, qrcode, verifyCode) {
  let ep = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) ep += `&verify_code=${encodeURIComponent(verifyCode)}`;
  try {
    return await ilink.ilinkGet({ baseUrl, endpoint: ep, timeoutMs: POLL_TIMEOUT_MS, label: 'get_qrcode_status' });
  } catch {
    return { status: 'wait' }; // timeouts and gateway errors: keep waiting, like the official client
  }
}

/** Ask for the verification digits on a terminal, or wait for them in state/verify_code.txt. */
async function getVerifyCode(deadline) {
  if (process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question('Enter the digits shown on your phone: ')).trim() || null; } finally { rl.close(); }
  }
  try { fs.unlinkSync(P.verifyCode); } catch { /* ignore */ }
  while (Date.now() < deadline) {
    const code = F.readText(P.verifyCode);
    if (code) { try { fs.unlinkSync(P.verifyCode); } catch { /* ignore */ } return code; }
    await F.sleep(1000);
  }
  return null;
}

function cleanupQr() { for (const f of [P.qrPng, P.qrLink, P.verifyCode]) { try { fs.unlinkSync(f); } catch { /* ignore */ } } }

async function main() {
  let qrCount = 0; let qr;
  try { qr = await fetchQr(); qrCount = 1; } catch (e) { status('FAILED', `cannot get QR code: ${e.message}`); process.exit(2); }
  status('QR_READY', `(1/${MAX_QR})`);
  let baseUrl = ilink.DEFAULT_BASE_URL; let pendingCode; let scannedNoted = false;

  const refresh = async (reason) => {
    if (qrCount >= MAX_QR) { status('FAILED', `${reason}; QR code refreshed ${MAX_QR} times, giving up`); cleanupQr(); process.exit(3); }
    try { qr = await fetchQr(); } catch (e) { status('FAILED', `cannot refresh QR code: ${e.message}`); cleanupQr(); process.exit(2); }
    qrCount += 1; baseUrl = ilink.DEFAULT_BASE_URL; pendingCode = undefined; scannedNoted = false;
    status('QR_READY', `(${qrCount}/${MAX_QR}) refreshed after ${reason}`);
  };

  for (;;) {
    if (Date.now() - qr.startedAt > QR_TTL_MS) { await refresh('5 minute timeout'); continue; }
    const s = await pollStatus(baseUrl, qr.qrcode, pendingCode);
    switch (s.status) {
      case 'wait': break;
      case 'scaned':
        if (pendingCode) { pendingCode = undefined; status('VERIFY_CODE_ACCEPTED'); }
        if (!scannedNoted) { status('SCANNED', 'confirm on your phone'); scannedNoted = true; }
        break;
      case 'need_verifycode': {
        status('NEED_VERIFY_CODE', process.stdin.isTTY ? '' : `write the digits shown on the phone to ${P.verifyCode}`);
        const code = await getVerifyCode(qr.startedAt + QR_TTL_MS);
        if (!code) { await refresh('verification code not provided in time'); continue; }
        pendingCode = code; status('VERIFY_CODE_SUBMITTED');
        continue;
      }
      case 'verify_code_blocked': status('VERIFY_CODE_BLOCKED'); await refresh('too many wrong codes'); continue;
      case 'scaned_but_redirect':
        // Only follow a redirect to a Tencent host (the QR code is not a secret, but keep the login on Tencent).
        if (s.redirect_host && /^[A-Za-z0-9.-]+$/.test(s.redirect_host) && C.safeBaseUrl(`https://${s.redirect_host}`) !== ilink.DEFAULT_BASE_URL) {
          baseUrl = `https://${s.redirect_host}`; status('REDIRECT', 'switching polling host');
        }
        break;
      case 'expired': status('EXPIRED_QR'); await refresh('QR code expired'); continue;
      case 'binded_redirect':
        status('ALREADY_BOUND', 'this bot is already bound to the saved credentials; keeping them');
        cleanupQr(); process.exit(0);
      case 'confirmed': {
        if (!s.bot_token || !s.ilink_bot_id) { status('FAILED', 'confirmed but the response is missing fields'); cleanupQr(); process.exit(4); }
        F.writeJson(P.creds, {
          bot_token: s.bot_token,
          ilink_bot_id: s.ilink_bot_id,
          // The bot token is sent to this host: only https on a Tencent host is kept, else the default.
          baseurl: C.safeBaseUrl(s.baseurl),
          login_user_id: s.ilink_user_id || '', // the WeChat account that scanned; default owner
          bound_at: new Date().toISOString(),
        });
        // Fresh login: reset cursor, context tokens, owner binding, last sender, and any fatal status.
        for (const f of [P.syncBuf, P.ctxTokens, P.owner, P.lastSender, P.status]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
        status('CONFIRMED', 'logged in; now run ./start.sh and send the bot a message');
        cleanupQr(); process.exit(0);
      }
      default: status('UNKNOWN_STATUS', String(s.status).slice(0, 40));
    }
    await F.sleep(1000);
  }
}

main().catch((e) => { try { status('FAILED', e.message); } catch { /* ignore */ } process.exit(1); });
