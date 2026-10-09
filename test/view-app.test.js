'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ui = require('../plugin/views/ui.js');

// The view's wiring (views/app.js) is a browser IIFE: it reads `window` and
// `document`, talks to `pluginBridge`, and puts ui.js output into the page.
// This drives that real file against a small hand-built DOM, and asserts on the
// one thing app.js is actually responsible for -- which bridge calls it makes
// and what it does to the screen afterwards. Markup and escaping are covered
// separately in test/view-ui.test.js.

const APP = path.join(__dirname, '..', 'plugin', 'views', 'app.js');

function fakeElement(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    placeholder: '',
    hidden: false,
    dataset: {},
    attributes: {},
    listeners: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    dispatch(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); },
    setAttribute(name, value) { this.attributes[name] = value; },
    focus() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

/** An event whose target answers `closest` the way the page's DOM would. */
function clickEvent({ act, id }) {
  return {
    target: {
      closest(selector) {
        if (selector.startsWith('[data-act')) return act ? { dataset: { act } } : null;
        if (selector.startsWith('[data-id')) return id ? { dataset: { id } } : null;
        return null;
      },
    },
  };
}

function boot(cards = [], { locale = 'zh-CN', base = 'dark' } = {}) {
  const elements = Object.fromEntries(
    ['root', 'stats', 'cards', 'notice', 'toast', 'overlay', 'search', 'project', 'title', 'refresh', 'filters']
      .map(id => [id, fakeElement(id)]),
  );
  const documentListeners = {};
  const document = {
    documentElement: { lang: '', dataset: {} },
    getElementById: id => elements[id] ?? null,
    addEventListener(type, fn) { (documentListeners[type] ??= []).push(fn); },
    dispatch(type, event) { for (const fn of documentListeners[type] ?? []) fn(event); },
  };

  const calls = [];
  const bridge = {
    invoke: async (channel, payload = {}) => {
      calls.push([channel, payload]);
      if (channel === 'app.getAppearance') return { theme: 'system', base, locale, pluginTheme: null };
      if (channel === 'memory.list') {
        return {
          project: { name: 'Demo', path: '/demo' },
          cards,
          stats: {
            total: cards.length, active: cards.length, retired: 0, pinned: 0, recent: 0, pending: 0,
            byKind: { lesson: cards.length, rule: 0, decision: 0, procedure: 0, map: 0, preference: 0 },
          },
          disabled: false,
        };
      }
      if (channel === 'memory.get') {
        return { card: cards.find(card => card.id === payload.id), body: 'Body from disk.' };
      }
      if (channel === 'memory.update') {
        return { card: { ...(cards.find(card => card.id === payload.id) ?? cards[0]), ...(payload.patch ?? {}) } };
      }
      if (channel === 'memory.delete') return { deleted: payload.id };
      return {};
    },
    on(event, fn) { (bridge.pushed ??= {})[event] = fn; return () => {}; },
  };

  globalThis.window = { pluginBridge: bridge, setTimeout, clearTimeout };
  globalThis.document = document;
  globalThis.PM = ui;
  delete require.cache[require.resolve(APP)];
  require(APP);

  return {
    elements,
    calls,
    bridge,
    document,
    channels: () => calls.map(([channel]) => channel),
    last: channel => [...calls].reverse().find(([name]) => name === channel),
    flush: () => new Promise(resolve => setTimeout(resolve, 5)),
  };
}

const card = (id, extra = {}) => ({
  id,
  kind: 'lesson',
  title: `Title ${id}`,
  summary: 'Summary.',
  keywords: ['k'],
  status: 'active',
  active: true,
  pinned: false,
  pinnedForced: false,
  supersededBy: null,
  related: [],
  batchRef: null,
  created: '2026-09-21',
  updated: '',
  chars: 6,
  ...extra,
});

// ---------------------------------------------------------------------------

test('the view asks for the appearance and the corpus, then renders both', async () => {
  const { elements, channels, flush } = boot([card('LES-1'), card('LES-2')]);
  await flush();

  assert.deepEqual(channels(), ['app.getAppearance', 'memory.list']);
  assert.equal(document.documentElement.lang, 'zh-CN');
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(elements.title.textContent, '项目记忆');
  assert.equal(elements.project.textContent, 'Demo');
  assert.ok(elements.cards.innerHTML.includes('Title LES-1'));
  assert.ok(elements.cards.innerHTML.includes('Title LES-2'));
  assert.ok(elements.stats.innerHTML.includes('<strong>2</strong>'));
});

test('the pin toggle sends the opposite value and reports it', async () => {
  const { elements, calls, last, flush } = boot([card('LES-1')]);
  await flush();

  elements.cards.dispatch('click', clickEvent({ act: 'toggle-pin', id: 'LES-1' }));
  await flush();

  assert.deepEqual(last('memory.update'), ['memory.update', { id: 'LES-1', patch: { pinned: true } }]);
  assert.ok(elements.toast.textContent.length > 0, 'a mutation must be acknowledged');
  assert.equal(calls.filter(([channel]) => channel === 'memory.delete').length, 0);
});

test('retire and restore are the same button with opposite payloads', async () => {
  const { elements, last, flush } = boot([card('LES-1')]);
  await flush();

  elements.cards.dispatch('click', clickEvent({ act: 'toggle-status', id: 'LES-1' }));
  await flush();
  assert.deepEqual(last('memory.update'), ['memory.update', { id: 'LES-1', patch: { status: 'retired' } }]);
});

test('delete is confirmed first, and Escape backs out without deleting', async () => {
  const { elements, channels, document, flush } = boot([card('LES-1')]);
  await flush();

  elements.cards.dispatch('click', clickEvent({ act: 'delete', id: 'LES-1' }));
  assert.ok(elements.overlay.innerHTML.includes('删除这条记忆？'), 'the dialog must name what it will do');
  assert.ok(elements.overlay.hidden === false);
  assert.ok(!channels().includes('memory.delete'), 'a click on delete must not delete');

  document.dispatch('keydown', { key: 'Escape' });
  assert.ok(!channels().includes('memory.delete'));
});

test('confirming the dialog deletes the entry and takes it off the screen', async () => {
  const { elements, channels, last, flush } = boot([card('LES-1'), card('LES-2')]);
  await flush();

  elements.cards.dispatch('click', clickEvent({ act: 'delete', id: 'LES-1' }));
  elements.overlay.dispatch('click', clickEvent({ act: 'confirm-delete' }));
  await flush();

  assert.ok(channels().includes('memory.delete'));
  assert.deepEqual(last('memory.delete'), ['memory.delete', { id: 'LES-1' }]);
  assert.ok(!elements.cards.innerHTML.includes('Title LES-1'));
  assert.ok(elements.cards.innerHTML.includes('Title LES-2'));
  assert.equal(elements.overlay.hidden, true);
});

test('opening the editor asks for the body and renders the form', async () => {
  const { elements, last, flush } = boot([card('LES-1')]);
  await flush();

  elements.cards.dispatch('click', clickEvent({ act: 'edit', id: 'LES-1' }));
  await flush();

  assert.deepEqual(last('memory.get'), ['memory.get', { id: 'LES-1' }]);
  assert.ok(elements.cards.innerHTML.includes('<form'));
  assert.ok(elements.cards.innerHTML.includes('Body from disk.'));
});

test('cancel just closes the editor', async () => {
  const { elements, channels, flush } = boot([card('LES-1')]);
  await flush();
  elements.cards.dispatch('click', clickEvent({ act: 'edit', id: 'LES-1' }));
  await flush();

  elements.cards.dispatch('click', clickEvent({ act: 'cancel', id: 'LES-1' }));
  assert.ok(!elements.cards.innerHTML.includes('<form'));
  assert.ok(!channels().includes('memory.update'));
});

test('the pending stat links to the review panel', async () => {
  const { elements, channels, flush } = boot([card('LES-1')]);
  await flush();

  elements.stats.dispatch('click', clickEvent({ act: 'open-review' }));
  await flush();
  assert.ok(channels().includes('memory.openReview'));
});

test('switching project reloads and drops anything half-finished', async () => {
  const { elements, bridge, channels, flush } = boot([card('LES-1')]);
  await flush();
  elements.cards.dispatch('click', clickEvent({ act: 'edit', id: 'LES-1' }));
  await flush();

  bridge.pushed['workspace:changed']();
  await flush();

  assert.equal(channels().filter(channel => channel === 'memory.list').length, 2);
  assert.ok(!elements.cards.innerHTML.includes('<form'));
});

test('a failing load says so instead of showing a silent empty screen', async () => {
  const { elements, flush } = boot([card('LES-1')]);
  await flush();
  globalThis.window.pluginBridge.invoke = async () => { throw new Error('boom'); };
  elements.refresh.dispatch('click', {});
  await flush();

  assert.ok(elements.toast.textContent.includes('boom'));
});
test('the sort button cycles default, oldest-first, newest-first, hot and reorders the cards', async () => {
  const { elements, flush } = boot([
    card('NEW', { created: '2026-09-25' }),
    card('OLD-PIN', { created: '2026-01-01', pinned: true }),
    card('MID', { created: '2026-06-01' }),
  ]);
  await flush();
  const filterEvent = filter => ({
    target: { closest: selector => (selector === '[data-filter]' ? { dataset: { filter } } : null) },
  });
  const isOrdered = (...ids) => {
    const at = ids.map(id => elements.cards.innerHTML.indexOf(`Title ${id}`));
    return at.every(i => i >= 0) && at.every((v, i) => i === 0 || at[i - 1] < v);
  };
  assert.ok(isOrdered('OLD-PIN', 'NEW', 'MID'), 'default: pinned on top, newest first');
  elements.filters.dispatch('click', filterEvent('sort'));
  assert.ok(isOrdered('OLD-PIN', 'MID', 'NEW'), 'asc: pinned on top, oldest first');
  elements.filters.dispatch('click', filterEvent('sort'));
  assert.ok(isOrdered('OLD-PIN', 'NEW', 'MID'), 'desc: pinned on top, newest first');
  elements.filters.dispatch('click', filterEvent('sort'));
  assert.ok(isOrdered('OLD-PIN', 'MID', 'NEW'), 'hot without heat: pinned on top, id tiebreak');
  elements.filters.dispatch('click', filterEvent('sort'));
  assert.ok(isOrdered('OLD-PIN', 'NEW', 'MID'), 'back to default');
});
