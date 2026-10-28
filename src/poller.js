'use strict';
// getupdates long-poll loop with anti-disconnect handling:
//  - a client-side long-poll timeout is normal and simply starts the next poll;
//  - errors back off exponentially with jitter (2s .. 60s) and mark the status DEGRADED after 3 in a row;
//  - wake-up (wall-clock jump after a host suspend, or frozen timers after a pause; see clock.js) aborts the
//    in-flight poll or the backoff sleep, resets the backoff and polls again at once;
//  - every request has a timeout (long-poll timeout + 5 s); a watchdog tick (every watchdogEveryMs, monotonic
//    clock) also aborts a poll or a sleep that overran its bound by stepMarginMs, in case a timer was lost;
//  - the cursor (get_updates_buf) is saved only after a batch has been handled, so a crash or forced stop in
//    the middle of a batch gets the batch again on restart (already handled messages are skipped by the
//    persisted dedupe list); the heartbeat keeps ticking while a long batch (media, webhook retries) runs;
//  - errcode -14 (session expired) is fatal by default: the loop stops and never retries on its own. With
//    expiredRetryAfterMs > 0 it pauses that long and polls again instead (the official client pauses 1 hour).
const { Backoff } = require('./backoff');
const { ClockJumpDetector } = require('./clock');
const { errCodeOf, isTimeout, ERR } = require('./ilink');
const { performance } = require('node:perf_hooks');
const { sleep: defaultSleep } = require('./files');

const DEFAULT_LONG_POLL_MS = 35_000;
const BUSY_BEAT_MS = 30_000;
const STEP_MARGIN_MS = 30_000;

/** Settle with an AbortError as soon as `signal` aborts, even if `p` itself never settles. */
function raceAbort(p, signal) {
  if (!signal) return p;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    // Always attach to p first, so a late rejection of p is never unhandled.
    Promise.resolve(p).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A signal that aborts when any of `signals` aborts, plus dispose() (no listener left on the long-lived stop signal). */
function linkSignals(signals) {
  const list = signals.filter(Boolean);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  for (const s of list) { if (s.aborted) { ctrl.abort(); break; } }
  if (!ctrl.signal.aborted) for (const s of list) s.addEventListener('abort', onAbort, { once: true });
  return { signal: ctrl.signal, dispose: () => { for (const s of list) s.removeEventListener('abort', onAbort); } };
}

class FatalError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** One-line, length-capped text from a server field (no newlines in logs). */
function oneLine(v, n = 80) { const t = String(v).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '...' : t; }

class Poller {
  /**
   * deps:
   *  getUpdates({ buf, timeoutMs, signal }) -> response
   *  onMessages(msgs) -> Promise
   *  loadBuf() / saveBuf(buf)
   *  setStatus(word), beat() (record healthy activity), recordError(text)
   *  onWake(reason): a wake-up (clock jump, stuck poll) restarted the long-poll
   *  expiredRetryAfterMs: 0 = -14 is fatal; > 0 = pause and retry
   */
  constructor({ getUpdates, onMessages, loadBuf = () => '', saveBuf = () => {}, setStatus = () => {}, beat = () => {},
    recordError = () => {}, onWake = () => {}, logFn = () => {}, sleep = defaultSleep, backoff = new Backoff({ baseMs: 2000, maxMs: 60_000 }),
    clock = { intervalMs: 5000, thresholdMs: 30_000 }, degradedAfter = 3, expiredRetryAfterMs = 0, busyBeatMs = BUSY_BEAT_MS,
    mono = () => performance.now(), watchdogEveryMs = 10_000, stepMarginMs = STEP_MARGIN_MS }) {
    Object.assign(this, { getUpdates, onMessages, loadBuf, saveBuf, setStatus, beat, recordError, onWake, logFn, sleep, backoff, clock,
      degradedAfter, expiredRetryAfterMs, busyBeatMs, mono, watchdogEveryMs, stepMarginMs });
    this.fails = 0; this.degraded = false; this.jumped = false; this.reqCtrl = null; this.clockJumps = 0; this.wakes = 0;
    this.sleepCtrl = null; // aborted by a wake-up to end a backoff sleep early
    this.step = null;      // { name, since (monotonic), limitMs }
  }

  /** Called by the clock detector (or tests). Aborts the current poll so the loop reconnects. */
  onClockJump(driftMs) {
    this.clockJumps++;
    this.logFn(`clock jump detected (${Math.round(driftMs / 1000)}s, host suspend or clock change), restarting long-poll`);
    this.wake('clock_jump', driftMs);
  }

  /** Abort the in-flight poll or backoff sleep and poll again at once with a reset backoff. */
  wake(reason = 'wake', driftMs = 0) {
    if (!this.running || (this.stopSignal && this.stopSignal.aborted)) return; // stopping, or run() is not active
    this.wakes++; this.wakeReason = reason;
    try { this.onWake(reason, driftMs); } catch { /* ignore */ }
    this.jumped = true;
    this.backoff.reset();
    if (this.reqCtrl) this.reqCtrl.abort();
    if (this.sleepCtrl) this.sleepCtrl.abort();
  }

  setStep(name, limitMs) { this.step = { name, since: this.mono(), limitMs }; }

  /** Watchdog tick: a poll or sleep that overran its bound (e.g. a timer lost across a suspend) is aborted. */
  watchdogTick() {
    const st = this.step;
    if (!st || !st.limitMs) return;
    const age = this.mono() - st.since;
    if (age > st.limitMs) {
      this.logFn(`watchdog: ${st.name} did not finish within ${Math.round(age / 1000)}s, restarting long-poll`);
      this.step = null;
      this.wake('stuck');
    }
  }

  /** Backoff sleep that a wake-up (or stop) ends early. */
  async wakeableSleep(ms, signal, name = 'backoff sleep') {
    const ctrl = new AbortController();
    this.sleepCtrl = ctrl;
    this.setStep(name, ms + this.stepMarginMs);
    const link = linkSignals([signal, ctrl.signal]);
    try { await this.sleep(ms, link.signal); } finally { link.dispose(); if (this.sleepCtrl === ctrl) this.sleepCtrl = null; this.step = null; }
  }

  async fail(why, signal) {
    this.fails++;
    const delay = this.backoff.next();
    this.recordError(why);
    if (this.fails >= this.degradedAfter && !this.degraded) { this.degraded = true; this.setStatus('DEGRADED'); }
    this.logFn(`getupdates error (${this.fails} in a row): ${why}; retrying in ${Math.round(delay / 1000)}s`);
    await this.wakeableSleep(delay, signal);
  }

  /** Sleep `ms` while still writing the heartbeat, so a deliberate pause is not reported as STALE. */
  async pauseWithBeat(ms, signal) {
    let left = ms;
    while (!signal.aborted && left > 0) {
      try { this.beat(); } catch { /* ignore */ }
      const d = Math.min(this.busyBeatMs, left);
      // wakeable, so the watchdog can end a chunk whose timer was lost (the pause then goes on with the next chunk)
      await this.wakeableSleep(d, signal, '-14 pause');
      left -= d;
    }
  }

  /** Handle one batch while keeping the heartbeat alive. */
  async handleBatch(msgs) {
    const t = setInterval(() => { try { this.beat(); } catch { /* ignore */ } }, this.busyBeatMs);
    t.unref?.();
    try { await this.onMessages(msgs); } finally { clearInterval(t); }
  }

  /** Resolves when `signal` aborts; rejects with FatalError on -14 (unless expiredRetryAfterMs > 0). */
  async run(signal) {
    this.running = true; this.stopSignal = signal;
    let buf = this.loadBuf() || '';
    let timeoutMs = DEFAULT_LONG_POLL_MS;
    const detector = this.clock ? new ClockJumpDetector({ ...this.clock, onJump: (d) => this.onClockJump(d) }).start() : null;
    const wd = this.watchdogEveryMs > 0 ? setInterval(() => this.watchdogTick(), this.watchdogEveryMs) : null;
    wd?.unref?.();
    try {
      while (!signal.aborted) {
        this.reqCtrl = new AbortController();
        const ctrl = this.reqCtrl;
        const onStop = () => ctrl.abort();
        signal.addEventListener('abort', onStop, { once: true });
        let resp;
        this.jumped = false;
        try {
          this.setStep('getupdates request', timeoutMs + 5000 + this.stepMarginMs);
          resp = await raceAbort(this.getUpdates({ buf, timeoutMs: timeoutMs + 5000, signal: ctrl.signal }), ctrl.signal);
        } catch (e) {
          if (signal.aborted) break;
          if (this.jumped) { this.jumped = false; this.backoff.reset(); continue; }
          // A client-side timeout is normal for long polling (as in the official client): poll again at once.
          // It is not counted as healthy activity, so a server that never answers shows up as STALE in healthcheck.
          if (isTimeout(e)) continue;
          await this.fail(e.status ? `HTTP ${e.status}` : oneLine(e.message || 'network error'), signal);
          continue;
        } finally {
          signal.removeEventListener('abort', onStop);
          this.reqCtrl = null; this.step = null;
        }
        if (this.jumped) { this.jumped = false; this.backoff.reset(); } // jump during a successful poll: just continue
        const code = errCodeOf(resp);
        if (code === ERR.SESSION_EXPIRED) {
          if (!(this.expiredRetryAfterMs > 0)) throw new FatalError('EXPIRED_-14', 'getupdates errcode -14: session expired; a new QR login is required');
          const min = Math.round(this.expiredRetryAfterMs / 60_000);
          this.recordError('errcode -14 (session expired or paused)');
          this.setStatus('PAUSED_-14');
          this.logFn(`getupdates errcode -14: pausing ${min} min before polling again (EXPIRED_RETRY_AFTER_MIN); run ./login.sh if it keeps happening`);
          await this.pauseWithBeat(this.expiredRetryAfterMs, signal);
          if (!signal.aborted) this.setStatus('RUNNING');
          continue;
        }
        if (code !== 0) {
          await this.fail(`ret=${resp.ret} errcode=${resp.errcode}${resp.errmsg ? ' errmsg=' + oneLine(resp.errmsg) : ''}`, signal);
          continue;
        }
        // success
        this.fails = 0; this.backoff.reset(); this.beat();
        if (this.degraded) { this.degraded = false; this.setStatus('RUNNING'); this.logFn('getupdates recovered'); }
        if (resp.longpolling_timeout_ms > 0) timeoutMs = resp.longpolling_timeout_ms;
        if (Array.isArray(resp.msgs) && resp.msgs.length) await this.handleBatch(resp.msgs);
        if (resp.get_updates_buf) { buf = resp.get_updates_buf; this.saveBuf(buf); } // only after the batch is handled
      }
    } finally { this.running = false; if (detector) detector.stop(); if (wd) clearInterval(wd); this.step = null; }
  }
}

module.exports = { Poller, FatalError, DEFAULT_LONG_POLL_MS, oneLine, raceAbort, linkSignals };
