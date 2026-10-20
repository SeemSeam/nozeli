import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'code-file-'));
const project = path.join(output, 'project'); await mkdir(project);
const source = 'function helper(value) { return value + 1; }\nconst result = helper(2);\n';
await writeFile(path.join(project, 'main.js'), source); await writeFile(path.join(project, 'util.js'), 'export const util = 1;\n');
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const require = createRequire(import.meta.url); const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(require('electron'), ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], { cwd: root, env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone }, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise(resolve => child.once('exit', resolve)); let log = '', browser; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
try {
  const deadline = Date.now() + 20000;
  for (;;) { if (child.exitCode !== null || child.signalCode) throw new Error(log); try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} if (Date.now() > deadline) throw new Error('Startup timeout: ' + log); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` }); const page = await waitForDesktopPage(browser);
  await page.waitForFunction(() => window.__nozeliReady); await page.setViewport({ width: 1200, height: 800 }); await prepareReading(page);await page.click('#pick-project');
  await page.click('#file-tree button[data-path="main.js"]'); await page.waitForFunction(() => document.querySelector('#file-path').textContent === 'main.js');
  assert.equal(await page.$eval('#code-jump', node => node.hidden), false);
  const helperStart = source.indexOf('helper(2)'); await page.evaluate((from, to) => window.__nozeliInput.select(from, to), helperStart, helperStart + 6);
  await page.evaluate(() => document.querySelector('#code-jump').click()); await page.waitForFunction(() => document.querySelector('#code-status').textContent.includes('已跳转到 helper 定义'));
  console.log(JSON.stringify({ output, checks: ['real project JavaScript opened', 'code navigation control visible', 'current-file definition jump'] }));
} finally {
  await browser?.disconnect();
  if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
  clearTimeout(timer);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
}
