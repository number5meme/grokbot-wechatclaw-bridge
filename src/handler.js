'use strict';
// Turns iLink messages into webhook payloads, applying dedupe and sender protection.
// Text = TEXT items plus WeChat's voice transcripts (prefixed "[voice] "). Media items are downloaded
// only after the sender passed the guard, and listed in the payload's "media" array.
const { extractText, extractVoiceTranscripts, MSG_TYPE } = require('./ilink');
const { collectMediaItems } = require('./media');
const { buildPayload } = require('./guard');

const SEEN_MAX = 500;
const VOICE_PREFIX = '[voice] ';

/** Message text: text items, then each voice transcript on its own line. */
function messageText(m) {
  return [extractText(m), ...extractVoiceTranscripts(m).map((t) => VOICE_PREFIX + t)].filter(Boolean).join('\n').trim();
}

/**
 * deps: { guard, forward(payload)->bool, mirror, saveToken(userId, token), saveLastSender(userId),
 *         saveUndelivered(obj), logFn, seen:Set, markSeen(id) (persists the dedupe list),
 *         fetchMedia(collected)->entries (null disables media) }
 * A message id is marked as seen only after the message has been fully handled (forwarded, saved as
 * undelivered, or dropped), so a message interrupted by a crash or stop is handled again when the
 * server redelivers it (the cursor is saved after the batch).
 * Returns counters { forwarded, dropped, duplicate, nonText, undelivered }.
 * nonText counts messages with nothing to forward (no text and no usable media).
 */
async function handleMessages(msgs, { guard, forward, mirror = true, saveToken = () => {}, saveLastSender = () => {},
  saveUndelivered = () => {}, logFn = () => {}, seen = new Set(), markSeen = () => {}, fetchMedia = null }) {
  const r = { forwarded: 0, dropped: 0, duplicate: 0, nonText: 0, undelivered: 0 };
  for (const m of msgs || []) {
    if (!m || m.message_type !== MSG_TYPE.USER) continue; // bot echoes and system items
    const id = m.message_id != null ? String(m.message_id) : '';
    if (id && seen.has(id)) { r.duplicate++; continue; }
    await handleOne(m, id, r);
    if (id) {
      seen.add(id); if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
      try { markSeen(id, seen); } catch { /* ignore */ }
    }
  }
  return r;

  async function handleOne(m, id, r) {
    const from = m.from_user_id ? String(m.from_user_id) : '';
    const text = messageText(m);
    const d = guard.check(from, text);
    if (!d.forward) { r.dropped++; return; } // guard already counted and logged it; nothing is stored for dropped senders

    if (m.context_token) saveToken(from, m.context_token); // refreshes the reply window for this sender
    saveLastSender(from);
    const collected = fetchMedia ? collectMediaItems(m) : [];
    if (!text && !collected.length) {
      const types = (m.item_list || []).map((i) => i && i.type).join(',');
      logFn(`message without text or usable media (item types ${types}) not forwarded; reply window refreshed`);
      r.nonText++; return;
    }
    let media = [];
    if (collected.length) {
      try { media = await fetchMedia(collected); } catch (e) { logFn(`media handling failed: ${e.label || 'error'}`); media = []; }
      const failed = media.filter((x) => x.error).map((x) => x.error);
      logFn(`inbound media ${media.map((x) => x.kind).join(',')}${failed.length ? ` (failed: ${failed.join(',')})` : ''}`);
    }
    logFn(`inbound text len=${text.length}${d.truncated ? ' (truncated)' : ''}${media.length ? ` media=${media.length}` : ''}`);
    const payload = buildPayload({ source: 'wechat', senderId: from, messageId: id, text: d.text, truncated: d.truncated, untrusted: d.untrusted, mirror, media });
    const ok = await forward(payload);
    if (guard.recordDelivery) guard.recordDelivery(ok);
    if (ok) r.forwarded++;
    else { r.undelivered++; try { saveUndelivered(payload); } catch { /* ignore */ } }
  }
}

module.exports = { handleMessages, messageText, SEEN_MAX, VOICE_PREFIX };
