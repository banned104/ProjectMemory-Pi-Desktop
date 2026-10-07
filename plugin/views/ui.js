'use strict';

// Pure view layer for the project memory browser (views/index.html).
//
// Every string this module turns into HTML came out of a repository file, so
// every insertion point escapes. That is the only reason the page is allowed to
// render repository content at all, and it is what test/view-ui.test.js checks
// by rendering hostile entries and asserting that no markup survives.
//
// `id` is the one field that is NOT sanitised upstream: it has to round-trip
// byte for byte so an edit or a delete names the entry the user clicked. It is
// escaped here like everything else, which is why `esc` is not optional.
//
// The markdown renderer is a deliberately small subset -- headings, lists,
// quotes, fenced code, bold, italic, code spans. Text is escaped *before* any
// of those transforms run, so a transform can only ever wrap already-safe text.
// There are no links and no images: an `href` is the one place user text would
// have to be spliced into an attribute, and this module has no need for one.

const KINDS = ['lesson', 'rule', 'decision', 'procedure', 'map', 'preference'];

const TEXT = {
  en: {
    title: 'Project Memory',
    searchPlaceholder: 'Search title, keywords, summary…',
    filterAll: 'All',
    filterActive: 'Active',
    filterRetired: 'Retired',
    pinnedOnly: 'Pinned only',
    unitEntries: 'entries',
    unitKinds: 'kinds',
    labelPinned: 'pinned',
    labelPending: 'to confirm',
    labelRecent: 'new in 7 days',
    labelRetired: 'retired',
    openReview: 'Review proposals',
    edit: 'Edit',
    save: 'Save',
    cancel: 'Cancel',
    retire: 'Retire',
    restore: 'Restore',
    delete: 'Delete',
    pin: 'Pin',
    unpin: 'Unpin',
    pinnedByKind: 'A map entry is always pinned.',
    deleteTitle: 'Delete this entry?',
    deleteBody: 'The file is removed from .workflow/memory. This cannot be undone.',
    deleteConfirm: 'Delete',
    fieldTitle: 'Title',
    fieldKind: 'Kind',
    fieldKeywords: 'Keywords, comma separated',
    fieldBody: 'Body',
    fieldStatus: 'Status',
    statusActive: 'Active — injected as before',
    statusRetired: 'Retired — kept, never injected',
    emptyTitle: 'No memory yet',
    emptyBody: 'Once you confirm a proposal, entries appear here.',
    emptyFiltered: 'Nothing matches',
    emptyFilteredBody: 'Try another word, or clear the filters.',
    disabledTitle: 'Automatic retrieval is paused for this project',
    disabledBody: 'Delete .workflow/memory/DISABLED to turn it back on.',
    saved: 'Saved',
    deleted: 'Deleted',
    failed: 'That did not work',
    refresh: 'Refresh',
    loading: 'Loading…',
    created: 'Created',
    updated: 'Updated',
    untitled: '(untitled)',
    kindLesson: 'Lesson',
    kindRule: 'Rule',
    kindDecision: 'Decision',
    kindProcedure: 'Procedure',
    kindMap: 'Map',
    kindPreference: 'Preference',
  },
  'zh-CN': {
    title: '项目记忆',
    searchPlaceholder: '搜索标题、关键词、摘要…',
    filterAll: '全部',
    filterActive: '生效中',
    filterRetired: '已停用',
    pinnedOnly: '仅置顶',
    unitEntries: '条记忆',
    unitKinds: '类',
    labelPinned: '置顶',
    labelPending: '待确认',
    labelRecent: '近 7 天',
    labelRetired: '已停用',
    openReview: '去确认',
    edit: '编辑',
    save: '保存',
    cancel: '取消',
    retire: '停用',
    restore: '恢复',
    delete: '删除',
    pin: '置顶',
    unpin: '取消置顶',
    pinnedByKind: 'map 记忆按定义始终置顶。',
    deleteTitle: '删除这条记忆？',
    deleteBody: '文件会从 .workflow/memory 删除，无法撤销。',
    deleteConfirm: '删除',
    fieldTitle: '标题',
    fieldKind: '类型',
    fieldKeywords: '关键词，逗号分隔',
    fieldBody: '正文',
    fieldStatus: '状态',
    statusActive: '生效 — 照常注入',
    statusRetired: '停用 — 保留但不再注入',
    emptyTitle: '还没有记忆',
    emptyBody: '确认一次沉淀后，条目会出现在这里。',
    emptyFiltered: '没有匹配的条目',
    emptyFilteredBody: '换个词，或清除筛选。',
    disabledTitle: '本项目的自动检索已暂停',
    disabledBody: '删除 .workflow/memory/DISABLED 即可恢复。',
    saved: '已保存',
    deleted: '已删除',
    failed: '操作失败',
    refresh: '刷新',
    loading: '加载中…',
    created: '创建',
    updated: '更新',
    untitled: '（无标题）',
    kindLesson: '教训',
    kindRule: '规则',
    kindDecision: '决策',
    kindProcedure: '步骤',
    kindMap: '地图',
    kindPreference: '偏好',
  },
};

const localeOf = value => (typeof value === 'string' && value.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en');

function t(locale, key) {
  const table = TEXT[localeOf(locale)] ?? TEXT.en;
  return table[key] ?? TEXT.en[key] ?? key;
}

const kindLabel = (locale, kind) =>
  t(locale, KINDS.includes(kind) ? `kind${kind[0].toUpperCase()}${kind.slice(1)}` : 'kindLesson');

// ---------------------------------------------------------------------------
// Escaping and the markdown subset
// ---------------------------------------------------------------------------

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline marks over already-escaped text. Only fixed tags come out of this. */
function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

function markdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null;
  let fence = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const line of lines) {
    if (fence) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (/^```/.test(line)) { closeList(); fence = []; continue; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length + 1;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      const tag = item[1] ? 'ul' : 'ol';
      if (list !== tag) { closeList(); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${inline(item[3])}</li>`);
      continue;
    }
    closeList();

    if (!line.trim()) continue;
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }

  if (fence) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
  closeList();
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Substring matching over what a card shows. This is a browse filter, not the
 * agent's ranked search (core/search.js): it answers "which cards on screen
 * mention this", instantly and with no process round-trip.
 */
function matchesQuery(card, query) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    card.id, card.title, card.summary, card.status,
    ...(card.keywords ?? []), ...(card.related ?? []),
  ].join(' \n ').toLowerCase();
  return needle.split(/\s+/).every(word => haystack.includes(word));
}

/** Preserves the order it was given: the caller already sorted. */
function filterCards(cards, { query = '', kind = '', status = '', pinnedOnly = false } = {}) {
  return (cards ?? []).filter(card =>
    (!kind || card.kind === kind)
    && (!status || (status === 'active') === card.active)
    && (!pinnedOnly || card.pinned)
    && matchesQuery(card, query));
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

const badge = (label, className) => `<span class="pm-badge ${className}">${esc(label)}</span>`;

function cardHtml(card, { locale = 'en' } = {}) {
  const when = card.updated || card.created;
  const kind = KINDS.includes(card.kind) ? card.kind : 'lesson';
  const title = card.title || t(locale, 'untitled');
  const badges = [
    badge(kindLabel(locale, kind), `pm-kind pm-kind-${kind}`),
    ...(card.pinned ? [badge(t(locale, 'labelPinned'), 'pm-pin')] : []),
    ...(!card.active ? [badge(t(locale, 'labelRetired'), 'pm-off')] : []),
    ...(card.supersededBy ? [badge(`↳ ${card.supersededBy}`, 'pm-off')] : []),
  ].join('');

  const keywords = (card.keywords ?? []).map(word => `<li>${esc(word)}</li>`).join('');

  const actions = [
    `<button type="button" class="pm-btn" data-act="edit">${esc(t(locale, 'edit'))}</button>`,
    card.pinnedForced
      ? ''
      : `<button type="button" class="pm-btn" data-act="toggle-pin">${esc(t(locale, card.pinned ? 'unpin' : 'pin'))}</button>`,
    `<button type="button" class="pm-btn" data-act="toggle-status">${esc(t(locale, card.active ? 'retire' : 'restore'))}</button>`,
    `<button type="button" class="pm-btn pm-danger" data-act="delete">${esc(t(locale, 'delete'))}</button>`,
  ].join('');

  return [
    `<article class="pm-card${card.active ? '' : ' pm-card-off'}" data-id="${esc(card.id)}">`,
    `<header class="pm-card-head">${badges}</header>`,
    `<h3 class="pm-card-title">${esc(title)}</h3>`,
    `<p class="pm-card-summary">${esc(card.summary)}</p>`,
    keywords ? `<ul class="pm-keywords">${keywords}</ul>` : '',
    `<footer class="pm-card-foot">`,
    `<span class="pm-meta">${esc(card.id)}</span>`,
    `<time class="pm-meta" datetime="${esc(when)}">${esc(when || '')}</time>`,
    `<div class="pm-actions">${actions}</div>`,
    `</footer>`,
    `</article>`,
  ].join('');
}

function formHtml(card, { locale = 'en' } = {}) {
  const option = (value, label, selected) =>
    `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  const kindOptions = KINDS.map(kind =>
    option(kind, kindLabel(locale, kind), kind === card.kind)).join('');

  return [
    `<form class="pm-form" data-id="${esc(card.id)}">`,
    `<label class="pm-field"><span>${esc(t(locale, 'fieldTitle'))}</span>`,
    `<input name="title" value="${esc(card.title)}" maxlength="120" required></label>`,
    `<div class="pm-row">`,
    `<label class="pm-field"><span>${esc(t(locale, 'fieldKind'))}</span>`,
    `<select name="kind">${kindOptions}</select></label>`,
    `<label class="pm-field"><span>${esc(t(locale, 'fieldStatus'))}</span>`,
    `<select name="status">`,
    option('active', t(locale, 'statusActive'), card.active),
    option('retired', t(locale, 'statusRetired'), !card.active),
    `</select></label>`,
    `</div>`,
    `<label class="pm-field"><span>${esc(t(locale, 'fieldKeywords'))}</span>`,
    `<input name="keywords" value="${esc((card.keywords ?? []).join(', '))}"></label>`,
    `<label class="pm-check">`,
    `<input type="checkbox" name="pinned"${card.pinned ? ' checked' : ''}${card.pinnedForced ? ' disabled' : ''}>`,
    `<span>${esc(t(locale, card.pinnedForced ? 'pinnedByKind' : 'pin'))}</span></label>`,
    `<label class="pm-field"><span>${esc(t(locale, 'fieldBody'))}</span>`,
    `<textarea name="body" rows="12">${esc(card.body ?? '')}</textarea></label>`,
    `<div class="pm-actions">`,
    `<button type="submit" class="pm-btn pm-primary">${esc(t(locale, 'save'))}</button>`,
    `<button type="button" class="pm-btn" data-act="cancel">${esc(t(locale, 'cancel'))}</button>`,
    `</div>`,
    `</form>`,
  ].join('');
}

function statsHtml(stats, { locale = 'en' } = {}) {
  const cell = (value, label) =>
    `<div class="pm-stat"><strong>${esc(String(value))}</strong><span>${esc(label)}</span></div>`;
  const pending = stats.pending
    ? `<button type="button" class="pm-stat pm-stat-action" data-act="open-review">`
      + `<strong>${esc(String(stats.pending))}</strong><span>${esc(t(locale, 'labelPending'))}</span></button>`
    : '';
  return [
    cell(stats.total, t(locale, 'unitEntries')),
    cell(stats.byKind ? Object.values(stats.byKind).filter(Boolean).length : 0, t(locale, 'unitKinds')),
    cell(stats.pinned, t(locale, 'labelPinned')),
    cell(stats.retired, t(locale, 'labelRetired')),
    cell(stats.recent, t(locale, 'labelRecent')),
    pending,
  ].join('');
}

function emptyHtml(kind, { locale = 'en' } = {}) {
  const filtered = kind === 'filtered';
  return [
    `<div class="pm-empty">`,
    `<h3>${esc(t(locale, filtered ? 'emptyFiltered' : 'emptyTitle'))}</h3>`,
    `<p>${esc(t(locale, filtered ? 'emptyFilteredBody' : 'emptyBody'))}</p>`,
    `</div>`,
  ].join('');
}

function confirmHtml({ locale = 'en' } = {}) {
  return [
    `<div class="pm-overlay" hidden>`,
    `<div class="pm-dialog" role="dialog" aria-modal="true" aria-label="${esc(t(locale, 'deleteTitle'))}">`,
    `<h3>${esc(t(locale, 'deleteTitle'))}</h3>`,
    `<p>${esc(t(locale, 'deleteBody'))}</p>`,
    `<div class="pm-actions">`,
    `<button type="button" class="pm-btn pm-danger" data-act="confirm-delete">${esc(t(locale, 'deleteConfirm'))}</button>`,
    `<button type="button" class="pm-btn" data-act="cancel-delete">${esc(t(locale, 'cancel'))}</button>`,
    `</div></div></div>`,
  ].join('');
}

module.exports = {
  KINDS, TEXT, localeOf, t, kindLabel,
  esc, inline, markdown,
  matchesQuery, filterCards,
  cardHtml, formHtml, statsHtml, emptyHtml, confirmHtml,
};
