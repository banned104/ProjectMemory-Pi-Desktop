'use strict';
// Reproducible character costs, not token estimates or a performance benchmark.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const core=require('../plugin/core/index.js'),main=require('../plugin/main.js'),extension=require('../plugin/extension.js');
const {memoryIo,mdFile,MEMORY}=require('../test/helpers.js');
const measure=value=>({utf16Chars:JSON.stringify(value).length,utf8Bytes:Buffer.byteLength(JSON.stringify(value),'utf8')});
(async()=>{
 const initial=Object.fromEntries([0,1,2,3].map(n=>[MEMORY+'/LSN-20260101-build'+n+'.md',mdFile('LSN-20260101-build'+n,{title:'Build setup',body:'Step '+n+' '+ 'Long build knowledge '.repeat(550),keywords:['build','setup'],extra:'pinned: true'})]));
 const io=memoryIo(initial),ctx={cwd:'/costs',sessionManager:{getSessionId:()=> 'cost-s6'}};
 globalThis.pi={workspace:{get:async()=>({path:'/costs',name:'Costs'})},app:{getLocale:async()=> 'en'},plugin:{getSettings:async()=>({})},fs:{list:io.reader.list,readText:io.readText,writeText:io.writeText,stat:async p=>{if(!await io.exists(p))throw Object.assign(Error('missing'),{code:'NOT_FOUND'});return {};}}};
 main._internals.setProjectIoFactory(()=>io);extension._internals.resetTasks();
 let payload={messages:[{role:'user',content:'Validate the build setup'}]};const added=(next,original)=>next.messages.reduce((n,m,i)=>n+String(m.content).length-String(original.messages[i]?.content??'').length,0);
 const first=await extension._internals.onProviderRequest({payload},ctx,{io});const repeated=await extension._internals.onProviderRequest({payload},ctx,{io});assert.deepEqual(first,repeated);
 payload={messages:[...payload.messages,{role:'assistant',content:'working'},{role:'user',content:'Continue through build validation'}]};const continued=await extension._internals.onProviderRequest({payload},ctx,{io});assert(added(continued,payload)<=8000);
 await extension._internals.onLifecycle({type:'session_compact'},ctx,{io});const compactPayload={messages:[{role:'assistant',content:'Compacted summary'}]};const compact=await extension._internals.onProviderRequest({payload:compactPayload},ctx,{io});
 const toolCtx={sessionId:'cost-s6',mode:'plan'};
 const search=await main._internals.tools.search.execute({action:'search',query:'build'},toolCtx);
 const load=await main._internals.tools.load.execute({action:'load',id:'LSN-20260101-build0'},toolCtx);
 const prepare=await main._internals.tools.prepare.execute({action:'prepare',items:[{kind:'lesson',title:'Build setup',content:'Different project setup',keywords:['build','setup']}]},toolCtx);
 const initialBody=prepare.items.flatMap(i=>i.candidates).reduce((n,c)=>n+(c.body?.length??0),0);let pages=0,pagedBody=0,pageSerialized=0;
 for(const candidate of prepare.items[0].candidates){let next=candidate;while(!next.versionComplete){const page=await main._internals.tools.prepare.execute({action:'page',reviewToken:prepare.reviewToken,id:candidate.id,offset:next.nextOffset},toolCtx);pages++;pagedBody+=page.body.length;pageSerialized+=JSON.stringify(page).length;next={...page,versionComplete:page.versionComplete??page.complete};}}
 const report={unit:'UTF-16 characters unless utf8Bytes is named; no model tokenizer was run',fixture:{entries:4,bodyChars:core.parseEntry('x',Object.values(initial)[0]).body.length},automatic:{firstAdded:added(first,{messages:[{role:'user',content:'Validate the build setup'}]}),repeatAdded:added(repeated,{messages:[{role:'user',content:'Validate the build setup'}]}),repeatByteStable:JSON.stringify(first)===JSON.stringify(repeated),continuedAdded:added(continued,payload),compactedAdded:added(compact,compactPayload),requestLimit:8000,blockLimitIncludingSeparator:4000,bodyLimit:2000,bodiesPerBlock:3},tools:{search:measure(search),load:{...measure(load),suppliedBodyChars:load.memoryDelivery[0].suppliedChars},prepare:{...measure(prepare),suppliedBodyChars:initialBody,bodyBudget:24000,candidatePageBudget:8000,candidates:prepare.items[0].candidates.length},paging:{calls:pages,suppliedBodyChars:pagedBody,serializedChars:pageSerialized}}};
 const output=path.join(process.env.PI_SCRATCH_DIR??require('node:os').tmpdir(),'phase6-costs.json');fs.writeFileSync(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));delete globalThis.pi;
})().catch(e=>{console.error(e);process.exitCode=1;});
