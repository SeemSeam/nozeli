import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, symlink, writeFile, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

// Behavior coverage for the managed work directory in the git repo build: ongoing
// work precedes history, all remains available in overflow, an ended+blocked Work
// (including the error-only legacy shape) never hides and never claims completion;
// merge-constraint card submits a version-bound three-way host decision, the
// overview retains the real report and necessary decision while keeping internal
// diagnostics collapsed; interactions never spawn work or lose the input draft.
const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'work-directory-'));
const root = path.join(output, 'app');
await mkdir(root);
for (const item of ['src', 'tools', 'package.json']) await cp(path.join(source, item), path.join(root, item), { recursive: true });
for (const item of ['node_modules', 'vendor', 'assets']) await symlink(path.join(source, item), path.join(root, item), 'dir');
const panelPath = path.join(root, 'src/renderer/managed-agent-panel.mjs');
let panel = await readFile(panelPath, 'utf8');
const callAnchor = " const call=async(op,p={},id=projectId)=>{";
assert.ok(panel.includes(callAnchor), 'call anchor');
panel = panel.replace(callAnchor, ` const call=async(op,p={},id=projectId)=>{window.__uiCalls??=[];window.__uiCalls.push({op,p});if(op==='versions.list')return {checkpoints:[],pending:[]};if(op==='status')return {state:window.__dirState,ready:window.__dirReady!==false};if(op==='terminal.screen')return {available:false,reason:'尚未就绪'};if(op==='terminal.attach')return {terminalId:'stub-terminal-'+p.target,ownerId:'stub-owner'};if(op==='artifact.list')return {files:[{relPath:'README.md'}]};if(op==='disposition')return {binding:{revision:3,objectId:'obj-readme'},retryClosure:{allowed:true},accept:{allowed:true},discard:{allowed:true}};if(op==='merge.constraint'){window.__constraintReceipts??=[];const receipt={workId:p.workId,status:p.decision,version:9};window.__constraintReceipts.push(receipt);const s=window.__dirState;const t=s.todos.find(x=>x.id===p.todoId||x.kind==='merge-constraint'&&x.workId===p.workId);if(t&&p.decision!=='hold'){t.status='resolved';t.resolution={status:p.decision,version:9,at:new Date().toISOString()};}return receipt;}if(op==='retry')return {accepted:true};`);
const previewAnchor = ' return {get active()';
assert.ok(panel.includes(previewAnchor), 'preview anchor');
panel = panel.replace(previewAnchor, ` window.__dirTest=(s,r=true)=>{projectId='dir-project';state=s;window.__dirState=s;ready=r!==false;show(true);render();}; return {get active()`);
await writeFile(panelPath, panel);
const agentPanelPath = path.join(root, 'src/renderer/agent-panel.mjs');
await writeFile(agentPanelPath, (await readFile(agentPanelPath, 'utf8')).replace('async function loadProjectSettings(id, gen) {', 'async function loadProjectSettings(id, gen) { return;'));
const build = spawn(process.execPath, [path.join(root, 'tools/build-renderer.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let buildLog = '';
build.stdout.on('data', chunk => { buildLog += chunk; });
build.stderr.on('data', chunk => { buildLog += chunk; });
assert.equal(await new Promise(resolve => build.once('exit', resolve)), 0, buildLog);
const project = path.join(output, 'project');
await mkdir(project);
await writeFile(path.join(project, 'sample.md'), '# Reading\n\nA real project document.\n');
const port = await new Promise((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const require = createRequire(import.meta.url);
const ozone = process.env.NOZELI_OZONE || 'headless';
const child = spawn(require('electron'), ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise(resolve => child.once('exit', resolve));
let log = '', browser, page;
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
const report = { checks: [], errors: [] };
const check = name => { report.checks.push(name); console.log(JSON.stringify({ check: name })); };
const selectAll=async()=>{await page.$eval('#managed-work-category-more',node=>node.click());await page.waitForFunction(()=>!document.querySelector('#managed-work-filter-menu').hidden);await page.$eval('#managed-work-filter-menu [data-command="filter-all"]',node=>node.click());};
try {
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) throw new Error(log);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Startup timeout: ' + log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 30000 });
  page = (await browser.pages()).find(item => item.url().includes('127.0.0.1'));
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.__nozeliReady, { timeout: 90000, polling: 250 });
  await page.$eval('#pick-project', node => node.click());
  await page.waitForFunction(() => document.querySelector('#project-name').textContent === 'project', { timeout: 60000, polling: 250 });
  if (await page.$eval('#toggle-sidebar', node => node.getAttribute('aria-expanded') !== 'true')) await page.$eval('#toggle-sidebar', node => node.click());
  const now = '2026-10-28T10:00:00.000Z';
  const state = {
    works: [
      { id: 'w-queued', name: '排队工作', request: '排队任务目标', status: 'queued', revision: 0 },
      { id: 'w-running', name: '执行工作', request: '执行任务目标', status: 'running', revision: 1 },
      { id: 'w-paused', name: '图标工作', request: '图标任务目标', status: 'paused', revision: 1 },
      { id: 'w-review', name: '审查工作', request: '审查任务目标', status: 'review', revision: 2, result: { objectId: 'obj-review', revision: 2 } },
      { id: 'w-closing', name: '结束中工作', request: '结束中任务目标', status: 'closing', revision: 1 },
      { id: 'w-readme', name: 'README 工作', request: 'README 任务目标', status: 'closing', outcome: 'accept', revision: 3, result: { objectId: 'obj-readme', revision: 3 }, closure: { phase: 'blocked', error: '此工作明确要求不提交Git；请先明确更新这一约束，再选择接受' } },
      { id: 'w-strategy', name: '策略工作', request: '策略任务目标', status: 'closing', outcome: 'accept', revision: 2, result: { objectId: 'obj-strategy', revision: 2 }, closure: { phase: 'blocked', error: 'Legacy merge strategy required' } },
      { id: 'w-done', name: '完成工作', request: '完成任务目标', status: 'ended', outcome: 'discard', revision: 1, endedAt: now, closure: { phase: 'complete', decision: 'discard', completedAt: now } },
    ],
    jobs: [], messages: [], frontdeskRoutes: [],
    todos: [{ id: 'todo-strategy', workId: 'w-strategy', kind: 'merge-constraint', status: 'open', revision: 2, constraintVersion: 7, text: '宿主识别历史约束：此工作明确要求不提交Git；请选择合并策略。' }],
    receipts: [
      { id: 'rc-review', objectId: 'obj-review', workId: 'w-review', kind: 'result', revision: 2, at: now, text: '审查报告正文，含候选文件。', report: { format: 'markdown' }, snapshot: { candidate: { commit: 'c0ffee123456' }, files: [{ relPath: 'sample.md' }] } },
      { id: 'rc-readme', objectId: 'obj-readme', workId: 'w-readme', kind: 'result', revision: 3, at: now, text: 'README 报告正文，候选保留。', report: { format: 'markdown' }, snapshot: { candidate: { commit: 'abc123def456' }, files: [{ relPath: 'README.md' }] } },
      { id: 'rc-strategy', objectId: 'obj-strategy', workId: 'w-strategy', kind: 'result', revision: 2, at: now, text: '策略工作报告。', report: { format: 'markdown' }, snapshot: { candidate: { commit: 'fff000111222' }, files: [] } },
    ],
    drafts: {}, agents: [], busyTargets: ['frontdesk', 'orchestrator'], nativeDraftTargets: [], externalTerminalTargets: [], providers: {}, quotaUsed: 4, limit: 8, artifacts: [],
    bindings: { frontdesk: { model: 'gpt-6.1-sol', effort: 'low' }, orchestrator: { model: 'gpt-6.1-sol', effort: 'high' } }, contentRoot: project,
  };
  await page.evaluate(dirState => {
    window.__dirState = dirState;
    window.__dirTest(dirState);
    window.__wgOpens = [];
    const original = window.__workspaceGroups?.open;
    if (original) window.__workspaceGroups.open = view => { window.__wgOpens.push(view); return Promise.resolve(); };
    window.__confirms = 0; window.confirm = () => { window.__confirms += 1; return true; };
    window.__errs = []; window.addEventListener('error', event => window.__errs.push(String(event.message))); window.addEventListener('unhandledrejection', event => window.__errs.push('rej:' + String(event.reason?.message || event.reason)));
    const realInvoke = window.nozeli.invoke;
    window.nozeli.invoke = (op, payload) => {
      if (op === 'managed.history.read') return Promise.resolve({ ok: true, value: { projectId: 'dir-project', objectId: payload.objectId, version: 'a'.repeat(64), mode: 'offline', report: { format: 'markdown' }, body: (payload?.objectId || '') + ' 原报告正文（冻结候选保留）。' } });
      return realInvoke(op, payload);
    };
  }, state);

  await page.$eval('[data-managed-category="ended"]',node=>node.click());
  const endedRows=await page.$$eval('#work-items [data-managed-work]',nodes=>nodes.map(node=>node.dataset.managedWork).sort());
  assert.deepEqual(endedRows,['w-done']);
  await page.$eval('#managed-work-category-more',node=>node.click());
  await page.waitForFunction(()=>!document.querySelector('#managed-work-filter-menu').hidden);
  await page.$eval('#managed-work-filter-menu [data-command="filter-closing"]',node=>node.click());
  const unfinishedRows=await page.$$eval('#work-items [data-managed-work]',nodes=>nodes.map(node=>node.dataset.managedWork).sort());
  assert.deepEqual(unfinishedRows,['w-closing','w-readme','w-strategy']);
  await selectAll();
  await page.$eval('[data-managed-category="active"]',node=>node.click());
  const ongoingRows=await page.$$eval('#work-items [data-managed-work]',nodes=>nodes.map(node=>node.dataset.managedWork).sort());
  assert.deepEqual(ongoingRows,['w-closing','w-paused','w-queued','w-readme','w-review','w-running','w-strategy']);
  await selectAll();
  const allOrder=await page.$$eval('#work-items [data-managed-work]',nodes=>nodes.map(node=>node.dataset.managedWork));
  assert.equal(allOrder.at(-1),'w-done','completed history follows ongoing and unfinished closure work');
  check('directory category navigation retains finished and blocked work without counting them as active tasks');

  await page.evaluate(() => { const composer = document.querySelector('#composer'); composer.value = '草稿保留检查'; });
  await page.$eval('[data-managed-work="w-readme"]',node=>node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
  await page.waitForFunction(()=>!document.querySelector('#managed-work-menu').hidden);
  await page.$eval('#managed-work-menu [data-command="details"]',node=>node.click());
  await page.waitForFunction(() => document.querySelector('#managed-agent-details')?.open === true, { timeout: 20000, polling: 250 });
  assert.equal(await page.$eval('#managed-current-work [data-managed-work-report]',node=>node.dataset.managedWorkReport),'w-readme');
  assert.equal(await page.$eval('#managed-current-work',node=>node.textContent.includes(window.__dirState.works.find(work=>work.id==='w-readme').closure.error)),false,'technical faults must not become user recovery instructions');
  assert.equal(await page.$eval('[data-work-overview-technical]',node=>node.open),false);
  assert.equal(await page.$eval('[data-work-overview-technical] [data-managed-work-lifecycle]',node=>node.checkVisibility()),false,'detailed host errors remain hidden until explicitly requested');
  assert.equal(await page.$$eval('#managed-current-work [data-managed-work-closure-retry]', nodes => nodes.length), 0);
  assert.equal(await page.$eval('#composer', node => node.value), '草稿保留检查');
  assert.equal(await page.$eval('#composer', node => node.disabled), false);
  assert.equal(await page.$eval('#conversation-panel', node => node.dataset.managedConversation), 'frontdesk');
  check('blocked closure retains report, draft and target without offering technical recovery');
  await page.screenshot({path:path.join(output,'overview-with-report.png')});


  await page.$eval('#managed-current-work [data-managed-work-report]', node => node.click());
  await page.waitForFunction(()=>!document.querySelector('#managed-agent-details').open);
  check('the report action exits the overview without changing the composer target');

  await page.evaluate(() => document.querySelector('#managed-agent-details').close());
  // localOnly metadata mode: natives are not ready, yet the host-authored
  // strategy decision must stay submittable (only the host CAS gates it).
  await page.evaluate(() => { window.__dirReady = false; window.__dirTest(window.__dirState, false); });
  await page.$eval('[data-managed-work="w-strategy"]',node=>node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
  await page.waitForFunction(()=>!document.querySelector('#managed-work-menu').hidden);
  await page.$eval('#managed-work-menu [data-command="details"]',node=>node.click());
  await page.waitForFunction(() => document.querySelector('#managed-agent-details')?.open === true, { timeout: 20000, polling: 250 });
  const choices = await page.$$eval('#managed-current-work [data-merge-choice]', nodes => nodes.map(node => [node.dataset.mergeChoice, node.disabled, node.getAttribute('aria-pressed')]));
  assert.deepEqual(choices.map(entry => entry[0]), ['never-commit', 'hold', 'none']);
  assert.ok(choices.every(entry => entry[1] === false && entry[2] === null));
  assert.equal(await page.$$eval('#managed-current-work [data-managed-work-closure-retry]', nodes => nodes.length), 0);
  check('strategy card stays fully usable while natives are not ready, with no default or technical retry');
  await page.$eval('#managed-current-work [data-merge-choice="hold"]', node => node.click());
  assert.equal(await page.evaluate(() => window.__confirms), 0);
  await page.waitForFunction(() => ![...document.querySelectorAll('#managed-current-work [data-merge-choice]')].some(node => node.disabled), { timeout: 20000, polling: 250 });
  assert.equal(await page.$$eval('#managed-current-work [data-merge-constraint-gate] [role=alert]', nodes => nodes.length), 0);
  check('a locally recorded strategy choice restores usable controls without an error surface');
  await page.$eval('#managed-current-work [data-merge-choice="never-commit"]', node => node.click());
  assert.equal(await page.evaluate(() => window.__confirms), 1);
  check('never-commit requires exactly one explicit confirmation');
  await page.waitForFunction(() => !document.querySelector('#managed-current-work [data-merge-constraint-gate]'), { timeout: 20000, polling: 250 });
  assert.equal(await page.$$eval('#managed-current-work [data-merge-constraint-gate] [role=alert]', nodes => nodes.length), 0);
  await page.evaluate(() => { window.__dirReady = true; window.__dirTest(window.__dirState, true); });
  await page.evaluate(() => { const dialog = document.querySelector('#managed-agent-details'); if (dialog?.open) dialog.close(); delete document.querySelector('#managed-current-work')?.dataset.signature; });
  await page.$eval('[data-managed-work="w-strategy"]',node=>node.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
  await page.waitForFunction(()=>!document.querySelector('#managed-work-menu').hidden);
  await page.$eval('#managed-work-menu [data-command="details"]',node=>node.click());
  await page.waitForFunction(() => document.querySelector('#managed-agent-details')?.open === true);
  assert.equal(await page.$$eval('#managed-current-work [data-managed-work-closure-retry]',nodes=>nodes.length),0);
  assert.equal(await page.$$eval('#managed-work-menu [data-command="retry"]',nodes=>nodes.length),0);
  assert.equal(await page.evaluate(()=>window.__uiCalls.some(call=>['retry','git.locks.inspect','git.locks.quarantine'].includes(call.op))),false);
  check('resolved strategy remains system-owned with no recovery action or dispatch');

  await page.evaluate(() => document.querySelector('#managed-agent-details').close());
  await page.$eval('[data-managed-work="w-review"]', node => node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await page.waitForFunction(() => !document.querySelector('#managed-work-menu').hidden, { timeout: 20000, polling: 250 });
  await page.$eval('#managed-work-menu [data-command="details"]',node=>node.click());
  await page.waitForFunction(() => document.querySelector('#managed-agent-details')?.open === true, { timeout: 20000, polling: 250 });
  assert.equal(await page.$$eval('#managed-current-work [data-work-control-details]',nodes=>nodes.length),1,'real Work retains pause/stop/resume entry');
  assert.equal(await page.$$eval('#managed-current-work [data-managed-work-end]',nodes=>nodes.length),1,'real Work retains explicit business cancellation');
  assert.equal(await page.$eval('[data-managed-work-report]',node=>node.dataset.managedWorkReport),'w-review');
  assert.equal(await page.$eval('#composer', node => node.value), '草稿保留检查');
  await page.evaluate(() => document.querySelector('#managed-agent-details').close());
  check('review detail carries the explicit candidate-review entry without touching the composer draft');

  await page.$eval('[data-managed-work="w-readme"]', node => node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await page.waitForFunction(() => !document.querySelector('#managed-work-menu').hidden, { timeout: 20000, polling: 250 });
  assert.equal(await page.$eval('#managed-work-menu [data-command="report"]',node=>node.disabled),false);
  assert.equal(await page.$$eval('#managed-work-menu [data-command="retry"]',nodes=>nodes.length),0);
  await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await page.waitForFunction(() => document.querySelector('#managed-work-menu').hidden, { timeout: 20000, polling: 250 });
  await page.$eval('[data-managed-work="w-strategy"] .managed-work-open', node => { node.focus(); node.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
  await page.waitForFunction(() => !document.querySelector('#managed-work-menu').hidden, { timeout: 20000, polling: 250 });
  assert.equal(await page.$$eval('#managed-work-menu [data-command="retry"]',nodes=>nodes.length),0);
  await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  check('row context menu and keyboard menu retain candidate access without technical retry entries');

  const spawnOps = await page.evaluate(() => window.__uiCalls.filter(call => ['send', 'task', 'connect', 'restart', 'enable', 'end', 'retry', 'git.locks.inspect', 'git.locks.quarantine', 'intake.retry', 'git.retry', 'recovery.resolve', 'worker.handoff', 'resident.handoff', 'todo.manage'].includes(call.op)).map(call => call.op));
  assert.deepEqual(spawnOps, []);
  assert.equal(await page.evaluate(() => document.querySelector('#composer').value), '草稿保留检查');
  assert.deepEqual(report.errors, []);
  check('interactions stay projection-only: no spawn, replay, todo mutation or draft loss');

  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'work-directory' }));
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, fixture: true, ozone }, null, 2));
  console.log(`managed work directory Electron ${report.checks.length} checks passed; ${output}`);
} catch (error) {
  report.errors.push(error.message);
  console.error(error.stack);
  try { const diag = await Promise.race([page.evaluate(() => ({ body: document.body.innerText.slice(0, 200), dialogs: [...document.querySelectorAll('dialog[open]')].map(d => d.id), errs: window.__errs || [], agentDetails: Boolean(document.querySelector('#managed-agent-details')) })), new Promise(resolve => setTimeout(resolve, 2000))]); if (diag) console.error('DIAG ' + JSON.stringify(diag).slice(0, 3000)); } catch {}
  try { await Promise.race([page.screenshot({ path: path.join(output, 'failure.png') }), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {}
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, fixture: true, ozone, failed: true }, null, 2)).catch(() => {});
  throw error;
} finally {
  // Bounded teardown: persist evidence first, never await a wedged browser or
  // an unclosable Electron process indefinitely.
  await writeFile(path.join(output, 'electron.log'), log).catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, fixture: true, ozone, failed: report.errors.length > 0 }, null, 2)).catch(() => {});
  await Promise.race([browser?.disconnect().catch(() => {}), new Promise(resolve => setTimeout(resolve, 4000))]);
  if (child.exitCode === null && child.signalCode === null) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (child.exitCode === null && child.signalCode === null) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
}
