'use strict';

// Wiring for the project memory view.
//
// Everything visible comes from ui.js: this file owns one screen's state,
// turns pluginBridge round trips into that state, and moves DOM nodes around.
// It never composes markup from a string it did not get from ui.js -- the one
// `innerHTML` assignment in this file is `ui.*Html` output and nothing else.
//
// The page has no `pi` object and no way to be pushed to, so it pulls: open,
// after a mutation, and whenever the host says the workspace changed.

(() => {
  const bridge = window.pluginBridge;
  const ui = globalThis.PM;

  const state = {
    locale: 'en',
    project: null,
    cards: [],
    stats: { total: 0, active: 0, retired: 0, pinned: 0, recent: 0, pending: 0, byKind: {} },
    disabled: false,
    query: '',
    kind: '',
    status: '',
    pinnedOnly: false,
    sort: '',
    view: 'grid',
    importing: false,
    importText: '',
    editing: null,
    pendingDelete: null,
    busy: false,
    loaded: false,
    failed: false,
  };

  const el = {
    root: document.getElementById('root'),
    stats: document.getElementById('stats'),
    grid: document.getElementById('cards'),
    notice: document.getElementById('notice'),
    transfer: document.getElementById('transfer'),
    toast: document.getElementById('toast'),
    overlay: document.getElementById('overlay'),
    search: document.getElementById('search'),
    project: document.getElementById('project'),
    title: document.getElementById('title'),
    refresh: document.getElementById('refresh'),
    filters: document.getElementById('filters'),
  };

  // --- Rendering ------------------------------------------------------------

  const label = key => ui.t(state.locale, key);

  function renderChrome() {
    document.documentElement.lang = state.locale;
    el.title.textContent = label('title');
    el.search.placeholder = label('searchPlaceholder');
    el.refresh.textContent = label('refresh');
    el.project.textContent = state.project ? `${state.project.name}` : '';

    const options = [
      ['', label('filterAll')],
      ['active', label('filterActive')],
      ['retired', label('filterRetired')],
    ];
    const sorts = [
      ['', label('sortDefault')],
      ['asc', label('sortAsc')],
      ['desc', label('sortDesc')],
      ['hot', label('sortHot')],
    ];
    el.filters.querySelectorAll('[data-filter]').forEach(button => {
      const filter = button.dataset.filter;
      if (filter === 'pinned') {
        button.textContent = label('pinnedOnly');
        button.setAttribute('aria-pressed', String(state.pinnedOnly));
      } else if (filter === 'status') {
        button.textContent = options.find(([value]) => value === state.status)?.[1] ?? label('filterAll');
      } else if (filter === 'sort') {
        button.textContent = sorts.find(([value]) => value === state.sort)?.[1] ?? label('sortDefault');
      } else if (filter === 'view') {
        button.textContent = state.view === 'timeline' ? label('viewTimeline') : label('viewGrid');
      } else if (filter === 'import') {
        button.textContent = label('importView');
        button.setAttribute('aria-pressed', String(state.importing));
      } else {
        button.textContent = ui.kindLabel(state.locale, filter);
        button.setAttribute('aria-pressed', String(state.kind === filter));
      }
    });

    el.notice.hidden = !state.disabled;
    if (state.disabled) {
      el.notice.textContent = `${label('disabledTitle')} — ${label('disabledBody')}`;
    }
  }

  function renderStats() {
    el.stats.innerHTML = ui.statsHtml(state.stats, { locale: state.locale });
  }

  function renderCards() {
    const query = {
      query: state.query,
      kind: state.kind,
      status: state.status,
      pinnedOnly: state.pinnedOnly,
    };

    if (!state.loaded) {
      el.grid.innerHTML = `<p class="pm-loading">${ui.esc(label('loading'))}</p>`;
      return;
    }
    if (state.view === 'timeline') {
      const visible = ui.filterCards(state.cards, query);
      if (!visible.length) {
        el.grid.innerHTML = ui.emptyHtml(state.cards.length ? 'filtered' : 'empty', { locale: state.locale });
        return;
      }
      el.grid.innerHTML = ui.timelineHtml(visible, { locale: state.locale, editing: state.editing });
      return;
    }
    const visible = ui.filterCards(ui.orderCards(state.cards, state.sort), query);
    if (!visible.length) {
      el.grid.innerHTML = ui.emptyHtml(state.cards.length ? 'filtered' : 'empty', { locale: state.locale });
      return;
    }
    el.grid.innerHTML = visible.map(card =>
      (state.editing && state.editing.id === card.id
        ? ui.formHtml(state.editing, { locale: state.locale })
        : ui.cardHtml(card, { locale: state.locale }))).join('');
  }

  function renderTransfer() {
    if (!el.transfer) return;
    el.transfer.innerHTML = state.importing
      ? ui.importHtml({ locale: state.locale, text: state.importText })
      : '';
  }

  function render() {
    renderChrome();
    renderStats();
    renderTransfer();
    renderCards();
    el.overlay.innerHTML = state.pendingDelete
      ? ui.confirmHtml({ locale: state.locale })
      : '';
    el.overlay.hidden = !state.pendingDelete;
    if (state.pendingDelete) {
      const first = el.overlay.querySelector('button');
      if (first) first.focus();
    }
  }

  let toastTimer = 0;
  function say(message, isError = false) {
    window.clearTimeout(toastTimer);
    el.toast.textContent = message;
    el.toast.classList.toggle('pm-toast-error', isError);
    el.toast.hidden = false;
    toastTimer = window.setTimeout(() => { el.toast.hidden = true; }, 2600);
  }

  // --- Talking to the plugin process ----------------------------------------

  async function call(channel, payload) {
    if (!bridge) throw new Error('pluginBridge is unavailable');
    return bridge.invoke(channel, payload ?? {});
  }

  function replaceCard(card) {
    const index = state.cards.findIndex(candidate => candidate.id === card.id);
    if (index >= 0) state.cards[index] = card;
    else state.cards.unshift(card);
    void refreshStatsOnly();
  }

  // `statsOf` lives in the plugin process, so counts come back with the list.
  // Rather than duplicating the arithmetic here, a mutation refreshes the
  // overview in the background and leaves the cards alone.
  async function refreshStatsOnly() {
    try {
      const listed = await call('memory.list');
      state.stats = listed.stats;
      state.disabled = listed.disabled;
      render();
    } catch { /* the visible cards are still the ones the user just saved */ }
  }

  async function refresh() {
    state.failed = false;
    try {
      const listed = await call('memory.list');
      state.project = listed.project;
      state.cards = listed.cards;
      state.stats = listed.stats;
      state.disabled = listed.disabled;
      state.loaded = true;
    } catch (error) {
      state.failed = true;
      state.loaded = true;
      say(`${label('failed')}: ${error?.message ?? error}`, true);
    }
    render();
  }

  async function openEditor(card) {
    try {
      const loaded = await call('memory.get', { id: card.id });
      state.editing = { ...loaded.card, body: loaded.body };
      state.pendingDelete = null;
      render();
      const form = el.grid.querySelector('.pm-form');
      const first = form && form.querySelector('input');
      if (first) first.focus();
    } catch (error) {
      say(`${label('failed')}: ${error?.message ?? error}`, true);
    }
  }

  async function applyPatch(card, patch, message) {
    state.busy = true;
    try {
      const result = await call('memory.update', { id: card.id, patch });
      state.editing = null;
      replaceCard(result.card);
      render();
      say(message);
    } catch (error) {
      say(`${label('failed')}: ${error?.message ?? error}`, true);
    } finally {
      state.busy = false;
    }
  }

  /** Clipboard with a fallback for pages without the async API. */
  function writeClipboard(text) {
    const nav = typeof navigator !== 'undefined' ? navigator : globalThis.navigator;
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      return nav.clipboard.writeText(String(text));
    }
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc || typeof doc.createElement !== 'function' || !doc.body) {
      throw new Error('clipboard unavailable');
    }
    const area = doc.createElement('textarea');
    area.value = String(text);
    doc.body.appendChild(area);
    area.select();
    try {
      if (typeof doc.execCommand !== 'function' || !doc.execCommand('copy')) {
        throw new Error('clipboard unavailable');
      }
    } finally {
      if (typeof area.remove === 'function') area.remove();
    }
  }

  async function copyCard(card) {
    state.busy = true;
    try {
      const exported = await call('memory.export', { id: card.id });
      await writeClipboard(exported.markdown);
      say(label('copied'));
    } catch (error) {
      say(`${label('failed')}: ${error?.message ?? error}`, true);
    } finally {
      state.busy = false;
    }
  }

  async function confirmImport() {
    if (!state.importText.trim()) {
      say(label('importEmpty'), true);
      return;
    }
    state.busy = true;
    try {
      const result = await call('memory.import', { markdown: state.importText });
      state.importText = '';
      state.importing = false;
      render();
      void refreshStatsOnly();
      say(`${label('importQueued')}: ${result.title}`);
    } catch (error) {
      say(`${label('failed')}: ${error?.message ?? error}`, true);
    } finally {
      state.busy = false;
    }
  }

  async function removePending() {
    const card = state.pendingDelete;
    if (!card) return;
    state.pendingDelete = null;
    state.busy = true;
    try {
      await call('memory.delete', { id: card.id });
      state.cards = state.cards.filter(candidate => candidate.id !== card.id);
      state.editing = null;
      render();
      void refreshStatsOnly();
      say(label('deleted'));
    } catch (error) {
      render();
      say(`${label('failed')}: ${error?.message ?? error}`, true);
    } finally {
      state.busy = false;
    }
  }

  // --- Events ---------------------------------------------------------------

  function cardFromEvent(event) {
    const holder = event.target.closest('[data-id]');
    if (!holder) return null;
    return state.cards.find(card => card.id === holder.dataset.id) ?? null;
  }

  el.grid.addEventListener('click', event => {
    const action = event.target.closest('[data-act]');
    if (!action) return;
    const card = cardFromEvent(event);
    if (!card) return;

    switch (action.dataset.act) {
      case 'edit':
        void openEditor(card);
        break;
      case 'toggle-pin':
        if (!state.busy) void applyPatch(card, { pinned: !card.pinned }, label('saved'));
        break;
      case 'toggle-status':
        if (!state.busy) {
          void applyPatch(card, { status: card.active ? 'retired' : 'active' }, label('saved'));
        }
        break;
      case 'copy':
        if (!state.busy) void copyCard(card);
        break;
      case 'delete':
        state.pendingDelete = card;
        state.editing = null;
        render();
        break;
      case 'cancel':
        state.editing = null;
        render();
        break;
      default:
        break;
    }
  });

  el.grid.addEventListener('submit', event => {
    event.preventDefault();
    const form = event.target.closest('.pm-form');
    const card = cardFromEvent(event);
    if (!form || !card || state.busy) return;

    const data = new FormData(form);
    const pinned = form.querySelector('[name="pinned"]');
    void applyPatch(card, {
      title: String(data.get('title') ?? ''),
      kind: String(data.get('kind') ?? card.kind),
      status: String(data.get('status') ?? 'active'),
      keywords: String(data.get('keywords') ?? '').split(',').map(value => value.trim()).filter(Boolean),
      pinned: pinned ? pinned.checked : card.pinned,
      body: String(data.get('body') ?? ''),
    }, label('saved'));
  });

  el.overlay.addEventListener('click', event => {
    const action = event.target.closest('[data-act]');
    if (!action) return;
    if (action.dataset.act === 'confirm-delete') void removePending();
    else { state.pendingDelete = null; render(); }
  });

  el.stats.addEventListener('click', event => {
    if (event.target.closest('[data-act="open-review"]')) void call('memory.openReview').catch(() => {});
  });

  if (el.transfer) {
    el.transfer.addEventListener('input', event => {
      const target = event.target;
      if (target && (target.name === 'import-text'
        || (typeof target.closest === 'function' && target.closest('textarea')))) {
        state.importText = String(target.value ?? '');
      }
    });
    el.transfer.addEventListener('click', event => {
      const action = event.target.closest('[data-act]');
      if (!action) return;
      if (action.dataset.act === 'import-confirm') void confirmImport();
      else if (action.dataset.act === 'cancel') {
        state.importing = false;
        state.importText = '';
        render();
      }
    });
  }

  let searchTimer = 0;
  el.search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      state.query = el.search.value;
      renderCards();
    }, 120);
  });

  el.filters.addEventListener('click', event => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    const filter = button.dataset.filter;
    if (filter === 'pinned') state.pinnedOnly = !state.pinnedOnly;
    else if (filter === 'status') {
      state.status = state.status === '' ? 'active' : state.status === 'active' ? 'retired' : '';
    } else if (filter === 'sort') {
      state.sort = state.sort === '' ? 'asc' : state.sort === 'asc' ? 'desc' : state.sort === 'desc' ? 'hot' : '';
    } else if (filter === 'view') {
      state.view = state.view === 'timeline' ? 'grid' : 'timeline';
    } else if (filter === 'import') {
      state.importing = !state.importing;
    } else state.kind = state.kind === filter ? '' : filter;
    render();
  });

  el.refresh.addEventListener('click', () => void refresh());

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (state.pendingDelete) { state.pendingDelete = null; render(); }
    else if (state.editing) { state.editing = null; render(); }
  });

  // --- Appearance and workspace ---------------------------------------------

  function applyAppearance(appearance) {
    const base = appearance && typeof appearance.base === 'string' ? appearance.base : 'system';
    document.documentElement.dataset.theme = base === 'system' ? '' : base;
    if (appearance && typeof appearance.locale === 'string') {
      state.locale = ui.localeOf(appearance.locale);
      if (state.loaded) render();
    }
  }

  async function boot() {
    try {
      applyAppearance(await call('app.getAppearance'));
    } catch { /* English and the system palette are a fine default */ }
    await refresh();
    if (bridge && typeof bridge.on === 'function') {
      bridge.on('appearance:changed', appearance => {
        applyAppearance(appearance);
        // The pushed payload carries the language only; the palette lives
        // behind the host's own call, so ask for it as well.
        void call('app.getAppearance').then(applyAppearance).catch(() => {});
      });
      bridge.on('workspace:changed', () => {
        state.editing = null;
        state.pendingDelete = null;
        state.importing = false;
        state.importText = '';
        void refresh();
      });
    }
  }

  void boot();
})();
