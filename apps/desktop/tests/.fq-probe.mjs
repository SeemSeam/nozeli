// One-off diagnostic probe for the editor-typing step (registry-launched).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {prepareReading} from './reading-setup.fixture.mjs';

const out = process.argv[2];
assert(out && path.isAbsolute(out));
await fs.mkdir(out, {recursive: true});
console.log('probe env TEMP=', process.env.TEMP, 'OUTPUT_ROOT=', process.env.NOZELI_TEST_OUTPUT_ROOT);
const app = path.resolve(import.meta.dirname, '..');
const configRoot = path.join(out, '.Nozeli'), profile = path.join(configRoot, 'desktop');
const project = path.join(out, 'project');
await fs.mkdir(project, {recursive: true});
await fs.writeFile(path.join(project, 'edit.txt'), 'Original editable text.\n');
const require_ = createRequire(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const port = await new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const value = server.address().port; server.close(() => resolve(value));});});
const env = {...process.env};
for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key) || /^path$/i.test(key) || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
env.Path = path.join(env.SystemRoot ?? env.SYSTEMROOT, 'System32');
Object.assign(env, {NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: configRoot, NOZELI_USER_DATA: profile, NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0', NOZELI_SHOT_DIR: out});
console.log('app env TEMP=', env.TEMP);
const child = spawn(require_('electron'), [path.join(app, 'src/main/main.cjs')], {cwd: out, env, stdio: ['ignore', 'pipe', 'pipe']});
let log = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {log += chunk;});
const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));

async function until(fn, label, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
async function state(page) {
  return page.evaluate(() => ({
    focused: document.hasFocus(),
    visibility: document.visibilityState,
    inEditor: !!document.activeElement?.closest('#text-host .cm-editor'),
    text: window.__nozeliInput?.text?.() ?? null,
    saveStatus: document.querySelector('#save-status')?.dataset?.state ?? null,
    keys: (window.__fqKeys ?? []).slice(-8),
  }));
}
try {
  const browser = await until(() => puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null, protocolTimeout: 60000}).catch(() => null), 'CDP');
  const shell = await until(async () => {for (const target of await browser.pages()) if (target.url().startsWith('http://127.0.0.1:') && await target.evaluate(() => window.__nozeliReady && window.__workspaceScope?.role === 'shell').catch(() => false)) return target;}, 'shell');
  await prepareReading(shell);
  await shell.bringToFront();
  const invoke = async (op, payload = {}) => {
    const response = await shell.evaluate(({op, payload}) => nozeli.invoke(op, payload), {op, payload});
    assert.equal(response.ok, true, op + ': ' + JSON.stringify(response.error));
    return response.value;
  };
  await invoke('session.resize', {width: 1440, height: 900});
  await shell.waitForFunction(() => {const button = document.getElementById('pick-project'); return button && !button.disabled && !button.hidden && document.visibilityState === 'visible';});
  await shell.click('#pick-project');
  const projectId = (await until(async () => (await invoke('project.recent')).projects.find(row => path.relative(row.rootDisplay, project) === ''), 'registered')).id;
  await shell.waitForFunction(id => document.querySelector('#recent button[aria-current="true"]')?.dataset.projectId === id, {}, projectId);
  console.log('project picked', projectId);

  await shell.waitForSelector('#file-tree button[data-path="edit.txt"]', {visible: true});
  await shell.click('#file-tree button[data-path="edit.txt"]');
  const page = await until(async () => {for (const target of await browser.pages()) if (await target.evaluate(() => window.__nozeliReady && window.__workspaceScope?.kind === 'document' && window.__workspaceScope.relPath === 'edit.txt').catch(() => false)) return target;}, 'document surface');
  await page.bringToFront();
  await page.waitForSelector('#text-host .cm-content', {visible: true});
  await page.evaluate(() => {window.__fqKeys = []; for (const type of ['keydown', 'beforeinput', 'keypress', 'compositionstart']) document.addEventListener(type, event => window.__fqKeys.push(type + ':' + (event.data ?? event.key ?? '')), true);});
  await page.click('#text-host .cm-content');
  await page.evaluate(() => window.__nozeliInput.focus());
  await page.waitForFunction(() => document.hasFocus() && document.activeElement?.closest('#text-host .cm-editor'));
  await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
  await pause(200);
  console.log('driver-flow state:', JSON.stringify(await state(page)));
  await page.keyboard.type('UNSENT_FORCEQUIT_STALL_DRAFT');
  await pause(700);
  console.log('after driver-flow type:', JSON.stringify(await state(page)));
  await page.screenshot({path: path.join(out, 'probe.png')});
  await browser.disconnect();
} catch (error) {
  console.error('PROBE-FAIL', error.stack);
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([exited, pause(3000)]);
  await fs.writeFile(path.join(out, 'probe-main.log'), log);
}
