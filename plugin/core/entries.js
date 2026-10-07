'use strict';

// The memory model: what an entry is, where it lives, how a corpus is loaded,
// and how ids are allocated. Pure logic — the reader/io objects are injected by
// the caller (the plugin process uses the host gateway, the agent extension
// uses its own confined fs).

const {
  normalize, clip, firstLine, basename, asList, codeUnitCompare, sha,
  parseFrontmatter, yamlString, yamlList,
} = require('./text.js');

const MEMORY_DIR = '.workflow/memory';
const INBOX_DIR = '.workflow/memory-inbox';

/** The project map is a singleton, so it has a fixed id and no date. */
const MAP_ID = 'MAP';

const KINDS = ['lesson', 'rule', 'decision', 'procedure', 'map', 'preference'];

const KIND_PREFIX = {
  lesson: 'LSN', rule: 'RUL', decision: 'DEC', procedure: 'HOW', map: 'MAP', preference: 'PRF',
};

/** Short tag used inside the injection block, so the model sees the type. */
const KIND_TAG = {
  lesson: 'lesson', rule: 'rule', decision: 'decision',
  procedure: 'howto', map: 'map', preference: 'pref',
};

const INACTIVE = new Set(['deprecated', 'superseded', 'archived', 'retired']);

/** A generated id must match this; anything else falls back to the filename. */
const ID_PATTERN = /^(?:MAP|[A-Z]{3}-\d{8}-[a-z0-9]{1,48}(?:-\d{1,3})?)$/;

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 2000;
/**
 * A corpus budget the original lacked: 2000 files at 256 KB each is 512 MB.
 * Reads stop once this many bytes have been queued.
 */
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
/** Matching only looks at the head of a body; the rest is for `load`. */
const MATCH_BODY_CHARS = 20000;
const MAX_LOAD_CHARS = 20000;

/**
 * Only structured codes count as "missing". The original also matched message
 * text, which turned permission failures into a silently empty corpus.
 */
const isMissing = error => ['ENOENT', 'ENOTDIR', 'NOT_FOUND'].includes(error?.code);

const isActive = entry => !INACTIVE.has(entry.status) && !entry.supersededBy;

function slug(title) {
  const ascii = normalize(title).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return ascii.length >= 3 ? ascii : sha(title).slice(0, 8);
}

/** Local calendar date. `toISOString()` would be UTC and off by a day. */
function localDate(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Allocate an id, suffixing `-2`, `-3`, … on collision. Bounded: an unbounded
 * probe loop is how a stuck host turns into a hung turn.
 */
function newEntryId(kind, title, date, taken) {
  if (kind === 'map') return MAP_ID;
  const base = `${KIND_PREFIX[kind]}-${String(date).replace(/-/g, '')}-${slug(title)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; n <= 999; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`cannot allocate a unique id for "${clip(title, 60)}"`);
}

function parseEntry(source, raw) {
  const { data, body } = parseFrontmatter(raw);
  const text = String(body ?? '').trim();
  const kind = KINDS.includes(data.kind) ? data.kind : 'lesson';
  const rawId = typeof data.id === 'string' ? data.id.trim() : '';
  const id = ID_PATTERN.test(rawId) ? rawId : basename(source);
  const title = typeof data.title === 'string' && data.title.trim()
    ? data.title.trim()
    : (firstLine(text) || basename(source));
  const summary = String(data.description || data.summary || firstLine(text) || title);
  return {
    id,
    kind,
    title,
    keywords: asList(data.keywords ?? data.tags),
    status: normalize(data.status) || 'active',
    pinned: data.pinned === true || data.pinned === 'true' || kind === 'map',
    summary: clip(summary, 160),
    body: text,
    source,
    created: typeof data.created === 'string' ? data.created : '',
    updated: typeof data.updated === 'string' ? data.updated : '',
    related: asList(data.related),
    supersededBy: typeof data.supersededBy === 'string' && data.supersededBy.trim()
      ? data.supersededBy.trim()
      : null,
    batchRef: typeof data.batchRef === 'string' && data.batchRef ? data.batchRef : null,
  };
}

/**
 * Walk both memory directories and parse every `.md` file. Ordering is by
 * code unit so the first-wins rule for duplicate ids is reproducible.
 */
async function loadCorpus(reader) {
  const files = [];
  let queued = 0;
  const walk = async dir => {
    if (files.length >= MAX_FILES || queued >= MAX_TOTAL_BYTES) return;
    let listed;
    try { listed = await reader.list(dir); }
    catch (error) { if (isMissing(error)) return; throw error; }
    for (const entry of [...listed].sort((a, b) => codeUnitCompare(a.path, b.path))) {
      if (files.length >= MAX_FILES || queued >= MAX_TOTAL_BYTES) return;
      if (entry.isDirectory) { await walk(entry.path); continue; }
      if (!/\.md$/i.test(entry.name)) continue;
      const size = Number.isFinite(entry.size) ? entry.size : 0;
      if (size > MAX_FILE_BYTES) continue;
      queued += size;
      files.push(entry.path);
    }
  };
  await walk(MEMORY_DIR);

  const entries = [];
  const seen = new Set();
  for (const source of files) {
    let raw;
    try { raw = await reader.read(source); }
    catch (error) { if (isMissing(error)) continue; throw error; }
    const entry = parseEntry(source, raw);
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

function renderEntry({ id, kind, title, keywords, content, created, pinned, batchRef, supersedes, related }) {
  const lines = [
    '---',
    `id: ${yamlString(id)}`,
    `kind: ${kind}`,
    `title: ${yamlString(title)}`,
    `keywords: ${yamlList(keywords ?? [])}`,
    'status: active',
    `created: ${created}`,
  ];
  if (pinned) lines.push('pinned: true');
  if (batchRef) lines.push(`batchRef: ${batchRef}`);
  if (supersedes) lines.push(`supersedes: ${yamlString(supersedes)}`);
  if (related?.length) lines.push(`related: ${yamlList(related)}`);
  lines.push('---', '', String(content ?? '').trim(), '');
  return lines.join('\n');
}

/**
 * Replace or add top-level frontmatter fields. Strings are written quoted and
 * arrays inline; an existing block list under a replaced key is removed.
 */
function setFrontmatterFields(raw, fields) {
  const scalar = value => (typeof value === 'boolean' ? String(value) : yamlString(value));
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? yamlList(value) : scalar(value)}`);
  // Keep the file's BOM, but match past it. Without that a BOM file takes the
  // fallback branch and the entry is rewritten behind a second frontmatter
  // block, which permanently scrambles its title and kind.
  const source = String(raw ?? '');
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = bom ? source.slice(1) : source;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!match) return `${bom}---\n${rendered.join('\n')}\n---\n\n${text}`;
  const kept = [];
  let skipping = false;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([\w-]+):/.exec(line);
    if (pair) skipping = Object.hasOwn(fields, pair[1]);
    else if (!/^\s+-\s+/.test(line) && line.trim()) skipping = false;
    if (!skipping) kept.push(line);
  }
  return `${bom}---\n${[...kept, ...rendered].join('\n')}\n---${match[2] || '\n'}${text.slice(match[0].length)}`;
}

/**
 * Replace everything after the closing `---`, keeping the frontmatter block and
 * any BOM byte for byte. Used when the user edits an entry body in the view.
 */
function setEntryBody(raw, body) {
  const source = String(raw ?? '');
  const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
  const text = bom ? source.slice(1) : source;
  const match = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.exec(text);
  const head = (match ? match[0] : '---\n\n').replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  return `${bom}${head}\n${String(body ?? '').trim()}\n`;
}

/**
 * Apply one view edit: frontmatter fields first, then the body. Both helpers
 * preserve the BOM and the block boundaries, so the order cannot re-open the
 * frontmatter and put the body inside it.
 */
function rewriteEntry(raw, { fields = {}, body } = {}) {
  const withFields = Object.keys(fields).length
    ? setFrontmatterFields(raw, fields)
    : String(raw ?? '');
  return body === undefined ? withFields : setEntryBody(withFields, body);
}

module.exports = {
  MEMORY_DIR, INBOX_DIR, MAP_ID, KINDS, KIND_PREFIX, KIND_TAG, INACTIVE, ID_PATTERN,
  MAX_FILE_BYTES, MAX_FILES, MAX_TOTAL_BYTES, MATCH_BODY_CHARS, MAX_LOAD_CHARS,
  isMissing, isActive, slug, localDate, newEntryId, parseEntry, loadCorpus,
  renderEntry, setFrontmatterFields, setEntryBody, rewriteEntry,
};
