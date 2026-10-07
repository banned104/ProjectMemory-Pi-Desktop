'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The review panel formats the commit result inline in index.html. This pulls
// the real `TEXT` table and the real formatting block out of the file and runs
// them, so the copy is locked without a DOM harness for the rest of the panel.
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'renderer', 'index.html'), 'utf8');

function loadFormatter() {
  const table = /const TEXT = \{[\s\S]*?\n  \};/.exec(SOURCE);
  assert.ok(table, 'the panel must still define its TEXT table');
  const TEXT = new Function(`${table[0]}; return TEXT;`)();

  const start = SOURCE.indexOf('const lines = result.saved.length');
  const end = SOURCE.indexOf('\n', SOURCE.indexOf("show('result'", start));
  assert.ok(start >= 0 && end > start, 'the panel must still format the commit result');
  const block = SOURCE.slice(start, end);

  return {
    TEXT,
    run(locale, result) {
      const L = TEXT[locale];
      const tr = (key, ...args) => (typeof L[key] === 'function' ? L[key](...args) : L[key]);
      const esc = value => String(value);
      let shown = null;
      new Function('tr', 'esc', 'show', 'result', block)(tr, esc, (id, value) => { shown = value; }, result);
      return shown;
    },
  };
}

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
