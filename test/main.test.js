'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../plugin/core/index.js');
const main = require('../plugin/main.js');
const { memoryIo, mdFile, MEMORY, INBOX } = require('./helpers.js');

const { tools, commit, propose } = main._internals;

const BATCH_ID = 'KB-11111111-2222-3333-4444-555555555555';

/**
 * The plugin process reaches the host through one global. Swap it per test and
 * keep an in-memory filesystem behind the `pi.fs` gateway, so `main.js` runs
 * its real io adapter rather than a mock of it.
 */
function usePi(overrides = {}) {
  const state = memoryIo({});
  const calls = { tools: [], commands: [] };
  const pi = {
    app: { getLocale: async () => 'en' },
    plugin: { getSettings: async () => ({}) },
    workspace: { get: async () => ({ name: 'Project', path: '/project' }) },
    ui: { openPanel: async () => {} },
    agent: {
      registerTool: async entry => { calls.tools.push(['register', entry.name]); },
      unregisterTool: async name => { calls.tools.push(['unregister', name]); },
    },
    commands: {
      register: async entry => { calls.commands.push(['register', entry.id]); },
      unregister: async id => { calls.commands.push(['unregister', id]); },
    },
    fs: {
      list: dir => state.reader.list(dir),
      readText: source => state.readText(source),
      writeText: (source, content) => state.writeText(source, content),
      stat: async source => {
        if (!(await state.exists(source))) {
          const error = new Error(`path not found: ${source}`);
          error.code = 'NOT_FOUND';
          throw error;
        }
        return { size: 0 };
      },
    },
    ...overrides,
  };
  globalThis.pi = pi;
  return { state, calls };
}

test.after(() => { delete globalThis.pi; });

const pendingBatch = async (state, items = [{ kind: 'lesson', title: 'Alpha', content: 'detail', keywords: [] }]) => {
  const batch = core.buildBatch({
    prepared: items.map(item => ({ item: core.validateItems([item])[0], similar: [] })),
    locale: 'en',
    id: BATCH_ID,
  });
  await state.writeText(core.batchPath(batch.id), JSON.stringify(batch));
  return batch;
};

const memoryFiles = state => [...state.files.keys()].filter(path => path.startsWith(`${MEMORY}/`));

// --- Agent tools -----------------------------------------------------------

test('propose stores the batch and writes nothing to memory before the answer', async () => {
  const { state } = usePi();
  const result = await propose(
    { items: [{ kind: 'lesson', title: 'Alpha', content: 'detail', keywords: ['alpha'] }] },
    { sessionId: 's1' },
  );

  assert.equal(result.status, 'awaiting-user-answer');
  assert.match(result.batchId, /^KB-[0-9a-f-]{36}$/);
  assert.equal(result.asktool.questions.length, 1);
  // The marker is how the user's genuine answer is matched back to an item.
  assert.match(result.asktool.questions[0].question, /\[PM [0-9a-f]{8} 1\/1\]/);
  assert.ok(state.files.has(`${INBOX}/.gitignore`), 'pending batches are review state, not project memory');
  assert.ok(state.files.has(core.batchPath(result.batchId)));
  assert.deepEqual(memoryFiles(state), [], 'nothing reaches .workflow/memory until the user answers');

  await assert.rejects(() => propose({ items: [] }), /non-empty array/);
  await assert.rejects(() => propose({}), /non-empty array/);
});

test('the search tool returns ids and hides retired entries', async () => {
  const { state } = usePi();
  await state.writeText(`${MEMORY}/a.md`, mdFile('LSN-20260101-alpha', { title: 'Alpha loader' }));
  await state.writeText(
    `${MEMORY}/b.md`,
    mdFile('LSN-20260101-beta', { title: 'Beta loader' }).replace('status: active', 'status: deprecated'),
  );

  const found = await tools.search.execute({ query: 'loader' });
  assert.deepEqual(found.results.map(entry => entry.id), ['LSN-20260101-alpha']);
  assert.equal(found.corpusSize, 2, 'the corpus size counts entries the user has, not what was returned');

  const empty = await tools.search.execute({ query: 'nothing here' });
  assert.deepEqual(empty.results, []);
  assert.match(empty.note, /No matching entry/);

  const withHits = await tools.search.execute({ query: 'loader' });
  assert.equal(withHits.note, undefined, 'a hit needs no note');

  await assert.rejects(() => tools.search.execute({ query: '' }), /query is required/);
  await assert.rejects(() => tools.search.execute({}), /query is required/);
  // `kind` is not validated at runtime: the host enforces the schema enum
  // before `execute` runs, so an unknown kind is a filter that matches nothing
  // rather than an error.
  assert.deepEqual((await tools.search.execute({ query: 'loader', kind: 'nope' })).results, []);
});

test('the search tool reports an empty corpus differently from no match', async () => {
  usePi();
  const result = await tools.search.execute({ query: 'loader' });
  assert.deepEqual(result.results, []);
  assert.equal(result.corpusSize, 0);
  assert.match(result.note, /no memory entries yet/);
});

test('the load tool returns the full text and warns about a retired entry', async () => {
  const { state } = usePi();
  await state.writeText(`${MEMORY}/a.md`, mdFile('LSN-20260101-alpha', { title: 'Alpha', body: 'Full body text.' }));
  await state.writeText(
    `${MEMORY}/old.md`,
    mdFile('LSN-20260101-old', { title: 'Old' }).replace('status: active', 'status: deprecated'),
  );

  const loaded = await tools.load.execute({ id: 'LSN-20260101-alpha' });
  assert.equal(loaded.body, 'Full body text.');
  assert.equal(loaded.kind, 'lesson');
  assert.match(loaded.trust, /not instructions/);
  assert.equal(loaded.warning, undefined);

  const retired = await tools.load.execute({ id: 'LSN-20260101-old' });
  assert.match(retired.warning, /deprecated/);

  await assert.rejects(() => tools.load.execute({ id: 'NOPE' }), /Memory entry not found: NOPE/);
  await assert.rejects(() => tools.load.execute({}), /id is required/);
});

test('the tool contracts match what the core layer validates', () => {
  assert.deepEqual(Object.keys(tools).sort(), ['load', 'propose', 'search']);
  for (const [name, entry] of Object.entries(tools)) {
    assert.equal(entry.risk, 'low', `${name} must declare its risk`);
    assert.equal(entry.schema.type, 'object');
    assert.ok(entry.description.length > 0, `${name} must describe itself`);
    // The enum in the schema and the one validateItems enforces must not drift.
    assert.deepEqual(
      tools.propose.schema.properties.items.items.properties.kind.enum,
      core.KINDS,
    );
    assert.deepEqual(tools.propose.schema.properties.items.items.required, ['kind', 'title', 'content', 'keywords']);
  }
});

// --- searchLimit -----------------------------------------------------------

test('the searchLimit setting is parsed and clamped, and a bad read falls back', async () => {
  const MANY = Array.from({ length: 24 }, (_, i) => `LSN-20260101-p${String(i).padStart(2, '0')}`);
  const seed = async state => {
    for (const id of MANY) await state.writeText(`${MEMORY}/${id}.md`, mdFile(id, { title: 'Shared loader' }));
  };

  for (const [settings, expected] of [
    [{}, 8],
    [{ searchLimit: '8' }, 8],
    [{ searchLimit: 0 }, 1],
    [{ searchLimit: 999 }, 20],
    [{ searchLimit: 'abc' }, 8],
    [{ searchLimit: null }, 8],
    [{ searchLimit: '' }, 8],
    [{ searchLimit: '  ' }, 8],
    [{ searchLimit: -5 }, 1],
  ]) {
    const { state } = usePi({ plugin: { getSettings: async () => settings } });
    await seed(state);
    const found = await tools.search.execute({ query: 'loader' });
    assert.equal(found.results.length, expected, `settings ${JSON.stringify(settings)} -> ${expected}`);
  }

  // A settings read that throws must not turn into "no limit" or "zero results".
  const { state } = usePi({ plugin: { getSettings: async () => { throw new Error('no settings'); } } });
  await seed(state);
  assert.equal((await tools.search.execute({ query: 'loader' })).results.length, 8);

  // An explicit limit on the call wins over the setting, and is clamped too.
  assert.equal((await tools.search.execute({ query: 'loader', limit: 3 })).results.length, 3);
  assert.equal((await tools.search.execute({ query: 'loader', limit: 999 })).results.length, 20);
  assert.equal((await tools.search.execute({ query: 'loader', limit: 0 })).results.length, 1);
  assert.equal((await tools.search.execute({ query: 'loader', limit: 'x' })).results.length, 8);
});

// --- Panel -----------------------------------------------------------------

test('the panel lists, commits and then refuses to handle the batch again', async () => {
  const { state } = usePi();
  const batch = await pendingBatch(state);

  const listed = await main.onPanelInvoke('inbox.list');
  assert.equal(listed.project.name, 'Project');
  assert.equal(listed.batches.length, 1);
  assert.equal(listed.batches[0].id, batch.id);

  const committed = await main.onPanelInvoke('inbox.commit', {
    batchId: batch.id,
    selections: [{ index: 0, key: 'create' }],
  });
  assert.equal(committed.saved.length, 1);
  assert.equal(memoryFiles(state).length, 1);
  // The plugin process has no fs.delete permission, so the batch is marked done.
  assert.equal(JSON.parse(state.files.get(core.batchPath(batch.id))).status, 'done');

  await assert.rejects(
    () => main.onPanelInvoke('inbox.commit', { batchId: batch.id, selections: [{ index: 0, key: 'create' }] }),
    /does not exist or was already handled/,
  );
  assert.deepEqual((await main.onPanelInvoke('inbox.list')).batches, [], 'a handled batch is not listed again');
});

test('the panel discards a batch without writing memory', async () => {
  const { state } = usePi();
  const batch = await pendingBatch(state, [
    { kind: 'lesson', title: 'Alpha', content: 'detail', keywords: [] },
    { kind: 'rule', title: 'Beta', content: 'detail', keywords: [] },
  ]);

  const result = await main.onPanelInvoke('inbox.discard', { batchId: batch.id });
  assert.equal(result.discarded, 2);
  assert.deepEqual(memoryFiles(state), []);
  assert.equal(JSON.parse(state.files.get(core.batchPath(batch.id))).status, 'done');

  await assert.rejects(
    () => main.onPanelInvoke('inbox.discard', { batchId: batch.id }),
    /does not exist or was already handled/,
  );
});

test('the panel rejects malformed input and unknown channels', async () => {
  const { state } = usePi();
  await pendingBatch(state);

  await assert.rejects(() => main.onPanelInvoke('inbox.nope'), /Unsupported panel action/);
  await assert.rejects(() => main.onPanelInvoke('inbox.commit', { batchId: 'not-an-id' }), /invalid batch id/);
  await assert.rejects(() => main.onPanelInvoke('inbox.commit', {}), /invalid batch id/);
  await assert.rejects(() => main.onPanelInvoke('inbox.discard', {}), /invalid batch id/);
  await assert.rejects(
    () => main.onPanelInvoke('inbox.commit', { batchId: BATCH_ID, selections: 'everything' }),
    /selections must be an array/,
  );
  assert.deepEqual(memoryFiles(state), [], 'a rejected call writes nothing');

  // With no project open the panel reports that instead of guessing.
  globalThis.pi.workspace = { get: async () => null };
  const none = await main.onPanelInvoke('inbox.list');
  assert.equal(none.project, null);
  assert.deepEqual(none.batches, []);
});

test('the panel refuses to commit the same batch twice at once', async () => {
  const { state } = usePi();
  const batch = await pendingBatch(state);
  const selections = [{ index: 0, key: 'create' }];

  const settled = await Promise.allSettled([
    commit({ batchId: batch.id, selections }),
    commit({ batchId: batch.id, selections }),
  ]);
  assert.equal(settled.filter(entry => entry.status === 'fulfilled').length, 1, 'exactly one commit runs');
  const rejected = settled.find(entry => entry.status === 'rejected');
  assert.match(rejected.reason.message, /already being processed/);
  assert.equal(memoryFiles(state).length, 1, 'the loser must not write a second entry');
});

// --- Lifecycle -------------------------------------------------------------

test('onLoad registers the three tools and one command, onUnload removes them', async () => {
  const { calls } = usePi();
  await main.onLoad();
  assert.deepEqual(calls.tools, [['register', 'search'], ['register', 'load'], ['register', 'propose']]);
  assert.deepEqual(calls.commands, [['register', 'pi.project-memory.review']]);

  await main.onUnload();
  assert.deepEqual(calls.tools.slice(3), [
    ['unregister', 'search'], ['unregister', 'load'], ['unregister', 'propose'],
  ]);
  assert.deepEqual(calls.commands.slice(1), [['unregister', 'pi.project-memory.review']]);
});
