// Run serially after npm run build:renderer: node tests/desktop-project-scope-live.mjs
// Real Electron, native content views and isolated synthetic storage; no model.
// Only OS chooser decisions and persistence/native-attachment failures are injected.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {createLayout,reduceLayout} from '../src/domain/workspace-layout.mjs';

const root=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-project-scope-'));
const config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop');
const control=path.join(out,'control.json'),dialogs=path.join(out,'dialogs.jsonl');
const host=new DesktopHost(profile),projects=[];
for(const name of ['Project B','Project A']){
  const directory=path.join(out,name);await fs.mkdir(directory);
  await fs.writeFile(path.join(directory,'sample.txt'),name+' original\n');
  projects.push((await host.pick(directory)).project);
}
const [b,a]=projects;
const draft='UNSENT PROJECT A DRAFT — never submit';
let layout=reduceLayout(createLayout(a.id),{type:'open',view:{kind:'conversation'}});
Object.values(layout.views).find(view=>view.kind==='conversation').viewState={draftOnly:true,workspace:{draft},conversationInput:{projectId:a.id,target:'frontdesk'}};
layout=reduceLayout(layout,{type:'split',groupId:layout.mainRoot.id,axis:'x'});
layout=reduceLayout(layout,{type:'open',groupId:layout.mainRoot.second.id,view:{kind:'document',relPath:'sample.txt'}});
await host.storage.putLocal(a.id,'workspace:layout',layout);
await host.storage.putLocal(b.id,'workspace:layout',reduceLayout(createLayout(b.id),{type:'open',view:{kind:'document',relPath:'sample.txt'}}));
const launcher=path.join(out,'launcher.cjs');
await fs.writeFile(control,JSON.stringify({pick:b.rootDisplay}));
// The chooser result is a user decision fixture, not a replacement for project.pick.
// Faults throw at real native/storage boundaries; all renderer/IPC handling is real.
await fs.writeFile(launcher,`
const fs=require('node:fs');const electron=require('electron');
const control=${JSON.stringify(control)},dialogs=${JSON.stringify(dialogs)};
const state=()=>JSON.parse(fs.readFileSync(control,'utf8'));
electron.dialog.showOpenDialog=async()=>{const s=state();fs.writeFileSync(control,JSON.stringify({...s,picked:true}));return {canceled:!!s.cancel,filePaths:s.cancel?[]:[s.pick]};};
electron.dialog.showMessageBox=async(...args)=>{const options=args.at(-1);fs.appendFileSync(dialogs,JSON.stringify(options)+'\\n');return {response:0};};
(async()=>{
 const {ProjectStorage}=await import(${JSON.stringify(path.join(root,'src/main/project-storage.mjs'))});
 const put=ProjectStorage.prototype.putRecovery;
 ProjectStorage.prototype.putRecovery=async function(id,key,value){if(state().rejectRecovery&&key==='workspace:shell')throw Object.assign(Error('Synthetic recovery disk write denied'),{code:'EACCES'});return put.call(this,id,key,value);};
 const {WorkspaceNative}=await import(${JSON.stringify(path.join(root,'src/main/workspace-native.mjs'))});
 const context=new (require('node:async_hooks').AsyncLocalStorage)(),reconcile=WorkspaceNative.prototype.reconcile;
 WorkspaceNative.prototype.reconcile=function(layout,...args){return context.run(layout.projectId,()=>reconcile.call(this,layout,...args));};
 const original=electron.View.prototype.addChildView;
 electron.View.prototype.addChildView=function(...args){const s=state();if(s.rejectAttachment&&context.getStore()===${JSON.stringify(b.id)}){fs.writeFileSync(control,JSON.stringify({...s,rejectAttachment:false}));fs.appendFileSync(dialogs,JSON.stringify({boundary:'addChildView',projectId:context.getStore()})+'\\n');throw Error('Synthetic native attachment denied');}return original.apply(this,args);};
 require(${JSON.stringify(path.join(root,'src/main/main.cjs'))});
})().catch(error=>{console.error(error);process.exit(1);});
`);
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const env={...process.env};
for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY/i.test(key))delete env[key];
Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_GUIDED_DEMO_ROOT:path.join(out,'unused-demo-examples'),NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
let child,browser,shell,log='',launchError;const report={out,checks:[],errors:[],qualification:'Linux source Electron; synthetic projects; chooser/failure fixtures, not physical portal automation; no installation or model requests'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const watched=new WeakSet();function watch(page){if(!watched.has(page)){watched.add(page);page.on('pageerror',error=>report.errors.push(error.message));}return page;}
async function until(fn,label){const deadline=Date.now()+30000;while(Date.now()<deadline){if(launchError)throw launchError;const value=await fn();if(value)return value;if(child&&(child.exitCode!==null||child.signalCode))throw Error('Electron exited: '+log);await pause(50);}throw Error('Timed out: '+label);}
async function call(page,op,payload={}){const result=await page.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);assert.equal(result.ok,true,op+': '+JSON.stringify(result.error));return result.value;}
async function current(project){await shell.waitForFunction(id=>document.querySelector('#recent [aria-current=true]')?.dataset.projectId===id,{},project.id);assert.equal((await call(shell,'workspace.bootstrap')).projectId,project.id);assert.equal(await shell.$eval('#project-name',node=>node.textContent),project.name);}
async function surface(project){return until(async()=>{for(const page of await browser.pages()){const scope=await page.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope?.role==='surface'&&scope.projectId===project.id&&scope.relPath==='sample.txt'&&await page.evaluate(()=>window.__nozeliReady))return watch(page);}},'document surface '+project.name);}
async function conversation(project){return until(async()=>{for(const page of await browser.pages()){const scope=await page.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope?.role==='surface'&&scope.projectId===project.id&&scope.kind==='conversation'&&await page.evaluate(()=>window.__nozeliReady))return watch(page);}},'draft-only conversation');}
async function pick(options){await fs.writeFile(control+'.next',JSON.stringify({pick:b.rootDisplay,...options}));await fs.rename(control+'.next',control);await shell.click('#pick-project');await until(async()=>JSON.parse(await fs.readFile(control,'utf8')).picked,'chooser decision');await shell.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function failureText(){return shell.evaluate(()=>[...document.querySelectorAll('#save-error,#toast,#workspace-toast')].filter(node=>node.checkVisibility()).map(node=>node.textContent).join(' '));}
async function restoreA(){await shell.click('[data-project-id="'+a.id+'"]');await current(a);return surface(a);}
const edit='\nUNSAVED PROJECT A CONTENT';
try{
  child=spawn(createRequire(import.meta.url)('electron'),[launcher,'--ozone-platform='+ (process.env.NOZELI_OZONE||'wayland')],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  child.on('error',error=>{launchError=error;});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;});
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'CDP');
  shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__workspaceScope?.role==='shell'&&window.__nozeliReady).catch(()=>false))return page;},'shell');
  watch(shell);browser.on('targetcreated',async target=>{const page=await target.page().catch(()=>null);if(page)watch(page);});
  if(await shell.$eval('#configuration-setup',node=>node.open)){await shell.click('#configuration-cancel');await shell.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
  await shell.click('[data-project-id="'+a.id+'"]');await current(a);
  let pageA=await surface(a);
  await pageA.evaluate(text=>__nozeliInput.insert(text),edit);
  const originalA=pageA,originalText=await pageA.evaluate(()=>{window.__scopeJourneyEditor=document.querySelector('#text-host .cm-editor');return __nozeliInput.text();});
  const chatA=await conversation(a);await chatA.locator('#composer').fill(draft+' — live native input');
  assert.equal(await chatA.$eval('#composer',node=>node.value),draft+' — live native input');
  await pick({cancel:true});await until(async()=>(await call(shell,'workspace.bootstrap')).projectId===a.id,'cancel remains A');
  await current(a);assert.equal(await pageA.evaluate(()=>__nozeliInput.text().includes('UNSAVED PROJECT A CONTENT')),true);
  assert.equal(await chatA.$eval('#composer',node=>node.value),draft+' — live native input');report.checks.push('picker cancellation leaves A/A, current editor and unsent native conversation draft unchanged');
  await pick({rejectRecovery:true});await until(async()=>(await failureText()).includes('Synthetic recovery disk write denied'),'switch recovery error feedback');
  await current(a);assert.equal(await chatA.$eval('#composer',node=>node.value),draft+' — live native input');assert.equal(pageA.isClosed(),false);
  report.checks.push('recovery persistence rejection visibly reports its cause and preserves A/A with live document and draft');
  await shell.screenshot({path:path.join(out,'switch-save-failed.png')});
  await pageA.screenshot({path:path.join(out,'preserved-a-document.png')});await chatA.screenshot({path:path.join(out,'preserved-a-draft.png')});
  await call(shell,'session.requestClose');
  await until(async()=>{try{return (await fs.readFile(dialogs,'utf8')).includes('Synthetic recovery disk write denied');}catch{return false;}},'native close save-failed detail');
  assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);await current(a);
  assert.equal(await chatA.$eval('#composer',node=>node.value),draft+' — live native input');report.checks.push('failed normal close displays specific native save failure and keeps window/draft instead of silently closing');
  await pick({rejectAttachment:true});await until(async()=>(await failureText()).includes('Synthetic native attachment denied'),'native attachment rollback feedback');
  await current(a);assert.equal(pageA.isClosed(),false);assert.equal(await pageA.evaluate(()=>__nozeliInput.text().includes('UNSAVED PROJECT A CONTENT')),true);
  assert.equal(await chatA.$eval('#composer',node=>node.value),draft+' — live native input');assert((await fs.readFile(dialogs,'utf8')).includes(JSON.stringify({boundary:'addChildView',projectId:b.id})));report.checks.push('native B attachment failure rolls back to A/A with original live content and unsent draft');
  await pick({});await current(b);
  assert.equal(await shell.$eval('#composer',node=>node.value).then(value=>value.includes(draft)),false,'A draft must not leak into B');
  await shell.click('#file-tree [data-path="sample.txt"]');const pageB=await surface(b);
  assert.equal(await pageB.evaluate(()=>__nozeliInput.text()),'Project B original\n');
  report.checks.push('real picker A→B commits coherent B/B; B document and composer contain no A content');
  pageA=await restoreA();assert.equal(pageA,originalA,'A retains the identical WebContents page');assert.equal(await pageA.evaluate(()=>window.__scopeJourneyEditor===document.querySelector('#text-host .cm-editor')),true);assert.equal(await pageA.evaluate(()=>__nozeliInput.text()),originalText);
  const restoredChat=await conversation(a);assert.equal(await restoredChat.$eval('#composer',node=>node.value),draft+' — live native input');report.checks.push('returning to A restores its edited document and exact unsent native conversation draft');
  const documentViewId=(await call(pageA,'workspace.bootstrap')).viewId,chatViewId=(await call(restoredChat,'workspace.bootstrap')).viewId;
  await pageA.bringToFront();await pageA.evaluate(()=>__nozeliInput.focus());await pageA.keyboard.type('\nAFTER RETURN EDIT');
  assert.equal(await pageA.evaluate(()=>__nozeliInput.text().includes('AFTER RETURN EDIT')),true);assert.equal((await call(pageA,'workspace.bootstrap')).projectId,a.id);report.checks.push('restored A keeps identical WebContents/editor and accepts subsequent trusted keyboard editing under A scope');
  await pick({});await current(b);await shell.screenshot({path:path.join(out,'project-b-coherent.png')});const finalB=await surface(b);await finalB.screenshot({path:path.join(out,'project-b-document.png')});
  await call(shell,'session.requestClose');const exit=await Promise.race([exited,pause(15000).then(()=>{throw Error('Normal B close did not exit');})]);
  assert.deepEqual(exit,{code:0,signal:null});report.exit=exit;
  assert.equal((await fs.readFile(path.join(b.rootDisplay,'sample.txt'),'utf8')),'Project B original\n');
  const retainedDocument=await host.storage.getRecovery(a.id,'workspace:'+documentViewId),retainedChat=await host.storage.getRecovery(a.id,'workspace:'+chatViewId);
  assert.match(retainedDocument?.candidate?.text??await fs.readFile(path.join(a.rootDisplay,'sample.txt'),'utf8'),/UNSAVED PROJECT A CONTENT/);
  assert.match(retainedDocument?.candidate?.text??await fs.readFile(path.join(a.rootDisplay,'sample.txt'),'utf8'),/AFTER RETURN EDIT/);
  assert.equal(retainedChat?.workspace?.draft,draft+' — live native input');
  assert.deepEqual(report.errors,[]);report.checks.push('B normal close exits 0; A edit remains durable and B source remains uncontaminated');report.passed=true;
}catch(error){report.passed=false;report.error=error.stack;if(browser)report.pages=await Promise.all((await browser.pages()).map(page=>page.evaluate(()=>({scope:window.__workspaceScope,ready:window.__nozeliReady,body:document.body.innerText.slice(0,500)})).catch(()=>null)));throw error;}
finally{await browser?.disconnect();if(child&&child.exitCode===null&&!child.signalCode)child.kill('SIGKILL');await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.rm(launcher,{force:true});console.log(JSON.stringify(report,null,2));}
