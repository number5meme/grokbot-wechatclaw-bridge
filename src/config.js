'use strict';
// WeChat bridge configuration and on-disk state layout.
const path = require('node:path');
const { loadDotEnv } = require('./env');
const { ConfigError, parseCommon, parseIntStrict, hostAllowed } = require('./config-common');
const F = require('./files');
const { DEFAULT_BASE_URL } = require('./ilink');
const { CDN_BASE_URL } = require('./cdn');

const ROOT = path.join(__dirname, '..');

// STATUS values that need a human. Supervisors must not restart on these.
const FATAL_STATUS = {
  'EXPIRED_-14': 'WeChat session expired (errcode -14). Run ./login.sh, scan the new QR code, then ./start.sh '
    + '(or set EXPIRED_RETRY_AFTER_MIN to pause and retry like the official client)',
  CONFIG_ERROR: 'configuration is invalid. Fix .env (see .env.example), then ./start.sh',
  NO_CREDENTIALS: 'not logged in. Run ./login.sh and scan the QR code, then ./start.sh',
};
const EXIT = { OK: 0, CRASH: 1, CONFIG: 2, EXPIRED: 14 };

/** Load .env (unless disabled) and parse. Throws ConfigError. */
function loadConfig({ env = process.env, root = ROOT, requireWebhook = true, dotenv = true } = {}) {
  if (dotenv && env.BRIDGE_NO_DOTENV !== '1') loadDotEnv(path.join(root, '.env'), env);
  const { cfg, errors } = parseCommon(env, { root, requireWebhook });
  cfg.cdnBaseUrl = (env.WECHAT_CDN_BASE_URL || CDN_BASE_URL).trim().replace(/\/+$/, '');
  let cdnHost = '';
  try { const u = new URL(cfg.cdnBaseUrl); cdnHost = u.protocol === 'https:' ? u.hostname : ''; } catch { /* invalid */ }
  if (!cdnHost) errors.push('WECHAT_CDN_BASE_URL must be an https URL');
  else if (!hostAllowed(cdnHost, cfg.mediaAllowedHosts)) errors.push('WECHAT_CDN_BASE_URL host must be in the media host allowlist (weixin.qq.com, or MEDIA_ALLOWED_HOSTS)');
  // -14 handling: 0 (default) stops the bridge for a new QR login; N > 0 pauses N minutes and polls again, as the
  // official client does (it pauses 60 minutes).
  cfg.expiredRetryAfterMin = parseIntStrict(env.EXPIRED_RETRY_AFTER_MIN, 0);
  if (Number.isNaN(cfg.expiredRetryAfterMin) || cfg.expiredRetryAfterMin > 1440) errors.push('EXPIRED_RETRY_AFTER_MIN must be an integer from 0 to 1440 (0 = stop and wait for a new login)');
  if (errors.length) throw new ConfigError(errors);
  return cfg;
}

function paths(cfg) {
  const s = (f) => path.join(cfg.stateDir, f);
  return {
    creds: s('credentials.json'),
    syncBuf: s('sync.json'),
    ctxTokens: s('context-tokens.json'),
    owner: s('owner.json'),
    lastSender: s('last-sender.json'),
    stats: s('stats.json'),
    status: s('STATUS'),
    heartbeat: s('HEARTBEAT'),
    health: s('health.json'),
    pid: s('bridge.pid'),
    loginState: s('LOGIN_STATE'),
    loginLog: s('login-status.txt'),
    undelivered: s('undelivered.jsonl'),
    seen: s('seen.json'),
    replyLock: s('reply.lock'),
    qrPng: s('qr.png'),
    qrLink: s('qr-link.txt'),
    verifyCode: s('verify_code.txt'),
    log: path.join(cfg.logDir, 'bridge.log'),
  };
}

/** The bot token is sent to baseurl, so only https on a Tencent host (*.qq.com, *.wechat.com) is accepted (else the default). */
function safeBaseUrl(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  try { const u = new URL(s); if (u.protocol === 'https:' && hostAllowed(u.hostname, ['qq.com', 'wechat.com'])) return s; } catch { /* invalid */ }
  return DEFAULT_BASE_URL;
}

function loadCreds(P) {
  const c = F.readJson(P.creds, null);
  if (!c || !c.bot_token) return null;
  c.baseurl = safeBaseUrl(c.baseurl);
  return c;
}

const UNDELIVERED_MAX_BYTES = 50 * 1024 * 1024; // undelivered.jsonl is rotated to .1 at this size
const CTX_TOKENS_MAX = 500; // context tokens kept (most recent senders)
const SEEN_FILE_MAX = 500;

/** Owner binding: explicit owner.json, else the account that completed QR login. */
function ownerStore(P) {
  return {
    get: () => {
      const o = F.readJson(P.owner, null);
      if (o && o.owner_id) return o.owner_id;
      const c = F.readJson(P.creds, null);
      return (c && c.login_user_id) || null;
    },
    set: (id) => F.writeJson(P.owner, { owner_id: id, bound_at: new Date().toISOString() }),
  };
}
function statsStore(P) { return { load: () => F.readJson(P.stats, null), save: (o) => F.writeJson(P.stats, o) }; }

/**
 * Remember the newest context_token per sender (needed to reply), capped at CTX_TOKENS_MAX senders.
 * A new token starts a new reply window, so its sent-message counter is reset.
 */
function saveContextToken(P, userId, token, now = new Date()) {
  const all = F.readJson(P.ctxTokens, {}) || {};
  const prev = all[userId];
  all[userId] = { token, at: now.toISOString(), sent: prev && prev.token === token ? prev.sent || 0 : 0 };
  const keys = Object.keys(all);
  if (keys.length > CTX_TOKENS_MAX) {
    keys.sort((a, b) => String(all[a].at || '').localeCompare(String(all[b].at || '')));
    for (const k of keys.slice(0, keys.length - CTX_TOKENS_MAX)) delete all[k];
  }
  F.writeJson(P.ctxTokens, all);
}

module.exports = { ROOT, saveContextToken, FATAL_STATUS, EXIT, ConfigError, loadConfig, paths, loadCreds, safeBaseUrl, ownerStore, statsStore,
  UNDELIVERED_MAX_BYTES, CTX_TOKENS_MAX, SEEN_FILE_MAX };
