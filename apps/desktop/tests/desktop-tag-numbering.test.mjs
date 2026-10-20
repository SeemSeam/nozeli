import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'tag-numbering-'));
const project = path.join(output, 'project'); await mkdir(project);
const code = 'const first={a:1};\nconst second={b:2};\nconsole.log(first, second);\n';
await writeFile(path.join(project,'main.ts'),code);
await writeFile(path.join(project,'note.txt'),'Plain text selection\nSecond line');
await writeFile(path.join(project,'read.md'),'# Reading sample\n\nUnique reading sentence.\n\nOther paragraph.\n');
await writeFile(path.join(project,'test.cpp'),'int main(){return 0;}\n');
await writeFile(path.join(project,'sample.pdf'),await readFile(path.resolve(root,'tests/fixtures/pdf/nozeli-sample.zh.pdf')));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const electron = createRequire(import.meta.url)('electron');
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(electron, ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root, env: { ...process.env, WAYLAND_DISPLAY:process.env.WAYLAND_DISPLAY||'wayland-0', XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR||'/run/user/1000', NOZELI_TEST_INSTANCE:'1', NOZELI_USER_DATA:path.join(output,'profile'), NOZELI_TEST_PICK:project, NOZELI_DEBUG_PORT:String(port), NOZELI_AGENT_FIXTURE:'1', NOZELI_HIDDEN:'0', NOZELI_OZONE:ozone }, stdio: ['ignore','pipe','pipe'],
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
  const checks=[];
  await open('test.cpp');
  for (const text of ['note one','note two']) {
    await page.evaluate(()=>{window.__nozeliInput.focus();window.__nozeliInput.select(0,3);});
    await page.$eval('#selection-note',n=>n.click());await page.type('#note-input',text);await page.$eval('#add-note',n=>n.click());
    await page.waitForFunction(text=>[...document.querySelectorAll('#text-host .tag-note')].some(n=>n.textContent.includes(text)),{},text);
  }
  for (let index=1;index<=2;index++) {
    await page.evaluate(()=>{window.__nozeliInput.focus();window.__nozeliInput.select(11,17);});await page.$eval('#selection-discuss',n=>n.click());
    await page.waitForFunction(count=>document.querySelectorAll('#text-host .tag-discuss').length===count,{},index);
  }
  const snapshot=()=>page.$$eval('#text-host .note-anchor',ns=>ns.map(n=>({id:n.dataset.annotation,kind:n.classList.contains('tag-note')?'note':'agent',index:n.querySelector('.note-index').textContent,card:n.querySelector('.tag-ordinal').textContent,border:getComputedStyle(n.querySelector('.note-index')).borderColor,bg:getComputedStyle(n.querySelector('.note-index')).backgroundColor,cardBg:getComputedStyle(n.querySelector('.tag-ordinal')).backgroundColor})));
  let tags=await snapshot();
  for(const kind of ['note','agent'])assert.deepEqual(tags.filter(t=>t.kind===kind).map(t=>t.index),['1','2']);
  assert.ok(tags.every(t=>t.index===t.card));assert.equal(new Set(tags.map(t=>t.border)).size,1);assert.equal(new Set(tags.map(t=>t.bg)).size,2);assert.ok(tags.every(t=>t.bg===t.cardBg));
  checks.push('two independent sequences and red rings with category-specific fills');
  const n1=tags.find(t=>t.kind==='note').id,c1=tags.find(t=>t.kind==='agent').id;
  await page.evaluate(async({projectId,n1})=>{const r=await window.nozeli.invoke('annotation.remove',{projectId,annotationId:n1});if(!r.ok)throw Error(r.error.message);},{projectId,n1});
  await page.$eval(`[data-annotation="${c1}"] .tag-remove`,n=>n.click());
  await page.waitForSelector('#action-confirmation[open]');await page.click('#action-confirmation-accept');
  await page.waitForFunction(id=>!document.querySelector(`[data-annotation="${id}"]`),{},c1);
  await open('note.txt');await open('test.cpp');
  await page.waitForFunction(()=>document.querySelectorAll('#text-host .note-anchor').length===2);
  tags=await snapshot();assert.ok(tags.every(t=>t.index==='1'&&t.card==='1'));checks.push('delete one of each kind closes both gaps on reopening');
  await page.reload();await page.waitForFunction(()=>window.__nozeliReady);await page.waitForSelector('#text-host .note-anchor');tags=await snapshot();assert.ok(tags.every(t=>t.index==='1'));checks.push('reload reproduces independent display numbering');
  await page.screenshot({path:path.join(output,'tag-numbering.png')});assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'result.json'),JSON.stringify({ok:true,checks},null,2));console.log(JSON.stringify({ok:true,output,checks}));
} catch(error){await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});throw error;} finally{await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}
