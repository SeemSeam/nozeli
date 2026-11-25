// Windows native-content reading journey: real project pick through the visible
// shell, CDP-driven Unicode selection, local annotation with immutable frozen
// material, explicit editor save, an external winner keeping disk bytes, and
// unsaved-draft recovery across a full process restart. Gestures are VM/CDP
// mouse+keyboard input on real native Electron surfaces — not physical
// keyboard/IME or multi-display device proof. No provider init, no model calls.
// Optional deep-stall diagnosis (main-process inspector trace breakpoints) is
// OFF by default and enabled only via NOZELI_READING_DIAGNOSTIC=1.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {pathToFileURL} from 'node:url';
import {prepareReading} from './reading-setup.fixture.mjs';

const [requestedOutput,application,executable]=process.argv.slice(2);
assert.equal(process.platform,'win32');assert(requestedOutput&&path.isAbsolute(requestedOutput),'fresh absolute evidence directory required');
const root=path.resolve(application??path.join(import.meta.dirname,'..')),out=requestedOutput,packaged=Boolean(executable);await fs.mkdir(out);
const diagnostic=process.env.NOZELI_READING_DIAGNOSTIC==='1';
const {DesktopHost}=await import(pathToFileURL(path.join(root,'src/main/host.mjs')).href);
const configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop'),project=path.join(out,'project');
await fs.mkdir(project);
const original='# Reading lifecycle\n\nA physical selection 中文🧭é keeps this local note anchored.\n\nSecond paragraph stays readable.\n';
const savedText='Original editable text.\nSaved current UI edit.',draftText=savedText+'Unsent local reading draft',externalText=savedText+'\nExternal winner line.\n';
await fs.writeFile(path.join(project,'reading.md'),original);await fs.writeFile(path.join(project,'edit.txt'),'Original editable text.\n');
// Independent digest oracle: the annotation material must be the exact SHA-256
// CAS identity of the original bytes, computed without the application.
const expectedMaterialDigest=createHash('sha256').update(Buffer.from(original,'utf8')).digest('hex');
const checks=[],errors=[],runs=[];let child,browser,shell,page,exited,stage='',projectId,result,submitProbes=[],inspectorSend,inspectorSocket;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function mark(phase){runs.at(-1).phase=phase;await fs.writeFile(path.join(out,'progress.json'),JSON.stringify({phase,pid:child.pid},null,2)+'\n');}
async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;if(child&&child.exitCode!==null)throw Error('Electron exited before '+label+': '+(runs.at(-1)?.log??'').slice(-4000));await pause(80);}throw Error('Timed out: '+label);}
async function invoke(op,payload={},target=shell){const response=await target.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert.equal(response.ok,true,op+': '+JSON.stringify(response));return response.value;}
async function content(kind,relPath){return until(async()=>{for(const target of await browser.pages())if(await target.evaluate(({kind,relPath})=>window.__nozeliReady&&window.__workspaceScope?.kind===kind&&(!relPath||window.__workspaceScope.relPath===relPath),{kind,relPath}).catch(()=>false))return target;},kind+' '+(relPath||''));}
async function launch(){
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
 const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
 env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:configRoot,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_SHOT_DIR:out});
 // The inspector launch arg exists only in diagnostic mode; ordinary runs have
 // no debugger coupling at all.
 const diagnosticPort=diagnostic?await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});}):null;
 const command=executable??createRequire(import.meta.url)('electron'),args=[...(packaged?[]:[path.join(root,'src/main/main.cjs')]),...(diagnosticPort?['--inspect=127.0.0.1:'+diagnosticPort]:[])];
 child=spawn(command,args,{cwd:out,env,stdio:['ignore','pipe','pipe']});
 const run={pid:child.pid,command,args,systemOnlyPath:env.Path};if(diagnosticPort)run.inspectPort=diagnosticPort;run.log='';runs.push(run);
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>run.log+=chunk);
 exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});exited.catch(()=>{});
 await mark('connect-cdp');browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 await mark('find-shell');shell=await until(async()=>{for(const target of await browser.pages())if(await target.evaluate(()=>location.href.startsWith('http://127.0.0.1:')&&window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return target;},'visible shell');
 const observe=target=>target.on('pageerror',error=>errors.push(error.message));
 for(const target of await browser.pages())observe(target);
 browser.on('targetcreated',async target=>{const created=await target.page();if(created)observe(created);});
 // Deterministic setup-dialog dismissal (the dialog can re-show while its own
 // probe resolves) plus physical file-rail click installation.
 await prepareReading(shell);
 await mark('shell-window');await shell.bringToFront();await invoke('session.resize',{width:1440,height:900});
 if(diagnostic){
  // Opt-in stall diagnosis only (NOZELI_READING_DIAGNOSTIC=1): attach the
  // main-process Node inspector and place conditional TRACE breakpoints
  // (never pause) over shutdown/flush stages and the storage primitive chain
  // (readState→getLocal→localDirectory→privateDirectory→native directorySync→
  // db.request). The line numbers are source-text coupled; each breakpoint
  // must resolve or the run fails loudly instead of diagnosing silently.
  await mark('main-inspector');inspectorSocket?.close();inspectorSocket=null;inspectorSend=null;
  const mainInspector=await until(async()=>{try{return (await(await fetch('http://127.0.0.1:'+diagnosticPort+'/json/list')).json())[0]?.webSocketDebuggerUrl??null;}catch{return null;}},'main inspector endpoint');
  inspectorSocket=new WebSocket(mainInspector);
  await new Promise((resolve,reject)=>{inspectorSocket.addEventListener('open',resolve,{once:true});inspectorSocket.addEventListener('error',reject,{once:true});});
  {let serial=0;const pending=new Map();inspectorSocket.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.id){const entry=pending.get(message.id);pending.delete(message.id);message.error?entry.reject(Error(message.error.message)):entry.resolve(message.result);}});
   inspectorSend=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});inspectorSocket.send(JSON.stringify({id,method,params}));});}
  await inspectorSend('Debugger.enable');
  const placeBreakpoint=async(regex,line,condition)=>{
   // Modules may still parse late; a first send can register a pending
   // breakpoint with empty locations and a blind re-send collides with it.
   // Remove-then-replace until it resolves.
   let placed=null,breakpointId=null;
   for(let attempt=0;attempt<90;attempt++){
    if(breakpointId)await inspectorSend('Debugger.removeBreakpoint',{breakpointId}).catch(()=>{});
    placed=await inspectorSend('Debugger.setBreakpointByUrl',{urlRegex:regex,lineNumber:line-1,condition}).catch(error=>({error:String(error?.message??error)}));
    if(placed?.breakpointId)breakpointId=placed.breakpointId;
    if(Array.isArray(placed?.locations)&&placed.locations.length>0)break;
    await pause(1000);
   }
   assert.ok(Array.isArray(placed?.locations)&&placed.locations.length>0,'trace breakpoint did not resolve: '+regex+':'+line+' — source line numbers changed ('+(placed?.error??'no locations')+')');
   return placed;};
  for(const [regex,lines] of [['main/main[.]cjs$',[240,241,936,937,938,939,940,941,942,943,944,945,946,947,948,949,950,951,952,953]],['main/window-recovery[.]cjs$',[29,47,63,73,87,90,103]],['main/workspace-native[.]mjs$',[379,380,1141,1142,1156,1157]],['main/project-storage[.]mjs$',[20,21,46,214,217]],['platform/windows/desktop-project-storage[.]mjs$',[47]],['platform/windows/desktop-profile-directory[.]mjs$',[7,9]],['platform/windows/experimental-directories[.]mjs$',[27,40]],['main/storage-database[.]mjs$',[46,60]]])
   for(const line of lines)await placeBreakpoint(regex,line,'(console.error("TRACE:'+regex.split('/').at(-1)+':'+line+'"),false)');
  for(const line of [370,372,375,382,1513,1516])await placeBreakpoint('main/host[.]mjs$',line,'(console.error("TRACE:host:'+line+' a="+(this&&this.active)+" "+String(new Error().stack).split("\\n").slice(2,6).join(" ~ ")),false)');
  // Deterministic tracked read proves the breakpoints fire before the journey.
  await invoke('file.availability',{projectId,paths:['reading.md']}).catch(()=>{});
  await until(()=>runs.at(-1).log.includes('TRACE:host:'),'host trace breakpoints firing');
 }
 const windows=await invoke('workspace.windows.list');assert(windows.some(entry=>entry.visible));run.nativeWindows=windows;
 await mark('project-pick');
 if(projectId){await shell.waitForSelector('[data-project-id="'+projectId+'"]',{visible:true});await shell.click('[data-project-id="'+projectId+'"]');}
 else{
  // Never act before the native control is enabled and the window is shown.
  await shell.waitForFunction(()=>{const button=document.getElementById('pick-project');return button&&!button.disabled&&!button.hidden&&document.visibilityState==='visible';});
  await shell.evaluate(()=>{window.__readingInputTrace=[];for(const type of ['click','keydown'])document.addEventListener(type,event=>window.__readingInputTrace.push({type,target:event.target?.id||event.target?.tagName,trusted:event.isTrusted}),true);});
  await shell.click('#pick-project');
  // rootDisplay is a display path; identity is normalized, not string-equal.
  projectId=(await until(async()=>(await invoke('project.recent')).projects.find(row=>path.relative(row.rootDisplay,project)===''),'registered synthetic project via normalized root match')).id;
  const delivery=await shell.evaluate(()=>{const button=document.getElementById('pick-project');return {focused:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement?.id||document.activeElement?.tagName,appInert:document.getElementById('app')?.inert,blockedAncestor:button?.closest('[inert]')?.id||null,rect:button?.getBoundingClientRect().toJSON(),trace:window.__readingInputTrace};});
  await fs.writeFile(path.join(out,'input-delivery.json'),JSON.stringify(delivery,null,2)+'\n');
  assert(delivery.trace.some(entry=>entry.type==='click'&&entry.trusted===true&&entry.target==='pick-project'),'project pick must be a trusted click on the visible native control');
 }
 await shell.waitForFunction(id=>document.querySelector('#recent button[aria-current="true"]')?.dataset.projectId===id,{},projectId);
 assert.equal((await invoke('config.status')).initialized,false);
}
async function close(){
 // Diagnostic mode only: a still-attached Node inspector would hold the quit
 // ("Waiting for the debugger to disconnect..."); detach when the traced
 // shutdown sequence starts so a healthy close exits cleanly.
 let quitWatch=null;
 if(diagnostic){const run=runs.at(-1);
  quitWatch=setInterval(()=>{if(/TRACE:main\[.\]cjs\$:(9[3-5][0-9])|Waiting for the debugger/.test(run.log??'')){clearInterval(quitWatch);inspectorSocket?.close();inspectorSocket=null;inspectorSend=null;}},200);}
 try{
 await invoke('session.requestClose');const exit=await Promise.race([exited,pause(15000).then(()=>null)]);runs.at(-1).exit=exit;
 if(exit===null){
  // Stall evidence, no deadline change: main-process resources/handles via the
  // inspector (diagnostic mode) plus the trace tail naming the last executed
  // shutdown stage and any tracked host operation whose enter never exited.
  if(inspectorSend){const main=await Promise.race([inspectorSend('Runtime.evaluate',{expression:'JSON.stringify({resources:process.getActiveResourcesInfo(),handles:process._getActiveHandles().map(handle=>handle.constructor.name)})',returnByValue:true}).then(response=>{try{return JSON.parse(response?.result?.result?.value??'null');}catch{return response;}}),pause(5000).then(()=>({state:'main-inspector-timeout'}))]).catch(error=>({error:String(error.message)}));
   await fs.writeFile(path.join(out,'failure-main-probe.json'),JSON.stringify(main,null,2)).catch(()=>{});}
  if(diagnostic)await fs.writeFile(path.join(out,'failure-close-trace-tail.log'),(runs.at(-1).log??'').split('TRACE:').slice(-80).map(part=>'TRACE:'+part).join('')).catch(()=>{});
 }
 assert.deepEqual(exit,{code:0,signal:null},'app still alive 15s after session.requestClose; exit='+JSON.stringify(exit));await browser.disconnect();browser=null;
 }finally{clearInterval(quitWatch);}}
async function open(rel){await shell.click('#file-tree button[data-path="'+rel+'"]');page=await content('document',rel);await page.bringToFront();}
try{
 stage='visible project pick and native Markdown reading';await launch();await open('reading.md');
 await page.waitForSelector('#text-preview h1',{visible:true});assert.equal(await page.$eval('#text-preview h1',node=>node.textContent.trim()),'Reading lifecycle');
 await page.screenshot({path:path.join(out,'reading-markdown.png')});
 checks.push('real project pick through the enabled/visible native shell renders native Markdown without initializing any provider');
 stage='CDP Unicode selection and local annotation without dispatch';
 const points=await page.evaluate(()=>{const p=[...document.querySelectorAll('#text-preview p')].find(node=>node.textContent.startsWith('A physical'));p.scrollIntoView({block:'center'});const walker=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())&&!node.textContent.includes('physical selection')){}if(!node)throw Error('Selection text not rendered');const start=node.textContent.indexOf('physical selection'),range=document.createRange();range.setStart(node,start);range.setEnd(node,start+'physical selection'.length);const box=range.getBoundingClientRect();return{x:box.left+.2,y:box.top+box.height/2,end:box.right-.2};});
 await page.mouse.move(points.x,points.y);await page.mouse.down();await page.mouse.move(points.end,points.y,{steps:12});await page.mouse.up();
 await page.waitForSelector('#selection-menu:not([hidden])',{visible:true});
 const quote='physical selection 中文🧭é',initial=await page.evaluate(()=>getSelection().toString());assert(initial.length>0&&quote.startsWith(initial),'CDP mouse drag must select real rendered text');
 await page.keyboard.down('Shift');for(let count=0;count<quote.length&&await page.evaluate(()=>getSelection().toString())!==quote;count++){await page.keyboard.press('ArrowRight');assert(quote.startsWith(await page.evaluate(()=>getSelection().toString())));}await page.keyboard.up('Shift');
 assert.equal(await page.evaluate(()=>getSelection().toString()),quote);
 await page.waitForFunction(()=>{const button=document.getElementById('selection-note');return button&&!button.disabled&&!button.hidden&&document.visibilityState==='visible';});
 await page.click('#selection-note');await page.waitForSelector('#note-form:not([hidden])',{visible:true});await page.type('#note-input','Current anchored local note');
 // The anchored note form floats at the selection; wait until it is stationary
 // across animation frames so the trusted click cannot target stale coordinates.
 await page.waitForFunction(()=>new Promise(resolve=>{const form=document.getElementById('note-form');if(form.hidden)return resolve(false);const first=form.getBoundingClientRect().toJSON();requestAnimationFrame(()=>resolve(JSON.stringify(first)===JSON.stringify(form.getBoundingClientRect().toJSON())));}));
 // Submit policy: exactly ONE explicit user click on the native 保存备注
 // button; never resubmit — the original pending submit may still commit, so
 // a second click is an unknown-effect replay. The click must complete or the
 // run fails with classified diagnostics. Bounded in-page probes classify:
 // annotation.list timing out means project IPC is stuck; config.status
 // timing out means the whole invoke channel is stuck; both resolving while
 // the ledger stays empty and the form stays open means the single submit is
 // still pending — its eventual effect is unknown and is NOT inferred from
 // these healthy unrelated calls (earlier instrumentation proved the submit
 // task does enter). Deeper failure probes (renderer CPU profile, main
 // responsiveness) exist only in diagnostic mode.
 const probes=submitProbes=[];
 await page.click('#add-note');
 await until(async()=>{
  if(await Promise.race([page.evaluate(()=>document.getElementById('note-form').hidden),new Promise(resolve=>setTimeout(()=>resolve(undefined),5000))]).catch(()=>false))return true;
  const probe=await Promise.race([page.evaluate(async projectId=>{
   const race=promise=>Promise.race([Promise.resolve(promise).then(value=>({state:'resolved',ok:value?.ok===true,value:value?.ok?value.value??null:null}),()=>({state:'resolved',ok:false})),new Promise(resolve=>setTimeout(()=>resolve({state:'timeout'}),2000))]);
   const annotations=await race(window.nozeli.invoke('annotation.list',{projectId,relPath:'reading.md'}));
   const config=await race(window.nozeli.invoke('config.status',{}));
   return {annotations,config};
  },projectId),new Promise(resolve=>setTimeout(()=>resolve({state:'driver-timeout'}),8000))]).catch(error=>({evaluateError:String(error.message)}));
  probes.push({at:Date.now(),...probe});
  return Boolean(probe.annotations?.state==='resolved'&&probe.annotations.ok&&probe.annotations.value?.annotations?.some(row=>row.note==='Current anchored local note'));
 },'single explicit 保存备注 submit persists the local note',15000);
 // The note projection does not stay inside #text-preview: root.append is
 // transient and the async mountLocalWindow reparents the card into a
 // floating section.local-window.tag-note layer under #documents. Wait for
 // the durable in-text marker plus the actually mounted, visible card.
 await page.waitForSelector('#text-preview .note-anchor .note-index',{visible:true});
 await page.waitForSelector('.local-window.tag-note[data-annotation] .note-projection',{visible:true});
 await page.waitForFunction(()=>[...document.querySelectorAll('.local-window.tag-note .note-projection-content')].some(node=>node.textContent.includes('Current anchored local note')));
 const annotations=(await invoke('annotation.list',{projectId,relPath:'reading.md'},page)).annotations;
 assert.equal(annotations.length,1);const note=annotations[0];
 assert.equal(note.note,'Current anchored local note');assert.equal(note.relPath,'reading.md');
 assert.deepEqual(note.anchor,{start:original.indexOf(quote),end:original.indexOf(quote)+quote.length,quote});
 assert.equal(note.materialDigest,expectedMaterialDigest);
 const inspector=new DesktopHost(profile);try{assert.equal((await inspector.storage.readObject(projectId,note.materialDigest)).toString(),original);}finally{await inspector.storage.db.close();}
 assert.equal(await fs.readFile(path.join(project,'reading.md'),'utf8'),original);
 assert.equal((await invoke('managed.status',{projectId})).state?.jobs?.length??0,0);
 assert.equal((await invoke('config.status')).initialized,false);
 await page.screenshot({path:path.join(out,'reading-annotation.png')});
 checks.push('CDP mouse+Shift+Arrow Unicode selection anchors a local note at exact source offsets with immutable material (digest+profile verified), saved locally without dispatching model work');
 stage='native editor typing and explicit save';await open('edit.txt');
 await page.waitForSelector('#text-host .cm-content',{visible:true});await page.click('#text-host .cm-content');
 await page.waitForFunction(()=>document.hasFocus()&&document.activeElement?.closest('#text-host .cm-editor'));
 await page.keyboard.down('Control');await page.keyboard.press('End');await page.keyboard.up('Control');
 await page.keyboard.type('Saved current UI edit.');
 await page.keyboard.down('Control');await page.keyboard.press('s');await page.keyboard.up('Control');
 await until(async()=>{try{return (await fs.readFile(path.join(project,'edit.txt'),'utf8'))===savedText;}catch{}},'explicit save reaches the source file');
 // Publication precedes the renderer's save receipt. The shared save loop may
 // absorb input typed before that receipt; start the next unsaved phase only
 // after the actual UI confirms the preceding explicit save has settled.
 await page.waitForFunction(()=>document.querySelector('#save-status')?.dataset.state==='saved');
 assert.equal(await page.$eval('#save-failure',node=>node.hidden),true);
 await page.screenshot({path:path.join(out,'reading-editor-saved.png')});
 checks.push('real native editor typing and explicit Ctrl+S write exact source bytes (independent file oracle), with the renderer save receipt settled before the next unsaved phase');
 stage='unsaved draft retained by normal close';
 await page.bringToFront();
 await page.evaluate(()=>window.__nozeliInput.focus());
 await page.waitForFunction(()=>document.hasFocus()&&document.activeElement?.closest('#text-host .cm-editor'));
 await page.keyboard.down('Control');await page.keyboard.press('End');await page.keyboard.up('Control');
 await page.keyboard.type('Unsent local reading draft');
 await page.waitForFunction(text=>window.__nozeliInput.text()===text,{},draftText);
 await close();checks.push('normal close with an exact unsaved draft exits cleanly (code 0)');
 stage='external winner keeps disk bytes and retains the draft';
 await fs.writeFile(path.join(project,'edit.txt'),externalText);
 await launch();
 let retained=null,cursor=null;
 do{const recovery=await invoke('workspace.recovery.list',{cursor});
  for(const row of recovery.entries){if(row.project.id!==projectId||row.value.relPath!=='edit.txt')continue;
   const detail=await invoke('workspace.recovery.detail',{projectId,id:row.id,revision:row.revision,version:row.version});
   if(detail.value.candidate?.text===draftText){retained=row;break;}}
  cursor=recovery.nextCursor;}while(cursor&&!retained);
 assert(retained,'exact unsaved draft bytes must remain discoverable in the bounded recovery ledger');
 await open('edit.txt');
 await page.waitForSelector('#text-host .cm-content',{visible:true});
 await page.waitForFunction(()=>document.querySelector('#save-status')?.dataset.state==='conflict');
 assert.equal(await page.$eval('#save-failure',node=>node.hidden),false);
 assert.match(await page.$eval('#save-error',node=>node.textContent),/原文件已被其他操作修改/);
 assert.match(await page.$eval('#save-error-detail pre',node=>node.textContent),/CONFLICT/);
 await page.waitForFunction(text=>window.__nozeliInput?.text?.()===text,{},draftText);
 assert.equal(await fs.readFile(path.join(project,'edit.txt'),'utf8'),externalText);
 await page.screenshot({path:path.join(out,'reading-external-winner.png')});
 checks.push('an external writer wins the source: reopen exposes the native CONFLICT banner, keeps the exact unsaved draft editable, and never silently writes it over the external bytes');
 stage='cold reopen restores the annotation and immutable material';await open('reading.md');
 await page.waitForSelector('#text-preview .note-anchor .note-index',{visible:true});
 await page.waitForSelector('.local-window.tag-note[data-annotation] .note-projection',{visible:true});
 await page.waitForFunction(()=>[...document.querySelectorAll('.local-window.tag-note .note-projection-content')].some(node=>node.textContent.includes('Current anchored local note')));
 const restored=(await invoke('annotation.list',{projectId,relPath:'reading.md'},page)).annotations;
 assert.equal(restored.length,1);assert.equal(restored[0].id,note.id);
 assert.deepEqual(restored[0].anchor,note.anchor);assert.equal(restored[0].materialDigest,note.materialDigest);
 const coldInspector=new DesktopHost(profile);try{assert.equal((await coldInspector.storage.readObject(projectId,restored[0].materialDigest)).toString(),original);}finally{await coldInspector.storage.db.close();}
 assert.equal(await fs.readFile(path.join(project,'reading.md'),'utf8'),original);
 await page.screenshot({path:path.join(out,'reading-current.png')});
 checks.push('full process restart restores the untouched annotation anchor and frozen original material byte-for-byte (independent profile digest oracle)');
 assert.deepEqual(errors,[]);await close();
 assert.equal(await fs.readFile(path.join(project,'edit.txt'),'utf8'),externalText);
 checks.push('final normal close still retains the conflicted draft without overwriting the external winner');
 result={ok:true,packaged,application:root,projectId,checks,errors,runs,out,inputScope:'Visible real native Electron reading/editor surfaces driven by VM/CDP mouse and keyboard gestures; not physical keyboard/IME or multi-display device proof'};
}catch(error){
 const pages=[];for(const target of await browser?.pages()??[])pages.push(await target.evaluate(()=>({scope:window.__workspaceScope,text:document.body.innerText.slice(-12000),dialogs:[...document.querySelectorAll('dialog')].map(dialog=>({id:dialog.id,open:dialog.open,text:dialog.innerText})),reading:{noteFormHidden:document.getElementById('note-form')?.hidden??null,noteValue:document.getElementById('note-input')?.value??null,addNoteDisabled:document.getElementById('add-note')?.disabled??null,addNoteHidden:document.getElementById('add-note')?.hidden??null,activeElement:(document.activeElement?.id||document.activeElement?.tagName)??null,saveStatus:document.querySelector('#save-status')?.dataset.state??null,saveStatusText:document.querySelector('#save-status')?.textContent??null,saveFailureHidden:document.getElementById('save-failure')?.hidden??null,saveError:document.getElementById('save-error')?.textContent??null,toast:document.getElementById('toast')?.textContent??null,toastHidden:document.getElementById('toast')?.hidden??null,textHostInert:document.getElementById('text-host')?.inert??null,noteAnchors:document.querySelectorAll('.note-anchor').length,localWindows:document.querySelectorAll('.local-window').length,selection:String(getSelection())}})).catch(cause=>({error:cause.message})));
 await fs.writeFile(path.join(out,'failure-pages.json'),JSON.stringify(pages,null,2));
 await shell?.screenshot({path:path.join(out,'failure-shell.png')}).catch(()=>{});
 await Promise.race([page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{}),pause(2000)]);
 // Diagnostic mode adds deep stall evidence: renderer CPU profile of the last
 // surface and a main-process responsiveness probe (in Electron the browser
 // process IS the main process; an evaluate that never returns means its event
 // loop is blocked). Both record their own failures.
 if(diagnostic){
  try{const session=await page.createCDPSession();await session.send('Profiler.enable');await session.send('Profiler.setSamplingInterval',{interval:1000});await session.send('Profiler.start');await pause(1500);const {profile}=await session.send('Profiler.stop');await fs.writeFile(path.join(out,'failure-renderer-profile.json'),JSON.stringify(profile));await session.detach();}catch(cause){await fs.writeFile(path.join(out,'failure-renderer-profile.json'),JSON.stringify({error:String(cause?.message??cause)})).catch(()=>{});}
  try{const target=browser?.target?.();if(!target)throw Error('no browser target on connected browser');const session=await target.createCDPSession();const main=await Promise.race([session.send('Runtime.evaluate',{expression:'({electron:process.versions.electron,node:process.versions.node,activeResources:process.getActiveResourcesInfo().slice(0,40)})',returnByValue:true}).then(response=>response?.result?.result?.value??response??{state:'unreadable'}),new Promise(resolve=>setTimeout(()=>resolve({state:'main-thread-timeout'}),5000))]);await fs.writeFile(path.join(out,'failure-main-probe.json'),JSON.stringify(main,null,2));await session.detach();}catch(cause){await fs.writeFile(path.join(out,'failure-main-probe.json'),JSON.stringify({error:String(cause?.message??cause)})).catch(()=>{});}
 }
 if(submitProbes.length)await fs.writeFile(path.join(out,'failure-submit-probes.json'),JSON.stringify(submitProbes,null,2)).catch(()=>{});
 result={ok:false,stage,error:error.stack,checks,errors,runs,projectId,expectedProject:project,packaged,application:root,diagnostic};process.exitCode=1;
}finally{
 inspectorSocket?.close();
 await browser?.disconnect();
 if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 for(let index=0;index<runs.length;index++){await fs.writeFile(path.join(out,'main-'+(index+1)+'.log'),runs[index].log??'');delete runs[index].log;}
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({ok:result.ok,stage:result.stage??null,checks,out}));
}
