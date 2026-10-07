'use strict';

// Text primitives shared by every layer. Pure: no IO, no network, no globals.

const crypto = require('node:crypto');

/** NFKC + lowercase + collapse whitespace runs. The canonical compare form. */
function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Truncate to `max` UTF-16 units without leaving a lone surrogate behind. */
function clip(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * The one chokepoint for text that came out of a repository file and is about
 * to be shown to the user or sent to the model.
 *
 * Angle brackets go first: they are what lets a hostile entry close or forge
 * the wrapper it sits in. Every caller that renders repository data goes
 * through here — not just the automatic injection block.
 */
function sanitize(value, max) {
  const flat = String(value ?? '').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return clip(flat, max);
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** First non-empty line with leading markdown markers stripped. */
function firstLine(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.replace(/^[#>\-*\s]+/, '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/** Last path segment, extension removed. Used as an id fallback. */
function basename(source) {
  const name = String(source ?? '').split('/').pop() ?? '';
  return name.replace(/\.md$/i, '');
}

/** Coerce a frontmatter value into a clean list of non-empty strings. */
function asList(value) {
  if (Array.isArray(value)) {
    return value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/** Locale-independent ordering. `localeCompare` would vary with host ICU. */
function codeUnitCompare(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Split an inline YAML list on commas that are not inside quotes. A plain
 * `split(',')` corrupts any value that contains a comma, which is exactly what
 * a keyword like `v1, v2` is: `["a,b"]` came back as `["", "b\""]`.
 * An unterminated quote keeps its text as written instead of throwing — a
 * hand-edited file must still load.
 */
function splitInlineList(inner) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (quote) {
      current += char;
      if (quote === '"' && char === '\\' && i + 1 < inner.length) {
        i += 1;
        current += inner[i];
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

const unquoteItem = item => {
  const text = item.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
};

function yamlScalar(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return splitInlineList(inner).map(unquoteItem);
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * Flat frontmatter only: `key: scalar` plus `- item` list continuation. A
 * nested map or a multi-line scalar is not part of the memory format, so it is
 * left in the body rather than half-parsed.
 */
function parseFrontmatter(raw) {
  // A BOM is not content: Windows editors add one to .md files, and without
  // this the whole block falls through to the body, which silently degrades
  // the entry to its filename and its first line.
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };
  const data = {};
  let listKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([\w-]+):\s*(.*)$/.exec(line);
    if (pair) {
      listKey = null;
      const value = pair[2].trim();
      if (value === '') {
        listKey = pair[1];
        data[pair[1]] = [];
      } else {
        data[pair[1]] = yamlScalar(value);
      }
      continue;
    }
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) data[listKey].push(yamlScalar(item[1]));
  }
  return { data, body: text.slice(match[0].length) };
}

const yamlString = value => JSON.stringify(String(value));
const yamlList = values => `[${values.map(v => JSON.stringify(String(v))).join(', ')}]`;

module.exports = {
  normalize, clip, sanitize, sha, firstLine, basename, asList, codeUnitCompare,
  yamlScalar, parseFrontmatter, yamlString, yamlList,
};
