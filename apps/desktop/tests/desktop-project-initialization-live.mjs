import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

// Run from apps/desktop: NOZELI_TEST_BINARY=/absolute/installed/nozeli node tests/desktop-project-initialization-live.mjs
// Uses actual application IPC/persistence, never a source-host result substitute.
// A synthetic local provider controls refusal and a delayed map tool response.
const app = path.resolve(import.meta.dirname, '..');
const binary = process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
const out = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'nozeli-initialization-native-'));
const config = path.join(out, '.Nozeli'), profile = path.join(config, 'desktop');
const sourceText = '# Synthetic memory acceptance project\nLocal reading remains available.\n';
const mapText = 'Synthetic project for native initialization acceptance. README.md is the material entrance. Other files were not inspected; no verification or source edits performed.';
const result = {ok: false, out, binary, checks: [], errors: [], requests: [], scenarios: [], scope: 'Actual Electron/Pi native tools and application IPC/persistence; isolated synthetic projects/profile, deterministic loopback provider; no paid model quality claim'};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let attempt, child, browser, shell, exit, projectId, log = '', launchError;

async function fixture(name) {
  const directory = path.join(out, name);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'README.md'), sourceText);
  await fs.writeFile(path.join(directory, '.env'), 'SECRET_NEVER_DELIVERED=private-sentinel\n');
  await fs.mkdir(path.join(directory, 'node_modules'));
  await fs.writeFile(path.join(directory, 'node_modules', 'ignored.txt'), 'generated');
  const outside = path.join(out, name + '-outside');
  await fs.writeFile(outside, 'OUTSIDE_NEVER_DELIVERED');
  await fs.symlink(outside, path.join(directory, 'outside-link'));
  return directory;
}
function begin(mode, label) {
  assert(!attempt?.held, 'Previous response must be released');
  attempt = {mode, label, stage: 0, held: null};
  return attempt;
}
function sendTool(res, name, args, requestNumber) {
  const delta = {role: 'assistant', tool_calls: [{index: 0, id: 'init-' + requestNumber, type: 'function', function: {name, arguments: JSON.stringify(args)}}]};
  if (res.destroyed) return false; // Cancellation may correctly abort the provider socket.
  res.writeHead(200, {'content-type': 'text/event-stream'});
  for (const [part, finish] of [[delta, null], [{}, 'tool_calls']]) {
    res.write('data: ' + JSON.stringify({id: 'init-' + requestNumber, object: 'chat.completion.chunk', choices: [{index: 0, delta: part, finish_reason: finish}]}) + '\n\n');
  }
  res.end('data: [DONE]\n\n');
  return true;
}
function release(active) {
  assert(active.held, 'A real provider request must be in flight');
  const {res, args, requestNumber} = active.held;
  active.held = null;
  const socketOpen = sendTool(res, 'nozeli_project_map', args, requestNumber);
  result.scenarios.push({label: active.label, lateResponseAttempted: true, socketOpen});
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', bytes => body += bytes);
  req.on('end', () => {
    try {
      assert(attempt, 'No unsolicited model request is allowed');
      const active = attempt, input = JSON.parse(body), messages = input.messages ?? [];
      const names = (input.tools ?? []).map(t => t.function?.name);
      const rawText = messages.flatMap(m => typeof m.content === 'string' ? [m.content] : Array.isArray(m.content) ? m.content.map(x => x.text ?? '') : []).join('\n');
      assert(!rawText.includes('SECRET_NEVER_DELIVERED'));
      assert(!rawText.includes('OUTSIDE_NEVER_DELIVERED'));
      for (const forbidden of ['bash', 'write', 'nozeli_dispatch']) assert(!names.includes(forbidden));
      const requestNumber = result.requests.push({label: active.label, stage: active.stage, tools: names});
      if (active.mode === 'refuse') {
        res.writeHead(403, {'content-type': 'application/json'});
        res.end(JSON.stringify({error: {type: 'permission_error', code: 'provider_refused', message: 'Synthetic provider refusal'}}));
        return;
      }
      let name, args;
      if (active.stage === 0) {
        const match = rawText.match(/<location>([^<]*nozeli-orchestrator-project-initialization[^<]*SKILL\.md)<\/location>/);
        assert(match, 'Native Pi skill metadata catalog must reach actual model');
        // Explicit retries may retain a previous native read in session history.
        if (active.mode === 'hold-map') assert(!rawText.includes('Bounded project initialization and map maintenance'), 'Fresh project must not inject the skill body before native read');
        name = 'read'; args = {path: match[1]};
      } else if (active.stage === 1) {
        assert(rawText.includes('Bounded project initialization and map maintenance'));
        name = 'nozeli_project_inventory'; args = {};
      } else if (active.stage === 2) {
        const last = [...messages].reverse().find(m => m.role === 'tool');
        const value = JSON.parse(typeof last.content === 'string' ? last.content : last.content.map(b => b.text ?? '').join(''));
        const inventory = value.value ?? value;
        assert(inventory.files.includes('README.md'));
        assert(!inventory.files.some(f => f.startsWith('.env') || f.startsWith('node_modules') || f.startsWith('outside-link')));
        active.expectedVersion = inventory.map.expectedVersion;
        name = 'nozeli_project_read'; args = {relPath: 'README.md'};
      } else {
        assert.equal(active.stage, 3, 'Initialization must stop after map publication');
        const last = [...messages].reverse().find(m => m.role === 'tool');
        const content = typeof last.content === 'string' ? last.content : last.content.map(b => b.text ?? '').join('');
        assert.equal(content, sourceText, 'Actual project read must reach the model');
        name = 'nozeli_project_map'; args = {expectedVersion: active.expectedVersion, text: mapText};
      }
      assert(names.includes(name), 'Requested native tool must be advertised: ' + name);
      result.requests[requestNumber - 1].tool = name;
      active.stage++;
      if (active.mode === 'hold-map' && name === 'nozeli_project_map') {
        active.held = {res, args, requestNumber};
      } else sendTool(res, name, args, requestNumber);
    } catch (error) {
      result.errors.push(error.stack);
      res.destroy(error);
    }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const tcp = net.createServer();
await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve));
const port = tcp.address().port;
await new Promise(resolve => tcp.close(resolve));
const env = {...process.env};
for (const key of Object.keys(env)) {
  if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || (key !== 'XAUTHORITY' && /AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)) || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
}
Object.assign(env, {NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: config, NOZELI_USER_DATA: profile, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0'});
env.NOZELI_TEST_PICK = ['provider-refusal', 'cancel-in-flight', 'terminate-in-flight'].map(name => path.join(out, name)).join('\n');
async function until(fn, label, ms = 120000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (result.errors.length) throw Error(result.errors.join('\n'));
    if (launchError) throw launchError;
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw Error('Electron exited: ' + log);
    const value = await fn();
    if (value) return value;
    await pause(100);
  }
  throw Error('Timeout ' + label);
}
async function call(op, payload = {}, page = shell) {
  const reply = await page.evaluate(({op, payload}) => nozeli.invoke(op, payload), {op, payload});
  assert(reply.ok, op + ': ' + JSON.stringify(reply.error));
  return reply.value;
}
const status = () => call('managed.initialization.status', {projectId});
const state = async () => (await call('managed.status', {projectId})).state;
async function launch() {
  launchError = null;
  child = spawn(binary, [...(process.env.NOZELI_TEST_BINARY ? [] : [path.join(app, 'src/main/main.cjs')]), ...(process.platform==='linux'?['--ozone-platform='+(process.env.DISPLAY?'x11':'wayland')]:[])], {cwd: out, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  child.once('error', error => { launchError = error; });
  exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => log += bytes);
  browser = await until(() => puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null}).catch(() => null), 'CDP');
  shell = await until(async () => {
    for (const page of await browser.pages()) if (await page.evaluate(() => window.__nozeliReady && window.__workspaceScope?.role === 'shell').catch(() => false)) return page;
  }, 'shell');
  if (await shell.$eval('#configuration-setup', node => node.open)) await shell.click('#configuration-cancel');
}
async function close() {
  await call('session.requestClose');
  assert.deepEqual(await Promise.race([exit, pause(30000).then(() => null)]), {code: 0, signal: null});
  await browser.disconnect(); browser = null; child = null;
}
async function terminate() {
  // Only the process group created above, with its private synthetic profile.
  process.kill(-child.pid, 'SIGKILL');
  assert.equal((await exit).signal, 'SIGKILL');
  await browser.disconnect(); browser = null; child = null;
}
async function openProject(id) {
  projectId = id;
  await shell.waitForSelector('[data-project-id="' + id + '"]', {visible: true});
  await shell.click('[data-project-id="' + id + '"]');
  await shell.waitForFunction(id => window.__workspaceScope?.projectId === id, {}, id);
}
async function register(name) {
  const directory = await fixture(name);
  projectId = (await call('project.pick', {directory})).project.id;
  // Direct registration IPC persists the project but does not run the picker
  // UI wrapper's rail refresh. Rebootstrap the real renderer from persistence.
  await shell.reload({waitUntil: 'domcontentloaded'});
  await shell.waitForFunction(() => window.__nozeliReady && window.__workspaceScope?.role === 'shell');
  await openProject(projectId);
  return projectId;
}
async function stable(expected, count, label, ms = 2500) {
  const end = Date.now() + ms;
  do {
    const current = await status();
    assert.equal(current.status, expected, label);
    assert.equal(result.requests.length, count, label + ': no background model request');
    assert.equal((await state()).works.length, 0, 'Initialization must not create Work');
    if (expected !== 'completed') assert.equal(current.map, null, label + ': no map publication');
    await pause(100);
  } while (Date.now() < end);
  result.scenarios.push({label, status: expected, requests: count, observationMs: ms});
}
async function localReading() {
  assert.equal((await call('file.read', {projectId, relPath: 'README.md'})).text, sourceText);
  await shell.waitForSelector('#file-tree [data-path="README.md"]');
  await shell.click('#file-tree [data-path="README.md"]');
  const doc = await until(async () => {
    for (const page of await browser.pages()) if (await page.evaluate(id => window.__nozeliReady && window.__workspaceScope?.kind === 'document' && window.__workspaceScope.projectId === id && window.__workspaceScope.relPath === 'README.md', projectId).catch(() => false)) return page;
  }, 'local document surface');
  await until(() => doc.evaluate(text => document.body.innerText.includes(text) || window.__nozeliInput?.text?.().includes(text), 'Local reading remains available.'), 'local reading content');
}
async function completeRetry(label, {resolveAuth = false} = {}) {
  const previous = await status(), active = begin('complete', label);
  const beforeRetry = result.requests.length;
  const retried = await call('managed.initialization.retry', {projectId, expectedProjectInstanceId: previous.projectInstanceId});
  assert.notEqual(retried.jobId, previous.jobId, 'Explicit retry creates exactly one new initialization');
  if (resolveAuth) {
    // A 403 is an account-scoped auth gate, not an automatically retryable
    // initialization error. Ordinary retry must not bypass user resolution.
    await stable('queued', beforeRetry, 'explicit retry remains queued behind auth gate');
    const fault = (await call('managed.fault.status', {projectId})).faults.find(row => row.category === 'auth' && row.state === 'active');
    assert(fault, 'The real 403 must retain an active authorization fault');
    assert.equal(fault.evidenceSummary.httpStatus, 403);
    assert.equal(fault.userCritical, true);
    assert.equal(fault.release.available, true);
    assert(fault.projects.some(row => row.projectId === projectId && row.blockedJobs.includes(retried.jobId)));
    // Real explicit user-resolution API, with its exact current CAS/scope.
    // Release admits this queued retry; it must not synthesize another one.
    const receipt = await call('managed.fault.release', {faultRef: fault.faultRef, expectedVersion: fault.release.expectedVersion, scopeSnapshot: fault.release.scopeSnapshot, requestKey: 'initialization-auth-resolution'});
    result.scenarios.push({label: 'explicit connection authorization resolution', fault, receipt});
    assert(!(await call('managed.fault.status', {projectId})).faults.some(row => row.faultRef === fault.faultRef && row.state === 'active'));
  }
  const completed = await until(async () => {
    const current = await status();
    if (['failed', 'interrupted', 'cancelled'].includes(current.status) && current.jobId !== previous.jobId) throw Error(JSON.stringify(current));
    return current.status === 'completed' && current.jobId !== previous.jobId ? current : null;
  }, label);
  assert.equal(completed.jobId, retried.jobId, 'Resolution must run the existing queued retry, not a redundant job');
  assert.equal((await state()).jobs.find(job => job.id === previous.jobId).status, previous.status, 'Original settled initialization is never replayed');
  assert.equal(active.stage, 4);
  const map = await call('managed.initialization.read', {projectId, version: completed.map.version, offset: 0});
  assert(map.text.includes(mapText));
  assert(map.text.includes('Host source spans and coverage'));
  assert(map.text.includes('README.md'));
  completed.persistedText = map.text;
  assert.equal((await state()).works.length, 0);
  result.scenarios.push({label, completed});
  return completed;
}
try {
  await launch();
  await call('config.initialize', {mode: 'independent'});
  await call('settings.providers.save', {operation: 'create', provider: 'init-local', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', api: 'openai-completions', models: [{id: 'scripted'}], credential: {action: 'replace', value: 'local-only'}});
  await call('settings.models.save', Object.fromEntries(['frontdesk', 'orchestrator', 'worker'].map(role => [role, {model: {mode: 'explicit', selector: 'init-local/scripted'}, thinking: {mode: 'native-default'}}])));

  begin('refuse', 'provider-refusal');
  const refusalId = await register('provider-refusal');
  await call('managed.enable', {projectId});
  await until(async () => (await status()).status === 'failed', 'provider refusal');
  assert.equal(result.requests.length, 1, '403 must not be automatically retried');
  await localReading();
  await stable('failed', 1, 'refusal leaves reading available without loop');
  const refusalCompleted = await completeRetry('refusal explicit retry after authorization resolution', {resolveAuth: true});
  result.checks.push('Provider refusal fails once; local file IPC/document UI stay readable; retry stays gated with zero requests until explicit connection authorization resolution releases that exact queued retry');

  const cancelled = begin('hold-map', 'cancel-in-flight');
  const cancelId = await register('cancel-in-flight');
  await call('managed.enable', {projectId});
  await until(() => cancelled.held, 'held provider map response');
  assert.equal((await status()).status, 'running');
  const beforeCancellation = result.requests.length;
  const cancellation = call('managed.initialization.cancel', {projectId, expectedProjectInstanceId: (await status()).projectInstanceId});
  // Observe the durable cancellation before attempting a late tool publication.
  await until(async () => (await status()).status === 'cancelled', 'cancelled status');
  release(cancelled);
  await cancellation;
  await stable('cancelled', beforeCancellation, 'late provider response cannot publish');
  await localReading();
  await close();
  await launch(); await openProject(cancelId); await call('managed.connect', {projectId});
  await stable('cancelled', beforeCancellation, 'cancelled state persists across cold reopen');
  await completeRetry('cancel explicit retry');
  result.checks.push('Cancellation of real in-flight map response prevents late publication and persists; explicit retry completes');

  const interrupted = begin('hold-map', 'terminate-in-flight');
  const interruptedId = await register('terminate-in-flight');
  await call('managed.enable', {projectId});
  await until(() => interrupted.held, 'provider map request before termination');
  assert.equal((await status()).status, 'running');
  const beforeTermination = result.requests.length;
  await terminate();
  release(interrupted);
  await launch(); await openProject(interruptedId); await call('managed.connect', {projectId});
  await until(async () => (await status()).status === 'interrupted', 'cold interrupted status');
  await stable('interrupted', beforeTermination, 'terminated initialization is not silently replayed');
  await localReading();
  const interruptedCompleted = await completeRetry('termination explicit retry');
  result.checks.push('SIGKILL during real initialization recovers as interrupted, sends zero replay requests, explicit retry completes');

  const beforeCold = result.requests.length;
  await shell.screenshot({path: path.join(out, 'project-map-status.png')});
  await close(); await launch();
  for (const [id, completed] of [[refusalId, refusalCompleted], [interruptedId, interruptedCompleted]]) {
    await openProject(id); await call('managed.connect', {projectId});
    assert.equal((await status()).map.version, completed.map.version);
    await stable('completed', beforeCold, 'completed cold reopen has zero requests');
    assert.equal((await call('managed.initialization.read', {projectId, version: completed.map.version, offset: 0})).text, completed.persistedText);
  }
  await close();
  result.checks.push('Native skill progressively read; restricted inventory/read/map, credentials/generated files/symlink excluded; no Work; map persists and completed cold reopen makes zero requests');
  result.ok = true;
} catch (error) {
  result.error = error.stack; process.exitCode = 1;
  await shell?.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
} finally {
  if (attempt?.held) { attempt.held.res.destroy(); attempt.held = null; }
  if (child && child.exitCode === null && child.signalCode === null) {
    await call('session.requestClose').catch(() => {});
    await Promise.race([exit, pause(5000)]);
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
  }
  await browser?.disconnect().catch(() => {});
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
  await fs.writeFile(path.join(out, 'electron.log'), log);
  console.log(JSON.stringify(result, null, 2));
}
