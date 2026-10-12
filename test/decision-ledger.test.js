'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const ledger=require('../plugin/core/decisions.js');const {memoryIo}=require('./helpers.js');
const item={kind:'lesson',title:'Build rule',content:'CaseSensitive()',keywords:['build'],pin:false,analysis:{action:'create',targetId:null,scope:'Windows',evidence:['build passed'],compared:[{id:'LSN-20260101-old',baseHash:'a'.repeat(64),source:'.workflow/memory/old.md'}]}};
test('decision history is bounded and corrupt or failed IO is advisory',async()=>{
 const now=Date.parse('2026-10-11T12:00:00Z');const io=memoryIo({[ledger.DECISIONS_FILE]:'{broken'});
 assert.equal(Object.keys((await ledger.readDecisions(io,{now})).records).length,0);
 assert.equal((await ledger.readDecisions(io,{now})).warnings.length,1);
 const events=Array.from({length:1005},(_,n)=>({item:{...item,title:'Fact '+n},status:'rejected',reason:'x'.repeat(500)}));
 await ledger.recordDecisions(io,events,{now});const result=await ledger.readDecisions(io,{now});
 assert(Object.keys(result.records).length<=1000);assert(Object.keys(result.records).length>=900);assert(Buffer.byteLength(io.files.get(ledger.DECISIONS_FILE),'utf8')<=240000);assert(Object.values(result.records).every(r=>r.reason.length<=120));
 const failed=memoryIo({}, {failWrite:()=>true});assert.equal((await ledger.recordDecisions(failed,[events[0]],{now})).warnings.length,1);
});

test('decisions expire and changed content, evidence or versions bypass rejection dedup',async()=>{
 const io=memoryIo();const now=Date.parse('2026-10-11T12:00:00Z');const key=ledger.decisionKey(item);
 await ledger.recordDecisions(io,[{item,status:'rejected',reason:'Not reusable'}],{now});
 assert.equal((await ledger.readDecisions(io,{now})).records[key].status,'rejected');
 for(const changed of [{...item,content:'casesensitive()'},{...item,analysis:{...item.analysis,evidence:['new test']}},{...item,analysis:{...item.analysis,compared:[{...item.analysis.compared[0],baseHash:'b'.repeat(64)}]}}]) assert.equal((await ledger.readDecisions(io,{now})).records[ledger.decisionKey(changed)],undefined);
 assert.equal(Object.keys((await ledger.readDecisions(io,{now:now+31*86400000})).records).length,0);
});
