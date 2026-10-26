import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'pdf-agents-'));
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
  await open('sample.pdf');await page.waitForSelector('#pdf-host .textLayer span');
  const select=async(index=0)=>{const r=await page.$$eval('#pdf-host .textLayer span',(nodes,index)=>{const n=nodes.filter(n=>n.textContent.trim())[index];n.scrollIntoView({block:'center'});const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};},index);await page.mouse.move(r.x+2,r.y+r.h/2);await page.mouse.down();await page.mouse.move(r.x+Math.max(12,r.w-2),r.y+r.h/2,{steps:10});await page.mouse.up();await page.waitForSelector('#selection-menu:not([hidden])');};
  await select();await page.click('#selection-explain');await page.waitForFunction(()=>document.querySelector('#pdf-host .tag-message-assistant'));
  await page.click('#pdf-host .tag-window-title',{count:2});
  await select(2);await page.click('#selection-discuss');await page.waitForFunction(()=>[...document.querySelectorAll('#pdf-host .tag-composer .tag-send')].some(n=>n.textContent==='发送讨论'));
  await page.evaluate(()=>{const card=[...document.querySelectorAll('#pdf-host .note-anchor')].find(n=>[...n.querySelectorAll('.tag-composer .tag-send')].some(b=>b.textContent==='发送讨论'));const e=card.querySelector('.tag-editor');e.value='PDF_LOCATION';e.dispatchEvent(new Event('input',{bubbles:true}));[...card.querySelectorAll('button')].find(n=>n.textContent==='发送讨论').click();});
  await page.waitForFunction(()=>document.querySelectorAll('#pdf-host .tag-message-assistant').length===2);
  const log=JSON.parse(await readFile(path.join(output,'profile','nozeli','v1','projects',projectId,'agent-log.json'),'utf8'));const requests=log.requests.filter(r=>r.tagMaterials?.length);assert.equal(requests.length,2);
  for(const r of requests){const m=r.tagMaterials[0];assert.equal(m.relPath,'sample.pdf');assert.equal(m.kind,'pdf-selection');assert.equal(m.information.location.page,1);assert.ok(m.information.location.anchor.quote);assert.ok(m.information.location.anchor.rects.length);assert.ok(m.origin.materialDigest);}
  assert.deepEqual(errors,[]);await page.screenshot({path:path.join(output,'pdf-agent-location.png')});console.log(JSON.stringify({ok:true,output,checks:['PDF physical text selection, discuss/explain receive page/rectangles/quote/version'],errors}));
}finally{await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}
