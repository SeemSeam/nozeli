import { contentToolForPage, openContentToolsForPage } from './native-content-tools.fixture.mjs';
import {prepareReading, waitForDesktopPage, waitForReadingProject} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'ppt-editor-'));
const project = path.join(output, 'project'); await mkdir(project);
await writeFile(path.join(project,'sample.pptx'),await readFile(path.resolve(root,'tests/fixtures/ppt/compatibility.pptx')));
const original=await readFile(path.join(project,'sample.pptx'));
const code = 'const first={a:1};\nconst second={b:2};\nconsole.log(first, second);\n';
await writeFile(path.join(project,'main.ts'),code);
await writeFile(path.join(project,'note.txt'),'Plain text selection\nSecond line');
await writeFile(path.join(project,'read.md'),'# Reading sample\n\nUnique reading sentence.\n\nOther paragraph.\n');
await writeFile(path.join(project,'test.cpp'),'int main(){return 0;}\n');
await writeFile(path.join(project,'sample.pdf'),await readFile(path.resolve(root,'tests/fixtures/pdf/nozeli-sample.zh.pdf')));
await writeFile(path.join(project,'sample.docx'),await readFile(path.resolve(root,'tests/fixtures/office/中文 文档.docx')));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const electron = createRequire(import.meta.url)('electron');
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(electron, ['--inspect=0','--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root, env: { ...process.env, WAYLAND_DISPLAY:process.env.WAYLAND_DISPLAY||'wayland-0', XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR||'/run/user/1000', NOZELI_TEST_INSTANCE:'1', NOZELI_USER_DATA:path.join(output,'profile'), NOZELI_TEST_PICK:project, NOZELI_DEBUG_PORT:String(port), NOZELI_AGENT_FIXTURE:'1', NOZELI_HIDDEN:'0', NOZELI_OZONE:ozone }, stdio: ['ignore','pipe','pipe'],
});
let log=''; child.stdout.on('data',c=>{log+=c;});child.stderr.on('data',c=>{log+=c;});
const exited=new Promise(resolve=>child.once('exit',resolve));let browser,page;
const checks=[];
try {
  const deadline=Date.now()+20000;
  for (;;) { if(child.exitCode!==null)throw Error(log);try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}if(Date.now()>deadline)throw Error('startup timeout\n'+log);await new Promise(r=>setTimeout(r,100)); }
  browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});page=await waitForDesktopPage(browser);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>window.__nozeliReady);
  await prepareReading(page);await page.click('#pick-project');
  const projectId=await waitForReadingProject(page,project);
  const open=async rel=>{await page.click(`#file-tree button[data-path="${rel}"]`);await page.waitForFunction(rel=>document.querySelector('#file-path').textContent===rel,{},rel);};

  await open('sample.pptx');
  await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('本地编辑'),{timeout:60000});
  let frame=page.frames().find(f=>f.url().includes('/ppt-vendor/'));
  assert.equal(await frame.evaluate(()=>__nozeliPptist.store.slides.length),3);
  const el=await frame.evaluateHandle(()=>[...document.querySelectorAll('.editable-element .ProseMirror')].find(n=>n.textContent.includes('NOZELI_PPTIST_TITLE')));
  await el.asElement().click({count:2});await page.keyboard.down('Control');await page.keyboard.press('a');await page.keyboard.up('Control');await page.keyboard.type('NOZELI_INTEGRATED ');await page.keyboard.sendCharacter('中文编辑');await page.keyboard.press('Escape');
  await frame.waitForFunction(()=>JSON.stringify(__nozeliPptist.store.slides).includes('NOZELI_INTEGRATED'));
  await open('read.md');await open('sample.pptx');
  await page.waitForFunction(()=>document.querySelector('#save-status').textContent.includes('已恢复草稿'),{timeout:60000});
  frame=page.frames().find(f=>f.url().includes('/ppt-vendor/'));
  assert.match(await frame.evaluate(()=>JSON.stringify(__nozeliPptist.store.slides)),/NOZELI_INTEGRATED/);
  checks.push('real file-tree PPTX open, Chinese keyboard edit, switch away and draft restore');
  // Real text drag selection inside the embedded presentation.
  const title=await frame.evaluateHandle(()=>[...document.querySelectorAll('.editable-element .ProseMirror')].find(n=>n.textContent.includes('NOZELI_INTEGRATED')));await title.asElement().click({count:2});
  const coords=await frame.evaluate(()=>{const root=[...document.querySelectorAll('.editable-element .ProseMirror')].find(n=>n.textContent.includes('NOZELI_INTEGRATED'));const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const i=n.textContent.indexOf('NOZELI_INTEGRATED');if(i>=0){const r=document.createRange();r.setStart(n,i+7);r.setEnd(n,i+16);const b=r.getBoundingClientRect();return {x:b.left+1,y:(b.top+b.bottom)/2,end:b.right-1};}}});
  const fb=await page.$eval('#ppt-frame',n=>{const b=n.getBoundingClientRect();return{x:b.x,y:b.y}});
  await page.mouse.move(fb.x+coords.x,fb.y+coords.y);await page.mouse.down();await page.mouse.move(fb.x+coords.end,fb.y+coords.y,{steps:12});await page.mouse.up();
  await page.waitForSelector('#selection-menu:not([hidden])');
  assert.match(await frame.evaluate(()=>getSelection().toString()),/INTEGRAT/);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelector('#selection-menu').hidden);
  await new Promise(r=>setTimeout(r,150));assert.equal(await page.$eval('#selection-menu',n=>n.hidden),true,'delayed callback must not reopen after Escape');
  await page.keyboard.press('Home');await page.keyboard.down('Shift');await page.keyboard.press('End');await page.keyboard.up('Shift');
  await page.waitForSelector('#selection-menu:not([hidden])');assert.match(await frame.evaluate(()=>getSelection().toString()),/NOZELI_INTEGRATED/);
  await page.keyboard.press('Escape');checks.push('fresh keyboard selection resumes annotations after Escape without another pointer action');
  const selectAgain=async()=>{const target=await frame.evaluateHandle(()=>[...document.querySelectorAll('.editable-element .ProseMirror')].find(n=>n.textContent.includes('NOZELI_INTEGRATED')));await target.asElement().click({count:2});await page.keyboard.press('Home');await page.keyboard.down('Shift');await page.keyboard.press('End');await page.keyboard.up('Shift');await page.waitForSelector('#selection-menu:not([hidden])');};
  await selectAgain();await frame.evaluate(()=>getSelection().removeAllRanges());await page.waitForFunction(()=>document.querySelector('#selection-menu').hidden);
  await selectAgain();await frame.click('.canvas',{offset:{x:8,y:8}});await page.waitForFunction(()=>document.querySelector('#selection-menu').hidden);
  await selectAgain();await frame.evaluate(()=>{__nozeliPptist.store.slideIndex=1});await page.waitForFunction(()=>document.querySelector('#selection-menu').hidden);await frame.evaluate(()=>{__nozeliPptist.store.slideIndex=0});
  await selectAgain();checks.push('selection menu dismisses on Escape, empty selection, canvas click and slide change; no delayed reopen');
  await page.waitForSelector('#selection-menu:not([hidden])');await page.click('#selection-note');await page.waitForSelector('#note-form:not([hidden])');await page.type('#note-input','PPT 文字备注');await page.click('#add-note');await page.waitForSelector('.word-note-overlay .note-anchor:not([hidden])');
  await contentToolForPage(page, ['view', 'region']);
  const canvas=await frame.$eval('.canvas .viewport-wrapper',n=>{const b=n.getBoundingClientRect();return{x:b.x+20,y:b.y+60}});
  await page.mouse.move(fb.x+canvas.x,fb.y+canvas.y);await page.mouse.down();await page.mouse.move(fb.x+canvas.x+80,fb.y+canvas.y+45,{steps:10});await page.mouse.up();
  await page.waitForSelector('#selection-menu:not([hidden])');await page.click('#selection-note');await page.waitForSelector('#note-form:not([hidden])');await page.type('#note-input','PPT 区域备注');await page.click('#add-note');await page.waitForFunction(()=>document.querySelectorAll('.word-note-overlay .note-anchor').length===2);
  await frame.evaluate(()=>{__nozeliPptist.store.slideIndex=1});await page.waitForFunction(()=>document.querySelectorAll('.word-note-overlay .note-anchor:not([hidden])').length===0);
  await frame.evaluate(()=>{__nozeliPptist.store.slideIndex=0});await page.waitForSelector('.word-note-overlay .note-anchor:not([hidden])');
  await open('read.md');await open('sample.pptx');await page.waitForFunction(()=>document.querySelectorAll('.word-note-overlay .note-anchor').length===2,{timeout:60000});
  frame=page.frames().find(f=>f.url().includes('/ppt-vendor/'));assert.match(await page.$eval('.word-note-overlay',n=>n.textContent),/PPT 文字备注/);assert.match(await page.$eval('.word-note-overlay',n=>n.textContent),/PPT 区域备注/);
  checks.push('physical PPT text selection and region notes; slide isolation and reopen persistence');
  const notes=await page.evaluate(projectId=>window.nozeli.invoke('annotation.list',{projectId,relPath:'sample.pptx'}),projectId);assert.equal(notes.ok,true,JSON.stringify(notes));
  for(const note of notes.value.annotations){const packet=await page.evaluate(({projectId,id})=>window.nozeli.invoke('tag.material',{projectId,relPath:'sample.pptx',annotationId:id}),{projectId,id:note.id});assert.equal(packet.ok,true,JSON.stringify(packet));assert.match(packet.value.note,/PPT/);assert.equal(packet.value.information.location.page,1);assert.ok(packet.value.information.draft.digest);if(note.kind==='ppt-region'){const asset=packet.value.information.assets[0];assert.equal(asset.mime,'image/png');const png=await readFile(path.join(project,asset.relPath));assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.ok(asset.width>20&&asset.height>20);}}
  checks.push('agent packet contains note, page, frozen draft and actual captured region PNG');


  assert.deepEqual(await readFile(path.join(project,'sample.pptx')),original);
  // Real export bytes and host file write; only native save dialog choice is automated.
  const WebSocket=(await import('ws')).default;
  const ws=new WebSocket(log.match(/Debugger listening on (ws:\/\/[^\s]+)/)[1]);await new Promise(r=>ws.once('open',r));
  const expression=`process.mainModule.require('electron').dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(path.join(project,'exported.pptx'))}})`;
  await new Promise(resolve=>{ws.on('message',raw=>{if(JSON.parse(raw).id===1)resolve();});ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression}}));});
  await openContentToolsForPage(page);await page.click('#document-context-menu [data-command=file]');await page.click('.nozeli-submenu [data-command=exportPpt]');
  const until=Date.now()+45000;let exported;
  for(;;){try{exported=await readFile(path.join(project,'exported.pptx'));break;}catch{}if(Date.now()>until)throw Error('export timeout');await new Promise(r=>setTimeout(r,100));}
  // Choose the original path: host must refuse even when the native dialog allows it.
  await new Promise(resolve=>{ws.on('message',raw=>{if(JSON.parse(raw).id===2)resolve();});ws.send(JSON.stringify({id:2,method:'Runtime.evaluate',params:{expression:`process.mainModule.require('electron').dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(path.join(project,'sample.pptx'))}})`}}));});
  // Reuse the captured document digest from the independent draft file.
  const fsExtra=await import('node:fs/promises');const draftNames=await fsExtra.readdir(path.join(output,'profile/ppt-drafts'));const draftRecord=JSON.parse(await readFile(path.join(output,'profile/ppt-drafts',draftNames[0]),'utf8'));
  const protectedResult=await page.evaluate(async ({projectId,digest,bytes})=>window.nozeli.invoke('ppt.export',{projectId,relPath:'sample.pptx',digest,bytes}),{projectId,digest:draftRecord.sourceDigest,bytes:Array.from(exported)});assert.equal(protectedResult.ok,false);assert.match(protectedResult.error.message,/不能覆盖/);
  const mismatch=await page.evaluate(async projectId=>window.nozeli.invoke('ppt.draft',{projectId,relPath:'sample.pptx',digest:'f'.repeat(64)}),projectId);assert.equal(mismatch.value,null);
  assert.deepEqual(await readFile(path.join(project,'sample.pptx')),original);checks.push('original overwrite rejected; different source digest cannot restore stale draft');
  ws.close();const JSZip=(await import('jszip')).default;const zip=await JSZip.loadAsync(exported);assert.match(await zip.file('ppt/slides/slide1.xml').async('string'),/NOZELI_INTEGRATED/);
  assert.doesNotMatch(await zip.file('ppt/slides/slide1.xml').async('string'),/NOZELI_PPTIST_TITLE/);
  checks.push('host export to independent PPTX contains edited text; source unchanged');
  const noteCards=await page.$$('.word-note-overlay .note-anchor');await (await noteCards[1].$('.tag-window-title')).click({count:2});await page.waitForSelector('.word-note-overlay .is-collapsed');
  await (await noteCards[1].$('.note-projection-content')).click({count:2});await page.waitForFunction(()=>!document.querySelector('.word-note-overlay .is-collapsed'));
  await page.screenshot({path:path.join(output,'ppt-integrated.png')});
  await frame.evaluate(()=>{const s=__nozeliPptist.store.slides[0];s.elements=s.elements.filter(e=>!(e.content||e.text?.content||'').includes('NOZELI_INTEGRATED'))});
  await page.waitForSelector('.word-note-overlay [data-location="unresolved"] .ppt-anchor-status');
  assert.equal(await page.$$('.word-note-overlay .note-anchor').then(x=>x.length),2);checks.push('double-click collapse/expand; deleted text and changed region retain unresolved notes');

  await page.click('#close-subject');await page.waitForSelector('#action-confirmation[open]');await page.click('#action-confirmation-accept');await page.waitForFunction(()=>!document.querySelector('#ppt-frame'));assert.equal(await page.$('#ppt-frame'),null);
  checks.push('close disposes PPT iframe');
  console.log(JSON.stringify({ok:true,output,checks,errors}));
}catch(error){
  await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});
  const diagnostics=await page?.evaluate(()=>{
    const w=document.querySelector('#ppt-frame')?.contentWindow,s=w?.getSelection();
    return {status:document.querySelector('#save-status')?.textContent,menu:document.querySelector('#selection-menu')?.outerHTML,selection:s?.toString(),anchor:s?.anchorNode?.parentElement?.outerHTML.slice(0,800),focus:s?.focusNode?.parentElement?.outerHTML.slice(0,800),active:w?.document.activeElement?.outerHTML.slice(0,600),body:document.body.innerText.slice(-1000)};
  }).catch(()=>null);
  await writeFile(path.join(output,'failure.json'),JSON.stringify({error:error.stack,diagnostics},null,2));
  console.log(JSON.stringify({ok:false,output,diagnostics}));throw error;
}finally{
 await writeFile(path.join(output,'electron.log'),log);await browser?.disconnect();child.kill('SIGTERM');
}
