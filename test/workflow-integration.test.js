'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const core=require('../plugin/core/index.js'),main=require('../plugin/main.js'),extension=require('../plugin/extension.js'),tasks=require('../plugin/tasks.js');
const {createProjectFs}=require('../plugin/fs-guard.js');const {mdFile,MEMORY}=require('./helpers.js');
async function setup(t){
 const root=await fs.mkdtemp(path.join(process.env.PI_SCRATCH_DIR??os.tmpdir(),'pm-workflow-'));
 t.after(async()=>{delete globalThis.pi;extension._internals.resetTasks();await fs.rm(root,{recursive:true,force:true});});
 const io=createProjectFs(root,'main-fixture'),extIo=createProjectFs(root,'extension-fixture');
 globalThis.pi={workspace:{get:async()=>({path:root,name:'Integration'})},app:{getLocale:async()=> 'en'},plugin:{getSettings:async()=>({})},fs:{list:io.reader.list,readText:io.readText,writeText:io.writeText,stat:async p=>{if(!await io.exists(p))throw Object.assign(Error('missing'),{code:'NOT_FOUND'});return {};}}};
 main._internals.setProjectIoFactory(()=>io);extension._internals.resetTasks();
 const toolCtx={sessionId:'workflow-s6',mode:'agent'},ctx={cwd:root,sessionManager:{getSessionId:()=>toolCtx.sessionId}};
 async function call(name,input,mode='agent'){
  const result=await main._internals.tools[name].execute(input,{...toolCtx,mode});
  await extension._internals.onToolResult({toolName:'plugin_pi_project_memory_'+name,toolCallId:crypto.randomUUID(),input,details:result},ctx,{io:extIo});return result;
 }
 async function answer(proposed,index=0){
  const event={toolName:'asktool',toolCallId:crypto.randomUUID(),input:proposed.asktool};
  assert.equal(await extension._internals.onToolCall(event,ctx,{io:extIo}),undefined);
  return extension._internals.onToolResult({...event,details:{questions:proposed.asktool.questions,answers:[[proposed.asktool.questions[0].options[index]]]},content:[]},ctx,{io:extIo});
 }
 return {root,io,extIo,ctx,toolCtx,call,answer};
}
const crypto=require('node:crypto');
test('real-file legacy review, competing panel edits and restart require fresh analysis and approval',async t=>{
 const f=await setup(t),id='LSN-20260101-camera';await f.io.writeText(MEMORY+'/'+id+'.md',mdFile(id,{title:item.title,body:'Old camera guidance',keywords:item.keywords,extra:'created: 2026-01-01'}));
 const legacy=core.buildBatch({locale:'en',prepared:[{item:core.validateItems([item])[0],similar:await core.loadCorpus(f.io.reader)}]});delete legacy.revision;delete legacy.items[0].itemId;
 await f.io.writeText(core.batchPath(legacy.id),JSON.stringify(legacy));await f.call('task',{action:'begin',goal:'Review legacy camera guidance'});
 let shown=(await main.onPanelInvoke('inbox.list')).batches[0];assert.equal(shown.revision,2);assert.equal(shown.analysisState,'unanalysed');
 await assert.rejects(()=>main.onPanelInvoke('inbox.commit',{batchId:shown.id,reviewToken:shown.reviewToken,selections:[{index:0,key:'replace:'+id}]}),e=>e.code==='E_COMPARE_INCOMPLETE');
 let prepared=await f.call('prepare',{action:'prepare',importBatchId:legacy.id});let proposed=await f.call('propose',{reviewToken:prepared.reviewToken,decisions:[decision({action:'replace',targetId:id})]});
 shown=(await main.onPanelInvoke('inbox.list')).batches[0];const loaded=await main.onPanelInvoke('memory.get',{id});
 const edits=await Promise.allSettled(['first editor','second editor'].map(body=>main.onPanelInvoke('memory.update',{id,baseHash:loaded.baseHash,patch:{body}})));
 assert.equal(edits.filter(r=>r.status==='fulfilled').length,1);assert.match(edits.find(r=>r.status==='rejected').reason.message,/changed on disk/);
 const winner=(await core.loadCorpus(f.io.reader))[0].body;assert(['first editor','second editor'].includes(winner));
 await assert.rejects(()=>main.onPanelInvoke('inbox.commit',{batchId:shown.id,reviewToken:shown.reviewToken,selections:[{index:0,key:'replace:'+id}]}),e=>e.code==='E_TARGET_STALE');assert.equal((await core.loadCorpus(f.io.reader))[0].body,winner);
 main._internals.setProjectIoFactory(()=>f.io);extension._internals.resetTasks();
 await assert.rejects(()=>main.onPanelInvoke('inbox.commit',{batchId:shown.id,reviewToken:shown.reviewToken,selections:[{index:0,key:'replace:'+id}]}),e=>e.code==='E_APPROVAL_STALE');
 shown=(await main.onPanelInvoke('inbox.list')).batches[0];assert.equal(shown.analysisState,'unanalysed');
 prepared=await f.call('prepare',{action:'prepare',importBatchId:legacy.id});assert.equal(prepared.items[0].candidates[0].body,winner);
 proposed=await f.call('propose',{reviewToken:prepared.reviewToken,decisions:[decision({action:'replace',targetId:id})]});await f.answer(proposed);
 const corpus=await core.loadCorpus(f.io.reader);assert.equal(corpus.length,2);assert.equal(corpus.filter(core.isActive).length,1);assert.equal(corpus.find(e=>e.id===id).body,winner);assert.equal(corpus.find(core.isActive).body,item.content);
});
test('real chat rejection updates advisory user history and suppresses only matching reviewed proposals',async t=>{
 const f=await setup(t);await f.call('task',{action:'begin',goal:'Assess camera knowledge'});
 async function propose(extra={}){const p=await f.call('prepare',{action:'prepare',items:[item]});return f.call('propose',{reviewToken:p.reviewToken,decisions:[decision(extra)]});}
 const first=await propose();const reject=first.asktool.questions[0].options.findIndex(o=>/do not save/i.test(label(o)));assert(reject>=0);await f.answer(first,reject);
 const history=(await main.onPanelInvoke('inbox.list')).history;assert.equal(history[0].status,'rejected');assert.equal(history[0].actor,'user');
 const suppressed=await propose();assert.equal(suppressed.status,'suppressed');assert.equal(suppressed.asktool,undefined);assert.equal((await core.loadCorpus(f.io.reader)).length,0);
 const changed=await propose({evidence:['An additional current validation result']});assert.equal(changed.status,'awaiting-user-answer');
 const shown=(await main.onPanelInvoke('inbox.list')).batches.find(b=>b.id===changed.batchId);await main.onPanelInvoke('inbox.commit',{batchId:shown.id,reviewToken:shown.reviewToken,selections:[{index:0,key:'create'}]});assert.equal((await core.loadCorpus(f.io.reader)).length,1);
 const status=await f.call('task',{action:'status'});assert.deepEqual(status.task.pending,[]);
});
test('real-file import stays unapproved, chat defer is resumable, and panel saves its independent identity',async t=>{
 const f=await setup(t);await f.call('task',{action:'begin',goal:'Import camera instructions'});
 const imported=await main.onPanelInvoke('memory.import',{markdown:mdFile('LSN-20260101-origin',{title:item.title,body:item.content,keywords:item.keywords,extra:'created: 2026-01-01\nrelated: [LSN-20260101-foreign]'})});
 let shown=(await main.onPanelInvoke('inbox.list')).batches[0];assert.equal(shown.analysisState,'unanalysed');
 await assert.rejects(()=>main.onPanelInvoke('inbox.commit',{batchId:shown.id,reviewToken:shown.reviewToken,selections:[{index:0,key:'create'}]}),e=>e.code==='E_COMPARE_INCOMPLETE');assert.equal((await core.loadCorpus(f.io.reader)).length,0);
 const prepared=await f.call('prepare',{action:'prepare',importBatchId:imported.batchId});const proposed=await f.call('propose',{reviewToken:prepared.reviewToken,decisions:[decision()]});
 const defer=proposed.asktool.questions[0].options.findIndex(o=>/defer/i.test(label(o)));assert(defer>=0);await f.answer(proposed,defer);
 shown=(await main.onPanelInvoke('inbox.list')).batches[0];assert.equal(core.reviewStateOf(shown.items[0]),'deferred');assert.equal(core.undecidedCount(shown),1);
 let status=await f.call('task',{action:'status'});assert.deepEqual(status.task.pending,[imported.batchId]);
 const saved=await main.onPanelInvoke('inbox.commit',{batchId:shown.id,reviewToken:shown.reviewToken,selections:[{index:0,key:'create'}]});assert.equal(saved.saved.length,1);
 const entry=(await core.loadCorpus(f.io.reader))[0];assert.notEqual(entry.id,'LSN-20260101-origin');assert.deepEqual(entry.related,[]);assert.notEqual(entry.created,'2026-01-01');assert.equal(entry.body,item.content);
 status=await f.call('task',{action:'status'});assert.deepEqual(status.task.pending,[]);
});
const item={kind:'lesson',title:'Camera shutdown',content:'Windows camera closes on the acquisition owner thread.',keywords:['camera','shutdown']};
const label=value=>typeof value==='string'?value:value.label;
const decision=extra=>({index:0,action:'create',targetId:null,reason:'Verified applicable owner-thread rule',same:'Existing camera guidance has a different platform',changes:'Document the Windows condition',scope:'Windows acquisition',evidence:['Owner-thread integration fixture'],...extra});
async function snapshot(root){
 const result={};async function walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else result[path.relative(root,file)]=await fs.readFile(file,'utf8');}}await walk(root);return result;
}
test('real confined files connect old corpus, current-agent comparison, genuine chat approval and task recovery',async t=>{
 const f=await setup(t),id='LSN-20260101-camera',source=MEMORY+'/'+id+'.md';
 const old=mdFile(id,{title:item.title,body:'Linux camera uses the lifecycle callback.',keywords:['camera','shutdown'],extra:'created: 2026-01-01'});
 await f.io.writeText(source,old);await f.io.writeText(MEMORY+'/MAP.md',mdFile('MAP',{kind:'map',title:'Camera map',body:'Acquisition owns the camera lifecycle.'}));
 const entries=await core.loadCorpus(f.io.reader);assert.equal(entries.find(e=>e.id===id).updated,'');assert.equal(core.cardOf(entries.find(e=>e.id===id)).updated,'2026-01-01');
 await f.call('task',{action:'begin',goal:'Validate Windows camera shutdown'});
 const original={messages:[{role:'user',content:'Validate Windows camera shutdown'}]};
 const supplied=await extension._internals.onProviderRequest({payload:original},f.ctx,{io:f.extIo});assert(JSON.stringify(supplied).includes('Linux camera uses'));
 const prepared=await f.call('prepare',{action:'prepare',items:[item]});assert.equal(prepared.items[0].candidates[0].body,'Linux camera uses the lifecycle callback.');assert.equal(prepared.items[0].candidates[0].versionComplete,true);
 const proposed=await f.call('propose',{reviewToken:prepared.reviewToken,decisions:[decision({action:'conflict',targetId:id})]});
 assert.equal(await f.io.readText(source),old);assert.equal((await core.loadCorpus(f.io.reader)).length,2);
 let status=await f.call('task',{action:'status'});assert.deepEqual(status.task.pending,[proposed.batchId]);assert.equal(status.task.state,'awaiting-approval');
 const report=await f.answer(proposed);assert.match(report.content[0].text,/saved/i);
 const corpus=await core.loadCorpus(f.io.reader),added=corpus.find(e=>e.body===item.content);assert(added);assert(added.related.includes(id));assert(corpus.find(e=>e.id===id).related.includes(added.id));assert.equal(corpus.filter(core.isActive).length,3);
 status=await f.call('task',{action:'status'});assert.deepEqual(status.task.pending,[]);assert.equal(status.task.state,'active');
 await f.call('task',{action:'checkpoint',phase:'validation',result:'covered',reason:'Approved camera rule is now available'});
 await extension._internals.onLifecycle({type:'session_before_compact'},f.ctx,{io:f.extIo});await extension._internals.onLifecycle({type:'session_compact'},f.ctx,{io:f.extIo});
 const recovered=await extension._internals.onProviderRequest({payload:{messages:[{role:'assistant',content:'Compacted camera summary'}]}},f.ctx,{io:f.extIo});assert(JSON.stringify(recovered).includes(item.content));
 status=await f.call('task',{action:'status'});assert.equal(status.task.recovery.result,'restored');assert.equal(status.task.usedClaimed.length,0);
 await f.call('task',{action:'finish',result:'covered',reason:'Approved guidance covers the reusable knowledge'});
 const before=await snapshot(f.root);
 for(const mode of ['plan','goal']){await f.call('search',{action:'search',query:'camera'},mode);await f.call('load',{action:'load',id:added.id},mode);await f.call('prepare',{action:'pending'},mode);await f.call('task',{action:'status'},mode);}
 assert.deepEqual(await snapshot(f.root),before);
 extension._internals.resetTasks();assert.equal((await main.onPanelInvoke('task.status')).tasks[0].state,'completed');
 const writers=await f.io.reader.list('.workflow/memory-inbox/.writers');assert.equal(writers.length,0);
});
