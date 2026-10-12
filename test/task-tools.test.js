'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const main=require('../plugin/main.js');const extension=require('../plugin/extension.js');const tasks=require('../plugin/tasks.js');
const {memoryIo,mdFile,MEMORY}=require('./helpers.js');const context={sessionId:'task-tools',mode:'agent'};const ctx={cwd:'/task-tools',sessionManager:{getSessionId:()=>context.sessionId}};
function setup(){const io=memoryIo({[MEMORY+'/LSN-20260101-build.md']:mdFile('LSN-20260101-build',{title:'Build',body:'Build steps'})});globalThis.pi={workspace:{get:async()=>({path:'/task-tools',name:'Tasks'})},app:{getLocale:async()=> 'en'},plugin:{getSettings:async()=>({})},fs:{list:io.reader.list,readText:io.readText,writeText:io.writeText,stat:async p=>{if(!await io.exists(p))throw Object.assign(Error('missing'),{code:'NOT_FOUND'});return {};}}};main._internals.setProjectIoFactory(()=>io);extension._internals.resetTasks();return io;}
test.after(()=>delete globalThis.pi);
test('read-only diagnostics reconcile current and historical pending references after panel decisions',async()=>{
 const io=setup(),core=require('../plugin/core/index.js');
 const ids=['KB-11111111-2222-3333-4444-555555555555','KB-22222222-2222-3333-4444-555555555555'];
 for(const [n,id] of ids.entries()){
  const item=core.validateItems([{kind:'lesson',title:'Pending '+n,content:'Body '+n,keywords:[]}])[0];
  const batch=core.buildBatch({prepared:[{item,similar:[]}],locale:'en',id});
  await io.writeText(core.batchPath(id),JSON.stringify(batch));
 }
 await tasks.updateTask(io,context.sessionId,{action:'begin',goal:'Earlier task'});
 await tasks.updateTask(io,context.sessionId,{action:'proposal',pending:[ids[0]]});
 await tasks.updateTask(io,context.sessionId,{action:'begin',goal:'Current task'});
 await tasks.updateTask(io,context.sessionId,{action:'proposal',pending:[ids[1]]});
 await tasks.updateTask(io,'other-session',{action:'begin',goal:'Unrelated task'});
 let before=io.snapshot(),status=await main.onPanelInvoke('task.status');assert.deepEqual(io.snapshot(),before);
 assert.deepEqual(status.tasks.find(t=>t.goal==='Unrelated task').pending,[]);
 const displayed=await main.onPanelInvoke('inbox.list');
 for(const id of ids){const batch=displayed.batches.find(b=>b.id===id);await main.onPanelInvoke('inbox.discard',{batchId:id,reviewToken:batch.reviewToken});}
 extension._internals.resetTasks();before=io.snapshot();status=await main.onPanelInvoke('task.status');
 assert.deepEqual(io.snapshot(),before);assert(status.tasks.every(t=>t.pending.length===0));
 assert.equal(status.tasks.find(t=>t.goal==='Earlier task').state,'paused');
 assert.equal(status.tasks.find(t=>t.goal==='Current task').state,'active');
 const toolStatus=await main._internals.tools.task.execute({action:'status'},{...context,mode:'plan'});
 assert.deepEqual(toolStatus.task.pending,[]);assert.deepEqual(io.snapshot(),before);
 await extension._internals.onProviderRequest({payload:{messages:[{role:'user',content:'继续'}]}},ctx,{io});
 const persisted=await tasks.readTasks(io);assert(persisted.tasks.every(t=>t.pending.length===0));
 assert.equal(tasks.currentTask(persisted,context.sessionId).goal,'Current task');
});
async function deliver(result,input,io){await extension._internals.onToolResult({toolName:'plugin_pi_project_memory_task',input,details:result},ctx,{io});}
test('Plan and Goal read-only memory results never persist task observations',async()=>{
 const io=setup();const input={action:'begin',goal:'Read only checks'};await deliver(await main._internals.tools.task.execute(input,context),input,io);
 for(const mode of ['plan','goal']){
  const before=io.snapshot();
  for(const [name,args] of [['load',{action:'load',id:'LSN-20260101-build'}],['search',{action:'search',query:'build'}],['prepare',{action:'prepare',items:[{kind:'lesson',title:'Build',content:'new steps',keywords:['build']}]}],['task',{action:'status'}]]){
   const result=await main._internals.tools[name].execute(args,{...context,mode});
   await extension._internals.onToolResult({toolName:'plugin_pi_project_memory_'+name,input:args,details:result},ctx,{io});
  }
  assert.deepEqual(io.snapshot(),before);
 }
});

test('explicit task actions persist only through genuine tool results; status stays read-only',async()=>{
 const io=setup();const before=io.snapshot();const begin={action:'begin',goal:'Validate build'};
 const result=await main._internals.tools.task.execute(begin,context);assert.deepEqual(io.snapshot(),before);
 await deliver(result,begin,io);let stored=tasks.currentTask(await tasks.readTasks(io),context.sessionId);assert.equal(stored.boundary,'explicit');assert.equal(stored.goal,'Validate build');
 const load=await main._internals.tools.load.execute({action:'load',id:'LSN-20260101-build'},context);
 await extension._internals.onToolResult({toolName:'plugin_pi_project_memory_load',input:{action:'load',id:'LSN-20260101-build'},details:load},ctx,{io});
 stored=tasks.currentTask(await tasks.readTasks(io),context.sessionId);assert(stored.provided.some(v=>v.complete&&v.via==='load'));assert.equal(stored.usedClaimed.length,0);
 const finish={action:'finish',result:'covered',reason:'Existing build entry covers this knowledge'};
 await deliver(await main._internals.tools.task.execute(finish,context),finish,io);
 stored=tasks.currentTask(await tasks.readTasks(io),context.sessionId);assert.equal(stored.state,'completed');
 const snapshot=io.snapshot();for(const mode of ['plan','goal']){await main._internals.tools.task.execute({action:'status'},{...context,mode});await assert.rejects(()=>main._internals.tools.task.execute(begin,{...context,mode}),/Agent-only/);}assert.deepEqual(io.snapshot(),snapshot);
 const status=await main.onPanelInvoke('task.status');assert.equal(status.tasks[0].check.result,'covered');
});
