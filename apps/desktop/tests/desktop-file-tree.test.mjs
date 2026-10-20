import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, symlink, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';

const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'file-tree-'));
// File-tree regression owns an isolated copy and does not start paid Providers.
const root = path.join(output, 'app'); await mkdir(root);
for (const item of ['src','tools','package.json']) await cp(path.join(source,item),path.join(root,item),{recursive:true});
for (const item of ['node_modules','vendor','assets']) await symlink(path.join(source,item),path.join(root,item),'dir');
// Expose only idle observation in the private app; keep every real operation.
const actionsPath=path.join(root,'src/renderer/file-tree-actions.mjs');
await writeFile(actionsPath,(await readFile(actionsPath,'utf8')).replace('paint();return {paint};','window.__fileTreeIdle=()=>!busy;paint();return {paint};'));
const build = spawn(process.execPath,[path.join(root,'tools/build-renderer.mjs')],{cwd:root,stdio:'ignore'});
assert.equal(await new Promise(resolve=>build.once('exit',resolve)),0);
const project = path.join(output, 'project');
await mkdir(path.join(project, 'src'), { recursive: true });
await mkdir(path.join(project, 'dest'));
await writeFile(path.join(project,'src','note.txt'),'Original text');
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const electron = createRequire(import.meta.url)('electron');
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(electron, ['--inspect=0', '--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, XDG_RUNTIME_DIR: '/run/user/1000', WAYLAND_DISPLAY: 'wayland-0', NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
const exited = new Promise(resolve => child.once('exit', resolve));
let browser;
const checks = [];
let screenshot;
let completionScreenshot;
try {
  const deadline = Date.now() + 20000;
  for (;;) { if (child.exitCode !== null) throw new Error(log); try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} if (Date.now() > deadline) throw new Error('startup timeout\n' + log); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport:null });
  const page = await waitForDesktopPage(browser);
  page.on('pageerror', error => console.error('RENDERER', error.stack));
  await page.waitForFunction(() => window.__nozeliReady, { polling: 100 });
  await prepareReading(page);

  await page.click('#pick-project');
  await page.waitForSelector('#file-tree button');await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-toggle').click(); });
  const selector = rel => '#file-tree button[data-path="' + rel + '"]';
  // Inspect the native Menu in this isolated test process, then activate its
  // command callback. OS-native menu surfaces cannot be clicked through CDP.
  const inspectorUrl = log.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1];
  assert.ok(inspectorUrl, log);
  const inspector = new WebSocket(inspectorUrl);
  await new Promise((resolve,reject)=>{inspector.once('open',resolve);inspector.once('error',reject);});
  let sequence=0;
  const evaluateMain = expression => new Promise((resolve,reject)=>{
    const id=++sequence;const receive=raw=>{const r=JSON.parse(raw);if(r.id===id){inspector.off('message',receive);if(r.result?.exceptionDetails)reject(Error(JSON.stringify(r)));else resolve(r.result?.result?.value);}};
    inspector.on('message',receive);inspector.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true}}));
  });
  await page.click(selector('dest'));
  await page.waitForFunction(sel=>document.querySelector(sel)?.getAttribute('aria-expanded')==='false',{polling:50},selector('dest'));
  await page.click(selector('dest'),{button:'right'});
  assert(await page.$('#file-tree-menu [data-command=createFolder]'));await page.click('#file-tree-menu [data-command=createFile]');
  await page.waitForSelector('#file-tree-dialog[open]');
  await page.type('#file-tree-name','created.txt');await page.click('#file-tree-dialog button[type="submit"]');
  await page.waitForSelector(selector('dest/created.txt'));
  // Creating inside a collapsed folder must expand it so the new entry is visible.
  assert.equal(await page.$eval(selector('dest'),node=>node.getAttribute('aria-expanded')),'true');
  assert.equal(await page.$eval(selector('dest/created.txt'),node=>!node.hidden&&!!node.offsetParent),true);
  assert.equal(await readFile(path.join(project,'dest','created.txt'),'utf8'),'');

  checks.push('physical right click opens unified directory menu; command creates a real file');
  await page.click(selector('src/note.txt'));await page.waitForFunction(()=>window.__nozeliInput.text()==='Original text');
  await page.evaluate(()=>window.__nozeliInput.insert(' external saved'));
  await evaluateMain(`globalThis.__openOriginal=process.mainModule.require('electron').shell.openPath;
    process.mainModule.require('electron').shell.openPath=async p=>{globalThis.__openedPath=p;globalThis.__openedText=process.mainModule.require('node:fs').readFileSync(p,'utf8');return '';};`);
  await page.click(selector('src/note.txt'),{button:'right'});
  assert(await page.$('#file-tree-menu [data-command=openExternal]'));await page.click('#file-tree-menu [data-command=openExternal]');
  const openedDeadline=Date.now()+5000;while(!(await evaluateMain('globalThis.__openedPath||null'))){if(Date.now()>openedDeadline)throw Error('external open not invoked');await new Promise(r=>setTimeout(r,50));}
  assert.equal(await evaluateMain('globalThis.__openedText'),'Original text external saved');

  await evaluateMain(`process.mainModule.require('electron').shell.openPath=async()=> 'No associated application';`);
  const id=await page.evaluate(async()=>(await window.nozeli.invoke('project.recent')).value.projects[0].id);
  const failed=await page.evaluate(projectId=>window.nozeli.invoke('tree.path',{projectId,relPath:'src/note.txt',action:'openExternal'}),id);assert.equal(failed.ok,false);assert.match(failed.error.message,/No associated application/);
  const escaped=await page.evaluate(projectId=>window.nozeli.invoke('tree.path',{projectId,relPath:'../escape.docx',action:'openExternal'}),id);assert.equal(escaped.ok,false);
  await evaluateMain(`process.mainModule.require('electron').shell.openPath=globalThis.__openOriginal`);
  if(process.env.NOZELI_REAL_DEFAULT_APP==='1'){
    await writeFile(path.join(project,'默认打开 Word.docx'),await readFile(path.resolve(root,'tests/fixtures/office/中文 文档.docx')));
    const launched=await page.evaluate(projectId=>window.nozeli.invoke('tree.path',{projectId,relPath:'默认打开 Word.docx',action:'openExternal'}),id);assert.equal(launched.ok,true,JSON.stringify(launched));checks.push('actual Linux system default app accepted DOCX launch');
  }
  checks.push('native default-app action flushes unsaved text; missing handler and traversal return errors');

  inspector.close();
  if(process.env.NOZELI_DEFAULT_OPEN_ONLY==='1'){console.log(JSON.stringify({ok:true,output,checks}));} else {
  const key = async (rel, combo) => {
    await page.waitForFunction(()=>window.__fileTreeIdle?.());
    await page.focus(selector(rel));
    if(combo.startsWith('Control+')){await page.keyboard.down('Control');await page.keyboard.press(combo.slice(8));await page.keyboard.up('Control');}
    else await page.keyboard.press(combo);
  };
  await page.waitForFunction(()=>window.__nozeliInput.text()==='Original text external saved');
  await page.evaluate(()=>window.__nozeliInput.insert(' saved edit'));
  await key('src/note.txt','F2');await page.waitForSelector('#file-tree-dialog[open]');
  await page.$eval('#file-tree-name',n=>{n.value='renamed.txt';});
  await page.click('#file-tree-dialog button[type="submit"]');
  await page.waitForSelector(selector('src/renamed.txt'));
  await page.waitForFunction(()=>document.querySelector('#file-path').textContent==='src/renamed.txt');
  assert.equal(await readFile(path.join(project,'src','renamed.txt'),'utf8'),'Original text external saved saved edit');
  checks.push('F2 renames the active file after saving its latest edit');
  await key('src/renamed.txt','Control+c');await key('src','Control+v');
  await page.waitForSelector(selector('src/renamed 副本.txt'));
  assert.equal(await readFile(path.join(project,'src','renamed 副本.txt'),'utf8'),'Original text external saved saved edit');
  checks.push('copy/paste creates a sibling copy without overwriting');
  await key('src/renamed.txt','Control+x');
  assert.equal(await page.$eval(selector('src/renamed.txt'),n=>n.classList.contains('tree-cut')),true);
  await key('dest','Control+v');await page.waitForSelector(selector('dest/renamed.txt'));
  await page.waitForFunction(()=>document.querySelector('#file-path').textContent==='dest/renamed.txt');
  assert.equal(await page.$(selector('src/renamed.txt')),null);
  checks.push('cut/paste moves the active document and retargets the editor');
  await key('dest/renamed.txt','Delete');await page.waitForSelector('#file-tree-dialog[open]');
  await page.click('#file-tree-dialog button[type="button"]');
  assert.equal(await readFile(path.join(project,'dest','renamed.txt'),'utf8'),'Original text external saved saved edit');
  checks.push('delete cancellation retains the file');
  await key('dest/renamed.txt','Delete');await page.waitForSelector('#file-tree-dialog[open]');
  await page.click('#file-tree-dialog button[type="submit"]');
  await page.waitForFunction(()=>!document.querySelector('#file-tree button[data-path="dest/renamed.txt"]'));
  assert.equal(await page.$eval('#save-status',n=>n.textContent),'未打开');
  checks.push('confirmed delete uses the system recycle bin and closes deleted document');
  screenshot=path.join(output,'file-tree.png');await page.screenshot({path:screenshot});
  }
} finally {
  await browser?.disconnect();
  if (child.exitCode === null) child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 3000))]);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
}
console.log(JSON.stringify({ ok: true, output, checks, screenshot, completionScreenshot }));
