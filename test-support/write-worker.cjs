'use strict';
const {createProjectFs}=require('../plugin/fs-guard.js');
const {withProjectWrite}=require('../plugin/write-coordinator.js');
const core=require('../plugin/core/index.js');
const root=process.argv[2];const mode=process.argv[3];
(async()=>{
 const io=createProjectFs(root,'child');
 let outcome;
 await withProjectWrite(io,async()=>{
  if(mode==='commit') {
    const b=await core.readBatch(io,process.argv[4],'en');
    const result=await core.commitBatch(io,b,[{index:0,key:process.argv[6]}],{expectedDigest:process.argv[5]});
    outcome={saved:result.saved.length};return;
  }
  if(mode==='hold'){process.send?.('locked');await new Promise(()=>{});}
  const p='.workflow/memory-inbox/counter.json';const n=Number(await io.readText(p));
  await new Promise(r=>setTimeout(r,20));await io.writeText(p,String(n+1));
 },{timeoutMs:15000});
 process.send?.({done:true,...outcome});
})().catch(e=>{if(mode==='commit')process.send?.({error:e.code??e.message});else{console.error(e);process.exitCode=1;}}).finally(()=>{if(mode!=='hold')process.disconnect?.();});
