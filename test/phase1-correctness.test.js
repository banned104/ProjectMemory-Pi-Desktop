'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../plugin/core/index.js');
const { confirmedCommit } = require('./helpers.js');
const { memoryIo, makeEntry, mdFile, MEMORY } = require('./helpers.js');
const ID = 'KB-11111111-2222-3333-4444-555555555555';
const item = (extra = {}) => core.validateItems([{kind:'lesson',title:'Alpha',content:'new fact',keywords:['alpha'],...extra}])[0];
const batch = (items, entries = []) => core.buildBatch({id:ID,locale:'en',prepared:items.map(i=>({item:i,similar:core.findSimilar(entries,i)}))});
const unchangedOnReject = async (io, b, selections, pattern = /invalid|duplicate|map|choice/i) => {
  const before = io.snapshot();
  await assert.rejects(()=>confirmedCommit(io,b,selections),pattern);
  assert.deepEqual(io.snapshot(),before,'validation failure must not modify any file');
};

test('commit rejects repeated proposal identity and multiple maps before writing', async () => {
  for (const items of [
    [item(),item({title:'ＡＬＰＨＡ'})],
    [item({kind:'map',title:'One'}),item({kind:'map',title:'Two'})],
  ]) {
    const b = core.buildBatch({id:ID,locale:'en',prepared:items.map(i=>({item:i,similar:[]}))});
    await unchangedOnReject(memoryIo(),b,[{index:0,key:'create'},{index:1,key:'create'}]);
  }
});

test('commit refuses malformed persisted operations, including unselected ones', async () => {
  for (const mutate of [
    b=>{b.items[0].options[0].action='evil';},
    b=>{b.items[0].options[0]={key:'create',action:'replace',targetId:null};},
    b=>{b.items[0].options[0].targetId='LSN-20260101-old';},
    b=>{b.items[0].options.push({key:'replace:null',action:'replace',targetId:null});},
    b=>{b.items[0].options.push({...b.items[0].options[0]});},
    b=>{b.items[0].options=null;},
    b=>{b.items[0].pin='true';},
  ]) {
    const b=batch([item()]); mutate(b);
    await unchangedOnReject(memoryIo(),b,[{index:0,key:'create'}]);
  }
});

test('invalid selection does not stamp preceding skip verdicts', async () => {
  const b=batch([item(),item({title:'Beta'})]);
  const before=structuredClone(b);
  await unchangedOnReject(memoryIo(),b,[{index:0,key:'skip'},{index:1,key:'bad'}]);
  assert.deepEqual(b,before);
});

test('duplicate verdicts require a live same-kind target', async () => {
  const id='LSN-20260101-old';
  const e=makeEntry({id,title:'Alpha'});
  const b=batch([item()],[e]);
  await unchangedOnReject(memoryIo(),b,[{index:0,key:'duplicate:'+id}],/gone or retired/);
  const cross='RUL-20260101-old';
  const io=memoryIo({[MEMORY+'/'+cross+'.md']:mdFile(cross,{kind:'rule',title:'Alpha'})});
  for (const action of ['duplicate','conflict']) {
    const other=batch([item()]);
    other.items[0].options.push({key:action+':'+cross,action,targetId:cross,label:'x'});
    await unchangedOnReject(io,other,[{index:0,key:action+':'+cross}],/different kind/);
  }
});

test('a structurally valid forged option cannot introduce an unrelated target', async () => {
  const id='LSN-20260101-unrelated';
  const io=memoryIo({[MEMORY+'/'+id+'.md']:mdFile(id,{title:'Banana storage',body:'fruit orchard'})});
  const b=batch([item()]);
  b.items[0].options.push({key:'replace:'+id,action:'replace',targetId:id,label:'x'});
  await unchangedOnReject(io,b,[{index:0,key:'replace:'+id}],/invalid choice/);
});

test('full-body duplicates outrank title matches before the candidate limit', () => {
  const entries=[0,1,2].map(n=>makeEntry({id:'LSN-20260101-y'+n,title:'Alpha',body:'different '+n}));
  entries.push(makeEntry({id:'LSN-20260101-z',title:'Unrelated',body:'new fact'}));
  const b=batch([item()],entries);
  assert.equal(b.items[0].similar.length,3);
  assert.equal(b.items[0].decision.action,'duplicate');
  assert.equal(b.items[0].decision.targetId,'LSN-20260101-z');
});

test('body duplicates do not depend on searchable title terms', () => {
  const e=makeEntry({id:'LSN-20260101-old',title:'Unrelated',body:'new fact'});
  const b=batch([item({title:'if 1',keywords:[]})],[e]);
  assert.equal(b.items[0].decision.action,'duplicate');
  assert.equal(b.items[0].decision.targetId,e.id);
});

test('same title alone never recommends deprecating an existing entry', () => {
  const e=makeEntry({id:'LSN-20260101-old',title:'Alpha',body:'Linux-only fact'});
  const b=batch([item({content:'Windows-only fact'})],[e]);
  assert.equal(b.items[0].decision.action,'create');
  assert.equal(b.items[0].decision.targetId,null);
  assert(b.items[0].options.some(o=>o.key==='replace:'+e.id),'explicit user replacement remains available');
});

test('map commits refuse retired, misplaced, duplicated and occupied map files', async () => {
  const canonical=MEMORY+'/MAP.md';
  const active=mdFile('MAP',{kind:'map',title:'Project map',body:'old layout'});
  for (const files of [
    {[canonical]:active.replace('status: active','status: retired')},
    {[MEMORY+'/notes/map.md']:active},
    {[canonical]:active,[MEMORY+'/notes/map.md']:active},
    {[canonical]:mdFile('LSN-20260101-other',{title:'Unrelated',body:'keep this'})},
    {[canonical]:'x'.repeat(core.MAX_FILE_BYTES+1)},
  ]) {
    const io=memoryIo(files);
    const b=batch([item({kind:'map',title:'Project map',content:'new layout'})]);
    await unchangedOnReject(io,b,[{index:0,key:'create'}],/map/i);
  }
});

test('map replacement refuses misplaced and duplicated targets', async () => {
  const canonical=MEMORY+'/MAP.md';
  const active=mdFile('MAP',{kind:'map',title:'Project map',body:'old layout'});
  const b=batch([item({kind:'map',title:'Project map',content:'new layout'})],[core.parseEntry(canonical,active)]);
  for (const files of [
    {[MEMORY+'/notes/map.md']:active},
    {[canonical]:active,[MEMORY+'/notes/map.md']:active},
  ]) await unchangedOnReject(memoryIo(files),structuredClone(b),[{index:0,key:'replace:MAP'}],/map/i);
});

test('map proposals report retired or noncanonical map data instead of offering overwrite', () => {
  for (const e of [
    makeEntry({id:'MAP',kind:'map',status:'retired'}),
    makeEntry({id:'MAP',kind:'map',source:MEMORY+'/notes/map.md'}),
    makeEntry({id:'LSN-20260101-map',kind:'map'}),
  ]) assert.throws(()=>batch([item({kind:'map'})],[e]),/map/i);
});

test('stale map create cannot overwrite a newly created active map', async () => {
  const b=batch([item({kind:'map'})]);
  const io=memoryIo({[MEMORY+'/MAP.md']:mdFile('MAP',{kind:'map',title:'Map',body:'keep layout'})});
  await unchangedOnReject(io,b,[{index:0,key:'create'}]);
});

test('candidate reordering never invalidates a still-related offered target', async () => {
  const id='LSN-20260101-original';
  const source=MEMORY+'/'+id+'.md';
  const io=memoryIo({[source]:mdFile(id,{title:'Alpha',body:'original knowledge'})});
  const b=batch([item()],[core.parseEntry(source,io.files.get(source))]);
  for (let n=0;n<3;n++) io.files.set(MEMORY+'/LSN-20260101-dupe'+n+'.md',mdFile('LSN-20260101-dupe'+n,{title:'Alpha',body:'new fact'}));
  const result=await confirmedCommit(io,b,[{index:0,key:'replace:'+id}]);
  assert.equal(result.saved.length,1);
  assert.equal(core.parseEntry(source,io.files.get(source)).status,'deprecated');
});

test('body equality preserves identifier case and meaningful indentation', () => {
  for (const [oldBody,newBody] of [
    ['Call runBuild()','Call RunBuild()'],
    ['if ready:\n  run()','if ready:\nrun()'],
    ['let x = "Ａ";','let x = "A";'],
  ]) {
    const e=makeEntry({id:'LSN-20260101-code',title:'Alpha',body:oldBody});
    assert.equal(batch([item({content:newBody})],[e]).items[0].decision.action,'create');
  }
  const e=makeEntry({id:'LSN-20260101-code',title:'Alpha',body:'same\r\nbody'});
  assert.equal(batch([item({content:'same\nbody'})],[e]).items[0].decision.action,'duplicate');
});

test('map candidate errors respect the requested locale', () => {
  const e=makeEntry({id:'MAP',kind:'map',status:'retired'});
  assert.throws(()=>core.findSimilar([e],item({kind:'map'}),3,'zh-CN'),/项目地图数据异常/);
});
