// Real-Electron regression check for the legacy demo exit deadlock: a demo
// copy whose active sample.tex is missing must never block project retirement
// with PROJECT_FLUSH_FAILED, must not pretend its surface is ready, and the
// session must still leave through a normal exit 0 after retiring the stale
// copy onto the current template.
//
// Two launch modes:
//   node failed-surface-exit-check.mjs --app-root <repo>/apps/desktop
//     Spawns the source tree with the dev Electron binary.
//   node failed-surface-exit-check.mjs --release <releases>/<timestamp>
//     Spawns <release>/nozeli directly (installed acceptance).
//
// Isolation: sanitized HOME/XDG_* and NOZELI_TEST_INSTANCE plus a dedicated
// CDP port separate this instance from the user session. Packaged builds
// ignore NODE_OPTIONS, so no pre-main observer is injected and this report
// explicitly does not claim full-process network isolation.
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = (await import(require.resolve('puppeteer-core'))).default;
const arguments_ = process.argv.slice(2);
const option = name => { const index = arguments_.indexOf(name); return index >= 0 ? arguments_[index + 1] : null; };
const appRootOption = option('--app-root'), releaseOption = option('--release');
assert(appRootOption || releaseOption, 'pass --app-root <apps/desktop> or --release <release-dir>');
assert(!(appRootOption && releaseOption), 'pass exactly one of --app-root / --release');
const mode = appRootOption ? 'source' : 'installed';
const appRoot = appRootOption ? path.resolve(appRootOption) : null;
const release = releaseOption ? path.resolve(releaseOption) : null;
const binary = appRoot ? createRequire(path.join(appRoot, 'package.json'))('electron') : path.join(release, 'nozeli');
const appArguments = appRoot ? [path.join(appRoot, 'src/main/main.cjs')] : [];

const root = await fs.mkdtemp(path.join(tmpdir(), `nozeli-failed-surface-exit-${mode}-`));
const report = {
  ok: false,
  kind: 'failed-surface-exit-check',
  mode,
  root,
  binary,
  appRoot,
  release,
  coverage: 'No NODE_OPTIONS observer is injected (packaged builds ignore it). Sanitized HOME/XDG_* and NOZELI_TEST_INSTANCE plus a dedicated CDP port isolate this instance; Chromium host-resolver rules reduce DNS-name access. This is not full network or syscall isolation and is not claimed as such.',
  checks: [],
  scenes: [],
  normalExits: [],
  errors: [],
};
console.log('EVIDENCE_ROOT=' + root);
let child, exited, browser, log = '', shell, controls;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  do {
    if (child && (child.exitCode !== null || child.signalCode)) throw new Error('Electron exited while waiting for ' + label + '\n' + log);
    const value = await fn();
    if (value) return value;
    await sleep(75);
  } while (Date.now() < deadline);
  throw new Error('Timed out: ' + label);
}
async function invoke(page, operation, payload = {}) {
  const result = await page.evaluate(({ operation, payload }) => window.nozeli.invoke(operation, payload), { operation, payload });
  assert(result.ok, `${operation}: ${JSON.stringify(result.error)}`);
  return result.value;
}
async function scope(predicate, label) {
  return until(async () => {
    for (const page of await browser.pages()) {
      const identity = await page.evaluate(async () => {
        if (!window.nozeli) return null;
        const result = await window.nozeli.invoke('workspace.bootstrap', {});
        return result.ok ? result.value : null;
      }).catch(() => null);
      if (identity && predicate(identity) && await page.evaluate(() => window.__nozeliReady === true).catch(() => false)) return { page, scope: identity };
    }
    return null;
  }, label);
}
function isolatedEnvironment(port) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key) || /^(?:CCB_|CODEX_|OMP_|PI_|ANTHROPIC_|OPENAI_|NOZELI_)/.test(key) || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
  }
  return Object.assign(env, {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'home', '.config'),
    XDG_DATA_HOME: path.join(root, 'home', '.local', 'share'),
    XDG_CACHE_HOME: path.join(root, 'home', '.cache'),
    NOZELI_TEST_INSTANCE: '1',
    NOZELI_CONFIG_ROOT: path.join(root, 'config'),
    NOZELI_USER_DATA: path.join(root, 'config', 'desktop'),
    NOZELI_GUIDED_DEMO_ROOT: path.join(root, 'examples'),
    NOZELI_DEBUG_PORT: String(port),
    NOZELI_HIDDEN: '0',
  });
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function launch() {
  const port = await freePort();
  const env = isolatedEnvironment(port);
  await fs.mkdir(env.HOME, { recursive: true, mode: 0o700 });
  log += `\n=== launch on CDP ${port} ===\n`;
  child = spawn(binary, [...appArguments, `--ozone-platform=${process.env.NOZELI_OZONE || 'wayland'}`, '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'], { cwd: '/tmp', env, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; });
  browser = await until(() => puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null }).catch(() => null), 'CDP endpoint');
  const observe = page => page.on('pageerror', error => report.errors.push(String(error.stack || error)));
  for (const page of await browser.pages()) observe(page);
  browser.on('targetcreated', async target => { const page = await target.page().catch(() => null); if (page) observe(page); });
  ({ page: shell } = await scope(scope => scope.role === 'shell', 'shell window'));
}
async function requestCloseExpectZero(scene) {
  const response = await shell.evaluate(() => window.nozeli.invoke('session.requestClose', {}));
  assert(response.ok, `session.requestClose: ${JSON.stringify(response.error)}`);
  const result = await Promise.race([exited, sleep(20_000).then(() => null)]);
  assert.deepEqual(result, { code: 0, signal: null }, scene + ': normal close must exit 0');
  report.normalExits.push({ scene, ...result });
  await browser?.disconnect();
  browser = null;
}
function firstGroup(node) {
  return node.kind === 'group' ? node.id : firstGroup(node.first) || firstGroup(node.second);
}
const controlsState = () => invoke(controls, 'workspace.bootstrap');
const activeProject = async () => (await invoke(shell, 'workspace.bootstrap')).projectId;

try {
  // Run 1: fresh demo, paused, opens sample.tex through a real layout command.
  await launch();
  await shell.click('#start-demo-entry');
  ({ page: controls } = await scope(scope => scope.role === 'demo-controls', 'demo controls'));
  await until(async () => (await controlsState()).model?.status === 'playing', 'learning starts playing');
  const oldId = (await controlsState()).model.projectId;
  const oldRoot = (await invoke(shell, 'demo.state', { projectId: oldId })).project.rootDisplay;
  await controls.click('[data-demo-control="play"]');
  await until(async () => (await controlsState()).model.status === 'paused', 'demo pauses');
  const snapshot = await invoke(shell, 'workspace.snapshot', { projectId: oldId });
  await invoke(shell, 'workspace.command', {
    projectId: oldId,
    expectedRevision: snapshot.layout.revision,
    requestKey: 'failed-surface-exit-open-sample-tex',
    command: { type: 'open', groupId: firstGroup(snapshot.layout.mainRoot), view: { kind: 'document', relPath: 'sample.tex' } },
  });
  const tex = await scope(scope => scope.projectId === oldId && scope.relPath === 'sample.tex', 'sample.tex surface');
  await tex.page.waitForFunction(() => document.body.innerText.includes('documentclass'), { timeout: 45_000 });
  report.checks.push('Paused demo opens sample.tex via workspace.command (expectedRevision/requestKey/groupId/view) and renders TeX');
  await requestCloseExpectZero('ready-tex-close');
  report.checks.push('Normal close with ready TeX content exits 0');

  // Degrade to a stale template with a missing expected file on disk.
  const registryFile = path.join(root, 'config/desktop/guided-demo/registry.json');
  const registry = JSON.parse(await fs.readFile(registryFile, 'utf8'));
  const row = registry.projects[oldId];
  assert(row.expectedFiles['sample.tex'] !== undefined, 'current template must expect sample.tex');
  row.templateVersion = '1';
  row.templateDigest = 'legacy-v1-digest';
  delete row.expectedFiles['sample.tex'];
  await fs.rm(path.join(oldRoot, 'sample.tex'));
  await fs.writeFile(path.join(oldRoot, 'my-note.txt'), 'KEEP OLD EXPLORATION');
  await fs.writeFile(registryFile, JSON.stringify(registry));
  report.checks.push('Registry degraded (templateVersion 1, stale digest, no expectedFiles.sample.tex); disk copy missing sample.tex, keeps my-note.txt');

  // Run 2: reopen the legacy project; its persisted layout still opens the
  // now-missing file. The surface must fail init and never claim readiness.
  await launch();
  await shell.waitForSelector(`[data-project-id="${oldId}"]`, { visible: true });
  await shell.click(`[data-project-id="${oldId}"]`);
  await until(async () => await activeProject() === oldId, 'legacy project reopens');
  const broken = await until(async () => {
    for (const page of await browser.pages()) {
      const identity = await page.evaluate(async () => {
        if (!window.nozeli) return null;
        const result = await window.nozeli.invoke('workspace.bootstrap', {});
        return result.ok ? result.value : null;
      }).catch(() => null);
      if (identity?.projectId === oldId && identity.relPath === 'sample.tex' && identity.contentFailed === true) return { page, scope: identity };
    }
    return null;
  }, 'missing sample.tex surface reports terminal init failure');
  const brokenText = await broken.page.evaluate(() => document.body.innerText);
  assert(brokenText.includes('原项目内容未能载入'), 'failure surface must say content never loaded');
  const focus = await shell.evaluate(viewId => window.nozeli.invoke('workspace.focus', { viewId }), broken.scope.viewId);
  assert.equal(focus.ok, false, 'failed surface must not gain ready-gated admission');
  assert.equal(focus.error.code, 'SURFACE_NOT_READY');
  await broken.page.screenshot({ path: path.join(root, 'legacy-missing-tex.png') });
  report.scenes.push({ name: 'legacy-missing-tex', file: 'legacy-missing-tex.png', projectId: oldId, viewId: broken.scope.viewId });
  report.checks.push('Missing-file surface reports contentFailed, shows honest failure text and stays SURFACE_NOT_READY');

  // Starting learning again retires the stale copy and plays a fresh v2 one.
  await shell.click('#open-settings');
  await shell.click('[data-settings-section="settings-help"]');
  await shell.click('#settings-demo-help');
  ({ page: controls } = await scope(scope => scope.role === 'demo-controls', 'new demo controls'));
  const fresh = await until(async () => {
    const model = (await controlsState()).model;
    return model?.projectId !== oldId && model?.status === 'playing' ? model : null;
  }, 'legacy copy retires and the new template starts playing', 90_000);
  const newState = await invoke(shell, 'demo.state', { projectId: fresh.projectId });
  assert.equal(newState.templateVersion, '2');
  assert((await fs.readFile(path.join(newState.project.rootDisplay, 'sample.tex'), 'utf8')).includes('documentclass'));
  assert.equal(await fs.readFile(path.join(oldRoot, 'my-note.txt'), 'utf8'), 'KEEP OLD EXPLORATION');
  await assert.rejects(fs.stat(path.join(oldRoot, 'sample.tex')), { code: 'ENOENT' });
  assert.equal((await invoke(shell, 'demo.state', { projectId: oldId })).isDemo, false);
  assert(!(await invoke(shell, 'project.recent')).projects.some(project => project.id === oldId));
  report.checks.push('Retirement closes the failed-surface project, creates v2 with sample.tex and preserves old exploration notes');

  // End the demo, then leave through a normal exit 0.
  await controls.click('[data-demo-control="stop"]');
  await until(async () => await activeProject() === null && !(await controlsState()).visible, 'demo end returns to the start workspace');
  assert.equal((await invoke(shell, 'demo.state', {})).projects.length, 0);
  report.checks.push('Demo end removes the registry entry and returns to the start workspace');
  await requestCloseExpectZero('after-demo-end-close');
  report.checks.push('Final normal close after ending the demo exits 0');
  assert.deepEqual(report.errors, []);
  report.ok = true;
} catch (error) {
  report.failure = error.stack;
  console.log(report.failure);
  if (shell) {
    await shell.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    console.log(await shell.evaluate(() => document.body.innerText.slice(-2500)).catch(() => null));
  }
  if (controls) console.log('CONTROLS', JSON.stringify(await controlsState().catch(() => null)));
  process.exitCode = 1;
} finally {
  await browser?.disconnect();
  if (child && child.exitCode === null && !child.signalCode) {
    report.cleanup = { forced: true };
    child.kill('SIGTERM');
    const stopped = await Promise.race([exited.then(() => true), sleep(4_000).then(() => false)]);
    if (!stopped) { child.kill('SIGKILL'); await exited; report.cleanup.signal = 'SIGKILL'; }
    else report.cleanup.signal = 'SIGTERM';
  }
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(root, 'main.log'), log);
  console.log(JSON.stringify({ ok: report.ok, root, mode, checks: report.checks, normalExits: report.normalExits, errors: report.errors, failure: report.failure }, null, 2));
}
