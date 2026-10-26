// Clean single-instance startup-deadlock repro: drive restoreLast ops one by one.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
const appRoot = path.resolve(import.meta.dirname, '..');
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-deadlock-'));
const profile = path.join(out, 'profile'), project = path.join(out, 'proj');
await fs.mkdir(project, { recursive: true });
await fs.writeFile(path.join(project, 'index.html'), '<!doctype html><html><body><h1>entry</h1></body></html>');
const { DesktopHost } = await import(path.join(appRoot, 'src/main/host.mjs'));
const host = new DesktopHost(profile);
await (await host.pick(project)).project;
const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const tick = ms => new Promise(r => setTimeout(r, ms));
const child = spawn(createRequire(import.meta.url)('electron'), [path.join(appRoot, 'src/main/main.cjs'), '--ozone-platform=wayland'], {
  cwd: appRoot,
  env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: out, NOZELI_USER_DATA: profile, NOZELI_DEBUG_PORT: String(port), NOZELI_SHOT_DIR: out },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; for (const s of [child.stdout, child.stderr]) s.on('data', c => log += c);
let browser, page;
const timed = (label, promise, ms = 8000) => Promise.race([promise.then(v => ({ label, ok: v?.ok, value: v?.value ? JSON.stringify(v.value).slice(0, 60) : null }), e => ({ label, thrown: String(e.message).slice(0, 80) })), tick(ms).then(() => ({ label, HANG: true }))]);
try {
  for (let i = 0; i < 150; i++) { try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + port, defaultViewport: null }); break; } catch { if (child.exitCode !== null) throw Error(log); await tick(100); } }
  for (let i = 0; i < 100 && !page; i++) { page = (await browser.pages()).find(p => p.url().includes('127.0.0.1')); if (!page) await tick(200); }
  if (!page) throw Error('no page target; ' + log.slice(0, 500));
  // Fresh-launch check: no reload (frame swap races window recovery).
  page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 200)); });
  await tick(3000);
  console.log('after+3s nozeliReady =', await page.evaluate(() => window.__nozeliReady));
  console.log('EARLY-ERRORS', JSON.stringify(await page.evaluate(() => window.__earlyErrors || [])));
  console.log('MARKERS', JSON.stringify(await page.evaluate(() => ({ webToggle: !!document.querySelector('#web-preview-toggle'), settingsDialog: !!document.querySelector('#settings-dialog'), agentDetails: !!document.querySelector('#managed-agent-details'), fontMenu: !!document.querySelector('#font-menu'), agentProject: typeof window.__agentProject, reviewSnapshot: typeof window.__reviewSnapshot, configurationWired: !!document.querySelector('#configuration-cancel')?.onclick }))));
  const steps = [];
  steps.push(await timed('workspace.ready', page.evaluate(() => nozeli.invoke('workspace.ready', {}))));
  console.log(JSON.stringify(steps.at(-1)));
  steps.push(await timed('project.recent', page.evaluate(() => nozeli.invoke('project.recent', {}))));
  console.log(JSON.stringify(steps.at(-1)));
  const recent = await page.evaluate(() => nozeli.invoke('project.recent', {}));
  const id = recent?.value?.projects?.[0]?.id;
  steps.push(await timed('project.open', page.evaluate(id => nozeli.invoke('project.open', { projectId: id }), id)));
  console.log(JSON.stringify(steps.at(-1)));
  steps.push(await timed('state.read', page.evaluate(id => nozeli.invoke('state.read', { projectId: id }), id)));
  console.log(JSON.stringify(steps.at(-1)));
  await tick(3000);
  console.log('after manual ops nozeliReady =', await page.evaluate(() => window.__nozeliReady));
  console.log('readystate detail:', JSON.stringify(await page.evaluate(() => ({ ready: window.__nozeliReady === true, scope: window.__workspaceScope || null }))));
  await fs.writeFile(path.join(out, 'repro.json'), JSON.stringify({ steps, logTail: log.slice(-2000) }, null, 2));
  console.log('EVIDENCE', out);
} finally {
  try { if (page && !page.isClosed() && child.exitCode === null) await page.evaluate(() => nozeli.invoke('session.requestClose', {})).catch(() => {}); } catch {}
  if (child.exitCode === null) { const ex = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await Promise.race([ex, tick(4000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  await browser?.disconnect();
}
