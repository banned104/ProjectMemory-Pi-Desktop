'use strict';

// Regression tests for hour-level timestamps, the heat ledger, the timeline
// view and the end-of-task nudge:
// - localDateTime format (local offset, second precision)
// - newEntryId still derives a day-only id from a full stamp
// - renderEntry writes updated at birth; cardOf falls back to created
// - sortCards/orderCards compare epochs (mixed offsets stay chronological)
// - backlinks stamp updated on the retired/linked entry
// - heat ledger round-trips and never breaks reads
// - timelineHtml groups by day with HH:MM rows

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../plugin/core/index.js');
const ui = require('../plugin/views/ui.js');
const extension = require('../plugin/extension.js');
const { memoryIo, makeEntry, mdFile, MEMORY, INBOX } = require('./helpers.js');

// --- localDateTime ------------------------------------------------------------

test('localDateTime carries the local offset at second precision', () => {
  const stamp = core.localDateTime(new Date(2026, 9, 9, 14, 32, 5));
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.ok(stamp.startsWith('2026-10-09T14:32:05'), 'local fields, not UTC');
  const off = -new Date(2026, 9, 9, 14, 32, 5).getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  assert.ok(stamp.endsWith(`${sign}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`));
});

test('newEntryId still derives a day-only id from a full stamp', () => {
  const id = core.newEntryId('lesson', 'Alpha', '2026-10-09T14:32:05+08:00', new Set());
  assert.match(id, /^LSN-20261009-alpha$/);
});

// --- updated at birth + lazy migration -----------------------------------------

test('a created entry carries updated equal to created', () => {
  const source = core.renderEntry({
    id: 'LSN-20261009-alpha', kind: 'lesson', title: 'Alpha', keywords: ['a'],
    content: 'Body.', created: '2026-10-09T14:32:05+08:00', pinned: false,
  });
  assert.ok(source.includes('updated: 2026-10-09T14:32:05+08:00'));
  const entry = core.parseEntry(`${MEMORY}/LSN-20261009-alpha.md`, source);
  assert.equal(entry.created, '2026-10-09T14:32:05+08:00');
  assert.equal(entry.updated, '2026-10-09T14:32:05+08:00');
});

test('cardOf reads an old updated-less entry as updated === created', () => {
  const entry = makeEntry({ id: 'OLD', created: '2026-09-21', updated: '' });
  const card = core.cardOf(entry);
  assert.equal(card.created, '2026-09-21');
  assert.equal(card.updated, '2026-09-21');
  assert.equal(card.hits, 0);
  assert.equal(card.lastAccess, '');
});

// --- epoch ordering ---------------------------------------------------------------

test('sortCards orders same-day edits by time, not by id', () => {
  const cards = [
    { id: 'B', created: '2026-10-09T09:00:00+08:00', updated: '' },
    { id: 'A', created: '2026-10-09T14:32:05+08:00', updated: '' },
  ];
  assert.deepEqual(core.sortCards(cards).map(c => c.id), ['A', 'B']);
  assert.deepEqual(core.sortCards(cards, 'asc').map(c => c.id), ['B', 'A']);
});

test('sortCards stays chronological across mixed offsets', () => {
  // 12:00+08:00 is 04:00Z — later than 03:00Z, though the string is greater.
  const cards = [
    { id: 'STR', created: '2026-10-09T03:00:00Z', updated: '' },
    { id: 'OFF', created: '2026-10-09T12:00:00+08:00', updated: '' },
  ];
  assert.deepEqual(core.sortCards(cards).map(c => c.id), ['OFF', 'STR']);
  assert.deepEqual(ui.orderCards(cards).map(c => c.id), ['OFF', 'STR']);
  assert.deepEqual(ui.orderCards(cards, 'asc').map(c => c.id), ['STR', 'OFF']);
});

test('sortCards hot ranks by hits then lastAccess, pinned first', () => {
  const cards = [
    { id: 'C', pinned: false, hits: 1, lastAccess: '2026-10-09T10:00:00+08:00', created: '2026-01-01', updated: '' },
    { id: 'A', pinned: false, hits: 5, lastAccess: '2026-10-01T10:00:00+08:00', created: '2026-01-01', updated: '' },
    { id: 'B', pinned: false, hits: 5, lastAccess: '2026-10-09T10:00:00+08:00', created: '2026-01-01', updated: '' },
    { id: 'P', pinned: true, hits: 0, lastAccess: '', created: '2026-01-01', updated: '' },
  ];
  assert.deepEqual(core.sortCards(cards, 'hot').map(c => c.id), ['P', 'B', 'A', 'C']);
  assert.deepEqual(ui.orderCards(cards, 'hot').map(c => c.id), ['P', 'B', 'A', 'C']);
});

test('daysSince accepts a datetime stamp', () => {
  const now = Date.parse('2026-10-09T12:00:00+08:00');
  assert.ok(core.daysSince('2026-10-09T11:00:00+08:00', now) < 1);
  assert.ok(core.daysSince('2026-10-01', now) > 7);
});

// --- backlink stamps updated -------------------------------------------------------

test('a replace backlink refreshes updated on the retired entry', async () => {
  const source = `${MEMORY}/LSN-20260101-old.md`;
  const io = memoryIo({ [source]: mdFile('LSN-20260101-old', { title: 'Alpha' }) });
  const [item] = core.validateItems([{ kind: 'lesson', title: 'Alpha', content: 'better', keywords: [] }]);
  const batch = core.buildBatch({
    prepared: [{ item, similar: [core.parseEntry(source, io.files.get(source))] }],
    locale: 'en', id: 'KB-11111111-2222-3333-4444-555555555555',
  });
  await core.commitBatch(io, batch, [{ index: 0, key: 'replace:LSN-20260101-old' }]);
  const old = core.parseEntry(source, io.files.get(source));
  assert.equal(old.status, 'deprecated');
  assert.match(old.updated, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

// --- heat ledger ----------------------------------------------------------------------

test('the heat ledger round-trips hits and lastAccess', async () => {
  const io = memoryIo({});
  assert.deepEqual(await core.readHeat(io), {});
  await core.recordHeat(io, ['A', 'B'], '2026-10-09T10:00:00+08:00');
  await core.recordHeat(io, ['A'], '2026-10-09T11:00:00+08:00');
  assert.deepEqual(await core.readHeat(io), {
    A: { hits: 2, lastAccess: '2026-10-09T11:00:00+08:00' },
    B: { hits: 1, lastAccess: '2026-10-09T10:00:00+08:00' },
  });
});

test('a missing or corrupt ledger reads as empty, never throws', async () => {
  const io = memoryIo({});
  assert.deepEqual(await core.readHeat(io), {});
  await io.writeText(core.HEAT_FILE, 'not json{{{');
  assert.deepEqual(await core.readHeat(io), {});
  await io.writeText(core.HEAT_FILE, '["an", "array"]');
  assert.deepEqual(await core.readHeat(io), {});
});

test('the ledger lives outside the corpus and lists no batches', async () => {
  const io = memoryIo({});
  await core.recordHeat(io, ['A']);
  assert.ok(io.files.has(`${INBOX}/.heat.json`));
  assert.deepEqual((await core.loadCorpus(io.reader)).map(e => e.id), []);
  assert.deepEqual(await core.listBatches(io), []);
});

// --- timeline + display ------------------------------------------------------------------

test('shortWhen compacts datetimes and leaves day-only stamps alone', () => {
  assert.equal(ui.shortWhen('2026-10-09T14:32:05+08:00'), '10-09 14:32');
  assert.equal(ui.shortWhen('2026-10-09'), '2026-10-09');
  assert.equal(ui.shortWhen(''), '');
});

test('timelineHtml renders the day header even when the only row is being edited', () => {
  const c = {
    id: 'A', kind: 'lesson', title: 'Alpha', summary: '', keywords: [], status: 'active', active: true,
    pinned: false, pinnedForced: false, supersededBy: null, related: [], batchRef: null,
    created: '2026-10-09T14:32:05+08:00', updated: '', chars: 1,
  };
  const html = ui.timelineHtml([c], { locale: 'en', editing: { ...c, body: 'draft' } });
  assert.ok(html.includes('pm-tl-day'), 'the day header must not be swallowed by the edited row');
  assert.ok(html.includes('<form'));
});

test('timelineHtml groups by day, newest first, with HH:MM rows', () => {
  const cards = [
    { id: 'B', kind: 'lesson', title: 'Beta', summary: '', keywords: [], status: 'active', active: true, pinned: false, pinnedForced: false, supersededBy: null, related: [], batchRef: null, created: '2026-10-08T09:00:00+08:00', updated: '', chars: 1 },
    { id: 'A', kind: 'rule', title: 'Alpha', summary: '', keywords: [], status: 'active', active: true, pinned: true, pinnedForced: false, supersededBy: null, related: [], batchRef: null, created: '2026-10-09T14:32:05+08:00', updated: '', chars: 1 },
    { id: 'C', kind: 'lesson', title: 'Gamma', summary: '', keywords: [], status: 'active', active: true, pinned: false, pinnedForced: false, supersededBy: null, related: [], batchRef: null, created: '2026-10-09T08:00:00+08:00', updated: '', chars: 1 },
  ];
  const html = ui.timelineHtml(cards, { locale: 'en' });
  const day9 = html.indexOf('2026-10-09');
  const day8 = html.indexOf('2026-10-08');
  assert.ok(day9 >= 0 && day8 > day9, 'day headers newest first');
  assert.ok(html.indexOf('14:32') > day9 && html.indexOf('14:32') < day8, 'row time under its day');
  assert.ok(html.includes('data-id="A"') && html.includes('data-act="edit"'));
  // No pinned-first in a timeline: the pinned A still sorts by time, not on top by force.
  assert.ok(html.indexOf('data-id="A"') < html.indexOf('data-id="C"'));
});

test('cardHtml shows the compact time and the read count', () => {
  const base = { id: 'A', kind: 'lesson', title: 'T', summary: 's', keywords: [], status: 'active', active: true, pinned: false, pinnedForced: false, supersededBy: null, related: [], batchRef: null, created: '2026-10-09T14:32:05+08:00', updated: '', chars: 1, hits: 0, lastAccess: '' };
  const plain = ui.cardHtml(base, { locale: 'en' });
  assert.ok(plain.includes('10-09 14:32'));
  assert.ok(!plain.includes('reads'));
  const hot = ui.cardHtml({ ...base, hits: 3 }, { locale: 'zh-CN' });
  assert.ok(hot.includes('3 阅读'));
});

// --- end-of-task nudge ----------------------------------------------------------------------

test('the guidance nudges a wrap-up proposal at the end of a task', () => {
  assert.match(extension._internals.GUIDANCE, /When a task ends, ask whether anything reusable came out of it/);
  assert.match(extension._internals.GUIDANCE, /propose it now instead of leaving it for later/);
});
