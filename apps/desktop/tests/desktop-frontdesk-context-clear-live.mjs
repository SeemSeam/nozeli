// Real Electron + private native OMP + scripted loopback HTTP only. No public model/account.
// Run from apps/desktop: node tests/desktop-frontdesk-context-clear-live.mjs
// Optional installed launch: NOZELI_TEST_APP_ROOT=/installation NOZELI_TEST_BINARY=/installation/nozeli
// Source helpers below deliberately remain relative to this fixture, including installed runs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';

const source = path.resolve(import.meta.dirname, '..');
const appRoot = path.resolve(process.env.NOZELI_TEST_APP_ROOT || source);
const binary = process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-frontdesk-clear-'));
const project = path.join(root, 'paper'), config = path.join(root, '.Nozeli'), profile = path.join(config, 'desktop');
const original = '# Synthetic reset smoke\n\nKEEP_PROJECT_BYTES\n';
await fs.mkdir(project);
await fs.writeFile(path.join(project, 'paper.md'), original);
execFileSync('git', ['init', '-q', project]);
execFileSync('git', ['-C', project, 'add', 'paper.md']);
execFileSync('git', ['-C', project, '-c', 'user.name=Nozeli local fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'Synthetic fixture']);
const host = new DesktopHost(profile), projectId = (await host.pick(project)).project.id;
const runtime = path.join(profile, 'nozeli', 'managed-v1', projectId, 'runtime');
const store = await Workspace.open(runtime, project);
const oldIndependent = 'RESET_OLD_INDEPENDENT_REQUEST_' + randomUUID();
const oldOtherRole = 'RESET_OLD_ORCHESTRATOR_DIALOGUE_' + randomUUID();
// Seed explicitly historical data, not a fake native session or fake live round.
const historicalWork = await store.submit(oldIndependent, 'Synthetic historical Work fact', {name: 'Historical fixture Work'});
await store.mutate(() => {
  const work = store.find(historicalWork.id);
  Object.assign(work, {status: 'ended', outcome: 'discard', endedBy: 'user', endedAt: new Date().toISOString(), closure: {phase: 'complete', decision: 'discard'}});
  for (const todo of store.state.todos) todo.status = 'resolved';
  store.state.jobs = [{id: randomUUID(), target: 'frontdesk', type: 'front', status: 'completed', text: oldIndependent}];
  store.state.messages = [{id: randomUUID(), target: 'orchestrator', speaker: 'agent', text: oldOtherRole}];
});
await store.close();

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, browser, shell, chat, doc, exited, log = '', serverError;
async function until(fn, label, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (serverError) throw serverError;
    if (child && (child.exitCode !== null || child.signalCode)) throw Error('Electron exited during ' + label + '\n' + log);
    const value = await fn();
    if (value) return value;
    await pause(75);
  }
  throw Error('Timeout: ' + label);
}
const requests = [];
const oldPrompt = 'RESET_OLD_FRONTDESK_PROMPT_' + randomUUID();
const oldReply = 'RESET_OLD_FRONTDESK_REPLY_' + randomUUID();
const newPrompt = 'RESET_NEW_FRONTDESK_PROMPT_' + randomUUID();
const newReply = 'RESET_NEW_FRONTDESK_REPLY_' + randomUUID();
const draft = 'KEEP_UNSENT_GUI_DRAFT_' + randomUUID();
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      assert.equal(req.method, 'POST');
      assert.match(req.url, /^\/v1\/chat\/completions\/?$/);
      const request = JSON.parse(body);
      requests.push(request);
      assert(requests.length <= 2, 'No reset, refresh, history or launcher model request/replay');
      const content = requests.length === 1 ? oldReply : newReply;
      res.writeHead(200, {'content-type': 'text/event-stream'});
      for (const delta of [{role: 'assistant', content}, {}]) {
        res.write('data: ' + JSON.stringify({id: 'local-reset-' + requests.length, model: request.model, object: 'chat.completion.chunk', choices: [{index: 0, delta, finish_reason: delta.content ? null : 'stop'}]}) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { serverError = error; res.writeHead(500); res.end('Synthetic local fixture rejected request'); }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = await new Promise(resolve => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1', () => { const value = socket.address().port; socket.close(() => resolve(value)); });
});
const env = {...process.env};
for (const key of Object.keys(env)) {
  if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY/i.test(key)) delete env[key];
}
Object.assign(env, {NOZELI_TEST_INSTANCE: '1', NOZELI_TEST_PICK: project, NOZELI_CONFIG_ROOT: config, NOZELI_USER_DATA: profile, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0'});
const checks = [], rendererErrors = [];
const invokeRaw = (page, op, payload = {}) => page.evaluate((op, payload) => window.nozeli.invoke(op, payload), op, payload);
async function invoke(page, op, payload = {}) {
  const result = await invokeRaw(page, op, payload);
  assert.equal(result.ok, true, op + ': ' + JSON.stringify(result.error));
  return result.value;
}
const state = async () => (await invoke(shell, 'managed.status', {projectId})).state;
const persisted = async () => JSON.parse(await fs.readFile(path.join(runtime, 'state.json'), 'utf8'));
const front = s => s.agents.find(agent => agent.target === 'frontdesk');
const orch = s => s.agents.find(agent => agent.target === 'orchestrator');
const business = s => Object.fromEntries(['jobs', 'messages', 'works', 'todos', 'receipts', 'fileOperations'].map(key => [key, s[key]]));
async function surface(kind) {
  for (const page of await browser.pages()) {
    if (!page.url().startsWith('http://127.0.0.1:')) continue;
    const scope = await page.evaluate(() => window.__workspaceScope).catch(() => null);
    if (scope?.kind === kind && scope.projectId === projectId) return page;
  }
}
async function conversationIdentity() {
  const snapshot = await invoke(shell, 'workspace.snapshot', {projectId});
  return Object.values(snapshot.layout.views).filter(view => view.kind === 'conversation').map(view => view.id).sort();
}
async function send(text, expectedJobs) {
  await chat.waitForFunction(() => !document.querySelector('#send-message').disabled);
  await chat.$eval('#composer', (node, value) => { node.value = value; node.dispatchEvent(new Event('input', {bubbles: true})); }, text);
  await chat.click('#send-message');
  return until(async () => {
    const current = await state();
    const failed = current.jobs.find(job => ['failed', 'unknown', 'interrupted'].includes(job.status));
    assert(!failed, JSON.stringify(failed));
    return current.jobs.length === expectedJobs && current.jobs.every(job => job.status === 'completed') && !current.busyTargets.length ? current : null;
  }, 'real native round completion');
}
try {
  child = spawn(binary, [...(process.env.NOZELI_TEST_BINARY ? [] : [path.join(appRoot, 'src/main/main.cjs')]), '--ozone-platform=' + (process.env.NOZELI_OZONE || 'wayland')], {cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe']});
  child.on('error', error => { serverError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; });
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  await until(async () => { try { browser = await puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null}); return true; } catch { return false; } }, 'private Electron debug endpoint');
  shell = await until(async () => {
    for (const page of await browser.pages()) if (await page.evaluate(() => window.__workspaceScope?.role === 'shell').catch(() => false)) return page;
  }, 'workspace shell');
  await shell.waitForFunction(() => window.__nozeliReady);
  shell.on('pageerror', error => rendererErrors.push(error.message));
  await shell.waitForSelector('#configuration-setup[open]');
  await shell.click('#configuration-independent');
  await shell.waitForFunction(() => !document.querySelector('#configuration-setup').open);
  await invoke(shell, 'settings.providers.save', {provider: 'reset-local', model: 'scripted', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', key: 'synthetic-local-only', api: 'openai-completions'});
  await shell.click('#open-settings');
  await shell.waitForSelector('#settings-dialog[open]');
  await shell.click('[data-settings-section="settings-models"]');
  await shell.waitForSelector('[data-default-role="frontdesk"] option[value="reset-local/scripted"]');
  for (const role of ['frontdesk', 'orchestrator', 'worker']) await shell.select('[data-default-role="' + role + '"]', 'reset-local/scripted');
  await shell.click('[data-role-model-form] button[type="submit"]');
  await shell.waitForFunction(() => document.querySelector('[data-model-status]').textContent.includes('已保存'));
  await shell.click('#settings-close');
  await shell.click('#pick-project');
  await shell.waitForFunction(() => document.querySelector('#project-name').textContent === 'paper');
  await until(async () => (await invoke(shell, 'managed.status', {projectId})).ready, 'private native residents');
  await shell.waitForSelector('#workspace-open-conversation', {visible: true});
  await shell.click('#workspace-open-conversation');
  chat = await until(() => surface('conversation'), 'launcher-created conversation surface');
  await chat.waitForFunction(() => window.__nozeliReady);
  chat.on('pageerror', error => rendererErrors.push(error.message));
  assert.equal(await chat.$eval('#workspace-open-conversation', node => Boolean(node.offsetWidth && node.offsetHeight)), false);
  const openClear=async()=>{await chat.locator('#composer').click({button:'right'});await chat.waitForSelector('#conversation-context-menu:not([hidden]) [data-command="chat-clear-frontdesk-context"]');await chat.click('#conversation-context-menu [data-command="chat-clear-frontdesk-context"]');};
  await chat.waitForFunction(() => !document.querySelector('#chat-clear-frontdesk-context').disabled && !document.querySelector('#send-message').disabled);
  const conversationIds = await conversationIdentity();
  assert.equal(conversationIds.length, 1);
  await shell.click('#workspace-open-conversation');
  assert.deepEqual(await conversationIdentity(), conversationIds);
  checks.push('shell launcher opens the unique conversation; conversation hides launcher');

  await shell.waitForSelector('#file-tree [data-path="paper.md"]');
  await shell.locator('#file-tree [data-path="paper.md"]').click();
  doc = await until(() => surface('document'), 'document surface');
  await doc.waitForFunction(() => window.__nozeliReady);
  assert.equal(await doc.$eval('#workspace-open-conversation',node=>node.getClientRects().length),0);
  const beforeDenied = await state();
  const denied = await invokeRaw(doc, 'managed.frontdesk.context.clear', {projectId});
  assert.equal(denied.ok, false, 'Document surfaces must not invoke clear');
  assert.equal(front(await state()).threadId, front(beforeDenied).threadId);
  await shell.click('#workspace-open-conversation');
  chat = await until(() => surface('conversation'), 'conversation remounted after document launcher');
  await chat.waitForFunction(() => window.__nozeliReady);
  chat.on('pageerror', error => rendererErrors.push(error.message));
  assert.deepEqual(await conversationIdentity(), conversationIds);
  checks.push('document launcher reuses conversation; document clear API is denied');

  const before = await send(oldPrompt + ' 仅回复一句，不使用工具。', 2);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].model, 'scripted');
  assert.equal(front(before).model, 'reset-local/scripted');
  assert(before.messages.some(message => message.text?.includes(oldReply)), 'Actual native answer is preserved in timeline');
  assert(front(before).threadId && orch(before).threadId);
  const oldOwner = before.providers.frontdesk, orchestratorOwner = before.providers.orchestrator;
  assert(oldOwner?.pid && oldOwner.stamp && orchestratorOwner?.pid && orchestratorOwner.stamp);
  assert.equal(await processStamp(oldOwner.pid), oldOwner.stamp);
  await chat.$eval('#composer', (node, value) => { node.value = value; node.dispatchEvent(new Event('input', {bubbles: true})); }, draft);
  await until(async () => (await persisted()).drafts?.frontdesk === draft, 'GUI draft durability');
  const durableBefore = await persisted();
  await openClear();
  await chat.waitForSelector('#action-confirmation[open]');
  await chat.click('#action-confirmation-cancel');
  await chat.waitForFunction(() => !document.querySelector('#action-confirmation').open);
  assert.equal(front(await state()).threadId, front(before).threadId);
  assert.deepEqual(business(await persisted()), business(durableBefore));
  assert.equal(requests.length, 1);
  assert.equal(await processStamp(oldOwner.pid), oldOwner.stamp);
  checks.push('cancel neither clears context nor changes owner, jobs, history, or model calls');

  await openClear();
  await chat.waitForSelector('#action-confirmation[open]');
  await chat.click('#action-confirmation-accept');
  const cleared = await until(async () => {
    const current = await state();
    return front(current)?.threadId && front(current).threadId !== front(before).threadId && !(current.configuringTargets || []).includes('frontdesk') ? current : null;
  }, 'confirmed zero-model frontdesk reset');
  await chat.waitForFunction(() => !document.querySelector('#action-confirmation').open);
  assert.equal(orch(cleared).threadId, orch(before).threadId);
  assert.deepEqual(cleared.providers.orchestrator, orchestratorOwner);
  assert.equal(await processStamp(orchestratorOwner.pid), orchestratorOwner.stamp);
  assert.notEqual(await processStamp(oldOwner.pid), oldOwner.stamp, 'Old frontdesk owner fully exits');
  assert.notEqual(cleared.providers.frontdesk.pid, oldOwner.pid);
  assert.deepEqual(business(await persisted()), business(durableBefore));
  assert.deepEqual((await persisted()).contextDelivery?.orchestrator, durableBefore.contextDelivery?.orchestrator, 'Orchestrator history delivery watermark is unchanged');
  assert.equal(await chat.$eval('#composer', node => node.value), draft);
  assert.equal((await persisted()).drafts.frontdesk, draft);
  assert.equal(requests.length, 1, 'Reset completes without requesting a model answer');
  await chat.waitForFunction(text=>!document.querySelector('#managed-session-timeline').innerText.includes(text),{},oldReply);
  const archives = cleared.residentArchive?.frontdesk?.handoffs || [];
  const archive = archives.find(entry => (entry.oldThreadId || entry.threadId) === front(before).threadId);
  assert(archive, 'Old resident has a durable readable archive');
  const archiveId = archive.archiveId || archive.id;
  assert(archiveId);
  const clearedEpoch = structuredClone((await persisted()).frontdeskContextEpoch);
  let history = await invoke(shell, 'managed.resident.history', {projectId, role: 'frontdesk', archiveId});
  let archivedText = history.text;
  while (history.nextOffset !== null) {
    history = await invoke(shell, 'managed.resident.history', {projectId, role: 'frontdesk', archiveId, offset: history.nextOffset, version: history.version});
    archivedText += history.text;
  }
  assert(archivedText.includes(oldPrompt), 'Archive retains actual old native user prompt');
  assert(archivedText.includes(oldReply), 'Archive retains actual old native answer');
  checks.push('confirm replaces only frontdesk native owner/thread; business, orchestrator, draft and archive survive without HTTP');

  await chat.reload();
  await chat.waitForFunction(() => window.__nozeliReady);
  await chat.waitForFunction(value => document.querySelector('#composer').value === value, {}, draft);
  await shell.reload();
  await shell.waitForFunction(() => window.__nozeliReady);
  await until(async () => (await invoke(shell, 'managed.status', {projectId})).ready, 'resident readiness after renderer refresh');
  const refreshed = await state(), durableRefreshed = await persisted();
  assert.equal(front(refreshed).threadId, front(cleared).threadId);
  assert.equal(durableRefreshed.residents.frontdesk.threadId, front(cleared).threadId);
  assert.deepEqual(durableRefreshed.frontdeskContextEpoch, clearedEpoch);
  assert.equal(durableRefreshed.frontdeskContextEpoch.archiveId, archiveId);
  assert.equal(durableRefreshed.frontdeskContextEpoch.jobId, before.jobs.at(-1).id);
  assert.equal(orch(refreshed).threadId, orch(before).threadId);
  assert.deepEqual(refreshed.providers.orchestrator, orchestratorOwner);
  assert.deepEqual(business(durableRefreshed), business(durableBefore));
  assert.equal(durableRefreshed.drafts.frontdesk, draft);
  assert.equal(requests.length, 1);
  checks.push('renderer refresh retains new durable boundary and GUI draft without replay');

  const after = await send(newPrompt + ' 仅回复一句，不使用工具。', 3);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].model, 'scripted');
  assert.equal(front(after).threadId, front(cleared).threadId);
  assert.equal(front(after).model, 'reset-local/scripted');
  assert.equal(orch(after).threadId, orch(before).threadId);
  assert.deepEqual(after.providers.orchestrator, orchestratorOwner);
  const nextInput = JSON.stringify(requests[1].messages);
  assert(nextInput.includes(newPrompt));
  for (const old of [oldPrompt, oldReply, oldOtherRole, oldIndependent]) assert(!nextInput.includes(old), 'New model input must exclude pre-reset dialogue/request: ' + old);
  assert.deepEqual(after.jobs.slice(0, before.jobs.length), before.jobs);
  assert.deepEqual(after.works, before.works);
  for (const message of before.messages) assert.deepEqual(after.messages.find(item => item.id === message.id), message);
  checks.push('next actual native round uses effective model/new thread and excludes old frontdesk, cross-role and independent-request input');

  await chat.waitForSelector('[data-resident-history="' + archiveId + '"]', {visible: true});
  await chat.click('[data-resident-history="' + archiveId + '"]');
  const historyPage = await until(() => surface('history'), 'old history surface');
  await historyPage.waitForFunction(() => window.__nozeliReady);
  await until(async () => {
    if (await historyPage.evaluate(text => document.body.innerText.includes(text), oldPrompt)) return true;
    await historyPage.evaluate(() => {
      const button = [...document.querySelectorAll('#managed-doc button')].find(node => node.textContent === '下一段' && !node.disabled);
      if (!button) return false;
      button.click();
      return true;
    });
    return false;
  }, 'old history visibly readable');
  await shell.waitForSelector('#workspace-open-conversation', {visible: true});
  await shell.click('#workspace-open-conversation');
  chat = await until(() => surface('conversation'), 'conversation remounted after archive reading');
  await chat.waitForFunction(() => window.__nozeliReady);
  assert.deepEqual(await conversationIdentity(), conversationIds);
  await pause(500);
  assert.equal(requests.length, 2);
  assert.deepEqual((await state()).jobs, after.jobs);
  assert.equal(await fs.readFile(path.join(project, 'paper.md'), 'utf8'), original);
  assert.deepEqual(rendererErrors, []);
  await chat.screenshot({path: path.join(root, 'frontdesk-context-cleared.png')});
  checks.push('old archive is visibly readable; repeated launcher/history reads do not duplicate conversation or replay jobs');
  const report = {pass: true, root, checks, modelService: 'scripted HTTP on 127.0.0.1 only; not a public or real intelligence model', requests: requests.map(request => request.model), oldThreadId: front(before).threadId, threadId: front(cleared).threadId, orchestratorThreadId: orch(before).threadId, archiveId};
  await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  await fs.writeFile(path.join(root, 'failure.json'), JSON.stringify({error: error.stack, checks, requests: requests.length, rendererErrors}, null, 2));
  if (chat && !chat.isClosed()) await chat.screenshot({path: path.join(root, 'failure.png')}).catch(() => {});
  console.error('Frontdesk context clear smoke failed; synthetic evidence:', root);
  throw error;
} finally {
  if (shell && !shell.isClosed()) await Promise.race([invokeRaw(shell, 'session.requestClose').catch(() => {}), pause(2000)]);
  if (child && child.exitCode === null && !child.signalCode) {
    await Promise.race([exited, pause(8000)]);
    if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
    await Promise.race([exited, pause(3000)]);
    if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exited; }
  }
  await browser?.disconnect();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(root, 'electron.log'), log);
}
