'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const extension=require('../plugin/extension.js');const tasks=require('../plugin/tasks.js');
const {memoryIo,mdFile,MEMORY}=require('./helpers.js');const context={cwd:'/lifecycle-project',sessionManager:{getSessionId:()=> 'task-s1'}};
test('long task checkpoints stay within total budget and recovery works without a user prompt',async()=>{
 const io=memoryIo({[MEMORY+'/MAP.md']:mdFile('MAP',{kind:'map',title:'Map',body:'Long project context '.repeat(300)})});
 extension._internals.resetTasks();
 let payload={messages:[{role:'user',content:'Validate long project flow'}]};
 const first=await extension._internals.onProviderRequest({payload},context,{io});
 let task=tasks.currentTask(await tasks.readTasks(io),'task-s1');
 await tasks.updateTask(io,'task-s1',{action:'checkpoint',phase:'test',result:'covered',reason:'Existing instructions apply'});
 // Session explicitly observes the phase change from its genuine task tool result in another test; simulate new process restore here.
 extension._internals.resetTasks();
 payload.messages.push({role:'assistant',content:'working'},{role:'user',content:'继续'});
 const next=await extension._internals.onProviderRequest({payload},context,{io});
 assert(next.messages.map(m=>m.content).join('').includes('Long project context'));
 assert(next.messages.reduce((n,m,i)=>n+String(m.content).length-String(payload.messages[i].content).length,0)<=8000);
 await extension._internals.onLifecycle({type:'session_before_compact'},context,{io});await extension._internals.onLifecycle({type:'session_compact'},context,{io});
 const recovered=await extension._internals.onProviderRequest({payload:{messages:[{role:'assistant',content:'Compacted summary'}]}},context,{io});
 assert(recovered);assert(JSON.stringify(recovered).includes('Long project context'));assert(JSON.stringify(recovered).includes('Validate long project flow'));
});

test('a real file change invalidates a checkpoint and waiting approval is a legitimate pause',async()=>{
 const io=memoryIo({[MEMORY+'/MAP.md']:mdFile('MAP',{kind:'map',title:'Map',body:'Instructions'})});extension._internals.resetTasks();
 const payload={messages:[{role:'user',content:'Validate camera ownership'}]};await extension._internals.onProviderRequest({payload},context,{io});
 const session=[...extension._internals.taskSessions.values()][0];
 const checked=await tasks.updateTask(io,'task-s1',{action:'checkpoint',phase:'test',result:'covered',reason:'Covered by map'});session.task=checked.task;
 await extension._internals.onToolResult({toolName:'Write',toolCallId:'file-write',input:{path:'code.js'},details:{},content:[]},context,{io});
 let task=tasks.currentTask(await tasks.readTasks(io),'task-s1');assert.equal(task.dirty,true);assert.equal(task.check.result,'unchecked');
 const first=task.contextRevision;await extension._internals.onToolResult({toolName:'Write',toolCallId:'file-write',input:{path:'code.js'},details:{},content:[]},context,{io});
 task=tasks.currentTask(await tasks.readTasks(io),'task-s1');assert.equal(task.contextRevision,first);
 const core=require('../plugin/core/index.js');const batchId='KB-11111111-2222-3333-4444-555555555555';
 const item=core.validateItems([{kind:'lesson',title:'Pending',content:'New body',keywords:[]}])[0];
 await io.writeText(core.batchPath(batchId),JSON.stringify(core.buildBatch({prepared:[{item,similar:[]}],locale:'en',id:batchId})));
 const paused=await tasks.updateTask(io,'task-s1',{action:'proposal',pending:['KB-11111111-2222-3333-4444-555555555555']});session.task=paused.task;
 await extension._internals.onLifecycle({type:'agent_end'},context,{io});task=tasks.currentTask(await tasks.readTasks(io),'task-s1');assert.equal(task.finishMissed,false);assert.equal(task.state,'awaiting-approval');
});

test('whole-request automatic budget includes separators and persistence warnings',async()=>{
 const io=memoryIo(Object.fromEntries([0,1,2].map(n=>[MEMORY+'/RUL-20260101-large'+n+'.md',mdFile('RUL-20260101-large'+n,{kind:'rule',title:'Large '+n,body:'x'.repeat(5000),extra:'pinned: true'})])));extension._internals.resetTasks();
 const originalWrite=io.writeText;io.writeText=async(path,body)=>{if(path===tasks.TASK_FILE)throw Error('warning '.repeat(100));return originalWrite(path,body);};
 const payload={messages:[{role:'user',content:'Validate the large automatic context request'}]};await extension._internals.onProviderRequest({payload},context,{io});
 payload.messages.push({role:'assistant',content:'working'},{role:'user',content:'Continue with the second budget checkpoint'});
 const next=await extension._internals.onProviderRequest({payload},context,{io});
 const added=next.messages.reduce((sum,m,i)=>sum+String(m.content).length-String(payload.messages[i].content).length,0);
 assert(added<=8000,'automatic additions exceed budget: '+added);assert(JSON.stringify(next).includes('Task persistence warning'));
});

test('failed recovery remains incomplete, retries once per stage and later retrieves current bodies',async()=>{
 const io=memoryIo({[MEMORY+'/MAP.md']:mdFile('MAP',{kind:'map',title:'Map',body:'Current approved instructions'})});extension._internals.resetTasks();
 const payload={messages:[{role:'user',content:'Validate recovery flow'}]};await extension._internals.onProviderRequest({payload},context,{io});
 await extension._internals.onLifecycle({type:'session_before_compact'},context,{io});await extension._internals.onLifecycle({type:'session_compact'},context,{io});
 let task=tasks.currentTask(await tasks.readTasks(io),'task-s1');assert.equal(task.recovery.needed,true);assert.notEqual(task.recovery.result,'restored');
 const exists=io.exists;let attempts=0;io.exists=async path=>{if(path===MEMORY+'/DISABLED'){attempts++;throw Error('denied '+ 'x'.repeat(200));}return exists(path);};
 const compacted={messages:[{role:'assistant',content:'Short summary'}]};
 for(let n=0;n<5;n++){
  const failed=await extension._internals.onProviderRequest({payload:compacted},context,{io});
  assert(JSON.stringify(failed).includes('retrieval failed'));assert(failed.messages.at(-1).content.length<=4000);
 }
 task=tasks.currentTask(await tasks.readTasks(io),'task-s1');assert.equal(task.recovery.needed,true);assert.equal(task.recovery.result,'failed');assert.equal(task.retrieval.status,'failed');assert.equal(attempts,2);
 io.exists=exists;
 const restored=await extension._internals.onProviderRequest({payload:{messages:[...compacted.messages,{role:'user',content:'Continue with the recovery verification'}]}},context,{io});
 assert(JSON.stringify(restored).includes('Current approved instructions'));
 task=tasks.currentTask(await tasks.readTasks(io),'task-s1');assert.equal(task.recovery.needed,false);assert.equal(task.recovery.result,'restored');
});

test('zero-tool provider flow supplies key bodies, preserves cache and restores after compaction',async()=>{
 const io=memoryIo({[MEMORY+'/MAP.md']:mdFile('MAP',{kind:'map',title:'Project map',body:'Modules: camera/capture'}),[MEMORY+'/LSN-20260101-capture.md']:mdFile('LSN-20260101-capture',{title:'Camera capture',body:'Only the owner thread closes the camera',keywords:['camera','capture']})});
 extension._internals.resetTasks();
 const payload={messages:[{role:'user',content:'Fix camera capture shutdown'}]};
 const first=await extension._internals.onProviderRequest({payload},context,{io});
 assert(first.messages[0].content.includes('Only the owner thread closes the camera'));
 assert(first.messages[0].content.includes('<memory-task'));assert.equal(payload.messages[0].content,'Fix camera capture shutdown');
 const second=await extension._internals.onProviderRequest({payload},context,{io});assert.equal(JSON.stringify(second),JSON.stringify(first));
 const grown={messages:[...payload.messages,{role:'assistant',content:'working'},{role:'user',content:'继续'}]};
 const continued=await extension._internals.onProviderRequest({payload:grown},context,{io});
 assert(continued.messages[0].content.includes('Only the owner thread'));
 let task=tasks.currentTask(await tasks.readTasks(io),'task-s1');assert(task.provided.length>0);assert.equal(task.usedClaimed.length,0);
 assert.equal(await extension._internals.onLifecycle({type:'session_before_compact'},context,{io}),undefined);
 await extension._internals.onLifecycle({type:'session_compact'},context,{io});
 const restored=await extension._internals.onProviderRequest({payload:{messages:[{role:'user',content:'继续'}]}},context,{io});
 assert(restored.messages[0].content.includes('Fix camera capture shutdown'));assert(restored.messages[0].content.includes('Only the owner thread'));
 task=tasks.currentTask(await tasks.readTasks(io),'task-s1');assert.equal(task.recovery.result,'restored');
 await extension._internals.onLifecycle({type:'agent_end'},context,{io});
 task=tasks.currentTask(await tasks.readTasks(io),'task-s1');assert.equal(task.finishMissed,true);
 assert.equal([...io.files.keys()].filter(p=>p.startsWith(MEMORY+'/')).length,2);
});
