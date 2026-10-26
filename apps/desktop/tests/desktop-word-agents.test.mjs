import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'word-editor-'));
const project = path.join(output, 'project'); await mkdir(project);
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
const child = spawn(electron, ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root, env: { ...process.env, WAYLAND_DISPLAY:process.env.WAYLAND_DISPLAY||'wayland-0', XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR||'/run/user/1000', NOZELI_TEST_INSTANCE:'1', NOZELI_USER_DATA:path.join(output,'profile'), NOZELI_TEST_PICK:project, NOZELI_DEBUG_PORT:String(port), NOZELI_AGENT_FIXTURE:'1',NOZELI_AGENT_FIXTURE_REPLY:'1', NOZELI_HIDDEN:'0', NOZELI_OZONE:ozone }, stdio: ['ignore','pipe','pipe'],
});
let log=''; child.stdout.on('data',c=>{log+=c;});child.stderr.on('data',c=>{log+=c;});
const exited=new Promise(resolve=>child.once('exit',resolve));let browser,page;
const checks=[];
try {
  const deadline=Date.now()+20000;
  for (;;) { if(child.exitCode!==null)throw Error(log);try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}if(Date.now()>deadline)throw Error('startup timeout\n'+log);await new Promise(r=>setTimeout(r,100)); }
  browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,defaultViewport:null});page=(await browser.pages()).find(p=>p.url().includes('127.0.0.1'));
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.waitForFunction(()=>window.__nozeliReady);
  await page.click('#pick-project');await page.waitForSelector('#agent-setup[open]');
  const provider=await page.$eval('#agent-foreground option:not(:disabled)',n=>n.value);await page.select('#agent-foreground',provider);await page.select('#agent-background',provider);await page.$eval('#agent-setup-form',n=>n.requestSubmit());
  await page.waitForFunction(()=>!document.querySelector('#agent-setup').open);
  const projectId=await page.evaluate(async()=> (await window.nozeli.invoke('project.recent')).value.projects[0].id);
  const open=async rel=>{await page.click(`#file-tree button[data-path="${rel}"]`);await page.waitForFunction(rel=>document.querySelector('#file-path').textContent===rel,{},rel);};
  await open('sample.docx');
  await page.waitForSelector('#word-host iframe');
  const frame=page.frames().find(f=>f.url().endsWith('/word-frame.html'));
  await frame.waitForFunction(()=>window.nozeliWordEditor?.activeEditor?.state?.doc,{timeout:45000});
  await frame.evaluate(()=>{const e=window.nozeliWordEditor.activeEditor;e.commands.setTextSelection(1);e.view.focus();});
  await page.keyboard.type('NOZELI_DESKTOP_WORD ');
  await page.keyboard.sendCharacter('中文编辑验证 ');
  await page.keyboard.down('Control');await page.keyboard.press('s');await page.keyboard.up('Control');
  await frame.waitForFunction(()=>window.nozeliWordEditor.activeEditor.state.doc.textContent.includes('NOZELI_DESKTOP_WORD'));
  await open('read.md');
  const disk=await readFile(path.join(project,'sample.docx'));
  const JSZip=(await import('jszip')).default;const zip=await JSZip.loadAsync(disk);assert.match(await zip.file('word/document.xml').async('string'),/NOZELI_DESKTOP_WORD/);assert.match(await zip.file('word/document.xml').async('string'),/中文编辑验证/);
  await open('sample.docx');
  await page.waitForSelector('#word-host iframe');
  await page.waitForFunction(()=>document.querySelector('#word-host iframe')?.contentWindow?.nozeliWordEditor?.activeEditor?.state?.doc,{timeout:45000});
  const reopened=page.frames().find(f=>f.url().endsWith('/word-frame.html'));await reopened.waitForFunction(()=>window.nozeliWordEditor?.activeEditor?.state?.doc?.textContent.includes('NOZELI_DESKTOP_WORD'),{timeout:45000});
  await page.waitForFunction(()=>document.querySelector('#save-status')?.textContent?.includes('本地编辑') || document.body.innerText.includes('Word · 本地编辑'));
  await page.evaluate(()=>{window.wordMessages=[];addEventListener('message',e=>{if(e.data?.type==='selection')wordMessages.push(e.data);});});
  const selectionCoordinates=()=>reopened.evaluate(()=>{
   const walker=document.createTreeWalker(document.querySelector('#document'),NodeFilter.SHOW_TEXT);let node;
   while(node=walker.nextNode()){const i=node.textContent.indexOf('原始首句');if(i<0)continue;const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+4);const r=range.getBoundingClientRect();if(r.width&&r.x>=0){node.parentElement.scrollIntoView({block:'center'});const box=range.getBoundingClientRect();return {a:{x:box.left+1,y:(box.top+box.bottom)/2},b:{x:box.right-1,y:(box.top+box.bottom)/2}};}}
   throw Error('No visible Word text');
  });
  let range=await selectionCoordinates();
  let box=await page.$eval('#word-host iframe',n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y};});
  await page.mouse.move(box.x+range.a.x,box.y+range.a.y);await page.mouse.down();await page.mouse.move(box.x+range.b.x,box.y+range.b.y,{steps:12});await page.mouse.up();
  await page.waitForSelector('#selection-menu.word-selection-menu:not([hidden])');
  assert.notEqual(await page.$eval('#selection-discuss',n=>getComputedStyle(n).display),'none');
  assert.equal(await reopened.$('#word-add-note'),null);
  assert.equal(await reopened.$('.word-modes'),null);
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('#selection-menu').hidden);
  range=await selectionCoordinates();
  box=await page.$eval('#word-host iframe',n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y};});
  await page.mouse.move(box.x+range.a.x,box.y+range.a.y);await page.mouse.down();await page.mouse.move(box.x+range.b.x,box.y+range.b.y,{steps:12});await page.mouse.up();
  await page.waitForSelector('#selection-menu.word-selection-menu:not([hidden])');

  await page.click('#selection-discuss');
  await page.waitForSelector('.word-note-overlay .tag-discuss:not([hidden]) .tag-editor');
  await page.click('.word-note-overlay .tag-discuss .tag-editor');await page.keyboard.type('WORD_DISCUSS_QUESTION');
  await page.evaluate(()=>[...document.querySelectorAll('.word-note-overlay .tag-composer .tag-send')].find(n=>n.textContent==='发送讨论').click());
  await page.waitForFunction(()=>document.querySelector('.word-note-overlay .tag-transcript')?.textContent.includes('Word Agent 测试回复'));
  const messages=await page.evaluate(async projectId=>(await window.nozeli.invoke('agents.messages',{projectId})).value.messages,projectId);
  assert.ok(messages.some(m=>m.text.includes('WORD_DISCUSS_QUESTION')&&m.text.includes('原始首句')));
  await page.click('.word-note-overlay .tag-discuss .tag-editor');await page.keyboard.type('SECOND_ROUND');
  await page.evaluate(()=>[...document.querySelectorAll('.word-note-overlay .tag-composer .tag-send')].find(n=>n.textContent==='发送续问').click());
  await page.waitForFunction(()=>document.querySelectorAll('.word-note-overlay .tag-message-assistant').length===2);
  await open('read.md');await open('sample.docx');
  await page.waitForFunction(()=>document.querySelectorAll('.word-note-overlay .tag-message-assistant').length===2);

  await page.click('.word-note-overlay .tag-window-title',{count:2});
  await page.waitForSelector('.word-note-overlay .is-collapsed');
  const again=page.frames().find(f=>f.url().endsWith('/word-frame.html'));
  await again.evaluate(()=>{const e=nozeliWordEditor.activeEditor;let range;e.state.doc.descendants((n,pos)=>{if(n.isText){const i=n.text.indexOf('原始首句');if(i>=0)range={from:pos+i,to:pos+i+4};}});e.commands.setTextSelection(range);e.view.focus();});
  await page.waitForSelector('#selection-menu:not([hidden])');
  await page.waitForFunction(()=>!document.querySelector('#selection-explain').disabled);
  await page.click('#selection-explain');
  await page.waitForFunction(()=>[...document.querySelectorAll('.word-note-overlay .tag-transcript')].filter(n=>n.textContent.includes('Word Agent 测试回复')).length===2);
  const result=await page.evaluate(async projectId=>(await window.nozeli.invoke('annotation.list',{projectId,relPath:'sample.docx'})).value.annotations,projectId);
  assert.equal(result.filter(n=>n.projection&&n.kind==='word-selection').length,2);
  const agentLog=JSON.parse(await readFile(path.join(output,'profile','nozeli','v1','projects',projectId,'agent-log.json'),'utf8'));
  const anchored=agentLog.requests.filter(r=>r.tagMaterials?.length);
  assert.equal(anchored.length,3,'discussion, followup and explain all carry frozen location');
  for(const request of anchored){const m=request.tagMaterials[0];assert.equal(m.relPath,'sample.docx');assert.equal(m.kind,'word-selection');assert.equal(m.information.location.context.quote,'原始首句');assert.ok(m.origin.materialDigest);assert.ok(m.information.location.renderedPage>0);}
  const beforeRemove=await page.evaluate(async projectId=>(await window.nozeli.invoke('agents.messages',{projectId})).value.messages.length,projectId);
  await page.$eval('.word-note-overlay .tag-discuss .tag-remove',n=>n.click());
  await page.waitForSelector('#action-confirmation[open]');await page.click('#action-confirmation-accept');
  await page.waitForFunction(()=>document.querySelectorAll('.word-note-overlay .tag-discuss').length===1);
  await open('read.md');await open('sample.docx');
  await page.waitForFunction(()=>document.querySelectorAll('.word-note-overlay .tag-discuss').length===1);
  assert.equal(await page.evaluate(async projectId=>(await window.nozeli.invoke('agents.messages',{projectId})).value.messages.length,projectId),beforeRemove);
  assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,'word-agents.png')});
  console.log(JSON.stringify({ok:true,output,checks:['one shared menu, no independent note button','discussion real UI sends selected quote through host','fixture reply renders Markdown in floating card','reopen restores conversation and reply','explain sends selection and renders reply','two conversation projections persisted','all three prompts freeze Word quote, file, rendered page and version','remove projection and reopen preserve conversation history'],errors}));
} catch(error){console.log('WORD',await page?.frames().find(f=>f.url().endsWith('/word-frame.html'))?.evaluate(()=>({native:getSelection()?.toString(),selection:nozeliWordEditor.activeEditor.state.selection.toJSON(),active:document.activeElement?.outerHTML.slice(0,200)})));console.log(await page?.evaluate(()=>({messages:window.wordMessages,body:document.body.innerText.slice(-2200)})));throw error;} finally {await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}
