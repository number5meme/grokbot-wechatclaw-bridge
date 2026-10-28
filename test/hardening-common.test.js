'use strict';
// Tests for the shared hardening code (kept identical in the sibling project grokbot-qqbot-bridge). No network, no TTY.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseDotEnv, quoteEnvValue } = require('../src/env');
const { stripMarkdown, splitText, buildChunks, safeSlice } = require('../src/text');
const { createGuard } = require('../src/guard');
const { postWebhook, drainCapped, MAX_RESPONSE_BYTES } = require('../src/webhook');
const { createMediaStore, fetchLimited } = require('../src/media-store');
const { parseCommon, hostAllowed, DEFAULT_MEDIA_HOSTS } = require('../src/config-common');
const { runSetup, COMMON_QUESTIONS, renderEnv } = require('../src/setup-common');
const { recipientProblem, checkSendablePath } = require('../src/outbound');
const { replayUndelivered } = require('../src/replay');
const F = require('../src/files');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hardening-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const memOwner = (v = null) => ({ get: () => v, set: (x) => { v = x; } });
const lone = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

/* ---- #10 .env quoting round-trip ---- */
test('env: quoteEnvValue output parses back to the same value', () => {
  const values = ['plain', 'Bearer abc.def-123', 'has space', 'with "quotes"', 'back\\slash', 'hash # not comment', 'a=b&c',
    "single 'q'", 'tab\there', 'line1\nline2', '', 'trailing\\', '$HOME `x`'];
  const text = values.map((v, i) => `K${i}=${quoteEnvValue(v)}`).join('\n');
  const parsed = parseDotEnv(text);
  values.forEach((v, i) => assert.strictEqual(parsed[`K${i}`], v, JSON.stringify(v)));
  assert.strictEqual(quoteEnvValue('https://x.example/a'), 'https://x.example/a', 'URLs stay unquoted');
  const p = parseDotEnv('A="x" # comment\nB=y # comment\nC=\'lit\\n\'\nD="q\\"x"');
  assert.deepStrictEqual([p.A, p.B, p.C, p.D], ['x', 'y', 'lit\\n', 'q"x']);
});

/* ---- #18 stripMarkdown keeps lone asterisks ---- */
test('stripMarkdown: emphasis removed, arithmetic and globs keep their asterisks', () => {
  assert.strictEqual(stripMarkdown('2*3*4 = 24'), '2*3*4 = 24');
  assert.strictEqual(stripMarkdown('a * b * c'), 'a * b * c');
  assert.strictEqual(stripMarkdown('*.txt and *x*'), '*.txt and x');
  assert.strictEqual(stripMarkdown('**bold** and *it*'), 'bold and it');
});

/* ---- #20 surrogate pairs ---- */
test('text: splitting and truncation never cut a surrogate pair', () => {
  const s = '\u{1F600}'.repeat(30); // 60 UTF-16 units, no spaces
  for (const max of [3, 5, 7, 11]) {
    const parts = splitText(s, max);
    assert.strictEqual(parts.join(''), s);
    for (const p of parts) assert.ok(!lone(p), `lone surrogate at max=${max}`);
  }
  assert.strictEqual(safeSlice('ab\u{1F600}', 3), 'ab');
  const chunks = buildChunks('x' + '\u{1F600}'.repeat(50), { chunkSize: 9, maxChunks: 2 });
  for (const c of chunks) assert.ok(!lone(c));
  const g = createGuard({ protection: false, ownerStore: memOwner(), maxChars: 3 });
  const d = g.check('u', 'a\u{1F600}b');
  assert.ok(d.truncated && !lone(d.text));
});

/* ---- #3 global rate limit ---- */
test('guard: global rate limit applies in both modes and counts as rate limited; untrusted logic unchanged', () => {
  let t = 0;
  for (const protection of [false, true]) {
    const g = createGuard({ protection, ownerStore: memOwner('o'), allowlist: ['a', 'b'], rateLimitPerMin: 0, globalRateLimitPerMin: 2, now: () => t });
    const ids = ['o', 'a', 'b'];
    const res = ids.map((id) => g.check(id, 'hi'));
    assert.deepStrictEqual(res.map((r) => r.forward), [true, true, false]);
    assert.strictEqual(res[2].reason, 'rate_limited');
    assert.strictEqual(g.stats.dropped_rate_limited, 1);
    assert.strictEqual(res[0].untrusted, protection, 'protection off => untrusted false (unchanged, by design)');
    t += 61_000;
    assert.strictEqual(g.check('o', 'again').forward, true, 'window slides');
  }
  const g = createGuard({ protection: false, ownerStore: memOwner() });
  g.recordOverload();
  assert.strictEqual(g.stats.dropped_overload, 1);
  const { cfg } = parseCommon({}, { root: TMP, requireWebhook: false });
  assert.strictEqual(cfg.globalRateLimitPerMin, 60);
  assert.deepStrictEqual(parseCommon({ GLOBAL_RATE_LIMIT_PER_MIN: 'x' }, { root: TMP, requireWebhook: false }).errors.length, 1);
});

/* ---- #21 webhook redirects and capped body ---- */
test('webhook: redirects are not followed and not retried; response body read is capped', async () => {
  const calls = [];
  const logs = [];
  const f = async (url, opts) => { calls.push(opts); return { ok: false, status: 302, headers: new Headers({ location: 'https://evil.example/' }), text: async () => '' }; };
  const ok = await postWebhook({ a: 1 }, { url: 'https://hook.example/in', fetchImpl: f, sleep: async () => {}, logFn: (m) => logs.push(m) });
  assert.strictEqual(ok, false);
  assert.strictEqual(calls.length, 1, 'a redirect is a final failure');
  assert.strictEqual(calls[0].redirect, 'manual');
  assert.ok(logs.some((l) => /redirects are not followed/.test(l)));
  let pulled = 0; let cancelled = false;
  const body = new ReadableStream({
    pull(c) { pulled += 16384; c.enqueue(new Uint8Array(16384)); if (pulled > 10 * 1024 * 1024) c.close(); },
    cancel() { cancelled = true; },
  });
  await drainCapped({ body });
  assert.ok(cancelled, 'stream cancelled after the cap');
  assert.ok(pulled <= MAX_RESPONSE_BYTES + 3 * 16384, `read ${pulled} bytes`);
});

/* ---- #7 media host allowlist and redirects ---- */
test('fetchLimited: host allowlist, manual redirects checked per hop, redirect limit', async () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex');
  const routes = {
    'https://cdn.qpic.cn/a': { status: 302, location: 'https://cdn2.qq.com/b' },
    'https://cdn2.qq.com/b': { status: 200, body: PNG },
    'https://cdn.qpic.cn/evil': { status: 302, location: 'https://169.254.169.254/latest' },
    'https://cdn.qpic.cn/http': { status: 301, location: 'http://cdn.qpic.cn/x' },
    'https://cdn.qpic.cn/loop': { status: 302, location: '/loop' },
  };
  const seen = [];
  const f = async (url, opts) => {
    seen.push(url); assert.strictEqual(opts.redirect, 'manual');
    const r = routes[url] || { status: 404 };
    return { ok: r.status === 200, status: r.status, headers: new Headers(r.location ? { location: r.location } : {}),
      arrayBuffer: async () => (r.body || Buffer.alloc(0)), text: async () => '' };
  };
  assert.ok((await fetchLimited('https://cdn.qpic.cn/a', { fetchImpl: f })).equals(PNG));
  await assert.rejects(fetchLimited('https://cdn.qpic.cn/evil', { fetchImpl: f }), (e) => e.label === 'HOST_NOT_ALLOWED');
  assert.ok(!seen.some((u) => u.includes('169.254')), 'the disallowed hop is never requested');
  await assert.rejects(fetchLimited('https://cdn.qpic.cn/http', { fetchImpl: f }), (e) => e.label === 'NOT_HTTPS');
  await assert.rejects(fetchLimited('https://cdn.qpic.cn/loop', { fetchImpl: f }), (e) => e.label === 'TOO_MANY_REDIRECTS');
  await assert.rejects(fetchLimited('https://attacker.example/x', { fetchImpl: f }), (e) => e.label === 'HOST_NOT_ALLOWED');
  await assert.rejects(fetchLimited('https://qq.com.attacker.example/x', { fetchImpl: f }), (e) => e.label === 'HOST_NOT_ALLOWED');
  assert.strictEqual(hostAllowed('multimedia.nt.qq.com.cn', DEFAULT_MEDIA_HOSTS), true);
  assert.strictEqual(hostAllowed('novac2c.cdn.weixin.qq.com', DEFAULT_MEDIA_HOSTS), true);
  assert.strictEqual(hostAllowed('evilqq.com', DEFAULT_MEDIA_HOSTS), false);
  const { cfg, errors } = parseCommon({ MEDIA_ALLOWED_HOSTS: 'cdn.example.com' }, { root: TMP, requireWebhook: false });
  assert.deepStrictEqual(errors, []); assert.ok(cfg.mediaAllowedHosts.includes('cdn.example.com') && cfg.mediaAllowedHosts.includes('qq.com'));
  assert.strictEqual(parseCommon({ MEDIA_ALLOWED_HOSTS: 'http://x' }, { root: TMP, requireWebhook: false }).errors.length, 1);
});

/* ---- #17 cleanup only touches files the store created ---- */
test('media cleanup: removes old generated files only; foreign files are kept', () => {
  const dir = path.join(TMP, 'media-clean'); fs.mkdirSync(dir);
  const t = Date.now();
  const s = createMediaStore({ dir, retentionDays: 1, now: () => t - 3 * 86_400_000 });
  const saved = s.save(Buffer.from('hello'), { kind: 'file', filename: 'a.txt' });
  const foreign = path.join(dir, 'notes.txt'); fs.writeFileSync(foreign, 'x');
  const old = new Date(t - 3 * 86_400_000);
  for (const p of [saved.path, foreign]) fs.utimesSync(p, old, old);
  const s2 = createMediaStore({ dir, retentionDays: 1 });
  assert.strictEqual(s2.cleanup(), 1);
  assert.ok(!fs.existsSync(saved.path) && fs.existsSync(foreign));
});

/* ---- #19 / #4 setup: OWNER_ID question, trusted note, atomic write ---- */
test('setup: OWNER_ID asked only with protection on; off help says senders are trusted; atomic 600 write with .bak', async () => {
  const { Readable, Writable } = require('node:stream');
  const qs = COMMON_QUESTIONS;
  assert.match(qs.find((q) => q.key === 'OWNER_PROTECTION').help, /untrusted": false/);
  assert.strictEqual(qs.find((q) => q.key === 'OWNER_PROTECTION').dflt, 'off', 'default unchanged');
  assert.match(qs.find((q) => q.key === 'OWNER_ID').help, /first account/);
  const run = async (lines, file) => {
    let out = '';
    const output = new Writable({ write(c, e, cb) { out += c; cb(); } });
    const answers = await runSetup({ questions: qs, file, input: Readable.from([lines.join('\n') + '\n']), output, terminal: false });
    return { answers, out };
  };
  const file = path.join(TMP, 'setup.env');
  let r = await run(['https://hook.example/in', '', 'off', 'true', 'true'], file);
  assert.ok(!/OWNER_ID:/.test(r.out), 'OWNER_ID not asked when protection is off');
  assert.ok(!('OWNER_ID' in r.answers));
  fs.writeFileSync(file, 'OLD=1\n');
  r = await run(['https://hook.example/in', 'Bearer a "b" #c', 'on', 'owner-123', 'false', 'true'], file);
  assert.match(r.out, /OWNER_ID:/);
  const env = parseDotEnv(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual([env.OWNER_PROTECTION, env.OWNER_ID, env.FORWARD_WEBHOOK_AUTH], ['on', 'owner-123', 'Bearer a "b" #c']);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(fs.readFileSync(`${file}.bak`, 'utf8'), 'OLD=1\n');
  assert.strictEqual(fs.statSync(`${file}.bak`).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(TMP).filter((n) => n.startsWith('setup.env') && !/^setup\.env(\.bak)?$/.test(n)), [], 'no temp files left');
  assert.match(renderEnv({ OWNER_ID: 'x y' }, [{ key: 'OWNER_ID' }]), /OWNER_ID="x y"/);
});

/* ---- #2 / #5 recipients ---- */
test('recipientProblem: ids accepted; empty, option-like and shell fragments rejected', () => {
  for (const ok of ['o_ABC123', 'abc@im.wechat', 'E5F0A1B2C3D4E5F6A7B8C9D0E1F2A3B4', 'a.b:c=d-e']) assert.strictEqual(recipientProblem(ok), null, ok);
  assert.strictEqual(recipientProblem(''), 'empty');
  assert.strictEqual(recipientProblem('--image'), 'looks like an option');
  for (const bad of ['a b', 'a;rm', '$(id)', 'x`y`', 'a\nb', 'x'.repeat(129)]) assert.ok(recipientProblem(bad), bad);
});

/* ---- #8 outbound file checks ---- */
test('checkSendablePath: secrets, state, internals and system paths refused; media and normal files allowed', () => {
  const root = path.join(TMP, 'bridge'); const st = path.join(root, 'state'); const md = path.join(st, 'media');
  for (const d of [md, path.join(root, 'logs'), path.join(TMP, 'proj', '.ssh'), path.join(TMP, 'out')]) fs.mkdirSync(d, { recursive: true });
  const mk = (p) => { fs.writeFileSync(p, 'x'); return p; };
  const opts = { root, stateDir: st, mediaDir: md };
  const refused = [mk(path.join(root, '.env')), mk(path.join(TMP, 'prod.env')), mk(path.join(TMP, '.env.local')), mk(path.join(st, 'credentials.json')),
    mk(path.join(root, 'logs', 'bridge.log')), mk(path.join(TMP, 'proj', '.ssh', 'config')), mk(path.join(TMP, 'id_ed25519')),
    mk(path.join(TMP, 'server.pem')), '/etc/passwd', '/proc/self/environ'];
  for (const p of refused) assert.throws(() => checkSendablePath(p, opts), (e) => e.label === 'FILE_NOT_ALLOWED', p);
  const link = path.join(TMP, 'out', 'innocent.png'); fs.symlinkSync(path.join(root, '.env'), link);
  assert.throws(() => checkSendablePath(link, opts), (e) => e.label === 'FILE_NOT_ALLOWED', 'symlinks are resolved');
  const ok = [mk(path.join(md, 'pic.png')), mk(path.join(TMP, 'out', 'report.pdf'))];
  for (const p of ok) assert.doesNotThrow(() => checkSendablePath(p, opts), p);
  assert.throws(() => checkSendablePath(ok[1], { ...opts, allowedDirs: [md] }), /REPLY_ALLOWED_DIRS/);
  assert.doesNotThrow(() => checkSendablePath(ok[1], { ...opts, allowedDirs: [path.join(TMP, 'out')] }));
  const { cfg } = parseCommon({ REPLY_ALLOWED_DIRS: 'out:/srv/files,x' }, { root: TMP, requireWebhook: false });
  assert.deepStrictEqual(cfg.replyAllowedDirs, [path.join(TMP, 'out'), '/srv/files', path.join(TMP, 'x')]);
});

/* ---- replay (README curl snippet replaced) ---- */
test('replayUndelivered: sends .1 then main file, re-appends failures, keeps invalid lines aside', async () => {
  const file = path.join(TMP, 'undelivered.jsonl');
  fs.writeFileSync(`${file}.1`, JSON.stringify({ n: 1 }) + '\n');
  fs.writeFileSync(file, [JSON.stringify({ n: 2 }), 'not json', JSON.stringify({ n: 3, fail: true })].join('\n') + '\n');
  const order = [];
  const r = await replayUndelivered(file, async (p) => { order.push(p.n); return !p.fail; });
  assert.deepStrictEqual(r, { sent: 2, failed: 1, invalid: 1 });
  assert.deepStrictEqual(order, [1, 2, 3]);
  assert.deepStrictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).n), [3]);
  assert.strictEqual(fs.readFileSync(`${file}.invalid`, 'utf8'), 'not json\n');
  assert.ok(!fs.existsSync(`${file}.1`));
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  // an interrupted replay (left-over .replay) is picked up first
  fs.writeFileSync(`${file}.replay`, JSON.stringify({ n: 0 }) + '\n'); fs.unlinkSync(file);
  order.length = 0;
  assert.deepStrictEqual(await replayUndelivered(file, async (p) => { order.push(p.n); return true; }), { sent: 1, failed: 0, invalid: 0 });
  assert.deepStrictEqual(order, [0]);
});

/* ---- #28 bounded logs / appends, #23 atomic writes ---- */
test('files: logger and appendSecure rotate at the cap; writeSecure is atomic and private', () => {
  const log = path.join(TMP, 'rot', 'bridge.log');
  const logger = F.makeLogger(log, { maxBytes: 200 });
  for (let i = 0; i < 20; i++) logger(`line ${i} ${'x'.repeat(20)}`);
  assert.ok(fs.statSync(log).size <= 260 && fs.existsSync(`${log}.1`));
  for (let i = 0; i < 2; i++) logger('errmsg with\nnew line'); // one record per line
  const last = fs.readFileSync(log, 'utf8').trim().split('\n').pop();
  assert.match(last, /errmsg with/);
  const u = path.join(TMP, 'rot', 'u.jsonl');
  for (let i = 0; i < 10; i++) F.appendSecure(u, 'y'.repeat(50) + '\n', { maxBytes: 120 });
  assert.ok(fs.statSync(u).size <= 153 && fs.existsSync(`${u}.1`));
  const w = path.join(TMP, 'rot', 'w.json');
  F.writeSecure(w, 'a'); F.writeSecure(w, 'b');
  assert.strictEqual(fs.readFileSync(w, 'utf8'), 'b');
  assert.strictEqual(fs.statSync(w).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(path.join(TMP, 'rot')).filter((n) => n.includes('.tmp')), []);
});

/* ---- #11 / #12 PID checks and single instance ---- */
test('pidRuns / acquirePidLock: a reused PID is not the bridge; a live bridge blocks a second one', async (t) => {
  const fake = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'bin/bridge.js'], { stdio: 'ignore' });
  t.after(() => fake.kill());
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(F.pidRuns(fake.pid), true);
  assert.strictEqual(F.pidRuns(process.pid), false, 'the test runner is alive but is not a bridge');
  assert.strictEqual(F.pidRuns(0), false);
  const pidFile = path.join(TMP, 'lock', 'bridge.pid');
  fs.mkdirSync(path.dirname(pidFile));
  fs.writeFileSync(pidFile, `${process.pid}\n`); // stale: reused by another program
  assert.deepStrictEqual(F.acquirePidLock(pidFile, { pid: 4242 }), { ok: true, pid: 4242 });
  fs.writeFileSync(pidFile, `${fake.pid}\n`);
  assert.deepStrictEqual(F.acquirePidLock(pidFile, { pid: 4243 }), { ok: false, pid: fake.pid });
});

/* ---- #16 reply lock ---- */
test('withFileLock: callers run one at a time; a dead holder is broken; timeout is labeled', async () => {
  const lock = path.join(TMP, 'lk', 'reply.lock');
  let active = 0; let maxActive = 0;
  const job = () => F.withFileLock(lock, async () => { active++; maxActive = Math.max(maxActive, active); await F.sleep(30); active--; }, { pollMs: 5 });
  await Promise.all([job(), job(), job()]);
  assert.strictEqual(maxActive, 1);
  assert.ok(!fs.existsSync(lock));
  fs.writeFileSync(lock, '999999\n'); // holder that does not exist
  assert.strictEqual(await F.withFileLock(lock, async () => 'ran', { pollMs: 5 }), 'ran');
  fs.writeFileSync(lock, `${process.pid}\n`); // held by a live process
  await assert.rejects(F.withFileLock(lock, async () => {}, { timeoutMs: 50, pollMs: 5 }), (e) => e.label === 'LOCK_TIMEOUT');
  fs.unlinkSync(lock);
});
