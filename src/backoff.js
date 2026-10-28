'use strict';
// Exponential backoff with jitter. With random() === 0 the sequence is deterministic: base, 2x, 4x, ... capped at max.

class Backoff {
  constructor({ baseMs = 1000, maxMs = 60_000, factor = 2, jitter = 0.3, random = Math.random } = {}) {
    Object.assign(this, { baseMs, maxMs, factor, jitter, random });
    this.attempt = 0;
  }
  /** Delay for the next retry; increments the attempt counter. */
  next() {
    const raw = Math.min(this.maxMs, this.baseMs * this.factor ** this.attempt);
    this.attempt++;
    return Math.max(0, Math.round(raw * (1 - this.jitter * this.random())));
  }
  reset() { this.attempt = 0; }
}

module.exports = { Backoff };
