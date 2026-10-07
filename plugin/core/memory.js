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
const { normalize, asList, sanitize, firstLine, clip } = text;
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
    updated: entry.updated,
    chars: entry.body.length,
  };
}

/** Newest first: an edit moves a card up, and ties stay reproducible by id. */
function sortCards(cards) {
  const when = card => card.updated || card.created || '';
  return [...cards].sort((a, b) =>
    (when(b).localeCompare(when(a)) || a.id.localeCompare(b.id)));
}

function daysSince(date, now) {
  if (!date) return Infinity;
  const then = Date.parse(`${date}T00:00:00`);
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
    && !rel.slice(prefix.length).split('/').some(part => !part || part === '.');
  if (!ok) throw fail('badTarget', `not a memory entry file: ${rel}`);
  return rel;
}

module.exports = {
  EDITABLE, STATUSES, MAX_BODY, RECENT_DAYS,
  cardOf, sortCards, daysSince, statsOf,
  validatePatch, fieldsOf, deleteTarget,
  // Re-exported so callers do not have to know which core module owns them.
  MEMORY_DIR, KINDS, MAX_TITLE, MAX_CONTENT, MAX_KEYWORDS,
  sanitize, firstLine, clip,
};
