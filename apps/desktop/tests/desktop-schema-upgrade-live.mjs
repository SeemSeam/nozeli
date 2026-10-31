// Opt-in, serial: old installed Electron -> current Electron, actual native OMP.
// Required NOZELI_TEST_OLD_APP_ROOT selects a genuine older resources/app;
// optional NOZELI_TEST_OLD_BINARY overrides its derived installed executable.
// NOZELI_TEST_APP_ROOT/BINARY and NOZELI_TEST_EVIDENCE_ROOT match other live tests.
// No fixtures, patched manifests, database writes, credentials or user projects.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
import {pinSessionFileById} from '../src/agents/managed/omp-process-ownership.mjs';
import {readOmpTerminalToolHistory} from '../src/agents/managed/omp-terminal-bridge.mjs';

assert(process.env.NOZELI_TEST_OLD_APP_ROOT?.trim(), 'Prerequisite: set NOZELI_TEST_OLD_APP_ROOT to a genuine older installed release resources/app directory.');
const oldAppRoot = path.resolve(process.env.NOZELI_TEST_OLD_APP_ROOT);
const oldBinary = process.env.NOZELI_TEST_OLD_BINARY || path.resolve(oldAppRoot, '../../nozeli');
const appRoot = path.resolve(process.env.NOZELI_TEST_APP_ROOT || path.join(import.meta.dirname, '..'));
const binary = process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
const {DesktopHost} = await import(pathToFileURL(path.join(oldAppRoot, 'src/main/host.mjs')));
const evidenceRoot = path.resolve(process.env.NOZELI_TEST_EVIDENCE_ROOT || path.join(os.homedir(), '.cache/nozeli-smokes'));
await fs.mkdir(evidenceRoot, {recursive: true});
const out = await fs.mkdtemp(path.join(evidenceRoot, 'schema-upgrade-live-'));
const project = path.join(out, 'project'), home = path.join(out, 'home');
const config = path.join(out, '.Nozeli'), profile = path.join(config, 'desktop');
const roles = ['frontdesk', 'orchestrator'];
const draft = 'UNSENT_SCHEMA_UPGRADE_DRAFT: do not submit or replay this text.';
const originals = Object.fromEntries(roles.map(role => [role, `OLD_${role}_HISTORY: harmless synthetic conversation only. Acknowledge without tools. Do not create Work, edit files, dispatch or continue automatically.`]));
const explicit = 'NEW_EXPLICIT_SCHEMA_UPGRADE_INPUT: acknowledge only; no tools, Work or filesystem changes.';
const result = {ok: false, out, project, oldAppRoot, oldBinary, appRoot, binary, checks: [], requests: [], errors: [], launches: [], scope: 'Real old and current Electron/native OMP, same isolated HOME/profile, synthetic project, loopback scripted final-only model. Frontdesk GUI send and Orchestrator actual native terminal manual rounds create harmless histories without routing intakes/todos. No original project, installed user database, credentials, task replay or Work side effects.'};
const run = promisify(execFile), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digestTools = tools => hash(JSON.stringify(tools.map(({name, description, parameters, inputSchema}) => ({name, description, parameters: parameters ?? inputSchema ?? {type: 'object', properties: {}}}))));
const save = (name, value) => fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2));
const check = name => {result.checks.push(name); console.log(JSON.stringify({check: name}));};
let child, exited, browser, shell, projectId, serverError, sampler, sampling = false, launch, phase = 'setup';
const processes = new Map();
async function until(fn, label, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (serverError) throw serverError;
    if (child && (child.exitCode !== null || child.signalCode)) throw Error('Electron exited during ' + label + ': ' + launch.log.slice(-8000));
    const value = await fn(); if (value) return value;
    await pause(100);
  }
  throw Error('Timeout: ' + label);
}
async function call(op, payload = {}) {
  const reply = await shell.evaluate(({op, payload}) => window.nozeli.invoke(op, payload), {op, payload});
  assert(reply.ok, op + ': ' + JSON.stringify(reply.error)); return reply.value;
}
const status = () => call('managed.status', {projectId});
const state = async () => (await status()).state;
async function sample() {
  if (sampling || !child?.pid) return; sampling = true;
  try {
    const pending = [child.pid], seen = new Set();
    while (pending.length) {
      const pid = pending.pop(); if (seen.has(pid)) continue; seen.add(pid);
      try {
        const [stat, children, command] = await Promise.all([fs.readFile(`/proc/${pid}/stat`, 'utf8'), fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'), fs.readFile(`/proc/${pid}/cmdline`, 'utf8')]);
        pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
        const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        processes.set(`${pid}:${startTicks}`, {pid, startTicks, command: command.replaceAll('\0', ' '), phase: launch.phase});
      } catch (error) {if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;}
    }
  } finally {sampling = false;}
}
async function survivors() {
  const alive = [];
  for (const row of processes.values()) {
    try {
      const stat = await fs.readFile(`/proc/${row.pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] !== 'Z' && fields[19] === row.startTicks) alive.push(row);
    } catch (error) {if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;}
  }
  return alive;
}
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', chunk => {body += chunk;});
  req.on('end', () => {
    try {
      assert(req.url.startsWith('/v1/')); assert.equal(req.method, 'POST');
      const input = JSON.parse(body), names = (input.tools || []).map(row => row.function?.name);
      assert(!names.includes('nozeli_publish'), 'No Worker model request is allowed');
      const role = names.includes('nozeli_dispatch') ? 'orchestrator' : 'frontdesk';
      const request = {phase, role, messages: input.messages, toolNames: names, at: new Date().toISOString()};
      result.requests.push(request);
      assert(['old-history', 'explicit-new-input'].includes(phase), 'Connect/reconnect/close must never call the model: ' + phase);
      assert.equal(result.requests.filter(row => row.phase === phase && row.role === role).length, 1, 'No automatic model or original-input replay');
      const expected = phase === 'old-history' ? originals[role] : explicit;
      assert(JSON.stringify(input.messages.filter(row => row.role === 'user')).includes(expected), 'Actual native model receives the explicit input');
      const content = `SCHEMA_UPGRADE_ACK_${phase}_${role}: harmless conversation retained; no tools or Work.`;
      const delta = {role: 'assistant', content};
      res.writeHead(200, {'content-type': 'text/event-stream'});
      for (const [part, finish] of [[delta, null], [{}, 'stop']]) res.write('data: ' + JSON.stringify({id: 'upgrade-' + result.requests.length, object: 'chat.completion.chunk', choices: [{index: 0, delta: part, finish_reason: finish}]}) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (error) {serverError = error; res.destroy(error);}
  });
});
async function start(root, executable, source, name) {
  launch = {phase: name, log: ''}; result.launches.push(launch);
  const port = await new Promise(resolve => {const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => {const p = socket.address().port; socket.close(() => resolve(p));});});
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)) delete env[key];
  Object.assign(env, {HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'), NOZELI_OMP_SOURCE_HOME: home, NOZELI_CONFIG_ROOT: config, NOZELI_USER_DATA: profile, NOZELI_TEST_INSTANCE: '1', NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0'});
  child = spawn(executable, [...(source ? [path.join(root, 'src/main/main.cjs')] : []), '--ozone-platform=' + (process.env.NOZELI_OZONE || 'wayland')], {cwd: project, env, stdio: ['ignore', 'pipe', 'pipe']});
  child.on('error', error => {serverError = error;}); exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {launch.log += chunk;});
  sampler = setInterval(() => {sample().catch(error => result.errors.push(error.message));}, 100);
  browser = await until(() => puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null}).catch(() => null), name + ' CDP', 45000);
  shell = await until(async () => {for (const page of await browser.pages()) if (await page.evaluate(() => window.__nozeliReady && window.__workspaceScope?.role === 'shell').catch(() => false)) return page;}, name + ' shell');
  shell.on('pageerror', error => result.errors.push(error.message));
  if (name !== 'old') {
    await shell.click('[data-project-id="' + projectId + '"]');
    await shell.waitForFunction(id => window.__workspaceScope?.projectId === id, {}, projectId);
  }
}
async function stop() {
  await sample();
  assert([...processes.values()].some(row => row.phase === launch.phase && /(?:^|\/)omp(?:\s|$)/.test(row.command)), 'Actual native OMP descendant in ' + launch.phase);
  await call('session.requestClose');
  launch.exit = await Promise.race([exited, pause(45000).then(() => null)]);
  assert.deepEqual(launch.exit, {code: 0, signal: null}, 'Clean real app shutdown');
  clearInterval(sampler); sampler = null;
  for (let n = 0; n < 100 && (await survivors()).length; n++) await pause(100);
  launch.normalExitSurvivors = await survivors(); assert.deepEqual(launch.normalExitSurvivors, []);
  await browser.disconnect(); browser = null; shell = null; child = null;
}
async function send(target, text, requestKey) {
  if (target === 'orchestrator') {
    // Real native manual rounds need no artificial intake routing decision and
    // leave no pending clarification for newer backstage automation to inspect.
    const attachment = await call('managed.terminal.attach', {projectId, target});
    await call('managed.terminal.input', {projectId, target, terminalId: attachment.terminalId, data: text});
    await until(async () => (await state()).nativeDraftTargets.includes(target), 'native explicit input draft');
    await call('managed.terminal.input', {projectId, target, terminalId: attachment.terminalId, data: '\r'});
  } else await call('managed.send', {projectId, target, text, requestKey});
  return until(async () => {
    const s = await state(), job = s.jobs.find(row => row.text === text);
    assert.equal(s.works.length, 0, 'Harmless conversation must never create Work');
    if (job && ['failed', 'unknown', 'interrupted'].includes(job.status)) throw Error('Explicit input failed: ' + JSON.stringify(job));
    return job?.status === 'completed' && !s.busyTargets.length ? s : null;
  }, target + ' explicit harmless conversation');
}
let oldState, history;
try {
  assert.equal(process.platform, 'linux', 'Identity-checked /proc ownership requires Linux');
  await fs.access(oldBinary); await fs.mkdir(project); await fs.mkdir(home);
  await fs.writeFile(path.join(project, 'baseline.txt'), 'SYNTHETIC_SCHEMA_UPGRADE_BASELINE\n');
  await fs.writeFile(path.join(project, '.gitignore'), '/.nozeli/\n');
  const gitEnv = {...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
  const git = async (...args) => (await run('git', ['-C', project, ...args], {env: gitEnv})).stdout.trim();
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Synthetic upgrade'], ['config', 'user.email', 'synthetic@localhost'], ['add', '--all'], ['commit', '-m', 'Synthetic upgrade baseline']]) await git(...args);
  result.originalHead = await git('rev-parse', 'HEAD');
  result.versions = {old: JSON.parse(await fs.readFile(path.join(oldAppRoot, 'package.json'), 'utf8')).version, current: JSON.parse(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8')).version};
  const host = new DesktopHost(profile);
  try {projectId = (await host.pick(project)).project.id;} finally {await host.storage.db.close();}
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  phase = 'old-connect'; await start(oldAppRoot, oldBinary, false, 'old');
  if (await shell.$eval('#configuration-setup', node => node.open)) await shell.click('#configuration-cancel');
  await call('config.initialize', {mode: 'independent'});
  await call('settings.providers.save', {operation:'create',provider:'schema-upgrade-local',baseUrl:'http://127.0.0.1:' + server.address().port + '/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'synthetic-loopback-only'}});
  await call('settings.models.save', Object.fromEntries(['frontdesk', 'orchestrator', 'worker'].map(role => [role, {model:{mode:'explicit',selector:'schema-upgrade-local/scripted'},thinking:{mode:'native-default'}}])));
  await shell.click('[data-project-id="' + projectId + '"]');
  await shell.waitForFunction(id => window.__workspaceScope?.projectId === id, {}, projectId);
  await call('managed.enable', {projectId});
  phase = 'old-history';
  for (const role of roles) await send(role, originals[role], 'schema-upgrade-old-' + role);
  await call('managed.draft', {projectId, target: 'frontdesk', text: draft});
  oldState = await state(); assert.equal(result.requests.length, 2);
  for (const role of roles) {assert(oldState.residents[role].threadId); assert.equal(oldState.residents[role].zeroActivity, false);}
  await save('old-state.json', oldState);
  await shell.screenshot({path: path.join(out, 'old-history.png')});
  phase = 'old-close'; await stop();
  history = {};
  for (const role of roles) {
    const agentHome = oldState.providers[role].home;
    const file = await pinSessionFileById(path.join(agentHome, 'sessions'), oldState.residents[role].threadId);
    const bytes = await fs.readFile(file);
    assert(bytes.toString().includes(originals[role]), 'Real historical native conversation contains original explicit input');
    const tools = await readOmpTerminalToolHistory(agentHome);
    assert(tools.some(defs => digestTools(defs) === oldState.residents[role].toolsDigest), 'Genuine old deployed definitions prove persisted old digest');
    history[role] = {agentHome, file, bytes, tools};
    await fs.writeFile(path.join(out, 'old-' + role + '-session.jsonl'), bytes);
  }
  check('Genuine installed old app creates two nonempty native resident conversations without Work, then exits cleanly');
  phase = 'current-connect'; await start(appRoot, binary, !process.env.NOZELI_TEST_BINARY, 'current');
  await call('managed.connect', {projectId});
  await until(async () => (await status()).ready, 'same-profile current residents ready');
  const connected = await state();
  const assertRetained = async s => {
    assert.equal(result.requests.length, 2, 'Restart/connect never calls model');
    assert.deepEqual(s.jobs, oldState.jobs, 'No original input replay, replacement job or job mutation');
    assert.equal(s.works.length, 0); assert.equal(s.drafts.frontdesk, draft);
    for (const role of roles) {
      assert.equal(s.residents[role].threadId, oldState.residents[role].threadId, 'Keep original ' + role + ' thread');
      assert.equal(s.residents[role].zeroActivity, false);
      const bytes = await fs.readFile(history[role].file);
      assert(bytes.subarray(0, history[role].bytes.length).equals(history[role].bytes), 'Original native history bytes retained verbatim');
      for (const message of oldState.messages.filter(row => row.target === role)) assert(s.messages.some(row => row.id === message.id && JSON.stringify(row) === JSON.stringify(message)), 'Original visible conversation retained exactly');
    }
  };
  await assertRetained(connected);
  result.schemaUpgrade = {};
  for (const role of roles) {
    const oldDigest = oldState.residents[role].toolsDigest, newDigest = connected.residents[role].toolsDigest;
    assert.notEqual(newDigest, oldDigest, 'Actual old/current tool schema digest mismatch required; same-schema run is not upgrade proof');
    const tools = await readOmpTerminalToolHistory(history[role].agentHome);
    assert(tools.some(defs => digestTools(defs) === oldDigest)); assert(tools.some(defs => digestTools(defs) === newDigest));
    result.schemaUpgrade[role] = {threadId: connected.residents[role].threadId, oldDigest, newDigest, originalHistorySha256: hash(history[role].bytes), originalHistoryBytes: history[role].bytes.length};
    await save(role + '-tool-history.json', tools);
  }
  await save('current-connected-state.json', connected);
  phase = 'current-reconnect';
  for (let n = 0; n < 2; n++) {await call('managed.connect', {projectId}); await assertRetained(await state());}
  await pause(1500); await assertRetained(await state());
  await shell.screenshot({path: path.join(out, 'current-reconnected.png')});
  check('Actual changed tool manifests resume exact old threads, native/visible histories and unsent draft; repeated connect makes zero model calls or job replay');
  // A full second current launch also tests durable compatibility after the old
  // digest has been migrated, not just the already-connected fast path.
  phase = 'current-close'; await stop();
  phase = 'current-relaunch'; await start(appRoot, binary, !process.env.NOZELI_TEST_BINARY, 'current-relaunch');
  await call('managed.connect', {projectId}); await until(async () => (await status()).ready, 'current relaunch residents ready');
  await assertRetained(await state());
  result.maintenance = await call('managed.maintenance.status', {projectId});
  assert(!result.maintenance.bugs.some(bug => bug.status !== 'repaired' && /resident-preflight|OMP_TOOLS_DIGEST_MISMATCH/.test(JSON.stringify(bug))), 'Compatible schema upgrade cannot remain masked behind internal maintenance');
  check('Clean current shutdown and fresh-process reconnect durably preserve both original resident sessions without replay');
  phase = 'explicit-new-input';
  await send('orchestrator', explicit, 'schema-upgrade-new-orchestrator');
  const final = await state();
  assert.equal(result.requests.length, 3); assert.equal(result.requests.at(-1).role, 'orchestrator');
  assert.equal(final.drafts.frontdesk, draft); assert.equal(final.works.length, 0);
  assert.equal(final.jobs.length, oldState.jobs.length + 1);
  for (const role of roles) assert.equal(final.residents[role].threadId, oldState.residents[role].threadId);
  assert.equal(await fs.readFile(path.join(project, 'baseline.txt'), 'utf8'), 'SYNTHETIC_SCHEMA_UPGRADE_BASELINE\n');
  assert.equal(await git('rev-parse', 'HEAD'), result.originalHead); assert.equal(await git('status', '--porcelain'), '');
  await save('final-state.json', final); await shell.screenshot({path: path.join(out, 'explicit-new-input.png')});
  check('Only a new explicit harmless input calls the model on the original upgraded native thread; draft and project bytes remain untouched');
  phase = 'final-close'; await stop(); assert.deepEqual(result.errors, []);
  check('All three real Electron launches exit code zero with no surviving owned native descendants or renderer errors');
  result.ok = true;
} catch (error) {
  result.error = {phase, message: error.message, stack: error.stack};
  if (shell) {await shell.screenshot({path: path.join(out, 'failure.png')}).catch(() => {}); await state().then(s => save('failure-state.json', s)).catch(() => {});}
} finally {
  clearInterval(sampler);
  if (child && child.exitCode === null && !child.signalCode && shell) {
    try {await stop();} catch (error) {result.cleanupError = error.message; result.ok = false;}
  }
  await browser?.disconnect().catch(() => {});
  // Failure-only cleanup: signal only descendants sampled under our exact
  // Electron PID, and recheck Linux start ticks before every signal.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const alive = await survivors();
    for (const row of alive.reverse()) {
      if ((await survivors()).some(current => current.pid === row.pid && current.startTicks === row.startTicks)) {
        try {process.kill(row.pid, signal);} catch (error) {if (error.code !== 'ESRCH') result.errors.push(error.message);}
      }
    }
    if (alive.length) await pause(signal === 'SIGTERM' ? 1500 : 300);
  }
  result.finalSurvivors = await survivors(); if (result.finalSurvivors.length) result.ok = false;
  result.processes = [...processes.values()];
  for (const row of result.launches) {await fs.writeFile(path.join(out, row.phase + '-electron.log'), row.log); delete row.log;}
  await new Promise(resolve => server.close(resolve));
  await save('result.json', result);
}
console.log(JSON.stringify({ok: result.ok, out, checks: result.checks, error: result.error, cleanupError: result.cleanupError}));
process.exitCode = result.ok ? 0 : 1;
