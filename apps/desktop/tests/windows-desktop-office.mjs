// Actual Windows main entry and embedded Word/Fortune editors, synthetic files.
// Gestures are VM/CDP keyboard/mouse input on the real embedded editors — not
// physical keyboard/IME proof. The spreadsheet surface intentionally exposes no
// formatting UI (content + formula only; see sheet-frame showToolbar:false and
// its context menu), so unsupported-format export boundaries are NOT exercised
// here — they belong to the API contract tests; this journey claims only what
// real UI controls can do.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
 import {spawn} from 'node:child_process';
 import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
import JSZip from 'jszip';
import {prepareReading} from './reading-setup.fixture.mjs';
const [out,application,executable]=process.argv.slice(2);assert.equal(process.platform,'win32');assert(out&&path.isAbsolute(out),'fresh absolute evidence directory required');await fs.mkdir(out);
const root=path.resolve(application||path.join(import.meta.dirname,'..')),profile=path.join(out,'.Nozeli/desktop'),project=path.join(out,'Office 项目 空格'),fixtures=path.join(import.meta.dirname,'fixtures');await fs.mkdir(project);
 const {wordText}=await import(pathToFileURL(path.join(root,'src/main/word-anchors.mjs')).href);
 const {decodeRecoveryBytes}=await import(pathToFileURL(path.join(root,'src/domain/office-recovery.mjs')).href);
const originals={};for(const [name,fixture]of [['document.docx','office/中文 文档.docx'],['sheet.xlsx','office/中文 表格.xlsx'],['legacy.doc','legacy-word/test01.doc']]){originals[name]=await fs.readFile(path.join(fixtures,fixture));await fs.writeFile(path.join(project,name),originals[name]);}
// Known body content of the synthetic legacy fixture (upstream test01.doc):
// the imported DOCX must reproduce it — no empty/non-empty tautology.
const legacyBody=['This is a test of reviewing','This text has been inserted','and should be included'];
const checks=[],errors=[],runs=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let child,browser,shell,page,frame,exited,stage='',projectId,result;
async function mark(phase){runs.at(-1).phase=phase;await fs.writeFile(path.join(out,'progress.json'),JSON.stringify({phase,pid:child.pid},null,2)+'\n');}
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Electron exited before '+label+': '+(runs.at(-1)?.log??'').slice(-4000));await pause(80);}throw Error('Timed out: '+label);}
async function invoke(op,payload={},target=shell){const response=await target.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert.equal(response.ok,true,op+': '+JSON.stringify(response));return response.value;}
async function content(rel){return until(async()=>{for(const target of await browser.pages())if(await target.evaluate(rel=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath===rel,rel).catch(()=>false))return target;},'document '+rel);}
async function launch(){
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:path.join(out,'.Nozeli'),NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_SHOT_DIR:out});const command=executable||createRequire(import.meta.url)('electron');child=spawn(command,executable?[]:[path.join(root,'src/main/main.cjs')],{cwd:out,env,stdio:['ignore','pipe','pipe']});
 const run={pid:child.pid,command,args:executable?[]:[path.join(root,'src/main/main.cjs')],systemOnlyPath:env.Path};run.log='';runs.push(run);for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>run.log+=bytes);exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});exited.catch(()=>{});
 await mark('connect-cdp');browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 const observe=target=>{target.on('pageerror',error=>errors.push(error.message));};browser.on('targetcreated',async target=>{const page=await target.page();if(page)observe(page);});
 await mark('find-shell');shell=await until(async()=>{for(const target of await browser.pages())if(await target.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return target;},'shell');observe(shell);
 // Deterministic setup-dialog dismissal (re-show safe) plus physical file-rail
 // click installation.
 await prepareReading(shell);await mark('shell-window');await shell.bringToFront();await invoke('session.resize',{width:1440,height:1000});const windows=await invoke('workspace.windows.list');assert(windows.some(win=>win.visible));run.nativeWindows=windows;
 await mark('project-pick');
 if(projectId)await shell.click('[data-project-id="'+projectId+'"]');
 else{
  // Never act before the native control is enabled and the window is shown.
  await shell.waitForFunction(()=>{const button=document.getElementById('pick-project');return button&&!button.disabled&&!button.hidden&&document.visibilityState==='visible';});
  await shell.evaluate(()=>{window.__officeInputTrace=[];for(const type of ['click','keydown'])document.addEventListener(type,event=>window.__officeInputTrace.push({type,target:event.target?.id||event.target?.tagName,trusted:event.isTrusted}),true);});
  await shell.click('#pick-project');
  // rootDisplay is a display path; identity is normalized, not string-equal.
  projectId=(await until(async()=>(await invoke('project.recent')).projects.find(row=>path.relative(row.rootDisplay,project)===''),'registered synthetic project via normalized root match')).id;
  const delivery=await shell.evaluate(()=>{const button=document.getElementById('pick-project');return {focused:document.hasFocus(),visibility:document.visibilityState,active:document.activeElement?.id||document.activeElement?.tagName,appInert:document.getElementById('app')?.inert,blockedAncestor:button?.closest('[inert]')?.id||null,rect:button?.getBoundingClientRect().toJSON(),trace:window.__officeInputTrace};});
  await fs.writeFile(path.join(out,'input-delivery.json'),JSON.stringify(delivery,null,2)+'\n');
  assert(delivery.trace.some(entry=>entry.type==='click'&&entry.trusted===true&&entry.target==='pick-project'),'project pick must be a trusted click on the visible native control');
 }
 await shell.waitForFunction(id=>document.querySelector('#recent button[aria-current="true"]')?.dataset.projectId===id,{},projectId);
 assert.equal((await invoke('config.status')).initialized,false);
 }
 async function open(rel,editor){await shell.click('#file-tree button[data-path="'+rel+'"]');page=await content(rel);await page.bringToFront();
  // The requested view must actually be the active surface, not merely mounted.
  await until(async()=>{const windows=await invoke('workspace.windows.list',{projectId});return windows.some(win=>win.surfaces.some(surface=>surface.relPath===rel&&surface.visible===true));},'active visible surface '+rel);
  if(editor){await page.waitForSelector('#word-host iframe');frame=await (await page.$('#word-host iframe')).contentFrame();await frame.waitForFunction(editor=>editor==='word'?Boolean(window.nozeliWordEditor?.activeEditor?.state?.doc):Boolean(window.nozeliSheetEditor)&&!document.querySelector('#sheet').inert,{timeout:60000},editor);}}
async function saved(){await page.waitForFunction(()=>document.querySelector('#save-status')?.dataset.state==='saved',{timeout:45000});assert.equal(await page.$eval('#save-failure',node=>node.hidden),true);}
async function recoveryEntries(){const entries=[];let cursor=null;do{const page=await invoke('workspace.recovery.list',{cursor});for(const item of page.entries){const detail=await invoke('workspace.recovery.detail',{projectId:item.project.id,id:item.id,revision:item.revision,version:item.version});entries.push({...item,value:detail.value});}cursor=page.nextCursor;}while(cursor);return entries;}
async function close(){void invoke('session.requestClose').catch(()=>{});const exit=await Promise.race([exited,pause(20000).then(()=>null)]);runs.at(-1).exit=exit;assert.deepEqual(exit,{code:0,signal:null},'app still alive 20s after session.requestClose; exit='+JSON.stringify(exit));await browser.disconnect();browser=null;}
try{
 stage='native project and actual Word editor';await launch();await open('document.docx','word');assert((await frame.evaluate(()=>nozeliWordEditor.activeEditor.state.doc.textContent)).includes('原始首句'));assert.deepEqual(await fs.readFile(path.join(project,'document.docx')),originals['document.docx']);await page.screenshot({path:path.join(out,'office-word-original.png')});checks.push('actual project selection through the enabled/visible native shell renders the embedded Word editor with the original DOCX unchanged');
 stage='Word keyboard edit, native export and settled save';await frame.evaluate(()=>{const editor=nozeliWordEditor.activeEditor;editor.commands.setTextSelection(1);editor.view.focus();});await page.keyboard.type('WINDOWS_OFFICE ');await page.keyboard.sendCharacter('中文编辑 ');await page.keyboard.down('Control');await page.keyboard.press('s');await page.keyboard.up('Control');await until(async()=>(await wordText(await fs.readFile(path.join(project,'document.docx')))).includes('WINDOWS_OFFICE 中文编辑'),'actual DOCX source');await saved();const savedWord=await fs.readFile(path.join(project,'document.docx'));assert((await invoke('file.read',{projectId,relPath:'document.docx'},page)).authorshipText.includes('WINDOWS_OFFICE 中文编辑'));await page.screenshot({path:path.join(out,'office-word-saved.png')});checks.push('actual embedded Word keyboard edit (incl. Unicode composition) and explicit Ctrl+S write the real DOCX source with a settled save receipt');
 stage='actual spreadsheet keyboard and formula dependency';await open('sheet.xlsx','sheet');await frame.waitForFunction(()=>nozeliSheetEditor.getCellValue(3,1)===30);assert.deepEqual(await fs.readFile(path.join(project,'sheet.xlsx')),originals['sheet.xlsx']);await frame.click('canvas',{offset:{x:155,y:50}});await frame.waitForFunction(()=>nozeliSheetEditor.getSelection()?.[0]?.row[0]===1&&nozeliSheetEditor.getSelection()?.[0]?.column[0]===1);await frame.click('#luckysheet-functionbox-cell');await page.keyboard.down('Control');await page.keyboard.press('a');await page.keyboard.up('Control');await page.keyboard.type('35');await page.keyboard.press('Enter');await frame.waitForFunction(()=>Number(nozeliSheetEditor.getCellValue(1,1))===35&&Number(nozeliSheetEditor.getCellValue(3,1))===55);assert.deepEqual(await frame.evaluate(()=>[nozeliSheetEditor.getCellValue(3,1)]),[55]);
 await until(async()=>{const zip=await JSZip.loadAsync(await fs.readFile(path.join(project,'sheet.xlsx')));return (await zip.file('xl/worksheets/sheet1.xml').async('string')).includes('<v>35</v>');},'actual XLSX source');await saved();const savedSheet=await fs.readFile(path.join(project,'sheet.xlsx'));await page.screenshot({path:path.join(out,'office-sheet-formula.png')});checks.push('real Fortune formula-bar keyboard input updates B2 and the SUM dependency; the XLSX source saves natively with exact bytes');
 stage='unsaved Word draft retained by normal close';await open('document.docx','word');await frame.waitForFunction(()=>nozeliWordEditor.activeEditor.state.doc.textContent.includes('WINDOWS_OFFICE 中文编辑'));await frame.evaluate(()=>{const editor=nozeliWordEditor.activeEditor;editor.commands.setTextSelection(editor.state.doc.content.size);editor.view.focus();});await page.keyboard.type('WINDOWS_UNSAVED_DRAFT ');await frame.waitForFunction(()=>nozeliWordEditor.activeEditor.state.doc.textContent.includes('WINDOWS_UNSAVED_DRAFT '));await close();assert.deepEqual(await fs.readFile(path.join(project,'document.docx')),savedWord);checks.push('normal close with an unsaved Word draft exits cleanly (code 0) without writing the draft over the saved DOCX source');
 stage='whole-process reopen Office source, draft and history';await launch();
 // Ledger facts with per-row diagnostics; the workspace recovery row is living
 // (each retention overwrites workspace:<viewId>, preserving the superseded
 // generation under workspace:<viewId>:retained:<ownerGeneration>).
 const ledgerRows=async()=>(await recoveryEntries()).map(entry=>{
   const bytes=entry.value?.candidate?.bytes?Buffer.from(decodeRecoveryBytes(entry.value.candidate.bytes)):null;
   return {id:entry.id,revision:entry.revision,generation:entry.value?.generation??null,ownerGeneration:entry.value?.ownerGeneration??null,dirty:entry.value?.documentStatus?.dirty??null,relPath:entry.value?.relPath??null,bytes,
     sha:bytes?createHash('sha256').update(bytes).digest('hex'):null,hasMarker:Boolean(bytes)&&bytes.includes(Buffer.from('WINDOWS_UNSAVED_DRAFT '))};});
 const firstLedger=await ledgerRows();
 const draftRow=firstLedger.find(row=>row.relPath==='document.docx'&&row.dirty===true&&row.bytes);
 assert(draftRow,'retained Word draft missing from the recovery ledger');
 const draftBytes=draftRow.bytes;assert((await wordText(draftBytes)).includes('WINDOWS_UNSAVED_DRAFT '),'retained draft must carry the exact unsaved edit bytes');assert.deepEqual(await fs.readFile(path.join(project,'document.docx')),savedWord);
 await open('document.docx','word');await frame.waitForFunction(text=>{const body=nozeliWordEditor.activeEditor.state.doc.textContent;return body.includes(text)&&!body.includes('WINDOWS_UNSAVED_DRAFT ');},{},'WINDOWS_OFFICE 中文编辑');assert.deepEqual(await fs.readFile(path.join(project,'document.docx')),savedWord);const reopenedWord=await invoke('file.read',{projectId,relPath:'document.docx'},page);assert.equal(reopenedWord.authorshipError,null);await page.screenshot({path:path.join(out,'office-reopen-saved.png')});checks.push('full process restart reopens the embedded Word editor at the last explicit save only — the retained draft never silently grafts into the editor or overwrites the DOCX source');
 await open('sheet.xlsx','sheet');await frame.waitForFunction(()=>Number(nozeliSheetEditor.getCellValue(1,1))===35&&Number(nozeliSheetEditor.getCellValue(3,1))===55);assert.deepEqual(await fs.readFile(path.join(project,'sheet.xlsx')),savedSheet);checks.push('saved spreadsheet values and exact XLSX source survive the whole-process restart');
 // Scoped oracles — no broad claims over unrelated historical or current rows:
 // (a) the EXACT original close-time draft bytes remain durably preserved and
 //     user-discoverable at their own logical row (the living row, or its
 //     linked :retained:<ownerGeneration> copy once superseded) with its
 //     authoritative dirty status intact;
 // (b) every row observed before the reopen keeps its exact bytes readable
 //     (same id, or its retained-prior copy once superseded) — history never
 //     mutates. The reopened editor intentionally mounts SAVED-ONLY content,
 //     so a newer living row for that clean scene may legitimately exist
 //     without the unsaved marker; no graft of the draft into it is expected
 //     or demanded — the preserved linked record IS the draft recovery.
 const afterLedger=await ledgerRows();
 await fs.writeFile(path.join(out,'recovery-rows.json'),JSON.stringify({first:firstLedger.map(({bytes,...row})=>row),after:afterLedger.map(({bytes,...row})=>row)},null,2));
 const preservedRow=afterLedger.find(row=>row.bytes?.equals(draftBytes)&&(row.id===draftRow.id||Boolean(draftRow.ownerGeneration)&&row.id===draftRow.id+':retained:'+draftRow.ownerGeneration));
 assert(preservedRow,'the exact original close-time draft bytes must remain preserved at their own row (living or retained-prior)');
 assert(preservedRow.dirty===true&&preservedRow.relPath==='document.docx','the preserved draft record keeps its authoritative dirty status and source-file linkage (scene id '+preservedRow.id+')');
 for(const row of firstLedger)if(row.bytes)assert(afterLedger.some(later=>later.bytes?.equals(row.bytes)&&(later.id===row.id||Boolean(row.ownerGeneration)&&later.id===row.id+':retained:'+row.ownerGeneration)),'recovery history mutated for row '+row.id);
 checks.push('the retained Word draft survives the whole-process restart and reopen: exact original bytes user-discoverable at their own row with authoritative dirty status, and history rows immutable');
 stage='actual legacy DOC import button';await open('legacy.doc');await page.waitForSelector('#import-doc',{visible:true});await page.click('#import-doc');const importedRel='legacy.正文导入.docx';const importedPage=await content(importedRel);await importedPage.waitForSelector('#word-host iframe');const imported=await fs.readFile(path.join(project,importedRel));const importedText=await wordText(imported);for(const known of legacyBody)assert(importedText.includes(known),'imported body must contain known fixture text: '+known);assert.deepEqual(await fs.readFile(path.join(project,'legacy.doc')),originals['legacy.doc']);await importedPage.screenshot({path:path.join(out,'office-legacy-import.png')});checks.push('actual legacy DOC import control runs the OLE parser and native create-only DOCX publication with the fixture known body; the original DOC remains byte-for-byte unchanged');
 await shell.screenshot({path:path.join(out,'office-shell.png')});
 assert.deepEqual(errors,[]);await close();
 result={ok:true,checks,errors,runs,application:root,packaged:Boolean(executable),projectId,out,scope:'actual embedded Word/XLSX/legacy DOC via real UI controls only; spreadsheet formatting UI intentionally unsupported (content+formula) and NOT claimed here — covered by API contract tests; not full Office/clipboard/IME qualification',inputScope:'Visible real native Electron embedded editors driven by VM/CDP keyboard and mouse input; not physical keyboard/IME or multi-display device proof'};
}catch(error){
 const pages=[];for(const target of await browser?.pages()??[])pages.push(await target.evaluate(()=>({scope:window.__workspaceScope,ready:window.__nozeliReady,text:document.body.innerText.slice(-10000),office:{saveStatus:document.querySelector('#save-status')?.dataset.state??null,saveStatusText:document.querySelector('#save-status')?.textContent??null,saveFailureHidden:document.getElementById('save-failure')?.hidden??null,saveError:document.getElementById('save-error')?.textContent??null,toast:document.getElementById('toast')?.textContent??null}})).catch(cause=>({error:cause.message})));
 await fs.writeFile(path.join(out,'failure-pages.json'),JSON.stringify(pages,null,2));await shell?.screenshot({path:path.join(out,'failure-shell.png')}).catch(()=>{});await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
 result={ok:false,stage,error:error.stack,checks,errors,runs,projectId,expectedProject:project,packaged:Boolean(executable),application:root};process.exitCode=1;
}finally{
 await browser?.disconnect();if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 for(let index=0;index<runs.length;index++){await fs.writeFile(path.join(out,'main-'+(index+1)+'.log'),runs[index].log??'');delete runs[index].log;}
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({ok:result.ok,stage:result.stage??null,checks,out}));
}
