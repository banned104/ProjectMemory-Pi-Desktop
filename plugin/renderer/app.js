'use strict';
(() => {
 const ui=globalThis.MemoryReview,bridge=window.pluginBridge;
 const el=id=>document.getElementById(id);
 let locale='en',project=null,batches=[],busy=false,request=0,viewKey='',drafts=new Map(),taskResponse={tasks:[],warnings:[]};
 const draftKey=(batch,item)=>String(project?.path)+'|'+batch.id+'|'+item.itemId;
 const signature=item=>JSON.stringify([item.content,item.analysis,item.requestedAction,item.origin,item.scope,item.savedAs,item.decided]);
 const show=(kind,text,html=false)=>{el('message').className=kind; if(html)el('message').innerHTML=text;else el('message').textContent=text;};
 function capture(){
  for(const section of el('list').querySelectorAll('[data-batch]')){
   const batch=batches.find(b=>b.id===section.dataset.batch);if(!batch)continue;
   for(const holder of section.querySelectorAll('[data-item]')){
    const item=batch.items[Number(holder.dataset.index)];if(!item||item.savedAs||item.decided)continue;
    const read=selector=>holder.querySelector(selector)?.value;
    drafts.set(draftKey(batch,item),{sig:signature(item),choice:read('[data-choice]')??'unreviewed',content:read('[data-content]')??item.content,origin:read('[data-origin]')??item.origin??'',scope:read('[data-scope]')??item.scope??item.analysis?.scope??'',alternative:read('[data-alternative]'),open:holder.querySelector('[data-editor]')?.open??false,comparisonOpen:holder.querySelector('[data-comparison]')?.open??false});
   }
  }
 }
 function focusRecord(){const e=document.activeElement;if(!e||!el('list').contains(e))return null;const holder=e.closest('[data-item]'),section=e.closest('[data-batch]');return {batch:section?.dataset.batch,item:holder?.dataset.item,attr:[...e.attributes].find(a=>/^data-(choice|content|origin|scope|alternative)$/.test(a.name))?.name,start:e.selectionStart,end:e.selectionEnd};}
 function render(){
  const focus=focusRecord();el('title').textContent=ui.t(locale,'title');el('refresh').textContent=ui.t(locale,'refresh');el('project').textContent=project?ui.t(locale,'project')+': '+project.name:ui.t(locale,'noProject');
  el('list').innerHTML=batches.length?batches.map(batch=>{const own={};for(const item of batch.items){const d=drafts.get(draftKey(batch,item));if(d?.sig===signature(item))own[item.itemId]=d;}return ui.batchHtml(batch,{locale,drafts:own});}).join(''):'<p class="empty">'+ui.esc(ui.t(locale,'empty'))+'</p>';
  for(const section of el('list').querySelectorAll('[data-batch]'))for(const holder of section.querySelectorAll('[data-item]')){const b=batches.find(b=>b.id===section.dataset.batch),item=b?.items[Number(holder.dataset.index)],d=item?drafts.get(draftKey(b,item)):null;if(d?.sig===signature(item)&&d.comparisonOpen)holder.querySelector('[data-comparison]').open=true;}
  if(focus?.attr){const section=[...el('list').querySelectorAll('[data-batch]')].find(s=>s.dataset.batch===focus.batch);const holder=[...(section?.querySelectorAll('[data-item]')??[])].find(h=>h.dataset.item===focus.item);const target=holder?.querySelector('['+focus.attr+']');if(target){target.focus();if(Number.isInteger(focus.start))try{target.setSelectionRange(focus.start,focus.end);}catch{}}}
  if(el('task-diagnostics'))el('task-diagnostics').innerHTML=ui.tasksHtml(taskResponse,locale);
  applyBusy();
 }
 function applyBusy(){document.querySelectorAll('button').forEach(button=>{button.disabled=busy;});}
 async function load(force=false){
  if(busy)return;capture();const id=++request;
  try{const response=await bridge.invoke('inbox.list',{});if(id!==request)return;
   if(project?.path!==response.project?.path){drafts.clear();viewKey='';}
   project=response.project;batches=response.batches;const key=JSON.stringify([locale,project,batches]);
   if(force||key!==viewKey){render();viewKey=key;}
   try{const status=await bridge.invoke('task.status',{});if(id!==request)return;taskResponse=status;if(el('task-diagnostics'))el('task-diagnostics').innerHTML=ui.tasksHtml(status,locale);}catch(error){if(id!==request)return;taskResponse={tasks:[],warnings:[ui.t(locale,'taskFailed')+': '+String(error.message??error)]};if(el('task-diagnostics'))el('task-diagnostics').innerHTML=ui.tasksHtml(taskResponse,locale);}
   const records=response.history??[];el('history').innerHTML=records.length?'<details><summary>'+ui.esc(ui.t(locale,'history'))+'</summary>'+records.map(r=>'<p><span class="badge">'+ui.esc(ui.t(locale,r.status))+'</span> '+ui.esc(ui.t(locale,r.actor==='agent'?'actorAgent':'actorUser'))+' · '+ui.esc(r.reason)+' <time>'+ui.esc(new Date(r.at).toLocaleString())+'</time></p>').join('')+'</details>':'';
  }catch(error){show('error',String(error.message??error));}
 }
 async function act(run){if(busy)return;capture();busy=true;applyBusy();let ok=false;try{await run();ok=true;}catch(error){show('error',ui.t(locale,'failed')+': '+String(error.message??error));}finally{busy=false;applyBusy();if(ok)await load(true);}}
 document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button||busy)return;
  if(button.id==='refresh'){void load();return;}
  const section=button.closest('[data-batch]');if(!section)return;
  const batch=batches.find(b=>b.id===section.dataset.batch);if(!batch)return;
  if(button.hasAttribute('data-commit')){
   capture();
   for(const select of section.querySelectorAll('[data-choice]'))if(select.value==='approve'){
     const item=batch.items[Number(select.dataset.choice)],d=drafts.get(draftKey(batch,item));
     const recommended=item.analysis?.action==='create'?'create':item.analysis?.action+':'+item.analysis?.targetId;
     if(d&&(d.content!==item.content||d.origin!==(item.origin??'')||d.scope!==(item.scope??item.analysis?.scope??'')||d.alternative!==recommended)){show('error',ui.t(locale,'dirty'));return;}
   }
   const selections=[...section.querySelectorAll('[data-choice]')].filter(select=>select.value!=='unreviewed').map(select=>{const index=Number(select.dataset.choice);const item=batch.items[index];const key=select.value==='approve'?item.analysis?.action==='create'?'create':item.analysis.action+':'+item.analysis.targetId:select.value;return {index,key};});
   if(!selections.length)return;
   void act(async()=>{const result=await bridge.invoke('inbox.commit',{batchId:batch.id,reviewToken:batch.reviewToken,selections});show('result',ui.formatResult(result,locale),true);});
  }else if(button.hasAttribute('data-revise')){
   const index=Number(button.dataset.revise),holder=button.closest('[data-item]');const key=holder.querySelector('[data-alternative]').value;const colon=key.indexOf(':');
   void act(async()=>{await bridge.invoke('inbox.revise',{batchId:batch.id,reviewToken:batch.reviewToken,index,content:holder.querySelector('[data-content]').value,origin:holder.querySelector('[data-origin]').value,scope:holder.querySelector('[data-scope]').value,action:colon<0?key:key.slice(0,colon),targetId:colon<0?null:key.slice(colon+1)});drafts.delete(draftKey(batch,batch.items[index]));show('result',ui.t(locale,'revised'));});
  }else if(button.hasAttribute('data-discard'))void act(async()=>{const result=await bridge.invoke('inbox.discard',{batchId:batch.id,reviewToken:batch.reviewToken});show('result',ui.t(locale,'rejected')+(result.already?.length?' · '+result.already.join(', '):''));});
 });
 document.addEventListener('input',event=>{if(event.target.closest('[data-item]'))capture();});
 document.addEventListener('change',event=>{if(event.target.closest('[data-item]'))capture();});
 window.addEventListener('focus',()=>{if(!busy)void load();});
 if(bridge?.on){bridge.on('workspace:changed',()=>{request++;drafts.clear();project=null;batches=[];taskResponse={tasks:[],warnings:[]};if(el('task-diagnostics'))el('task-diagnostics').innerHTML='';viewKey='';el('list').innerHTML='';if(!busy)void load(true);});bridge.on('appearance:changed',async()=>{capture();try{const appearance=await bridge.invoke('app.getAppearance',{});locale=ui.localeOf(appearance.locale);document.documentElement.dataset.theme=appearance.base??'system';document.documentElement.lang=locale;render();}catch{}});}
 (async()=>{try{const appearance=await bridge.invoke('app.getAppearance',{});locale=ui.localeOf(appearance.locale);document.documentElement.dataset.theme=appearance.base??'system';}catch{}document.documentElement.lang=locale;await load(true);})();
})();
