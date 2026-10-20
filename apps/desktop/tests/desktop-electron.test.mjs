import {installFileTreeClicks} from './file-tree-clicks.fixture.mjs';
  import { spawn } from 'node:child_process';
  import { createRequire } from 'node:module';
  import { mkdir, mkdtemp, readFile, rm, symlink, writeFile, unlink } from 'node:fs/promises';
  import net from 'node:net';
  import os from 'node:os';
  import path from 'node:path';
  import puppeteer from 'puppeteer-core';
  import { checkWorkspace } from './workspace-checks.mjs';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const appRoot = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(appRoot, '.test-output'), { recursive: true });
const outDir = await mkdtemp(path.join(appRoot, '.test-output', 'desktop-electron-'));
const samplePdf = path.resolve(appRoot, 'tests/fixtures/pdf/nozeli-sample.zh.pdf');

const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port === 8876 ? freePort() : port));
  });
});

async function waitFor(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child?.exitCode != null || child?.signalCode) throw new Error(`Electron exited before endpoint readiness: ${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`devtools did not come up: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function launch(env) {
  let output = '';
  const child = spawn(electronPath, [path.join(appRoot, 'src/main/main.cjs'), `--ozone-platform=${process.env.NOZELI_OZONE || 'headless'}`], {
    cwd: path.dirname(appRoot),
    env: { ...process.env, ...env, NOZELI_HIDDEN: process.env.NOZELI_TEST_VISIBLE === '1' ? '0' : '1', NOZELI_OZONE: process.env.NOZELI_OZONE || 'headless' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.once('exit', (code, signal) => { output += `\nPROCESS_EXIT code=${code} signal=${signal}\n`; });
  return { child, readOutput: () => output };
}

async function connect(port) {
  await waitFor(`http://127.0.0.1:${port}/json/version`);
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 120000 });
  const target = await browser.waitForTarget(target => target.type() === 'page' && target.url().startsWith('http://127.0.0.1:'), { timeout: 30000 });
  const page = await target.page();
  const waitForFunction = page.waitForFunction.bind(page);
  page.waitForFunction = (fn, options, ...args) => waitForFunction(fn, { polling: 100, ...options }, ...args);
  page.__errors = [];
  page.on('pageerror', (error) => page.__errors.push(String(error)));
  await page.waitForFunction(() => window.__nozeliReady === true, { timeout: 20000 }).catch(async (error) => {
    const state = await page.evaluate(() => ({ ready: window.__nozeliReady, nozeli: typeof window.nozeli, text: document.body?.innerText?.slice(0, 300), scripts: [...document.scripts].map((script) => script.src) })).catch((evalError) => String(evalError));
    throw new Error(`${error.message}\nurl=${page.url()}\n${(page.__errors || []).join('\n')}\n${JSON.stringify(state)}`);
  });
  const status = await page.evaluate(() => window.nozeli.invoke('config.status', {}));
  if (!status.ok) throw new Error(status.error.message);
  if (!status.value.initialized) {
    await page.waitForSelector('#configuration-setup[open]');
    await page.click('#configuration-cancel');
  }
  installFileTreeClicks(page, message => console.log('reading smoke: '+message));
  return { browser, page };
}

async function stop(child) {
  if (child.exitCode != null || child.signalCode) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

const checks = [];
function record(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log('reading smoke: '+name);
  if (!ok) throw new Error(`${name}: ${detail}`);
}

async function waitForInlineNote(text, present = true) {
  await page.waitForFunction(({ text, present }) => {
    const found = [...document.querySelectorAll('.note-anchor.tag-note .note-projection-content')].some((node) => node.textContent.includes(text));
    return found === present;
  }, {}, { text, present });
}

async function deleteInlineNote(text) {
  const id = await page.evaluate((value) => [...document.querySelectorAll('.note-anchor.tag-note')].find((node) => node.querySelector('.note-projection-content')?.textContent.includes(value))?.dataset.annotation || '', text);
  if (!id) throw new Error(`inline note not found: ${text}`);
  const selector = '.note-anchor[data-annotation="' + id + '"]';
  if (await page.$eval(selector + ' .note-projection', node => node.classList.contains('is-collapsed'))) await page.click(selector + ' .note-index');
  await page.$eval(selector + ' .tag-edit', node => node.click());
  await page.waitForSelector(`.note-anchor[data-annotation="${id}"] .tag-delete:not([hidden])`);
  await page.$eval(`.note-anchor[data-annotation="${id}"] .tag-delete`, node => node.click());
  await page.waitForSelector('#action-confirmation[open]');
  await page.click('#action-confirmation-accept');
}

const configurationRoot = path.join(await mkdtemp(path.join(os.tmpdir(), 'nozeli-desktop-user-')), '.Nozeli');
const userData = path.join(configurationRoot, 'desktop');
await mkdir(userData, { recursive: true });
const project = await mkdtemp(path.join(os.tmpdir(), 'nozeli-desktop-proj-'));
const relDir = path.join(project, '中文 目录');
await mkdir(relDir, { recursive: true });
  await writeFile(path.join(relDir, '笔记.md'), '原始正文\n');
  await writeFile(path.join(relDir, '第二份.md'), '第二份正文\n');
  await writeFile(path.join(relDir, '长文.txt'), Array.from({ length: 400 }, (_, i) => 'Line ' + i + ' original text').join('\n'));
  for (const length of [4000, 4001, 5001]) await writeFile(path.join(relDir, `长选区-${length}.txt`), '长'.repeat(length));
  try {
    await writeFile(path.join(relDir, '样例.pdf'), await readFile(samplePdf));
  } catch {
    await writeFile(path.join(relDir, '样例.pdf'), Buffer.from('%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'));
  }
const ownedOutside = path.join(userData, 'outside.txt');
await writeFile(ownedOutside, 'owned escape fixture');
await symlink(ownedOutside, path.join(project, '逃逸链接'));
await mkdir(outDir, { recursive: true });

  const port = await freePort();
  const otherProject = await mkdtemp(path.join(os.tmpdir(), 'nozeli-other-'));
  await writeFile(path.join(otherProject, '另一份.txt'), '另一项目正文\n');
  const env = {
    NOZELI_TEST_INSTANCE: '1',
    NOZELI_CONFIG_ROOT: configurationRoot,
    NOZELI_USER_DATA: userData,
    NOZELI_TEST_PICK: `${project}\n${otherProject}`,
    NOZELI_SHOT_DIR: outDir,
    NOZELI_DEBUG_PORT: String(port),
  };
let browser;
let page;
let child;
let output = () => '';
const report = {
  platform: `${process.platform}/${process.arch}`,
  windows: 'NOT TESTED',
  macos: 'NOT TESTED',
  nativeDialog: 'NOT TESTED; NOZELI_TEST_PICK supplied the owned directory and the system dialog was not clicked',
  port,
  userData,
  project,
};

try {
  ({ child, readOutput: output } = launch(env));
  ({ browser, page } = await connect(port));
  const duplicate = launch({ ...env, NOZELI_DEBUG_PORT: '0' });
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('duplicate profile process did not exit')), 6000);
      duplicate.child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    record('second process cannot own the same profile', exitCode === 0 && child.exitCode === null && !duplicate.readOutput().includes('NOZELI_DESKTOP_READY'), duplicate.readOutput());
  } finally { await stop(duplicate.child); }
  await page.setViewport({ width: 1440, height: 900 });
  const isolation = await page.evaluate(() => ({
    require: typeof require,
    process: typeof process,
    fs: typeof window.fs,
    electron: typeof window.electron,
    keys: Object.keys(window.nozeli || {}).sort(),
  }));
  record('renderer has no Node', isolation.require === 'undefined' && isolation.process === 'undefined' && isolation.fs === 'undefined' && isolation.electron === 'undefined' && isolation.keys.join() === 'invoke,subscribe', JSON.stringify(isolation));
  const aiText = await page.$eval('#ai-status', (node) => node.textContent);
  const unknown = await page.evaluate(() => window.nozeli.invoke('toString', {}));
  record('prototype operation rejected', !unknown.ok && unknown.error.code === 'UNKNOWN_OP');
  const staleFlush = await page.evaluate(() => window.nozeli.invoke('session.flushed', { ok: true, requestId: 'stale' }));
  record('stale close receipt rejected', staleFlush.value.accepted === false);
  record('AI status text', aiText.includes('尚未接通'), aiText);
  record('composer disabled', await page.$eval('#composer', (node) => node.disabled), '');
  console.log('phase open-project', Date.now());
  await page.click('#pick-project');
  await page.waitForFunction(() => document.querySelector('#project-name').textContent !== '未打开项目');
  record('opening a project does not repeat app initialization', await page.$eval('#configuration-setup', node => !node.open));
  const ignoredPick = await page.evaluate(() => window.nozeli.invoke('project.pick', { directory: '/tmp' }));
  record('renderer cannot choose an absolute directory', ignoredPick.ok && ignoredPick.value.project.rootDisplay !== '/tmp', JSON.stringify(ignoredPick.value?.project || ignoredPick.error));
  await page.waitForSelector('#file-tree button:not([disabled])');
  const escape = await page.evaluate(() => window.nozeli.invoke('file.read', { projectId: document.querySelector('#recent button')?.title, relPath: '../outside.txt' }));
  const projectId = ignoredPick.value.project.id;
  const escaped = await page.evaluate((id) => window.nozeli.invoke('file.read', { projectId: id, relPath: '../outside.txt' }), projectId);
  record('escape rejected over real IPC', escaped.ok === false, escaped.error?.code || '');
  const linked = await page.evaluate((id) => window.nozeli.invoke('file.read', { projectId: id, relPath: '逃逸链接' }), projectId);
  record('symlink rejected over real IPC', linked.ok === false, linked.error?.code || '');
  await page.click('#file-tree button[data-path="中文 目录/笔记.md"]');
  await page.waitForFunction(() => document.querySelector('#text-mode-toggle')?.textContent === '编辑');
  await page.click('#text-mode-toggle');
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => !document.querySelector('#text-host').inert);
  await page.focus('.cm-content');
  const inputSession = await page.createCDPSession();
  await inputSession.send('Input.insertText', { text: '浏览器输入' });
  const browserInput = await page.evaluate(() => window.__nozeliInput.text());
  record('browser input reaches real editor', browserInput.includes('浏览器输入'), browserInput);
  await page.evaluate(() => {
    window.__nozeliInput.insert('保存首段');
    document.querySelector('#retry-save').click();
    queueMicrotask(() => window.__nozeliInput.insert('保存期间新增'));
  });
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  const concurrentSaved = await readFile(path.join(relDir, '笔记.md'), 'utf8');
  record('typing during save is flushed before clean status', concurrentSaved.includes('保存首段') && concurrentSaved.includes('保存期间新增'), concurrentSaved);
  await page.evaluate(() => {
    window.__nozeliInput.insert('切换前保留');
    document.querySelector('#file-tree button[data-path="中文 目录/第二份.md"]').click();
    document.querySelector('#file-tree button[data-path="中文 目录/笔记.md"]').click();
  });
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('笔记.md') && !document.querySelector('#text-host').inert && window.__nozeliInput.text().includes('切换前保留'));
  const secondText = await readFile(path.join(relDir, '第二份.md'), 'utf8');
  record('rapid navigation preserves file identity and text', secondText === '第二份正文\n' && (await readFile(path.join(relDir, '笔记.md'), 'utf8')).includes('切换前保留'), secondText);
  const typed = await page.evaluate(() => window.__nozeliInput.insert('追加标记'));
  record('editor accepted text before close', typed.includes('追加标记'), typed);
  page.evaluate(() => window.nozeli.invoke('session.requestClose', {})).catch(() => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('window did not exit after flush')), 15000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  record('flush before close exited', true, output());
  const saved = await readFile(path.join(relDir, '笔记.md'), 'utf8');
  record('close flushed text to disk', saved.includes('追加标记'), saved);

  await browser.disconnect().catch(() => {});
  browser = null;
  const port2 = await freePort();
  ({ child, readOutput: output } = launch({ ...env, NOZELI_DEBUG_PORT: String(port2) }));
  ({ browser, page } = await connect(port2));
  await page.setViewport({ width: 1440, height: 900 });
  await page.waitForFunction(() => document.querySelector('#file-path')?.textContent?.includes('笔记.md'), { timeout: 15000 });
  const restored = await page.evaluate(() => window.__nozeliInput.text());
  record('restart restored text', restored.includes('追加标记'), restored);
  await page.evaluate(() => window.__nozeliInput.selectAll());
  await page.click('#show-note');
  await page.type('#note-input', '选段备注');
  await page.$eval('#add-note', node => node.click());
  await waitForInlineNote('选段备注');
  await page.waitForSelector('.note-index');
  record('saved text note still projects on its material', true);
  await page.click('#file-tree button[data-path="中文 目录/第二份.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('第二份.md') && document.querySelector('#note-input').value === '' && !document.querySelector('.note-index'));
  await page.click('#file-tree button[data-path="中文 目录/笔记.md"]');
  await page.waitForSelector('.note-index');
  await deleteInlineNote('选段备注');
  await waitForInlineNote('选段备注', false);
  record('deleting a note removes its text projection immediately', true);
  await page.click('#file-tree button[data-path="中文 目录/样例.pdf"]');
  await page.waitForFunction(() => document.querySelector('#pdf-host canvas') || (document.querySelector('#unsupported') && !document.querySelector('#unsupported').hidden && document.querySelector('#unsupported').textContent), { timeout: 20000 });
  const pdfError = await page.$eval('#unsupported', (node) => node.hidden ? '' : node.textContent);
  if (pdfError) throw new Error(pdfError);
  const canvas = await page.$eval('#pdf-host canvas', (node) => ({ width: node.width, height: node.height }));
  record('pdf canvas rendered', canvas.width > 0 && canvas.height > 0, JSON.stringify(canvas));
  await page.click('#show-note');
  await page.type('#note-input', '页级备注');
  await page.$eval('#add-note', node => node.click());
  await waitForInlineNote('页级备注');
  const span = await page.$eval('#pdf-host .textLayer span', node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, text: node.textContent }; });
  await page.mouse.move(span.x + 2, span.y + span.h / 2);
  await page.mouse.down();
  await page.mouse.move(span.x + Math.max(12, span.w - 2), span.y + span.h / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector('#selection-menu:not([hidden])');
  const noteButton = await page.$eval('#selection-note', node => node.getBoundingClientRect().toJSON());
  await page.mouse.click(noteButton.x + noteButton.width / 2, noteButton.y + noteButton.height / 2);
  await page.waitForSelector('#note-form:not([hidden])');
  await page.type('#note-input', '鼠标选文');
  const saveNote = await page.$eval('#add-note', node => node.getBoundingClientRect().toJSON());
  await page.mouse.click(saveNote.x + 10, saveNote.y + 8);
  await waitForInlineNote('鼠标选文');
  const selected = await page.evaluate(async (id) => (await window.nozeli.invoke('annotation.list', { projectId: id, relPath: '中文 目录/样例.pdf' })).value.annotations.find(note => note.note === '鼠标选文'), projectId);
  record('mouse text selection stores the full quote', selected.kind === 'pdf-selection' && selected.anchor.quote === span.text && selected.anchor.rects.every(r => r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= 1.001 && r[1] + r[3] <= 1.001), JSON.stringify(selected?.anchor));
  await page.evaluate(() => {
    const node = document.querySelector('#pdf-host .pdf-page');
    const trace = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup']) node.addEventListener(type, event => trace.push({ type: event.type, target: event.target.className || event.target.tagName }), true);
    window.__pdfRegionTrace = trace;
  });
  await page.click('#pdf-region');
  const pageBox = await page.$eval('#pdf-host .pdf-page', node => node.getBoundingClientRect().toJSON());
  await page.mouse.move(pageBox.x + 30, pageBox.y + 70);
  await page.mouse.down();
  await page.mouse.move(pageBox.x + 120, pageBox.y + 150, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('#selection-menu:not([hidden])');
  const regionTrace = await page.evaluate(() => ({
    ariaPressed: document.querySelector('#pdf-region')?.getAttribute('aria-pressed'),
    regionSelecting: document.querySelector('#pdf-host .pdf-page')?.classList.contains('region-selecting'),
    events: window.__pdfRegionTrace?.map(item => item.type) || [],
    menuHidden: document.querySelector('#selection-menu')?.hidden,
  }));
  record('region drag reaches pointer handlers and onSelection', regionTrace.ariaPressed === 'true' && regionTrace.regionSelecting && regionTrace.events.includes('pointerdown') && regionTrace.events.includes('pointermove') && regionTrace.events.includes('pointerup') && regionTrace.menuHidden === false, JSON.stringify(regionTrace));
  await page.click('#selection-note');
  record('region menu hides after action', await page.$eval('#selection-menu', node => node.hidden), 'selection menu remained visible');
  await page.type('#note-input', '鼠标框选');
  await page.click('#add-note');
  await waitForInlineNote('鼠标框选');
  const region = await page.evaluate(async (id) => (await window.nozeli.invoke('annotation.list', { projectId: id, relPath: '中文 目录/样例.pdf' })).value.annotations.find(note => note.note === '鼠标框选'), projectId);
  record('mouse region stores a bounded page rectangle, not a page-only note', region.kind === 'pdf-region' && region.anchor.quote === '' && region.anchor.rects[0][2] > 0 && region.anchor.rects[0][0] + region.anchor.rects[0][2] <= 1.001, JSON.stringify(region?.anchor));
  await page.waitForSelector('.note-index');
  const index = await page.$eval('.note-index', node => node.getBoundingClientRect().toJSON());
  await page.mouse.click(index.x + index.width / 2, index.y + index.height / 2);
  await page.waitForSelector('.note-projection:not([hidden])');
  const head = await page.$eval('.note-projection-head', node => node.getBoundingClientRect().toJSON());
  await page.mouse.move(head.x + 12, head.y + 8);
  await page.mouse.down();
  await page.mouse.move(head.x + 48, head.y + 28, { steps: 5 });
  await page.mouse.up();
  await page.focus('.note-projection-head');
  await page.keyboard.press('ArrowRight');
  record('note tag expands, drags, and accepts keyboard movement', await page.evaluate(() => { const card = document.querySelector('.note-projection'); return card && !card.hidden && card.style.transform.includes('px'); }));
  await page.evaluate(name => window.nozeli.invoke('session.capture', { name }), 'note-tags');
  const beforeZoom = region.anchor.rects[0].slice();
  await page.click('#pdf-zoom-in');
  await page.waitForFunction(width => document.querySelector('#pdf-host canvas').width > width, {}, canvas.width);
  const afterZoom = await page.evaluate(async (id) => (await window.nozeli.invoke('annotation.list', { projectId: id, relPath: '中文 目录/样例.pdf' })).value.annotations.find(note => note.note === '鼠标框选').anchor.rects[0], projectId);
  record('zoom does not rewrite the stored page rectangle', JSON.stringify(afterZoom) === JSON.stringify(beforeZoom), JSON.stringify(afterZoom));
  const overlap = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('#pdf-prev, #pdf-next, #pdf-page, #file-path, #save-status')].filter((node) => node.getBoundingClientRect().width > 0);
    const boxes = nodes.map((node) => ({ name: node.id || node.textContent, ...node.getBoundingClientRect().toJSON() }));
    const hits = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i];
        const b = boxes[j];
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 1 && overlapY > 1 && a.name !== b.name) hits.push([a.name, b.name]);
      }
    }
    return { hits, side: document.querySelector('#side').getBoundingClientRect().toJSON(), reader: document.querySelector('#reader').getBoundingClientRect().toJSON() };
  });
  record('desktop controls do not overlap', overlap.hits.length === 0, JSON.stringify(overlap.hits));
  await checkWorkspace({ page, projectId, record });
  const shot = await page.evaluate((name) => window.nozeli.invoke('session.capture', { name }), 'desktop-1440');
  if (!shot.ok) throw new Error(shot.error?.message || 'capture failed');
  await page.evaluate(() => window.nozeli.invoke('session.resize', { width: 390, height: 844 }));
  await page.setViewport({ width: 390, height: 844 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('#pdf-host canvas'), host = document.querySelector('#pdf-host');
    return canvas && canvas.getBoundingClientRect().width <= host.clientWidth;
  });
  const ratio = await page.$eval('#pdf-host canvas', canvas => {
    const box = canvas.getBoundingClientRect();
    return { actual: box.width / box.height, expected: canvas.width / canvas.height };
  });
  record('narrow PDF preserves page aspect ratio', Math.abs(ratio.actual - ratio.expected) < 0.01, JSON.stringify(ratio));
  const narrowShot = await page.evaluate((name) => window.nozeli.invoke('session.capture', { name }), 'narrow-390');
  if (!narrowShot.ok) throw new Error(narrowShot.error?.message || 'narrow capture failed');
  const narrow = await page.evaluate(() => {
    const side = document.querySelector('#side').getBoundingClientRect();
    const reader = document.querySelector('#reader').getBoundingClientRect();
    const toolbar = [...document.querySelectorAll('.pdf-toolbar button, .pdf-toolbar input')].map((node) => node.getBoundingClientRect());
    return {
      stacked: side.top >= reader.bottom - 1 || side.top >= reader.top + reader.height - 1,
      toolbarCount: toolbar.length,
      sideTop: side.top,
      readerBottom: reader.bottom,
    };
  });
  record('narrow layout does not cover reader with side panel', narrow.stacked || narrow.sideTop >= 600, JSON.stringify(narrow));
  for (const dock of ['top', 'left']) {
    await page.evaluate(() => { document.querySelector('#chat-layout').open = true; });
    const probe = await page.evaluate(dock => {
      const button = document.querySelector('button[data-dock="' + dock + '"]');
      button.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, hit: hit === button || button.contains(hit), tag: hit?.id || hit?.className || hit?.tagName };
    }, dock);
    record('narrow dock ' + dock + ' is under the pointer', probe.hit, JSON.stringify(probe));
    await page.mouse.click(probe.x, probe.y);
    record('narrow dock ' + dock + ' applied by real click', await page.evaluate(dock => document.querySelector('#work-surface').dataset.dock === dock, dock));
  }
  await page.evaluate(() => window.nozeli.invoke('session.resize', { width: 1440, height: 900 }));
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluate(() => document.querySelector('#file-tree button[data-path="中文 目录/笔记.md"]').click());
  const appeared = await page.waitForSelector('.cm-content', { timeout: 8000 }).then(() => true).catch(() => false);
  if (!appeared) {
    const state = await page.evaluate(() => ({ lastOpen: window.__lastOpen, status: document.querySelector('#save-status')?.textContent, path: document.querySelector('#file-path')?.textContent, unsupported: document.querySelector('#unsupported')?.textContent }));
    throw new Error(JSON.stringify(state));
  }
  await writeFile(path.join(relDir, '笔记.md'), '外部改写');
  const conflictTyped = await page.evaluate(() => window.__nozeliInput.insert('冲突草稿'));
  record('conflict text entered editor', conflictTyped.includes('冲突草稿'), conflictTyped);
  await page.waitForFunction(() => document.querySelector('#save-status')?.dataset.state === 'conflict', { timeout: 8000 });
  const disk = await readFile(path.join(relDir, '笔记.md'), 'utf8');
  record('external edit kept on disk', disk === '外部改写', disk);
  const editorText = await page.$eval('.cm-content', (node) => node.textContent);
  record('conflict kept editor draft', editorText.includes('冲突草稿'), editorText);
  await page.click('#overwrite-draft');
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  record('explicit overwrite updates saved baseline', (await readFile(path.join(relDir, '笔记.md'), 'utf8')).includes('冲突草稿'));
  await page.evaluate(() => document.querySelector('#file-tree button[data-path="中文 目录/第二份.md"]').click());
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('第二份.md') && !document.querySelector('#text-host').inert);
  await unlink(path.join(relDir, '笔记.md'));
  await page.evaluate(() => document.querySelector('#file-tree button[data-path="中文 目录/笔记.md"]').click());
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('笔记.md') && document.querySelector('#save-status').dataset.state === 'conflict' && !document.querySelector('#text-host').inert);
  record('deleted source restores editable draft', (await page.evaluate(() => window.__nozeliInput.text())).includes('冲突草稿'));
  const absent = await readFile(path.join(relDir, '笔记.md')).then(() => false, error => error.code === 'ENOENT');
  record('opening deleted draft does not recreate source', absent);
  await page.click('#overwrite-draft');
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  record('explicit recreation writes retained draft', (await readFile(path.join(relDir, '笔记.md'), 'utf8')).includes('冲突草稿'));
  await page.click('#file-tree button[data-path="中文 目录/长文.txt"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('长文.txt') && document.querySelector('#text-host .cm-scroller'));
  await page.waitForFunction(() => {
    const node = document.querySelector('#text-host .cm-scroller');
    return node && node.scrollHeight > node.clientHeight + 200;
  });
  const scrollBefore = await page.$eval('#text-host .cm-scroller', node => { node.scrollTop = 700; return node.scrollTop; });
  record('long text can leave the top', scrollBefore > 0, String(scrollBefore));
  await page.click('#file-tree button[data-path="中文 目录/第二份.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('第二份.md'));
  await page.click('#file-tree button[data-path="中文 目录/长文.txt"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('长文.txt') && document.querySelector('#text-host .cm-scroller'));
  await page.waitForFunction(() => document.querySelector('#text-host .cm-scroller').scrollTop > 0);
  record('return restores non-zero text scroll', await page.$eval('#text-host .cm-scroller', node => node.scrollTop) > 0);
  await page.evaluate(() => window.__nozeliInput.select(0, 8));
  await page.click('#show-note');
  await page.type('#note-input', 'UNSAVED_NOTE_MUST_SURVIVE');
  await page.click('#file-tree button[data-path="中文 目录/第二份.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('第二份.md') && document.querySelector('#note-input').value === '');
  await page.click('#file-tree button[data-path="中文 目录/长文.txt"]');
  await page.waitForFunction(() => document.querySelector('#note-input').value === 'UNSAVED_NOTE_MUST_SURVIVE');
  record('unsaved note draft survives file switch', true);
  await page.evaluate(() => {
    document.querySelector('#text-host .cm-editor').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }));
    window.__nozeliInput.insert('COMPOSING_PROBE');
    document.querySelector('#file-tree button[data-path="中文 目录/第二份.md"]').click();
  });
  await new Promise(resolve => setTimeout(resolve, 1200));
  record('composition blocks file switch', (await page.$eval('#file-path', node => node.textContent)).endsWith('长文.txt'));
  record('composition does not write before compositionend', !(await readFile(path.join(relDir, '长文.txt'), 'utf8')).includes('COMPOSING_PROBE'));
  await page.evaluate(() => document.querySelector('#text-host .cm-editor').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await page.click('#file-tree button[data-path="中文 目录/第二份.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('第二份.md'));
  await page.evaluate(() => window.__nozeliInput.select(0, 2));
  await page.click('#show-note');
  await page.type('#note-input', '甲');
  await page.click('#add-note');
  await waitForInlineNote('甲');
  await page.evaluate(() => window.__nozeliInput.select(2, 4));
  await page.click('#show-note');
  await page.type('#note-input', '乙');
  await page.click('#add-note');
  await waitForInlineNote('乙', false);
  await page.evaluate(() => window.__nozeliInput.replace('短'));
  const removedStale = await page.evaluate(async (id) => {
    const listed = await window.nozeli.invoke('annotation.list', { projectId: id, relPath: '中文 目录/第二份.md' });
    const note = listed.value.annotations.find((item) => item.note === '甲');
    return note ? window.nozeli.invoke('annotation.remove', { projectId: id, annotationId: note.id }) : { ok: false };
  }, projectId);
  await waitForInlineNote('乙');
  record('shortened dirty text can delete a stale note without a page error', removedStale.ok && (page.__errors || []).length === 0, JSON.stringify({ removedStale, errors: page.__errors || [] }));
  await page.click('#file-tree button[data-path="中文 目录/样例.pdf"]');
  await page.waitForSelector('#pdf-host canvas');
  await page.click('#pdf-search-toggle');
  await page.type('#pdf-query', 'Nozeli');
  const searchPromise = page.$eval('#pdf-search', node => node.requestSubmit());
  await page.click('#file-tree button[data-path="中文 目录/第二份.md"]');
  await searchPromise.catch(() => {});
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('第二份.md'));
  record('cancelled PDF search does not reject the page', (page.__errors || []).length === 0, (page.__errors || []).join('\n'));
  await page.click('#file-tree button[data-path="中文 目录/笔记.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('笔记.md') && !document.querySelector('#text-host').inert);
  await page.waitForFunction(() => document.querySelector('#save-status').dataset.state === 'saved');
  const frozenQuote = await page.evaluate(() => window.__nozeliInput.text());
  await page.evaluate(() => window.__nozeliInput.selectAll());
  await page.click('#show-note');
  await page.type('#note-input', 'REVIEW_FROZEN_SELECTION');
  await page.evaluate(() => window.__nozeliInput.select(0, 1));
  await page.click('#file-tree button[data-path="中文 目录/第二份.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('第二份.md') && document.querySelector('#note-input').value === '');
  await page.click('#file-tree button[data-path="中文 目录/笔记.md"]');
  await page.waitForFunction(() => document.querySelector('#note-input').value === 'REVIEW_FROZEN_SELECTION');
  await page.click('#add-note');
  await waitForInlineNote('REVIEW_FROZEN_SELECTION');
  const frozenSaved = await page.evaluate(async (id) => (await window.nozeli.invoke('annotation.list', { projectId: id, relPath: '中文 目录/笔记.md' })).value.annotations.find(note => note.note === 'REVIEW_FROZEN_SELECTION'), projectId);
  record('restored note saves the frozen quote without reselecting', frozenSaved?.kind === 'text-selection' && frozenSaved.anchor.quote === frozenQuote && frozenSaved.materialDigest === (await page.evaluate(async (id) => (await window.nozeli.invoke('file.read', { projectId: id, relPath: '中文 目录/笔记.md' })).value.materialDigest, projectId)), JSON.stringify(frozenSaved?.anchor));
  await page.waitForFunction(() => document.querySelector('#note-input').value === '');
  await page.evaluate(() => window.__nozeliInput.selectAll());
  await page.click('#show-note');
  await page.type('#note-input', 'OLD_DRAFT_CLEARED');
  await page.evaluate(() => {
    document.querySelector('#add-note').click();
    document.querySelector('#note-input').value = 'NEW_INPUT_KEPT';
    document.querySelector('#note-input').dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitForInlineNote('OLD_DRAFT_CLEARED');
  record('save receipt keeps newer note input', await page.$eval('#note-input', node => node.value) === 'NEW_INPUT_KEPT');
  await page.click('#file-tree button[data-path="中文 目录/第二份.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('第二份.md'));
  await page.click('#file-tree button[data-path="中文 目录/笔记.md"]');
  await page.waitForFunction(() => document.querySelector('#note-input').value === 'NEW_INPUT_KEPT');
  record('saved note text is not revived after switch', true);
  await page.click('#file-tree button[data-path="中文 目录/第二份.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('第二份.md') && !document.querySelector('#text-host').inert);
  const beforeRewrite = await page.evaluate(async (id) => (await window.nozeli.invoke('file.read', { projectId: id, relPath: '中文 目录/第二份.md' })).value.materialDigest, projectId);
  await page.evaluate(() => window.__nozeliInput.selectAll());
  await page.click('#show-note');
  await page.type('#note-input', 'MUST_NOT_REBIND');
  await page.click('#file-tree button[data-path="中文 目录/笔记.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('笔记.md'));
  await writeFile(path.join(relDir, '第二份.md'), '来源已经换成另一份材料\n');
  await page.click('#file-tree button[data-path="中文 目录/第二份.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('第二份.md') && document.querySelector('#note-input').value === '');
  record('source change does not restore the old note draft', true);
  await page.evaluate(() => document.querySelector('#note-form').requestSubmit());
  await new Promise(resolve => setTimeout(resolve, 400));
  const rebound = await page.evaluate(async (id) => (await window.nozeli.invoke('annotation.list', { projectId: id, relPath: '中文 目录/第二份.md' })).value.annotations.some(note => note.note === 'MUST_NOT_REBIND'), projectId);
  record('source change does not save the old draft onto the new material', rebound === false && typeof beforeRewrite === 'string' && beforeRewrite.length === 64);
  await page.click('#file-tree button[data-path="中文 目录/样例.pdf"]');
  await page.waitForSelector('#pdf-host canvas');
  await page.$eval('#pdf-page', node => { node.value = '1'; node.dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => document.querySelector('#pdf-page').value === '1');
  await page.click('#show-note');
  await page.type('#note-input', 'PAGE1_FROZEN');
  await page.click('#pdf-next');
  await page.waitForFunction(() => document.querySelector('#pdf-page').value === '2');
  await page.click('#file-tree button[data-path="中文 目录/笔记.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('笔记.md'));
  await page.click('#file-tree button[data-path="中文 目录/样例.pdf"]');
  await page.waitForSelector('#pdf-host canvas');
  await page.waitForFunction(() => document.querySelector('#note-input').value === 'PAGE1_FROZEN');
  await page.click('#add-note');
  await waitForInlineNote('PAGE1_FROZEN', false);
  const pageNote = await page.evaluate(async (id) => (await window.nozeli.invoke('annotation.list', { projectId: id, relPath: '中文 目录/样例.pdf' })).value.annotations.find(note => note.note === 'PAGE1_FROZEN'), projectId);
  record('pdf page draft stays on the frozen page after navigation and reopen', pageNote?.kind === 'pdf-page' && pageNote.anchor.page === 1, JSON.stringify(pageNote?.anchor));
  await page.$eval('#pdf-page', node => { node.value = '1'; node.dispatchEvent(new Event('change')); });
  await page.waitForFunction(() => document.querySelector('#pdf-page').value === '1');
  await waitForInlineNote('PAGE1_FROZEN');
  await page.click('#file-tree button[data-path="中文 目录/笔记.md"]');
  await page.waitForSelector('.note-index');
  const beforeMove = await page.evaluate(async (id) => (await window.nozeli.invoke('annotation.list', { projectId: id, relPath: '中文 目录/笔记.md' })).value.annotations.find(note => note.note === 'REVIEW_FROZEN_SELECTION'), projectId);
  await page.evaluate(() => document.querySelector('button[data-dock="bottom"]').click());
  await page.evaluate((ordinal) => {
    const index = [...document.querySelectorAll('.note-index')].find(node => node.textContent === String(ordinal));
    index.click();
    index.parentElement.querySelector('.note-projection-head').focus();
  }, beforeMove.ordinal);
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((ordinal) => {
    const index = [...document.querySelectorAll('.note-index')].find(node => node.textContent === String(ordinal));
    return index?.parentElement.querySelector('.note-projection')?.style.transform.includes('10px');
  }, {}, beforeMove.ordinal);
  await page.reload();
  await page.waitForFunction(() => window.__nozeliReady && document.querySelector('.note-index'));
  const afterMove = await page.evaluate(async (id, ordinal) => {
    const notes = (await window.nozeli.invoke('annotation.list', { projectId: id, relPath: '中文 目录/笔记.md' })).value.annotations;
    const note = notes.find(item => item.note === 'REVIEW_FROZEN_SELECTION');
    const index = [...document.querySelectorAll('.note-index')].find(node => node.textContent === String(ordinal));
    return { transform: index?.parentElement.querySelector('.note-projection')?.style.transform || '', note };
  }, projectId, beforeMove.ordinal);
  record('tag offset survives reload without changing anchor or ordinal', afterMove.transform.includes('10px') && afterMove.note?.ordinal === beforeMove.ordinal && afterMove.note.anchor.quote === beforeMove.anchor.quote && afterMove.note.anchor.start === beforeMove.anchor.start, JSON.stringify({ before: beforeMove?.anchor, after: afterMove.note?.anchor, ordinal: [beforeMove?.ordinal, afterMove.note?.ordinal], transform: afterMove.transform }));
  await page.click('#file-tree button[data-path="中文 目录/长文.txt"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('长文.txt') && document.querySelector('#save-status').dataset.state === 'saved' && !document.querySelector('#text-host').inert);
  await page.evaluate(() => {
    document.querySelector('#text-host .cm-editor').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    document.querySelector('#file-tree button[data-path="中文 目录/笔记.md"]').click();
  });
  await new Promise(resolve => setTimeout(resolve, 400));
  record('clean composition blocks file switch', (await page.$eval('#file-path', node => node.textContent)).endsWith('长文.txt'));
  await page.evaluate(() => document.querySelector('#text-host .cm-editor').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await page.click('#file-tree button[data-path="中文 目录/笔记.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('笔记.md'));
  record('compositionend allows the next file switch', true);
  console.log('phase long-anchor', Date.now());
  const longFiles = [4000, 4001, 5001].map(length => ({ name: `长选区-${length}.txt`, text: '长'.repeat(length), length }));
  for (const file of longFiles) {
    await page.click(`#file-tree button[data-path="中文 目录/${file.name}"]`);
    await page.waitForFunction(name => document.querySelector('#file-path').textContent.endsWith(name) && !document.querySelector('#text-host').inert, {}, file.name);
    await page.evaluate(() => window.__nozeliInput.selectAll());
    await page.click('#show-note');
    await page.type('#note-input', `KEEP-${file.length}`);
    await page.click('#file-tree button[data-path="中文 目录/笔记.md"]');
    await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('笔记.md'));
  }
  const pdfDigest = await page.evaluate(async (id) => (await window.nozeli.invoke('file.read', { projectId: id, relPath: '中文 目录/样例.pdf' })).value.materialDigest, projectId);
  const pdfQuote = '引'.repeat(5001);
  const pdfRects = Array.from({ length: 201 }, () => [0.1, 0.1, 0.2, 0.2]);
  const written = await page.evaluate(async (id, draft) => {
    const old = (await window.nozeli.invoke('state.read', { projectId: id })).value.state;
    return window.nozeli.invoke('state.write', { projectId: id, state: { ...old, workspace: { ...old.workspace, noteDrafts: [...(old.workspace.noteDrafts || []), draft] } } });
  }, projectId, { projectId, relPath: '中文 目录/样例.pdf', materialDigest: pdfDigest, kind: 'pdf-selection', anchor: { page: 1, rotation: 0, space: 'rendered-page-normalized', rects: pdfRects, quote: pdfQuote }, text: 'PDF-201', updatedAt: 3 });
  record('pdf draft with 201 rects and a long quote is accepted', written.ok === true, JSON.stringify(written.error || written.value?.state?.workspace?.noteDrafts?.length));
  await page.reload();
  await page.waitForFunction(() => window.__nozeliReady);
  const pdfRestored = await page.evaluate(async (id) => (await window.nozeli.invoke('state.read', { projectId: id })).value.state.workspace.noteDrafts.find(item => item.text === 'PDF-201'), projectId);
  record('pdf draft survives electron reopen unchanged', pdfRestored?.anchor.quote === pdfQuote && pdfRestored.anchor.rects.length === 201 && JSON.stringify(pdfRestored.anchor.rects) === JSON.stringify(pdfRects), JSON.stringify({ quote: pdfRestored?.anchor.quote?.length, rects: pdfRestored?.anchor.rects?.length }));
  for (const file of longFiles) {
    await page.click(`#file-tree button[data-path="中文 目录/${file.name}"]`);
    await page.waitForFunction(name => document.querySelector('#note-input').value === `KEEP-${name}`, {}, file.length);
    await page.click('#add-note');
    await waitForInlineNote(`KEEP-${file.length}`);
    const saved = await page.evaluate(async (id, name) => (await window.nozeli.invoke('annotation.list', { projectId: id, relPath: `中文 目录/${name}` })).value.annotations.find(note => note.note === `KEEP-${name.split('-')[1].replace('.txt', '')}`), projectId, file.name);
    record(`reopen saves ${file.length} character selection without reselecting`, saved?.anchor.quote === file.text && saved.anchor.end === file.length, JSON.stringify({ end: saved?.anchor.end, quote: saved?.anchor.quote?.length }));
  }
  console.log('phase legacy-drafts', Date.now());
  const viewPath = path.join(userData, 'nozeli', 'v1', 'projects', projectId, 'view.json');
  const legacyDigest = await page.evaluate(async (id) => (await window.nozeli.invoke('file.read', { projectId: id, relPath: '中文 目录/笔记.md' })).value.materialDigest, projectId);
  const otherDigest = 'b'.repeat(64);
  const truncatedQuote = '长'.repeat(4000);
  const legacyView = { schemaVersion: 1, currentRelPath: '中文 目录/笔记.md', workspace: { draft: '保留的项目对话草稿', dock: 'bottom', noteDrafts: [
    { projectId, relPath: '中文 目录/笔记.md', materialDigest: legacyDigest, kind: 'text', anchor: { start: 0, end: 4, quote: '旧版原文' }, text: '旧版未提交备注', updatedAt: 1 },
    { projectId, relPath: '中文 目录/样例.pdf', materialDigest: legacyDigest, kind: 'pdf', anchor: { page: 2 }, text: '旧页', updatedAt: 2 },
    { projectId, relPath: '中文 目录/样例.pdf', materialDigest: legacyDigest, kind: 'pdf', anchor: { page: 3, rotation: 0, space: 'rendered-page-normalized', rects: [[0.1, 0.2, 0.3, 0.1]], quote: '' }, text: '旧区域', updatedAt: 3 },
    { projectId, relPath: '中文 目录/样例.pdf', materialDigest: legacyDigest, kind: 'pdf', anchor: { page: 4, rotation: 90, space: 'rendered-page-normalized', rects: [[0.2, 0.2, 0.2, 0.2]], quote: '旧选文' }, text: '旧选文备注', updatedAt: 4 },
    { projectId, relPath: '中文 目录/笔记.md', materialDigest: otherDigest, kind: 'text', anchor: null, text: '无锚点', updatedAt: 5 },
    { projectId, relPath: '中文 目录/笔记.md', materialDigest: otherDigest, kind: 'text', anchor: { start: 0, end: 5001, quote: truncatedQuote }, text: '被截断', updatedAt: 6 },
    { projectId, relPath: '中文 目录/样例.pdf', materialDigest: otherDigest, kind: 'pdf', anchor: { rotation: 0, space: 'rendered-page-normalized', rects: [[0.1, 0.1, 0.1, 0.1]], quote: '无页' }, text: '缺页', updatedAt: 7 },
  ] } };
  await writeFile(viewPath, JSON.stringify(legacyView));
  await page.reload();
  await page.waitForFunction(() => window.__nozeliReady && document.querySelector('#composer').value === '保留的项目对话草稿');
  await page.waitForFunction(() => document.querySelector('#note-input').value === '旧版未提交备注');
  record('legacy text draft migrates without replacing its quote', await page.evaluate(async (id) => {
    const drafts = (await window.nozeli.invoke('state.read', { projectId: id })).value.state.workspace.noteDrafts;
    const text = drafts.find(item => item.text === '旧版未提交备注');
    return text?.kind === 'text-selection' && text.anchor?.quote === '旧版原文' && text.anchor?.end === 4;
  }, projectId));
  record('unrecoverable drafts remain visible and are not rebound', await page.$eval('#retained-notice', node => !node.hidden && node.textContent.includes('3')));
  await page.click('#file-tree button[data-path="中文 目录/第二份.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('第二份.md'));
  await page.evaluate(() => document.querySelector('button[data-dock="right"]').click());
  await page.waitForFunction(() => document.querySelector('#work-surface').dataset.dock === 'right');
  await page.reload();
  await page.waitForFunction(() => window.__nozeliReady && document.querySelector('#composer').value === '保留的项目对话草稿');
  const keptView = JSON.parse(await readFile(viewPath, 'utf8'));
  record('file switch and layout write keep the project draft and original records', keptView.workspace.draft === '保留的项目对话草稿' && keptView.workspace.retainedNoteDrafts.length === 3 && keptView.workspace.noteDrafts.some(item => item.anchor?.quote === '旧版原文') && keptView.workspace.retainedNoteDrafts.some(item => item.original?.anchor?.end === 5001));
  const corruptBytes = Buffer.from('{');
  await writeFile(viewPath, corruptBytes);
  await page.reload();
  await page.waitForFunction(() => window.__nozeliReady && document.querySelector('#save-error')?.textContent?.includes('未覆盖'));
  await page.evaluate(() => document.querySelector('button[data-dock="left"]').click());
  await page.click('#file-tree button[data-path="中文 目录/笔记.md"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('笔记.md'));
  record('failed view read does not overwrite view.json with defaults', Buffer.compare(await readFile(viewPath), corruptBytes) === 0);
  await writeFile(viewPath, JSON.stringify(legacyView));
  await page.evaluate(() => document.querySelector('#retry-save').click());
  await page.waitForFunction(() => document.querySelector('#composer').value === '保留的项目对话草稿' && document.querySelector('#save-failure').hidden);
  console.log('phase composition-project-close', Date.now());
  const openedOther = await page.evaluate((directory) => window.nozeli.invoke('project.pick', { directory }), otherProject);
  record('second owned project can be registered', openedOther.ok && openedOther.value.project.name === path.basename(otherProject), JSON.stringify(openedOther.value?.project || openedOther.error));
  await page.reload();
  await page.waitForFunction(() => window.__nozeliReady);
  await page.waitForFunction(name => document.querySelector('#project-name').textContent === name, {}, path.basename(otherProject));
  await page.click(`#recent button[title="${path.basename(project)}"]`);
  await page.waitForFunction(name => document.querySelector('#project-name').textContent === name, {}, path.basename(project));
  await page.click('#file-tree button[data-path="中文 目录/长文.txt"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent.endsWith('长文.txt') && document.querySelector('#save-status').dataset.state === 'saved' && !document.querySelector('#text-host').inert);
  await page.evaluate(() => {
    document.querySelector('#text-host .cm-editor').dataset.live = '1';
    document.querySelector('#text-host .cm-editor').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
  });
  await page.click(`#recent button[title="${path.basename(otherProject)}"]`);
  await new Promise(resolve => setTimeout(resolve, 500));
  record('clean composition blocks project switch', (await page.$eval('#project-name', node => node.textContent)) === path.basename(project) && (await page.$eval('#file-path', node => node.textContent)).endsWith('长文.txt') && await page.$eval('#text-host .cm-editor', node => node.dataset.live) === '1');
  const blockedClose = page.evaluate(() => window.nozeli.invoke('session.requestClose', {})).catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 800));
  record('clean composition blocks close', child.exitCode === null && (await page.$eval('#file-path', node => node.textContent)).endsWith('长文.txt') && await page.$eval('#text-host .cm-editor', node => node.dataset.live) === '1', String(child.exitCode));
  await blockedClose;
  await page.evaluate(() => document.querySelector('#text-host .cm-editor').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await page.click(`#recent button[title="${path.basename(otherProject)}"]`);
  await page.waitForFunction(name => document.querySelector('#project-name').textContent === name, {}, path.basename(otherProject));
  record('compositionend allows project switch', true);
  report.pageErrors = page.__errors || [];
  record('no page errors', report.pageErrors.length === 0, report.pageErrors.join('\n'));
  page.evaluate(() => window.nozeli.invoke('session.requestClose', {})).catch(() => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('close after compositionend did not exit')), 15000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  record('compositionend allows close', child.exitCode === 0 || child.exitCode === null);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.failure = String(error?.stack || error);
  console.error('Reading smoke failure; main logs: '+path.join(outDir,'electron.log')+'\n'+output());
  if(page&&!page.isClosed())await page.screenshot({path:path.join(outDir,'failure.png')}).catch(()=>{});
    if (page) await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'failure' })).catch(() => {});
} finally {
  report.checks = checks;
  report.electronLog = output();
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  if (output()) await writeFile(path.join(outDir, 'electron.log'), output());
  if (browser) await browser.disconnect().catch(() => {});
  if (child) await stop(child);
  if (report.ok) {
    await rm(userData, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
}

if (!report.ok) {
  console.error(report.failure);
  process.exit(1);
}
console.log(`desktop electron checks ${checks.length} ok; screenshots in ${outDir}`);
