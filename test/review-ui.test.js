'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const ui=require('../plugin/renderer/ui.js');const {lineDiff}=require('../plugin/review.js');
const item={itemId:'item-1',kind:'lesson',title:'<script>bad</script>',content:'new <img src=x>',keywords:[],analysis:{action:'create',reason:'because <script>x</script>',same:'same',changes:'change',scope:'Windows',evidence:['test <script>']} ,options:[{key:'create',label:'New'}]};
const batch={id:'batch',createdAt:'2026-10-11',analysisState:'analysed',reviewToken:'token',items:[item],display:[{index:0,state:'unreviewed',analysis:item.analysis,candidates:[{id:'old',current:true,body:'old <img src=y>',baseHash:'abc'}],diff:lineDiff('old','new'),alternatives:[]}]};
test('review UI escapes comparison and leaves every item unreviewed by default',()=>{
 const html=ui.batchHtml(batch,{locale:'en'});
 assert(!html.includes('<script>'));assert(!html.includes('<img'));assert(html.includes('&lt;script&gt;'));
 assert(html.includes('old &lt;img'));assert(html.includes('Windows'));assert(html.includes('Evidence'));
 assert(html.includes('value="unreviewed" selected'));assert(!html.includes('value="approve" selected'));
 assert(html.includes('data-revise'));assert(html.includes('diff-remove'));assert(html.includes('diff-add'));
});
test('the editor preserves its analysed action when the discovery window changes',()=>{
 const old={...item,analysis:{...item.analysis,action:'replace',targetId:'old'},options:[{key:'replace:old',action:'replace',targetId:'old',label:'Replace old'}]};
 const changed={...batch,items:[old],display:[{...batch.display[0],alternatives:[{key:'create',label:'New'}]}]};
 const html=ui.batchHtml(changed);assert(html.includes('value="replace:old" selected'));
});

test('task diagnostics distinguish supplied versions, claimed use and incomplete checks safely',()=>{
 const task={taskId:'id',goal:'<script>task</script>',boundary:'inferred',phase:'validation',state:'active',dirty:true,finishMissed:true,check:{result:'unchecked',reason:''},retrieval:{status:'no-match',corpusSize:2},surfaced:[{id:'A'}],provided:[{id:'A',complete:false,suppliedChars:20,bodyChars:100}],usedClaimed:[],pending:['KB-x'],recovery:{result:'restored'}};
 const html=ui.tasksHtml({tasks:[task],warnings:[]},'en');assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));
 assert(html.includes('Supplied'));assert(html.includes('Claimed use'));assert(html.includes('Unchecked'));assert(html.includes('no-match'));assert(html.includes('restored'));assert(html.includes('20/100'));assert(html.includes('not proof'));
});

test('bounded diff preserves text and offers parallel complete bodies for large inputs',()=>{
 assert.deepEqual(lineDiff('one\ntwo','one\nthree').lines,[{type:'same',text:'one'},{type:'remove',text:'two'},{type:'add',text:'three'}]);
 assert.equal(lineDiff('a\n'.repeat(1000),'b\n'.repeat(1000)).mode,'parallel');
 for(const key of Object.keys(ui.TEXT.en))assert(Object.hasOwn(ui.TEXT['zh-CN'],key),key);
});
