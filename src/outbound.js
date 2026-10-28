'use strict';
// Checks for outbound replies (kept identical in the sibling project grokbot-qqbot-bridge):
//  - recipient ids must look like platform ids, so a stray option or shell fragment is never used as one;
//  - files sent with reply.sh must not be secrets: .env files, the bridge state (credentials, tokens), git
//    metadata, SSH/cloud credential folders, or system paths. REPLY_ALLOWED_DIRS optionally restricts sending
//    to a set of directories. Symlinks are resolved before checking.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const RECIPIENT_RE = /^[A-Za-z0-9@._:=-]{1,128}$/;

function labeled(label, msg = label) { const e = new Error(msg); e.label = label; return e; }

/** Returns null when `to` is a plausible recipient id, else a short reason. */
function recipientProblem(to) {
  const s = String(to ?? '');
  if (!s) return 'empty';
  if (s.startsWith('-')) return 'looks like an option';
  if (!RECIPIENT_RE.test(s)) return 'contains characters that are not allowed (letters, digits and @ . _ : = - only)';
  return null;
}

const SECRET_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.gcloud', '.git', '.password-store']);
const SECRET_FILES = new Set(['.netrc', '.npmrc', '.pypirc', '.git-credentials', '.pgpass', '.bash_history', '.zsh_history',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'authorized_keys', 'known_hosts']);
const SYSTEM_ROOTS = ['/etc', '/proc', '/sys', '/dev', '/root', '/var/lib', '/var/run', '/run', '/boot'];

function realOrResolved(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
function inside(child, dir) { const rel = path.relative(dir, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }

/**
 * Throws Error .label FILE_NOT_ALLOWED when the file must not be sent.
 * opts: { root (bridge folder), stateDir, mediaDir, allowedDirs: string[] }
 */
function checkSendablePath(file, { root, stateDir, mediaDir, allowedDirs = [] } = {}) {
  const real = realOrResolved(file);
  const base = path.basename(real);
  const deny = (why) => { throw labeled('FILE_NOT_ALLOWED', `refusing to send ${base}: ${why}`); };
  if (/^\.env(\..*)?$/i.test(base) || /\.env$/i.test(base)) deny('environment files may contain secrets');
  if (SECRET_FILES.has(base) || /^id_[a-z0-9]+(\.pub)?$/i.test(base) || /\.(pem|key|p12|pfx|kdbx)$/i.test(base)) deny('it looks like a key or credential file');
  const segments = real.split(path.sep);
  if (segments.some((s) => SECRET_DIRS.has(s))) deny('it is inside a credentials or git folder');
  const home = os.homedir();
  // System folders are refused, except the user's own home (e.g. /root when running as root).
  if (SYSTEM_ROOTS.some((r) => inside(real, r) && !(home && inside(home, r) && inside(real, home)))) deny('system paths are not sent');
  if (home && inside(real, path.join(home, '.config'))) deny('application configuration is not sent');
  const st = stateDir ? realOrResolved(stateDir) : null;
  const md = mediaDir ? realOrResolved(mediaDir) : null;
  if (st && inside(real, st) && !(md && inside(real, md))) deny('the bridge state folder holds credentials and tokens');
  if (root && inside(real, realOrResolved(root)) && !(md && inside(real, md))) {
    const rel = path.relative(realOrResolved(root), real).split(path.sep)[0];
    if (['state', 'logs', 'node_modules', '.git'].includes(rel)) deny('bridge internals are not sent');
  }
  if (allowedDirs.length && !allowedDirs.some((d) => inside(real, realOrResolved(d)))) deny('it is outside REPLY_ALLOWED_DIRS');
  return real;
}

module.exports = { recipientProblem, checkSendablePath, RECIPIENT_RE };
