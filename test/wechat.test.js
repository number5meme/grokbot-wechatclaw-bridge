'use strict';
// WeChat-specific tests. No network: fetch and the iLink calls are faked.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const ilink = require('../src/ilink');
const { createGuard, HANDLING_HINT } = require('../src/guard');
const { handleMessages } = require('../src/handler');
const { Poller, FatalError } = require('../src/poller');
const { Backoff } = require('../src/backoff');
const { sendReply, parseArgs, ReplyError } = require('../bin/reply');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-wechatclaw-test-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const OWNER = 'owner-user@im.wechat';
const STRANGER = 'stranger-user@im.wechat';
const textMsg = (id, from, text, extra = {}) => ({ message_id: id, from_user_id: from, message_type: 1, context_token: `ctx-${id}`, item_list: [{ type: 1, text_item: { text } }], ...extra });
function memOwner(init = null) { let o = init; return { get: () => o, set: (id) => { o = id; } }; }

/* ---------------- protocol helpers ---------------- */
test('uint64 ids are parsed losslessly', () => {
  const r = ilink.parseIlinkJson('{"ret":0,"msgs":[{"message_id":18446744073709551615,"text":"\\"message_id\\":1"}]}');
  assert.strictEqual(r.msgs[0].message_id, '18446744073709551615');
});
test('errCodeOf', () => {
  assert.strictEqual(ilink.errCodeOf({ ret: 0 }), 0);
  assert.strictEqual(ilink.errCodeOf({ ret: -14 }), -14);
  assert.strictEqual(ilink.errCodeOf({ errcode: -14 }), -14);
  assert.strictEqual(ilink.errCodeOf({ ret: -2 }), -2);
  assert.strictEqual(ilink.errCodeOf({}), 0);
});
test('request headers', () => {
  assert.match(Buffer.from(ilink.randomWechatUin(), 'base64').toString(), /^\d{1,10}$/);
  const h = ilink.postHeaders('TOKEN');
  assert.strictEqual(h.Authorization, 'Bearer TOKEN');
  assert.strictEqual(h.AuthorizationType, 'ilink_bot_token');
  assert.strictEqual(h['iLink-App-Id'], 'bot');
  assert.strictEqual(h['iLink-App-ClientVersion'], String((2 << 16) | (4 << 8) | 10));
  assert.ok(!('Authorization' in ilink.postHeaders('')));
});
test('extractText joins text items only', () => {
  assert.strictEqual(ilink.extractText({ item_list: [{ type: 1, text_item: { text: 'a' } }, { type: 3, voice_item: { text: 'v' } }, { type: 1, text_item: { text: 'b' } }] }), 'a\nb');
  assert.strictEqual(ilink.extractText({}), '');
});
test('getUpdates / sendTextMessage request shape (fake fetch)', async () => {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, text: async () => '{"ret":0}' }; };
  await ilink.getUpdates({ baseUrl: 'https://ilink.example', token: 'T', buf: 'B', timeoutMs: 1000, fetchImpl: f });
  await ilink.sendTextMessage({ baseUrl: 'https://ilink.example', token: 'T', to: OWNER, text: 'hi', contextToken: 'C', fetchImpl: f });
  assert.strictEqual(calls[0].url, 'https://ilink.example/ilink/bot/getupdates');
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body).get_updates_buf, 'B');
  const sent = JSON.parse(calls[1].opts.body);
  assert.strictEqual(calls[1].url, 'https://ilink.example/ilink/bot/sendmessage');
  assert.deepStrictEqual({ ...sent.msg, client_id: 'x' }, { from_user_id: '', to_user_id: OWNER, client_id: 'x', message_type: 2, message_state: 2, item_list: [{ type: 1, text_item: { text: 'hi' } }], context_token: 'C' });
  assert.strictEqual(sent.base_info.bot_agent, ilink.BOT_AGENT);
  const err = async () => ({ ok: false, status: 502, text: async () => '' });
  await assert.rejects(ilink.getUpdates({ baseUrl: 'https://ilink.example', token: 'T', timeoutMs: 1000, fetchImpl: err }), (e) => e.status === 502);
});

/* ---------------- message handling + protection ---------------- */
function harness({ protection = true, owner = OWNER, mirror = true, rate = 20, allowlist = [], forwardOk = true } = {}) {
  const fwd = []; const tokens = {}; const undelivered = []; let last = null;
  const guard = createGuard({ protection, ownerStore: memOwner(owner), allowlist, rateLimitPerMin: rate, maxChars: 50 });
  const deps = { guard, mirror, seen: new Set(), forward: async (p) => { fwd.push(p); return forwardOk; },
    saveToken: (u, t) => { tokens[u] = t; }, saveLastSender: (u) => { last = u; }, saveUndelivered: (p) => undelivered.push(p) };
  return { guard, fwd, tokens, undelivered, last: () => last, run: (msgs) => handleMessages(msgs, deps) };
}

test('protection on: only the owner is forwarded; strangers dropped silently and counted; tokens never stored for them', async () => {
  const h = harness();
  const r = await h.run([
    textMsg('18446744073709551615', OWNER, 'hello'),
    textMsg('2', STRANGER, 'spam'),
    { message_id: '3', from_user_id: OWNER, message_type: 2, item_list: [{ type: 1, text_item: { text: 'bot echo' } }] },
    textMsg('4', OWNER, '', { item_list: [{ type: 2, image_item: {} }] }),
    textMsg('18446744073709551615', OWNER, 'hello'), // duplicate
    textMsg('5', STRANGER, 'more spam'),
  ]);
  assert.deepStrictEqual(r, { forwarded: 1, dropped: 2, duplicate: 1, nonText: 1, undelivered: 0 });
  assert.strictEqual(h.fwd.length, 1);
  const p = h.fwd[0];
  assert.strictEqual(p.source, 'wechat');
  assert.strictEqual(p.sender_id, OWNER);
  assert.strictEqual(p.message_id, '18446744073709551615');
  assert.strictEqual(p.text, 'hello');
  assert.strictEqual(p.untrusted, true);
  assert.strictEqual(p.handling_hint, HANDLING_HINT);
  assert.strictEqual(p.mirror, true);
  assert.ok(!('sender_binding' in p));
  assert.deepStrictEqual(h.tokens, { [OWNER]: 'ctx-4' }, 'latest owner token kept, stranger token never stored');
  assert.strictEqual(h.guard.stats.dropped_not_owner, 2);
  assert.strictEqual(h.last(), OWNER);
});

test('protection on with no prior login owner: first sender is bound', async () => {
  const h = harness({ owner: null });
  await h.run([textMsg('1', STRANGER, 'first'), textMsg('2', OWNER, 'second')]);
  assert.deepStrictEqual(h.fwd.map((p) => p.sender_id), [STRANGER]);
  assert.strictEqual(h.guard.owner(), STRANGER);
});

test('protection off: everyone forwarded with untrusted false and no hint; mirror flag passes through', async () => {
  const h = harness({ protection: false, owner: null, mirror: false, rate: 1 });
  await h.run([textMsg('1', OWNER, 'a'), textMsg('2', STRANGER, 'b'), textMsg('3', STRANGER, 'c')]);
  assert.deepStrictEqual(h.fwd.map((p) => [p.sender_id, p.untrusted, p.mirror, 'handling_hint' in p]), [
    [OWNER, false, false, false], [STRANGER, false, false, false], [STRANGER, false, false, false]]);
  assert.strictEqual(h.guard.owner(), null);
  assert.deepStrictEqual(Object.keys(h.tokens).sort(), [OWNER, STRANGER].sort());
});

test('rate limit, allowlist and max length applied to forwarded messages', async () => {
  const h = harness({ rate: 2, allowlist: ['friend@im.wechat'] });
  await h.run([textMsg('1', OWNER, 'a'), textMsg('2', OWNER, 'b'), textMsg('3', OWNER, 'c'), textMsg('4', 'friend@im.wechat', 'x'.repeat(80))]);
  assert.deepStrictEqual(h.fwd.map((p) => p.text.length), [1, 1, 50]);
  assert.strictEqual(h.fwd[2].truncated, true);
  assert.strictEqual(h.guard.stats.dropped_rate_limited, 1);
});

test('failed forwards are kept as undelivered', async () => {
  const h = harness({ forwardOk: false });
  const r = await h.run([textMsg('1', OWNER, 'lost')]);
  assert.strictEqual(r.undelivered, 1);
  assert.strictEqual(h.undelivered[0].text, 'lost');
});

/* ---------------- long-poll loop / anti-disconnect ---------------- */
function timeoutErr() { const e = new Error('timeout'); e.name = 'TimeoutError'; return e; }
function pollerHarness(script, extra = {}) {
  const ctrl = new AbortController(); const delays = []; const statuses = []; const logs = []; const errors = []; let beats = 0; const handled = []; let buf = null;
  const p = new Poller({
    getUpdates: async (args) => {
      const step = script.shift();
      if (!step) { ctrl.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
      return step(args, p);
    },
    onMessages: async (m) => handled.push(...m),
    saveBuf: (b) => { buf = b; },
    setStatus: (s) => statuses.push(s), beat: () => { beats++; }, recordError: (e) => errors.push(e), logFn: (m) => logs.push(m),
    sleep: async (ms) => { delays.push(ms); }, backoff: new Backoff({ baseMs: 2000, maxMs: 60000, random: () => 0 }), clock: null,
    ...extra,
  });
  return { p, ctrl, delays, statuses, logs, errors, handled, beats: () => beats, buf: () => buf, run: () => p.run(ctrl.signal) };
}

test('poller: client timeout is a normal empty poll; cursor saved; messages handled; longpolling_timeout_ms honored', async () => {
  const seenTimeouts = [];
  const h = pollerHarness([
    (a) => { seenTimeouts.push(a.timeoutMs); throw timeoutErr(); },
    (a) => { seenTimeouts.push(a.timeoutMs); return { ret: 0, get_updates_buf: 'C1', longpolling_timeout_ms: 20000, msgs: [{ message_id: '1' }] }; },
    (a) => { seenTimeouts.push(a.timeoutMs); return { ret: 0, msgs: [] }; },
  ]);
  await h.run();
  assert.deepStrictEqual(h.delays, [], 'no backoff for timeouts');
  assert.strictEqual(h.buf(), 'C1');
  assert.strictEqual(h.handled.length, 1);
  assert.deepStrictEqual(seenTimeouts, [40000, 40000, 25000]);
  assert.strictEqual(h.beats(), 2, 'timeouts are not counted as healthy activity');
});

test('poller: errors back off exponentially, DEGRADED after 3, RUNNING again on recovery', async () => {
  const boom = () => { throw Object.assign(new Error('fetch failed'), { name: 'TypeError' }); };
  const h = pollerHarness([boom, () => ({ ret: -1, errmsg: 'busy' }), boom, boom, () => ({ ret: 0 }), boom]);
  await h.run();
  assert.deepStrictEqual(h.delays, [2000, 4000, 8000, 16000, 2000]);
  assert.deepStrictEqual(h.statuses, ['DEGRADED', 'RUNNING']);
  assert.ok(h.errors.some((e) => e.includes('ret=-1')));
  assert.ok(h.logs.some((l) => l.includes('recovered')));
});

test('poller: -14 is fatal and never retried', async () => {
  let calls = 0;
  const h = pollerHarness([() => { calls++; return { ret: -14, errcode: -14 }; }, () => { calls++; return { ret: 0 }; }]);
  await assert.rejects(h.run(), (e) => e instanceof FatalError && e.status === 'EXPIRED_-14');
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(h.delays, []);
});

test('poller: clock jump aborts a hung long-poll and reconnects immediately without backoff', async () => {
  const h = pollerHarness([
    (a, p) => new Promise((_, reject) => {
      a.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      setTimeout(() => p.onClockJump(3_600_000), 10); // simulated resume after an hour of suspend
    }),
    () => ({ ret: 0, get_updates_buf: 'after-resume' }),
  ]);
  await h.run();
  assert.deepStrictEqual(h.delays, []);
  assert.strictEqual(h.buf(), 'after-resume');
  assert.strictEqual(h.p.clockJumps, 1);
  assert.ok(h.logs.some((l) => /clock jump detected \(3600s/.test(l)));
});

test('poller: stop signal ends the loop cleanly', async () => {
  const ctrl = new AbortController();
  const p = new Poller({ getUpdates: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('stopped')))), onMessages: async () => {}, clock: null });
  setTimeout(() => ctrl.abort(), 10);
  await p.run(ctrl.signal);
});

/* ---------------- reply ---------------- */
test('reply: Markdown stripped, chunked, -2 and -14 mapped', async () => {
  const sent = [];
  const r = await sendReply('**Hi** there', { send: async (t) => { sent.push(t); return {}; } });
  assert.deepStrictEqual([r.parts, sent], [1, ['Hi there']]);
  sent.length = 0;
  await sendReply('word '.repeat(1000), { send: async (t) => { sent.push(t); return { ret: 0 }; } });
  assert.strictEqual(sent.length, 3); assert.ok(sent.every((t) => t.length <= 2000));
  await assert.rejects(sendReply('x', { send: async () => ({ ret: -2 }) }), (e) => e instanceof ReplyError && e.code === '-2' && e.exit === 3);
  await assert.rejects(sendReply('x', { send: async () => ({ ret: -14 }) }), (e) => e.code === '-14' && e.exit === 14);
  await assert.rejects(sendReply('x', { send: async () => { throw Object.assign(new Error(), { status: 500 }); } }), (e) => e.code === 'HTTP_500');
  await assert.rejects(sendReply('x', { send: async () => { throw timeoutErr(); } }), (e) => e.code === 'TIMEOUT');
  await assert.rejects(sendReply('   ', { send: async () => ({}) }), (e) => e.code === 'EMPTY_TEXT');
  assert.deepStrictEqual(parseArgs(['--to', 'u1', 'hello', 'world']), { to: 'u1', text: ['hello', 'world'] });
});

/* ---------------- CLI (no network) ---------------- */
function runNode(args, env) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, BRIDGE_NO_DOTENV: '1', STATE_DIR: path.join(TMP, 'state'), LOG_DIR: path.join(TMP, 'logs'), ...env } });
}

test('CLI: bridge --check rejects bad config (exit 2) and missing login (exit 2)', () => {
  let r = runNode(['bin/bridge.js', '--check'], {});
  assert.strictEqual(r.status, 2); assert.match(r.stderr, /FORWARD_WEBHOOK_URL is required/);
  r = runNode(['bin/bridge.js', '--check'], { FORWARD_WEBHOOK_URL: 'https://hooks.example.com/x', MIRROR_TO_MAIN_CHAT: 'perhaps' });
  assert.strictEqual(r.status, 2); assert.match(r.stderr, /MIRROR_TO_MAIN_CHAT/);
  r = runNode(['bin/bridge.js', '--check'], { FORWARD_WEBHOOK_URL: 'https://hooks.example.com/x' });
  assert.strictEqual(r.status, 2); assert.match(r.stderr, /not logged in/);
  assert.strictEqual(fs.readFileSync(path.join(TMP, 'state', 'STATUS'), 'utf8').trim(), 'NO_CREDENTIALS');
  fs.writeFileSync(path.join(TMP, 'state', 'credentials.json'), JSON.stringify({ bot_token: 'fake', ilink_bot_id: 'fake@im.bot', login_user_id: OWNER }));
  r = runNode(['bin/bridge.js', '--check'], { FORWARD_WEBHOOK_URL: 'https://hooks.example.com/x', OWNER_PROTECTION: 'off', MIRROR_TO_MAIN_CHAT: 'false' });
  assert.strictEqual(r.status, 0, r.stderr); assert.match(r.stdout, /protection off, mirror false/);
});

test('CLI: healthcheck exit codes (fatal / not running / stale / ok)', (t) => {
  const st = path.join(TMP, 'hc-state'); fs.mkdirSync(st, { recursive: true });
  const env = { STATE_DIR: st };
  fs.writeFileSync(path.join(st, 'STATUS'), 'EXPIRED_-14\n');
  let r = runNode(['bin/healthcheck.js'], env);
  assert.strictEqual(r.status, 2); assert.match(r.stdout, /UNHEALTHY EXPIRED_-14: .*login/);
  fs.writeFileSync(path.join(st, 'STATUS'), 'STOPPED\n');
  r = runNode(['bin/healthcheck.js'], env);
  assert.strictEqual(r.status, 1); assert.match(r.stdout, /not running/);
  fs.writeFileSync(path.join(st, 'STATUS'), 'RUNNING\n');
  const fakeBridge = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'bin/bridge.js'], { stdio: 'ignore' }); // cmdline ends in bin/bridge.js
  t.after(() => fakeBridge.kill());
  fs.writeFileSync(path.join(st, 'bridge.pid'), `${process.pid}\n`); // alive, but not a bridge: a reused PID
  r = runNode(['bin/healthcheck.js'], env);
  assert.strictEqual(r.status, 1, 'a PID reused by another program is not the bridge');
  fs.writeFileSync(path.join(st, 'bridge.pid'), `${fakeBridge.pid}\n`);
  fs.writeFileSync(path.join(st, 'HEARTBEAT'), `${Date.now() - 600_000}\n`);
  r = runNode(['bin/healthcheck.js'], env);
  assert.strictEqual(r.status, 3); assert.match(r.stdout, /no successful activity for 600s/);
  fs.writeFileSync(path.join(st, 'HEARTBEAT'), `${Date.now()}\n`);
  r = runNode(['bin/healthcheck.js'], env);
  assert.strictEqual(r.status, 0); assert.match(r.stdout, /^HEALTHY/);
  r = runNode(['bin/healthcheck.js', '--status'], env);
  assert.strictEqual(r.status, 0); assert.match(r.stdout, /protection: +off/); assert.match(r.stdout, /mirror: +true/);
  r = runNode(['bin/healthcheck.js', '--status'], { ...env, OWNER_PROTECTION: 'on' });
  assert.match(r.stdout, /protection: +on; owner not bound yet/);
});

test('outbound-only: no server or listening socket in the code', () => {
  const files = [...fs.readdirSync(path.join(ROOT, 'src')).map((f) => path.join('src', f)), ...fs.readdirSync(path.join(ROOT, 'bin')).map((f) => path.join('bin', f))];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/createServer|\.listen\(|require\(['"](node:)?(http|net|dgram)['"]\)/.test(src), f);
  }
});

test('end-to-end: bridge forwards owner text, drops stranger, exits 14 on -14 (fake fetch)', () => {
  const st = path.join(TMP, 'e2e-state'); const lg = path.join(TMP, 'e2e-logs'); fs.mkdirSync(st, { recursive: true });
  fs.writeFileSync(path.join(st, 'credentials.json'), JSON.stringify({ bot_token: 'fake-token', ilink_bot_id: 'fake@im.bot', baseurl: 'https://ilink.example', login_user_id: OWNER }), { mode: 0o600 });
  const dump = path.join(TMP, 'e2e-dump.json');
  const script = [
    { ret: 0, get_updates_buf: 'CUR1', msgs: [textMsg('10', OWNER, 'ping'), textMsg('11', STRANGER, 'intruder')] },
    { ret: -14, errcode: -14 },
  ];
  const r = runNode(['-r', path.join(__dirname, 'fake-fetch-preload.js'), 'bin/bridge.js'], {
    STATE_DIR: st, LOG_DIR: lg, FAKE_SCRIPT: JSON.stringify(script), FAKE_DUMP: dump,
    FORWARD_WEBHOOK_URL: 'https://hooks.example.com/in', FORWARD_WEBHOOK_AUTH: 'Bearer fake-key', MIRROR_TO_MAIN_CHAT: 'false', OWNER_PROTECTION: 'on' });
  assert.strictEqual(r.status, 14, r.stderr);
  const calls = JSON.parse(fs.readFileSync(dump, 'utf8'));
  const hooks = calls.filter((c) => c.kind === 'webhook');
  assert.strictEqual(hooks.length, 1);
  assert.strictEqual(hooks[0].headers.Authorization, 'Bearer fake-key');
  assert.deepStrictEqual({ ...hooks[0].body, received_at: 'x', handling_hint: 'x' }, { source: 'wechat', sender_id: OWNER, message_id: '10', text: 'ping',
    truncated: false, received_at: 'x', untrusted: true, mirror: false, handling_hint: 'x' });
  assert.strictEqual(fs.readFileSync(path.join(st, 'STATUS'), 'utf8').trim(), 'EXPIRED_-14');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(st, 'sync.json'), 'utf8')), { get_updates_buf: 'CUR1' });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(st, 'stats.json'), 'utf8')).dropped_not_owner, 1);
  const log = fs.readFileSync(path.join(lg, 'bridge.log'), 'utf8');
  for (const s of ['fake-token', 'fake-key', 'hooks.example.com', 'ping', 'intruder', OWNER]) assert.ok(!log.includes(s), `log leaks ${s}`);
  assert.strictEqual(fs.statSync(st).mode & 0o777, 0o700);
  for (const f of fs.readdirSync(st)) assert.strictEqual(fs.statSync(path.join(st, f)).mode & 0o777, 0o600, f);
});

test('login: QR fallback link printed, redirect followed, credentials saved (mode 600), old binding reset, no token printed', () => {
  const st = path.join(TMP, 'login-state'); fs.mkdirSync(st, { recursive: true });
  fs.writeFileSync(path.join(st, 'owner.json'), JSON.stringify({ owner_id: 'previous-owner' }));
  fs.writeFileSync(path.join(st, 'STATUS'), 'EXPIRED_-14\n');
  const r = runNode(['-r', path.join(__dirname, 'fake-login-preload.js'), 'bin/login.js'], { STATE_DIR: st });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /open this link inside WeChat:\nhttps:\/\/liteapp\.example\.com\/q\/abc\?bot_type=3/);
  for (const w of ['QR_READY (1/3)', 'REDIRECT', 'SCANNED', 'CONFIRMED']) assert.ok(r.stdout.includes(w), w);
  assert.ok(!r.stdout.includes('fake-bot-token') && !r.stdout.includes('QR-ID'));
  const creds = JSON.parse(fs.readFileSync(path.join(st, 'credentials.json'), 'utf8'));
  assert.strictEqual(creds.bot_token, 'fake-bot-token');
  assert.strictEqual(creds.login_user_id, 'scanner@im.wechat');
  assert.strictEqual(fs.statSync(path.join(st, 'credentials.json')).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(st, 'owner.json')) && !fs.existsSync(path.join(st, 'STATUS')));
  assert.ok(!fs.existsSync(path.join(st, 'qr-link.txt')), 'QR artifacts cleaned up');
  assert.strictEqual(fs.readFileSync(path.join(st, 'LOGIN_STATE'), 'utf8').trim(), 'CONFIRMED');
});

test('forwarded counter only counts webhook successes; failures count as undelivered', async () => {
  const guard = createGuard({ protection: false, ownerStore: memOwner(null) });
  let ok = false;
  const deps = { guard, seen: new Set(), forward: async () => ok };
  const msg = (id) => ({ message_type: 1, from_user_id: 'u@im.wechat', message_id: id, item_list: [{ type: 1, text_item: { text: 'hi' } }] });
  let r = await handleMessages([msg('a')], deps);
  assert.strictEqual(r.undelivered, 1);
  assert.strictEqual(guard.stats.forwarded, 0);
  assert.strictEqual(guard.stats.undelivered, 1);
  ok = true;
  r = await handleMessages([msg('b')], deps);
  assert.strictEqual(r.forwarded, 1);
  assert.strictEqual(guard.stats.forwarded, 1);
});
