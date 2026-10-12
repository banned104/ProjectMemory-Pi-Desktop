'use strict';

// Proposals, the confirmation card, and committing a confirmed batch.
// Shared by the plugin process (host fs gateway) and the agent extension
// (confined fs), so both confirmation paths validate and write identically.

const crypto = require('node:crypto');
const { normalize, sanitize, clip } = require('./text.js');
const {
  MEMORY_DIR, INBOX_DIR, MAP_ID, KINDS, isActive, loadCorpus, newEntryId, localDateTime,
  renderEntry, setFrontmatterFields, parseEntry,
} = require('./entries.js');
const { search } = require('./search.js');
const { recordDecisions } = require('./decisions.js');
const { t, localeOf } = require('./i18n.js');

const SKIP_KEY = 'skip';
/** Marker the card carries so the extension can recognise its own question. */
const ASK_MARKER = /\[PM ([0-9a-f]{8}) (\d+)\/(\d+)\]/;

const MAX_ITEMS = 5;
const MAX_TITLE = 120;
const MAX_CONTENT = 8000;
const MAX_KEYWORDS = 12;
const MAX_SIMILAR = 3;
/** Room for every label of one card, so a failure can name all of them. */
const MAX_OPTIONS_CHARS = 400;

const BATCH_ID_RE = /^KB-[0-9a-f-]{36}$/;
/** The short fingerprint carried on the card: 8 hex chars off the batch id. */
const REF_RE = /^[0-9a-f]{8}$/;
const ITEM_ID_RE = /^[0-9a-f-]{36}$/;
const staleApproval = () => Object.assign(new Error('approval is stale or missing; show the proposal again and confirm its current version'), { code: 'E_APPROVAL_STALE' });
const staleTarget = id => Object.assign(new Error('memory target changed since review: ' + id + '; compare and confirm again'), { code: 'E_TARGET_STALE' });

/** Full review projection, independent of the clipped card preview. */
function proposalDigest(batch) {
  const review = { schema: batch?.schema, revision: batch?.revision, analysisState: batch?.analysisState, id: batch?.id, locale: batch?.locale,
    items: batch?.items?.map(item => ({ itemId: item.itemId, kind: item.kind, title: item.title,
      content: item.content, keywords: item.keywords, pin: item.pin, origin:item.origin, scope:item.scope, similar: item.similar,
      options: item.options, decision: item.decision, ask: item.ask, note: item.note, analysis: item.analysis,
      savedAs: item.savedAs, decided: item.decided, reviewStatus: item.reviewStatus, requestedAction: item.requestedAction })) };
  return crypto.createHash('sha256').update(JSON.stringify(review)).digest('hex');
}


function batchPath(id) {
  if (typeof id !== 'string' || !BATCH_ID_RE.test(id)) throw new Error('invalid batch id');
  return `${INBOX_DIR}/${id}.json`;
}

const optionKey = (action, targetId) => (action === 'create' ? 'create' : `${action}:${targetId}`);
const replayKey = (kind, title) => `${kind}\u0000${normalize(title)}`;

/** Whether an error is the "no such pending batch" signal, in either locale. */
const isBatchMissing = error => {
  const message = String(error?.message ?? '');
  return message === t('en', 'batchMissing') || message === t('zh-CN', 'batchMissing');
};

// --- Proposal validation ---------------------------------------------------

 function validateItems(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('items must be a non-empty array');
  if (items.length > MAX_ITEMS) throw new Error(`at most ${MAX_ITEMS} items per proposal`);
  const normalized = items.map((item, index) => {
    const kind = typeof item?.kind === 'string' ? item.kind.trim() : '';
    if (!['lesson', 'rule', 'decision', 'procedure', 'map', 'preference'].includes(kind)) {
      throw new Error(`items[${index}].kind must be one of: lesson, rule, decision, procedure, map, preference`);
    }
    const title = typeof item?.title === 'string' ? item.title.trim() : '';
    const content = typeof item?.content === 'string' ? item.content.trim() : '';
    if (!title) throw new Error(`items[${index}].title is required`);
    if (!content) throw new Error(`items[${index}].content is required`);
    if (title.length > MAX_TITLE) throw new Error(`items[${index}].title exceeds ${MAX_TITLE} characters`);
    if (content.length > MAX_CONTENT) throw new Error(`items[${index}].content exceeds ${MAX_CONTENT} characters`);
    const keywords = (Array.isArray(item?.keywords) ? item.keywords : [])
      .filter(k => typeof k === 'string' && k.trim())
      .map(k => k.trim())
      .slice(0, MAX_KEYWORDS);
    const optional={};
    for(const field of ['origin','scope']) if(item[field]!==undefined){
      if(typeof item[field]!=='string'||item[field].trim().length>1600)throw new Error(field+' must be a string of at most 1600 characters');
      if(item[field].trim())optional[field]=item[field].trim();
    }
    return { kind, title, content, keywords, pin: item?.pin === true,...optional };
  });
  assertProposalSet(normalized);
  return normalized;
}

function assertProposalSet(items) {
  // Two items that replay to the same key collapse onto one landed entry on
  // retry while getting distinct ids on first write: reject them up front.
  // Two maps in one batch last-wins on the singleton file for the same reason.
  const seen = new Set();
  let maps = 0;
  items.forEach((item, index) => {
    if (item.kind === 'map') maps += 1;
    const key = `${item.kind}\u0000${normalize(item.title)}`;
    if (seen.has(key)) throw new Error(`items[${index}] duplicates an earlier proposal (same kind and title)`);
    seen.add(key);
  });
  if (maps > 1) throw new Error('at most one map item per proposal');
}

/**
 * Fail-closed shape check for a batch about to be committed. `propose` runs
 * `validateItems` once, but the batch file sits on disk until someone answers,
 * and anything that rewrites it afterwards must not widen what gets written:
 * kind/title/content/keywords are re-checked here, against the same limits.
 */
function checkBatchItem(item) {
  if (!item || typeof item !== 'object') return 'not an object';
  if (!KINDS.includes(item.kind)) return `kind must be one of: ${KINDS.join(', ')}`;
  if (typeof item.title !== 'string' || !item.title.trim()) return 'title is required';
  if (item.title.trim().length > MAX_TITLE) return `title exceeds ${MAX_TITLE} characters`;
  if (typeof item.content !== 'string' || !item.content.trim()) return 'content is required';
  if (item.content.trim().length > MAX_CONTENT) return `content exceeds ${MAX_CONTENT} characters`;
  if (item.keywords !== undefined
    && (!Array.isArray(item.keywords) || item.keywords.length > MAX_KEYWORDS
      || item.keywords.some(k => typeof k !== 'string'))) {
    return `at most ${MAX_KEYWORDS} keywords`;
  }
  for(const field of ['origin','scope']) if(item[field]!==undefined&&(typeof item[field]!=='string'||item[field].length>1600))return field+' must be a short string';
  if (item.pin !== undefined && typeof item.pin !== 'boolean') return 'pin must be a boolean';
  return null;
}

/** Persisted options are untrusted; only canonical action/key pairs can execute. */
function assertItemOptions(item, locale) {
  const invalid = () => { throw new Error(t(locale, 'invalidAction', sanitize(item.title, MAX_TITLE))); };
  if (!Array.isArray(item.options) || !item.options.length) invalid();
  const keys = new Set();
  for (const option of item.options) {
    if (!option || !['create', 'replace', 'duplicate', 'conflict'].includes(option.action)) invalid();
    if (option.action === 'create' ? option.targetId !== null
      : typeof option.targetId !== 'string' || !option.targetId.trim()) invalid();
    if (option.key !== optionKey(option.action, option.targetId) || keys.has(option.key)) invalid();
    keys.add(option.key);
  }
}

function assertBatchIntegrity(batch) {
  const locale = batch?.locale;
  if (!batch || batch.schema !== 'memory-inbox/1'
    || typeof batch.id !== 'string' || !BATCH_ID_RE.test(batch.id)
    || typeof batch.ref !== 'string' || !REF_RE.test(batch.ref)
    || batch.ref !== batch.id.slice(3, 11)) {
    throw new Error(t(locale, 'batchMissing'));
  }
  if (!Array.isArray(batch.items) || !batch.items.length || batch.items.length > MAX_ITEMS) {
    throw new Error(`invalid batch ${batch.id}: items must hold 1-${MAX_ITEMS} proposals`);
  }
  batch.items.forEach((item, index) => {
    const bad = checkBatchItem(item);
    if (bad) throw new Error(`invalid batch ${batch.id} item[${index}]: ${bad}`);
    assertItemOptions(item, locale);
  });
  assertProposalSet(batch.items);
  if (batch.revision === 2) {
    const identities = new Set();
    for (const item of batch.items) {
      if (!ITEM_ID_RE.test(item.itemId) || identities.has(item.itemId)) throw new Error('invalid batch item identity');
      identities.add(item.itemId);
    }
  }
}

/**
 * Items still waiting for a verdict: neither written (`savedAs` from an
 * earlier round) nor decided without a write (`decided` skip/duplicate mark).
 * Entries recovered from disk via `batchRef` without either mark are counted
 * as decided by the caller, not here — this is the cheap display count.
 */
function reviewStateOf(item) {
  if (item?.savedAs) return 'approved';
  if (item?.decided) return String(item.decided).startsWith('duplicate:') ? 'duplicate' : 'rejected';
  return item?.reviewStatus === 'deferred' ? 'deferred' : 'unreviewed';
}

function undecidedCount(batch) {
  if (!batch || !Array.isArray(batch.items)) return 0;
  return batch.items.filter(item => item && !item.savedAs && !item.decided).length;
}

const MAP_SOURCE = `${MEMORY_DIR}/${MAP_ID}.md`;

/** Only a unique, active canonical map can be overwritten by an approved update. */
function assertMapLayout(entries, locale = 'en') {
  const maps = entries.filter(entry => entry.kind === 'map' || entry.id === MAP_ID || entry.source === MAP_SOURCE);
  if (maps.length > 1 || maps.some(entry => entry.kind !== 'map' || entry.id !== MAP_ID
    || entry.source !== MAP_SOURCE || !isActive(entry))) {
    throw new Error(t(locale, 'mapLayout'));
  }
  return maps[0] ?? null;
}

// Body equality must preserve code case, Unicode and indentation.
const bodyForm = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();

/** Same kind only: replacing a lesson with a procedure is never the intent. */
function findSimilar(entries, item, limit = MAX_SIMILAR, locale = 'en') {
  if (item.kind === 'map') assertMapLayout(entries, locale);
  const pool = entries.filter(entry => isActive(entry) && entry.kind === item.kind);
  const body = bodyForm(item.content);
  const duplicates = pool.filter(entry => bodyForm(entry.body) === body);
  const exact = pool.filter(entry => normalize(entry.title) === normalize(item.title));
  const query = `${item.title} ${item.keywords.join(' ')}`;
  const ranked = search(entries, query, { kind: item.kind, limit: limit + exact.length })
    .map(hit => hit.entry)
    .filter(entry => !exact.includes(entry));
  // Exact bodies are checked across the accessible corpus before any display cap.
  const similar = [...new Set([...duplicates, ...exact, ...ranked])];
  // The map is the one entry a text search may legitimately miss: its title is
  // stable while a fresh proposal's wording is not, and a retired map is not
  // searchable at all. Reading it straight out of the corpus is what lets
  // `optionsFor` offer the update when a map exists and the create when it does
  // not — a search miss used to leave the card with no save action whatsoever.
  if (item.kind === 'map') {
    similar.unshift(...entries.filter(entry =>
      entry.kind === 'map' && isActive(entry) && !similar.includes(entry)));
  }
  return similar.slice(0, limit);
}

function comparisonCandidates(entries,item,requested,locale='en') {
  const similar=findSimilar(entries,item,MAX_SIMILAR,locale);
  if(!requested||requested.action==='create')return similar;
  const target=entries.find(entry=>entry.id===requested.targetId);
  if(!['replace','conflict','duplicate'].includes(requested.action)||!target
    ||!findSimilar([target],item,MAX_SIMILAR,locale).some(entry=>entry.id===target.id)) {
    throw Object.assign(new Error('requested target is missing, retired or unrelated; choose a current target explicitly'),{code:'E_COMPARE_INVALID'});
  }
  return similar.some(entry=>entry.id===target.id)?similar:[...similar.slice(0,MAX_SIMILAR-1),target];
}

// --- Decisions -------------------------------------------------------------

/**
 * The map is a singleton: create it once, then only ever update it. Offering
 * both actions at once is what would let a project end up with two maps, so a
 * map item lists exactly one save action. `duplicate` rides along whenever a
 * map exists because `heuristicDecision` returns it for an unchanged body, and
 * the card only ever shows the action the decision names: without the option
 * the recommendation would name a choice the card cannot offer and the item
 * would be left with "do not save" as its only entry.
 */
function optionsFor(item, similar) {
  if (item.kind === 'map') {
    const existing = similar.find(entry => entry.kind === 'map');
    if (!existing) return [{ action: 'create', targetId: null, labelKey: 'create' }];
    return [
      { action: 'replace', targetId: existing.id, labelKey: 'mapUpdate' },
      { action: 'duplicate', targetId: existing.id, labelKey: 'duplicate' },
    ];
  }
  const options = [{ action: 'create', targetId: null, labelKey: 'create' }];
  for (const entry of similar) {
    options.push({ action: 'replace', targetId: entry.id, labelKey: 'replace' });
    options.push({ action: 'duplicate', targetId: entry.id, labelKey: 'duplicate' });
    options.push({ action: 'conflict', targetId: entry.id, labelKey: 'conflict' });
  }
  return options;
}

/** Local heuristic dedup. No network: this is where the original called Jev. */
function heuristicDecision(item, similar) {
  const sameBody = similar.find(entry => bodyForm(entry.body) === bodyForm(item.content));
  if (sameBody) return { action: 'duplicate', targetId: sameBody.id, source: 'heuristic' };
  if (item.kind === 'map') {
    const existing = similar.find(entry => entry.kind === 'map');
    if (existing) return { action: 'replace', targetId: existing.id, source: 'heuristic' };
    return { action: 'create', targetId: null, source: 'no-similar' };
  }
  return { action: 'create', targetId: null, source: similar.length ? 'heuristic' : 'no-similar' };
}

function decisionNote(batch, item) {
  const decision = item.decision;
  const option = item.options.find(o => o.key === optionKey(decision.action, decision.targetId));
  if (decision.action === 'duplicate') return t(batch.locale, 'noteDuplicate');
  if (decision.action === 'replace' && decision.targetId) {
    return item.kind === 'map'
      ? t(batch.locale, 'noteMap')
      : t(batch.locale, 'noteReplace', decision.targetId);
  }
  if (decision.source === 'no-similar') return t(batch.locale, 'noteNew');
  return t(batch.locale, 'noteSimilar', item.similar.length);
}

// --- Batch construction ----------------------------------------------------

/** Recommended action first, then the alternatives for the focus target, then "do not save". */
function askOptions(batch, item) {
  const recommended = optionKey(item.decision.action, item.decision.targetId);
  const focus = item.decision.targetId ?? item.similar[0]?.id ?? null;
  const keys = [recommended];
  if (item.kind !== 'map' && !item.analysis) {
    keys.push('create');
    if (focus) keys.push(`replace:${focus}`, `conflict:${focus}`, `duplicate:${focus}`);
  }
  const offered = [...new Set(keys)].filter(key => item.options.some(o => o.key === key));
  const choices = offered.map(key => {
    const option = item.options.find(o => o.key === key);
    return {
      key,
      label: key === recommended ? t(batch.locale, 'recommended', option.label) : option.label,
    };
  });
  if(item.analysis)for(const option of item.options.filter(o=>o.action==='duplicate'&&o.key!==recommended))choices.push({key:option.key,label:option.label});
  if (item.analysis) choices.push({ key: 'defer', label: t(batch.locale, 'defer') });
  choices.push({ key: SKIP_KEY, label: t(batch.locale, 'skip') });
  return choices;
}

function buildBatch({ prepared, sessionId, locale, id = `KB-${crypto.randomUUID()}`, createdAt = new Date().toISOString() }) {
  const language = localeOf(locale);
  const batch = {
    schema: 'memory-inbox/1',
    revision: 2,
    id,
    ref: id.slice(3, 11),
    createdAt,
    locale: language,
    sessionId: sessionId ?? null,
    items: prepared.map(({ item, similar }) => {
      const decision = heuristicDecision(item, similar);
      const options = optionsFor(item, similar).map(option => ({
        key: optionKey(option.action, option.targetId),
        action: option.action,
        targetId: option.targetId,
        label: t(language, option.labelKey, option.targetId),
      }));
      return {
        itemId: crypto.randomUUID(),
        kind: item.kind,
        title: item.title,
        content: item.content,
        keywords: item.keywords,
        pin: item.pin,
        ...(item.origin?{origin:item.origin}:{}),...(item.scope?{scope:item.scope}:{}),
        similar: similar.map(entry => ({
          id: entry.id, kind: entry.kind, title: entry.title, summary: entry.summary, source: entry.source, baseHash: entry.hash ?? null,
        })),
        options,
        decision,
      };
    }),
  };
  for (const item of batch.items) {
    item.note = decisionNote(batch, item);
    item.ask = askOptions(batch, item);
  }
  return batch;
}

/** Arguments for the host `asktool`: one single-choice question per item. */
function askToolArgs(batch) {
  const total = batch.items.length;
  return {
    questions: batch.items.flatMap((item, index) => item.savedAs || item.decided ? [] : [{
      question: t(
        batch.locale,
        'question',
        `[PM ${batch.ref} ${index + 1}/${total}] [REV ${proposalDigest(batch)}]`,
        t(batch.locale, `kind_${item.kind}`),
        sanitize(item.title, MAX_TITLE),
        sanitize(item.note, 160),
        item.analysis ? t(batch.locale,'reviewExcerpt',
          sanitize(item.analysis.targetId??item.similar[0]?.id??'—',80),
          sanitize(item.analysis.previews?.find(v=>v.id===item.analysis.targetId)?.body??item.analysis.previews?.[0]?.body??'—',240),
          sanitize(item.content,320),sanitize(item.analysis.changes,200),sanitize(item.analysis.scope,160),
          sanitize(item.analysis.evidence?.join('; '),240)) : sanitize(item.content, 200),
      ),
      options: item.ask.map(choice => choice.label),
    }]),
  };
}

/**
 * How a typed answer is compared with a card label. The host always offers a
 * free-text box beside the options, and the labels are long, localized and
 * decorated with the "recommended" marker, so a user who retypes a label by
 * hand must still land on it. `normalize` folds case, width and whitespace
 * runs; the decoration is stripped from both sides, which makes
 * "Recommended · New: ..." and "New: ..." the same answer.
 *
 * Nothing here guesses intent. An answer that does not reduce to a label the
 * card actually offered stays undecided, and the note names the labels that
 * were available so the user can answer again.
 */
const RECOMMENDED_DECORATION = /^(?:推荐|recommended)\s*·\s*/i;
const answerForm = value => normalize(value).replace(RECOMMENDED_DECORATION, '');

/**
 * Map genuine asktool answers back to selections. Only options this plugin
 * generated count. An explicit "do not save" is recorded as a verdict; an
 * answer that matches no label, or an unanswered question, leaves that item
 * undecided.
 */
function selectionsFromAnswers(batch, questions, answers) {
  const selections = [];
  const notes = [];
  questions.forEach((question, index) => {
    const marker = ASK_MARKER.exec(String(question?.question ?? ''));
    if (!marker || marker[1] !== batch.ref) return;
    const itemIndex = Number(marker[2]) - 1;
    const item = batch.items[itemIndex];
    if (!item) return;
    const answer = answers?.[index];
    if (!Array.isArray(answer) || !answer.length) {
      notes.push(t(batch.locale, 'unanswered', sanitize(item.title, MAX_TITLE)));
      return;
    }
    const typed = answerForm(answer[0]);
    const choice = typed ? item.ask.find(candidate => answerForm(candidate.label) === typed) : null;
    if (!choice) {
      // Name the choices the card did offer. Without them the free-text box is
      // a dead end: the user has no way to learn what the card accepts.
      const offered = sanitize(item.ask.map(candidate => candidate.label).join(' / '), MAX_OPTIONS_CHARS);
      notes.push(t(
        batch.locale, 'notAnOption',
        sanitize(item.title, MAX_TITLE), sanitize(String(answer[0]), 40), offered,
      ));
      return;
    }
    // "Do not save" is still a verdict and is recorded as one. Only an answer
    // that matches nothing or an unanswered question leaves the item undecided.
    selections.push({ index: itemIndex, key: choice.key });
  });
  return { selections, notes };
}

// --- Inbox -----------------------------------------------------------------

async function readBatch(io, id, locale) {
  let raw;
  try { raw = await io.readText(batchPath(id)); }
  catch (error) {
    if (isMissingLike(error)) throw new Error(t(locale, 'batchMissing'));
    throw error;
  }
  let batch;
  try { batch = JSON.parse(raw); }
  catch { throw new Error(t(locale, 'batchMissing')); }
  // A batch that has been handled is not a pending batch any more. Without
  // this the panel can commit it again: `batchRef` idempotency then only holds
  // as long as no entry file was deleted in between.
  const status = typeof batch?.status === 'string' ? batch.status.trim() : '';
  if (batch?.schema !== 'memory-inbox/1' || batch?.id !== id || !Array.isArray(batch?.items)
    || !batch.items.length || batch.items.length > MAX_ITEMS
    || batch.ref !== id.slice(3, 11)
    || (status && status !== 'pending')) {
    throw new Error(t(locale, 'batchMissing'));
  }
  return batch;
}

const isMissingLike = error =>
  ['ENOENT', 'ENOTDIR', 'NOT_FOUND'].includes(error?.code) || /not found/i.test(String(error?.message ?? ''));

async function listBatches(io) {
  let files;
  try { files = await io.reader.list(INBOX_DIR); }
  catch (error) { if (isMissingLike(error)) return []; throw error; }
  const batches = [];
  for (const file of files) {
    const match = /^(KB-[0-9a-f-]{36})\.json$/.exec(file.name);
    if (file.isDirectory || !match) continue;
    try {
      batches.push(await readBatch(io, match[1], 'en'));
    } catch (error) {
      // A handled or malformed batch is hidden. Anything else (a permission
      // or IO failure) is re-thrown: a silently short list would let the user
      // believe there is nothing waiting when the read simply failed.
      if (isBatchMissing(error)) continue;
      throw error;
    }
  }
  return batches.sort((a, b) => String(a.createdAt) < String(b.createdAt) ? -1 : String(a.createdAt) > String(b.createdAt) ? 1 : 0);
}

/**
 * A handled batch is deleted when the io layer can delete, and marked `done`
 * when it cannot (the plugin process has no fs.delete permission, so its
 * `remove` always throws by design).
 *
 * Idempotent both ways: when the file is already gone (deleted concurrently by
 * the other process) it stays gone — writing `done` back would resurrect a
 * handled batch. The existence check before the `done` write covers the case
 * where the delete happened between our load and our retire.
 */
async function retireBatch(io, batch, result) {
  try {
    await io.remove(batchPath(batch.id));
    return;
  } catch (error) {
    if (isMissingLike(error)) return;
    try {
      try {
        if (!(await io.exists(batchPath(batch.id)))) return;
      } catch { return; }
      await io.writeText(batchPath(batch.id), JSON.stringify({ ...batch, status: 'done', result }, null, 2));
    } catch { /* nothing else to do; the batch simply stays pending */ }
  }
}

// --- Commit ----------------------------------------------------------------

/**
 * Validate every selection first; write only when the whole commit is valid.
 * An item without a verdict — not selected at all, or answered with free text —
 * is left pending: the batch is retired only once every item has been decided.
 *
 * A verdict that needs no write (`skip`, `duplicate`) is stamped onto the item
 * (`decided`) and written back with the batch when siblings are still pending,
 * so the next round counts it as decided instead of asking again. An item this
 * batch already wrote (`savedAs`) counts as already saved on retry, never as
 * skipped.
 *
 * Idempotency does not depend on the inbox write succeeding: every entry this
 * batch wrote carries `batchRef`, so a retry finds what already landed and
 * adopts it instead of writing a second copy. A replayed item skips target
 * validation on purpose: the entry it replaced is legitimately retired by now,
 * and that must not block the rest of the batch.
 */
async function commitBatch(io, batch, selections, options = {}) {
  const date = options.date ?? localDateTime();
  const locale = batch?.locale;
  if (!Array.isArray(selections)) throw new Error('selections must be an array');
  assertBatchIntegrity(batch);
  if (batch.analysisState && batch.analysisState !== 'analysed' && selections.some(selection=>!['skip','defer'].includes(selection?.key))) {
    throw Object.assign(new Error('comparison is incomplete; use prepare and propose before confirmation'), { code: 'E_COMPARE_INCOMPLETE' });
  }
  if (batch.revision !== 2 || typeof options.expectedDigest !== 'string'
    || options.expectedDigest !== proposalDigest(batch)) throw staleApproval();

  const corpus = await loadCorpus(io.reader, { keepDuplicates: true });
  const unique = new Map();
  for (const entry of corpus) if (!unique.has(entry.id)) unique.set(entry.id, entry);
  const entries = [...unique.values()];
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const landed = new Map();
  for (const entry of entries) {
    if (entry.batchId === batch.id && entry.itemId) landed.set(entry.itemId, entry);
  }

  // Items an earlier round already wrote (persisted `savedAs` by the
  // write-back below). They count as already saved, never as skipped.
  const hadSaved = new Set();
  batch.items.forEach((item, index) => { if (item && item.savedAs) hadSaved.add(index); });

  const plan = [];
  const verdicts = [];
  const seen = new Set();
  for (const selection of selections) {
    const item = batch.items[selection?.index];
    if (!Number.isInteger(selection?.index) || !item || seen.has(selection.index)) throw new Error('invalid selection');
    seen.add(selection.index);
    if (item.savedAs) continue;
    if (item.decided) continue;
    if (selection.key === 'defer') { verdicts.push({ item, key: 'defer' }); continue; }
    if (selection.key === SKIP_KEY) { verdicts.push({ item, key: SKIP_KEY }); continue; }
    if (item.analysis && selection.key !== optionKey(item.analysis.action, item.analysis.targetId)
      && !item.options.some(o=>o.key===selection.key&&o.action==='duplicate'&&item.analysis.compared?.some(v=>v.id===o.targetId))) {
      throw new Error(t(locale, 'invalidAction', sanitize(item.title, MAX_TITLE)));
    }
    const offered = item.options.find(candidate => candidate.key === selection.key);
    if (!offered) throw new Error(t(locale, 'invalidAction', sanitize(item.title, MAX_TITLE)));
    // Reconstruct the executable object; labels and arbitrary inbox fields never execute.
    const option = { key: offered.key, action: offered.action, targetId: offered.targetId };
    // An item this batch already wrote in an earlier run needs no validation:
    // it is on disk. Everything below protects a *new* write, and the target a
    // landed item replaced is legitimately retired by now — that must not
    // block the retry.
    const replay = landed.get(item.itemId) ?? null;
    if (replay && replay.commitKey !== option.key) {
      throw Object.assign(new Error('the item was already committed with a different operation'), { code: 'E_REPLAY_CONFLICT' });
    }
    if (!replay && batch.analysisState==='analysed' && !item.analysis) {
      throw Object.assign(new Error('item analysis is missing; compare the current item before confirmation'),{code:'E_COMPARE_INCOMPLETE'});
    }
    if (!replay && item.analysis) {
      if (!Array.isArray(item.analysis.compared)) throw staleApproval();
      for (const version of item.analysis.compared) {
        const candidate = byId.get(version.id);
        if (!candidate || !isActive(candidate) || candidate.kind !== item.kind || candidate.hash !== version.baseHash
          || version.source && candidate.source !== version.source) throw staleTarget(version.id);
      }
    }
    let target = null;
    if (option.targetId) {
      target = byId.get(option.targetId) ?? null;
      if (!replay) {
        if (!target || !isActive(target)) {
          throw new Error(t(locale, 'targetGone', sanitize(item.title, MAX_TITLE), option.targetId));
        }
        if (target.kind !== item.kind) {
          throw new Error(t(locale, 'kindMismatch', target.id));
        }
        if (option.action === 'replace'
          && plan.some(entry => entry.option.action === 'replace' && entry.target?.id === target.id)) {
          throw new Error(t(locale, 'oneReplacement', target.id));
        }
      }
    }
    if (item.kind === 'map') {
      const map = assertMapLayout(corpus, locale);
      if (!map && await io.exists(MAP_SOURCE)) throw new Error(t(locale, 'mapLayout'));
    }
    if (!replay) {
      // Validate the selected target itself, not its position in a moving top-N window.
      // A stored option alone is insufficient: unrelated targets remain forbidden.
      const candidates = target && item.kind !== 'map' ? [target] : entries;
      const allowed = optionsFor(item, findSimilar(candidates, item, MAX_SIMILAR, locale));
      if (!allowed.some(candidate => optionKey(candidate.action, candidate.targetId) === option.key)) {
        throw new Error(t(locale, 'invalidAction', sanitize(item.title, MAX_TITLE)));
      }
    }
    if (!replay && target) {
      const reviewed = item.similar.find(candidate => candidate.id === target.id);
      if (!reviewed?.baseHash || reviewed.baseHash !== target.hash) throw staleTarget(target.id);
    }
    if (option.action === 'duplicate') { verdicts.push({ item, key: selection.key }); continue; }
    plan.push({ item, option, target, replay });
  }

  // Already-published items may still need the backlink their first write could not finish.
  // Recover the original operation, never infer a new one from the current recommendation.
  for (const item of batch.items) {
    const replay = landed.get(item.itemId);
    if (!replay || item.kind === 'map' || plan.some(entry => entry.item === item)) continue;
    const match = /^(replace|conflict):(.+)$/.exec(replay.commitKey ?? '');
    if (!match) continue;
    const option = item.options.find(candidate => candidate.key === replay.commitKey);
    if (!option || option.action !== match[1] || option.targetId !== match[2]) {
      throw Object.assign(new Error('the item was already committed with a different operation'), { code: 'E_REPLAY_CONFLICT' });
    }
    const target = byId.get(option.targetId) ?? null;
    if (target && target.kind !== item.kind) throw staleTarget(target.id);
    plan.push({ item, option, target, replay, repairOnly: true });
  }

  // Do not mutate verdicts until every selection has passed validation.
  for (const { item, key } of verdicts) {
    if (key === 'defer') item.reviewStatus = 'deferred';
    else { item.decided = key; delete item.reviewStatus; }
  }
  for (const { item } of plan) { delete item.decided; delete item.reviewStatus; }

  const taken = new Set(entries.map(entry => entry.id));
  const saved = [];
  const warnings = [];
  try {
    for (const { item, option, target, replay, repairOnly } of plan) {
      let id;
      let source;
      if (replay) {
        id = replay.id;
        source = replay.source;
      } else {
        id = newEntryId(item.kind, item.title, date, taken);
        taken.add(id);
        source = `${MEMORY_DIR}/${id}.md`;
        await io.writeText(source, renderEntry({
          id,
          kind: item.kind,
          title: item.title,
          keywords: item.keywords,
          content: item.content,
          origin:item.origin,scope:item.scope??item.analysis?.scope,
          created: date,
          updated: date,
          pinned: item.pin,
          batchRef: batch.ref,
          batchId: batch.id,
          itemId: item.itemId,
          commitKey: option.key,
          supersedes: option.action === 'replace' ? target?.id ?? null : null,
          related: option.action === 'conflict' && target ? [target.id] : [],
        }));
      }
      item.savedAs = id;
      if (!repairOnly) saved.push({ id, kind: item.kind, title: item.title, source, action: option.action, targetId: option.targetId });

      // The entry is already safe on disk; a failed back-link is reported, not
      // rolled back. It runs for a replayed item too: the fields written are
      // the same both times, which is what makes a retry converge instead of
      // leaving an earlier partial run half-linked.
      // The map is a singleton: replacing it overwrites the same file, so there
      // is no old entry to retire.
      if (item.kind !== 'map' && target && (option.action === 'replace' || option.action === 'conflict')) {
        // Same bar as `deleteTarget`, duplicated here because this module
        // cannot require the view layer (it requires this one). The target
        // came from a just-loaded corpus, but a hostile lister could have
        // paired a victim id with another file inside the memory dir.
        const src = typeof target.source === 'string' ? target.source : '';
        const prefix = `${MEMORY_DIR}/`;
        const rest = src.startsWith(prefix) ? src.slice(prefix.length) : '';
        const pathOk = rest.length > 3 && /\.md$/i.test(src)
          && !src.includes('..') && !src.includes('\\') && !src.includes('\0') && !src.includes(':')
          && src.charCodeAt(0) !== 0xFEFF && !src.includes('//')
          && rest.split('/').every(part => part && part !== '.' && part !== '..'
            && !part.endsWith('.') && !part.endsWith(' '));
        if (!pathOk) {
          warnings.push(t(locale, 'backlinkFailed', id, target.id, 'invalid target path'));
        } else try {
          const raw = await io.readText(target.source);
          // Bind the id to the file: refuse rather than mislabel a file that
          // became a different entry between the corpus load and this write.
          const current = parseEntry(target.source, raw);
          const linked = option.action === 'replace' ? current.supersededBy === id : current.related.includes(id);
          const baseHash = item.similar.find(candidate => candidate.id === target.id)?.baseHash;
          if (current.id !== target.id || !linked && current.hash !== baseHash) {
            warnings.push(t(locale, 'backlinkFailed', id, target.id, 'target changed on disk'));
          } else if (!linked) {
            // The retired/linked entry moves with the batch: without a fresh
            // 'updated' it would sink to the bottom of a time-sorted view forever.
            const fields = option.action === 'replace'
              ? { status: 'deprecated', supersededBy: id, updated: date }
              : { related: [...new Set([...target.related, id])], updated: date };
            await io.writeText(target.source, setFrontmatterFields(raw, fields));
          }
        } catch (error) {
          warnings.push(t(locale, 'backlinkFailed', id, target.id, String(error?.message ?? error)));
        }
      }
    }
  } catch (error) {
    if (saved.length) {
      // Best effort only. The batchRef scan above is what makes the retry safe,
      // so a write-back failure here is reported inside the thrown message
      // rather than swallowed.
      let writeBack = '';
      try {
        await io.writeText(batchPath(batch.id), JSON.stringify(batch, null, 2));
      } catch (writeError) {
        writeBack = ` ${t(locale, 'inboxWriteFailed', String(writeError?.message ?? writeError))}`;
      }
      throw new Error(
        t(locale, 'partialFailure', saved.map(entry => entry.id).join(', '), String(error?.message ?? error)) + writeBack,
      );
    }
    throw error;
  }

  // Every item falls into exactly one of: written now, already on disk from an
  // earlier round of this batch, decided without a write, or still undecided.
  // "Already on disk" is read from the batchRef scan and from the persisted
  // `savedAs` marks — not from memory: a batch re-read from disk after a
  // partial round must report those entries as already saved rather than as
  // skipped or pending.
  const keyOf = item => item.itemId;
  const savedIdx = new Set(plan.filter(p => !p.repairOnly).map(p => batch.items.indexOf(p.item)));
  const already = [];
  const settled = new Set(savedIdx);
  batch.items.forEach((item, index) => {
    if (!item || settled.has(index)) return;
    if (hadSaved.has(index) && item.savedAs) {
      const hit = landed.get(keyOf(item));
      if (hit) already.push({ id: hit.id, kind: hit.kind, title: hit.title });
      else already.push({ id: item.savedAs, kind: item.kind, title: item.title });
      settled.add(index);
      return;
    }
    if (!seen.has(index)) {
      const hit = landed.get(keyOf(item));
      if (hit) {
        already.push({ id: hit.id, kind: hit.kind, title: hit.title });
        settled.add(index);
      }
    }
  });
  let skipped = 0;
  batch.items.forEach((item, index) => {
    if (!item || settled.has(index)) return;
    if (item.decided) { skipped += 1; settled.add(index); }
  });
  const pending = batch.items.length - saved.length - already.length - skipped;
  const result = {
    saved,
    already,
    skipped,
    pending,
    deferred: batch.items.filter(item => reviewStateOf(item) === 'deferred').length,
    rejected: batch.items.filter(item => reviewStateOf(item) === 'rejected').length,
    duplicate: batch.items.filter(item => reviewStateOf(item) === 'duplicate').length,
    warnings,
  };
  const decisionEvents = selections.flatMap(selection => {
    const item=batch.items[selection.index];
    if (!item?.analysis) return [];
    const status=reviewStateOf(item);
    return status==='unreviewed' ? [] : [{item,status,reason:item.analysis?.reason??''}];
  });
  if (decisionEvents.length) warnings.push(...(await recordDecisions(io,decisionEvents)).warnings);
  if (pending > 0) {
    // Remember this round's verdicts (saves and skips alike) so the next round
    // does not ask again. A write-back failure only costs a repeated question:
    // the batchRef scan still guards against double writes.
    if (saved.length || skipped > 0 || already.length || verdicts.length) {
      try {
        await io.writeText(batchPath(batch.id), JSON.stringify(batch, null, 2));
      } catch (error) {
        warnings.push(t(locale, 'inboxWriteFailed', String(error?.message ?? error)));
      }
    }
  } else {
    await retireBatch(io, batch, result);
  }
  return result;
}

function describeResult(result, locale) {
  // "Nothing was saved" is an outcome in its own right. Without it a single
  // item chosen as "duplicate" reads as a bare "1 skipped", and the user is
  // left wondering whether anything landed. It is the wrong thing to say when
  // an earlier round of this batch already wrote entries, though: those are on
  // disk, and saying otherwise invites a duplicate proposal.
  const already = result.already ?? [];
  const lines = result.saved.length || already.length ? [] : [t(locale, 'nothingSaved')];
  if(result.deferred)lines.push(t(locale,'deferred',result.deferred));
  lines.push(...result.saved.map(entry =>
    entry.action === 'replace'
      ? t(locale, 'savedReplace', entry.id, entry.targetId)
      : entry.action === 'conflict'
        ? t(locale, 'savedConflict', entry.id, entry.targetId)
        : t(locale, 'saved', entry.id, entry.kind, clip(entry.title, 80))));
  if (already.length) lines.push(t(locale, 'alreadySaved', already.map(entry => entry.id).join(', ')));
  if(result.rejected||result.duplicate){
    if(result.rejected)lines.push(t(locale,'rejected',result.rejected));
    if(result.duplicate)lines.push(t(locale,'duplicates',result.duplicate));
  }else if (result.skipped) lines.push(t(locale, 'notSaved', result.skipped));
  if (result.pending) lines.push(t(locale, 'pending', result.pending));
  return [...lines, ...result.warnings];
}

module.exports = {
  SKIP_KEY, ASK_MARKER, MAX_ITEMS, MAX_TITLE, MAX_CONTENT, MAX_KEYWORDS,
  batchPath, optionKey, replayKey, validateItems, findSimilar, comparisonCandidates, optionsFor,
  heuristicDecision, decisionNote, askOptions, buildBatch, askToolArgs,
  selectionsFromAnswers, readBatch, listBatches, retireBatch, commitBatch, describeResult,
  assertBatchIntegrity, undecidedCount, reviewStateOf, proposalDigest,
  MAP_ID,
};
