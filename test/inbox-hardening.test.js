'use strict';

// Regression tests for the inbox ("pending confirmation") hardening:
// retire idempotency, verdict persistence across rounds, commit-time batch
// integrity, backlink id binding, listBatches error surfacing, and the
// extension's fresh re-read before committing.

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../plugin/core/index.js');
const extension = require('../plugin/extension.js');
const { memoryIo, mdFile, MEMORY, INBOX } = require('./helpers.js');

const { onToolResult } = extension._internals;

const BATCH_ID = 'KB-11111111-2222-3333-4444-555555555555';

const makeItem = (overrides = {}) => core.validateItems([{
  kind: 'lesson', title: 'Alpha', content: 'body text', keywords: ['alpha'], ...overrides,
}])[0];

const makeBatch = (prepared, id = BATCH_ID) => core.buildBatch({ prepared, locale: 'en', id });

// --- retireBatch idempotency ------------------------------------------------

test('retireBatch never resurrects a batch that is already gone', async () => {
  const io = memoryIo({});
  const batch = makeBatch([{ item: makeItem(), similar: [] }]);
  await io.writeText(core.batchPath(batch.id), JSON.stringify(batch));

  await core.retireBatch(io, batch, { saved: [], skipped: 1, warnings: [] });
  assert.equal(io.files.has(core.batchPath(batch.id)), false);

  // A concurrent retire that loses the race sees ENOENT and must not write
  // a `done` file back into existence.
  const missing = memoryIo({});
  await core.retireBatch(missing, batch, { saved: [], skipped: 1, warnings: [] });
  assert.equal(missing.files.has(core.batchPath(batch.id)), false);
});

// --- Verdict persistence across rounds --------------------------------------

test('a skip verdict survives a partial round and counts as skipped, not pending', async () => {
  const io = memoryIo({});
  const batch = makeBatch([
    { item: makeItem({ title: 'Alpha', content: 'first' }), similar: [] },
    { item: makeItem({ title: 'Beta', content: 'second' }), similar: [] },
  ]);
  await io.writeText(core.batchPath(batch.id), JSON.stringify(batch));

  const first = await core.commitBatch(io, await core.readBatch(io, batch.id, 'en'), [{ index: 0, key: 'skip' }]);
  assert.equal(first.skipped, 0 + 1);
  assert.equal(first.pending, 1);

  const second = await core.commitBatch(io, await core.readBatch(io, batch.id, 'en'), []);
  assert.equal(second.saved.length, 0);
  assert.equal(second.skipped, 1, 'the earlier skip is remembered');
  assert.equal(second.pending, 1, 'only the undecided item waits');

  const third = await core.commitBatch(io, await core.readBatch(io, batch.id, 'en'), [{ index: 1, key: 'create' }]);
  assert.equal(third.saved.length, 1);
  assert.equal(third.skipped, 1);
  assert.equal(third.pending, 0);
  assert.equal(io.files.has(core.batchPath(batch.id)), false);
});

test('an entry saved by an earlier round counts as already saved on retry, even without its file', async () => {
  const io = memoryIo({});
  const batch = makeBatch([
    { item: makeItem({ title: 'Alpha', content: 'first' }), similar: [] },
    { item: makeItem({ title: 'Beta', content: 'second' }), similar: [] },
  ]);
  await io.writeText(core.batchPath(batch.id), JSON.stringify(batch));

  const first = await core.commitBatch(io, await core.readBatch(io, batch.id, 'en'), [{ index: 0, key: 'create' }]);
  assert.equal(first.saved.length, 1);

  // The landed file is deleted out from under the batch: the persisted
  // `savedAs` mark is what keeps the retry honest.
  io.files.delete(first.saved[0].source);
  const second = await core.commitBatch(io, await core.readBatch(io, batch.id, 'en'), []);
  assert.deepEqual(second.already.map(entry => entry.id), [first.saved[0].id]);
  assert.equal(second.skipped, 0, 'a saved entry is never reported as skipped');
  assert.equal(second.pending, 1);
});

// --- Commit-time integrity ---------------------------------------------------

test('commitBatch refuses a batch whose envelope was rewritten on disk', async () => {
  const io = memoryIo({});
  const good = makeBatch([{ item: makeItem(), similar: [] }]);

  for (const mutate of [
    b => { b.ref = 'deadbeef'; },
    b => { b.items.push(b.items[0]); b.items.push(b.items[0]); b.items.push(b.items[0]); b.items.push(b.items[0]); b.items.push(b.items[0]); },
    b => { b.items[0].kind = 'nonsense'; },
    b => { b.items[0].title = 'x'.repeat(core.MAX_TITLE + 1); },
    b => { b.items = []; },
  ]) {
    const tampered = JSON.parse(JSON.stringify(good));
    mutate(tampered);
    await assert.rejects(() => core.commitBatch(io, tampered, []), /batch|invalid/i);
  }
});

test('readBatch refuses a batch whose ref does not match its id', async () => {
  const io = memoryIo({});
  const batch = makeBatch([{ item: makeItem(), similar: [] }]);
  await io.writeText(core.batchPath(batch.id), JSON.stringify({ ...batch, ref: 'deadbeef' }));
  await assert.rejects(() => core.readBatch(io, batch.id, 'en'), /does not exist or was already handled/);
});

test('undecidedCount counts only items still waiting for a verdict', () => {
  const batch = makeBatch([
    { item: makeItem({ title: 'Alpha' }), similar: [] },
    { item: makeItem({ title: 'Beta' }), similar: [] },
  ]);
  assert.equal(core.undecidedCount(batch), 2);
  batch.items[0].decided = 'skip';
  assert.equal(core.undecidedCount(batch), 1);
  batch.items[1].savedAs = 'LSN-1';
  assert.equal(core.undecidedCount(batch), 0);
  assert.equal(core.undecidedCount(null), 0);
});

// --- listBatches error surfacing ----------------------------------------------

test('listBatches hides handled batches but surfaces IO failures', async () => {
  const io = memoryIo({});
  const batch = makeBatch([{ item: makeItem(), similar: [] }]);
  await io.writeText(core.batchPath(batch.id), JSON.stringify({ ...batch, status: 'done' }));
  assert.deepEqual(await core.listBatches(io), []);

  const denied = memoryIo({});
  await denied.writeText(core.batchPath(batch.id), JSON.stringify(makeBatch([{ item: makeItem(), similar: [] }])));
  const deniedRead = denied.reader.read;
  denied.reader.read = async source => {
    if (source.startsWith(`${INBOX}/`)) {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    }
    return deniedRead(source);
  };
  denied.readText = denied.reader.read;
  await assert.rejects(() => core.listBatches(denied), /permission denied/);
});

// --- Backlink id binding -------------------------------------------------------

test('a backlink is refused when the target file became a different entry', async () => {
  const source = `${MEMORY}/LSN-20260101-old.md`;
  const io = memoryIo({ [source]: mdFile('LSN-20260101-old', { title: 'Alpha' }) });
  const batch = makeBatch([{
    item: makeItem({ title: 'Alpha', content: 'a better answer' }),
    similar: [core.parseEntry(source, io.files.get(source))],
  }]);

  // The file changes identity between the corpus load and the backlink write.
  let reads = 0;
  const raw = io.reader.read;
  const swapping = async path => {
    reads += 1;
    const text = await raw(path);
    return (path === source && reads > 1) ? text.replace(/LSN-20260101-old/g, 'LSN-20260101-evil') : text;
  };
  io.reader.read = swapping;
  io.readText = swapping;

  const result = await core.commitBatch(io, batch, [{ index: 0, key: 'replace:LSN-20260101-old' }]);
  assert.equal(result.saved.length, 1);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /target changed on disk/);
  assert.doesNotMatch(io.files.get(source), /supersededBy/, 'the wrong file must not be relabelled');
});

// --- Extension re-read ----------------------------------------------------------

test('the card commits nothing when the batch vanished before the answer', async () => {
  const io = memoryIo({});
  const batch = core.buildBatch({
    prepared: [{ item: makeItem({ title: 'Alpha', content: 'detail', keywords: [] }), similar: [] }],
    locale: 'en',
    id: BATCH_ID,
  });
  await io.writeText(core.batchPath(batch.id), JSON.stringify(batch));
  const { questions } = core.askToolArgs(batch);
  io.files.delete(core.batchPath(batch.id));

  const result = await onToolResult({
    toolName: 'asktool',
    isError: false,
    details: { questions, answers: [[batch.items[0].ask[0].label]] },
    content: [],
  }, { cwd: '/project', sessionManager: { getSessionId: () => 's1' } }, { io });

  assert.deepEqual([...io.files.keys()].filter(p => p.startsWith(`${MEMORY}/`)), [], 'nothing may be written');
  assert.match(result.content[0].text, /no pending batch matches/);
});
