// Permanent macOS real-package workspace journey: split left/right and
// top/bottom, pane switching, read-only split mirror rejecting writes, float to
// an independent native window and dock back with per-window reading positions
// and edits retained, clean quit → relayout/content restore on a fresh process,
// and closing one pane without losing the other pane's unsent draft. Runs
// against the installed Nozeli.app inner binary through NOZELI_TEST_BINARY
// with an isolated synthetic project and a profile outside the repository; on
// darwin the Linux ozone flags are never passed to the packaged binary.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {layoutGroups,findView} from '../src/domain/workspace-layout.mjs';

const root=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'nozeli-mac-workspace-'));
const configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop');
const host=new DesktopHost(profile);
const projectDir=path.join(out,'Project A');
await fs.mkdir(projectDir);
await fs.writeFile(path.join(projectDir,'a.txt'),'A original\n'+Array.from({length:240},(_,n)=>'line '+n).join('\n'));
await fs.writeFile(path.join(projectDir,'b.txt'),'B original\n'+Array.from({length:120},(_,n)=>'row '+n).join('\n'));
const project=(await host.pick(projectDir)).project,a=project;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const binary=process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron');
// Linux CI keeps its ozone selection; darwin (packaged or local Electron) gets
// no Linux windowing flags at all.
const platformArgs=process.platform==='linux'?['--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')]:[];
const report={out,checks:[],platform:process.platform,binary,errors:[]};
let child,browser,shell,log='';
async function until(fn,label){const end=Date.now()+45000;do{const value=await fn();if(value)return value;if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error(log);await pause(50);}while(Date.now()<end);throw Error('Timed out: '+label);}
async function rawCall(p,op,payload={}){return p.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);}
async function call(p,op,payload={}){const r=await rawCall(p,op,payload);if(!r.ok)throw Error(op+': '+JSON.stringify(r));return r.value;}
async function scoped(test){return until(async()=>{for(const p of await browser.pages()){if(!p.url().startsWith('http://127.0.0.1:'))continue;const scope=await p.evaluate(async()=>{const r=await nozeli.invoke('workspace.bootstrap',{});return r.value;}).catch(()=>null);if(scope&&test(scope)&&await p.evaluate(()=>window.__nozeliReady===true))return {page:p,scope};}return null;},'registered ready content');}
const snapshot=async()=>(await call(shell,'workspace.snapshot',{projectId:a.id})).layout;
const fileRow=id=>'#workspace-open-editors [data-editor-view="'+id+'"]';
const paneOf=id=>'[data-workspace-content][data-view-id="'+id+'"]';
async function context(id,command){await shell.locator(fileRow(id)).click({button:'right'});await shell.waitForSelector('.nozeli-context-menu:not([hidden]) [data-command="'+command+'"]');await shell.locator('.nozeli-context-menu:not([hidden]) [data-command="'+command+'"]').click();}
const splitAxes=node=>node?.kind==='split'?[node.axis,...splitAxes(node.first),...splitAxes(node.second)]:[];
const scrollState=page=>page.evaluate(()=>{const cm=document.querySelector('.cm-scroller'),reader=document.querySelector('#reader-scroll');return {cm:cm?cm.scrollTop:0,reader:reader?reader.scrollTop:0};});
async function launch(){
  const port=await freePort();
  child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(root,'src/main/main.cjs')]),...platformArgs],{cwd:root,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:configRoot,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_HIDDEN:'0'},stdio:['ignore','pipe','pipe']});
  log='';
  for(const s of [child.stdout,child.stderr])s.on('data',c=>log+=c);
  await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'debug');
  shell=(await scoped(s=>s.role==='shell')).page;
  shell.on('pageerror',e=>report.errors.push(e.message));
  if(await shell.$('#configuration-setup[open]')){await shell.click('#configuration-cancel');await shell.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
}
async function openProjectA(){
  await shell.waitForSelector('[data-project-id="'+a.id+'"]',{visible:true});
  await shell.click('[data-project-id="'+a.id+'"]');
  await until(async()=>(await call(shell,'workspace.bootstrap')).projectId===a.id,'project A binding');
}
try{
  // First launch: split both axes, verify the read-only mirror, float and dock,
  // then quit cleanly.
  await launch();
  await openProjectA();
  await shell.waitForSelector('#file-tree [data-path="a.txt"]');await shell.click('#file-tree [data-path="a.txt"]');
  let first=await scoped(s=>s.projectId===a.id&&s.relPath==='a.txt'&&!s.readOnly),firstId=first.scope.viewId;
  await context(firstId,'split-x');
  await until(async()=>layoutGroups(await snapshot()).length===2,'split-x creates a second pane');
  let state=await snapshot();
  assert(state.views[firstId]);
  const mirror=Object.values(state.views).find(v=>v.sourceViewId===firstId);assert(mirror,'split-x opens a mirror view');
  const mirrorScope=await scoped(s=>s.viewId===mirror.id);
  assert.equal(mirrorScope.scope.readOnly,true,'split mirror surface is read-only');
  // Read-only mirror rejects writes in the renderer and at the native boundary.
  const mirrorText=await mirrorScope.page.evaluate(()=>__nozeliInput.text());
  const insertRejected=await mirrorScope.page.evaluate(()=>{try{__nozeliInput.focus();__nozeliInput.insert('\nmirror write attempt');return false;}catch{return true;}});
  assert.equal(insertRejected,true,'mirror adapter rejects the edit');
  assert.equal(await mirrorScope.page.evaluate(()=>__nozeliInput.text()),mirrorText,'mirror editor discards typed input');
  const typed=await mirrorScope.page.evaluate(()=>{__nozeliInput.focus();const before=__nozeliInput.text();__nozeliInput.select(0,4);return before;});
  assert.equal(typed,mirrorText,'mirror selection never dirties the document');
  const denied=await rawCall(mirrorScope.page,'file.save',{projectId:a.id,relPath:'a.txt',text:mirrorText+'\nmirror save attempt'});
  assert.equal(denied.ok,false,'mirror save must be rejected');
  assert.equal(denied.error.code,'EDIT_LEASE_DENIED','mirror save rejected with the edit-lease denial');
  report.checks.push('split mirror is read-only: typed input is discarded and file.save is rejected with EDIT_LEASE_DENIED');
  // Activate the a.txt pane first so b.txt opens beside the mirror, not into it.
  await shell.locator(fileRow(firstId)).click();
  await scoped(s=>s.role==='surface'&&s.viewId===firstId&&s.projectId===a.id);
  await shell.waitForSelector(paneOf(firstId),{visible:true});
  // Top/bottom split on the second document in the same workspace.
  await shell.click('#file-tree [data-path="b.txt"]');
  const second=await scoped(s=>s.projectId===a.id&&s.relPath==='b.txt'&&!s.readOnly),secondId=second.scope.viewId;
  await context(secondId,'split-y');
  await until(async()=>splitAxes((await snapshot()).mainRoot).includes('y'),'split-y creates a top/bottom axis');
  state=await snapshot();
  assert.deepEqual(splitAxes(state.mainRoot).sort(),['x','y'],'workspace holds left/right and top/bottom splits');
  report.checks.push('split-x and split-y coexist: left/right and top/bottom panes in one layout');
  // Pane switching between all opened records shows the exact file content.
  const diskA=await fs.readFile(path.join(projectDir,'a.txt'),'utf8'),diskB=await fs.readFile(path.join(projectDir,'b.txt'),'utf8');
  for(const [viewId,expected] of [[firstId,diskA],[mirror.id,diskA],[secondId,diskB]]){
    await shell.locator(fileRow(viewId)).click();
    const active=await scoped(s=>s.role==='surface'&&s.viewId===viewId&&s.projectId===a.id);
    await shell.waitForSelector(paneOf(viewId),{visible:true});
    assert.equal(await active.page.evaluate(()=>__nozeliInput.text()),expected,'switched pane shows its exact file content');
  }
  report.checks.push('pane switching across split views shows the exact a.txt/b.txt content');
  // Float the b.txt document into an independent native window.
  await shell.locator(fileRow(secondId)).click();
  await context(secondId,'float');
  const detached=await scoped(s=>s.role==='detached'&&s.projectId===a.id);
  await until(async()=>(await call(second.page,'workspace.bootstrap')).windowId===detached.scope.windowId,'same live b.txt surface floated');
  let windows=await call(shell,'workspace.windows.list',{projectId:a.id});
  const float=windows.find(w=>w.id===detached.scope.windowId),main=windows.find(w=>w.id==='main');
  assert.notEqual(float.nativeWindowId,main.nativeWindowId,'float is a distinct native window');
  // Two windows hold different reading positions and independent edits.
  await first.page.bringToFront();await first.page.waitForFunction(()=>document.hasFocus());
  for(let step=0;step<10;step++){await first.page.mouse.wheel({deltaY:180});await pause(60);}
  await second.page.bringToFront();await second.page.waitForFunction(()=>document.hasFocus());
  for(let step=0;step<4;step++){await second.page.mouse.wheel({deltaY:120});await pause(60);}
  const draft='\n独立窗口未保存稿';
  await second.page.evaluate(draft=>{__nozeliInput.focus();__nozeliInput.insert(draft);},draft);
  await second.page.waitForFunction(draft=>__nozeliInput.text().includes(draft),{},draft);
  const firstScroll=await scrollState(first.page),secondScroll=await scrollState(second.page);
  assert(Math.max(firstScroll.cm,firstScroll.reader)>200,'main window a.txt is scrolled while reading');
  assert(Math.max(secondScroll.cm,secondScroll.reader)<Math.max(firstScroll.cm,firstScroll.reader),'the two windows hold different reading positions');
  await until(async()=>{const value=await host.readState(a.id);return (value.state?.workspace?.draft??'').includes(draft)||(await fs.readFile(path.join(projectDir,'b.txt'),'utf8')).includes(draft);},'b.txt edits are durable as a draft or autosaved bytes');
  await shell.bringToFront();
  assert.equal(await second.page.evaluate(value=>__nozeliInput.text().includes(value),draft),true,'draft retained while the main window is focused');
  report.checks.push('independent float and main window keep different reading positions and preserve local edits');
  // Dock the float back; the layout returns to the main workspace with the draft.
  await detached.page.locator('.workspace-pane-header').click({button:'right'});
  await detached.page.waitForSelector('#workspace-title-menu:not([hidden]) [data-command="dock"]',{visible:true});
  await detached.page.click('#workspace-title-menu [data-command="dock"]');
  await until(async()=>findView(await snapshot(),secondId)?.windowId==='main','dock returns b.txt to the main workspace');
  await until(async()=>detached.page.isClosed(),'float window closes after dock');
  const docked=await scoped(s=>s.role==='surface'&&s.viewId===secondId&&s.projectId===a.id);
  assert.equal(await docked.page.evaluate(value=>__nozeliInput.text().includes(value),draft),true,'docked b.txt keeps its unsent draft');
  report.checks.push('docking the independent window returns the live document and its local edits to the workspace');
  // Persist the a.txt edit explicitly so restart verification separates saved
  // content from the durable draft.
  await first.page.bringToFront();await first.page.click('#text-host .cm-content');await first.page.waitForFunction(()=>document.hasFocus());
  await first.page.evaluate(()=>{__nozeliInput.insert('\nSaved before restart');});
  await first.page.keyboard.down('Control');await first.page.keyboard.press('s');await first.page.keyboard.up('Control');
  const savedText=await first.page.evaluate(()=>__nozeliInput.text());
  await until(async()=>await fs.readFile(path.join(projectDir,'a.txt'),'utf8')===savedText,'a.txt edit saved before restart');
  const beforeAxes=splitAxes((await snapshot()).mainRoot).sort().join(','),beforeGroups=layoutGroups(await snapshot()).length;
  await shell.screenshot({path:path.join(out,'before-restart-layout.png')});
  // Clean quit: confirm the native shutdown choice when the app asks.
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  await call(shell,'session.requestClose');
  await until(async()=>child.exitCode!==null||await shell.$eval('#quit-choice',n=>n.open).catch(()=>false),'clean exit or shutdown confirmation');
  if(child.exitCode===null)await shell.click('#quit-cancel');
  assert.deepEqual(await Promise.race([exited,pause(20000).then(()=>null)]),{code:0,signal:null},'first launch exits cleanly');
  await browser.disconnect();
  report.checks.push('explicit close with shutdown confirmation exits the packaged app with code 0');
  // Second launch on the same isolated profile: layout and content restore.
  await launch();
  await openProjectA();
  await until(async()=>{const views=Object.values((await snapshot()).views);return views.some(v=>v.relPath==='a.txt'&&!v.readOnly)&&views.some(v=>v.relPath==='b.txt'&&!v.readOnly);},'restored layout keeps both document views');
  state=await snapshot();
  assert.equal(layoutGroups(state).length,beforeGroups,'restored layout preserves the pane count');
  assert.equal(splitAxes(state.mainRoot).sort().join(','),beforeAxes,'restored layout preserves both split axes');
  const restoredFirst=await scoped(s=>s.role==='surface'&&s.projectId===a.id&&s.relPath==='a.txt'&&!s.readOnly);
  assert.equal(await restoredFirst.page.evaluate(()=>__nozeliInput.text()),savedText,'saved a.txt edit restored after restart');
  const restoredSecond=await scoped(s=>s.role==='surface'&&s.projectId===a.id&&s.relPath==='b.txt'&&!s.readOnly);
  assert.equal(await restoredSecond.page.evaluate(value=>__nozeliInput.text().includes(value),draft),true,'unsent b.txt draft restored after restart');
  report.checks.push('restart on the same profile restores the split layout, saved content and durable local edits');
  // Closing one pane must not lose the other pane's unsent draft.
  const sourceBeforeDraft=await fs.readFile(path.join(projectDir,'b.txt'),'utf8');
  await fs.chmod(path.join(projectDir,'b.txt'),0o444);
  await restoredSecond.page.evaluate(()=>{__nozeliInput.focus();__nozeliInput.insert('\n关闭另一个窗格前的稿');});
  await restoredSecond.page.waitForFunction(()=>__nozeliInput.text().includes('关闭另一个窗格前的稿'));
  const restoredIds=Object.fromEntries(Object.values(state.views).filter(v=>!v.readOnly).map(v=>[v.relPath,v.id]));
  const closeTarget=restoredIds['a.txt'];
  await shell.locator('#workspace-open-editors [data-editor-close="'+closeTarget+'"]').click();
  await until(async()=>!(await snapshot()).views[closeTarget],'closed pane removed from the layout');
  const survivor=await scoped(s=>s.role==='surface'&&s.viewId===restoredIds['b.txt']&&s.projectId===a.id);
  const retainedText=await survivor.page.evaluate(()=>__nozeliInput.text());
  await until(async()=>{const record=await host.readDraftRecord(a.id,'b.txt');return record?.text===retainedText;},'unsaved candidate stays durable after the other pane closed');
  assert.equal(await fs.readFile(path.join(projectDir,'b.txt'),'utf8'),sourceBeforeDraft,'permission refusal must leave the source unchanged');
  report.checks.push('closing one pane keeps the other pane open with its unsent draft intact and durable');
  assert.equal((await call(shell,'config.status',{})).initialized,false,'configuration stays uninitialized; nothing dispatched');
  assert.deepEqual(report.errors,[]);
  const finalExit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  await call(shell,'session.requestClose');
  await until(async()=>child.exitCode!==null||await shell.$eval('#quit-choice',n=>n.open).catch(()=>false),'second clean exit or confirmation');
  if(child.exitCode===null)await shell.click('#quit-cancel');
  report.finalExit=await Promise.race([finalExit,pause(20000).then(()=>null)]);
  assert.deepEqual(report.finalExit,{code:0,signal:null});
  await fs.chmod(path.join(projectDir,'b.txt'),0o644);
  report.ok=true;
  console.log(JSON.stringify(report,null,2));
}catch(error){
  report.failure=error.stack;report.log=log;console.error(out,log,error);
  await Promise.race([shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{}),pause(2000)]);
  throw error;
}finally{
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(out,'main.log'),log);
  await Promise.race([browser?.disconnect().catch(()=>{}),pause(3000)]);
  if(child&&child.exitCode===null){child.kill('SIGKILL');await Promise.race([new Promise(r=>child.once('exit',r)),pause(5000)]);}
}
