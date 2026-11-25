import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

// Behavior coverage for the host-crash (HOST_LEASE_RECOVERY_REQUIRED) recovery UI in
// the managed panel: rendering alone never prepares; prepare is an explicit button
// whose DTO stays in UI state until refresh; confirm passes the exact prepare-issued
// token/lease/revision (never the resident schema handoff token); both actions are
// single-flight and never spawn/restart/replay work or discard composer input.
const source = path.resolve(import.meta.dirname, '..');
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-cold-recovery-ui-'));
const root = path.join(output, 'app');
await fs.mkdir(root);
for (const item of ['src', 'tools', 'package.json']) await fs.cp(path.join(source, item), path.join(root, item), { recursive: true });
for (const item of ['node_modules', 'vendor', 'assets', 'native', 'runtime']) await fs.symlink(path.join(source, item), path.join(root, item), process.platform === 'win32' ? 'junction' : 'dir');
const panelPath = path.join(root, 'src/renderer/managed-agent-panel.mjs');
let panel = await fs.readFile(panelPath, 'utf8');
const callAnchor = ' const call=async(op,p={},id=projectId)=>{';
assert.ok(panel.includes(callAnchor), 'call anchor');
panel = panel.replace(callAnchor, ` const call=async(op,p={},id=projectId)=>{window.__uiCalls??=[];window.__uiCalls.push({op,p:{...p},id});if(op==='status')return {state:window.__coldState,ready:true,enabled:true};if(op==='recovery.prepare')return (window.__coldPrepare||(()=>({available:true,token:'tok-1',hostLeaseId:'lease-1',hostRevision:7,automaticReplay:false})))();if(op==='recovery.confirm')return (window.__coldConfirm||(()=>({ready:true})))();if(op==='versions.list')return {checkpoints:[],pending:[]};if(op==='terminal.screen')return {available:false,reason:'尚未就绪'};`);
const previewAnchor = ' return {get active()';
assert.ok(panel.includes(previewAnchor), 'preview anchor');
panel = panel.replace(previewAnchor, ` window.__coldTest=(status,id='cold-project')=>{projectId=id;state=window.__coldState;ready=false;show(true);renderResidentRecovery(status);}; return {get active()`);
await fs.writeFile(panelPath, panel);
const agentPanelPath = path.join(root, 'src/renderer/agent-panel.mjs');
await fs.writeFile(agentPanelPath, (await fs.readFile(agentPanelPath, 'utf8')).replace('async function loadProjectSettings(id, gen) {', 'async function loadProjectSettings(id, gen) { return;'));
const build = spawn(process.execPath, [path.join(root, 'tools/build-renderer.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let buildLog = '';
build.stdout.on('data', chunk => { buildLog += chunk; });
build.stderr.on('data', chunk => { buildLog += chunk; });
assert.equal(await new Promise(resolve => build.once('exit', resolve)), 0, buildLog);
const project = path.join(output, 'project');
await fs.mkdir(project);
await fs.writeFile(path.join(project, 'sample.md'), '# Reading\n\nA real project document.\n');
const port = await new Promise((resolve) => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const require = createRequire(import.meta.url);
const windows = process.platform === 'win32';
const ozone = windows ? 'windows-native' : (process.env.NOZELI_OZONE || 'headless');
const config = path.join(output, 'config'), profile = path.join(config, 'desktop');
const child = spawn(require('electron'), windows ? [path.join(root, 'src/main/main.cjs')] : ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: config, NOZELI_USER_DATA: profile, NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise(resolve => child.once('exit', resolve));
let log = '', browser, page;
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
const report = { checks: [], errors: [] };
const check = name => { report.checks.push(name); console.log(JSON.stringify({ check: name })); };
const crashStatus = { connectionError: { code: 'HOST_LEASE_RECOVERY_REQUIRED', message: '原宿主租约仍由异常退出进程持有' } };
try {
  const deadline = Date.now() + 60000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) throw new Error(log);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Startup timeout: ' + log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, protocolTimeout: 30000 });
  const shellDeadline=Date.now()+60000;
  while(!page&&Date.now()<shellDeadline){page=(await browser.pages()).find(item=>item.url().includes('127.0.0.1'));if(!page)await new Promise(resolve=>setTimeout(resolve,100));}
  assert.ok(page,'production shell target must become available');
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.__nozeliReady, { timeout: 90000, polling: 250 });
  await page.$eval('#pick-project', node => node.click());
  await page.waitForFunction(() => document.querySelector('#project-name').textContent === 'project', { timeout: 60000, polling: 250 });
  if (await page.$eval('#toggle-sidebar', node => node.getAttribute('aria-expanded') !== 'true')) await page.$eval('#toggle-sidebar', node => node.click());
  await page.evaluate(coldState => {
    window.__coldState = coldState;
    window.__uiCalls = [];
    window.__confirms = []; window.confirm = text => { window.__confirms.push(String(text)); return true; };
    window.__errs = []; window.addEventListener('error', event => window.__errs.push(String(event.message))); window.addEventListener('unhandledrejection', event => window.__errs.push('rej:' + String(event.reason?.message || event.reason)));
  }, { works: [], jobs: [], requests: [], todos: [], receipts: [], agents: [], drafts: {}, timeline: { version: 1, entries: [], deltas: [] }, busyTargets: [], nativeDraftTargets: [], externalTerminalTargets: [], providers: {}, quotaUsed: 0, limit: 8, artifacts: [], frontdeskRoutes: [], bindings: {} });

  // A. Render alone never prepares; warnings retain materials semantics.
  await page.evaluate(status => window.__coldTest(status), crashStatus);
  const coldText = await page.$eval('#managed-resident-recovery', node => node.textContent);
  assert.ok(coldText.includes('原宿主异常退出'), 'crash headline');
  assert.ok(coldText.includes('不重发草稿、不重放旧任务'), 'no-resend/no-replay warning');
  assert.ok(coldText.includes('可能仍未知'), 'unknown-effects warning');
  assert.ok(coldText.includes('可能被拒绝'), 'refusal warning');
  assert.ok(await page.$('[data-cold-recovery-prepare]'), 'prepare button present');
  assert.equal(await page.$('[data-cold-recovery-confirm]'), null, 'no confirm before prepare');
  assert.equal(await page.evaluate(() => window.__uiCalls.filter(call => call.op === 'recovery.prepare' || call.op === 'recovery.confirm').length), 0, 'render issues no recovery.prepare');
  check('crash status renders explicit prepare only, with retention warnings; no auto prepare');

  // B. Prepare is single-flight while in flight.
  await page.evaluate(() => { window.__coldPrepare = () => new Promise(resolve => { window.__releasePrepare = resolve; }); });
  await page.$eval('[data-cold-recovery-prepare]', node => node.click());
  await page.waitForFunction(() => document.querySelector('[data-cold-recovery-prepare]')?.disabled === true);
  await page.$eval('[data-cold-recovery-prepare]', node => node.click());
  assert.equal(await page.evaluate(() => window.__uiCalls.filter(call => call.op === 'recovery.prepare').length), 1, 'one prepare call');
  await page.evaluate(() => window.__releasePrepare({ available: true, token: 'tok-1', hostLeaseId: 'lease-1', hostRevision: 7, automaticReplay: false }));
  await page.waitForFunction(() => Boolean(document.querySelector('[data-cold-recovery-confirm="lease-1"]')));
  assert.equal(await page.evaluate(() => window.__uiCalls.find(call => call.op === 'recovery.prepare').id), 'cold-project', 'prepare bound to current project');
  assert.ok((await page.$eval('#managed-resident-recovery', node => node.textContent)).includes('lease-1'), 'lease identity displayed');
  await page.$eval('#managed-agent-details',node=>{if(!node.open)node.showModal();});
  await page.screenshot({path:path.join(output,'cold-recovery-confirmation.png')});
  await page.$eval('#managed-agent-details',node=>node.close());
  check('prepare is single-flight, project-bound, and its DTO survives in UI state');

  // B2. Denying the confirm dialog never sends recovery.confirm; the token stays usable.
  await page.$eval('#composer', node => { node.value = '拒绝确认时草稿不丢失'; });
  await page.evaluate(() => { window.confirm = text => { window.__confirms.push(String(text)); return false; }; });
  await page.$eval('[data-cold-recovery-confirm="lease-1"]', node => node.click());
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await page.evaluate(() => window.__uiCalls.filter(call => call.op === 'recovery.confirm').length), 0, 'denied dialog sends no recovery.confirm');
  assert.equal(await page.evaluate(() => window.__uiCalls.filter(call => call.op === 'recovery.prepare').length), 1, 'denied dialog triggers no auto prepare');
  assert.equal(await page.$eval('[data-cold-recovery-confirm="lease-1"]', node => node.disabled), false, 'same-token confirm remains enabled after denial');
  assert.equal(await page.$eval('#composer', node => node.value), '拒绝确认时草稿不丢失', 'denied confirm leaves composer draft untouched');
  assert.equal((await page.evaluate(() => window.__confirms)).length, 1, 'one confirmation dialog was shown');
  await page.evaluate(() => { window.__confirms = []; window.confirm = text => { window.__confirms.push(String(text)); return true; }; });
  check('denying the confirm dialog is a no-op: no confirm sent, token re-usable, draft intact');

  // C. Composer and materials survive prepare; nothing spawns.
  await page.$eval('#composer', node => { node.value = '未发送草稿保留检查'; });
  await page.evaluate(status => window.__coldTest(status), crashStatus);
  await page.waitForFunction(() => Boolean(document.querySelector('[data-cold-recovery-confirm="lease-1"]')));
  assert.equal(await page.$eval('#composer', node => node.value), '未发送草稿保留检查', 'draft retained across re-render');
  check('composer draft retained across re-render of the crash section');

  // D. Confirm passes exactly the prepare-issued DTO (never a schema handoff token).
  await page.evaluate(status => window.__coldTest({ ...status, handoff: { role: 'frontdesk', token: 'schema-token', oldThreadId: 'thread-1', expectedToolsDigest: 'a', newToolsDigest: 'b' } }), crashStatus);
  await page.waitForFunction(() => Boolean(document.querySelector('[data-cold-recovery-confirm="lease-1"]')));
  await page.$eval('[data-cold-recovery-confirm="lease-1"]', node => node.click());
  await page.waitForFunction(() => window.__uiCalls.some(call => call.op === 'recovery.confirm'));
  const confirmCall = await page.evaluate(() => window.__uiCalls.find(call => call.op === 'recovery.confirm'));
  assert.deepEqual(confirmCall, { op: 'recovery.confirm', p: { token: 'tok-1', hostLeaseId: 'lease-1', hostRevision: 7 }, id: 'cold-project' }, 'confirm payload is the prepare-issued DTO');
  assert.equal((await page.evaluate(() => window.__confirms)).filter(text => text.includes('lease-1')).length, 1, 'confirm dialog cites lease and revision');
  await page.waitForFunction(() => !document.querySelector('[data-cold-recovery-confirm]'));
  check('confirm sends exact prepare DTO, not the resident schema handoff token');

  // E. A status-issued coldRecovery DTO is adopted without prepare; schema handoff stays separate.
  await page.evaluate(status => window.__coldTest({ ...status, coldRecovery: { available: true, token: 'tok-2', hostLeaseId: 'lease-2', hostRevision: 9, automaticReplay: false } }), crashStatus);
  await page.waitForFunction(() => Boolean(document.querySelector('[data-cold-recovery-confirm="lease-2"]')));
  assert.equal(await page.evaluate(() => window.__uiCalls.filter(call => call.op === 'recovery.prepare').length), 1, 'status DTO needs no prepare call');
  await page.evaluate(() => { window.__coldConfirm = () => new Promise(resolve => { window.__releaseConfirm = resolve; }); });
  await page.$eval('[data-cold-recovery-confirm="lease-2"]', node => node.click());
  await page.waitForFunction(() => document.querySelector('[data-cold-recovery-confirm="lease-2"]')?.disabled === true);
  await page.$eval('[data-cold-recovery-confirm="lease-2"]', node => node.click());
  assert.equal(await page.evaluate(() => window.__uiCalls.filter(call => call.op === 'recovery.confirm').length), 2, 'one additional confirm call');
  await page.evaluate(() => window.__releaseConfirm({ ready: true }));
  await page.waitForFunction(() => !document.querySelector('[data-cold-recovery-confirm]'));
  const confirm2 = await page.evaluate(() => window.__uiCalls.filter(call => call.op === 'recovery.confirm')[1]);
  assert.deepEqual(confirm2.p, { token: 'tok-2', hostLeaseId: 'lease-2', hostRevision: 9 }, 'status DTO confirm binding');
  check('status-issued coldRecovery DTO is adopted directly; confirm remains single-flight');

  // F. Incomplete prepare DTO never arms confirm.
  await page.evaluate(() => { window.__coldPrepare = () => ({ available: true, hostLeaseId: 'lease-3', hostRevision: 3, automaticReplay: false }); });
  await page.evaluate(status => window.__coldTest({ ...status, coldRecovery: undefined }), crashStatus);
  await page.$eval('[data-cold-recovery-prepare]', node => node.click());
  await page.waitForFunction(() => window.__uiCalls.filter(call => call.op === 'recovery.prepare').length === 2);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await page.$('[data-cold-recovery-confirm]'), null, 'incomplete DTO does not arm confirm');
  check('incomplete prepare DTO refuses to arm confirm');

  // H. A prepare that lands after the user switched projects is discarded, never armed.
  await page.evaluate(() => { window.__coldPrepare = () => new Promise(resolve => { window.__releaseStalePrepare = resolve; }); });
  await page.evaluate(status => window.__coldTest(status, 'cold-project'), crashStatus);
  await page.$eval('[data-cold-recovery-prepare]', node => node.click());
  await page.waitForFunction(() => document.querySelector('[data-cold-recovery-prepare]')?.disabled === true);
  await page.evaluate(status => window.__coldTest(status, 'another-project'), crashStatus);
  await page.waitForFunction(() => document.querySelector('[data-cold-recovery-prepare]') && !document.querySelector('[data-cold-recovery-prepare]').disabled);
  await page.evaluate(() => window.__releaseStalePrepare({ available: true, token: 'tok-stale', hostLeaseId: 'lease-stale', hostRevision: 11, automaticReplay: false }));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(await page.$('[data-cold-recovery-confirm]'), null, 'stale project result never arms confirm');
  assert.ok(await page.$('[data-cold-recovery-prepare]'), 'new project renders its own prepare');
  check('prepare result from a switched-away project is discarded, not adopted');

  // I. Failed prepare re-enables; failed confirm discards the one-shot DTO (fresh prepare only).
  await page.evaluate(() => { window.__coldPrepare = () => Promise.reject(Object.assign(new Error('宿主暂不可核对'), { code: 'BUSY' })); });
  await page.evaluate(status => window.__coldTest(status, 'cold-project'), crashStatus);
  await page.$eval('[data-cold-recovery-prepare]', node => node.click());
  await page.waitForFunction(() => document.querySelector('[data-cold-recovery-prepare]') && !document.querySelector('[data-cold-recovery-prepare]').disabled, { polling: 50 });
  await page.evaluate(() => { window.__coldPrepare = () => ({ available: true, token: 'tok-3', hostLeaseId: 'lease-3', hostRevision: 5, automaticReplay: false }); });
  await page.$eval('[data-cold-recovery-prepare]', node => node.click());
  await page.waitForFunction(() => Boolean(document.querySelector('[data-cold-recovery-confirm="lease-3"]')));
  await page.evaluate(() => { window.__coldConfirm = () => Promise.reject(Object.assign(new Error('结果未知'), { code: 'UNKNOWN' })); });
  await page.$eval('[data-cold-recovery-confirm="lease-3"]', node => node.click());
  await page.waitForFunction(() => Boolean(document.querySelector('[data-cold-recovery-prepare]')) && !document.querySelector('[data-cold-recovery-confirm]'), { polling: 50 });
  const confirmAttempts = await page.evaluate(() => window.__uiCalls.filter(call => call.op === 'recovery.confirm' && call.p.token === 'tok-3').length);
  await page.evaluate(() => { window.__coldPrepare = () => ({ available: true, token: 'tok-4', hostLeaseId: 'lease-4', hostRevision: 6, automaticReplay: false }); window.__coldConfirm = () => ({ ready: true }); });
  await page.$eval('[data-cold-recovery-prepare]', node => node.click());
  await page.waitForFunction(() => Boolean(document.querySelector('[data-cold-recovery-confirm="lease-4"]')));
  await page.$eval('[data-cold-recovery-confirm="lease-4"]', node => node.click());
  await page.waitForFunction(() => !document.querySelector('[data-cold-recovery-confirm]'));
  const confirmCalls = await page.evaluate(() => window.__uiCalls.filter(call => call.op === 'recovery.confirm').map(call => call.p.token));
  assert.equal(confirmAttempts, 1, 'UNKNOWN confirm never re-offers the used token');
  assert.deepEqual(confirmCalls, ['tok-1', 'tok-2', 'tok-3', 'tok-4'], 'each confirm uses a freshly prepared token');
  check('failed prepare re-enables; UNKNOWN confirm discards the DTO so only a fresh prepare continues');

  // G. Other connection errors render no cold controls.
  await page.evaluate(() => window.__coldTest({ connectionError: { code: 'OTHER', message: '普通失败' } }));
  assert.equal(await page.$('[data-cold-recovery-prepare]'), null, 'no prepare for other codes');
  assert.equal(await page.$('[data-cold-recovery-confirm]'), null, 'no confirm for other codes');

  const spawnOps = await page.evaluate(() => window.__uiCalls.filter(call => ['send', 'task', 'connect', 'restart', 'enable', 'end', 'retry', 'git.locks.inspect', 'git.locks.quarantine', 'intake.retry', 'git.retry', 'recovery.resolve', 'worker.handoff', 'resident.handoff', 'todo.manage'].includes(call.op)).map(call => call.op));
  assert.deepEqual(spawnOps, []);
  assert.equal(await page.$eval('#composer', node => node.value), '未发送草稿保留检查');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(await page.evaluate(() => window.__errs), []);
  check('cold recovery UI stays projection-only: no spawn, replay or draft loss');

  await page.evaluate(() => window.nozeli.invoke('session.capture', { name: 'cold-recovery-ui' }));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, fixture: true, ozone }, null, 2));
  console.log(`managed cold recovery UI Electron ${report.checks.length} checks passed; ${output}`);
} catch (error) {
  report.errors.push(error.message);
  console.error(error.stack);
  try { const diag = await Promise.race([page.evaluate(() => ({ body: document.body.innerText.slice(0, 200), errs: window.__errs || [], uiCalls: window.__uiCalls || [] })), new Promise(resolve => setTimeout(resolve, 2000))]); if (diag) console.error('DIAG ' + JSON.stringify(diag).slice(0, 3000)); } catch {}
  try { await Promise.race([page.screenshot({ path: path.join(output, 'failure.png') }), new Promise(resolve => setTimeout(resolve, 3000))]); } catch {}
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, fixture: true, ozone, failed: true }, null, 2)).catch(() => {});
  throw error;
} finally {
  // Bounded teardown: persist evidence first, never await a wedged browser or
  // an unclosable Electron process indefinitely.
  await fs.writeFile(path.join(output, 'electron.log'), log).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ ...report, fixture: true, ozone, failed: report.errors.length > 0 }, null, 2)).catch(() => {});
  await Promise.race([browser?.disconnect().catch(() => {}), new Promise(resolve => setTimeout(resolve, 4000))]);
  if (child.exitCode === null && child.signalCode === null) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (child.exitCode === null && child.signalCode === null) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
}
