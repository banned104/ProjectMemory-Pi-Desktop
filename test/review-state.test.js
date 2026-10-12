'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../plugin/core/index.js');
const { memoryIo } = require('./helpers.js');
const make = () => core.buildBatch({ locale: 'en', prepared: ['First fact', 'Second fact'].map(title => ({ item: core.validateItems([{kind:'lesson',title,content:title,keywords:[]}])[0], similar:[] })) });
test('optional source and scope survive approval and the view exposes relationships',async()=>{
 const io=memoryIo();const old='LSN-20260101-old';
 const {mdFile,MEMORY}=require('./helpers.js');await io.writeText(MEMORY+'/'+old+'.md',mdFile(old,{title:'Scope',body:'Linux'}));
 const item=core.validateItems([{kind:'lesson',title:'Scope',content:'Windows',keywords:[],origin:'build.log',scope:'Windows only'}])[0];
 const batch=core.buildBatch({locale:'en',prepared:[{item,similar:await core.loadCorpus(io.reader)}]});
 const result=await core.commitBatch(io,batch,[{index:0,key:'conflict:'+old}],{expectedDigest:core.proposalDigest(batch)});
 const entries=await core.loadCorpus(io.reader);const entry=entries.find(e=>e.id===result.saved[0].id);
 assert.equal(entry.origin,'build.log');assert.equal(entry.scope,'Windows only');
 const card=core.cardOf(entry);assert.equal(card.scope,'Windows only');assert.deepEqual(card.related,[old]);
 const ui=require('../plugin/views/ui.js');assert(ui.cardHtml(card).includes('Windows only'));assert(ui.cardHtml(card).includes(old));
 const replaced=core.parseEntry(MEMORY+'/new.md',core.renderEntry({...entry,content:entry.body,supersedes:old}));assert.equal(core.cardOf(replaced).supersedes,old);
});

test('an unanalysed import may be deferred or rejected but cannot save',async()=>{
 const io=memoryIo();const batch=make();batch.analysisState='unanalysed';
 await assert.rejects(()=>core.commitBatch(io,batch,[{index:0,key:'create'}],{expectedDigest:core.proposalDigest(batch)}),e=>e.code==='E_COMPARE_INCOMPLETE');
 const result=await core.commitBatch(io,batch,[{index:0,key:'defer'},{index:1,key:'skip'}],{expectedDigest:core.proposalDigest(batch)});
 assert.equal(result.pending,1);assert.equal(result.deferred,1);assert.equal(result.rejected,1);
 assert.equal([...io.files.keys()].filter(path=>path.startsWith('.workflow/memory/')).length,0);
});

test('an analysed batch cannot write an item whose analysis was removed',async()=>{
 const io=memoryIo();const batch=make();batch.analysisState='analysed';
 await assert.rejects(()=>core.commitBatch(io,batch,[{index:0,key:'create'}],{expectedDigest:core.proposalDigest(batch)}),e=>e.code==='E_COMPARE_INCOMPLETE');
 assert.equal([...io.files.keys()].filter(path=>path.startsWith('.workflow/memory/')).length,0);
});

test('defer stays pending and an omitted item remains unreviewed', async () => {
 const io=memoryIo(); const batch=make(); const before=core.proposalDigest(batch);
 const result=await core.commitBatch(io,batch,[{index:0,key:'defer'}],{expectedDigest:before});
 assert.equal(result.pending,2); assert.equal(result.deferred,1); assert.equal(result.skipped,0);
 const stored=await core.readBatch(io,batch.id,'en');
 assert.equal(core.reviewStateOf(stored.items[0]),'deferred');
 assert.equal(core.reviewStateOf(stored.items[1]),'unreviewed');
 assert.notEqual(core.proposalDigest(stored),before);
 assert.equal(core.undecidedCount(stored),2);
 const saved=await core.commitBatch(io,stored,[{index:0,key:'create'}],{expectedDigest:core.proposalDigest(stored)});
 assert.equal(saved.saved.length,1); assert.equal(saved.pending,1);
 assert.equal(core.reviewStateOf(stored.items[0]),'approved');
});
