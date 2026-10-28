'use strict';
// Health evaluation used by bin/healthcheck.js. Pure function so it can be unit-tested.
//
// Exit codes (suitable for cron / monitoring):
//   0 OK
//   1 NOT_RUNNING   process not running (safe to restart)
//   2 NEEDS_ACTION  fatal status such as expired credentials or a ban; restarting will not help
//   3 STALE         process alive but no successful activity recently (safe to restart)

const EXIT = { OK: 0, NOT_RUNNING: 1, NEEDS_ACTION: 2, STALE: 3 };

/**
 * fatal: { [STATUS]: 'human-readable remedy' }
 * input: { pidAlive, status, heartbeatMs, nowMs, staleSeconds, lastError, wakeMs, wakeGraceSeconds }
 * wakeMs / wakeDriftMs: when the bridge last detected a host wake-up (clock jump) and how long the host slept.
 * Right after a long suspend the heartbeat is old by wall-clock time although the bridge is already reconnecting by
 * itself, so STALE is held back for wakeGraceSeconds after a wake-up, but only if the bridge was healthy when the
 * host went to sleep (heartbeat age at the wake-up, minus the time slept, within staleSeconds). So repeated wake-ups
 * cannot keep a dead bridge from being restarted: once it was already stale before a sleep, no grace is given.
 */
const WAKE_GRACE_SECONDS = 90;
function evaluateHealth({ pidAlive, status, heartbeatMs, nowMs = Date.now(), staleSeconds = 180, lastError = '', wakeMs = 0,
  wakeDriftMs = 0, wakeGraceSeconds = WAKE_GRACE_SECONDS }, fatal) {
  if (status && fatal[status]) return { code: EXIT.NEEDS_ACTION, reason: `${status}: ${fatal[status]}` };
  if (!pidAlive) return { code: EXIT.NOT_RUNNING, reason: `not running (last status: ${status || 'none'})` };
  if (!heartbeatMs) return { code: EXIT.STALE, reason: 'running but no heartbeat recorded yet' };
  const age = Math.round((nowMs - heartbeatMs) / 1000);
  const sinceWake = wakeMs ? Math.round((nowMs - wakeMs) / 1000) : Infinity;
  const ageBeforeSleep = (wakeMs - heartbeatMs - Math.max(0, wakeDriftMs || 0)) / 1000;
  if (age > staleSeconds && sinceWake >= 0 && sinceWake <= wakeGraceSeconds && ageBeforeSleep <= staleSeconds) {
    return { code: EXIT.OK, reason: `recovering after a host wake-up ${sinceWake}s ago (status ${status || 'none'}, last activity ${age}s ago)` };
  }
  if (age > staleSeconds) {
    return { code: EXIT.STALE, reason: `no successful activity for ${age}s (limit ${staleSeconds}s, status ${status || 'none'})${lastError ? `, last error: ${lastError}` : ''}` };
  }
  return { code: EXIT.OK, reason: `ok (status ${status || 'none'}, last activity ${age}s ago)` };
}

module.exports = { evaluateHealth, EXIT, WAKE_GRACE_SECONDS };
