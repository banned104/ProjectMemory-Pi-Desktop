'use strict';

// Pure logic behind the project-memory view (plugin/views/).
//
// The view is a browser page with no filesystem access: it asks the plugin
// process over `onPanelInvoke`, and the plugin process consults this module
// before it reads or writes anything. Everything here is computation over an
// already-loaded corpus -- no I/O, no globals -- so the rules a page cannot be
// allowed to widen are unit-testable and have exactly one copy.
//
// The view may edit and delete; the agent extension may not. Delete in
// particular only ever runs in the plugin process, from a click on a confirm
// button, and only ever names the `source` path that `loadCorpus` just
// returned. There is no channel that accepts a path from the page.

const text = require('./text.js');
const entries = require('./entries.js');
const batch = require('./batch.js');

 const { MEMORY_DIR, KINDS, isActive } = entries;
 const { normalize, asList, sanitize, firstLine, clip, codeUnitCompare } = text;
 const { MAX_TITLE, MAX_CONTENT, MAX_KEYWORDS } = batch;

/** Fields the view may change. `id`, `created`, `batchRef` and the link fields are not among them. */
const EDITABLE = ['title', 'kind', 'keywords', 'pinned', 'status', 'body'];
/** `archived` / `retired` exist in the format; the view offers one honest switch. */
const STATUSES = ['active', 'retired'];
const MAX_BODY = entries.MAX_LOAD_CHARS;
const RECENT_DAYS = 7;

const fail = (code, message) => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------------------
// Display model
// ---------------------------------------------------------------------------

/**
 * One card. Deliberately a flat, already-sanitised record: the page renders
 * strings it is handed and has nothing to reach for beyond this shape.
 */
function cardOf(entry) {
  return {
    id: entry.id,
    kind: KINDS.includes(entry.kind) ? entry.kind : 'lesson',
    title: sanitize(entry.title, MAX_TITLE),
    summary: sanitize(entry.summary, 200),
    keywords: entry.keywords.slice(0, MAX_KEYWORDS).map(value => sanitize(value, 40)),
    status: entry.status,
    active: isActive(entry),
    pinned: entry.pinned === true,
    // A map entry is pinned by definition, so the toggle would be a lie.
    pinnedForced: entry.kind === 'map',
    supersededBy: entry.supersededBy ? sanitize(entry.supersededBy, 60) : null,
    related: entry.related.map(value => sanitize(value, 60)),
    batchRef: entry.batchRef ? sanitize(entry.batchRef, 60) : null,
    created: entry.created,
    // Lazy migration: entries written before 'updated' existed read as
    // updated === created. The file itself is untouched until the next write.
    updated: entry.updated || entry.created,
    hits: Number.isFinite(entry.hits) ? entry.hits : 0,
    lastAccess: typeof entry.lastAccess === 'string' ? entry.lastAccess : '',
    chars: entry.body.length,
  };
}

/**
 * Millis since epoch for a frontmatter stamp. Accepts the old day-only
 * `YYYY-MM-DD` and the new offset datetime; anything unparseable is dateless.
 * Epoch (not string) comparison is what keeps mixed offsets chronological.
 */
function epochOf(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let at = Date.parse(text);
  if (!Number.isFinite(at)) at = Date.parse(`${text}T00:00:00`);
  return Number.isFinite(at) ? at : null;
}

/**
 * Card order for the view. Pinned cards always come first; the rest follow
 * `updated || created` — newest first by default (`desc`), oldest first for
 * `asc`, most-read first for `hot`. Cards without any date sort last in both
 * time directions, and ties stay reproducible by id. Unknown orders fall back
 * to the default.
 */
const SORT_ORDERS = ['default', 'asc', 'desc', 'hot'];
 function sortCards(cards, order = 'default') {
   if (order === 'hot') {
     const heatOf = card => (Number.isFinite(card.hits) ? card.hits : 0);
     const seenOf = card => epochOf(card.lastAccess) ?? -1;
     return [...cards].sort((a, b) =>
       ((b.pinned === true) - (a.pinned === true))
       || (heatOf(b) - heatOf(a))
       || (seenOf(b) - seenOf(a))
       || codeUnitCompare(a.id, b.id));
   }
   const dir = order === 'asc' ? 1 : -1;
   const when = card => String(card.updated || card.created || '');
   const byTime = (a, b) => {
     const ea = epochOf(when(a));
     const eb = epochOf(when(b));
     if (ea === null && eb === null) return 0;
     if (ea === null) return 1;
     if (eb === null) return -1;
     return dir * (ea - eb) || codeUnitCompare(when(a), when(b));
   };
   return [...cards].sort((a, b) =>
     ((b.pinned === true) - (a.pinned === true))
     || byTime(a, b)
     || codeUnitCompare(a.id, b.id));
 }

function daysSince(date, now) {
  if (!date) return Infinity;
  const text = String(date);
  let then = Date.parse(text);
  if (!Number.isFinite(then)) then = Date.parse(`${text}T00:00:00`);
  return Number.isFinite(then) ? (now - then) / 86400000 : Infinity;
}

/**
 * Counts for the view's overview strip. `pending` is the inbox, not the corpus,
 * so the caller supplies it.
 */
function statsOf(cards, { pending = 0, now = Date.now() } = {}) {
  const byKind = Object.fromEntries(KINDS.map(kind => [kind, 0]));
  let active = 0;
  let pinned = 0;
  let recent = 0;
  for (const card of cards) {
    byKind[card.kind] = (byKind[card.kind] ?? 0) + 1;
    if (card.active) active += 1;
    if (card.pinned) pinned += 1;
    if (daysSince(card.updated || card.created, now) < RECENT_DAYS) recent += 1;
  }
  return {
    total: cards.length,
    active,
    retired: cards.length - active,
    pinned,
    recent,
    pending,
    byKind,
  };
}

// ---------------------------------------------------------------------------
// Edits
// ---------------------------------------------------------------------------

/**
 * Normalize what the page sent into exactly the fields that may be written.
 * Anything unrecognised is an error rather than a silent drop: a page that
 * thinks it changed `id` must be told that it did not.
 */
function validatePatch(patch) {
  const input = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const out = {};

  if (Object.hasOwn(input, 'title')) {
    const title = String(input.title ?? '').trim();
    if (!title) throw fail('titleRequired', 'title must not be empty');
    if (title.length > MAX_TITLE) throw fail('titleTooLong', `title exceeds ${MAX_TITLE} characters`);
    out.title = title;
  }
  if (Object.hasOwn(input, 'kind')) {
    const kind = normalize(input.kind);
    if (!KINDS.includes(kind)) throw fail('badKind', `kind must be one of: ${KINDS.join(', ')}`);
    out.kind = kind;
  }
  if (Object.hasOwn(input, 'keywords')) {
    const source = Array.isArray(input.keywords) ? input.keywords : String(input.keywords ?? '').split(',');
    const keywords = [...new Set(source.map(value => String(value).trim()).filter(Boolean))];
    if (keywords.length > MAX_KEYWORDS) {
      throw fail('tooManyKeywords', `at most ${MAX_KEYWORDS} keywords`);
    }
    for (const value of keywords) {
      if (value.length > 40) throw fail('keywordTooLong', 'a keyword exceeds 40 characters');
    }
    out.keywords = keywords;
  }
  if (Object.hasOwn(input, 'pinned')) {
    if (typeof input.pinned !== 'boolean') throw fail('badPinned', 'pinned must be a boolean');
    out.pinned = input.pinned;
  }
  if (Object.hasOwn(input, 'status')) {
    const status = normalize(input.status);
    if (!STATUSES.includes(status)) throw fail('badStatus', `status must be one of: ${STATUSES.join(', ')}`);
    out.status = status;
  }
  if (Object.hasOwn(input, 'body')) {
    const body = String(input.body ?? '');
    if (!body.trim()) throw fail('bodyRequired', 'body must not be empty');
    if (body.length > MAX_BODY) throw fail('bodyTooLong', `body exceeds ${MAX_BODY} characters`);
    out.body = body;
  }

  const unknown = Object.keys(input).filter(key => !EDITABLE.includes(key));
  if (unknown.length) throw fail('notEditable', `not editable: ${unknown.join(', ')}`);
  if (!Object.keys(out).length) throw fail('nothingToChange', 'no editable field was supplied');
  return out;
}

/**
 * The frontmatter a patch writes. `updated` is always part of it: an edit to
 * the body alone must still move the card up in the view, so the timestamp
 * cannot depend on which field changed.
 */
function fieldsOf(patch, date) {
  const fields = { updated: date };
  if (patch.title !== undefined) fields.title = patch.title;
  if (patch.kind !== undefined) fields.kind = patch.kind;
  if (patch.keywords !== undefined) fields.keywords = patch.keywords;
  if (patch.pinned !== undefined) fields.pinned = patch.pinned;
  if (patch.status !== undefined) fields.status = patch.status;
  return fields;
}

/**
 * The only path a delete may name. It comes from the `source` of an entry the
 * plugin process just loaded, never from the page, so this is the second half
 * of that guarantee rather than the first.
 */
 function deleteTarget(source) {
   const rel = typeof source === 'string' ? source : '';
   const prefix = `${MEMORY_DIR}/`;
   const ok = rel.startsWith(prefix)
     && rel.length > prefix.length + 3
     && /\.md$/i.test(rel)
     && !rel.includes('..')
     && !rel.includes('\\')
     && !rel.includes('\0')
     && !rel.includes(':')
     && rel.charCodeAt(0) !== 0xFEFF
     && !rel.slice(prefix.length).split('/').some(part => !part || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' '));
   if (!ok) throw fail('badTarget', `not a memory entry file: ${rel}`);
   return rel;
 }

module.exports = {
  EDITABLE, STATUSES, SORT_ORDERS, MAX_BODY, RECENT_DAYS,
  cardOf, sortCards, daysSince, statsOf, epochOf,
  validatePatch, fieldsOf, deleteTarget,
  // Re-exported so callers do not have to know which core module owns them.
  MEMORY_DIR, KINDS, MAX_TITLE, MAX_CONTENT, MAX_KEYWORDS,
  sanitize, firstLine, clip,
};
