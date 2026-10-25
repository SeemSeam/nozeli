// Single-content workspace journey on the current independent product: explicit
// project choice through host.pick, real storage-v2 profile beneath an explicit
// isolated .Nozeli root, and a storage-v2 runtime for the preloaded accepted work.
// No legacy Agent fixture and no provider/model/session setup — the one-time
// configuration stays uninitialized, so nothing can dispatch model work; the
// preloaded history is synthetic and must never replay. Responsiveness numbers
// come from the shared bounded probe: per-surface renderer frame and
// trusted-input observations; Node elapsed times include CDP/wait overhead and
// are not paint latency. Live divider axis-x gestures are measured here; the full
// both-axis divider journey lives in desktop-native-project.test.mjs.
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
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {readManagedState} from '../src/agents/managed/managed-storage.mjs';
import {staticReport} from './static-report.fixture.mjs';
import {measureResponsiveness,summarizeResponsiveness,observeProcessMemory} from './responsiveness-metrics.fixture.mjs';
import {observeProcessResources} from './process-resources.fixture.mjs';

const root=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-single-content-'));
const configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop');
const host=new DesktopHost(profile),projects=[];
for(const name of ['Project B','Project A']){
 const dir=path.join(out,name);
 await fs.mkdir(dir);
 await fs.writeFile(path.join(dir,'a.txt'),'A original\n'+Array.from({length:100},(_,n)=>'line '+n).join('\n'));
 await fs.writeFile(path.join(dir,'b.txt'),'B original\n');
 projects.push((await host.pick(dir)).project);
}
const [b,a]=projects,pause=ms=>new Promise(r=>setTimeout(r,ms));
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
let child,browser,shell,log='';
let memorySampler={stop:async()=>({supported:false,samples:[],boundary:'sampler not started'})};
const REGULAR_RESOURCES=process.env.NOZELI_REGULAR_RESOURCES==='1';let resourceSampler=null;
async function regularIdle(label,seconds){if(!REGULAR_RESOURCES)return;resourceSampler.mark(label);console.log(JSON.stringify({phase:label,seconds,out}));await pause(seconds*1000);}
const report={out,checks:[],windows:[],errors:[],responsivenessRecords:{root:[],content:[]},scope:'two explicit isolated synthetic projects; storage-v2 profile and runtime; preloaded accepted history is synthetic and must never replay; no provider, model or session exists'};
const rootRecords=report.responsivenessRecords.root,contentRecords=report.responsivenessRecords.content;
const phase=async(surface,page,label,action)=>{const records=surface==='root'?rootRecords:contentRecords,before=records.length;await measureResponsiveness(page,label,action,records);if(records.length>before)records.at(-1).surface=surface;};
const dualPhase=async(contentPage,contentLabel,rootLabel,action)=>{await phase('content',contentPage,contentLabel,()=>phase('root',shell,rootLabel,action));};
const nextFramesOn=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
// Current storage-v2 convention: the accepted work runtime lives in the project's
// storage instance directory, not in a hand-written profile path.
const history=await Workspace.open(path.join(await host.storage.localDirectory(a.id),'execution'),path.join(out,a.name),{storage:host.storage,projectId:a.id});
const accepted=await history.submit('Previously accepted request; never replay on layout changes','fixture',{name:'Historical accepted work'});
await history.activate(accepted.id);
await history.publish(accepted.id,1,'result',staticReport('# Existing saved result\n'),'fixture-existing-receipt');
await history.settle(accepted.id);
await history.close();
const business=async()=>{const value=await readManagedState(host.storage,a.id);return {works:value.works.map(w=>({id:w.id,revision:w.revision,status:w.status})),receipts:value.receipts.map(r=>({id:r.id,objectId:r.objectId})),jobs:(value.jobs??[]).map(j=>({id:j.id,status:j.status}))};};
const beforeBusiness=await business();
async function call(p,op,payload={}){const r=await p.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);assert(r.ok,op+': '+JSON.stringify(r));return r.value;}
async function until(fn,label){const end=Date.now()+30000;do{const value=await fn();if(value)return value;if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error(log);await pause(50);}while(Date.now()<end);throw Error('Timed out: '+label);}
async function scoped(test){return until(async()=>{for(const p of await browser.pages()){if(!p.url().startsWith('http://127.0.0.1:'))continue;const scope=await p.evaluate(async()=>{const r=await nozeli.invoke('workspace.bootstrap',{});return r.value;}).catch(()=>null);if(scope&&test(scope)&&await p.evaluate(()=>window.__nozeliReady===true))return {page:p,scope};}return null;},'registered ready content');}
const snapshot=async()=>(await call(shell,'workspace.snapshot',{projectId:a.id})).layout;
const fileRow=id=>'#workspace-open-editors [data-editor-view="'+id+'"]';
const paneOf=id=>'[data-workspace-content][data-view-id="'+id+'"]';
const nativeVisible=async viewId=>until(async()=>(await call(shell,'workspace.windows.list',{projectId:a.id})).flatMap(w=>w.surfaces).some(s=>s.viewId===viewId&&s.visible===true),'native visibility '+viewId);
const noConversationSurfaces=async()=>{const windows=await call(shell,'workspace.windows.list',{projectId:a.id});assert(windows.flatMap(w=>w.surfaces).every(s=>s.kind!=='conversation'),'no conversation surface without explicit provider setup');};
async function context(id,command){await shell.locator(fileRow(id)).click({button:'right'});await shell.waitForSelector('.nozeli-context-menu:not([hidden]) [data-command="'+command+'"]');await shell.locator('.nozeli-context-menu:not([hidden]) [data-command="'+command+'"]').click();}
const contentState=page=>page.evaluate(()=>({owner:window.__workspaceScope.viewId,text:window.__nozeliInput.text(),width:innerWidth,height:innerHeight}));
// Keep the full sampler stop result, but summarize only finite live sum-RSS
// samples: post-exit {exited:true} records carry no sumRssKiB, so counting them
// could make process shutdown look like memory recovery. Sum RSS double-counts
// shared pages; this is a trend, never a leak verdict.
const summarizeProcessMemory=stopResult=>{
 const live=(stopResult?.samples??[]).filter(sample=>Number.isFinite(sample.sumRssKiB)).map(sample=>sample.sumRssKiB);
 return {...stopResult,liveSummaries:{samples:live.length,firstSumRssKiB:live[0]??null,maxSumRssKiB:live.length?Math.max(...live):null,lastSumRssKiB:live.at(-1)??null,note:'finite live sum-RSS samples only; post-exit exited records excluded; shared pages double-counted; process-tree trend, no leak verdict'}};
};
try{
 child=spawn(process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(root,'src/main/main.cjs')]),'--ozone-platform=wayland'],{cwd:root,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:configRoot,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_HIDDEN:'0'},stdio:['ignore','pipe','pipe']});
 for(const s of [child.stdout,child.stderr])s.on('data',c=>log+=c);
 memorySampler=observeProcessMemory(child.pid);
 if(REGULAR_RESOURCES)resourceSampler=observeProcessResources(child.pid);
 await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'debug');
 shell=(await scoped(s=>s.role==='shell')).page;shell.on('pageerror',e=>report.errors.push(e.message));
 if(await shell.$('#configuration-setup[open]')){await shell.click('#configuration-cancel');await shell.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
 const configuration=await call(shell,'config.status',{});
 assert.equal(configuration.initialized,false,'independent configuration stays uninitialized; no provider, model or session exists');
 await shell.waitForSelector('[data-project-id="'+a.id+'"]',{visible:true});await shell.click('[data-project-id="'+a.id+'"]');
 await until(async()=>(await call(shell,'workspace.bootstrap')).projectId===a.id,'explicit project A binding');
 assert.equal((await call(shell,'managed.status',{projectId:a.id})).ready,false,'no managed conversation owner without explicit provider setup');
 await shell.waitForSelector('#file-tree [data-path="a.txt"]');await shell.click('#file-tree [data-path="a.txt"]');
 let first=await scoped(s=>s.projectId===a.id&&s.relPath==='a.txt'&&!s.readOnly),firstId=first.scope.viewId;
 if(REGULAR_RESOURCES){
  report.runtime={userAgent:await browser.userAgent(),platform:process.platform,devicePixelRatio:await first.page.evaluate(()=>devicePixelRatio)};
  await first.page.bringToFront();await regularIdle('idle-before-use',25);
  resourceSampler.mark('reading-and-editing');
  await phase('content',first.page,'regular reading scroll',async()=>{await first.page.mouse.move(400,300);for(let step=0;step<8;step++){await first.page.mouse.wheel({deltaY:step<4?160:-160});await pause(350);}});
  await first.page.evaluate(()=>__nozeliInput.focus());await first.page.waitForFunction(()=>document.hasFocus());
  await first.page.keyboard.down('Control');await first.page.keyboard.press('End');await first.page.keyboard.up('Control');
  const beforeTyping=await first.page.evaluate(()=>__nozeliInput.text()),typed='\nRegular use: reading notes, checking details, then saving the local document.';
  await phase('content',first.page,'regular physical typing',()=>first.page.keyboard.type(typed,{delay:45}));
  assert.equal(await first.page.evaluate(()=>__nozeliInput.text()),beforeTyping+typed);
  await phase('content',first.page,'regular explicit save',async()=>{await first.page.keyboard.down('Control');await first.page.keyboard.press('s');await first.page.keyboard.up('Control');await until(async()=>await fs.readFile(path.join(out,a.name,'a.txt'),'utf8')===beforeTyping+typed,'typed document saved');});
  await regularIdle('idle-after-reading-editing',20);resourceSampler.mark('file-switches-and-split');
 }
 await first.page.evaluate(()=>{__nozeliInput.insert('\nPreserved edit');__nozeliInput.select(8,12);});
 await shell.click('#file-tree [data-path="b.txt"]');
 let second=await scoped(s=>s.projectId===a.id&&s.relPath==='b.txt');
 let state=await snapshot();assert(state.views[firstId]);assert.equal(layoutGroups(state).length,1);assert.equal(layoutGroups(state)[0].views.length,1);
 let windows=await call(shell,'workspace.windows.list',{projectId:a.id});
 assert.equal(windows.flatMap(window=>window.surfaces).filter(surface=>surface.relPath&&surface.visible).length,1);
 assert.equal(await shell.$$eval('[data-workspace-tab],.workspace-tabs',n=>n.length),0);
 report.checks.push('two opened records present only one visible file in the pane, independently of inactive renderer residency');
 await shell.locator(fileRow(firstId)).click();
 first=await scoped(s=>s.projectId===a.id&&s.relPath==='a.txt'&&!s.readOnly);
 assert.equal(await first.page.evaluate(()=>__nozeliInput.text().includes('Preserved edit')),true);
 await first.page.bringToFront();await first.page.evaluate(()=>__nozeliInput.focus());await first.page.waitForFunction(()=>document.hasFocus());
 await first.page.keyboard.down('Control');await first.page.keyboard.press('s');await first.page.keyboard.up('Control');
 await until(async()=>await fs.readFile(path.join(out,a.name,'a.txt'),'utf8')===await first.page.evaluate(()=>__nozeliInput.text()),'explicit save persists the retained edit');
 assert.deepEqual(await first.page.evaluate(()=>__nozeliInput.selection()),{anchor:8,head:12,from:8,to:12});
 report.checks.push('left opened-file switch preserves the edit and independent selection; explicit keyboard save persists the retained source');
 // 32 measured warm switches between the two opened records, each with root and
 // content renderer observations plus native visibility of the activated surface.
 const switchTargets=[firstId,second.scope.viewId];const secondId=switchTargets[1];
 for(let i=0;i<32;i++){
  const viewId=switchTargets[i%2];
  await phase('root',shell,'warm workspace switch (root renderer)',async()=>{
   await shell.locator(fileRow(viewId)).click();
   await scoped(s=>s.role==='surface'&&s.viewId===viewId&&s.projectId===a.id);
   await shell.waitForSelector(paneOf(viewId),{visible:true});
   await nativeVisible(viewId);
  });
  const active=await scoped(s=>s.role==='surface'&&s.viewId===viewId&&s.projectId===a.id);
  await phase('content',active.page,'warm workspace switch (content surface settle)',async()=>{await nextFramesOn(active.page);});
  if(i%8===0)assert((await contentState(active.page)).text.length>0,'warm switch leaves populated content');
 }
 report.checks.push('32 warm switches measured on root and content renderers with native visibility verified per switch');
 await shell.locator(fileRow(firstId)).click();
 first=await scoped(s=>s.role==='surface'&&s.viewId===firstId&&s.projectId===a.id);
 await context(firstId,'split-x');await until(async()=>layoutGroups(await snapshot()).length===2,'left-list split-open');
 state=await snapshot();assert(layoutGroups(state).every(p=>p.views.length<=1));
 const mirror=Object.values(state.views).find(v=>v.sourceViewId===firstId);assert(mirror);
 await scoped(s=>s.viewId===mirror.id);
 await shell.screenshot({path:path.join(out,'single-file-split-chrome.png')});await first.page.screenshot({path:path.join(out,'file-content.png')});
 report.checks.push('right-click left opened file splits into two single-content panes');
 if(REGULAR_RESOURCES)resourceSampler.mark('resize-and-project-switches');
 // One measured live divider gesture on the split axis-x divider: click keeps the
 // revision, live drag repaints native content before release, Escape restores,
 // release commits. Both-axis coverage with minimum bounds lives in the project test.
 const splitNode=(node,id)=>!node?null:node.id===id?node:splitNode(node.first,id)??splitNode(node.second,id);
 const splitIds=node=>node?.kind==='split'?[node.id,...splitIds(node.first),...splitIds(node.second)]:[];
 state=await snapshot();const workspaceSplitId=splitIds(state.mainRoot)[0];assert(workspaceSplitId,'split-x created a divider');
 const workspaceSplit=splitNode(state.mainRoot,workspaceSplitId),dividerAxis=workspaceSplit.axis;
 const ownerGroup=layoutGroups(state).find(g=>g.activeViewId===firstId);assert(ownerGroup);
 await shell.locator(fileRow(firstId)).click();
 first=await scoped(s=>s.role==='surface'&&s.viewId===firstId&&s.projectId===a.id);
 await shell.waitForSelector(paneOf(firstId),{visible:true});
 const divider=await shell.waitForSelector('[data-split-id="'+workspaceSplitId+'"]>.workspace-divider',{visible:true});
 const dividerPoint=async()=>{const box=await divider.boundingBox();assert(box,'divider has real bounds');return {x:box.x+box.width/2,y:box.y+box.height/2};};
 const domRatio=id=>shell.$eval('[data-split-id="'+id+'"]',e=>Number(e.style.getPropertyValue('--ratio')));
 await shell.bringToFront();state=await snapshot();const beforeRatio=splitNode(state.mainRoot,workspaceSplitId).ratio;
 const clickAt=await dividerPoint();await shell.mouse.click(clickAt.x,clickAt.y);await nextFramesOn(shell);
 let afterClick=await snapshot();assert.equal(afterClick.revision,state.revision,'pure divider click cannot commit a layout revision');assert.equal(splitNode(afterClick.mainRoot,workspaceSplitId).ratio,beforeRatio);assert.equal(await domRatio(workspaceSplitId),beforeRatio);
 const dragBaseline=await contentState(first.page),direction=beforeRatio>=.5?-1:1,live=[];
 await shell.bringToFront();const dragStart=await dividerPoint();await shell.mouse.move(dragStart.x,dragStart.y);await shell.mouse.down();
 await dualPhase(first.page,'divider live drag preview axis-'+dividerAxis+' (content surface)','divider live drag preview axis-'+dividerAxis+' (root renderer)',async()=>{
  for(const distance of [30,60,90]){
   await shell.mouse.move(dividerAxis==='x'?dragStart.x+direction*distance:dragStart.x,dividerAxis==='y'?dragStart.y+direction*distance:dragStart.y,{steps:16});
   const previous=live.at(-1)??dragBaseline;
   await until(async()=>{const value=await contentState(first.page);if(value[dividerAxis==='x'?'width':'height']===previous[dividerAxis==='x'?'width':'height'])return false;live.push(value);return true;},'live native content dimension change while pointer is held');
  }
 });
 const held=await snapshot();assert.equal(held.revision,afterClick.revision,'drag preview does not persist before release');
 assert.notEqual(await domRatio(workspaceSplitId),beforeRatio,'drag paints a live DOM ratio');
 for(const sample of live){assert.equal(sample.owner,firstId);assert(sample.text.length>0);}
 await shell.keyboard.press('Escape');await shell.mouse.up();
 await until(async()=>await domRatio(workspaceSplitId)===beforeRatio,'Escape restores DOM ratio');
 await until(async()=>{const current=await contentState(first.page);return current.width===dragBaseline.width&&current.height===dragBaseline.height;},'Escape restores native content bounds');
 afterClick=await snapshot();assert.equal(afterClick.revision,held.revision,'Escape cannot persist the preview');
 await shell.bringToFront();const commitStart=await dividerPoint();await shell.mouse.move(commitStart.x,commitStart.y);await shell.mouse.down();
 await dualPhase(first.page,'divider commit drag axis-'+dividerAxis+' (content surface)','divider commit drag axis-'+dividerAxis+' (root renderer)',async()=>{
  await shell.mouse.move(dividerAxis==='x'?commitStart.x+direction*90:commitStart.x,dividerAxis==='y'?commitStart.y+direction*90:commitStart.y,{steps:48});
  await until(async()=>(await contentState(first.page))[dividerAxis==='x'?'width':'height']!==dragBaseline[dividerAxis==='x'?'width':'height'],'commit drag changes native surface before release');
  await shell.mouse.up();
 });
 await until(async()=>splitNode((await snapshot()).mainRoot,workspaceSplitId).ratio!==beforeRatio,'released divider ratio persists');
 report.checks.push('measured live axis-x divider gesture: pure click preserves the revision, held drag repaints native content without persisting, Escape restores, release commits the ratio');
 // Explicit native float of the live document surface.
 const before=(await call(first.page,'workspace.bootstrap')).generation,beforeWindows=await call(shell,'workspace.windows.list',{projectId:a.id}),beforeContent=beforeWindows.flatMap(w=>w.surfaces).find(s=>s.viewId===firstId);
 await context(firstId,'float');
 const detached=await scoped(s=>s.role==='detached'&&s.projectId===a.id);
 await until(async()=>(await call(first.page,'workspace.bootstrap')).windowId===detached.scope.windowId,'same live content floated');
 windows=await call(shell,'workspace.windows.list',{projectId:a.id});
 const float=windows.find(w=>w.id===detached.scope.windowId),main=windows.find(w=>w.id==='main');
 assert.notEqual(float.nativeWindowId,main.nativeWindowId);assert.equal(float.visible,true);assert.equal(float.surfaces[0].webContentsId,beforeContent.webContentsId);
 assert.equal((await call(first.page,'workspace.bootstrap')).generation,before);
 report.windows.push(...windows);report.checks.push('explicit left-list action creates visible distinct native BrowserWindow and reparents live content');
 const floatBounds=()=>detached.page.evaluate(()=>({x:screenX,y:screenY,width:outerWidth,height:outerHeight})),beforeHide=await floatBounds();
 await shell.bringToFront();
 await shell.click('[data-project-id="'+b.id+'"]');await shell.waitForFunction(id=>document.querySelector('#recent [aria-current=true]')?.dataset.projectId===id,{},b.id);
 let hidden=(await call(detached.page,'workspace.windows.list',{projectId:a.id})).find(w=>w.id===float.id);
 assert.equal(hidden.visible,false);assert.equal(hidden.projectHidden,true);assert.equal(first.page.isClosed(),false);
 await shell.click('[data-project-id="'+a.id+'"]');await shell.waitForFunction(id=>document.querySelector('#recent [aria-current=true]')?.dataset.projectId===id,{},a.id);
 const shown=(await call(detached.page,'workspace.windows.list',{projectId:a.id})).find(w=>w.id===float.id);
 assert.equal(shown.nativeWindowId,float.nativeWindowId);assert.equal(shown.visible,true);
 report.checks.push('project B hides A float; switching back restores same native window and content');
 report.geometry={beforeHide,afterRestore:await floatBounds()};
 assert.equal(report.geometry.afterRestore.width,beforeHide.width);assert.equal(report.geometry.afterRestore.height,beforeHide.height);
 assert.equal(await first.page.evaluate(()=>document.hasFocus()),false,'restoring project floats must not steal focus from the project switch');
 await call(detached.page,'session.requestClose');await until(async()=>detached.page.isClosed(),'explicit float close');
 await shell.click('[data-project-id="'+b.id+'"]');await shell.waitForFunction(id=>document.querySelector('#recent [aria-current=true]')?.dataset.projectId===id,{},b.id);
 await shell.click('[data-project-id="'+a.id+'"]');await shell.waitForFunction(id=>document.querySelector('#recent [aria-current=true]')?.dataset.projectId===id,{},a.id);
 assert.equal((await call(shell,'workspace.windows.list',{projectId:a.id})).some(w=>w.id===float.id),false);assert((await snapshot()).views[firstId]);
 report.checks.push('closed float does not reappear on project return; opened record remains available');
 await context(firstId,'float');
 const again=await scoped(s=>s.role==='detached'&&s.projectId===a.id);
 await again.page.locator('.workspace-pane-header').click({button:'right'});
 await again.page.waitForSelector('#workspace-title-menu:not([hidden]) [data-command="dock"]',{visible:true});
 await again.page.click('#workspace-title-menu [data-command="dock"]');
 await until(async()=>findView(await snapshot(),firstId)?.windowId==='main','title context menu return to workspace');
 assert(layoutGroups(await snapshot()).every(p=>p.views.length<=1));
 report.checks.push('floating an opened record again and using title context menu return restores one-file workspace pane');
 if(REGULAR_RESOURCES)resourceSampler.mark('window-roundtrips');
 // Eight measured detach/dock cycles on the live a.txt document: same renderer
 // DOM, editor text and real keyboard undo/redo survive every explicit float and
 // return, with native visibility verified detached and docked.
 await shell.locator(fileRow(firstId)).click();
 first=await scoped(s=>s.role==='surface'&&s.viewId===firstId&&s.projectId===a.id);
 const docPage=first.page,docBaseline=await fs.readFile(path.join(out,a.name,'a.txt'),'utf8');
 assert.equal(await docPage.evaluate(()=>__nozeliInput.text()),docBaseline,'a.txt flush completed before detach cycles');
 await docPage.bringToFront();await docPage.evaluate(()=>{__nozeliInput.focus();__nozeliInput.insert('\nDetached-cycle marker');});
 const docEdited=docBaseline+'\nDetached-cycle marker';
 await docPage.waitForFunction(edited=>__nozeliInput.text()===edited,{},docEdited);
 await docPage.evaluate(()=>{const node=document.querySelector('#text-host .cm-editor');if(!node)throw Error('Missing editor DOM for detach/dock identity');window.__nativeDriverIdentity={document,node};});
 const sameDriver=()=>docPage.evaluate(()=>window.__nativeDriverIdentity.document===document&&window.__nativeDriverIdentity.node===document.querySelector('#text-host .cm-editor'));
 let dragCancelChecked=false;
 const cycle=async n=>{
  await shell.bringToFront();
  await shell.locator(fileRow(firstId)).click({button:'right'});
  const command='.nozeli-context-menu:not([hidden]) [data-command="float"]';
  await shell.waitForSelector(command,{visible:true});await shell.locator(command).click();
  const cycleDetached=await scoped(s=>s.role==='detached'&&s.projectId===a.id);
  await until(async()=>(await call(docPage,'workspace.bootstrap')).windowId===cycleDetached.scope.windowId,'same live surface floated');
  await until(async()=>(await call(shell,'workspace.windows.list',{projectId:a.id})).some(w=>w.id===cycleDetached.scope.windowId&&w.visible&&w.surfaces.some(s=>s.viewId===firstId)),'visible native float');
  assert.equal(await sameDriver(),true,'same live editor DOM while detached');
  assert.equal(await docPage.evaluate(()=>__nozeliInput.text()),docEdited,'editor text survives detach');
  if(!dragCancelChecked){
   dragCancelChecked=true;
   await cycleDetached.page.evaluate(()=>{window.__attachmentEvents=[];nozeli.subscribe('workspace.control',e=>{if(e.type==='drag-session'||e.type==='drag-ended')__attachmentEvents.push(e.type);});});
   const handle=await cycleDetached.page.$eval('.workspace-pane-title',node=>{const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
   await cycleDetached.page.mouse.move(handle.x,handle.y);await cycleDetached.page.mouse.down();await cycleDetached.page.mouse.move(handle.x+100,handle.y+70,{steps:8});
   await cycleDetached.page.waitForFunction(()=>__attachmentEvents.includes('drag-session'));
   await cycleDetached.page.keyboard.press('Escape');await cycleDetached.page.mouse.up();
   await cycleDetached.page.waitForFunction(()=>__attachmentEvents.includes('drag-ended'));
   assert.equal(await sameDriver(),true,'cancelled pane drag keeps the same live editor DOM');
   assert.equal(await docPage.evaluate(()=>__nozeliInput.text()),docEdited,'cancelled pane drag keeps editor text');
  }
  await docPage.bringToFront();await docPage.evaluate(()=>__nozeliInput.focus());
  await docPage.waitForFunction(()=>document.hasFocus()&&Boolean(document.activeElement?.closest('#text-host .cm-editor')));
  await docPage.keyboard.down('Control');await docPage.keyboard.press('KeyZ');await docPage.keyboard.up('Control');
  await nextFramesOn(docPage);
  await docPage.waitForFunction(base=>__nozeliInput.text()===base,{},docBaseline);
  await docPage.keyboard.down('Control');await docPage.keyboard.press('KeyY');await docPage.keyboard.up('Control');
  await docPage.waitForFunction(edited=>__nozeliInput.text()===edited,{},docEdited);
  await cycleDetached.page.locator('.workspace-pane-header').click({button:'right'});
  const dock='#workspace-title-menu:not([hidden]) [data-command="dock"]';
  await cycleDetached.page.waitForSelector(dock,{visible:true});await cycleDetached.page.click(dock);
  await until(async()=>findView(await snapshot(),firstId)?.windowId==='main','cycle dock returns to main workspace');
  await until(async()=>cycleDetached.page.isClosed(),'cycle float closes after dock');
  await until(async()=>(await call(shell,'workspace.windows.list',{projectId:a.id})).find(w=>w.id==='main')?.surfaces.some(s=>s.viewId===firstId&&s.visible===true),'docked document natively visible');
  assert.equal(await sameDriver(),true,'same live editor DOM after dock');
 };
 for(let n=1;n<=8;n++)await dualPhase(docPage,'native document detach/dock cycle (content surface)','native document detach/dock cycle (root renderer)',()=>cycle(n));
 report.checks.push('eight measured native detach/dock cycles: explicit float and title-menu return retain the same live editor DOM, editor text and real keyboard undo/redo, with native visibility verified detached and docked');
 // Unsent b.txt edit survives float, project hide/restore and dock as the same
 // live surface with a durable workspace draft (or its flushed save), never
 // submitted, with no managed history change.
 await shell.locator(fileRow(secondId)).click();
 second=await scoped(s=>s.role==='surface'&&s.viewId===secondId&&s.projectId===a.id);
 const secondPage=second.page,draft='Unsent Project A draft; never submit during layout changes';
 await secondPage.bringToFront();await secondPage.evaluate(draft=>{__nozeliInput.focus();__nozeliInput.insert('\n'+draft);},draft);
 await secondPage.waitForFunction(draft=>__nozeliInput.text().includes(draft),{},draft);
 await until(async()=>{const value=await host.readState(a.id);return (value.state?.workspace?.draft??'').includes(draft)||(await fs.readFile(path.join(out,a.name,'b.txt'),'utf8')).includes(draft);},'unsent b.txt edit durable as workspace draft or flushed save');
 await secondPage.evaluate(()=>{const node=document.querySelector('#text-host .cm-editor');if(!node)throw Error('Missing editor DOM for draft identity');window.__nativeDriverIdentity={document,node};});
 const sameDraftDriver=()=>secondPage.evaluate(()=>window.__nativeDriverIdentity.document===document&&window.__nativeDriverIdentity.node===document.querySelector('#text-host .cm-editor'));
 await context(secondId,'float');
 const draftDetached=await scoped(s=>s.role==='detached'&&s.projectId===a.id);
 await until(async()=>(await call(secondPage,'workspace.bootstrap')).windowId===draftDetached.scope.windowId,'draft surface floated as same live content');
 assert.equal(await sameDraftDriver(),true,'float keeps the same live draft editor DOM');
 const draftFloatNative=(await call(shell,'workspace.windows.list',{projectId:a.id})).find(w=>w.id===draftDetached.scope.windowId)?.nativeWindowId;
 assert.notEqual(draftFloatNative,undefined,'draft float window listed with a native window id before hide');
 const draftBounds=()=>draftDetached.page.evaluate(()=>({x:screenX,y:screenY,width:outerWidth,height:outerHeight})),draftBeforeHide=await draftBounds();
 await shell.bringToFront();
 await shell.click('[data-project-id="'+b.id+'"]');await shell.waitForFunction(id=>document.querySelector('#recent [aria-current=true]')?.dataset.projectId===id,{},b.id);
 const draftHidden=(await call(draftDetached.page,'workspace.windows.list',{projectId:a.id})).find(w=>w.id===draftDetached.scope.windowId);
 assert(draftHidden,'hidden project still lists its float record');assert.equal(draftHidden.visible,false);assert.equal(draftHidden.projectHidden,true);assert.equal(secondPage.isClosed(),false);
 await shell.click('[data-project-id="'+a.id+'"]');await shell.waitForFunction(id=>document.querySelector('#recent [aria-current=true]')?.dataset.projectId===id,{},a.id);
 const draftShown=(await call(draftDetached.page,'workspace.windows.list',{projectId:a.id})).find(w=>w.id===draftDetached.scope.windowId);
 assert(draftShown,'restored project still lists its float record');assert.equal(draftShown.nativeWindowId,draftFloatNative);assert.equal(draftShown.visible,true);
 assert.equal(await sameDraftDriver(),true,'project hide/restore keeps the same live draft editor DOM');
 assert.equal(await secondPage.evaluate(value=>__nozeliInput.text().includes(value),draft),true,'project hide/restore keeps the unsent draft text');
 const draftGeometry={beforeHide:draftBeforeHide,afterRestore:await draftBounds()};
 assert.equal(draftGeometry.afterRestore.width,draftBeforeHide.width);assert.equal(draftGeometry.afterRestore.height,draftBeforeHide.height);
 assert.equal(await secondPage.evaluate(()=>document.hasFocus()),false,'restoring the draft float must not steal focus from the project switch');
 const beforeDockLayout=await snapshot();
 const mainSize=await shell.evaluate(()=>({width:innerWidth,height:innerHeight}));
 await call(shell,'session.resize',{width:500,height:800});await shell.waitForFunction(()=>innerWidth===500&&innerHeight===800);
 assert.equal(await sameDraftDriver(),true,'narrow resize keeps the same live draft editor DOM');
 assert.equal(await secondPage.evaluate(value=>__nozeliInput.text().includes(value),draft),true,'narrow resize keeps the unsent draft text');
 await draftDetached.page.locator('.workspace-pane-header').click({button:'right'});
 await draftDetached.page.waitForSelector('#workspace-title-menu:not([hidden]) [data-command="dock"]',{visible:true});
 await draftDetached.page.click('#workspace-title-menu [data-command="dock"]');
 await until(async()=>findView(await snapshot(),secondId)?.windowId==='main','draft context menu return');
 await nativeVisible(secondId);
 await until(async()=>draftDetached.page.isClosed(),'draft float closes after dock');
 const rootSize=await shell.evaluate(()=>({width:innerWidth,height:innerHeight}));
 const staleDock=await call(shell,'workspace.bounds',{projectId:a.id,windowId:'main',viewport:rootSize,layoutRevision:beforeDockLayout.revision,groups:[],overlay:false,overlayRects:[]});
 assert.equal(staleDock.stale,true);
 await secondPage.screenshot({path:path.join(out,'docked-draft-visible.png')});
 assert.equal(await shell.$eval('.workspace-pane.is-focused [data-view-id]',n=>n.dataset.viewId),secondId,'docking focuses the moved document in narrow mode');
 await call(shell,'session.resize',mainSize);await shell.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height,{},mainSize);
 assert.equal(await sameDraftDriver(),true,'restore keeps the same live draft editor DOM');
 assert.equal(await secondPage.evaluate(value=>__nozeliInput.text().includes(value),draft),true,'restore keeps the unsent draft text');
 await until(async()=>{const value=await host.readState(a.id);return (value.state?.workspace?.draft??'').includes(draft)||(await fs.readFile(path.join(out,a.name,'b.txt'),'utf8')).includes(draft);},'unsent draft remains durable after dock and restore');
 report.checks.push('document draft floats and returns as the same live editor; project hide/restore and narrow dock keep its unsent durable draft without submission');
 if(REGULAR_RESOURCES){
  await shell.bringToFront();await regularIdle('idle-after-full-use',45);
  resourceSampler.mark('close-inactive-content');
  const current=await snapshot();
  for(const view of Object.values(current.views)){if(view.id===secondId)continue;const selector='#workspace-open-editors [data-editor-close="'+view.id+'"]';if(await shell.$(selector)){await shell.locator(selector).click();await until(async()=>!(await snapshot()).views[view.id],'temporary content closed');}}
  await nativeVisible(secondId);
  await regularIdle('idle-single-document',30);
  report.regularResources=await resourceSampler.stop();resourceSampler=null;
 }
 assert.deepEqual(await business(),beforeBusiness);
 await noConversationSurfaces();
 assert.equal((await call(shell,'config.status',{})).initialized,false,'still uninitialized; nothing dispatched');
 report.checks.push('pane switching, split, divider gestures, floating and project hide/restore do not replay accepted work, duplicate receipts or dispatch anything');
 await context(REGULAR_RESOURCES?secondId:firstId,'float');await scoped(s=>s.role==='detached'&&s.projectId===a.id);
 await shell.click('[data-project-id="'+b.id+'"]');await shell.waitForFunction(id=>document.querySelector('#recent [aria-current=true]')?.dataset.projectId===id,{},b.id);
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 await call(shell,'session.requestClose');
 await until(async()=>child.exitCode!==null||await shell.$eval('#quit-choice',n=>n.open).catch(()=>false),'clean exit or native process shutdown confirmation');
 if(child.exitCode===null)await shell.click('#quit-cancel');
 assert.deepEqual(await Promise.race([exited,pause(15000).then(()=>null)]),{code:0,signal:null});
 report.checks.push('closing the last visible project window, with explicit native shutdown confirmation when required, flushes hidden project floats and exits cleanly');
 report.responsiveness={note:'frames/input-to-next-frame are bounded renderer observations per surface; Node elapsedMs includes CDP and wait overhead and is not paint latency; full both-axis divider coverage with minimum bounds is measured in desktop-native-project.test.mjs',root:summarizeResponsiveness(rootRecords),content:summarizeResponsiveness(contentRecords)};
 assert.deepEqual(report.errors,[]);report.ok=true;console.log(JSON.stringify({out,ok:report.ok,checks:report.checks,responsiveness:report.responsiveness,errors:report.errors},null,2));
}catch(error){
 report.failure=error.stack;report.log=log;console.error(out,log,error);
 await Promise.race([shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{}),pause(2000)]);throw error;
}finally{
 if(resourceSampler){report.regularResources=await resourceSampler.stop().catch(error=>({error:error.message}));resourceSampler=null;}
 report.processMemory=summarizeProcessMemory(await memorySampler.stop().catch(error=>({supported:false,error:error.message})));
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 await fs.writeFile(path.join(out,'main.log'),log);
 await browser?.disconnect();
 if(child&&child.exitCode===null&&child.signalCode===null){const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await pause(1000);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await stopped;}
}
