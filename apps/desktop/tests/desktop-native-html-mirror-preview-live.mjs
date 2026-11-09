// Permanent macOS real-package regression: an HTML document split into a read-only
// mirror must mount its own isolated offline-preview guest beside the owner's. The
// mirror holds no edit lease, so its web workspace must not attempt the edit-buffer
// publish (main denies it with EDIT_LEASE_DENIED); the preview captures the synced
// owner buffer instead. Before the fix the mirror pane kept an empty placeholder and
// an error status with no second native guest. Runs the installed Nozeli.app inner
// binary through NOZELI_TEST_BINARY with an isolated synthetic project and profile
// outside the repository; on darwin the Linux ozone flags are never passed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';

const root = path.resolve(import.meta.dirname, '..');
const out = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'nozeli-mac-html-mirror-'));
const report = { out, platform: process.platform, checks: [], errors: [] };
if(process.platform!=='darwin')throw Error('This native HTML mirror acceptance requires darwin.');

const configRoot = path.join(out, '.Nozeli'), profile = path.join(configRoot, 'desktop');
const host = new DesktopHost(profile);
const projectDir = path.join(out, 'Project');
await fs.mkdir(projectDir);
await fs.writeFile(path.join(projectDir, 'page.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>Mirror Journey</title><style>body{font:16px system-ui;margin:2em}h1{color:#345}</style></head>
<body><h1>镜像正文</h1>${Array.from({ length: 30 }, (_, n) => '<p>段落 ' + n + '</p>').join('')}</body></html>`);
const project = (await host.pick(projectDir)).project;
const pause = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const binary = process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
let child, browser, log = '';
async function until(fn, label, ms = 45000) { const end = Date.now() + ms; do { const value = await fn(); if (value) return value; if (child?.exitCode !== null && child?.exitCode !== undefined) throw Error(log); await pause(70); } while (Date.now() < end); throw Error('Timed out: ' + label); }
async function call(page, op, payload = {}) { const r = await page.evaluate((op, payload) => nozeli.invoke(op, payload), op, payload); if (!r.ok) throw Error(op + ': ' + JSON.stringify(r.error)); return r.value; }
const surfaces = async test => { const found = []; for (const p of await browser.pages()) { const s = await p.evaluate(() => window.__workspaceScope).catch(() => null); if (s && test(s)) found.push({ page: p, scope: s }); } return found; };
const guests = async () => { const rows = []; for (const p of await browser.pages()) { if (!p.url().includes('.invalid/')) continue; rows.push({ page: p, id:p.target()._targetId, ...(await p.evaluate(() => ({ vis: document.visibilityState, w: innerWidth, h: innerHeight, h1: document.querySelector('h1')?.textContent,body:document.body.innerText })).catch(() => ({}))) }); } return rows; };
try {
  const port = await freePort();
  child = spawn(binary, [...(process.env.NOZELI_TEST_BINARY ? [] : [path.join(root, 'src/main/main.cjs')])], { cwd: root, env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: configRoot, NOZELI_USER_DATA: profile, NOZELI_DEBUG_PORT: String(port), NOZELI_SHOT_DIR: out, NOZELI_HIDDEN: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', c => log += c);
  browser = await until(async () => { try { return await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + port, defaultViewport: null }); } catch { return null; } }, 'debug');
  const shell = await until(async () => { for (const p of await browser.pages()) { if (!p.url().startsWith('http://127.0.0.1:')) continue; if (await p.evaluate(() => window.__workspaceScope?.role === 'shell' && window.__nozeliReady === true).catch(() => false)) return p; } return null; }, 'shell');
  if (await shell.$('#configuration-setup[open]')) { await shell.click('#configuration-cancel'); await shell.waitForFunction(() => !document.querySelector('#configuration-setup').open); }
  await until(async () => await shell.evaluate(id => { const n = document.querySelector('[data-project-id="' + id + '"]'); if (!n) return false; n.click(); return true; }, project.id), 'project open');
  await until(async () => (await call(shell, 'workspace.bootstrap', {})).projectId === project.id, 'project bound');
  await until(async () => await shell.evaluate(() => { const n = document.querySelector('#file-tree [data-path="page.html"]'); if (!n) return false; n.click(); return true; }), 'open page.html');
  const owner = await until(async () => (await surfaces(s => s.relPath === 'page.html' && !s.readOnly))[0] ?? null, 'owner surface');
  const ownerViewId = owner.scope.viewId;
  await until(async () => (await guests()).length >= 1, 'owner preview guest');
  const ownerGuests = await guests();
  assert.equal(ownerGuests.length, 1, 'owner web mode opens exactly one guest');
  assert.equal(ownerGuests[0].vis, 'visible', 'owner guest is natively visible');
  report.checks.push({ step: 'owner web mode', guest: { vis: ownerGuests[0].vis, size: [ownerGuests[0].w, ownerGuests[0].h] } });

  await shell.locator('#workspace-open-editors [data-editor-view="' + ownerViewId + '"]').click({ button: 'right' });
  await shell.waitForSelector('.nozeli-context-menu:not([hidden]) [data-command="split-x"]');
  await shell.locator('.nozeli-context-menu:not([hidden]) [data-command="split-x"]').click();
  const mirror = await until(async () => (await surfaces(s => s.relPath === 'page.html' && s.readOnly === true))[0] ?? null, 'read-only mirror surface');
  const settled = await until(async () => {
    const list = await guests();
    const status = await mirror.page.evaluate(() => { const n = document.querySelector('.isolated-status'); return { state: n?.dataset.state ?? null, text: n?.textContent ?? '' }; });
    return (list.length >= 2 || status.state === 'error') ? { list, status } : null;
  }, 'mirror preview settles (guest opens or honest error)', 30000);
  assert.notEqual(settled.status.state, 'error', 'mirror preview must not fail: ' + settled.status.text);
  assert.equal(settled.list.length, 2, 'split mirror mounts its own preview guest beside the owner guest');
  const mirrorGuest=await until(async()=>{
    const candidate=(await guests()).find(g=>g.id!==ownerGuests[0].id);
    const placeholder=await mirror.page.evaluate(()=>{const r=document.querySelector('[data-preview-key]')?.getBoundingClientRect();return r?[Math.round(r.width),Math.round(r.height)]:null;});
    return candidate&&placeholder&&candidate.vis==='visible'&&Math.abs(candidate.w-placeholder[0])<=1&&Math.abs(candidate.h-placeholder[1])<=1?candidate:null;
  },'mirror guest layout matches its final placeholder',15000);
  const finalGuests=await guests();
  for(const guest of finalGuests){assert.equal(guest.h1,'镜像正文');assert.equal(guest.vis,'visible');}
  await mirrorGuest.page.screenshot({path:path.join(out,'mirror-body.png')});
  report.checks.push({step:'split mirror',guests:finalGuests.map(g=>({vis:g.vis,size:[g.w,g.h]})),mirrorStatus:settled.status});
  report.ok=true;
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  await call(shell,'session.requestClose');
  report.exit=await Promise.race([exit,pause(15000).then(()=>null)]);
  assert.deepEqual(report.exit,{code:0,signal:null});
} catch (error) {
  report.ok=false;report.errors.push(error.message);process.exitCode=1;
} finally {
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(out,'main.log'),log);
  await browser?.disconnect().catch(()=>{});
  if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),pause(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  console.log(JSON.stringify(report));
}
