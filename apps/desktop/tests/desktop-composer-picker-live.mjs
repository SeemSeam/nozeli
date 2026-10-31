// Real-Electron acceptance for the composer 引用文件 picker: viewport honesty
// (取消/引用 buttons really reachable, only the list scrolls) across big
// paginated directories (>500 entries, long names, sub-directories), short
// windows, narrow panels and elevated zoom, plus the full Escape contract
// (focus inside path input / file row / footer / moved out to the composer,
// during an in-flight browse, layered under preview/settings/Zen) and the
// settings 快捷键 help text checked against real key delivery.
//
// Two launch modes (see failed-surface-exit-check.mjs / desktop-stale-remove-hold-live.mjs):
//   node tests/desktop-composer-picker-live.mjs --app-root <repo>/apps/desktop
//     Spawns the source tree's main.cjs with the dev Electron binary
//     (dist/renderer must already be built: npm run build:renderer).
//   node tests/desktop-composer-picker-live.mjs --release <releases>/<timestamp>
//     Spawns <release>/nozeli directly (installed acceptance).
//
// Isolation: everything lives under one mkdtemp root — synthetic 620+ entry
// project, sanitized HOME/XDG_*, dedicated NOZELI_CONFIG_ROOT/NOZELI_USER_DATA,
// NOZELI_TEST_INSTANCE, dedicated CDP port, loopback-only scripted model. The
// real user profile, existing caches and real credentials are never read and no
// real provider is contacted. No NODE_OPTIONS observer is injected (packaged
// builds ignore it), so full-process network isolation is not claimed.
//
// Input honesty: clicks and keys go through CDP Input (real trusted events);
// coordinates are hit-tested with elementFromPoint before every real click.
// Assertions are user-visible boundaries (rects inside the viewport, hit tests,
// scroll containers, focus targets, rendered text) — never CSS source strings.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

const require=createRequire(import.meta.url);
const arguments_=process.argv.slice(2);
const option=name=>{const index=arguments_.indexOf(name);return index>=0?arguments_[index+1]:null;};
const appRootOption=option('--app-root'),releaseOption=option('--release');
assert(appRootOption||releaseOption,'pass --app-root <apps/desktop> or --release <release-dir>');
assert(!(appRootOption&&releaseOption),'pass exactly one of --app-root / --release');
const mode=appRootOption?'source':'installed';
const appRoot=appRootOption?path.resolve(appRootOption):null;
const release=releaseOption?path.resolve(releaseOption):null;
const binary=appRoot?createRequire(path.join(appRoot,'package.json'))('electron'):path.join(release,'nozeli');
const appArguments=appRoot?[path.join(appRoot,'src/main/main.cjs')]:[];

const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-composer-picker-'+mode+'-'));
const projectRoot=path.join(out,'synthetic-project');
const externalDir=path.join(out,'外部材料目录');
const LONG_STEM='bulk-long-'+('L'.repeat(150));
const FROZEN_EXTERNAL='EXTERNAL-FROZEN-MARKER-9033';
const REPLY_MARKER='合成回复 PICKER-LIVE（脚本模型）';
const report={ok:false,kind:'composer-picker-live',mode,out,binary,appRoot,release,projectRoot,
 coverage:'Synthetic 620+ entry project + isolated HOME/XDG/config/profile; loopback scripted model over the real CLI transport; real CDP mouse/keyboard input with elementFromPoint hit tests. Packaged mode gets no NODE_OPTIONS observer and full-process isolation is not claimed. Real user profile, caches and credentials are never read.',
 checks:[],scenes:[],modelRequests:[],notCovered:['OS/native IME: the composition guard leg dispatches a DOM KeyboardEvent with isComposing/keyCode 229 — that is explicitly not OS IME qualification and not real key delivery','OS/browser zoom: the 125%/150% leg applies CSS zoom on #conversation-panel, matching the existing conversation live suite','Cmd (Meta) shortcut variants: Linux run only exercises Ctrl; the help text mentioning Cmd is neither tested nor contradicted','Real model/worker inference — the only send targets the loopback scripted model and its request is recorded'],
 sizes:{},errors:[],normalExits:[]};
console.log('EVIDENCE_ROOT='+out);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=90000){
 const deadline=Date.now()+timeout;
 do{const value=await fn();if(value)return value;await pause(100);}while(Date.now()<deadline);
 throw new Error('Timed out: '+label);
}
const freePort=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
// Loopback scripted model: one SSE answer per completion. Requests are recorded
// so the single controlled send is provable and every Esc provably sends nothing.
const server=http.createServer((req,res)=>{let body='';req.on('data',bytes=>body+=bytes);req.on('end',()=>{
 report.modelRequests.push({at:new Date().toISOString(),path:req.url,body:body.slice(0,300)});
 res.writeHead(200,{'content-type':'text/event-stream'});
 for(const [delta,finish] of [[{role:'assistant',content:REPLY_MARKER},null],[{},'stop']])
  res.write('data: '+JSON.stringify({id:'picker-live-local',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
 res.end('data: [DONE]\n\n');
});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

/* ---------- synthetic project: >500 paginated, long names, sub-dirs ---------- */
await fs.mkdir(externalDir,{recursive:true});
await fs.mkdir(projectRoot,{recursive:true});
await fs.writeFile(path.join(projectRoot,'材料-说明.md'),'# 合成大目录\n\nBULK-FROZEN-MARKER-ROOTDOC\n');
await fs.writeFile(path.join(externalDir,'外部-冻结核对.md'),FROZEN_EXTERNAL+'\n');
const writeJobs=[];
for(let index=1;index<=600;index++)writeJobs.push(fs.writeFile(path.join(projectRoot,`bulk-文件-${String(index).padStart(4,'0')}.md`),`BULK-FROZEN-MARKER-${String(index).padStart(4,'0')}\n`));
for(let index=1;index<=20;index++)writeJobs.push(fs.writeFile(path.join(projectRoot,`${LONG_STEM}-${String(index).padStart(4,'0')}.md`),`LONG-NAME-FROZEN-MARKER-${index}\n`));
for(let index=1;index<=20;index++)writeJobs.push((async()=>{const dir=path.join(projectRoot,`0目录-${String(index).padStart(2,'0')}`);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,`内部材料-${String(index).padStart(2,'0')}.md`),`INSIDE-DIR-FROZEN-MARKER-${index}\n`);})());
await Promise.all(writeJobs); // 641 top-level entries -> page size 500 paginates.

function isolatedEnvironment(port){
 const env={...process.env};
 for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
 Object.assign(env,{HOME:path.join(out,'home'),XDG_CONFIG_HOME:path.join(out,'home','.config'),XDG_DATA_HOME:path.join(out,'home','.local','share'),XDG_CACHE_HOME:path.join(out,'home','.cache'),
  NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:path.join(out,'config'),NOZELI_USER_DATA:path.join(out,'config','desktop'),
  NOZELI_TEST_PICK:projectRoot,NOZELI_SHOT_DIR:out,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
 return env;
}
let child,browser,shell,chat,log='',exitPromise;
async function launch(){
 const port=await freePort(),env=isolatedEnvironment(port);
 await fs.mkdir(env.HOME,{recursive:true,mode:0o700});
 log+='\n=== launch on CDP '+port+' ===\n';
 child=spawn(binary,[...appArguments,'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland'),'--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'],{cwd:out,env,stdio:['ignore','pipe','pipe']});
 exitPromise=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 for(const stream of[child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes;});
 browser=await until(async()=>{if(child.exitCode!==null||child.signalCode)throw Error('Electron exited during launch\n'+log);try{return await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});}catch{return false;}},'CDP endpoint');
 const observe=page=>page.on('pageerror',error=>report.errors.push(String(error.stack||error)));
 for(const page of await browser.pages())observe(page);
 browser.on('targetcreated',async target=>{const page=await target.page().catch(()=>null);if(page)observe(page);});
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__workspaceScope?.role==='shell'&&window.__nozeliReady).catch(()=>false))return page;},'shell window');
}
async function raw(page,op,payload={}){return page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});}
async function call(page,op,payload={}){const result=await raw(page,op,payload);assert(result.ok,op+': '+JSON.stringify(result.error));return result.value;}
async function scoped(kind,extra){return until(async()=>{for(const page of await browser.pages()){const scope=await page.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope&&scope.kind===kind&&(!extra||extra(scope))&&await page.evaluate(()=>window.__nozeliReady).catch(()=>false))return page;}},kind+' surface');}
async function shot(name){await chat.screenshot({path:path.join(out,name+'.png')});report.scenes.push(name+'.png');}

/* ---------- picker helpers: hit-tested real clicks only ---------- */
async function reachablePoint(page,selector){
 return page.evaluate(selector=>{const node=document.querySelector(selector);if(!node)return null;const r=node.getBoundingClientRect();if(r.width<1||r.height<1)return null;const w=r.width,h=r.height;const pts=[[w*0.15,h*0.5],[w*0.5,h*0.5],[w*0.85,h*0.5],[w*0.5,h*0.25],[w*0.5,h*0.75]];for(const[fractionX,fractionY] of pts){const x=r.left+fractionX,y=r.top+fractionY;if(x<0||y<0||x>=innerWidth||y>=innerHeight)continue;const hit=document.elementFromPoint(x,y);if(hit===node||node.contains(hit))return{x:Math.round(x),y:Math.round(y)};}return null;},selector);
}
async function realClick(page,selector,label){
 await page.waitForSelector(selector,{visible:true,timeout:15000});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const point=await reachablePoint(page,selector);
 assert(point,label+': '+selector+' must have a viewport-reachable click point');
 await page.mouse.click(point.x,point.y);
}
async function wheelToListBottom(){
 const point=await reachablePoint(chat,'.cm-picker-list');
 await chat.mouse.move(point.x,point.y);
 for(let index=0;index<90;index++){
  if(await chat.evaluate(()=>{const list=document.querySelector('.cm-picker .cm-picker-list');return list.scrollTop+list.clientHeight>=list.scrollHeight-2;}))return;
  await chat.mouse.wheel({deltaY:700});await pause(40);
 }
}
async function wheelToListTop(){
 const point=await reachablePoint(chat,'.cm-picker-list');
 await chat.mouse.move(point.x,point.y);
 for(let index=0;index<45;index++){
  if(await chat.evaluate(()=>document.querySelector('.cm-picker .cm-picker-list').scrollTop<=0))return;
  await chat.mouse.wheel({deltaY:-900});await pause(40);
 }
}
async function revealPickerRow(selector){
 const point=await reachablePoint(chat,'.cm-picker-list');
 assert(point,'the picker list must be reachable before scrolling to a file');
 await chat.mouse.move(point.x,point.y);
 for(let attempt=0;attempt<60;attempt++){
  const state=await chat.evaluate(selector=>{const row=document.querySelector(selector),list=document.querySelector('.cm-picker-list');if(!row)return null;const r=row.getBoundingClientRect(),l=list.getBoundingClientRect();return {inside:r.top>=l.top&&r.bottom<=l.bottom,delta:(r.top+r.bottom-l.top-l.bottom)/2};},selector);
  assert(state,'target file must exist in the loaded page: '+selector);
  if(state.inside)return;
  await chat.mouse.wheel({deltaY:Math.max(-900,Math.min(900,state.delta))});
  await chat.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 }
 throw Error('File row did not become reachable after scrolling: '+selector);
}
async function openPicker(){
 // Short windows intentionally scroll the composer; the picker has its own
 // separate reachability invariant once opened.
 await (await chat.$('.cm-add')).scrollIntoView();
 await realClick(chat,'.cm-add','打开引用文件面板');
 await until(async()=>await chat.$eval('.cm-picker',node=>!node.hidden).catch(()=>false),'picker becomes visible');
 await until(async()=>{const value=await chat.$eval('.cm-picker .cm-path',node=>node.value).catch(()=>null);return value&&value.length>0;},'picker initial browse finishes');
}
const pickerHidden=()=>chat.$eval('.cm-picker',node=>node.hidden).catch(()=>true);
async function pickerGeometry(){
 return chat.evaluate(()=>{
  const panel=document.querySelector('.cm-picker');
  if(!panel||panel.hidden)return null;
  const list=panel.querySelector('.cm-picker-list'),foot=panel.querySelector('.cm-picker-foot');
  const rect=node=>{const r=node.getBoundingClientRect();return{left:Math.round(r.left),top:Math.round(r.top),right:Math.round(r.right),bottom:Math.round(r.bottom)};};
  const inside=r=>r.top>=-0.5&&r.left>=-0.5&&r.bottom<=innerHeight+0.5&&r.right<=innerWidth+0.5;
  const reachable=node=>{const r=node.getBoundingClientRect();if(r.width<1||r.height<1)return false;const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return hit===node||node.contains(hit);};
  const doc=document.scrollingElement||document.documentElement;
  return{viewport:{w:innerWidth,h:innerHeight},panel:rect(panel),foot:rect(foot),
   panelInside:inside(panel.getBoundingClientRect()),footInside:inside(foot.getBoundingClientRect()),
   cancelReachable:reachable(panel.querySelector('.cm-cancel')),confirmReachable:reachable(panel.querySelector('.cm-confirm')),
   listScrolls:list.scrollHeight>list.clientHeight,listInside:inside(list.getBoundingClientRect()),
   panelScrolls:panel.scrollHeight>panel.clientHeight+1,pageScrolls:doc.scrollHeight>doc.clientHeight+1,
   horizontalOverflow:doc.scrollWidth>doc.clientWidth+1,
   rows:panel.querySelectorAll('.cm-entry').length,fileRows:panel.querySelectorAll('.cm-entry[data-path]').length,
   moreRow:!!panel.querySelector('.cm-entry-more'),count:panel.querySelector('.cm-picker-count').textContent};
 });
}
async function assertPickerHonest(label,{needListScrolls=true}={}){
 const geometry=await pickerGeometry();
 assert(geometry,label+': picker geometry present');
 assert(geometry.panelInside,label+': whole panel inside viewport '+JSON.stringify(geometry));
 assert(geometry.footInside,label+': 取消/引用 footer fully inside viewport '+JSON.stringify(geometry));
 assert(geometry.cancelReachable&&geometry.confirmReachable,label+': 取消/引用按钮 hit-test reachable '+JSON.stringify(geometry));
 assert(!geometry.panelScrolls&&!geometry.pageScrolls,label+': only the list may scroll '+JSON.stringify(geometry));
 if(needListScrolls)assert(geometry.listScrolls,label+': long list scrolls internally '+JSON.stringify(geometry));
 report.sizes[label]={viewport:geometry.viewport,foot:geometry.foot,rows:geometry.rows};
 return geometry;
}
const convoState=()=>chat.evaluate(()=>({
 draft:document.getElementById('composer').value,
 chips:[...document.querySelectorAll('#compose-form .cm-chip')].map(chip=>({t:chip.textContent.trim().slice(0,30),s:chip.querySelector('.cm-chip-status')?.dataset.status})),
 timeline:document.querySelector('#conversation').innerText,
 active:document.activeElement===document.querySelector('.cm-add')?'add':document.activeElement===document.getElementById('composer')?'composer':document.activeElement&&document.activeElement.className||document.activeElement?.id||'body'}));
async function escCloses(label,{expectFocusAdd=true}={}){
 const before=await convoState(),requests=report.modelRequests.length;
 await chat.keyboard.press('Escape');
 await until(()=>pickerHidden(),label+': Esc closes the picker');
 const after=await convoState();
 assert(after.draft===before.draft,label+': Esc keeps the chat draft untouched');
 assert(JSON.stringify(after.chips)===JSON.stringify(before.chips),label+': Esc keeps confirmed materials untouched');
 assert(after.timeline===before.timeline,label+': Esc keeps the displayed conversation unchanged');
 assert(report.modelRequests.length===requests,label+': Esc triggers zero model requests');
 if(expectFocusAdd)assert(after.active==='add',label+': focus returns to the 引用文件 trigger, got '+after.active);
 return after;
}

try{
 await launch();
 await call(shell,'config.initialize',{mode:'independent'});
 await call(shell,'settings.providers.save',{operation:'create',provider:'picker-live-model',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'synthetic-local-only'}});
 await call(shell,'settings.models.save',{frontdesk:{model:{mode:'explicit',selector:'picker-live-model/scripted'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'explicit',selector:'picker-live-model/scripted'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'picker-live-model/scripted'},thinking:{mode:'native-default'}}});
 await shell.click('#pick-project');
 const pickedScope=await until(async()=>{const scope=await call(shell,'workspace.bootstrap');if(!scope.projectId)return;const recent=await call(shell,'project.recent');return recent.projects.find(project=>path.resolve(project.rootDisplay)===projectRoot)?scope:null;},'synthetic project registered and active');
 const projectId=pickedScope.projectId;
 await call(shell,'managed.enable',{projectId});
 await until(async()=>(await call(shell,'managed.status',{projectId})).ready===true,'managed residents ready');
 await shell.click('#workspace-open-conversation');
 chat=await scoped('conversation',scope=>scope.projectId===projectId);
 await chat.waitForFunction(()=>window.__nozeliReady===true);
 await until(async()=>!(await chat.$eval('#send-message',node=>node.disabled).catch(()=>true)),'composer send enabled');
 await call(shell,'session.resize',{width:1280,height:800});
 await shell.waitForFunction(()=>Math.abs(innerWidth-1280)<=2&&Math.abs(innerHeight-800)<=2);
 const draftMarker='草稿保持检查-PICKER-LIVE-第一段';
 await realClick(chat,'#composer','composer');
 await chat.keyboard.type(draftMarker);
 report.checks.push('isolated conversation surface ready: synthetic 641-entry project, scripted loopback model, real keyboard draft typed');

 /* ---------- A. big directory: default view, pagination, load more ---------- */
 await openPicker();
 await until(async()=>(await pickerGeometry())?.rows>=400,'first 500-entry page renders');
 const firstPage=await assertPickerHonest('big-dir-first-page');
 assert(firstPage.moreRow,'加载更多 row present while entries remain');
 assert(firstPage.fileRows<=501,'page size stays bounded: '+firstPage.fileRows);
 report.checks.push('641-entry project root paginates (first page '+firstPage.fileRows+' rows, 加载更多 visible) with 取消/引用 reachable and only the list scrolling');
 await shot('picker-big-first-page');
 await wheelToListBottom();
 const moreVisible=await chat.evaluate(()=>{const more=document.querySelector('.cm-picker .cm-entry-more');if(!more)return false;const r=more.getBoundingClientRect();return r.height>0&&r.top>=0&&r.bottom<=innerHeight;});
 assert(moreVisible,'real wheel scrolling the list reveals the bottom 加载更多 option');
 await realClick(chat,'.cm-picker .cm-entry-more','加载更多');
 await until(async()=>{const geometry=await pickerGeometry();return geometry&&!geometry.moreRow&&geometry.fileRows>=620;},'second page loads all remaining files');
 const secondPage=await assertPickerHonest('big-dir-after-load-more');
 report.checks.push('real click on 加载更多 loads the remaining page ('+secondPage.fileRows+' file rows, no more-pages row) — bottom options stay reachable');
 await shot('picker-big-load-more');
 await wheelToListBottom();
 // Select a known second-page file without assuming locale-specific sort order.
 const page2Selector='.cm-picker .cm-entry[data-path$="bulk-文件-0600.md"]';
 await revealPickerRow(page2Selector);
 const rootDoc=await reachablePoint(chat,page2Selector);
 assert(rootDoc,'page-2 CJK-named file row is reachable after scrolling to it');
 await chat.mouse.click(rootDoc.x,rootDoc.y);
 const oneState=await chat.evaluate(()=>document.querySelector('.cm-picker-count').textContent);
 assert(/已选 1/.test(oneState),'page-2 CJK-named file selectable: '+oneState);
 await revealPickerRow('.cm-picker .cm-entry[data-path*="bulk-long-"]');
 const longRow=await reachablePoint(chat,'.cm-picker .cm-entry[data-path*="bulk-long-"]');
 assert(longRow,'very long file-name row is clickable after scrolling to it');
 await chat.mouse.click(longRow.x,longRow.y);
 const twoState=await chat.evaluate(()=>document.querySelector('.cm-picker-count').textContent);
 assert(/已选 2/.test(twoState),'long-name file selectable alongside the page-2 pick: '+twoState);
 report.checks.push('long names and page-2 files are real rows that survive selection across pagination');
 // No model request is expected before the explicit keyboard-send leg.
 assert.equal(report.modelRequests.length,0,'opening the picker must not initiate model inference');

 /* ---------- B. Esc contract ---------- */
 // B1: focus on a file row (real click focused it), Esc keeps the unconfirmed selection.
 await escCloses('Esc from file row keeps selection');
 await openPicker();
 const kept=await chat.evaluate(()=>document.querySelector('.cm-picker-count').textContent);
 assert(/已选 2/.test(kept),'reopened picker keeps the unconfirmed cross-page selection: '+kept);
 await escCloses('Esc after reopen');
 // B2: focus in the path input.
 await openPicker();
 await realClick(chat,'.cm-picker .cm-path','path input');
 await escCloses('Esc from path input');
 // B3: focus on the footer buttons.
 await openPicker();
 await chat.focus('.cm-picker .cm-cancel'); // focus placement only; the Esc itself is a real key.
 assert(await chat.evaluate(()=>document.activeElement===document.querySelector('.cm-picker .cm-cancel')),'footer 取消 focused');
 await escCloses('Esc from footer button');
 // B4: focus moved out to the composer while the panel stays open.
 await openPicker();
 // The anchored picker may cover the textarea; move focus out by keyboard,
 // rather than assuming the composer has an exposed mouse-click position.
 await chat.keyboard.down('Shift');
 try{
  for(let attempt=0;attempt<30;attempt++){
   await chat.keyboard.press('Tab');
   if(await chat.evaluate(()=>document.activeElement===document.getElementById('composer')))break;
  }
 }finally{await chat.keyboard.up('Shift');}
 await until(async()=>await chat.evaluate(()=>document.activeElement===document.getElementById('composer')),'composer focused with picker open');
 const typedWhileOpen=draftMarker+'；面板打开时补充';
 await chat.keyboard.type('；面板打开时补充');
 const outsideState=await convoState();
 assert(outsideState.draft===typedWhileOpen,'typing with the picker open reaches the composer draft');
 await escCloses('Esc after focus moved out to composer');
 const draftAfterOutside=await chat.$eval('#composer',node=>node.value);
 assert(draftAfterOutside===typedWhileOpen,'draft text typed while the picker was open survives the Esc close');
 report.checks.push('Esc closes the picker from path input, file row, footer and after focus moved to the composer — draft, chips, focus-return and zero sends verified each time');
 // B5: Esc during an in-flight initial browse must not be re-stolen by the async path focus.
 for(let round=1;round<=6;round++){
 const point=await reachablePoint(chat,'.cm-add');
 assert(point,'race round '+round+': .cm-add must have a reachable click point');
 await chat.mouse.click(point.x,point.y);
 await chat.keyboard.press('Escape'); // fired while the 641-entry browse is still resolving
  await until(()=>pickerHidden(),'race round '+round+': Esc closes');
 }
 await until(async()=>{const value=await chat.$eval('.cm-picker .cm-path',node=>node.value).catch(()=>null);return value&&value.length>0;},'post-race browse settled');
 await pause(400);
 const raceFocus=await chat.evaluate(()=>({hidden:document.querySelector('.cm-picker').hidden,add:document.activeElement===document.querySelector('.cm-add'),path:document.activeElement===document.querySelector('.cm-path')}));
 assert(raceFocus.hidden&&raceFocus.add,'Esc 后异步 path.focus 不得抢回焦点: '+JSON.stringify(raceFocus));
 report.checks.push('Esc pressed while the big-directory browse is still in flight stays closed: the late async path focus never steals focus back ('+JSON.stringify(raceFocus)+')');
 // B6: 取消 clears the unconfirmed selection (contrast with Esc keeping it).
 await openPicker();
 await wheelToListTop();
 await realClick(chat,'.cm-picker .cm-entry[data-path]','select a first-page file');
 await realClick(chat,'.cm-picker .cm-cancel','取消');
 await until(()=>pickerHidden(),'取消 closes the picker');
 await openPicker();
 const afterCancelCount=await chat.evaluate(()=>document.querySelector('.cm-picker-count').textContent);
 assert(/未选择/.test(afterCancelCount),'取消 (not Esc) clears the unconfirmed selection: '+afterCancelCount);
 await escCloses('Esc after cancel-clears check');
 report.checks.push('取消 button clears the unconfirmed selection while Esc preserves it — both leave draft and confirmed materials untouched');
 // B7: composition-guard — a synthetic DOM keydown with isComposing/keyCode 229
 // (explicitly NOT real key delivery and NOT OS IME qualification) must leave
 // the picker open; a real Esc right after still closes it.
 await openPicker();
 const compositionGuard=await chat.evaluate(()=>{
  const input=document.querySelector('.cm-picker .cm-path');
  input.focus();
  input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,keyCode:229,bubbles:true,cancelable:true}));
  return !document.querySelector('.cm-picker').hidden;
 });
 assert(compositionGuard,'composition Esc (isComposing / keyCode 229) must not close the picker');
 await escCloses('real Esc closes after the synthetic composition guard');
 report.checks.push('synthetic composition keydown (isComposing, keyCode 229 — DOM event only, not OS IME) leaves the picker open; the following real Esc closes it');

 /* ---------- C. confirm freezes via real material.attachPath, draft preserved ---------- */
 await openPicker();
 await realClick(chat,'.cm-picker .cm-entry[data-path$="bulk-文件-0004.md"]','project file on first page');
 // Sub-directory rows render at the bottom of the first page — wheel there first.
 await wheelToListBottom();
 await revealPickerRow('.cm-picker .cm-entry-dir[data-dir$="0目录-07"]');
 const dirPoint=await reachablePoint(chat,'.cm-picker .cm-entry-dir[data-dir$="0目录-07"]','sub-directory row');
 await chat.mouse.click(dirPoint.x,dirPoint.y);
 await until(async()=>(await chat.$eval('.cm-picker .cm-path',node=>node.value)).includes('0目录-07'),'navigated into sub-directory');
 await realClick(chat,'.cm-picker .cm-entry[data-path$="内部材料-07.md"]','file inside sub-directory');
 const crossDir=await chat.evaluate(()=>document.querySelector('.cm-picker-count').textContent);
 assert(/已选 2/.test(crossDir),'cross-directory selection counted: '+crossDir);
 // project-external file through the real path input (real keys, real Enter).
 await realClick(chat,'.cm-picker .cm-path','path input for external dir');
 await chat.keyboard.down('Control');await chat.keyboard.press('KeyA');await chat.keyboard.up('Control');
 await chat.keyboard.type(externalDir);
 await chat.keyboard.press('Enter');
 await until(async()=>(await chat.$eval('.cm-picker .cm-path',node=>node.value)).includes('外部材料目录'),'external directory browsable via typed path');
 await realClick(chat,'.cm-picker .cm-entry[data-path$="外部-冻结核对.md"]','external file');
 const threeState=await chat.evaluate(()=>({count:document.querySelector('.cm-picker-count').textContent,confirm:document.querySelector('.cm-picker .cm-confirm').disabled}));
 assert(/已选 3/.test(threeState.count)&&!threeState.confirm,'three files across directories selected: '+JSON.stringify(threeState));
 await assertPickerHonest('footer with wrapped multi-selection count',{needListScrolls:false});
 const draftBeforeConfirm=await chat.$eval('#composer',node=>node.value);
 await realClick(chat,'.cm-picker .cm-confirm','引用所选文件');
 await until(()=>pickerHidden(),'confirm closes the picker');
 await until(async()=>{const chips=await chat.evaluate(()=>[...document.querySelectorAll('#compose-form .cm-chip .cm-chip-status')].map(node=>node.dataset.status));return chips.length===3&&chips.every(status=>status==='ok');},'three materials frozen ok');
 const confirmState=await convoState();
 assert(confirmState.draft===draftBeforeConfirm,'confirming materials preserves the chat draft byte-for-byte');
 assert(confirmState.active==='add','confirm returns focus to the 引用文件 trigger, got '+confirmState.active);
 const persisted=await chat.evaluate(()=>window.__composerMaterials?.snapshotPersist?.());
 assert(persisted?.pending?.length===3&&persisted.pending.every(entry=>entry.digest),'frozen materials carry digests (host attachPath copies)');
 await shot('picker-confirm-three-chips');
 report.checks.push('real material.browse paging + typed-path navigation + material.attachPath freeze: 3 materials (project file, sub-directory file, project-external file) all ok with draft and focus preserved');
 // Freeze honesty: mutate sources after confirm; the frozen copy must not change.
 await fs.writeFile(path.join(projectRoot,'bulk-文件-0004.md'),'MUTATED-AFTER-FREEZE\n');
 await fs.writeFile(path.join(externalDir,'外部-冻结核对.md'),'MUTATED-AFTER-FREEZE\n');
 await realClick(chat,'#compose-form .cm-chip-main[data-digest]','external frozen chip');
 await until(async()=>await chat.$eval('.material-viewer',node=>!node.hidden).catch(()=>false),'material viewer opens');
 await until(async()=>(await chat.$eval('.material-viewer .mv-body',node=>node.innerText).catch(()=>'')).includes(FROZEN_EXTERNAL),'viewer shows the frozen original bytes');
 const viewerLeak=await chat.$eval('.material-viewer .mv-body',node=>node.innerText);
 assert(!viewerLeak.includes('MUTATED-AFTER-FREEZE'),'viewer never shows post-freeze mutations');
 await shot('picker-frozen-viewer');
 report.checks.push('frozen material keeps the original bytes after both sources were mutated on disk (digest copy, not a live reference)');

 /* ---------- D. layered Esc: preview over picker, then Zen, then settings ---------- */
 // D1: material viewer visible -> first Esc closes only the viewer, picker stays.
 await realClick(chat,'.cm-add','open picker under viewer'); // viewer stays open (right side)
 await until(async()=>await chat.$eval('.cm-picker',node=>!node.hidden).catch(()=>false),'picker opens while viewer visible');
 const layerBefore=await chat.evaluate(()=>({viewer:!document.querySelector('.material-viewer').hidden,picker:!document.querySelector('.cm-picker').hidden}));
 assert(layerBefore.viewer&&layerBefore.picker,'viewer and picker stacked: '+JSON.stringify(layerBefore));
 await chat.keyboard.press('Escape');
 await until(async()=>await chat.$eval('.material-viewer',node=>node.hidden).catch(()=>false),'first Esc closes the preview layer');
 await pause(300);
 const layerAfter=await chat.evaluate(()=>({viewer:!document.querySelector('.material-viewer').hidden,picker:!document.querySelector('.cm-picker').hidden}));
 assert(!layerAfter.viewer&&layerAfter.picker,'Esc closes the higher preview layer first, picker stays open: '+JSON.stringify(layerAfter));
 await escCloses('second Esc closes the picker');
 report.checks.push('Esc priority: with the read-only preview stacked over the picker, the first Esc closes only the preview and the picker stays open');
 // D2: Zen focus mode — picker Esc must not exit Zen (workspace modalEscapes contract).
 await chat.keyboard.down('Control');await chat.keyboard.down('Shift');await chat.keyboard.press('F11');await chat.keyboard.up('Shift');await chat.keyboard.up('Control');
 await until(async()=>await chat.$eval('#app',node=>node.classList.contains('focus-mode')),'Ctrl+Shift+F11 enters Zen');
 await openPicker();
 await escCloses('Esc inside Zen closes only the picker');
 assert(await chat.$eval('#app',node=>node.classList.contains('focus-mode')),'Zen focus mode survives the picker Esc');
 await chat.keyboard.press('Escape');
 await until(async()=>!(await chat.$eval('#app',node=>node.classList.contains('focus-mode'))),'next unclaimed Esc exits Zen');
 report.checks.push('Esc priority: inside Zen the picker Esc closes the picker only (focus-mode preserved); the next unclaimed Esc exits Zen — no regression to the workspace modalEscapes guard');
 // D3: settings dialog (opened in the shell window per product routing) — its Esc must not reach the conversation picker.
 await openPicker();
 await shell.click('#open-settings');
 await shell.waitForSelector('#settings-dialog[open]');
 await shell.click('[data-settings-section="settings-general"]');
 const helpText=await shell.$eval('#settings-general',node=>node.innerText);
 assert(/发送/.test(helpText)&&/Ctrl/.test(helpText)&&/Enter/.test(helpText)&&/换行/.test(helpText)&&/F11/.test(helpText)&&/Zen/.test(helpText)&&/Esc/.test(helpText),'settings 快捷键 help documents Ctrl+Enter send / Enter newline / Shift+F11 Zen / Esc exit: '+JSON.stringify(helpText));
 await shell.keyboard.press('Escape');
 await until(async()=>!(await shell.$eval('#settings-dialog',node=>node.open)),'settings Esc closes the settings dialog');
 assert(!(await pickerHidden()),'settings Esc does not close the conversation picker');
 await escCloses('conversation Esc after settings');
 report.checks.push('Esc priority: settings (shell-routed dialog) closes on its own Esc while the conversation picker stays open; the help text matches the four documented shortcuts');

 /* ---------- E. viewport matrix: short window, narrow panel, elevated zoom ---------- */
 // E0: live window resize with the picker open must re-settle honestly, and a
 // wrapping multi-line error text must not push 取消/引用 out of the viewport.
 await openPicker();
 await until(async()=>(await pickerGeometry())?.rows>=400,'pre-resize page renders');
 await call(shell,'session.resize',{width:800,height:560});
 await shell.waitForFunction(()=>Math.abs(innerWidth-800)<=2&&Math.abs(innerHeight-560)<=2);
 await chat.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 await pause(250);
 await assertPickerHonest('resized-while-open-800x560');
 await realClick(chat,'.cm-picker .cm-path','path input for error-wrap leg');
 await chat.keyboard.down('Control');await chat.keyboard.press('KeyA');await chat.keyboard.up('Control');
 await chat.keyboard.type(path.join(out,'不存在的超长错误目录路径'+('很长的不存在子目录名'.repeat(8))));
 await chat.keyboard.press('Enter');
 await until(async()=>await chat.$eval('.cm-picker .cm-picker-error',node=>!node.hidden&&node.textContent.trim().length>0).catch(()=>false),'nonexistent path shows an error');
 const errorGeometry=await assertPickerHonest('with-wrapped-error-text');
 assert(errorGeometry.footInside&&errorGeometry.cancelReachable&&errorGeometry.confirmReachable,'footer buttons stay reachable under wrapped error text: '+JSON.stringify(errorGeometry));
 await shot('picker-error-wrap');
 await escCloses('Esc after error-wrap leg');
 report.checks.push('window resized while the picker is open (800x560) and a long wrapping error text both keep 取消/引用 fully in viewport and clickable');
 await call(shell,'session.resize',{width:620,height:520});
 await shell.waitForFunction(()=>Math.abs(innerWidth-620)<=2&&Math.abs(innerHeight-520)<=2);
 await openPicker();
 await until(async()=>(await pickerGeometry())?.rows>=400,'short window renders first page');
 const shortGeometry=await assertPickerHonest('short-window-620x520');
 await realClick(chat,'.cm-picker .cm-entry[data-path$="bulk-文件-0002.md"]','short-window file');
 await realClick(chat,'.cm-picker .cm-confirm','short-window confirm');
 await until(()=>pickerHidden(),'short-window confirm closes');
 await until(async()=>{const chips=await chat.evaluate(()=>[...document.querySelectorAll('#compose-form .cm-chip .cm-chip-status')].map(node=>node.dataset.status));return chips.length===4&&chips.every(status=>status==='ok');},'short-window freeze ok');
 await shot('picker-short-window');
 report.checks.push('short 620x520 window: 取消/引用 stay fully in viewport and really work (freeze completed) with only the list scrolling');
 await openPicker();
 await escCloses('Esc in short window');
 await call(shell,'session.resize',{width:420,height:720});
 await shell.waitForFunction(()=>Math.abs(innerWidth-420)<=2&&Math.abs(innerHeight-720)<=2);
 await openPicker();
 await until(async()=>(await pickerGeometry())?.rows>=400,'narrow window renders first page');
 const narrowGeometry=await assertPickerHonest('narrow-420x720',{needListScrolls:true});
 assert(!narrowGeometry.horizontalOverflow,'narrow conversation surface has no horizontal document overflow');
 await shot('picker-narrow-window');
 await escCloses('Esc in narrow window');
 report.checks.push('narrow 420x720 conversation surface: footer buttons reachable, no horizontal overflow, only the list scrolls');
 await call(shell,'session.resize',{width:1000,height:760});
 await shell.waitForFunction(()=>Math.abs(innerWidth-1000)<=2&&Math.abs(innerHeight-760)<=2);
 for(const factor of [1.25,1.5]){
  await chat.evaluate(zoom=>{document.querySelector('#conversation-panel').style.zoom=String(zoom);},factor);
  await chat.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await openPicker();
  await until(async()=>(await pickerGeometry())?.rows>=400,'zoom '+factor+' renders first page');
  await assertPickerHonest('css-zoom-'+factor);
  await escCloses('Esc at CSS zoom '+factor);
  await shot('picker-zoom-'+String(factor).replace('.','-'));
 }
 await chat.evaluate(()=>document.querySelector('#conversation-panel').style.removeProperty('zoom'));
 report.checks.push('125%/150% CSS zoom legs (labeled CSS zoom, not OS zoom): footer stays reachable and only the list scrolls');

 /* ---------- F. settings help text vs real key delivery + one scripted send ---------- */
 const chipsBefore=await chat.evaluate(()=>document.querySelectorAll('#compose-form .cm-chip').length);
 while(await chat.$('.cm-chip-x')){await (await chat.$('.cm-chip-x')).scrollIntoView();await realClick(chat,'.cm-chip-x','remove chip');await pause(80);}
 assert(chipsBefore>=4&&(await chat.evaluate(()=>document.querySelectorAll('#compose-form .cm-chip').length))===0,'chips removed before the send leg');
 await realClick(chat,'#composer','composer for shortcut proof');
 await chat.keyboard.press('End');
 await chat.keyboard.press('Enter');
 await chat.keyboard.type('快捷键验收第二行：Enter 已换行');
 const newlineValue=await chat.$eval('#composer',node=>node.value);
 assert(newlineValue.includes('快捷键验收第二行')&&newlineValue.includes('\n'),'plain Enter really inserts a newline (help text 换行：Enter)');
 const requestsBefore=report.modelRequests.length;
 const jobsBefore=(await call(chat,'managed.status',{projectId})).state.jobs.length;
 await chat.keyboard.down('Control');await chat.keyboard.press('Enter');await chat.keyboard.up('Control');
 await until(async()=>{const value=await chat.$eval('#composer',node=>node.value);return value==='';},'Ctrl+Enter really sends and clears the composer');
 await until(async()=>{const jobs=(await call(chat,'managed.status',{projectId})).state.jobs;return jobs.length===jobsBefore+1&&jobs.at(-1)?.status==='completed';},'scripted-model job completes');
 await until(async()=>await chat.$eval('#conversation',node=>node.innerText.includes('快捷键验收第二行')),'user message rendered');
 await until(async()=>await chat.$eval('#conversation',(node,marker)=>node.innerText.includes(marker),REPLY_MARKER),'scripted reply rendered');
 assert(report.modelRequests.length===requestsBefore+1,'exactly one loopback model request for the whole run\'s single send');
 report.checks.push('help text ↔ real keys: Enter=newline, Ctrl+Enter=send (real CLI transport to the loopback scripted model, 1 recorded request, synthetic reply rendered — no real provider, no fabricated receipt)');
 await shot('picker-shortcut-send');
 assert.deepEqual(report.errors,[],'no renderer page errors across all surfaces');

 /* ---------- G. clean exit ---------- */
 const closeShell=await shell.evaluate(()=>nozeli.invoke('session.requestClose',{}));
 assert(closeShell.ok,'shell requestClose: '+JSON.stringify(closeShell.error));
 let exited=await Promise.race([exitPromise,pause(15000).then(()=>null)]);
 if(!exited){
  const quitOpen=await shell.$eval('#quit-choice',node=>node.open).catch(()=>false);
  if(quitOpen){await shell.click('#quit-cancel');exited=await Promise.race([exitPromise,pause(45000).then(()=>null)]);}
 }
 if(exited){assert.deepEqual(exited,{code:0,signal:null},'normal close must exit 0');report.normalExits.push({scene:'picker-live-close',...exited});report.checks.push('normal close exits 0');}
 else throw new Error('app did not exit after requestClose');
 report.ok=true;
}catch(error){
 report.failure=error.stack;
 console.log(report.failure);
 const failurePage=chat||shell;
 if(failurePage){
  await failurePage.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
  console.log(await failurePage.evaluate(()=>document.body.innerText.slice(-2500)).catch(()=>null));
  console.log('PICKER',await failurePage.evaluate(()=>({hidden:document.querySelector('.cm-picker')?.hidden,active:document.activeElement?.className})).catch(()=>null));
 }
 process.exitCode=1;
}finally{
 await browser?.disconnect().catch(()=>{});
 if(child&&child.exitCode===null&&!child.signalCode){report.cleanup={forced:true};child.kill('SIGTERM');const stopped=await Promise.race([exitPromise.then(()=>true),pause(5000).then(()=>false)]);if(!stopped){child.kill('SIGKILL');await exitPromise;report.cleanup.signal='SIGKILL';}else report.cleanup.signal='SIGTERM';}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 await fs.writeFile(path.join(out,'main.log'),log);
 console.log(JSON.stringify({ok:report.ok,root:out,mode,checks:report.checks,scenes:report.scenes,modelRequests:report.modelRequests.length,normalExits:report.normalExits,errors:report.errors,notCovered:report.notCovered,failure:report.failure},null,2));
}
