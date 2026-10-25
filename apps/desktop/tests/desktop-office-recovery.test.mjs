import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import JSZip from 'jszip';
import {decodeRecoveryBytes} from '../src/domain/office-recovery.mjs';
import {normalizeOfficeRecovery} from '../src/main/office-recovery.mjs';

// Actual Electron/Office engines; all writes are confined to this new fixture.
const root=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-office-recovery-'));
const project=path.join(out,'project'), offline=path.join(out,'offline'), downloads=path.join(out,'downloads');
await fs.mkdir(project);await fs.mkdir(downloads);
const fixtures={word:['sample.docx','office/中文 文档.docx'],sheet:['sample.xlsx','office/中文 表格.xlsx'],ppt:['sample.pptx','ppt/compatibility.pptx']};
const originals={};
for(const [kind,[name,fixture]] of Object.entries(fixtures)){originals[kind]=await fs.readFile(path.join(root,'tests/fixtures',fixture));await fs.writeFile(path.join(project,name),originals[kind]);}
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
let child,browser,exited,log='';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const deadline=Date.now()+90000;while(Date.now()<deadline){const value=await check();if(value)return value;await pause(100);}throw Error(label+'\n'+log);}
function launch(){child=spawn(process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(root,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{cwd:root,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_TEST_PICK:project,NOZELI_CONFIG_ROOT:path.join(out,'.Nozeli'),NOZELI_USER_DATA:path.join(out,'.Nozeli/desktop'),NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes;});exited=new Promise(resolve=>child.once('exit',resolve));}
async function connect(){await until(async()=>{try{browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});return true;}catch{return false;}},'Electron unavailable');}
async function call(page,op,payload={}){const result=await page.evaluate((op,payload)=>window.nozeli.invoke(op,payload),op,payload);assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function scope(predicate){return until(async()=>{for(const page of await browser.pages()){const state=await page.evaluate(async()=>(await window.nozeli.invoke('workspace.bootstrap',{})).value).catch(()=>null);if(state&&predicate(state)){await page.waitForFunction(()=>window.__nozeliReady);return page;}}},'Workspace scope unavailable');}
async function dismiss(page){if(await page.$eval('#configuration-setup',node=>node.open).catch(()=>false))await page.click('#configuration-cancel');}
async function stop(){await browser?.disconnect();browser=null;if(child.exitCode===null){child.kill('SIGTERM');await exited;}}
try{
  launch();await connect();let shell=await scope(state=>state.role==='shell');await dismiss(shell);
  const picked=await call(shell,'project.pick'),projectId=picked.project.id;
  await shell.reload({waitUntil:'domcontentloaded'});await shell.waitForFunction(()=>window.__nozeliReady);await dismiss(shell);
  await shell.waitForSelector(`#recent [data-project-id="${projectId}"]`);await shell.click(`#recent [data-project-id="${projectId}"]`);
  const pages={},frames={};
  for(const [kind,[name]] of Object.entries(fixtures)){
    await shell.waitForSelector(`#file-tree button[data-path="${name}"]`);await shell.click(`#file-tree button[data-path="${name}"]`);
    const page=pages[kind]=await scope(state=>state.kind==='document'&&state.relPath===name);
    frames[kind]=await until(async()=>page.frames().find(frame=>frame.url().includes(kind==='ppt'?'/ppt-vendor/':`/${kind}-frame.html`)),'Office frame unavailable');
    await frames[kind].waitForFunction(kind=>kind==='word'?Boolean(window.nozeliWordEditor?.activeEditor):kind==='sheet'?Boolean(window.nozeliSheetEditor?.getAllSheets()?.length):Boolean(window.__nozeliPptist?.store.slides.length),{timeout:90000},kind);
  }
  await fs.rename(project,offline);
  for(const [kind,[name]] of Object.entries(fixtures)){
    const unavailable=await pages[kind].evaluate(({projectId,relPath})=>window.nozeli.invoke('file.read',{projectId,relPath}),{projectId,relPath:name});
    assert.equal(unavailable.ok,false);assert.equal(unavailable.error.code,'PROJECT_ROOT_MISSING');
  }
  const markers={word:'RECOVERY_WORD_中文_9421',sheet:'RECOVERY_SHEET_中文_9421',ppt:'RECOVERY_PPT_中文_9421'};
  await frames.word.evaluate(marker=>{const editor=nozeliWordEditor.activeEditor;editor.commands.setTextSelection(1);editor.commands.insertContent(marker+' ');},markers.word);
  // Public engine API edits the actual workbook and emits its normal change event.
  await frames.sheet.evaluate(marker=>nozeliSheetEditor.setCellValue(0,0,marker),markers.sheet);
  await frames.ppt.evaluate(marker=>{const store=__nozeliPptist.store;const element=store.slides[0].elements.find(element=>typeof element.content==='string');if(!element)throw Error('Fixture lacks editable text');element.content='<p>'+marker+'</p>';},markers.ppt);
  await pages.word.waitForFunction(()=>document.querySelector('#save-status').textContent!=='');
  await pause(150); // Deliver actual engine change notifications before close capture.
  await call(shell,'workspace.closeProject',{projectId,operationId:'office-offline-close'});
  const before=await call(shell,'workspace.recovery.list');
  const retained=Object.fromEntries(Object.entries(fixtures).map(([kind,[name]])=>[kind,before.entries.find(entry=>entry.project.id===projectId&&entry.value.relPath===name)]));
  for(const [kind,entry] of Object.entries(retained)){assert(entry,kind+' recovery missing');await normalizeOfficeRecovery(kind,entry.value.candidate);assert.match(entry.value.baseDigest||entry.value.sourceDigest,/^[a-f0-9]{64}$/);assert.deepEqual(await fs.readFile(path.join(offline,fixtures[kind][0])),originals[kind]);}
  assert.match(JSON.stringify(retained.ppt.value.candidate.model),new RegExp(markers.ppt));
  await stop();launch();await connect();shell=await scope(state=>state.role==='shell');await dismiss(shell);
  const after=await call(shell,'workspace.recovery.list');
  for(const [kind,[name]] of Object.entries(fixtures)){
    const entry=after.entries.find(entry=>entry.project.id===projectId&&entry.value.relPath===name);assert(entry);
    assert.deepEqual(entry.value.candidate,retained[kind].value.candidate,'Cold-open candidate changed');
  }
  const cdp=await shell.createCDPSession();await cdp.send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await shell.evaluate(()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='本机恢复').click());
  for(const [kind,[name]] of Object.entries(fixtures)){
    await shell.waitForFunction(name=>[...document.querySelectorAll('dialog[open] section')].some(section=>section.querySelector('h3')?.textContent.includes(' · '+name+' · ')),{},name);
    await shell.screenshot({path:path.join(out,`recovery-${kind}.png`)});
    await shell.evaluate(name=>{const section=[...document.querySelectorAll('dialog[open] section')].find(section=>section.querySelector('h3')?.textContent.includes(' · '+name+' · '));const button=[...section.querySelectorAll('button')].find(button=>button.textContent==='导出文档副本');if(!button)throw Error('No Office export action');button.click();},name);
    const bytes=await until(async()=>fs.readFile(path.join(downloads,name)).catch(()=>null),'Office export missing');
    assert.deepEqual(bytes,Buffer.from(decodeRecoveryBytes(retained[kind].value.candidate.bytes)),'Export must preserve exact retained package');
    const zip=await JSZip.loadAsync(bytes),members=Object.values(zip.files).filter(file=>!file.dir&&(kind==='word'?file.name==='word/document.xml':kind==='sheet'?/^xl\/(worksheets|sharedStrings)/.test(file.name):/^ppt\/slides\/slide\d+\.xml$/.test(file.name)));
    const xml=(await Promise.all(members.map(file=>file.async('string')))).join('\n');assert.equal(xml.split(markers[kind]).length-1,1,'Exact unsaved content must occur once in the exported Office XML');
    assert.deepEqual(await fs.readFile(path.join(offline,name)),originals[kind],'Immutable source changed');
  }
  await assert.rejects(fs.stat(project),{code:'ENOENT'});
  const report={ok:true,out,checks:['actual Word/Sheet/PPT engines edited after root loss','validated durable Office packages and PPT model','cold restart without source','recovery UI exact-byte exports parse with exact edited content','immutable original packages unchanged'],screenshots:Object.keys(fixtures).map(kind=>`recovery-${kind}.png`)};
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await fs.writeFile(path.join(out,'electron.log'),log);await stop();}
