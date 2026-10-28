'use strict';
// WeChat hardening tests: -14 detection and optional pause, cursor after handling, persisted dedupe, context-token
// cap and reply quota, host checks (baseurl, CDN), file/video replies, --to / --stdin, and process-level checks.
// No network, no TTY: fetch is faked (test/fake-ilink-preload.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const ilink = require('../src/ilink');
const cdn = require('../src/cdn');
const C = require('../src/config');
const { createGuard } = require('../src/guard');
const { handleMessages } = require('../src/handler');
const { Poller, FatalError } = require('../src/poller');
const { Backoff } = require('../src/backoff');
const { sendReply, sendMediaReply, ReplyError, parseArgs } = require('../bin/reply');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fake-ilink-preload.js');
const NO_NET = path.join(__dirname, 'no-network-preload.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wechatclaw-hardening-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const OWNER = 'owner-user@im.wechat';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textMsg = (id, from, text) => ({ message_id: id, from_user_id: from, message_type: 1, context_token: `ctx-${id}`, item_list: [{ type: 1, text_item: { text } }] });
const memOwner = (v = null) => ({ get: () => v, set: (x) => { v = x; } });

function env(extra = {}) { return { PATH: process.env.PATH, BRIDGE_NO_DOTENV: '1', FORWARD_WEBHOOK_URL: 'https://hook.example/in', ...extra }; }
function runNode(args, extra = {}, opts = {}) { return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 15000, input: '', ...opts, env: env(extra) }); }
function stateFor(name, { creds = true, tokens = {} } = {}) {
  const st = path.join(TMP, name, 'state'); const lg = path.join(TMP, name, 'logs'); fs.mkdirSync(st, { recursive: true, mode: 0o700 });
  if (creds) fs.writeFileSync(path.join(st, 'credentials.json'), JSON.stringify({ bot_token: 'fake-token', ilink_bot_id: 'fake@im.bot', baseurl: 'https://ilinkai.weixin.qq.com', login_user_id: OWNER }), { mode: 0o600 });
  if (Object.keys(tokens).length) fs.writeFileSync(path.join(st, 'context-tokens.json'), JSON.stringify(tokens), { mode: 0o600 });
  return { st, lg, STATE_DIR: st, LOG_DIR: lg };
}
function requests(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) : []; }
async function waitFor(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); } throw new Error('timed out waiting'); }

/* ---- #24 ---- */
test('errCodeOf: -14 wins in either errcode or ret', () => {
  assert.strictEqual(ilink.errCodeOf({ ret: -1, errcode: -14 }), -14);
  assert.strictEqual(ilink.errCodeOf({ ret: -14, errcode: 0 }), -14);
  assert.strictEqual(ilink.errCodeOf({ ret: -14 }), -14);
  assert.strictEqual(ilink.errCodeOf({ ret: 0 }), 0);
});

/* ---- #14 / #25 / #27 poller ---- */
function poller(script, extra = {}) {
  const ctrl = new AbortController(); const order = []; const statuses = []; const logs = []; const errors = []; let beats = 0;
  const p = new Poller({
    getUpdates: async () => { const s = script.shift(); if (!s) { ctrl.abort(); throw Object.assign(new Error('a'), { name: 'AbortError' }); } return s(); },
    onMessages: async (m) => { order.push(`handle:${m.length}`); if (extra.slowMs) await sleep(extra.slowMs); },
    saveBuf: (b) => order.push(`save:${b}`), setStatus: (s) => statuses.push(s), beat: () => { beats++; },
    recordError: (e) => errors.push(e), logFn: (m) => logs.push(m), sleep: extra.sleep || (async () => {}),
    backoff: new Backoff({ baseMs: 2000, maxMs: 60000, random: () => 0 }), clock: null, ...extra.opts,
  });
  return { p, order, statuses, logs, errors, beats: () => beats, run: () => p.run(ctrl.signal) };
}

test('poller: the cursor is saved only after the batch was handled; heartbeat continues during a long batch', async () => {
  const h = poller([() => ({ ret: 0, get_updates_buf: 'C1', msgs: [{ message_id: '1' }] })], { slowMs: 120, opts: { busyBeatMs: 25 } });
  await h.run();
  assert.deepStrictEqual(h.order, ['handle:1', 'save:C1']);
  assert.ok(h.beats() >= 3, `beats during batch: ${h.beats()}`);
  const h2 = poller([() => ({ ret: 0, get_updates_buf: 'C2', msgs: [{ message_id: '2' }] })], { opts: { onMessages: async () => { throw new Error('crash'); } } });
  await assert.rejects(h2.run(), /crash/);
  assert.ok(!h2.order.includes('save:C2'), 'a failed batch does not advance the cursor');
});

test('poller: -14 pauses and retries with EXPIRED_RETRY_AFTER_MIN, still fatal by default; errmsg stays on one line', async () => {
  const slept = [];
  const h = poller([() => ({ ret: -1, errcode: -14 }), () => ({ ret: 0, get_updates_buf: 'after' })],
    { opts: { expiredRetryAfterMs: 60_000, busyBeatMs: 30_000 }, sleep: async (ms) => { slept.push(ms); } });
  await h.run();
  assert.deepStrictEqual(h.statuses, ['PAUSED_-14', 'RUNNING']);
  assert.ok(slept.length >= 1 && slept.reduce((a, b) => a + b, 0) <= 60_000);
  assert.ok(h.order.includes('save:after'));
  assert.ok(h.logs.some((l) => /pausing 1 min/.test(l)));
  const f = poller([() => ({ ret: -14 })]);
  await assert.rejects(f.run(), (e) => e instanceof FatalError && e.status === 'EXPIRED_-14');
  const e = poller([() => ({ ret: -1, errmsg: 'bad\nFORGED 2026 line\r\nmore' })]);
  await e.run();
  assert.ok(e.errors.every((x) => !/[\r\n]/.test(x)), JSON.stringify(e.errors));
  const cfgBad = runNode(['bin/bridge.js', '--check'], { ...stateFor('exp'), EXPIRED_RETRY_AFTER_MIN: 'soon' });
  assert.strictEqual(cfgBad.status, 2); assert.match(cfgBad.stderr, /EXPIRED_RETRY_AFTER_MIN/);
});

/* ---- #33 seen persisted and marked after handling ---- */
test('handler: ids are marked seen only after handling; markSeen persists; a crash leaves the message unseen', async () => {
  const guard = createGuard({ protection: false, ownerStore: memOwner() });
  const seen = new Set(); const marks = [];
  let fail = true;
  const deps = { guard, seen, markSeen: (id) => marks.push(id), forward: async () => { if (fail) throw new Error('crash'); return true; } };
  await assert.rejects(handleMessages([textMsg('1', OWNER, 'a')], deps), /crash/);
  assert.ok(!seen.has('1')); assert.deepStrictEqual(marks, []);
  fail = false;
  const r = await handleMessages([textMsg('1', OWNER, 'a'), textMsg('1', OWNER, 'a')], deps);
  assert.deepStrictEqual([r.forwarded, r.duplicate], [1, 1]);
  assert.deepStrictEqual(marks, ['1']);
});

/* ---- #28 context tokens capped, quota counter reset ---- */
test('context tokens: capped at CTX_TOKENS_MAX, newest kept; a new token resets the sent counter', () => {
  const P = C.paths({ stateDir: path.join(TMP, 'ctx'), logDir: path.join(TMP, 'ctx-logs') });
  fs.mkdirSync(path.dirname(P.ctxTokens), { recursive: true });
  const base = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < C.CTX_TOKENS_MAX + 5; i++) C.saveContextToken(P, `u${i}`, `t${i}`, new Date(base + i * 1000));
  const all = JSON.parse(fs.readFileSync(P.ctxTokens, 'utf8'));
  assert.strictEqual(Object.keys(all).length, C.CTX_TOKENS_MAX);
  assert.ok(!all.u0 && all[`u${C.CTX_TOKENS_MAX + 4}`]);
  all.u10.sent = 7; fs.writeFileSync(P.ctxTokens, JSON.stringify(all));
  C.saveContextToken(P, 'u10', 't10', new Date(base + 9e6));
  assert.strictEqual(JSON.parse(fs.readFileSync(P.ctxTokens, 'utf8')).u10.sent, 7, 'same token keeps its count');
  C.saveContextToken(P, 'u10', 'new-token', new Date(base + 9e6 + 1));
  assert.strictEqual(JSON.parse(fs.readFileSync(P.ctxTokens, 'utf8')).u10.sent, 0, 'new inbound message: fresh quota');
});

/* ---- #9 baseurl, CDN host checks ---- */
test('hosts: baseurl only on Tencent https hosts; WECHAT_CDN_BASE_URL and upload URLs checked', async () => {
  assert.strictEqual(C.safeBaseUrl('https://ilinkai.weixin.qq.com/'), 'https://ilinkai.weixin.qq.com');
  for (const bad of ['http://ilinkai.weixin.qq.com', 'https://evil.example', 'https://weixin.qq.com.evil.example', '', 'nonsense']) {
    assert.strictEqual(C.safeBaseUrl(bad), ilink.DEFAULT_BASE_URL, bad);
  }
  const s = stateFor('hosts');
  fs.writeFileSync(path.join(s.st, 'credentials.json'), JSON.stringify({ bot_token: 'x', baseurl: 'https://evil.example' }));
  assert.strictEqual(C.loadCreds(C.paths({ stateDir: s.st, logDir: s.lg })).baseurl, ilink.DEFAULT_BASE_URL);
  let r = runNode(['bin/bridge.js', '--check'], { ...s, WECHAT_CDN_BASE_URL: 'https://cdn.evil.example/c2c' });
  assert.strictEqual(r.status, 2); assert.match(r.stderr, /WECHAT_CDN_BASE_URL host/);
  r = runNode(['bin/bridge.js', '--check'], { ...s, WECHAT_CDN_BASE_URL: 'https://cdn.example.com/c2c', MEDIA_ALLOWED_HOSTS: 'cdn.example.com' });
  assert.strictEqual(r.status, 0, r.stderr);
  const posts = [];
  const f = async (url) => { posts.push(url); return { ok: true, status: 200, headers: new Headers({ 'x-encrypted-param': 'D' }), text: async () => '' }; };
  await assert.rejects(cdn.uploadMedia({ buf: Buffer.from('hello'), toUserId: OWNER, fetchImpl: f,
    getUploadUrl: async () => ({ upload_full_url: 'https://attacker.example/upload' }) }), (e) => e.label === 'UPLOAD_URL_REJECTED' || e.code === 'UPLOAD_URL_REJECTED');
  assert.deepStrictEqual(posts, [], 'nothing is uploaded to a foreign host');
});

test('login: redirect to a non-Tencent host is ignored; a foreign baseurl is not saved', () => {
  const st = path.join(TMP, 'login-evil'); fs.mkdirSync(st, { recursive: true });
  const urls = path.join(TMP, 'login-urls.json');
  const r = runNode(['-r', path.join(__dirname, 'fake-login-preload.js'), 'bin/login.js'],
    { STATE_DIR: st, FAKE_REDIRECT_HOST: 'evil.example', FAKE_BASEURL: 'https://evil.example', FAKE_URLS: urls });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes('REDIRECT'));
  assert.ok(JSON.parse(fs.readFileSync(urls, 'utf8')).every((u) => !u.includes('evil.example')));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(st, 'credentials.json'), 'utf8')).baseurl, ilink.DEFAULT_BASE_URL);
  const bad = runNode(['bin/login.js'], { STATE_DIR: st, OWNER_PROTECTION: 'maybe' });
  assert.strictEqual(bad.status, 2); assert.match(bad.stderr, /^ERROR /); assert.doesNotMatch(bad.stderr, /\n\s+at /, 'no stack trace');
});

/* ---- #33 file / video replies, quota trimming ---- */
test('media replies: file_item and video_item follow the official shapes; quota trims text chunks', async () => {
  const sent = []; const ups = [];
  const f = async () => ({ ok: true, status: 200, headers: new Headers({ 'x-encrypted-param': 'DP' }), text: async () => '' });
  const deps = { to: OWNER, fetchImpl: f, getUploadUrl: async (p) => { ups.push(p); return { upload_param: 'UP' }; }, send: async (i) => { sent.push(i); return { ret: 0 }; } };
  const doc = path.join(TMP, 'report.pdf'); fs.writeFileSync(doc, Buffer.from('%PDF-1.4 fake'));
  let r = await sendMediaReply('file', doc, 'see attached', deps);
  assert.strictEqual(r.messages, 2);
  assert.strictEqual(ups[0].media_type, cdn.UPLOAD_MEDIA_TYPE.FILE);
  assert.deepStrictEqual(sent[0], { type: 1, text_item: { text: 'see attached' } });
  assert.strictEqual(sent[1].type, 4);
  assert.deepStrictEqual(Object.keys(sent[1].file_item).sort(), ['file_name', 'len', 'media']);
  assert.deepStrictEqual([sent[1].file_item.file_name, sent[1].file_item.len, sent[1].file_item.media.encrypt_type], ['report.pdf', String(fs.statSync(doc).size), 1]);
  assert.strictEqual(Buffer.from(sent[1].file_item.media.aes_key, 'base64').toString(), ups[0].aeskey);
  const vid = path.join(TMP, 'clip.mp4'); fs.writeFileSync(vid, Buffer.alloc(100, 1));
  sent.length = 0; ups.length = 0;
  r = await sendMediaReply('video', vid, '', deps);
  assert.strictEqual(r.messages, 1); assert.strictEqual(ups[0].media_type, cdn.UPLOAD_MEDIA_TYPE.VIDEO);
  assert.strictEqual(sent[0].type, 5); assert.strictEqual(sent[0].video_item.video_size, cdn.aesEcbPaddedSize(100));
  await assert.rejects(sendMediaReply('video', doc, '', deps), (e) => e instanceof ReplyError && e.code === 'UNSUPPORTED_TYPE');
  const texts = []; let counted = 0;
  r = await sendReply('word '.repeat(2000), { maxChunks: 2, onSent: () => counted++, send: async (t) => { texts.push(t); return { ret: 0 }; } });
  assert.deepStrictEqual([r.parts, texts.length, counted], [2, 2, 2]);
  r = await sendReply('hi', { maxChunks: 0, send: async () => ({ ret: 0 }) });
  assert.strictEqual(r.parts, 1, 'at least one message is always tried');
  assert.deepStrictEqual(parseArgs(['--to', 'u', '--file', 'a.txt', '--stdin']), { to: 'u', text: [], kind: 'file', file: 'a.txt', stdin: true });
});

/* ---- #2 / #5 / #8 CLI ---- */
test('CLI reply: --to required and validated; --stdin conflicts; secrets refused; all before any network call', () => {
  const s = stateFor('cli', { tokens: { [OWNER]: { token: 'CTX', at: '2026-01-01T00:00:00Z' } } });
  fs.writeFileSync(path.join(TMP, 'cli', '.env'), 'X=1');
  const cases = [
    [['--to', '', 'hi'], 2, /^ERROR USAGE --to needs a recipient id, got \(empty\)/],
    [['--to', '--image', 'x.png'], 2, /^ERROR USAGE --to needs a recipient id, got --image/],
    [['--to', 'a b', 'hi'], 2, /^ERROR USAGE invalid --to/],
    [['hi'], 2, /^ERROR NO_RECIPIENT/],
    [['--to', OWNER, '--stdin', 'x'], 2, /^ERROR USAGE use either --stdin/],
    [['--to', OWNER, '--image', 'a.png', '--video', 'b.mp4'], 2, /^ERROR USAGE/],
    [['--to', OWNER, '--file', path.join(TMP, 'cli', '.env')], 1, /^ERROR FILE_NOT_ALLOWED/],
    [['--to', OWNER, '--file', path.join(s.st, 'credentials.json')], 1, /^ERROR FILE_NOT_ALLOWED/],
    [['--to', OWNER, '--voice', 'a.silk'], 1, /^ERROR UNSUPPORTED/],
  ];
  for (const [args, code, re] of cases) {
    const r = runNode(['--require', NO_NET, 'bin/reply.js', ...args], s);
    assert.strictEqual(r.status, code, `${JSON.stringify(args)}: ${r.stdout}${r.stderr}`); assert.match(r.stdout, re, JSON.stringify(args));
  }
  const n = stateFor('cli-noowner');
  fs.writeFileSync(path.join(n.st, 'credentials.json'), JSON.stringify({ bot_token: 'fake-token' }));
  const r = runNode(['--require', NO_NET, 'bin/reply.js', '--to', 'owner', 'hi'], n);
  assert.strictEqual(r.stdout.trim(), 'ERROR NO_RECIPIENT'); assert.strictEqual(r.status, 1);
});

test('CLI reply: heredoc via --stdin sent verbatim; -2 -> exit 3; quota counter; --file and --video sent', () => {
  const s = stateFor('cli2', { tokens: { [OWNER]: { token: 'CTX', at: '2026-01-01T00:00:00Z' } } });
  const dumpDir = path.join(TMP, 'cli2-dump');
  const text = 'It costs $5 and "quotes" and \'single\' $(id)\nsecond line\n';
  const sh = `"${process.execPath}" --require "${PRELOAD}" bin/reply.js --to '${OWNER}' --stdin <<'EOF'\n${text}EOF\n`;
  let r = spawnSync('bash', ['-c', sh], { cwd: ROOT, encoding: 'utf8', timeout: 15000, env: env({ ...s, FAKE_DUMP: dumpDir }) });
  assert.strictEqual(r.stdout.trim(), 'OK', r.stderr);
  const sends = requests(dumpDir).filter((q) => q.url.includes('sendmessage'));
  assert.strictEqual(sends.length, 1);
  assert.strictEqual(sends[0].body.msg.item_list[0].text_item.text, text.trim());
  assert.strictEqual(sends[0].body.msg.context_token, 'CTX');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(s.st, 'context-tokens.json'), 'utf8'))[OWNER].sent, 1);
  r = runNode(['--require', PRELOAD, 'bin/reply.js', '--to', OWNER, '--', 'hi'], { ...s, FAKE_SEND: 'minus2' });
  assert.strictEqual(r.stdout.trim(), 'ERROR -2'); assert.strictEqual(r.status, 3);
  const doc = path.join(TMP, 'notes.txt'); fs.writeFileSync(doc, 'notes');
  fs.rmSync(dumpDir, { recursive: true, force: true });
  r = runNode(['--require', PRELOAD, 'bin/reply.js', '--to', OWNER, '--file', doc, '--stdin'], { ...s, FAKE_DUMP: dumpDir }, { input: 'caption' });
  assert.strictEqual(r.stdout.trim(), 'OK', r.stderr);
  const items = requests(dumpDir).filter((q) => q.url.includes('sendmessage')).map((q) => q.body.msg.item_list[0]);
  assert.deepStrictEqual(items.map((i) => i.type), [1, 4]);
  assert.strictEqual(items[1].file_item.file_name, 'notes.txt');
  const vid = path.join(TMP, 'v.mp4'); fs.writeFileSync(vid, Buffer.alloc(64, 2));
  r = runNode(['--require', PRELOAD, 'bin/reply.js', '--to', 'owner', '--video', vid], { ...s, OWNER_ID: OWNER });
  assert.strictEqual(r.stdout.trim(), 'OK', r.stderr);
  assert.ok(!(r.stdout + r.stderr).includes('fake-token'));
  assert.ok(!fs.existsSync(path.join(s.st, 'reply.lock')));
});

/* ---- process level: single instance, persisted dedupe, graceful stop ---- */
test('bridge process: single instance; dedupe survives a restart; stop during a slow batch keeps the cursor for redelivery', async (t) => {
  const s = stateFor('proc');
  const batch = { ret: 0, get_updates_buf: 'CUR1', msgs: [textMsg('100', OWNER, 'hello')] };
  const start = (extra) => {
    const c = spawn(process.execPath, ['--require', PRELOAD, 'bin/bridge.js'], { cwd: ROOT, stdio: 'ignore',
      env: env({ ...s, FAKE_SCRIPT: JSON.stringify([batch]), BRIDGE_STOP_GRACE_MS: '300', ...extra }) });
    t.after(() => { try { c.kill('SIGKILL'); } catch { /* ignore */ } });
    return { c, exited: new Promise((r) => c.on('exit', (code) => r(code))) };
  };
  // 1) slow webhook: SIGTERM during the batch -> exit 0, cursor not saved, message not marked seen
  let b = start({ FAKE_WEBHOOK_MS: '20000' });
  await waitFor(() => fs.existsSync(path.join(s.lg, 'bridge.log')) && /inbound text/.test(fs.readFileSync(path.join(s.lg, 'bridge.log'), 'utf8')));
  const second = runNode(['--require', PRELOAD, 'bin/bridge.js'], s);
  assert.strictEqual(second.status, 2); assert.match(second.stderr, /already running/);
  b.c.kill('SIGTERM');
  assert.strictEqual(await b.exited, 0);
  assert.strictEqual(fs.readFileSync(path.join(s.st, 'STATUS'), 'utf8').trim(), 'STOPPED');
  assert.ok(!fs.existsSync(path.join(s.st, 'sync.json')), 'cursor not saved for an unfinished batch');
  assert.ok(!fs.existsSync(path.join(s.st, 'seen.json')) || !JSON.parse(fs.readFileSync(path.join(s.st, 'seen.json'), 'utf8')).includes('100'));
  // 2) redelivered batch is handled, then cursor and seen are saved
  const dumpDir = path.join(TMP, 'proc-dump');
  b = start({ FAKE_DUMP: dumpDir });
  await waitFor(() => fs.existsSync(path.join(s.st, 'sync.json')));
  b.c.kill('SIGTERM'); assert.strictEqual(await b.exited, 0);
  assert.strictEqual(requests(dumpDir).filter((q) => q.url.startsWith('https://hook')).length, 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.st, 'seen.json'), 'utf8')), ['100']);
  // 3) the same batch again after a restart is a duplicate (persisted dedupe)
  fs.rmSync(dumpDir, { recursive: true, force: true });
  b = start({ FAKE_DUMP: dumpDir });
  await waitFor(() => requests(dumpDir).filter((q) => q.url.includes('getupdates')).length >= 2);
  b.c.kill('SIGTERM'); assert.strictEqual(await b.exited, 0);
  assert.strictEqual(requests(dumpDir).filter((q) => q.url.startsWith('https://hook')).length, 0);
  const log = fs.readFileSync(path.join(s.lg, 'bridge.log'), 'utf8');
  for (const secret of ['fake-token', 'hook.example', 'hello']) assert.ok(!log.includes(secret), secret);
});

test('shell scripts: STATE_DIR/LOG_DIR from .env, idempotent start, PID reuse safe stop', async (t) => {
  const dir = path.join(TMP, 'copy'); fs.mkdirSync(dir);
  for (const n of ['bin', 'src', 'start.sh', 'stop.sh', 'status.sh', 'healthcheck.sh', 'watchdog.sh', 'replay.sh', 'reply.sh', 'package.json']) {
    fs.cpSync(path.join(ROOT, n), path.join(dir, n), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, '.env'), ['FORWARD_WEBHOOK_URL=https://hook.example/in', 'STATE_DIR=custom-state', 'LOG_DIR="custom logs"', ''].join('\n'));
  const st = path.join(dir, 'custom-state'); fs.mkdirSync(st, { mode: 0o700 });
  fs.writeFileSync(path.join(st, 'credentials.json'), JSON.stringify({ bot_token: 'fake-token', baseurl: 'https://ilinkai.weixin.qq.com' }), { mode: 0o600 });
  const shEnv = { PATH: process.env.PATH, NODE_OPTIONS: `--require ${PRELOAD}`, START_WAIT: '10', STOP_WAIT: '5' };
  const sh = (script) => spawnSync('bash', [path.join(dir, script)], { cwd: TMP, encoding: 'utf8', timeout: 30000, env: shEnv });
  t.after(() => { spawnSync('bash', [path.join(dir, 'stop.sh')], { env: shEnv, timeout: 20000 }); });
  let r = sh('start.sh');
  assert.match(r.stdout, /started \(pid \d+, status RUNNING\)/, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'custom logs', 'bridge.log')) && !fs.existsSync(path.join(dir, 'state')));
  const pid = fs.readFileSync(path.join(st, 'bridge.pid'), 'utf8').trim();
  assert.match(sh('start.sh').stdout, new RegExp(`already running \\(pid ${pid}\\)`));
  assert.match(sh('status.sh').stdout, /status: +RUNNING/);
  assert.match(sh('stop.sh').stdout, new RegExp(`stopped \\(pid ${pid}\\)`));
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => { try { other.kill('SIGKILL'); } catch { /* ignore */ } });
  fs.writeFileSync(path.join(st, 'bridge.pid'), `${other.pid}\n`);
  assert.match(sh('stop.sh').stdout, /not running/);
  assert.doesNotThrow(() => process.kill(other.pid, 0));
});
