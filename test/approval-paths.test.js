'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const core=require('../plugin/core/index.js');const main=require('../plugin/main.js');const extension=require('../plugin/extension.js');
const {memoryIo,mdFile,MEMORY}=require('./helpers.js');
const {reviewBatch}=require('../plugin/approval.js');
const ID='KB-11111111-2222-3333-4444-555555555555';
const ctx={cwd:'/project',sessionManager:{getSessionId:()=> 'approval-test'}};
const make=()=>core.buildBatch({id:ID,locale:'en',prepared:[{item:core.validateItems([{kind:'lesson',title:'Alpha',content:'new fact',keywords:['alpha']}])[0],similar:[]}]});
const setup=async()=>{const io=memoryIo();const batch=make();await io.writeText(core.batchPath(ID),JSON.stringify(batch));await extension._internals.onToolResult({toolName:'plugin_pi_project_memory_propose',details:{status:'awaiting-user-answer',batchId:batch.id,proposalDigest:core.proposalDigest(batch)}},ctx,{io});return {io,batch};};
const memoryFiles=io=>[...io.files.keys()].filter(p=>p.startsWith(MEMORY+'/'));
const piFor=io=>{globalThis.pi={workspace:{get:async()=>({name:'Project',path:'/project'})},app:{getLocale:async()=> 'en'}};main._internals.setProjectIoFactory(()=>io);};
test.after(()=>delete globalThis.pi);
test('chat refuses an answer without a remembered real tool call',async()=>{
 const {io,batch}=await setup();const questions=core.askToolArgs(batch).questions;
 const result=await extension._internals.onToolResult({toolName:'asktool',toolCallId:'missing',details:{questions,answers:[[batch.items[0].ask[0].label]]},content:[]},ctx,{io});
 assert.match(result.content[0].text,/approval is stale/);assert.equal(memoryFiles(io).length,0);
});
test('chat approval cannot commit a proposal changed after tool_call',async()=>{
 const {io,batch}=await setup();const questions=core.askToolArgs(batch).questions;const event={toolName:'asktool',toolCallId:'changed',input:{questions}};
 assert.equal(await extension._internals.onToolCall(event,ctx,{io}),undefined);
 batch.items[0].content='tampered after display';await io.writeText(core.batchPath(ID),JSON.stringify(batch));
 const result=await extension._internals.onToolResult({...event,details:{questions,answers:[[batch.items[0].ask[0].label]]},content:[]},ctx,{io});
 assert.match(result.content[0].text,/approval is stale/);assert.equal(memoryFiles(io).length,0);
});
test('chat blocks a revised question or truncated-version marker before showing it',async()=>{
 const {io,batch}=await setup();const questions=core.askToolArgs(batch).questions;questions[0].question+='changed';
 const result=await extension._internals.onToolCall({toolName:'asktool',toolCallId:'bad',input:{questions}},ctx,{io});
 assert.equal(result.block,true);assert.equal(memoryFiles(io).length,0);
});
test('panel tokens reject changed proposals, cross-project use, and restart loss',async()=>{
 const {io,batch}=await setup();piFor(io);let shown=(await main.onPanelInvoke('inbox.list')).batches[0];
 batch.items[0].content='changed';await io.writeText(core.batchPath(ID),JSON.stringify(batch));
 await assert.rejects(()=>main.onPanelInvoke('inbox.commit',{batchId:ID,reviewToken:shown.reviewToken,selections:[{index:0,key:'create'}]}),e=>e.code==='E_APPROVAL_STALE');
 shown=(await main.onPanelInvoke('inbox.list')).batches[0];globalThis.pi.workspace.get=async()=>({name:'Other',path:'/other'});
 await assert.rejects(()=>main.onPanelInvoke('inbox.commit',{batchId:ID,reviewToken:shown.reviewToken,selections:[{index:0,key:'create'}]}),e=>e.code==='E_APPROVAL_STALE');
 globalThis.pi.workspace.get=async()=>({name:'Project',path:'/project'});main._internals.setProjectIoFactory(()=>io);
 await assert.rejects(()=>main.onPanelInvoke('inbox.commit',{batchId:ID,reviewToken:shown.reviewToken,selections:[{index:0,key:'create'}]}),e=>e.code==='E_APPROVAL_STALE');
 assert.equal(memoryFiles(io).length,0);
});
test('legacy batch is upgraded only on review and preserves landed entries',async()=>{
 const {io,batch}=await setup();delete batch.revision;delete batch.items[0].itemId;
 io.files.set(MEMORY+'/LSN-20260101-landed.md',mdFile('LSN-20260101-landed',{title:'Alpha',body:'already saved',extra:'batchRef: 11111111'}));
 const reviewed=await reviewBatch(io,batch);assert.equal(reviewed.revision,2);assert.equal(reviewed.items[0].savedAs,'LSN-20260101-landed');
 const result=await core.commitBatch(io,reviewed,[],{expectedDigest:core.proposalDigest(reviewed)});assert.equal(result.saved.length,0);assert.equal(result.already.length,1);assert.equal(memoryFiles(io).length,1);
});
test('editor snapshot refuses content changed while editing',async()=>{
 const {io}=await setup();const source=MEMORY+'/LSN-20260101-alpha.md';await io.writeText(source,mdFile('LSN-20260101-alpha',{title:'Alpha',body:'old'}));piFor(io);
 const loaded=await main.onPanelInvoke('memory.get',{id:'LSN-20260101-alpha'});await io.writeText(source,mdFile('LSN-20260101-alpha',{title:'Alpha',body:'new from other writer'}));
 await assert.rejects(()=>main.onPanelInvoke('memory.update',{id:loaded.card.id,patch:{body:'user draft'},baseHash:loaded.baseHash}),/changed on disk/);
 assert.match(await io.readText(source),/new from other writer/);
});

test('review recovers revision2 items when inbox write-back was lost',async()=>{
 const {io,batch}=await setup();const stale=structuredClone(batch);
 const first=await core.commitBatch(io,batch,[{index:0,key:'create'}],{expectedDigest:core.proposalDigest(batch)});
 const reviewed=await reviewBatch(io,stale);assert.equal(reviewed.items[0].savedAs,first.saved[0].id);
});
test('view list supplies a version and stale delete leaves the edited file intact',async()=>{
 const {io}=await setup();const source=MEMORY+'/LSN-20260101-alpha.md';await io.writeText(source,mdFile('LSN-20260101-alpha',{title:'Alpha',body:'old'}));piFor(io);
 const card=(await main.onPanelInvoke('memory.list')).cards[0];assert.match(card.baseHash,/^[0-9a-f]{64}$/);
 await io.writeText(source,mdFile('LSN-20260101-alpha',{title:'Alpha',body:'new from other writer'}));
 await assert.rejects(()=>main.onPanelInvoke('memory.delete',{id:card.id,baseHash:card.baseHash}),/changed on disk/);assert.equal(await io.exists(source),true);
});

test('a batch rewritten before display cannot replace the real propose result',async()=>{
 const {io,batch}=await setup();batch.items[0].content='rewritten before asktool';await io.writeText(core.batchPath(ID),JSON.stringify(batch));
 const result=await extension._internals.onToolCall({toolName:'asktool',toolCallId:'pre-display-change',input:core.askToolArgs(batch)},ctx,{io});
 assert.equal(result.block,true);assert.equal(memoryFiles(io).length,0);
});
