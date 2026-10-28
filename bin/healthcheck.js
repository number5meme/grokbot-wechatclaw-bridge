#!/usr/bin/env node
'use strict';
// Health check for cron, monitoring, or the watchdog. Prints one line and exits:
//   0 OK, 1 NOT_RUNNING, 2 NEEDS_ACTION (fatal: do not restart), 3 STALE.
// --status prints a longer human-readable summary and always exits 0.
const C = require('../src/config');
const F = require('../src/files');
const { evaluateHealth } = require('../src/health');

function main() {
  let cfg;
  try { cfg = C.loadConfig({ requireWebhook: false }); } catch (e) {
    console.log(`UNHEALTHY CONFIG_ERROR: ${e.message.replace(/\n\s*/g, ' ')}`); process.exit(2);
  }
  const P = C.paths(cfg);
  const pid = parseInt(F.readText(P.pid), 10);
  const alive = F.pidRuns(pid); // a reused PID of another program does not count as running
  const status = F.readText(P.status);
  const health = F.readJson(P.health, {}) || {};
  const res = evaluateHealth({ pidAlive: alive, status, heartbeatMs: parseInt(F.readText(P.heartbeat), 10) || 0,
    staleSeconds: cfg.healthStaleSeconds, lastError: health.last_error || '', wakeMs: Date.parse(health.last_wake_at || '') || 0,
    wakeDriftMs: Number(health.last_wake_drift_ms) || 0 }, C.FATAL_STATUS);

  if (process.argv.includes('--status')) {
    const stats = F.readJson(P.stats, {}) || {};
    const lines = [
      `bridge:      ${alive ? `running (pid ${pid})` : 'not running'}`,
      `status:      ${status || 'none'}`,
      `health:      ${res.reason}`,
      `login:       ${F.readText(P.loginState) || 'none'}; credentials ${C.loadCreds(P) ? 'present' : 'missing'}`,
      `protection:  ${cfg.protection ? 'on' : 'off'}${cfg.protection ? `; owner ${cfg.ownerId || C.ownerStore(P).get() ? 'bound' : 'not bound yet (first sender binds)'}; allowlist ${cfg.allowlist.length}; rate limit ${cfg.rateLimitPerMin}/min` : ' (every sender is forwarded as trusted)'}; global limit ${cfg.globalRateLimitPerMin}/min`,
      `mirror:      ${cfg.mirror}`,
      `counters:    forwarded=${stats.forwarded || 0} undelivered=${stats.undelivered || 0} dropped_not_owner=${stats.dropped_not_owner || 0} dropped_rate_limited=${stats.dropped_rate_limited || 0} dropped_overload=${stats.dropped_overload || 0} truncated=${stats.truncated || 0}`,
      `last error:  ${health.last_error ? `${health.last_error} at ${health.last_error_at}` : 'none'}`,
    ];
    console.log(lines.join('\n'));
    process.exit(0);
  }
  console.log(`${res.code === 0 ? 'HEALTHY' : 'UNHEALTHY'} ${res.reason}`);
  process.exit(res.code);
}

main();
