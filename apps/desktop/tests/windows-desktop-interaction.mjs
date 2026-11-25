// Real Windows Electron surfaces, keyboard clipboard, transfer and recovery.
// Synthetic composition exercises guards only; it is not physical IME proof.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {installFileTreeClicks} from './file-tree-clicks.fixture.mjs';

const [out,application,executable,python]=process.argv.slice(2);
assert.equal(process.platform,'win32');
assert(out&&path.isAbsolute(out),'fresh absolute output directory required');
assert(python&&path.isAbsolute(python),'explicit Python 3 interpreter required for the independent Win32 oracle');
const root=path.resolve(application||path.join(import.meta.dirname,'..')),packaged=Boolean(executable);
await fs.mkdir(out);
const project=path.join(out,'project'),configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop');
await fs.mkdir(project);
const nonce=randomUUID(),text=nonce+' Clipboard 中文🧭é\nSecond line',second='Independent second editor.\n';
await fs.writeFile(path.join(project,'first.txt'),text);await fs.writeFile(path.join(project,'second.txt'),second);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const checks=[],errors=[],runs=[],clipboardProofs=[];
let child,browser,shell,doc,exited,projectId,log='',stage='',oracle,oracleExit,clipboardRestoration,oracleLog='';
let oraclePending;
async function oracleCall(request){
 assert(!oraclePending,'one oracle request at a time');
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{oraclePending=null;reject(Error('Win32 oracle timeout'));},6000);
  oraclePending={resolve:value=>{clearTimeout(timer);oraclePending=null;value.ok?resolve(value):reject(Error(value.error));},reject};
  oracle.stdin.write(JSON.stringify(request)+'\n');
 });
}
async function oracleStart(){
 oracle=spawn(python,[path.join(root,'tests/fixtures/windows-clipboard-oracle.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 oracle.stderr.on('data',chunk=>oracleLog+=chunk);
 oracleExit=new Promise(resolve=>oracle.once('exit',(code,signal)=>resolve({code,signal})));
 readline.createInterface({input:oracle.stdout}).on('line',line=>{try{assert(oraclePending,'unexpected oracle response');oraclePending.resolve(JSON.parse(line));}catch(error){oraclePending?.reject(error);}});
 clipboardProofs.push(await oracleCall({action:'begin'}));
}
async function oracleExpect(expected,label){
 let proof;for(let count=0;count<30;count++){proof=await oracleCall({action:'expect',expected,syntheticPrefix:nonce,alternates:[expected.replaceAll('\r\n','\n'),expected.replace(/(?<!\r)\n/g,'\r\n')]});if(proof.matches)break;await pause(100);}clipboardProofs.push({label,...proof});assert(proof.matches,label+': '+JSON.stringify(proof));
}
async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error(log);await pause(80);}throw Error('Timed out: '+label);}
async function raw(op,payload={},target=shell){return target.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});}
async function invoke(op,payload={},target=shell){const value=await raw(op,payload,target);assert.equal(value.ok,true,op+': '+JSON.stringify(value));return value.value;}
async function scoped(predicate){return until(async()=>{for(const page of await browser.pages())if(await page.evaluate(predicate).catch(()=>false))return page;},'scoped renderer');}
async function chord(page,key){await page.keyboard.down('Control');try{await page.keyboard.press(key);}finally{await page.keyboard.up('Control');}}
async function launch(){
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
 const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:configRoot,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_SHOT_DIR:out});
 const command=executable||createRequire(import.meta.url)('electron');child=spawn(command,packaged?[]:[path.join(root,'src/main/main.cjs')],{cwd:out,env,stdio:['ignore','pipe','pipe']});
 const run={pid:child.pid,command,systemOnlyPath:env.Path,debugPort:port};runs.push(run);
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
 child.on('error',error=>errors.push(error.message));exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await scoped(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell');
 browser.on('targetcreated',async target=>{const page=await target.page().catch(()=>null);page?.on('pageerror',error=>errors.push(error.message));});
 for(const page of await browser.pages())page.on('pageerror',error=>errors.push(error.message));
 if(await shell.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell.click('#configuration-cancel');
 installFileTreeClicks(shell);await invoke('session.resize',{width:1440,height:900});
 run.nativeWindows=await invoke('workspace.windows.list');assert(run.nativeWindows.some(win=>win.visible));
 if(projectId)await shell.click('[data-project-id="'+projectId+'"]');
 else{await shell.click('#pick-project');projectId=(await until(async()=>(await invoke('project.recent')).projects.find(row=>row.rootDisplay===project),'project registration')).id;}
 assert.equal((await invoke('config.status')).initialized,false);
}
async function open(rel){
 await shell.click('#file-tree button[data-path="'+rel+'"]');
 doc=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(rel=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath===rel,rel).catch(()=>false))return page;},'document '+rel);
 await doc.waitForSelector('#text-host .cm-content',{visible:true});return doc;
}
async function close(){
 const started=Date.now();void raw('session.requestClose').catch(()=>{});
 const exit=await Promise.race([exited,pause(15000).then(()=>null)]);runs.at(-1).exit=exit;runs.at(-1).closeMs=Date.now()-started;
 assert.deepEqual(exit,{code:0,signal:null},'normal close only; cleanup termination is not a pass');
 await browser.disconnect();browser=null;
 let listening=false;try{listening=(await fetch('http://127.0.0.1:'+runs.at(-1).debugPort+'/json/version')).ok;}catch{}
 assert.equal(listening,false,'actual process exit releases debugging listener');
}
const pane=id=>'.workspace-pane:has([data-view-id="'+id+'"])';
async function surface(id){return(await invoke('workspace.windows.list',{projectId})).flatMap(win=>win.surfaces).find(row=>row.viewId===id);}
async function recoveryHasDraft(page,recovery,relPath,text){
 for(const entry of recovery.entries??[]){
  if(entry.project?.id!==projectId||entry.value?.relPath!==relPath)continue;
  const payload={projectId,id:entry.id,revision:entry.revision,version:entry.version};
  const result=await raw('workspace.recovery.detail',payload,page);
  if(result.value?.value?.candidate?.text===text)return true;
 }
 return false;
}
async function command(value){const {layout}=await invoke('workspace.snapshot',{projectId});return raw('workspace.command',{projectId,expectedRevision:layout.revision,requestKey:randomUUID(),command:value});}
async function titleAction(host,id,action){const selector=id?pane(id)+' .workspace-pane-title':'.workspace-pane-title';await host.click(selector,{button:'right'});await host.waitForSelector('#workspace-title-menu:not([hidden]) [data-command="'+action+'"]',{visible:true});await host.click('#workspace-title-menu [data-command="'+action+'"]');}
async function editorState(page){return page.evaluate(()=>({text:__nozeliInput.text(),selection:__nozeliInput.selection()}));}
async function composition(page,type){await page.evaluate(type=>document.querySelector('#text-host .cm-content').dispatchEvent(new CompositionEvent(type,{bubbles:true,data:type==='compositionstart'?'中':''})),type);}
try{
 stage='native clipboard snapshot';await oracleStart();
 stage='native copy cut undo and independent paste';await launch();const first=await open('first.txt');
 await oracleCall({action:'write',text:'Nozeli synthetic clipboard sentinel'});
 await first.bringToFront();await first.evaluate(()=>{__nozeliInput.focus();__nozeliInput.select(0,__nozeliInput.text().length);});
 const copyState=await first.evaluate(()=>({text:__nozeliInput.text(),selection:__nozeliInput.selection(),focus:document.hasFocus(),active:document.activeElement?.outerHTML.slice(0,500)}));await fs.writeFile(path.join(out,'copy-state.json'),JSON.stringify(copyState,null,2));assert.equal(copyState.text,text);
 await chord(first,'c');await oracleExpect(text,'Ctrl+C copies exact Unicode text to the Windows clipboard');
 await chord(first,'x');await until(()=>first.evaluate(()=>__nozeliInput.text()===''),'cut changes editor');
 await oracleExpect(text,'Ctrl+X publishes the same native Unicode selection');
 await chord(first,'z');await until(()=>first.evaluate(text=>__nozeliInput.text()===text,text),'native cut undo');
 const external='Independent Win32 paste 中文🧭é\r\nSecond pasted line';await oracleCall({action:'write',text:external});
 await first.evaluate(()=>{__nozeliInput.select(0,__nozeliInput.text().length);__nozeliInput.focus();});await chord(first,'v');
 await until(()=>first.evaluate(expected=>__nozeliInput.text()===expected,external.replaceAll('\r\n','\n')),'Win32 clipboard paste');
 await chord(first,'z');await until(()=>first.evaluate(text=>__nozeliInput.text()===text,text),'native paste undo');
 checks.push('actual Ctrl+C/Ctrl+X and undo, independent Win32 Unicode clipboard reader/writer, native Ctrl+V normalizes CRLF without losing Unicode');
 stage='explicit and trusted clipboard paths';const explicit='Explicit synthetic clipboard 中文';await invoke('document.clipboard',{action:'write',text:explicit},first);await oracleExpect(explicit,'document.clipboard IPC reaches Win32');
 const trusted='Trusted navigator synthetic 中文';await first.bringToFront();await first.evaluate(text=>navigator.clipboard.writeText(text),trusted);await oracleExpect(trusted,'trusted navigator.clipboard reaches Win32');
 clipboardRestoration=await oracleCall({action:'restore'});assert.equal(clipboardRestoration.restored,true);oracle.stdin.end();assert.deepEqual(await oracleExit,{code:0,signal:null});oracle=null;
 checks.push('scoped clipboard IPC and navigator clipboard reach the real system clipboard; original formats restored without logging original contents');
 stage='two native document surfaces and focus';const firstScope=await invoke('workspace.bootstrap',{},first),firstId=firstScope.viewId;
 await titleAction(shell,firstId,'split-x');const empty=await until(()=>shell.$$eval('.workspace-pane',rows=>rows.find(row=>!row.querySelector('[data-view-id]'))?.dataset.workspaceGroup),'empty split');
 await shell.click('[data-workspace-group="'+empty+'"] .workspace-pane-title');const other=await open('second.txt'),otherScope=await invoke('workspace.bootstrap',{},other),otherId=otherScope.viewId;
 await until(async()=>{const windows=await invoke('workspace.windows.list',{projectId});return[firstId,otherId].every(id=>windows.find(win=>win.id==='main')?.surfaces.some(row=>row.viewId===id&&row.visible&&row.bounds.width>0));},'two native visible surfaces');
 await first.bringToFront();await first.evaluate(()=>__nozeliInput.focus());await first.keyboard.type('FIRST_ONLY ');
 assert((await editorState(first)).text.includes('FIRST_ONLY '));assert.equal((await editorState(other)).text,second);
 await shell.click(pane(otherId)+' .workspace-pane-title');await other.evaluate(()=>__nozeliInput.focus());await other.keyboard.type('SECOND_ONLY ');
 assert((await editorState(other)).text.includes('SECOND_ONLY '));assert(!(await editorState(first)).text.includes('SECOND_ONLY '));
 checks.push('two native WebContentsView document surfaces are visible; focused keyboard edits remain in their own buffers');
 stage='synthetic composition transfer veto';await composition(first,'compositionstart');
 const refused=await command({type:'floatOpen',viewId:firstId});assert.equal(refused.ok,false);assert.equal(refused.error.code,'COMPOSITION_ACTIVE');
 assert.equal((await invoke('workspace.bootstrap',{},first)).windowId,'main');await composition(first,'compositionend');
 assert((await editorState(first)).text.includes('FIRST_ONLY '));checks.push('synthetic composition guard refuses moving the live document with COMPOSITION_ACTIVE and retains the original surface/buffer; physical IME remains unqualified');
 stage='detach dock identity selection and undo';
 await first.evaluate(()=>{window.__interactionEditor=document.querySelector('#text-host .cm-editor');__nozeliInput.select(2,9);});
 const before=await editorState(first),identity=await surface(firstId);
 await shell.click(pane(firstId)+' [data-workspace-command="floatOpen"]');
 const detached=await scoped(()=>window.__nozeliReady&&window.__workspaceScope?.role==='detached');
 await until(async()=>(await invoke('workspace.bootstrap',{},first)).windowId!=='main','native detached host');
 const during=await surface(firstId);assert.equal(during.webContentsId,identity.webContentsId);assert.equal((await invoke('workspace.bootstrap',{},first)).generation,firstScope.generation);assert.deepEqual(await editorState(first),before);
 const nativeWindows=await invoke('workspace.windows.list',{projectId});assert(nativeWindows.filter(win=>win.visible).length>=2);runs.at(-1).detachedWindows=nativeWindows;
 await detached.screenshot({path:path.join(out,'detached-shell-only.png')});await first.screenshot({path:path.join(out,'detached-content-only.png')});
 await titleAction(detached,null,'dock');await until(async()=>(await invoke('workspace.bootstrap',{},first)).windowId==='main','docked surface');
 assert.equal((await surface(firstId)).webContentsId,identity.webContentsId);assert.equal((await invoke('workspace.bootstrap',{},first)).generation,firstScope.generation);assert.equal(await first.evaluate(()=>document.querySelector('#text-host .cm-editor')===window.__interactionEditor),true);assert.deepEqual(await editorState(first),before);
 await first.bringToFront();await first.evaluate(()=>__nozeliInput.focus());await chord(first,'z');await until(()=>first.evaluate(text=>__nozeliInput.text()===text,text),'undo after dock');
 checks.push('detach/dock preserves WebContents ID, generation, exact DOM editor, Unicode buffer, selection and actual native undo; two visible native windows observed');
 stage='multi-surface close and exact draft recovery';const diskFirst=await fs.readFile(path.join(project,'first.txt'),'utf8'),diskOther=await fs.readFile(path.join(project,'second.txt'),'utf8');
 await other.bringToFront();await other.evaluate(()=>{__nozeliInput.focus();__nozeliInput.select(0,0);});await other.keyboard.type('UNSAVED_CLOSE 中文 ');const expectedOther=(await editorState(other)).text;await close();
 assert.equal(await fs.readFile(path.join(project,'first.txt'),'utf8'),diskFirst);assert.equal(await fs.readFile(path.join(project,'second.txt'),'utf8'),diskOther);
 await launch();const recovery=await invoke('workspace.recovery.list');assert(await recoveryHasDraft(shell,recovery,'second.txt',expectedOther));
 await open('first.txt');assert.equal((await editorState(doc)).text,diskFirst);checks.push('normal shutdown preserves the exact second-surface draft in the recovery ledger without silently overwriting either source');
 await close();
 stage='repeated process restart and unsaved retention';const stress=[];
 for(let index=0;index<4;index++){
  await launch();await open('first.txt');await doc.bringToFront();await doc.evaluate(()=>{__nozeliInput.focus();__nozeliInput.select(0,0);});
  const marker='Cycle_'+index+'_中文 ';await doc.keyboard.type(marker);const expected=(await editorState(doc)).text;assert(expected.includes(marker));await close();
  stress.push({index,exactDraft:expected,exit:runs.at(-1).exit,closeMs:runs.at(-1).closeMs});
 await launch();const entries=await invoke('workspace.recovery.list');assert(await recoveryHasDraft(shell,entries,'first.txt',expected));await close();
 }
 checks.push('four additional edit/close/full-restart pairs retain exact Unicode drafts; all application processes exit 0 and release their debugging listener');
 assert.deepEqual(errors,[]);assert.equal((await fs.readFile(path.join(project,'first.txt'),'utf8')),diskFirst);
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:true,checks,errors,out,runs,packaged,application:root,clipboardProofs,clipboardRestoration,stress,physicalIME:false},null,2));
 console.log(JSON.stringify({ok:true,checks,out,runs:runs.length},null,2));
}catch(error){
 const pages=[];for(const page of await browser?.pages()??[])pages.push(await page.evaluate(()=>({scope:window.__workspaceScope,text:document.body.innerText.slice(-12000),dialogs:[...document.querySelectorAll('dialog')].map(node=>({id:node.id,open:node.open,text:node.innerText}))})).catch(e=>({error:e.message})));
 await fs.writeFile(path.join(out,'failure-pages.json'),JSON.stringify(pages,null,2));await shell?.screenshot({path:path.join(out,'failure-shell.png')}).catch(()=>{});
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:false,stage,error:error.stack,checks,errors,out,runs,packaged,application:root,clipboardProofs,clipboardRestoration},null,2));throw error;
}finally{
 if(oracle){try{clipboardRestoration=await oracleCall({action:'restore'});}catch(error){clipboardRestoration={error:error.message};}oracle.stdin.end();await Promise.race([oracleExit,pause(6000)]);}
 await fs.writeFile(path.join(out,'clipboard-cleanup.json'),JSON.stringify({clipboardRestoration,oracleLog},null,2));
 await fs.writeFile(path.join(out,'main.log'),log);await browser?.disconnect();
 if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
}
