import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { submitHandoff } from '../src/agents/handoff.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const appRoot = path.resolve(import.meta.dirname, '..');
const outDir = await mkdtemp(path.join(appRoot, '.test-output', 'desktop-work-sidebar-'));
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
const child = spawn(electronPath, [path.join(appRoot, 'src/main/main.cjs'), `--ozone-platform=${process.env.NOZELI_OZONE || 'headless'}`], {
  cwd: path.dirname(appRoot),
  env: {
    ...process.env,
    NOZELI_HIDDEN: process.env.NOZELI_OZONE === 'wayland' ? '0' : '1',
    NOZELI_TEST_INSTANCE: '1',
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
    if (child.exitCode != null || child.signalCode != null) throw new Error(`Electron exit ${child.exitCode}/${child.signalCode}: ${output}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`devtools did not come up\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 120000 });
  const pages = await browser.pages();
  const page = pages.find((item) => item.url().includes('127.0.0.1')) || pages.at(-1);
  const wait = (fn, options = {}, ...args) => page.waitForFunction(fn, { polling: 100, ...options }, ...args);
  page.on('pageerror', error => console.error('PAGE ERROR', error.message));
  await wait(() => window.__nozeliReady, { timeout: 20000 });
  const checks = [];
  const check = (name, ok) => { assert.ok(ok, name); checks.push(name); };
  await page.evaluate(() => document.querySelector('#pick-project').click());
  await wait(() => document.querySelector('#agent-setup')?.open, { timeout: 20000 }).catch(async error => { console.error(await page.evaluate(() => document.body.innerText)); throw error; });
  const projectId = await page.evaluate(async directory => (await window.nozeli.invoke('project.pick', { directory })).value.project.id, projectA);
  const logDir = path.join(outDir, 'profile', 'nozeli', 'v1', 'projects', projectId);
  await mkdir(logDir, { recursive: true });
  await writeFile(path.join(logDir, 'agent-log.json'), JSON.stringify({ schemaVersion: 1, seq: 0, messages: [],
    requests: ['unknown', 'completed', 'failed', 'cancelled'].map(status => ({ id: status, projectId, role: 'task', text: `seed-${status}`, status })),
    reports: [{ id: 'read-report', projectId, title: '可阅读的报告', success: true, text: '报告正文', status: 'completed' }, { id: 'failed-report', projectId, title: '失败报告', success: false, text: '未完成', status: 'failed' }],
  }));
  await page.evaluate(() => {
    for (const id of ['agent-foreground', 'agent-background']) {
      const select = document.getElementById(id); select.value = [...select.options].find(item => !item.disabled && item.value).value;
    }
  });
  await page.click('#agent-save');
  await wait(() => !document.querySelector('#send-message').disabled);
  await wait(() => document.querySelector('#inbox-reports').children.length === 2);
  check('open filter excludes historical work', await page.$eval('#work-items', node => node.children.length === 0));
  check('count includes unknown work', await page.$eval('#work-count', node => node.textContent === '01'));
  for (const [filter, count] of [['paused', 1], ['closed', 3], ['all', 4], ['active', 0]]) {
    await page.click(`[data-work-filter="${filter}"]`);
    check(`work filter ${filter}`, await page.$eval('#work-items', (node, count) => node.children.length === count, count));
  }
  for (const [filter, count] of [['answer', 0], ['read', 2], ['all', 2]]) {
    await page.click(`[data-inbox-filter="${filter}"]`);
    check(`inbox filter ${filter}`, await page.$eval('#inbox-reports', (node, count) => node.children.length === count, count));
    check('inbox total is stable', await page.$eval('#inbox-count', node => node.textContent === '02'));
  }
  const grant = path.join(outDir, 'profile', 'nozeli', 'v1', 'runtime', `${projectId}-qa.json`);
  const taskFile = path.join(projectA, 'task.txt'); await writeFile(taskFile, 'sidebar live running');
  const first = await submitHandoff(grant, taskFile);
  await wait(id => document.querySelector(`[data-work-id="${id}"]`)?.textContent.includes('进行中'), {}, first.id);
  await writeFile(taskFile, 'sidebar live queued'); const second = await submitHandoff(grant, taskFile);
  await wait(id => document.querySelector(`[data-work-id="${id}"]`)?.textContent.includes('排队中'), {}, second.id);
  check('live open count includes queued running and unknown', await page.$eval('#work-count', node => node.textContent === '03'));
  check('one-way sends do not create inbox reports', await page.$eval('#inbox-count', node => node.textContent === '02'));
  const cancelled = await page.evaluate(async ({ projectId, requestId }) => window.nozeli.invoke('agents.cancel', { projectId, requestId }), { projectId, requestId: second.id });
  assert.equal(cancelled.value.cancelled, true);
  await wait(() => document.querySelector('#work-items').children.length === 1);
  await page.click('[data-work-filter="closed"]');
  check('cancelled queue item moves to closed filter', await page.$eval('#work-items', node => node.children.length === 4));
  check('work list stays inside its panel', await page.$eval('#work-items', node => node.getBoundingClientRect().bottom <= node.closest('section').getBoundingClientRect().bottom));
  check('last work is reachable by scrolling', await page.$eval('#work-items', node => { node.scrollTop = node.scrollHeight; const last = node.lastElementChild.getBoundingClientRect(); const box = node.getBoundingClientRect(); return last.bottom <= box.bottom + 1 && last.top >= box.top; }));
  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'work-sidebar' }));
  await page.click('#inbox-reports button');
  await wait(() => document.querySelector('#subject-title').textContent.includes('可阅读的报告'));
  check('inbox entry opens its actual report', true);
  await page.evaluate(async directory => {
    const opened = await window.nozeli.invoke('project.pick', { directory }); window.__agentProject(opened.value.project.id);
  }, projectB);
  check('project switch immediately clears work and reports', await page.evaluate(() => !document.querySelector('#work-items').children.length && !document.querySelector('#inbox-reports').children.length && document.querySelector('#inbox-count').textContent === '00'));
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify({ ok: true, checks, fixture: true }, null, 2));
  console.log(`work sidebar Electron ${checks.length} checks passed; ${outDir}`);

} finally {
  if (child.exitCode == null) child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}
