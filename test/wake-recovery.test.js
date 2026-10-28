'use strict';
// Host suspend / pause recovery for the WeChat long-poll: clock jumps, frozen or lost timers, polls that never
// settle. No network; clocks are injected.
const test = require('node:test');
const assert = require('node:assert');
const { Poller, raceAbort } = require('../src/poller');
const { ClockJumpDetector } = require('../src/clock');
const { Backoff } = require('../src/backoff');
const ilink = require('../src/ilink');
const { sleep: realSleep } = require('../src/files');

function harness(script, extra = {}) {
  const ctrl = new AbortController(); const delays = []; const logs = []; let buf = null;
  const p = new Poller({
    getUpdates: async (args) => {
      const step = script.shift();
      if (!step) { ctrl.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
      return step(args, p);
    },
    onMessages: async () => {}, saveBuf: (b) => { buf = b; }, logFn: (m) => logs.push(m),
    sleep: (ms, signal) => { delays.push(ms); return realSleep(Math.min(ms, 5), signal); },
    backoff: new Backoff({ baseMs: 2000, maxMs: 60_000, random: () => 0 }), clock: null, ...extra,
  });
  return { p, ctrl, delays, logs, buf: () => buf, run: () => p.run(ctrl.signal) };
}
const neverSettles = () => new Promise(() => {}); // ignores its abort signal entirely

test('clock detector: wall-clock jump (suspend) and late monotonic tick (frozen timers) both report', () => {
  let t = 0; let m = 0; const jumps = [];
  const d = new ClockJumpDetector({ intervalMs: 5000, thresholdMs: 30_000, now: () => t, mono: () => m, onJump: (x) => jumps.push(x) });
  d.last = 0; d.lastMono = 0;
  t += 5000; m += 5000; assert.strictEqual(d.tick(), 0);
  t += 5000 + 310_000; m += 5000; assert.strictEqual(d.tick(), 310_000);
  t += 45_000; m += 45_000; assert.strictEqual(d.tick(), 40_000);
  assert.deepStrictEqual(jumps, [310_000, 40_000]);
});

test('clock jump aborts a poll that ignores its signal and polls again at once', async () => {
  const h = harness([
    (a, p) => { setTimeout(() => p.onClockJump(310_000), 10); return neverSettles(); },
    () => ({ ret: 0, get_updates_buf: 'after-resume' }),
  ]);
  const t0 = Date.now();
  await h.run();
  assert.ok(Date.now() - t0 < 1000);
  assert.deepStrictEqual(h.delays, []);
  assert.strictEqual(h.buf(), 'after-resume');
});

test('clock jump during a long backoff sleep (timer frozen) ends the sleep and resets the backoff', async () => {
  const boom = () => { throw new TypeError('fetch failed'); };
  let pRef = null;
  const h = harness([boom, boom, boom, () => ({ ret: 0, get_updates_buf: 'ok' })], {
    sleep: (ms, signal) => {
      h.delays.push(ms);
      if (h.delays.length === 3) { setTimeout(() => pRef.onClockJump(300_000), 10); return realSleep(3_600_000, signal); } // frozen
      return realSleep(1, signal);
    },
  });
  pRef = h.p;
  const t0 = Date.now();
  await h.run();
  assert.ok(Date.now() - t0 < 1000, 'did not wait for the frozen timer');
  assert.deepStrictEqual(h.delays, [2000, 4000, 8000]);
  assert.strictEqual(h.p.backoff.attempt, 0, 'backoff reset');
  assert.strictEqual(h.buf(), 'ok');
});

test('watchdog: a poll that never settles and whose timeout was lost is aborted after its bound (no clock jump)', async () => {
  let m = 0;
  const h = harness([
    () => { setTimeout(() => { m += 120_000; }, 20); return neverSettles(); },
    () => ({ ret: 0, get_updates_buf: 'recovered' }),
  ], { mono: () => m, watchdogEveryMs: 10, stepMarginMs: 1000 });
  await h.run();
  assert.ok(h.logs.some((l) => /^watchdog: getupdates request did not finish within 120s, restarting long-poll$/.test(l)), h.logs.join('\n'));
  assert.strictEqual(h.buf(), 'recovered');
  assert.deepStrictEqual(h.delays, [], 'no backoff after a watchdog restart');
});

test('watchdog: a backoff sleep whose timer was lost is ended', async () => {
  let m = 0;
  const h = harness([() => { throw new TypeError('fetch failed'); }, () => ({ ret: 0, get_updates_buf: 'x' })], {
    mono: () => m, watchdogEveryMs: 10, stepMarginMs: 1000,
    sleep: (ms, signal) => { h.delays.push(ms); setTimeout(() => { m += ms + 5000; }, 15); return realSleep(3_600_000, signal); },
  });
  await h.run();
  assert.ok(h.logs.some((l) => /^watchdog: backoff sleep did not finish/.test(l)), h.logs.join('\n'));
  assert.strictEqual(h.buf(), 'x');
});

test('errors retry forever with backoff capped at 60 s', async () => {
  const boom = () => { throw new TypeError('fetch failed'); };
  const h = harness([...Array(10).fill(boom), () => ({ ret: 0 })]);
  await h.run();
  assert.deepStrictEqual(h.delays, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000, 60000]);
});

test('stop during a poll that ignores its signal ends run() promptly', async () => {
  const ctrl = new AbortController();
  const p = new Poller({ getUpdates: neverSettles, onMessages: async () => {}, clock: null });
  setTimeout(() => ctrl.abort(), 20);
  const t0 = Date.now();
  await p.run(ctrl.signal);
  assert.ok(Date.now() - t0 < 1000);
});

test('raceAbort: late rejection of the raced promise is handled; ilink requests always carry a timeout', async () => {
  const c = new AbortController(); c.abort();
  await assert.rejects(raceAbort(Promise.reject(new Error('late')), c.signal), (e) => e.name === 'AbortError');
  let seen = null;
  const fetchImpl = async (url, opts) => { seen = opts.signal; return { ok: true, status: 200, text: async () => '{"ret":0}' }; };
  await ilink.ilinkPost({ baseUrl: 'https://ilinkai.weixin.qq.com', endpoint: 'x', body: {}, label: 'x', fetchImpl });
  assert.ok(seen instanceof AbortSignal, 'default timeout applied when none was given');
  // a body that stalls after the headers is bounded by the same request signal
  const stall = async (url, opts) => ({ ok: true, status: 200, text: () => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(opts.signal.reason))) });
  await assert.rejects(ilink.ilinkPost({ baseUrl: 'https://ilinkai.weixin.qq.com', endpoint: 'x', body: {}, label: 'x', timeoutMs: 30, fetchImpl: stall }), (e) => ilink.isTimeout(e));
});

test('healthcheck: STALE held back briefly after a wake-up only if the bridge was healthy before the sleep', () => {
  const { evaluateHealth, EXIT, WAKE_GRACE_SECONDS } = require('../src/health');
  const now = 10_000_000; const fatal = {};
  // healthy until the host slept for 300 s; woke 5 s ago; heartbeat 310 s old by wall clock
  const base = { pidAlive: true, status: 'RECONNECTING', heartbeatMs: now - 310_000, nowMs: now, staleSeconds: 180 };
  assert.strictEqual(evaluateHealth(base, fatal).code, EXIT.STALE, 'no wake-up recorded');
  const rec = evaluateHealth({ ...base, wakeMs: now - 5000, wakeDriftMs: 300_000 }, fatal);
  assert.strictEqual(rec.code, EXIT.OK);
  assert.match(rec.reason, /^recovering after a host wake-up 5s ago/);
  assert.strictEqual(evaluateHealth({ ...base, wakeMs: now - (WAKE_GRACE_SECONDS + 1) * 1000, wakeDriftMs: 300_000 }, fatal).code, EXIT.STALE,
    'no recovery within the grace period -> restart');
  assert.strictEqual(evaluateHealth({ ...base, pidAlive: false, wakeMs: now - 5000, wakeDriftMs: 300_000 }, fatal).code, EXIT.NOT_RUNNING);
  // a dead bridge with recurring wake-ups (e.g. paused every minute): already stale before the last sleep -> no grace
  const dead = { ...base, heartbeatMs: now - 900_000, wakeMs: now - 5000, wakeDriftMs: 60_000 };
  assert.strictEqual(evaluateHealth(dead, fatal).code, EXIT.STALE);
  // a watchdog 'stuck' wake-up (no sleep) does not extend a stale heartbeat
  assert.strictEqual(evaluateHealth({ ...base, wakeMs: now - 5000, wakeDriftMs: 0 }, fatal).code, EXIT.STALE);
  // wake time in the future (clock set back) gives no grace
  assert.strictEqual(evaluateHealth({ ...base, wakeMs: now + 60_000, wakeDriftMs: 400_000 }, fatal).code, EXIT.STALE);
});

test('clock detector: monotonic-only lateness (frozen timers, wall clock stepped back meanwhile) is reported', () => {
  let t = 0; let m = 0; const jumps = [];
  const d = new ClockJumpDetector({ intervalMs: 5000, thresholdMs: 30_000, now: () => t, mono: () => m, onJump: (x) => jumps.push(x) });
  d.last = 0; d.lastMono = 0;
  t += 5000; m += 65_000; // timers frozen 60 s, and NTP stepped the wall clock back by the same amount
  assert.strictEqual(d.tick(), 60_000);
  t += 5000 + 25_000; m += 5000; // 25 s step: below the threshold, ignored
  assert.strictEqual(d.tick(), 0);
  t += 5000; m += 5000 + 29_000; // 29 s event-loop stall: below the threshold, ignored (no reconnect loop under load)
  assert.strictEqual(d.tick(), 0);
  assert.deepStrictEqual(jumps, [60_000]);
});

test('wake-up after stop or outside run() does nothing', async () => {
  const wakes = [];
  const ctrl = new AbortController();
  const p = new Poller({ getUpdates: ({ signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('stopped')))),
    onMessages: async () => {}, clock: null, onWake: (r) => wakes.push(r) });
  p.onClockJump(300_000);
  const run = p.run(ctrl.signal);
  ctrl.abort(); p.onClockJump(300_000);
  await run;
  p.wake('late');
  assert.deepStrictEqual(wakes, []);
});

test('watchdog ends a -14 pause chunk whose timer was lost; the pause then continues', async () => {
  let m = 0; let calls = 0;
  const h = harness([
    () => ({ ret: -14, errcode: -14 }),
    () => { calls++; return { ret: 0, get_updates_buf: 'after-pause' }; },
  ], {
    expiredRetryAfterMs: 60_000, busyBeatMs: 30_000, mono: () => m, watchdogEveryMs: 10, stepMarginMs: 1000,
    sleep: (ms, signal) => { h.delays.push(ms); if (h.delays.length === 1) { setTimeout(() => { m += 100_000; }, 15); return realSleep(3_600_000, signal); } return realSleep(1, signal); },
  });
  await h.run();
  assert.ok(h.logs.some((l) => /^watchdog: -14 pause did not finish/.test(l)), h.logs.join('\n'));
  assert.deepStrictEqual(h.delays, [30_000, 30_000], 'second chunk still slept');
  assert.strictEqual(calls, 1);
});

test('backoff sleeps leave no listener on the stop signal', async () => {
  const { getEventListeners } = require('node:events');
  const boom = () => { throw new TypeError('fetch failed'); };
  const h = harness(Array(20).fill(boom));
  let max = 0;
  const orig = h.p.sleep;
  h.p.sleep = (ms, s) => { max = Math.max(max, getEventListeners(h.ctrl.signal, 'abort').length); return orig(ms, s); };
  await h.run();
  assert.ok(max <= 2, `listeners on the stop signal stayed bounded (${max})`);
  assert.strictEqual(getEventListeners(h.ctrl.signal, 'abort').length, 0);
});
