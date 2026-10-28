'use strict';
// Tests for the shared modules: config validation, sender protection, rate limiting, backoff,
// clock-jump detection, webhook forwarding, text helpers, health evaluation, .env parsing, setup.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { parseCommon } = require('../src/config-common');
const { createGuard, buildPayload, RateLimiter, HANDLING_HINT } = require('../src/guard');
const { Backoff } = require('../src/backoff');
const { ClockJumpDetector } = require('../src/clock');
const { postWebhook } = require('../src/webhook');
const { stripMarkdown, splitText, buildChunks, TRUNCATION_NOTE } = require('../src/text');
const { evaluateHealth, EXIT } = require('../src/health');
const { parseDotEnv } = require('../src/env');
const { renderEnv, normalizeBool, COMMON_QUESTIONS } = require('../src/setup-common');

const ROOT = path.join(__dirname, '..');
const OK_ENV = { FORWARD_WEBHOOK_URL: 'https://hooks.example.com/inbound' };

function memOwner(init = null) { let o = init; return { get: () => o, set: (id) => { o = id; }, peek: () => o }; }

/* ---------------- config validation ---------------- */
test('config: defaults (owner protection off, mirror true)', () => {
  const { cfg, errors } = parseCommon(OK_ENV, { root: ROOT });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(cfg.protection, false, 'owner protection is off by default');
  assert.strictEqual(cfg.mirror, true, 'mirroring is on by default');
  assert.strictEqual(parseCommon({ ...OK_ENV, OWNER_PROTECTION: 'on' }, { root: ROOT }).cfg.protection, true);
  assert.strictEqual(parseCommon({ ...OK_ENV, OWNER_PROTECTION: '' }, { root: ROOT }).cfg.protection, false);
  assert.strictEqual(cfg.rateLimitPerMin, 20);
  assert.strictEqual(cfg.maxMessageChars, 4000);
  assert.strictEqual(cfg.webhookAuth, '');
  assert.deepStrictEqual(cfg.allowlist, []);
  assert.strictEqual(cfg.stateDir, path.join(ROOT, 'state'));
});

test('config: parses switches, lists and numbers', () => {
  const { cfg, errors } = parseCommon({ ...OK_ENV, OWNER_PROTECTION: 'off', MIRROR_TO_MAIN_CHAT: 'false', ALLOWLIST: ' a, b ,,c ',
    RATE_LIMIT_PER_MIN: '0', MAX_MESSAGE_CHARS: '100', FORWARD_WEBHOOK_AUTH: 'Bearer x', OWNER_ID: 'u1', STATE_DIR: '/tmp/s' }, { root: ROOT });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(cfg.protection, false);
  assert.strictEqual(cfg.mirror, false);
  assert.deepStrictEqual(cfg.allowlist, ['a', 'b', 'c']);
  assert.strictEqual(cfg.rateLimitPerMin, 0);
  assert.strictEqual(cfg.maxMessageChars, 100);
  assert.strictEqual(cfg.webhookAuth, 'Bearer x');
  assert.strictEqual(cfg.ownerId, 'u1');
  assert.strictEqual(cfg.stateDir, '/tmp/s');
  for (const v of ['on', 'true', '1', 'yes', 'ON']) assert.strictEqual(parseCommon({ ...OK_ENV, MIRROR_TO_MAIN_CHAT: v }, { root: ROOT }).cfg.mirror, true);
});

test('config: rejects invalid values with clear messages', () => {
  const bad = (env, re, opts = {}) => {
    const { errors } = parseCommon(env, { root: ROOT, ...opts });
    assert.ok(errors.some((e) => re.test(e)), `${JSON.stringify(env)} -> ${errors.join('; ')}`);
  };
  bad({}, /FORWARD_WEBHOOK_URL is required/);
  bad({ FORWARD_WEBHOOK_URL: 'not a url' }, /not a valid URL/);
  bad({ FORWARD_WEBHOOK_URL: 'ftp://x.example.com' }, /must be http/);
  bad({ FORWARD_WEBHOOK_URL: 'http://hooks.example.com/x' }, /must use https/);
  bad({ ...OK_ENV, OWNER_PROTECTION: 'maybe' }, /OWNER_PROTECTION/);
  bad({ ...OK_ENV, MIRROR_TO_MAIN_CHAT: 'sometimes' }, /MIRROR_TO_MAIN_CHAT/);
  bad({ ...OK_ENV, RATE_LIMIT_PER_MIN: '-1' }, /RATE_LIMIT_PER_MIN/);
  bad({ ...OK_ENV, MAX_MESSAGE_CHARS: 'lots' }, /MAX_MESSAGE_CHARS/);
  bad({ ...OK_ENV, HEALTH_STALE_SECONDS: '5' }, /HEALTH_STALE_SECONDS/);
  bad({ ...OK_ENV, FORWARD_WEBHOOK_AUTH: 'a\nb' }, /single line/);
  // allowed variants
  assert.deepStrictEqual(parseCommon({ FORWARD_WEBHOOK_URL: 'http://localhost:8080/hook' }, { root: ROOT }).errors, []);
  assert.deepStrictEqual(parseCommon({ FORWARD_WEBHOOK_URL: 'http://10.0.0.5/hook', FORWARD_ALLOW_INSECURE_HTTP: '1' }, { root: ROOT }).errors, []);
  assert.deepStrictEqual(parseCommon({}, { root: ROOT, requireWebhook: false }).errors, []);
});

/* ---------------- sender protection ---------------- */
test('guard (protection on): binds first sender, drops others silently and counts them', () => {
  const owner = memOwner(); const logs = []; let saved = null;
  const g = createGuard({ protection: true, ownerStore: owner, logFn: (m) => logs.push(m), statsStore: { load: () => null, save: (s) => { saved = { ...s }; } } });
  const a = g.check('owner-1', 'hello');
  assert.deepStrictEqual(a, { forward: true, reason: 'ok', text: 'hello', truncated: false, untrusted: true });
  assert.strictEqual(owner.peek(), 'owner-1');
  assert.ok(logs.some((l) => l.startsWith('OWNER_BOUND')));
  assert.ok(!logs.join('\n').includes('owner-1'), 'full sender id is not logged');
  assert.deepStrictEqual(g.check('stranger', 'hi'), { forward: false, reason: 'not_owner' });
  assert.deepStrictEqual(g.check('stranger', 'hi again'), { forward: false, reason: 'not_owner' });
  assert.strictEqual(owner.peek(), 'owner-1', 'binding is not changed by other senders');
  assert.strictEqual(g.stats.dropped_not_owner, 2);
  assert.strictEqual(g.stats.forwarded, 0, 'check alone does not count as forwarded');
  g.recordDelivery(true); g.recordDelivery(false);
  assert.strictEqual(g.stats.forwarded, 1);
  assert.strictEqual(g.stats.undelivered, 1);
  assert.strictEqual(saved.dropped_not_owner, 2);
  assert.ok(!logs.join('\n').includes('hi again'), 'dropped content is not logged');
  assert.deepStrictEqual(g.check('', 'x'), { forward: false, reason: 'invalid' });
});

test('guard (protection on): explicit OWNER_ID wins and allowlist admits extra senders', () => {
  const owner = memOwner('someone-else');
  const g = createGuard({ protection: true, explicitOwner: 'boss', ownerStore: owner, allowlist: ['friend'] });
  assert.strictEqual(g.check('boss', 'a').forward, true);
  assert.strictEqual(g.check('friend', 'b').forward, true);
  assert.strictEqual(g.check('friend', 'b').untrusted, true);
  assert.strictEqual(g.check('someone-else', 'c').reason, 'not_owner');
  assert.strictEqual(owner.peek(), 'someone-else', 'store untouched when OWNER_ID is set');
});

test('guard (protection off): no binding, everything forwarded, untrusted false, no rate limit', () => {
  const owner = memOwner();
  const g = createGuard({ protection: false, ownerStore: owner, rateLimitPerMin: 1 });
  for (const s of ['a', 'b', 'c', 'a', 'a']) {
    assert.deepStrictEqual(g.check(s, 'x'), { forward: true, reason: 'ok', text: 'x', truncated: false, untrusted: false });
  }
  assert.strictEqual(owner.peek(), null, 'no owner binding when protection is off');
  assert.strictEqual(g.stats.dropped_not_owner, 0);
});

test('guard: per-sender rate limiting (protection on)', () => {
  let t = 0;
  const g = createGuard({ protection: true, ownerStore: memOwner('o'), allowlist: ['f'], rateLimitPerMin: 3, now: () => t });
  const r = [];
  for (let i = 0; i < 5; i++) r.push(g.check('o', 'm').reason);
  assert.deepStrictEqual(r, ['ok', 'ok', 'ok', 'rate_limited', 'rate_limited']);
  assert.strictEqual(g.check('f', 'm').reason, 'ok', 'limits are per sender');
  assert.strictEqual(g.stats.dropped_rate_limited, 2);
  t += 61_000;
  assert.strictEqual(g.check('o', 'm').reason, 'ok', 'window slides');
});

test('guard: max message length truncates in both modes', () => {
  for (const protection of [true, false]) {
    const g = createGuard({ protection, ownerStore: memOwner('o'), maxChars: 5 });
    const d = g.check('o', '1234567890');
    assert.strictEqual(d.text, '12345'); assert.strictEqual(d.truncated, true);
    assert.strictEqual(g.stats.truncated, 1);
  }
  const g0 = createGuard({ protection: true, ownerStore: memOwner('o'), maxChars: 0 });
  assert.strictEqual(g0.check('o', 'x'.repeat(10000)).truncated, false);
});

test('RateLimiter: limit 0 disables; key map is bounded', () => {
  const off = new RateLimiter({ limit: 0 });
  for (let i = 0; i < 100; i++) assert.ok(off.allow('k'));
  const rl = new RateLimiter({ limit: 1, maxKeys: 10 });
  for (let i = 0; i < 50; i++) rl.allow('k' + i);
  assert.ok(rl.hits.size <= 10);
});

test('buildPayload: sender id, untrusted + handling_hint, mirror flag', () => {
  const at = new Date('2026-01-02T03:04:05Z');
  const p = buildPayload({ source: 'test', senderId: 'u1', messageId: 7, text: 'hi', untrusted: true, mirror: true, receivedAt: at });
  assert.deepStrictEqual(p, { source: 'test', sender_id: 'u1', message_id: '7', text: 'hi', truncated: false,
    received_at: '2026-01-02T03:04:05.000Z', untrusted: true, mirror: true, handling_hint: HANDLING_HINT });
  const q = buildPayload({ source: 'test', senderId: 'u2', messageId: 'm', text: 'yo', truncated: true, untrusted: false, mirror: false, receivedAt: at });
  assert.strictEqual(q.untrusted, false); assert.strictEqual(q.mirror, false); assert.strictEqual(q.truncated, true);
  assert.ok(!('handling_hint' in q));
  assert.ok(!('sender_binding' in p) && !('sender_binding' in q));
  assert.match(HANDLING_HINT, /untrusted/); assert.match(HANDLING_HINT, /credentials/);
});

/* ---------------- backoff / clock ---------------- */
test('Backoff: exponential, capped, jittered, resettable', () => {
  const b = new Backoff({ baseMs: 1000, maxMs: 8000, random: () => 0 });
  assert.deepStrictEqual([1, 2, 3, 4, 5].map(() => b.next()), [1000, 2000, 4000, 8000, 8000]);
  b.reset(); assert.strictEqual(b.next(), 1000);
  const j = new Backoff({ baseMs: 1000, maxMs: 60000, jitter: 0.3, random: () => 1 });
  assert.strictEqual(j.next(), 700);
  const r = new Backoff({ baseMs: 1000, maxMs: 60000 });
  for (let i = 0; i < 20; i++) { const d = r.next(); assert.ok(d >= 0 && d <= 60000); }
});

test('ClockJumpDetector: fires on forward and backward jumps, not on normal ticks', () => {
  let t = 0; const jumps = [];
  const d = new ClockJumpDetector({ intervalMs: 5000, thresholdMs: 30000, now: () => t, onJump: (x) => jumps.push(x) });
  d.last = 0;
  t = 5000; assert.strictEqual(d.tick(), 0);
  t = 10500; assert.strictEqual(d.tick(), 0); // small timer lag
  t = 10500 + 5000 + 3600_000; assert.strictEqual(d.tick(), 3600_000); // host slept for an hour
  t = t + 5000 - 120_000; assert.strictEqual(d.tick(), -120_000); // clock set back
  assert.deepStrictEqual(jumps, [3600_000, -120_000]);
  d.start(); d.stop();
});

/* ---------------- webhook ---------------- */
function fakeFetch(statuses, calls) {
  return async (url, opts) => { calls.push({ url, opts }); const s = statuses.shift(); if (s === 'throw') throw new TypeError('net'); return { ok: s < 300, status: s, text: async () => '' }; };
}
const noSleep = async () => {};

test('webhook: optional Authorization header, JSON body, retries 5xx/network, not 4xx', async () => {
  let calls = [];
  assert.strictEqual(await postWebhook({ a: 1 }, { url: 'https://h.example.com', auth: 'Bearer K', fetchImpl: fakeFetch([503, 'throw', 200], calls), sleep: noSleep }), true);
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer K');
  assert.strictEqual(calls[0].opts.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { a: 1 });
  calls = [];
  assert.strictEqual(await postWebhook({}, { url: 'https://h.example.com', fetchImpl: fakeFetch([200], calls), sleep: noSleep }), true);
  assert.ok(!('Authorization' in calls[0].opts.headers), 'no auth header when not configured');
  calls = [];
  assert.strictEqual(await postWebhook({}, { url: 'https://h.example.com', auth: 'X', fetchImpl: fakeFetch([401], calls), sleep: noSleep }), false);
  assert.strictEqual(calls.length, 1);
  calls = [];
  assert.strictEqual(await postWebhook({}, { url: 'https://h.example.com', fetchImpl: fakeFetch([429, 429, 429], calls), sleep: noSleep }), false);
  assert.strictEqual(calls.length, 3);
});

test('webhook: never logs URL or auth', async () => {
  const logs = [];
  await postWebhook({}, { url: 'https://secret-host.example.com/k=abc', auth: 'Bearer SECRET', fetchImpl: fakeFetch([500, 500, 500], []), sleep: noSleep, logFn: (m) => logs.push(m) });
  const all = logs.join('\n');
  assert.ok(!all.includes('secret-host') && !all.includes('SECRET') && !all.includes('abc'));
});

/* ---------------- text ---------------- */
test('stripMarkdown', () => {
  assert.strictEqual(stripMarkdown('**bold** and *italic* and `code`'), 'bold and italic and code');
  assert.strictEqual(stripMarkdown('# Title\n## Sub\nBody'), 'Title\nSub\nBody');
  assert.strictEqual(stripMarkdown('see [docs](https://a.example/x) now'), 'see docs https://a.example/x now');
  assert.strictEqual(stripMarkdown('```js\nconst a = 1;\n```'), 'const a = 1;');
  assert.strictEqual(stripMarkdown('* one\n* two'), '- one\n- two');
  assert.strictEqual(stripMarkdown('> quote\n---\n~~gone~~'), 'quote\n\ngone');
  assert.strictEqual(stripMarkdown('snake_case_name stays'), 'snake_case_name stays');
  assert.ok(!/[*`]/.test(stripMarkdown('***x*** **y** `z` ```q```')));
});

test('splitText / buildChunks', () => {
  const long = 'This is a sentence. '.repeat(150); // 3000 chars
  const parts = splitText(long, 2000);
  assert.strictEqual(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 2000));
  assert.strictEqual(parts.join(' ').replace(/\s+/g, ' '), long.trim());
  assert.deepStrictEqual(splitText('short', 2000), ['short']);
  const c = buildChunks('x'.repeat(30000), { chunkSize: 2000, maxChunks: 10 });
  assert.strictEqual(c.length, 10);
  assert.ok(c[9].endsWith(TRUNCATION_NOTE.trim()));
  assert.ok(c.every((p) => p.length <= 2000));
});

/* ---------------- health ---------------- */
test('evaluateHealth: exit codes and reasons', () => {
  const fatal = { BANNED: 'appeal on the platform' };
  const now = 1_000_000;
  assert.strictEqual(evaluateHealth({ pidAlive: true, status: 'RUNNING', heartbeatMs: now - 10_000, nowMs: now }, fatal).code, EXIT.OK);
  const nr = evaluateHealth({ pidAlive: false, status: 'STOPPED', nowMs: now }, fatal);
  assert.strictEqual(nr.code, EXIT.NOT_RUNNING); assert.match(nr.reason, /not running/);
  const f = evaluateHealth({ pidAlive: false, status: 'BANNED', nowMs: now }, fatal);
  assert.strictEqual(f.code, EXIT.NEEDS_ACTION); assert.match(f.reason, /BANNED: appeal/);
  const st = evaluateHealth({ pidAlive: true, status: 'DEGRADED', heartbeatMs: now - 400_000, nowMs: now, staleSeconds: 180, lastError: 'HTTP 502' }, fatal);
  assert.strictEqual(st.code, EXIT.STALE); assert.match(st.reason, /400s.*HTTP 502/);
  assert.strictEqual(evaluateHealth({ pidAlive: true, status: 'RUNNING', heartbeatMs: 0, nowMs: now }, fatal).code, EXIT.STALE);
});

/* ---------------- env / setup ---------------- */
test('parseDotEnv', () => {
  assert.deepStrictEqual(parseDotEnv('# c\nA=1\nexport B="two words"\nC=\'x#y\'\nD=val # comment\nbad line\n'), { A: '1', B: 'two words', C: 'x#y', D: 'val' });
});

test('setup: asks about protection and mirroring; renders .env', () => {
  const keys = COMMON_QUESTIONS.map((q) => q.key);
  for (const k of ['FORWARD_WEBHOOK_URL', 'FORWARD_WEBHOOK_AUTH', 'OWNER_PROTECTION', 'MIRROR_TO_MAIN_CHAT']) assert.ok(keys.includes(k), k);
  assert.match(COMMON_QUESTIONS.find((q) => q.key === 'MIRROR_TO_MAIN_CHAT').help, /main chat/);
  assert.strictEqual(COMMON_QUESTIONS.find((q) => q.key === 'OWNER_PROTECTION').dflt, 'off', 'setup still asks, default off');
  assert.strictEqual(COMMON_QUESTIONS.find((q) => q.key === 'MIRROR_TO_MAIN_CHAT').dflt, 'true');
  assert.strictEqual(normalizeBool('OWNER_PROTECTION', '', 'off'), 'off');
  assert.strictEqual(createGuard({ ownerStore: memOwner() }).protection, false, 'guard default matches config default');
  assert.strictEqual(normalizeBool('MIRROR_TO_MAIN_CHAT', '', 'true'), 'true');
  assert.strictEqual(normalizeBool('MIRROR_TO_MAIN_CHAT', 'n', 'true'), 'false');
  assert.strictEqual(normalizeBool('OWNER_PROTECTION', 'yes', 'on'), 'on');
  assert.strictEqual(normalizeBool('OWNER_PROTECTION', 'maybe', 'on'), null);
  const text = renderEnv({ FORWARD_WEBHOOK_URL: 'https://h.example.com/x', FORWARD_WEBHOOK_AUTH: 'Bearer abc def', OWNER_PROTECTION: 'on', MIRROR_TO_MAIN_CHAT: 'false' }, COMMON_QUESTIONS);
  const parsed = parseDotEnv(text);
  assert.deepStrictEqual(parsed, { FORWARD_WEBHOOK_URL: 'https://h.example.com/x', FORWARD_WEBHOOK_AUTH: 'Bearer abc def', OWNER_PROTECTION: 'on', MIRROR_TO_MAIN_CHAT: 'false' });
});

test('.env.example matches the defaults', () => {
  const ex = parseDotEnv(require('node:fs').readFileSync(path.join(ROOT, '.env.example'), 'utf8'));
  assert.strictEqual(ex.OWNER_PROTECTION, 'off');
  assert.strictEqual(ex.MIRROR_TO_MAIN_CHAT, 'true');
});

/* ---------------- inbound media: config, payload, store, download, SILK ---------------- */
const fs = require('node:fs');
const os = require('node:os');
const { createMediaStore, fetchLimited: fetchLimitedRaw, sniffMime, isSilk, safeName, mimeFromFilename } = require('../src/media-store');
const { silkToWav, pcmToWav, loadSilk } = require('../src/silk');

const MTMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-media-common-'));
test.after(() => fs.rmSync(MTMP, { recursive: true, force: true }));
/** Binary fake response: body Buffer, optional stream mode and headers. */
function binFetch(handler) {
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const spec = (await handler(String(url), calls.length)) || {};
    if (spec.throw) throw Object.assign(new Error('net'), { name: spec.throw });
    const status = spec.status || 200; const body = spec.body || Buffer.alloc(0); const hdr = spec.headers || {};
    const res = { ok: status < 300, status, headers: { get: (k) => (hdr[k.toLowerCase()] ?? null) },
      text: async () => body.toString(), arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
    if (spec.stream) {
      let sent = false;
      res.body = { getReader: () => ({ read: async () => { if (sent) return { done: true }; sent = true; return { done: false, value: new Uint8Array(body) }; }, cancel: async () => {} }) };
    }
    return res;
  };
  f.calls = calls;
  return f;
}

test('config: media defaults and validation', () => {
  const { cfg, errors } = parseCommon(OK_ENV, { root: ROOT });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(cfg.acceptMedia, true);
  assert.strictEqual(cfg.mediaDir, path.join(ROOT, 'state', 'media'));
  assert.strictEqual(cfg.mediaMaxBytes, 100 * 1024 * 1024);
  assert.strictEqual(cfg.mediaRetentionDays, 7);
  const c2 = parseCommon({ ...OK_ENV, ACCEPT_MEDIA: 'false', MEDIA_DIR: 'm', MEDIA_MAX_MB: '5', MEDIA_RETENTION_DAYS: '0', STATE_DIR: 's' }, { root: ROOT }).cfg;
  assert.deepStrictEqual([c2.acceptMedia, c2.mediaDir, c2.mediaMaxBytes, c2.mediaRetentionDays], [false, path.join(ROOT, 'm'), 5 * 1024 * 1024, 0]);
  assert.strictEqual(parseCommon({ ...OK_ENV, STATE_DIR: 's' }, { root: ROOT }).cfg.mediaDir, path.join(ROOT, 's', 'media'));
  const bad = parseCommon({ ...OK_ENV, ACCEPT_MEDIA: 'maybe', MEDIA_MAX_MB: '0', MEDIA_RETENTION_DAYS: '-1' }, { root: ROOT }).errors;
  assert.strictEqual(bad.length, 3);
});

test('config: FORWARD_MEDIA is a deprecated fallback for ACCEPT_MEDIA', () => {
  assert.strictEqual(parseCommon({ ...OK_ENV, FORWARD_MEDIA: 'false' }, { root: ROOT }).cfg.acceptMedia, false);
  assert.strictEqual(parseCommon({ ...OK_ENV, ACCEPT_MEDIA: 'true', FORWARD_MEDIA: 'false' }, { root: ROOT }).cfg.acceptMedia, true);
  assert.strictEqual(parseCommon({ ...OK_ENV, ACCEPT_MEDIA: 'false', FORWARD_MEDIA: 'true' }, { root: ROOT }).cfg.acceptMedia, false);
  assert.match(parseCommon({ ...OK_ENV, FORWARD_MEDIA: 'maybe' }, { root: ROOT }).errors.join(), /FORWARD_MEDIA/);
});

test('setup: asks about ACCEPT_MEDIA (bool, default true) and renders it', () => {
  const q = COMMON_QUESTIONS.find((x) => x.key === 'ACCEPT_MEDIA');
  assert.ok(q);
  assert.strictEqual(q.type, 'bool');
  assert.strictEqual(q.dflt, 'true');
  assert.match(q.help, /other than text/);
  assert.match(q.help, /voice transcripts are still forwarded as text/);
  assert.strictEqual(normalizeBool('ACCEPT_MEDIA', 'off', 'true'), 'false');
  assert.match(renderEnv({ ACCEPT_MEDIA: 'false' }, COMMON_QUESTIONS), /^ACCEPT_MEDIA=false$/m);
});

test('payload: media array only when present; existing fields unchanged', () => {
  const at = new Date(0);
  const plain = buildPayload({ source: 'x', senderId: 'u', messageId: '1', text: 't', untrusted: false, receivedAt: at });
  assert.ok(!('media' in plain));
  assert.ok(!('media' in buildPayload({ source: 'x', senderId: 'u', messageId: '1', text: 't', untrusted: false, receivedAt: at, media: [] })));
  const m = [{ kind: 'image', path: '/tmp/a.png', content_type: 'image/png', size: 3 }];
  const p = buildPayload({ source: 'x', senderId: 'u', messageId: '1', text: '', untrusted: true, receivedAt: at, media: m });
  assert.deepStrictEqual(Object.keys(p), ['source', 'sender_id', 'message_id', 'text', 'truncated', 'received_at', 'untrusted', 'mirror', 'media', 'handling_hint']);
  assert.deepStrictEqual(p.media, m);
});

test('media store: private files, generated names, size cap, cleanup by age', () => {
  let t = Date.UTC(2026, 0, 10);
  const dir = path.join(MTMP, 'store');
  const s = createMediaStore({ dir, maxBytes: 64, retentionDays: 2, now: () => t });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x')]);
  const a = s.save(png, { kind: 'image' });
  assert.strictEqual(a.content_type, 'image/png'); assert.strictEqual(a.size, png.length);
  assert.ok(a.path.startsWith(dir + path.sep) && a.path.endsWith('-image.png'));
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(a.path).mode & 0o777, 0o600);
  const b = s.save(Buffer.from('hello'), { kind: 'file', filename: '../../etc/pass wd.txt', contentType: 'text/plain' });
  assert.strictEqual(path.dirname(b.path), dir);
  assert.ok(path.basename(b.path).endsWith('-pass_wd.txt'), b.path);
  assert.strictEqual(b.filename, '../../etc/pass wd.txt'); // original name is reported, never used as a path
  assert.strictEqual(safeName('\u4e2d\u6587.pdf'), 'pdf'); assert.strictEqual(safeName('...'), 'file');
  assert.throws(() => s.save(Buffer.alloc(65, 1)), (e) => e.label === 'TOO_LARGE');
  assert.throws(() => s.save(Buffer.alloc(0)), (e) => e.label === 'EMPTY_MEDIA');
  const old = Date.now() / 1000 - 3 * 86400; fs.utimesSync(a.path, old, old);
  t = Date.now();
  assert.strictEqual(s.cleanup(), 1);
  assert.ok(!fs.existsSync(a.path) && fs.existsSync(b.path));
  assert.strictEqual(createMediaStore({ dir, retentionDays: 0 }).cleanup(), 0);
  assert.strictEqual(createMediaStore({ dir: path.join(MTMP, 'missing') }).cleanup(), 0);
});

test('fetchLimited: https only, HTTP errors, size cap (header, stream, buffer), network/timeout labels', async () => {
  const fetchLimited = (u, o = {}) => fetchLimitedRaw(u, { allowedHosts: ['cdn.example'], ...o });
  const ok = binFetch(() => ({ body: Buffer.from('abc') }));
  assert.strictEqual((await fetchLimited('https://cdn.example/x', { fetchImpl: ok })).toString(), 'abc');
  assert.strictEqual((await fetchLimited('https://cdn.example/x', { fetchImpl: binFetch(() => ({ body: Buffer.from('st'), stream: true })) })).toString(), 'st');
  await assert.rejects(fetchLimited('http://cdn.example/x', { fetchImpl: ok }), (e) => e.label === 'NOT_HTTPS');
  assert.strictEqual(ok.calls.length, 1);
  await assert.rejects(fetchLimited('not a url', { fetchImpl: ok }), (e) => e.label === 'BAD_URL');
  await assert.rejects(fetchLimited('https://cdn.example/x', { fetchImpl: binFetch(() => ({ status: 404 })) }), (e) => e.label === 'HTTP_404' && !e.message.includes('cdn.example'));
  await assert.rejects(fetchLimited('https://cdn.example/x', { maxBytes: 2, fetchImpl: binFetch(() => ({ body: Buffer.from('abc'), headers: { 'content-length': '3' } })) }), (e) => e.label === 'TOO_LARGE');
  await assert.rejects(fetchLimited('https://cdn.example/x', { maxBytes: 2, fetchImpl: binFetch(() => ({ body: Buffer.from('abc'), stream: true })) }), (e) => e.label === 'TOO_LARGE');
  await assert.rejects(fetchLimited('https://cdn.example/x', { maxBytes: 2, fetchImpl: binFetch(() => ({ body: Buffer.from('abc') })) }), (e) => e.label === 'TOO_LARGE');
  await assert.rejects(fetchLimited('https://cdn.example/x', { fetchImpl: binFetch(() => ({ throw: 'TypeError' })) }), (e) => e.label === 'NETWORK');
  await assert.rejects(fetchLimited('https://cdn.example/x', { fetchImpl: binFetch(() => ({ throw: 'AbortError' })) }), (e) => e.label === 'TIMEOUT');
});

test('format sniffing and SILK -> WAV (24 kHz mono)', async () => {
  assert.strictEqual(sniffMime(Buffer.from('GIF89a..')), 'image/gif');
  assert.strictEqual(sniffMime(Buffer.from('RIFF\0\0\0\0WAVEfmt ')), 'audio/wav');
  assert.strictEqual(sniffMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.strictEqual(sniffMime(Buffer.from('ID3\x04rest')), 'audio/mpeg');
  assert.strictEqual(sniffMime(Buffer.from('\x02#!SILK_V3rest')), 'audio/silk');
  assert.strictEqual(sniffMime(Buffer.from('\0\0\0\x18ftypmp42')), 'video/mp4');
  assert.strictEqual(sniffMime(Buffer.from('plain text')), null);
  assert.ok(isSilk(Buffer.from('#!SILK_V3....')) && !isSilk(Buffer.from('#!AMR\n')));
  assert.strictEqual(mimeFromFilename('Report.PDF'), 'application/pdf'); assert.strictEqual(mimeFromFilename('x'), 'application/octet-stream');
  const wav = pcmToWav(new Uint8Array([1, 0, 2, 0]), 24000);
  assert.strictEqual(wav.length, 48);
  assert.deepStrictEqual([wav.toString('latin1', 0, 4), wav.toString('latin1', 8, 12), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34), wav.readUInt32LE(40)], ['RIFF', 'WAVE', 1, 24000, 16, 4]);
  const fake = { decode: async (buf, rate) => { assert.strictEqual(rate, 24000); return { data: new Uint8Array([9, 0]), duration: 1 }; } };
  assert.strictEqual((await silkToWav(Buffer.from('#!SILK_V3xx'), { codec: fake })).length, 46);
  assert.strictEqual(await silkToWav(Buffer.from('x'), { codec: null }), null);
  assert.strictEqual(await silkToWav(Buffer.from('x'), { codec: { decode: async () => { throw new Error('bad'); } } }), null);
});

test('SILK round trip with the optional silk-wasm package (skipped when not installed)', async (t) => {
  const codec = loadSilk();
  if (!codec) { t.skip('silk-wasm not installed'); return; }
  const pcm = Buffer.alloc(24000); // 0.5 s of 24 kHz mono s16le
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin(i / 8)), i * 2);
  const silk = Buffer.from((await codec.encode(pcm, 24000)).data);
  assert.ok(isSilk(silk));
  const wav = await silkToWav(silk);
  assert.ok(wav && wav.toString('latin1', 0, 4) === 'RIFF' && wav.length > 44);
});

/* ---------------- setup: hidden secret input ---------------- */
const { runSetup } = require('../src/setup-common');
const { PassThrough, Writable: SetupWritable } = require('node:stream');

const SETUP_QUESTIONS = [
  { key: 'FORWARD_WEBHOOK_URL', required: true, help: 'url' },
  { key: 'FORWARD_WEBHOOK_AUTH', secret: true, help: 'auth' },
  { key: 'OWNER_PROTECTION', type: 'bool', dflt: 'off', help: 'prot' },
];
const SECRET = 'Bearer s3cr3t-value-xyz';

function captureOutput(onWrite = () => {}) {
  const out = { text: '' };
  out.stream = new SetupWritable({ write(c, e, cb) { out.text += c.toString(); onWrite(out.text); cb(); } });
  return out;
}

test('setup: piped (non-TTY) answers are read in order, secret never written to output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-setup-'));
  try {
    const file = path.join(dir, '.env');
    const input = new PassThrough();
    const out = captureOutput();
    input.end(`https://hooks.example.com/x\n${SECRET}\non\n`);
    const answers = await runSetup({ questions: SETUP_QUESTIONS, file, input, output: out.stream, terminal: false });
    assert.strictEqual(answers.FORWARD_WEBHOOK_AUTH, SECRET);
    assert.deepStrictEqual(parseDotEnv(fs.readFileSync(file, 'utf8')),
      { FORWARD_WEBHOOK_URL: 'https://hooks.example.com/x', FORWARD_WEBHOOK_AUTH: SECRET, OWNER_PROTECTION: 'on' });
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!out.text.includes('s3cr3t'), 'secret not echoed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup: in terminal mode, normal answers are echoed but secret answers are hidden', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-setup-'));
  try {
    const file = path.join(dir, '.env');
    const input = new PassThrough();
    const replies = [['FORWARD_WEBHOOK_URL: ', 'https://hooks.example.com/visible'], ['FORWARD_WEBHOOK_AUTH: ', SECRET], ['OWNER_PROTECTION [off]: ', '']];
    let next = 0;
    const out = captureOutput((text) => {
      // "type" each answer only after its prompt appears, as a person would.
      if (next < replies.length && text.endsWith(replies[next][0])) { const a = replies[next++][1]; setImmediate(() => input.write(`${a}\r`)); }
    });
    const answers = await runSetup({ questions: SETUP_QUESTIONS, file, input, output: out.stream, terminal: true });
    assert.strictEqual(answers.FORWARD_WEBHOOK_AUTH, SECRET);
    assert.strictEqual(answers.OWNER_PROTECTION, 'off');
    assert.ok(out.text.includes('https://hooks.example.com/visible'), 'non-secret answer is echoed');
    assert.ok(!out.text.includes('s3cr3t'), 'secret answer is not echoed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setup: input that ends early aborts without writing .env', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-setup-'));
  try {
    const file = path.join(dir, '.env');
    const input = new PassThrough();
    input.end('https://hooks.example.com/x\n');
    await assert.rejects(runSetup({ questions: SETUP_QUESTIONS, file, input, output: captureOutput().stream, terminal: false }), /aborted/);
    assert.ok(!fs.existsSync(file));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
