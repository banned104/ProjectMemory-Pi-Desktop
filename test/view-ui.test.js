'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ui = require('../plugin/views/ui.js');

// The view is the only place repository content is spliced into HTML, so this
// file is the XSS regression suite. The rule it enforces: after removing the
// tags this module is allowed to emit, nothing that looks like markup may
// remain -- because every user string went through `esc` on the way in.

const SAFE_TAGS = /<\/?(?:article|header|footer|h[1-6]|p|div|span|ul|ol|li|code|pre|blockquote|strong|em|time|form|label|input|select|option|textarea|button|br|hr)\b[^>]*>/gi;

function assertNoMarkup(html, note) {
  const stripped = String(html).replace(SAFE_TAGS, '');
  assert.ok(!/[<>]/.test(stripped), `${note}: markup survived -> ${JSON.stringify(stripped.slice(0, 240))}`);
}

const HOSTILE_TITLE = '"><img src=x onerror=alert(1)>';
const HOSTILE_ID = 'x" onload="alert(1)';
const HOSTILE_BODY = '</textarea><script>alert(1)</script>\n# </h3><script>x</script>\n- <svg/onload=alert(1)>\n```\n</code></pre><script>bad()</script>\n```\n`<script>inline()</script>`\n**<b>bold</b>**';

const card = extra => ({
  id: 'LES-20260921-safe',
  kind: 'lesson',
  title: 'Config file',
  summary: 'Read the config from disk.',
  keywords: ['config', 'json'],
  status: 'active',
  active: true,
  pinned: false,
  pinnedForced: false,
  supersededBy: null,
  related: [],
  batchRef: 'BAT-1',
  created: '2026-09-21',
  updated: '',
  chars: 12,
  body: 'Body.',
  ...extra,
});

// ---------------------------------------------------------------------------
// esc
// ---------------------------------------------------------------------------

test('esc escapes every character that could end a tag or an attribute', () => {
  assert.equal(ui.esc(`<a href="x" data-y='z'>&`), '&lt;a href=&quot;x&quot; data-y=&#39;z&#39;&gt;&amp;');
  assert.equal(ui.esc(null), '');
  assert.equal(ui.esc(42), '42');
});

test('esc does not double-escape an already safe string', () => {
  assert.equal(ui.esc('plain text'), 'plain text');
});

// ---------------------------------------------------------------------------
// markdown
// ---------------------------------------------------------------------------

test('markdown renders the supported subset', () => {
  const html = ui.markdown(['# Title', '', 'Some **bold** and `code`.', '', '- one', '- two', '', '> quoted', '', '```', 'raw <stuff>', '```'].join('\n'));
  assert.ok(html.includes('<h2>Title</h2>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<ul>') && html.includes('<li>one</li>') && html.includes('<li>two</li>') && html.includes('</ul>'));
  assert.ok(html.includes('<blockquote>quoted</blockquote>'));
  assert.ok(html.includes('<pre><code>raw &lt;stuff&gt;</code></pre>'));
  assertNoMarkup(html, 'markdown');
});

test('markdown escapes hostile text before it applies any mark', () => {
  const html = ui.markdown(HOSTILE_BODY);
  assert.ok(!html.includes('<script>'), 'a script tag survived');
  assert.ok(!html.includes('<svg'), 'an svg tag survived');
  assert.ok(!html.includes('</textarea>'), 'the textarea was closed early');
  assert.ok(html.includes('&lt;script&gt;'), 'the payload should be visible as text');
  assertNoMarkup(html, 'markdown hostile');
});

test('markdown does not turn a markdown link into a real link', () => {
  const html = ui.markdown('[click](javascript:alert(1))');
  assert.ok(!html.includes('href'));
  assertNoMarkup(html, 'markdown link');
});

test('markdown keeps an unterminated code fence readable instead of dropping it', () => {
  const html = ui.markdown('```\nstill code');
  assert.ok(html.includes('<pre><code>still code</code></pre>'));
});

// ---------------------------------------------------------------------------
// cardHtml
// ---------------------------------------------------------------------------

test('cardHtml escapes a hostile entry in every slot', () => {
  const html = ui.cardHtml(card({
    id: HOSTILE_ID,
    title: HOSTILE_TITLE,
    summary: '<script>s()</script>',
    keywords: ['</ul><script>k()</script>'],
    supersededBy: '<b>old</b>',
  }));

  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<b>'));
  assert.ok(!html.includes('data-id="x" onload'), 'the id escaped its attribute');
  assert.ok(html.includes('data-id="x&quot; onload=&quot;alert(1)"'));
  assertNoMarkup(html, 'cardHtml');
});

test('cardHtml marks the states a card can be in', () => {
  const off = ui.cardHtml(card({ active: false, pinned: true, status: 'retired' }), { locale: 'zh-CN' });
  assert.ok(off.includes('pm-card-off'));
  assert.ok(off.includes('已停用'));
  assert.ok(off.includes('置顶'));
  assertNoMarkup(off, 'cardHtml states');
});

test('cardHtml hides the pin toggle for an entry the format pins', () => {
  assert.ok(!ui.cardHtml(card({ kind: 'map', pinned: true, pinnedForced: true })).includes('data-act="toggle-pin"'));
  assert.ok(ui.cardHtml(card({ kind: 'map', pinned: true, pinnedForced: true })).includes('data-act="toggle-status"'));
});

test('cardHtml falls back to the untitled label for an empty title', () => {
  assert.ok(ui.cardHtml(card({ title: '' }), { locale: 'zh-CN' }).includes('（无标题）'));
});

// ---------------------------------------------------------------------------
// formHtml
// ---------------------------------------------------------------------------

test('formHtml escapes attribute and text contexts alike', () => {
  const html = ui.formHtml(card({
    id: HOSTILE_ID,
    title: HOSTILE_TITLE,
    keywords: ['a" onfocus="alert(1)'],
    body: HOSTILE_BODY,
  }));

  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('onfocus="alert'));
  assert.ok(html.includes('value="&quot;&gt;&lt;img'), 'the title escaped its value attribute');
  assert.ok(html.includes('&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;'), 'the body is visible as text, not markup');
  assertNoMarkup(html, 'formHtml');
});

test('formHtml keeps a map entry pinned and says why', () => {
  const html = ui.formHtml(card({ kind: 'map', pinned: true, pinnedForced: true }), { locale: 'zh-CN' });
  assert.ok(html.includes('disabled'));
  assert.ok(html.includes('map 记忆按定义始终置顶'));
});

test('formHtml offers the six kinds and both statuses', () => {
  const html = ui.formHtml(card({ kind: 'procedure' }), { locale: 'en' });
  for (const kind of ui.KINDS) assert.ok(html.includes(`value="${kind}"`), `missing kind ${kind}`);
  assert.ok(html.includes('value="active"') && html.includes('value="retired"'));
  assert.ok(html.includes('<option value="procedure" selected>'));
});

// ---------------------------------------------------------------------------
// statsHtml / emptyHtml / delete flip
// ---------------------------------------------------------------------------

test('statsHtml renders counts and only offers review when something is pending', () => {
  const stats = { total: 12, pinned: 2, retired: 3, recent: 4, byKind: { lesson: 5, rule: 7 }, pending: 1 };
  const html = ui.statsHtml(stats, { locale: 'zh-CN' });
  assert.ok(html.includes('<strong>12</strong>'));
  assert.ok(html.includes('待确认'));
  assert.ok(html.includes('data-act="open-review"'));

  assert.ok(!ui.statsHtml({ ...stats, pending: 0 }).includes('data-act="open-review"'));
  assertNoMarkup(html, 'statsHtml');
});

test('the empty state is localized and the delete flip stays escaped', () => {
  const empty = ui.emptyHtml('filtered', { locale: 'zh-CN' });
  assert.ok(empty.includes('没有匹配的条目'));
  assertNoMarkup(empty, 'emptyHtml');

  // The confirmation lives on the button itself: the plain card offers
  // "delete", the pending one offers "confirm delete?" instead.
  const plain = ui.cardHtml(card(), { locale: 'zh-CN' });
  assert.ok(plain.includes('data-act="delete"'));
  assert.ok(!plain.includes('delete-confirm'));
  const flipped = ui.cardHtml(card(), { locale: 'zh-CN', confirmingDelete: true });
  assert.ok(flipped.includes('data-act="delete-confirm"'));
  assert.ok(flipped.includes('确认删除？'));
  assert.ok(!flipped.includes('data-act="delete"'));
  assertNoMarkup(flipped, 'cardHtml confirm flip');

  const rowPlain = ui.timelineHtml([card()], { locale: 'zh-CN' });
  assert.ok(rowPlain.includes('data-act="delete"'));
  const rowFlip = ui.timelineHtml([card()], { locale: 'zh-CN', confirmingDeleteId: 'LES-20260921-safe' });
  assert.ok(rowFlip.includes('data-act="delete-confirm"'));
  assertNoMarkup(rowFlip, 'timeline confirm flip');
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test('matchesQuery is a substring filter over what the card shows', () => {
  const sample = card({ title: 'Config Loader', keywords: ['json', 'env'], summary: 'Reads .env' });
  assert.ok(ui.matchesQuery(sample, ''));
  assert.ok(ui.matchesQuery(sample, 'config'));
  assert.ok(ui.matchesQuery(sample, 'CONFIG loader'));
  assert.ok(ui.matchesQuery(sample, 'env'));
  assert.ok(!ui.matchesQuery(sample, 'missing'));
  assert.ok(!ui.matchesQuery(sample, 'config missing'));
  assert.ok(ui.matchesQuery(card({ id: 'LES-1' }), 'les-1'));
});

test('filterCards combines every filter and keeps the given order', () => {
  const cards = [
    card({ id: 'a', kind: 'rule', pinned: true }),
    card({ id: 'b', kind: 'lesson', active: false, status: 'retired' }),
    card({ id: 'c', kind: 'lesson', title: 'Config loader' }),
    card({ id: 'd', kind: 'lesson', title: 'Other' }),
  ];
  assert.deepEqual(ui.filterCards(cards).map(c => c.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ui.filterCards(cards, { kind: 'lesson' }).map(c => c.id), ['b', 'c', 'd']);
  assert.deepEqual(ui.filterCards(cards, { status: 'active' }).map(c => c.id), ['a', 'c', 'd']);
  assert.deepEqual(ui.filterCards(cards, { pinnedOnly: true }).map(c => c.id), ['a']);
  assert.deepEqual(ui.filterCards(cards, { query: 'loader' }).map(c => c.id), ['c']);
  assert.deepEqual(ui.filterCards(cards, { kind: 'lesson', status: 'active', query: 'other' }).map(c => c.id), ['d']);
  assert.deepEqual(ui.filterCards(null), []);
});

// ---------------------------------------------------------------------------
// Localization
// ---------------------------------------------------------------------------

test('localeOf accepts anything Chinese, and falls back to English', () => {
  assert.equal(ui.localeOf('zh-CN'), 'zh-CN');
  assert.equal(ui.localeOf('ZH'), 'zh-CN');
  assert.equal(ui.localeOf('zh'), 'zh-CN');
  assert.equal(ui.localeOf('en-US'), 'en');
  assert.equal(ui.localeOf(undefined), 'en');
});

test('every key exists in both locales', () => {
  const en = Object.keys(ui.TEXT.en).sort();
  const zh = Object.keys(ui.TEXT['zh-CN']).sort();
  assert.deepEqual(zh, en);
  for (const key of en) assert.ok(ui.TEXT['zh-CN'][key], `zh-CN is blank for ${key}`);
});

test('kindLabel names every kind and never leaks an unlisted one', () => {
  for (const kind of ui.KINDS) assert.ok(ui.kindLabel('en', kind).length > 0);
  assert.equal(ui.kindLabel('zh-CN', 'preference'), '偏好');
  assert.equal(ui.kindLabel('en', '<script>'), 'Lesson');
});
test('orderCards mirrors the core order: pinned first, dateless last', () => {
  const cards = [
    card({ id: 'new', created: '2026-09-25', updated: '' }),
    card({ id: 'old-pin', created: '2026-01-01', updated: '', pinned: true }),
    card({ id: 'mid', created: '2026-06-01', updated: '' }),
    card({ id: 'nodate', created: '', updated: '' }),
  ];
  assert.deepEqual(ui.orderCards(cards).map(c => c.id), ['old-pin', 'new', 'mid', 'nodate']);
  assert.deepEqual(ui.orderCards(cards, 'asc').map(c => c.id), ['old-pin', 'mid', 'new', 'nodate']);
  assert.deepEqual(ui.orderCards(cards, 'desc').map(c => c.id), ['old-pin', 'new', 'mid', 'nodate']);
  assert.deepEqual(ui.orderCards(null), []);
});
