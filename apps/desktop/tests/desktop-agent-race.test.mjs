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
const outDir = await mkdtemp(path.join(appRoot, '.test-output', 'desktop-agent-race-'));
await mkdir(outDir, { recursive: true });
const projectA = await mkdtemp(path.join(os.tmpdir(), 'nozeli-race-a-'));
const projectB = await mkdtemp(path.join(os.tmpdir(), 'nozeli-race-b-'));
await writeFile(path.join(projectA, 'a.md'), 'A');
await writeFile(path.join(projectB, 'b.md'), 'B');
const port = await new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const chosen = server.address().port;
    server.close(() => resolve(chosen === 8876 ? 8877 : chosen));
  });
});
const child = spawn(electronPath, [path.join(appRoot, 'src/main/main.cjs')], {
  cwd: path.dirname(appRoot),
  env: {
    ...process.env,
    NOZELI_HIDDEN: '1',
    NOZELI_OZONE: process.env.NOZELI_OZONE || 'headless',
    NOZELI_USER_DATA: path.join(outDir, 'profile'),
    NOZELI_TEST_PICK: `${projectA}\n${projectB}`,
    NOZELI_SHOT_DIR: outDir,
    NOZELI_DEBUG_PORT: String(port),
    NOZELI_AGENT_FIXTURE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

try {
  const deadline = Date.now() + 30000;
  for (;;) {
    if (child.exitCode != null) throw new Error(output);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`devtools did not come up\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 120000 });
  const pages = await browser.pages();
  const page = pages.find((item) => item.url().includes('127.0.0.1')) || pages.at(-1);
  await page.waitForFunction(() => window.__nozeliReady, { timeout: 20000 });
  await page.evaluate(() => document.querySelector('#pick-project').click());
  await page.waitForFunction(() => document.querySelector('#project-name').textContent !== '未打开项目');
  await page.waitForFunction(() => document.querySelector('#agent-setup')?.open, { timeout: 20000 });
  await page.evaluate(() => {
    for (const [selectId, permissionId] of [['#agent-foreground', '#agent-foreground-permission'], ['#agent-background', '#agent-background-permission']]) {
      const select = document.querySelector(selectId);
      const option = [...select.options].find((item) => !item.disabled && item.value);
      select.value = option.value;
      document.querySelector(permissionId).value = 'inherit';
    }
  });
  await page.click('#agent-save');
  await page.waitForFunction(() => !document.querySelector('#send-message').disabled, { timeout: 20000 });
  const draft = 'same draft';
  await page.evaluate((value) => {
    const node = document.querySelector('#composer');
    node.value = value;
    node.dispatchEvent(new Event('input'));
  }, draft);
  const pending = page.evaluate(() => window.__agentSend());
  await page.evaluate(async (directory) => {
    const opened = await window.nozeli.invoke('project.pick', { directory });
    window.__agentProject(opened.value.project.id);
    const node = document.querySelector('#composer');
    node.value = 'same draft';
    node.dispatchEvent(new Event('input'));
  }, projectB);
  const sent = await pending;
  const kept = await page.$eval('#composer', (node) => node.value);
  const sessions = await page.evaluate(() => window.nozeli.invoke('agents.status', { projectId: document.querySelector('#project-name').dataset.id || '' }));
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify({ kept, sessions, draft }, null, 2));
  if (kept !== draft) throw new Error(`B draft was cleared: ${JSON.stringify(kept)}`);
  console.log(`agent race kept equal draft; ${outDir}`);
} finally {
  if (child.exitCode == null) child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
