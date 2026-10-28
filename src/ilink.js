'use strict';
// Minimal client for Tencent's WeChat ClawBot "iLink" bot API (https://ilinkai.weixin.qq.com).
// Protocol details follow Tencent's official MIT-licensed package @tencent-weixin/openclaw-weixin.
// All traffic is outbound HTTPS. Never log bot_token, the QR id, or context tokens.
const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '2.4.10'; // protocol version of the official client this implementation follows
const BOT_AGENT = 'grokbot-wechatclaw-bridge/1.0';
const ILINK_APP_ID = 'bot';
const ERR = { SESSION_EXPIRED: -14, REPLY_WINDOW: -2 };
const MSG_TYPE = { USER: 1, BOT: 2 };
const ITEM_TYPE = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 };

function clientVersion(v) {
  const [a = 0, b = 0, c = 0] = v.split('.').map((x) => parseInt(x, 10) || 0);
  return ((a & 0xff) << 16) | ((b & 0xff) << 8) | (c & 0xff);
}
const ILINK_APP_CLIENT_VERSION = String(clientVersion(CHANNEL_VERSION));

/** X-WECHAT-UIN: base64 of the decimal string of a random uint32, new on every request. */
function randomWechatUin() {
  const n = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(n), 'utf8').toString('base64');
}
function baseInfo() { return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }; }
function commonHeaders() { return { 'iLink-App-Id': ILINK_APP_ID, 'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION }; }
function postHeaders(token) {
  const h = { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': randomWechatUin(), ...commonHeaders() };
  if (token && token.trim()) h.Authorization = `Bearer ${token.trim()}`;
  return h;
}

/** Quote uint64 id fields before JSON.parse so they are not rounded. */
function parseIlinkJson(text) {
  if (!text || !text.trim()) return {};
  const fixed = text.replace(/"(message_id|msg_id|svr_id)"(\s*):(\s*)(-?\d+)/g, '"$1"$2:$3"$4"');
  return JSON.parse(fixed);
}

class HttpError extends Error {
  constructor(status, label) { super(`${label} HTTP ${status}`); this.status = status; }
}

function joinUrl(base, endpoint) { return new URL(endpoint, base.endsWith('/') ? base : base + '/').toString(); }

/** Combine a timeout with an optional caller signal. A timeout rejects with name "TimeoutError". */
function requestSignal(timeoutMs = 15_000, signal) {
  const t = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([t, signal]) : t;
}

async function ilinkPost({ baseUrl, endpoint, body, token, timeoutMs, label, signal, fetchImpl = fetch }) {
  const res = await fetchImpl(joinUrl(baseUrl, endpoint), {
    method: 'POST', headers: postHeaders(token), body: JSON.stringify(body), signal: requestSignal(timeoutMs, signal),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, label);
  return parseIlinkJson(text);
}

async function ilinkGet({ baseUrl, endpoint, timeoutMs, label, signal, fetchImpl = fetch }) {
  const res = await fetchImpl(joinUrl(baseUrl, endpoint), { method: 'GET', headers: commonHeaders(), signal: requestSignal(timeoutMs, signal) });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, label);
  return parseIlinkJson(text);
}

function isTimeout(e) { return Boolean(e && (e.name === 'TimeoutError' || (e.cause && e.cause.name === 'TimeoutError'))); }

/** Non-zero errcode/ret from a response, or 0. */
function errCodeOf(resp) {
  if (!resp) return 0;
  // -14 wins wherever it appears, as in the official client (errcode === -14 || ret === -14)
  if (resp.errcode === ERR.SESSION_EXPIRED || resp.ret === ERR.SESSION_EXPIRED) return ERR.SESSION_EXPIRED;
  if (resp.errcode !== undefined && resp.errcode !== 0) return resp.errcode;
  if (resp.ret !== undefined && resp.ret !== 0) return resp.ret;
  return 0;
}

/** Text from TEXT items only (voice transcripts and media are not included). */
function extractText(msg) {
  const items = Array.isArray(msg && msg.item_list) ? msg.item_list : [];
  return items
    .filter((i) => i && i.type === ITEM_TYPE.TEXT && i.text_item && typeof i.text_item.text === 'string')
    .map((i) => i.text_item.text)
    .join('\n')
    .trim();
}

function getUpdates({ baseUrl, token, buf, timeoutMs, signal, fetchImpl }) {
  return ilinkPost({ baseUrl, endpoint: 'ilink/bot/getupdates', body: { get_updates_buf: buf || '', base_info: baseInfo() },
    token, timeoutMs, label: 'getupdates', signal, fetchImpl });
}

/** Voice-to-text transcripts that WeChat attaches to voice items (voice_item.text). */
function extractVoiceTranscripts(msg) {
  const items = Array.isArray(msg && msg.item_list) ? msg.item_list : [];
  return items
    .filter((i) => i && i.type === ITEM_TYPE.VOICE && i.voice_item && typeof i.voice_item.text === 'string' && i.voice_item.text.trim())
    .map((i) => i.voice_item.text.trim());
}

/** Send one message item (text, image, ...) as its own message, as the official client does. */
function sendMessageItem({ baseUrl, token, to, item, contextToken, timeoutMs = 15_000, fetchImpl }) {
  const body = {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: `grokbot-wechatclaw:${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      message_type: MSG_TYPE.BOT,
      message_state: 2, // FINISH
      item_list: [item],
      context_token: contextToken,
    },
    base_info: baseInfo(),
  };
  return ilinkPost({ baseUrl, endpoint: 'ilink/bot/sendmessage', body, token, timeoutMs, label: 'sendmessage', fetchImpl });
}

function sendTextMessage({ baseUrl, token, to, text, contextToken, timeoutMs = 15_000, fetchImpl }) {
  return sendMessageItem({ baseUrl, token, to, item: { type: ITEM_TYPE.TEXT, text_item: { text } }, contextToken, timeoutMs, fetchImpl });
}

/** ilink/bot/getuploadurl: params { filekey, media_type, to_user_id, rawsize, rawfilemd5, filesize, no_need_thumb, aeskey }. */
function getUploadUrl({ baseUrl, token, params, timeoutMs = 15_000, fetchImpl }) {
  return ilinkPost({ baseUrl, endpoint: 'ilink/bot/getuploadurl', body: { ...params, base_info: baseInfo() }, token, timeoutMs, label: 'getuploadurl', fetchImpl });
}

module.exports = {
  DEFAULT_BASE_URL, CHANNEL_VERSION, BOT_AGENT, ERR, MSG_TYPE, ITEM_TYPE, ILINK_APP_CLIENT_VERSION,
  randomWechatUin, baseInfo, postHeaders, commonHeaders, parseIlinkJson, HttpError, ilinkPost, ilinkGet,
  isTimeout, errCodeOf, extractText, extractVoiceTranscripts, getUpdates, sendTextMessage, sendMessageItem, getUploadUrl,
};
