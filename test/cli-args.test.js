'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('../bin/reply');

const BIN = path.join(__dirname, '..', 'bin', 'reply.js');
// Any network call fails loudly: fetch is replaced before the CLI runs.
function run(args) {
  return spawnSync(process.execPath, ['--require', path.join(__dirname, 'no-network-preload.js'), BIN, ...args],
    { encoding: 'utf8', input: '', env: { PATH: process.env.PATH, HOME: '/nonexistent-home' } });
}

test('parseArgs: --help / -h set help', () => {
  assert.strictEqual(parseArgs(['--help']).help, true);
  assert.strictEqual(parseArgs(['--to', 'u', '-h']).help, true);
});
test('parseArgs: unknown option is reported, not treated as text', () => {
  const a = parseArgs(['--bogus', 'x']);
  assert.strictEqual(a.unknown, '--bogus');
  assert.strictEqual(parseArgs(['-x']).unknown, '-x');
});
test('parseArgs: -- ends options so text may start with "-"', () => {
  const a = parseArgs(['--to', 'u', '--', '--help', '-5 degrees']);
  assert.strictEqual(a.to, 'u');
  assert.strictEqual(a.help, undefined);
  assert.strictEqual(a.unknown, undefined);
  assert.deepStrictEqual(a.text || a.rest, ['--help', '-5 degrees']);
});
test('CLI: --help prints usage, exits 0, sends nothing', () => {
  for (const flag of ['--help', '-h']) {
    const r = run([flag]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Usage: \.\/reply\.sh/);
    assert.doesNotMatch(r.stdout, /NETWORK_CALLED|OK\n/);
  }
});
test('CLI: unknown option errors without network', () => {
  const r = run(['--bogus', 'x']);
  assert.strictEqual(r.status, 2, 'usage errors exit 2');
  assert.match(r.stdout, /^ERROR USAGE unknown option --bogus\n/);
  assert.doesNotMatch(r.stdout, /NETWORK_CALLED/);
});
