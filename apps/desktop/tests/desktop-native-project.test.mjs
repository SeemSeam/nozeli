// Isolated-copy real-source journey. The actual repository is never registered as a
// project, so no .nozeli/Git metadata can be created inside it: the four real public
// source/README files are copied byte for byte into an isolated project that also
// carries a deterministic synthetic navigation tree (2500 small synthetic files,
// labeled synthetic — not a real full-repo benchmark). Real Electron, real
// storage-v2 profile beneath an explicit isolated .Nozeli root, explicit project
// choice, no provider/model/session setup. Responsiveness numbers come from the
// shared bounded probe: per-surface renderer frame and trusted-input observations;
// Node elapsed times include CDP/wait overhead and are not paint latency. The
// injected requestAnimationFrame pause below is a functional regression check and
// runs outside every measured phase, so smoothness metrics stay natural.
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
import {layoutGroups,findView} from '../src/domain/workspace-layout.mjs';
import {measureResponsiveness,summarizeResponsiveness,observeProcessMemory} from './responsiveness-metrics.fixture.mjs';

const root=path.resolve(import.meta.dirname,'..'),sourceRepo=path.resolve(root,'../..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-isolated-project-'));
const configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop');
const files=['README.md','apps/desktop/README.md','apps/desktop/src/renderer/workspace-groups.mjs','apps/desktop/src/main/workspace-native.mjs'];
const project=path.join(out,'project');
for(const rel of files){await fs.mkdir(path.dirname(path.join(project,rel)),{recursive:true});await fs.copyFile(path.join(sourceRepo,rel),path.join(project,rel));}
const SYNTHETIC_FILES=2500,SYNTHETIC_ROOT='synthetic-navigation-tree';
const syntheticRel=index=>`${SYNTHETIC_ROOT}/branch-${String(index%25).padStart(2,'0')}/nested-${String(index%125).padStart(3,'0')}/synthetic-note-${String(index).padStart(4,'0')}.txt`;
for(let i=0;i<SYNTHETIC_FILES;i++){const dir=path.join(project,syntheticRel(i));await fs.mkdir(path.dirname(dir),{recursive:true});await fs.writeFile(dir,`Synthetic navigation sample ${i} of ${SYNTHETIC_FILES}.\nDeterministic fixture content for navigation stress; not a real repository file.\n`);}
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const originalDigests=await Promise.all(files.map(rel=>hash(path.join(sourceRepo,rel))));
const copyDigests=await Promise.all(files.map(rel=>hash(path.join(project,rel))));
assert.deepEqual(copyDigests,originalDigests,'isolated project preserves the four real public files byte for byte');
const repoMetadata=async()=>(await fs.readdir(sourceRepo)).filter(name=>name.startsWith('.nozeli'));
const repoMetadataBefore=await repoMetadata();
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id;

const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
let browser,shell,log='',child;const pause=ms=>new Promise(r=>setTimeout(r,ms));
let memorySampler={stop:async()=>({supported:false,samples:[],boundary:'sampler not started'})};
const report={out,project,checks:[],errors:[],dividers:[],surfaceEvidence:[],responsivenessRecords:{root:[],content:[]},scope:'isolated byte-identical copy of four real public source/README files plus a labeled deterministic synthetic navigation tree; the real repository is never registered and stays untouched; measured observations without benchmark thresholds or comparison claims',syntheticTree:{files:SYNTHETIC_FILES,root:SYNTHETIC_ROOT,label:'deterministic synthetic navigation stress tree; not a real full-repo benchmark'}};
const rootRecords=report.responsivenessRecords.root,contentRecords=report.responsivenessRecords.content;
const phase=async(surface,page,label,action)=>{const records=surface==='root'?rootRecords:contentRecords,before=records.length;await measureResponsiveness(page,label,action,records);if(records.length>before)records.at(-1).surface=surface;};
const dualPhase=async(contentPage,contentLabel,rootLabel,action)=>{await phase('content',contentPage,contentLabel,()=>phase('root',shell,rootLabel,action));};
const invoke=async(p,op,payload={})=>{const r=await p.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);assert(r.ok,JSON.stringify(r));return r.value;};
const layout=async()=>(await invoke(shell,'workspace.snapshot',{projectId})).layout;
async function until(fn,label){const end=Date.now()+45000;do{const v=await fn();if(v)return v;if(child?.exitCode!=null)throw Error(log);await pause(30);}while(Date.now()<end);throw Error('Timeout: '+label);}
async function scoped(test){return until(async()=>{for(const p of await browser.pages()){if(!p.url().startsWith('http://127.0.0.1:'))continue;const s=await p.evaluate(async()=>{const r=await nozeli.invoke('workspace.bootstrap',{});return r.value;}).catch(()=>null);if(s&&test(s)&&await p.evaluate(()=>window.__nozeliReady===true))return {page:p,scope:s};}return null;},'ready registered scope');}
const measure=(name,action)=>phase('root',shell,name,action);
const editor=id=>'#workspace-open-editors [data-editor-view="'+id+'"]';
const pane=id=>'[data-workspace-content][data-view-id="'+id+'"]';
async function context(id,command){await shell.locator(editor(id)).click({button:'right'});const item='.nozeli-context-menu:not([hidden]) [data-command="'+command+'"]';await shell.waitForSelector(item,{visible:true});await shell.locator(item).click();}
const nativeVisible=async viewId=>until(async()=>(await invoke(shell,'workspace.windows.list',{projectId})).flatMap(w=>w.surfaces).some(s=>s.viewId===viewId&&s.visible===true),'native visibility '+viewId);
const noConversationSurfaces=async()=>{const windows=await invoke(shell,'workspace.windows.list',{projectId});assert(windows.flatMap(w=>w.surfaces).every(s=>s.kind!=='conversation'),'no conversation surface without explicit provider setup');};
const nextFrames=()=>shell.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const nextFramesOn=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
// Keep the full sampler stop result, but summarize only finite live sum-RSS
// samples: post-exit {exited:true} records carry no sumRssKiB, so counting them
// could make process shutdown look like memory recovery. Sum RSS double-counts
// shared pages; this is a trend, never a leak verdict.
const summarizeProcessMemory=stopResult=>{
 const live=(stopResult?.samples??[]).filter(sample=>Number.isFinite(sample.sumRssKiB)).map(sample=>sample.sumRssKiB);
 return {...stopResult,liveSummaries:{samples:live.length,firstSumRssKiB:live[0]??null,maxSumRssKiB:live.length?Math.max(...live):null,lastSumRssKiB:live.at(-1)??null,note:'finite live sum-RSS samples only; post-exit exited records excluded; shared pages double-counted; process-tree trend, no leak verdict'}};
};
try{
 child=spawn(process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(root,'src/main/main.cjs')]),'--ozone-platform=wayland'],{cwd:root,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:profile,NOZELI_CONFIG_ROOT:configRoot,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_HIDDEN:'0'},stdio:['ignore','pipe','pipe']});
 for(const s of [child.stdout,child.stderr])s.on('data',c=>log+=c);
 memorySampler=observeProcessMemory(child.pid);
 await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'debug');
 shell=(await scoped(s=>s.role==='shell')).page;shell.on('pageerror',e=>report.errors.push(e.message));
 await shell.waitForFunction(()=>__nozeliReady);
 if(await shell.$('#configuration-setup[open]')){await shell.click('#configuration-cancel');await shell.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
 const configuration=await invoke(shell,'config.status',{});
 assert.equal(configuration.initialized,false,'independent configuration stays uninitialized; no provider, model or session exists');
 await shell.waitForSelector('[data-project-id="'+projectId+'"]',{visible:true});await shell.click('[data-project-id="'+projectId+'"]');
 await until(async()=>(await invoke(shell,'workspace.bootstrap')).projectId===projectId,'explicit project binding');
 assert.equal((await invoke(shell,'managed.status',{projectId})).ready,false,'no managed conversation owner without explicit provider setup');
 await shell.waitForSelector('#file-tree button[data-path="README.md"]');
 await shell.waitForFunction(id=>window.__workspaceGroups?.snapshot()?.projectId===id,{},projectId);
 await shell.evaluate(()=>{window.__treeRebuilds=0;new MutationObserver(list=>{window.__treeRebuilds+=list.filter(e=>e.target.classList?.contains('workspace-tree')).length;}).observe(document.querySelector('.workspace-tree'),{childList:true});});
 const opened=[];
 for(const rel of files){
  await shell.locator('#file-filter').fill(rel);
  await measure('open '+rel,async()=>{await shell.locator('#quick-open-results [data-open-target="current"][data-path="'+rel+'"]').click();const v=await scoped(s=>s.role==='surface'&&s.relPath===rel);opened.push({relPath:rel,viewId:v.scope.viewId,synthetic:false});});
 }
 report.checks.push('four real public source/README files opened read-only from the isolated byte-identical copy');
 // Deterministic synthetic navigation stress (labeled): quick-open over 2500 small
 // synthetic files, then open one synthetic document for the detach/dock cycles.
 const syntheticPath=syntheticRel(7);
 await measure('open '+syntheticPath+' (synthetic)',async()=>{
  await shell.locator('#file-filter').fill('synthetic-note-0007');
  await shell.waitForFunction(()=>document.querySelector('#quick-open-results [data-open-target]')!==null);
  await shell.locator('#quick-open-results [data-open-target="current"][data-path="'+syntheticPath+'"]').click();
  const v=await scoped(s=>s.role==='surface'&&s.relPath===syntheticPath);opened.push({relPath:syntheticPath,viewId:v.scope.viewId,synthetic:true});
 });
 await phase('root',shell,'synthetic tree navigation filter (root renderer)',async()=>{
  for(const probe of ['synthetic-note-1249','synthetic-note-2499','synthetic-note-1000']){
   const searchInput=await shell.$eval('#quick-open',dialog=>dialog.open)?'#quick-open-input':'#file-filter';
   await shell.locator(searchInput).fill(probe);
   await shell.waitForFunction(value=>[...document.querySelectorAll('#quick-open-results [data-open-target="current"]')].some(button=>button.dataset.path?.includes(value)),{},probe);
  }
  await shell.keyboard.press('Escape');
 });
 report.checks.push('quick-open navigation stays responsive across the labeled 2500-file synthetic stress tree');
 const source=opened[2],other=opened[3];let state=await layout();const initialGroups=layoutGroups(state).length;
 await measure('split-open x',async()=>{await context(source.viewId,'split-x');await until(async()=>layoutGroups(await layout()).length===initialGroups+1,'split-x');});
 await measure('split-open y',async()=>{await context(other.viewId,'split-y');await until(async()=>layoutGroups(await layout()).length===initialGroups+2,'split-y');});
 state=await layout();assert(layoutGroups(state).every(g=>g.views.length<=1),'single-content panes');
 for(const original of [source,other]){const presented=Object.values(state.views).find(v=>v.sourceViewId===original.viewId)??state.views[original.viewId];assert(findView(state,presented.id),'split-open presents the inactive resource itself or an active resource reading mirror');await scoped(s=>s.role==='surface'&&s.viewId===presented.id);await shell.waitForSelector(pane(presented.id),{visible:true});}
 report.checks.push('right-click opened-list split commands create ready real single-content panes');
 // Measure mixed working-set switches, classifying actual renderer residency before activation.
 for(let i=0;i<32;i++){
  const target=opened[i%opened.length];
  const prior=(await invoke(shell,'workspace.windows.list',{projectId})).flatMap(window=>window.surfaces).find(surface=>surface.viewId===target.viewId);
  const residency=prior?'resident':'recreated';
  await phase('root',shell,residency+' workspace switch (root renderer)',async()=>{
   await shell.locator(editor(target.viewId)).click();
   const active=await scoped(s=>s.role==='surface'&&s.viewId===target.viewId);
   await shell.waitForSelector(pane(target.viewId),{visible:true});
   await nativeVisible(target.viewId);
   await active.page.waitForFunction(()=>window.__nozeliReady===true);
  });
  const active=await scoped(s=>s.role==='surface'&&s.viewId===target.viewId);
  await phase('content',active.page,residency+' workspace switch (content surface settle)',async()=>{await nextFramesOn(active.page);});
  const presented=(await invoke(shell,'workspace.windows.list',{projectId})).flatMap(window=>window.surfaces).find(surface=>surface.viewId===target.viewId);
  if(prior)assert.equal(presented.webContentsId,prior.webContentsId,'a resident activation reuses its live renderer');
  (report.switchResidency??=[]).push({iteration:i,viewId:target.viewId,residency,webContentsId:presented.webContentsId});
  if(i%8===0){const text=await active.page.evaluate(()=>__nozeliInput.text());assert(text.length>0,'warm switch leaves populated content on '+target.relPath);}
 }
 report.checks.push('32 working-set switches measured with resident versus recreated renderer classification and native visibility verified per switch');
 await shell.locator(editor(source.viewId)).click();const sourceSurface=await scoped(s=>s.role==='surface'&&s.viewId===source.viewId);state=await layout();const groups=layoutGroups(state),sourcePane=findView(state,source.viewId).group,destination=groups.find(g=>g.id!==sourcePane.id&&g.activeViewId);assert(destination,'another occupied pane exists');
 await sourceSurface.page.bringToFront();await sourceSurface.page.evaluate(()=>__nozeliInput.focus());
 await measure('Ctrl+number from content surface',async()=>{await sourceSurface.page.keyboard.down('Control');await sourceSurface.page.keyboard.press('Digit'+(groups.findIndex(g=>g.id===destination.id)+1));await sourceSurface.page.keyboard.up('Control');await shell.waitForFunction(id=>document.querySelector('[data-workspace-group="'+id+'"]')?.classList.contains('is-focused'),{},destination.id);});
 const focused=await scoped(s=>s.role==='surface'&&s.viewId===destination.activeViewId);
 await focused.page.waitForFunction(()=>document.hasFocus());
 report.keyboardTarget=await focused.page.evaluate(()=>({hasFocus:document.hasFocus(),activeTag:document.activeElement?.tagName,activeClass:document.activeElement?.className}));
 report.checks.push('Ctrl+number routes real content-surface keyboard focus to another occupied single-content pane');
 await shell.bringToFront();await invoke(shell,'session.resize',{width:1440,height:1000});await shell.waitForFunction(()=>innerWidth===1440&&innerHeight===1000);
 const splitNode=(node,id)=>!node?null:node.id===id?node:splitNode(node.first,id)??splitNode(node.second,id);
 const splitIds=node=>node?.kind==='split'?[node.id,...splitIds(node.first),...splitIds(node.second)]:[];
 const occupied=node=>node?.kind==='group'?(node.activeViewId?[node]:[]):node?[...occupied(node.first),...occupied(node.second)]:[];
 const domRatio=id=>shell.$eval('[data-split-id="'+id+'"]',e=>Number(e.style.getPropertyValue('--ratio')));
 const contentState=page=>page.evaluate(()=>({owner:window.__workspaceScope.viewId,text:window.__nozeliInput.text(),width:innerWidth,height:innerHeight}));
 const settledContent=(page,viewId)=>until(async()=>{const rect=await shell.$eval(pane(viewId),el=>{const r=el.getBoundingClientRect();return {width:r.width,height:r.height};}),content=await contentState(page);return rect.width>0&&rect.height>0&&Math.abs(content.width-rect.width)<=2&&Math.abs(content.height-rect.height)<=2?content:false;},'native surface matches its visible pane bounds');
 report.dividers=[];state=await layout();const axes=new Set();
 await shell.evaluate(()=>{window.__resizeTrace=[];for(const name of ['pointerdown','pointerup','pointercancel','lostpointercapture','blur'])window.addEventListener(name,e=>__resizeTrace.push({name,at:performance.now(),target:e.target?.className,buttons:e.buttons}),true);});
 for(const splitId of splitIds(state.mainRoot)){
  const beforeLayout=await layout(),node=splitNode(beforeLayout.mainRoot,splitId),axis=node.axis,dimension=axis==='x'?'width':'height';axes.add(axis);
  const candidates=occupied(node).filter(g=>beforeLayout.views[g.activeViewId]?.kind==='document');
  const owner=candidates.find(g=>beforeLayout.views[g.activeViewId].relPath?.endsWith('.mjs')&&!beforeLayout.views[g.activeViewId].sourceViewId)??candidates.find(g=>beforeLayout.views[g.activeViewId].relPath?.endsWith('.mjs'))??candidates[0];assert(owner,'split has an occupied document surface');
  const surface=await scoped(s=>s.role==='surface'&&s.viewId===owner.activeViewId);await shell.waitForSelector(pane(owner.activeViewId),{visible:true});
  const baseline=await settledContent(surface.page,owner.activeViewId);assert.equal(baseline.owner,owner.activeViewId);assert(baseline.text.length>0,'occupied surface exposes actual editor text');
  const divider=await shell.waitForSelector('[data-split-id="'+splitId+'"]>.workspace-divider',{visible:true});
  const point=async()=>{const b=await divider.boundingBox();assert(b,'divider has real bounds');return {x:b.x+b.width/2,y:b.y+b.height/2};};
  await shell.bringToFront();const clickAt=await point();await shell.mouse.click(clickAt.x,clickAt.y);await nextFrames();
  const afterClick=await layout();assert.equal(afterClick.revision,beforeLayout.revision,'pure divider click cannot commit a layout revision');assert.equal(splitNode(afterClick.mainRoot,splitId).ratio,node.ratio);assert.equal(await domRatio(splitId),node.ratio);
  assert.deepEqual(afterClick.views[owner.activeViewId],beforeLayout.views[owner.activeViewId],'click retains the content owner record');assert.equal(findView(afterClick,owner.activeViewId).group.id,owner.id);
  assert.deepEqual(await contentState(surface.page),baseline,'click retains the same live content owner, text and viewport');
  await shell.mouse.click(clickAt.x,clickAt.y,{button:'right'});await nextFrames();assert.equal((await layout()).revision,afterClick.revision);assert.deepEqual(await contentState(surface.page),baseline,'divider right click keeps actual content size and text');
  // Functional regression check only: the title menu must work while the root
  // renderer's animation frames are deliberately paused. This injected pause is
  // outside every measured phase and is excluded from smoothness metrics.
  const title='[data-workspace-group="'+owner.id+'"] .workspace-pane-title';
  const titlePoint=await shell.$eval(title,n=>{const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
  await shell.evaluate(()=>{window.__savedRAF=requestAnimationFrame;window.requestAnimationFrame=()=>0;});
  await shell.mouse.click(titlePoint.x,titlePoint.y,{button:'right'});await until(async()=>shell.$eval('#workspace-title-menu',n=>!n.hidden),'menu visible without root animation frame');
  await shell.keyboard.press('Escape');await until(async()=>shell.$eval('#workspace-title-menu',n=>n.hidden),'menu closed without root animation frame');
  await shell.evaluate(()=>{window.requestAnimationFrame=window.__savedRAF;delete window.__savedRAF;});
  await until(async()=>{const windows=await invoke(shell,'workspace.windows.list',{projectId});return windows.flatMap(w=>w.surfaces).find(s=>s.viewId===owner.activeViewId)?.visible===true;},'native content visibility restored after menu dismissal without root rAF');
  assert.equal((await contentState(surface.page)).text,baseline.text,'menu dismissal restores interactive native content even when root rAF does not run');
  await surface.page.bringToFront();await surface.page.evaluate(()=>{__nozeliInput.focus();__nozeliInput.select(0,0);});await surface.page.keyboard.press('ArrowRight');
  await surface.page.waitForFunction(()=>document.hasFocus()&&__nozeliInput.selection()?.from===1&&__nozeliInput.selection()?.to===1);
  assert.equal((await contentState(surface.page)).text,baseline.text,'editor responds to real navigation without editing');
  const dragBaseline=await contentState(surface.page),direction=node.ratio>=.5?-1:1;
  report.activeDivider={splitId,axis,ownerViewId:owner.activeViewId,beforeRatio:node.ratio,beforeViewport:{width:dragBaseline.width,height:dragBaseline.height}};
  await shell.bringToFront();const start=await point();await shell.mouse.move(start.x,start.y);await shell.mouse.down();const live=[];
  await dualPhase(surface.page,'divider live drag preview axis-'+axis+' (content surface)','divider live drag preview axis-'+axis+' (root renderer)',async()=>{
   for(const distance of [30,60,90]){await shell.mouse.move(start.x+(axis==='x'?direction*distance:0),start.y+(axis==='y'?direction*distance:0),{steps:16});
    const previous=live.at(-1)??dragBaseline;await until(async()=>{const value=await contentState(surface.page);if(value[dimension]===previous[dimension])return false;live.push(value);return true;},'live '+axis+' native content dimension changes while pointer is held');}
  });
  const held=await layout();assert.equal(held.revision,afterClick.revision,'drag preview does not persist before release');assert.equal(splitNode(held.mainRoot,splitId).ratio,node.ratio);
  const heldRatio=await domRatio(splitId);if(heldRatio===node.ratio)console.error('RESIZE TRACE',JSON.stringify(await shell.evaluate(()=>({events:__resizeTrace,ratio:[...document.querySelectorAll('[data-split-id]')].map(n=>({id:n.dataset.splitId,ratio:n.style.getPropertyValue('--ratio')}))}))));
  assert.notEqual(heldRatio,node.ratio,'drag paints a live DOM ratio');
  for(const sample of live){assert.equal(sample.owner,baseline.owner);assert.equal(sample.text,baseline.text);}
  const minBounds=[];for(const edge of [0,axis==='x'?1439:999]){
   await shell.mouse.move(axis==='x'?edge:start.x,axis==='y'?edge:start.y,{steps:16});await nextFrames();
   const bounds=await shell.$eval('[data-split-id="'+splitId+'"]',el=>[...el.querySelectorAll('[data-workspace-group]')].map(group=>{const r=group.getBoundingClientRect();return {groupId:group.dataset.workspaceGroup,width:r.width,height:r.height};}));
   assert(bounds.every(box=>box[dimension]>=(axis==='x'?280:180)-1),'extreme pointer movement respects recursive pane minimum bounds');minBounds.push({edge,bounds});
  }
  await shell.keyboard.press('Escape');await shell.mouse.up();await until(async()=>await domRatio(splitId)===node.ratio,'Escape restores DOM ratio');
  await until(async()=>{const current=await contentState(surface.page);return current.width===dragBaseline.width&&current.height===dragBaseline.height;},'Escape restores native content bounds');await nextFrames();
  const cancelled=await layout();assert.equal(cancelled.revision,afterClick.revision,'Escape cannot persist the preview');assert.equal(splitNode(cancelled.mainRoot,splitId).ratio,node.ratio);assert.deepEqual(cancelled.mainRoot,afterClick.mainRoot);
  await shell.bringToFront();const commitStart=await point();await shell.mouse.move(commitStart.x,commitStart.y);await shell.mouse.down();
  await dualPhase(surface.page,'divider commit drag axis-'+axis+' (content surface)','divider commit drag axis-'+axis+' (root renderer)',async()=>{
   await shell.mouse.move(commitStart.x+(axis==='x'?direction*90:0),commitStart.y+(axis==='y'?direction*90:0),{steps:48});
   await until(async()=>(await contentState(surface.page))[dimension]!==dragBaseline[dimension],'second drag changes native surface before commit');await shell.mouse.up();
  });
  await until(async()=>splitNode((await layout()).mainRoot,splitId).ratio!==node.ratio,'released divider ratio persists');const committed=await layout();assert(committed.revision>cancelled.revision);assert.equal(await domRatio(splitId),splitNode(committed.mainRoot,splitId).ratio);
  report.dividers.push({splitId,axis,viewId:owner.activeViewId,clickRevision:afterClick.revision,cancelledRevision:cancelled.revision,beforeRatio:node.ratio,afterRatio:splitNode(committed.mainRoot,splitId).ratio,beforeViewport:{width:dragBaseline.width,height:dragBaseline.height},heldViewports:live.map(({width,height})=>({width,height})),minBounds});
 }
 assert(axes.has('x')&&axes.has('y'),'both left/right and top/bottom splits exercised');report.checks.push('both divider axes: pure click preserves revision, ratio, owner and text; real editor arrow navigation still works','both divider axes: live drag gestures measured on root and content renderers with three native surface dimension changes before release; Escape restores DOM/native bounds without persistence; release commits ratio','both axes: extreme pointer positions preserve recursive pane minimum bounds');
 let preNarrow=await layout(),emptyGroup=layoutGroups(preNarrow).find(g=>!g.activeViewId);
 if(!emptyGroup){await invoke(shell,'workspace.command',{projectId,expectedRevision:preNarrow.revision,requestKey:crypto.randomUUID(),command:{type:'split',groupId:layoutGroups(preNarrow).find(g=>g.activeViewId).id,axis:'y'}});preNarrow=await layout();emptyGroup=layoutGroups(preNarrow).find(g=>!g.activeViewId);}
 assert(emptyGroup,'narrow regression begins with an actual empty group');
 await shell.locator('[data-workspace-group="'+emptyGroup.id+'"] .workspace-pane-title').click();await shell.waitForFunction(id=>document.querySelector('[data-workspace-group="'+id+'"]')?.classList.contains('is-focused'),{},emptyGroup.id);await nextFrames();
 const wideLayout=await layout(),wideViewport=await shell.evaluate(()=>({width:innerWidth,height:innerHeight}));
 const visibleOwners=layoutGroups(wideLayout).filter(g=>g.activeViewId).map(g=>({groupId:g.id,viewId:g.activeViewId}));const wideSurfaces=[];
 for(const owner of visibleOwners){const surface=await scoped(s=>s.role==='surface'&&s.viewId===owner.viewId);wideSurfaces.push({...owner,page:surface.page,before:await settledContent(surface.page,owner.viewId)});}
 await invoke(shell,'session.resize',{width:480,height:600});await shell.waitForFunction(()=>innerWidth===480&&innerHeight===600&&document.querySelector('#workspace-groups').classList.contains('workspace-narrow'));await nextFrames();
 assert.deepEqual(await layout(),wideLayout,'narrowing cannot rewrite the persisted layout');
 const narrowOwner=await until(async()=>{const shown=await shell.$$eval('[data-workspace-content][data-view-id]',els=>els.filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}).map(el=>({groupId:el.dataset.workspaceContent,viewId:el.dataset.viewId})));return shown.find(owner=>visibleOwners.some(before=>before.viewId===owner.viewId));},'empty focused group yields to an occupied group in narrow mode');
 const narrowSurface=wideSurfaces.find(surface=>surface.viewId===narrowOwner.viewId),narrowContent=await settledContent(narrowSurface.page,narrowOwner.viewId);
 assert.equal(narrowContent.owner,narrowSurface.before.owner);assert.equal(narrowContent.text,narrowSurface.before.text);assert(narrowContent.text.length>0,'narrow mode displays real occupied content rather than blank shell');
 report.narrow={initialEmptyGroupId:emptyGroup.id,visibleGroupId:narrowOwner.groupId,viewId:narrowOwner.viewId,textLength:narrowContent.text.length};
 await invoke(shell,'session.resize',wideViewport);await shell.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height&&!document.querySelector('#workspace-groups').classList.contains('workspace-narrow'),{},wideViewport);
 for(const surface of wideSurfaces){await shell.waitForSelector(pane(surface.viewId),{visible:true});await until(async()=>{const current=await contentState(surface.page);return current.width===surface.before.width&&current.height===surface.before.height;},'restored occupied surface bounds');assert.deepEqual(await contentState(surface.page),surface.before,'narrow/restore retains live owner, text and viewport');}
 assert.deepEqual(await layout(),wideLayout);
 report.checks.push('focused empty group falls back to a populated native surface when narrowed; restore preserves full layout tree and every occupied surface owner, text and bounds');
 // Actual native document detach/dock, eight measured cycles, on the labeled
 // synthetic document: same live editor DOM, text, and real keyboard undo/redo
 // survive every explicit float and return; native visibility is verified per phase.
 const doc=opened.find(entry=>entry.synthetic);assert(doc,'synthetic detach/dock document is open');
 const docBaseline=await fs.readFile(path.join(project,doc.relPath),'utf8');
 await shell.locator(editor(doc.viewId)).click();const docSurface=await scoped(s=>s.role==='surface'&&s.viewId===doc.viewId);
 await docSurface.page.bringToFront();await docSurface.page.evaluate(()=>{__nozeliInput.focus();__nozeliInput.insert('\nDetached-cycle marker');});
 const docEdited=docBaseline+'\nDetached-cycle marker';
 await docSurface.page.waitForFunction(edited=>__nozeliInput.text()===edited,{},docEdited);
 await docSurface.page.evaluate(()=>{const node=document.querySelector('#text-host .cm-editor');if(!node)throw Error('Missing editor DOM for detach/dock identity');window.__nativeDriverIdentity={document,node};});
 const sameDriver=()=>docSurface.page.evaluate(()=>window.__nativeDriverIdentity.document===document&&window.__nativeDriverIdentity.node===document.querySelector('#text-host .cm-editor'));
 let dragCancelChecked=false;
 const cycle=async n=>{
  await shell.bringToFront();
  await shell.locator(editor(doc.viewId)).click({button:'right'});
  const command='.nozeli-context-menu:not([hidden]) [data-command="float"]';
  await shell.waitForSelector(command,{visible:true});await shell.locator(command).click();
  const detached=await scoped(s=>s.role==='detached'&&s.projectId===projectId);
  await until(async()=>(await invoke(docSurface.page,'workspace.bootstrap')).windowId===detached.scope.windowId,'same live surface floated');
  await until(async()=>(await invoke(shell,'workspace.windows.list',{projectId})).some(w=>w.id===detached.scope.windowId&&w.visible&&w.surfaces.some(s=>s.viewId===doc.viewId)),'visible native float');
  assert.equal(await sameDriver(),true,'same live editor DOM while detached');
  assert.equal(await docSurface.page.evaluate(()=>__nozeliInput.text()),docEdited,'editor text survives detach');
  if(!dragCancelChecked){
   dragCancelChecked=true;
   await detached.page.evaluate(()=>{window.__attachmentEvents=[];nozeli.subscribe('workspace.control',e=>{if(e.type==='drag-session'||e.type==='drag-ended')__attachmentEvents.push(e.type);});});
   const handle=await detached.page.$eval('.workspace-pane-title',node=>{const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
   await detached.page.mouse.move(handle.x,handle.y);await detached.page.mouse.down();await detached.page.mouse.move(handle.x+100,handle.y+70,{steps:8});
   await detached.page.waitForFunction(()=>__attachmentEvents.includes('drag-session'));
   await detached.page.keyboard.press('Escape');await detached.page.mouse.up();
   await detached.page.waitForFunction(()=>__attachmentEvents.includes('drag-ended'));
   assert.equal(await sameDriver(),true,'cancelled pane drag keeps the same live editor DOM');
   assert.equal(await docSurface.page.evaluate(()=>__nozeliInput.text()),docEdited,'cancelled pane drag keeps editor text');
  }
  await docSurface.page.bringToFront();await docSurface.page.evaluate(()=>__nozeliInput.focus());
  await docSurface.page.waitForFunction(()=>document.hasFocus()&&Boolean(document.activeElement?.closest('#text-host .cm-editor')));
  await docSurface.page.keyboard.down('Control');await docSurface.page.keyboard.press('KeyZ');await docSurface.page.keyboard.up('Control');
  await nextFramesOn(docSurface.page);
  await docSurface.page.waitForFunction(base=>__nozeliInput.text()===base,{},docBaseline);
  await docSurface.page.keyboard.down('Control');await docSurface.page.keyboard.press('KeyY');await docSurface.page.keyboard.up('Control');
  await docSurface.page.waitForFunction(edited=>__nozeliInput.text()===edited,{},docEdited);
  await detached.page.locator('.workspace-pane-header').click({button:'right'});
  const dock='#workspace-title-menu:not([hidden]) [data-command="dock"]';
  await detached.page.waitForSelector(dock,{visible:true});await detached.page.click(dock);
  await until(async()=>findView(await layout(),doc.viewId)?.windowId==='main','cycle dock returns to main workspace');
  await until(async()=>detached.page.isClosed(),'cycle float closes after dock');
  await until(async()=>(await invoke(shell,'workspace.windows.list',{projectId})).find(w=>w.id==='main')?.surfaces.some(s=>s.viewId===doc.viewId&&s.visible===true),'docked document natively visible');
 };
 for(let n=1;n<=8;n++)await dualPhase(docSurface.page,'native document detach/dock cycle (content surface)','native document detach/dock cycle (root renderer)',()=>cycle(n));
 report.checks.push('eight measured native detach/dock cycles: explicit float and title-menu return retain the same live editor DOM, editor text and real keyboard undo/redo, with native visibility verified detached and docked');
 await pause(500);
 report.treeRebuilds=await shell.evaluate(()=>window.__treeRebuilds);
 report.surfaceEvidence=[];
 for(const entry of opened){
  await shell.locator(editor(entry.viewId)).click();const active=await scoped(s=>s.role==='surface'&&s.viewId===entry.viewId);
  await shell.waitForSelector(pane(entry.viewId),{visible:true});
  const evidence=await contentState(active.page);assert.equal(evidence.owner,entry.viewId);assert(evidence.text.length>0,'screenshot evidence is a populated content surface, not blank shell chrome');
  const screenshot=(entry.synthetic?'synthetic_':'')+entry.relPath.replaceAll('/','_')+'.png';
  await active.page.screenshot({path:path.join(out,screenshot)});
  report.surfaceEvidence.push({viewId:entry.viewId,relPath:entry.relPath,synthetic:entry.synthetic,screenshot,textLength:evidence.text.length,width:evidence.width,height:evidence.height});
 }
 await noConversationSurfaces();
 assert.deepEqual(await Promise.all(files.map(rel=>hash(path.join(sourceRepo,rel)))),originalDigests,'real repository source files unchanged');
 assert.deepEqual(await Promise.all(files.map(rel=>hash(path.join(project,rel)))),copyDigests,'isolated copies of the real files unchanged; only the labeled synthetic file was edited');
 assert.deepEqual(await repoMetadata(),repoMetadataBefore,'no .nozeli metadata appeared in the real repository');
 report.checks.push('all exercised real source file digests unchanged in the repository and in the isolated copies; no project metadata written to the real repository');
 report.responsiveness={note:'frames/input-to-next-frame are bounded renderer observations per surface; Node elapsedMs includes CDP and wait overhead and is not paint latency; the injected requestAnimationFrame pause regression check ran outside every measured phase and is excluded from these smoothness metrics',root:summarizeResponsiveness(rootRecords),content:summarizeResponsiveness(contentRecords)};
 assert.deepEqual(report.errors,[]);
 report.ok=true;console.log(JSON.stringify({out,ok:report.ok,checks:report.checks,responsiveness:report.responsiveness,errors:report.errors},null,2));
}catch(error){
 report.failure=error.stack;
 report.resizeFailure=await shell?.evaluate(()=>({events:window.__resizeTrace,viewport:{width:innerWidth,height:innerHeight},dividers:[...document.querySelectorAll('[data-split-id]')].map(node=>({id:node.dataset.splitId,ratio:node.style.getPropertyValue('--ratio'),bounds:node.getBoundingClientRect().toJSON()})),pointerCapture:[...document.querySelectorAll('.workspace-divider')].map(node=>({id:node.parentElement.dataset.splitId,captured:node.hasPointerCapture(1)}))})).catch(()=>null);
 if(browser)await shell?.mouse.up().catch(()=>{});
 report.surfaces=await Promise.all((browser?await browser.pages():[]).filter(p=>p.url().startsWith('http://127.0.0.1:')).map(async p=>({state:await p.evaluate(()=>({ready:window.__nozeliReady,scope:window.__workspaceScope,lastOpen:window.__lastOpen,error:document.querySelector('#save-error')?.textContent,status:document.querySelector('#save-status')?.textContent})).catch(()=>null)})));
 await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
 console.error(out,error);throw error;
}finally{
 report.processMemory=summarizeProcessMemory(await memorySampler.stop().catch(error=>({supported:false,error:error.message})));
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 await fs.writeFile(path.join(out,'main.log'),log);
 await browser?.disconnect();
 if(child&&child.exitCode===null){child.kill('SIGTERM');await pause(1000);if(child.exitCode===null)child.kill('SIGKILL');}
}
