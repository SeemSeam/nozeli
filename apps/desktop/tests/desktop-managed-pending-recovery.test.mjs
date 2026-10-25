import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {managedRuntime,listManagedPending,readManagedState} from '../src/agents/managed/managed-storage.mjs';

const root=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-managed-pending-recovery-'));
const project=path.join(out,'project'),offline=path.join(out,'offline'),configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop'),downloads=path.join(out,'downloads');
await fs.mkdir(project);await fs.mkdir(downloads);
const original=Buffer.from('Immutable managed pending recovery source.\n原始依据，不能改写。\n');
await fs.writeFile(path.join(project,'source.txt'),original);
const sourceDigest=createHash('sha256').update(original).digest('hex');
const receiptId='electron-pending-static-report',jobId='completed-static-report-job';
const html='<!doctype html><html><head><meta charset="utf-8"><title>Retained pending recovery 9421</title></head><body><h1>完整保留报告 9421</h1><p>Exact retained static HTML bytes; no model or native execution.</p></body></html>';
const seedHost=new DesktopHost(profile);
let store,seed;
try{
  const registered=await seedHost.registerDirectory(project);
  const binding=await seedHost.storage.requireRegistered(registered.id);
  store=await Workspace.open(await managedRuntime(seedHost.storage,binding.id),project,{storage:seedHost.storage,projectId:binding.id});
  const work=await store.submit('Retain the prepared report without replay','Inspect and explicitly reconcile retained result');await store.activate(work.id);
  // The synthetic completed fixture turn is explicit business input, not a fake
  // provider/session. The report still passes the production source-job gate.
  await store.mutate(()=>{(store.state.jobs??=[]).push({id:jobId,target:work.id,revision:1,type:'initial',text:'Prepared static report fixture',status:'completed',finishedAt:new Date().toISOString()});});
  await seedHost.storage.closeProjectHandles(binding.id);
  await fs.rename(project,offline);
  await assert.rejects(store.publish(work.id,1,'result',html,receiptId,{jobId}),error=>['PROJECT_ROOT_MISSING','PROJECT_UNAVAILABLE'].includes(error.code));
  const pending=await listManagedPending(seedHost.storage,binding.id);
  const business=pending.find(row=>row.kind==='business'&&row.collections?.managed_receipts?.some(row=>row.value.id===receiptId));assert(business,'Real failed publication must retain a business candidate');
  const receipt=business.collections.managed_receipts.find(row=>row.value.id===receiptId).value;
  assert.equal(receipt.sourceJobId,jobId);assert.equal(receipt.report.format,'html-static');
  const objects=pending.filter(row=>row.kind==='object');assert(objects.some(row=>row.digest===receipt.report.digest),'Real object fallback must be pending');
  const bytes=await store.readObject(receipt.report.digest);assert.match(bytes.toString(),/完整保留报告 9421/);
  await fs.writeFile(path.join(out,'expected-retained.html'),bytes);
  seed={projectId:binding.id,workId:work.id,pendingId:business.id,objectId:receipt.objectId,report:receipt.report,bytes};
}finally{if(store&&!store.closed)await store.close();await seedHost.storage.db.close();}
await fs.rename(offline,project);

const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
let child,browser,exited,log='';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const deadline=Date.now()+90000;while(Date.now()<deadline){const value=await check();if(value)return value;await pause(100);}throw Error(label+'\n'+log);}
function launch(){child=spawn(process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(root,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{cwd:root,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_TEST_PICK:project,NOZELI_CONFIG_ROOT:configRoot,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes;});exited=new Promise(resolve=>child.once('exit',resolve));}
async function connect(){await until(async()=>{try{browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});return true;}catch{return false;}},'Electron unavailable');}
async function shellPage(){return until(async()=>{for(const page of await browser.pages()){const scope=await page.evaluate(async()=>(await window.nozeli.invoke('workspace.bootstrap',{})).value).catch(()=>null);if(scope?.role==='shell'){await page.waitForFunction(()=>window.__nozeliReady);if(await page.$eval('#configuration-setup',node=>node.open).catch(()=>false))await page.click('#configuration-cancel');return page;}}},'Shell unavailable');}
async function call(page,op,payload={}){const result=await page.evaluate((op,payload)=>window.nozeli.invoke(op,payload),op,payload);assert.equal(result.ok,true,op+': '+JSON.stringify(result));return result.value;}
async function stop(){await browser?.disconnect();browser=null;if(child?.exitCode===null){child.kill('SIGTERM');await exited;}}
async function durableState(){const host=new DesktopHost(profile);try{return await readManagedState(host.storage,seed.projectId);}finally{await host.storage.db.close();}}
function assertNoReplay(state){assert.equal(state.jobs.length,1);assert.equal(state.jobs[0].id,jobId);assert.equal(state.jobs[0].status,'completed');assert(!state.jobs.some(job=>['queued','running'].includes(job.status)));assert(state.works.every(work=>!work.threadId));}
async function history(page){const query=await call(page,'managed.history.list',{projectId:seed.projectId,offset:0,limit:50});const entry=query.items.find(row=>row.objectId===seed.objectId);assert(entry,'Normal history must list reconciled immutable report');assert.equal(entry.report.digest,seed.report.digest);const read=await call(page,'managed.history.read',{projectId:seed.projectId,objectId:seed.objectId,version:query.version});assert.equal(read.objectVerified,true);assert.equal(read.report.digest,seed.report.digest);assert.equal(read.byteLength,seed.bytes.length);assert.equal(read.bodyAvailability,'isolated-source-only');const status=await call(page,'managed.status',{projectId:seed.projectId});assert.equal(status.ready,false);assert.equal(status.enabled,false);return {query,read};}
try{
  launch();await connect();let shell=await shellPage();assert.equal((await call(shell,'workspace.bootstrap')).projectId,null,'Recovery must work with no active project');
  const listed=await call(shell,'workspace.recovery.list');assert(listed.entries.some(entry=>entry.project.id===seed.projectId&&entry.id===seed.pendingId));
  const cdp=await shell.createCDPSession();await cdp.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await shell.click('#open-settings');
  await shell.waitForSelector('[data-settings-section="settings-recovery"]');
  await shell.waitForFunction(()=>{const badge=document.getElementById('settings-recovery-count');return !badge.hidden&&Number(badge.textContent)>0;},'recovery count badge must show retained records');
  await shell.click('[data-settings-section="settings-recovery"]');
  // Select the visible receipt and business type, not DOM internals or source text.
  await shell.waitForFunction(receiptId=>[...document.querySelectorAll('#settings-recovery section')].some(section=>{try{const value=JSON.parse(section.querySelector('pre').textContent);return value.kind==='business'&&value.reports?.some(report=>report.id===receiptId);}catch{return false;}}),{},receiptId);
  await shell.screenshot({path:path.join(out,'recovery-center-pending.png')});
  const receiptSection=await shell.evaluateHandle(receiptId=>[...document.querySelectorAll('#settings-recovery section')].find(section=>{try{const value=JSON.parse(section.querySelector('pre').textContent);return value.kind==='business'&&value.reports?.some(report=>report.id===receiptId);}catch{return false;}}),receiptId);
  await receiptSection.evaluate(section=>[...section.querySelectorAll('button')].find(button=>button.textContent==='查看并导出保留报告').click());
  const exported=await until(async()=>fs.readFile(path.join(downloads,'retained-'+receiptId+'.html')).catch(()=>null),'Retained HTML export unavailable');assert.deepEqual(exported,seed.bytes);
  await shell.waitForFunction(marker=>[...document.querySelectorAll('#settings-recovery section pre')].some(pre=>pre.textContent.includes(marker)),{},'完整保留报告 9421');
  await shell.screenshot({path:path.join(out,'recovery-center-report.png')});
  shell.once('dialog',dialog=>dialog.accept());
  await receiptSection.evaluate(section=>[...section.querySelectorAll('button')].find(button=>button.textContent==='核对并恢复到项目…').click());
  await shell.waitForFunction(()=>[...document.querySelectorAll('#settings-recovery section button')].some(button=>button.textContent==='已恢复 · 未重新派工'));
  assert.equal((await call(shell,'workspace.bootstrap')).projectId,null,'Explicit settlement must not activate project or start execution');
  await shell.screenshot({path:path.join(out,'recovery-center-settled.png')});
  await shell.evaluate(()=>document.getElementById('settings-dialog').close());
  await shell.waitForSelector(`#recent [data-project-id="${seed.projectId}"]`);await shell.click(`#recent [data-project-id="${seed.projectId}"]`);
  await until(async()=>(await call(shell,'workspace.bootstrap')).projectId===seed.projectId,'Recent project activation missing');
  const firstHistory=await history(shell);await stop();const firstState=await durableState();assertNoReplay(firstState);assert(firstState.receipts.some(receipt=>receipt.id===receiptId));
  launch();await connect();shell=await shellPage();
  if((await call(shell,'workspace.bootstrap')).projectId!==seed.projectId){await shell.waitForSelector(`#recent [data-project-id="${seed.projectId}"]`);await shell.click(`#recent [data-project-id="${seed.projectId}"]`);await until(async()=>(await call(shell,'workspace.bootstrap')).projectId===seed.projectId,'Cold project activation missing');}
  const coldHistory=await history(shell);assert.equal(coldHistory.read.report.digest,firstHistory.read.report.digest);await stop();const coldState=await durableState();assertNoReplay(coldState);assert.equal(coldState.receipts.filter(receipt=>receipt.id===receiptId).length,1);
  assert.deepEqual(await fs.readFile(path.join(project,'source.txt')),original);
  const report={ok:true,out,projectId:seed.projectId,pendingId:seed.pendingId,receiptId,objectId:seed.objectId,reportDigest:seed.report.digest,sourceDigest,exportByteLength:exported.length,jobs:coldState.jobs.map(({id,status})=>({id,status})),screenshots:['recovery-center-pending.png','recovery-center-report.png','recovery-center-settled.png'],checks:['real root loss retains publication objects and business candidate','empty-shell recovery center inspects and exports exact static HTML bytes','explicit confirmation reconciles under production lifecycle gate','real recent-project UI and managed.history consumers read reconciled report','cold restart persists report without queued/running jobs or native/model execution','original source remains unchanged']};
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await browser?.pages().then(pages=>pages.find(page=>page.url().startsWith('http://127.0.0.1:'))?.screenshot({path:path.join(out,'failure.png')})).catch(()=>{});await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:false,out,error:error.stack},null,2));throw error;}
finally{await fs.writeFile(path.join(out,'electron.log'),log);await stop();}
