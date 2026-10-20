import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'tag-position-'));
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
  await open('main.ts');await page.waitForSelector('#text-host .monaco-editor');
  await page.evaluate(()=>{window.__nozeliInput.focus();window.__nozeliInput.select(0,37);});
  await page.$eval('#selection-note',n=>n.click());await page.type('#note-input','Position check');await page.$eval('#add-note',n=>n.click());
  await page.waitForSelector('#text-host .tag-note .note-index');
  const measure=()=>page.evaluate(()=>{
    const line=document.querySelector('#text-host .view-line').getBoundingClientRect();
    const ring=document.querySelector('#text-host .tag-note .note-index').getBoundingClientRect();
    const editor=document.querySelector('#text-host .monaco-editor').getBoundingClientRect();
    const hit=document.elementFromPoint(ring.left+8,ring.top+8);
    return {hit:hit?.classList.contains('note-index'),dx:ring.left-line.left,dy:ring.top-line.top,inside:ring.top>=editor.top,line:line.toJSON(),ring:ring.toJSON()};
  });
  let result=await measure();assert.ok(Math.abs(result.dx+18)<2,JSON.stringify(result));assert.ok(Math.abs(result.dy+12)<2,JSON.stringify(result));assert.ok(result.inside);assert.ok(result.hit,JSON.stringify(result));checks.push('multiline selection anchors ring 18px left and 12px above first selected line, visible on line 1');
  await page.$eval('#text-host .tag-note .tag-close',n=>n.click());let collapsed=await measure();assert.equal(collapsed.dx,result.dx);assert.equal(collapsed.dy,result.dy);
  await page.$eval('#text-host .tag-note .tag-close',n=>n.click());let expanded=await measure();assert.equal(expanded.dx,result.dx);assert.equal(expanded.dy,result.dy);checks.push('collapse and expand preserve anchor position');
  await page.screenshot({path:path.join(output,'top-left-ring.png')});assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,output,checks}));
} finally {await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}
