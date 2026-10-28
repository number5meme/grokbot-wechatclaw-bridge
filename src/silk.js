'use strict';
// SILK -> WAV transcoding with the optional silk-wasm package (the same approach and settings as Tencent's
// official clients: decode at 24 kHz, mono, 16-bit PCM, wrapped in a WAV container).
// If silk-wasm is not installed or decoding fails, callers keep the raw .silk file.
const SILK_SAMPLE_RATE = 24_000;

let cached;
function loadSilk() {
  if (cached !== undefined) return cached;
  try { cached = require('silk-wasm'); } catch { cached = null; }
  return cached;
}

/** Wrap mono pcm_s16le bytes in a 44-byte WAV header. */
function pcmToWav(pcm, sampleRate = SILK_SAMPLE_RATE) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24); h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Returns a WAV Buffer, or null when silk-wasm is unavailable or the input does not decode. */
async function silkToWav(silkBuf, { codec = loadSilk() } = {}) {
  if (!codec) return null;
  try {
    let input = silkBuf;
    if (input.length > 6 && input.subarray(0, 6).toString('latin1') === '#!AMR\n') input = input.subarray(6); // as the official QQ SDK does
    const r = await codec.decode(input, SILK_SAMPLE_RATE);
    if (!r || !r.data || !r.data.byteLength) return null;
    return pcmToWav(r.data, SILK_SAMPLE_RATE);
  } catch { return null; }
}

module.exports = { silkToWav, pcmToWav, loadSilk, SILK_SAMPLE_RATE };
