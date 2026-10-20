import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const root = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(root, '.test-output', 'tag-removal-'));
const project = path.join(output, 'project');
await mkdir(project);
await writeFile(path.join(project, 'sample.md'), '# Reading\n\nUnique selection for a discussion.\n');
await writeFile(path.join(project, 'other.md'), '# Another document\n');
const port = await new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const require = createRequire(import.meta.url);
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(require('electron'), ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise(resolve => child.once('exit', resolve));
let log = '', browser;
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
try {
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) throw new Error(log);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Startup timeout: ' + log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const page = (await browser.pages()).find(page => page.url().includes('127.0.0.1'));
  await page.waitForFunction(() => window.__nozeliReady);
  await page.setViewport({ width: 1200, height: 800 });
  await page.click('#pick-project');
  await page.waitForSelector('#agent-setup[open]');
  await page.click('#agent-skip');
  await page.click('#file-tree button[data-path="sample.md"]');
  await page.waitForFunction(() => !document.querySelector('#text-preview').hidden);
  const report = { checks: [] };
  for (const mode of ['read', 'edit']) {
    if (mode === 'edit') await page.click('#text-mode-toggle');
    for (const collapsed of [false, true]) {
      await page.evaluate(mode => {
        if (mode === 'edit') {
          window.__nozeliInput.select(12, 28);
        } else {
          const node = document.querySelector('#text-preview p').firstChild;
          const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 16);
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          document.querySelector('#text-preview').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        }
      }, mode);
      await page.click('#selection-discuss');
      const selector = (mode === 'read' ? '#text-preview' : '#text-host') + ' .note-anchor.tag-discuss';
      await page.waitForSelector(selector + ' .tag-remove');
      await page.type(selector + ' .tag-editor', 'Local question draft');
      if (collapsed) await page.click(selector + ' .tag-close');
      const remove = selector + ' .tag-remove';
      const label = await page.$eval(remove, node => ({ title: node.title, bounds: node.getBoundingClientRect().toJSON() }));
      assert.match(label.title, /保留对话历史/);
      assert.ok(label.bounds.width >= 25 && label.bounds.height >= 25);
      await page.screenshot({ path: path.join(output, `${mode}-${collapsed ? 'collapsed' : 'expanded'}.png`) });
      if (collapsed) { await page.focus(remove); await page.keyboard.press('Enter'); }
      else await page.click(remove);
      await page.waitForFunction(() => !document.querySelector('.note-anchor.tag-discuss'));
      await page.click('#font-larger');
      assert.equal(await page.$(selector), null, 'redraw restored removed projection');
      report.checks.push(`${mode}: ${collapsed ? 'collapsed keyboard' : 'expanded pointer'} removal and redraw`);
    }
  }
  await page.click('#file-tree button[data-path="other.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent === 'other.md');
  await page.click('#file-tree button[data-path="sample.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent === 'sample.md');
  assert.equal(await page.$('.note-anchor.tag-discuss'), null);
  report.checks.push('removed projections stay absent after document reopen');
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }));
} finally {
  await browser?.disconnect();
  if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
  clearTimeout(timer);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
}
