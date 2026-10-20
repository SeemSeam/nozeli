// Actual Electron UI + real IPC/Workspace files. Provider-only fixture; no paid model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
const app=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),pause=ms=>new Promise(r=>setTimeout(r,ms));
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-todo-gui-')),project=path.join(out,'project'),profile=path.join(out,'profile'),home=path.join(out,'home');
await fs.mkdir(project);await fs.mkdir(home);await fs.writeFile(path.join(project,'paper.md'),'# 合成用户文档\n正文必须保留。\n');
const checks=[],errors=[];let child,browser,page,projectId,runtime,log='';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const invoke=async(op,p={})=>{const r=await page.evaluate(({op,p})=>nozeli.invoke(op,p),{op,p});assert.equal(r.ok,true,op+': '+JSON.stringify(r.error));return r.value;};
const snapshot=async()=> (await invoke('managed.status',{projectId})).state;
const check=(label,condition)=>{assert.ok(condition,label);checks.push(label);};
async function launch(){
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const env={...process.env,HOME:home,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_TEST_INSTANCE:'1',NOZELI_HIDDEN:'0',NOZELI_DEBUG_PORT:String(port)};delete env.ELECTRON_RUN_AS_NODE;delete env.NOZELI_AGENT_FIXTURE;
 child=spawn(require('electron'),['--ozone-platform=wayland',path.join(app,'tests/todo-management-entry.cjs')],{cwd:app,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 for(let i=0;i<300;i++){if(child.exitCode!==null)throw Error(log);try{browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:{width:1300,height:900}});break;}catch{}await pause(100);}
 assert.ok(browser,'Electron attached');page=(await browser.pages()).find(p=>p.url().includes('127.0.0.1'));page.on('pageerror',e=>errors.push(e.stack));
 await page.waitForFunction(()=>window.__nozeliReady,{timeout:30000});
 if(!projectId){await page.click('#pick-project');await page.waitForSelector('#file-tree button');projectId=(await invoke('project.recent')).projects[0].id;}
 await invoke('managed.enable',{projectId});runtime=(await invoke('managed.status',{projectId})).runtimeRoot;
 await page.reload();await page.waitForFunction(()=>window.__nozeliReady);await page.waitForSelector('#managed-todo-filters:not([hidden])',{timeout:30000});
 if(await page.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await page.click('#toggle-sidebar');
}
async function close(){if(!child||child.exitCode!==null)return;const exit=new Promise(resolve=>child.once('exit',resolve));await invoke('session.requestClose');await Promise.race([exit,pause(15000).then(()=>{throw Error('owned app close timeout');})]);await browser.disconnect();browser=null;}
const filter=async value=>{await page.click(`[data-todo-filter="${value}"]`);};
const row=id=>`[data-todo-row="${id}"]`;
const menuAction=async id=>{await page.waitForSelector('#managed-todo-menu:not([hidden])');const b=await page.$eval(`#managed-todo-menu [data-command="${id}"]`,n=>n.getBoundingClientRect().toJSON());assert.ok(b.width&&b.height,'menu item visible');await page.mouse.click(b.x+b.width/2,b.y+b.height/2);};
try{
 await launch();const initial=await snapshot(),system=initial.todos.find(t=>t.kind==='system'),problem=initial.todos.find(t=>t.kind==='problem'),completed=initial.todos.find(t=>t.kind==='result');assert.ok(system&&problem&&completed);
 const sources=hash({messages:initial.messages,receipts:initial.receipts,works:initial.works,jobs:initial.jobs,git:initial.gitRecovery}),paper=hash(await fs.readFile(path.join(project,'paper.md'),'utf8'));
 check('默认待处理，徽标仅计系统/旧提醒/待回答',await page.$eval('[data-todo-filter="open"]',n=>n.getAttribute('aria-pressed'))==='true'&&await page.$eval('#inbox-count',n=>Number(n.textContent))===3);
 const beforePath=await page.$eval('#file-path',n=>n.textContent);
 await page.click(row(system.id),{button:'right'});await page.waitForSelector('#managed-todo-menu:not([hidden])');
 check('鼠标右键作用于该条且不打开阅读面',await page.$eval('#file-path',n=>n.textContent)===beforePath);
 await menuAction('copy');await pause(200);check('复制走真实系统剪贴板',String(await invoke('document.clipboard',{action:'read'})).includes(system.text));
 await page.click(row(system.id),{button:'right'});await menuAction('close');await page.waitForFunction(id=>!document.querySelector(`[data-todo-row="${id}"]`),{},system.id);
 let s=await snapshot();check('关闭持久化并减徽标，不改业务源或额度',s.todos.find(t=>t.id===system.id).status==='closed'&&s.quotaUsed===initial.quotaUsed&&hash({messages:s.messages,receipts:s.receipts,works:s.works,jobs:s.jobs,git:s.gitRecovery})===sources&&await page.$eval('#inbox-count',n=>Number(n.textContent))===2);
 await filter('closed');await page.waitForSelector(row(system.id));check('已关闭视图保留原文和关闭原因',(await page.$eval(row(system.id),n=>n.textContent)).includes('不代表故障已修复'));
 await page.focus(row(system.id));await page.keyboard.down('Shift');await page.keyboard.press('F10');await page.keyboard.up('Shift');await menuAction('reopen');
 await filter('open');await page.waitForSelector(row(system.id));s=await snapshot();check('Shift+F10 重开仅提醒，没有新 job/Git/额度变化',s.todos.find(t=>t.id===system.id).status==='open'&&hash({messages:s.messages,receipts:s.receipts,works:s.works,jobs:s.jobs,git:s.gitRecovery})===sources);
 await page.click(`${row(system.id)} [data-todo-more]`);await menuAction('detail');await page.waitForSelector(`[data-todo-detail="${system.id}"]`);
 await page.click(`[data-todo-detail="${system.id}"] [data-todo-action="close"]`);await filter('closed');await page.waitForSelector(row(system.id));
 check('详情有同源关闭操作',(await snapshot()).todos.find(t=>t.id===system.id).status==='closed');
 await page.click(`${row(system.id)} [data-todo-more]`);await menuAction('remove');await page.waitForSelector('#managed-todo-confirm[open]');
 check('二次确认明确不可恢复与非级联',await page.$eval('#managed-todo-confirm',n=>n.textContent.includes('无法恢复')&&n.textContent.includes('原任务')));
 await page.click('[data-todo-cancel]');check('取消彻底移除保留原记录',(await snapshot()).todos.some(t=>t.id===system.id));
 await page.click(`${row(system.id)} [data-todo-more]`);await menuAction('remove');await page.click('[data-todo-confirm]');await page.waitForFunction(id=>!document.querySelector(`[data-todo-row="${id}"]`),{},system.id);
 const disk=JSON.parse(await fs.readFile(path.join(runtime,'state.json'),'utf8')),tombstone=disk.todoTombstones.find(t=>t.todoId===system.id);
 check('确认移除正文及私有历史消失，仅留无正文墓碑',!disk.todos.some(t=>t.id===system.id)&&tombstone&&!('text'in tombstone)&&!('reason'in tombstone)&&!JSON.stringify(tombstone).includes(system.text)&&!(disk.todoManagementActions||[]).some(a=>a.todoId===system.id));
 check('移除后当前详情不残留待办正文',!await page.$eval('#managed-doc',n=>n.textContent.includes('隔离测试：真实持久系统异常')));
 check('源报告/对话/任务/Git和论文不级联删除',hash({messages:disk.messages,receipts:disk.receipts,works:disk.works,jobs:disk.jobs,git:disk.gitRecovery})===sources&&hash(await fs.readFile(path.join(project,'paper.md'),'utf8'))===paper);
 await filter('completed');check('历史首屏有界为50条',await page.$$eval('[data-todo-row]',nodes=>nodes.length)===50);await page.click('#managed-todo-more');check('加载更多显示剩余历史',await page.$$eval('[data-todo-row]',nodes=>nodes.length)===56);await page.waitForSelector(row(completed.id));check('正式认可结果进入完成历史',completed.status==='resolved'&&(await page.$eval(row(completed.id),n=>n.textContent)).includes('已完成'));
 await page.click(`${row(completed.id)} [data-todo-more]`);await menuAction('work');check('已结束任务可查看但不会重放',(await snapshot()).jobs.length===initial.jobs.length);
 await filter('open');await page.click(row(problem.id),{button:'right'});await page.waitForSelector('#managed-todo-menu:not([hidden])');
 check('活跃待回答不提供关闭/删除绕过',!await page.$('#managed-todo-menu [data-command="close"]')&&!await page.$('#managed-todo-menu [data-command="remove"]'));
 const blocked=await page.evaluate(p=>nozeli.invoke('managed.todo.manage',p),{projectId,todoId:problem.id,expectedRevision:problem.managementRevision||0,requestKey:'gui-active-protection',action:'remove'});
 check('宿主拦截活跃关键条目删除',blocked.ok===false&&(await snapshot()).works.find(w=>w.id===problem.workId).status==='paused');
 await page.keyboard.press('Escape');
 // Legacy source-less anomaly can close, then remove, without a fabricated source.
 await page.click(row('legacy-no-source'),{button:'right'});await menuAction('close');await filter('closed');await page.waitForSelector(row('legacy-no-source'));
 await page.click(`${row('legacy-no-source')} [data-todo-more]`);await menuAction('remove');await page.click('[data-todo-confirm]');await page.waitForFunction(()=>!document.querySelector('[data-todo-row="legacy-no-source"]'));
 check('无来源旧提醒可关闭并彻底移除，不伪造 revision/sourceJobId',!(await snapshot()).todos.some(t=>t.id==='legacy-no-source'));
 await filter('all');await page.screenshot({path:path.join(out,'todos-wide.png')});
 await page.setViewport({width:480,height:800});if(await page.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await page.click('#toggle-sidebar');await page.screenshot({path:path.join(out,'todos-narrow.png')});
 await close();await launch();const restored=await snapshot();
 check('真实重启不复活被删提醒，完成历史仍保留',!restored.todos.some(t=>t.id===system.id||t.id==='legacy-no-source')&&restored.todos.some(t=>t.id===completed.id&&t.status==='resolved')&&restored.jobs.length===initial.jobs.length);
 assert.deepEqual(errors,[]);await close();
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify({passed:true,checks,out,scope:'Linux Wayland real Electron; provider lifecycle fixture, no models'},null,2));console.log(JSON.stringify({passed:true,checks,out},null,2));
}catch(error){if(page){await fs.writeFile(path.join(out,'page-error.json'),JSON.stringify(await page.evaluate(()=>({errors:[],menu:document.querySelector('#managed-todo-menu')?.outerHTML,box:document.querySelector('#managed-todo-menu')?.getBoundingClientRect().toJSON(),viewport:[innerWidth,innerHeight]})).catch(()=>({})),null,2));await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}await fs.writeFile(path.join(out,'failure.txt'),String(error.stack));throw error;}
finally{await fs.writeFile(path.join(out,'electron.log'),log);if(browser)await browser.disconnect().catch(()=>{});if(child&&child.exitCode===null){child.kill('SIGTERM');await pause(1000);if(child.exitCode===null)child.kill('SIGKILL');}}
