import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
// Installed smoke: NOZELI_TEST_BINARY=/absolute/nozeli node tests/desktop-lifecycle-simplified-live.mjs
// Source classes seed stopped synthetic fixtures only; all operations use app IPC.

// Actual renderer -> preload -> host IPC with owned synthetic projects only.
const app=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-lifecycle-system-'));
const binary=process.env.NOZELI_TEST_BINARY||require('electron'),home=path.join(out,'home');await fs.mkdir(home);
const profile=path.join(out,'config/desktop'),config=path.dirname(profile),project=path.join(out,'project'),other=path.join(out,'other');
await fs.mkdir(project);await fs.mkdir(other);await fs.writeFile(path.join(project,'paper.txt'),'Original synthetic paper.\n');await fs.writeFile(path.join(other,'other.txt'),'Other original.\n');
const host=new DesktopHost(profile),p=(await host.pick(project)).project,q=(await host.pick(other)).project;
const heldProject=await host.storage.requireRegistered(q.id),oldOperation='cold-fixture-remove';
const oldHold=host.storage.holdProject(q.id,{operationId:oldOperation,instanceId:heldProject.instanceId,action:'remove',root:other});oldHold.needsStopCheck=true;await host.storage.persistProjectHold(q.id,oldHold);
await host.storage.putRecovery(q.id,'lifecycle:'+oldOperation,{schema:1,projectId:q.id,instanceId:heldProject.instanceId,operationId:oldOperation,action:'remove',root:other,phase:'needs-attention',failedPhase:'prepared',error:{code:'PROJECT_FLUSH_FAILED',message:'Synthetic interrupted close'}});
await host.storage.db.close();
const report={ok:false,out,checks:[],errors:[],qualification:'Linux actual Electron/native web/conversation/editor IPC, isolated files/SQLite; no models or user data'};
let child,browser,shell,exit,log='';const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(child?.exitCode!=null)throw Error('App exited '+log);const r=await fn();if(r)return r;await pause(60);}throw Error('Timeout '+label);}
async function raw(op,payload={},page=shell){return page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});}
async function call(op,payload={},page=shell){const r=await raw(op,payload,page);assert(r.ok,op+':'+JSON.stringify(r.error));return r.value;}
async function launch(){const srv=net.createServer();await new Promise(r=>srv.listen(0,'127.0.0.1',r));const port=srv.address().port;await new Promise(r=>srv.close(r));const env={...process.env};for(const k of Object.keys(env))if(k!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(k)))delete env[k];Object.assign(env,{HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_STATE_HOME:path.join(home,'.local/state'),XDG_CACHE_HOME:path.join(home,'.cache'),NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':'wayland'))],{cwd:out,env,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const s of[child.stdout,child.stderr])s.on('data',b=>log+=b);browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'shell');if(await shell.$eval('#configuration-setup',n=>n.open).catch(()=>false))await shell.click('#configuration-cancel');}
async function select(id){await shell.click('[data-project-id="'+id+'"]');await shell.waitForFunction(id=>window.__workspaceScope?.projectId===id,{},id);}
async function surface(kind){return until(async()=>{for(const page of await browser.pages())if(await page.evaluate(kind=>window.__nozeliReady&&window.__workspaceScope?.kind===kind,kind).catch(()=>false))return page;},kind);}
async function openWeb(id){const s=await call('workspace.snapshot',{projectId:id});await call('workspace.command',{projectId:id,expectedRevision:s.layout.revision,requestKey:'web-'+Date.now(),command:{type:'open',view:{kind:'web',url:'https://example.invalid/'}}});return surface('web');}
async function close(){await call('session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;await browser.disconnect();browser=null;}
try{
 await launch();await select(q.id);assert.equal((await call('project.open',{projectId:q.id})).project.id,q.id);report.checks.push('Ordinary click on a cold held project performs one verified recovery and opens it without models or removal');await select(p.id);await shell.waitForSelector('#file-tree [data-path="paper.txt"]');await shell.click('#file-tree [data-path="paper.txt"]');const doc=await surface('document');await doc.waitForFunction(()=>window.__nozeliInput?.text?.()==='Original synthetic paper.\n');
 await doc.evaluate(()=>window.__nozeliInput.focus());await doc.keyboard.down('Control');await doc.keyboard.press('End');await doc.keyboard.up('Control');await doc.keyboard.type('RETAINED_UNSAVED_BUFFER\n');
 const closes=await shell.evaluate(projectId=>Promise.all(['close-retained-document','close-retained-document','close-competing-document'].map(operationId=>nozeli.invoke('workspace.closeProject',{projectId,operationId}))),p.id);
 assert(closes[0].ok);assert.deepEqual(closes[1],closes[0]);assert.equal(closes[2].ok,false);assert.equal(closes[2].error.code,'PROJECT_LIFECYCLE_ACTIVE');report.checks.push('Concurrent identical close shares its result; competing operation identity is refused');
 await select(p.id);const restored=await surface('document');await restored.waitForFunction(()=>window.__nozeliInput?.text?.().includes('RETAINED_UNSAVED_BUFFER'));report.checks.push('Normal project close preserves actual native unsaved buffer and reopens it');
 const web=await openWeb(p.id);await web.waitForSelector('input');await web.$eval('input',(n)=>{n.value='https://example.invalid/unfinished-address';n.dispatchEvent(new Event('input',{bubbles:true}));});
 const removed=await call('project.remove',{projectId:p.id,operationId:'remove-web-with-address'});assert.equal(removed.removed,true);assert((await call('project.recent')).projects.some(v=>v.id===q.id));report.checks.push('Web address flush crosses real lifecycle receipt and remove completes without persistent self-lock');
 await close();
 // Re-add through real host registration after stopped fixture; retained state is not reset.
 const readd=new DesktopHost(profile);assert.equal((await readd.pick(project)).project.id,p.id);await readd.storage.db.close();await launch();await select(p.id);
 const web2=await openWeb(p.id);await web2.evaluate(()=>nozeli.subscribe('session.flush',async()=>({ok:false,error:{code:'FIXTURE_REFUSES_SAVE',message:'Owned fixture deliberately cannot retain'}})));
 const ordinary=await raw('workspace.closeProject',{projectId:p.id,operationId:'ordinary-refuses-save'});assert.equal(ordinary.ok,false);assert.equal(ordinary.error.code,'PROJECT_FLUSH_FAILED');assert(ordinary.error.details.failures.some(f=>f.code==='FIXTURE_REFUSES_SAVE'));report.checks.push('Genuine renderer save failure keeps project intact and exposes bounded owner errors');
 const preview=await call('project.lifecycle.preview',{projectId:p.id,action:'reset-project'});assert.equal(preview.permanentDelete,true);
 const denied=await raw('project.lifecycle.execute',{token:preview.token});assert.equal(denied.ok,false);assert.equal(denied.error.code,'PERMANENT_DELETE_CONFIRMATION_REQUIRED');
 const resets=await shell.evaluate(token=>Promise.all([1,2].map(()=>nozeli.invoke('project.lifecycle.execute',{token,confirmPermanentDelete:true}))),preview.token);assert(resets[0].ok,JSON.stringify(resets[0]));assert.equal(resets[1].ok,false);assert.equal(resets[1].error.code,'LIFECYCLE_CONFIRMATION_EXPIRED');const reset=resets[0].value;assert(reset.complete);assert.notEqual(reset.newProjectId,p.id);report.newProjectId=reset.newProjectId;report.checks.push('Concurrent reset token is consumed exactly once, never publishes a second fresh instance');
 assert.equal(await fs.readFile(path.join(project,'paper.txt'),'utf8'),'Original synthetic paper.\n');assert.equal(await fs.readFile(path.join(other,'other.txt'),'utf8'),'Other original.\n');
 await call('project.open',{projectId:reset.newProjectId});report.checks.push('Explicit confirmed reset discards refused view state without flushing, preserves original files and publishes usable fresh instance');
 await close();await launch();await select(reset.newProjectId);const status=await call('managed.initialization.status',{projectId:reset.newProjectId});assert(!['queued','running'].includes(status.status),'no-model local open cannot start inference');await shell.screenshot({path:path.join(out,'fresh-project.png')});await close();report.checks.push('Fresh reset instance cold opens without AI configuration or old state');report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{if(child?.exitCode===null){await raw('session.requestClose').catch(()=>{});await Promise.race([exit,pause(5000)]);if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exit,pause(5000)]);}}await browser?.disconnect().catch(()=>{});await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
