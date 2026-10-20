import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { DesktopHost } from '../src/main/host.mjs';

// The fixture isolates UI readiness; this test makes no native CLI claims.
const root = path.resolve(import.meta.dirname, '..');
const out = await fs.mkdtemp(path.join(root, '.test-output/agent-availability-'));
const profile = path.join(out, 'profile');
const host = new DesktopHost(profile);
const projects = {};
for (const name of ['尚未配置', '已配置']) {
  const directory = path.join(out, name);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, '阅读.md'), '# ' + name + '\n\n保留本地阅读和讨论草稿。');
  projects[name] = (await host.pick(directory)).project;
}
const port = await new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const selected = server.address().port; server.close(() => resolve(selected)); });
});
const child = spawn(createRequire(import.meta.url)('electron'), [path.join(root, 'src/main/main.cjs'), '--ozone-platform=wayland'], {
  cwd: root,
  env: { ...process.env, WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000', NOZELI_TEST_INSTANCE: '1', NOZELI_HIDDEN: '0', NOZELI_AGENT_FIXTURE: '1', NOZELI_USER_DATA: profile, NOZELI_DEBUG_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser, log = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', value => log += value);
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
const checks = [], errors = [];
try {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:' + port, defaultViewport: null }); break; } catch {}
    if (child.exitCode !== null) throw Error(log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(browser, log);
  const page = (await browser.pages())[0];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.__nozeliReady && document.querySelector('#agent-setup').open);
  await page.evaluate(() => {
    for (const id of ['agent-foreground', 'agent-background']) {
      const select = document.getElementById(id);
      select.value = [...select.options].find(item => !item.disabled && item.value)?.value;
    }
    document.querySelector('#agent-setup-form').requestSubmit();
  });
  await page.waitForFunction(() => !document.querySelector('#agent-setup').open && !document.querySelector('#send-message').disabled && !document.querySelector('#selection-explain').disabled);
  checks.push('configured project enables sending and explanations only after foreground readiness');
  await page.click('#recent button[title="尚未配置"]');
  await page.waitForFunction(() => document.querySelector('#project-name').textContent === '尚未配置' && document.querySelector('#agent-setup').open);
  const unavailable = () => page.evaluate(() => ({ send: document.querySelector('#send-message').disabled, explain: document.querySelector('#selection-explain').disabled, discuss: document.querySelector('#selection-discuss').disabled, state: document.querySelector('#ai-status').dataset.state }));
  assert.deepEqual(await unavailable(), { send: true, explain: true, discuss: false, state: 'unavailable' });
  await page.click('#agent-skip');
  assert.deepEqual(await unavailable(), { send: true, explain: true, discuss: false, state: 'unavailable' });
  await page.type('#composer', '尚未配置项目的草稿');
  assert.equal(await page.evaluate(() => window.__agentSend()), undefined);
  assert.equal(await page.$eval('#composer', node => node.value), '尚未配置项目的草稿');
  const messages = await page.evaluate(id => nozeli.invoke('agents.messages', { projectId: id }), projects['尚未配置'].id);
  assert.equal(messages.value.messages.length, 0);
  checks.push('switching to unconfigured project immediately disables stale controls; skipping preserves draft and sends nothing');
  await page.reload();
  await page.waitForFunction(() => window.__nozeliReady && document.querySelector('#project-name').textContent === '尚未配置');
  await page.waitForFunction(() => document.querySelector('#ai-status').dataset.state === 'unavailable');
  assert.deepEqual(await unavailable(), { send: true, explain: true, discuss: false, state: 'unavailable' });
  checks.push('unconfigured status remains unavailable after refresh and profile restoration');
  await page.click('#recent button[title="已配置"]');
  await page.waitForFunction(() => document.querySelector('#project-name').textContent === '已配置' && !document.querySelector('#send-message').disabled && !document.querySelector('#selection-explain').disabled);
  assert.equal(await page.$eval('#agent-setup', node => node.open), false);
  checks.push('returning to configured project restores current readiness without changing its settings');
  assert.deepEqual(errors, []);
  await page.evaluate(() => nozeli.invoke('session.requestClose'));
  const exit = await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('normal close timed out')), 12000); timer.unref(); })]);
  assert.deepEqual(exit, { code: 0, signal: null });
  checks.push('normal close flushes profile and exits zero');
  const result = { passed: true, kind: 'real-electron-with-agent-ui-fixture', checks, errors, exit, out };
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await fs.writeFile(path.join(out, 'failure.txt'), error.stack);
  throw error;
} finally {
  await browser?.disconnect();
  if (child.exitCode === null) child.kill('SIGTERM');
  await fs.writeFile(path.join(out, 'main.log'), log);
}
