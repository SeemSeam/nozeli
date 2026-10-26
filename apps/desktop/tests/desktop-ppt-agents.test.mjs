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
  await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelector('#selection-menu').hidden);
  await new Promise(r=>setTimeout(r,150));assert.equal(await page.$eval('#selection-menu',n=>n.hidden),true,'delayed callback must not reopen after Escape');
  const selectAgain=async()=>{const target=await frame.evaluateHandle(()=>[...document.querySelectorAll('.editable-element .ProseMirror')].find(n=>n.textContent.includes('NOZELI_INTEGRATED')));await target.asElement().click({count:2});await page.keyboard.press('Home');await page.keyboard.down('Shift');await page.keyboard.press('End');await page.keyboard.up('Shift');await page.waitForSelector('#selection-menu:not([hidden])');};
  await selectAgain();await page.click('#selection-explain');
  await page.waitForFunction(()=>document.querySelector('.word-note-overlay .tag-transcript')?.textContent.includes('Word Agent 测试回复'));
  await selectAgain();await page.click('#selection-discuss');
  await page.waitForSelector('.word-note-overlay .tag-discuss .tag-editor');
  await page.evaluate(()=>{const card=[...document.querySelectorAll('.word-note-overlay .note-anchor')].find(n=>[...n.querySelectorAll('.tag-composer .tag-send')].some(b=>b.textContent==='发送讨论'));const e=card.querySelector('.tag-editor');e.value='PPT_LOCATION_DISCUSS';e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.evaluate(()=>[...document.querySelectorAll('.word-note-overlay .tag-composer .tag-send')].find(n=>n.textContent==='发送讨论').click());
  await page.waitForFunction(()=>document.querySelectorAll('.word-note-overlay .tag-message-assistant').length===2);
  const agentLog=JSON.parse(await readFile(path.join(output,'profile','nozeli','v1','projects',projectId,'agent-log.json'),'utf8'));
  const requests=agentLog.requests.filter(r=>r.tagMaterials?.length);assert.equal(requests.length,2);
  for(const r of requests){const m=r.tagMaterials[0];assert.equal(m.relPath,'sample.pptx');assert.equal(m.information.location.page,1);assert.ok(m.information.location.object.id);assert.ok(m.information.location.context.quote.includes('NOZELI_INTEGRATED'));assert.ok(m.information.draft.digest);assert.equal(m.draftStatus,'unchanged');}
  checks.push('PPT explain/discuss deliver slide, object, quote and frozen draft');assert.deepEqual(errors,[]);
  await page.screenshot({path:path.join(output,'ppt-agent-location.png')});console.log(JSON.stringify({ok:true,output,checks,errors}));
}finally{
 await writeFile(path.join(output,'electron.log'),log);await browser?.disconnect();child.kill('SIGTERM');
}
