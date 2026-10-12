'use strict';
// Ephemeral task checkpoints. This file never writes or supplies formal knowledge.
const crypto=require('node:crypto');
const core=require('./core/index.js');
const {withProjectWrite}=require('./write-coordinator.js');
const TASK_FILE='.workflow/memory-inbox/.tasks.json';
const RETENTION_MS=30*86400000,MAX_TASKS=100,MAX_BYTES=240000,MAX_VERSIONS=24;
const RESULTS=['unchecked','new','covered','none','awaiting'];
const STATES=['active','awaiting-approval','completed','paused'];
const text=(value,max)=>core.clip(typeof value==='string'?value.trim():'',max);
const sessionKey=sid=>core.sha(String(sid));
const continuation=value=>/^(?:继续|请继续|接着|接下来继续|继续完成|好的|好|可以)|^(?:continue|keep going|go on|proceed)(?:\b|:)/i.test(String(value).trim())||String(value).trim().length<12;
const validId=id=>typeof id==='string'&&/^[0-9a-f-]{36}$/.test(id);
function freshTask(sid,goal,boundary,now,operationId){
 return {taskId:validId(operationId)?operationId:crypto.randomUUID(),sessionKey:sessionKey(sid),goal:text(goal,500),boundary,current:true,state:'active',phase:'start',revision:1,contextRevision:1,dirty:true,check:{result:'unchecked',reason:''},retrieval:{status:'not-checked',corpusSize:0},surfaced:[],provided:[],usedClaimed:[],pending:[],recovery:{generation:0,needed:false,result:'none'},finishMissed:false,lastPromptKey:'',operations:[],updated:now};
}
function versions(values){
 return (Array.isArray(values)?values:[]).filter(v=>v&&core.ID_PATTERN.test(v.id)&&typeof v.baseHash==='string'&&/^[a-f0-9]{64}$/.test(v.baseHash)&&typeof v.source==='string'&&v.source.startsWith(core.MEMORY_DIR+'/')).slice(0,MAX_VERSIONS).map(v=>({id:v.id,source:text(v.source,300),baseHash:v.baseHash,suppliedChars:Math.max(0,Math.min(262144,Number(v.suppliedChars)||0)),bodyChars:Math.max(0,Math.min(262144,Number(v.bodyChars)||0)),complete:v.complete===true,via:['automatic','load','comparison'].includes(v.via)?v.via:'automatic'}));
}
function cleanTask(raw,now){
 if(!raw||!validId(raw.taskId)||!/^[a-f0-9]{64}$/.test(raw.sessionKey)||!Number.isFinite(raw.updated)||raw.updated>now||now-raw.updated>=RETENTION_MS||!STATES.includes(raw.state))return null;
 const task=freshTask('',raw.goal,raw.boundary==='explicit'?'explicit':'inferred',raw.updated,raw.taskId);
 task.sessionKey=raw.sessionKey;task.current=raw.current!==false;task.state=raw.state;task.phase=text(raw.phase,80)||'start';task.revision=Math.max(1,Math.min(1e9,Number(raw.revision)||1));task.contextRevision=Math.max(1,Math.min(1e9,Number(raw.contextRevision)||1));
 task.dirty=raw.dirty!==false;task.finishMissed=raw.finishMissed===true;
 task.check={result:RESULTS.includes(raw.check?.result)?raw.check.result:'unchecked',reason:text(raw.check?.reason,300)};
 task.retrieval={status:['not-checked','hit','no-match','empty','disabled','failed'].includes(raw.retrieval?.status)?raw.retrieval.status:'not-checked',corpusSize:Math.max(0,Math.min(2000,Number(raw.retrieval?.corpusSize)||0)),query:text(raw.retrieval?.query,500),error:text(raw.retrieval?.error,200)};
 task.surfaced=versions(raw.surfaced);task.provided=versions(raw.provided);task.usedClaimed=versions(raw.usedClaimed);
 task.pending=(Array.isArray(raw.pending)?raw.pending:[]).filter(id=>/^KB-[a-f0-9-]{36}$/.test(id)).slice(0,10);
 task.recovery={generation:Math.max(0,Math.min(1e9,Number(raw.recovery?.generation)||0)),needed:raw.recovery?.needed===true,result:['none','before','compacted','restored','failed','disabled','restart'].includes(raw.recovery?.result)?raw.recovery.result:'none'};
 task.lastPromptKey=/^[a-f0-9]{64}$/.test(raw.lastPromptKey)?raw.lastPromptKey:text(raw.lastPromptKey,80);
 task.operations=(Array.isArray(raw.operations)?raw.operations:[]).filter(value=>typeof value==='string'&&value.length<=120).slice(-24);
 return task;
}
async function readTasks(io,{now=Date.now()}={}){
 let raw;try{raw=await io.readText(TASK_FILE);}catch(error){return {tasks:[],warnings:['ENOENT','ENOTDIR','NOT_FOUND'].includes(error?.code)?[]:['Task state read failed: '+core.sanitize(error.message,160)]};}
 if(Buffer.byteLength(raw,'utf8')>MAX_BYTES)return {tasks:[],warnings:['Task state exceeds its size budget; ignored.']};
 let state;try{state=JSON.parse(raw);}catch{return {tasks:[],warnings:['Task state is corrupt; ignored.']};}
 if(state?.schema!==1||!Array.isArray(state.tasks))return {tasks:[],warnings:['Task state has an invalid shape; ignored.']};
 const seen=new Set();const tasks=[];
 for(const rawTask of state.tasks){const task=cleanTask(rawTask,now);if(task&&!seen.has(task.taskId)){seen.add(task.taskId);tasks.push(task);}}
 return {tasks:tasks.sort((a,b)=>b.updated-a.updated||b.revision-a.revision).slice(0,MAX_TASKS),warnings:[]};
}
async function reconcilePending(state,io){
 try{
  const live=new Set((await core.listBatches(io)).filter(b=>core.undecidedCount(b)>0).map(b=>b.id));
  for(const task of state.tasks){
   const pending=task.pending.filter(id=>live.has(id));if(pending.length===task.pending.length)continue;
   task.pending=pending;task.revision++;task.contextRevision++;
   if(!pending.length&&task.state==='awaiting-approval'){task.state=task.current===false?'paused':'active';task.dirty=true;task.check={result:'unchecked',reason:''};}
   else if(!pending.length&&task.check.result==='awaiting'){task.dirty=true;task.check={result:'unchecked',reason:''};}
  }
 }catch(error){state.warnings.push('Task pending reconciliation failed: '+core.sanitize(error.message,160));}
 return state;
}
async function readTaskStatus(io,options={}){return reconcilePending(await readTasks(io,options),io);}
function currentTask(state,sid){return state.tasks.find(t=>t.sessionKey===sessionKey(sid)&&t.current!==false)??null;}
function mergeVersions(previous,next){return [...new Map([...previous,...next].map(v=>[v.id,v])).values()].slice(-MAX_VERSIONS);}
function transition(state,sid,command,{now=Date.now()}={}){
 if(typeof sid!=='string'||!sid)throw new Error('stable sessionId is required');
 const supported=['observe','begin','checkpoint','finish','delivery','read','used','proposal','before-compact','compacted','compact-failed','end','restart','change'];
 if(!supported.includes(command?.action))throw new Error('unsupported task action');
 let task=currentTask(state,sid);const op=text(command.operationId,120);
 if(task&&op&&task.operations.includes(op))return {state,task,changed:false};
 const observed=text(command.goal,500),isObserve=command.action==='observe';
 if(isObserve&&task&&task.lastPromptKey===command.promptKey)return {state,task,changed:false};
 const start=!task||command.action==='begin'||isObserve&&(task.state==='completed'||!continuation(observed)&&observed!==task.goal&&task.lastPromptKey);
 if(start){if(!observed)throw new Error('a nonempty task goal is required');
  for(const old of state.tasks.filter(t=>t.sessionKey===sessionKey(sid))){old.current=false;if(old.state!=='completed')old.state='paused';}
  task=freshTask(sid,observed,command.action==='begin'?'explicit':'inferred',now,op);state.tasks.unshift(task);}
 else task=structuredClone(task);
 let contextChanged=start;
 const pendingBefore=task.pending.join('|');
 if(isObserve){task.lastPromptKey=text(command.promptKey,80);if(!start){task.dirty=true;if(task.state!=='awaiting-approval')task.check={result:'unchecked',reason:''};if(task.state==='completed')task.state='active';contextChanged=true;}}
 if(command.action==='checkpoint'||command.action==='finish'){
  if(command.taskId&&command.taskId!==task.taskId)throw new Error('task changed; record a fresh checkpoint');
  if(command.phase!==undefined){if(typeof command.phase!=='string'||!command.phase.trim()||command.phase.length>80)throw new Error('phase must hold 1-80 characters');if(task.phase!==command.phase.trim())contextChanged=true;task.phase=command.phase.trim();}
  if(!['new','covered','none','awaiting'].includes(command.result)||typeof command.reason!=='string'||!command.reason.trim()||command.reason.length>300)throw new Error('check result and a short nonempty reason are required');
  task.check={result:command.result,reason:command.reason.trim()};task.finishMissed=false;
  task.pending=(Array.isArray(command.pending)?command.pending:task.pending).filter(id=>/^KB-[a-f0-9-]{36}$/.test(id)).slice(0,10);
  task.dirty=false;task.state=command.result==='awaiting'?'awaiting-approval':command.action==='finish'?'completed':'active';contextChanged=true;
 }
 if(command.action==='change'){
  if(!task.dirty)contextChanged=true;task.dirty=true;task.finishMissed=false;
  if(task.state!=='awaiting-approval'){task.state='active';task.check={result:'unchecked',reason:''};}
 }
 if(command.action==='delivery'){
  const next=versions(command.versions);task.surfaced=mergeVersions(task.surfaced,next);
  task.provided=mergeVersions(task.provided,next.filter(v=>v.suppliedChars>0));
  if(task.recovery.needed&&command.recoveryDelivery){const status=command.retrieval?.status;const failed=['failed','disabled','not-checked',undefined].includes(status);task.recovery.needed=failed;task.recovery.result=failed?(status==='disabled'?'disabled':'failed'):'restored';}
  if(command.retrieval)task.retrieval={status:command.retrieval.status,corpusSize:command.retrieval.corpusSize??0,query:text(command.retrieval.query,500),error:text(command.retrieval.error,200)};
 }
 if(command.action==='read'){const next=versions(command.versions);task.provided=mergeVersions(task.provided,next);}
 if(command.action==='used'){const next=versions(command.versions);task.usedClaimed=mergeVersions(task.usedClaimed,next);}
 if(command.action==='proposal'){task.pending=(Array.isArray(command.pending)?command.pending:[]).filter(id=>/^KB-[a-f0-9-]{36}$/.test(id)).slice(0,10);if(task.pending.length){task.finishMissed=false;task.state='awaiting-approval';task.check={result:'awaiting',reason:'Waiting for genuine user review'};}else if(task.state==='awaiting-approval'){task.state='active';task.dirty=true;task.check={result:'unchecked',reason:''};}}
 if(command.action==='before-compact'){task.recovery.needed=true;task.recovery.result='before';}
 if(command.action==='compacted'){task.recovery={generation:task.recovery.generation+1,needed:true,result:'compacted'};task.dirty=true;contextChanged=true;}
 if(command.action==='compact-failed'){task.recovery.needed=false;task.recovery.result='failed';}
 if(command.action==='restart'){task.recovery={generation:task.recovery.generation+1,needed:true,result:'restart'};task.dirty=true;contextChanged=true;}
 if(command.action==='end'){if(task.finishMissed)return {state,task,changed:false};if(task.dirty&&task.state!=='awaiting-approval'&&task.state!=='completed')task.finishMissed=true;}
 if(pendingBefore!==task.pending.join('|'))contextChanged=true;
 if(op)task.operations=[...task.operations,op].slice(-24);
 task.updated=now;task.revision++;if(contextChanged&&!start)task.contextRevision++;
 state.tasks=state.tasks.filter(t=>t.taskId!==task.taskId);state.tasks.unshift(task);
 return {state,task,changed:true};
}
async function updateTask(io,sid,command,options={}){
 try{return await withProjectWrite(io,async()=>{
  const state=await readTasks(io,options);
  if(options.fallbackTask){const latest=currentTask(state,sid);if(!latest||options.fallbackTask.revision>latest.revision){state.tasks=state.tasks.filter(t=>t.taskId!==options.fallbackTask.taskId);state.tasks.unshift(structuredClone(options.fallbackTask));}}
  const beforeReconcile=state.tasks.map(t=>t.revision).join('|');
  if(options.reconcilePending)await reconcilePending(state,io);
  const result=transition(state,sid,command,options);
  if(result.changed||beforeReconcile!==state.tasks.map(t=>t.revision).join('|')){let tasks=result.state.tasks.filter(t=>(options.now??Date.now())-t.updated<RETENTION_MS).slice(0,MAX_TASKS);let raw=JSON.stringify({schema:1,tasks});
   while(Buffer.byteLength(raw,'utf8')>MAX_BYTES&&tasks.length>1){tasks.pop();raw=JSON.stringify({schema:1,tasks});}
   if(Buffer.byteLength(raw,'utf8')>MAX_BYTES)state.warnings.push('Task state exceeds budget; not saved.');
   else try{await io.writeText(TASK_FILE,raw);}catch(error){state.warnings.push('Task state write failed: '+core.sanitize(error.message,160));}
  }
  return {task:result.task,warnings:state.warnings,changed:result.changed};
 },{timeoutMs:2000,signal:options.signal});
 }catch(error){
  const state=await readTasks(io,options);
  if(options.fallbackTask){state.tasks=state.tasks.filter(t=>t.taskId!==options.fallbackTask.taskId);state.tasks.unshift(structuredClone(options.fallbackTask));}
  if(options.reconcilePending)await reconcilePending(state,io);
  const result=transition(state,sid,command,options);
  return {task:result.task,changed:result.changed,warnings:[...state.warnings,'Task state write failed (coordination): '+core.sanitize(error.message,160)],persisted:false};
 }
}
function taskIndex(task){
 if(!task)return '';
 return '<memory-task note="Temporary task status, not approved knowledge; delivery does not prove understanding.">\n'+
  'Task '+task.taskId+'; boundary='+task.boundary+'; goal='+core.sanitize(task.goal,500)+'; phase='+core.sanitize(task.phase,80)+'; state='+task.state+'\n'+
  'Check='+task.check.result+'; dirty='+task.dirty+'; reason='+core.sanitize(task.check.reason,300)+'; finish-check-missing='+task.finishMissed+'\n'+
  'Pending identities='+task.pending.join(', ')+'; recovery='+task.recovery.result+'; recovery-needed='+task.recovery.needed+'\n'+
  'Use plugin_pi_project_memory_task begin/checkpoint/finish to state task boundaries and record a reusable/covered/none/waiting conclusion. Waiting for user review is a legitimate pause; do not repeat approval cards.\n</memory-task>';
}
module.exports={TASK_FILE,RETENTION_MS,MAX_TASKS,MAX_BYTES,readTasks,readTaskStatus,currentTask,transition,updateTask,taskIndex,sessionKey,versions,continuation};
