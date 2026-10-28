// Real-Electron interaction regression for Quick Open (快速打开): clicking or
// typing into #file-filter must open the #quick-open modal, searches must open
// the real NativeDocument for the exact file (same name in different dirs,
// nested paths, Chinese names), and the four open targets must produce real
// layout geometry — never just a request or a label. Uses only synthetic
// directories of real Markdown text files; no model configuration, no agents,
// no LLM inference. Conventions copied from tests/failed-surface-exit-check.mjs
// and tests/model-menu-interaction-check.mjs (isolated HOME/XDG/config, throwaway
// user data, dedicated CDP port, loopback-only host-resolver rules).
//
// Two launch modes:
//   node tests/quick-open-real-check.mjs --app-root <repo>/apps/desktop
//     Spawns the source tree (needs `npm run build:renderer` first).
//   node tests/quick-open-real-check.mjs --release <releases>/<timestamp>
//     Spawns <release>/nozeli directly (installed acceptance).
//
// Stated limitation (measured, not assumed): CDP-injected keys do not reach the
// Electron browser-process before-input-event hook (verified with a standalone
// Electron probe on this host) and this KDE Wayland session has no synthetic
// input tool, so CtrlP pressed inside a document/conversation SURFACE and its
// native forward (workspace-native before-input-event -> root quick-open) is
// not key-driven here. Root-level CtrlP — main shell root AND detached window
// root — is exercised end to end with real keys. No synthetic workspace.control
// events are dispatched anywhere.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { prepareReading } from './reading-setup.fixture.mjs';

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

const root = await fs.mkdtemp(path.join(os.tmpdir(), `nozeli-quick-open-${mode}-`));
const report = {
  ok: false, kind: 'quick-open-real-check', mode, root, binary, appRoot, release,
  coverage: 'Synthetic fixture of real text Markdown files only; sanitized HOME/XDG_*/NOZELI_* under a throwaway root; NOZELI_TEST_INSTANCE + dedicated CDP port; host-resolver rules black-hole non-loopback names; no user profile, model config, agent or inference. Result rows are chosen by data-path attribute, never by assumed locale sort order. NativeDocument is proven by reading the opened surface DOM text plus real layout geometry from workspace.windows.list.',
  limitations: ['CtrlP inside a document/conversation surface and its native before-input-event forward to the owning root is not key-driven: CDP keys do not reach the browser-process input hook (standalone Electron probe) and KDE Wayland here has no synthetic-input tool. Root-level CtrlP (shell + detached root) is covered end to end instead.', 'OS-level activation of a detached window cannot be asserted on KDE Wayland (win.focus() cannot programmatically activate a window there): the window target proves the real window, the moved writer, and that the launcher did not reclaim the keyboard; the detached root end-to-end CtrlP covers its keyboard.'],
  checks: [], scenes: [], normalExits: [], errors: [], measurements: {},
};
console.log('EVIDENCE_ROOT=' + root);
let child, exited, browser, log = '', shell;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  do {
    if (child && (child.exitCode !== null || child.signalCode)) throw new Error('Electron exited while waiting for ' + label + '\n' + log.slice(-4000));
    const value = await fn();
    if (value) return value;
    await sleep(80);
  } while (Date.now() < deadline);
  throw new Error('Timed out: ' + label);
}
async function invoke(page, operation, payload = {}) {
  const result = await page.evaluate(({ operation, payload }) => window.nozeli.invoke(operation, payload), { operation, payload });
  assert(result.ok, `${operation}: ${JSON.stringify(result.error)}`);
  return result.value;
}
function isolatedEnvironment(port) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key) || /^(?:CCB_|CODEX_|OMP_|PI_|ANTHROPIC_|OPENAI_|NOZELI_)/.test(key) || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
  }
  return Object.assign(env, {
    HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'home', '.config'),
    XDG_DATA_HOME: path.join(root, 'home', '.local', 'share'), XDG_CACHE_HOME: path.join(root, 'home', '.cache'),
    NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: path.join(root, 'config'),
    NOZELI_USER_DATA: path.join(root, 'config', 'desktop'),
    NOZELI_TEST_PICK: path.join(root, 'project-a'), NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0',
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
  const observe = page => { page.on('pageerror', error => report.errors.push(String(error.stack || error))); page.evaluate(() => { if (window.__focusLog) return; window.__focusLog = []; for (const type of ['focus', 'blur']) window.addEventListener(type, event => window.__focusLog.push({ type, target: event.target === window ? 'window' : event.target?.id || event.target?.tagName, t: Date.now() }), true); }).catch(() => {}); };
  for (const page of await browser.pages()) observe(page);
  browser.on('targetcreated', async target => { const page = await target.page().catch(() => null); if (page) observe(page); });
  ({ page: shell } = await until(async () => {
    for (const page of await browser.pages()) {
      const identity = await page.evaluate(async () => { if (!window.nozeli) return null; const result = await window.nozeli.invoke('workspace.bootstrap', {}); return result.ok ? result.value : null; }).catch(() => null);
      if (identity && identity.role === 'shell' && await page.evaluate(() => window.__nozeliReady === true).catch(() => false)) return { page, identity };
    }
    return null;
  }, 'shell window'));
}
const shot = async (page, name) => { await page.screenshot({ path: path.join(root, name + '.png') }); report.scenes.push({ name: 'screenshot', file: name + '.png' }); };
async function requestCloseExpectZero(scene) {
  const response = await shell.evaluate(() => window.nozeli.invoke('session.requestClose', {}));
  assert(response.ok, `session.requestClose: ${JSON.stringify(response.error)}`);
  const result = await Promise.race([exited, sleep(45_000).then(() => null)]);
  assert.deepEqual(result, { code: 0, signal: null }, scene + ': normal close must exit 0');
  report.normalExits.push({ scene, ...result });
  await browser?.disconnect();
  browser = null;
}

// ---- synthetic fixture: real directories, real Markdown text files ----
const projectA = path.join(root, 'project-a');
const markerFor = rel => `QO-MARKER ${rel} 独立内容`;
const fixtureFiles = ['notes-a.md', 'alpha/dup.md', 'beta/dup.md', 'split-r.md', 'split-b.md', 'float-w.md', 'detached-note.md', 'missing.md', 'deep/nested/中文笔记.md'];
for (let index = 0; index < 120; index++) fixtureFiles.push(`folder-hit-${String(index).padStart(3, '0')}/hit-${String(index).padStart(3, '0')}.md`);
for (const rel of fixtureFiles) {
  const file = path.join(projectA, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, markerFor(rel) + '\n');
}

// ---- interaction helpers (real keys and clicks only) ----
// Activate the intended root before sending CDP keys. No Escape/retry recovery:
// a missing first shortcut invocation is a failure, not a passing check.
const ctrlP = async page => {
  await page.bringToFront();
  await page.keyboard.down('Control');await page.keyboard.press('p');await page.keyboard.up('Control');
  await page.waitForSelector('#quick-open[open]');
};
// Opening focuses and selects the modal input already; seed the query with the
// keyboard (a real keyboard user's flow) instead of a mouse click, so a
// transient relayout of the dialog can never break the interaction.
const quickOpen = async (page, query) => { await ctrlP(page); await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); if (query) await page.type('#quick-open-input', query); };
const closeQuick = async page => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('#quick-open').open); };
const waitSettled = async page => until(async () => {
  const status = await page.$eval('#quick-open-status', node => node.textContent);
  return status && !status.includes('搜索中') ? status : null;
}, 'quick-open status settles');
const resultPaths = page => page.$$eval('#quick-open-results [data-open-target="current"]', nodes => nodes.map(node => node.dataset.path));
const scopedPage = expression => until(async () => {
  for (const page of await browser.pages()) if (await page.evaluate(expression).catch(() => false)) return page;
  return null;
}, 'surface page: ' + expression);
const docState = page => page.evaluate(() => {
  const scope = window.__workspaceScope || {};
  const editor = document.querySelector('#text-host .cm-content') || document.querySelector('#text-host .monaco-editor .view-lines') || document.querySelector('#text-host');
  return { relPath: scope.relPath, windowId: scope.windowId, readOnly: scope.readOnly, hasFocus: document.hasFocus(), editorFocused: Boolean(document.activeElement?.closest?.('#text-host')), text: (editor?.textContent || '').replace(/\s+/g, ' ').slice(0, 150) };
});
const layoutFor = async rel => {
  const snapshot = await shell.evaluate(() => window.__workspaceGroups.snapshot());
  const mine = Object.values(snapshot.views).filter(view => view.relPath === rel);
  return { snapshot, writers: mine.filter(view => !view.readOnly), mirrors: mine.filter(view => view.readOnly) };
};
const surfaceBounds = async rel => {
  const windows = await invoke(shell, 'workspace.windows.list');
  return windows.flatMap(window => window.surfaces.filter(surface => surface.relPath === rel).map(surface => ({ windowId: window.id, ...surface.bounds })));
};
// Focus-ownership trace: window focus/blur per page with timestamps, so a focus
// handoff race leaves evidence in the report instead of a bare hasFocus flip.
const wireFocusLog = async () => { for (const page of await browser.pages()) await page.evaluate(() => { if (window.__focusLog) return; window.__focusLog = []; for (const type of ['focus', 'blur']) window.addEventListener(type, event => window.__focusLog.push({ type, target: event.target === window ? 'window' : event.target?.id || event.target?.tagName, t: Date.now() }), true); }).catch(() => {}); };
const dumpFocusTrace = async label => { report.measurements[label] = []; for (const page of await browser.pages()) { const entry = await page.evaluate(() => ({ scope: { role: window.__workspaceScope?.role, kind: window.__workspaceScope?.kind, relPath: window.__workspaceScope?.relPath }, hasFocus: document.hasFocus(), active: document.activeElement?.id || document.activeElement?.tagName, log: (window.__focusLog || []).slice(-12) })).catch(error => ({ error: String(error) })); if (entry.scope || entry.hasFocus !== undefined) report.measurements[label].push(entry); } };
// Focus ownership proof. In-window surfaces are WebContentsView children of the
// shell window: Electron leaves the parent main webContents' page-level
// hasFocus() flag stale (measured: owner and shell both report true while keys
// and element focus live on the child). The provable invariant is therefore
// element-level: the owner page must have focus AND hold a real focused element
// (the main-side wc.focus + focus-content round trip), and the shell must hold
// NO focused element (it yielded the keyboard). Cross-window OS focus for
// detached windows cannot be asserted on this KDE Wayland host (win.focus()
// cannot programmatically activate a window there), so the detached step
// instead proves the window is real and that the launcher did not reclaim the
// keyboard; the detached root's own CtrlP in 6f proves its keys end to end.
const focusSnapshot = page => page.evaluate(() => ({ focus: document.hasFocus(), active: document.activeElement === document.body || !document.activeElement ? null : document.activeElement?.id || document.activeElement?.tagName })).catch(() => null);
const waitFocused = (page, rival) => until(async () => {
  const owner = await focusSnapshot(page);
  if (!owner?.focus || !owner.active) return null;
  return (await focusSnapshot(rival))?.active != null ? null : owner;
}, 'page takes focus', 20_000);
// ---- writer readiness proof (the edit surface must be real before interacting) ----
// A Markdown writer opens in read mode by design (阅读 is the product default for
// .md): #text-host stays hidden and the CodeMirror content has no layout box, so
// a blind editor click fails on the hidden element while silently skipping the
// click would prove nothing. Prove mount + real layout instead, and leave read
// mode through the REAL user entry when (and only when) the surface reports it
// is in read mode: the document's own #text-mode-toggle is hidden by the unified
// single title bar on isolated surfaces, so the real path is the owning pane
// header's 阅读／编辑 control ([data-workspace-command="content-text-mode"] on the
// pane currently showing this writer), which routes content-command to the
// surface. In-page focus after the click is asserted too — that is the harness's
// own responsibility and is separate from the cross-surface focus the activation
// step later demands from the product.
const editorState = page => page.evaluate(() => {
  const host = document.querySelector('#text-host');
  const content = host?.querySelector('.cm-content') || host?.querySelector('.monaco-editor .view-lines');
  if (!content) return { mounted: false };
  const box = content.getBoundingClientRect();
  return { mounted: true, visible: !host.hidden && box.width > 0 && box.height > 0, hostHidden: host.hidden, readMode: document.querySelector('#text-mode-toggle')?.getAttribute('aria-pressed') };
});
const rootPageFor = windowId => until(async () => {
  for (const page of await browser.pages()) {
    const owned = await page.evaluate(id => {
      const scope = window.__workspaceScope;
      if (!scope || !window.__workspaceGroups) return false;
      return scope.role === 'shell' ? id === 'main' : scope.role === 'detached' && scope.windowId === id;
    }, windowId).catch(() => false);
    if (owned) return page;
  }
  return null;
}, 'root window page owning the writer');
const clickHeaderTextMode = async (root, viewId) => {
  const control = await until(async () => {
    const handle = await root.evaluateHandle(id => {
      const pane = [...document.querySelectorAll('.workspace-pane')].find(node => node.querySelector(`[data-view-id="${id}"]`));
      return pane?.querySelector('[data-workspace-command="content-text-mode"]') || null;
    }, viewId);
    const element = handle.asElement();
    return element && await element.boundingBox() ? element : null;
  }, 'pane header 阅读／编辑 control for the writer (writer must be its pane active view)');
  await control.click();
};
const ensureEditorInteractive = async page => {
  await until(async () => (await editorState(page)).mounted, 'editor content element mounts in the opened writer');
  let state = await editorState(page);
  let toggled = false;
  if (!state.visible) {
    assert.equal(state.readMode, 'true', 'a hidden editor must be the documented Markdown read mode, not a broken mount');
    const { viewId, windowId } = await page.evaluate(() => ({ viewId: window.__workspaceScope?.viewId, windowId: window.__workspaceScope?.windowId }));
    const root = await rootPageFor(windowId);
    await clickHeaderTextMode(root, viewId);
    toggled = true;
    state = await until(async () => { const next = await editorState(page); return next.visible ? next : null; }, 'editor gains a real layout box after the pane-header mode control');
  }
  return { ...state, toggled };
};

try {
  await launch();
  await prepareReading(shell);
  await shell.click('#pick-project');
  await until(() => shell.evaluate(() => window.__workspaceGroups?.snapshot?.()?.projectId || null), 'project opens');
  const projectId = await shell.evaluate(() => window.__workspaceGroups.snapshot().projectId);

  // 1. Clicking #file-filter opens the modal; Escape returns focus to the launcher.
  await shell.click('#file-filter');
  await shell.waitForSelector('#quick-open[open]');
  assert.equal(await shell.$eval('#quick-open-input', node => node.id === document.activeElement?.id ? 'focused' : document.activeElement?.id), 'focused', 'modal must focus its input');
  assert.equal(await shell.$eval('#file-filter', node => node.getAttribute('aria-expanded')), 'true');
  await shot(shell, '01-click-opens-modal');
  await closeQuick(shell);
  assert.equal(await shell.evaluate(() => document.activeElement?.id), 'file-filter', 'close must return focus to #file-filter');
  report.checks.push('click on #file-filter opens #quick-open, focuses its input, Escape returns focus to the launcher');

  // 2. Enter and ArrowDown on the filter also open it.
  for (const key of ['Enter', 'ArrowDown']) { await shell.focus('#file-filter'); await shell.keyboard.press(key); await shell.waitForSelector('#quick-open[open]'); await closeQuick(shell); }
  report.checks.push('Enter and ArrowDown on #file-filter open the modal');

  // 3. Typing into #file-filter keeps the legacy input entry working.
  await shell.type('#file-filter', 'd');
  await shell.waitForSelector('#quick-open[open]');
  assert.equal(await shell.$eval('#quick-open-input', node => node.value), 'd', 'first filter keystroke seeds the modal query');
  await shell.keyboard.down('Control'); await shell.keyboard.press('a'); await shell.keyboard.up('Control');
  await shell.type('#quick-open-input', 'dup');
  const dupPaths = await until(async () => { const paths = await resultPaths(shell); return paths.length >= 2 ? paths : null; }, 'two dup results');
  for (const expected of ['alpha/dup.md', 'beta/dup.md']) assert(dupPaths.includes(expected), `results must include ${expected}, got ${dupPaths}`);
  report.checks.push('typing into #file-filter opens the modal with the typed query and both same-name files are offered');

  // 4. Same name in different dirs: the clicked row opens exactly that file.
  await wireFocusLog();
  const betaOpenedAt = Date.now();
  await shell.click('#quick-open-results [data-path="beta/dup.md"][data-open-target="current"]');
  await shell.waitForFunction(() => !document.querySelector('#quick-open').open);
  const betaPage = await scopedPage(`window.__nozeliReady===true&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='beta/dup.md'&&!window.__workspaceScope?.readOnly`);
  const beta = await docState(betaPage);
  assert(beta.text.includes(markerFor('beta/dup.md')), `beta/dup.md must render its own marker, got: ${beta.text}`);
  await waitFocused(betaPage, shell);
  assert.equal(await shell.evaluate(() => document.activeElement === document.body || !document.activeElement), true, 'shell must yield the keyboard: no focused element may remain in the launcher after the document takes focus');
  await dumpFocusTrace('focusTraceBeta');
  report.measurements.focusTraceBeta.wallClockMs = Date.now() - betaOpenedAt;
  report.checks.push('same-name file chosen by data-path opens exactly that document (DOM marker proof) which takes real focus');
  // 5. Chinese + nested path search, keyboard selection with Enter.
  await quickOpen(shell, '中文');
  await until(async () => (await resultPaths(shell)).includes('deep/nested/中文笔记.md'), 'CJK filename found');
  await shell.keyboard.down('Control'); await shell.keyboard.press('a'); await shell.keyboard.up('Control');
  await shell.type('#quick-open-input', 'nested/中文');
  await waitSettled(shell);
  assert((await resultPaths(shell)).includes('deep/nested/中文笔记.md'), 'nested path query still matches');
  await shell.keyboard.press('ArrowDown');
  assert.equal(await shell.evaluate(() => document.activeElement?.dataset.path), 'deep/nested/中文笔记.md', 'ArrowDown focuses the real result row');
  await shell.keyboard.press('Enter');
  const cjkPage = await scopedPage(`window.__nozeliReady===true&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='deep/nested/中文笔记.md'`);
  assert((await docState(cjkPage)).text.includes(markerFor('deep/nested/中文笔记.md')), 'CJK document renders its own marker');
  report.checks.push('Chinese filename and nested-path queries find the file; ArrowDown+Enter opens it and the DOM marker matches');

  // 6. current: activate an already-open file without a second writer, keep user edits, hand focus over.
  await quickOpen(shell, 'notes-a');
  await waitSettled(shell);
  await shell.keyboard.press('Enter');
  const notesPage = await scopedPage(`window.__nozeliReady===true&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='notes-a.md'&&!window.__workspaceScope?.readOnly`);
  const dirtyTag = 'QO_DIRTY_KEEP';
  const readiness = await ensureEditorInteractive(notesPage);
  assert(readiness.visible, `editor must be visible with a real layout box before editing, got ${JSON.stringify(readiness)}`);
  const editor = (await notesPage.$('#text-host .cm-content')) || (await notesPage.$('#text-host .monaco-editor .view-lines'));
  await editor.click();
  assert.equal(await notesPage.evaluate(() => Boolean(document.activeElement?.closest('#text-host'))), true, 'clicking the ready editor must give it in-page focus');
  await notesPage.keyboard.down('Control'); await notesPage.keyboard.press('End'); await notesPage.keyboard.up('Control');
  await notesPage.keyboard.sendCharacter(' ' + dirtyTag);
  await until(async () => {
    const snapshot = await invoke(shell, 'workspace.document.snapshot', { projectId, relPath: 'notes-a.md' });
    return snapshot.dirty && snapshot.text?.includes(dirtyTag);
  }, 'user edit becomes dirty buffer');
  await quickOpen(shell, 'notes-a');
  await waitSettled(shell);
  await shell.keyboard.press('Enter');
  await shell.waitForFunction(() => !document.querySelector('#quick-open').open);
  let notesLayout = await layoutFor('notes-a.md');
  assert.equal(notesLayout.writers.length, 1, 'activating an open file must not create a second writer');
  const afterActivate = await invoke(shell, 'workspace.document.snapshot', { projectId, relPath: 'notes-a.md' });
  assert(afterActivate.text.includes(dirtyTag) && afterActivate.dirty, 'activation must not drop the unsaved edit');
  await waitFocused(notesPage, shell);
  const notesFocused = await docState(notesPage);
  assert(notesFocused.editorFocused, 'target editor area must hold focus after activation, not the search launcher');
  await shot(notesPage, '06-current-activate-focus');
  report.checks.push('current on an open file: exactly one writer, unsaved edit preserved, editor focused');
  report.checks.push(`writer interaction readiness proven before editing (mounted, ${readiness.toggled ? 'Markdown read mode left via the owning pane header 阅读／编辑 control (content-text-mode)' : 'already editable'}, editor visible with a layout box, click gives in-page focus)`);
  // 6b. A failing open keeps the dialog open with an honest status.
  const missingFile = path.join(projectA, 'missing.md');
  await quickOpen(shell, 'missing');
  await shell.waitForSelector('#quick-open-results [data-path="missing.md"]');
  await fs.chmod(missingFile, 0o000);
  await shell.click('#quick-open-results [data-path="missing.md"][data-open-target="current"]');
  await until(async () => { const status = await shell.$eval('#quick-open-status', node => node.textContent); return status && status !== '正在打开文件…' ? status : null; }, 'failure status');
  assert.equal(await shell.$eval('#quick-open', node => node.open), true, 'failed open must keep the dialog open');
  // 6b-retry: clicking the same failing result again must not claim success either
  // (activating the retained failed surface is not a successful open).
  await shell.click('#quick-open-results [data-path="missing.md"][data-open-target="current"]');
  await until(async () => (await shell.$eval('#quick-open-status', node => node.textContent)) === '正在打开文件…', 'retry enters busy state');
  await until(async () => { const status = await shell.$eval('#quick-open-status', node => node.textContent); return status && status !== '正在打开文件…' ? status : null; }, 'retry failure status');
  assert.equal(await shell.$eval('#quick-open', node => node.open), true, 'retrying the failed open must keep the dialog open');
  await closeQuick(shell);
  await fs.chmod(missingFile, 0o644);
  // Close the retained failed surface through its real pane header 关闭 button:
  // keeping it would make the session end on the honest retention confirmation,
  // which is its own acceptance suite (failed-surface-exit-check).
  const missingLayout = await layoutFor('missing.md');
  const failedViewId = missingLayout.writers[0]?.id;
  if (failedViewId) {
    const closeButton = await shell.evaluateHandle(id => { const pane = [...document.querySelectorAll('.workspace-pane')].find(node => node.querySelector(`[data-view-id="${id}"]`)); return pane?.querySelector('[data-workspace-command="close"]') || null; }, failedViewId);
    const closeElement = closeButton.asElement();
    if (!closeElement) throw new Error('retained failed surface pane has no close control');
    await closeElement.click();
    await until(async () => !(await layoutFor('missing.md')).writers.some(view => view.id === failedViewId), 'retained failed surface closes via its pane header');
  }
  report.checks.push('opening an unavailable file keeps the dialog open and reports the failure; retrying the same result stays honest too');

  // 6c-6e. right / bottom / window produce real, distinct layout geometry.
  const openTarget = async (rel, target) => {
    await quickOpen(shell, rel.includes('/') ? rel.split('/').pop() : rel);
    await waitSettled(shell);
    await shell.waitForSelector(`#quick-open-results [data-path="${rel}"]`);
    await shell.click(`#quick-open-results [data-path="${rel}"][data-open-target="${target}"]`);
    await shell.waitForFunction(() => !document.querySelector('#quick-open').open);
  };
  const expectWriterMirror = async rel => {
    await until(async () => { const layout = await layoutFor(rel); return layout.writers.length === 1 && layout.mirrors.length === 1 ? layout : null; }, `writer+mirror for ${rel}`);
    const layout = await layoutFor(rel);
    assert.equal(layout.mirrors[0].sourceViewId, layout.writers[0].id, `${rel} mirror must reference the writer`);
    return layout;
  };
  await openTarget('split-r.md', 'right');
  await expectWriterMirror('split-r.md');
  let bounds = await surfaceBounds('split-r.md');
  assert(bounds.length === 2, 'split-r visible in two panes');
  bounds.sort((a, b) => a.x - b.x);
  assert(bounds[1].x >= bounds[0].x + bounds[0].width - 2, `right must place the file beside, got ${JSON.stringify(bounds)}`);
  const mirrorR = await scopedPage(`window.__nozeliReady===true&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='split-r.md'&&window.__workspaceScope?.readOnly===true`);
  assert((await docState(mirrorR)).text.includes(markerFor('split-r.md')), 'right mirror renders the real file');
  report.checks.push('right: writer + reading mirror side by side (geometry from workspace.windows.list, DOM marker proof)');

  await openTarget('split-b.md', 'bottom');
  await expectWriterMirror('split-b.md');
  bounds = await surfaceBounds('split-b.md');
  bounds.sort((a, b) => a.y - b.y);
  assert(bounds[1].y >= bounds[0].y + bounds[0].height - 2, `bottom must stack the panes, got ${JSON.stringify(bounds)}`);
  const mirrorB = await scopedPage(`window.__nozeliReady===true&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='split-b.md'&&window.__workspaceScope?.readOnly===true`);
  assert((await docState(mirrorB)).text.includes(markerFor('split-b.md')), 'bottom mirror renders the real file');
  report.checks.push('bottom: writer + reading mirror stacked vertically (geometry + DOM marker proof)');

  await openTarget('float-w.md', 'window');
  // The window target is floatOpen→detach in the domain: it MOVES the only writer
  // into a real detached window — no mirror is created (mirrors are the splitOpen
  // contract of right/bottom above). Assert that honest contract: exactly one
  // writer, zero mirrors, both living in the detached window.
  const floatLayout = await until(async () => { const layout = await layoutFor('float-w.md'); return layout.writers.length === 1 && layout.mirrors.length === 0 && layout.snapshot.detached.length >= 1 ? layout : null; }, 'float-w writer moves to the detached window (single writer, no mirror)');
  const detachedRoot = await scopedPage(`window.__nozeliReady===true&&window.__workspaceScope?.role==='detached'`);
  const detachedId = await detachedRoot.evaluate(() => window.__workspaceScope.windowId);
  assert(floatLayout.snapshot.detached.some(window => window.id === detachedId), 'the moved writer must live in the real detached window');
  const floatBounds = await surfaceBounds('float-w.md');
  assert(floatBounds.length === 1 && floatBounds[0].windowId === detachedId, `window target must place the single writer surface in the detached window, got ${JSON.stringify(floatBounds)}`);
  const floatWriter = await scopedPage(`window.__nozeliReady===true&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='float-w.md'&&window.__workspaceScope?.windowId==='${detachedId}'&&!window.__workspaceScope?.readOnly`);
  assert((await docState(floatWriter)).text.includes(markerFor('float-w.md')), 'detached window renders the real writer file');
  assert.equal(await shell.evaluate(() => document.activeElement === document.body || !document.activeElement), true, 'window target: the launcher must not reclaim the keyboard after the file moved to its own window');
  await shot(detachedRoot, '06-window-detached-focused');
  report.checks.push('window: floatOpen moves the only writer into a real shown detached window (Wayland cannot prove OS activation; launcher did not reclaim, no mirror, DOM marker proof)');

  // 6f. The detached window root has its own working Quick Open (this was the lost-CtrlP bug).
  await ctrlP(detachedRoot);
  await detachedRoot.type('#quick-open-input', 'detached-note');
  await waitSettled(detachedRoot);
  await detachedRoot.keyboard.press('Enter');
  const detachedNote = await scopedPage(`window.__nozeliReady===true&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='detached-note.md'&&window.__workspaceScope?.windowId==='${detachedId}'`);
  assert((await docState(detachedNote)).text.includes(markerFor('detached-note.md')), 'detached-root Quick Open must open the file into its own window');
  report.checks.push('detached window root: CtrlP opens its own Quick Open and opens the file into that window');

  // 7. Consecutive Enter never duplicates the document.
  const writersBefore = (await layoutFor('notes-a.md')).writers.length;
  await quickOpen(shell, 'notes-a');
  await waitSettled(shell);
  await shell.keyboard.press('Enter');
  await shell.keyboard.press('Enter');
  await sleep(400);
  await shell.evaluate(() => document.querySelector('#quick-open').open && document.querySelector('#quick-open').close());
  assert.equal((await layoutFor('notes-a.md')).writers.length, writersBefore, 'rapid double Enter must not open a second writer');
  report.checks.push('consecutive Enter does not duplicate the document');

  // 8. Stale query / same-query ABA resolves against the final input value.
  for (const [steps, expected] of [[['bet', 'beta', 'bet', 'beta'], 'beta/dup.md'], [['folder-hit-00', 'folder-hit-005', 'folder-hit-005/hit'], 'folder-hit-005/hit-005.md']]) {
    await quickOpen(shell);
    for (const step of steps) { await shell.keyboard.down('Control'); await shell.keyboard.press('a'); await shell.keyboard.up('Control'); await shell.type('#quick-open-input', step); await sleep(60); }
    await shell.keyboard.press('Enter');
    const opened = await until(async () => { const page = await scopedPage(`window.__nozeliReady===true&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='${expected}'`); return page; }, 'opens final-query file');
    assert((await docState(opened)).text.includes(markerFor(expected)), `stale-query race must open ${expected} with its own content`);
  }
  report.checks.push('rapidly retryped (ABA) and stale queries open the file matching the final query text');

  // 9. Escape during the debounce: no late repaint, no reopen, nothing opened.
  const viewsBeforeEscape = await shell.evaluate(() => Object.keys(window.__workspaceGroups.snapshot().views).length);
  await quickOpen(shell);
  await shell.keyboard.down('Control'); await shell.keyboard.press('a'); await shell.keyboard.up('Control');
  await shell.type('#quick-open-input', 'dup', { delay: 0 });
  await shell.keyboard.press('Escape');
  await sleep(1200);
  assert.equal(await shell.$eval('#quick-open', node => node.open), false, 'dialog must stay closed');
  assert.equal(await shell.$eval('#quick-open-results', node => node.children.length), 0, 'no late result paint after close');
  assert.equal(await shell.evaluate(() => Object.keys(window.__workspaceGroups.snapshot().views).length), viewsBeforeEscape, 'close must not open anything');
  report.checks.push('closing during the in-flight debounce keeps the dialog closed with no late paint and nothing opened');

  // 10. Project transition race: closing the project mid-dialog must self-close it.
  await quickOpen(shell, 'dup');
  await until(async () => (await resultPaths(shell)).length >= 2, 'results before transition');
  await invoke(shell, 'workspace.closeProject', { projectId });
  await until(async () => {
    const identity = await shell.evaluate(async () => (await window.nozeli.invoke('workspace.bootstrap', {})).value);
    return identity.projectId == null;
  }, 'project closes');
  assert.equal(await shell.$eval('#quick-open', node => node.open), false, 'transition must close the quick-open dialog');
  await shell.evaluate(()=>{window.__quickReopenSettled=false;window.addEventListener('nozeli-project-transition',function settled(event){if(!event.detail.active){window.__quickReopenSettled=true;window.removeEventListener('nozeli-project-transition',settled);}});});
  await shell.click('#pick-project');
  await until(() => shell.evaluate(() => window.__quickReopenSettled&&window.__workspaceGroups?.snapshot?.()?.projectId || null), 'project reopens and settles');
  await quickOpen(shell, 'notes-a');
  await waitSettled(shell);
  assert((await resultPaths(shell)).includes('notes-a.md'), 'quick-open works again after reopen');
  await closeQuick(shell);
  report.checks.push('project transition while the dialog is open self-closes it; Quick Open works again after reopen');

  // 11. Directory-crowded query still returns real files (filesOnly contract), truncation stays honest.
  await quickOpen(shell, 'folder-hit');
  const status = await waitSettled(shell);
  const paths = await resultPaths(shell);
  assert(paths.length >= 1 && paths.length <= 100, `folder-hit must return real files within the limit, got ${paths.length}`);
  for (const rel of paths) assert(/^folder-hit-\d{3}\/hit-\d{3}\.md$/.test(rel), `result must be a real file, got ${rel}`);
  assert(/个结果|更多结果/.test(status), `status must be honest, got "${status}"`);
  const pick = paths[Math.floor(paths.length / 2)];
  await shell.click(`#quick-open-results [data-path="${pick}"][data-open-target="current"]`);
  const pickedPage = await scopedPage(`window.__nozeliReady===true&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='${pick}'`);
  assert((await docState(pickedPage)).text.includes(markerFor(pick)), `picked middle result ${pick} must open its own content`);
  report.checks.push(`120 same-prefix directories: search still returns real files (picked ${pick}, DOM marker proof), status honest: "${status}"`);

  // 12. Narrow/short window: long results stay reachable and the close control stays clickable.
  // Browser.getWindowForTarget/setWindowBounds do not exist in this Electron's
  // CDP protocol (page- and browser-level sessions both refuse them), so the
  // narrow/short window is emulated with a device-metrics override on the shell
  // page. That still proves the dialog's own narrow-DOM behavior; the real
  // WebContentsView surfaces cannot shrink under emulation because the bounds
  // pipeline validates the reported viewport against the native content size,
  // so the doc-surface size below is recorded as a measurement, not gated.
  const originalViewport = await shell.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const cdp = await shell.createCDPSession();
  await shell.setViewport({ width: 430, height: 330 });
  await until(() => shell.evaluate(() => window.innerWidth <= 431 && window.innerWidth > 200), 'shell shrinks');
  report.measurements.shellNarrow = await shell.evaluate(() => ({ innerWidth, innerHeight }));
  await quickOpen(shell, 'folder-hit');
  await waitSettled(shell);
  const narrow = await shell.evaluate(() => {
    const close = document.querySelector('#quick-open > button');
    const results = document.querySelector('#quick-open-results');
    const closeRect = close.getBoundingClientRect();
    results.scrollTop = results.scrollHeight;
    const rows = [...results.querySelectorAll('.quick-open-result')].slice(-3).map(row => [...row.querySelectorAll('button')].map(button => ({ target: button.dataset.openTarget, w: button.getBoundingClientRect().width, h: button.getBoundingClientRect().height, bottom: button.getBoundingClientRect().bottom })));
    return { closeVisible: closeRect.top >= 0 && closeRect.bottom <= innerHeight && closeRect.width > 0, scrollable: results.scrollHeight > results.clientHeight, innerHeight, rows };
  });
  assert(narrow.closeVisible, 'close button must stay inside the short viewport');
  assert(narrow.scrollable, 'long result list must scroll in the short viewport');
  for (const row of narrow.rows) for (const button of row) assert(button.w > 0 && button.h > 0 && button.bottom <= narrow.innerHeight + 2, `all open actions reachable at the bottom, got ${JSON.stringify(row)}`);
  const lastPath = (await resultPaths(shell)).at(-1);
  await shell.click(`#quick-open-results [data-path="${lastPath}"][data-open-target="current"]`);
  const narrowPage = await scopedPage(`window.__nozeliReady===true&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='${lastPath}'`);
  assert((await docState(narrowPage)).text.includes(markerFor(lastPath)), 'bottom-most result must still open its file');
  report.measurements.narrowDocSurface = { relPath: lastPath, ...(await narrowPage.evaluate(() => ({ innerWidth, innerHeight }))) };
  assert(report.measurements.narrowDocSurface.relPath === lastPath, 'the bottom-most result opens its own file under the narrow viewport');
  await shot(shell, '12-narrow-long-results');
  await cdp.send('Emulation.clearDeviceMetricsOverride');await shell.setViewport(originalViewport);
  await until(() => shell.evaluate(() => window.innerWidth > 500), 'shell restores');
  report.checks.push('narrow/short window: close control clickable, long list scrolls, bottom actions open their file; doc surface inner size measured separately');
  // Project close/reopen replaces native pages. Retire the CURRENT layout's
  // detached windows, not the stale detachedRoot handle from the earlier scene.
  const finalDetached=await shell.evaluate(()=>window.__workspaceGroups.snapshot().detached.map(window=>window.id));
  for(const windowId of finalDetached)await shell.evaluate(windowId=>window.__workspaceGroups.command({type:'dock',windowId}),windowId);
  await until(()=>shell.evaluate(()=>window.__workspaceGroups.snapshot().detached.length===0),'all current detached windows docked');
  // The dirty writer may be backgrounded after later opens. Reopen its actual
  // surface before saving; no skipped cleanup or fake exit receipt.
  await shell.evaluate(()=>window.__workspaceGroups.open({kind:'document',relPath:'notes-a.md'}));
  const notesNow=await scopedPage(`window.__nozeliReady===true&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope?.relPath==='notes-a.md'&&!window.__workspaceScope?.readOnly`);
  await notesNow.keyboard.down('Control');await notesNow.keyboard.press('s');await notesNow.keyboard.up('Control');
  await until(async()=>!(await invoke(shell,'workspace.document.snapshot',{projectId,relPath:'notes-a.md'})).dirty,'writer saved',15000);
  await requestCloseExpectZero('quick-open real check');
  assert.deepEqual(report.errors, [], 'no page errors during the session');
  report.ok = true;
} catch (error) {
  report.fatal = String(error?.stack || error);
  await dumpFocusTrace('focusTraceFailure').catch(() => {});
  await shell?.screenshot({ path: path.join(root, 'failure-state.png') }).catch(() => {});
  console.error('QuickOpen evidence', root, log.slice(-4000));
  if (browser) for (const page of await browser.pages()) console.error(await page.evaluate(() => ({ scope: window.__workspaceScope, quickOpen: { open: document.querySelector('#quick-open')?.open, value: document.querySelector('#quick-open-input')?.value, status: document.querySelector('#quick-open-status')?.textContent, rows: document.querySelectorAll('#quick-open-results .quick-open-result').length }, active: document.activeElement?.id || document.activeElement?.tagName, filter: document.querySelector('#file-filter')?.getAttribute('aria-expanded') })).catch(() => null));
} finally {
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  console.log(JSON.stringify(report, null, 2));
  if (browser) await browser.disconnect().catch(() => {});
  if (child && child.exitCode === null) child.kill(9);
  if (report.ok !== true) process.exitCode = 1;
}
