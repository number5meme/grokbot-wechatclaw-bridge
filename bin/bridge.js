#!/usr/bin/env node
'use strict';
// WeChat ClawBot -> webhook forwarder. Outbound HTTPS only: it never listens on a port.
// Usage: node bin/bridge.js            run in the foreground (start.sh runs it in the background)
//        node bin/bridge.js --check    validate configuration and credentials, then exit
// Exit codes: 0 stopped, 1 crash, 2 configuration / not logged in / already running, 14 session expired (-14, needs QR
// re-login; with EXPIRED_RETRY_AFTER_MIN > 0 the bridge pauses and polls again instead).
const fs = require('node:fs');
const C = require('../src/config');
const F = require('../src/files');
const ilink = require('../src/ilink');
const { createGuard } = require('../src/guard');
const { postWebhook } = require('../src/webhook');
const { Poller, FatalError } = require('../src/poller');
const { handleMessages } = require('../src/handler');
const { createMediaStore } = require('../src/media-store');
const { fetchMedia } = require('../src/media');

const STOP_GRACE_MS = Number(process.env.BRIDGE_STOP_GRACE_MS) || 10_000;

function main() {
  let cfg;
  try { cfg = C.loadConfig(); } catch (e) {
    if (e instanceof C.ConfigError) { console.error(`ERROR ${e.message}`); process.exit(C.EXIT.CONFIG); }
    throw e;
  }
  const P = C.paths(cfg);
  F.ensureDir(cfg.stateDir); F.ensureDir(cfg.logDir);
  const log = F.makeLogger(P.log, { echo: process.env.BRIDGE_LOG_STDERR === '1' });
  const setStatus = (s) => { try { F.writeSecure(P.status, s + '\n'); } catch (e) { log(`cannot write STATUS: ${e.code || e.message}`); } };
  const creds = C.loadCreds(P);
  if (!creds) {
    const m = 'ERROR not logged in (no credentials). Run ./login.sh and scan the QR code.';
    console.error(m); log(m); setStatus('NO_CREDENTIALS'); process.exit(C.EXIT.CONFIG);
  }
  if (process.argv.includes('--check')) {
    console.log(`config OK (owner protection ${cfg.protection ? 'on' : 'off'}, mirror ${cfg.mirror}, media ${cfg.acceptMedia ? 'on' : 'off'}, credentials present)`);
    process.exit(0);
  }

  const lock = F.acquirePidLock(P.pid);
  if (!lock.ok) { console.error(`ERROR another bridge is already running from this state folder (pid ${lock.pid})`); process.exit(C.EXIT.CONFIG); }
  const removePid = () => { try { if (F.readText(P.pid) === String(process.pid)) fs.unlinkSync(P.pid); } catch { /* ignore */ } };
  process.on('exit', removePid);
  const crash = (what, e) => {
    log(`crash (${what}): ${e && e.message}`); setStatus('CRASHED'); removePid(); process.exit(C.EXIT.CRASH);
  };
  process.on('uncaughtException', (e) => crash('uncaught exception', e));
  process.on('unhandledRejection', (e) => crash('unhandled rejection', e));
  const ctrl = new AbortController();

  const guard = createGuard({ protection: cfg.protection, explicitOwner: cfg.ownerId, ownerStore: C.ownerStore(P),
    allowlist: cfg.allowlist, rateLimitPerMin: cfg.rateLimitPerMin, globalRateLimitPerMin: cfg.globalRateLimitPerMin, maxChars: cfg.maxMessageChars, logFn: log, statsStore: C.statsStore(P) });
  const forward = (payload) => postWebhook(payload, { url: cfg.webhookUrl, auth: cfg.webhookAuth, logFn: log, userAgent: ilink.BOT_AGENT });
  // Dedupe list survives restarts, so a batch redelivered after a crash or stop is not forwarded twice.
  const seenList = F.readJson(P.seen, []);
  const seen = new Set(Array.isArray(seenList) ? seenList.slice(-C.SEEN_FILE_MAX).map(String) : []);
  const markSeen = () => { try { F.writeJson(P.seen, [...seen].slice(-C.SEEN_FILE_MAX)); } catch { /* ignore */ } };
  let mediaFetch = null;
  if (cfg.acceptMedia) {
    const mediaStore = createMediaStore({ dir: cfg.mediaDir, maxBytes: cfg.mediaMaxBytes, retentionDays: cfg.mediaRetentionDays, allowedHosts: cfg.mediaAllowedHosts });
    const sweep = () => { const n = mediaStore.cleanup(); if (n) log(`media cleanup removed ${n} file(s) older than ${cfg.mediaRetentionDays} day(s)`); };
    sweep(); setInterval(sweep, 60 * 60_000).unref();
    mediaFetch = (collected) => fetchMedia(collected, { store: mediaStore, cdnBaseUrl: cfg.cdnBaseUrl });
  }
  const health = F.readJson(P.health, {}) || {};
  const saveHealth = () => F.writeJson(P.health, health);

  const poller = new Poller({
    getUpdates: ({ buf, timeoutMs, signal }) => ilink.getUpdates({ baseUrl: creds.baseurl, token: creds.bot_token, buf, timeoutMs, signal }),
    onMessages: (msgs) => handleMessages(msgs, {
      guard, forward, mirror: cfg.mirror, seen, markSeen, logFn: log, fetchMedia: mediaFetch,
      saveToken: (u, t) => C.saveContextToken(P, u, t),
      saveLastSender: (u) => F.writeJson(P.lastSender, { sender_id: u, at: new Date().toISOString() }),
      saveUndelivered: (p) => F.appendSecure(P.undelivered, JSON.stringify(p) + '\n', { maxBytes: C.UNDELIVERED_MAX_BYTES }),
    }),
    loadBuf: () => (F.readJson(P.syncBuf, {}) || {}).get_updates_buf || '',
    saveBuf: (b) => F.writeJson(P.syncBuf, { get_updates_buf: b }),
    setStatus,
    beat: () => F.writeSecure(P.heartbeat, `${Date.now()}\n`),
    onWake: (reason, driftMs) => { health.last_wake_at = new Date().toISOString(); health.last_wake_drift_ms = Math.max(0, Math.round(driftMs || 0)); try { saveHealth(); } catch { /* ignore */ } },
    recordError: (why) => { health.last_error = why; health.last_error_at = new Date().toISOString(); try { saveHealth(); } catch { /* ignore */ } },
    logFn: log,
    expiredRetryAfterMs: cfg.expiredRetryAfterMin * 60_000,
  });

  // Graceful stop: stop polling, and give the batch being handled up to STOP_GRACE_MS. If it does not finish,
  // exit without saving the cursor: the server redelivers the batch on the next start and the handled
  // messages are skipped by the persisted dedupe list.
  let stopping = false;
  let running = null;
  const stop = async (sig) => {
    if (stopping) return; stopping = true;
    log(`received ${sig}, stopping`);
    ctrl.abort();
    const done = await Promise.race([running.then(() => true, () => true), F.sleep(STOP_GRACE_MS).then(() => false)]);
    if (!done) log(`stop: batch still running after ${STOP_GRACE_MS} ms; cursor not saved, unfinished messages will be redelivered`);
    setStatus('STOPPED'); removePid(); process.exit(0);
  };
  process.on('SIGTERM', () => { stop('SIGTERM'); });
  process.on('SIGINT', () => { stop('SIGINT'); });

  log(`bridge started pid=${process.pid} protection=${cfg.protection ? 'on' : 'off'} mirror=${cfg.mirror} media=${cfg.acceptMedia ? 'on' : 'off'} owner=${guard.owner() ? 'bound' : 'not bound'}`);
  setStatus('RUNNING');
  F.writeSecure(P.heartbeat, `${Date.now()}\n`);
  running = poller.run(ctrl.signal);
  running.then(() => { if (!stopping) process.exit(0); }, (e) => {
    if (e instanceof FatalError) {
      setStatus(e.status); log(`FATAL ${e.message}. Not retrying. Run ./login.sh to scan a new QR code.`);
      console.error(`${e.status}: ${e.message}`);
      process.exit(C.EXIT.EXPIRED);
    }
    crash('poller', e);
  });
}

main();
