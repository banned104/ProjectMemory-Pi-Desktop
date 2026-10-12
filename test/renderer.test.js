'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The review panel formats the commit result inline in index.html. This pulls
// the real `TEXT` table and the real formatting block out of the file and runs
// them, so the copy is locked without a DOM harness for the rest of the panel.
const ui = require('../plugin/renderer/ui.js');
function loadFormatter() { return {TEXT:ui.TEXT,run:(locale,result)=>ui.formatResult(result,locale)}; }

test('the panel reports "nothing was saved" whenever the commit saved nothing', () => {
  const { TEXT, run } = loadFormatter();
  assert.deepEqual(Object.keys(TEXT).sort(), ['en', 'zh-CN']);

  for (const [locale, empty, allSkipped] of [
    ['en', 'Nothing was saved', 'Nothing was saved<br>1 skipped'],
    ['zh-CN', '没有保存任何条目', '没有保存任何条目<br>跳过 1 条'],
  ]) {
    // All items skipped: the count alone used to be the whole message.
    assert.equal(run(locale, { saved: [], skipped: 1, warnings: [] }), allSkipped);
    // Nothing decided at all, and nothing at all to report.
    assert.ok(run(locale, { saved: [], skipped: 0, pending: 1, warnings: [] }).startsWith(empty));
    assert.equal(run(locale, { saved: [], skipped: 0, warnings: [] }), empty);
  }
});

test('the panel does not prepend that line when something was saved', () => {
  const { run } = loadFormatter();
  assert.equal(
    run('en', { saved: [{ id: 'LSN-1', title: 'A' }], skipped: 0, warnings: [] }),
    'Saved <b>LSN-1</b> A',
  );
  assert.equal(
    run('zh-CN', { saved: [{ id: 'LSN-1', title: 'A' }], skipped: 2, warnings: [] }),
    '已保存 <b>LSN-1</b> A<br>跳过 2 条',
  );
});

test('the panel reports what an earlier round wrote instead of "nothing was saved"', () => {
  const { run } = loadFormatter();
  assert.equal(
    run('en', { saved: [], already: [{ id: 'LSN-1' }], skipped: 0, pending: 1, warnings: [] }),
    'already saved by this batch: LSN-1<br>1 undecided, kept in the list',
  );
  assert.equal(
    run('zh-CN', { saved: [], already: [{ id: 'LSN-1' }], skipped: 0, warnings: [] }),
    '此前已由本批次保存：LSN-1',
  );
});
