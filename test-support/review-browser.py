import json, os
from pathlib import Path
from playwright.sync_api import sync_playwright
scratch=Path(os.environ['PI_SCRATCH_DIR'])
root=Path(__file__).resolve().parents[1]
fixture=json.loads((scratch/'phase4-browser-fixture.json').read_text(encoding='utf-8'))
init='''window.fixture = %s; window.calls=[]; window.pushed={}; window.failCommit=false;window.failRevise=false;window.base='light';window.listDelay=0;
window.pluginBridge={on:(name,fn)=>window.pushed[name]=fn,invoke:async(name,payload)=>{calls.push({name,payload});if(name==='app.getAppearance')return {locale:'zh-CN',base};if(name==='task.status')return structuredClone(fixture.taskStatus??{tasks:[],warnings:[]});if(name==='inbox.list'){if(listDelay)await new Promise(r=>setTimeout(r,listDelay));return structuredClone(fixture.response);}if(name==='inbox.commit'){if(failCommit)throw Error('simulated commit failure');return {saved:[],already:[],skipped:0,pending:2,deferred:1,rejected:0,duplicate:0,warnings:[]};}if(name==='inbox.revise'){if(failRevise)throw Error('simulated revise failure');return {analysisState:'unanalysed'};}if(name==='inbox.discard')return {already:[]};throw Error(name);}};''' % json.dumps(fixture,ensure_ascii=False)
report=[]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True)
 page=browser.new_page(viewport={'width':1100,'height':900})
 errors=[]; page.on('pageerror',lambda e:errors.append(str(e)))
 page.add_init_script(init)
 page.goto((root/'plugin/renderer/index.html').as_uri())
 page.wait_for_selector('[data-choice="0"]')
 assert page.locator('[data-choice="0"]').input_value()=='unreviewed'
 assert page.locator('[data-choice="1"]').input_value()=='unreviewed'
 page.locator('[data-comparison] summary').first.click()
 assert 'Linux 使用 /usr/local/sdk。' in page.locator('[data-comparison]').first.inner_text()
 assert page.locator('.diff-remove').count()>0 and page.locator('.diff-add').count()>0
 assert '任务记忆检查' in page.locator('#task-diagnostics').inner_text()
 assert 'covered' in page.locator('#task-diagnostics').inner_text()
 assert '正文提供不证明理解' in page.locator('#task-diagnostics').inner_text()
 report.append('task diagnostics show check state without claiming understanding')
 report.append('default unreviewed and full comparison')
 page.locator('[data-editor] summary').first.click()
 area=page.locator('[data-content="0"]');area.fill('用户修改的新正文')
 page.locator('[data-choice="0"]').select_option('approve')
 page.locator('[data-commit]').click();page.wait_for_timeout(80)
 assert not page.evaluate("calls.filter(c=>c.name==='inbox.commit')")
 assert '重新分析' in page.locator('#message').inner_text()
 report.append('dirty draft cannot approve old proposal')
 # Refresh must preserve current draft, selection and caret, including input during a pending request.
 area.focus();page.evaluate("document.querySelector('[data-content=\"0\"]').setSelectionRange(2,4);fixture.response.batches[0].reviewToken='next-token';listDelay=120;window.dispatchEvent(new Event('focus'))")
 area.fill('等待刷新期间继续输入')
 page.evaluate("document.querySelector('[data-content=\"0\"]').setSelectionRange(3,5)")
 page.wait_for_timeout(220)
 assert area.input_value()=='等待刷新期间继续输入'
 assert page.evaluate("document.activeElement.dataset.content")=='0'
 assert page.evaluate("document.activeElement.selectionStart")==3
 report.append('draft and focus retained during refresh')
 # Failure cannot clear current controls or drafts.
 page.evaluate("failRevise=true;listDelay=0")
 page.locator('[data-revise="0"]').click();page.wait_for_timeout(80)
 assert area.input_value()=='等待刷新期间继续输入'
 assert 'simulated revise failure' in page.locator('#message').inner_text()
 report.append('revision failure preserves draft')
 # Explicit defer sends only item 0, not the default unreviewed sibling.
 page.locator('[data-choice="0"]').select_option('defer')
 page.evaluate('failCommit=true')
 page.locator('[data-commit]').click();page.wait_for_timeout(80)
 last=page.evaluate("calls.filter(c=>c.name==='inbox.commit').at(-1).payload")
 assert last['selections']==[{'index':0,'key':'defer'}],last
 assert area.input_value()=='等待刷新期间继续输入'
 page.evaluate('failCommit=false')
 page.locator('[data-commit]').click();page.wait_for_timeout(80)
 assert '暂缓' in page.locator('#message').inner_text()
 assert page.locator('[data-choice="1"]').input_value()=='unreviewed'
 report.append('only explicit decisions submitted; defer stays pending')
 # Request revised content and action sends a draft, not commit.
 page.evaluate('failRevise=false')
 page.locator('[data-alternative="0"]').select_option('replace:LSN-20260101-build')
 page.locator('[data-revise="0"]').click();page.wait_for_timeout(80)
 payload=page.evaluate("calls.filter(c=>c.name==='inbox.revise').at(-1).payload")
 assert payload['action']=='replace' and payload['content']=='等待刷新期间继续输入',payload
 assert '未写入正式记忆' in page.locator('#message').inner_text()
 report.append('revision requests re-analysis, not approval')
 # Theme and responsive screenshot.
 page.screenshot(path=str(scratch/'phase4-review-light.png'),full_page=True)
 page.evaluate("base='dark';pushed['appearance:changed']({locale:'zh-CN'})")
 page.wait_for_timeout(80)
 assert page.evaluate('document.documentElement.dataset.theme')=='dark'
 page.screenshot(path=str(scratch/'phase4-review-dark.png'),full_page=True)
 page.set_viewport_size({'width':480,'height':850})
 assert page.evaluate('document.documentElement.scrollWidth')<=480
 report.append('light/dark theme and narrow viewport')
 # Project switch clears old controls and input.
 page.evaluate("fixture.response.project={name:'Other',path:'/other'};fixture.response.batches=[];fixture.taskStatus={tasks:[],warnings:[]};pushed['workspace:changed']()")
 page.wait_for_timeout(80)
 assert page.locator('[data-content]').count()==0
 assert 'Other' in page.locator('#project').inner_text()
 report.append('workspace switch clears old draft')
 assert not errors,errors
 browser.close()
(scratch/'phase4-browser-report.json').write_text(json.dumps({'passed':report,'pageErrors':errors},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'passed':report,'pageErrors':errors},ensure_ascii=False))
