'use strict';
// Inbound WeChat media -> local files. Mirrors the official client (src/media/media-download.ts):
//  - image: key from image_item.aeskey (hex, preferred) else media.aes_key; no key -> plain download;
//  - voice: if voice_item.text (WeChat's transcript) is present it is used as text and nothing is downloaded;
//           otherwise the SILK audio is decrypted and transcoded to WAV (silk-wasm, 24 kHz mono), else kept as .silk;
//  - file / video: need media.aes_key; file keeps its original name (sanitized on disk).
// Download failures never drop the message: the entry is kept with path null and an error label.
const { ITEM_TYPE } = require('./ilink');
const cdn = require('./cdn');
const { sniffMime, mimeFromFilename } = require('./media-store');
const { silkToWav } = require('./silk');

const MAX_MEDIA_PER_MESSAGE = 10;
const KIND = { [ITEM_TYPE.IMAGE]: 'image', [ITEM_TYPE.VOICE]: 'voice', [ITEM_TYPE.FILE]: 'file', [ITEM_TYPE.VIDEO]: 'video' };

function hasMedia(m) { return Boolean(m && (m.encrypt_query_param || m.full_url)); }

/**
 * Media items worth reporting, in message order: [{ kind, item, transcript? , download: boolean }].
 * Items without a downloadable reference are ignored, as in the official client.
 */
function collectMediaItems(msg) {
  const out = [];
  for (const it of Array.isArray(msg && msg.item_list) ? msg.item_list : []) {
    if (!it || !KIND[it.type]) continue;
    if (it.type === ITEM_TYPE.IMAGE) { if (hasMedia(it.image_item && it.image_item.media)) out.push({ kind: 'image', item: it, download: true }); continue; }
    if (it.type === ITEM_TYPE.VOICE) {
      const v = it.voice_item || {};
      const transcript = typeof v.text === 'string' ? v.text.trim() : '';
      if (transcript) out.push({ kind: 'voice', item: it, transcript, download: false });
      else if (hasMedia(v.media) && v.media.aes_key) out.push({ kind: 'voice', item: it, download: true });
      continue;
    }
    const sub = it.type === ITEM_TYPE.FILE ? it.file_item : it.video_item;
    if (sub && hasMedia(sub.media) && sub.media.aes_key) out.push({ kind: KIND[it.type], item: it, download: true });
  }
  return out.slice(0, MAX_MEDIA_PER_MESSAGE);
}

/** Download + decrypt one collected item and save it. Returns a payload media entry. */
async function fetchOne(c, { store, cdnBaseUrl = cdn.CDN_BASE_URL, fetchImpl, transcode = silkToWav }) {
  const it = c.item;
  if (!c.download) return { kind: 'voice', path: null, content_type: null, size: null, transcript: c.transcript };
  const opts = { cdnBaseUrl, fetchImpl, maxBytes: store.maxBytes, allowedHosts: store.allowedHosts };
  try {
    if (c.kind === 'image') {
      const img = it.image_item;
      const key = img.aeskey ? Buffer.from(img.aeskey, 'hex').toString('base64') : img.media.aes_key;
      const buf = key ? await cdn.downloadAndDecrypt(img.media, key, opts) : await cdn.downloadPlain(img.media, opts);
      const ct = sniffMime(buf);
      return { kind: 'image', ...store.save(buf, { kind: 'image', contentType: ct && ct.startsWith('image/') ? ct : undefined }) };
    }
    if (c.kind === 'voice') {
      const v = it.voice_item;
      const silk = await cdn.downloadAndDecrypt(v.media, v.media.aes_key, opts);
      const wav = await transcode(silk);
      const saved = wav ? store.save(wav, { kind: 'voice', contentType: 'audio/wav' }) : store.save(silk, { kind: 'voice', contentType: 'audio/silk' });
      const e = { kind: 'voice', ...saved };
      if (v.playtime) e.duration_ms = Number(v.playtime) || undefined;
      return e;
    }
    if (c.kind === 'file') {
      const f = it.file_item;
      const name = f.file_name || 'file.bin';
      const buf = await cdn.downloadAndDecrypt(f.media, f.media.aes_key, opts);
      return { kind: 'file', ...store.save(buf, { kind: 'file', contentType: mimeFromFilename(name), filename: name }) };
    }
    const buf = await cdn.downloadAndDecrypt(it.video_item.media, it.video_item.media.aes_key, opts);
    return { kind: 'video', ...store.save(buf, { kind: 'video', contentType: 'video/mp4' }) };
  } catch (e) {
    const entry = { kind: c.kind, path: null, content_type: null, size: null, error: e.label || 'DOWNLOAD_FAILED' };
    if (c.kind === 'file' && it.file_item && it.file_item.file_name) entry.filename = String(it.file_item.file_name).slice(0, 200);
    return entry;
  }
}

/** Download every collected item (sequentially, to bound memory). */
async function fetchMedia(collected, deps) {
  const out = [];
  for (const c of collected) out.push(await fetchOne(c, deps));
  return out;
}

module.exports = { collectMediaItems, fetchOne, fetchMedia, MAX_MEDIA_PER_MESSAGE };
