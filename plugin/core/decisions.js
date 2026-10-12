'use strict';
// Advisory decision history. Never an approval authority or formal-memory input.
const { sha, clip, codeUnitCompare } = require('./text.js');
const DECISIONS_FILE='.workflow/memory-inbox/.decisions.json';
const RETENTION_MS=30*86400000;const MAX_DECISIONS=1000;const MAX_BYTES=240000;
const STATUSES=['rejected','duplicate','approved','deferred'];
function decisionKey(item){
 const a=item.analysis ?? item.decision ?? {};
 return sha(JSON.stringify({kind:item.kind,title:item.title,content:String(item.content??'').replace(/\r\n?/g,'\n').trim(),keywords:item.keywords??[],pin:item.pin===true,
  origin:item.origin??'',scope:item.scope??a.scope??'',action:a.action,targetId:a.targetId??null,evidence:a.evidence??[],
  compared:[...(a.compared??item.similar??[])].map(v=>({id:v.id,source:v.source??null,baseHash:v.baseHash??null})).sort((a,b)=>codeUnitCompare(a.id,b.id))}));
}
async function readDecisions(io,{now=Date.now()}={}){
 const empty=warning=>({records:Object.create(null),warnings:warning?[warning]:[]});
 let raw;try{raw=await io.readText(DECISIONS_FILE);}catch(e){return empty(['ENOENT','ENOTDIR','NOT_FOUND'].includes(e?.code)?null:'Decision history unavailable: '+String(e.message??e));}
 if(Buffer.byteLength(raw,'utf8')>MAX_BYTES)return empty('Decision history exceeded its size limit; ignored.');
 let parsed;try{parsed=JSON.parse(raw);}catch{return empty('Decision history is corrupt; ignored.');}
 if(parsed?.schema!==1||!parsed.records||typeof parsed.records!=='object'||Array.isArray(parsed.records))return empty('Decision history has an invalid shape; ignored.');
 const records=Object.create(null);
 for(const [key,r] of Object.entries(parsed.records)){
  if(!/^[0-9a-f]{64}$/.test(key)||!r||!STATUSES.includes(r.status)||!Number.isFinite(r.at)||r.at>now||now-r.at>=RETENTION_MS||typeof r.reason!=='string'||r.reason.length>120)continue;
  records[key]={status:r.status,at:r.at,reason:r.reason,actor:r.actor==='agent'?'agent':'user'};
 }
 const newest=Object.entries(records).sort((a,b)=>b[1].at-a[1].at||codeUnitCompare(a[0],b[0])).slice(0,MAX_DECISIONS);
 return {records:Object.fromEntries(newest),warnings:[]};
}
async function recordDecisions(io,events,{now=Date.now()}={}){
 const history=await readDecisions(io,{now});
 for(const event of events){
  if(!event?.item||!STATUSES.includes(event.status))throw new Error('invalid decision event');
  history.records[decisionKey(event.item)]={status:event.status,at:now,reason:clip(event.reason??event.item.analysis?.reason??'',120),actor:event.actor==='agent'?'agent':'user'};
 }
 let records=Object.entries(history.records).sort((a,b)=>b[1].at-a[1].at||codeUnitCompare(a[0],b[0])).slice(0,MAX_DECISIONS);
 let raw=JSON.stringify({schema:1,records:Object.fromEntries(records)});
 while(Buffer.byteLength(raw,'utf8')>MAX_BYTES&&records.length){records.pop();raw=JSON.stringify({schema:1,records:Object.fromEntries(records)});}
 try{await io.writeText(DECISIONS_FILE,raw);}catch(e){history.warnings.push('Decision history could not be saved: '+String(e.message??e));}
 return {records:Object.fromEntries(records),warnings:history.warnings};
}
module.exports={decisionKey,readDecisions,recordDecisions,DECISIONS_FILE,RETENTION_MS,MAX_DECISIONS};
