import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, symlink, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'file-labels-'));
// File-tree regression owns an isolated copy and does not start paid Providers.
const root = path.join(output, 'app'); await mkdir(root);
for (const item of ['src','tools','package.json']) await cp(path.join(source,item),path.join(root,item),{recursive:true});
for (const item of ['node_modules','vendor','assets']) await symlink(path.join(source,item),path.join(root,item),'dir');
// Observe transaction settlement in this isolated copy: painted rows can precede
// completion of metadata persistence, while production intentionally rejects overlap.
const actionsPath=path.join(root,'src/renderer/file-tree-actions.mjs');
await writeFile(actionsPath,(await readFile(actionsPath,'utf8')).replace('paint();return {paint};','window.__fileTreeIdle=()=>!busy;paint();return {paint};'));
const build = spawn(process.execPath,[path.join(root,'tools/build-renderer.mjs')],{cwd:root,stdio:'ignore'});
assert.equal(await new Promise(resolve=>build.once('exit',resolve)),0);
const project = path.join(output, 'project');
await mkdir(path.join(project, 'src/deep/more'), { recursive: true });
await writeFile(path.join(project,'src/deep/more/a.txt'),'Nested text');
await writeFile(path.join(project,'top.txt'),'Top original');
await mkdir(path.join(project, 'dest'));
await writeFile(path.join(project,'src','note.txt'),'Original text');
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const electron = createRequire(import.meta.url)('electron');
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(electron, ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, WAYLAND_DISPLAY:'wayland-0', XDG_RUNTIME_DIR:'/run/user/1000', NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
const exited = new Promise(resolve => child.once('exit', resolve));
let browser;
const checks = [];
try {
  const deadline = Date.now() + 20000;
  for (;;) { if (child.exitCode !== null) throw new Error(log); try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} if (Date.now() > deadline) throw new Error('startup timeout\n' + log); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport:null });
  const page = await waitForDesktopPage(browser);
  const errors=[];page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.__nozeliReady, { polling: 100 });
  await prepareReading(page);

  await page.click('#pick-project');
  await page.waitForSelector('#file-tree button');await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-close').click(); });
  const selector = rel => '#file-tree button[data-path="' + rel + '"]';
  const command=async(rel,action)=>{await page.waitForFunction(()=>window.__fileTreeIdle?.());await page.click(selector(rel),{button:'right'});await page.waitForSelector('#file-tree-menu [data-command="'+action+'"]',{visible:true});await page.click('#file-tree-menu [data-command="'+action+'"]');};
  const hidden=rel=>page.$eval(selector(rel),n=>n.hidden);
  await command('src','collapse');await page.waitForFunction(()=>document.querySelector('#file-tree button[data-path="src"]').getAttribute('aria-expanded')==='false');
  assert.equal(await hidden('src/deep'),true);assert.equal(await hidden('src/deep/more/a.txt'),true);
  await page.click(selector('src'));assert.equal(await hidden('src/deep'),false);assert.equal(await hidden('src/deep/more'),true);
  await page.click(selector('src/deep'));assert.equal(await hidden('src/deep/more'),false);assert.equal(await hidden('src/deep/more/a.txt'),true);
  checks.push('collapse subtree closes all nested levels and reopening parent preserves child collapse');
  await page.type('#file-filter','a.txt');await page.waitForFunction(()=>!document.querySelector('#file-tree button[data-path="src/deep/more/a.txt"]').hidden);
  await command('src','collapse');await page.waitForFunction(()=>document.querySelector('#file-tree button[data-path="src/deep/more/a.txt"]').hidden);
  await command('src','refresh');await page.waitForFunction(()=>document.querySelector('#file-tree button[data-path="src"]').getAttribute('aria-expanded')==='false');assert.equal(await hidden('src/deep/more/a.txt'),true);
  await page.$eval('#file-filter',n=>{n.value='';n.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.reload();await prepareReading(page);await page.waitForSelector(selector('src'));assert.equal(await hidden('src/deep'),true);
  checks.push('collapse works in search results, survives refresh, query clearing and reload');

  // The root toolbar opens the root menu without blank-space hit testing or
  // relying on platform delivery of the ContextMenu key after reload.
  if(await page.$eval('#app',n=>n.classList.contains('narrow-layout')?!n.classList.contains('drawer-files-open'):n.classList.contains('files-collapsed')))await page.click('#file-toggle');
  await page.waitForSelector('#file-tree-more',{visible:true});await page.click('#file-tree-more');await page.waitForSelector('#file-tree-menu [data-command="collapse"]',{visible:true});await page.click('#file-tree-menu [data-command="collapse"]');
  await page.waitForFunction(()=>[...document.querySelectorAll('#file-tree .dir')].every(n=>n.getAttribute('aria-expanded')==='false'));assert.equal(await hidden('top.txt'),false);checks.push('root context menu collapses all folders while root files remain visible');
  await command('top.txt','label');await page.waitForSelector('#file-label-dialog[open]');
  await page.click('#file-label-dialog input[value="red"]');await page.click('#file-label-dialog input[value="blue"]');
  await page.type('#file-label-note','优先阅读：核心接口\n<script>window.__fileLabelInjected=true</script>');
  await page.screenshot({path:path.join(output,'01-label-editor.png')});
  await page.click('#file-label-save');await page.waitForSelector('#file-label-dialog:not([open])');await page.waitForSelector(selector('top.txt')+' [data-color="red"]');assert.ok(await page.$(selector('top.txt')+' [data-color="blue"]'));assert.ok(await page.$(selector('top.txt')+' .file-note-icon'));
  assert.equal(await page.evaluate(()=>window.__fileLabelInjected),undefined);assert.match(await page.$eval(selector('top.txt'),n=>n.title),/优先阅读/);assert.equal(await readFile(path.join(project,'top.txt'),'utf8'),'Top original');
  await page.type('#file-filter','核心接口');assert.equal(await hidden('top.txt'),false);assert.equal(await hidden('src'),true);await page.$eval('#file-filter',n=>{n.value='';n.dispatchEvent(new Event('input',{bubbles:true}));});
  checks.push('native file menu saves multiple colors/plain note safely; note search works and source unchanged');
  await page.waitForFunction(()=>window.__fileTreeIdle?.());
  await command('top.txt','label');await page.waitForSelector('#file-label-dialog[open]');await page.click('#file-label-clear');await page.click('#file-label-cancel');assert.ok(await page.$(selector('top.txt')+' [data-color="red"]'));
  await page.waitForFunction(()=>window.__fileTreeIdle?.());await page.focus(selector('top.txt'));await page.keyboard.press('F2');await page.waitForSelector('#file-tree-dialog[open]');await page.$eval('#file-tree-name',n=>{n.value='已标记.txt';});await page.click('#file-tree-dialog button[type="submit"]');await page.waitForSelector(selector('已标记.txt')+' [data-color="red"]');
  await page.waitForFunction(()=>window.__fileTreeIdle?.());await page.focus(selector('已标记.txt'));await page.keyboard.down('Control');await page.keyboard.press('c');await page.keyboard.press('v');await page.keyboard.up('Control');await page.waitForSelector(selector('已标记 副本.txt')+' [data-color="blue"]');
  await command('已标记 副本.txt','label');await page.waitForSelector('#file-label-dialog[open]');await page.click('#file-label-clear');await page.click('#file-label-save');await page.waitForFunction(()=>!document.querySelector('#file-tree button[data-path="已标记 副本.txt"] .file-note-icon'));
  assert.ok(await page.$(selector('已标记.txt')+' [data-color="red"]'));checks.push('cancel preserves marks; rename and copy carry labels; clearing copied marks leaves original intact');
  await page.reload();await prepareReading(page);await page.waitForSelector(selector('已标记.txt')+' [data-color="red"]');assert.match(await page.$eval(selector('已标记.txt'),n=>n.title),/核心接口/);
  await page.screenshot({path:path.join(output,'02-tree-labels.png')});checks.push('file colors and notes restore after reload');assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'result.json'),JSON.stringify({passed:true,checks,output},null,2));console.log(JSON.stringify({passed:true,checks,output}));
  await page.evaluate(()=>window.nozeli.invoke('session.requestClose'));await Promise.race([exited,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('shutdown timeout')),10000);t.unref();})]);
}finally{await writeFile(path.join(output,'electron.log'),log);await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');}
