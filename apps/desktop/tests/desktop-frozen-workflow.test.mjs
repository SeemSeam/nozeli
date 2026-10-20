import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {prepareReading} from './reading-setup.fixture.mjs';
import {prepareFrozenWorkflow,git} from './desktop-frozen-workflow.fixture.mjs';

// Full Linux product consumer acceptance, not a component harness or paid run.
// No routes, preload replacements, injected controllers or fake Git sides.
const root=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-frozen-workflow-'));
const checks=[],errors=[],screenshots=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let fixture,child,exited,browser,page,log='',stage='fixture',normalClose=false;
async function invoke(op,payload={}) {
  const result=await page.evaluate((op,payload)=>window.nozeli.invoke(op,payload),op,payload);
  assert.equal(result.ok,true,`${op}: ${JSON.stringify(result.error)}`);return result.value;
}
async function screenshot(name){const file=path.join(out,name+'.png');await page.screenshot({path:file});screenshots.push(file);}
async function clickProject(id){
  const selector=`[data-project-id="${id}"]`;
  await page.waitForSelector(selector);await page.$eval(selector,node=>node.click());
}
async function back(){await page.$eval('.frozen-change-reader .document-diff-head button',node=>node.click());await page.waitForFunction(()=>!document.querySelector('.frozen-change-reader'));}
async function openDiff(){
  await page.waitForSelector(`[data-frozen-file="${fixture.fileId}"]`);
  await page.$eval(`[data-frozen-file="${fixture.fileId}"]`,node=>node.scrollIntoView({block:'center'}));
  await page.click(`[data-frozen-file="${fixture.fileId}"]`);
  await page.waitForSelector('.frozen-change-reader .cm-mergeView',{visible:true});
}
async function retainedState(){return page.evaluate(()=>({same:window.__frozenWorkflowEditor===document.querySelector('#text-host .cm-editor'),text:window.__nozeliInput.text(),selection:window.__nozeliInput.selection(),scroll:document.querySelector('#text-host .cm-scroller').scrollTop,draft:document.querySelector('#composer').value}));}
async function report(ok,error){await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok,stage,error:error?.stack,platform:process.platform,evidence:'Full production Electron/main/preload/IPC/React/reader with independent preloaded synthetic native history and actual Git commits; no model run. No Windows/macOS claim.',checks,screenshots,errors,normalClose,out,identity:fixture&&{projectId:fixture.a.id,workId:fixture.workId,jobId:fixture.jobId,revision:1,receiptId:fixture.receiptId,changeSetId:fixture.changeSetId,inputCommit:fixture.inputCommit,candidateCommit:fixture.candidateCommit}},null,2));}
try {
  assert.equal(process.platform,'linux','This journey is certified only for Linux');
  fixture=await prepareFrozenWorkflow(out);
  const gitBefore=await git(fixture.project,['status','--porcelain=v1']);
  const expectedSides=await Promise.all([fixture.inputCommit,fixture.candidateCommit].map(commit=>git(fixture.project,['show',commit+':'+fixture.relPath])));
  stage='launch actual product';
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
  const ozone=process.env.NOZELI_OZONE||'headless';
  child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform='+ozone],{cwd:root,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:fixture.configRoot,NOZELI_USER_DATA:fixture.profile,NOZELI_TEST_PICK:fixture.project,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_HIDDEN:process.env.NOZELI_TEST_VISIBLE==='1'?'0':'1',NOZELI_OZONE:ozone},stdio:['ignore','pipe','pipe']});
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
  exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  for(let attempt=0;attempt<150;attempt++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{if(child.exitCode!==null||child.signalCode)throw Error(log);await pause(100);}}
  assert(browser,'Production Electron endpoint did not start: '+log);
  const target=await browser.waitForTarget(t=>t.type()==='page'&&t.url().startsWith('http://127.0.0.1:'),{timeout:30000});
  page=await target.page();page.on('pageerror',error=>errors.push(error.stack));
  await prepareReading(page);
  assert.equal((await invoke('config.status')).initialized,false,'Cancel configuration, never initialize a provider');
  await invoke('session.resize',{width:1440,height:1000});await page.waitForFunction(()=>innerWidth===1440);
  await clickProject(fixture.a.id);
  await page.waitForSelector(`[data-frozen-file="${fixture.fileId}"]`);
  let status=await invoke('managed.status',{projectId:fixture.a.id});
  assert.equal(status.ready,false);assert.equal(status.enabled,true);
  assert.deepEqual(Object.keys(status.state.providers||{}),[]);
  const receipt=status.state.receipts.find(r=>r.id===fixture.receiptId);
  assert.deepEqual([receipt.workId,receipt.jobId,receipt.revision,receipt.changeSetId],[fixture.workId,fixture.jobId,1,fixture.changeSetId]);
  assert(status.state.timeline.entries.some(entry=>entry.jobId===fixture.jobId));
  assert.equal(await page.$eval('.session-worker details',node=>node.open),false);
  assert.equal(await page.$eval(`[data-frozen-file="${fixture.fileId}"]`,node=>node.closest('details')===null),true);
  checks.push('Production Controller archive projection reaches collapsed React Worker with external real-Git files, without provider connection');

  stage='retain unsaved editor and draft';
  await page.click('#file-tree button[data-path="reading.txt"]');
  await page.waitForSelector('#text-host .cm-content',{visible:true});
  assert.equal(await page.$eval('#composer',node=>node.value),'Preloaded main draft — never send');
  await page.click('#composer');await page.type('#composer',' + locally unsent');
  await page.click('#text-host .cm-content');await page.keyboard.down('Control');await page.keyboard.press('Home');await page.keyboard.up('Control');
  await page.keyboard.type('UNSAVED-WORKFLOW ');
  await page.evaluate(()=>{window.__nozeliInput.select(2,12);window.__frozenWorkflowEditor=document.querySelector('#text-host .cm-editor');document.querySelector('#text-host .cm-scroller').scrollTop=520;});
  const before=await retainedState();assert.notEqual(before.text,fixture.source);assert(before.scroll>0);
  assert.equal(await fs.readFile(path.join(fixture.project,'reading.txt'),'utf8'),fixture.source,'Unsaved input stays out of source');
  stage='real click reads retained Merge Diff';await openDiff();
  const renderedSides=await page.$$eval('.frozen-change-reader .cm-mergeView .cm-content',nodes=>nodes.map(node=>node.textContent.trim()));
  assert.deepEqual(renderedSides,expectedSides,'Merge Diff renders actual retained Git sides, not live file or authored labels');
  assert.equal(await page.$$eval('.frozen-change-reader .cm-content',nodes=>nodes.every(node=>node.getAttribute('contenteditable')==='false')),true,'Both MergeView editors are read-only');
  for(const width of [1440,800,390]){
    await invoke('session.resize',{width,height:1000});await page.waitForFunction(width=>innerWidth===width,{},width);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`No document overflow at ${width}`);
    await screenshot('frozen-diff-'+width);
  }
  await invoke('session.resize',{width:1440,height:1000});await page.waitForFunction(()=>innerWidth===1440);
  await back();assert.deepEqual(await retainedState(),before,'Back retains identical editor DOM, buffer, selection, scroll and main draft');
  await page.focus('#text-host .cm-content');await page.keyboard.down('Control');await page.keyboard.press('z');await page.keyboard.up('Control');
  await page.waitForFunction(source=>window.__nozeliInput.text()===source,{},fixture.source);
  assert.equal(await page.evaluate(()=>window.__frozenWorkflowEditor===document.querySelector('#text-host .cm-editor')),true,'Undo executes in retained original editor');
  checks.push('Physical unsaved typing, exact retained DOM/selection/scroll/draft, read-only real MergeView and preserved undo chain');

  stage='read same history after worktree cleanup';await fixture.removeWorktree();
  await openDiff();assert.equal(await page.$eval('.frozen-change-reader .document-diff-title',node=>node.textContent.includes('冻结变更')),true);
  await screenshot('history-after-source-gc');await back();
  const historical=await invoke('managed.changes.read',{projectId:fixture.a.id,changeSetId:fixture.changeSetId,fileId:fixture.fileId});
  assert.equal(historical.availability,'available');
  assert.equal((await invoke('managed.status',{projectId:fixture.a.id})).state.works.find(w=>w.id===fixture.workId).status,'ended');
  checks.push('Same immutable changeSet is consumed after ended Work, actual worktree deletion, branch deletion and source Git GC');

  stage='cross-project pending read isolation';
  // Queue a real click/read immediately before project navigation. No transport
  // interception or artificial delayed/fabricated IPC response is installed.
  await page.$eval(`[data-frozen-file="${fixture.fileId}"]`,node=>node.click());
  await clickProject(fixture.b.id);
  await page.waitForSelector('#file-tree button[data-path="other.txt"]');
  await page.click('#file-tree button[data-path="other.txt"]');
  await page.waitForFunction(()=>document.querySelector('#file-path').textContent==='other.txt');
  await page.waitForFunction(()=>!document.querySelector('.frozen-change-reader'));
  const forged=await page.evaluate(payload=>window.nozeli.invoke('managed.changes.read',payload),{projectId:fixture.b.id,changeSetId:fixture.changeSetId,fileId:fixture.fileId});
  assert.equal(forged.ok,false);assert.equal(forged.error.code,'CHANGES_BINDING');
  assert.equal(await page.$(`[data-frozen-file="${fixture.fileId}"]`),null);
  await screenshot('other-project-isolated');
  checks.push('Real queued read/navigation cannot leave old overlay or files in other project; real IPC rejects cross-project capability');
  stage='return to historical project';await clickProject(fixture.a.id);await openDiff();await back();
  for(const width of [1440,800,390]){
    await invoke('session.resize',{width,height:1000});await page.waitForFunction(width=>innerWidth===width,{},width);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Timeline does not overflow at ${width}`);
    await screenshot('product-timeline-'+width);
  }
  await invoke('session.resize',{width:1440,height:1000});await page.waitForFunction(()=>innerWidth===1440);
  status=await invoke('managed.status',{projectId:fixture.a.id});assert.equal(status.ready,false);assert.deepEqual(Object.keys(status.state.providers||{}),[]);
  assert.equal((await invoke('config.status')).initialized,false);
  assert.equal(await git(fixture.project,['status','--porcelain=v1']),gitBefore,'Viewing and unsaved input never write project Git/source');
  assert.deepEqual(errors,[]);
  stage='normal product close';void page.evaluate(()=>window.nozeli.invoke('session.requestClose',{})).catch(()=>{});
  assert.deepEqual(await Promise.race([exited,pause(15000).then(()=>null)]),{code:0,signal:null});normalClose=true;
  await browser.disconnect();browser=null;checks.push('Normal production close completes with exit 0; isolated profile and evidence retained');
  await report(true);console.log(JSON.stringify({ok:true,out,checks},null,2));
} catch(error) {
  await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
  await report(false,error);console.error('Frozen product journey failed at '+stage+'; artifacts: '+out+'\n'+log);throw error;
} finally {
  await fs.writeFile(path.join(out,'electron.log'),log);await browser?.disconnect();
  if(child?.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await Promise.race([exited,pause(5000)]);if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await exited;}}
}
