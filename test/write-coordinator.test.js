'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fsp=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createProjectFs}=require('../plugin/fs-guard.js');
const coordinator=require('../plugin/write-coordinator.js');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function project(t){const root=await fsp.mkdtemp(path.join(os.tmpdir(),'pm-lock-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));return root;}
test('exclusive create has one winner and never overwrites existing content',async t=>{
 const io=createProjectFs(await project(t),'exclusive');
 const results=await Promise.allSettled([io.createExclusive('.workflow/memory-inbox/a.json','first'),io.createExclusive('.workflow/memory-inbox/a.json','second')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'EEXIST');
});
test('independent writers serialize complete read-modify-write operations',async t=>{
 const root=await project(t); const io=createProjectFs(root,'init');await io.writeText('.workflow/memory-inbox/counter.json','0');
 await Promise.all(Array.from({length:8},(_,n)=>coordinator.withProjectWrite(createProjectFs(root,'s'+n),async locked=>{
  const old=Number(await locked.readText('.workflow/memory-inbox/counter.json'));await wait(8);await locked.writeText('.workflow/memory-inbox/counter.json',String(old+1));
 })));
 assert.equal(await io.readText('.workflow/memory-inbox/counter.json'),'8');
});
test('timeouts and cancellation do not steal a live writer ticket',async t=>{
 const root=await project(t);let release;let ready;const started=new Promise(r=>ready=r);
 const holder=coordinator.withProjectWrite(createProjectFs(root,'holder'),async()=>{ready();await new Promise(r=>release=r);});await started;
 await assert.rejects(()=>coordinator.withProjectWrite(createProjectFs(root,'timeout'),async()=>assert.fail('stole lock'),{timeoutMs:40}),e=>e.code==='E_LOCK_TIMEOUT');
 const abort=new AbortController();const waiting=coordinator.withProjectWrite(createProjectFs(root,'abort'),async()=>assert.fail('stole lock'),{signal:abort.signal});abort.abort();
 await assert.rejects(()=>waiting,e=>e.code==='ABORT_ERR');release();await holder;
 await coordinator.withProjectWrite(createProjectFs(root,'after'),async()=>{});
});

const {fork}=require('node:child_process');
const worker=path.join(__dirname,'..','test-support','write-worker.cjs');
const exited=child=>new Promise((resolve,reject)=>{let stderr='';child.stderr?.on('data',data=>{stderr+=data});child.on('error',reject);child.on('exit',(code,signal)=>code===0||signal?resolve():reject(new Error('worker exit '+code+': '+stderr)));});
test('actual child processes serialize shared updates',async t=>{
 const root=await project(t);const io=createProjectFs(root,'parent');await io.writeText('.workflow/memory-inbox/counter.json','0');
 const children=Array.from({length:5},()=>fork(worker,[root,'update'],{stdio:['ignore','ignore','pipe','ipc']}));
 await Promise.all(children.map(exited));assert.equal(await io.readText('.workflow/memory-inbox/counter.json'),'5');
});
test('a terminated child writer is recovered without an age-based takeover',async t=>{
 const root=await project(t);const child=fork(worker,[root,'hold'],{stdio:['ignore','ignore','pipe','ipc']});
 const ready=new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);});await ready;
 const stopped=exited(child);child.kill();await stopped;
 const io=createProjectFs(root,'parent');await coordinator.withProjectWrite(io,async()=>{await io.writeText('.workflow/memory-inbox/recovered.json','yes');});
 assert.equal(await io.readText('.workflow/memory-inbox/recovered.json'),'yes');
});

const core=require('../plugin/core/index.js');
const commitChild=(root,b,key)=>new Promise((resolve,reject)=>{
 const child=fork(worker,[root,'commit',b.id,core.proposalDigest(b),key],{stdio:['ignore','ignore','pipe','ipc']});let result;
 child.on('message',message=>{result=message});child.on('error',reject);child.on('exit',code=>code===0&&result?resolve(result):reject(new Error('commit worker exit '+code)));
});
const makeBatch=(id,entries,content='new fact')=>core.buildBatch({id,locale:'en',prepared:[{item:core.validateItems([{kind:'lesson',title:'Alpha',content,keywords:['alpha']}])[0],similar:entries}]});
test('two child commits of one batch publish exactly one entry',async t=>{
 const root=await project(t);const io=createProjectFs(root,'parent');const b=makeBatch('KB-11111111-2222-3333-4444-555555555555',[]);await io.writeText(core.batchPath(b.id),JSON.stringify(b));
 const outcomes=await Promise.all([commitChild(root,b,'create'),commitChild(root,b,'create')]);
 assert.equal(outcomes.filter(r=>r.saved===1).length,1);assert.equal((await core.loadCorpus(io.reader)).length,1);
});
test('two child replacements of one target preserve the winning version',async t=>{
 const root=await project(t);const io=createProjectFs(root,'parent');const source='.workflow/memory/LSN-20260101-old.md';
 await io.writeText(source,core.renderEntry({id:'LSN-20260101-old',kind:'lesson',title:'Alpha',content:'old',keywords:['alpha'],created:'2026-01-01'}));
 const entries=await core.loadCorpus(io.reader);const a=makeBatch('KB-11111111-2222-3333-4444-555555555555',entries,'first');const b=makeBatch('KB-22222222-2222-3333-4444-555555555555',entries,'second');
 await io.writeText(core.batchPath(a.id),JSON.stringify(a));await io.writeText(core.batchPath(b.id),JSON.stringify(b));
 const results=await Promise.all([commitChild(root,a,'replace:LSN-20260101-old'),commitChild(root,b,'replace:LSN-20260101-old')]);
 assert.equal(results.filter(r=>r.saved===1).length,1);const corpus=await core.loadCorpus(io.reader);assert.equal(corpus.length,2);assert.equal(corpus.filter(core.isActive).length,1);
});
