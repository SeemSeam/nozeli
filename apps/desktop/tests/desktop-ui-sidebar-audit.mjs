// Focused REAL Electron host-sidebar acceptance; no Provider/model execution, no Diff scenario.
// Run serially, only AFTER normally closing the user's product and any other audit:
// NOZELI_SIDEBAR_OUT=/new/evidence/path node tests/desktop-ui-sidebar-audit.mjs
// Defaults to source main. Optional NOZELI_TEST_BINARY selects an installed binary.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {prepareFrozenWorkflow} from './desktop-frozen-workflow.fixture.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {managedWorkRecords, managedReviewTodos} from '../src/domain/managed-work-records.mjs';

const source = path.resolve(import.meta.dirname, '..');
const binary = process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
const lock = path.join(os.tmpdir(), 'nozeli-ui-design-live.lock');
await fs.mkdir(lock); // Never remove another audit's lock, singleton, profile or process.
const report = {source, binary, scenes: [], interactions: [], errors: [],
  evidence: '真实 Electron shell、真实 IPC 和宿主持久化状态的投影；合成历史不是 Agent 推理。',
  boundaries: ['No Provider initialization or model inference', 'Linux current display backend only', 'Host webContents screenshot, not OS compositor/window decoration', 'No Diff retest', 'No destructive actions or task submission']};
let out, fixture, child, browser, shell, launchError, log = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 45000) {
  const deadline = Date.now() + timeout;
  do {
    if (launchError) throw launchError;
    if (child && (child.exitCode !== null || child.signalCode)) throw Error('Product exited: ' + log);
    const value = await fn(); if (value) return value;
    await pause(80);
  } while (Date.now() < deadline);
  throw Error('Timed out: ' + label);
}
async function call(op, payload = {}) {
  const result = await shell.evaluate((op, payload) => window.nozeli.invoke(op, payload), op, payload);
  assert(result.ok, op + ': ' + JSON.stringify(result.error)); return result.value;
}
async function frames() { await shell.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }
async function sidebar() {
  const open = await shell.$eval('#app', n => n.classList.contains('narrow-layout') ? n.classList.contains('drawer-side-open') : !n.classList.contains('side-collapsed'));
  if (!open) await shell.click('#toggle-sidebar');
  await shell.waitForFunction(() => { const app = document.querySelector('#app'); return app.classList.contains('narrow-layout') ? app.classList.contains('drawer-side-open') : !app.classList.contains('side-collapsed'); });
  await shell.waitForSelector('#sidebar-body', {visible: true});
  await shell.waitForSelector('.workflow-panel', {visible: true}); await frames();
}
async function appearance(theme, palette, width, size) {
  await call('session.resize', {width: 1440, height: 1000});
  await shell.waitForFunction(() => innerWidth === 1440);
  await shell.click('#open-settings');
  await shell.click('[data-settings-section="settings-appearance"]');
  await shell.select('[data-appearance="theme"]', theme);
  await shell.select('[data-appearance="palette"]', palette);
  await shell.select('[data-appearance="size"]', String(size));
  await shell.click('#settings-close');
  await call('session.resize', {width, height: 1000});
  await shell.waitForFunction(width => innerWidth === width, {}, width);
  await shell.waitForFunction(() => document.querySelector('#app').classList.contains('narrow-layout') === (innerWidth <= 1000));
  await sidebar();
}
async function measure() {
  return shell.evaluate(() => {
    const colorContext=document.createElement('canvas').getContext('2d',{willReadFrequently:true});
    const rgba = value => {
      colorContext.clearRect(0,0,1,1);colorContext.fillStyle=value;colorContext.fillRect(0,0,1,1);
      const pixel=colorContext.getImageData(0,0,1,1).data;return [pixel[0],pixel[1],pixel[2],pixel[3]/255];
    };
    const over = (a, b) => { const alpha = a[3] + b[3] * (1 - a[3]); return [...a.slice(0, 3).map((v, i) => (v * a[3] + b[i] * b[3] * (1 - a[3])) / alpha), alpha]; };
    const background = node => {
      const chain = []; for (let n = node; n; n = n.parentElement) chain.push(rgba(getComputedStyle(n).backgroundColor));
      return chain.reverse().reduce((base, color) => over(color, base), [255, 255, 255, 1]);
    };
    const lum = rgb => rgb.slice(0, 3).map(v => { const c = v / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const shown = n => { const b = n.getBoundingClientRect(), s = getComputedStyle(n); return n.getClientRects().length && s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0; };
    const selectors = ['.managed-work-name', '.managed-work-status', '.managed-work-description', '.managed-work-history p', '.managed-work-decisions button', '.managed-todo-title', '.managed-todo-marker', '#managed-todo-full-name:not([hidden])', '#managed-todo-filters button', '#managed-todo-menu button'];
    const nodes = selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(shown).map(n => {
      const style = getComputedStyle(n), bg = background(n), fg = over(rgba(style.color), bg), a = lum(fg), b = lum(bg), bounds = n.getBoundingClientRect();
      const row = n.closest('[data-managed-request],[data-todo-row]');
      const container = row?.getBoundingClientRect();
      return {selector, text: n.textContent, disabled: !!n.disabled, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), color: style.color, background: bg, font: style.fontSize, bounds: bounds.toJSON(), insideRow: !container || bounds.left >= container.left - 1 && bounds.right <= container.right + 1};
    }));
    const boxes = [...document.querySelectorAll('.workflow-panel,.inbox-panel,#work-items,#inbox-reports,[data-managed-request],[data-todo-row]')].filter(shown).map(n => ({selector: n.id || n.className, bounds: n.getBoundingClientRect().toJSON(), client: n.clientWidth, scroll: n.scrollWidth, overflowX: getComputedStyle(n).overflowX}));
    const active = document.activeElement, s = getComputedStyle(active);
    return {theme: document.documentElement.dataset.theme, palette: document.documentElement.dataset.palette, font: getComputedStyle(document.documentElement).getPropertyValue('--chrome-font-size'), viewport: {width: innerWidth, height: innerHeight}, pageOverflow: document.documentElement.scrollWidth > innerWidth, nodes, boxes, focus: {tag: active.tagName, text: active.textContent?.slice(0, 120), visible: active.matches(':focus-visible'), outline: s.outlineStyle, outlineWidth: s.outlineWidth, boxShadow: s.boxShadow}};
  });
}
async function capture(label) {
  await frames(); const data = await measure();
  const scene = {label, ...data, file: label + '.png'}; report.scenes.push(scene);
  await shell.screenshot({path: path.join(out, scene.file)});
  assert(data.nodes.length, label + ': missing real sidebar text');
  assert(!data.pageOverflow, label + ': page horizontal overflow');
  assert(data.nodes.every(n => n.insideRow), label + ': text/control bounds outside row');
  assert(data.boxes.every(n => n.scroll <= n.client + 1), label + ': sidebar horizontal overflow');
  const bad = data.nodes.filter(n => !n.disabled && n.contrast < 4.5);
  assert.deepEqual(bad, [], label + ': normal text contrast below 4.5');
  return data;
}
async function snapshotFiles(root) {
  const result = {};
  async function walk(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
      if (entry.name === '.git' || entry.name === '.nozeli') continue;
      const rel = path.join(prefix, entry.name), target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target, rel);
      else if (entry.isFile()) result[rel] = createHash('sha256').update(await fs.readFile(target)).digest('hex');
    }
  }
  await walk(root); return result;
}
function business(state) {
  return {works: state.works, jobs: state.jobs, todos: state.todos, drafts: state.drafts, receipts: state.receipts, messages: state.messages, providers: state.providers};
}
async function prepare() {
  fixture = await prepareFrozenWorkflow(out);
  const c = await Controller.open({storage:fixture.storage,projectId:fixture.a.id,runtimeRoot: fixture.runtimeRoot, contentRoot: fixture.project});
  const names = {running: '执行中：逐项核对很长的中文材料名称并保持工作现场与未发送草稿', review: '结果待审查：阅读真实宿主持久化报告而不启动模型或后台作业', paused: 'PendingReviewOfIndependentSourceMaterialsAndFrozenCandidateVersionWithoutOverwritingDraftsOrRepeatingAcceptedRequests'};
  fixture.sidebar = {};
  try {
    await c.store.mutate(() => { c.store.state.limit = 3; });
    for (const status of ['review', 'paused', 'running']) {
      const w = await c.store.submit(names[status], '合成持久化历史；不是模型执行，不得重放', {name: names[status]});
      await c.store.activate(w.id);
      if (status !== 'running') {
        const kind = status === 'review' ? 'result' : 'problem';
        const text = '这是宿主持久化的合成历史，不是真实模型推理。请核对来源、版本与待办状态；阅读不能新建任务或改动草稿。';
        const body = kind === 'result'
          ? '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>侧栏专项报告</title></head><body><main><h1>侧栏专项报告</h1><p>' + text + '</p></main></body></html>'
          : '# 侧栏专项报告\n\n' + text + '\n';
        const receipt = await c.store.publish(w.id, 1, kind, body, 'sidebar-' + kind);
        await c.store.settle(w.id);
        fixture.sidebar[kind] = {workId: w.id, objectId: receipt.objectId};
      }
      fixture.sidebar[status] = w.id;
    }
    await c.store.mutate(() => {
      const at = new Date().toISOString();
      // Read-only synthetic identities prevent any native session admission/replay.
      for (const w of c.store.state.works) w.readOnly = true;
      c.store.state.jobs.push({id: 'sidebar-failed-intake', target: 'orchestrator', type: 'intake', status: 'failed', text: '失败请求：材料读取中止，原请求和未发送草稿保留，不会自动重放', context: {}, at, finishedAt: at, error: '合成失败历史：等待人工检查材料；没有 Provider 或推理。'});
      c.store.state.todos.push({id: 'sidebar-system', kind: 'system', status: 'open', sourceJobId: 'sidebar-failed-intake', text: '系统提示：材料读取失败。核对材料后再决定是否重试；当前只读浏览不启动执行。', createdAt: at});
      c.store.state.todos.push({id: 'sidebar-closed', kind: 'system', status: 'closed', text: '已关闭提醒不表示故障已修复；原任务与材料继续保留。', reason: '合成历史：用户仅关闭提醒', createdAt: at, closedAt: at});
      for(let i=0;i<55;i++)c.store.state.todos.push({id:'sidebar-history-'+i,kind:'system',status:'resolved',text:'已处理的合成历史记录 '+i,createdAt:at,settledAt:at});
      c.store.state.drafts.frontdesk = '侧栏专项：未发送主草稿，禁止发送或改变';
      for (const w of c.store.state.works) c.store.state.drafts[w.id] = '未发送工作草稿：' + w.id;
    });
  } finally { await c.stop(); }
  report.identity = fixture.sidebar;
}

try {
  // The global product singleton is intentionally NOT bypassed by test profile isolation.
  const singleton = path.join(os.userInfo().homedir, '.Nozeli', 'application-singleton', 'SingletonLock');
  const exists = await fs.lstat(singleton).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
  assert(!exists, 'Global product singleton exists: normally close the product first; this audit never kills it or removes its lock.');
  out = process.env.NOZELI_SIDEBAR_OUT ? path.resolve(process.env.NOZELI_SIDEBAR_OUT) : await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-sidebar-audit-'));
  if (process.env.NOZELI_SIDEBAR_OUT) await fs.mkdir(out);
  report.out = out;
  await prepare();
  const fileBaseline = await snapshotFiles(fixture.project);
  const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)) delete env[key];
  Object.assign(env, {NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: fixture.configRoot, NOZELI_USER_DATA: fixture.profile, NOZELI_TEST_PICK: fixture.project, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0', NOZELI_SHOT_DIR: out});
  report.platform = {platform: process.platform, arch: process.arch, backend: process.env.NOZELI_OZONE || 'wayland'};
  child = spawn(binary, [...(process.env.NOZELI_TEST_BINARY ? [] : [path.join(source, 'src/main/main.cjs')]), '--ozone-platform=' + report.platform.backend], {cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe']});
  child.on('error', error => { launchError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; });
  await until(async () => { try { browser = await puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null}); return true; } catch { return false; } }, 'real product debug endpoint');
  shell = await until(async () => { for (const page of await browser.pages()) if (await page.evaluate(() => window.__workspaceScope?.role === 'shell' && window.__nozeliReady === true).catch(() => false)) return page; }, 'real native shell');
  shell.on('pageerror', error => report.errors.push(error.stack));
  if (await shell.$eval('#configuration-setup', n => n.open)) await shell.click('#configuration-cancel');
  await shell.waitForSelector('[data-project-id="' + fixture.a.id + '"]', {visible: true});
  await shell.click('[data-project-id="' + fixture.a.id + '"]');
  await until(async () => (await call('workspace.bootstrap')).projectId === fixture.a.id, 'project bound');
  await until(async () => (await call('managed.status', {projectId: fixture.a.id})).state?.todos.some(t => t.id === 'sidebar-system'), 'real host synthetic persisted state');
  const initial = await call('managed.status', {projectId: fixture.a.id});
  assert.equal(initial.ready, false); assert.deepEqual(Object.keys(initial.state.providers || {}), []);
  const records = managedWorkRecords(initial.state), todos = managedReviewTodos(initial.state);
  for (const status of ['running', 'review', 'paused', 'failed']) assert(records.some(r => r.status === status), 'Missing real projection ' + status);
  for (const kind of ['result', 'problem', 'system']) assert(todos.some(t => t.kind === kind), 'Missing real todo ' + kind);
  const baseline = structuredClone(business(initial.state));
  report.initialProjection = {records, todos};
  for (const palette of ['sage', 'slate']) for (const theme of ['light', 'dark']) for (const size of [13, 20]) for (const width of [1440, 390]) {
    const label = [palette, theme, size, width].join('-');
    console.log('SIDEBAR_SCENE ' + label);
    await appearance(theme, palette, width, size);
    await shell.click('[data-todo-filter="open"]');
    await shell.waitForSelector('[data-todo-row="sidebar-system"]', {visible: true});
    for (const status of ['running', 'review', 'paused', 'failed']) assert(await shell.$('.managed-work-entry[data-state="' + status + '"]'), label + ': status row missing');
    assert.equal(await shell.$$eval('[data-todo-row] :is(.managed-todo-labels,.managed-todo-excerpt,.managed-todo-time,.managed-todo-reason,.managed-todo-open-hint,time)',nodes=>nodes.length),0,'List must not contain card details');
    assert(await shell.$$eval('[data-todo-row]',nodes=>nodes.every(n=>!n.hasAttribute('tabindex')&&n.querySelectorAll(':scope > button').length===2)),'Only title and menu are tab stops');
    assert(await shell.$$eval('.managed-todo-title',nodes=>nodes.every(n=>n.clientHeight<=parseFloat(getComputedStyle(n).lineHeight)*2+1)),'Titles exceed two lines');
    await capture(label + '-collapsed');
    const workEntry='.managed-work-entry[data-managed-work="'+fixture.sidebar.review+'"] .managed-work-open';
    await shell.focus(workEntry);await shell.keyboard.down('Shift');await shell.keyboard.press('F10');await shell.keyboard.up('Shift');await shell.waitForSelector('#managed-work-menu:not([hidden])',{visible:true});await capture(label+'-work-menu');await shell.keyboard.press('Escape');
    await shell.focus(workEntry);await shell.keyboard.press('Tab');
    const focus = (await measure()).focus;
    assert(focus.visible && (focus.outline !== 'none' && focus.outlineWidth !== '0px' || focus.boxShadow !== 'none'), label + ': no visible keyboard focus');
    report.interactions.push({label,action:'Tab after Work name',focus});
    await capture(label + '-tab-focus');
    await shell.focus('[data-managed-todo="sidebar-system"]');await shell.waitForSelector('#managed-todo-full-name',{visible:true});assert((await shell.$eval('#managed-todo-full-name',n=>n.innerText)).includes(await shell.$eval('[data-managed-todo="sidebar-system"]',n=>n.getAttribute('aria-label'))));
    await shell.keyboard.down('Shift'); await shell.keyboard.press('F10'); await shell.keyboard.up('Shift');
    await shell.waitForSelector('#managed-todo-menu', {visible: true});
    await capture(label + '-keyboard-menu');
    await shell.keyboard.press('Escape');
    await shell.waitForFunction(() => { const n = document.querySelector('#managed-todo-menu'); return !n || n.hidden || getComputedStyle(n).display === 'none'; });
    assert(await shell.$eval('[data-managed-todo="sidebar-system"]', n => document.activeElement === n), label + ': Escape failed to restore title focus');
    await shell.click('[data-todo-more="sidebar-system"]');await shell.waitForSelector('#managed-todo-menu',{visible:true});await shell.keyboard.press('Escape');assert(await shell.$eval('[data-todo-more="sidebar-system"]',n=>document.activeElement===n));
    await shell.click('[data-managed-todo="sidebar-system"]',{button:'right'});await shell.waitForSelector('#managed-todo-menu',{visible:true});await shell.keyboard.press('Escape');
    await shell.click('[data-todo-filter="closed"]');
    await shell.waitForSelector('[data-todo-row="sidebar-closed"]', {visible: true});
    assert.equal(await shell.$$eval('[data-todo-row]', nodes => nodes.length), 1);
    await capture(label + '-closed-filter');
    await shell.click('[data-todo-filter="all"]');
    await shell.waitForSelector('[data-todo-row="sidebar-history-54"]', {visible: true});assert.equal(await shell.$$eval('[data-todo-row]',nodes=>nodes.length),50);
    await capture(label + '-all-filter');
    await shell.click('[data-todo-filter="open"]');
    await shell.focus(summary); await shell.keyboard.press('Enter');
    await shell.waitForFunction(selector => !document.querySelector(selector).closest('details').open, {}, summary);
    report.interactions.push({label, action: 'Enter expand/collapse; Shift+F10/Escape; closed/all/open filters', passed: true});
  }
  const media=await shell.createCDPSession();await media.send('Emulation.setEmulatedMedia',{features:[{name:'forced-colors',value:'active'}]});assert(await shell.evaluate(()=>matchMedia('(forced-colors:active)').matches));await shell.focus('[data-managed-todo="sidebar-system"]');assert.equal(await shell.$eval('.managed-todo-row[data-category="check"] .managed-todo-marker',n=>n.textContent),'！');await capture('forced-colors-entry');await media.send('Emulation.setEmulatedMedia',{features:[]});await media.detach();
  await appearance('light', 'sage', 1440, 13);
  await shell.click('[data-todo-filter="completed"]');assert.equal(await shell.$$eval('[data-todo-row]',nodes=>nodes.length),50);await shell.click('#managed-todo-more');assert.equal(await shell.$$eval('[data-todo-row]',nodes=>nodes.length),56);assert(await shell.evaluate(()=>Boolean(document.activeElement?.closest('[data-todo-row]'))),'Pagination must retain meaningful keyboard focus');report.interactions.push({action:'historical pagination',first:50,total:56,focusRetained:true});await shell.click('[data-todo-filter="open"]');
  const resultTodo=todos.find(todo=>todo.kind==='result'&&todo.workId===fixture.sidebar.review);assert(resultTodo);
  await shell.focus('[data-managed-todo="'+resultTodo.id+'"]');await shell.keyboard.press('Enter');
  await until(async () => (await shell.$eval('#conversation-connection-error', n => n.open)) || Object.values((await call('workspace.snapshot', {projectId: fixture.a.id})).layout.views).some(view => view.kind === 'report'), 'report request or connection notice');
  if (await shell.$eval('#conversation-connection-error', n => n.open)) await shell.keyboard.press('Escape');
  await call('session.resize', {width: 1441, height: 1000});
  await call('session.resize', {width: 1440, height: 1000});
  const reader = await until(async () => { for (const page of await browser.pages()) if (await page.evaluate(id => window.__workspaceScope?.kind === 'report' && window.__workspaceScope?.projectId === id, fixture.a.id).catch(() => false)) return page; }, 'actual report WCV');
  await reader.waitForFunction(() => document.body.innerText.includes('这是宿主持久化的合成历史'));
  const titleScope=await reader.evaluate(()=>window.__workspaceScope);assert.equal(titleScope.viewState.report.todoId,resultTodo.id,'Title must open original todo');await shell.click('[data-managed-todo="'+resultTodo.id+'"]');await reader.waitForFunction(id=>window.__workspaceScope.viewState.report.todoId===id,{},resultTodo.id);
  const readerScope = await reader.evaluate(() => window.__workspaceScope);
  const surface = await until(async () => (await call('workspace.windows.list', {projectId: fixture.a.id})).flatMap(w => w.surfaces).find(s => s.viewId === readerScope.viewId && s.visible && s.bounds.width > 0 && s.bounds.height > 0), 'visible actual report WCV');
  report.reportSurface = surface;
  await reader.screenshot({path: path.join(out, 'report-real-wcv.png')});
  report.interactions.push({action: 'todo title Enter opens original full result', todoId:resultTodo.id,scope: readerScope, screenshot: 'report-real-wcv.png', contentVerified: true});
  const final = await call('managed.status', {projectId: fixture.a.id});
  assert.deepEqual(business(final.state), baseline, 'Reading interactions changed authoritative works/jobs/todos/drafts/receipts/messages/providers');
  assert.deepEqual(await snapshotFiles(fixture.project), fileBaseline, 'Reading changed project files');
  assert.equal(final.ready, false); assert.equal((await call('config.status')).initialized, false);
  assert.deepEqual(report.errors, [], 'Renderer errors');
  report.invariants = {businessStateUnchanged: true, jobsUnchanged: true, draftsUnchanged: true, projectFilesUnchanged: true, providers: [], configurationInitialized: false};
} catch (error) {
  report.failure = error.stack; process.exitCode = 1;
  if (shell && !shell.isClosed()) {
    report.failureDOM = await shell.evaluate(() => ({width: innerWidth, height: innerHeight, app: document.querySelector('#app')?.className, dialogs: [...document.querySelectorAll('dialog[open]')].map(n => n.id), nodes: [...document.querySelectorAll('#side,#sidebar-body,.workflow-panel,.inbox-panel,#managed-todo-filters,[data-todo-filter]')].map(n => ({id: n.id, text: n.textContent.slice(0, 80), bounds: n.getBoundingClientRect().toJSON(), display: getComputedStyle(n).display, scrollTop: n.scrollTop, scrollHeight: n.scrollHeight, clientHeight: n.clientHeight}))})).catch(() => null);
    await shell.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
  }
} finally {
  // Only our spawned product; use its normal flush/close path, never kill a process.
  if (shell && !shell.isClosed() && child?.exitCode === null && !child.signalCode) {
    try {
      await call('session.requestClose');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(15000)]);
      assert(child.exitCode !== null || child.signalCode, 'Normal product close did not complete; no kill attempted');
      report.normalClose = true;
    } catch (error) { report.closeFailure = error.stack; process.exitCode = 1; }
  }
  await browser?.disconnect();
  report.status = report.failure || report.closeFailure ? 'failed' : 'complete';
  if (out) { await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await fs.writeFile(path.join(out, 'main.log'), log); }
  await fs.rmdir(lock);
  console.log(JSON.stringify({out, status: report.status, scenes: report.scenes.length, invariants: report.invariants, failure: report.failure, closeFailure: report.closeFailure}, null, 2));
}
