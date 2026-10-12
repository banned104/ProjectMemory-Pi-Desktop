'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../plugin/core/index.js');
const { createComparisonStore } = require('../plugin/comparison.js');
const { mdFile, MEMORY } = require('./helpers.js');
const entry = (id, body = 'Linux steps', kind = 'lesson') => core.parseEntry(MEMORY + '/' + id + '.md', mdFile(id, { title: 'Build setup', body, kind, keywords: ['build'] }));
const item = { kind: 'lesson', title: 'Build setup', content: 'Windows steps', keywords: ['build'] };
const decision = (extra = {}) => ({ index: 0, action: 'replace', targetId: 'LSN-20260101-old', reason: 'Add verified Windows requirements', same: 'Build prerequisites', changes: 'Add Windows paths, retain Linux steps', scope: 'Windows and Linux', evidence: ['Windows build test passed'], content: 'Linux steps and Windows steps', ...extra });

test('prepare supplies full candidate bodies and version without writing memory', () => {
  const store = createComparisonStore(); const old = entry('LSN-20260101-old');
  const prepared = store.prepare([item], [old], 's1');
  assert.equal(prepared.status, 'comparison-required');
  assert.equal(prepared.items[0].candidates[0].body, 'Linux steps');
  assert.equal(prepared.items[0].candidates[0].complete, true);
  assert.equal(prepared.items[0].candidates[0].baseHash, old.hash);
  const final = store.finalize(prepared.reviewToken, [decision()], [old], 's1');
  assert.equal(final.prepared[0].analysis.action, 'replace');
  assert.equal(final.prepared[0].item.content, 'Linux steps and Windows steps');
});

test('truncated candidates require actual consecutive paging before proposal', () => {
  const store = createComparisonStore(); const old = entry('LSN-20260101-old', 'x'.repeat(19000));
  const prepared = store.prepare([item], [old], 's1'); const c = prepared.items[0].candidates[0];
  assert.equal(c.body.length, 8000); assert.equal(c.complete, false); assert.equal(c.nextOffset, 8000);
  assert.throws(() => store.finalize(prepared.reviewToken, [decision()], [old], 's1'), e => e.code === 'E_COMPARE_INCOMPLETE');
  assert.throws(() => store.page(prepared.reviewToken, c.id, 16000, [old], 's1'), /offset/);
  store.page(prepared.reviewToken, c.id, 8000, [old], 's1');
  store.page(prepared.reviewToken, c.id, 16000, [old], 's1');
  assert.equal(store.finalize(prepared.reviewToken, [decision()], [old], 's1').prepared.length, 1);
});

test('total body budget is explicit and requires omitted candidates to be paged', () => {
  const store = createComparisonStore(); const entries = [0, 1, 2, 3].map(n => entry('LSN-20260101-p' + n, String(n).repeat(8000)));
  const items = [item, { ...item, title: 'Build guide', content: 'Other steps' }];
  const prepared = store.prepare(items, entries, 's1');
  const chars = prepared.items.flatMap(i => i.candidates).reduce((n, c) => n + c.body.length, 0);
  assert(chars <= 24000); assert.equal(prepared.budget.totalBodyChars, 24000);
  assert(prepared.items.some(i => i.candidates.some(c => !c.complete)));
});

test('shared candidates expose the same consecutive paging offset after budget truncation', () => {
  const store = createComparisonStore(); const old = entry('LSN-20260101-old', 'x'.repeat(19000));
  const p = store.prepare([0, 1, 2, 3].map(index => ({ ...item, title: 'Build guide ' + index })), [old], 's1');
  const last = p.items[3].candidates[0];
  assert.equal(last.body, '');
  assert.equal(last.nextOffset, 8000);
  const page = store.page(p.reviewToken, last.id, last.nextOffset, [old], 's1');
  assert.equal(page.offset, 8000); assert.equal(page.nextOffset, 16000);
});

test('review tokens reject another session or changed target versions', () => {
  const store = createComparisonStore(); const old = entry('LSN-20260101-old'); const p = store.prepare([item], [old], 's1');
  assert.throws(() => store.finalize(p.reviewToken, [decision()], [old], 's2'), e => e.code === 'E_COMPARE_STALE');
  assert.throws(() => store.finalize(p.reviewToken, [decision()], [entry(old.id, 'changed')], 's1'), e => e.code === 'E_COMPARE_STALE');
});

test('exact duplicate defaults to no card and cross-kind candidates cannot be targets', () => {
  const store = createComparisonStore(); const old = entry('LSN-20260101-old', item.content);
  const p = store.prepare([item], [old], 's1');
  assert.equal(p.status, 'no-change'); assert.equal(p.items[0].duplicateOf, old.id);
  const rule = entry('RUL-20260101-rule', 'Project rule', 'rule'); const other = store.prepare([item], [rule], 's1');
  assert.equal(other.items[0].warnings[0].kind, 'rule');
  assert.throws(() => store.finalize(other.reviewToken, [decision({ targetId: rule.id })], [rule], 's1'), /target/);
});

test('final body cannot introduce unread candidates or bypass exact duplication', () => {
  const store = createComparisonStore();
  const old = entry('LSN-20260101-old');
  const other = core.parseEntry(MEMORY + '/LSN-20260101-other.md', mdFile('LSN-20260101-other', { title: 'Deployment', body: 'Deployment-only steps', keywords: ['deployment'] }));
  const p = store.prepare([item], [old, other], 's1');
  assert.equal(p.items[0].candidates.length, 1);
  assert.throws(() => store.finalize(p.reviewToken, [decision({ content: other.body })], [old, other], 's1'), e => e.code === 'E_COMPARE_STALE');
  assert.throws(() => store.finalize(p.reviewToken, [decision({ content: old.body })], [old, other], 's1'), e => e.code === 'E_COMPARE_INVALID');
  const duplicate = store.prepare([{ ...item, content: old.body }], [old], 's1');
  assert.throws(() => store.finalize(duplicate.reviewToken, [decision({ action: 'create', targetId: null, content: old.body })], [old], 's1'), e => e.code === 'E_COMPARE_INVALID');
});

test('incomplete or unsupported agent decisions cannot produce an approved suggestion', () => {
  const store = createComparisonStore(); const old = entry('LSN-20260101-old'); const p = store.prepare([item], [old], 's1');
  assert.throws(() => store.finalize(p.reviewToken, [decision({ reason: '' })], [old], 's1'), /reason/);
  assert.throws(() => store.finalize(p.reviewToken, [decision({ action: 'delete' })], [old], 's1'), /action/);
  assert.throws(() => store.finalize(p.reviewToken, [], [old], 's1'), /decision/);
});
