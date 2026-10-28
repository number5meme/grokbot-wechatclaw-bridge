'use strict';
// Test preload: fail loudly if the CLI attempts any network call.
const boom = () => { process.stdout.write('NETWORK_CALLED\n'); process.exit(99); };
globalThis.fetch = boom;
for (const m of ['node:http', 'node:https']) { const mod = require(m); mod.request = boom; mod.get = boom; }
