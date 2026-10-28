'use strict';
// Text helpers: Markdown -> plain text, and splitting long replies.

/** Defensive Markdown -> plain text (chat apps here do not render Markdown). */
function stripMarkdown(input) {
  let s = String(input ?? '').replace(/\r\n/g, '\n');
  s = s.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => code.replace(/\n$/, '')); // fenced code
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, t, u) => (t ? `${t} ${u}` : u)); // images
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, t, u) => (t === u ? u : `${t} ${u}`)); // links
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, '$1'); // headings
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, ''); // blockquotes
  s = s.replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, ''); // horizontal rules
  s = s.replace(/^([ \t]*)[*+][ \t]+/gm, '$1- '); // "* item" -> "- item"
  s = s.replace(/`([^`\n]*)`/g, '$1'); // inline code
  s = s.replace(/`/g, '');
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2'); // *italic* (no spaces inside the markers)
  s = s.replace(/~~([^~\n]+)~~/g, '$1');
  // Unpaired asterisks are kept: they are often arithmetic or wildcards ("2*3", "*.txt").
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

// Sentence enders: ASCII ". " plus the full-width stop, exclamation and question marks (U+3002, U+FF01, U+FF1F).
const SENTENCE_ENDS = ['. ', '\u3002', '\uff01', '\uff1f'];

/** True when index i (0 < i < s.length) falls between the two halves of a UTF-16 surrogate pair. */
function splitsPair(s, i) {
  const c = s.charCodeAt(i - 1);
  return c >= 0xd800 && c <= 0xdbff && i < s.length && s.charCodeAt(i) >= 0xdc00 && s.charCodeAt(i) <= 0xdfff;
}
/** s.slice(0, n) without cutting an emoji or other astral character in half. */
function safeSlice(s, n) {
  const str = String(s);
  if (n >= str.length) return str;
  if (n <= 0) return '';
  return str.slice(0, splitsPair(str, n) ? n - 1 : n);
}

/** Split into chunks <= max chars, preferring paragraph, line, sentence, then word boundaries. */
function splitText(text, max = 2000) {
  const out = [];
  let rest = String(text);
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max * 0.5) cut = window.lastIndexOf('\n');
    if (cut < max * 0.5) cut = Math.max(...SENTENCE_ENDS.map((p) => window.lastIndexOf(p)));
    if (cut < max * 0.5) cut = window.lastIndexOf(' ');
    if (cut < max * 0.5) { cut = max - 1; if (splitsPair(rest, cut + 1)) cut -= 1; }
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out.filter(Boolean);
}

const TRUNCATION_NOTE = '\n... (message too long, truncated)';

/** Markdown-strip, split, and cap the number of chunks. */
function buildChunks(raw, { chunkSize = 2000, maxChunks = 10 } = {}) {
  let parts = splitText(stripMarkdown(raw), chunkSize);
  if (parts.length > maxChunks) {
    parts = parts.slice(0, maxChunks);
    parts[maxChunks - 1] = safeSlice(parts[maxChunks - 1], chunkSize - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
  }
  return parts;
}

module.exports = { stripMarkdown, splitText, buildChunks, safeSlice, TRUNCATION_NOTE };
