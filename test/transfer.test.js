'use strict';

// Regression tests for cross-project transfer (independent copy):
// - parseImportItem keeps only the reusable substance
// - memory.export returns the exact file text
// - memory.import queues a pending batch and writes nothing to memory
// - the view offers Copy on cards/rows and an import panel

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../plugin/core/index.js');
const main = require('../plugin/main.js');
const ui = require('../plugin/views/ui.js');
const { memoryIo, mdFile, MEMORY, INBOX } = require('./helpers.js');

// --- parseImportItem ------------------------------------------------------------

test('parseImportItem keeps kind/title/body/keywords/pin and drops identity', () => {
  const source = [
    '---',
    'id: "LSN-20260101-alpha"',
    'kind: rule',
    'title: "Alpha rule"',
    'keywords: [alpha, beta]',
    'status: deprecated',
    'created: 2026-01-01',
    'updated: 2026-02-02',
    'pinned: true',
    'batchRef: deadbeef',
    'supersedes: "LSN-0"',
    'related: ["LSN-1"]',
    '---',
    '',
    'Do this, not that.',
    '',
  ].join('\n');
  assert.deepEqual(core.parseImportItem(source), {
    kind: 'rule',
    title: 'Alpha rule',
    content: 'Do this, not that.',
    keywords: ['alpha', 'beta'],
    pin: true,
  });
});

test('parseImportItem turns plain pasted text into a lesson', () => {
  const item = core.parseImportItem('A useful trick\n\nDetails follow.');
  assert.equal(item.kind, 'lesson');
  assert.equal(item.title, 'A useful trick');
  assert.match(item.content, /Details follow/);
});

test('parseImportItem falls back to lesson for an unknown kind', () => {
  const item = core.parseImportItem('---\nkind: nonsense\ntitle: "T"\n---\n\nBody.');
  assert.equal(item.kind, 'lesson');
});

test('parseImportItem refuses empty and oversized input', () => {
  assert.throws(() => core.parseImportItem('   \n  '), /nothing to import/);
  assert.throws(() => core.parseImportItem('x'.repeat(core.MAX_IMPORT_CHARS + 1)), /exceeds/);
});

// --- main.js channels ------------------------------------------------------------
// The plugin process reaches the host through one global (same shape as in
// test/main.test.js), backed by an in-memory filesystem.

function usePi(overrides = {}) {
  const state = memoryIo({});
  const pi = {
    app: { getLocale: async () => 'en' },
    plugin: { getSettings: async () => ({}) },
    workspace: { get: async () => ({ name: 'Project', path: '/project' }) },
    ui: { openPanel: async () => {} },
    agent: { registerTool: async () => {}, unregisterTool: async () => {} },
    commands: { register: async () => {}, unregister: async () => {} },
    fs: {
      list: dir => state.reader.list(dir),
      readText: source => state.readText(source),
      writeText: (source, content) => state.writeText(source, content),
      remove: source => state.remove(source),
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
  return { state };
}

test.after(() => { delete globalThis.pi; });

const seedEntry = async state => {
  const source = `${MEMORY}/LSN-20260101-alpha.md`;
  await state.writeText(source, mdFile('LSN-20260101-alpha', { title: 'Alpha', body: 'Alpha body.' }));
  return source;
};

test('memory.export returns the exact file text for the clipboard', async () => {
  const { state } = usePi();
  const source = await seedEntry(state);
  const result = await main.onPanelInvoke('memory.export', { id: 'LSN-20260101-alpha' });
  assert.equal(result.id, 'LSN-20260101-alpha');
  assert.equal(result.markdown, state.files.get(source));
  await assert.rejects(() => main.onPanelInvoke('memory.export', { id: 'NOPE' }), /not found/);
});

test('memory.import queues a pending batch and writes nothing to memory', async () => {
  const { state } = usePi();
  await seedEntry(state);
  const pasted = state.files.get(`${MEMORY}/LSN-20260101-alpha.md`);

  const result = await main.onPanelInvoke('memory.import', { markdown: pasted });
  assert.equal(result.count, 1);
  assert.equal(result.title, 'Alpha');
  assert.match(result.batchId, /^KB-[0-9a-f-]{36}$/);
  assert.deepEqual(
    [...state.files.keys()].filter(path => path.startsWith(`${MEMORY}/`)),
    [`${MEMORY}/LSN-20260101-alpha.md`],
    'an import must not write memory before confirmation',
  );
  assert.ok(state.files.has(`${INBOX}/.gitignore`));
  const batches = await main.onPanelInvoke('inbox.list');
  assert.equal(batches.batches.length, 1);
  assert.equal(batches.batches[0].id, result.batchId);
});

test('memory.import rejects pasted text with nothing reusable', async () => {
  const { state } = usePi();
  await assert.rejects(() => main.onPanelInvoke('memory.import', { markdown: '   ' }), /nothing to import/);
  await assert.rejects(() => main.onPanelInvoke('memory.import', {}), /nothing to import/);
  assert.deepEqual(await main.onPanelInvoke('inbox.list'), { project: { name: 'Project', path: '/project' }, batches: [] });
});

test('an imported batch commits under a fresh id, not the source one', async () => {
  const { state } = usePi();
  await seedEntry(state);
  const pasted = state.files.get(`${MEMORY}/LSN-20260101-alpha.md`);
  const imported = await main.onPanelInvoke('memory.import', { markdown: pasted });

  const committed = await main.onPanelInvoke('inbox.commit', {
    batchId: imported.batchId,
    selections: [{ index: 0, key: 'create' }],
  });
  assert.equal(committed.saved.length, 1);
  assert.notEqual(committed.saved[0].id, 'LSN-20260101-alpha');
  const entry = core.parseEntry(committed.saved[0].source, state.files.get(committed.saved[0].source));
  assert.equal(entry.batchRef, imported.ref);
  assert.equal(entry.supersededBy, null, 'cross-project links do not travel');
});

// --- view markup -------------------------------------------------------------------

test('cards and timeline rows offer Copy, and the import panel escapes input', () => {
  const card = {
    id: 'A', kind: 'lesson', title: 'T', summary: 's', keywords: [], status: 'active',
    active: true, pinned: false, pinnedForced: false, supersededBy: null, related: [],
    batchRef: null, created: '2026-10-09T10:00:00+08:00', updated: '', chars: 1,
  };
  assert.ok(ui.cardHtml(card, { locale: 'en' }).includes('data-act="copy"'));
  assert.ok(ui.timelineHtml([card], { locale: 'zh-CN' }).includes('data-act="copy"'));

  const hostile = ui.importHtml({ locale: 'en', text: '</textarea><script>x</script>' });
  assert.ok(!hostile.includes('</textarea><script>'));
  assert.ok(hostile.includes('data-act="import-confirm"'));
  assert.ok(hostile.includes('name="import-text"'));
});
