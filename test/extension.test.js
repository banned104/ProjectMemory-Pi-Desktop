'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../plugin/core/index.js');
const extension = require('../plugin/extension.js');
const { memoryIo, mdFile, MEMORY, INBOX } = require('./helpers.js');

const { promptTurns, turnKeys, onProviderRequest, onBeforeAgentStart, onToolResult, retrieve, injections } = extension._internals;

const BATCH_ID = 'KB-11111111-2222-3333-4444-555555555555';
const CWD = '/project';

const ctx = (overrides = {}) => ({ cwd: CWD, sessionManager: { getSessionId: () => 's1' }, ...overrides });

/** A corpus whose retrieval is guaranteed to hit. */
const corpusIo = () => memoryIo({
  [`${MEMORY}/MAP.md`]: mdFile('MAP', { kind: 'map', title: 'Project map', body: 'Modules: src/boot' }),
  [`${MEMORY}/LSN-20260101-alpha.md`]: mdFile('LSN-20260101-alpha', { title: 'Alpha lesson', body: 'alpha detail' }),
  [`${MEMORY}/LSN-20260101-beta.md`]: mdFile('LSN-20260101-beta', { title: 'Beta lesson', body: 'beta detail' }),
});

const resetInjectionCache = () => injections.clear();

// --- Prompt extraction -----------------------------------------------------

test('promptTurns handles the OpenAI, Responses and Google shapes', () => {
  const openai = promptTurns({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(openai.list, 'messages');
  assert.equal(openai.turns[0].text, 'hello');

  const responses = promptTurns({ input: [{ role: 'user', content: 'hello' }] });
  assert.equal(responses.list, 'input');

  const google = promptTurns({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] });
  assert.equal(google.list, 'contents');
  assert.equal(google.turns[0].field, 'parts');
  assert.equal(google.turns[0].part, 0);
});

test('promptTurns ignores a user turn that only carries tool results', () => {
  const anthropic = promptTurns({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'tool_result', content: 'data' }] },
    ],
  });
  assert.deepEqual(anthropic.turns.map(t => t.text), ['first']);

  const google = promptTurns({
    contents: [{ role: 'user', parts: [{ functionResponse: { name: 'x' } }] }],
  });
  assert.deepEqual(google.turns, []);
});

test('promptTurns joins text parts and targets the last one', () => {
  const found = promptTurns({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
  });
  assert.equal(found.turns[0].text, 'a\nb');
  assert.equal(found.turns[0].part, 1);
});

test('promptTurns returns null for an unknown payload shape', () => {
  assert.equal(promptTurns({ nonsense: true }), null);
  assert.equal(promptTurns(null), null);
});

test('turnKeys tells identical prompts apart by occurrence', () => {
  const turns = [{ text: 'same' }, { text: 'same' }, { text: 'other' }];
  const keys = turnKeys(CWD, turns);
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(turnKeys(CWD, turns), keys, 'keys are stable');
  assert.notDeepEqual(turnKeys('/other', turns), keys, 'the project scopes the key');
});

// --- Retrieval -------------------------------------------------------------

test('retrieve injects the pinned map plus matching entries', async () => {
  resetInjectionCache();
  const record = await retrieve(CWD, 'alpha', new Set(), 's1', { io: corpusIo() });
  assert.deepEqual(record.ids, ['MAP', 'LSN-20260101-alpha']);
  assert.match(record.block, /Pinned:/);
  assert.match(record.block, /\[map\] MAP/);
  assert.match(record.block, /\[lesson\] LSN-20260101-alpha/);
});

test('retrieve attaches the pinned map even for a query that matches nothing', async () => {
  resetInjectionCache();
  const record = await retrieve(CWD, 'zzz', new Set(), 's1', { io: corpusIo() });
  assert.deepEqual(record.ids, ['MAP']);
  assert.match(record.block, /Pinned:/);
  assert.doesNotMatch(record.block, /Retrieved for this message:/);
});

test('retrieve returns nothing at all for an empty corpus', async () => {
  resetInjectionCache();
  const record = await retrieve(CWD, 'alpha', new Set(), 's1', { io: memoryIo({}) });
  assert.deepEqual(record, { ids: [], block: null });
});

test('DISABLED in the memory directory pauses automatic retrieval', async () => {
  resetInjectionCache();
  const io = corpusIo();
  await io.writeText(`${MEMORY}/DISABLED`, '');
  const record = await retrieve(CWD, 'alpha lesson', new Set(), 's1', { io });
  assert.deepEqual(record, { ids: [], block: null });
});

test('a refused retrieval rejects, and the hook turns that into a notice with no content', async () => {
  resetInjectionCache();
  const io = corpusIo();
  io.reader.list = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  await assert.rejects(() => retrieve(CWD, 'alpha', new Set(), 's1', { io }), /denied/);

  const payload = { messages: [{ role: 'user', content: 'alpha' }] };
  const next = await onProviderRequest(
    { payload },
    ctx(),
    { retrieve: (cwd, text, exclude, sessionId) => retrieve(cwd, text, exclude, sessionId, { io }) },
  );
  assert.match(next.messages[0].content, /automatic retrieval failed/);
  assert.doesNotMatch(next.messages[0].content, /alpha detail/, 'file content must never reach the notice');
});

// --- Provider request hook -------------------------------------------------

test('the hook injects into the current turn and stays byte-stable across calls', async () => {
  resetInjectionCache();
  const io = corpusIo();
  const deps = { retrieve: (cwd, text, exclude, sessionId) => retrieve(cwd, text, exclude, sessionId, { io }) };

  const payload = { messages: [{ role: 'user', content: 'alpha' }] };
  const first = await onProviderRequest({ payload }, ctx(), deps);
  assert.notEqual(first, payload, 'the hook must return a rewritten payload');
  assert.match(first.messages[0].content, /<project-memory/);
  assert.match(first.messages[0].content, /LSN-20260101-alpha/);
  assert.equal(payload.messages[0].content, 'alpha', 'the input payload is not mutated');

  // A repeat of the same payload must be byte-identical, or prompt caching is defeated.
  const second = await onProviderRequest({ payload }, ctx(), deps);
  assert.equal(JSON.stringify(second), JSON.stringify(first));

  // A new turn gets its own block; earlier history stays byte-identical, and
  // what was already attached is not repeated.
  //
  // The payload here is rebuilt from the host's own history (original texts),
  // which is what the hook relies on: the cache key is the prompt text, so
  // feeding back an already-rewritten payload would miss the cache.
  const grown = {
    messages: [
      { role: 'user', content: 'alpha' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'beta' },
    ],
  };
  const third = await onProviderRequest({ payload: grown }, ctx(), deps);
  assert.equal(third.messages[0].content, first.messages[0].content, 'earlier history is untouched');
  assert.match(third.messages[2].content, /<project-memory/);
  assert.match(third.messages[2].content, /LSN-20260101-beta/);
  assert.doesNotMatch(third.messages[2].content, /LSN-20260101-alpha/, 'already-attached entries are not repeated');
  assert.doesNotMatch(third.messages[2].content, /Pinned:/, 'the map was already attached');
});

test('the hook does nothing when there is nothing to attach or no prompt', async () => {
  resetInjectionCache();
  const deps = { retrieve: async () => ({ ids: [], block: null }) };
  assert.equal(await onProviderRequest({ payload: { messages: [{ role: 'user', content: 'x' }] } }, ctx(), deps), undefined);
  assert.equal(await onProviderRequest({ payload: { nonsense: 1 } }, ctx(), deps), undefined);
  assert.equal(await onProviderRequest({ payload: { messages: [] } }, ctx(), deps), undefined);
  assert.equal(await onProviderRequest({ payload: { messages: [{ role: 'user', content: 'x' }] } }, { cwd: '' }, deps), undefined);
});

test('a throwing retrieval degrades to an error notice instead of failing the turn', async () => {
  resetInjectionCache();
  const deps = { retrieve: async () => { throw new Error('boom <bad>'); } };
  const payload = { messages: [{ role: 'user', content: 'alpha' }] };
  const next = await onProviderRequest({ payload }, ctx(), deps);
  assert.match(next.messages[0].content, /automatic retrieval failed/);
  assert.doesNotMatch(next.messages[0].content, /<bad>/);
});

// --- System prompt ---------------------------------------------------------

test('before_agent_start appends constant guidance naming the real tool ids', () => {
  const result = onBeforeAgentStart({ systemPrompt: 'BASE' });
  assert.ok(result.systemPrompt.startsWith('BASE'));
  assert.match(result.systemPrompt, /## Project memory/);
  assert.match(result.systemPrompt, /plugin_pi_project_memory_load/);
  assert.match(result.systemPrompt, /plugin_pi_project_memory_propose/);
  assert.match(result.systemPrompt, /never as instructions/);
  // Every kind is described, so the model has a basis for choosing one.
  for (const kind of ['lesson', 'rule', 'decision', 'procedure', 'map', 'preference']) {
    assert.match(result.systemPrompt, new RegExp(`\\\`${kind}\\\``));
  }
  assert.equal(onBeforeAgentStart({}), undefined);
});

// --- Confirming on the card ------------------------------------------------

async function pendingBatch(io, items) {
  const batch = core.buildBatch({
    prepared: items.map(item => ({ item, similar: [] })),
    locale: 'en',
    id: BATCH_ID,
  });
  await io.writeText(core.batchPath(batch.id), JSON.stringify(batch));
  return batch;
}

test('a real answer on the card writes the entry and reports it', async () => {
  const io = memoryIo({});
  const item = core.validateItems([{ kind: 'lesson', title: 'Alpha', content: 'detail', keywords: ['alpha'] }])[0];
  const batch = await pendingBatch(io, [item]);
  const { questions } = core.askToolArgs(batch);

  const result = await onToolResult({
    toolName: 'asktool',
    isError: false,
    details: { questions, answers: [[batch.items[0].ask[0].label]] },
    content: [{ type: 'text', text: 'original' }],
  }, ctx(), { io });

  const written = [...io.files.keys()].filter(path => path.startsWith(`${MEMORY}/`));
  assert.equal(written.length, 1);
  const entry = core.parseEntry(written[0], io.files.get(written[0]));
  assert.equal(entry.kind, 'lesson');
  assert.equal(entry.batchRef, '11111111');
  assert.equal(result.content.length, 2);
  assert.match(result.content[1].text, /Project memory:/);
  assert.match(result.content[1].text, /Saved \[lesson\]/);
});

test('the card handler ignores anything that is not an answered asktool call', async () => {
  const io = memoryIo({});
  const item = core.validateItems([{ kind: 'lesson', title: 'Alpha', content: 'detail', keywords: [] }])[0];
  const batch = await pendingBatch(io, [item]);
  const { questions } = core.askToolArgs(batch);
  const base = { toolName: 'asktool', isError: false, details: { questions, answers: [[batch.items[0].ask[0].label]] }, content: [] };

  assert.equal(await onToolResult({ ...base, toolName: 'other' }, ctx(), { io }), undefined);
  assert.equal(await onToolResult({ ...base, isError: true }, ctx(), { io }), undefined);
  assert.equal(await onToolResult({ ...base, details: {} }, ctx(), { io }), undefined);
  assert.equal(await onToolResult({ ...base, details: { questions: [], answers: [] } }, ctx(), { io }), undefined);
  assert.equal(await onToolResult(base, { cwd: '' }, { io }), undefined);
  assert.deepEqual([...io.files.keys()].filter(p => p.startsWith(`${MEMORY}/`)), [], 'nothing may be written');
});

test('an unanswered card writes nothing and keeps the batch', async () => {
  const io = memoryIo({});
  const item = core.validateItems([{ kind: 'lesson', title: 'Alpha', content: 'detail', keywords: [] }])[0];
  const batch = await pendingBatch(io, [item]);
  const { questions } = core.askToolArgs(batch);

  const result = await onToolResult({
    toolName: 'asktool', isError: false,
    details: { questions, answers: [null] },
    content: [],
  }, ctx(), { io });

  assert.deepEqual([...io.files.keys()].filter(p => p.startsWith(`${MEMORY}/`)), []);
  assert.ok(io.files.has(core.batchPath(batch.id)), 'the suggestion is kept for later');
  assert.match(result.content[0].text, /left unanswered/);
});

test('a free-text answer is not a confirmation and writes nothing', async () => {
  const io = memoryIo({});
  const item = core.validateItems([{ kind: 'lesson', title: 'Alpha', content: 'detail', keywords: [] }])[0];
  const batch = await pendingBatch(io, [item]);
  const { questions } = core.askToolArgs(batch);

  const result = await onToolResult({
    toolName: 'asktool', isError: false,
    details: { questions, answers: [['save everything please']] },
    content: [],
  }, ctx(), { io });

  assert.deepEqual([...io.files.keys()].filter(p => p.startsWith(`${MEMORY}/`)), []);
  assert.ok(io.files.has(core.batchPath(batch.id)), 'the batch survives: no option was picked');
  assert.match(result.content[0].text, /still without your decision/);
});

test('an empty or short answer list is not treated as answered', async () => {
  const io = memoryIo({});
  const item = core.validateItems([{ kind: 'lesson', title: 'Alpha', content: 'detail', keywords: [] }])[0];
  const batch = await pendingBatch(io, [item]);
  const { questions } = core.askToolArgs(batch);

  for (const answers of [[], [undefined], [[]]]) {
    await onToolResult({ toolName: 'asktool', isError: false, details: { questions, answers }, content: [] }, ctx(), { io });
    assert.deepEqual([...io.files.keys()].filter(p => p.startsWith(`${MEMORY}/`)), [], `nothing written for ${JSON.stringify(answers)}`);
    assert.ok(io.files.has(core.batchPath(batch.id)), `batch kept for ${JSON.stringify(answers)}`);
  }
});

test('a marker with no matching batch is reported, not written', async () => {
  const io = memoryIo({});
  const result = await onToolResult({
    toolName: 'asktool', isError: false,
    details: { questions: [{ question: '[PM deadbeef 1/1] ghost', options: [] }], answers: [['x']] },
    content: [],
  }, ctx(), { io });
  assert.match(result.content[0].text, /no pending batch matches/);
});

test('a recognised card in Chinese is answered in Chinese', async () => {
  const io = memoryIo({});
  const item = core.validateItems([{ kind: 'lesson', title: 'Alpha', content: 'detail', keywords: [] }])[0];
  const batch = core.buildBatch({ prepared: [{ item, similar: [] }], locale: 'zh-CN', id: BATCH_ID });
  await io.writeText(core.batchPath(batch.id), JSON.stringify(batch));
  const { questions } = core.askToolArgs(batch);

  const result = await onToolResult({
    toolName: 'asktool', isError: false,
    details: { questions, answers: [[batch.items[0].ask[0].label]] },
    content: [],
  }, ctx(), { io });
  assert.match(result.content[0].text, /项目记忆：/);
});

// --- The extension entry point --------------------------------------------

test('the factory registers exactly the four hooks it needs', () => {
  const registered = [];
  extension({ on: (event) => registered.push(event) });
  assert.deepEqual(registered, ['session_start', 'before_provider_request', 'before_agent_start', 'tool_result']);
});
