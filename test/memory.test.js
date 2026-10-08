'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const memory = require('../plugin/core/memory.js');
const entries = require('../plugin/core/entries.js');

const SOURCE = '.workflow/memory/LES-20260921-config-file.md';

/** A real parsed entry, so `cardOf` sees the shape `loadCorpus` produces. */
const entry = (source, frontmatter, body = 'Body line.') => entries.parseEntry(
  source,
  `---\n${frontmatter}\n---\n\n${body}\n`,
);

const throwsWith = (fn, code) => {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught, `expected ${code} to be thrown`);
  assert.equal(caught.code, code);
  return caught;
};

// ---------------------------------------------------------------------------
// cardOf
// ---------------------------------------------------------------------------

test('cardOf exposes exactly the fields a card needs, already clipped', () => {
  const card = memory.cardOf(entry(
    SOURCE,
    'id: "LES-20260921-config-file"\nkind: lesson\ntitle: "Config file"\nkeywords: ["config", "json"]\nstatus: active\ncreated: 2026-09-21\nupdated: 2026-09-25\nbatchRef: BAT-1\nrelated: ["LES-20260901-other"]',
    'First line.\nSecond line.',
  ));

  assert.deepEqual(Object.keys(card).sort(), [
    'active', 'batchRef', 'chars', 'created', 'id', 'keywords', 'kind', 'pinned',
    'pinnedForced', 'related', 'status', 'summary', 'supersededBy', 'title', 'updated',
  ]);
  assert.equal(card.id, 'LES-20260921-config-file');
  assert.equal(card.title, 'Config file');
  assert.equal(card.summary, 'First line.');
  assert.deepEqual(card.keywords, ['config', 'json']);
  assert.deepEqual(card.related, ['LES-20260901-other']);
  assert.equal(card.created, '2026-09-21');
  assert.equal(card.updated, '2026-09-25');
  assert.equal(card.active, true);
  assert.equal(card.chars, 'First line.\nSecond line.'.length);
});

test('cardOf strips the markup a hostile entry would need to break out', () => {
  const card = memory.cardOf(entry(
    SOURCE,
    'id: "LES-20260921-config-file"\nkind: lesson\ntitle: "<img src=x onerror=alert(1)>"\nkeywords: ["</style><script>x</script>"]\nstatus: active\ncreated: 2026-09-21',
    'ignored',
  ));
  assert.ok(!card.title.includes('<') && !card.title.includes('>'));
  assert.ok(!card.keywords[0].includes('<') && !card.keywords[0].includes('>'));
  assert.ok(!card.summary.includes('<') && !card.summary.includes('>'));
});

test('cardOf reports a map entry as pinned by definition, not by choice', () => {
  const map = memory.cardOf(entry(
    '.workflow/memory/MAP.md',
    'id: "MAP"\nkind: map\ntitle: "Layout"\nkeywords: []\nstatus: active\ncreated: 2026-09-21',
  ));
  assert.equal(map.pinned, true);
  assert.equal(map.pinnedForced, true);

  const lesson = memory.cardOf(entry(SOURCE, 'kind: lesson\ntitle: "T"\nkeywords: []\nstatus: active\ncreated: 2026-09-21'));
  assert.equal(lesson.pinnedForced, false);
});

test('cardOf keeps a non-standard status visible instead of rewriting it', () => {
  const card = memory.cardOf(entry(SOURCE, 'kind: lesson\ntitle: "T"\nkeywords: []\nstatus: archived\ncreated: 2026-09-21'));
  assert.equal(card.status, 'archived');
  assert.equal(card.active, false);
});

// ---------------------------------------------------------------------------
// sortCards / daysSince / statsOf
// ---------------------------------------------------------------------------

test('sortCards puts the most recently edited first, then falls back to created', () => {
  const card = (id, created, updated) => ({ id, created, updated });
  const sorted = memory.sortCards([
    card('B', '2026-01-01', '2026-03-01'),
    card('A', '2026-02-02', ''),
    card('C', '2026-02-02', ''),
  ]);
  assert.deepEqual(sorted.map(c => c.id), ['B', 'A', 'C']);
});

test('daysSince is inclusive of today and Infinity for an empty date', () => {
  const now = Date.parse('2026-09-25T12:00:00');
  assert.ok(memory.daysSince('2026-09-25', now) < 1);
  assert.equal(memory.daysSince('', now), Infinity);
  assert.equal(memory.daysSince('not a date', now), Infinity);
});

test('statsOf counts kinds, states and the last week', () => {
  const now = Date.parse('2026-09-25T12:00:00');
  const cards = [
    { id: '1', kind: 'lesson', active: true, pinned: false, created: '2026-09-24', updated: '' },
    { id: '2', kind: 'rule', active: true, pinned: true, created: '2026-09-25', updated: '' },
    { id: '3', kind: 'lesson', active: false, pinned: false, created: '2026-01-01', updated: '2026-09-20' },
    { id: '4', kind: 'map', active: true, pinned: true, created: '2026-01-01', updated: '' },
  ];
  const stats = memory.statsOf(cards, { pending: 2, now });

  assert.equal(stats.total, 4);
  assert.equal(stats.active, 3);
  assert.equal(stats.retired, 1);
  assert.equal(stats.pinned, 2);
  assert.equal(stats.pending, 2);
  // 1 and 2 are this week; 3 was edited five days ago; 4 is from January.
  assert.equal(stats.recent, 3);
  assert.equal(stats.byKind.lesson, 2);
  assert.equal(stats.byKind.rule, 1);
  assert.equal(stats.byKind.map, 1);
  assert.equal(stats.byKind.preference, 0);
});

test('statsOf counts an edit date as recent even for an old entry', () => {
  const now = Date.parse('2026-09-25T12:00:00');
  const stats = memory.statsOf(
    [{ id: '1', kind: 'rule', active: true, pinned: false, created: '2020-01-01', updated: '2026-09-24' }],
    { now },
  );
  assert.equal(stats.recent, 1);
});

// ---------------------------------------------------------------------------
// validatePatch
// ---------------------------------------------------------------------------

test('validatePatch accepts each editable field and normalizes it', () => {
  const patch = memory.validatePatch({
    title: '  New title  ',
    kind: 'RULE',
    keywords: ['a', ' b ', 'a', ''],
    pinned: true,
    status: 'retired',
    body: '  Some body  ',
  });
  assert.deepEqual(patch, {
    title: 'New title',
    kind: 'rule',
    keywords: ['a', 'b'],
    pinned: true,
    status: 'retired',
    body: '  Some body  ',
  });
});

test('validatePatch accepts keywords as a comma-separated string', () => {
  assert.deepEqual(memory.validatePatch({ keywords: 'alpha, beta' }).keywords, ['alpha', 'beta']);
});

test('validatePatch refuses anything outside the editable set', () => {
  throwsWith(() => memory.validatePatch({ id: 'MAP' }), 'notEditable');
  throwsWith(() => memory.validatePatch({ batchRef: 'BAT-1' }), 'notEditable');
  throwsWith(() => memory.validatePatch({ related: ['x'] }), 'notEditable');
  throwsWith(() => memory.validatePatch({}), 'nothingToChange');
  throwsWith(() => memory.validatePatch(null), 'nothingToChange');
});

test('validatePatch refuses values the store could not round-trip', () => {
  throwsWith(() => memory.validatePatch({ title: '   ' }), 'titleRequired');
  throwsWith(() => memory.validatePatch({ title: 'x'.repeat(121) }), 'titleTooLong');
  throwsWith(() => memory.validatePatch({ kind: 'note' }), 'badKind');
  throwsWith(() => memory.validatePatch({ keywords: ['x'.repeat(41)] }), 'keywordTooLong');
  throwsWith(() => memory.validatePatch({ keywords: Array.from({ length: memory.MAX_KEYWORDS + 1 }, (_, i) => `k${i}`) }), 'tooManyKeywords');
  throwsWith(() => memory.validatePatch({ pinned: 'true' }), 'badPinned');
  throwsWith(() => memory.validatePatch({ status: 'gone' }), 'badStatus');
  throwsWith(() => memory.validatePatch({ body: ' \n ' }), 'bodyRequired');
  throwsWith(() => memory.validatePatch({ body: 'x'.repeat(memory.MAX_BODY + 1) }), 'bodyTooLong');
});

// ---------------------------------------------------------------------------
// fieldsOf
// ---------------------------------------------------------------------------

test('fieldsOf writes the changed fields and always the timestamp', () => {
  assert.deepEqual(
    memory.fieldsOf({ title: 'T', pinned: false }, '2026-09-25'),
    { updated: '2026-09-25', title: 'T', pinned: false },
  );
});

test('fieldsOf still stamps an edit that only changed the body', () => {
  assert.deepEqual(memory.fieldsOf({ body: 'text' }, '2026-09-25'), { updated: '2026-09-25' });
});

// ---------------------------------------------------------------------------
// deleteTarget
// ---------------------------------------------------------------------------

test('deleteTarget accepts only an entry file inside the memory directory', () => {
  assert.equal(memory.deleteTarget('.workflow/memory/LES-20260921-x.md'), '.workflow/memory/LES-20260921-x.md');
  assert.equal(memory.deleteTarget('.workflow/memory/sub/LES-20260921-x.MD'), '.workflow/memory/sub/LES-20260921-x.MD');
});

test('deleteTarget refuses every way of naming something else', () => {
  for (const bad of [
    '.workflow/memory/../secret.md',
    '.workflow/memory/a\\b.md',
    '.workflow/memory-inbox/BAT-1.md',
    '.workflow/memory/DISABLED',
    '.workflow/memory/nested//x.md',
    '.workflow/memory/./x.md',
    '/abs/x.md',
    '.workflow/memory/x.txt',
    '.workflow/memory/',
    '',
    null,
    42,
  ]) {
    throwsWith(() => memory.deleteTarget(bad), 'badTarget');
  }
});

// ---------------------------------------------------------------------------
// Round trip through the entry rewriter
// ---------------------------------------------------------------------------

test('an edited entry still parses to the values the user typed', () => {
  const source = entries.renderEntry({
    id: 'LES-20260921-config-file',
    kind: 'lesson',
    title: 'Old title',
    keywords: ['old'],
    content: 'Old body.',
    created: '2026-09-21',
    pinned: false,
    batchRef: 'BAT-1',
    supersedes: 'LES-20260901-older',
    related: ['LES-20260902-linked'],
  });

  const patch = memory.validatePatch({
    title: 'New title',
    kind: 'procedure',
    keywords: ['new', 'other'],
    pinned: true,
    status: 'retired',
    body: 'New body.',
  });
  const next = entries.rewriteEntry(source, { fields: memory.fieldsOf(patch, '2026-09-25'), body: patch.body });
  const parsed = entries.parseEntry(SOURCE, next);

  assert.equal(parsed.title, 'New title');
  assert.equal(parsed.kind, 'procedure');
  assert.deepEqual(parsed.keywords, ['new', 'other']);
  assert.equal(parsed.pinned, true);
  assert.equal(parsed.status, 'retired');
  assert.equal(parsed.body, 'New body.');
  assert.equal(parsed.created, '2026-09-21');
  assert.equal(parsed.updated, '2026-09-25');
  // Untouched link fields survive an edit.
  assert.equal(parsed.batchRef, 'BAT-1');
  // `supersedes` is the link this entry declares; `supersededBy` is the one it
  // receives. Only the first is present here, and an edit must not invent the other.
  assert.equal(parsed.supersededBy, null);
  assert.ok(next.includes('supersedes: "LES-20260901-older"'));
  assert.deepEqual(parsed.related, ['LES-20260902-linked']);
});

test('a body-only edit leaves the frontmatter byte-identical', () => {
  const source = entries.renderEntry({
    id: 'LES-20260921-config-file',
    kind: 'lesson',
    title: 'Title',
    keywords: ['k'],
    content: 'Old body.',
    created: '2026-09-21',
    pinned: false,
  });
  const next = entries.rewriteEntry(source, { fields: memory.fieldsOf({ body: 'New body.' }, '2026-09-25'), body: 'New body.' });
  const head = raw => raw.slice(0, raw.indexOf('\n---\n') + 5);

  assert.equal(entries.parseEntry(SOURCE, next).body, 'New body.');
  assert.ok(head(next).includes('title: "Title"'));
  assert.ok(head(next).includes('updated: "2026-09-25"'));
  assert.ok(!next.includes('Old body.'));
});
test('sortCards keeps pinned cards on top in every order', () => {
  const cards = [
    { id: 'NEW', created: '2026-09-25', updated: '', pinned: false },
    { id: 'OLD-PIN', created: '2026-01-01', updated: '', pinned: true },
    { id: 'MID', created: '2026-06-01', updated: '', pinned: false },
  ];
  assert.deepEqual(memory.sortCards(cards).map(c => c.id), ['OLD-PIN', 'NEW', 'MID']);
  assert.deepEqual(memory.sortCards(cards, 'desc').map(c => c.id), ['OLD-PIN', 'NEW', 'MID']);
  assert.deepEqual(memory.sortCards(cards, 'asc').map(c => c.id), ['OLD-PIN', 'MID', 'NEW']);
});

test('sortCards puts dateless cards last and falls back to id', () => {
  const cards = [
    { id: 'B', created: '', updated: '', pinned: false },
    { id: 'A', created: '2026-02-02', updated: '', pinned: false },
    { id: 'C', created: '', updated: '', pinned: false },
  ];
  assert.deepEqual(memory.sortCards(cards, 'asc').map(c => c.id), ['A', 'B', 'C']);
  assert.deepEqual(memory.sortCards(cards, 'nonsense').map(c => c.id), ['A', 'B', 'C']);
});
