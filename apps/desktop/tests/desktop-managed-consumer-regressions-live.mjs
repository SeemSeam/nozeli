import {projectReportEvidence} from './report-evidence.fixture.mjs';
// Opt-in real Electron/provider consumer regressions. No fixture or injected tool output.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {auditRuntime} from '../src/agents/managed/runtime-audit.mjs';

if(process.env.NOZELI_REAL_CODEX!=='1')throw Error('Explicit NOZELI_REAL_CODEX=1 provider-spending opt-in required');
const require=createRequire(import.meta.url),app=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-consumer-live-')),profile=path.join(out,'profile'),project=path.join(out,'project');
await fs.mkdir(project);await fs.writeFile(path.join(project,'material.md'),'DISK_MATERIAL_MUST_STAY\n');
const material='EXPLICIT_BUFFER_MATERIAL_731',queuedMarker='QUEUED_SUPPLEMENT_492',checks=[],errors=[];
let child,browser,page,projectId,runtimeRoot,failure,log='';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function invoke(op,p={}){const result=await page.evaluate(({op,p})=>window.nozeli.invoke(op,p),{op,p});if(!result.ok)throw Error(op+': '+JSON.stringify(result.error));return result.value;}
const state=async()=>(await invoke('managed.status',{projectId})).state;
async function wait(fn,label,timeout=360000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await fn())return;await pause(200);}throw Error('Timed out: '+label);}
function check(label,value){assert(value,label);checks.push(label);console.log(JSON.stringify({check:label,out}));}
async function launch(){
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
 const env={...process.env,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_TEST_INSTANCE:'1',NOZELI_HIDDEN:'0',NOZELI_DEBUG_PORT:String(port)};delete env.ELECTRON_RUN_AS_NODE;delete env.NOZELI_AGENT_FIXTURE;
 child=spawn(require('electron'),[path.join(app,'src/main/main.cjs'),...(env.WAYLAND_DISPLAY?['--ozone-platform=wayland']:[])],{cwd:app,env,stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);
 await wait(async()=>{try{browser=await require('puppeteer-core').connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:{width:1440,height:900}});return true;}catch{return false;}},'Electron debugging endpoint',30000);
 page=(await browser.pages()).find(page=>page.url().startsWith('http://127.0.0.1:'));assert(page);page.on('pageerror',error=>errors.push(error.message));
 await page.waitForFunction(()=>window.__nozeliReady===true,{timeout:30000});
}
async function close(){if(!child||child.exitCode!==null)return;const exited=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));await invoke('session.requestClose');assert.deepEqual(await Promise.race([exited,pause(20000).then(()=>null)]),{code:0,signal:null});await browser.disconnect();browser=null;page=null;}
async function sidebar(){if(await page.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true'))await page.click('#toggle-sidebar');}
async function openReport(work){await sidebar();const todo=(await state()).todos.findLast(todo=>todo.workId===work.id&&todo.kind==='result'&&todo.status==='open');assert(todo);await page.click('[data-managed-todo="'+todo.id+'"]');await page.waitForSelector('[data-managed-end-result]');return todo;}
async function compose(text){await page.$eval('#composer',(node,text)=>{node.value=text;node.dispatchEvent(new Event('input',{bubbles:true}));},text);}
async function archive(label){await fs.writeFile(path.join(out,label+'.json'),JSON.stringify(await state(),null,2));await page.screenshot({path:path.join(out,label+'.png'),fullPage:true});}
async function waitReview(name,afterRevision=-1){await wait(async()=>{const snapshot=await state(),work=snapshot.works.find(work=>work.name===name);const failed=snapshot.jobs.findLast(job=>job.status==='failed');if(failed)throw Error(failed.error);return work?.status==='review'&&work.revision>afterRevision&&!snapshot.busyTargets.includes(work.id)&&!snapshot.jobs.some(job=>['queued','running'].includes(job.status)&&(job.target===work.id||job.context?.boundWorkId===work.id));},name+' report');return (await state()).works.find(work=>work.name===name);}
try{
 await launch();await page.click('#pick-project');await wait(async()=>(await invoke('project.recent')).projects.length===1,'project selection',30000);projectId=(await invoke('project.recent')).projects[0].id;
 if(await page.$('#agent-setup[open]'))await page.click('#agent-managed-enable');await wait(async()=>(await invoke('managed.status',{projectId})).ready,'resident readiness');runtimeRoot=(await invoke('managed.status',{projectId})).runtimeRoot;
 await invoke('managed.limit',{projectId,limit:1});
 await invoke('managed.send',{projectId,target:'frontdesk',requestKey:randomUUID(),relPath:'material.md',materialText:material,text:'这是独立执行目标，请转交原文并创建名称严格为“材料交接”的工作。只使用本条显式附带材料，不把磁盘材料当成缓冲内容。创建result.txt，内容必须原样包含显式材料标记；读回验证并用nozeli_publish result发布带[result.txt](result.txt)链接的报告，files列出result.txt。不操作Git、不联网、不自行结束工作。'});
 const first=await waitReview('材料交接'),firstThread=first.threadId,firstRevision=first.revision;
 let snapshot=await state();const firstReceipt=snapshot.receipts.findLast(receipt=>receipt.workId===first.id&&receipt.kind==='result');assert(firstReceipt);
 check('real Frontdesk transfers explicit buffered material through Orchestrator to Worker',snapshot.jobs.some(job=>job.type==='front'&&job.status==='completed')&&snapshot.jobs.some(job=>job.type==='intake'&&job.routing?.workId===first.id));
 assert.equal(await fs.readFile(path.join(project,'material.md'),'utf8'),'DISK_MATERIAL_MUST_STAY\n');await assert.rejects(fs.stat(path.join(project,'result.txt')),{code:'ENOENT'});
 const artifact=await invoke('managed.artifact.read',{projectId,objectId:firstReceipt.objectId,relPath:'result.txt'});check('candidate output uses supplied material while original project stays unchanged',artifact.text.includes(material));
 await openReport(first);await compose('保留的未发送原Worker草稿');await wait(async()=>(await state()).drafts[first.id]==='保留的未发送原Worker草稿','durable composer draft');
 await page.click('[data-managed-end-result]');await page.waitForFunction(()=>document.querySelector('#managed-review-error')?.textContent.includes('未发送草稿'));
 check('accept rejection preserves original Worker draft and readable report',(await state()).works.find(work=>work.id===first.id).status==='review'&&await page.$eval('#composer',node=>node.value==='保留的未发送原Worker草稿'));
 await compose('');await invoke('managed.draft',{projectId,target:first.id,text:''});
 await invoke('managed.send',{projectId,target:first.id,requestKey:randomUUID(),text:'继续同一Work修改result.txt，保留原有标记并追加一行SAME_WORK_REVISION_2。实际读回验证后发布新result，报告附[result.txt](result.txt)，files列出result.txt；不结束工作，不操作Git。'});
 const updated=await waitReview('材料交接',firstRevision);check('discussion revises original Worker, thread and Work',updated.id===first.id&&updated.threadId===firstThread&&updated.revision>firstRevision);
 await openReport(updated);const updatedReceipt=(await state()).receipts.findLast(receipt=>receipt.workId===updated.id&&receipt.kind==='result');assert(updatedReceipt);
 await page.click('#managed-doc .conversation-file-link[data-path="result.txt"]');
 const reviewTab=await wait(async()=>{for(const candidate of await browser.pages()){if(candidate===page||!candidate.url().startsWith('http://127.0.0.1/'))continue;const scope=await candidate.evaluate(()=>window.__nozeliReady===true&&window.__workspaceScope?.kind==='document'?window.__workspaceScope:null).catch(()=>null);if(scope&&scope.relPath==='result.txt'&&scope.documentSource?.type==='review'&&scope.documentSource.objectId===updatedReceipt.objectId)return candidate;}return false;},'unified review document tab from report candidate link');
 await reviewTab.waitForFunction(()=>document.body.textContent.includes('SAME_WORK_REVISION_2')&&(document.querySelector('#file-section-label')?.textContent||'').includes('审核候选'));
 check('report candidate entry opens the unified review document tab with the frozen candidate bytes, never the missing original');
 await invoke('managed.task',{projectId,requestKey:randomUUID(),text:'新建独立工作，名称严格为“排队材料”。创建queued.txt，写QUEUE_RESULT。接收排队中的用户补充时也原样保留其额外标记。读回验证并发布result，files列出queued.txt。不操作Git、不联网、不自行结束工作。'});
 await wait(async()=>(await state()).works.some(work=>work.name==='排队材料'&&work.status==='queued'),'independent queued work');const queued=(await state()).works.find(work=>work.name==='排队材料');
 await invoke('managed.send',{projectId,target:queued.id,requestKey:randomUUID(),text:'补充原任务：queued.txt还必须包含'+queuedMarker+'；保持同一Work，不另建任务。'});
 check('queued supplement stays bound without a replacement Work',(await state()).works.length===2);
 await openReport(updated);page.once('dialog',dialog=>dialog.accept());await page.click('[data-managed-end-result]');await wait(async()=>{const work=(await state()).works.find(work=>work.id===first.id);return work.status==='ended'&&work.outcome==='accept'&&work.closure?.phase==='complete';},'accepted technical closure');
 assert((await fs.readFile(path.join(project,'result.txt'),'utf8')).includes('SAME_WORK_REVISION_2'));
 const second=await waitReview('排队材料'),secondReceipt=(await state()).receipts.findLast(receipt=>receipt.workId===second.id&&receipt.kind==='result');
 check('released quota executes original queued supplement',(await invoke('managed.artifact.read',{projectId,objectId:secondReceipt.objectId,relPath:'queued.txt'})).text.includes(queuedMarker));
 const history=await invoke('managed.history.list',{projectId,offset:0,limit:50});const old=await invoke('managed.history.read',{projectId,objectId:firstReceipt.objectId,version:history.version});check('superseded accepted report remains readable by immutable identity',(await projectReportEvidence(invoke,projectId,old.objectId)).body===await fs.readFile(path.join(runtimeRoot,'objects',firstReceipt.report.objectId+(firstReceipt.report.format==='html-static'?'.html':'.md')),'utf8'));
 await openReport(second);await compose('重启后保留的讨论草稿');await wait(async()=>(await state()).drafts[second.id]==='重启后保留的讨论草稿','restart draft persistence');const before=await state();await archive('before-restart');await close();await launch();await wait(async()=>(await invoke('managed.status',{projectId})).ready,'restart readiness');snapshot=await state();
 check('restart retains original thread, report and draft without replay',snapshot.jobs.length===before.jobs.length&&snapshot.works.find(work=>work.id===second.id).threadId===second.threadId&&snapshot.drafts[second.id]==='重启后保留的讨论草稿');
 await invoke('managed.draft',{projectId,target:second.id,text:''});await openReport(second);await compose('');page.once('dialog',dialog=>dialog.accept());await page.$$eval('#managed-result-actions button',nodes=>nodes.find(node=>node.textContent==='丢弃成果并结束').click());
 await wait(async()=>{const work=(await state()).works.find(work=>work.id===second.id);return work.status==='ended'&&work.outcome==='discard'&&work.closure?.phase==='complete';},'discard technical closure');await assert.rejects(fs.stat(path.join(project,'queued.txt')),{code:'ENOENT'});
 check('discard never adopts candidate, and its frozen report artifact stays readable',(await invoke('managed.artifact.read',{projectId,objectId:secondReceipt.objectId,relPath:'queued.txt'})).text.includes(queuedMarker));
 assert.equal(await fs.readFile(path.join(project,'material.md'),'utf8'),'DISK_MATERIAL_MUST_STAY\n');assert.deepEqual(errors,[]);await archive('ended');await close();
}catch(error){failure=error;console.error(error.stack);if(page){await archive('failure').catch(()=>{});await close().catch(()=>{});}}
finally{
 if(browser)await browser.disconnect().catch(()=>{});if(child?.exitCode===null){child.kill('SIGTERM');await pause(2000);if(child.exitCode===null)child.kill('SIGKILL');}
 const audit=runtimeRoot?await auditRuntime(runtimeRoot):null;if(audit&&(audit.processes.length||audit.authCopies.length))failure??=Error('owned runtime cleanup incomplete');
 await fs.writeFile(path.join(out,'electron.log'),log);await fs.writeFile(path.join(out,'result.json'),JSON.stringify({pass:!failure,error:failure?.stack,checks,errors,audit,out,scope:'real Electron/provider; explicit material handoff, Work-bound discussion, queue, drafts, immutable report/artifact UI and restart; Linux only'},null,2));
 console.log(JSON.stringify({pass:!failure,out,checks}));if(failure)process.exitCode=1;
}
