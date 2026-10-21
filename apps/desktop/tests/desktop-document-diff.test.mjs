import { contentToolForPage } from './native-content-tools.fixture.mjs';
import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'document-diff-'));
const project = path.join(output, 'project');
await mkdir(project);
await writeFile(path.join(project, 'left.md'), '# Title\ncommon\nold line\nend\n');
await writeFile(path.join(project, 'right.md'), '# Title\ncommon\nnew line\nend\nextra\n');
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
const require = createRequire(import.meta.url);
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(require('electron'), ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], { cwd: root, env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone }, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = new Promise(resolve => child.once('exit', resolve));
let log = '', browser;
child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
try {
  const deadline = Date.now() + 20000;
  for (;;) { if (child.exitCode !== null || child.signalCode) throw new Error(log); try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} if (Date.now() > deadline) throw new Error('Startup timeout: ' + log); await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const page = await waitForDesktopPage(browser);
  await page.waitForFunction(() => window.__nozeliReady); await page.setViewport({ width: 1280, height: 820 });
  await prepareReading(page);await page.click('#pick-project');
  await page.click('#file-tree button[data-path="left.md"]'); await page.waitForFunction(() => document.querySelector('#file-path').textContent === 'left.md');
  const before = await page.evaluate(() => window.__nozeliInput.text());
  await contentToolForPage(page, ['history', 'compareFile']); await page.waitForSelector('#beside-dialog[open]'); await page.select('#beside-file', 'right.md'); await page.click('#beside-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#secondary-path').textContent === 'right.md');
  assert.equal(await page.$eval('#diff-mode', node => node.disabled), false);
  await page.click('#diff-mode'); await page.waitForSelector('.document-diff .cm-mergeView');
  assert.equal(await page.$$eval('.cm-mergeViewEditor', nodes => nodes.length), 2);
  assert.ok(await page.$$eval('.cm-changedLine', nodes => nodes.length) > 0);
  assert.equal(await page.$eval('.document-diff', node => getComputedStyle(node).visibility), 'visible');
  assert.equal(await page.$eval('#secondary-close', node => node.closest('.document-diff-head') !== null), true);
  await page.screenshot({ path: path.join(output, 'diff.png') });
  await page.evaluate(() => document.querySelector('#compare-mode').click()); await page.waitForFunction(() => !document.querySelector('.document-diff'));
  assert.equal(await page.evaluate(() => window.__nozeliInput.text()), before);
  console.log(JSON.stringify({ output, checks: ['text diff toggle', 'changed lines and two editors', 'source editor retained after exit'] }));
} finally {
  await browser?.disconnect(); if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  let timer; const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]); clearTimeout(timer); if (!stopped) { child.kill('SIGKILL'); await exited; }
}
