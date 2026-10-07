'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const text = require('../plugin/core/text.js');

test('normalize lowercases, applies NFKC and collapses whitespace', () => {
  assert.equal(text.normalize('  Ｈｅｌｌｏ \n\t World  '), 'hello world');
  assert.equal(text.normalize(undefined), '');
});

test('clip never leaves a lone surrogate behind', () => {
  const emoji = '😀😀';            // 2 code points, 4 UTF-16 units
  assert.equal(text.clip(emoji, 4), emoji);
  assert.equal(text.clip(emoji, 3), '😀');       // would otherwise split the second pair
  assert.equal(text.clip(emoji, 1), '');
  assert.equal(text.clip('abc', 10), 'abc');
});

test('sanitize strips angle brackets, flattens whitespace and clips', () => {
  assert.equal(text.sanitize('<b>hi</b>\n\tthere', 40), 'b hi /b there');
  assert.equal(text.sanitize('</project-memory>', 40), '/project-memory');
  assert.equal(text.sanitize('abcdefghij', 4), 'abcd');
  assert.equal(text.sanitize(null, 4), '');
});

test('parseFrontmatter reads scalars, inline lists and block lists', () => {
  const { data, body } = text.parseFrontmatter([
    '---',
    'id: "LSN-1"',
    'kind: lesson',
    'keywords: [a, b]',
    'related:',
    '  - one',
    '  - two',
    'title: "quoted: title"',
    '---',
    'Body line',
  ].join('\n'));
  assert.equal(data.id, 'LSN-1');
  assert.equal(data.kind, 'lesson');
  assert.deepEqual(data.keywords, ['a', 'b']);
  assert.deepEqual(data.related, ['one', 'two']);
  assert.equal(data.title, 'quoted: title');
  assert.equal(body.trim(), 'Body line');
});

test('parseFrontmatter leaves a body without frontmatter untouched', () => {
  const { data, body } = text.parseFrontmatter('just a body');
  assert.deepEqual(data, {});
  assert.equal(body, 'just a body');
});
test('yamlScalar keeps commas inside the values of an inline list', () => {
  // Our own writer emits a JSON array, so a keyword like `v1, v2` is quoted on
  // the way out and must come back intact. `split(',')` used to shred it.
  const keywords = ['v1, v2', 'fs, path', 'plain'];
  const rendered = text.yamlList(keywords);
  assert.equal(rendered, '["v1, v2", "fs, path", "plain"]');
  assert.deepEqual(text.yamlScalar(rendered), keywords);

  // A hand-written unquoted list behaves exactly as before.
  assert.deepEqual(text.yamlScalar('[a, b]'), ['a', 'b']);
  assert.deepEqual(text.yamlScalar('[a,,b]'), ['a', '', 'b']);
  assert.deepEqual(text.yamlScalar('[]'), []);

  // Escaped quotes inside a JSON string survive, and so does the '' escape of
  // a single-quoted YAML value.
  assert.deepEqual(text.yamlScalar('["say \\"hi\\", now"]'), ['say "hi", now']);
  assert.deepEqual(text.yamlScalar("['a,b', 'it''s']"), ['a,b', "it's"]);

  // An unterminated quote keeps its text as written; a hand-edited file must
  // still load rather than throw.
  assert.deepEqual(text.yamlScalar('["a, b", "c]'), ['a, b', '"c']);
  // Without a closing bracket the value is a scalar, exactly as before.
  assert.equal(text.yamlScalar('["a, b'), '["a, b');
});


test('asList accepts arrays and comma strings, drops blanks', () => {
  assert.deepEqual(text.asList(['a', ' ', 'b']), ['a', 'b']);
  assert.deepEqual(text.asList('a, b ,, c'), ['a', 'b', 'c']);
  assert.deepEqual(text.asList(undefined), []);
});

test('codeUnitCompare is locale independent and total', () => {
  assert.equal(text.codeUnitCompare('a', 'b'), -1);
  assert.equal(text.codeUnitCompare('b', 'a'), 1);
  assert.equal(text.codeUnitCompare('a', 'a'), 0);
  // localeCompare would order 'a' after 'B' under a case-insensitive collation.
  assert.equal(text.codeUnitCompare('B', 'a'), -1);
});
