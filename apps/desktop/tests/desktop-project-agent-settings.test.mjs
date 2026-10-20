import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const appRoot = path.resolve(import.meta.dirname, '..');
const outDir = await mkdtemp(path.join(appRoot, '.test-output', 'desktop-project-agent-settings-'));
await mkdir(outDir, { recursive: true });
const projectA = await mkdtemp(path.join(os.tmpdir(), 'nozeli-project-agent-a-'));
const projectB = await mkdtemp(path.join(os.tmpdir(), 'nozeli-project-agent-b-'));
await writeFile(path.join(projectA, 'a.md'), '# A');
await writeFile(path.join(projectB, 'b.md'), '# B');
const port = await new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const selected = server.address().port;
    server.close(() => resolve(selected));
  });
});
const child = spawn(electronPath, [path.join(appRoot, 'src/main/main.cjs'), `--ozone-platform=${process.env.NOZELI_OZONE || 'wayland'}`], {
  cwd: path.dirname(appRoot),
  env: {
    ...process.env,
    NOZELI_AGENT_FIXTURE: '1',
    NOZELI_HIDDEN: '0',
    NOZELI_OZONE: process.env.NOZELI_OZONE || 'wayland',
    NOZELI_USER_DATA: path.join(outDir, 'profile'),
    NOZELI_TEST_PICK: `${projectA}\n${projectB}`,
    NOZELI_DEBUG_PORT: String(port),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

async function choose(page, backgroundPermission = 'inherit') {
  const provider = await page.$eval('#agent-foreground', (select) => [...select.options].find((item) => !item.disabled && item.value)?.value || '');
  if (!provider) throw new Error('no provider available');
  await page.select('#agent-foreground', provider);
  await page.select('#agent-background', provider);
  await page.select('#agent-foreground-permission', 'inherit');
  await page.select('#agent-background-permission', backgroundPermission);
  await page.$eval('#agent-setup-form', (form) => form.requestSubmit());
  await page.waitForFunction(() => !document.querySelector('#agent-setup').open && !document.querySelector('#send-message').disabled, { timeout: 20000 });
  return provider;
}

try {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode != null) throw new Error(output);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`devtools did not come up\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 30000 });
  const page = (await browser.pages()).find((item) => item.url().includes('127.0.0.1'));
  await page.waitForFunction(() => window.__nozeliReady === true, { timeout: 20000 });
  if (await page.$eval('#agent-setup', (node) => node.open)) throw new Error('setup opened without a project');

  await page.click('#pick-project');
  await page.waitForFunction((name) => document.querySelector('#project-name').textContent === name && document.querySelector('#agent-setup').open, {}, path.basename(projectA));
  const provider = await choose(page, 'inherit');
  const projectsA = (await page.evaluate(() => window.nozeli.invoke('project.recent'))).value.projects;
  const idA = projectsA.find((item) => item.name === path.basename(projectA)).id;
  const settingsA = (await page.evaluate((projectId) => window.nozeli.invoke('agents.settings.read', { projectId }), idA)).value;
  await page.click('#provider-console-toggle');
  await page.waitForFunction(() => !document.querySelector('#provider-console').hidden);
  const placement = await page.evaluate(() => ({
    inProjectAgent: Boolean(document.querySelector('#provider-console #terminal-menu-qa')),
    inTopbar: Boolean(document.querySelector('.topbar #agent-settings')),
  }));
  if (!placement.inProjectAgent || placement.inTopbar) throw new Error(`wrong settings placement ${JSON.stringify(placement)}`);
  await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-toggle').click(); });

  await page.evaluate((directory) => window.nozeli.invoke('project.pick', { directory }), projectB);
  await page.click('#pick-project');
  await page.waitForFunction((name) => [...document.querySelectorAll('#recent button')].some((item) => item.title === name), {}, path.basename(projectB));
  await page.click(`#recent button[title="${path.basename(projectB)}"]`);
  await page.waitForFunction((name) => document.querySelector('#project-name').textContent === name && document.querySelector('#agent-setup').open, {}, path.basename(projectB));
  await choose(page, 'full');
  const projectsB = (await page.evaluate(() => window.nozeli.invoke('project.recent'))).value.projects;
  const idB = projectsB.find((item) => item.name === path.basename(projectB)).id;
  const settingsB = (await page.evaluate((projectId) => window.nozeli.invoke('agents.settings.read', { projectId }), idB)).value;

  await page.click('#provider-console-toggle');
  await page.waitForFunction(() => !document.querySelector('#provider-console').hidden);
  await page.click('#terminal-menu-qa');
  await page.click('#terminal-actions-qa button');
  await page.waitForFunction(() => document.querySelector('#agent-setup').open);
  await page.select('#agent-foreground-permission', 'full');
  await page.$eval('#agent-setup-form', (form) => form.requestSubmit());
  await page.waitForFunction(() => !document.querySelector('#agent-setup').open && !document.querySelector('#send-message').disabled, { timeout: 20000 });
  const adjustedB = (await page.evaluate((projectId) => window.nozeli.invoke('agents.settings.read', { projectId }), idB)).value;

  await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-toggle').click(); });
  await page.click(`#recent button[title="${path.basename(projectA)}"]`);
  await page.waitForFunction((name) => document.querySelector('#project-name').textContent === name, {}, path.basename(projectA));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const returnState = await page.evaluate(async (projectId) => ({
    setupOpen: document.querySelector('#agent-setup').open,
    setupText: document.querySelector('#agent-setup-status').textContent,
    bootstrap: await window.nozeli.invoke('agents.bootstrap', { projectId }),
  }), idA);
  if (returnState.setupOpen) throw new Error(`A unexpectedly requested settings again: ${JSON.stringify(returnState)}`);
  const restoredA = (await page.evaluate((projectId) => window.nozeli.invoke('agents.settings.read', { projectId }), idA)).value;
  const result = { provider, placement, settingsA, settingsB, adjustedB, restoredA };
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(result, null, 2));
  if (settingsA.background.permissionMode !== 'inherit') throw new Error('A settings changed');
  if (settingsB.background.permissionMode !== 'full') throw new Error('B settings not saved');
  if (adjustedB.foreground.permissionMode !== 'full') throw new Error('B settings not adjustable from project Agent page');
  if (restoredA.foreground.permissionMode !== 'inherit' || restoredA.background.permissionMode !== 'inherit') throw new Error('A settings were overwritten by B');
  console.log(`project Agent settings isolated; ${outDir}`);
  await browser.disconnect();
} finally {
  if (child.exitCode == null) child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
