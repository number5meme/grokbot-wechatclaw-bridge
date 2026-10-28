'use strict';
// WeChat media tests: AES-128-ECB CDN crypto, inbound download/decrypt, voice transcripts, payload shape,
// outbound image upload flow, and error cases. No network: every fetch is faked.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cdn = require('../src/cdn');
const ilink = require('../src/ilink');
const { collectMediaItems, fetchMedia } = require('../src/media');
const { createMediaStore } = require('../src/media-store');
const { handleMessages, messageText } = require('../src/handler');
const { createGuard } = require('../src/guard');
const { sendImageReply, loadImage, ReplyError } = require('../bin/reply');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-wechatclaw-media-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const OWNER = 'owner-user@im.wechat';
const STRANGER = 'stranger-user@im.wechat';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body-0123456789')]);
const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const b64raw = KEY.toString('base64'); // base64(16 raw bytes): images
const b64hex = Buffer.from(KEY.toString('hex')).toString('base64'); // base64(32-char hex): file / voice / video

/** Fake fetch serving bytes per URL substring; records calls. */
function cdnFetch(routes) {
  const calls = [];
  const f = async (url, opts = {}) => {
    const u = String(url); calls.push({ url: u, opts });
    const hit = Object.keys(routes).find((k) => u.includes(k));
    if (!hit) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    const r = routes[hit];
    const body = Buffer.isBuffer(r) ? r : r.body || Buffer.alloc(0);
    const status = (r && r.status) || 200;
    const hdr = (r && r.headers) || {};
    return { ok: status < 300, status, headers: { get: (k) => hdr[k.toLowerCase()] ?? null }, text: async () => '',
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
  };
  f.calls = calls;
  return f;
}
function memOwner(init = null) { let o = init; return { get: () => o, set: (id) => { o = id; } }; }
const store = (name = 'm', maxBytes = 1024 * 1024) => createMediaStore({ dir: path.join(TMP, name), maxBytes, allowedHosts: ['example.com', 'weixin.qq.com'] });

/* ---------------- crypto ---------------- */
test('AES-128-ECB round trip, padded size, aes_key encodings', () => {
  for (const n of [0, 1, 15, 16, 17, 1000]) {
    const plain = crypto.randomBytes(n);
    const enc = cdn.encryptAesEcb(plain, KEY);
    assert.strictEqual(enc.length, cdn.aesEcbPaddedSize(n));
    assert.ok(cdn.decryptAesEcb(enc, KEY).equals(plain));
  }
  assert.strictEqual(cdn.aesEcbPaddedSize(16), 32);
  assert.ok(cdn.parseAesKey(b64raw).equals(KEY));
  assert.ok(cdn.parseAesKey(b64hex).equals(KEY));
  assert.throws(() => cdn.parseAesKey(Buffer.from('short').toString('base64')), (e) => e.label === 'BAD_AES_KEY');
  assert.strictEqual(cdn.buildCdnDownloadUrl('a b&c'), 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%20b%26c');
  assert.strictEqual(cdn.buildCdnUploadUrl({ uploadParam: 'p=1', filekey: 'k' }), 'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=p%3D1&filekey=k');
});

/* ---------------- inbound ---------------- */
test('collect: image/voice/file/video items; voice transcript means no download; items without media ignored', () => {
  const m = { item_list: [
    { type: 1, text_item: { text: 'hi' } },
    { type: 2, image_item: {} },
    { type: 2, image_item: { media: { encrypt_query_param: 'Q' } } },
    { type: 3, voice_item: { text: ' hello there ', media: { encrypt_query_param: 'V', aes_key: b64hex } } },
    { type: 3, voice_item: { media: { encrypt_query_param: 'V2', aes_key: b64hex } } },
    { type: 4, file_item: { media: { encrypt_query_param: 'F' } } }, // no aes_key: ignored (official)
    { type: 5, video_item: { media: { full_url: 'https://cdn.example.com/v', aes_key: b64hex } } },
  ] };
  assert.deepStrictEqual(collectMediaItems(m).map((c) => [c.kind, c.download, c.transcript]), [
    ['image', true, undefined], ['voice', false, 'hello there'], ['voice', true, undefined], ['video', true, undefined]]);
  assert.strictEqual(messageText(m), 'hi\n[voice] hello there');
  assert.strictEqual(messageText({ item_list: [{ type: 3, voice_item: { text: 'only voice' } }] }), '[voice] only voice');
});

test('download: image via encrypt_query_param (hex aeskey preferred), full_url, plain; file name; video', async () => {
  const f = cdnFetch({
    'encrypted_query_param=IMG': cdn.encryptAesEcb(PNG, KEY),
    'full/img': cdn.encryptAesEcb(PNG, KEY),
    'plain/img': PNG,
    'encrypted_query_param=DOC': cdn.encryptAesEcb(Buffer.from('%PDF-1.4 doc'), KEY),
    'full/video': cdn.encryptAesEcb(Buffer.from('\0\0\0\x18ftypmp42....'), KEY),
  });
  const s = store('dl');
  const items = [
    { type: 2, image_item: { aeskey: KEY.toString('hex'), media: { encrypt_query_param: 'IMG', aes_key: 'd3Jvbmc=' } } },
    { type: 2, image_item: { media: { full_url: 'https://cdn.example.com/full/img', aes_key: b64raw } } },
    { type: 2, image_item: { media: { full_url: 'https://cdn.example.com/plain/img' } } },
    { type: 4, file_item: { file_name: 'Quarterly report.pdf', media: { encrypt_query_param: 'DOC', aes_key: b64hex } } },
    { type: 5, video_item: { media: { full_url: 'https://cdn.example.com/full/video', aes_key: b64hex } } },
  ];
  const out = await fetchMedia(collectMediaItems({ item_list: items }), { store: s, cdnBaseUrl: 'https://cdn.example.com/c2c', fetchImpl: f });
  assert.deepStrictEqual(out.map((e) => [e.kind, e.content_type, e.error]), [['image', 'image/png', undefined], ['image', 'image/png', undefined],
    ['image', 'image/png', undefined], ['file', 'application/pdf', undefined], ['video', 'video/mp4', undefined]]);
  for (const e of out.slice(0, 3)) assert.ok(fs.readFileSync(e.path).equals(PNG));
  assert.strictEqual(out[3].filename, 'Quarterly report.pdf');
  assert.ok(out[3].path.endsWith('-Quarterly_report.pdf'));
  assert.strictEqual(f.calls[0].url, 'https://cdn.example.com/c2c/download?encrypted_query_param=IMG');
});

test('download: voice without transcript is decrypted and transcoded to WAV, else kept as SILK; failures keep an entry', async () => {
  const silk = Buffer.from('\x02#!SILK_V3 fake voice frames');
  const f = cdnFetch({ 'encrypted_query_param=VOICE': cdn.encryptAesEcb(silk, KEY), 'encrypted_query_param=GONE': { status: 404 } });
  const s = store('voice');
  const collected = collectMediaItems({ item_list: [{ type: 3, voice_item: { playtime: 1200, media: { encrypt_query_param: 'VOICE', aes_key: b64hex } } }] });
  const wav = Buffer.from('RIFF\0\0\0\0WAVEfmt fake');
  let seen = null;
  const [a] = await fetchMedia(collected, { store: s, fetchImpl: f, transcode: async (b) => { seen = b; return wav; } });
  assert.ok(seen.equals(silk));
  assert.deepStrictEqual([a.kind, a.content_type, a.duration_ms], ['voice', 'audio/wav', 1200]);
  assert.ok(a.path.endsWith('.wav') && fs.readFileSync(a.path).equals(wav));
  const [b] = await fetchMedia(collected, { store: s, fetchImpl: f, transcode: async () => null });
  assert.deepStrictEqual([b.content_type, path.extname(b.path)], ['audio/silk', '.silk']);
  const bad = collectMediaItems({ item_list: [{ type: 3, voice_item: { media: { encrypt_query_param: 'GONE', aes_key: b64hex } } },
    { type: 2, image_item: { media: { encrypt_query_param: 'IMG', aes_key: 'AAAA' } } }] });
  const errs = await fetchMedia(bad, { store: s, fetchImpl: f });
  assert.deepStrictEqual(errs.map((e) => [e.kind, e.path, e.error]), [['voice', null, 'HTTP_404'], ['image', null, 'BAD_AES_KEY']]);
  const big = await fetchMedia(collectMediaItems({ item_list: [{ type: 2, image_item: { media: { full_url: 'https://cdn.example.com/plain/big' } } }] }),
    { store: store('tiny', 4), fetchImpl: cdnFetch({ 'plain/big': PNG }) });
  assert.strictEqual(big[0].error, 'TOO_LARGE');
});

function harness({ protection = true, media = true, rate = 20 } = {}) {
  const fwd = []; const fetched = [];
  const guard = createGuard({ protection, ownerStore: memOwner(OWNER), rateLimitPerMin: rate, maxChars: 4000 });
  const deps = { guard, seen: new Set(), forward: async (p) => { fwd.push(p); return true; },
    fetchMedia: media ? async (c) => { fetched.push(...c); return c.map((x) => (x.download ? { kind: x.kind, path: `/media/${x.kind}`, content_type: 'x/y', size: 1 } : { kind: 'voice', path: null, content_type: null, size: null, transcript: x.transcript })); } : null };
  return { guard, fwd, fetched, run: (msgs) => handleMessages(msgs, deps) };
}
const imgMsg = (id, from) => ({ message_id: id, from_user_id: from, message_type: 1, context_token: 'c', item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'Q', aes_key: b64raw } } }] });
const voiceMsg = (id, from, text) => ({ message_id: id, from_user_id: from, message_type: 1, context_token: 'c', item_list: [{ type: 3, voice_item: { text, media: { encrypt_query_param: 'V', aes_key: b64hex } } }] });

test('handler: media-only messages are forwarded with a media array; voice transcript becomes text', async () => {
  const h = harness();
  const r = await h.run([imgMsg('1', OWNER), voiceMsg('2', OWNER, 'turn on the lights'),
    { message_id: '3', from_user_id: OWNER, message_type: 1, item_list: [{ type: 1, text_item: { text: 'look' } }, ...imgMsg('x', OWNER).item_list] }]);
  assert.deepStrictEqual(r, { forwarded: 3, dropped: 0, duplicate: 0, nonText: 0, undelivered: 0 });
  assert.deepStrictEqual(h.fwd[0].media, [{ kind: 'image', path: '/media/image', content_type: 'x/y', size: 1 }]);
  assert.strictEqual(h.fwd[0].text, '');
  for (const k of ['source', 'sender_id', 'message_id', 'text', 'truncated', 'received_at', 'untrusted', 'mirror', 'handling_hint']) assert.ok(k in h.fwd[0], k);
  assert.strictEqual(h.fwd[1].text, '[voice] turn on the lights');
  assert.deepStrictEqual(h.fwd[1].media, [{ kind: 'voice', path: null, content_type: null, size: null, transcript: 'turn on the lights' }]);
  assert.strictEqual(h.fwd[2].text, 'look'); assert.strictEqual(h.fwd[2].media.length, 1);
});

test('handler: strangers with media are dropped before any download; rate limit counts media messages', async () => {
  const h = harness({ rate: 1 });
  const r = await h.run([imgMsg('1', STRANGER), imgMsg('2', OWNER), imgMsg('3', OWNER)]);
  assert.deepStrictEqual([r.forwarded, r.dropped], [1, 2]);
  assert.strictEqual(h.fetched.length, 1);
  assert.strictEqual(h.guard.stats.dropped_not_owner, 1); assert.strictEqual(h.guard.stats.dropped_rate_limited, 1);
});

test('handler: ACCEPT_MEDIA off skips media-only messages but still forwards voice transcripts as text', async () => {
  const h = harness({ media: false });
  const r = await h.run([imgMsg('1', OWNER), voiceMsg('2', OWNER, 'hello'), voiceMsg('3', OWNER, '')]);
  assert.deepStrictEqual([r.forwarded, r.nonText], [1, 2]);
  assert.deepStrictEqual([h.fwd[0].text, 'media' in h.fwd[0]], ['[voice] hello', false]);
});

/* ---------------- outbound image ---------------- */
function uploadHarness({ cdnRoutes, uploadResp, sendResp } = {}) {
  const ups = []; const sent = [];
  const f = cdnFetch(cdnRoutes || { '/c2c/upload': { headers: { 'x-encrypted-param': 'DOWNLOAD-PARAM' } } });
  const deps = { to: OWNER, cdnBaseUrl: 'https://cdn.example.com/c2c', fetchImpl: f, allowedHosts: ['example.com'],
    getUploadUrl: async (p) => { ups.push(p); return uploadResp ? uploadResp(p) : { ret: 0, upload_param: 'UP-PARAM' }; },
    send: async (item) => { sent.push(item); return sendResp ? sendResp(item, sent.length) : { ret: 0 }; } };
  return { f, ups, sent, run: (file, cap) => sendImageReply(file, cap, deps) };
}
function imgFile(name, buf = PNG) { const p = path.join(TMP, name); fs.writeFileSync(p, buf); return p; }

test('image upload: getuploadurl fields, encrypted CDN POST, x-encrypted-param, caption then image_item', async () => {
  const h = uploadHarness();
  const r = await h.run(imgFile('a.png'), '**Look** at this');
  const p = h.ups[0];
  assert.deepStrictEqual(Object.keys(p).sort(), ['aeskey', 'filekey', 'filesize', 'media_type', 'no_need_thumb', 'rawfilemd5', 'rawsize', 'to_user_id']);
  assert.deepStrictEqual([p.media_type, p.to_user_id, p.rawsize, p.filesize, p.no_need_thumb], [1, OWNER, PNG.length, cdn.aesEcbPaddedSize(PNG.length), true]);
  assert.strictEqual(p.rawfilemd5, crypto.createHash('md5').update(PNG).digest('hex'));
  assert.match(p.filekey, /^[0-9a-f]{32}$/); assert.match(p.aeskey, /^[0-9a-f]{32}$/);
  const post = h.f.calls[0];
  assert.strictEqual(post.url, `https://cdn.example.com/c2c/upload?encrypted_query_param=UP-PARAM&filekey=${p.filekey}`);
  assert.strictEqual(post.opts.method, 'POST'); assert.strictEqual(post.opts.headers['Content-Type'], 'application/octet-stream');
  assert.ok(cdn.decryptAesEcb(Buffer.from(post.opts.body), Buffer.from(p.aeskey, 'hex')).equals(PNG));
  assert.deepStrictEqual(h.sent, [
    { type: 1, text_item: { text: 'Look at this' } },
    { type: 2, image_item: { media: { encrypt_query_param: 'DOWNLOAD-PARAM', aes_key: Buffer.from(p.aeskey).toString('base64'), encrypt_type: 1 }, mid_size: p.filesize } },
  ]);
  assert.deepStrictEqual([r.mime, r.messages], ['image/png', 2]);
  // the receiver decodes aes_key with the same rule as inbound media
  assert.ok(cdn.parseAesKey(h.sent[1].image_item.media.aes_key).equals(Buffer.from(p.aeskey, 'hex')));
});

test('image upload: upload_full_url preferred; no caption sends one message; sendmessage body shape', async () => {
  const h = uploadHarness({ cdnRoutes: { 'full-upload': { headers: { 'x-encrypted-param': 'DP' } } }, uploadResp: () => ({ upload_full_url: ' https://cdn.example.com/full-upload?x=1 ', upload_param: 'ignored' }) });
  const r = await h.run(imgFile('b.png'), '');
  assert.strictEqual(h.f.calls[0].url, 'https://cdn.example.com/full-upload?x=1');
  assert.strictEqual(r.messages, 1); assert.strictEqual(h.sent[0].type, 2);
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200, text: async () => '{"ret":0}' }; };
  await ilink.sendMessageItem({ baseUrl: 'https://ilink.example', token: 'T', to: OWNER, item: h.sent[0], contextToken: 'CTX', fetchImpl: f });
  await ilink.getUploadUrl({ baseUrl: 'https://ilink.example', token: 'T', params: { filekey: 'k', media_type: 1 }, fetchImpl: f });
  assert.deepStrictEqual(calls[0].body.msg.item_list, [h.sent[0]]); assert.strictEqual(calls[0].body.msg.context_token, 'CTX');
  assert.strictEqual(calls[1].url, 'https://ilink.example/ilink/bot/getuploadurl');
  assert.deepStrictEqual({ ...calls[1].body, base_info: 'x' }, { filekey: 'k', media_type: 1, base_info: 'x' });
});

test('image upload errors: CDN 4xx not retried, 5xx retried 3x, missing header, no URL, -14 / -2 mapped, file checks', async () => {
  const file = imgFile('c.png');
  let h = uploadHarness({ cdnRoutes: { '/c2c/upload': { status: 400 } } });
  await assert.rejects(h.run(file, ''), (e) => e instanceof ReplyError && e.code === 'CDN_HTTP_400');
  assert.strictEqual(h.f.calls.length, 1); assert.strictEqual(h.sent.length, 0);
  h = uploadHarness({ cdnRoutes: { '/c2c/upload': { status: 500 } } });
  await assert.rejects(h.run(file, ''), (e) => e.code === 'CDN_HTTP_500'); assert.strictEqual(h.f.calls.length, 3);
  h = uploadHarness({ cdnRoutes: { '/c2c/upload': {} } });
  await assert.rejects(h.run(file, ''), (e) => e.code === 'CDN_NO_PARAM');
  h = uploadHarness({ uploadResp: () => ({ ret: 0 }) });
  await assert.rejects(h.run(file, ''), (e) => e.code === 'UPLOAD_URL_MISSING');
  h = uploadHarness({ uploadResp: () => ({ ret: -14, errcode: -14 }) });
  await assert.rejects(h.run(file, ''), (e) => e.code === '-14' && e.exit === 14); assert.strictEqual(h.f.calls.length, 0);
  h = uploadHarness({ sendResp: (_i, n) => (n === 1 ? { ret: 0 } : { ret: -2 }) });
  await assert.rejects(h.run(file, 'caption'), (e) => e.code === '-2' && e.exit === 3 && /sent 1\/2/.test(e.hint));
  assert.throws(() => loadImage(path.join(TMP, 'none.png')), (e) => e.code === 'FILE_NOT_FOUND');
  assert.throws(() => loadImage(TMP), (e) => e.code === 'NOT_A_FILE');
  assert.throws(() => loadImage(imgFile('empty.png', Buffer.alloc(0))), (e) => e.code === 'EMPTY_FILE');
  assert.throws(() => loadImage(imgFile('fake.png', Buffer.from('not an image'))), (e) => e.code === 'UNSUPPORTED_TYPE');
  assert.throws(() => loadImage(file, { maxBytes: 4 }), (e) => e.code === 'FILE_TOO_LARGE');
});

/* ---------------- CLI + end-to-end ---------------- */
function runNode(args, env) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, BRIDGE_NO_DOTENV: '1', STATE_DIR: path.join(TMP, 'state'), LOG_DIR: path.join(TMP, 'logs'), ...env } });
}

test('CLI: reply --image validates the file before any network call; --voice is unsupported', () => {
  let r = runNode(['bin/reply.js', '--image', path.join(TMP, 'missing.png')], {});
  assert.strictEqual(r.status, 1); assert.strictEqual(r.stdout.trim(), 'ERROR FILE_NOT_FOUND');
  r = runNode(['bin/reply.js', '--image'], {});
  assert.strictEqual(r.stdout.trim(), 'ERROR NO_FILE');
  r = runNode(['bin/reply.js', '--voice', 'x.silk'], {});
  assert.strictEqual(r.stdout.trim(), 'ERROR UNSUPPORTED');
  r = runNode(['bin/reply.js', '--image', imgFile('cli.png')], {});
  assert.strictEqual(r.stdout.trim(), 'ERROR NO_RECIPIENT'); assert.strictEqual(r.status, 2, '--to is required');
  r = runNode(['bin/reply.js', '--to', OWNER, '--image', imgFile('cli.png')], {});
  assert.strictEqual(r.stdout.trim(), 'ERROR NO_CREDENTIALS');
});

test('end-to-end: image-only message is downloaded, decrypted, saved under MEDIA_DIR and forwarded (fake fetch)', () => {
  const st = path.join(TMP, 'e2e-state'); const md = path.join(TMP, 'e2e-media'); fs.mkdirSync(st, { recursive: true });
  fs.writeFileSync(path.join(st, 'credentials.json'), JSON.stringify({ bot_token: 'fake-token', baseurl: 'https://ilink.example', login_user_id: OWNER }), { mode: 0o600 });
  const dump = path.join(TMP, 'e2e-media-dump.json');
  const script = [{ ret: 0, get_updates_buf: 'C1', msgs: [
    { message_id: '20', from_user_id: OWNER, message_type: 1, context_token: 'ctx', item_list: [{ type: 2, image_item: { aeskey: KEY.toString('hex'), media: { full_url: 'https://cdn.example.com/c2c/download?encrypted_query_param=SECRETPARAM' } } }] },
    { message_id: '21', from_user_id: STRANGER, message_type: 1, item_list: [{ type: 2, image_item: { media: { full_url: 'https://cdn.example.com/c2c/download?x=2' } } }] },
  ] }, { ret: -14, errcode: -14 }];
  const r = runNode(['-r', path.join(__dirname, 'fake-fetch-preload.js'), 'bin/bridge.js'], {
    STATE_DIR: st, LOG_DIR: path.join(TMP, 'e2e-logs'), MEDIA_DIR: md, FAKE_SCRIPT: JSON.stringify(script), FAKE_DUMP: dump,
    FAKE_CDN_B64: cdn.encryptAesEcb(PNG, KEY).toString('base64'), FORWARD_WEBHOOK_URL: 'https://hooks.example.com/in', OWNER_PROTECTION: 'on', MEDIA_ALLOWED_HOSTS: 'cdn.example.com' });
  assert.strictEqual(r.status, 14, r.stderr);
  const calls = JSON.parse(fs.readFileSync(dump, 'utf8'));
  assert.strictEqual(calls.filter((c) => c.kind === 'cdn').length, 1, 'stranger media is never downloaded');
  const hooks = calls.filter((c) => c.kind === 'webhook');
  assert.strictEqual(hooks.length, 1);
  const p = hooks[0].body;
  assert.deepStrictEqual([p.text, p.media.length, p.media[0].kind, p.media[0].content_type, p.media[0].size], ['', 1, 'image', 'image/png', PNG.length]);
  assert.strictEqual(path.dirname(p.media[0].path), md);
  assert.ok(fs.readFileSync(p.media[0].path).equals(PNG));
  assert.strictEqual(fs.statSync(p.media[0].path).mode & 0o777, 0o600);
  const log = fs.readFileSync(path.join(TMP, 'e2e-logs', 'bridge.log'), 'utf8');
  assert.match(log, /inbound media image/);
  for (const s of ['SECRETPARAM', KEY.toString('hex'), 'cdn.example.com']) assert.ok(!log.includes(s), `log leaks ${s}`);
});
