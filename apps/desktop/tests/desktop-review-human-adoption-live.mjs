import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';

// Natural Chinese journey, real private Pi/tools/files + actual X11 window pixels.
// The local HTTP response is scripted, not model-understanding evidence.
const app=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),exec=promisify(execFile);
assert(process.env.DISPLAY,'M5 composite evidence requires an actual X11/XWayland display; no DOM substitute');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-ux-batch2-zh-')),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),root=path.join(out,'组会材料');
await fs.mkdir(root);
const relPath='笔记/访谈摘要.md';
const source='# 组会材料\n\n访谈为合成样本：10人中8人来自同一实验室，未做长期追踪。\n';
await fs.writeFile(path.join(root,'材料说明.md'),source);
const host=new DesktopHost(profile),project=(await host.pick(root)).project;await host.storage.db.close();
const request='请整理一份访谈摘要，说明主要发现、样本局限和还需核对的内容，供组会审阅。';
const question='这里的十人样本为什么不能代表所有研究者？先解释，不要增加结论。';
const modification='把结论写得更简洁，明确说明没有做长期追踪。';
const unsent='我还想补充跨实验室样本的讨论，这条意见先留着，不发送。';
const originalCandidate='# 访谈摘要\n\n## 主要发现\n参与者希望更快找到原文依据，并保留自己的阅读笔记。\n\n## 样本局限\n共10位合成参与者，8位来自同一实验室，不能代表所有研究者。\n\n## 待核对\n没有长期追踪，尚不能判断持续使用效果。\n';
const revisedCandidate='# 访谈摘要\n\n## 主要发现\n本组样本重视原文依据与笔记保留。\n\n## 样本局限\n10位合成参与者中8位来自同一实验室，不代表所有研究者。没有长期追踪，持续使用效果待核对。\n';
const humanNote='\n## 我的审阅补充\n采用时保留这条人工说明：样本仅用于流程演示，不作为研究结论。\n';
const htmlReport=version=>`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>访谈摘要 · 第${version}版</title><style>body{font:16px/1.9 system-ui;margin:0;padding:28px;color:inherit}h1{font-size:26px}h2{font-size:19px}main{max-width:720px;margin:auto}aside{border-left:3px solid currentColor;padding:10px 15px;opacity:.85}</style></head><body><main><h1>访谈摘要</h1><p>本报告基于合成访谈材料，供组会审阅与交互验证。</p><h2>结论</h2><p>${version===1?'参与者希望更快定位依据、保留阅读笔记。样本集中在单一实验室，尚不能外推总体。':'本组样本重视依据定位与笔记保留，不能代表所有研究者。没有长期追踪，持续效果待核对。'}</p><h2>改动文件</h2><p><a href="${relPath}">${relPath}</a> · 候选文件，采用前不写入项目。</p><aside><b>尚未核实</b><br>没有独立用户研究；不声称AI推理或长期效果已验证。人工修改保存在文件审阅稿中，旧报告正文不会随之改写。</aside><h2>依据与范围</h2><p>10位合成参与者，8位来自同一实验室，未作长期追踪。请结合原材料和自己的判断采用。</p></main></body></html>`;
const text=m=>typeof m.content==='string'?m.content:m.content?.filter(p=>p.type==='text').map(p=>p.text).join('')||'';
const calls=[];
const provider=await serve(r=>{
 const names=r.tools?.map(t=>t.function?.name)||[];
 if(names.includes('nozeli_dispatch'))return {tool:'nozeli_dispatch',id:'zh-dispatch',args:{name:'访谈摘要',brief:request+' 候选相对路径为'+relPath+'。'}};
 const inputs=r.messages.filter(m=>m.role==='user').map(text);
 const phase=inputs.findLast(t=>[question,modification].includes(t.trim()))?.trim();calls.push(phase||'初稿');
 if(phase===question)return {text:'十人样本主要来自同一实验室，来源集中，且没有长期追踪。因此只能描述这组材料，不能代表所有研究者。这一解释不改变报告结论，当前版本保留。'};
 const version=phase===modification?2:1,id=version===1?'zh-initial-write':'zh-revised-write';
 if(!r.messages.some(m=>m.tool_call_id===id))return {tool:'write',id,args:{path:relPath,content:version===1?originalCandidate:revisedCandidate}};
 return {tool:'nozeli_publish',id:version===1?'zh-publish-1':'zh-publish-2',args:{kind:'result',content:htmlReport(version),files:[relPath]}};
});
let child,browser,shell,review,doc,observer,exit,log='',windowId;const errors=[];
const report={ok:false,out,version:'0.1.0-alpha.5-source-ux-batch2',scope:'Actual Electron/private Pi/native files and X11 window capture, Chinese scripted local Provider, no paid model/user project',steps:[],screenshots:[],checks:[],notCovered:['真实模型理解','Windows/macOS','R01/R02与未知效果恢复','同文件合入冲突解决']};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('App exited '+log);const v=await fn();if(v)return v;await pause(70);}throw Error('Timeout '+label);}
async function invoke(page,op,p={}){const r=await page.evaluate(({op,p})=>window.nozeli.invoke(op,p),{op,p});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
report.binary=process.env.NOZELI_TEST_BINARY||require('electron');
if(process.env.NOZELI_REVIEW_VISUAL_ONLY==='1')report.version='0.1.0-alpha.5-installed-approval-ux-batch1-20261105-local-01';
const state=async()=> (await invoke(shell,'managed.status',{projectId:project.id})).state;
async function shot(name){
 await review.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 // X11 reads the compositor-backed window, not CDP DOM. Allow its next paint
 // after native guest geometry/visibility acknowledgements before acquisition.
 await pause(300);
 const file=path.join(out,name+'.png');
 // Capture only the owned app window, not the root desktop or unrelated windows.
 await exec('import',['-window',windowId,file],{timeout:10000});
 const geometry=await invoke(shell,'workspace.control',{type:'window-control',action:'state'});
 report.screenshots.push({file,name,capture:'actual-X11-owned-window-including-native-child-views',geometry});
}
async function activePage(kind){return until(async()=>{for(const p of await browser.pages())if(await p.evaluate(kind=>window.__nozeliReady&&window.__workspaceScope?.kind===kind,kind).catch(()=>false))return p;},kind);}
async function submit(value){await review.waitForFunction(()=>{const n=document.querySelector('[data-review-instruction]');return n&&!n.disabled&&!n.readOnly;});await review.$eval('[data-review-instruction]',(n,t)=>{n.value=t;n.dispatchEvent(new Event('input',{bubbles:true}));},value);await review.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});await review.click('[data-review-action="send"]');await until(async()=>{const s=await state(),j=s.jobs.find(j=>j.text===value);if(j&&['failed','unknown'].includes(j.status))throw Error(JSON.stringify(j));return j?.status==='completed'&&s.works[0].status==='review';},'中文讨论完成');report.steps.push({action:'发送讨论',text:value});}
async function resize(width,height){await invoke(shell,'workspace.control',{type:'window-control',action:'resize',width,height});await review.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
try{
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});const env={...process.env};for(const k of Object.keys(env))if(k!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||['ELECTRON_RUN_AS_NODE','NODE_OPTIONS'].includes(k)))delete env[k];Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_OZONE:'x11'});
 child=spawn(process.env.NOZELI_TEST_BINARY||require('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform=x11','--inspect=0'],{cwd:root,env,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=b);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');browser.on('targetcreated',async t=>{const p=await t.page().catch(()=>null);p?.on('pageerror',e=>errors.push(e.message));});shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
 observer=await MainObserver.connect(await until(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'native observer'));
 windowId=await observer.evaluate(`(()=>{const {BaseWindow}=process.mainModule.require('electron');const win=BaseWindow.getAllWindows().find(w=>!w.isDestroyed());if(!win)throw Error('Owned native window not ready');win.show();win.focus();return '0x'+win.getNativeWindowHandle().readUInt32LE(0).toString(16);})()`);
 await invoke(shell,'config.initialize',{mode:'independent'});if(await shell.$eval('#configuration-setup',n=>n.open).catch(()=>false))await shell.click('#configuration-cancel');await invoke(shell,'settings.providers.save',{operation:'create',provider:'zh-review-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-nonsecret'}});const model={model:{mode:'explicit',selector:'zh-review-local/scripted'},thinking:{mode:'native-default'}};await invoke(shell,'settings.models.save',{frontdesk:model,orchestrator:model,worker:model});
 await shell.click('[data-project-id="'+project.id+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,project.id),'project');await invoke(shell,'managed.enable',{projectId:project.id});await invoke(shell,'managed.task',{projectId:project.id,text:request,requestKey:'zh-review-natural-task'});
 const initial=await until(async()=>{const s=await state();if(s.jobs.some(j=>j.status==='failed'))throw Error(JSON.stringify(s.jobs));return s.works[0]?.status==='review'&&!s.jobs.some(j=>['queued','running'].includes(j.status))?s:null;},'初稿待审');const work=initial.works[0],thread=work.threadId,todo=initial.todos.find(t=>t.workId===work.id&&t.kind==='result'&&t.status==='open');
 if(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await shell.click('#toggle-sidebar');await shell.waitForSelector('[data-managed-todo="'+todo.id+'"]',{visible:true});await shell.click('[data-managed-todo="'+todo.id+'"]');review=await activePage('report');await review.waitForSelector('[data-review-discussion]',{visible:true});await review.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
 for(const width of [1440,800]){await resize(width,width===800?650:900);await shot('01-读中文报告与讨论-'+width);}
 report.steps.push({action:'待办进入审阅',report:'访谈摘要初稿',files:[relPath]});
 await submit(question);await review.waitForFunction(()=>document.querySelector('[data-review-discussion-history]')?.textContent.includes('十人样本主要来自同一实验室'));
 await review.waitForFunction(()=>{const e=document.querySelector('[data-review-instruction]');return e&&!e.disabled&&!e.readOnly;});
 await review.$eval('[data-review-discussion-history]',e=>{e.scrollTop=e.scrollHeight;});await shot('02-自然中文解释-800');
 await submit(modification);const updated=(await state()).works[0].result.objectId;await until(()=>review.$('[data-review-action="latest-discussion"]:not([hidden])'),'新版入口');await review.click('[data-review-action="latest-discussion"]');await until(()=>review.evaluate(id=>window.__workspaceScope.viewState.report.objectId===id,updated),'新版报告');await review.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
 await review.$eval('[data-review-instruction]',(n,t)=>{n.value=t;n.dispatchEvent(new Event('input',{bubbles:true}));},unsent);await review.click('[data-review-action="hide-discussion"]');await shot('03-收起继续读中文报告-800');await review.click('[data-review-action="open-discussion"]');assert.equal(await review.$eval('[data-review-instruction]',n=>n.value),unsent);await shot('04-展开保留意见-800');report.steps.push({action:'收起继续读→展开',retainedDraft:unsent});
 if(process.env.NOZELI_REVIEW_VISUAL_ONLY==='1'){
  await review.waitForSelector('[data-review-action="accept"]:not([disabled])',{visible:true});await review.click('[data-review-action="accept"]');await review.waitForSelector('[data-confirmation-dialog][open]');report.confirmation=await review.$eval('[data-confirmation-dialog]',n=>n.innerText);await shot('00-原版采用确认-800');await review.click('[data-confirmation-cancel]');
  report.mode='visual-only-baseline';report.ok=true;report.providerCalls=provider.requests.length;report.scriptPhases=calls;
  report.checks.push('仅中文阅读／讨论／收起展开实际窗口基线，不执行或声称人工采用通过');
 }else{
 await review.waitForSelector('[data-review-file="'+relPath+'"]',{visible:true});await review.click('[data-review-file="'+relPath+'"]');doc=await activePage('document');await doc.waitForFunction(()=>window.__nozeliInput?.text().includes('访谈摘要'));const beforeHuman=await doc.evaluate(()=>window.__nozeliInput.text());assert.equal(beforeHuman,revisedCandidate);
 await doc.bringToFront();await doc.evaluate(t=>{window.__nozeliInput.focus();const text=window.__nozeliInput.text();window.__nozeliInput.select(text.length,text.length);window.__nozeliInput.insert(t);},humanNote);await doc.keyboard.down('Control');await doc.keyboard.press('s');await doc.keyboard.up('Control');
 const humanText=beforeHuman+humanNote;await until(async()=>{const r=await invoke(doc,'managed.review.read',{projectId:project.id,workId:work.id,objectId:updated,relPath});return r.files?.some(f=>f.relPath===relPath&&f.draft?.text===humanText);},'人工审阅稿持久保存');
 await assert.rejects(fs.stat(path.join(root,relPath)),{code:'ENOENT'});await shot('05-人工直接改稿已保存-800');report.steps.push({action:'人工编辑候选→Ctrl+S',relPath,text:humanText,projectStillMissing:true});
 const layout=await shell.evaluate(()=>window.__workspaceGroups.snapshot()),viewId=await review.evaluate(()=>window.__workspaceScope.viewId);await invoke(shell,'workspace.command',{projectId:project.id,expectedRevision:layout.revision,requestKey:'zh-return-report',command:{type:'activate',viewId}});await review.waitForFunction(()=>!document.querySelector('[data-review-action="accept"]').disabled);
 for(const width of [800,1440]){await resize(width,width===800?650:900);await shot('06-人工稿返回审阅-'+width);}
 await review.click('[data-review-action="accept"]');await review.waitForSelector('[data-confirmation-dialog][open]');const confirmation=await review.$eval('[data-confirmation-dialog]',n=>n.innerText);report.confirmation=confirmation;assert(confirmation.includes(relPath),'confirmation names actual file');assert(confirmation.includes('人工'),'confirmation identifies manual version');assert(confirmation.includes('不会')&&confirmation.includes('AI'),'confirmation states unsent opinions are not sent');await shot('07-采用人工稿单层确认-1440');await review.click('[data-confirmation-cancel]');assert.equal(await review.$eval('[data-review-instruction]',n=>n.value),unsent);assert.equal((await state()).works[0].status,'review');await assert.rejects(fs.stat(path.join(root,relPath)),{code:'ENOENT'});
 await review.click('[data-review-action="accept"]');await review.waitForSelector('[data-confirmation-dialog][open]');await review.click('[data-confirmation-confirm]');await until(async()=>{const w=(await state()).works[0];if(w.closure?.phase==='blocked')throw Error(JSON.stringify(w.closure));return w.status==='ended'&&w.closure?.phase==='complete';},'人工稿实际合入');
 assert.equal(await fs.readFile(path.join(root,relPath),'utf8'),humanText);assert.equal(await fs.readFile(path.join(root,'材料说明.md'),'utf8'),source);const final=await state();assert.equal(final.works.length,1);assert.equal(final.works[0].threadId,thread);assert.equal(final.jobs.some(j=>j.text===unsent),false);assert.equal(await review.$eval('[data-review-instruction]',n=>n.value),unsent);assert.deepEqual(provider.errors,[]);assert.deepEqual(errors,[]);report.steps.push({action:'返回审阅保留草稿→明确采用人工稿',exactFile:relPath,mergedText:humanText,unsentDispatched:false,workStatus:final.works[0].status});report.checks.push('自然中文原任务及同线程讨论','主工作区正文与标签窗实际X11同帧','收起恢复正文且意见保留','人工直接编辑候选保存后原项目未改','单层确认实际路径/人工稿/未发送意见','采用文件逐字等于人工稿且ended/complete');report.providerCalls=provider.requests.length;report.scriptPhases=calls;report.ok=true;
 }
 observer.close();observer=null;
 await invoke(shell,'session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;
}catch(error){report.error=error.stack;process.exitCode=1;await review?.screenshot({path:path.join(out,'failure-dom.png')}).catch(()=>{});if(windowId)await shot('failure-composite').catch(()=>{});report.visible=await review?.evaluate(()=>document.body.innerText.slice(-7000)).catch(()=>null);}
finally{observer?.close();if(child?.exitCode===null){try{await invoke(shell,'session.requestClose');await Promise.race([exit,pause(10000)]);}catch{}if(child.exitCode===null)child.kill('SIGTERM');}await browser?.disconnect().catch(()=>{});await provider.close();report.errors=errors;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
