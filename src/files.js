'use strict';
// Small file helpers: private (0700/0600) state, atomic writes, size-capped logs, a pid lock and an
// inter-process lock file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
}
/** Write a file atomically (temp file + rename) with mode 0600. */
function writeSecure(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw e; }
}
/** Rename file to file.1 (replacing an older .1) once it reaches maxBytes. Returns true when rotated. */
function rotateIfLarge(file, maxBytes) {
  if (!(maxBytes > 0)) return false;
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (st.size < maxBytes) return false;
  try { fs.renameSync(file, `${file}.1`); return true; } catch { return false; }
}
function appendSecure(file, line, { maxBytes = 0 } = {}) {
  ensureDir(path.dirname(file));
  rotateIfLarge(file, maxBytes);
  fs.appendFileSync(file, line, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) { writeSecure(file, JSON.stringify(obj)); }
function readText(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }

const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Line logger. The file is rotated to <file>.1 at maxBytes (default 5 MB), so logs stay bounded. */
function makeLogger(file, { echo = false, maxBytes = LOG_MAX_BYTES } = {}) {
  return (msg) => {
    // One record per line: control characters from remote text (error messages) cannot forge log lines.
    const line = `${new Date().toISOString()} ${String(msg).replace(/\r?\n/g, ' \\n ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '?')}\n`;
    try { appendSecure(file, line, { maxBytes }); } catch { /* ignore */ }
    if (echo) process.stderr.write(line);
  };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); resolve(); }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

function pidAlive(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
/**
 * True when `pid` is alive and (where /proc exists) its command line contains `marker`, so a reused PID of an
 * unrelated process is not mistaken for the bridge.
 */
function pidRuns(pid, marker = 'bin/bridge.js') {
  if (!pidAlive(pid)) return false;
  let cmd;
  try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return true; } // no /proc: trust kill -0
  return cmd.split('\0').some((a) => a.endsWith(marker));
}

/**
 * Single-instance pid file. Creates `file` exclusively with this process id. If it exists and names a live
 * process running `marker`, returns { ok: false, pid }. A stale file (dead or unrelated pid) is replaced.
 */
function acquirePidLock(file, { marker = 'bin/bridge.js', pid = process.pid } = {}) {
  ensureDir(path.dirname(file));
  for (let i = 0; i < 3; i++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, `${pid}\n`); fs.closeSync(fd);
      return { ok: true, pid };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const other = parseInt(readText(file), 10);
      if (other === pid) return { ok: true, pid };
      if (pidRuns(other, marker)) return { ok: false, pid: other };
      try { fs.unlinkSync(file); } catch { /* raced: retry */ }
    }
  }
  return { ok: false, pid: parseInt(readText(file), 10) || 0 };
}

/**
 * Run fn() while holding an exclusive lock file (other processes wait). A lock whose holder died or that is
 * older than staleMs is broken. Throws Error with .label LOCK_TIMEOUT after timeoutMs.
 */
async function withFileLock(lockFile, fn, { timeoutMs = 30_000, staleMs = 5 * 60_000, pollMs = 100 } = {}) {
  ensureDir(path.dirname(lockFile));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}\n`); fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const holder = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
        const age = Date.now() - fs.statSync(lockFile).mtimeMs;
        stale = (holder > 0 && !pidAlive(holder)) || age > staleMs;
      } catch { /* vanished: retry at once */ continue; }
      if (stale) { try { fs.unlinkSync(lockFile); } catch { /* ignore */ } continue; }
      if (Date.now() > deadline) { const err = new Error('timed out waiting for another reply to finish'); err.label = 'LOCK_TIMEOUT'; throw err; }
      await sleep(pollMs);
    }
  }
  try { return await fn(); } finally {
    try { if (readText(lockFile) === String(process.pid)) fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }
}

module.exports = { ensureDir, writeSecure, appendSecure, rotateIfLarge, readJson, writeJson, readText, makeLogger, sleep,
  pidAlive, pidRuns, acquirePidLock, withFileLock, LOG_MAX_BYTES };
