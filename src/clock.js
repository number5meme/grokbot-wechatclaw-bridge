'use strict';
// Wake detector: notices that the host was suspended, paused or frozen, or that the wall clock was changed.
//  - Linux suspend: CLOCK_MONOTONIC (Node timers, performance.now) stops while the machine sleeps, Date.now() does
//    not, so the first tick after a resume sees a wall-clock gap far larger than the tick interval.
//  - VM pause / cgroup freeze: both clocks keep running but timers do not fire, so the next tick arrives late (on
//    the wall clock too, so the wall-clock check usually reports it; the monotonic check still catches it if the
//    wall clock was stepped back meanwhile, e.g. by NTP after the resume).
// Threshold 30 s against a 5 s tick: only a 30 s+ event-loop stall or clock step reports; normal timer lag and GC
// pauses do not, so a busy bridge does not reconnect in a loop.
// Each tick compares the wall-clock and monotonic gaps since the previous tick with the tick interval; a gap
// larger than the threshold (either clock) reports a jump. Long-lived sockets often look ESTABLISHED after a resume
// but never deliver data again, so the bridges use this signal to force an immediate fresh reconnect.

const { performance } = require('node:perf_hooks');

class ClockJumpDetector {
  constructor({ intervalMs = 5000, thresholdMs = 30_000, now = Date.now, mono = () => performance.now(), onJump }) {
    Object.assign(this, { intervalMs, thresholdMs, now, mono, onJump });
    this.last = null; this.lastMono = null; this.timer = null;
  }
  start() {
    this.last = this.now(); this.lastMono = this.mono();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }
  /**
   * One check. Exposed for tests. Returns the drift in ms if a jump was detected, else 0.
   * Wall-clock drift (suspend, clock change; may be negative) wins; otherwise a late monotonic tick (frozen timers).
   */
  tick() {
    const t = this.now(); const m = this.mono();
    const wallDrift = this.last === null ? 0 : t - this.last - this.intervalMs;
    const monoDrift = this.lastMono === null ? 0 : m - this.lastMono - this.intervalMs;
    this.last = t; this.lastMono = m;
    let drift = 0;
    if (Math.abs(wallDrift) > this.thresholdMs) drift = wallDrift;
    else if (monoDrift > this.thresholdMs) drift = Math.round(monoDrift);
    if (drift) { try { this.onJump(drift); } catch { /* ignore */ } }
    return drift;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { ClockJumpDetector };
