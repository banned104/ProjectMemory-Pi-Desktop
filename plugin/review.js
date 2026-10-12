'use strict';
const core=require('./core/index.js');
// Bounded line comparison; fallback still provides both complete originals.
function lineDiff(oldBody,newBody){
 const a=String(oldBody).split('\n'),b=String(newBody).split('\n');
 if(a.length*b.length>160000||a.length+b.length>1600)return {mode:'parallel',lines:[]};
 const rows=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)rows[i][j]=a[i]===b[j]?rows[i+1][j+1]+1:Math.max(rows[i+1][j],rows[i][j+1]);
 const lines=[];let i=0,j=0;
 while(i<a.length||j<b.length){
  if(i<a.length&&j<b.length&&a[i]===b[j]){lines.push({type:'same',text:a[i++]});j++;}
  else if(j<b.length&&(i===a.length||rows[i][j+1]>rows[i+1][j]))lines.push({type:'add',text:b[j++]});
  else lines.push({type:'remove',text:a[i++]});
 }
 return {mode:'lines',lines};
}
function reviewDisplay(batch,entries){
 return batch.items.map((item,index)=>{
  const candidates=(item.similar??[]).map(v=>{
   const entry=entries.find(e=>e.id===v.id&&e.source===v.source);
   const current=!!entry&&core.isActive(entry)&&entry.hash===v.baseHash;
   return {...v,body:current?entry.body:null,current};
  });
  const target=candidates.find(v=>v.id===item.analysis?.targetId)??candidates[0];
  const diff=target?.current?lineDiff(target.body,item.content):null;
  const fresh=core.findSimilar(entries,item,undefined,batch.locale);
  const currentOptions=(item.options??[]).filter(o=>o.action==='create'||entries.some(e=>e.id===o.targetId&&core.isActive(e)&&core.findSimilar([e],item).length));
  const choices=[...core.optionsFor(item,fresh),...currentOptions.map(o=>({...o,labelKey:o.action}))];
  const alternatives=[...new Map(choices.map(o=>[core.optionKey(o.action,o.targetId),o])).values()].map(o=>({key:core.optionKey(o.action,o.targetId),action:o.action,targetId:o.targetId,label:core.t(batch.locale,o.labelKey,o.targetId)}));
  return {index,state:core.reviewStateOf(item),analysis:item.analysis??null,candidates,diff,alternatives,newBody:item.content};
 });
}
module.exports={lineDiff,reviewDisplay};
