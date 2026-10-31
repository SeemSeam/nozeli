// Explicit isolated real Electron geometry smoke; no personal profile or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
import {innerViewportMetrics} from './geometry-inner.fixture.mjs';
const source=path.resolve(import.meta.dirname,'..'),appRoot=path.resolve(process.env.NOZELI_TEST_APP_ROOT||source),binary=process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron');
const {DesktopHost}=await import(pathToFileURL(path.join(appRoot,'src/main/host.mjs')));
const evidence=path.resolve(process.env.NOZELI_TEST_EVIDENCE_ROOT||path.join(os.homedir(),'.cache/nozeli-smokes'));await fs.mkdir(evidence,{recursive:true});
const out=await fs.mkdtemp(path.join(evidence,'dynamic-geometry-live-')),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),root=path.join(out,'project');await fs.mkdir(root);
const fixtures=[['word.docx','office/中文 文档.docx'],['sheet.xlsx','office/中文 表格.xlsx'],['slides.pptx','ppt/compatibility.pptx'],['paper.pdf','pdf/nozeli-sample.zh.pdf'],['image.png','tex/pipeline.png']];
for(const [name,fixture]of fixtures)await fs.copyFile(path.join(source,'tests/fixtures',fixture),path.join(root,name));
const wordSourceBytes=await fs.readFile(path.join(root,'word.docx'));
const officeSourceBytes=new Map(await Promise.all(fixtures.map(async([name])=>[name,await fs.readFile(path.join(root,name))])));
await fs.writeFile(path.join(root,'reading.md'),'# Dynamic Markdown\n\n'+Array.from({length:100},(_,i)=>`Paragraph ${i}: resizing must preserve source and ownership.\n\n`).join(''));
await fs.writeFile(path.join(root,'code.py'),'# Dynamic code\n'+Array.from({length:200},(_,i)=>`value_${i} = ${i}\n`).join(''));
const host=new DesktopHost(profile),project=(await host.pick(root)).project;
const result={ok:false,out,checks:[],matrix:[],errors:[]};let child,browser,shell,log='',exited;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let settling=null;
async function until(fn,label,ms=45000){
 const end=Date.now()+ms;while(Date.now()<end){if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('App exited '+log);const v=await fn();if(v)return v;await pause(80);}
 result.settleFailure={label,requested:settling,pages:[]};
 if(browser)for(const page of await browser.pages()){
  const data=await page.evaluate(()=>({url:location.href,ready:window.__nozeliReady,scope:window.__workspaceScope,viewport:{width:innerWidth,height:innerHeight},panes:[...document.querySelectorAll('[data-view-id]')].map(node=>{const rect=node.getBoundingClientRect();return {viewId:node.dataset.viewId,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};}),dialogs:[...document.querySelectorAll('dialog[open]')].map(node=>({id:node.id,text:node.innerText.slice(0,300)}))})).catch(error=>({error:error.message}));
  if(['shell','detached'].includes(data.scope?.role))data.nativeState=await nativeState(page).catch(error=>({error:error.message}));
  result.settleFailure.pages.push(data);
 }
 throw Error('Timeout '+label+'; native settle diagnostics recorded in result.settleFailure');
}
async function call(page,op,payload={}){const r=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
async function findPage(predicate,label){return until(async()=>{for(const page of await browser.pages())if(await page.evaluate(predicate).catch(()=>false))return page;},label);}
async function nativeState(page){return call(page,'workspace.control',{type:'window-control',action:'state'});}
async function innerGeometry(owner,label){
 return until(async()=>{
  const metrics=await owner.evaluate(innerViewportMetrics);result.lastInnerGeometry={label,...metrics};
  if(!metrics.valid)return false;
  result.matrix.push({label:label+' inner',...metrics});return metrics;
 },'format inner viewport '+label);
}
async function geometry(chrome,owner,viewId,label){
 settling={label,viewId,chromeWindowId:await chrome.evaluate(()=>__workspaceScope.windowId),ownerWindowId:await owner.evaluate(()=>__workspaceScope.windowId),phase:'pane-geometry'};
 const actual=await until(async()=>{
  const expected=await chrome.evaluate(id=>{const n=document.querySelector('[data-view-id="'+CSS.escape(id)+'"]');if(!n)return null;const b=n.getBoundingClientRect();return {width:b.width,height:b.height};},viewId);
  const actual=await owner.evaluate(()=>({width:innerWidth,height:innerHeight,ready:window.__nozeliReady,scope:__workspaceScope,reader:document.querySelector('#reader')?.getBoundingClientRect().width}));
  if(!expected||Math.abs(expected.width-actual.width)>2||Math.abs(expected.height-actual.height)>2)return false;
  assert(actual.ready);assert(actual.reader>actual.width-3,'Reader must use the guest viewport');result.matrix.push({label,expected,actual:{width:actual.width,height:actual.height}});return actual;
 },'native guest tracks pane '+label);
 await innerGeometry(owner,label);return actual;
}
async function transitions(chrome,owner,viewId,label){
 const control=(action,extra={})=>call(chrome,'workspace.control',{type:'window-control',action,...extra});
 const limits=await nativeState(chrome),maxWidth=Math.max(320,limits.workArea.width-64),maxHeight=Math.max(240,limits.workArea.height-64);
 for(const [desiredWidth,desiredHeight]of [[960,720],[1420,960],[1080,780]]){
  const width=Math.min(desiredWidth,maxWidth),height=Math.min(desiredHeight,maxHeight),before=await nativeState(chrome);
  settling={label,viewId,chromeWindowId:await chrome.evaluate(()=>__workspaceScope.windowId),ownerWindowId:await owner.evaluate(()=>__workspaceScope.windowId),phase:'native-resize',desired:{width:desiredWidth,height:desiredHeight},requested:{width,height},workArea:limits.workArea};
  await control('resize',{width,height});let previous=null,stable=0;
  const settled=await until(async()=>{
   const state=await nativeState(chrome),viewport=await chrome.evaluate(()=>({width:innerWidth,height:innerHeight})),native=state.contentSize,zoom=state.chromeZoomFactor;
   settling.actual={state,viewport};
   const follows=Math.abs(viewport.width*zoom-native.width)<=2&&Math.abs(viewport.height*zoom-native.height)<=2;
   const admitted=(actual,requested,limit)=>Math.abs(actual-requested)<=2||actual<=requested&&actual>=limit-64;
   const matches=admitted(native.width,width,state.workArea.width)&&admitted(native.height,height,state.workArea.height);
   const key=JSON.stringify([native,viewport,state.bounds.windowState]);stable=follows&&matches&&key===previous?stable+1:0;previous=key;
   return stable>=2?{state,viewport}:false;
  },'native resize '+label);
  result.matrix.push({label:label+' native resize',desired:{width:desiredWidth,height:desiredHeight},requested:{width,height},before:before.contentSize,...settled});
  await geometry(chrome,owner,viewId,label+` ${width}x${height}`);
 }
 await control('maximize');await until(async()=>(await nativeState(chrome)).bounds.windowState==='maximized','native maximize '+label);await geometry(chrome,owner,viewId,label+' maximized');
 await control('maximize');await until(async()=>(await nativeState(chrome)).bounds.windowState==='normal','native unmaximize '+label);await geometry(chrome,owner,viewId,label+' restored');
 await control('fullscreen',{enabled:true});await until(async()=>(await nativeState(chrome)).bounds.windowState==='fullscreen','native fullscreen '+label);await geometry(chrome,owner,viewId,label+' fullscreen');
 await control('fullscreen',{enabled:false});await until(async()=>(await nativeState(chrome)).bounds.windowState==='normal','native leave fullscreen '+label);await geometry(chrome,owner,viewId,label+' leave-fullscreen');
}
try{
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
 const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
 Object.assign(env,{HOME:path.join(out,'home'),XDG_CONFIG_HOME:path.join(out,'home/.config'),NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});await fs.mkdir(env.HOME,{recursive:true});
 child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(appRoot,'src/main/main.cjs')]),'--ozone-platform=x11'],{cwd:out,env,stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await findPage(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell','shell');if(await shell.$eval('#configuration-setup',n=>n.open))await shell.click('#configuration-cancel');
 await shell.click('#recent [data-project-id="'+project.id+'"]');await shell.waitForFunction(id=>__workspaceGroups?.snapshot()?.projectId===id,{},project.id);
 for(const rel of ['word.docx','paper.pdf','image.png','reading.md','code.py','sheet.xlsx','slides.pptx']){
  await shell.evaluate(rel=>__workspaceGroups.open({kind:'document',relPath:rel}),rel);
  const owner=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(rel=>window.__nozeliReady&&__workspaceScope?.relPath===rel,rel).catch(()=>false))return p;},'ready '+rel);owner.on('pageerror',e=>result.errors.push(rel+': '+e.message));
  const viewId=await owner.evaluate(()=>{window.__geometryOwner=__workspaceScope;return __workspaceScope.viewId;});
  const word=rel.endsWith('.docx')?owner.frames().find(f=>f.url().endsWith('/word-frame.html')):null;
  if(word){
   // activeEditor exists during import; its initial empty PM document is not a
   // business-ready baseline. Require the complete fixture and its last page.
   await word.waitForFunction(()=>{
    const editor=window.nozeliWordEditor?.activeEditor;if(!editor)return false;
    const text=editor.state.doc.textContent,rendered=document.querySelector('#document')?.textContent||'';
    const expected=['Office 编辑验证：原始首句。','中文结构与保存检查','未修改标记：表格、图片、脚注、公式和页眉页脚应保留。','项目','数值','中文样例','42','校验标记','保持原样','含脚注的段落','第二页：未修改内容。'];
    if(!expected.every(value=>text.includes(value)&&rendered.includes(value)))return false;
    if(document.querySelectorAll('.superdoc-page').length<2)return false;
    try{if(!window.nozeliWordModels.getText().includes(expected.at(-1)))return false;}catch{return false;}
    return [...document.querySelectorAll('#document img')].every(image=>image.complete&&image.naturalWidth>0);
   },{timeout:45000});
   await word.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
   await word.evaluate(()=>{
    window.__geometryEditor=nozeliWordEditor.activeEditor;
    let range;__geometryEditor.state.doc.descendants((node,pos)=>{if(node.isText){const at=node.text.indexOf('原始首句');if(at>=0)range={from:pos+at,to:pos+at+4};}});
    if(!range)throw Error('Complete Word fixture selection missing');
    __geometryEditor.commands.setTextSelection(range);
    window.__geometryModel=JSON.stringify(__geometryEditor.state.doc.toJSON());window.__geometrySelection=JSON.stringify(__geometryEditor.state.selection.toJSON());window.__geometryTransactions=[];window.__geometryDocumentChanges=0;
    __geometryEditor.on('transaction',event=>{const tr=event.transaction;if(tr.docChanged)__geometryDocumentChanges++;if(__geometryTransactions.length<100)__geometryTransactions.push({docChanged:tr.docChanged,selectionSet:tr.selectionSet,selection:tr.selection.toJSON(),meta:Object.keys(tr.meta||{}),steps:tr.steps.map(step=>step.toJSON())});});
    nozeliWordEditor.setZoom(161);
   });
  }
  if(rel==='code.py')await owner.evaluate(()=>{__nozeliInput.focus();__nozeliInput.insert('UNSAVED_GEOMETRY\n');window.__geometryDraft=__nozeliInput.text();});
  if(rel==='reading.md'){await call(shell,'workspace.control',{type:'content-command',projectId:project.id,viewId,command:'text-mode'});await owner.waitForSelector('#markdown-preview-scroll:not([hidden])');}
  if(rel==='code.py')await owner.evaluate(()=>__nozeliInput.select(0,12));
  if(rel==='image.png')await call(shell,'workspace.control',{type:'content-command',projectId:project.id,viewId,command:'actual'});
  await innerGeometry(owner,rel+' initial');
  await transitions(shell,owner,viewId,rel+' main');
  if(word){assert.equal(await word.evaluate(()=>nozeliWordEditor.getZoom()),161,'manual Word zoom survives resize');await call(shell,'workspace.control',{type:'content-command',projectId:project.id,viewId,command:'fit'});await word.waitForFunction(()=>nozeliWordEditor.getZoomState().mode==='fit-width');}
  if(rel==='image.png')await call(shell,'workspace.control',{type:'content-command',projectId:project.id,viewId,command:'fit'});
  await shell.evaluate(viewId=>__workspaceGroups.command({type:'floatOpen',viewId}),viewId);
  const ownerWindowId=await until(()=>owner.evaluate(()=>__workspaceScope.windowId!=='main'&&__workspaceScope.windowId),'owner detached window identity '+rel);
  const detached=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(windowId=>window.__nozeliReady&&window.__workspaceScope?.role==='detached'&&__workspaceScope.windowId===windowId,ownerWindowId).catch(()=>false))return page;},'detached chrome for '+rel+' '+ownerWindowId);
  result.matrix.push({label:rel+' detached target',ownerWindowId,chromeWindowId:await detached.evaluate(()=>__workspaceScope.windowId)});
  await transitions(detached,owner,viewId,rel+' detached');
  assert(await owner.evaluate(()=>__workspaceScope===__geometryOwner),'Native resizing must not replace source owner');
  if(word){
   const state=await word.evaluate(()=>({same:nozeliWordEditor.activeEditor===__geometryEditor,content:JSON.stringify(nozeliWordEditor.activeEditor.state.doc.toJSON().content)===JSON.stringify(JSON.parse(__geometryModel).content),documentChanges:__geometryDocumentChanges,selection:JSON.stringify(nozeliWordEditor.activeEditor.state.selection.toJSON())===__geometrySelection,expectedModel:JSON.parse(__geometryModel),actualModel:nozeliWordEditor.activeEditor.state.doc.toJSON(),expectedSelection:JSON.parse(__geometrySelection),actualSelection:nozeliWordEditor.activeEditor.state.selection.toJSON(),transactions:__geometryTransactions,zoom:nozeliWordEditor.getZoomState(),metrics:nozeliWordEditor.getViewportMetrics(),width:document.querySelector('#toolbar').getBoundingClientRect().width,viewport:innerWidth}));
   result.wordPreservation=state;
   // Root OOXML section metadata is lazily serialized by the vendor during
   // transfer. The formatted PM content, caret and source bytes must be exact.
   state.sourceBytesUnchanged=wordSourceBytes.equals(await fs.readFile(path.join(root,'word.docx')));
   assert(state.same&&state.content&&state.documentChanges===0&&state.selection&&state.sourceBytesUnchanged,'Word formatted content/caret/source retained: '+JSON.stringify({same:state.same,content:state.content,documentChanges:state.documentChanges,selection:state.selection,sourceBytesUnchanged:state.sourceBytesUnchanged,expectedSelection:state.expectedSelection,actualSelection:state.actualSelection}));
   assert.equal(state.zoom.mode,'fit-width');assert(Math.abs(state.width-state.viewport)<20,'Word chrome spans current viewport');assert(Math.abs(state.zoom.value-Math.max(25,Math.min(200,state.metrics.fitZoom)))<=1,'Fit recomputes from current viewport metrics');
  }
  if(rel==='code.py')assert(await owner.evaluate(()=>__nozeliInput.text()===__geometryDraft),'Exact unsaved code draft retained');
  const detachedWindowId=await detached.evaluate(()=>__workspaceScope.windowId);
  await shell.evaluate(windowId=>__workspaceGroups.command({type:'dock',windowId}),detachedWindowId);await geometry(shell,owner,viewId,rel+' redocked');
  if(officeSourceBytes.has(rel))assert.deepEqual(await fs.readFile(path.join(root,rel)),officeSourceBytes.get(rel),rel+': resize must preserve exact source bytes');
  await owner.screenshot({path:path.join(out,rel+'.png')});result.checks.push(rel+': native resize/maximize/fullscreen/restore in main and detached; same source owner after dock');
 }
 assert.deepEqual(result.errors,[]);await call(shell,'session.requestClose');result.exit=await Promise.race([exited,pause(20000).then(()=>null)]);assert.deepEqual(result.exit,{code:0,signal:null});result.ok=true;
}catch(error){result.failure=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await browser?.disconnect().catch(()=>{});if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(2000)]);if(child.exitCode===null){child.kill('SIGKILL');await exited;}}await host.storage.db.close();await fs.writeFile(path.join(out,'electron.log'),log);await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({ok:result.ok,out,checks:result.checks,failure:result.failure}));}
