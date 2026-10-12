'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const tasks=require('../plugin/tasks.js');const {memoryIo}=require('./helpers.js');
test('version delivery and duplicate recovery events stay bounded and distinct from claimed use',async()=>{
 const io=memoryIo();const now=Date.parse('2026-10-11T12:00:00Z');
 const started=await tasks.updateTask(io,'s',{action:'begin',goal:'Check build',operationId:'11111111-2222-3333-4444-555555555555'},{now});
 const version={id:'LSN-20260101-build',source:'.workflow/memory/build.md',baseHash:'a'.repeat(64),suppliedChars:100,bodyChars:200,complete:false,via:'automatic'};
 await tasks.updateTask(io,'s',{action:'delivery',versions:[version],retrieval:{status:'hit',corpusSize:1}},{now:now+1});
 let current=tasks.currentTask(await tasks.readTasks(io,{now:now+2}),'s');
 assert.equal(current.provided[0].complete,false);assert.equal(current.usedClaimed.length,0);
 await tasks.updateTask(io,'s',{action:'used',versions:[version]},{now:now+3});
 const a=await tasks.updateTask(io,'s',{action:'compacted',operationId:'compact-event-1'},{now:now+4});
 const b=await tasks.updateTask(io,'s',{action:'compacted',operationId:'compact-event-1'},{now:now+5});
 assert.equal(a.task.recovery.generation,b.task.recovery.generation);assert.equal(b.changed,false);
 assert.equal(b.task.usedClaimed[0].id,version.id);assert.equal(b.task.dirty,true);
 const raw=JSON.stringify({schema:1,tasks:[{...b.task,transcript:'SECRET',provided:[{...version,body:'SECRET'}]}]});io.files.set(tasks.TASK_FILE,raw);
 const restored=await tasks.readTasks(io,{now:now+6});assert(!JSON.stringify(restored).includes('SECRET'));
 assert.equal((await tasks.readTasks(io,{now:now+31*86400000})).tasks.length,0);
});
test('corrupt and failed task persistence are visible but never become formal memory',async()=>{
 const io=memoryIo({[tasks.TASK_FILE]:'{broken'},{failWrite:()=>true});const now=Date.parse('2026-10-11T12:00:00Z');
 const result=await tasks.updateTask(io,'s',{action:'begin',goal:'Continue work'},{now});
 assert(result.warnings.some(w=>w.includes('corrupt')));assert(result.warnings.some(w=>w.includes('write failed')));
 assert.equal(result.task.goal,'Continue work');
});

test('task history stays within count and byte budgets across many sessions',async()=>{
 const io=memoryIo();const now=Date.parse('2026-10-11T12:00:00Z');
 for(let n=0;n<105;n++)await tasks.updateTask(io,'session-'+n,{action:'begin',goal:'Goal '+n},{now:now+n});
 const result=await tasks.readTasks(io,{now:now+200});assert.equal(result.tasks.length,100);
 assert(Buffer.byteLength(io.files.get(tasks.TASK_FILE),'utf8')<=240000);
 assert.equal(tasks.currentTask(result,'session-104').goal,'Goal 104');assert.equal(tasks.currentTask(result,'session-0'),null);
});

test('long continuation preserves its task and explicit begin pauses the earlier work',async()=>{
 const io=memoryIo();const now=Date.parse('2026-10-12T12:00:00Z');
 const first=await tasks.updateTask(io,'s',{action:'observe',goal:'Fix camera ownership',promptKey:'a'},{now});
 const batchId='KB-11111111-2222-3333-4444-555555555555';
 await tasks.updateTask(io,'s',{action:'proposal',pending:[batchId]},{now:now+1});
 for(const [n,goal] of ['Continue: check the camera owner thread','继续检查相机所有者线程的关闭顺序','keep going with the capture validation'].entries()){
  const continued=await tasks.updateTask(io,'s',{action:'observe',goal,promptKey:'follow-'+n},{now:now+2+n});
  assert.equal(continued.task.taskId,first.task.taskId);assert.deepEqual(continued.task.pending,[batchId]);assert.equal(continued.task.state,'awaiting-approval');
 }
 await tasks.updateTask(io,'s',{action:'proposal',pending:[]},{now:now+10});
 const next=await tasks.updateTask(io,'s',{action:'begin',goal:'Another explicit task'},{now:now+11});
 const history=await tasks.readTasks(io,{now:now+12});assert.notEqual(next.task.taskId,first.task.taskId);
 assert.equal(history.tasks.find(t=>t.taskId===first.task.taskId).state,'paused');
});

test('task state separates explicit tasks, continuations and checked completion',async()=>{
 const io=memoryIo();const now=Date.parse('2026-10-11T12:00:00Z');
 const first=await tasks.updateTask(io,'session-1',{action:'observe',goal:'Fix camera capture',promptKey:'first'},{now});
 assert.equal(first.task.boundary,'inferred');assert.equal(first.task.check.result,'unchecked');
 const continued=await tasks.updateTask(io,'session-1',{action:'observe',goal:'继续',promptKey:'second'},{now:now+1000});
 assert.equal(continued.task.taskId,first.task.taskId);
 const phase=await tasks.updateTask(io,'session-1',{action:'checkpoint',phase:'validation',result:'covered',reason:'Existing entry covers the lesson'},{now:now+2000});
 assert.equal(phase.task.phase,'validation');assert.equal(phase.task.check.result,'covered');
 const finished=await tasks.updateTask(io,'session-1',{action:'finish',result:'none',reason:'No reusable knowledge'},{now:now+3000});
 assert.equal(finished.task.state,'completed');assert.equal(finished.task.dirty,false);
 const explicit=await tasks.updateTask(io,'session-1',{action:'begin',goal:'Another task',operationId:'op-new'},{now:now+4000});
 assert.notEqual(explicit.task.taskId,first.task.taskId);assert.equal(explicit.task.boundary,'explicit');
 const restored=await tasks.readTasks(io,{now:now+5000});
 assert.equal(tasks.currentTask(restored,'session-1').taskId,explicit.task.taskId);
 assert.equal(tasks.currentTask(restored,'other-session'),null);
 assert.equal([...io.files.keys()].filter(p=>p.startsWith('.workflow/memory/')).length,0);
});
