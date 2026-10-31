// Opt-in, serial: real Electron + native OMP; synthetic project and loopback model only.
// Supports NOZELI_TEST_APP_ROOT, NOZELI_TEST_BINARY and NOZELI_TEST_EVIDENCE_ROOT.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
import {staticReport} from './static-report.fixture.mjs';

const appRoot = path.resolve(process.env.NOZELI_TEST_APP_ROOT || path.join(import.meta.dirname, '..'));
const binary = process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
const {DesktopHost} = await import(pathToFileURL(path.join(appRoot, 'src/main/host.mjs')));
const {runGit} = await import(pathToFileURL(path.join(appRoot, 'src/agents/managed/git-runtime.mjs')));
const evidenceRoot = path.resolve(process.env.NOZELI_TEST_EVIDENCE_ROOT || path.join(os.homedir(), '.cache/nozeli-smokes'));
await fs.mkdir(evidenceRoot, {recursive: true});
const out = await fs.mkdtemp(path.join(evidenceRoot, 'maintenance-live-'));
const project = path.join(out, 'project'), home = path.join(out, 'home'), config = path.join(out, '.Nozeli'), profile = path.join(config, 'desktop');
const sentinelPath = '.ccb/.codex-demo-session', sentinel = 'SYNTHETIC_ORDINARY_CCB_INPUT_NOT_A_CREDENTIAL\n';
const original = 'original synthetic small file\n', edited = 'accepted synthetic small file\n';
const executable = '#!/bin/sh\nprintf "synthetic executable accepted\\n"\n';
const validation = JSON.stringify({ok: true, sentinel: sentinel.trim(), executable: 'build/delivery.sh'}) + '\n';
const artifacts = ['small.txt', 'build/delivery.sh', 'build/validation.json'];
const result = {ok: false, out, project, appRoot, binary, checks: [], requests: [], errors: [],
  scope: 'Real native OMP under Electron; isolated HOME, loopback model, synthetic Git project; no credentials, paid model, user project, installation or user task replay.',
  boundaries: ['Transient synthetic Git ref lock is a real publication failure, not a fabricated product result.', 'Synthetic project and evidence are retained; cleanup signals only identity-checked descendants of our Electron.']};
let child, exited, browser, shell, projectId, serverError, sampler, sampling = false, log = '', workerStep = 0, dispatchCount = 0, lockPath, lockIdentity, lockOwned = false, maintenanceStep = 0;
const processes = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const git = async (...args) => (await runGit(project, args, {env: {...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'}})).toString().trim();
const check = name => {result.checks.push(name); console.log(JSON.stringify({check: name}));};
async function until(fn, label, ms = 180000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (serverError) throw serverError;
    if (child && child.exitCode !== null) throw Error('Electron exited during ' + label + ': ' + log.slice(-8000));
    const value = await fn(); if (value) return value;
    await pause(100);
  }
  throw Error('Timeout: ' + label);
}
async function call(op, payload = {}, page = shell) {
  const reply = await page.evaluate(({op, payload}) => window.nozeli.invoke(op, payload), {op, payload});
  assert(reply.ok, op + ': ' + JSON.stringify(reply.error)); return reply.value;
}
const state = async () => (await call('managed.status', {projectId})).state;
async function releaseOwnedLock() {
  if (!lockOwned) return;
  const current = await fs.lstat(lockPath).catch(error => {if (error.code !== 'ENOENT') throw error; return null;});
  if (current) {
    assert(current.isFile() && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino, 'Never remove a replaced fault lock');
    await fs.unlink(lockPath);
  }
  lockOwned = false;
}
function lastReply(input) {
  const message = input.messages.findLast(row => row.role === 'tool');
  assert(message, 'Expected an actual native tool response');
  const text = typeof message.content === 'string' ? message.content : message.content.map(part => part.text || '').join('\n');
  assert(!/nozeli host rejected|"isError":true/.test(text), 'Native tool failure: ' + text);
  try {const parsed = JSON.parse(text); assert.notEqual(parsed.ok, false, text); return parsed.value ?? parsed;} catch (error) {if (error instanceof SyntaxError) return text; throw error;}
}
async function sample() {
  if (sampling || !child?.pid) return; sampling = true;
  try {
    const pending = [child.pid], seen = new Set();
    while (pending.length) {
      const pid = pending.pop(); if (seen.has(pid)) continue; seen.add(pid);
      try {
        const [stat, children, command] = await Promise.all([fs.readFile(`/proc/${pid}/stat`, 'utf8'), fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'), fs.readFile(`/proc/${pid}/cmdline`, 'utf8')]);
        pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
        processes.set(pid, {pid, startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], command: command.replaceAll('\0', ' ')});
      } catch (error) {if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;}
    }
  } finally {sampling = false;}
}
async function survivors() {
  const alive = [];
  for (const row of processes.values()) {
    try {const stat = await fs.readFile(`/proc/${row.pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); if (fields[0] !== 'Z' && fields[19] === row.startTicks) alive.push(row.pid);}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  return alive;
}
const tool = (name, args, id) => ({role: 'assistant', tool_calls: [{index: 0, id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]});
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const workerCode = `const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(fs.readFileSync(${JSON.stringify(path.join(project, sentinelPath))},'utf8'),${JSON.stringify(sentinel)});assert.equal(fs.readFileSync('small.txt','utf8'),${JSON.stringify(edited)});fs.mkdirSync('build',{recursive:true});fs.writeFileSync('build/delivery.sh',${JSON.stringify(executable)},{mode:0o755});fs.writeFileSync('build/validation.json',${JSON.stringify(validation)});assert.equal(require('node:child_process').execFileSync('./build/delivery.sh',{encoding:'utf8'}),'synthetic executable accepted\\n');console.log('native ordinary source read, host edit and ignored executable validation passed');`;
const workerCommand = quote(process.execPath) + ' -e ' + quote(workerCode);
const reportHtml = staticReport('The actual Worker read the synthetic .ccb sentinel through the host and native filesystem, edited small.txt and generated an ignored executable and validation JSON. These are isolated candidates, not yet accepted project bytes.');
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', chunk => {body += chunk;});
  req.on('end', async () => {
    try {
      assert(req.url.startsWith('/v1/'));
      const input = JSON.parse(body), names = (input.tools || []).map(row => row.function?.name);
      let delta, finish = 'tool_calls';
      if (names.includes('nozeli_publish')) {
        switch (workerStep++) {
          case 0: delta = tool('nozeli_document_read', {relPath: sentinelPath}, 'maintenance-source-read'); break;
          case 1: {
            const read = lastReply(input); assert.equal(read.text, sentinel); assert(read.provenance, 'Host must identify the actual source');
            assert(['project-source', 'worktree'].includes(read.provenance.kind));
            const actual = path.join(read.provenance.root, sentinelPath); assert.equal(await fs.readFile(actual, 'utf8'), sentinel);
            result.workerSourceRead = read; delta = tool('nozeli_document_read', {relPath: 'small.txt'}, 'maintenance-small-read'); break;
          }
          case 2: {
            const read = lastReply(input); assert.equal(read.text, original); assert(read.readHandle);
            delta = tool('nozeli_document_apply', {readHandle: read.readHandle, replacements: [{oldText: original, newText: edited}]}, 'maintenance-small-edit'); break;
          }
          case 3: result.workerEdit = lastReply(input); delta = tool('bash', {command: workerCommand}, 'maintenance-native-generate'); break;
          case 4: {
            result.nativeCommandReply = lastReply(input);
            const s = await state(); assert.equal(s.works.length, 1); const work = s.works[0]; result.originalWork = structuredClone(work);
            assert(work.execution.branchRef.startsWith('refs/heads/nozeli/'));
            lockPath = path.join(work.execution.commonDir, work.execution.branchRef + '.lock');
            assert(lockPath.startsWith(path.join(project, '.git') + path.sep));
            await fs.mkdir(path.dirname(lockPath), {recursive: true}); await fs.writeFile(lockPath, 'owned synthetic transient publication fault\n', {flag: 'wx'}); lockOwned = true;
            const identity = await fs.lstat(lockPath); lockIdentity = {dev: identity.dev, ino: identity.ino};
            result.injectedFault = {kind: 'owned-candidate-ref-lock', path: lockPath, workId: work.id};
            delta = tool('nozeli_publish', {kind: 'result', html: reportHtml, files: artifacts}, 'maintenance-publish-once'); break;
          }
          default: throw Error('Worker replayed after single publication: ' + JSON.stringify(input.messages.at(-1)));
        }
      } else if (names.includes('nozeli_dispatch')) {
        const maintenance = await call('managed.maintenance.status', {projectId});
        const bugs = maintenance.bugs;
        assert(Array.isArray(bugs), 'Actual versioned maintenance ledger');
        if (bugs.length) {
          assert(names.includes('nozeli_maintenance'), 'Actual maintenance tool must be exposed to Orchestrator');
          assert(maintenanceStep < 3, 'Maintenance retry loop');
          if (maintenanceStep++ === 0) {result.observedMaintenance = maintenance; delta = tool('nozeli_maintenance', {action: 'status'}, 'maintenance-observe');}
          else if (maintenanceStep === 2) {
            result.maintenanceStatusReply = lastReply(input);
            const bug = bugs.find(row => row.workId === result.originalWork.id) || bugs[0]; result.bugId = bug.id;
            assert(result.bugId, 'Real host maintenance bug identity');
            result.failedMaintenance = await until(async () => {
              const ledger = await call('managed.maintenance.status', {projectId}), row = ledger.bugs.find(entry => entry.id === result.bugId);
              return row?.attempts[0]?.status === 'unverified' ? ledger : null;
            }, 'observed actual failed host recovery before lock release', 30000);
            assert(lockOwned); await releaseOwnedLock();
            delta = tool('nozeli_maintenance', {action: 'retry', bugId: result.bugId}, 'maintenance-real-host-retry');
          } else {result.maintenanceRetryReply = lastReply(input); delta = {role: 'assistant', content: 'Host recovery has been attempted; its observed maintenance ledger is authoritative.'}; finish = 'stop';}
        } else if (dispatchCount === 0) {
          dispatchCount++;
          delta = tool('nozeli_dispatch', {name: 'Synthetic maintenance delivery', brief: 'Read synthetic .ccb sentinel through host and native access, host-edit small.txt, generate ignored build executable and validation JSON, publish all three exact artifacts once. Preserve original source until explicit acceptance.'}, 'maintenance-dispatch');
        } else {delta = {role: 'assistant', content: 'The original synthetic Work has been dispatched; no replacement Work is needed.'}; finish = 'stop';}
      } else {delta = {role: 'assistant', content: 'The synthetic delivery remains subject to explicit user acceptance.'}; finish = 'stop';}
      result.requests.push({tool: delta.tool_calls?.[0]?.function.name || 'final', at: new Date().toISOString()});
      assert(result.requests.length <= 20, 'Native model protocol replay limit');
      res.writeHead(200, {'content-type': 'text/event-stream'});
      for (const [part, end] of [[delta, null], [{}, finish]]) res.write('data: ' + JSON.stringify({id: 'maintenance-' + result.requests.length, object: 'chat.completion.chunk', choices: [{index: 0, delta: part, finish_reason: end}]}) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (error) {serverError = error; res.destroy(error);}
  });
});
try {
  await fs.mkdir(project); await fs.mkdir(home); await fs.mkdir(path.join(project, '.ccb'));
  await fs.writeFile(path.join(project, '.gitignore'), '/.nozeli/\n/build/\n');
  await fs.writeFile(path.join(project, sentinelPath), sentinel); await fs.writeFile(path.join(project, 'small.txt'), original);
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Synthetic maintenance'); await git('config', 'user.email', 'synthetic@localhost');
  await git('add', '--all'); await git('commit', '-m', 'Synthetic ordinary source input');
  assert((await git('ls-files', '--', sentinelPath)).includes(sentinelPath)); result.originalHead = await git('rev-parse', 'HEAD');
  const host = new DesktopHost(profile); try {projectId = (await host.pick(project)).project.id;} finally {await host.storage.db.close();}
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = await new Promise(resolve => {const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => {const value = socket.address().port; socket.close(() => resolve(value));});});
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)) delete env[key];
  Object.assign(env, {HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'), NOZELI_OMP_SOURCE_HOME: home, NOZELI_CONFIG_ROOT: config, NOZELI_USER_DATA: profile, NOZELI_TEST_INSTANCE: '1', NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0'});
  child = spawn(binary, [...(process.env.NOZELI_TEST_BINARY ? [] : [path.join(appRoot, 'src/main/main.cjs')]), '--ozone-platform=' + (process.env.NOZELI_OZONE || 'wayland')], {cwd: project, env, stdio: ['ignore', 'pipe', 'pipe']});
  child.on('error', error => {serverError = error;}); exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {log += chunk;});
  sampler = setInterval(() => {sample().catch(error => {result.errors.push(error.message);});}, 100);
  browser = await until(() => puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null}).catch(() => null), 'Electron CDP', 45000);
  shell = await until(async () => {for (const page of await browser.pages()) if (await page.evaluate(() => window.__nozeliReady && window.__workspaceScope?.role === 'shell').catch(() => false)) return page;}, 'shell');
  shell.on('pageerror', error => result.errors.push(error.message));
  if (await shell.$eval('#configuration-setup', node => node.open)) await shell.click('#configuration-cancel');
  await call('config.initialize', {mode: 'independent'});
  await call('settings.providers.save', {operation:'create',provider:'maintenance-local',baseUrl:'http://127.0.0.1:' + server.address().port + '/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'synthetic-loopback-only'}});
  await call('settings.models.save', {frontdesk:{model:{mode:'explicit',selector:'maintenance-local/scripted'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'explicit',selector:'maintenance-local/scripted'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'maintenance-local/scripted'},thinking:{mode:'native-default'}}});
  await shell.click('[data-project-id="' + projectId + '"]'); await shell.waitForFunction(id => window.__workspaceScope?.projectId === id, {}, projectId);
  await call('managed.enable', {projectId});
  const sourceRead = await call('file.read', {projectId, relPath: sentinelPath}); assert.equal(sourceRead.text, sentinel); result.sourceRead = sourceRead;
  await call('managed.task', {projectId, requestKey: 'synthetic-maintenance-task', text: 'In one isolated synthetic Work, read .ccb/.codex-demo-session via the host and actual native filesystem, host-edit small.txt, generate and execute build/delivery.sh and create build/validation.json. Publish small.txt and both ignored build artifacts once. Do not modify Git, touch other projects, or accept results. Program faults are internal maintenance, not user business questions.'});
  const work = await until(async () => {
    const s = await state(); assert(s.works.length <= 1, 'Maintenance must not create replacement Work');
    assert(!s.todos.some(row => ['problem', 'question', 'recovery', 'system'].includes(row.kind) && row.status === 'open'), 'Internal failure must not become a user question or recovery todo');
    const w = s.works[0]; return w?.status === 'review' && !s.busyTargets.includes(w.id) ? w : null;
  }, 'same Work repaired publication');
  assert.equal(work.id, result.originalWork.id); assert.equal(work.threadId, result.originalWork.threadId); assert.equal(workerStep, 5);
  assert(maintenanceStep >= 2, 'Automatic maintenance Orchestrator actually observed and retried');
  result.repairedMaintenance = await call('managed.maintenance.status', {projectId});
  const repaired = result.repairedMaintenance.bugs.find(row => row.id === result.bugId); assert(repaired);
  assert.equal(repaired.status, 'repaired'); assert.equal(repaired.lastOutcome.verified, true); assert.equal(repaired.phase, 'publication');
  assert.equal(repaired.workId, work.id); assert.equal(repaired.attempts.length, 2);
  assert.deepEqual(repaired.attempts.map(row => row.status), ['unverified', 'verified']);
  assert.equal(result.requests.filter(row => row.tool === 'bash').length, 1); assert.equal(result.requests.filter(row => row.tool === 'nozeli_publish').length, 1);
  const workerJobs = (await state()).jobs.filter(row => row.target === work.id && row.type === 'initial');
  assert.equal(workerJobs.length, 1); assert.equal(repaired.jobId, workerJobs[0].id);
  assert.equal(await git('rev-parse', 'HEAD'), result.originalHead); assert.equal(await fs.readFile(path.join(project, 'small.txt'), 'utf8'), original);
  assert.equal(await fs.stat(path.join(project, 'build')).then(() => true, () => false), false);
  assert.equal(await fs.readFile(path.join(project, sentinelPath), 'utf8'), sentinel);
  check('Tracked .ccb source is readable by actual host/native tools; real publication failure automatically routes to same-project maintenance without Worker replay or user question');
  const published = await state(), receipt = published.receipts.find(row => row.workId === work.id && row.kind === 'result'); assert(receipt); result.receipt = receipt;
  const cas = path.join(project, '.nozeli/objects/sha256');
  for (const rel of artifacts) {
    const file = receipt.snapshot.files.find(row => row.relPath === rel); assert(file, 'Frozen ignored delivery: ' + rel);
    assert.equal(digest(await fs.readFile(path.join(work.execution.directory, rel))), file.digest);
    assert.equal(digest(await fs.readFile(path.join(cas, file.objectDigest || file.digest))), file.digest);
  }
  assert((await fs.stat(path.join(work.execution.directory, 'build/delivery.sh'))).mode & 0o111);
  check('Complete declared ignored executable and validation JSON freeze into actual immutable CAS before acceptance');
  await fs.writeFile(path.join(out, 'published-state.json'), JSON.stringify(published, null, 2));
  if (await shell.$eval('#toggle-sidebar', node => node.getAttribute('aria-expanded') !== 'true')) await shell.click('#toggle-sidebar');
  const todo = published.todos.find(row => row.objectId === receipt.objectId && row.kind === 'result'); assert(todo);
  await shell.waitForSelector('[data-managed-todo="' + todo.id + '"]', {visible: true}); await shell.screenshot({path: path.join(out, 'maintenance-published.png')});
  await shell.click('[data-managed-todo="' + todo.id + '"]');
  const review = await until(async () => {for (const page of await browser.pages()) if (await page.$eval('[data-review-action="accept"]:not([disabled])', node => node.getClientRects().length > 0).catch(() => false)) return page;}, 'real report UI');
  await review.screenshot({path: path.join(out, 'report-before-accept.png')}); await review.click('[data-review-action="accept"]');
  await review.waitForSelector('[data-confirmation-confirm]', {visible: true}); await review.click('[data-confirmation-confirm]');
  const ended = await until(async () => {const w = (await state()).works.find(row => row.id === work.id); if (w.closure?.phase === 'blocked') throw Error(JSON.stringify(w.closure)); return w.closure?.phase === 'complete' ? w : null;}, 'host acceptance');
  assert.equal(ended.outcome, 'accept'); assert.notEqual(await git('rev-parse', 'HEAD'), result.originalHead);
  for (const rel of artifacts) {const frozen = receipt.snapshot.files.find(row => row.relPath === rel); assert.equal(digest(await fs.readFile(path.join(project, rel))), frozen.digest);}
  assert.equal(await fs.readFile(path.join(project, 'small.txt'), 'utf8'), edited); assert.equal(await fs.readFile(path.join(project, 'build/delivery.sh'), 'utf8'), executable); assert.equal(await fs.readFile(path.join(project, 'build/validation.json'), 'utf8'), validation);
  assert((await fs.stat(path.join(project, 'build/delivery.sh'))).mode & 0o111);
  assert.equal(await fs.readFile(path.join(project, sentinelPath), 'utf8'), sentinel); assert.equal(await git('status', '--porcelain'), '');
  assert.equal(await fs.stat(work.execution.directory).then(() => true, () => false), false);
  const final = await state(); assert.deepEqual(final.receipts.find(row => row.id === receipt.id), receipt); result.finalMaintenance = await call('managed.maintenance.status', {projectId});
  await review.waitForFunction(() => document.querySelector('[data-review-status]')?.textContent.includes('已合入')); await review.screenshot({path: path.join(out, 'report-accepted.png')});
  await fs.writeFile(path.join(out, 'final-state.json'), JSON.stringify(final, null, 2));
  check('Explicit real UI acceptance integrates exact declared bytes and executable mode while preserving tracked .ccb and original receipt');
  await sample(); assert([...processes.values()].some(row => /(?:^|\/)omp(?:\s|$)/.test(row.command)), 'Observed actual native OMP descendant');
  await until(async () => !(await state()).busyTargets.length, 'settled native turns'); await call('session.requestClose');
  result.exit = await Promise.race([exited, pause(45000).then(() => null)]); assert.deepEqual(result.exit, {code: 0, signal: null});
  for (let n = 0; n < 50 && (await survivors()).length; n++) await pause(100);
  result.normalExitSurvivors = await survivors(); assert.deepEqual(result.normalExitSurvivors, []); assert.deepEqual(result.errors, []);
  check('Native OMP observed; normal Electron exit code zero with no owned surviving descendants or renderer errors'); result.ok = true;
} catch (error) {
  result.error = error.stack; process.exitCode = 1;
  if (shell) {await shell.screenshot({path: path.join(out, 'failure.png')}).catch(() => {}); await fs.writeFile(path.join(out, 'failure-state.json'), JSON.stringify(await state().catch(() => null), null, 2));}
} finally {
  clearInterval(sampler);
  await releaseOwnedLock().catch(error => {result.errors.push('Fault lock cleanup: ' + error.message); process.exitCode = 1;});
  if (child?.exitCode === null) {
    await Promise.race([call('session.requestClose').catch(() => {}), pause(2000)]); await Promise.race([exited, pause(8000)]);
    if (child.exitCode === null) {await sample().catch(() => {}); child.kill('SIGTERM'); await Promise.race([exited, pause(5000)]); if (child.exitCode === null) {child.kill('SIGKILL'); await exited;}}
  }
  result.cleanupSignalled = [];
  for (const signal of ['SIGTERM', 'SIGKILL']) {const alive = await survivors(); for (const pid of alive) {try {process.kill(pid, signal); result.cleanupSignalled.push({pid, signal});} catch (error) {if (error.code !== 'ESRCH') throw error;}} if (alive.length) await pause(500);}
  result.cleanupSurvivors = await survivors(); await browser?.disconnect().catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); result.processes = [...processes.values()];
  await fs.writeFile(path.join(out, 'electron.log'), log); await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
