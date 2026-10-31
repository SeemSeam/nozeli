// Opt-in, serial Linux live test: real Electron/native OMP, synthetic data only.
// NOZELI_TEST_APP_ROOT/BINARY/EVIDENCE_ROOT follow desktop-maintenance-live.mjs.
// Run from apps/desktop: node tests/desktop-force-quit-live.mjs
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

const appRoot = path.resolve(process.env.NOZELI_TEST_APP_ROOT || path.join(import.meta.dirname, '..'));
const binary = process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
const {DesktopHost} = await import(pathToFileURL(path.join(appRoot, 'src/main/host.mjs')));
const {runGit} = await import(pathToFileURL(path.join(appRoot, 'src/agents/managed/git-runtime.mjs')));
const evidenceRoot = path.resolve(process.env.NOZELI_TEST_EVIDENCE_ROOT || path.join(os.homedir(), '.cache/nozeli-smokes'));
await fs.mkdir(evidenceRoot, {recursive: true});
const out = await fs.mkdtemp(path.join(evidenceRoot, 'force-quit-live-'));
const result = {ok: false, out, appRoot, binary, checks: [], scenarios: [], errors: [], scope: 'Linux only; isolated synthetic HOME/profile/project, real native OMP and loopback scripted model. Actual busy Work, no publication or acceptance. Only identity-checked owned descendants are signalled; unrelated synthetic sentinel must survive. No original data, credentials, production hooks, fabricated Work completion or task replay.'};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const save = (name, value) => fs.writeFile(path.join(out, name), JSON.stringify(value, null, 2));
const check = name => {result.checks.push(name); console.log(JSON.stringify({check: name}));};
let active, sentinel, sentinelIdentity;
async function identity(pid) {
  try {
    const [stat, metadata] = await Promise.all([fs.readFile(`/proc/${pid}/stat`, 'utf8'), fs.stat(`/proc/${pid}`)]);
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return fields[0] === 'Z' ? null : {pid, parent: Number(fields[1]), uid: metadata.uid, startTicks: fields[19]};
  } catch (error) {if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error;}
}
async function same(row) {const live = row && await identity(row.pid); return !!live && live.startTicks === row.startTicks && live.uid === row.uid;}
async function sample(ctx) {
  if (ctx.sampling || !ctx.child?.pid) return;
  ctx.sampling = true;
  try {
    const root = await identity(ctx.child.pid); if (!root || root.uid !== process.getuid()) return;
    const pending = [root], seen = new Set();
    while (pending.length) {
      const before = pending.pop(), {pid} = before; if (seen.has(pid)) continue; seen.add(pid);
      try {
        if (!await same(before)) continue;
        const tasks = await fs.readdir(`/proc/${pid}/task`), children = new Set();
        for (const tid of tasks) {
          try {
            const raw = await fs.readFile(`/proc/${pid}/task/${tid}/children`, 'utf8');
            for (const value of raw.trim().split(/\s+/)) if (/^\d+$/.test(value)) children.add(Number(value));
          } catch (error) {if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;}
        }
        const command = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
        if (!await same(before) || !await same(root)) continue;
        ctx.processes.set(`${pid}:${before.startTicks}`, {...before, command: command.replaceAll('\0', ' ')});
        for (const childPid of children) {
          const child = await identity(childPid);
          if (child && child.parent === pid && child.uid === root.uid && await same(before)) pending.push(child);
        }
      } catch (error) {if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;}
    }
  } finally {ctx.sampling = false;}
}
async function survivors(ctx) {
  const rows = [];
  for (const row of ctx.processes.values()) if (await same(row)) rows.push(row);
  return rows;
}
async function until(ctx, fn, label, timeout = 120000, allowExit = false) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (ctx.error) throw ctx.error;
    if (!allowExit && ctx.child && (ctx.child.exitCode !== null || ctx.child.signalCode)) throw Error('Electron exited during ' + label + ': ' + ctx.log.slice(-8000));
    const value = await fn(); if (value) return value;
    await pause(50);
  }
  throw Error('Timeout: ' + label);
}
async function call(ctx, op, payload = {}) {
  const reply = await ctx.shell.evaluate(({op, payload}) => window.nozeli.invoke(op, payload), {op, payload});
  assert(reply.ok, op + ': ' + JSON.stringify(reply.error)); return reply.value;
}
const state = ctx => call(ctx, 'managed.status', {projectId: ctx.projectId}).then(reply => reply.state);
async function launch(ctx) {
  ctx.log = '';
  const port = await new Promise(resolve => {const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => {const p = socket.address().port; socket.close(() => resolve(p));});});
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)) delete env[key];
  Object.assign(env, {HOME: ctx.home, USERPROFILE: ctx.home, XDG_CONFIG_HOME: path.join(ctx.home, '.config'), XDG_DATA_HOME: path.join(ctx.home, '.local/share'), XDG_STATE_HOME: path.join(ctx.home, '.local/state'), XDG_CACHE_HOME: path.join(ctx.home, '.cache'), NOZELI_OMP_SOURCE_HOME: ctx.home, NOZELI_CONFIG_ROOT: ctx.config, NOZELI_USER_DATA: ctx.profile, NOZELI_TEST_INSTANCE: '1', NOZELI_TEST_PICK: ctx.project, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0'});
  ctx.child = spawn(binary, [...(process.env.NOZELI_TEST_BINARY ? [] : [path.join(appRoot, 'src/main/main.cjs')]), '--ozone-platform=' + (process.env.NOZELI_OZONE || 'wayland')], {cwd: ctx.project, env, stdio: ['ignore', 'pipe', 'pipe']});
  ctx.child.on('error', error => {ctx.error = error;});
  ctx.exited = new Promise(resolve => ctx.child.once('exit', (code, signal) => resolve({code, signal})));
  for (const stream of [ctx.child.stdout, ctx.child.stderr]) stream.on('data', chunk => {ctx.log += chunk;});
  ctx.sampler = setInterval(() => {sample(ctx).catch(error => {ctx.error = error;});}, 50);
  ctx.browser = await until(ctx, () => puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null}).catch(() => null), 'CDP', 45000);
  ctx.shell = await until(ctx, async () => {for (const page of await ctx.browser.pages()) if (await page.evaluate(() => window.__nozeliReady && window.__workspaceScope?.role === 'shell').catch(() => false)) return page;}, 'shell');
  ctx.shell.on('pageerror', error => result.errors.push(error.message));
}
async function select(ctx) {
  await ctx.shell.click('[data-project-id="' + ctx.projectId + '"]');
  await ctx.shell.waitForFunction(id => window.__workspaceScope?.projectId === id, {}, ctx.projectId);
}
async function disconnected(ctx) {
  clearInterval(ctx.sampler); ctx.sampler = null;
  if (ctx.browser) await ctx.browser.disconnect();
  ctx.browser = null; ctx.shell = null;
}
async function assertGone(ctx) {
  await until(ctx, async () => !(await survivors(ctx)).length, 'owned descendant exit', 10000, true);
  assert.deepEqual(await survivors(ctx), []);
  assert(await same(sentinelIdentity), 'Unrelated sentinel survives application shutdown');
}
const tool = (name, args, id) => ({role: 'assistant', tool_calls: [{index: 0, id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]});
async function scenario(name, cancelFirst) {
  const root = path.join(out, name), project = path.join(root, 'project'), home = path.join(root, 'home'), config = path.join(root, '.Nozeli'), profile = path.join(config, 'desktop');
  const row = {name, cancelFirst, requests: [], launches: [], checks: []}; result.scenarios.push(row);
  const ctx = active = {root, project, home, config, profile, processes: new Map(), phase: 'setup', log: '', row};
  const baseline = 'SYNTHETIC_FORCE_QUIT_BASELINE_' + name + '\n';
  const drafts = {frontdesk: 'UNSENT_FRONTDESK_' + name, orchestrator: 'UNSENT_ORCHESTRATOR_' + name};
  const marker = 'NOZELI_FORCE_QUIT_OWNED_' + name;
  const ready = path.join(root, 'owned-child-ready.json');
  // This is an actual tool-launched process, not a product test hook. It writes
  // only synthetic readiness evidence, ignores TERM and otherwise does no work.
  const code = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,marker:${JSON.stringify(marker)}}));setInterval(()=>{},1000);`;
  const command = quote(process.execPath) + ' -e ' + quote(code) + ' ' + quote(marker);
  let dispatches = 0, workerCalls = 0;
  ctx.server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => {body += chunk;});
    req.on('end', () => {
      try {
        assert(req.url.startsWith('/v1/')); assert.equal(req.method, 'POST');
        const input = JSON.parse(body), names = (input.tools || []).map(row => row.function?.name);
        assert.equal(ctx.phase, 'busy', 'Cold reopen/config/quit must not replay any input');
        let delta, finish = 'tool_calls';
        if (names.includes('nozeli_publish')) {
          assert.equal(workerCalls++, 0, 'Busy Worker must never replay or publish');
          delta = tool('bash', {command}, 'force-quit-native-busy');
        } else if (names.includes('nozeli_dispatch') && dispatches === 0) {
          dispatches++;
          delta = tool('nozeli_dispatch', {name: 'Synthetic force quit busy Work', brief: 'Run the provided harmless synthetic wait command once. Do not edit, publish, accept, create other Work or touch any other project.'}, 'force-quit-dispatch');
        } else {delta = {role: 'assistant', content: 'The one synthetic busy Work is running. Do not dispatch another Work.'}; finish = 'stop';}
        row.requests.push({phase: ctx.phase, tools: names, response: delta, at: new Date().toISOString()});
        assert(row.requests.length <= 8, 'No automatic input loop');
        res.writeHead(200, {'content-type': 'text/event-stream'});
        for (const [part, end] of [[delta, null], [{}, finish]]) res.write('data: ' + JSON.stringify({id: name + '-' + row.requests.length, object: 'chat.completion.chunk', choices: [{index: 0, delta: part, finish_reason: end}]}) + '\n\n');
        res.end('data: [DONE]\n\n');
      } catch (error) {ctx.error = error; res.destroy(error);}
    });
  });
  await fs.mkdir(project, {recursive: true}); await fs.mkdir(home);
  await fs.writeFile(path.join(project, 'baseline.txt'), baseline); await fs.writeFile(path.join(project, '.gitignore'), '/.nozeli/\n');
  const git = async (...args) => (await runGit(project, args, {env: {...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'}})).toString().trim();
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Synthetic force quit'], ['config', 'user.email', 'synthetic@localhost'], ['add', '--all'], ['commit', '-m', 'Synthetic force quit baseline']]) await git(...args);
  row.head = await git('rev-parse', 'HEAD');
  const host = new DesktopHost(profile); try {ctx.projectId = (await host.pick(project)).project.id;} finally {await host.storage.db.close();}
  await new Promise(resolve => ctx.server.listen(0, '127.0.0.1', resolve));
  await launch(ctx);
  if (await ctx.shell.$eval('#configuration-setup', node => node.open)) await ctx.shell.click('#configuration-cancel');
  await call(ctx, 'config.initialize', {mode: 'independent'});
  await call(ctx, 'settings.providers.save', {operation:'create',provider:'force-quit-local',baseUrl:'http://127.0.0.1:' + ctx.server.address().port + '/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'synthetic-loopback-only'}});
  await call(ctx, 'settings.models.save', {frontdesk:{model:{mode:'explicit',selector:'force-quit-local/scripted'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'explicit',selector:'force-quit-local/scripted'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'force-quit-local/scripted'},thinking:{mode:'native-default'}}});
  await select(ctx); await call(ctx, 'managed.enable', {projectId: ctx.projectId});
  ctx.phase = 'busy';
  await call(ctx, 'managed.task', {projectId: ctx.projectId, requestKey: 'force-quit-' + name, text: 'Create exactly one synthetic Work running a harmless wait command for the force-quit check. No edits, publication, acceptance or other work.'});
  const busy = await until(ctx, async () => {
    const s = await state(ctx); assert(s.works.length <= 1, 'No replacement Work');
    const readyValue = await fs.readFile(ready, 'utf8').then(JSON.parse).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
    if (!readyValue || !s.works[0] || !s.busyTargets.includes(s.works[0].id)) return null;
    await sample(ctx);
    const owned = [...ctx.processes.values()].find(row => row.pid === readyValue.pid);
    assert(owned && await same(owned), 'Wait process is an actual identity-verified Electron descendant');
    assert(owned.command.includes(marker)); row.resistantChild = owned;
    return s;
  }, 'actual busy native Worker and TERM-resistant child');
  for (const [target, text] of Object.entries(drafts)) await call(ctx, 'managed.draft', {projectId: ctx.projectId, target, text});
  for (const [target, text] of Object.entries(drafts)) assert.equal((await state(ctx)).drafts[target], text);
  assert.equal(workerCalls, 1); assert.equal(dispatches, 1);
  assert([...ctx.processes.values()].some(row => /(?:^|\/)omp(?:\s|$)/.test(row.command)), 'Actual native OMP descendant');
  row.workId = busy.works[0].id; row.jobsBefore = busy.jobs.map(({id, target, type}) => ({id, target, type}));
  await save(name + '-busy-state.json', await state(ctx));
  ctx.phase = 'quit';
  await call(ctx, 'session.requestClose');
  await ctx.shell.waitForFunction(() => document.querySelector('#quit-choice')?.open && !document.querySelector('#quit-force')?.disabled);
  row.dialog = await ctx.shell.$eval('#quit-choice', node => node.innerText);
  assert(/未保存/.test(row.dialog) && /丢失/.test(row.dialog), 'Original quit dialog explicitly warns of unsaved data loss');
  await ctx.shell.screenshot({path: path.join(root, 'busy-quit.png')});
  if (cancelFirst) {
    await ctx.shell.click('#quit-cancel');
    await ctx.shell.waitForFunction(() => document.querySelector('#quit-choice')?.open && document.querySelector('#quit-cancel')?.disabled && !document.querySelector('#quit-force')?.disabled, {timeout: 5000});
    row.cancelPending = true;
    assert.equal(ctx.child.exitCode, null, 'Application remains alive during pending cancellation');
    assert(await same(row.resistantChild), 'TERM-resistant child remains present when Force Quit is available');
  }
  await sample(ctx);
  const started = Date.now();
  await ctx.shell.click('#quit-force').catch(error => {if (!/Target closed|Session closed|detached|Connection closed/i.test(error.message)) throw error;});
  row.forceExit = await Promise.race([ctx.exited, pause(10000).then(() => null)]);
  row.forceExitMs = Date.now() - started;
  assert(row.forceExit, 'Force Quit exits within ten seconds, without awaiting normal cancellation');
  assert.deepEqual(row.forceExit, {code: 0, signal: null}, 'Electron force exit returns success');
  await disconnected(ctx); await assertGone(ctx);
  await save(name + '-force-processes.json', [...ctx.processes.values()]);
  await fs.writeFile(path.join(root, 'force-electron.log'), ctx.log);
  check(name + ': bounded Force Quit, owned descendants gone and unrelated sentinel alive');
  const requestsBefore = row.requests.length;
  ctx.phase = 'cold-reopen';
  await launch(ctx); await select(ctx);
  await call(ctx, 'managed.connect', {projectId: ctx.projectId});
  const reopened = await state(ctx);
  for (const [target, text] of Object.entries(drafts)) assert.equal(reopened.drafts[target], text, 'Persisted unsent ' + target + ' draft retained');
  assert.equal(reopened.works.length, 1); assert.equal(reopened.works[0].id, row.workId);
  assert(!['completed', 'accepted'].includes(reopened.works[0].status), 'Interrupted busy Work is not fake-completed or accepted');
  assert.deepEqual(reopened.jobs.map(({id, target, type}) => ({id, target, type})), row.jobsBefore, 'Cold reopen creates no replay/replacement jobs');
  await pause(4000);
  await call(ctx, 'managed.connect', {projectId: ctx.projectId});
  assert.equal(row.requests.length, requestsBefore, 'Cold reopen and repeated connect perform zero model calls');
  const final = await state(ctx);
  assert.deepEqual(final.jobs.map(({id, target, type}) => ({id, target, type})), row.jobsBefore);
  assert.equal(final.works.length, 1); assert.equal(final.works[0].id, row.workId);
  assert.equal(await fs.readFile(path.join(project, 'baseline.txt'), 'utf8'), baseline);
  assert.equal(await git('rev-parse', 'HEAD'), row.head);
  assert.equal(await git('diff', '--', 'baseline.txt'), '');
  await save(name + '-reopened-state.json', final);
  await ctx.shell.screenshot({path: path.join(root, 'cold-reopened.png')});
  check(name + ': cold reopen retains drafts, exact Work and baseline without model or task replay');
  await sample(ctx); await call(ctx, 'session.requestClose');
  const normalExit = await Promise.race([ctx.exited, pause(45000).then(() => null)]);
  assert.deepEqual(normalExit, {code: 0, signal: null}, 'Cold reopened app closes normally');
  await disconnected(ctx); await assertGone(ctx);
  await fs.writeFile(path.join(root, 'reopen-electron.log'), ctx.log);
  await new Promise(resolve => ctx.server.close(resolve)); ctx.server = null; active = null;
}
try {
  assert.equal(process.platform, 'linux', 'This live ownership check uses Linux /proc; no claim is made for other platforms');
  sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'NOZELI_FORCE_QUIT_UNRELATED_SENTINEL'], {stdio: 'ignore'});
  sentinel.on('error', error => result.errors.push(error.message));
  sentinelIdentity = await until({}, () => identity(sentinel.pid), 'unrelated sentinel identity', 5000);
  await scenario('force-direct', false);
  await scenario('force-during-cancel', true);
  assert.deepEqual(result.errors, []); result.ok = true;
} catch (error) {
  result.failure = error.stack || String(error); process.exitCode = 1;
} finally {
  if (active) {
    clearInterval(active.sampler);
    await sample(active).catch(error => result.errors.push(error.message));
    // Failure cleanup is deliberately separate from the product exit assertions.
    // Never use killall, process-name matching or unverified process groups.
    result.failureCleanup = [];
    for (const row of [...active.processes.values()].reverse()) if (await same(row)) {
      try {process.kill(row.pid, 'SIGKILL'); result.failureCleanup.push(row);} catch (error) {if (error.code !== 'ESRCH') result.errors.push(error.message);}
    }
    await disconnected(active).catch(error => result.errors.push(error.message));
    active.server?.closeAllConnections(); active.server?.close();
    await fs.writeFile(path.join(active.root, 'failure-electron.log'), active.log).catch(() => {});
  }
  if (await same(sentinelIdentity)) sentinel.kill('SIGKILL');
  await save('result.json', result);
  console.log(JSON.stringify({ok: result.ok, out, checks: result.checks, failure: result.failure}, null, 2));
}
