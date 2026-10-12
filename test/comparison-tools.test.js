'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../plugin/core/index.js');
const main = require('../plugin/main.js');
const extension = require('../plugin/extension.js');
const { memoryIo, mdFile, MEMORY } = require('./helpers.js');
const ctx = { sessionId: 'compare-tools', mode: 'agent' };
const substance = { kind: 'lesson', title: 'Build setup', content: 'Windows setup', keywords: ['build'] };
const decision = extra => ({ index: 0, action: 'create', targetId: null, reason: 'Verified project-specific setup', same: 'No existing equivalent', changes: 'Add Windows instructions', scope: 'This project on Windows', evidence: ['Build test passed'], ...extra });
function setup(initial = {}) {
  const io = memoryIo(initial);
  globalThis.pi = { workspace: { get: async () => ({ name: 'Project', path: '/project' }) },
    app: { getLocale: async () => 'en' }, plugin: { getSettings: async () => ({}) }, fs: {
      list: io.reader.list, readText: io.readText, writeText: io.writeText,
      stat: async path => { if (!await io.exists(path)) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' }); return { size: 0 }; }
    } };
  main._internals.setProjectIoFactory(() => io);
  return io;
}
test.after(() => { delete globalThis.pi; });

test('legacy propose call prepares bodies; reviewed propose alone creates a confirmation batch', async () => {
  const io = setup();
  const prepared = await main._internals.propose({ items: [substance] }, ctx);
  assert.equal(prepared.status, 'comparison-required'); assert.equal(prepared.asktool, undefined); assert.equal(io.files.size, 0);
  const proposed = await main._internals.propose({ reviewToken: prepared.reviewToken, decisions: [decision()] }, ctx);
  assert.equal(proposed.status, 'awaiting-user-answer');
  assert.match(proposed.asktool.questions[0].question, /Verified project-specific setup/);
  assert.equal(proposed.asktool.questions[0].options.length, 3);
  const batch = await core.readBatch(io, proposed.batchId, 'en'); assert.equal(batch.analysisState, 'analysed');
  assert.equal(batch.items[0].analysis.scope, 'This project on Windows');
  assert.equal([...io.files.keys()].filter(path => path.startsWith(MEMORY + '/')).length, 0);
  await assert.rejects(() => main._internals.propose({ reviewToken: prepared.reviewToken, decisions: [decision()] }, ctx), e => e.code === 'E_COMPARE_STALE');
});

test('one preparation receipt cannot stage two concurrent proposals', async () => {
  const io = setup();
  const p = await main._internals.prepare({ items: [substance] }, ctx);
  const results = await Promise.allSettled([0, 1].map(() => main._internals.propose({ reviewToken: p.reviewToken, decisions: [decision()] }, ctx)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'E_COMPARE_STALE');
  assert.equal([...io.files.keys()].filter(path => path.startsWith(core.INBOX_DIR + '/KB-') && path.endsWith('.json')).length, 1);
});

test('exact and semantic duplicate decisions finish without a card or corpus writes', async () => {
  const id = 'LSN-20260101-build';
  const io = setup({ [MEMORY + '/' + id + '.md']: mdFile(id, { title: 'Build setup', body: 'Windows setup', keywords: ['build'] }) });
  const exact = await main._internals.tools.prepare.execute({ action: 'prepare', items: [substance] }, ctx);
  assert.equal(exact.status, 'no-change'); assert.equal(io.files.size, 1);
  const p = await main._internals.tools.prepare.execute({ action: 'prepare', items: [{ ...substance, content: 'Same setup rephrased' }] }, ctx);
  const result = await main._internals.propose({ reviewToken: p.reviewToken, decisions: [decision({ action: 'duplicate', targetId: id, reason: 'The existing steps already cover this setup' })] }, ctx);
  assert.equal(result.status, 'no-change'); assert.equal(result.asktool, undefined); assert.equal([...io.files.keys()].filter(path=>path.startsWith(MEMORY+'/')).length, 1);
});

test('read-only modes expose declared actions with zero filesystem writes', async () => {
  const io = setup({ [MEMORY + '/LSN-20260101-build.md']: mdFile('LSN-20260101-build', { title: 'Build setup', body: 'Linux steps' }) });
  const before = io.snapshot();
  for (const mode of ['plan', 'goal']) {
    const context = { ...ctx, mode };
    await main._internals.tools.search.execute({ action: 'search', query: 'build' }, context);
    await main._internals.tools.load.execute({ action: 'load', id: 'LSN-20260101-build' }, context);
    await main._internals.tools.prepare.execute({ action: 'prepare', items: [substance] }, context);
    await assert.rejects(() => main._internals.tools.search.execute({ query: 'build' }, context), /read-only action/);
    await assert.rejects(() => main._internals.propose({ items: [substance] }, context), /Agent-only/);
  }
  assert.deepEqual(io.snapshot(), before);
  for (const name of ['search', 'load', 'prepare']) {
    const tool = main._internals.tools[name]; assert(tool.planSafeActions.length);
    assert(tool.planSafeActions.every(action => tool.schema.properties.action.enum.includes(action)));
  }
});

test('unanalysed imports cannot commit; pending prepares them in the active Agent session', async () => {
  const io = setup();
  const imported = await main.onPanelInvoke('memory.import', { markdown: 'Build setup\nWindows instructions' });
  const listed = await main.onPanelInvoke('inbox.list'); assert.equal(listed.batches[0].analysisState, 'unanalysed');
  await assert.rejects(() => main.onPanelInvoke('inbox.commit', { batchId: imported.batchId, reviewToken: listed.batches[0].reviewToken, selections: [{ index: 0, key: 'create' }] }), e => e.code === 'E_COMPARE_INCOMPLETE');
  const pending = await main._internals.tools.prepare.execute({ action: 'pending' }, ctx);
  assert.equal(pending.batches[0].batchId, imported.batchId);
  const p = await main._internals.tools.prepare.execute({ action: 'prepare', importBatchId: imported.batchId }, ctx);
  const proposed = await main._internals.propose({ reviewToken: p.reviewToken, decisions: [decision()] }, ctx);
  assert.equal(proposed.batchId, imported.batchId);
  const reviewed = (await main.onPanelInvoke('inbox.list')).batches[0]; assert.equal(reviewed.analysisState, 'analysed');
  const saved = await main.onPanelInvoke('inbox.commit', { batchId: reviewed.id, reviewToken: reviewed.reviewToken, selections: [{ index: 0, key: 'create' }] });
  assert.equal(saved.saved.length, 1);
});

test('partial pending batches retain landed identity and decisions while only remaining items are analysed', async () => {
  const io = setup();
  const items = core.validateItems([{ ...substance, title: 'Saved setup' }, { ...substance, title: 'Skipped setup', content: 'Skipped fact' }, { ...substance, title: 'Remaining setup', content: 'Remaining fact' }]);
  const batch = core.buildBatch({ locale: 'en', prepared: items.map(item => ({ item, similar: [] })) });
  const stale = structuredClone(batch);
  const first = await core.commitBatch(io, batch, [{ index: 0, key: 'create' }, { index: 1, key: 'skip' }], { expectedDigest: core.proposalDigest(batch) });
  stale.items[1].decided = 'skip'; // The savedAs write-back was lost, but the landed identity is recoverable.
  await io.writeText(core.batchPath(batch.id), JSON.stringify(stale));
  const before = io.snapshot();
  const p = await main._internals.prepare({ action: 'prepare', importBatchId: batch.id }, { ...ctx, mode: 'plan' });
  assert.deepEqual(io.snapshot(), before);
  assert.equal(p.items.length, 1); assert.equal(p.items[0].item.title, 'Remaining setup');
  const proposed = await main._internals.propose({ reviewToken: p.reviewToken, decisions: [decision()] }, ctx);
  const current = await core.readBatch(io, batch.id, 'en');
  assert.equal(current.items.length, 3);
  assert.equal(current.items[0].itemId, stale.items[0].itemId);
  assert.equal(current.items[0].savedAs, first.saved[0].id);
  assert.deepEqual(current.items[0].options, stale.items[0].options);
  assert.equal(current.items[1].decided, 'skip');
  assert.equal(current.items[2].itemId, stale.items[2].itemId);
  assert.equal(proposed.asktool.questions.length, 1);
  assert(proposed.asktool.questions[0].question.includes('3/3]'));
  const shown = (await main.onPanelInvoke('inbox.list')).batches[0];
  const saved = await main.onPanelInvoke('inbox.commit', { batchId: shown.id, reviewToken: shown.reviewToken, selections: [{ index: 2, key: 'create' }] });
  assert.equal(saved.saved.length, 1); assert.equal(saved.already.length, 1);
  assert.equal([...io.files.keys()].filter(path => path.startsWith(MEMORY + '/')).length, 2);
});

test('chat accepts the absolute item marker of a restored partial batch', async () => {
  const io = setup();
  const items = core.validateItems([{ ...substance, title: 'Handled setup' }, { ...substance, title: 'Pending setup', content: 'Other fact' }]);
  const batch = core.buildBatch({ locale: 'en', prepared: items.map(item => ({ item, similar: [] })) });
  await core.commitBatch(io, batch, [{ index: 0, key: 'skip' }], { expectedDigest: core.proposalDigest(batch) });
  const p = await main._internals.prepare({ importBatchId: batch.id }, ctx);
  const proposed = await main._internals.propose({ reviewToken: p.reviewToken, decisions: [decision()] }, ctx);
  const extContext = { cwd: '/project', sessionManager: { getSessionId: () => ctx.sessionId } };
  await extension._internals.onToolResult({ toolName: 'plugin_pi_project_memory_propose', details: proposed }, extContext, { io });
  const event = { toolName: 'asktool', toolCallId: 'partial-chat', input: proposed.asktool };
  assert.equal(await extension._internals.onToolCall(event, extContext, { io }), undefined);
  const report = await extension._internals.onToolResult({ ...event, details: { questions: proposed.asktool.questions, answers: [[proposed.asktool.questions[0].options[0]]] }, content: [] }, extContext, { io });
  assert.match(report.content[0].text, /saved/i);
  const entries = await core.loadCorpus(io.reader);
  assert.equal(entries.length, 1); assert.equal(entries[0].title, 'Pending setup');
});

test('restart loses analysis trust and edited candidates invalidate explicit redisplay', async () => {
  const source = MEMORY + '/LSN-20260101-build.md';
  const io = setup({ [source]: mdFile('LSN-20260101-build', { title: 'Build setup', body: 'Linux steps' }) });
  const p = await main._internals.prepare({ items: [substance] }, ctx);
  const result = await main._internals.propose({ reviewToken: p.reviewToken, decisions: [decision()] }, ctx);
  main._internals.setProjectIoFactory(() => io); // New process state cannot trust persisted analysis labels.
  let shown = (await main.onPanelInvoke('inbox.list')).batches[0];
  assert.equal(shown.analysisState, 'unanalysed');
  await assert.rejects(() => main.onPanelInvoke('inbox.commit', { batchId: shown.id, reviewToken: shown.reviewToken, selections: [{ index: 0, key: 'create' }] }), e => e.code === 'E_COMPARE_INCOMPLETE');
  const again = await main._internals.prepare({ importBatchId: result.batchId }, ctx);
  await main._internals.propose({ reviewToken: again.reviewToken, decisions: [decision()] }, ctx);
  await io.writeText(source, mdFile('LSN-20260101-build', { title: 'Build setup', body: 'changed' }));
  shown = (await main.onPanelInvoke('inbox.list')).batches[0];
  assert.equal(shown.analysisState, 'unanalysed');
  assert.equal(shown.items[0].analysis, undefined);
  assert.equal([...io.files.keys()].filter(path => path.startsWith(MEMORY + '/')).length, 1);
});

test('create approval also binds every compared candidate version', async () => {
  const source = MEMORY + '/LSN-20260101-build.md';
  const io = setup({ [source]: mdFile('LSN-20260101-build', { title: 'Build setup', body: 'Linux steps' }) });
  const p = await main._internals.prepare({ items: [substance] }, ctx);
  await main._internals.propose({ reviewToken: p.reviewToken, decisions: [decision()] }, ctx);
  const shown = (await main.onPanelInvoke('inbox.list')).batches[0];
  await io.writeText(source, mdFile('LSN-20260101-build', { title: 'Build setup', body: 'changed after approval display' }));
  await assert.rejects(() => main.onPanelInvoke('inbox.commit', { batchId: shown.id, reviewToken: shown.reviewToken, selections: [{ index: 0, key: 'create' }] }), e => e.code === 'E_TARGET_STALE');
  assert.equal([...io.files.keys()].filter(path => path.startsWith(MEMORY + '/')).length, 1);
});

test('panel supplies full version-bound comparison and edits require new analysis', async () => {
 const source=MEMORY+'/LSN-20260101-build.md'; const io=setup({[source]:mdFile('LSN-20260101-build',{title:'Build setup',body:'Linux original steps'})});
 const p=await main._internals.prepare({items:[substance]},ctx);
 const proposed=await main._internals.propose({reviewToken:p.reviewToken,decisions:[decision({action:'replace',targetId:'LSN-20260101-build'})]},ctx);
 assert.match(proposed.asktool.questions[0].question,/Linux original steps/);
 const shown=(await main.onPanelInvoke('inbox.list')).batches[0];
 assert.equal(shown.display[0].candidates[0].body,'Linux original steps');
 assert.equal(shown.display[0].analysis.changes,'Add Windows instructions');
 const revised=await main.onPanelInvoke('inbox.revise',{batchId:shown.id,reviewToken:shown.reviewToken,index:0,content:'Windows revised instructions',action:'conflict',targetId:'LSN-20260101-build'});
 assert.equal(revised.analysisState,'unanalysed');
 await assert.rejects(()=>main.onPanelInvoke('inbox.commit',{batchId:shown.id,reviewToken:shown.reviewToken,selections:[{index:0,key:'replace:LSN-20260101-build'}]}),e=>e.code==='E_APPROVAL_STALE');
 const current=await core.readBatch(io,shown.id,'en');assert.equal(current.items[0].content,'Windows revised instructions');assert.equal(current.items[0].analysis,undefined);
 const again=await main._internals.prepare({importBatchId:shown.id},ctx);assert.equal(again.items[0].requestedAction.action,'conflict');
 assert.equal([...io.files.keys()].filter(path=>path.startsWith(MEMORY+'/')).length,1);
});

test('pending proposals reuse a batch and rejection dedup allows evidence change or explicit re-review', async () => {
 const io=setup();
 async function proposeAgain(extra={},options={}){const p=await main._internals.prepare({items:[substance]},ctx);return main._internals.propose({reviewToken:p.reviewToken,decisions:[decision(extra)],...options},ctx);}
 const first=await proposeAgain();const same=await proposeAgain();
 assert.equal(same.status,'already-pending');assert.equal(same.batchId,first.batchId);assert.equal(same.asktool,undefined);
 const shown=(await main.onPanelInvoke('inbox.list')).batches[0];
 await main.onPanelInvoke('inbox.commit',{batchId:shown.id,reviewToken:shown.reviewToken,selections:[{index:0,key:'skip'}]});
 const rejected=await proposeAgain();assert.equal(rejected.status,'suppressed');assert.equal(rejected.asktool,undefined);
 const changed=await proposeAgain({evidence:['A second verified build']});assert.equal(changed.status,'awaiting-user-answer');
 const forced=await proposeAgain({}, {reReview:true});assert.equal(forced.status,'awaiting-user-answer');
 assert.equal([...io.files.keys()].filter(path=>path.startsWith(MEMORY+'/')).length,0);
});

test('semantic duplicate outcome is visible as agent analysis, not human approval',async()=>{
 const id='LSN-20260101-build';const io=setup({[MEMORY+'/'+id+'.md']:mdFile(id,{title:'Build setup',body:'Existing instructions'})});
 const p=await main._internals.prepare({items:[substance]},ctx);
 const result=await main._internals.propose({reviewToken:p.reviewToken,decisions:[decision({action:'duplicate',targetId:id})]},ctx);
 assert.equal(result.status,'no-change');
 await extension._internals.onToolResult({toolName:'plugin_pi_project_memory_propose',details:result},{cwd:'/project',sessionManager:{getSessionId:()=>ctx.sessionId}},{io});
 const shown=await main.onPanelInvoke('inbox.list');assert.equal(shown.history[0].status,'duplicate');assert.equal(shown.history[0].actor,'agent');
 assert.equal([...io.files.keys()].filter(path=>path.startsWith(MEMORY+'/')).length,1);
});

test('a user can explicitly mark a reviewed proposal duplicate without approving a write',async()=>{
 const id='LSN-20260101-build';const io=setup({[MEMORY+'/'+id+'.md']:mdFile(id,{title:'Build setup',body:'Linux instructions'})});
 const p=await main._internals.prepare({items:[substance]},ctx);await main._internals.propose({reviewToken:p.reviewToken,decisions:[decision()]},ctx);
 const shown=(await main.onPanelInvoke('inbox.list')).batches[0];
 const result=await main.onPanelInvoke('inbox.commit',{batchId:shown.id,reviewToken:shown.reviewToken,selections:[{index:0,key:'duplicate:'+id}]});
 assert.equal(result.duplicate,1);assert.equal(result.saved.length,0);assert.equal(result.pending,0);
 const history=(await main.onPanelInvoke('inbox.list')).history;assert.equal(history[0].actor,'user');assert.equal(history[0].status,'duplicate');
 assert.equal([...io.files.keys()].filter(path=>path.startsWith(MEMORY+'/')).length,1);
});

test('clearing optional metadata in a revision does not inherit the old values',async()=>{
 const io=setup();const p=await main._internals.prepare({items:[{...substance,origin:'old source',scope:'old scope'}]},ctx);
 await main._internals.propose({reviewToken:p.reviewToken,decisions:[decision()]},ctx);
 const shown=(await main.onPanelInvoke('inbox.list')).batches[0];
 await main.onPanelInvoke('inbox.revise',{batchId:shown.id,reviewToken:shown.reviewToken,index:0,content:'Revised substance',origin:'',scope:'',action:'create'});
 const revised=await core.readBatch(io,shown.id,'en');assert.equal(revised.items[0].origin,undefined);assert.equal(revised.items[0].scope,undefined);
 const prepared=await main._internals.prepare({importBatchId:shown.id},ctx);assert.equal(prepared.items[0].item.origin,undefined);assert.equal(prepared.items[0].item.scope,undefined);
});

test('a requested current target remains in preparation outside the display window',async()=>{
 const id='LSN-20260101-build';const io=setup({[MEMORY+'/'+id+'.md']:mdFile(id,{title:'Build setup',body:'Linux instructions'})});
 const p=await main._internals.prepare({items:[substance]},ctx);await main._internals.propose({reviewToken:p.reviewToken,decisions:[decision({action:'replace',targetId:id})]},ctx);
 for(let n=0;n<3;n++)await io.writeText(MEMORY+'/LSN-20260101-a'+n+'.md',mdFile('LSN-20260101-a'+n,{title:'Build setup',body:substance.content}));
 const shown=(await main.onPanelInvoke('inbox.list')).batches[0];
 assert(shown.display[0].alternatives.some(o=>o.key==='replace:'+id));
 await main.onPanelInvoke('inbox.revise',{batchId:shown.id,reviewToken:shown.reviewToken,index:0,content:'Revised Windows instructions',action:'replace',targetId:id});
 const again=await main._internals.prepare({importBatchId:shown.id},ctx);
 assert(again.items[0].candidates.some(c=>c.id===id));assert.equal(again.items[0].requestedAction.targetId,id);
});

test('changed target invalidates review and changed analysis invalidates approval', async () => {
  const source = MEMORY + '/LSN-20260101-build.md'; const io = setup({ [source]: mdFile('LSN-20260101-build', { title: 'Build setup', body: 'Linux steps' }) });
  const p = await main._internals.prepare({ action: 'prepare', items: [substance] }, ctx);
  await io.writeText(source, mdFile('LSN-20260101-build', { title: 'Build setup', body: 'edited' }));
  await assert.rejects(() => main._internals.propose({ reviewToken: p.reviewToken, decisions: [decision({ action: 'replace', targetId: 'LSN-20260101-build' })] }, ctx), e => e.code === 'E_COMPARE_STALE');
  const p2 = await main._internals.prepare({ action: 'prepare', items: [substance] }, ctx);
  const result = await main._internals.propose({ reviewToken: p2.reviewToken, decisions: [decision({ action: 'replace', targetId: 'LSN-20260101-build' })] }, ctx);
  const b = await core.readBatch(io, result.batchId, 'en'); const digest = result.proposalDigest; b.items[0].analysis.reason = 'altered';
  await assert.rejects(() => core.commitBatch(io, b, [{ index: 0, key: 'replace:LSN-20260101-build' }], { expectedDigest: digest }), e => e.code === 'E_APPROVAL_STALE');
});
