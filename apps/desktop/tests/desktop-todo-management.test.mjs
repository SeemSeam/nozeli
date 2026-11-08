// Real Electron, real storage/IPC/frozen reports; no provider mocks or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {managedRuntime} from '../src/agents/managed/managed-storage.mjs';
import {reportDescriptor} from '../src/agents/managed/report-descriptor.mjs';
const app=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),pause=ms=>new Promise(r=>setTimeout(r,ms));
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-readable-inbox-')),profile=path.join(out,'config/desktop'),home=path.join(out,'home'),sample=path.join(out,'sample');
await fs.mkdir(home);await fs.mkdir(sample);await fs.writeFile(path.join(sample,'paper.md'),'# 删除提醒不能改动这份文档\n');
const realSource=process.env.NOZELI_READABILITY_PROJECT?await fs.realpath(process.env.NOZELI_READABILITY_PROJECT):null;
const realRoot=realSource?path.join(out,'real-project-snapshot'):null;
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const sourceFiles=['README.md','.nozeli/project.json','.nozeli/project.sqlite'];
const sourceHashes=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async name=>[name,hash(await fs.readFile(path.join(realSource,name)))])));
const sourceBefore=realSource?await sourceHashes():null;
if(realSource){await fs.mkdir(realRoot);for(const name of ['README.md','apps/desktop/src','docs/manual-task-control-repair-design.md'])await fs.cp(path.join(realSource,name),path.join(realRoot,name),{recursive:true});}
const report={out,ok:false,checks:[],screenshots:[],scope:'Real Electron and local storage/report IPC; synthetic reminder history; real repository content copied read-only to an isolated project snapshot. No model calls.',realSource,realRoot,sourceBefore};
const host=new DesktopHost(profile),ids={},objects={};
const realEntries=realRoot?(await fs.readdir(realRoot)).sort():[];
const samplePaper=hash(await fs.readFile(path.join(sample,'paper.md'),'utf8'));
async function seed(root,label){
 const project=(await host.pick(root)).project;ids[label]=project.id;
 const store=await Workspace.open(await managedRuntime(host.storage,project.id),root,{storage:host.storage,projectId:project.id});
 const receipts=[],works=[],todos=[];
 const variants=[['discard',1,'cancelled'],['accept',2,'resolved'],['reopened',3,'open'],['current',4,'open'],['missing',5,'cancelled']];
 for(const [name,revision,status] of variants){
  const workId=randomUUID(),objectId=name==='missing'?null:randomUUID(),todoId=label+'-'+name;
  const title=label==='real'?'Nozeli 真实项目目录核对与阅读界面可读性说明':'论文参考文献核对与引用来源补充';
  works.push({id:workId,name:title,status:name==='current'?'review':'ended',revision,outcome:name==='accept'?'accept':'discard',result:objectId?{objectId,revision}:undefined,closure:name==='current'?undefined:{phase:'complete',decision:name==='accept'?'accept':'discard'}});
  todos.push({id:todoId,kind:'result',status,workId,objectId,revision,createdAt:'2026-11-02T10:00:00.000Z',...(name==='reopened'?{reopenedAt:'2026-11-02T11:00:00.000Z'}:{})});
  if(objectId){const bytes=Buffer.from(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title} · 第 ${revision} 版</title></head><body><main><h1>${title}</h1><p>冻结报告 ${label}-${name}：本报告仅供阅读，不重新执行任务。</p><p>依据：${label==='real'?'真实项目顶层目录，共 '+realEntries.length+' 项。':'隔离样本文档，原始论文内容保持不变。'}</p><p>结论：原报告与提醒生命周期独立，删除提醒不删除报告。</p></main></body></html>`);await store.putObject(bytes);receipts.push({id:randomUUID(),objectId,workId,revision,kind:'result',at:'2026-11-02T10:00:00.000Z',report:reportDescriptor(bytes,{format:'html-static',objectId})});objects[todoId]=objectId;}
 }
 // These are historical diagnostics, not fresh unhandled recovery requests.
 const diagnosticJob={id:label+'-diagnostic-source',target:'orchestrator',type:'maintenance',status:'completed',diagnosticOnly:true};
 for(const kind of ['system','recovery','attention','queue'])for(const status of ['open','resolved','closed'])todos.push({id:label+'-internal-'+kind+status,sourceJobId:diagnosticJob.id,kind,status,title:'连接与恢复待处理',text:'INTERNAL_PROTOCOL_DIAGNOSTIC',userActionable:false});
 await store.mutate(()=>Object.assign(store.state,{works,todos,receipts,jobs:[diagnosticJob],messages:[],drafts:{frontdesk:'未发送草稿应保留'},limit:4}));
 await store.close();await host.storage.putLocal(project.id,'managed:binding',{schema:1,enabled:true,roles:{frontdesk:{provider:'pi'},orchestrator:{provider:'pi'},worker:{provider:'pi'}}});
}
await seed(sample,'sample');if(realRoot)await seed(realRoot,'real');await host.storage.db.close();
let child,browser,shell,exit,log='';const errors=[];
async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(child?.exitCode!==null)throw Error('App exited: '+log);const result=await fn();if(result)return result;await pause(70);}throw Error('Timeout '+label);}
async function invoke(op,p={}){const r=await shell.evaluate(({op,p})=>window.nozeli.invoke(op,p),{op,p});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
async function state(id){return (await invoke('managed.status',{projectId:id})).state;}
async function launch(){
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const env={...process.env};for(const k of Object.keys(env))if(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||k==='ELECTRON_RUN_AS_NODE')delete env[k];
 Object.assign(env,{HOME:home,NOZELI_CONFIG_ROOT:path.join(out,'config'),NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
 child=spawn(require('electron'),[path.join(app,'src/main/main.cjs'),'--ozone-platform='+ (process.env.NOZELI_OZONE||'wayland')],{cwd:app,env,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',v=>log+=v);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
 for(const p of await browser.pages())p.on('pageerror',e=>errors.push(e.message));browser.on('targetcreated',async t=>(await t.page().catch(()=>null))?.on('pageerror',e=>errors.push(e.message)));
}
async function select(label){await shell.click('#recent [data-project-id="'+ids[label]+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,ids[label]),'select '+label);await shell.waitForSelector('#managed-todo-filters:not([hidden])');if(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await shell.click('#toggle-sidebar');}
async function menuAction(id){const selector='#managed-todo-menu:not([hidden]) [data-command="'+id+'"]';await shell.waitForSelector(selector,{visible:true});await shell.click(selector);}
async function filter(name){if(['closed','all'].includes(name)){await shell.click('#managed-todo-filter-more');await menuAction(name);}else await shell.click('[data-todo-filter="'+name+'"]');}
async function surface(todoId){return until(async()=>{for(const p of await browser.pages())if(await p.evaluate(id=>window.__nozeliReady&&window.__workspaceScope?.resourceId===id,todoId).catch(()=>false))return p;},'report surface '+todoId);}
async function shot(page,name){const file=path.join(out,name+'.png');await page.screenshot({path:file});report.screenshots.push(file);}
async function reportBody(todoId,expected){await shell.click('[data-managed-todo="'+todoId+'"]');const page=await surface(todoId);const preview=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(text=>document.body?.innerText.includes(text),expected).catch(()=>false))return p;},'frozen HTML body');await shot(preview,todoId+'-actual-report');return page;}
async function close(){await invoke('session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});await browser.disconnect();browser=null;child=null;}
try{
 await launch();await shell.evaluate(()=>{window.__attentionEvents=[];document.addEventListener('nozeli-sidebar-attention',event=>window.__attentionEvents.push(event.detail));});await select('sample');const before=await state(ids.sample),source={works:before.works,receipts:before.receipts,jobs:before.jobs,drafts:before.drafts,messages:before.messages};
 assert.deepEqual(await shell.$$eval('[data-todo-row]',ns=>ns.map(n=>n.dataset.todoRow)),['sample-current']);
 await until(()=>shell.evaluate(id=>window.__attentionEvents.some(event=>event.projectId===id&&!event.loading&&!event.stale&&event.pendingCount===1),ids.sample),'authoritative sidebar attention event');
 assert.equal(await shell.$eval('#managed-todo-summary',node=>node.hidden),true);
 assert.equal(await shell.$eval('[data-todo-row="sample-current"]',node=>node.dataset.severity),'review');
 assert.equal(await shell.$('.managed-todo-unread'),null,'unread decorations are not projected');
 await shell.click('[data-todo-row="sample-current"] [data-todo-more]');await menuAction('read');
 assert.equal(await shell.$('.managed-todo-unread'),null);
 assert.equal((await state(ids.sample)).todos.find(todo=>todo.id==='sample-current').status,'open');
 await invoke('managed.attention.ack',{projectId:ids.sample,ids:['sample-current'],occurrences:[{id:'sample-current',interrupted:false}]});
 assert.equal((await state(ids.sample)).todos.find(todo=>todo.id==='sample-current').status,'open');
 assert.equal((await invoke('project.attention.summary',{projectIds:[ids.sample]})).projects[0].pendingCount,1);
 report.checks.push('Explicit mark-read and reminder acknowledgement retain the authoritative pending obligation without numeric or unread sidebar UI');
 for(const view of ['completed','closed','all','open']){await filter(view);assert.equal(await shell.$$eval('[data-todo-row]',ns=>ns.some(n=>n.innerText.includes('连接与恢复')||n.dataset.todoRow.includes('internal'))),false);}
 report.checks.push('All user filters exclude internal connection/recovery/system/queue records; only current review obligation is pending');
 await filter('completed');assert(await shell.$('[data-todo-row="sample-reopened"]'));const versions=await shell.$$eval('.managed-todo-secondary',ns=>ns.map(n=>n.innerText));assert(versions.some(t=>t.includes('第 1 版')&&t.includes('已丢弃')));assert(versions.some(t=>t.includes('历史提醒已重开')));await shot(shell,'history-light');
 const page=await reportBody('sample-discard','冻结报告 sample-discard');assert.equal(await page.$$eval('[data-managed-end-result],[data-report-discuss]',ns=>ns.filter(n=>n.checkVisibility()).length),0);await shot(page,'historical-report');report.checks.push('Discarded history opens its exact frozen report, version and outcome read-only without routing through metadata-only record');
 await shell.click('#managed-todo-filters');await shell.focus('[data-todo-row="sample-discard"] [data-managed-todo]');await shell.keyboard.down('Shift');await shell.keyboard.press('F10');await shell.keyboard.up('Shift');await menuAction('remove');await shell.waitForSelector('#managed-todo-confirm[open]');assert(await shell.$eval('[data-todo-cancel]',n=>document.activeElement===n));await shell.click('[data-todo-cancel]');assert((await state(ids.sample)).todos.some(t=>t.id==='sample-discard'));
 await shell.click('[data-todo-row="sample-discard"] [data-todo-more]');await menuAction('remove');await shell.waitForSelector('#managed-todo-confirm[open]');await shell.click('[data-todo-confirm]');await until(async()=>!(await state(ids.sample)).todos.some(t=>t.id==='sample-discard'),'reminder deletion');
 const after=await state(ids.sample);assert.deepEqual({works:after.works,receipts:after.receipts,jobs:after.jobs,drafts:after.drafts,messages:after.messages},source);assert((await invoke('managed.history.read',{projectId:ids.sample,objectId:objects['sample-discard']})).report);assert.equal(hash(await fs.readFile(path.join(sample,'paper.md'),'utf8')),samplePaper);
 assert(await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>document.body?.innerText.includes('冻结报告 sample-discard')).catch(()=>false))return true;},'report remains visible after reminder deletion'));
 report.checks.push('Keyboard menu removal supports cancel and confirm; only reminder disappears, report/drafts/task/file source remains unchanged and visible');
 await reportBody('sample-reopened','冻结报告 sample-reopened');await shell.click('[data-todo-row="sample-reopened"] [data-todo-more]');await menuAction('remove');await shell.waitForSelector('#managed-todo-confirm[open]');await shell.click('[data-todo-confirm]');await until(async()=>!(await state(ids.sample)).todos.some(t=>t.id==='sample-reopened'),'reopened history removed');
 await filter('open');await shell.click('[data-todo-row="sample-current"] [data-todo-more]');await shell.waitForSelector('#managed-todo-menu:not([hidden])');assert.equal(await shell.$('#managed-todo-menu [data-command="remove"]'),null);await shell.keyboard.press('Escape');
 const denied=await shell.evaluate(p=>window.nozeli.invoke('managed.todo.manage',p),{projectId:ids.sample,todoId:'sample-current',expectedRevision:0,action:'remove',requestKey:'deny-current-obligation'});assert.equal(denied.ok,false);report.checks.push('Reopened ended reminder stays historical and removable; active review cannot be deleted from UI or host API');
 await filter('completed');await shell.click('[data-managed-todo="sample-missing"]');const missing=await surface('sample-missing');await missing.waitForFunction(()=>document.querySelector('#managed-doc')?.innerText.includes('报告暂不可读取'));report.checks.push('Missing report displays explicit unreadable reason instead of an empty record');
 if(realRoot){await select('real');await filter('completed');await shot(shell,'real-project-history-light');await reportBody('real-accept','冻结报告 real-accept');report.checks.push('A read-only copy of real repository content is opened as an isolated project; history report renders snapshot inventory context');}
 for(const theme of ['dark','light']){await shell.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await filter('completed');await shot(shell,'sidebar-'+theme);}
 await shell.setViewport({width:390,height:844});await shell.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));if(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await shell.click('#toggle-sidebar');await shell.waitForSelector('#managed-todo-filter-more',{visible:true});await until(()=>shell.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'390px no document overflow');await shot(shell,'sidebar-390');await shell.click('#managed-todo-filter-more');await shell.waitForSelector('#managed-todo-menu:not([hidden])');await shell.keyboard.press('Escape');assert(await shell.$eval('#managed-todo-filter-more',n=>document.activeElement===n&&n.getAttribute('aria-expanded')==='false'));await shell.keyboard.press('Enter');await shell.waitForSelector('#managed-todo-menu:not([hidden])');await shell.keyboard.press('Escape');report.checks.push('Dark/light and 390px screenshots captured; overflow menu is keyboard-operable and Escape restores focus');
 await close();await launch();await select('sample');await filter('completed');const restored=await state(ids.sample);assert(!restored.todos.some(t=>['sample-discard','sample-reopened'].includes(t.id)));assert((await invoke('managed.history.read',{projectId:ids.sample,objectId:objects['sample-discard']})).report);assert.deepEqual(restored.jobs,source.jobs);assert.equal(restored.agents.length,0);await close();
 if(realSource){assert.deepEqual(await sourceHashes(),sourceBefore);report.sourceAfter=await sourceHashes();}assert.deepEqual(errors,[]);report.checks.push('Normal restart does not resurrect deleted reminders; preserved report still reads; no new jobs or native agents; original README and project metadata digests unchanged');report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{if(child&&child.exitCode===null){try{await close();}catch{child?.kill('SIGTERM');}}await browser?.disconnect().catch(()=>{});await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
