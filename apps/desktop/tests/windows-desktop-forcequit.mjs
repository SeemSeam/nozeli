// Windows native force-quit GUI acceptance: a fresh visible Electron instance
// with an isolated synthetic profile/project and a System32-only PATH, a real
// ordinary project terminal (ConPTY shell + a typed long-running program) as
// the owned descendant tree, an independent unrelated sentinel, and a real
// stalled normal close (blocked shell renderer) plus a real crashed-renderer
// close. The explicit user force-quit control is exercised through the
// product's native recovery dialogs (工作区恢复 → 强制退出… → 确认强制退出 →
// 强制退出) driven by Windows UI Automation. Exits are observed only through
// pinned native process identities; no taskkill, no PID adoption, and no
// fabricated flush acknowledgement. VM/CDP/UIA gestures are not physical
// keyboard/IME/device proof.
// Retained open observation: one earlier crashed-renderer run (v13,
// source-gui-forcequit-final-v13) observed the OS exit signal 14.7s after the
// confirmed force-quit click. It never reproduced in five later force quits
// (1761/402/359ms and two green sub-8s runs) and the in-process app.exit
// diagnostic failed in the inspector realm that day, so the latency ORIGIN
// (OS teardown vs product-side delay) remains UNEXPLAINED, not classified.
// The v13 artifacts are preserved unchanged; the 8s bound is unchanged.
// Run from apps/desktop: node tests/windows-desktop-forcequit.mjs <fresh absolute output> [application] [executable]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {prepareReading} from './reading-setup.fixture.mjs';
import {UiaAgent, pinProcessTree, waitForExited, assertRunning} from './windows-desktop-forcequit-uia.mjs';

const [requestedOutput, application, executable] = process.argv.slice(2);
assert.equal(process.platform, 'win32', 'Windows native acceptance only');
assert(requestedOutput && path.isAbsolute(requestedOutput), 'fresh absolute evidence directory required');
if (process.versions.electron && !process.env.NOZELI_TEST_NODE_EXECUTABLE) throw new Error('run this driver under Node so the sentinel and the typed program are plain unrelated/owned Node processes');
const app = path.resolve(application ?? path.join(import.meta.dirname, '..'));
const packaged = Boolean(executable);
const require_ = createRequire(import.meta.url);
const native = require_(path.join(app, 'native', 'windows-process', 'build', 'Release', 'nozeli_windows_process.node'));
const electronCommand = executable ?? require_('electron');
const electronImage = path.resolve(electronCommand);
const nodeExe = process.versions.electron ? process.env.NOZELI_TEST_NODE_EXECUTABLE : process.execPath;

const out = requestedOutput;
await fs.mkdir(out);
const configRoot = path.join(out, '.Nozeli'), profile = path.join(configRoot, 'desktop');
const checks = [], errors = [], runs = [], scenarios = {};
const projectIds = new Map();
let child, browser, shell, page, exited, uia, sentinel, sentinelPin, rootPin, stage = '', result;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = row => ({pid: row.pid, name: row.name ?? null, image: row.imagePath ?? row.image ?? null, stamp: row.stamp ?? null, command: row.command ?? null});
async function mark(phase) { runs.at(-1).phase = phase; await fs.writeFile(path.join(out, 'progress.json'), JSON.stringify({phase, pid: child?.pid ?? null, at: new Date().toISOString()}, null, 2) + '\n'); }
async function until(fn, label, ms = 45000, allowExit = false) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!allowExit && child && child.exitCode !== null) throw new Error('Electron exited before ' + label + ': ' + (runs.at(-1)?.log ?? '').slice(-4000));
    const value = await fn();
    if (value) return value;
    await pause(80);
  }
  throw new Error('Timed out: ' + label);
}
async function invoke(op, payload = {}, target = shell) {
  const response = await target.evaluate(({op, payload}) => nozeli.invoke(op, payload), {op, payload});
  assert.equal(response.ok, true, op + ': ' + JSON.stringify(response.error));
  return response.value;
}
async function surface(kind, relPath) {
  return until(async () => {
    for (const target of await browser.pages()) {
      if (await target.evaluate(({kind, relPath}) => window.__nozeliReady && window.__workspaceScope?.kind === kind && (!relPath || window.__workspaceScope.relPath === relPath), {kind, relPath}).catch(() => false)) return target;
    }
  }, kind + ' surface' + (relPath ? ' ' + relPath : ''));
}
async function open(rel) {
  await shell.waitForSelector('#file-tree button[data-path="' + rel + '"]', {visible: true});
  await shell.click('#file-tree button[data-path="' + rel + '"]');
  page = await surface('document', rel);
  await page.bringToFront();
  return page;
}
// Real keyboard input with a bounded, user-like retry: if a burst is lost to
// a focus/mount race the driver re-focuses the app's own input anchor and
// types only the missing suffix. The input trace records what the page really
// received; nothing is inserted by bypassing the editor.
async function typeDraft(page, draftText, baseline, receipt) {
  await page.evaluate(() => {
    window.__fqInputTrace = [];
    for (const type of ['keydown', 'beforeinput', 'keypress', 'compositionstart', 'compositionend']) document.addEventListener(type, event => window.__fqInputTrace.push(type + ':' + String(event.data ?? event.key ?? '')), true);
  });
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.evaluate(() => window.__nozeliInput.focus());
    await page.waitForFunction(() => document.hasFocus() && document.activeElement?.closest('#text-host .cm-editor'));
    await page.keyboard.down('Control'); await page.keyboard.press('End'); await page.keyboard.up('Control');
    const current = await page.evaluate(() => window.__nozeliInput.text());
    if (current === draftText) { attempts.push({attempt, done: true}); break; }
    if (current !== baseline && !draftText.startsWith(current)) throw new Error('editor holds unexpected text before typing: ' + JSON.stringify(current));
    const remaining = draftText.slice(current.length);
    if (remaining) await page.keyboard.type(remaining);
    await pause(400);
    attempts.push({attempt, typed: remaining.length, current: await page.evaluate(() => window.__nozeliInput.text())});
    if (attempts.at(-1).current === draftText) break;
  }
  const state = await page.evaluate(() => ({text: window.__nozeliInput.text(), trace: (window.__fqInputTrace ?? []).slice(-24), active: String(document.activeElement?.className ?? ''), visibility: document.visibilityState}));
  receipt.typing = [...(receipt.typing ?? []), {attempts, finalText: state.text, trace: state.trace, active: state.active, visibility: state.visibility}];
  assert.equal(state.text, draftText, 'real keyboard input must reach the editor; received trace: ' + JSON.stringify(state.trace));
}
async function recoveryCursor(projectId, visitor) {
  let cursor, found = [];
  do {
    const listing = await invoke('workspace.recovery.list', {cursor});
    for (const row of listing.entries) {
      if (row.project?.id !== projectId) continue;
      const detail = await invoke('workspace.recovery.detail', {projectId, id: row.id, revision: row.revision, version: row.version});
      if (visitor(detail.value, row)) found.push({row: {id: row.id, revision: row.revision, version: row.version}, detail: {candidateText: detail.value?.candidate?.text ?? null, kind: detail.value?.kind ?? null}});
    }
    cursor = listing.nextCursor;
  } while (cursor);
  return found;
}
const appExitTrace = path.join(out, 'forcequit-appexit-trace.jsonl');
const appExitPatchSource = `(() => {
  // The inspector evaluate realm has no CJS require; the entry module's own
  // loader is the product-context way to reach electron/fs.
  const require_ = process.mainModule && process.mainModule.require;
  if (!require_) return 'no-main-module';
  const fs = require_('node:fs');
  const {app} = require_('electron');
  globalThis.__fqTrace = globalThis.__fqTrace || [];
  if (app.__fqPatched) return 'already';
  app.__fqPatched = true;
  const orig = app.exit.bind(app);
  app.exit = code => {
    const entry = {event: 'app.exit', pid: process.pid, at: Date.now(), code, stack: String(new Error().stack).split('\\n').slice(1, 7).join(' | ')};
    globalThis.__fqTrace.push(entry);
    try { fs.appendFileSync(${JSON.stringify(appExitTrace)}, JSON.stringify(entry) + '\\n'); } catch {}
    return orig(code);
  };
  return 'patched';
})()`;
async function patchAppExit(inspectPort) {
  const list = await (await fetch('http://127.0.0.1:' + inspectPort + '/json/list')).json();
  const WebSocket = require_('ws');
  const outcomes = [];
  for (const target of list.filter(entry => entry.webSocketDebuggerUrl)) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
      const call = (id, method, params = {}) => new Promise((resolve, reject) => {
        const handler = data => { const message = JSON.parse(String(data)); if (message.id === id) { socket.off('message', handler); resolve(message); } };
        socket.on('message', handler);
        socket.send(JSON.stringify({id, method, params}));
        setTimeout(() => { socket.off('message', handler); reject(new Error('inspector ' + method + ' timed out')); }, 10000);
      });
      await call(1, 'Runtime.enable');
      const reply = await call(2, 'Runtime.evaluate', {expression: appExitPatchSource});
      outcomes.push({target: target.title ?? target.id, value: reply.result?.result?.value ?? null, exception: reply.result?.exceptionDetails?.exception?.description ?? reply.result?.exceptionDetails?.text ?? null, error: reply.error ?? null});
    } catch (error) {
      outcomes.push({target: target.title ?? target.id, error: error.message});
    } finally { try { socket.close(); } catch {} }
  }
  return outcomes;
}
async function launch(project) {
  const port = await new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const value = server.address().port; server.close(() => resolve(value));});});
  const inspectPort = await new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const value = server.address().port; server.close(() => resolve(value));});});
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key) || /^path$/i.test(key) || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
  // The actual child cannot discover development Node/Git/Bash on PATH.
  env.Path = path.join(env.SystemRoot ?? env.SYSTEMROOT, 'System32');
  Object.assign(env, {NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: configRoot, NOZELI_USER_DATA: profile, NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0', NOZELI_SHOT_DIR: out});
  // Diagnostic in-process app.exit tracing is opt-in (NOZELI_FORCEQUIT_INSPECT=1):
  // the default acceptance path runs the app exactly as shipped, with the 8s
  // bound asserted on the observed OS exit.
  const inspectEnabled = process.env.NOZELI_FORCEQUIT_INSPECT === '1';
  const args = [...(packaged ? [] : [path.join(app, 'src/main/main.cjs')]), ...(inspectEnabled ? ['--inspect=' + inspectPort] : [])];
  child = spawn(electronCommand, args, {cwd: out, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false});
  const run = {pid: child.pid, command: electronCommand, args, cwd: out, systemOnlyPath: env.Path, packaged, appExitInstrumentation: inspectEnabled ? 'opt-in' : 'off', log: ''};
  runs.push(run);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {run.log += chunk;});
  exited = new Promise(resolve => {child.once('error', () => resolve(null)); child.once('exit', (code, signal) => resolve({code, signal}));});
  exited.catch(() => {});
  rootPin?.close();
  rootPin = native.openProcessIdentity(child.pid);
  await mark('connect-cdp');
  browser = await until(() => puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null, protocolTimeout: 60000}).catch(() => null), 'CDP');
  shell = await until(async () => {for (const target of await browser.pages()) if (target.url().startsWith('http://127.0.0.1:') && await target.evaluate(() => window.__nozeliReady && window.__workspaceScope?.role === 'shell').catch(() => false)) return target;}, 'visible shell');
  const observe = target => target.on('pageerror', error => errors.push(target.url() + ': ' + error.message));
  for (const target of await browser.pages()) observe(target);
  browser.on('targetcreated', async target => {const created = await target.page().catch(() => null); if (created) observe(created);});
  if (inspectEnabled) { try { run.appExitPatch = await patchAppExit(inspectPort); } catch (error) { run.appExitPatch = [{error: error.message}]; } }
  await prepareReading(shell);
  await shell.bringToFront();
  await invoke('session.resize', {width: 1440, height: 900});
  const windows = await invoke('workspace.windows.list');
  assert(windows.some(entry => entry.visible), 'native window must be visible');
  run.nativeWindows = windows.map(({visible, title}) => ({visible, title}));
  await mark('project-pick');
  const known = projectIds.get(project);
  if (known) {
    await shell.waitForSelector('[data-project-id="' + known + '"]', {visible: true});
    await shell.click('[data-project-id="' + known + '"]');
  } else {
    await shell.waitForFunction(() => {const button = document.getElementById('pick-project'); return button && !button.disabled && !button.hidden && document.visibilityState === 'visible';});
    await shell.click('#pick-project');
    projectIds.set(project, (await until(async () => (await invoke('project.recent')).projects.find(row => path.relative(row.rootDisplay, project) === ''), 'registered synthetic project via normalized root match')).id);
  }
  const projectId = projectIds.get(project);
  await shell.waitForFunction(id => document.querySelector('#recent button[aria-current="true"]')?.dataset.projectId === id, {}, projectId);
  assert.equal((await invoke('config.status')).initialized, false);
  return {run, projectId};
}
// The editor node is re-created by CodeMirror mounts, which can stale a
// queried element handle between query and click. The product's own input
// anchor is the real focus path (the same one the reading journey uses):
// focus it and require the editor to actually hold keyboard focus.
async function focusEditor(page) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.waitForSelector('#text-host .cm-content', {visible: true});
    await page.evaluate(() => window.__nozeliInput.focus());
    try {
      await page.waitForFunction(() => document.hasFocus() && document.activeElement?.closest('#text-host .cm-editor'), {timeout: 4000, polling: 200});
      return;
    } catch {
      await pause(400);
    }
  }
  throw new Error('editor surface did not take keyboard focus for real input');
}
async function stopCdp() {
  try { await browser?.disconnect(); } catch { /* the browser process may already be gone */ }
  browser = null; shell = null; page = null;
}
async function normalClose() {
  await invoke('session.requestClose');
  const exit = await Promise.race([exited, pause(15000).then(() => null)]);
  runs.at(-1).exit = exit;
  assert.deepEqual(exit, {code: 0, signal: null}, 'normal close must exit cleanly');
  await stopCdp();
  return exit;
}
async function forceQuitDialogs({dir, dialogWaitMs = 25000}) {
  const transcript = {};
  const names = window => new Set([...window.buttons, ...window.descendants.map(entry => entry.slice(entry.indexOf('=') + 1))]);
  // Electron renders the native recovery/confirmation dialogs as views inside
  // the owning window's UIA tree (ControlType.Window=工作区恢复 with Pane
  // buttons), so discovery is content-based: find the window whose subtree
  // contains the explicit 强制退出… control.
  const recovery = await uia.findDialog({pid: child.pid, label: '强制退出…', timeoutMs: dialogWaitMs}).catch(error => ({found: false, error: error.message}));
  transcript.recoveryFoundAt = Date.now();
  transcript.windowsAtRecovery = await uia.listWindows({pid: child.pid}).catch(() => ({windows: []}));
  if (!recovery.found) transcript.dialogNotFoundScreenshot = await uia.screenshotWindow({pid: child.pid, file: path.join(dir, 'dialog-not-found.png'), timeoutMs: 3000}).catch(error => ({ok: false, error: error.message}));
  assert.equal(recovery.found, true, 'native 工作区恢复 dialog must appear through the real close/recovery path; windows: ' + JSON.stringify(transcript.windowsAtRecovery));
  transcript.recovery = recovery.window;
  assert(names(recovery.window).has('强制退出…'), 'recovery dialog must expose the explicit 强制退出… control: ' + JSON.stringify(recovery.window.buttons.concat(recovery.window.descendants)));
  transcript.recoveryScreenshot = await uia.screenshotWindow({pid: child.pid, hwnd: recovery.window.hwnd, file: path.join(dir, 'dialog-workspace-recovery.png'), timeoutMs: 4000}).catch(error => ({ok: false, error: error.message}));
  const forced = await uia.clickButton({pid: child.pid, hwnd: recovery.window.hwnd, button: '强制退出…', timeoutMs: 8000});
  assert.equal(forced.ok, true, 'UIA click on 强制退出…: ' + JSON.stringify(forced));
  assert.equal(forced.click.name, '强制退出…');
  transcript.forcedClick = forced.click;
  transcript.forcedClickAt = Date.now();
  // The confirmation dialog replaces the first one inside the same window.
  const confirm = await uia.findDialog({pid: child.pid, label: '取消', timeoutMs: 30000}).catch(error => ({found: false, error: error.message}));
  transcript.windowsAtConfirm = await uia.listWindows({pid: child.pid}).catch(() => ({windows: []}));
  assert.equal(confirm.found, true, 'native confirmation dialog must appear before any forced exit; windows: ' + JSON.stringify(transcript.windowsAtConfirm));
  transcript.confirm = confirm.window;
  const confirmNames = names(confirm.window);
  assert(confirmNames.has('强制退出'), 'confirmation dialog buttons: ' + JSON.stringify(confirm.window.buttons.concat(confirm.window.descendants)));
  assert(!confirmNames.has('强制退出…'), 'the recovery dialog must be dismissed before the confirmation is handled: ' + JSON.stringify(confirm.window.descendants));
  transcript.confirmScreenshot = await uia.screenshotWindow({pid: child.pid, hwnd: confirm.window.hwnd, file: path.join(dir, 'dialog-confirm-forcequit.png'), timeoutMs: 4000}).catch(error => ({ok: false, error: error.message}));
  const confirmed = await uia.clickButton({pid: child.pid, hwnd: confirm.window.hwnd, button: '强制退出', timeoutMs: 8000});
  assert.equal(confirmed.ok, true, 'UIA click on 强制退出: ' + JSON.stringify(confirmed));
  assert.equal(confirmed.click.name, '强制退出');
  transcript.confirmedAt = Date.now();
  transcript.confirmedClick = confirmed.click;
  return transcript;
}
async function observeForcedExit({label, dir, tree, dialogWaitMs, closeAt = null, receipt}) {
  // Evidence is attached to the receipt BEFORE any assertion so a failing
  // bound never discards the timestamp chain being classified.
  const timing = {};
  const evidence = receipt.forceQuitEvidence = {label, timing, transcript: null, appExitTrace: null, exit: null, descendantExits: [], sentinel: null};
  const transcript = await forceQuitDialogs({dir, dialogWaitMs});
  evidence.transcript = transcript;
  timing.confirmAt = transcript.confirmedAt;
  timing.forcedClickAt = transcript.forcedClickAt;
  if (closeAt) timing.dialogAfterCloseMs = transcript.recoveryFoundAt - closeAt;
  const exit = await Promise.race([exited, pause(20000).then(() => null)]);
  timing.exitObservedAt = Date.now();
  timing.osExitMs = timing.exitObservedAt - timing.confirmAt;
  runs.at(-1).exit = exit;
  // In-process app.exit trace: the product's own bounded timer must call
  // app.exit(0) promptly (2.5s cleanup deadline); the OS-level exit signal is
  // recorded separately and never silently substituted.
  const traceText = await fs.readFile(appExitTrace, 'utf8').catch(() => '');
  const entries = traceText.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const own = entries.filter(entry => entry.pid === child.pid).at(-1) ?? null;
  evidence.appExitTrace = {own, allCount: entries.length};
  if (own) timing.appExitAt = own.at;
  if (own) timing.productExitMs = own.at - timing.confirmAt;
  const snapshots = [];
  await waitForExited(rootPin, label + ' Electron root', 6000);
  timing.rootExitedAt = Date.now();
  for (const pin of tree.pinned) {
    const snapshot = (await waitForExited(pin.pin, label + ' descendant ' + pin.row.pid, 6000));
    snapshots.push({row: stamp({...pin.row, stamp: pin.stamp}), exited: snapshot.exitCode ?? null, exitedAt: Date.now()});
  }
  evidence.descendantExits = snapshots;
  const survivor = await assertRunning(sentinelPin, 'unrelated sentinel after ' + label);
  evidence.sentinel = {pid: sentinel.pid, stamp: survivor.stamp, state: survivor.state};
  await stopCdp();
  for (const pin of tree.pinned) pin.pin.close();
  // Assertions run last, on the recorded evidence.
  assert(exit, 'force quit must exit the application');
  assert.deepEqual(exit, {code: 0, signal: null}, 'force quit exits through app.exit(0)');
  if (own) {
    assert(timing.productExitMs >= 0 && timing.productExitMs < 8000, 'the product force-quit path must call app.exit within its bounded cleanup (2.5s deadline, 8s bound), took ' + timing.productExitMs + 'ms after the confirmed 强制退出 click; OS exit signal observed at ' + timing.osExitMs + 'ms');
  } else {
    assert(timing.osExitMs < 8000, 'forced exit must stay bounded (no in-process app.exit trace available; OS exit observed), took ' + timing.osExitMs + 'ms');
  }
  return {timing, transcript, exit, descendantExits: snapshots, sentinel: evidence.sentinel, appExitTrace: evidence.appExitTrace};
}

// Scenario 1: a real stalled normal close. The shell renderer is blocked the
// way a genuinely unresponsive page is, so the real 8s close watchdog offers
// the native recovery dialog while a real project terminal and its typed
// program are still running as owned descendants.
async function stalledCloseScenario() {
  stage = 'stall: synthetic project and owned terminal';
  const dir = path.join(out, 'stall');
  const project = path.join(dir, 'project');
  const original = 'Original editable text.\n', savedText = original + 'UNSENT_FORCEQUIT_STALL_DRAFT';
  const externalText = 'External winner replaces the autosaved bytes.\n', draftText = savedText + '\nUNSENT_FORCEQUIT_CONFLICT_DRAFT\n';
  const marker = 'NOZELI_FORCEQUIT_OWNED_PROGRAM_STALL';
  const ready = path.join(project, 'owned-program-ready.json'), script = path.join(project, 'owned wait program.cjs');
  await fs.mkdir(project, {recursive: true});
  await fs.writeFile(path.join(project, 'edit.txt'), original);
  await fs.writeFile(script, 'const fs=require(\'node:fs\');fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,marker:process.argv[3],node:process.versions.node}));setInterval(()=>{},1000);\n');
  const receipt = {scope: 'real stalled close (blocked shell renderer) with owned terminal tree; explicit native recovery-dialog force quit', project};
  scenarios.stall = receipt;
  const {projectId} = await launch(project);
  receipt.run = {pid: child.pid, command: electronCommand, sourceArgs: packaged ? [] : [path.join(app, 'src/main/main.cjs')], systemOnlyPath: 'System32-only'};

  stage = 'stall: unsaved draft typed in the real editor';
  await mark('stall-draft');
  const document = await open('edit.txt');
  await focusEditor(document);
  await typeDraft(document, savedText, original, receipt);
  // The app's real debounced autosave (SAVE_DELAY 700ms / SAVE_MAX_WAIT 2s)
  // settles the first edit into the source file; that saved digest becomes
  // the baseline the unsent input will be retained against.
  await until(() => document.$eval('#save-status', node => node.dataset.state).then(state => state === 'saved' ? state : null).catch(() => null), 'autosave settled the first edit into the source', 15000);
  assert.equal(await fs.readFile(path.join(project, 'edit.txt'), 'utf8'), savedText, 'autosave writes the settled edit to the source file');
  const savedDigest = (await invoke('file.read', {projectId, relPath: 'edit.txt'})).digest;
  // An external writer wins the source; any further input can only become an
  // unconfirmed conflict draft — the product never silently overwrites it.
  await fs.writeFile(path.join(project, 'edit.txt'), externalText);
  await typeDraft(document, draftText, savedText, receipt);
  await until(() => document.$eval('#save-status', node => node.dataset.state).then(state => state === 'conflict' ? state : null).catch(() => null), 'autosave refuses the stale baseline and reports CONFLICT', 15000);
  const conflicted = await invoke('file.read', {projectId, relPath: 'edit.txt'});
  assert.equal(conflicted.text, externalText, 'the external winner stays the source of truth');
  assert.equal(conflicted.draft?.text, draftText, 'the unsent input is retained as an unconfirmed draft');
  assert.equal(conflicted.draft?.status, 'conflict');
  assert.equal(await fs.readFile(path.join(project, 'edit.txt'), 'utf8'), externalText, 'the unsent draft must never be written over the external winner');
  receipt.draft = {relPath: 'edit.txt', text: draftText, baselineDigest: savedDigest, retainedRecord: {status: conflicted.draft?.status, baseDigest: conflicted.draft?.baseDigest ?? null}};
  checks.push('stall: external winner kept on disk while the unsent input is retained as an unconfirmed conflict draft');

  stage = 'stall: real project terminal with a typed long-running program';
  await mark('stall-terminal');
  await shell.bringToFront();
  await shell.waitForFunction(() => {const button = document.getElementById('workspace-open-terminal'); return button && !button.disabled && !button.hidden && document.visibilityState === 'visible';});
  await shell.click('#workspace-open-terminal');
  const terminal = await surface('project-terminal');
  await terminal.waitForSelector('.project-terminal[data-terminal-state="running"]');
  const scope = await terminal.evaluate(() => ({projectId: __workspaceScope.projectId, viewId: __workspaceScope.viewId}));
  const attached = await invoke('project-terminal.attach', scope, terminal);
  assert.equal(attached.status, 'running');
  const ownerPin = native.openProcessIdentity(attached.pid);
  await terminal.bringToFront();
  await terminal.focus('.xterm-helper-textarea');
  await terminal.keyboard.type('"' + nodeExe + '" "' + script + '" "' + ready + '" ' + marker);
  await terminal.keyboard.press('Enter');
  const program = await until(async () => {try {return JSON.parse(await fs.readFile(ready, 'utf8'));} catch (error) {if (error.code !== 'ENOENT') throw error;}}, 'typed owned program ready file', 20000);
  assert.equal(program.marker, marker);
  const programPin = native.openProcessIdentity(program.pid);
  receipt.terminal = {owner: {pid: attached.pid, stamp: ownerPin.snapshot().stamp, image: ownerPin.snapshot().imagePath}, program: {pid: program.pid, marker, stamp: programPin.snapshot().stamp}, instanceId: attached.instanceId};
  checks.push('stall: real rail terminal and typed program run as owned descendants with pinned native identities');

  stage = 'stall: pin the owned tree and block the shell renderer';
  await mark('stall-block');
  const tree = await pinProcessTree(native, child.pid, {excludeImages: [electronImage]});
  assert(tree.rows.some(row => row.pid === attached.pid), 'terminal shell owner must be an enumerated descendant of the app');
  assert(tree.rows.some(row => row.pid === program.pid), 'typed program must be an enumerated descendant of the app');
  assert(!tree.rows.some(row => row.pid === sentinel.pid), 'the unrelated sentinel must not be part of the app tree');
  receipt.tree = {owned: tree.pinned.map(pin => stamp({...pin.row, stamp: pin.stamp})), browserManaged: tree.browserManaged, vanishedBeforePin: tree.vanished};
  await assertRunning(sentinelPin, 'unrelated sentinel before the stall');
  const blockSession = await shell.createCDPSession();
  blockSession.send('Runtime.evaluate', {expression: 'for(;;){}'}).catch(() => {});
  const probe = await Promise.race([
    shell.evaluate(() => Date.now()).then(value => ({responsive: true, value})).catch(error => ({responsive: false, error: error.message})),
    pause(1500).then(() => ({responsive: false})),
  ]);
  receipt.rendererStall = probe;
  if (probe.responsive) throw new Error('the shell renderer was still responsive; the stall was not established before the native close gesture');
  checks.push('stall: shell renderer genuinely unresponsive (timed-out CDP probe) so the real close watchdog must run');

  stage = 'stall: native window close gesture and native force-quit dialogs';
  await mark('stall-forcequit');
  await uia.screenshotWindow({pid: child.pid, file: path.join(dir, 'window-before-stall-close.png'), timeoutMs: 4000}).catch(() => {});
  const mainWindow = await uia.findWindow({pid: child.pid, className: 'Chrome_WidgetWin_1', timeoutMs: 5000});
  receipt.mainWindow = mainWindow.window ?? null;
  const closeGesture = await uia.closeMainWindow({pid: child.pid, timeoutMs: 10000});
  assert.equal(closeGesture.ok, true, 'native window close gesture: ' + JSON.stringify(closeGesture));
  const closeAt = Date.now();
  const forced = await observeForcedExit({label: 'stalled close', dir, tree, dialogWaitMs: 25000, closeAt, receipt});
  receipt.closeGesture = closeGesture;
  receipt.forceQuit = forced;
  assert(forced.timing.dialogAfterCloseMs >= 3000 && forced.timing.dialogAfterCloseMs <= 25000, 'the recovery dialog must come from the supervised close watchdog (' + forced.timing.dialogAfterCloseMs + 'ms after the close gesture), not an immediate error path');
  checks.push('stall: explicit 强制退出… → 确认强制退出 via Windows UI Automation exits the app bounded in ' + (forced.timing.productExitMs ?? forced.timing.osExitMs) + 'ms; ' + forced.descendantExits.length + ' pinned owned descendants (terminal shell + typed program + captured tree) exited by native identities; unrelated sentinel survived');
  receipt.afterExitDisk = await fs.readFile(path.join(project, 'edit.txt'), 'utf8');
  assert.equal(receipt.afterExitDisk, externalText, 'force quit must not write the unsent draft over the external winner');
  blockSession.detach().catch(() => {});
  ownerPin.close(); programPin.close();

  stage = 'stall: cold reopen keeps unsaved recovery facts unknown';
  await mark('stall-reopen');
  await launch(project);
  const reopened = await invoke('file.read', {projectId: projectIds.get(project), relPath: 'edit.txt'});
  assert.equal(reopened.text, externalText, 'the external winner remains the source of truth after force quit');
  assert.equal(reopened.draft?.text, draftText, 'the unsent draft must remain as an unconfirmed draft after force quit');
  assert(['dirty', 'conflict'].includes(reopened.draft?.status), 'a force-quit draft stays an unconfirmed record (dirty/conflict), never saved: ' + String(reopened.draft?.status));
  assert.equal(reopened.draft?.baseDigest, savedDigest, 'the draft keeps the exact baseline it was retained against');
  // The close-flush workspace-recovery ledger entry is never created by a
  // force quit; the persisted draft record is the honest surviving fact.
  const ledger = await recoveryCursor(projectIds.get(project), value => value?.candidate?.text === draftText);
  const coldTerminal = await surface('project-terminal');
  await coldTerminal.waitForSelector('.project-terminal[data-terminal-state="not-started"]');
  assert.deepEqual(await invoke('project-terminal.attach', await coldTerminal.evaluate(() => ({projectId: __workspaceScope.projectId, viewId: __workspaceScope.viewId})), coldTerminal), {instanceId: null, status: 'not-started', reason: 'EXPLICIT_START_REQUIRED'});
  await coldTerminal.screenshot({path: path.join(dir, 'cold-terminal-not-started.png')});
  await normalClose();
  receipt.reopen = {draft: {status: reopened.draft?.status, baseDigest: reopened.draft?.baseDigest ?? null}, ledgerRows: ledger.map(entry => entry.row), exit: runs.at(-1).exit};
  checks.push('stall: cold reopen keeps the source bytes, the unsent draft as an unconfirmed recovery record, and the terminal explicit-start; the app still closes normally afterwards');
}

// Scenario 2: a real crashed shell renderer. The crashed-page recovery dialog
// is the explicit user route to force quit; the unsent draft must survive as
// an unconfirmed recovery record and the source bytes must stay untouched.
async function crashedRendererScenario() {
  stage = 'crash: synthetic project and unsent draft';
  const dir = path.join(out, 'crash');
  const project = path.join(dir, 'project');
  const original = 'Crash scenario original text.\n', savedText = original + 'UNSENT_FORCEQUIT_CRASH_SAVED';
  const externalText = 'External winner replaces the crash-scenario bytes.\n', draftText = savedText + '\nUNSENT_FORCEQUIT_CRASH_CONFLICT_DRAFT\n';
  await fs.mkdir(project, {recursive: true});
  await fs.writeFile(path.join(project, 'notes.txt'), original);
  const receipt = {scope: 'real crashed shell renderer; explicit native recovery-dialog force quit', project};
  scenarios.crash = receipt;
  const {projectId} = await launch(project);
  await mark('crash-draft');
  const document = await open('notes.txt');
  await focusEditor(document);
  await typeDraft(document, savedText, original, receipt);
  await until(() => document.$eval('#save-status', node => node.dataset.state).then(state => state === 'saved' ? state : null).catch(() => null), 'autosave settled the first edit into the source', 15000);
  const savedDigest = (await invoke('file.read', {projectId, relPath: 'notes.txt'})).digest;
  await fs.writeFile(path.join(project, 'notes.txt'), externalText);
  await typeDraft(document, draftText, savedText, receipt);
  await until(() => document.$eval('#save-status', node => node.dataset.state).then(state => state === 'conflict' ? state : null).catch(() => null), 'autosave refuses the stale baseline and reports CONFLICT', 15000);
  const conflicted = await invoke('file.read', {projectId, relPath: 'notes.txt'});
  assert.equal(conflicted.text, externalText);
  assert.equal(conflicted.draft?.text, draftText);
  assert.equal(conflicted.draft?.status, 'conflict');
  assert.equal(await fs.readFile(path.join(project, 'notes.txt'), 'utf8'), externalText, 'the unsent draft must never be written over the external winner');
  receipt.draft = {relPath: 'notes.txt', text: draftText, baselineDigest: savedDigest, retainedRecord: {status: conflicted.draft?.status, baseDigest: conflicted.draft?.baseDigest ?? null}};

  stage = 'crash: pin the owned tree and crash the shell renderer';
  await mark('crash-forcequit');
  const tree = await pinProcessTree(native, child.pid, {excludeImages: [electronImage]});
  assert(!tree.rows.some(row => row.pid === sentinel.pid), 'the unrelated sentinel must not be part of the app tree');
  receipt.tree = {owned: tree.pinned.map(pin => stamp({...pin.row, stamp: pin.stamp})), browserManaged: tree.browserManaged, vanishedBeforePin: tree.vanished};
  const mainWindow = await uia.findWindow({pid: child.pid, className: 'Chrome_WidgetWin_1', timeoutMs: 5000});
  receipt.mainWindow = mainWindow.window ?? null;
  const crashSession = await shell.createCDPSession();
  await Promise.race([crashSession.send('Page.crash').catch(() => {}), pause(3000)]);
  const forced = await observeForcedExit({label: 'crashed renderer close', dir, tree, dialogWaitMs: 20000, receipt});
  crashSession.detach().catch(() => {});
  receipt.forceQuit = forced;
  checks.push('crash: crashed shell renderer exposes the native recovery dialog; explicit force quit exits bounded in ' + (forced.timing.productExitMs ?? forced.timing.osExitMs) + 'ms with owned descendants exited by native identities and the unrelated sentinel alive');
  assert.equal(await fs.readFile(path.join(project, 'notes.txt'), 'utf8'), externalText, 'force quit must not fabricate a save for the crashed page');

  stage = 'crash: cold reopen keeps the unsaved recovery facts unknown';
  await mark('crash-reopen');
  await launch(project);
  const reopened = await invoke('file.read', {projectId: projectIds.get(project), relPath: 'notes.txt'});
  assert.equal(reopened.text, externalText, 'the external winner remains the source of truth after force quit');
  assert.equal(reopened.draft?.text, draftText);
  assert(['dirty', 'conflict'].includes(reopened.draft?.status), 'a force-quit draft stays an unconfirmed record (dirty/conflict), never saved: ' + String(reopened.draft?.status));
  assert.equal(reopened.draft?.baseDigest, savedDigest);
  const ledger = await recoveryCursor(projectIds.get(project), value => value?.candidate?.text === draftText);
  await normalClose();
  receipt.reopen = {draft: {status: reopened.draft?.status, baseDigest: reopened.draft?.baseDigest ?? null}, ledgerRows: ledger.map(entry => entry.row), exit: runs.at(-1).exit};
  checks.push('crash: cold reopen keeps the source bytes and the unsent draft as an unconfirmed recovery record; normal close still works');
}

try {
  stage = 'fixture startup';
  uia = await new UiaAgent().start();
  sentinel = spawn(nodeExe, ['-e', 'setInterval(()=>{},1000)', 'NOZELI_FORCEQUIT_UNRELATED_SENTINEL'], {stdio: 'ignore', windowsHide: true});
  sentinelPin = native.openProcessIdentity(sentinel.pid);
  await assertRunning(sentinelPin, 'unrelated sentinel at startup');
  await stalledCloseScenario();
  await assertRunning(sentinelPin, 'unrelated sentinel between scenarios');
  await crashedRendererScenario();
  await assertRunning(sentinelPin, 'unrelated sentinel after all scenarios');
  assert.deepEqual(errors.filter(message => !/crash|target closed|session closed|detached/i.test(message)), []);
  checks.push('unrelated sentinel survived every force quit through its pinned native identity');
  result = {ok: true, output: out, application: app, packaged, checks, errors, scenarios, runs: runs.map(run => ({...run, log: undefined})),
    sentinel: {pid: sentinel.pid, stamp: sentinelPin.snapshot().stamp},
    commands: {driver: process.argv.slice(1), electron: electronCommand, sourceArgs: [path.join(app, 'src/main/main.cjs')], packagedArgs: []},
    evidence: ['report.json', 'stall/dialog-workspace-recovery.png', 'stall/dialog-confirm-forcequit.png', 'crash/dialog-workspace-recovery.png', 'crash/dialog-confirm-forcequit.png', 'main-N.log'],
    inputScope: 'Visible real native Electron on Windows; close/force-quit gestures via Windows UI Automation on the real native dialogs; stall via a genuinely blocked shell renderer; crash via a real renderer process crash. VM/CDP/UIA automation proof only - not physical keyboard/mouse/IME/device or multi-display proof, and not real-model proof.'};
} catch (error) {
  await uia?.screenshotWindow({pid: child?.pid ?? 0, file: path.join(out, 'failure.png'), timeoutMs: 4000}).catch(() => {});
  const pages = [];
  for (const target of await browser?.pages().catch(() => []) ?? []) {
    pages.push(await target.evaluate(() => ({scope: window.__workspaceScope ?? null, inputText: window.__nozeliInput?.text?.() ?? null, inputTrace: (window.__fqInputTrace ?? []).slice(-16), dialogs: [...document.querySelectorAll('dialog')].filter(node => node.open).map(node => node.id)})).catch(cause => ({error: cause.message})));
  }
  result = {ok: false, stage, error: error.stack, output: out, application: app, packaged, checks, errors, scenarios, pages, runs: runs.map(run => ({...run, log: undefined}))};
  process.exitCode = 1;
} finally {
  // Failure cleanup stays separate from the product exit assertions: only the
  // processes this harness spawned directly are signalled through their own
  // handles; any surviving app-owned descendant is recorded, never adopted.
  const failureCleanup = [];
  if (child?.exitCode === null) {child.kill(); const exit = await Promise.race([exited, pause(4000)]); failureCleanup.push({spawned: 'electron', pid: child.pid, exit});}
  await stopCdp();
  if (sentinel) {
    if (sentinel.exitCode === null) sentinel.kill();
    await waitForExited(sentinelPin, 'sentinel teardown', 4000).catch(error => failureCleanup.push({spawned: 'sentinel', pid: sentinel.pid, error: error.message}));
  }
  sentinelPin?.close(); rootPin?.close();
  if (uia) await uia.dispose();
  for (let index = 0; index < runs.length; index++) await fs.writeFile(path.join(out, 'main-' + (index + 1) + '.log'), runs[index].log ?? '');
  if (result) {
    if (failureCleanup.length) result.failureCleanup = failureCleanup;
    await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ok: result.ok, stage: result.stage ?? null, output: out, checks: result.checks ?? [], error: result.error ?? null}, null, 2));
  }
}
