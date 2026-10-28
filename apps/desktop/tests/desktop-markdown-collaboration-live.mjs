import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {contentToolForPage} from './native-content-tools.fixture.mjs';

// Real native tools and Git with a deterministic local model. No user projects,
// personal credentials or simulated browser-only file effects.
const app=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url);
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-markdown-collaboration-'));
const config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),project=path.join(out,'project');
await fs.mkdir(project,{recursive:true});
const baseline='# Shared document\n\nBaseline paragraph.\n',first='# Shared document\n\nWorker first proposal.\n';
await fs.writeFile(path.join(project,'reading.md'),baseline);
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id;await host.storage.db.close();
const result={out,ok:false,checks:[],errors:[],modelRequests:[],qualification:'Linux real Electron, bundled OMP/native document tools, actual Git; deterministic local model, synthetic project; no paid model quality claim.'};
const tool=(name,args,id)=>({role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
let workerTurn=0,workerStage=0,orchestratorStage=0,humanText=null;
const server=http.createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
 try{
  const input=JSON.parse(body),names=(input.tools||[]).map(t=>t.function?.name),orchestrator=names.includes('nozeli_dispatch');
  let delta,finish='tool_calls';
  if(orchestrator){
   if(++orchestratorStage===1)delta=tool('nozeli_dispatch',{name:'Markdown collaborative review',brief:'Revise reading.md within the user task and publish the result.'},'dispatch-collaboration');
   else{delta={role:'assistant',content:'Routed to original Worker.'};finish='stop';}
  }else{
   const last=input.messages?.at(-1);const lastTool=last?.role==='tool'?last:null;
   if(workerStage===0){workerTurn++;workerStage=1;delta=tool('nozeli_document_read',{relPath:'reading.md'},'read-'+workerTurn);}
   else if(workerStage===1){
    assert(lastTool,'native document read reply required');const reply=typeof lastTool.content==='string'?JSON.parse(lastTool.content):lastTool.content;
    const read=reply.value??reply;assert.equal(read.relPath,'reading.md');
    if(workerTurn===1){assert.equal(read.text,baseline);delta=tool('nozeli_document_apply',{readHandle:read.readHandle,replacements:[{oldText:baseline,newText:first}]},'edit-first');workerStage=2;}
    else{assert.equal(read.text,humanText,'same Worker must read latest human candidate, not the old published version');result.checks.push('native Worker continuation read the exact saved human candidate');delta=tool('nozeli_publish',{kind:'result',html:reportHtml('Human changes retained in the same Work.'),files:['reading.md']},'publish-'+workerTurn);workerStage=0;}
   }else{delta=tool('nozeli_publish',{kind:'result',html:reportHtml('First Worker proposal.'),files:['reading.md']},'publish-'+workerTurn);workerStage=0;}
  }
  result.modelRequests.push({role:orchestrator?'orchestrator':'worker',tool:delta.tool_calls?.[0]?.function?.name,turn:workerTurn});
  res.writeHead(200,{'content-type':'text/event-stream'});for(const [part,end]of [[delta,null],[{},finish]])res.write('data: '+JSON.stringify({id:'collaboration-'+result.modelRequests.length,object:'chat.completion.chunk',choices:[{index:0,delta:part,finish_reason:end}]})+'\n\n');res.end('data: [DONE]\n\n');
 }catch(error){result.errors.push(error.stack);res.destroy(error);}
});});
function reportHtml(text){return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Collaborative proposal</title></head><body><main><h1>Collaborative proposal</h1><p>'+text+'</p><a href="reading.md">Review Markdown</a></main></body></html>';}
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
Object.assign(env,{HOME:os.homedir(),NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
let child,browser,shell,log='',exit;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=90000){const end=Date.now()+ms;while(Date.now()<end){if(result.errors.length)throw Error(result.errors.join('\n'));if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Application exited: '+log);const value=await fn();if(value)return value;await pause(80);}throw Error('Timed out '+label);}
async function raw(op,payload={},page=shell){return page.evaluate(({op,payload})=>{if(window.__workspaceScope?.kind==='document'&&/^(?:file\.|document\.|annotation\.|tag\.|workspace\.document\.)/.test(op))payload={...payload,documentSource:payload.documentSource??window.__workspaceScope.documentSource};return nozeli.invoke(op,payload);},{op,payload});}
async function call(op,payload={},page=shell){const response=await raw(op,payload,page);assert(response.ok,op+': '+JSON.stringify(response.error));return response.value;}
const state=async()=>(await call('managed.status',{projectId})).state;
async function findReview(){return until(async()=>{const s=await state();const failed=s.jobs.find(j=>j.status==='failed');if(failed)throw Error(failed.error);return s.works.find(w=>w.status==='review'&&!s.busyTargets.includes(w.id));},'native Worker report');}
async function reportPage(todoId){await shell.evaluate(id=>window.__workspaceOpenTodo(id),todoId);return until(async()=>{for(const page of await browser.pages())if(await page.evaluate(id=>window.__nozeliReady&&window.__workspaceScope?.kind==='report'&&window.__workspaceScope?.viewState?.report?.todoId===id,todoId).catch(()=>false))return page;},'review content surface');}
async function nativeDocument(objectId){return until(async()=>{for(const page of await browser.pages())if(await page.evaluate(id=>{const s=window.__workspaceScope;return window.__nozeliReady&&s?.kind==='document'&&s.relPath==='reading.md'&&(id?s.documentSource?.type==='review'&&s.documentSource.objectId===id:!s.documentSource||s.documentSource.type==='project');},objectId).catch(()=>false))return page;},'native document '+(objectId||'source'));}
async function editNative(page,text){if(await page.$eval('#text-host',node=>node.hidden))await contentToolForPage(page,['view','text-mode']);await page.evaluate(()=>window.__nozeliInput.focus());await page.keyboard.down('Control');await page.keyboard.press('a');await page.keyboard.up('Control');await page.keyboard.sendCharacter(text);}

async function startApp(){
 const binary=process.env.NOZELI_TEST_BINARY||require('electron');
 child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform=wayland'],{cwd:project,env,stdio:['ignore','pipe','pipe']});
 exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of[child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'ready shell');
 for(const page of await browser.pages())page.on('pageerror',error=>result.errors.push(error.message));
}
async function closeApp(){await call('session.requestClose');assert.deepEqual(await Promise.race([exit,pause(30000).then(()=>null)]),{code:0,signal:null});await browser.disconnect();}
try{
 await startApp();
 if(await shell.$eval('#configuration-setup',node=>node.open))await shell.click('#configuration-cancel');
 await call('config.initialize',{mode:'independent'});
 await call('settings.providers.save',{provider:'review-local',model:'scripted',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',api:'openai-completions',key:'synthetic-local-only'});
 await call('settings.models.save',{frontdesk:'review-local/scripted',orchestrator:'review-local/scripted',worker:'review-local/scripted'});
 await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForFunction(id=>window.__workspaceScope?.projectId===id,{},projectId);
 await call('managed.enable',{projectId});await until(async()=>(await call('managed.status',{projectId})).ready,'resident native owners');
 await shell.click('#file-tree [data-path="reading.md"]');const sourcePage=await nativeDocument(null);const sourceHistory=await call('document.history',{projectId,relPath:'reading.md'},sourcePage);
 await call('managed.task',{projectId,text:'Revise reading.md into a clear proposal for collaborative review. Keep all changes as a candidate until the user accepts; only the host may integrate after acceptance.',requestKey:'collaboration-initial'});
 const initialWork=await findReview(),workId=initialWork.id,originalThread=initialWork.threadId;
 assert.equal(typeof originalThread,'string','native Worker must have a real persisted thread identity');
 assert.equal(await fs.readFile(path.join(project,'reading.md'),'utf8'),baseline);
 assert.equal(await fs.readFile(path.join(initialWork.execution.directory,'reading.md'),'utf8'),first);
 result.identity={projectId,workId,originalThread};result.checks.push('real native Worker changed only the candidate worktree and published an immutable report');
 let current=await state(),receipt=current.receipts.findLast(r=>r.workId===workId&&r.kind==='result'),todo=current.todos.find(t=>t.objectId===receipt.objectId);
 if(await shell.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true'))await shell.click('#toggle-sidebar');
 let page=await reportPage(todo.id);page.on('pageerror',error=>result.errors.push(error.message));
 await page.waitForSelector('[data-review-file="reading.md"]',{visible:true});
 assert.equal(await page.$eval('[data-review-file-row="reading.md"] [data-review-counts]',node=>node.textContent.trim()),'+1 / -1');
 assert.equal(await page.$$eval('#managed-doc .cm-editor',nodes=>nodes.length),0,'report is a document index, never a parallel editor');
 const originalReview=await call('managed.review.read',{projectId,workId,objectId:receipt.objectId});assert.equal(originalReview.files.find(f=>f.relPath==='reading.md').baselineText,baseline);
 await page.click('[data-review-file="reading.md"]');let doc=await nativeDocument(receipt.objectId);assert.equal(await doc.evaluate(()=>window.__nozeliInput.text()),first);
 assert.notEqual((await doc.evaluate(()=>window.__workspaceScope)).viewId,(await sourcePage.evaluate(()=>window.__workspaceScope)).viewId);
 humanText='# Shared document\n\nHUMAN_REVIEW_MARKER: retain my wording.\n';await editNative(doc,humanText);await doc.evaluate(()=>window.__nativeReviewEditor=document.querySelector('#text-host .cm-editor'));
 await contentToolForPage(doc,['view','text-mode']);await doc.waitForFunction(()=>!document.querySelector('#text-preview').hidden&&document.querySelector('#text-preview').textContent.includes('HUMAN_REVIEW_MARKER'));
 await contentToolForPage(doc,['view','text-mode']);assert(await doc.evaluate(()=>window.__nativeReviewEditor===document.querySelector('#text-host .cm-editor')));
 await doc.evaluate(()=>window.__nozeliInput.focus());await doc.keyboard.down('Control');await doc.keyboard.press('z');await doc.keyboard.up('Control');assert.equal(await doc.evaluate(()=>window.__nozeliInput.text()),first);
 await doc.keyboard.down('Control');await doc.keyboard.down('Shift');await doc.keyboard.press('z');await doc.keyboard.up('Shift');await doc.keyboard.up('Control');
 await until(async()=>{const read=await call('managed.review.read',{projectId,workId,objectId:receipt.objectId});return read.files.find(f=>f.relPath==='reading.md').draft?.text===humanText;},'native document saved to candidate CAS');
 assert.equal(await fs.readFile(path.join(project,'reading.md'),'utf8'),baseline);assert.equal((await state()).jobs.filter(j=>j.target===workId).length,1);
 await contentToolForPage(doc,['history','compareHistory']);await doc.waitForSelector('#beside-dialog[open]');await doc.waitForFunction(()=>!document.querySelector('#beside-diff').disabled);await doc.select('#beside-version','baseline:');await doc.click('#beside-diff');await doc.waitForSelector('.document-diff .cm-mergeView',{visible:true});
 const compared=await doc.$$eval('.document-diff-body .cm-content',nodes=>nodes.map(node=>node.textContent));assert(compared.some(text=>text.includes('Baseline paragraph.')));assert(compared.some(text=>text.includes('HUMAN_REVIEW_MARKER')));await doc.screenshot({path:path.join(out,'01-native-candidate-diff.png')});
 await doc.click('#secondary-close');if(await doc.$eval('#action-confirmation',node=>node.open))await doc.click('#action-confirmation-accept');await doc.waitForFunction(()=>!document.querySelector('.document-diff'));assert(await doc.evaluate(()=>window.__nativeReviewEditor===document.querySelector('#text-host .cm-editor')));
 if(await doc.$eval('#text-host',node=>node.hidden))await contentToolForPage(doc,['view','text-mode']);await doc.evaluate(()=>window.__nozeliInput.focus());await doc.keyboard.down('Control');await doc.keyboard.press('Home');await doc.keyboard.up('Control');await doc.keyboard.down('Shift');for(let i=0;i<17;i++)await doc.keyboard.press('ArrowRight');await doc.keyboard.up('Shift');await doc.waitForSelector('#selection-menu:not([hidden])');await doc.click('#selection-note');await doc.type('#note-input','Candidate-only annotation');await doc.click('#add-note');
 const hasCandidateNote=notes=>notes.annotations.some(note=>note.note==='Candidate-only annotation');await until(async()=>hasCandidateNote(await call('annotation.list',{projectId,relPath:'reading.md'},doc)),'native candidate note committed');
 assert.equal((await call('annotation.list',{projectId,relPath:'reading.md'},sourcePage)).annotations.length,0);assert.deepEqual(await call('document.history',{projectId,relPath:'reading.md'},sourcePage),sourceHistory);
 const documentScope=await call('workspace.bootstrap',{},doc),layoutBeforeSplit=await call('workspace.snapshot',{projectId});await call('workspace.command',{projectId,expectedRevision:layoutBeforeSplit.layout.revision,requestKey:'native-review-split',command:{type:'splitOpen',viewId:documentScope.viewId,axis:'x',side:'after'}});
 const mirror=await until(async()=>{for(const candidate of await browser.pages())if(await candidate.evaluate(id=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.sourceViewId===id,documentScope.viewId).catch(()=>false))return candidate;for(const candidate of await browser.pages())if(await candidate.evaluate(id=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.readOnly&&window.__workspaceScope?.documentSource?.objectId===id,receipt.objectId).catch(()=>false))return candidate;},'native candidate readonly mirror');
 assert.equal(await mirror.evaluate(()=>window.__nozeliInput.text()),humanText);const mirrorFile=await call('file.read',{projectId,relPath:'reading.md'},mirror);const mirrorWrite=await raw('file.save',{projectId,relPath:'reading.md',baseDigest:mirrorFile.digest,text:'MIRROR_MUST_NOT_WRITE'},mirror);assert.equal(mirrorWrite.ok,false);assert.equal(mirrorWrite.error.code,'EDIT_LEASE_DENIED');result.checks.push('native split mirror shares candidate text but retains a single writer independent of source');
 const stale=await raw('managed.review.accept',{projectId,workId,objectId:receipt.objectId,reviewVersion:originalReview.reviewVersion,requestKey:'stale-review-accept'});assert.equal(stale.ok,false);
 result.checks.push('report opens native document reader/editor; preview undo Diff and annotations share native state while source stays untouched');
 page=await reportPage(todo.id);await page.waitForSelector('[data-review-report-outdated]:not([hidden])',{visible:true});const unsentInstruction='UNSENT_REVIEW_INSTRUCTION: retain my words.\n';await page.type('[data-review-instruction]',unsentInstruction);
 const modelCountBeforeRestart=result.modelRequests.length;await closeApp();await startApp();await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForFunction(id=>window.__workspaceScope?.projectId===id,{},projectId);await call('managed.connect',{projectId});
 page=await reportPage(todo.id);await page.waitForSelector('[data-review-file="reading.md"]',{visible:true});assert.equal(result.modelRequests.length,modelCountBeforeRestart);assert.equal((await call('managed.review.read',{projectId,workId,objectId:receipt.objectId})).files.find(f=>f.relPath==='reading.md').draft.text,humanText);assert.equal(await page.$eval('[data-review-instruction]',node=>node.value),unsentInstruction);
 await page.click('[data-review-file="reading.md"]');doc=await nativeDocument(receipt.objectId);assert.equal(await doc.evaluate(()=>window.__nozeliInput.text()),humanText);assert(hasCandidateNote(await call('annotation.list',{projectId,relPath:'reading.md'},doc)));
 result.checks.push('cold restart restores native candidate text annotation and unsent instructions with no model replay');
 page=await reportPage(todo.id);await page.type('[data-review-instruction]','Retain my exact HUMAN_REVIEW_MARKER wording, read the current candidate and publish the next report for this same Work.');await page.click('[data-review-action="continue"]');await page.waitForSelector('[data-confirmation-confirm]',{visible:true});await page.click('[data-confirmation-confirm]');
 await until(async()=>{const s=await state(),w=s.works.find(w=>w.id===workId);return w.revision>initialWork.revision&&w.status==='review'&&!s.busyTargets.includes(workId)?w:null;},'same Worker continuation report');current=await state();assert.equal(current.works.length,1);assert.equal(current.works[0].threadId,originalThread);assert.equal(await fs.readFile(path.join(current.works[0].execution.directory,'reading.md'),'utf8'),humanText);
 receipt=current.receipts.findLast(r=>r.workId===workId&&r.kind==='result');todo=current.todos.find(t=>t.objectId===receipt.objectId);page=await reportPage(todo.id);await page.waitForSelector('[data-review-file="reading.md"]',{visible:true});await page.click('[data-review-file="reading.md"]');doc=await nativeDocument(receipt.objectId);
 const finalText=humanText+'\nFinal human accepted addition.\n';await editNative(doc,finalText);assert.equal(await fs.readFile(path.join(project,'reading.md'),'utf8'),baseline);
 page=await reportPage(todo.id);await page.click('[data-review-action="accept"]');await page.waitForSelector('[data-confirmation-confirm]',{visible:true});await page.click('[data-confirmation-confirm]');
 const merged=await until(async()=>{const read=await call('managed.review.read',{projectId,workId,objectId:receipt.objectId});if(read.merge?.status==='blocked')throw Error(JSON.stringify(read.merge));return read.merge?.status==='merged'?read:null;},'Orchestrator coordinated host merge');assert.equal(await fs.readFile(path.join(project,'reading.md'),'utf8'),finalText);
 const {runGit}=await import('../src/agents/managed/git-runtime.mjs');assert.equal((await runGit(project,['symbolic-ref','HEAD'])).toString().trim(),'refs/heads/main');assert.equal((await runGit(project,['show','HEAD:reading.md'])).toString(),finalText);
 assert.equal(merged.merge.actor,'orchestrator');assert.equal(merged.merge.executor,'host');
 await page.waitForFunction(()=>document.querySelector('[data-review-status]')?.textContent.includes('已合入'),{timeout:30000});
 result.merge=merged.merge;result.checks.push('cross-document barrier merges exactly the latest native candidate into main through Orchestrator coordination');await page.screenshot({path:path.join(out,'02-merged-native-review.png')});await closeApp();result.ok=true;
}catch(error){result.error=error.stack;process.exitCode=1;if(shell)await shell.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});if(shell)await fs.writeFile(path.join(out,'failure-state.json'),JSON.stringify(await state().catch(()=>null),null,2));}
finally{
 if(child?.exitCode===null){await call('session.requestClose').catch(()=>{});await Promise.race([exit,pause(10000)]);if(child.exitCode===null){result.forcedCleanup=true;child.kill('SIGTERM');await exit;}}
 await browser?.disconnect().catch(()=>{});await new Promise(resolve=>server.close(resolve));await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
