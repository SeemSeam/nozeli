import { contentToolForPage } from './native-content-tools.fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'document-header-'));
const root = path.join(output, 'app');
await mkdir(root);
for (const item of ['src', 'tools', 'package.json']) await cp(path.join(source, item), path.join(root, item), { recursive: true });
await symlink(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'dir');
await symlink(path.join(source, 'vendor'), path.join(root, 'vendor'), 'dir');
const build = spawn(process.execPath, [path.join(root, 'tools/build-renderer.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let buildLog = '';
build.stdout.on('data', chunk => { buildLog += chunk; }); build.stderr.on('data', chunk => { buildLog += chunk; });
assert.equal(await new Promise(resolve => build.once('exit', resolve)), 0, buildLog);
const project = path.join(output, 'project');
const directory = '中文 目录';
const name = '较长的文件标题用于验证不会重复显示或挤压操作按钮.md';
const relPath = directory + '/' + name;
await mkdir(path.join(project, directory), { recursive: true });
await writeFile(path.join(project, relPath), '# Header sample\n\nDocument text.\n');
await writeFile(path.join(project, 'other.md'), '# Other\n\nDifferent contents.\n');
await cp(path.resolve(source, 'tests/fixtures/pdf/nozeli-sample.zh.pdf'), path.join(project, 'sample.pdf'));
const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const require = createRequire(import.meta.url), ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(require('electron'), ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise(resolve => child.once('exit', resolve));
let log = '', browser, page;
child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
const report = { checks: [], errors: [] };
try {
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) throw new Error(log);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Startup timeout: ' + log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  page = (await browser.pages()).find(page => page.url().includes('127.0.0.1'));
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.__nozeliReady);
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('#pick-project'); if (await page.waitForSelector('#agent-setup[open]', { timeout: 4000 }).catch(() => null)) await page.click('#agent-skip');
  await page.click(`#file-tree button[data-path="${relPath}"]`);
  await page.waitForFunction(() => !document.querySelector('#text-preview').hidden);
  await page.type('#composer', 'Preserved question');
  await page.setViewport({ width: 1440, height: 900 });
  await contentToolForPage(page, ['view', 'text-mode']);
  await page.waitForFunction(() => !document.querySelector('#text-host').hidden);
  assert.equal(await page.$eval('#text-host', node => node.hidden), false);
  await page.evaluate(() => window.__nozeliInput.replace('# Updated\n\nReal saved edit.\n'));
  await page.waitForFunction(() => document.querySelector('#save-status').textContent === '已保存');
  assert.equal(await readFile(path.join(project, relPath), 'utf8'), '# Updated\n\nReal saved edit.\n');
  await contentToolForPage(page, ['view', 'text-mode']);
  await page.waitForFunction(() => !document.querySelector('#text-preview').hidden);
  assert.equal(await page.$eval('#text-preview', node => node.hidden), false);
  report.checks.push('content menu switches reading/editing while real saved edits persist');
  await contentToolForPage(page, ['history', 'compareFile']); await page.waitForSelector('#beside-dialog[open]'); await page.select('#beside-file', 'other.md'); await page.click('#beside-form button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#reader').classList.contains('document-dual'));
  await page.screenshot({ path: path.join(output, 'dual-1440.png') });
  await page.click('#diff-mode'); await page.waitForSelector('.document-diff .cm-mergeView');
  await page.click('#compare-mode'); await page.waitForFunction(() => !document.querySelector('.document-diff'));
  await page.click('#secondary-close'); if (await page.waitForSelector('#action-confirmation[open]', { timeout: 2000 }).catch(() => null)) await page.click('#action-confirmation-accept'); await page.waitForFunction(() => !document.querySelector('#reader').classList.contains('document-dual'));
  assert.equal(await page.$eval('#composer', node => node.value), 'Preserved question');
  report.checks.push('comparison and Diff remain usable without losing the conversation draft');
  const savedText = await readFile(path.join(project, relPath), 'utf8');
  await writeFile(path.join(project, relPath), '# External change\n');
  await page.evaluate(() => window.__nozeliInput.replace('# My unsaved change\n'));
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'conflict');
  assert.equal(await readFile(path.join(project, relPath), 'utf8'), '# External change\n');
  assert.equal(await page.$eval('#save-status', node => node.title), '保存失败');
  assert.equal(await page.$eval('#save-failure', node => node.hidden), false);
  await page.setViewport({ width: 800, height: 900 });
  await page.screenshot({ path: path.join(output, 'conflict-800.png') });
  await writeFile(path.join(project, relPath), savedText);
  await page.click('#retry-save');
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  assert.equal(await readFile(path.join(project, relPath), 'utf8'), '# My unsaved change\n');
  report.checks.push('real concurrent file change remains protected; compact conflict indicator and retry work');
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('#file-tree button[data-path="sample.pdf"]'); await page.waitForSelector('#pdf-host canvas');
  await page.screenshot({ path: path.join(output, 'pdf-1440.png') });
  report.checks.push('PDF still renders after switching from text');
  await page.click('#close-subject'); if (await page.waitForSelector('#action-confirmation[open]', { timeout: 2000 }).catch(() => null)) await page.click('#action-confirmation-accept');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.includes('较长的文件标题'));
  report.checks.push('closing the current file switches to the remaining tab');
  await page.click('#close-subject'); if (await page.waitForSelector('#action-confirmation[open]', { timeout: 2000 }).catch(() => null)) await page.click('#action-confirmation-accept');
  await page.waitForFunction(() => !document.querySelector('#empty').hidden);
  report.checks.push('closing the last file restores the empty workspace');
  assert.deepEqual(report.errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }));
} catch (error) {
  report.failure = error.stack;
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.error('Evidence: ' + output); throw error;
} finally {
  await browser?.disconnect();
  if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  let timer; const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]); clearTimeout(timer);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
}
