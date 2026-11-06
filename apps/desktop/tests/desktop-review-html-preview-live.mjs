import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';
import {prepareFrozenWorkflow} from './desktop-frozen-workflow.fixture.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {staticReport} from './static-report.fixture.mjs';

const app=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),exec=promisify(execFile),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-review-html-'));
const fixture=await prepareFrozenWorkflow(out),report={ok:false,out,checks:[],screenshots:[],scope:'Actual Electron, real frozen HTML/JS/text/deleted/binary files and report footer navigation; prepared real ledger, no model run or user project.'};
const original='<html><body>PROJECT_ORIGINAL_MUST_NOT_PREVIEW</body></html>',deleted='Original text retained in the frozen input baseline.\n';
await fs.writeFile(path.join(fixture.project,'candidate.html'),original);
await fs.writeFile(path.join(fixture.project,'candidate.js'),'document.body.dataset.source="WRONG_PROJECT"');
await fs.writeFile(path.join(fixture.project,'old.md'),deleted);
await fs.copyFile(path.join(app,'tests/fixtures/tex/pipeline.png'),path.join(fixture.project,'old.png'));
const originalPngHash=createHash('sha256').update(await fs.readFile(path.join(fixture.project,'old.png'))).digest('hex');
const c=await Controller.open({storage:fixture.storage,projectId:fixture.a.id,runtimeRoot:fixture.runtimeRoot,contentRoot:fixture.project});let work,receipt,todo;
try{
 work=await c.store.submit('审阅网页效果、源码和删除文件的真实交付物','Report-first delivered files and frozen diff',{name:'HTML成果与交付物Diff'});await c.store.activate(work.id);work=c.store.find(work.id);await c.execution.prepare(work.id);
 const directory=c.execution.directory(work.id);
 await fs.writeFile(path.join(directory,'candidate.html'),'<!doctype html><html><head><meta charset="utf-8"></head><body><h1>候选网页交付物</h1><p>CANDIDATE_NEW_CONTENT</p><button id="increment">计算</button><output id="result">0</output><script src="candidate.js"></script></body></html>');
 await fs.writeFile(path.join(directory,'candidate.js'),'let n=0;document.body.dataset.source="FROZEN_CANDIDATE";document.querySelector("#increment").onclick=()=>document.querySelector("#result").textContent=String(++n);');
 await fs.writeFile(path.join(directory,'added.txt'),'NEW_FROZEN_DELIVERABLE\n');
 await fs.rm(path.join(directory,'old.md'));await fs.rm(path.join(directory,'old.png'));
 const job={id:'review-html-job',revision:work.revision},receiptId='review-html-result',files=[{relPath:'candidate.html'},{relPath:'candidate.js'},{relPath:'added.txt'}];
 await c.execution.publish(work,job,()=>true,async(manifest,candidate)=>{
  const binding={projectId:fixture.a.id,workId:work.id,revision:job.revision,jobId:job.id,receiptId,repo:manifest.repo,commonDir:manifest.commonDir,inputCommit:manifest.inputCommit,candidateCommit:candidate.commit};
  receipt=await c.store.publish(work.id,job.revision,'result',staticReport('报告仍是阅读主体；交付物在底部逐文件查看，并能打开输入→候选冻结Diff。'),receiptId,{jobId:job.id,files,retainCandidate:async()=>{
   const retained=await c.changes.capture(binding);return {...retained,rollback:()=>c.changes.discardUnpublished(retained.changeSetId,binding)};
  }});
  assert(receipt.changeSetId,'this exact publication must retain its own frozen change set');
  await c.changes.list({changeSetId:receipt.changeSetId,expectedBinding:binding});
  return {changeSetId:receipt.changeSetId};
 },{receiptId,explicitFiles:files.map(file=>file.relPath)});
 await c.store.settle(work.id);todo=c.store.state.todos.find(t=>t.workId===work.id&&t.objectId===receipt.objectId&&t.kind==='result');assert(todo);
}finally{await c.stop();}
let child,browser,shell,doc,review,observer,windowId,exit,log='';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=30000){const deadline=Date.now()+ms;while(Date.now()<deadline){if(child&&(child.exitCode!==null||child.signalCode))throw Error('app exited '+log);const v=await fn();if(v)return v;await pause(60);}throw Error('Timeout '+label);}
async function call(op,p={},page=shell){const r=await page.evaluate(({op,p})=>window.nozeli.invoke(op,p),{op,p});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
async function active(kind,relPath){return until(async()=>{for(const p of await browser.pages())if(await p.evaluate(({kind,relPath})=>window.__nozeliReady&&window.__workspaceScope?.kind===kind&&(!relPath||(kind==='diff'?window.__workspaceScope.viewState?.target?.relPath:window.__workspaceScope.relPath)===relPath),{kind,relPath}).catch(()=>false))return p;},kind+' '+(relPath||''));}
async function assertDiscussionClosed(){
 const scopes=await Promise.all((await browser.pages()).map(page=>page.evaluate(()=>window.__workspaceScope).catch(()=>null)));
 assert.equal(scopes.some(scope=>scope?.role==='review-discussion'&&scope.projectId===fixture.a.id&&scope.workId===work.id),false,'cold browsing must not create a native discussion window');
 const native=await observer.evaluate(`(async()=>{const {BrowserWindow}=process.mainModule.require('electron');return Promise.all(BrowserWindow.getAllWindows().filter(win=>!win.isDestroyed()).map(async win=>({visible:win.isVisible(),scope:await win.webContents.executeJavaScript('window.__workspaceScope || null').catch(()=>null)})));})()`);
 assert.equal(native.some(({scope})=>scope?.role==='review-discussion'&&scope.projectId===fixture.a.id&&scope.workId===work.id),false,'cold report browsing must not allocate even a hidden native discussion child');
}
async function returnReport(){const viewId=await review.evaluate(()=>window.__workspaceScope.viewId);await shell.waitForSelector('[data-editor-view="'+viewId+'"]',{visible:true});await shell.click('[data-editor-view="'+viewId+'"]');await until(()=>shell.evaluate(id=>Boolean(document.querySelector('[data-workspace-content][data-view-id="'+id+'"]')),viewId),'opened-report user navigation');await assertDiscussionClosed();}
async function reportGuest(){
 await review.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
 const key=await review.$eval('.managed-report-body .isolated-viewport',n=>n.dataset.previewKey),snapshot=await call('isolated-preview.snapshot',{key},review);
 return until(async()=>{for(const page of await browser.pages())if(page.url().startsWith(snapshot.origin+'/'))return page;},'own frozen report guest');
}
async function appendixLink(action,relPath){
 const page=await reportGuest();await page.waitForSelector('[data-nozeli-report-endmatter]');
 const selector=await page.evaluate(({action,relPath})=>{
  const section=document.querySelector('[data-nozeli-report-endmatter]'),row=[...section.querySelectorAll('li')].find(node=>node.querySelector('.nozeli-end-path')?.textContent===relPath),link=row?.querySelector('[data-nozeli-endmatter-action="'+action+'"]');
  if(!link)return null;
  const url=new URL(link.href);if(url.origin!==location.origin||!/^\/__nozeli_report_end__\/[a-z0-9]+\/(file|diff)\/\d+$/.test(url.pathname))throw Error('appendix link must use the frozen guest nonce dispatcher');
  return '[data-nozeli-report-endmatter] a[href="'+CSS.escape(link.getAttribute('href'))+'"]';
 },{action,relPath});
 assert(selector,'actual appendix '+action+' link for '+relPath);return {page,selector};
}
async function openAppendix(action,relPath){const {page,selector}=await appendixLink(action,relPath);await page.$eval(selector,node=>node.scrollIntoView({block:'center'}));await page.click(selector);}
async function preview(){const key=await doc.$eval('#web-preview-pane .isolated-viewport',n=>n.dataset.previewKey),s=await call('isolated-preview.snapshot',{key},doc);return until(async()=>{for(const p of await browser.pages())if(p.url().startsWith(s.origin+'/'))return p;},'candidate native preview');}
async function shot(page,name){
 const file=path.join(out,name+'.png'),clip=path.join(out,name+'-frames.mkv'),previous=report.screenshots.at(-1)?.file;let changedPixels=null,attempt=0;
 const url=page.url();await until(()=>observer.evaluate(`(()=>{const {BaseWindow}=process.mainModule.require('electron');return BaseWindow.getAllWindows().some(win=>(win.contentView.children||[]).some(view=>view.getVisible?.()&&view.webContents?.getURL()===${JSON.stringify(url)}));})()`),'expected native content visible for '+name);
 for(;attempt<6;attempt++){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await observer.evaluate(`(async()=>{const {BaseWindow}=process.mainModule.require('electron');const contains=view=>view.webContents?.getURL()===${JSON.stringify(url)}||(view.children||[]).some(contains),win=BaseWindow.getAllWindows().find(win=>contains(win.contentView));if(!win)throw Error('native owner not found');win.show();win.focus();const capture=async view=>{if(!view.getVisible?.())return;if(view.webContents&&!view.webContents.isDestroyed())await view.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});for(const child of view.children||[])await capture(child);};for(const view of win.contentView.children||[])await capture(view);return true;})()`,15000);
  const info=(await exec('xwininfo',['-id',windowId],{timeout:5000})).stdout,width=Number(/Width:\s+(\d+)/.exec(info)?.[1]),height=Number(/Height:\s+(\d+)/.exec(info)?.[1]);assert(width>0&&height>0);
  await exec('ffmpeg',['-y','-loglevel','error','-f','x11grab','-framerate','10','-draw_mouse','0','-window_id',windowId,'-video_size',width+'x'+height,'-i',process.env.DISPLAY,'-t','1.2','-c:v','ffv1','-pix_fmt','bgr0',clip],{timeout:10000});
  await exec('ffmpeg',['-y','-loglevel','error','-sseof','-0.15','-i',clip,'-frames:v','1',file],{timeout:10000});
  if(!previous)break;
  const comparison=await exec('compare',['-metric','AE',previous,file,'null:']).catch(error=>error);changedPixels=Number(String(comparison.stderr||'').trim().split(/\s+/)[0]);if(changedPixels>3000)break;
 }
 if(previous)assert(changedPixels>3000,'whole-window action picture must differ from its predecessor: '+name);
 report.screenshots.push({file,recording:clip,scope:await page.evaluate(()=>window.__workspaceScope),sha256:createHash('sha256').update(await fs.readFile(file)).digest('hex'),changedPixels,captureAttempts:attempt+1});
}
try{
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));const env={...process.env};for(const k of Object.keys(env))if(k!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||k==='ELECTRON_RUN_AS_NODE'))delete env[k];Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:fixture.configRoot,NOZELI_USER_DATA:fixture.profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_OZONE:'x11'});
 const binary=process.env.NOZELI_TEST_BINARY||require('electron');report.binary=binary;child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform=x11','--inspect=0'],{cwd:app,env,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const s of [child.stdout,child.stderr])s.on('data',v=>log+=v);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
 await shell.click('[data-project-id="'+fixture.a.id+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,fixture.a.id),'project activated');
 observer=await MainObserver.connect(await until(()=>/Debugger listening on (ws:\/\/[^\s]+)/.exec(log)?.[1],'own main inspector'));
 windowId=await observer.evaluate(`(()=>{const {BaseWindow}=process.mainModule.require('electron'),w=BaseWindow.getAllWindows().find(x=>x.contentView.children.some(v=>v.webContents?.getURL().includes('index.html')))||BaseWindow.getAllWindows()[0];return '0x'+w.getNativeWindowHandle().readUInt32LE(0).toString(16);})()`);
 const before=(await call('managed.status',{projectId:fixture.a.id})).state;
 if(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true').catch(()=>false))await shell.click('#toggle-sidebar');
 await shell.waitForSelector('[data-managed-todo="'+todo.id+'"]',{visible:true});await shell.click('[data-managed-todo="'+todo.id+'"]');review=await active('report');await review.waitForSelector('.managed-review');
 await assertDiscussionClosed();await review.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
 const actions=await review.$$eval('.managed-review button[data-review-action]',nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>node.dataset.reviewAction));assert.deepEqual(actions.sort(),['accept','discard','open-discussion'],'report exposes exactly the three page-level review actions');
 await shot(review,'01-报告主体与三个审核动作-默认无原生讨论');report.checks.push('Actual Todo opens original report body with exactly discussion/accept/discard actions and no native discussion window');
 const initialAppendix=await appendixLink('file','candidate.html');await initialAppendix.page.$eval('[data-nozeli-report-endmatter]',node=>node.scrollIntoView({block:'start'}));
 const changes=await initialAppendix.page.$$eval('[data-nozeli-report-endmatter] .nozeli-end-files > li',rows=>rows.map(row=>({relPath:row.querySelector('.nozeli-end-path')?.textContent,change:row.dataset.nozeliEndmatterChange,label:row.querySelector('small')?.textContent.trim(),labelRendered:Boolean(row.querySelector('small')?.getClientRects().length)})));
 for(const [relPath,change] of [['added.txt','added'],['candidate.html','modified'],['candidate.js','modified'],['old.md','removed'],['old.png','removed']]){
  const row=changes.find(row=>row.relPath===relPath);assert(row,'appendix must include the exact publication path '+relPath);assert.equal(row.change,change,'appendix change type must come from this publication archive: '+relPath);assert(row.label&&row.labelRendered,'real change description must be rendered for '+relPath);
 }
 report.checks.push('Report appendix renders added/modified/deleted paths with change semantics from this exact Work publication archive, not another Work or live project');
 await shot(review,'02-报告guest正文末尾真实成果附录');
 await openAppendix('file','candidate.html');doc=await active('document','candidate.html');await doc.waitForSelector('#web-preview-toolbar:not([hidden])');await doc.waitForSelector('#web-preview-pane .isolated-status[data-state="ready"]');let guest=await preview();
 const candidateSource=await doc.evaluate(()=>({projectId:window.__workspaceScope.projectId,...window.__workspaceScope.documentSource}));assert.equal(candidateSource.projectId,fixture.a.id);assert.equal(candidateSource.workId,work.id);assert.equal(candidateSource.objectId,receipt.objectId);
 await guest.waitForFunction(()=>document.body.dataset.source==='FROZEN_CANDIDATE');assert(await guest.evaluate(()=>document.body.innerText.includes('CANDIDATE_NEW_CONTENT')&&!document.body.innerText.includes('PROJECT_ORIGINAL')));await guest.click('#increment');assert.equal(await guest.$eval('#result',n=>n.textContent),'1');assert.equal(await doc.evaluate(()=>window.__workspaceScope.documentSource.type),'review');
 await shot(doc,'03-从成果清单打开真实HTML并点击计算');report.checks.push('Footer file click opens real frozen candidate HTML/JS in native reader; actual script click works, not current same-name project HTML');
 await doc.click('#web-mode-source');await doc.waitForSelector('#text-host',{visible:true});await doc.evaluate(()=>window.__nozeliInput.insert('\n<p>UNSAVED_REVIEW_HTML</p>'));await doc.click('#web-mode-split');await doc.waitForSelector('#web-preview-pane .isolated-status[data-state="ready"]');guest=await preview();await guest.waitForFunction(()=>document.body.innerText.includes('UNSAVED_REVIEW_HTML'));await shot(doc,'04-人工未保存源码与原生预览');
 report.checks.push('Native source/split preview consumes unsaved human review buffer without adopting into project');
 for(const relPath of ['old.md','old.png']){
  await returnReport();await openAppendix('file',relPath);doc=await active('document',relPath);
  assert.equal(await doc.evaluate(()=>window.__workspaceScope.documentSource.type),'review-version');assert.equal(await doc.evaluate(()=>window.__workspaceScope.documentSource.version.kind),'baseline');
  const baselineSource=await doc.evaluate(()=>({projectId:window.__workspaceScope.projectId,...window.__workspaceScope.documentSource}));assert.equal(baselineSource.projectId,fixture.a.id);assert.equal(baselineSource.workId,work.id);assert.equal(baselineSource.objectId,receipt.objectId);
  if(relPath==='old.md')await doc.waitForFunction(text=>window.__nozeliInput?.text()===text,{},deleted);
  else {await doc.waitForFunction(()=>[...document.querySelectorAll('#image-host img')].some(image=>image.complete&&image.naturalWidth>0));const frozen=await call('file.read',{projectId:fixture.a.id,relPath,documentSource:baselineSource},doc);assert.equal(frozen.digest,originalPngHash,'image reader consumes exact retained baseline bytes');}
  await shot(doc,(relPath==='old.png'?'04b-删除图片冻结基线-':'04b-删除交付物原生基线浏览-')+relPath.replaceAll('.','-'));report.checks.push(relPath==='old.png'?'Deleted image renders its exact frozen baseline without reading a candidate replacement':'Deleted text opens the retained frozen baseline in the actual native reader, not a missing candidate or current file');
 }
 await returnReport();const diffAppendix=await appendixLink('diff','candidate.html');await diffAppendix.page.$eval('[data-nozeli-report-endmatter]',node=>node.scrollIntoView({block:'start'}));await shot(review,'05-报告正文附录冻结Diff路径');
 for(const relPath of ['candidate.html','old.md','old.png']){
  await openAppendix('diff',relPath);const diff=await active('diff',relPath);await diff.waitForFunction(path=>document.querySelector('.document-diff-title')?.textContent.includes(path),{},relPath);
  if(relPath==='old.png')await diff.waitForFunction(()=>document.querySelector('.document-diff-body')?.textContent.includes('二进制'));
  else await diff.waitForFunction(()=>document.querySelector('.cm-mergeView'));
  const surface=await diff.evaluate(()=>({scope:window.__workspaceScope,text:document.body.innerText}));assert.equal(surface.scope.projectId,fixture.a.id);assert.equal(surface.scope.viewState.target.workId,work.id);assert.equal(surface.scope.viewState.target.objectId,receipt.objectId);assert.equal(surface.scope.viewState.target.relPath,relPath);
  report.checks.push('Footer Diff opens frozen input→candidate '+relPath+(relPath==='old.png'?' with truthful binary explanation':''));await shot(diff,'06-冻结Diff-'+relPath.replaceAll('.','-'));
  await returnReport();
 }
 assert.equal(await fs.readFile(path.join(fixture.project,'candidate.html'),'utf8'),original);assert.equal(await fs.readFile(path.join(fixture.project,'candidate.js'),'utf8'),'document.body.dataset.source="WRONG_PROJECT"');assert.equal(await fs.readFile(path.join(fixture.project,'old.md'),'utf8'),deleted);assert.equal(createHash('sha256').update(await fs.readFile(path.join(fixture.project,'old.png'))).digest('hex'),originalPngHash);
 await assert.rejects(fs.stat(path.join(fixture.project,'added.txt')),{code:'ENOENT'},'browsing the newly added frozen deliverable must not add it to the live project');
 const after=(await call('managed.status',{projectId:fixture.a.id})).state;assert.deepEqual(after.jobs,before.jobs);assert.equal(after.works.find(w=>w.id===work.id).status,'review');assert.equal(after.agents.length,0);report.checks.push('Browsing, preview and frozen Diff preserve all source files, deleted baselines, Work status and jobs; zero model jobs/agents');
 observer.close();observer=null;await call('session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;report.surface=await(doc||review)?.evaluate(()=>({scope:window.__workspaceScope,text:document.body.innerText.slice(-3500)})).catch(()=>null);if(windowId)await shot(doc||review,'failure').catch(()=>{});}
finally{observer?.close();if(child&&child.exitCode===null){try{await call('session.requestClose');await Promise.race([exit,pause(15000)]);}catch{}if(child.exitCode===null)child.kill('SIGTERM');}await browser?.disconnect().catch(()=>{});await fixture.storage.db.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
