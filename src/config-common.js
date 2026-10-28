'use strict';
// Channel-independent configuration (kept identical in the sibling project grokbot-qqbot-bridge). Everything comes from environment variables (or a .env file).
const path = require('node:path');

class ConfigError extends Error {
  constructor(errors) { super(`invalid configuration:\n  - ${errors.join('\n  - ')}`); this.errors = errors; }
}

function parseBool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  return null;
}
function parseIntStrict(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return /^\d+$/.test(String(v).trim()) ? parseInt(v, 10) : NaN;
}
function parseList(v) { return String(v || '').split(',').map((s) => s.trim()).filter(Boolean); }
function isLocalHost(host) { return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'; }

// Hosts that inbound media may be downloaded from (suffix match). Tencent serves QQ attachments from
// *.qq.com / *.qq.com.cn / *.qpic.cn and WeChat media from *.weixin.qq.com. MEDIA_ALLOWED_HOSTS adds more.
const DEFAULT_MEDIA_HOSTS = ['qq.com', 'qq.com.cn', 'qpic.cn', 'qlogo.cn', 'weixin.qq.com', 'wechat.com'];

/** True when hostname equals one of the suffixes or is a subdomain of one. */
function hostAllowed(hostname, suffixes) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  return (suffixes || []).some((sfx) => { const x = String(sfx).toLowerCase().replace(/^\*?\./, ''); return x && (h === x || h.endsWith(`.${x}`)); });
}

/**
 * Parse common settings. Returns { cfg, errors } (does not throw).
 * requireWebhook: the bridge needs it; reply/healthcheck do not.
 */
function parseCommon(env, { root, requireWebhook = true } = {}) {
  const errors = [];
  const cfg = {};

  cfg.webhookUrl = (env.FORWARD_WEBHOOK_URL || '').trim();
  cfg.webhookAuth = (env.FORWARD_WEBHOOK_AUTH || '').trim();
  if (!cfg.webhookUrl) {
    if (requireWebhook) errors.push('FORWARD_WEBHOOK_URL is required (the HTTP endpoint that receives forwarded messages)');
  } else {
    let u = null;
    try { u = new URL(cfg.webhookUrl); } catch { errors.push('FORWARD_WEBHOOK_URL is not a valid URL'); }
    if (u) {
      if (u.protocol !== 'https:' && u.protocol !== 'http:') errors.push('FORWARD_WEBHOOK_URL must be http(s)');
      else if (u.protocol === 'http:' && !isLocalHost(u.hostname) && parseBool(env.FORWARD_ALLOW_INSECURE_HTTP, false) !== true) {
        errors.push('FORWARD_WEBHOOK_URL must use https (http is only allowed for localhost, or set FORWARD_ALLOW_INSECURE_HTTP=1)');
      }
    }
  }
  if (/[\r\n]/.test(cfg.webhookAuth)) errors.push('FORWARD_WEBHOOK_AUTH must be a single line');

  const prot = parseBool(env.OWNER_PROTECTION, false); // off by default; setup asks
  if (prot === null) errors.push('OWNER_PROTECTION must be on or off');
  cfg.protection = prot === true;
  cfg.ownerId = (env.OWNER_ID || '').trim();
  cfg.allowlist = parseList(env.ALLOWLIST);

  const mirror = parseBool(env.MIRROR_TO_MAIN_CHAT, true);
  if (mirror === null) errors.push('MIRROR_TO_MAIN_CHAT must be true or false');
  cfg.mirror = mirror !== false;

  cfg.rateLimitPerMin = parseIntStrict(env.RATE_LIMIT_PER_MIN, 20);
  if (Number.isNaN(cfg.rateLimitPerMin)) errors.push('RATE_LIMIT_PER_MIN must be a non-negative integer (0 disables)');
  cfg.globalRateLimitPerMin = parseIntStrict(env.GLOBAL_RATE_LIMIT_PER_MIN, 60);
  if (Number.isNaN(cfg.globalRateLimitPerMin)) errors.push('GLOBAL_RATE_LIMIT_PER_MIN must be a non-negative integer (0 disables)');
  cfg.maxMessageChars = parseIntStrict(env.MAX_MESSAGE_CHARS, 4000);
  if (Number.isNaN(cfg.maxMessageChars)) errors.push('MAX_MESSAGE_CHARS must be a non-negative integer (0 disables)');
  cfg.healthStaleSeconds = parseIntStrict(env.HEALTH_STALE_SECONDS, 180);
  if (Number.isNaN(cfg.healthStaleSeconds) || cfg.healthStaleSeconds < 30) errors.push('HEALTH_STALE_SECONDS must be an integer >= 30');

  cfg.stateDir = path.resolve(root, env.STATE_DIR || 'state');
  cfg.logDir = path.resolve(root, env.LOG_DIR || 'logs');

  // Inbound media (images, voice, files, video): downloaded to MEDIA_DIR and listed in the payload's "media" array.
  // ACCEPT_MEDIA (formerly FORWARD_MEDIA; the old name is still read when ACCEPT_MEDIA is unset).
  const mediaKey = env.ACCEPT_MEDIA !== undefined && env.ACCEPT_MEDIA !== '' ? 'ACCEPT_MEDIA'
    : (env.FORWARD_MEDIA !== undefined && env.FORWARD_MEDIA !== '' ? 'FORWARD_MEDIA' : 'ACCEPT_MEDIA');
  const media = parseBool(env[mediaKey], true);
  if (media === null) errors.push(`${mediaKey} must be true or false`);
  cfg.acceptMedia = media !== false;
  cfg.mediaDir = env.MEDIA_DIR ? path.resolve(root, env.MEDIA_DIR) : path.join(cfg.stateDir, 'media');
  const maxMb = parseIntStrict(env.MEDIA_MAX_MB, 100);
  if (Number.isNaN(maxMb) || maxMb < 1 || maxMb > 1024) errors.push('MEDIA_MAX_MB must be an integer from 1 to 1024');
  cfg.mediaMaxBytes = (Number.isNaN(maxMb) ? 100 : maxMb) * 1024 * 1024;
  cfg.mediaRetentionDays = parseIntStrict(env.MEDIA_RETENTION_DAYS, 7);
  if (Number.isNaN(cfg.mediaRetentionDays)) errors.push('MEDIA_RETENTION_DAYS must be a non-negative integer (0 keeps files forever)');
  const extraHosts = parseList(env.MEDIA_ALLOWED_HOSTS);
  if (extraHosts.some((h) => !/^(\*\.)?\.?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(h))) errors.push('MEDIA_ALLOWED_HOSTS must be a comma-separated list of host names (e.g. cdn.example.com)');
  cfg.mediaAllowedHosts = [...DEFAULT_MEDIA_HOSTS, ...extraHosts];

  // Outbound files (reply.sh --image/--file/...): optional allowlist of directories (colon- or comma-separated).
  cfg.replyAllowedDirs = String(env.REPLY_ALLOWED_DIRS || '').split(/[:,]/).map((s) => s.trim()).filter(Boolean).map((d) => path.resolve(root, d));
  return { cfg, errors };
}

module.exports = { ConfigError, parseCommon, parseBool, parseIntStrict, parseList, hostAllowed, DEFAULT_MEDIA_HOSTS };
