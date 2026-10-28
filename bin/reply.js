#!/usr/bin/env node
'use strict';
// Send a plain-text reply, an image, a video or a file to a WeChat user via the bot.
// Recommended (no shell quoting problems): ./reply.sh --to <user_id> --stdin <<'EOF_REPLY' ... EOF_REPLY
// Voice replies are not supported: Tencent's official client has no outbound voice implementation.
// Prints "OK" (exit 0) or "ERROR <code>" with a hint on stderr.
// Exit codes: 1 generic, 2 usage / configuration, 3 reply window closed or quota used (-2, the same meaning as
// REPLY_WINDOW on QQ), 14 session expired (-14).
const fs = require('node:fs');
const path = require('node:path');
const C = require('../src/config');
const F = require('../src/files');
const ilink = require('../src/ilink');
const { buildChunks, stripMarkdown } = require('../src/text');
const cdn = require('../src/cdn');
const { sniffMime } = require('../src/media-store');
const { DEFAULT_MEDIA_HOSTS } = require('../src/config-common');
const { recipientProblem, checkSendablePath } = require('../src/outbound');

const CHUNK = 2000;
const MAX_CHUNKS = 10; // iLink allows roughly 10 outbound messages per inbound context_token
const REPLY_QUOTA = 10; // messages per context_token, counted in context_tokens.json ("sent")
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024; // the official client's media size limit
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp'];
const VIDEO_EXT = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo' };

class ReplyError extends Error {
  constructor(code, exit, hint = '') { super(`${code}${hint ? ': ' + hint : ''}`); this.code = code; this.exit = exit; this.hint = hint; }
}

/** Core send loop (exported for tests). send(text) must call sendmessage and resolve with the response. */
async function sendReply(raw, { send, maxChunks = MAX_CHUNKS, onSent = () => {} }) {
  const parts = buildChunks(raw, { chunkSize: CHUNK, maxChunks: Math.max(1, Math.min(MAX_CHUNKS, maxChunks)) });
  if (!parts.length) throw new ReplyError('EMPTY_TEXT', 1, 'text is empty after Markdown stripping');
  for (let i = 0; i < parts.length; i++) {
    let resp;
    try { resp = await send(parts[i]); } catch (e) {
      if (e.status) throw new ReplyError(`HTTP_${e.status}`, 1, `sent ${i}/${parts.length}`);
      throw new ReplyError(ilink.isTimeout(e) ? 'TIMEOUT' : 'NETWORK', 1, `sent ${i}/${parts.length}`);
    }
    const code = ilink.errCodeOf(resp);
    if (code === ilink.ERR.SESSION_EXPIRED) throw new ReplyError('-14', 14, `session expired; run ./login.sh and scan again (sent ${i}/${parts.length})`);
    if (code === ilink.ERR.REPLY_WINDOW) throw new ReplyError('-2', 3, `reply window closed or ~10-reply quota used; the user must send a new message first (sent ${i}/${parts.length})`);
    if (code !== 0) throw new ReplyError(String(code), 1, `sent ${i}/${parts.length}`);
    onSent();
  }
  return { parts: parts.length };
}

/** Map one sendmessage / getuploadurl response or error to a ReplyError (or return normally). */
function checkResp(resp, where) {
  const code = ilink.errCodeOf(resp);
  if (code === ilink.ERR.SESSION_EXPIRED) throw new ReplyError('-14', 14, `session expired; run ./login.sh and scan again (${where})`);
  if (code === ilink.ERR.REPLY_WINDOW) throw new ReplyError('-2', 3, `reply window closed or ~10-reply quota used; the user must send a new message first (${where})`);
  if (code !== 0) throw new ReplyError(String(code), 1, where);
}
function netError(e, where) {
  if (e instanceof ReplyError) return e;
  if (e && e.label) return new ReplyError(e.label, 1, `${where}: ${e.message}`);
  if (e && e.status) return new ReplyError(`HTTP_${e.status}`, 1, where);
  return new ReplyError(ilink.isTimeout(e) ? 'TIMEOUT' : 'NETWORK', 1, where);
}

function statFile(filePath, maxBytes) {
  let st;
  try { st = fs.statSync(filePath); } catch { throw new ReplyError('FILE_NOT_FOUND', 1, `file not found: ${filePath}`); }
  if (!st.isFile()) throw new ReplyError('NOT_A_FILE', 1, `not a regular file: ${filePath}`);
  if (st.size === 0) throw new ReplyError('EMPTY_FILE', 1, `file is empty: ${filePath}`);
  if (st.size > maxBytes) throw new ReplyError('FILE_TOO_LARGE', 1, `file is ${(st.size / 1048576).toFixed(1)}MB; limit is ${(maxBytes / 1048576).toFixed(0)}MB`);
  return st;
}

/** Read + validate a local image. Throws ReplyError FILE_NOT_FOUND / NOT_A_FILE / EMPTY_FILE / FILE_TOO_LARGE / UNSUPPORTED_TYPE. */
function loadImage(filePath, { maxBytes = MAX_IMAGE_BYTES } = {}) {
  statFile(filePath, maxBytes);
  const buf = fs.readFileSync(filePath);
  const mime = sniffMime(buf);
  if (!IMAGE_TYPES.includes(mime)) throw new ReplyError('UNSUPPORTED_TYPE', 1, 'only png / jpg / gif / webp / bmp images are supported');
  return { buf, mime, size: buf.length };
}

/** Read + validate a local video (by extension, as in the official client: mp4 / mov / webm / mkv / avi). */
function loadVideo(filePath, { maxBytes = MAX_FILE_BYTES } = {}) {
  const mime = VIDEO_EXT[path.extname(filePath).toLowerCase()];
  if (!mime) throw new ReplyError('UNSUPPORTED_TYPE', 1, 'only mp4 / mov / webm / mkv / avi videos are supported (send other files with --file)');
  statFile(filePath, maxBytes);
  const buf = fs.readFileSync(filePath);
  return { buf, mime, size: buf.length };
}

/** Read + validate any local file (sent as a file attachment). */
function loadFile(filePath, { maxBytes = MAX_FILE_BYTES } = {}) {
  statFile(filePath, maxBytes);
  const buf = fs.readFileSync(filePath);
  return { buf, mime: sniffMime(buf) || 'application/octet-stream', size: buf.length, name: path.basename(filePath) };
}

const KINDS = {
  image: { load: loadImage, uploadType: cdn.UPLOAD_MEDIA_TYPE.IMAGE, item: (u) => cdn.buildImageItem(u) },
  video: { load: loadVideo, uploadType: cdn.UPLOAD_MEDIA_TYPE.VIDEO, item: (u) => cdn.buildVideoItem(u) },
  file: { load: loadFile, uploadType: cdn.UPLOAD_MEDIA_TYPE.FILE, item: (u, m) => cdn.buildFileItem(u, m.name) },
};

/**
 * Media send (official flow: uploadMediaToCdn + sendImageMessageWeixin / sendVideoMessageWeixin /
 * sendFileMessageWeixin). The optional caption goes first as its own TEXT message, then the media item.
 * deps: { send(item) -> resp, getUploadUrl(params) -> resp, cdnBaseUrl, fetchImpl, to, maxBytes, allowedHosts, onSent }.
 */
async function sendMediaReply(kind, filePath, caption, { send, getUploadUrl, cdnBaseUrl = cdn.CDN_BASE_URL, fetchImpl, to, maxBytes,
  allowedHosts = DEFAULT_MEDIA_HOSTS, onSent = () => {} }) {
  const k = KINDS[kind];
  if (!k) throw new ReplyError('UNSUPPORTED', 1, `unknown media kind ${kind}`);
  const media = k.load(filePath, maxBytes ? { maxBytes } : {});
  let uploaded;
  try {
    uploaded = await cdn.uploadMedia({ buf: media.buf, toUserId: to, mediaType: k.uploadType, cdnBaseUrl, fetchImpl, allowedHosts,
      getUploadUrl: async (params) => { const r = await getUploadUrl(params); checkResp(r, `${kind} upload`); return r; } });
  } catch (e) { throw netError(e, `${kind} upload`); }
  const text = stripMarkdown(caption || '').slice(0, CHUNK);
  let sent = 0;
  const items = [];
  if (text) items.push({ type: ilink.ITEM_TYPE.TEXT, text_item: { text } });
  items.push(k.item(uploaded, media));
  for (const item of items) {
    let resp;
    try { resp = await send(item); } catch (e) { throw netError(e, `${kind} send, sent ${sent}/${items.length}`); }
    checkResp(resp, `${kind} send, sent ${sent}/${items.length}`);
    sent++; onSent();
  }
  return { mime: media.mime, size: media.size, messages: sent };
}

/** Image send (kept for compatibility): sendMediaReply('image', ...). */
function sendImageReply(filePath, caption, deps) { return sendMediaReply('image', filePath, caption, deps); }

const USAGE = `Usage: ./reply.sh --to <user_id> --stdin <<'EOF'      (recommended: text on stdin)
       ./reply.sh --to <user_id> [--] "plain text"
       ./reply.sh --to <user_id> --image <file.png|jpg|gif|webp|bmp> [--stdin | -- "caption"]
       ./reply.sh --to <user_id> --video <file.mp4|mov|webm|mkv|avi> [--stdin | -- "caption"]
       ./reply.sh --to <user_id> --file <any file> [--stdin | -- "caption"]
Options: --to <user_id>  recipient (required): the payload's sender_id, or "owner" for the bound owner
         --stdin         read the text (or the caption) from stdin; use a quoted heredoc (<<'EOF')
         --image/--video/--file <file>  send media (one per call)
         --              end of options (text may then start with '-')
         -h, --help      show this help
Text without --stdin or arguments is also read from stdin when stdin is not a terminal.
Prints OK (exit 0) or ERROR <code> (exit non-zero; usage errors exit 2, -2 = reply window closed exits 3).`;

const MEDIA_FLAGS = { '--image': 'image', '--video': 'video', '--file': 'file' };

function parseArgs(argv) {
  const out = { to: '', text: [] }; // media / voice keys only appear when those flags are used
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') {
      const v = argv[i + 1];
      if (v === undefined || v === '' || v.startsWith('-')) { out.badTo = v === undefined ? '(missing)' : v === '' ? '(empty)' : v; break; }
      out.to = v; i++;
    } else if (MEDIA_FLAGS[a]) {
      const kind = MEDIA_FLAGS[a];
      if (out.kind && out.kind !== kind) out.conflict = true;
      out.kind = kind; out[kind] = argv[++i] || '';
    } else if (a === '--voice') { out.voice = true; i++; }
    else if (a === '--stdin') out.stdin = true;
    else if (a === '-h' || a === '--help') { out.help = true; return out; }
    else if (a === '--') { out.text.push(...argv.slice(i + 1)); break; }
    else if (a.startsWith('-') && a !== '-') { out.unknown = a; return out; }
    else out.text.push(a);
  }
  return out;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** Count messages sent with this context_token (iLink allows about REPLY_QUOTA per inbound message). */
function bumpSent(P, to, token) {
  const all = F.readJson(P.ctxTokens, {}) || {};
  const e = all[to];
  if (!e || e.token !== token) return;
  e.sent = (e.sent || 0) + 1;
  F.writeJson(P.ctxTokens, all);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }
  const usage = (detail) => { console.log(`ERROR USAGE${detail ? ' ' + detail : ''}`); console.error(USAGE); process.exit(2); };
  if (args.unknown) usage(`unknown option ${args.unknown}`);
  if (args.conflict) usage('use only one of --image, --video, --file per call');
  if (args.badTo) usage(`--to needs a recipient id, got ${args.badTo}`);
  if (args.to && args.to !== 'owner' && recipientProblem(args.to)) usage(`invalid --to: ${recipientProblem(args.to)}`);
  if (args.stdin && args.text.length) usage('use either --stdin or text arguments, not both');
  let cfg;
  try { cfg = C.loadConfig({ requireWebhook: false }); } catch (e) { console.log('ERROR CONFIG'); console.error(e.message); process.exit(2); }
  const P = C.paths(cfg);
  const log = F.makeLogger(P.log);
  const fail = (code, exit, hint) => { console.log(`ERROR ${code}`); if (hint) console.error(hint); log(`reply ERROR ${code}`); process.exit(exit); };

  if (args.voice) fail('UNSUPPORTED', 1, 'voice replies are not supported on WeChat (no official implementation); send text, --image, --video or --file');
  let raw = ''; let mediaPath = ''; let caption = args.text.join(' ');
  if (args.kind) {
    if (!args[args.kind]) fail('NO_FILE', 1, `usage: ./reply.sh --to <user_id> --${args.kind} <file> [--stdin | -- "caption"]`);
    mediaPath = path.resolve(process.env.REPLY_CWD || process.cwd(), args[args.kind]);
    try { KINDS[args.kind].load(mediaPath); } catch (e) { fail(e.code || 'BAD_FILE', 1, e.hint); } // validate before any network call
    try { checkSendablePath(mediaPath, { root: C.ROOT, stateDir: cfg.stateDir, mediaDir: cfg.mediaDir, allowedDirs: cfg.replyAllowedDirs }); }
    catch (e) { fail(e.label || 'FILE_NOT_ALLOWED', 1, e.message); }
    if (args.stdin) caption = await readStdin();
  } else {
    if (args.text.length) raw = args.text.join(' ');
    else if (args.stdin || !process.stdin.isTTY) raw = await readStdin();
    if (!raw || !raw.trim()) fail('EMPTY_TEXT', 1, 'usage: ./reply.sh --to <user_id> --stdin <<\'EOF\' ... (or text after --)');
  }
  if (!args.to) fail('NO_RECIPIENT', 2, '--to is required: pass the payload\'s sender_id (or "owner" for the bound owner)');
  const creds = C.loadCreds(P);
  if (!creds) fail('NO_CREDENTIALS', 1, 'not logged in; run ./login.sh first');
  const to = args.to === 'owner' ? (cfg.ownerId || C.ownerStore(P).get()) : args.to;
  if (!to) fail('NO_RECIPIENT', 1, 'no owner is bound yet: send the bot a message first, set OWNER_ID, or pass --to <user_id>');
  if (recipientProblem(to)) fail('NO_RECIPIENT', 1, `stored owner id is invalid: ${recipientProblem(to)}`);

  try {
    // One reply at a time per bridge, so the per-message quota counter stays right.
    await F.withFileLock(P.replyLock, async () => {
      const entry = (F.readJson(P.ctxTokens, {}) || {})[to];
      if (!entry || !entry.token) fail('NO_CONTEXT_TOKEN', 1, 'this user has not messaged the bot yet (a reply needs the context token from an inbound message)');
      const onSent = () => { try { bumpSent(P, to, entry.token); } catch { /* ignore */ } };
      const used = entry.sent || 0;
      if (used >= REPLY_QUOTA) log(`reply: about ${REPLY_QUOTA} messages already sent for this inbound message; WeChat will likely refuse (-2)`);
      const deps = { to, cdnBaseUrl: cfg.cdnBaseUrl, allowedHosts: cfg.mediaAllowedHosts, onSent,
        send: (item) => ilink.sendMessageItem({ baseUrl: creds.baseurl, token: creds.bot_token, to, item, contextToken: entry.token }),
        getUploadUrl: (params) => ilink.getUploadUrl({ baseUrl: creds.baseurl, token: creds.bot_token, params }) };
      if (mediaPath) {
        const r = await sendMediaReply(args.kind, mediaPath, caption, deps);
        log(`reply ${args.kind} OK ${r.mime} ${r.size}B messages=${r.messages}`);
      } else {
        // Fit the text into what is left of the quota (at least one message is always tried).
        const r = await sendReply(raw, { maxChunks: REPLY_QUOTA - used, onSent,
          send: (text) => ilink.sendTextMessage({ baseUrl: creds.baseurl, token: creds.bot_token, to, text, contextToken: entry.token }) });
        log(`reply OK parts=${r.parts}`);
      }
    });
    console.log('OK');
  } catch (e) {
    if (e && e.label === 'LOCK_TIMEOUT') fail('BUSY', 1, 'another reply is still running');
    if (!(e instanceof ReplyError)) fail('INTERNAL', 1, e.message);
    if (e.code === '-14') F.writeSecure(P.status, 'EXPIRED_-14\n');
    fail(e.code, e.exit, e.hint);
  }
}

module.exports = { sendReply, sendImageReply, sendMediaReply, loadImage, loadVideo, loadFile, ReplyError, parseArgs, USAGE, CHUNK, MAX_CHUNKS,
  MAX_IMAGE_BYTES, MAX_FILE_BYTES, REPLY_QUOTA, bumpSent };
if (require.main === module) main().catch((e) => { console.log('ERROR INTERNAL'); console.error(e.message); process.exit(1); });
