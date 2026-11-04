import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {prepareFrozenWorkflow} from './desktop-frozen-workflow.fixture.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {staticReport} from './static-report.fixture.mjs';
const app=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-review-html-'));
const fixture=await prepareFrozenWorkflow(out),report={ok:false,out,checks:[],screenshots:[],scope:'Actual Electron, real candidate HTML/JS and review-source IPC, no model or user project.'};
const original='<html><body>PROJECT_ORIGINAL_MUST_NOT_PREVIEW</body></html>';
await fs.writeFile(path.join(fixture.project,'candidate.html'),original);await fs.writeFile(path.join(fixture.project,'candidate.js'),'document.body.dataset.source="WRONG_PROJECT"');
const c=await Controller.open({storage:fixture.storage,projectId:fixture.a.id,runtimeRoot:fixture.runtimeRoot,contentRoot:fixture.project});let work,receipt;
try{
 work=await c.store.submit('预览候选网页而非原项目','HTML preview source isolation',{name:'HTML成果交互预览'});await c.store.activate(work.id);work=c.store.find(work.id);await c.execution.prepare(work.id);
 const directory=c.execution.directory(work.id);
 await fs.writeFile(path.join(directory,'candidate.html'),'<!doctype html><html><head><meta charset="utf-8"></head><body><h1>CANDIDATE_NEW_CONTENT</h1><button id="increment">计算</button><output id="result">0</output><script src="candidate.js"></script></body></html>');
 await fs.writeFile(path.join(directory,'candidate.js'),'let n=0;document.body.dataset.source="FROZEN_CANDIDATE";document.querySelector("#increment").onclick=()=>document.querySelector("#result").textContent=String(++n);');
 await c.execution.publish(work,{id:'review-html-job'},()=>true);receipt=await c.store.publish(work.id,1,'result',staticReport('审阅实际HTML交互效果'),'review-html-result',{jobId:'review-html-job',files:[{relPath:'candidate.html'},{relPath:'candidate.js'}]});await c.store.settle(work.id);
}finally{await c.stop();}
let child,browser,shell,doc,exit,log='';const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=30000){const deadline=Date.now()+ms;while(Date.now()<deadline){if(child&&(child.exitCode!==null||child.signalCode))throw Error('app exited '+log);const v=await fn();if(v)return v;await pause(60);}throw Error('Timeout '+label);}
async function call(op,p={},page=shell){const r=await page.evaluate(({op,p})=>window.nozeli.invoke(op,p),{op,p});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
async function preview(){const key=await doc.$eval('#web-preview-pane .isolated-viewport',n=>n.dataset.previewKey),s=await call('isolated-preview.snapshot',{key},doc);return until(async()=>{for(const p of await browser.pages())if(p.url().startsWith(s.origin+'/'))return p;},'candidate native preview');}
async function shot(page,name){const file=path.join(out,name+'.png');await page.screenshot({path:file});report.screenshots.push(file);}
try{
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));const env={...process.env};for(const k of Object.keys(env))if(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||k==='ELECTRON_RUN_AS_NODE')delete env[k];Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:fixture.configRoot,NOZELI_USER_DATA:fixture.profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
 const binary=process.env.NOZELI_TEST_BINARY||require('electron');report.binary=binary;child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform=wayland'],{cwd:app,env,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const s of [child.stdout,child.stderr])s.on('data',v=>log+=v);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');await shell.click('[data-project-id="'+fixture.a.id+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,fixture.a.id),'project activated');
 const before=(await call('managed.status',{projectId:fixture.a.id})).state;
 await call('workspace.control',{type:'open-file',projectId:fixture.a.id,relPath:'candidate.html',documentSource:{type:'review',workId:work.id,objectId:receipt.objectId}});
 doc=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath==='candidate.html').catch(()=>false))return p;},'review document');await doc.waitForSelector('#web-preview-toolbar:not([hidden])');await doc.waitForSelector('#web-preview-pane .isolated-status[data-state="ready"]');let guest=await preview();await guest.waitForFunction(()=>document.body.dataset.source==='FROZEN_CANDIDATE');assert(await guest.evaluate(()=>document.body.innerText.includes('CANDIDATE_NEW_CONTENT')&&!document.body.innerText.includes('PROJECT_ORIGINAL')));await guest.click('#increment');assert.equal(await guest.$eval('#result',n=>n.textContent),'1');assert.equal(await guest.evaluate(()=>typeof window.nozeli),'undefined');assert.equal(await guest.evaluate(()=>typeof process),'undefined');await shot(guest,'candidate-interactive');report.checks.push('HTML preview and JS dependency use the frozen candidate, not original same-path project; real button interaction works without privileged API');
 await doc.click('#web-mode-source');await doc.waitForSelector('#text-host',{visible:true});await doc.evaluate(()=>window.__nozeliInput.insert('\n<p>UNSAVED_REVIEW_HTML</p>'));await doc.click('#web-mode-split');await doc.waitForSelector('#web-preview-pane .isolated-status[data-state="ready"]');guest=await preview();await guest.waitForFunction(()=>document.body.innerText.includes('UNSAVED_REVIEW_HTML'));await shot(guest,'human-buffer-preview');report.checks.push('Source/split preview consumes current unsaved human review buffer without adopting it into project');
 assert.equal(await fs.readFile(path.join(fixture.project,'candidate.html'),'utf8'),original);assert.equal(await fs.readFile(path.join(fixture.project,'candidate.js'),'utf8'),'document.body.dataset.source="WRONG_PROJECT"');const after=(await call('managed.status',{projectId:fixture.a.id})).state;assert.deepEqual(after.jobs,before.jobs);assert.equal(after.works.find(w=>w.id===work.id).status,'review');assert.equal(after.agents.length,0);report.checks.push('Preview leaves original project files and Work review state untouched, with zero model jobs or agents');
 await call('session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;report.surface=await doc?.evaluate(()=>({scope:window.__workspaceScope,text:document.body.innerText.slice(-2500)})).catch(()=>null);await doc?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{if(child&&child.exitCode===null){try{await call('session.requestClose');await Promise.race([exit,pause(15000)]);}catch{}if(child.exitCode===null)child.kill('SIGTERM');}await browser?.disconnect().catch(()=>{});await fixture.storage.db.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
