import {prepareReading, waitForDesktopPage} from './reading-setup.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'restart-screenshot-'));
const profile = path.join(output, 'profile');
const project = path.join(output, 'project');
await mkdir(project);
await writeFile(path.join(project, 'sample.txt'), '第一段\n第二段\n第三段\n');
const electron = createRequire(import.meta.url)('electron');
const ozone = process.env.NOZELI_OZONE || 'wayland';
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const launch = async port => {
  const child = spawn(electron, ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
    cwd: root,
    env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: profile, NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: '0', NOZELI_OZONE: ozone },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  const deadline = Date.now() + 20000;
  for (;;) { if (child.exitCode !== null) throw new Error(log); try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} if (Date.now() > deadline) throw new Error('startup timeout\n' + log); await new Promise(resolve => setTimeout(resolve, 100)); }
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const page = await waitForDesktopPage(browser);
  await page.waitForFunction(() => window.__nozeliReady === true, { polling: 100, timeout: 20000 });
  await prepareReading(page);
  return { child, browser, page, log: () => log };
};
const close = async ({ child, browser, page }) => {
  await page.evaluate(() => window.nozeli.invoke('session.requestClose', {})).catch(() => {});
  await browser.disconnect().catch(() => {});
  if (child.exitCode === null) await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10000); child.once('exit', (code, signal) => { clearTimeout(timer); assert.equal(code, 0, `Nozeli exit signal=${signal}`); resolve(); }); });
};

const checks = [];
let first, second;
try {
  const firstPort = await freePort();
  first = await launch(firstPort);
  const { page } = first;
  if (!(await page.$('#file-tree button[data-path="sample.txt"]'))) {
    await page.click('#pick-project');
  }
  await page.waitForSelector('#file-tree button[data-path="sample.txt"]');
  await page.click('#file-tree button[data-path="sample.txt"]');
  await page.waitForFunction(() => window.__nozeliInput.text().includes('第二段'), { polling: 100 });
  await page.evaluate(() => { document.querySelector('.cm-content').focus(); window.__nozeliInput.select(3, 6); });
  await page.waitForSelector('#selection-note:not([hidden])');
  await page.$eval('#selection-note', node => node.click());
  await page.type('#note-input', '重启后仍在的备注');
  await page.$eval('#add-note', node => node.click());
  await page.waitForSelector('.note-anchor.tag-note');
  assert.equal(await page.$eval('.note-projection-content', node => node.textContent.includes('重启后仍在的备注')), true);
  const firstGeometry = await page.$eval('.note-anchor.tag-note', tag => ({ index: tag.querySelector('.note-index').getBoundingClientRect().toJSON(), card: tag.querySelector('.note-projection').getBoundingClientRect().toJSON() }));
  assert.ok(firstGeometry.index.right <= firstGeometry.card.left + 1, 'ordinal ring must remain clear of card');
  await page.screenshot({ path: path.join(output, 'before-restart.png'), fullPage: false });
  checks.push('first process creates and screenshots a real note projection');
  await close(first);
  first = null;

  const secondPort = await freePort();
  second = await launch(secondPort);
  await second.page.waitForSelector('.note-anchor.tag-note', { timeout: 20000 });
  assert.equal(await second.page.$eval('.note-projection-content', node => node.textContent.includes('重启后仍在的备注')), true);
  assert.equal(await second.page.$eval('#file-path', node => node.textContent.endsWith('sample.txt')), true);
  const secondGeometry = await second.page.$eval('.note-anchor.tag-note', tag => ({ index: tag.querySelector('.note-index').getBoundingClientRect().toJSON(), card: tag.querySelector('.note-projection').getBoundingClientRect().toJSON() }));
  assert.ok(secondGeometry.index.right <= secondGeometry.card.left + 1, 'restored ordinal ring must remain clear of card');
  await second.page.screenshot({ path: path.join(output, 'after-restart.png'), fullPage: false });
  checks.push('second process restores project, file and note projection');
  await close(second);
  second = null;
  const report = { ok: true, checks, output, screenshots: ['before-restart.png', 'after-restart.png'] };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  if (first) await close(first).catch(() => {});
  if (second) await close(second).catch(() => {});
}
