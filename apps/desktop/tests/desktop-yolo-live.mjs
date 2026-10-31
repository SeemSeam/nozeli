// Opt-in, serial real Electron/native OMP test; never uses a remote model or user project.
// Source default; installed support: NOZELI_TEST_APP_ROOT + NOZELI_TEST_BINARY.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
import {staticReport} from './static-report.fixture.mjs';

const appRoot = path.resolve(process.env.NOZELI_TEST_APP_ROOT || path.join(import.meta.dirname, '..'));
const binary = process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
const {DesktopHost} = await import(pathToFileURL(path.join(appRoot, 'src/main/host.mjs')));
const evidenceRoot = path.resolve(process.env.NOZELI_TEST_EVIDENCE_ROOT || path.join(os.homedir(), '.cache/nozeli-smokes'));
await fs.mkdir(evidenceRoot, {recursive: true});
const out = await fs.mkdtemp(path.join(evidenceRoot, 'yolo-live-'));
const project = path.join(out, 'registered-A'), external = path.join(out, 'unregistered-B');
const home = path.join(out, 'home'), config = path.join(out, '.Nozeli'), profile = path.join(config, 'desktop');
const ordinary = 'SYNTHETIC_EXTERNAL_ORDINARY_TEXT\n', externalEdited = 'SYNTHETIC_EXTERNAL_EDITED_TEXT\n';
const sentinel = 'SYNTHETIC_CCB_SENTINEL_NOT_A_CREDENTIAL\n';
const original = 'Synthetic A original\n', candidate = 'Synthetic A accepted candidate\n';
const workName = 'Synthetic YOLO continuation';
const result = {ok: false, out, appRoot, binary, project, external, checks: [], requests: [], errors: [],
  scope: 'Real Electron/native OMP host tools and current-user commands; loopback deterministic provider; isolated HOME; synthetic registered A/unregistered B; no credentials, installation or user task replay.',
  boundaries: ['Admin command only writes a synthetic marker, but is denied before any execution or OS authentication.', 'Native YOLO is not a shell-classifier sandbox. No dangerous command, system modification or actual elevation is attempted.', 'Only identity-checked descendants of this Electron may be signalled on failure; synthetic evidence is retained.']};
let child, exited, browser, shell, projectId, serverError, sampler, sampling = false, log = '';
let phase = 'ordinary', frontStep = 0, workerStep = 0, dispatched = 0, continued = 0;
const processes = new Map(), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = name => {result.checks.push(name); console.log(JSON.stringify({check: name}));};
const exists = file => fs.access(file).then(() => true, error => {if (error.code === 'ENOENT') return false; throw error;});
async function until(fn, label, ms = 180000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (serverError) throw serverError;
    if (child && (child.exitCode !== null || child.signalCode)) throw Error('Electron exited during ' + label + ': ' + log.slice(-8000));
    const value = await fn(); if (value) return value;
    await pause(100);
  }
  throw Error('Timeout: ' + label + '; no automatic replay');
}
async function call(op, payload = {}, page = shell) {
  const reply = await page.evaluate(({op, payload}) => window.nozeli.invoke(op, payload), {op, payload});
  assert(reply.ok, op + ': ' + JSON.stringify(reply.error)); return reply.value;
}
const state = async () => (await call('managed.status', {projectId})).state;
async function reviewOnly(s) {
  const rendered=await shell.$$eval('[data-todo-row]',nodes=>nodes.filter(node=>node.getClientRects().length).map(node=>node.dataset.todoRow));
  for(const id of rendered){const row=s.todos.find(todo=>todo.id===id);assert(row&&(row.kind==='result'||row.destination?.kind==='effect-permission'),'Only result review and concrete dangerous-operation permission belong in rendered user todos');}
  assert(!s.todos.some(row=>row.status==='open'&&row.userActionable===true&&row.kind!=='result'&&row.destination?.kind!=='effect-permission'),'No other kind may be declared user actionable');
}
async function settled() {return until(async () => {const s = await state(); await reviewOnly(s); const failed = s.jobs.find(row => row.status === 'failed'); if (failed) throw Error(JSON.stringify(failed)); return !s.busyTargets.length && s;}, 'settled native turns');}
function lastReply(input) {
  const message = input.messages.findLast(row => row.role === 'tool'); assert(message, 'Actual native host tool reply required');
  const text = typeof message.content === 'string' ? message.content : message.content.map(part => part.text || '').join('\n');
  assert(!/nozeli host rejected|Validation failed for tool|"isError":true/.test(text), text);
  try {const value = JSON.parse(text); assert.notEqual(value.ok, false, text); return value.value ?? value;} catch (error) {if (error instanceof SyntaxError) return text; throw error;}
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
        const startTicks=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],argv=command.split('\0').filter(Boolean),previous=processes.get(pid);
        processes.set(pid,{pid,startTicks,argv:argv.length?argv:previous?.startTicks===startTicks?previous.argv:[]});
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
const effect = (name, elevation) => ({command: process.execPath, args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(path.join(external, name))},'EXECUTED_ONCE\\n')`], cwd: external, purpose: 'Synthetic harmless marker only; administrator variant must await explicit denial without authentication.', elevation});
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const nativeCommand = quote(process.execPath) + ' -e ' + quote(`const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(fs.readFileSync(${JSON.stringify(path.join(external, '.ccb/sentinel.txt'))},'utf8'),${JSON.stringify(sentinel)});assert.equal(fs.readFileSync(${JSON.stringify(path.join(external, 'ordinary.txt'))},'utf8'),${JSON.stringify(externalEdited)});fs.writeFileSync(${JSON.stringify(path.join(external, 'native.txt'))},'NATIVE_CURRENT_USER\\n');console.log('native external sentinel read verified');`);
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', chunk => {body += chunk;});
  req.on('end', async () => {
    try {
      assert(req.url.startsWith('/v1/')); const input = JSON.parse(body), names = (input.tools || []).map(row => row.function?.name);
      let delta, finish = 'tool_calls';
      if (names.includes('nozeli_publish')) {
        switch (workerStep++) {
          case 0: delta = tool('nozeli_document_read', {relPath: 'small.txt'}, 'yolo-worker-read'); break;
          case 1: {const read = lastReply(input); assert.equal(read.text, original); delta = tool('nozeli_document_apply', {readHandle: read.readHandle, replacements: [{oldText: original, newText: candidate}]}, 'yolo-worker-edit'); break;}
          case 2: {
            result.workerEdit = lastReply(input); const s = await state(); assert.equal(s.works.length, 1); result.originalWork = structuredClone(s.works[0]);
            delta = tool('nozeli_publish', {kind: 'problem', text: 'Ordinary reversible question: should this synthetic report use the concise default? Existing task permits a concise report. Retain the edited candidate and continue this same Work using the reversible default; no user authorization is requested.', files: ['small.txt']}, 'yolo-ordinary-problem'); break;
          }
          case 3: assert.equal(continued, 1, 'Orchestrator must continue original Work once'); delta = tool('nozeli_document_read', {relPath: 'small.txt'}, 'yolo-resumed-read'); break;
          case 4: {const read = lastReply(input); assert.equal(read.text, candidate, 'Continuation retains prior candidate'); delta = tool('nozeli_publish', {kind: 'result', html: staticReport('The native host edited the isolated A candidate; Orchestrator handled the ordinary question and continued the original Work once. External B host/native access and current-user execution produced actual synthetic evidence without permission todos. Accept explicitly to integrate small.txt.'), files: ['small.txt']}, 'yolo-result'); break;}
          default: throw Error('Unexpected Worker replay');
        }
      } else if (names.includes('nozeli_dispatch')) {
        const s = await state(); await reviewOnly(s);
        if (!dispatched) {dispatched++; delta = tool('nozeli_dispatch', {name: workName, brief: 'Host-edit small.txt in isolation, publish one ordinary reversible problem, then continue this SAME Work with the concise default and publish the actual candidate result. No new scope or sensitive action.'}, 'yolo-dispatch');}
        else {
          const work = s.works.find(row => row.name === workName);
          if (work?.status === 'paused' && !continued) {assert(names.includes('nozeli_problem_continue'), 'Source-bound backstage continuation tool exposed'); continued++; result.continuationState = s; delta = tool('nozeli_problem_continue', {workId: work.id, revision: work.revision, objectId: work.problem.objectId, text: 'Use the concise reversible default already permitted by the original task. Preserve candidate progress and continue this exact Work to its final result. No command replay, new scope, sensitive effect or user authorization.'}, 'yolo-continue-once');}
          else {delta = {role: 'assistant', content: 'No additional dispatch or continuation is needed.'}; finish = 'stop';}
        }
      } else if (phase === 'ordinary') {
        switch (frontStep++) {
          case 0: delta = tool('nozeli_project_list', {projectPath: external, relPath: ''}, 'yolo-external-list'); break;
          case 1: result.externalList = lastReply(input); assert(JSON.stringify(result.externalList).includes('ordinary.txt')); delta = tool('nozeli_document_read', {projectPath: external, relPath: '.ccb/sentinel.txt'}, 'yolo-sentinel-read'); break;
          case 2: result.sentinelRead = lastReply(input); assert.equal(result.sentinelRead.text, sentinel); delta = tool('nozeli_document_read', {projectPath: external, relPath: 'ordinary.txt'}, 'yolo-external-read'); break;
          case 3: {const read = lastReply(input); assert.equal(read.text, ordinary); assert(read.readHandle); assert.equal(await exists(path.join(external, '.nozeli')), false, 'Mere reads create no external metadata'); assert.deepEqual((await call('project.recent')).projects.map(row => row.id), [projectId], 'Mere reads do not register B'); delta = tool('nozeli_document_apply', {readHandle: read.readHandle, replacements: [{oldText: ordinary, newText: externalEdited}]}, 'yolo-external-edit'); break;}
          case 4: result.externalEdit = lastReply(input); delta = tool('bash', {command: nativeCommand}, 'yolo-native-current-user'); break;
          case 5: result.nativeReply = lastReply(input); delta = tool('nozeli_privileged_execute', effect('user.txt', 'user'), 'yolo-user-effect'); break;
          case 6: result.userEffectReply = lastReply(input); delta = {role: 'assistant', content: 'Observed real host and native ordinary execution; no user permission required.'}; finish = 'stop'; break;
          default: throw Error('Ordinary frontdesk command replay');
        }
      } else if (phase === 'admin' && frontStep++ === 0) delta = tool('nozeli_privileged_execute', effect('admin-denied.txt', 'admin'), 'yolo-admin-request');
      else {delta = {role: 'assistant', content: 'Explicit denial is binding. Do not execute, authenticate, substitute bash, or re-request.'}; finish = 'stop';}
      result.requests.push({phase, tool: delta.tool_calls?.[0]?.function.name || 'final', at: new Date().toISOString()}); assert(result.requests.length <= 35, 'Bounded deterministic protocol');
      res.writeHead(200, {'content-type': 'text/event-stream'});
      for (const [part, end] of [[delta, null], [{}, finish]]) res.write('data: ' + JSON.stringify({id: 'yolo-' + result.requests.length, object: 'chat.completion.chunk', choices: [{index: 0, delta: part, finish_reason: end}]}) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (error) {serverError = error; res.destroy(error);}
  });
});
try {
  await fs.mkdir(project); await fs.mkdir(home); await fs.mkdir(path.join(external, '.ccb'), {recursive: true});
  await fs.writeFile(path.join(project, 'small.txt'), original); await fs.writeFile(path.join(project, '.gitignore'), '/.nozeli/\n');
  await fs.writeFile(path.join(external, 'ordinary.txt'), ordinary); await fs.writeFile(path.join(external, '.ccb/sentinel.txt'), sentinel);
  const host = new DesktopHost(profile); try {projectId = (await host.pick(project)).project.id;} finally {await host.storage.db.close();}
  assert.equal(await exists(path.join(external, '.nozeli')), false);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = await new Promise(resolve => {const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => {const value = socket.address().port; socket.close(() => resolve(value));});});
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'SSH_ASKPASS'].includes(key)) delete env[key];
  Object.assign(env, {HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', NOZELI_OMP_SOURCE_HOME: home, NOZELI_CONFIG_ROOT: config, NOZELI_USER_DATA: profile, NOZELI_TEST_INSTANCE: '1', NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0'});
  child = spawn(binary, [...(process.env.NOZELI_TEST_BINARY ? [] : [path.join(appRoot, 'src/main/main.cjs')]), '--ozone-platform=' + (process.env.NOZELI_OZONE || 'wayland')], {cwd: project, env, stdio: ['ignore', 'pipe', 'pipe']});
  child.on('error', error => {serverError = error;}); exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {log += chunk;});
  sampler = setInterval(() => {sample().catch(error => {result.errors.push(error.message);});}, 50);
  browser = await until(() => puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null}).catch(() => null), 'Electron CDP', 45000);
  shell = await until(async () => {for (const page of await browser.pages()) if (await page.evaluate(() => window.__nozeliReady && window.__workspaceScope?.role === 'shell').catch(() => false)) return page;}, 'shell');
  shell.on('pageerror', error => result.errors.push(error.message));
  if (await shell.$eval('#configuration-setup', node => node.open)) await shell.click('#configuration-cancel');
  await call('config.initialize', {mode: 'independent'});
  await call('settings.providers.save', {operation:'create',provider:'yolo-local',baseUrl:'http://127.0.0.1:' + server.address().port + '/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'synthetic-loopback-only'}});
  await call('settings.models.save', {frontdesk:{model:{mode:'explicit',selector:'yolo-local/scripted'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'explicit',selector:'yolo-local/scripted'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'yolo-local/scripted'},thinking:{mode:'native-default'}}});
  await shell.click('[data-project-id="' + projectId + '"]'); await shell.waitForFunction(id => window.__workspaceScope?.projectId === id, {}, projectId);
  await call('managed.enable', {projectId}); await until(async () => (await call('managed.status', {projectId})).ready, 'native owners');
  await call('managed.send', {projectId, target: 'frontdesk', requestKey: 'synthetic-yolo-ordinary', text: 'Use host list/read/apply on the unregistered synthetic directory ' + external + ', including .ccb/sentinel.txt. Edit ordinary.txt to the exact synthetic replacement, run the harmless native verification command and current-user nozeli_privileged_execute marker once. These ordinary operations need no permission todo. Never register B or create .nozeli there.'});
  await until(() => frontStep === 7, 'ordinary host tool sequence');
  const ordinaryState = await settled(); assert.equal(frontStep, 7); assert(!ordinaryState.todos.some(row => row.status === 'open'));
  assert.equal(await fs.readFile(path.join(external, 'ordinary.txt'), 'utf8'), externalEdited); assert.equal(await fs.readFile(path.join(external, '.ccb/sentinel.txt'), 'utf8'), sentinel);
  result.registryAfterOrdinary = await call('project.recent');
  assert.deepEqual(result.registryAfterOrdinary.projects.map(row => row.id), [projectId], 'External B is not auto-registered by ordinary reads or edits');
  assert.equal(await fs.readFile(path.join(external, 'native.txt'), 'utf8'), 'NATIVE_CURRENT_USER\n'); assert.equal(await fs.readFile(path.join(external, 'user.txt'), 'utf8'), 'EXECUTED_ONCE\n');
  assert.equal(await exists(path.join(external, '.nozeli')), false); await shell.screenshot({path: path.join(out, 'ordinary-no-permission.png')});
  await fs.writeFile(path.join(out, 'ordinary-state.json'), JSON.stringify(ordinaryState, null, 2));
  check('Native host list/read/edit and .ccb read in unregistered B plus native bash and user-level privileged tool execute with no todo or B metadata');
  phase = 'work';
  await call('managed.task', {projectId, requestKey: 'synthetic-yolo-work', text: 'Create one synthetic Work, host-edit small.txt, publish an ordinary question about concise report style, then let Orchestrator use the reversible concise default and continue the same Work exactly once. Publish a real result for explicit user acceptance. Never turn the ordinary problem into a user answer todo.'});
  const work = await until(async () => {const s = await state(); await reviewOnly(s); assert(s.works.length <= 1, 'No replacement Work'); const w = s.works[0]; return w?.status === 'review' && !s.busyTargets.includes(w.id) ? w : null;}, 'ordinary problem handled by Orchestrator');
  assert.equal(dispatched, 1); assert.equal(continued, 1); assert.equal(workerStep, 5); assert.equal(work.id, result.originalWork.id); assert.equal(work.threadId, result.originalWork.threadId); assert.equal(work.execution.directory, result.originalWork.execution.directory);
  assert.equal(await fs.readFile(path.join(project, 'small.txt'), 'utf8'), original); assert.equal(await fs.readFile(path.join(work.execution.directory, 'small.txt'), 'utf8'), candidate);
  const published = await state(); await reviewOnly(published); result.publishedState = published;
  assert.equal(published.jobs.filter(row => row.target === work.id).length, 2, 'One initial and one same-Work continuation');
  const receipt = published.receipts.find(row => row.workId === work.id && row.kind === 'result'); assert(receipt); result.receipt = receipt;
  const todo = published.todos.find(row => row.objectId === receipt.objectId && row.kind === 'result' && row.status === 'open'); assert(todo);
  check('Ordinary Worker problem reaches Orchestrator and continues original Work/thread/candidate exactly once without user answer todo');
  if (await shell.$eval('#toggle-sidebar', node => node.getAttribute('aria-expanded') !== 'true')) await shell.click('#toggle-sidebar');
  await shell.waitForSelector('[data-managed-todo="' + todo.id + '"]', {visible: true}); await shell.screenshot({path: path.join(out, 'result-only-todo.png')}); await shell.click('[data-managed-todo="' + todo.id + '"]');
  const review = await until(async () => {for (const page of await browser.pages()) if (await page.$eval('[data-review-action="accept"]:not([disabled])', node => node.getClientRects().length > 0).catch(() => false)) return page;}, 'actual result review UI');
  await review.screenshot({path: path.join(out, 'result-before-accept.png')}); await review.click('[data-review-action="accept"]'); await review.waitForSelector('[data-confirmation-confirm]', {visible: true}); await review.click('[data-confirmation-confirm]');
  const ended = await until(async () => {const w = (await state()).works.find(row => row.id === work.id); if (w.closure?.phase === 'blocked') throw Error(JSON.stringify(w.closure)); return w.closure?.phase === 'complete' ? w : null;}, 'explicit UI acceptance');
  assert.equal(ended.outcome, 'accept'); assert.equal(await fs.readFile(path.join(project, 'small.txt'), 'utf8'), candidate);
  assert.deepEqual((await state()).receipts.find(row => row.id === receipt.id), receipt); await review.waitForFunction(() => document.querySelector('[data-review-status]')?.textContent.includes('已合入')); await review.screenshot({path: path.join(out, 'result-accepted.png')});
  check('Real result-review acceptance integrates actual A candidate bytes and preserves immutable receipt; frontdesk B edit was direct current-user work, not deferred until acceptance');
  phase = 'admin'; frontStep = 0;
  await call('managed.send', {projectId, target: 'frontdesk', requestKey: 'synthetic-yolo-admin', text: 'Request exactly this harmless marker command with elevation admin using nozeli_privileged_execute: ' + JSON.stringify(effect('admin-denied.txt', 'admin')) + '. Wait for the real user permission todo. Never run it, authenticate, or substitute bash before a decision. This test will explicitly deny.'});
  const permission = await until(async () => {const s = await state(); await reviewOnly(s); const permissions = s.todos.filter(row => row.status === 'open' && row.destination?.kind === 'effect-permission'); assert(permissions.length <= 1, 'Only one real administrator permission pending'); return permissions[0];}, 'real admin permission todo');
  result.adminTodo = permission; assert.equal(await exists(path.join(external, 'admin-denied.txt')), false); await pause(500); assert.equal(await exists(path.join(external, 'admin-denied.txt')), false);
  await shell.evaluate(id => window.__workspaceOpenTodo(id), permission.id);
  const selector = 'section[data-attention-kind="effect-permission"][data-attention-id="' + permission.destination.requestId + '"]';
  const decision = await until(async () => {for (const page of await browser.pages()) if (await page.$(selector).catch(() => null)) return page;}, 'real administrator decision surface');
  assert.equal(await decision.$$eval(selector + ' input', nodes => nodes.some(node => node.checked)), false, 'No default approval');
  await decision.screenshot({path: path.join(out, 'admin-before-denial.png')}); await decision.click(selector + ' input[data-attention-permission-action="deny"]'); await decision.click(selector + ' [data-attention-submit]');
  await until(async () => !(await state()).todos.some(row => row.id === permission.id && row.status === 'open'), 'explicit denial applied'); await settled();
  assert.equal(await exists(path.join(external, 'admin-denied.txt')), false); await decision.screenshot({path: path.join(out, 'admin-denied.png')});
  assert.equal(result.requests.filter(row => row.phase === 'admin' && row.tool === 'nozeli_privileged_execute').length, 1, 'Denial causes no repeated request or execution');
  await sample(); result.nativeProcesses = [...processes.values()].filter(row => row.argv.some(arg => /(?:^|\/)omp$/.test(arg))&&row.argv.includes('--system-prompt'));
  assert(result.nativeProcesses.length, 'Actual native OMP observed'); assert(result.nativeProcesses.every(row => {const index = row.argv.indexOf('--approval-mode'); return index >= 0 && row.argv[index + 1] === 'yolo';}), 'Actual native OMP argv contains --approval-mode yolo');
  assert(![...processes.values()].some(row => /^(?:sudo|pkexec|doas|su|kdesu|gksu)$/.test(path.basename(row.argv[0] || ''))), 'No OS authentication/elevation helper launched');
  check('Administrator request creates real permission todo; explicit denial has no execution and no observed OS elevation helper; native OMP argv is YOLO');
  assert.equal(await exists(path.join(external, '.nozeli')), false); await fs.writeFile(path.join(out, 'final-state.json'), JSON.stringify(await state(), null, 2));
  await call('session.requestClose'); result.exit = await Promise.race([exited, pause(45000).then(() => null)]); assert.deepEqual(result.exit, {code: 0, signal: null});
  for (let n = 0; n < 50 && (await survivors()).length; n++) await pause(100);
  result.normalExitSurvivors = await survivors(); assert.deepEqual(result.normalExitSurvivors, []); assert.deepEqual(result.errors, []); result.ok = true;
  check('Normal Electron exit code zero with no owned surviving descendants or renderer errors');
} catch (error) {
  result.error = error.stack; process.exitCode = 1;
  if (shell) {await shell.screenshot({path: path.join(out, 'failure.png')}).catch(() => {}); await fs.writeFile(path.join(out, 'failure-state.json'), JSON.stringify(await Promise.race([state().catch(() => null), pause(2000).then(() => null)]), null, 2));}
} finally {
  clearInterval(sampler);
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
