'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const core=require('../plugin/core/index.js');const {memoryIo,mdFile,MEMORY}=require('./helpers.js');
const ID='KB-11111111-2222-3333-4444-555555555555';
const make=entries=>core.buildBatch({id:ID,locale:'en',prepared:[{item:core.validateItems([{kind:'lesson',title:'Alpha',content:'new',keywords:['alpha']}])[0],similar:entries}]});
test('approval binds full proposal content beyond the displayed excerpt',async()=>{
 const io=memoryIo();const b=make([]);const expectedDigest=core.proposalDigest(b);b.items[0].content='changed';
 await assert.rejects(()=>core.commitBatch(io,b,[{index:0,key:'create'}],{expectedDigest}),e=>e.code==='E_APPROVAL_STALE');assert.deepEqual(io.snapshot(),{});
});
test('target content changes invalidate a previously displayed replacement',async()=>{
 const source=MEMORY+'/LSN-20260101-old.md';const io=memoryIo({[source]:mdFile('LSN-20260101-old',{title:'Alpha',body:'old'})});
 const b=make(await core.loadCorpus(io.reader));const expectedDigest=core.proposalDigest(b);io.files.set(source,mdFile('LSN-20260101-old',{title:'Alpha',body:'user edited'}));
 await assert.rejects(()=>core.commitBatch(io,b,[{index:0,key:'replace:LSN-20260101-old'}],{expectedDigest}),e=>e.code==='E_TARGET_STALE');assert.equal(io.files.size,1);
});
test('stable item identity recovers a landed entry after its title changes',async()=>{
 const io=memoryIo();const b=make([]);const stale=structuredClone(b);const expectedDigest=core.proposalDigest(b);
 const first=await core.commitBatch(io,b,[{index:0,key:'create'}],{expectedDigest});const source=first.saved[0].source;
 io.files.set(source,core.setFrontmatterFields(io.files.get(source),{title:'renamed'}));
 const next=await core.commitBatch(io,stale,[{index:0,key:'create'}],{expectedDigest});assert.equal(next.saved[0].id,first.saved[0].id);assert.equal(io.files.size,1);
});
test('commit without an independently supplied approval digest fails closed',async()=>{
 const io=memoryIo();await assert.rejects(()=>core.commitBatch(io,make([]),[{index:0,key:'create'}]),e=>e.code==='E_APPROVAL_STALE');assert.equal(io.files.size,0);
});

test('replay cannot change the already committed operation',async()=>{
 const source=MEMORY+'/LSN-20260101-old.md';const io=memoryIo({[source]:mdFile('LSN-20260101-old',{title:'Alpha',body:'old'})});
 const b=make(await core.loadCorpus(io.reader));const stale=structuredClone(b);await core.commitBatch(io,b,[{index:0,key:'create'}],{expectedDigest:core.proposalDigest(b)});
 await assert.rejects(()=>core.commitBatch(io,stale,[{index:0,key:'replace:LSN-20260101-old'}],{expectedDigest:core.proposalDigest(stale)}),e=>e.code==='E_REPLAY_CONFLICT');
 assert.equal(core.parseEntry(source,io.files.get(source)).status,'active');
});
test('retry never relabels a backlink target changed after a partial save',async()=>{
 const source=MEMORY+'/LSN-20260101-old.md';let fail=true;
 const io=memoryIo({[source]:mdFile('LSN-20260101-old',{title:'Alpha',body:'old'})},{failWrite:p=>fail&&p===source});
 const b=make(await core.loadCorpus(io.reader));const stale=structuredClone(b);await core.commitBatch(io,b,[{index:0,key:'replace:LSN-20260101-old'}],{expectedDigest:core.proposalDigest(b)});
 fail=false;io.files.set(source,mdFile('LSN-20260101-old',{title:'Alpha',body:'new edit'}));
 const result=await core.commitBatch(io,stale,[{index:0,key:'replace:LSN-20260101-old'}],{expectedDigest:core.proposalDigest(stale)});
 assert.equal(result.warnings.length,1);assert.equal(core.parseEntry(source,io.files.get(source)).status,'active');
});

test('a persisted savedAs item safely repairs its incomplete backlink on retry',async()=>{
 const source=MEMORY+'/LSN-20260101-old.md';let fail=true;const io=memoryIo({[source]:mdFile('LSN-20260101-old',{title:'Alpha',body:'old'})},{failWrite:p=>fail&&p===source});
 const b=make(await core.loadCorpus(io.reader));const first=await core.commitBatch(io,b,[{index:0,key:'replace:LSN-20260101-old'}],{expectedDigest:core.proposalDigest(b)});assert.equal(first.warnings.length,1);
 fail=false;await core.commitBatch(io,b,[],{expectedDigest:core.proposalDigest(b)});
 assert.equal(core.parseEntry(source,io.files.get(source)).supersededBy,first.saved[0].id);
});
