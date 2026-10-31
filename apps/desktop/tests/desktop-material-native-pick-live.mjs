// Real-Electron acceptance for the composer 引用文件 panel's NATIVE selection
// entries: the 选择文件… button (material.pickFiles — external FILE multiselect,
// files only) and the 选择文件夹… button (material.pickDirectory — browse entry,
// directories are opened in the list, never attached), each reached through a
// real renderer click, the real renderer→main IPC op and the REAL main-process
// handler code, then frozen through the real material.attachPath host copy.
//
// Native-dialog boundary: NOZELI_TEST_PICK is deliberately NOT set (that env
// bypass would short-circuit the handlers and prove nothing about the chooser
// path). Instead the Electron entry is tests/material-native-pick-fixture.main.cjs,
// which requires the real src/main/main.cjs unchanged and replaces only
// electron.dialog.showOpenDialog with a scripted fixture. The fixture LOGS every
// call (title / properties / defaultPath) — proof the real handler really asked
// the OS chooser API with ['openFile','multiSelections'] / ['openDirectory'] —
// and returns synthetic paths or cancel. => The native OS chooser WINDOW itself
// (portal UI, keyboard navigation inside it) is explicitly NOT tested; see
// report.notCovered.
//
// Also encodes the picker bar's responsive honesty contract: at 1280/420/360 px
// the bar must not overflow the panel, all four bar controls stay inside the
// panel/viewport and hit-test reachable, and the path input keeps flexing to
// fill the bar.
//
// Two contracts verified with bytes, not labels: confirmed selections freeze the
// ACTUAL file bytes (material.read returns byte-identical content even after the
// source files are mutated on disk), and a synthetic credentials file planted in
// the isolated HOME is never surfaced in any material ref nor in the single
// recorded loopback model request.
//
// Launch (source mode only; dist/renderer must already be built):
//   node tests/desktop-material-native-pick-live.mjs --app-root <repo>/apps/desktop
//
// Sibling coverage NOT repeated here: 641-entry pagination, zoom/short-window
// matrix, full Esc contract and settings help — tests/desktop-composer-picker-live.mjs.
//
// Isolation: everything lives under one mkdtemp root — synthetic project,
// synthetic external material directory, sanitized HOME/XDG_* (with a planted
// credentials.json that must never be read), dedicated
// NOZELI_CONFIG_ROOT/NOZELI_USER_DATA, NOZELI_TEST_INSTANCE, dedicated CDP port,
// loopback-only scripted model. Real user profile/caches/credentials are never
// read and no real provider is contacted. No NODE_OPTIONS observer is injected,
// so full-process network isolation is not claimed.
//
// Input honesty: clicks and keys go through CDP Input (real trusted events);
// coordinates are hit-tested with elementFromPoint before every real click.
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
const appRootOption=option('--app-root');
assert(appRootOption,'this live check runs in source mode only (--app-root <apps/desktop>): the dialog fixture must wrap src/main/main.cjs');
const appRoot=path.resolve(appRootOption);
const binary=createRequire(path.join(appRoot,'package.json'))('electron');
const fixtureMain=path.join(appRoot,'tests','material-native-pick-fixture.main.cjs');

const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-material-native-pick-'));
const projectRoot=path.join(out,'synthetic-project');
const externalDir=path.join(out,'外部材料目录');
const externalSub=path.join(externalDir,'外部子目录');
const extFileA=path.join(externalDir,'外部材料甲.md');
const extFileB=path.join(externalDir,'外部材料乙.md');
const subFile=path.join(externalSub,'子目录内部.md');
const projectDoc=path.join(projectRoot,'材料-说明.md');
const FROZEN_A='EXTERNAL-FROZEN-A-4471\n';
const FROZEN_B='EXTERNAL-FROZEN-B-4472\n';
const FROZEN_SUB='EXTERNAL-FROZEN-SUB-4473\n';
const PROJECT_DOC='PROJECT-DOC-FROZEN-4474\n';
const MUTATED_A='MUTATED-AFTER-FREEZE-NATIVE-4475\n';
const SECRET_MARKER='CREDENTIAL-SECRET-MARKER-7731';
const REPLY_MARKER='合成回复 NATIVE-PICK（脚本模型）';
const DRAFT_MARKER='原生选择-草稿保持-NATIVE-PICK-第一段';
const report={ok:false,kind:'material-native-pick-live',mode:'source',out,binary,appRoot,projectRoot,
 coverage:'Native selection entries (选择文件… / 选择文件夹…) driven by real renderer clicks through the real IPC ops and real main handlers; electron.dialog.showOpenDialog intercepted by a main-process fixture returning scripted paths/cancel (native OS chooser window itself not exercised). Frozen bytes proven via material.read + read-only viewer after on-disk mutation. Isolated HOME/XDG/config; loopback scripted model over the real CLI transport; real CDP mouse/keyboard with elementFromPoint hit tests.',
 checks:[],scenes:[],modelRequests:[],dialogCalls:[],sizes:{},errors:[],normalExits:[],
 notCovered:['Native OS chooser WINDOW (xdg portal / file pane / multi-select keyboard interaction) — a main-process dialog fixture answers at the electron.dialog.showOpenDialog API boundary; the real main handlers and their dialog options are proven by the call log, the OS UI itself is not',
  'NOZELI_TEST_PICK bypass — proven absent by construction (env unset) plus the dialog call log; the bypass branch itself is not exercised here',
  'installed --release mode — unsupported: the fixture entry must wrap the source src/main/main.cjs',
  'OS IME/composition, OS zoom, 641-entry pagination and the full Esc matrix — owned by tests/desktop-composer-picker-live.mjs',
  'send-time promotion of path-select materials — currently refused by the drawing-PNG-only send guard; asserted as-is, not redesigned here']};
console.log('EVIDENCE_ROOT='+out);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=90000){
 const deadline=Date.now()+timeout;
 do{const value=await fn();if(value)return value;await pause(100);}while(Date.now()<deadline);
 throw new Error('Timed out: '+label);
}
const freePort=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
// Loopback scripted model: records FULL request bodies so the single send is
// provable and the credentials-never-read claim is checkable on real traffic.
const server=http.createServer((req,res)=>{let body='';req.on('data',bytes=>body+=bytes);req.on('end',()=>{
 report.modelRequests.push({at:new Date().toISOString(),path:req.url,body:body.slice(0,131072)});
 res.writeHead(200,{'content-type':'text/event-stream'});
 for(const [delta,finish] of [[{role:'assistant',content:REPLY_MARKER},null],[{},'stop']])
  res.write('data: '+JSON.stringify({id:'material-native-pick-local',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
 res.end('data: [DONE]\n\n');
});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

/* ---------- synthetic project + external materials + planted credentials ---------- */
await fs.mkdir(externalSub,{recursive:true});
await fs.mkdir(projectRoot,{recursive:true});
await fs.writeFile(projectDoc,PROJECT_DOC);
for(let index=1;index<=5;index++)await fs.writeFile(path.join(projectRoot,`项目笔记-${String(index).padStart(2,'0')}.md`),`PROJECT-NOTE-FROZEN-${index}\n`);
await fs.writeFile(extFileA,FROZEN_A);
await fs.writeFile(extFileB,FROZEN_B);
await fs.writeFile(subFile,FROZEN_SUB);
const fixtureState=path.join(out,'pick-fixture-state.json'),fixtureCalls=path.join(out,'pick-fixture-calls.jsonl');
await fs.writeFile(fixtureState,JSON.stringify({queue:[]}));

function isolatedEnvironment(port){
 const env={...process.env};
 for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
 // NOZELI_TEST_PICK is intentionally NOT set: the native pick ops must reach
 // the real dialog call path, intercepted only by the main-process fixture.
 Object.assign(env,{HOME:path.join(out,'home'),XDG_CONFIG_HOME:path.join(out,'home','.config'),XDG_DATA_HOME:path.join(out,'home','.local','share'),XDG_CACHE_HOME:path.join(out,'home','.cache'),
  NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:path.join(out,'config'),NOZELI_USER_DATA:path.join(out,'config','desktop'),
  NOZELI_SHOT_DIR:out,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',
  NOZELI_PICK_FIXTURE_STATE:fixtureState,NOZELI_PICK_FIXTURE_CALLS:fixtureCalls});
 return env;
}
// Decoy credentials inside the isolated HOME: nothing may read or surface them.
await fs.mkdir(path.join(out,'home','.config','credentials'),{recursive:true});
await fs.writeFile(path.join(out,'home','.config','credentials','credentials.json'),JSON.stringify({secret:SECRET_MARKER})+'\n');

async function enqueue(reply){const state=JSON.parse(await fs.readFile(fixtureState,'utf8'));state.queue.push(reply);await fs.writeFile(fixtureState,JSON.stringify(state));}
async function dialogCalls(){try{return (await fs.readFile(fixtureCalls,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch{return [];}}
async function waitDialogCall(label,predicate){return until(async()=>(await dialogCalls()).find(predicate),label);}

let child,browser,shell,chat,log='',exitPromise;
async function launch(){
 const port=await freePort(),env=isolatedEnvironment(port);
 await fs.mkdir(env.HOME,{recursive:true,mode:0o700});
 log+='\n=== launch on CDP '+port+' with dialog fixture ===\n';
 child=spawn(binary,[fixtureMain,'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland'),'--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'],{cwd:out,env,stdio:['ignore','pipe','pipe']});
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
 return page.evaluate(selector=>{const node=document.querySelector(selector);if(!node)return null;const r=node.getBoundingClientRect();if(r.width<1||r.height<1)return null;const w=r.width,h=r.height;const pts=[[w*0.15,h*0.5],[w*0.5,h*0.5],[w*0.85,h*0.5],[w*0.5,h*0.25],[w*0.5,h*0.75]];for(const[fractionX,fractionY]of pts){const x=r.left+fractionX,y=r.top+fractionY;if(x<0||y<0||x>=innerWidth||y>=innerHeight)continue;const hit=document.elementFromPoint(x,y);if(hit===node||node.contains(hit))return{x:Math.round(x),y:Math.round(y)};}return null;},selector);
}
async function realClick(page,selector,label){
 await page.waitForSelector(selector,{visible:true,timeout:15000});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const point=await reachablePoint(page,selector);
 assert(point,label+': '+selector+' must have a viewport-reachable click point');
 await page.mouse.click(point.x,point.y);
}
async function realClickHandle(handle,label){
 await handle.scrollIntoView();
 await chat.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 const box=await handle.boundingBox();
 assert(box&&box.width>0&&box.height>0,label+': element must be visible');
 await chat.mouse.click(box.x+box.width/2,box.y+box.height/2);
}
async function openPicker(){
 await (await chat.$('.cm-add')).scrollIntoView();
 await realClick(chat,'.cm-add','打开引用文件面板');
 await until(async()=>await chat.$eval('.cm-picker',node=>!node.hidden).catch(()=>false),'picker becomes visible');
 await until(async()=>{const value=await chat.$eval('.cm-picker .cm-path',node=>node.value).catch(()=>null);return value&&value.length>0;},'picker initial browse finishes');
}
// The fixture logs the dialog call the moment the main handler asks the OS
// chooser API — the renderer still needs an IPC round trip to settle (buttons
// re-enabled, focus returned, error cleared). Wait for that settled state
// before asserting it.
async function settleAfterNative(label){
 await until(async()=>await chat.evaluate(()=>!document.querySelector('.cm-pick-files').disabled&&!document.querySelector('.cm-browse').disabled&&document.activeElement===document.querySelector('.cm-picker .cm-path')&&document.querySelector('.cm-picker-error').hidden).catch(()=>false),label);
}
const pickerHidden=()=>chat.$eval('.cm-picker',node=>node.hidden).catch(()=>true);
const draftNow=()=>chat.$eval('#composer',node=>node.value);
const chipsNow=()=>chat.evaluate(()=>[...document.querySelectorAll('#compose-form .cm-chip')].map(chip=>({title:chip.querySelector('.cm-chip-main')?.title||'',status:chip.querySelector('.cm-chip-status')?.dataset.status})));
const countText=()=>chat.$eval('.cm-picker-count',node=>node.textContent).catch(()=>'');
const pickCount=async()=>{const text=await countText();const match=/已选 (\d+) 个文件/.exec(text);return match?Number(match[1]):-1;};
async function pickerGeometry(){
 return chat.evaluate(()=>{
  const panel=document.querySelector('.cm-picker');
  if(!panel||panel.hidden)return null;
  const list=panel.querySelector('.cm-picker-list'),foot=panel.querySelector('.cm-picker-foot'),bar=panel.querySelector('.cm-picker-bar');
  const prect=panel.getBoundingClientRect();
  const rect=node=>{const r=node.getBoundingClientRect();return{left:Math.round(r.left),top:Math.round(r.top),right:Math.round(r.right),bottom:Math.round(r.bottom),width:Math.round(r.width)};};
  const inside=r=>r.top>=-0.5&&r.left>=-0.5&&r.bottom<=innerHeight+0.5&&r.right<=innerWidth+0.5;
  const insidePanel=r=>r.left>=prect.left-0.5&&r.right<=prect.right+0.5&&r.top>=prect.top-0.5&&r.bottom<=prect.bottom+0.5;
  const reachable=node=>{const r=node.getBoundingClientRect();if(r.width<1||r.height<1)return false;const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return hit===node||node.contains(hit);};
  const doc=document.scrollingElement||document.documentElement;
  const controls=['.cm-up','.cm-path','.cm-pick-files','.cm-browse'].map(sel=>{const node=bar.querySelector(sel);const r=node.getBoundingClientRect();return{sel,rect:rect(node),insidePanel:insidePanel(r),insideViewport:inside(r),reachable:reachable(node)};});
  return{viewport:{w:innerWidth,h:innerHeight},panel:rect(panel),foot:rect(foot),
   panelInside:inside(prect),footInside:inside(foot.getBoundingClientRect()),
   cancelReachable:reachable(panel.querySelector('.cm-cancel')),confirmReachable:reachable(panel.querySelector('.cm-confirm')),
   listScrolls:list.scrollHeight>list.clientHeight,listInside:inside(list.getBoundingClientRect()),
   panelScrolls:panel.scrollHeight>panel.clientHeight+1,pageScrolls:doc.scrollHeight>doc.clientHeight+1,
   horizontalOverflow:doc.scrollWidth>doc.clientWidth+1,
   barOverflow:bar.scrollWidth>bar.clientWidth+1,barScrollWidth:bar.scrollWidth,barClientWidth:bar.clientWidth,
   controls,rows:panel.querySelectorAll('.cm-entry').length,fileRows:panel.querySelectorAll('.cm-entry[data-path]').length,
   count:panel.querySelector('.cm-picker-count').textContent};
 });
}
async function assertPickerHonest(label,{needListScrolls=false,needInputFlex=false}={}){
 const geometry=await pickerGeometry();
 assert(geometry,label+': picker geometry present');
 assert(geometry.panelInside,label+': whole panel inside viewport '+JSON.stringify(geometry));
 assert(geometry.footInside,label+': 取消/引用 footer fully inside viewport '+JSON.stringify(geometry));
 assert(geometry.cancelReachable&&geometry.confirmReachable,label+': 取消/引用按钮 hit-test reachable '+JSON.stringify(geometry));
 assert(!geometry.panelScrolls&&!geometry.pageScrolls,label+': only the list may scroll '+JSON.stringify(geometry));
 if(needListScrolls)assert(geometry.listScrolls,label+': long list scrolls internally '+JSON.stringify(geometry));
 assert(!geometry.barOverflow,label+': picker bar must not overflow horizontally '+JSON.stringify({barScrollWidth:geometry.barScrollWidth,barClientWidth:geometry.barClientWidth,viewport:geometry.viewport}));
 for(const control of geometry.controls){
  assert(control.insidePanel,label+': bar control '+control.sel+' stays inside the panel border '+JSON.stringify(control));
  assert(control.insideViewport,label+': bar control '+control.sel+' inside the viewport '+JSON.stringify(control));
  assert(control.reachable,label+': bar control '+control.sel+' hit-test reachable '+JSON.stringify(control));
 }
 if(needInputFlex){const input=geometry.controls.find(control=>control.sel==='.cm-path');assert(input.rect.width>=200,label+': path input flexes to fill the bar at wide widths (got '+input.rect.width+'px)');}
 report.sizes[label]={viewport:geometry.viewport,bar:{scrollWidth:geometry.barScrollWidth,clientWidth:geometry.barClientWidth},controls:geometry.controls.map(control=>({sel:control.sel,width:control.rect.width,right:control.rect.right}))};
 return geometry;
}
async function escCloses(label){
 const draftBefore=await draftNow(),chipsBefore=await chipsNow(),requests=report.modelRequests.length;
 await chat.keyboard.press('Escape');
 await until(()=>pickerHidden(),label+': Esc closes the picker');
 assert(await draftNow()===draftBefore,label+': Esc keeps the chat draft untouched');
 assert(JSON.stringify(await chipsNow())===JSON.stringify(chipsBefore),label+': Esc keeps confirmed materials untouched');
 assert(report.modelRequests.length===requests,label+': Esc triggers zero model requests');
 const active=await chat.evaluate(()=>document.activeElement===document.querySelector('.cm-add')?'add':document.activeElement&&document.activeElement.className||document.activeElement?.id||'body');
 assert(active==='add',label+': focus returns to the 引用文件 trigger, got '+active);
}

try{
 await launch();
 await call(shell,'config.initialize',{mode:'independent'});
 await call(shell,'settings.providers.save',{operation:'create',provider:'pick-native-model',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'synthetic-local-only'}});
 await call(shell,'settings.models.save',{frontdesk:{model:{mode:'explicit',selector:'pick-native-model/scripted'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'explicit',selector:'pick-native-model/scripted'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'pick-native-model/scripted'},thinking:{mode:'native-default'}}});
 // Project registration itself goes through the fixture-backed native dialog
 // (project.pick → dialog.showOpenDialog ['openDirectory']) — no env bypass.
 await enqueue({filePaths:[projectRoot],canceled:false});
 await shell.click('#pick-project');
 const pickedScope=await until(async()=>{const scope=await call(shell,'workspace.bootstrap');if(!scope.projectId)return;const recent=await call(shell,'project.recent');return recent.projects.find(project=>path.resolve(project.rootDisplay)===projectRoot)?scope:null;},'synthetic project registered and active via fixture-backed native directory pick');
 const projectId=pickedScope.projectId;
 const projectPickCall=await waitDialogCall('project.pick dialog call',entry=>entry.title==='选择项目目录');
 assert.deepEqual(projectPickCall.properties,['openDirectory'],'project.pick asks the OS chooser for a single directory: '+JSON.stringify(projectPickCall));
 report.checks.push('project registration used the real project.pick handler → dialog.showOpenDialog(properties ["openDirectory"]) intercepted by the main-process fixture (NOZELI_TEST_PICK unset, bypass not taken)');

 await call(shell,'managed.enable',{projectId});
 await until(async()=>(await call(shell,'managed.status',{projectId})).ready===true,'managed residents ready');
 await shell.click('#workspace-open-conversation');
 chat=await scoped('conversation',scope=>scope.projectId===projectId);
 await chat.waitForFunction(()=>window.__nozeliReady===true);
 await until(async()=>!(await chat.$eval('#send-message',node=>node.disabled).catch(()=>true)),'composer send enabled');
 await call(shell,'session.resize',{width:1280,height:800});
 await shell.waitForFunction(()=>Math.abs(innerWidth-1280)<=2&&Math.abs(innerHeight-800)<=2);
 await realClick(chat,'#composer','composer');
 await chat.keyboard.type(DRAFT_MARKER);
 report.checks.push('isolated conversation surface ready: synthetic project registered through the fixture-backed native pick, scripted loopback model, real keyboard draft typed');

 /* ---------- A. native FILE multiselect: cancel preserves state ---------- */
 await openPicker();
 await until(async()=>(await pickerGeometry())?.rows>=5,'project directory renders');
 await assertPickerHonest('bar-at-first-open-1280x800',{needInputFlex:true});
 await realClick(chat,'.cm-picker .cm-entry[data-path$="材料-说明.md"]','project file row');
 assert.equal(await pickCount(),1,'selecting a project file row counts it: '+await countText());
 const draftA=await draftNow();
 await enqueue({canceled:true});
 const pickFilesCallsA=await dialogCalls().then(calls=>calls.filter(entry=>entry.title==='选择要引用的文件').length);
 await realClick(chat,'.cm-picker .cm-pick-files','选择文件… (native cancel leg)');
 const cancelCall=await waitDialogCall('native pickFiles cancel call',entry=>entry.title==='选择要引用的文件');
 assert.deepEqual(cancelCall.properties,['openFile','multiSelections'],'material.pickFiles asks the OS chooser for multi-file selection: '+JSON.stringify(cancelCall));
 assert.equal((await dialogCalls()).filter(entry=>entry.title==='选择要引用的文件').length,pickFilesCallsA+1,'exactly one dialog call for this click');
 assert(await pickerHidden()===false,'cancel of the native chooser keeps the picker panel open');
await settleAfterNative('picker settles after the canceled native file chooser');
assert.equal(await pickCount(),1,'native-file-picker cancel preserves the unconfirmed selection: '+await countText());
 assert(await draftNow()===draftA,'native-file-picker cancel preserves the chat draft');
 assert(await chat.$eval('.cm-picker-error',node=>node.hidden),'native-file-picker cancel leaves no error state');
 const pickFilesState=await chat.evaluate(()=>({disabled:document.querySelector('.cm-pick-files').disabled,label:document.querySelector('.cm-pick-files').textContent.trim(),focus:document.activeElement===document.querySelector('.cm-picker .cm-path')}));
 assert(!pickFilesState.disabled&&pickFilesState.label==='选择文件…','选择文件… re-enabled with its label intact: '+JSON.stringify(pickFilesState));
 assert(pickFilesState.focus,'focus returns to the picker path input after the native chooser closes');
 report.checks.push('选择文件… cancel (fixture-canceled OS chooser): dialog options ["openFile","multiSelections"] proven, panel stays open, unconfirmed selection/draft preserved, focus returns to the path input');

 /* ---------- B. native FILE multiselect: external files land in the selection ---------- */
 await enqueue({filePaths:[extFileA,extFileB],canceled:false});
 await realClick(chat,'.cm-picker .cm-pick-files','选择文件… (native multiselect leg)');
 await until(async()=>(await pickCount())===3,'two externally picked files join the project-file selection');
 const multiCall=(await dialogCalls()).filter(entry=>entry.title==='选择要引用的文件').at(-1);
 assert.deepEqual(multiCall.properties,['openFile','multiSelections'],'second pickFiles call still asks for multiselect: '+JSON.stringify(multiCall));
 const stillProjectListing=await chat.$eval('.cm-picker .cm-path',node=>node.value);
 assert(stillProjectListing===projectRoot,'pickFiles only adds files to the selection — it does not navigate the listing: '+stillProjectListing);
 assert(await chat.$eval('.cm-picker-error',node=>node.hidden),'successful native pick leaves no error');
 report.checks.push('选择文件… multiselect through the real handler: 2 project-external files join the selection (已选 3), listing stays in the project root — files only, nothing read yet');

 /* ---------- C. DIRECTORY entry browses; never attaches ---------- */
 await enqueue({filePaths:[externalDir],canceled:false});
 await realClick(chat,'.cm-picker .cm-browse','选择文件夹… (native directory browse)');
 const dirCall=await waitDialogCall('native pickDirectory call',entry=>entry.title==='选择引用文件所在目录');
 assert.deepEqual(dirCall.properties,['openDirectory'],'material.pickDirectory asks the OS chooser for one directory: '+JSON.stringify(dirCall));
 assert(dirCall.defaultPath===projectRoot,'pickDirectory forwards the current listing as defaultPath: '+JSON.stringify(dirCall));
 await until(async()=>(await chat.$eval('.cm-picker .cm-path',node=>node.value))===externalDir,'directory pick navigates the listing');
 assert.equal(await pickCount(),3,'browsing a directory adds NOTHING to the selection: '+await countText());
 assert((await chat.$('.cm-picker .cm-entry[data-path$="外部材料甲.md"]')),'browsed directory lists its files');
 assert((await chat.$('.cm-picker .cm-entry-dir[data-dir$="外部子目录"]')),'browsed directory lists sub-directories as rows');
 let persisted=(await chat.evaluate(()=>window.__composerMaterials?.snapshotPersist?.()));
 assert.equal(persisted?.pending?.length,0,'nothing is frozen by browsing (material refs stay empty)');
 // Sub-directory row: browsing entry point, still no bulk/recursive attach.
 await realClick(chat,'.cm-picker .cm-entry-dir[data-dir$="外部子目录"]','sub-directory row');
 await until(async()=>(await chat.$eval('.cm-picker .cm-path',node=>node.value))===externalSub,'sub-directory row navigates into it');
 assert.equal(await pickCount(),3,'entering a sub-directory adds nothing: '+await countText());
 assert((await chat.$('.cm-picker .cm-entry[data-path$="子目录内部.md"]')),'sub-directory contents are browsable');
 persisted=(await chat.evaluate(()=>window.__composerMaterials?.snapshotPersist?.()));
 assert.equal(persisted?.pending?.length,0,'browsing sub-directories freezes nothing');
 await realClick(chat,'.cm-picker .cm-up','返回上级目录');
 await until(async()=>(await chat.$eval('.cm-picker .cm-path',node=>node.value))===externalDir,'上级 returns to the browsed directory');
 report.checks.push('选择文件夹… is a browse entry only: real dialog call ["openDirectory"] with defaultPath, listing navigates (also via ▸ rows and 上级), selection count and frozen material refs stay untouched — no directory attach, no recursive bulk add');
 // Cancel leg for the directory chooser.
 const draftC=await draftNow();
const dirCallsBeforeCancel=(await dialogCalls()).filter(entry=>entry.title==='选择引用文件所在目录').length;
 await enqueue({canceled:true});
 await realClick(chat,'.cm-picker .cm-browse','选择文件夹… (cancel leg)');
await until(async()=>{const calls=(await dialogCalls()).filter(entry=>entry.title==='选择引用文件所在目录');return calls.length===dirCallsBeforeCancel+1?calls.at(-1):false;},'native pickDirectory cancel call');
await settleAfterNative('picker settles after the canceled native directory chooser');
assert(await pickerHidden()===false,'directory-chooser cancel keeps the picker open');
 assert((await chat.$eval('.cm-picker .cm-path',node=>node.value))===externalDir,'directory-chooser cancel keeps the current listing');
 assert.equal(await pickCount(),3,'directory-chooser cancel preserves the selection: '+await countText());
 assert(await chat.$eval('.cm-picker-error',node=>node.hidden),'the pre-chooser hint error is cleared after cancel');
 assert(await draftNow()===draftC,'directory-chooser cancel preserves the draft');
 report.checks.push('选择文件夹… cancel: listing/selection/draft preserved, pre-chooser hint cleared, focus returns to the path input');

 /* ---------- D. 取消 clears the native-originated selection; draft survives ---------- */
 const chipsBeforeCancel=await chipsNow();
 await realClick(chat,'.cm-picker .cm-cancel','取消');
 await until(()=>pickerHidden(),'取消 closes the picker');
 assert.deepEqual(await chipsNow(),chipsBeforeCancel,'取消 leaves confirmed materials untouched');
 assert(await draftNow()===draftA,'取消 preserves the chat draft');
 await openPicker();
 assert(/未选择/.test(await countText()),'取消 clears the unconfirmed (native-picked) selection: '+await countText());
 assert(await chat.$eval('.cm-picker .cm-confirm',node=>node.disabled),'引用 stays disabled with nothing selected');
 await escCloses('Esc after cancel-clears check');
 report.checks.push('取消 clears unconfirmed native-picked files while Esc preserves them (both keep draft and confirmed chips untouched)');

 /* ---------- E. confirm freezes actual bytes of native-selected files ---------- */
 await openPicker();
 await enqueue({filePaths:[extFileA,extFileB],canceled:false});
 await realClick(chat,'.cm-picker .cm-pick-files','选择文件… (freeze leg)');
 await until(async()=>(await pickCount())===2,'two external files selected for freeze');
 await realClick(chat,'.cm-picker .cm-entry[data-path$="材料-说明.md"]','project file for the same freeze');
 await until(async()=>(await pickCount())===3,'three files selected across project and external roots');
 const draftE=await draftNow();
 await realClick(chat,'.cm-picker .cm-confirm','引用所选文件');
 await until(()=>pickerHidden(),'confirm closes the picker');
 await until(async()=>{const chips=await chat.evaluate(()=>[...document.querySelectorAll('#compose-form .cm-chip .cm-chip-status')].map(node=>node.dataset.status));return chips.length===3&&chips.every(status=>status==='ok');},'three materials frozen ok');
 assert(await draftNow()===draftE,'confirming materials preserves the chat draft byte-for-byte');
 const active=await chat.evaluate(()=>document.activeElement===document.querySelector('.cm-add')?'add':document.activeElement&&document.activeElement.className||'body');
 assert(active==='add','confirm returns focus to the 引用文件 trigger, got '+active);
 const refs=await chat.evaluate(()=>(window.__composerMaterials?.snapshotPersist?.()||{pending:[]}).pending.map(entry=>({name:entry.name,relPath:entry.relPath||null,note:entry.note||null,source:entry.source,digest:entry.digest,instanceId:entry.instanceId,storage:entry.storage,size:entry.size})));
 assert.equal(refs.length,3,'exactly the three picked files are pending — no extras: '+JSON.stringify(refs.map(ref=>ref.name)));
 assert(refs.every(ref=>/^[a-f0-9]{64}$/.test(ref.digest||'')),'frozen material refs carry sha256 digests');
 const projectRef=refs.find(ref=>ref.name==='材料-说明.md');
 const externalRefs=refs.filter(ref=>ref.name==='外部材料甲.md'||ref.name==='外部材料乙.md');
 assert(projectRef?.relPath==='材料-说明.md','in-project pick keeps its project-relative path');
 assert(externalRefs.length===2&&externalRefs.every(ref=>!ref.relPath&&ref.note.includes('项目外')),'external picks are marked 项目外 with no relPath: '+JSON.stringify(externalRefs));
 assert(refs.every(ref=>!ref.name.includes('credentials')),'no credentials file appears among the frozen refs');
 // Frozen bytes: real material.read (host recovery store, digest-verified).
 const original={};
 for(const file of [extFileA,extFileB,projectDoc])original[file]=await fs.readFile(file);
 for(const ref of externalRefs.concat([projectRef])){
  const result=await raw(chat,'material.read',{projectId,instanceId:ref.instanceId,storage:ref.storage,source:ref.source,digest:ref.digest});
  assert(result.ok,'material.read for '+ref.name+': '+JSON.stringify(result.error));
  const bytes=Buffer.from(result.value.bytes,'base64');
  const sourceFile=ref.name==='材料-说明.md'?projectDoc:ref.name==='外部材料甲.md'?extFileA:extFileB;
  assert(bytes.equals(original[sourceFile]),'frozen bytes for '+ref.name+' are byte-identical to the picked file on disk ('+bytes.length+' bytes)');
 }
 report.checks.push('引用所选文件 froze 3 materials via real material.attachPath: digests present, in-project vs 项目外 noted, and material.read returns byte-identical content for every picked file');
// Freeze honesty: mutate one source; the frozen copy must not change.
await fs.writeFile(extFileA,MUTATED_A);
const refA=externalRefs.find(ref=>ref.name==='外部材料甲.md');
const reread=await raw(chat,'material.read',{projectId,instanceId:refA.instanceId,storage:refA.storage,source:refA.source,digest:refA.digest});
 assert(reread.ok,'material.read after mutation: '+JSON.stringify(reread.error));
 assert(Buffer.from(reread.value.bytes,'base64').equals(original[extFileA]),'frozen bytes ignore the on-disk mutation (digest copy, not a live reference)');
 assert(!(await fs.readFile(extFileA)).equals(original[extFileA]),'control: the source file really did change on disk');
 // Read-only viewer via an ordinary chip click.
 const chipHandles=await chat.$$('#compose-form .cm-chip-main');
 let chipA=null;
 for(const handle of chipHandles)if((await handle.evaluate(node=>node.title)).includes('外部材料甲'))chipA=handle;
 assert(chipA,'external frozen chip rendered');
 await realClickHandle(chipA,'external frozen chip 外部材料甲');
 await until(async()=>await chat.$eval('.material-viewer',node=>!node.hidden).catch(()=>false),'material viewer opens');
 await until(async()=>(await chat.$eval('.material-viewer .mv-body',node=>node.innerText).catch(()=>'')).includes(FROZEN_A.trim()),'viewer shows the frozen original bytes');
 const viewerText=await chat.$eval('.material-viewer .mv-body',node=>node.innerText);
 assert(!viewerText.includes(MUTATED_A.trim()),'viewer never shows post-freeze mutations');
 await shot('native-pick-frozen-viewer');
 await chat.keyboard.press('Escape');
 await until(async()=>await chat.$eval('.material-viewer',node=>node.hidden).catch(()=>false),'viewer closes on Esc');
 report.checks.push('freeze honesty: after mutating 外部材料甲.md on disk, material.read AND the read-only viewer still serve the original frozen bytes');
 assert(!refs.some(ref=>JSON.stringify(ref).includes(SECRET_MARKER)),'planted HOME credentials never appear in any material ref');

 /* ---------- F. send guard with path-select materials (exact current behavior) ---------- */
 await realClick(chat,'#composer','composer for guard leg');
 await chat.keyboard.down('Control');await chat.keyboard.press('Enter');await chat.keyboard.up('Control');
 await until(async()=>(await chat.$eval('#compose-status',node=>node.textContent)).includes('发送未发出'),'path-select materials block the send with an explicit reason');
 const guardStatus=await chat.$eval('#compose-status',node=>node.textContent);
 assert(/涂鸦|附件/.test(guardStatus),'send refusal names the unsupported attachments: '+guardStatus);
 assert.equal(report.modelRequests.length,0,'the refused send produced zero model requests');
 assert.equal((await chipsNow()).length,3,'refused send keeps all three frozen materials');
 assert(await draftNow()===draftE,'refused send keeps the draft');
 report.checks.push('exact current send contract: with path-select materials attached, Ctrl+Enter is refused (drawing-PNG-only guard), draft + materials preserved, zero requests — asserted as implemented, not redesigned');
 await until(async()=>await chat.$eval('#toast',node=>node.hidden),'send-refusal toast dismisses before picker hit-test matrix');

 /* ---------- G. responsive matrix for the bar (regression sentinel) ---------- */
 for(const [width,height,extra] of [[420,720,{}],[360,700,{}],[1280,800,{needInputFlex:true}]]){
  await call(shell,'session.resize',{width,height});
  await shell.waitForFunction((width,height)=>Math.abs(innerWidth-width)<=2&&Math.abs(innerHeight-height)<=2,{},width,height);
  await openPicker();
  await until(async()=>(await pickerGeometry())?.rows>=2,'listing renders at '+width+'x'+height);
  await chat.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await pause(250);
  const geometry=await assertPickerHonest('bar-'+width+'x'+height,extra);
  assert(!geometry.horizontalOverflow,'no horizontal document overflow at '+width+'x'+height);
  await shot('native-pick-bar-'+width+'x'+height);
  await escCloses('Esc after bar leg '+width+'x'+height);
  report.checks.push('picker bar honest at '+width+'x'+height+': no bar overflow, 上级/路径/选择文件…/选择文件夹… inside the panel and hit-test reachable, footer buttons reachable, only the list scrolls');
 }

 /* ---------- H. chips removed, one real send, credentials never on the wire ---------- */
 while(await chat.$('.cm-chip-x')){await (await chat.$('.cm-chip-x')).scrollIntoView();await realClick(chat,'.cm-chip-x','remove chip');await pause(80);}
 assert.equal((await chipsNow()).length,0,'all chips removed before the send leg');
 assert(await draftNow()===draftE,'chip removal preserves the draft');
 await realClick(chat,'#composer','composer for send');
 const requestsBefore=report.modelRequests.length;
 const jobsBefore=(await call(chat,'managed.status',{projectId})).state.jobs.length;
 await chat.keyboard.down('Control');await chat.keyboard.press('Enter');await chat.keyboard.up('Control');
 await until(async()=>{const value=await draftNow();return value==='';},'Ctrl+Enter really sends and clears the composer');
 await until(async()=>{const jobs=(await call(chat,'managed.status',{projectId})).state.jobs;return jobs.length===jobsBefore+1&&jobs.at(-1)?.status==='completed';},'scripted-model job completes');
 await until(async()=>await chat.$eval('#conversation',(node,marker)=>node.innerText.includes(marker),DRAFT_MARKER),'user message rendered');
 await until(async()=>await chat.$eval('#conversation',(node,marker)=>node.innerText.includes(marker),REPLY_MARKER),'scripted reply rendered');
 assert.equal(report.modelRequests.length,requestsBefore+1,'exactly one loopback model request for the single send');
 const sentBody=report.modelRequests.at(-1).body;
 assert(sentBody.includes(DRAFT_MARKER),'the real CLI request carries the typed draft text');
 assert(!sentBody.includes(SECRET_MARKER),'the planted HOME credentials never reach the model request');
 assert(!sentBody.includes(FROZEN_A.trim()),'frozen material bytes are not shipped after the guard refused them (current behavior)');
 report.checks.push('single scripted send over the real CLI transport: 1 recorded request carrying the draft, and neither the planted credentials nor material bytes appear on the wire');
 await shot('native-pick-send');
 assert.deepEqual(report.errors,[],'no renderer page errors across all surfaces');

 /* ---------- I. clean exit ---------- */
 const closeShell=await shell.evaluate(()=>nozeli.invoke('session.requestClose',{}));
 assert(closeShell.ok,'shell requestClose: '+JSON.stringify(closeShell.error));
 let exited=await Promise.race([exitPromise,pause(15000).then(()=>null)]);
 if(!exited){
  const quitOpen=await shell.$eval('#quit-choice',node=>node.open).catch(()=>false);
  if(quitOpen){await shell.click('#quit-cancel');exited=await Promise.race([exitPromise,pause(45000).then(()=>null)]);}
 }
 if(exited){assert.deepEqual(exited,{code:0,signal:null},'normal close must exit 0');report.normalExits.push({scene:'material-native-pick-close',...exited});report.checks.push('normal close exits 0');}
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
 report.dialogCalls=await dialogCalls();
 await browser?.disconnect().catch(()=>{});
 if(child&&child.exitCode===null&&!child.signalCode){report.cleanup={forced:true};child.kill('SIGTERM');const stopped=await Promise.race([exitPromise.then(()=>true),pause(5000).then(()=>false)]);if(!stopped){child.kill('SIGKILL');await exitPromise;report.cleanup.signal='SIGKILL';}else report.cleanup.signal='SIGTERM';}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 await fs.writeFile(path.join(out,'main.log'),log);
 console.log(JSON.stringify({ok:report.ok,root:out,mode:report.mode,checks:report.checks,scenes:report.scenes,dialogCalls:report.dialogCalls,modelRequests:report.modelRequests.length,normalExits:report.normalExits,errors:report.errors,notCovered:report.notCovered,failure:report.failure},null,2));
}
