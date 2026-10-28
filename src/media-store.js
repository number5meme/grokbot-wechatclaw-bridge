'use strict';
// Local storage for inbound media (kept identical in the sibling project grokbot-qqbot-bridge).
//  - files are written under MEDIA_DIR with private permissions (dir 0700, files 0600);
//  - file names are generated (time + random + sanitized original name), never taken verbatim from the sender;
//  - downloads are capped at MEDIA_MAX_MB; only https URLs on allowed hosts are fetched, and every redirect hop
//    is checked the same way (no redirect to http or to another host);
//  - files older than MEDIA_RETENTION_DAYS are removed by cleanup(); only files whose names this store
//    generated are touched, so pointing MEDIA_DIR at a shared folder cannot delete unrelated files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const F = require('./files');
const { hostAllowed, DEFAULT_MEDIA_HOSTS } = require('./config-common');

/** Names written by save(): 20260110T120000-0a1b2c3d-<stem>.<ext> */
const GENERATED_NAME = /^\d{8}T\d{6}-[0-9a-f]{8}-[A-Za-z0-9._-]+$/;
const MAX_REDIRECTS = 3;

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
  'audio/wav': 'wav', 'audio/silk': 'silk', 'audio/mpeg': 'mp3', 'audio/amr': 'amr', 'audio/ogg': 'ogg',
  'video/mp4': 'mp4', 'application/pdf': 'pdf', 'text/plain': 'txt', 'application/zip': 'zip',
};
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  wav: 'audio/wav', silk: 'audio/silk', slk: 'audio/silk', mp3: 'audio/mpeg', amr: 'audio/amr', ogg: 'audio/ogg',
  mp4: 'video/mp4', mov: 'video/quicktime', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', json: 'application/json', zip: 'application/zip', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function labeled(label, msg = label) { const e = new Error(msg); e.label = label; return e; }

/** Detect a few common formats by magic bytes. Returns a MIME type or null. */
function sniffMime(buf) {
  if (!buf || !buf.length) return null;
  const head = (n) => buf.subarray(0, n);
  if (buf.length >= 8 && head(8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(head(6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && head(4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && head(4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (buf.length >= 2 && head(2).toString('latin1') === 'BM') return 'image/bmp';
  if (isSilk(buf)) return 'audio/silk';
  if (buf.length >= 5 && head(5).toString('latin1') === '#!AMR') return 'audio/amr';
  if (buf.length >= 3 && head(3).toString('latin1') === 'ID3') return 'audio/mpeg';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buf.length >= 4 && head(4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (buf.length >= 8 && buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'video/mp4';
  if (buf.length >= 5 && head(5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/** SILK v3 header, optionally preceded by the 0x02 byte that Tencent apps prepend. */
function isSilk(buf) {
  if (!buf || buf.length < 9) return false;
  if (buf.subarray(0, 9).toString('latin1') === '#!SILK_V3') return true;
  return buf.length >= 10 && buf[0] === 0x02 && buf.subarray(1, 10).toString('latin1') === '#!SILK_V3';
}

function mimeFromFilename(name) {
  const ext = path.extname(String(name || '')).slice(1).toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

/** Keep only [A-Za-z0-9._-] (non-ASCII names become "file"), max 80 chars, never a hidden or empty name. */
function safeName(name) {
  const base = path.basename(String(name || '')).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(-80);
  return base && /[A-Za-z0-9]/.test(base) ? base : 'file';
}

/**
 * dir: absolute media directory; maxBytes: per-file cap; retentionDays: cleanup age (0 disables cleanup).
 * save(buf, { kind, contentType, filename }) -> { path, size, content_type, filename? }
 */
function createMediaStore({ dir, maxBytes = 100 * 1024 * 1024, retentionDays = 7, now = Date.now, allowedHosts = DEFAULT_MEDIA_HOSTS }) {
  function save(buf, { kind = 'file', contentType, filename } = {}) {
    if (!Buffer.isBuffer(buf) || !buf.length) throw labeled('EMPTY_MEDIA', 'media is empty');
    if (buf.length > maxBytes) throw labeled('TOO_LARGE', `media is larger than ${Math.round(maxBytes / 1048576)}MB`);
    const ct = contentType || sniffMime(buf) || (filename ? mimeFromFilename(filename) : 'application/octet-stream');
    let ext = MIME_EXT[ct] || (filename && path.extname(filename).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '')) || 'bin';
    if (ext.length > 8) ext = 'bin';
    const stem = filename ? safeName(filename).replace(/\.[A-Za-z0-9]{1,8}$/, '') : kind;
    const name = `${new Date(now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-${crypto.randomBytes(4).toString('hex')}-${stem}.${ext}`;
    const file = path.join(dir, name);
    F.writeSecure(file, buf);
    const out = { path: file, size: buf.length, content_type: ct };
    if (filename) out.filename = String(filename).slice(0, 200);
    return out;
  }

  /** Remove regular files older than retentionDays that this store created. Returns the number removed. */
  function cleanup() {
    if (!(retentionDays > 0)) return 0;
    const cutoff = now() - retentionDays * 86_400_000;
    let removed = 0; let names = [];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    for (const n of names) {
      if (!GENERATED_NAME.test(n)) continue;
      const p = path.join(dir, n);
      try {
        const st = fs.lstatSync(p);
        if (st.isFile() && st.mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
      } catch { /* ignore */ }
    }
    return removed;
  }

  return { dir, maxBytes, retentionDays, allowedHosts, save, cleanup };
}

/**
 * GET an https URL into a Buffer with a size cap. Throws Error with .label:
 * BAD_URL, NOT_HTTPS, HOST_NOT_ALLOWED, TOO_MANY_REDIRECTS, TOO_LARGE, HTTP_<status>, TIMEOUT, NETWORK.
 * allowedHosts: host suffixes (default: Tencent media hosts); null disables the host check.
 * Redirects are followed manually (at most 3), and each hop must pass the same https + host checks.
 * The URL is never put in the error message.
 */
async function fetchLimited(url, { fetchImpl = fetch, maxBytes = 100 * 1024 * 1024, timeoutMs = 120_000, headers, allowedHosts = DEFAULT_MEDIA_HOSTS } = {}) {
  const check = (raw, base) => {
    let u;
    try { u = new URL(String(raw), base); } catch { throw labeled('BAD_URL', 'invalid media URL'); }
    if (u.protocol !== 'https:') throw labeled('NOT_HTTPS', 'only https media URLs are downloaded');
    if (allowedHosts && !hostAllowed(u.hostname, allowedHosts)) throw labeled('HOST_NOT_ALLOWED', 'media host is not in the allowlist (MEDIA_ALLOWED_HOSTS)');
    return u;
  };
  let u = check(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    for (let hop = 0; ; hop++) {
      try { res = await fetchImpl(u.toString(), { method: 'GET', headers, signal: ctrl.signal, redirect: 'manual' }); } catch (e) {
        throw labeled(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', 'media download failed');
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
        try { await res.text(); } catch { /* ignore */ }
        if (!loc) throw labeled(`HTTP_${res.status}`, `media download HTTP ${res.status}`);
        if (hop >= MAX_REDIRECTS) throw labeled('TOO_MANY_REDIRECTS', 'media download redirected too often');
        u = check(loc, u);
        continue;
      }
      break;
    }
    if (!res.ok) { try { await res.text(); } catch { /* ignore */ } throw labeled(`HTTP_${res.status}`, `media download HTTP ${res.status}`); }
    const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
    if (Number.isFinite(len) && len > maxBytes) throw labeled('TOO_LARGE', 'media is larger than the cap');
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader(); const parts = []; let n = 0;
      for (;;) {
        let r;
        try { r = await reader.read(); } catch (e) { throw labeled(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', 'media download failed'); }
        if (r.done) break;
        n += r.value.byteLength;
        if (n > maxBytes) { try { await reader.cancel(); } catch { /* ignore */ } throw labeled('TOO_LARGE', 'media is larger than the cap'); }
        parts.push(Buffer.from(r.value));
      }
      return Buffer.concat(parts, n);
    }
    let ab;
    try { ab = await res.arrayBuffer(); } catch (e) { throw labeled(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', 'media download failed'); }
    const buf = Buffer.from(ab);
    if (buf.length > maxBytes) throw labeled('TOO_LARGE', 'media is larger than the cap');
    return buf;
  } finally { clearTimeout(t); }
}

module.exports = { GENERATED_NAME, createMediaStore, fetchLimited, sniffMime, isSilk, mimeFromFilename, safeName, labeled, MIME_EXT, EXT_MIME };
