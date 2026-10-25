// Serial evidence collection only; the parent runs this script, never a component/DOM fixture.
// NOZELI_DESIGN_PHASE=audit NOZELI_TEST_BINARY=/installed/nozeli node tests/desktop-ui-host-results-audit.mjs
// Optional NOZELI_HOST_RESULTS_OUT selects a NEW evidence directory. No provider is initialized.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {prepareFrozenWorkflow, git} from './desktop-frozen-workflow.fixture.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {WorkChanges, WORK_CHANGES_LIMITS} from '../src/agents/managed/work-changes.mjs';

const source = path.resolve(import.meta.dirname, '..');
const phase = process.env.NOZELI_DESIGN_PHASE || 'audit';
assert(['audit', 'before', 'after'].includes(phase), 'Unknown evidence phase');
const binary = process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
const lock = path.join(os.tmpdir(), 'nozeli-ui-design-live.lock');
await fs.mkdir(lock); // Own only this acquisition; never remove another run's lock.
let out;
const report = {
  phase, binary, source, scenes: [], completed: [], gaps: [], errors: [],
  evidence: '真实 Git 对象、真实宿主读取与文件；预置合成历史；非真实 Worker 推理。',
  captureContract: 'Host webContents and actual embedded WCV are separate images, never a composed OS window.',
  notCovered: ['Other platforms', 'OS compositor/window decorations', 'Real inference', 'Provider initialization'],
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let fixture, child, browser, shell, log = '', launchError;
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
async function call(page, op, payload = {}) {
  const result = await page.evaluate((op, payload) => window.nozeli.invoke(op, payload), op, payload);
  assert(result.ok, op + ': ' + JSON.stringify(result.error)); return result.value;
}
async function scoped(predicate) {
  return until(async () => {
    for (const page of await browser.pages()) {
      const scope = await page.evaluate(() => window.__workspaceScope).catch(() => null);
      if (scope && predicate(scope) && await page.evaluate(() => window.__nozeliReady === true)) return {page, scope};
    }
  }, 'native renderer');
}
async function windows() { return call(shell, 'workspace.windows.list', {projectId: fixture.a.id}); }
async function visibleSurface(viewId) {
  return until(async () => {
    if (await shell.$eval('#conversation-connection-error', n => n.open)) {
      report.dismissedConnectionNotices = (report.dismissedConnectionNotices || 0) + 1;
      await shell.keyboard.press('Escape');
    }
    return (await windows()).flatMap(w => w.surfaces).find(s => s.viewId === viewId && s.visible && s.bounds.width > 0 && s.bounds.height > 0);
  }, 'visible WCV ' + viewId, 12000);
}
async function frames(page) { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }
async function measure(page, selectors) {
  return page.evaluate(selectors => {
    const item = n => {
      const b = n.getBoundingClientRect(), s = getComputedStyle(n);
      return {text: n.innerText?.slice(0, 2000), bounds: b.toJSON(), visible: !!n.getClientRects().length && s.visibility !== 'hidden' && s.display !== 'none' && b.width > 0 && b.height > 0 && b.right > 0 && b.bottom > 0 && b.x < innerWidth && b.y < innerHeight,
        font: s.fontSize, lineHeight: s.lineHeight, color: s.color, background: s.backgroundColor, outline: s.outline, focusVisible: n.matches(':focus-visible'), disabled: n.disabled};
    };
    return {scope: window.__workspaceScope, viewport: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio}, theme: document.documentElement.dataset.theme,
      chromeFont: getComputedStyle(document.documentElement).getPropertyValue('--chrome-font-size'), overflow: document.documentElement.scrollWidth > innerWidth,
      nodes: Object.fromEntries(selectors.map(selector => [selector, [...document.querySelectorAll(selector)].map(item)])), active: document.activeElement && item(document.activeElement)};
  }, selectors);
}
async function capture(label, page = shell, selectors = ['#sidebar-body', '.workflow-panel', '.inbox-panel']) {
  await frames(page);
  const data = await measure(page, selectors), isHost = data.scope.role === 'shell';
  const valid = Object.values(data.nodes).flat().some(n => n.visible);
  assert(valid, label + ': no visible evidence bounds');
  const scene = {label, ...data, kind: isHost ? 'host-shell-only' : 'actual-content-WCV'};
  if (!isHost) scene.surface = await visibleSurface(data.scope.viewId);
  scene.file = label + '-' + scene.kind + '.png';
  await page.screenshot({path: path.join(out, scene.file)});
  report.scenes.push(scene); return scene;
}
async function attempt(name, run) {
  report.stage = name; console.log('AUDIT_STAGE ' + name);
  try { const details = await run(); report.completed.push({name, details}); }
  catch (error) {
    if (shell && !shell.isClosed() && await shell.$eval('#conversation-connection-error', n => n.open).catch(() => false)) await shell.keyboard.press('Escape');
    report.lastFailureWindows = await windows().catch(() => null);
    report.lastFailureOverlays = await shell.$$eval('dialog[open]', nodes => nodes.map(n => ({id: n.id, text: n.innerText}))).catch(() => []);
    report.gaps.push({name, error: error.stack});
    if (shell && !shell.isClosed()) await capture(name + '-gap', shell, ['#app']).catch(() => {});
  }
}
async function project(id) {
  const selector = '[data-project-id="' + id + '"]';
  await shell.waitForSelector(selector, {visible: true}); await shell.click(selector);
  await until(async () => (await call(shell,'workspace.bootstrap')).projectId===id,'project scope binding');
  assert.equal((await call(shell,'workspace.snapshot',{projectId:id})).layout.projectId,id);
}
async function sidebar(open) {
  const expanded=await shell.$eval('#app',n=>n.classList.contains('narrow-layout')?n.classList.contains('drawer-side-open'):!n.classList.contains('side-collapsed'));
  if(expanded!==open)await shell.$eval('#toggle-sidebar', n => n.click());
  await shell.waitForFunction(open=>{const n=document.querySelector('#app');return (n.classList.contains('narrow-layout')?n.classList.contains('drawer-side-open'):!n.classList.contains('side-collapsed'))===open;},{},open);
  await frames(shell);
}
async function appearance(theme, width, size) {
  await call(shell, 'session.resize', {width: 1440, height: 1000});
  await shell.waitForFunction(() => innerWidth === 1440);
  await shell.click('#open-settings');
  await shell.click('[data-settings-section="settings-appearance"]');
  await shell.select('[data-appearance="theme"]', theme);
  await shell.select('[data-appearance="size"]', String(size));
  await shell.click('#settings-close');
  await call(shell, 'session.resize', {width, height: 1000});
  await shell.waitForFunction(width => innerWidth === width, {}, width);
}
async function openReading() {
  if (await shell.$eval('#file-toggle', n => n.getAttribute('aria-expanded') !== 'true')) await shell.click('#file-toggle');
  await shell.waitForSelector('#file-tree [data-path="reading.txt"]', {visible: true});
  await shell.click('#file-tree [data-path="reading.txt"]');
  const doc = await scoped(s => s.kind === 'document' && s.projectId === fixture.a.id && s.relPath === 'reading.txt');
  await visibleSurface(doc.scope.viewId);
  await doc.page.waitForSelector('#text-host .cm-content', {visible: true});
  return doc;
}
async function closeSurface(viewId) {
  const pane = '.workspace-pane:has([data-view-id="' + viewId + '"])';
  await shell.waitForSelector(pane + ' [data-workspace-command="close"]', {visible: true});
  await shell.click(pane + ' [data-workspace-command="close"]');
}
async function editorState(doc, editor) {
  const state = await doc.page.evaluate(editor => ({sameEditor: editor === document.querySelector('#text-host .cm-editor'), text: window.__nozeliInput.text(), selection: window.__nozeliInput.selection(), scroll: document.querySelector('#text-host .cm-scroller').scrollTop}), editor);
  const status = await call(shell, 'managed.status', {projectId: fixture.a.id});
  return {...state, draft: status.state.drafts.frontdesk};
}

async function prepare() {
  fixture = await prepareFrozenWorkflow(out);
  const directory = '多层来源目录用于确认冻结版本不是当前文件/进一步说明候选变更与输入版本的独立来源';
  const paths = {changes: directory + '/需要逐处阅读的长中文文件名与多段候选修改.txt', same: directory + '/正文相同仅文件模式变化.txt', unreadable: directory + '/不可读取的非UTF8内容.txt', bytes: directory + '/超过正文大小预算.txt', lines: directory + '/超过正文行数预算.txt'};
  await fs.mkdir(path.join(fixture.project, directory), {recursive: true});
  const before = Array.from({length: 180}, (_, i) => '输入材料第' + i + '行：保留上下文与中文说明。').join('\n') + '\n';
  const after = before.split('\n').map((line, i) => [8, 65, 142].includes(i) ? '候选修改第' + i + '行：这一处与原始输入不同。' : line).join('\n');
  for (const [key, rel] of Object.entries(paths)) await fs.writeFile(path.join(fixture.project, rel), key === 'changes' ? before : '独立冻结输入正文\n');
  await git(fixture.project, ['add', '.']); await git(fixture.project, ['commit', '-m', 'host results audit input']);
  const inputCommit = await git(fixture.project, ['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(fixture.project, paths.changes), after);
  await fs.chmod(path.join(fixture.project, paths.same), 0o755);
  await fs.writeFile(path.join(fixture.project, paths.unreadable), Buffer.from([0xff, 0xfe, 0x61, 0x0a]));
  await fs.writeFile(path.join(fixture.project, paths.bytes), 'A'.repeat(WORK_CHANGES_LIMITS.bytes + 1));
  await fs.writeFile(path.join(fixture.project, paths.lines), '行\n'.repeat(WORK_CHANGES_LIMITS.lines + 1));
  await git(fixture.project, ['add', '.']); await git(fixture.project, ['commit', '-m', 'host results audit candidate']);
  const candidateCommit = await git(fixture.project, ['rev-parse', 'HEAD']);
  const controller = await Controller.open({storage:fixture.storage,projectId:fixture.a.id,runtimeRoot: fixture.runtimeRoot, contentRoot: fixture.project});
  let work, receipt, binding;
  try {
    work = await controller.store.submit('核对多个成果、长中文任务名称、未发送草稿以及冻结输入候选版本之间的可追溯阅读链路', '合成宿主历史，禁止重放或推理', {name: '核对长中文任务名称下的多项阅读成果与冻结版本差异并保留原文件编辑现场'});
    await controller.store.activate(work.id);
    binding = await controller.changes.capture({projectId: fixture.a.id, workId: work.id, revision: 1, jobId: 'audit-result-job', receiptId: 'audit-result-receipt', repo: fixture.project, commonDir: await fs.realpath(path.join(fixture.project, '.git')), inputCommit, candidateCommit});
    const text = '这是真实宿主持久化的本地报告对象；历史由 fixture 合成，不是模型推理。版本来源——输入：' + inputCommit + '；候选：' + candidateCommit + '。阅读结论：冻结版本不得由当前文件替代。';
    const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>长中文成果报告</title></head><body><main><h1>长中文成果报告</h1><p>' + text + '</p></main></body></html>';
    receipt = await controller.store.publish(work.id, 1, 'result', html, 'audit-result-receipt', {jobId: 'audit-result-job', changeSetId: binding.changeSetId});
    await controller.store.settle(work.id);
    await controller.store.mutate(() => {
      controller.store.find(work.id).readOnly = true; // Explicit synthetic historical identity; never resume it.
      controller.store.state.jobs.push({id: 'audit-result-job', target: work.id, revision: 1, type: 'work', status: 'completed', text: '合成历史，无推理', context: {}, completedAt: new Date().toISOString()});
      for (let i = 0; i < 3; i++) {
        const id = 'audit-failed-intake-' + i, at = new Date().toISOString();
        controller.store.state.jobs.push({id, target: 'orchestrator', type: 'intake', status: 'failed', text: '需要处理的长中文材料核对请求第' + (i + 1) + '项：保留原始文件与阅读来源并等待人工确认', context: {}, at, finishedAt: at, error: '合成历史：宿主读取材料失败，原请求与草稿保留；未自动重试。'});
        controller.store.state.todos.push({id: 'audit-system-' + i, kind: 'system', status: 'open', sourceJobId: id, text: '合成历史：材料读取失败，待人工核对；不会自动重放原请求。', createdAt: at});
      }
    });
  } finally { await controller.stop(); }
  const emptyRuntime = path.join(await fixture.storage.localDirectory(fixture.b.id),'execution');
  const empty = await Controller.open({storage:fixture.storage,projectId:fixture.b.id,runtimeRoot: emptyRuntime, contentRoot: fixture.other}); await empty.stop();
  await fixture.storage.putLocal(fixture.b.id,'managed:binding',await fixture.storage.getLocal(fixture.a.id,'managed:binding'));
  const changes = new WorkChanges({runtimeRoot:fixture.runtimeRoot,storage:fixture.storage,projectId:fixture.a.id}), files = (await changes.list({changeSetId: binding.changeSetId})).files;
  fixture.audit = {paths, before, after, workId: work.id, objectId: receipt.objectId, changeSetId: binding.changeSetId, inputCommit, candidateCommit, files};
  // Deliberately divergent live bytes: none of the frozen readers may display this sentinel.
  for (const rel of Object.values(paths)) await fs.writeFile(path.join(fixture.project, rel), 'LIVE-CURRENT-FILE-MUST-NOT-SUBSTITUTE\n');
  report.identity = {projectId: fixture.a.id, emptyProjectId: fixture.b.id, ...fixture.audit, before: undefined, after: undefined};
}

try {
  if (process.env.NOZELI_HOST_RESULTS_OUT) { out = path.resolve(process.env.NOZELI_HOST_RESULTS_OUT); await fs.mkdir(out); }
  else out = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-host-results-' + phase + '-'));
  report.out = out;
  await prepare();
  const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)) delete env[key];
  Object.assign(env, {NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: fixture.configRoot, NOZELI_USER_DATA: fixture.profile, NOZELI_TEST_PICK: fixture.project, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0', NOZELI_SHOT_DIR: out});
  child = spawn(binary, [...(process.env.NOZELI_TEST_BINARY ? [] : [path.join(source, 'src/main/main.cjs')]), '--ozone-platform=' + (process.env.NOZELI_OZONE || 'wayland')], {cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe']});
  child.on('error', error => { launchError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; });
  await until(async () => { try { browser = await puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null}); return true; } catch { return false; } }, 'isolated product debug endpoint');
  shell = (await scoped(s => s.role === 'shell')).page;
  shell.on('pageerror', error => report.errors.push(error.stack));
  if (await shell.$eval('#configuration-setup', n => n.open)) { await shell.click('#configuration-cancel'); await shell.waitForFunction(() => !document.querySelector('#configuration-setup').open); }
  await project(fixture.a.id);
  await until(async () => (await call(shell, 'managed.status', {projectId: fixture.a.id})).state?.receipts.some(r => r.objectId === fixture.audit.objectId), 'persisted host result');
  const initial = await call(shell, 'managed.status', {projectId: fixture.a.id});
  assert.equal(initial.ready, false); assert.deepEqual(Object.keys(initial.state.providers || {}), []);
  report.initialJobs = initial.state.jobs.map(j => j.id);

  for (const [label, theme, width, size] of [['wide-light-13', 'light', 1440, 13], ['wide-dark-13', 'dark', 1440, 13], ['narrow-dark-20', 'dark', 390, 20]]) {
    await attempt(label + '-empty-and-nonempty', async () => {
      await appearance(theme, width, size);
      await project(fixture.b.id); await sidebar(true);
      await shell.waitForSelector('#work-empty', {visible: true}); await shell.waitForSelector('#inbox-empty', {visible: true});
      const empty = await capture(label + '-empty-project');
      assert(empty.nodes['.workflow-panel'].some(n => n.visible) && empty.nodes['.inbox-panel'].some(n => n.visible));
      await project(fixture.a.id); await sidebar(true);
      await shell.waitForSelector('[data-managed-todo]', {visible: true});
      const nonempty = await capture(label + '-multiple-pending-and-failed', shell, ['.workflow-panel', '.inbox-panel', '[data-managed-request]', '[data-todo-row]']);
      assert(nonempty.nodes['[data-todo-row]'].length >= 3);
      await shell.click('[data-todo-filter="closed"]');
      await shell.waitForSelector('#inbox-empty', {visible: true});
      await capture(label + '-closed-filter-no-results', shell, ['#managed-todo-filters', '#inbox-empty', '.workflow-panel']);
      await shell.click('[data-todo-filter="open"]');
      // Real Tab navigation from the filter, not scripted focus on the target row.
      await shell.click('[data-todo-filter="all"]');
      await shell.keyboard.press('Tab'); await shell.keyboard.press('Tab');
      await capture(label + '-keyboard-focus', shell, ['[data-todo-row]', '#managed-todo-filters']);
      await shell.click('[data-todo-more]');
      await shell.waitForSelector('#managed-todo-menu:not([hidden])', {visible: true});
      await capture(label + '-todo-more-menu', shell, ['#managed-todo-menu:not([hidden])']);
      await shell.keyboard.press('Escape'); await shell.click('[data-todo-filter="open"]');
      return {width, theme, size, emptyProject: fixture.b.id, populatedProject: fixture.a.id};
    });
  }

  await attempt('host-result-report-return-retained-editor', async () => {
    await project(fixture.a.id); await appearance('light', 1440, 13);
    const doc = await openReading(), editor = await doc.page.$('#text-host .cm-editor');
    await doc.page.click('#text-host .cm-content');
    await doc.page.keyboard.down('Control'); await doc.page.keyboard.press('Home'); await doc.page.keyboard.up('Control');
    await doc.page.keyboard.type('UNSENT-LOCAL-EDITOR ');
    await doc.page.keyboard.down('Shift'); for (let i = 0; i < 6; i++) await doc.page.keyboard.press('ArrowLeft'); await doc.page.keyboard.up('Shift');
    const box = await doc.page.$eval('#text-host .cm-scroller', n => n.getBoundingClientRect().toJSON());
    await doc.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await doc.page.mouse.wheel({deltaY: 550});
    await until(async () => (await editorState(doc, editor)).scroll > 0, 'physical editor scrolling');
    const before = await editorState(doc, editor); assert(before.sameEditor); assert.notEqual(before.text, fixture.source);
    await capture('original-editor-before-host-result', doc.page, ['#text-host .cm-editor']);
    const pane = '.workspace-pane:has([data-view-id="' + doc.scope.viewId + '"])';
    await shell.click(pane + ' .workspace-pane-title', {button: 'right'});
    await shell.waitForSelector('#workspace-title-menu [data-command="split-x"]', {visible: true});
    await shell.click('#workspace-title-menu [data-command="split-x"]');
    const emptyGroup = await until(() => shell.$$eval('.workspace-pane', nodes => nodes.find(n => !n.querySelector('[data-view-id]'))?.dataset.workspaceGroup), 'empty report pane');
    await shell.click('[data-workspace-group="' + emptyGroup + '"] .workspace-pane-title');
    await sidebar(true);
    const reportTodo=(await call(shell,'managed.status',{projectId:fixture.a.id})).state.todos.find(t=>t.workId===fixture.audit.workId&&t.kind==='result');assert(reportTodo,'Original result todo exists');
    await shell.locator('[data-managed-todo="'+reportTodo.id+'"]').click();
    await until(async () => (await call(shell, 'workspace.snapshot', {projectId: fixture.a.id})).layout.views && (await shell.$eval('#conversation-connection-error', n => n.open) || (await windows()).some(w => w.surfaces.some(s => s.kind === 'report'))), 'report request or explicit connection notice');
    if (await shell.$eval('#conversation-connection-error', n => n.open)) await shell.keyboard.press('Escape');
    await call(shell, 'session.resize', {width: 1441, height: 1000});
    await call(shell, 'session.resize', {width: 1440, height: 1000});
    const result = await scoped(s => s.kind === 'report' && s.projectId === fixture.a.id);
    await visibleSurface(result.scope.viewId);
    await result.page.waitForFunction(() => document.querySelector('#managed-doc')?.innerText.includes('长中文成果报告'));
    await capture('host-result-opened-report-host', shell, ['.workspace-pane-header']);
    await capture('host-result-opened-report', result.page, ['#managed-doc']);
    assert((await result.page.$eval('#managed-doc', n => n.innerText)).includes(fixture.audit.inputCommit));
    await closeSurface(result.scope.viewId); await visibleSurface(doc.scope.viewId);
    const after = await editorState(doc, editor); assert.deepEqual(after, before);
    await capture('host-result-return-original-editor', doc.page, ['#text-host .cm-editor']);
    await editor.dispose(); return {before, after, reportObjectId: fixture.audit.objectId, draftEvidence: 'Persisted host frontdesk draft; no provider/visible conversation composer was started.'};
  });

  // The present native architecture exposes frozen-file buttons only in the conversation WCV.
  // Keep no-provider sampling independent: open the same production diff resource with its
  // real archived capability, and explicitly do NOT certify the timeline-entry click chain.
  report.gaps.push({name: 'conversation-frozen-file-entry-click', reason: 'No provider is initialized. Frozen files are rendered in conversation WCV, not host work/todo DOM. Diff scenes below use production workspace.command open with a real archive target, not a claimed UI entry click.'});
  for (const [key, expected] of [['changes', 'available'], ['same', 'available'], ['unreadable', 'non-utf8'], ['bytes', 'byte-budget'], ['lines', 'line-budget']]) {
    await attempt('frozen-' + key, async () => {
      await project(fixture.a.id); await appearance('dark', 1440, 13);
      const file = fixture.audit.files.find(f => f.path === fixture.audit.paths[key]); assert(file, 'Actual Git manifest file required');
      const target = {projectId: fixture.a.id, changeSetId: fixture.audit.changeSetId, fileId: file.fileId};
      const read = await call(shell, 'managed.changes.read', target);
      assert.equal(expected === 'available' ? read.availability : read.reason, expected);
      const {layout} = await call(shell, 'workspace.snapshot', {projectId: fixture.a.id});
      await call(shell, 'workspace.command', {projectId: fixture.a.id, expectedRevision: layout.revision, requestKey: crypto.randomUUID(), command: {type: 'open', view: {kind: 'diff', resourceId: crypto.randomUUID(), viewState: {target, title: file.path}}}});
      const diff = await scoped(s => s.kind === 'diff' && s.projectId === fixture.a.id);
      await visibleSurface(diff.scope.viewId);
      await diff.page.waitForSelector('.frozen-change-reader', {visible: true});
      await diff.page.waitForFunction(() => !document.querySelector('.document-diff-body')?.innerText.includes('正在读取冻结版本'));
      if (key === 'changes') {
        assert.equal(read.before.text, fixture.audit.before); assert.equal(read.after.text, fixture.audit.after);
        await diff.page.waitForSelector('.cm-mergeView', {visible: true});
        const navigation = '.diff-navigation [role="status"]';
        await diff.page.click('[aria-label="下一处差异"]');
        const next = await diff.page.$eval(navigation, n => n.textContent); assert.match(next, /1\/3/);
        await diff.page.click('[aria-label="下一处差异"]');
        const second = await diff.page.$eval(navigation, n => n.textContent); assert.match(second, /2\/3/);
        await diff.page.click('[aria-label="上一处差异"]'); assert.equal(await diff.page.$eval(navigation, n => n.textContent), next);
        for (const [label, theme, width, size] of [['wide-light-13', 'light', 1440, 13], ['wide-dark-13', 'dark', 1440, 13], ['narrow-dark-20', 'dark', 390, 20]]) {
          await appearance(theme, width, size); await visibleSurface(diff.scope.viewId);
          if (width === 390) {
            await sidebar(false);
            if (await shell.$eval('#app', n => n.classList.contains('drawer-files-open'))) await shell.$eval('#file-toggle', n => n.click());
            const groupId = await shell.$eval('.workspace-pane:has([data-view-id="' + diff.scope.viewId + '"])', n => n.dataset.workspaceGroup);
            const {layout} = await call(shell, 'workspace.snapshot', {projectId: fixture.a.id});
            if (layout.maximized.main !== groupId) await call(shell, 'workspace.command', {projectId: fixture.a.id, expectedRevision: layout.revision, requestKey: crypto.randomUUID(), command: {type: 'maximize', groupId}});
          }
          await frames(shell); await frames(diff.page);
          if (width === 390) await diff.page.waitForFunction(() => innerWidth >= 300 && innerWidth <= 400, {timeout: 5000}).catch(() => {});
          await diff.page.waitForFunction(theme => document.documentElement.dataset.theme === theme, {}, theme);
          await capture(label + '-frozen-multiple-differences-host', shell, ['.workspace-pane-header']);
          const scene = await capture(label + '-frozen-multiple-differences', diff.page, ['.document-diff-head', '.document-diff-title', '.frozen-change-versions', '.diff-navigation', '.document-diff-head button']);
          if (width === 390 && (scene.viewport.width < 300 || scene.viewport.width > 400)) report.gaps.push({name: 'narrow-diff-content-width', actual: scene.viewport.width, required: '300–400px'});
        }
      } else if (key === 'same') {
        assert.equal(read.before.text, read.after.text);
        await diff.page.waitForFunction(() => document.querySelector('.diff-navigation')?.innerText.includes('内容相同'));
        assert(await diff.page.$eval('[aria-label="下一处差异"]', n => n.disabled));
      } else {
        const body = await diff.page.$eval('.document-diff-body', n => n.innerText);
        assert(body.includes('不会读取当前文件代替')); assert(!body.includes('LIVE-CURRENT-FILE-MUST-NOT-SUBSTITUTE'));
        assert.equal(await diff.page.$('.cm-mergeView'), null);
      }
      await capture('frozen-' + key, diff.page, ['.document-diff-head', '.document-diff-body']);
      await diff.page.click('.document-diff-head header:first-child button');
      await diff.page.waitForFunction(() => !document.querySelector('.frozen-change-reader'));
      await capture('frozen-' + key + '-actual-return-reading', diff.page, ['#documents', '#reader']);
      report.gaps.push({name: 'frozen-' + key + '-return-destination', reason: '返回阅读 was physically clicked and overlay removed in its dedicated native diff WCV. This does not certify return to the original document; that separate chain is measured in the host-result scenario.'});
      await closeSurface(diff.scope.viewId);
      return {target, path: file.path, availability: read.availability, reason: read.reason, entry: 'production workspace.command real archive capability', actualReturnClicked: true};
    });
  }
  const final = await call(shell, 'managed.status', {projectId: fixture.a.id});
  assert.deepEqual(final.state.jobs.map(j => j.id), report.initialJobs, 'No added model jobs');
  assert.deepEqual(Object.keys(final.state.providers || {}), []); assert.equal(final.ready, false);
  assert.equal((await call(shell, 'config.status')).initialized, false);
  report.noModelEvidence = {providers: final.state.providers, initialized: false, jobIdsUnchanged: true};
} catch (error) {
  report.failure = error.stack; process.exitCode = 1;
} finally {
  report.status = report.failure ? 'failed' : report.gaps.length ? 'partial-evidence-with-explicit-gaps' : 'complete';
  if (report.gaps.length) process.exitCode = 1; // A partial audit must not become a green acceptance run.
  await browser?.disconnect();
  if (child?.exitCode === null && !child.signalCode) {
    child.kill('SIGTERM'); await Promise.race([new Promise(r => child.once('exit', r)), pause(5000)]);
    if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
  }
  if (out) { await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await fs.writeFile(path.join(out, 'main.log'), log); }
  await fs.rmdir(lock);
  console.log(JSON.stringify({out, status: report.status, completed: report.completed, gaps: report.gaps, failure: report.failure}, null, 2));
}
