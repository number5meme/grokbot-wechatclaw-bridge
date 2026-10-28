'use strict';
// Forward one JSON payload to the configured HTTP webhook. Retries on network errors, timeouts, 408, 429 and 5xx.
// Redirects are not followed (a 3xx is a configuration error, and following it could leak the payload or the
// Authorization value to another host). At most 64 KB of the response body is read.
// The webhook URL and the Authorization value are never logged.

const MAX_RESPONSE_BYTES = 64 * 1024;

/** Read and discard at most `max` bytes of a response body. */
async function drainCapped(res, max = MAX_RESPONSE_BYTES) {
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader(); let n = 0;
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        n += r.value.byteLength;
        if (n > max) { try { await reader.cancel(); } catch { /* ignore */ } return; }
      }
    }
    if (typeof res.text === 'function') await res.text();
  } catch { /* ignore body */ }
}

async function postWebhook(payload, { url, auth, fetchImpl = fetch, attempts = 3, timeoutMs = 20_000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), logFn = () => {}, userAgent = 'chat-bridge' }) {
  let last = 'n/a';
  for (let i = 1; i <= attempts; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json', 'User-Agent': userAgent };
      if (auth) headers.Authorization = auth;
      const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal, redirect: 'manual' });
      await drainCapped(res);
      last = String(res.status);
      if (res.ok) { logFn(`webhook ok status=${res.status} attempt=${i}`); return true; }
      if (res.status >= 300 && res.status < 400 || res.type === 'opaqueredirect') {
        logFn(`webhook failed status=${res.status || 'redirect'} attempt=${i} (redirects are not followed; use the final URL)`);
        break;
      }
      logFn(`webhook failed status=${res.status} attempt=${i}`);
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) break; // not retryable
    } catch (e) {
      last = e.name === 'AbortError' ? 'timeout' : 'network';
      logFn(`webhook error=${last} attempt=${i}`);
    } finally { clearTimeout(t); }
    if (i < attempts) await sleep(1000 * 3 ** (i - 1)); // 1s, 3s
  }
  logFn(`webhook gave up last=${last}`);
  return false;
}

module.exports = { postWebhook, drainCapped, MAX_RESPONSE_BYTES };
