'use strict';
// Minimal .env loader (no dependencies). Values already present in the environment win.
// Double-quoted values understand the escapes \" \\ \n \r \t (as written by setup); single-quoted values are literal.
const fs = require('node:fs');

const ESC = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith('"')) {
    let out = ''; let i = 1;
    for (; i < v.length; i++) {
      const c = v[i];
      if (c === '\\' && i + 1 < v.length && ESC[v[i + 1]] !== undefined) { out += ESC[v[++i]]; continue; }
      if (c === '"') break;
      out += c;
    }
    if (i < v.length) return out; // closing quote found; anything after it (e.g. a comment) is ignored
    return v; // unterminated: keep as written
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    if (end > 0) return v.slice(1, end);
    return v;
  }
  return v.replace(/\s+#.*$/, '');
}

function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = parseValue(m[2]);
  }
  return out;
}

/** Quote a value for a .env file so parseDotEnv returns it unchanged. */
function quoteEnvValue(v) {
  const s = String(v);
  if (/^[A-Za-z0-9_./:@,+-]*$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
}

function loadDotEnv(file, env = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const parsed = parseDotEnv(text);
  for (const [k, v] of Object.entries(parsed)) if (env[k] === undefined) env[k] = v;
  return parsed;
}

module.exports = { parseDotEnv, loadDotEnv, quoteEnvValue };
