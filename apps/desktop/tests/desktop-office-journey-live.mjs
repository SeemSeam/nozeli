// Permanent real-package Office journey: actual engines edit and explicitly
// save DOCX/XLSX, PPTX exports a copy while the original stays untouched, an
// external source change is refused with a retained recovery copy, and a cold
// restart reopens the saved DOCX, the saved XLSX and the exported PPTX copy.
//
// Mac real bundle (no Ozone switch is passed on darwin):
//   NOZELI_TEST_BINARY=/Users/bfly/nozeli/dist/macos-verified-20261106/Nozeli.app \
//     node apps/desktop/tests/desktop-office-journey-live.mjs
// Development tree (from apps/desktop; Linux may set NOZELI_OZONE=x11|wayland):
//   node tests/desktop-office-journey-live.mjs
//
// Real app only: NOZELI_TEST_BINARY may point at the .app bundle or its inner
// executable. Profile and config root live outside the synthetic project, under
// a canonical temporary root. No credentials or model calls. The export test
// supplies a destination through a single-use native save-dialog override;
// actual edit, serialization, conflict handling and file publication stay real.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import JSZip from 'jszip';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';
import {contentToolForPage} from './native-content-tools.fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const tmp = await fs.realpath(os.tmpdir()); // macOS /tmp is a symlink; fixtures must sit on the real path.
const out = await fs.mkdtemp(path.join(tmp, 'nozeli-office-journey-'));
const project = path.join(out, 'project'), config = path.join(out, '.Nozeli'), profile = path.join(config, 'desktop');
await fs.mkdir(project, {recursive: true});

async function resolveBinary() {
  const requested = process.env.NOZELI_TEST_BINARY;
  if (!requested) return {binary: createRequire(import.meta.url)('electron'), packaged: false};
  const stat = await fs.stat(requested);
  if (stat.isDirectory()) {
    // macOS .app bundle: honor CFBundleExecutable instead of guessing a name.
    const plist = await fs.readFile(path.join(requested, 'Contents', 'Info.plist'), 'utf8');
    const name = plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/)?.[1] ?? 'Nozeli';
    const binary = path.join(requested, 'Contents', 'MacOS', name);
    await fs.access(binary, fs.constants.X_OK);
    return {binary, packaged: true};
  }
  await fs.access(requested, fs.constants.X_OK);
  return {binary: requested, packaged: true};
}
const {binary, packaged} = await resolveBinary();

const fixtures = {
  word: {name: 'sample.docx', source: path.join(root, 'tests/fixtures/office/中文 文档.docx')},
  sheet: {name: 'sample.xlsx', source: path.join(root, 'tests/fixtures/office/中文 表格.xlsx')},
  ppt: {name: 'sample.pptx', source: path.join(root, 'tests/fixtures/ppt/compatibility.pptx')},
};
const originals = {};
for (const {name, source} of Object.values(fixtures)) {
  originals[name] = await fs.readFile(source);
  await fs.writeFile(path.join(project, name), originals[name]);
}

const port = await new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const value = server.address().port; server.close(() => resolve(value));});});
const env = {...process.env};
for (const key of Object.keys(env)) if (key !== 'XAUTHORITY' && (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key) || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key))) delete env[key];
const ozone = process.env.NOZELI_OZONE; // darwin never receives an Ozone switch.
Object.assign(env, {NOZELI_TEST_INSTANCE: '1', NOZELI_TEST_PICK: project, NOZELI_CONFIG_ROOT: config, NOZELI_USER_DATA: profile, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0'});
const args = [...(packaged ? [] : [path.join(root, 'src/main/main.cjs')]), '--inspect=0',
  ...(process.platform === 'darwin' ? [] : ['--ozone-platform=' + (ozone || 'wayland')])];

let child, browser, exited, log = '';
const logs = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) throw Error(label + ' aborted: main exited ' + JSON.stringify(await exited) + '\n' + log);
    let value;
    try { value = await check(); } catch {}
    if (value) return value;
    if (Date.now() > deadline) throw Error(label + ' timeout\n' + log.slice(-8000));
    await pause(150);
  }
}
function launch() {
  child = spawn(binary, args, {cwd: out, env, stdio: ['ignore', 'pipe', 'pipe']});
  const session = {text: ''};
  logs.push(session);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {session.text += bytes; log = session.text;});
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
}
async function connect() {
  await until(async () => {try {browser = await puppeteer.connect({browserURL: `http://127.0.0.1:${port}`, defaultViewport: null}); return true;} catch {return false;}}, 'Electron debug endpoint');
}
async function scope(predicate) {
  return until(async () => {
    for (const page of await browser.pages()) {
      const state = await page.evaluate(async () => (await window.nozeli.invoke('workspace.bootstrap', {})).value).catch(() => null);
      if (state && predicate(state)) {await page.waitForFunction(() => window.__nozeliReady); return page;}
    }
  }, 'Workspace scope');
}
async function call(page, op, payload = {}) {
  const result = await page.evaluate((op, payload) => window.nozeli.invoke(op, payload), op, payload);
  assert.equal(result.ok, true, op + ': ' + JSON.stringify(result.error));
  return result.value;
}
async function dismiss(page) {
  if (await page.$eval('#configuration-setup', node => node.open).catch(() => false)) await page.click('#configuration-cancel');
}
// Bounded teardown: SIGTERM, bounded wait, SIGKILL; never an unbounded exit await.
async function stop(signal = 'SIGTERM') {
  inspector?.close(); inspector = null;
  try { await browser?.disconnect(); } catch {}
  browser = null;
  if (!child || child.exitCode !== null) return child ? await exited : null;
  child.kill(signal);
  let exit = await Promise.race([exited, pause(8000).then(() => null)]);
  if (!exit && child.exitCode === null) {
    child.kill('SIGKILL');
    exit = await Promise.race([exited, pause(3000).then(() => null)]) ?? {code: child.exitCode, signal: child.signalCode, forced: true};
  }
  return exit;
}
const saveShortcut = async page => {await page.bringToFront(); const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'; await page.keyboard.down(modifier); await page.keyboard.press('s'); await page.keyboard.up(modifier);};
// Use the real native shortcut. A failed save must stay observable; do not
// dispatch synthetic key events or retry a possibly admitted write.
async function explicitSave(page, effect) {
  await saveShortcut(page);
  await effect();
  return 'keyboard';
}

const report = {ok: false, out, project, config, profile, binary, packaged, platform: process.platform, port, markers: {}, checks: [], saves: {}, exits: {}};
let shell, wordPage, sheetPage, pptPage, inspector;
try {
  launch(); await connect();
  shell = await scope(state => state.role === 'shell'); await dismiss(shell);
  const picked = await call(shell, 'project.pick'); const projectId = picked.project.id; report.projectId = projectId;
  await shell.reload({waitUntil: 'domcontentloaded'}); await shell.waitForFunction(() => window.__nozeliReady); await dismiss(shell);
  await shell.locator(`#recent [data-project-id="${projectId}"]`).click();

  const openDoc = async name => {
    await shell.locator(`#file-tree button[data-path="${name}"]`).click();
    return until(async () => {
      for (const page of await browser.pages()) {
        const state = await page.evaluate(async () => (await window.nozeli.invoke('workspace.bootstrap', {})).value).catch(() => null);
        if (state && state.kind === 'document' && state.relPath === name) {await page.waitForFunction(() => window.__nozeliReady); return page;}
      }
    }, 'document page for ' + name);
  };
  const waitSaved = page => page.waitForFunction(() => document.querySelector('#save-status')?.dataset?.state === 'saved', {timeout: 25000, polling: 200});

  // ---- DOCX: real engine edit, explicit save, ZIP XML on disk. ----
  const wordMarker = 'JOURNEY_WORD_中文_7401'; report.markers.word = wordMarker;
  wordPage = await openDoc('sample.docx');
  let frame = await until(() => wordPage.frames().find(f => f.url().endsWith('/word-frame.html')), 'Word frame');
  await frame.waitForFunction(() => window.nozeliWordEditor?.activeEditor, {timeout: 90000});
  await frame.evaluate(() => {const editor = window.nozeliWordEditor.activeEditor; editor.commands.setTextSelection(1); editor.view.focus();});
  await wordPage.keyboard.type(wordMarker + ' ');
  await wordPage.keyboard.sendCharacter('中文旅程编辑 ');
  await frame.waitForFunction(marker => window.nozeliWordEditor.activeEditor.state.doc.textContent.includes(marker), {timeout: 30000}, wordMarker);
  await wordPage.waitForFunction(() => document.querySelector('#save-status')?.dataset?.state === 'dirty', {timeout: 20000});
  report.saves.word = await explicitSave(wordPage, () => waitSaved(wordPage));
  const docxSaved = await fs.readFile(path.join(project, 'sample.docx'));
  const wordXml = await (await JSZip.loadAsync(docxSaved)).file('word/document.xml').async('string');
  assert.match(wordXml, new RegExp(wordMarker), 'saved DOCX must contain the edited marker');
  assert.match(wordXml, /中文旅程编辑/, 'saved DOCX must contain the Chinese edit');
  assert.equal(wordXml.split(wordMarker).length - 1, 1, 'marker must occur exactly once in word/document.xml');
  await wordPage.screenshot({path: path.join(out, 'word-saved.png')});
  report.checks.push('DOCX actual engine edit + explicit save + saved ZIP word/document.xml verified');

  // ---- XLSX: engine cell edits, explicit save, ZIP worksheet values. ----
  const sheetMarker = 'JOURNEY_SHEET_中文_7402'; report.markers.sheet = sheetMarker;
  sheetPage = await openDoc('sample.xlsx');
  const sheetFrame = await until(() => sheetPage.frames().find(f => f.url().endsWith('/sheet-frame.html')), 'Sheet frame');
  await sheetFrame.waitForFunction(() => window.nozeliSheetEditor?.getAllSheets()?.length, {timeout: 90000});
  await sheetFrame.waitForFunction(() => !document.querySelector('#sheet')?.inert, {timeout: 90000});
  await sheetPage.bringToFront();
  await sheetFrame.locator('#sheet').click();
  report.sheetOriginalA1 = await sheetFrame.evaluate(() => nozeliSheetEditor.getCellValue(0, 0));
  await sheetFrame.evaluate(marker => nozeliSheetEditor.setCellValue(0, 0, marker), sheetMarker);
  await sheetFrame.waitForFunction(marker => nozeliSheetEditor.getCellValue(0, 0) === marker, {timeout: 30000}, sheetMarker);
  await sheetFrame.evaluate(() => nozeliSheetEditor.setCellValue(1, 1, 47012));
  await sheetFrame.waitForFunction(() => Number(nozeliSheetEditor.getCellValue(1, 1)) === 47012, {timeout: 30000});
  await sheetPage.waitForFunction(() => document.querySelector('#save-status')?.dataset?.state === 'dirty', {timeout: 20000});
  report.saves.sheet = await explicitSave(sheetPage, () => waitSaved(sheetPage));
  const xlsxSaved = await fs.readFile(path.join(project, 'sample.xlsx'));
  const xzip = await JSZip.loadAsync(xlsxSaved);
  const sheetXml = await xzip.file('xl/worksheets/sheet1.xml').async('string');
  const sharedEntry = xzip.file('xl/sharedStrings.xml');
  const sharedXml = sharedEntry ? await sharedEntry.async('string') : null;
  assert.match(sheetXml + ' ' + (sharedXml ?? ''), new RegExp(sheetMarker), 'saved XLSX must store the edited cell value');
  assert.match(sheetXml, /47012/, 'saved XLSX must store the edited numeric cell');
  await sheetPage.screenshot({path: path.join(out, 'sheet-saved.png')});
  report.checks.push('XLSX engine cell edits + explicit save + saved ZIP worksheet values verified');

  // ---- PPTX: engine text edit, exported copy via real export path, original untouched. ----
  const pptMarker = 'JOURNEY_PPT_中文_7403'; report.markers.ppt = pptMarker;
  await call(shell, 'workspace.control', {type: 'window-control', action: 'resize', width: 1024, height: 800});
  pptPage = await openDoc('sample.pptx');
  let pptFrame = await until(() => pptPage.frames().find(f => f.url().includes('/ppt-vendor/')), 'PPT frame');
  await pptFrame.waitForFunction(() => window.__nozeliPptist?.store?.slides?.length === 3, {timeout: 90000});
  await pptFrame.waitForSelector('.pptist-editor[data-nozeli-ppt-layout="compact"]', {visible: true});
  await pptFrame.waitForFunction(() => document.querySelector('.canvas')?.getBoundingClientRect().width >= innerWidth * .9 && document.querySelector('.canvas .viewport-wrapper')?.getBoundingClientRect().width >= 150);
  const layoutBaseline = await pptFrame.evaluate(() => {
    window.__ciPptCanvas = document.querySelector('.canvas');
    const canvas = window.__ciPptCanvas.getBoundingClientRect();
    const viewport = document.querySelector('.canvas .viewport-wrapper').getBoundingClientRect();
    return {model: JSON.stringify(window.__nozeliPptist.store.$state), width: innerWidth, canvasWidth: canvas.width, viewportWidth: viewport.width};
  });
  assert(layoutBaseline.width <= 900, 'exercise the actual narrow document viewport');
  assert(layoutBaseline.canvasWidth >= layoutBaseline.width * .9, 'sidebars must not squeeze the editable canvas');
  assert(layoutBaseline.viewportWidth >= 150, 'the fitted slide must not collapse into a tiny strip');
  for (const [panel, selector] of [['tools', '.layout-content-right'], ['slides', '.layout-content-left']]) {
    await pptFrame.locator(`.nozeli-ppt-panel-controls [data-panel="${panel}"]`).click();
    await pptFrame.waitForFunction(selector => document.querySelector(selector)?.checkVisibility(), {}, selector);
    await pptPage.keyboard.press('Escape');
    await pptFrame.waitForFunction(panel => document.querySelector(`.nozeli-ppt-panel-controls [data-panel="${panel}"]`)?.getAttribute('aria-expanded') === 'false', {}, panel);
    const retained = await pptFrame.evaluate(() => ({sameCanvas: window.__ciPptCanvas === document.querySelector('.canvas'), model: JSON.stringify(window.__nozeliPptist.store.$state)}));
    assert.equal(retained.sameCanvas, true, 'opening tools must not replace the live editor');
    assert.equal(retained.model, layoutBaseline.model, 'panel layout must not edit or reset the document');
  }
  report.pptLayout = {width: layoutBaseline.width, canvasWidth: layoutBaseline.canvasWidth, viewportWidth: layoutBaseline.viewportWidth};
  await pptPage.screenshot({path: path.join(out, 'ppt-narrow-canvas.png')});
  report.checks.push('narrow PPT retains a usable canvas and both original tool panels without replacing the editor or changing its model');
  const title = pptFrame.locator(() => [...document.querySelectorAll('.editable-element .ProseMirror')].find(node => {
    const rect = node.getBoundingClientRect();
    return node.textContent.includes('NOZELI_PPTIST_TITLE') && node.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) && rect.width > 0 && rect.height > 0;
  }));
  await title.click({clickCount: 2}); // Fresh, visible, stable DOM; still physical keyboard editing, never a store write.
  await pptPage.keyboard.press('End');
  await pptPage.keyboard.type(' ' + pptMarker);
  await pptFrame.waitForFunction(marker => JSON.stringify(window.__nozeliPptist.store.slides).includes(marker), {timeout: 30000}, pptMarker);
  // PPT drafts also auto-flush on a 1200ms debounce; dirty is observational
  // only, the explicit accelerator still runs the same production flush.
  await pptPage.waitForFunction(() => document.querySelector('#save-status')?.dataset?.state === 'dirty', {timeout: 5000}).catch(() => {});
  report.saves.pptDraft = await explicitSave(pptPage, () => waitSaved(pptPage));
  // Single-use native save-dialog override through the real main inspector;
  // the export itself runs the production flush + IPC + exclusive file write.
  const inspectorUrl = await until(() => log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1], 'main inspector');
  inspector = await MainObserver.connect(inspectorUrl);
  const evaluateMain = expression => inspector.evaluate(expression);
  const exportedPath = path.join(project, 'exported.pptx');
  const overridden = await evaluateMain(`(() => {const dialog = process.mainModule.require('electron').dialog; const original = dialog.showSaveDialog;
    dialog.showSaveDialog = async () => {dialog.showSaveDialog = original; return {canceled: false, filePath: ${JSON.stringify(exportedPath)}};}; return true;})()`);
  assert.equal(overridden, true, 'save dialog override');
  await contentToolForPage(pptPage,['file','exportPpt']);
  const exported = await until(() => fs.readFile(exportedPath).catch(() => null), 'exported PPTX copy', 60000);
  assert.deepEqual(await fs.readFile(path.join(project, 'sample.pptx')), originals['sample.pptx'], 'PPTX original must stay byte-identical after export');
  const ezip = await JSZip.loadAsync(exported);
  const exportedSlide = await ezip.file('ppt/slides/slide1.xml').async('string');
  assert.match(exportedSlide, new RegExp(pptMarker), 'exported copy must contain the edited text');
  assert.match(exportedSlide, /NOZELI_PPTIST_TITLE/, 'appending text must preserve the existing title');
  await pptPage.screenshot({path: path.join(out, 'ppt-exported.png')});
  report.checks.push('PPTX engine text edit + exported copy through real export path + original byte-identical');

  // ---- External modification conflict: explicit save refused, original kept, recovery copy retained. ----
  const conflictMarker = 'JOURNEY_CONFLICT_中文_7404'; report.markers.conflict = conflictMarker;
  await frame.evaluate(() => {const editor = window.nozeliWordEditor.activeEditor; editor.commands.setTextSelection(editor.state.doc.content.size); editor.view.focus();});
  await wordPage.keyboard.type(conflictMarker + ' ');
  await frame.waitForFunction(marker => window.nozeliWordEditor.activeEditor.state.doc.textContent.includes(marker), {timeout: 30000}, conflictMarker);
  await wordPage.waitForFunction(() => document.querySelector('#save-status')?.dataset?.state === 'dirty', {timeout: 20000});
  const externalZip = await JSZip.loadAsync(await fs.readFile(path.join(project, 'sample.docx')));
  externalZip.file('docProps/external-change.xml', '<external>journey conflict probe</external>');
  const externalBytes = await externalZip.generateAsync({type: 'nodebuffer'});
  await fs.writeFile(path.join(project, 'sample.docx'), externalBytes); // third-party editor writes the source
  const conflictEffect = () => wordPage.waitForSelector('#save-failure:not([hidden])', {timeout: 25000, polling: 200});
  report.saves.conflictAttempt = await explicitSave(wordPage, conflictEffect);
  const saveError = await wordPage.$eval('#save-error', node => node.textContent);
  assert.match(saveError, /原文件已被其他操作修改/, 'conflict must surface the no-overwrite message');
  const recoveryPath = saveError.match(/恢复副本：(\S+)/)?.[1];
  assert.ok(recoveryPath, 'conflict UI must surface the retained recovery copy path: ' + saveError);
  assert.deepEqual(await fs.readFile(path.join(project, 'sample.docx')), externalBytes, 'externally modified source must not be overwritten');
  const recoveryBytes = await fs.readFile(recoveryPath);
  const recoveryXml = await (await JSZip.loadAsync(recoveryBytes)).file('word/document.xml').async('string');
  assert.match(recoveryXml, new RegExp(conflictMarker), 'retained recovery copy must hold the unsaved edit');
  assert.match(recoveryXml, new RegExp(wordMarker), 'retained recovery copy must hold the earlier saved edit');
  await wordPage.screenshot({path: path.join(out, 'word-conflict.png')});
  report.checks.push('external DOCX modification: explicit save refused, source preserved, unsaved edit retained in recovery copy');

  // ---- Cold restart: same profile, reopen saved DOCX, saved XLSX and the exported PPTX copy. ----
  report.exits.session1 = await stop();
  launch(); await connect();
  shell = await scope(state => state.role === 'shell'); await dismiss(shell);
  await shell.waitForSelector(`#recent [data-project-id="${projectId}"]`, {timeout: 60000});
  await shell.locator(`#recent [data-project-id="${projectId}"]`).click();

  const reopenedWord = await openDoc('sample.docx');
  const reopenedWordFrame = await until(() => reopenedWord.frames().find(f => f.url().endsWith('/word-frame.html')), 'reopened Word frame');
  await reopenedWordFrame.waitForFunction(() => window.nozeliWordEditor?.activeEditor, {timeout: 90000});
  await reopenedWordFrame.waitForFunction(markers => {const text = window.nozeliWordEditor.activeEditor.state.doc.textContent;
    return text.includes(markers[0]) && !text.includes(markers[1]);}, {timeout: 60000}, [wordMarker, conflictMarker]);
  assert.deepEqual(await fs.readFile(path.join(project, 'sample.docx')), externalBytes, 'reopen must not rewrite the externally modified source');
  await reopenedWord.screenshot({path: path.join(out, 'restart-docx.png')});
  report.checks.push('cold restart reopens saved DOCX content without adopting the unsaved conflict edit');

  const reopenedSheet = await openDoc('sample.xlsx');
  const reopenedSheetFrame = await until(() => reopenedSheet.frames().find(f => f.url().endsWith('/sheet-frame.html')), 'reopened Sheet frame');
  await reopenedSheetFrame.waitForFunction(() => window.nozeliSheetEditor?.getAllSheets()?.length, {timeout: 90000});
  await reopenedSheetFrame.waitForFunction(marker => nozeliSheetEditor.getCellValue(0, 0) === marker, {timeout: 60000}, sheetMarker);
  assert.equal(Number(await reopenedSheetFrame.evaluate(() => nozeliSheetEditor.getCellValue(1, 1))), 47012, 'reopened XLSX numeric cell');
  await reopenedSheet.screenshot({path: path.join(out, 'restart-xlsx.png')});
  report.checks.push('cold restart reopens saved XLSX cell values');

  const reopenedExport = await openDoc('exported.pptx');
  const reopenedExportFrame = await until(() => reopenedExport.frames().find(f => f.url().includes('/ppt-vendor/')), 'reopened export frame');
  await reopenedExportFrame.waitForFunction(marker => window.__nozeliPptist?.store?.slides?.length === 3 && JSON.stringify(window.__nozeliPptist.store.slides).includes(marker), {timeout: 90000}, pptMarker);
  assert.deepEqual(await fs.readFile(path.join(project, 'sample.pptx')), originals['sample.pptx'], 'PPTX original must still be byte-identical after restart');
  assert.deepEqual(await fs.readFile(exportedPath), exported, 'exported copy must stay byte-identical after reopen');
  await reopenedExport.screenshot({path: path.join(out, 'restart-exported-pptx.png')});
  report.checks.push('cold restart reopens the exported PPTX copy with the edited text; original still pristine');

  // ---- Graceful quit with an exact exit receipt. ----
  if (process.platform === 'darwin') {
    inspector = await MainObserver.connect(await until(() => log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1], 'restarted main inspector'));
    await inspector.evaluate('setTimeout(()=>process.mainModule.require("electron").app.quit(),0);true');
    inspector.close(); inspector = null;
  } else await call(shell, 'session.requestClose');
  const graceful = await Promise.race([exited, pause(20000).then(() => null)]);
  if (!graceful) {
    report.exits.session2 = await stop();
    throw Error('Graceful close did not exit in 20s; forced exit receipt ' + JSON.stringify(report.exits.session2));
  }
  report.exits.session2 = graceful;
  assert.deepEqual(graceful, {code: 0, signal: null}, 'graceful close must exit cleanly');
  report.ok = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  report.documentStates = {};
  for (const [kind, page] of [['word', wordPage], ['sheet', sheetPage], ['ppt', pptPage]]) {
    if (!page) continue;
    report.documentStates[kind] = await page.evaluate(() => {const status = document.querySelector('#save-status');return {status: status?.dataset?.state, message: status?.textContent, focused: document.hasFocus(), active: document.activeElement?.tagName};}).catch(() => null);
  }
  await sheetPage?.screenshot({path: path.join(out, 'failure-sheet.png')}).catch(() => {});
  await wordPage?.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
  if (pptPage) {
    await pptPage.screenshot({path: path.join(out, 'failure-ppt.png')}).catch(() => {});
    const frame = pptPage.frames().find(item => item.url().includes('/ppt-vendor/'));
    report.pptGeometry = await frame?.evaluate(() => ({viewport: {width: innerWidth, height: innerHeight}, titles: [...document.querySelectorAll('.editable-element .ProseMirror')].filter(node => node.textContent.includes('NOZELI_PPTIST_TITLE')).map(node => {const rect = node.getBoundingClientRect();return {connected: node.isConnected, visible: node.checkVisibility(), rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height}};})})).catch(() => null);
  }
} finally {
  try { await inspector?.close(); } catch {}
  if (process.exitCode && child.exitCode === null) report.exits.forced = await stop();
  else if (child.exitCode === null) await stop();
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(out, 'electron-session-logs.json'), JSON.stringify(logs.map(session => session.text), null, 2));
  console.log(JSON.stringify(report));
}
