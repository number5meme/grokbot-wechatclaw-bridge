'use strict';
// WeChat (iLink) CDN media: AES-128-ECB encrypted upload and download.
// Mirrors Tencent's official MIT-licensed @tencent-weixin/openclaw-weixin (src/cdn/aes-ecb.ts, cdn-url.ts,
// pic-decrypt.ts, cdn-upload.ts, upload.ts). Never log keys, encrypted query params, or full CDN URLs.
const crypto = require('node:crypto');
const { fetchLimited, labeled } = require('./media-store');
const { hostAllowed, DEFAULT_MEDIA_HOSTS } = require('./config-common');

const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const MEDIA_MAX_BYTES = 100 * 1024 * 1024; // WEIXIN_MEDIA_MAX_BYTES in the official client
const UPLOAD_MAX_RETRIES = 3;
const UPLOAD_MEDIA_TYPE = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 }; // proto UploadMediaType

/** AES-128-ECB with PKCS7 padding (Node's default). */
function encryptAesEcb(plain, key) { const c = crypto.createCipheriv('aes-128-ecb', key, null); return Buffer.concat([c.update(plain), c.final()]); }
function decryptAesEcb(cipher, key) { const d = crypto.createDecipheriv('aes-128-ecb', key, null); return Buffer.concat([d.update(cipher), d.final()]); }
/** Ciphertext size after PKCS7 padding to a 16-byte boundary. */
function aesEcbPaddedSize(n) { return Math.ceil((n + 1) / 16) * 16; }

/**
 * CDNMedia.aes_key -> 16-byte key. Two encodings exist: base64(16 raw bytes) (images) and
 * base64(32-char hex string) (file / voice / video).
 */
function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(String(aesKeyBase64 || ''), 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) return Buffer.from(decoded.toString('ascii'), 'hex');
  throw labeled('BAD_AES_KEY', `aes_key must decode to 16 bytes or a 32-char hex string (got ${decoded.length} bytes)`);
}

function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl = CDN_BASE_URL) {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}
function buildCdnUploadUrl({ cdnBaseUrl = CDN_BASE_URL, uploadParam, filekey }) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

/** Download URL: full_url when the server sent one, else built from encrypt_query_param (official fallback). */
function mediaUrl(media, cdnBaseUrl) {
  if (media && media.full_url) return media.full_url;
  if (media && media.encrypt_query_param) return buildCdnDownloadUrl(media.encrypt_query_param, cdnBaseUrl);
  throw labeled('NO_MEDIA_URL', 'media has neither full_url nor encrypt_query_param');
}

/** Download + AES-128-ECB decrypt. aesKeyBase64 as in CDNMedia.aes_key. */
async function downloadAndDecrypt(media, aesKeyBase64, { cdnBaseUrl = CDN_BASE_URL, fetchImpl, maxBytes = MEDIA_MAX_BYTES, allowedHosts = DEFAULT_MEDIA_HOSTS } = {}) {
  const key = parseAesKey(aesKeyBase64);
  const enc = await fetchLimited(mediaUrl(media, cdnBaseUrl), { fetchImpl, maxBytes: maxBytes + 16, allowedHosts });
  let plain;
  try { plain = decryptAesEcb(enc, key); } catch { throw labeled('DECRYPT_FAILED', 'media could not be decrypted'); }
  if (plain.length > maxBytes) throw labeled('TOO_LARGE', 'media is larger than the cap');
  return plain;
}
/** Download without decryption (images that carry no key). */
async function downloadPlain(media, { cdnBaseUrl = CDN_BASE_URL, fetchImpl, maxBytes = MEDIA_MAX_BYTES, allowedHosts = DEFAULT_MEDIA_HOSTS } = {}) {
  return fetchLimited(mediaUrl(media, cdnBaseUrl), { fetchImpl, maxBytes, allowedHosts });
}

/**
 * Encrypt and POST one buffer to the CDN; returns the download param from the x-encrypted-param header.
 * Retries up to 3 times on server/network errors; a 4xx aborts at once (as in the official client).
 */
async function uploadBufferToCdn({ buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl = CDN_BASE_URL, aeskey, fetchImpl = fetch,
  timeoutMs = 120_000, attempts = UPLOAD_MAX_RETRIES, allowedHosts = DEFAULT_MEDIA_HOSTS }) {
  const ciphertext = encryptAesEcb(buf, aeskey);
  const full = uploadFullUrl && String(uploadFullUrl).trim();
  let url;
  if (full) url = full;
  else if (uploadParam) url = buildCdnUploadUrl({ cdnBaseUrl, uploadParam, filekey });
  else throw labeled('UPLOAD_URL_MISSING', 'getuploadurl returned neither upload_full_url nor upload_param');
  let host = '';
  try { const u = new URL(url); host = u.protocol === 'https:' ? u.hostname : ''; } catch { /* invalid */ }
  if (!host || (allowedHosts && !hostAllowed(host, allowedHosts))) throw labeled('UPLOAD_URL_REJECTED', 'upload URL is not an https URL on an allowed host');
  let last = labeled('CDN_UPLOAD_FAILED');
  for (let i = 1; i <= attempts; i++) {
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(ciphertext),
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch (e) { last = labeled(e && e.name === 'TimeoutError' ? 'CDN_TIMEOUT' : 'CDN_NETWORK', 'CDN upload failed'); continue; }
    if (res.status >= 400 && res.status < 500) { try { await res.text(); } catch { /* ignore */ } throw labeled(`CDN_HTTP_${res.status}`, `CDN upload rejected (HTTP ${res.status})`); }
    if (res.status !== 200) { try { await res.text(); } catch { /* ignore */ } last = labeled(`CDN_HTTP_${res.status}`, `CDN upload server error (HTTP ${res.status})`); continue; }
    const param = res.headers && res.headers.get('x-encrypted-param');
    if (!param) { last = labeled('CDN_NO_PARAM', 'CDN response is missing the x-encrypted-param header'); continue; }
    return { downloadParam: param };
  }
  throw last;
}

/**
 * Full upload pipeline (official uploadMediaToCdn): md5 + sizes -> getuploadurl -> encrypted CDN POST.
 * getUploadUrl(body) must call ilink/bot/getuploadurl and resolve with its JSON response.
 * Returns { filekey, downloadParam, aeskeyHex, fileSize, fileSizeCiphertext }.
 */
async function uploadMedia({ buf, toUserId, mediaType = UPLOAD_MEDIA_TYPE.IMAGE, getUploadUrl, cdnBaseUrl = CDN_BASE_URL, fetchImpl, randomBytes = crypto.randomBytes,
  allowedHosts = DEFAULT_MEDIA_HOSTS }) {
  const rawsize = buf.length;
  const rawfilemd5 = crypto.createHash('md5').update(buf).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString('hex');
  const aeskey = randomBytes(16);
  const resp = await getUploadUrl({ filekey, media_type: mediaType, to_user_id: toUserId, rawsize, rawfilemd5, filesize,
    no_need_thumb: true, aeskey: aeskey.toString('hex') });
  const uploadFullUrl = resp && resp.upload_full_url ? String(resp.upload_full_url).trim() : '';
  const uploadParam = resp && resp.upload_param;
  if (!uploadFullUrl && !uploadParam) throw labeled('UPLOAD_URL_MISSING', 'getuploadurl returned neither upload_full_url nor upload_param');
  const { downloadParam } = await uploadBufferToCdn({ buf, uploadFullUrl, uploadParam, filekey, cdnBaseUrl, aeskey, fetchImpl, allowedHosts });
  return { filekey, downloadParam, aeskeyHex: aeskey.toString('hex'), fileSize: rawsize, fileSizeCiphertext: filesize };
}

/** image_item for sendmessage (official sendImageMessageWeixin): aes_key is base64 of the hex key string. */
function buildImageItem(uploaded) {
  return {
    type: 2,
    image_item: {
      media: { encrypt_query_param: uploaded.downloadParam, aes_key: Buffer.from(uploaded.aeskeyHex).toString('base64'), encrypt_type: 1 },
      mid_size: uploaded.fileSizeCiphertext,
    },
  };
}

/** video_item for sendmessage (official sendVideoMessageWeixin): video_size is the ciphertext size. */
function buildVideoItem(uploaded) {
  return {
    type: 5,
    video_item: {
      media: { encrypt_query_param: uploaded.downloadParam, aes_key: Buffer.from(uploaded.aeskeyHex).toString('base64'), encrypt_type: 1 },
      video_size: uploaded.fileSizeCiphertext,
    },
  };
}

/** file_item for sendmessage (official sendFileMessageWeixin): file_name plus len = plaintext size as a string. */
function buildFileItem(uploaded, fileName) {
  return {
    type: 4,
    file_item: {
      media: { encrypt_query_param: uploaded.downloadParam, aes_key: Buffer.from(uploaded.aeskeyHex).toString('base64'), encrypt_type: 1 },
      file_name: fileName,
      len: String(uploaded.fileSize),
    },
  };
}

module.exports = {
  buildVideoItem, buildFileItem,
  CDN_BASE_URL, MEDIA_MAX_BYTES, UPLOAD_MEDIA_TYPE, encryptAesEcb, decryptAesEcb, aesEcbPaddedSize, parseAesKey,
  buildCdnDownloadUrl, buildCdnUploadUrl, mediaUrl, downloadAndDecrypt, downloadPlain, uploadBufferToCdn, uploadMedia, buildImageItem,
};
