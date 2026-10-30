// Serial, opt-in real Electron + native OMP + Git smoke. No external provider calls.
// NOZELI_TEST_APP_ROOT=/release/resources/app NOZELI_TEST_BINARY=/release/nozeli \
// NOZELI_TEST_EVIDENCE_ROOT=/home/bfly/.cache/nozeli-smokes node tests/desktop-worker-large-files-live.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
import {staticReport} from './static-report.fixture.mjs';

const source = path.resolve(import.meta.dirname, '..');
const appRoot = path.resolve(process.env.NOZELI_TEST_APP_ROOT || source);
const binary = process.env.NOZELI_TEST_BINARY || createRequire(import.meta.url)('electron');
const {DesktopHost} = await import(pathToFileURL(path.join(appRoot, 'src/main/host.mjs')));
const {runGit} = await import(pathToFileURL(path.join(appRoot, 'src/agents/managed/git-runtime.mjs')));
const evidenceRoot = path.resolve(process.env.NOZELI_TEST_EVIDENCE_ROOT || path.join(os.homedir(), '.cache/nozeli-smokes'));
await fs.mkdir(evidenceRoot, {recursive: true});
const out = await fs.mkdtemp(path.join(evidenceRoot, 'worker-large-files-'));
const project = path.join(out, 'project'), config = path.join(out, '.Nozeli'), profile = path.join(config, 'desktop');
const home = path.join(out, 'home');
const MiB = 1024 * 1024, bulkSize = 88 * MiB, generatedSize = 68 * MiB, tinyCount = 10032;
const result = {ok: false, out, project, appRoot, binary, checks: [], requests: [], errors: [],
  scope: 'Linux real Electron, native OMP CLI and actual host/Git acceptance; deterministic loopback protocol provider, synthetic project and isolated HOME; no credentials, paid requests or user projects.',
  boundaries: ['No conflict/recovery scenario: focused large-file clean acceptance.', 'Peak RSS is sampled per-process and includes only observed descendants of this owned Electron process, not system-wide memory or aggregate simultaneous RSS.', 'Evidence and the synthetic project are retained; only owned live processes are stopped.']};
let child, exited, browser, shell, projectId, serverError, log = '', workerStep = 0, sampler, sampling = false;
const observed = new Map();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
async function digest(file) {const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex');}
async function writeBulk(file, size, byte) {
  const handle = await fs.open(file, 'wx');
  try {const block = byte === undefined ? randomBytes(MiB) : Buffer.alloc(MiB, byte); for (let at = 0; at < size; at += block.length) await handle.write(block, 0, Math.min(block.length, size - at));}
  finally {await handle.close();}
}
const git = async (...args) => (await runGit(project, args, {env: {...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'}})).toString().trim();
async function until(fn, label, ms = 600000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (serverError) throw serverError;
    if (child && child.exitCode !== null) throw Error('Desktop exited during ' + label + ': ' + log.slice(-8000));
    const value = await fn(); if (value) return value;
    await pause(200);
  }
  throw Error('Timeout: ' + label);
}
async function call(op, p = {}, page = shell) {
  const reply = await page.evaluate(({op, p}) => window.nozeli.invoke(op, p), {op, p});
  assert(reply.ok, op + ': ' + JSON.stringify(reply.error)); return reply.value;
}
const state = async () => (await call('managed.status', {projectId})).state;
const check = name => {result.checks.push(name); console.log(JSON.stringify({check: name}));};
// Linux /proc traversal follows only our child, never a name-based process search.
async function sample() {
  if (sampling || !child?.pid) return;
  sampling = true;
  try {
    const pending = [child.pid], seen = new Set();
    while (pending.length) {
      const pid = pending.pop(); if (seen.has(pid)) continue; seen.add(pid);
      try {
        const [status, cmdline, children, stat] = await Promise.all([
          fs.readFile(`/proc/${pid}/status`, 'utf8'), fs.readFile(`/proc/${pid}/cmdline`, 'utf8'),
          fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'), fs.readFile(`/proc/${pid}/stat`, 'utf8')]);
        pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
        const rss = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] || 0) * 1024;
        const previous = observed.get(pid), command = cmdline.replaceAll('\0', ' ').trim();
        observed.set(pid, {pid, command, startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], peakRSS: Math.max(previous?.peakRSS || 0, rss), samples: (previous?.samples || 0) + 1,
          nativeOMP: /(?:^|\/)omp(?:\s|$)/.test(command), main: pid === child.pid});
      } catch (error) {if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error;}
    }
  } finally {sampling = false;}
}
async function ownedSurvivors() {
  const alive = [];
  for (const row of observed.values()) {
    try {
      const stat = await fs.readFile(`/proc/${row.pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] !== 'Z' && fields[19] === row.startTicks) alive.push(row.pid);
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  return alive;
}
const tool = (name, args, id) => ({role: 'assistant', tool_calls: [{index: 0, id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]});
const workerCode = `const fs=require('node:fs');const assert=require('node:assert/strict');assert(fs.statSync('input.tar').size>80*1024*1024);assert.equal(fs.readdirSync('many').length,${tinyCount});assert.equal(fs.readFileSync('small.txt','utf8'),'original small file\\n');fs.writeFileSync('small.txt','accepted Worker small file\\n');const fd=fs.openSync('generated.bin','wx');try{const b=Buffer.alloc(1024*1024,0x5a);b[0]=0;for(let n=0;n<68;n++)fs.writeSync(fd,b);}finally{fs.closeSync(fd);}assert.equal(fs.statSync('generated.bin').size,${generatedSize});console.log('verified archive, file count, small edit and 68 MiB binary');`;
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const workerCommand = shellQuote(process.execPath) + ' -e ' + shellQuote(workerCode);
const reportHtml = staticReport('Large synthetic input copied into an isolated Worker worktree. The real native Worker changed small.txt and generated a 68 MiB binary, verified the archive size and 10,032-file directory, and published both files. These are frozen candidates; the original project is unchanged until explicit user acceptance.');
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', chunk => {body += chunk;});
  req.on('end', () => {
    try {
      assert(req.url.startsWith('/v1/'), 'Only local model protocol requests are supported');
      const input = JSON.parse(body), names = (input.tools || []).map(t => t.function?.name);
      let delta, finish = 'tool_calls';
      if (names.includes('nozeli_dispatch')) {
        delta = tool('nozeli_dispatch', {name: 'Large files synthetic acceptance', brief: 'In the isolated Work, verify input.tar and many/, change small.txt, create generated.bin of 68 MiB using the supplied deterministic command, and publish both artifacts as a result. Do not touch Git or original project.'}, 'large-dispatch');
      } else if (names.includes('nozeli_publish')) {
        if (workerStep++ === 0) delta = tool('bash', {command: workerCommand}, 'large-worker-write');
        else {
          const last = input.messages.findLast(message => message.role === 'tool');
          const toolReply=typeof last?.content==='string'?last.content:JSON.stringify(last?.content);
          assert(!/nozeli host rejected|isError":true/.test(toolReply||''),'Worker tool failed: '+toolReply);
          assert(workerStep<=2,'Unexpected Worker publication replay: '+toolReply);
          if (workerStep === 2) result.workerCommandReply = last?.content;
          delta = tool('nozeli_publish', {kind: 'result', html: reportHtml, files: ['small.txt', 'generated.bin']}, 'large-worker-publish');
        }
      } else {delta = {role: 'assistant', content: 'The synthetic result is published for explicit user acceptance.'}; finish = 'stop';}
      result.requests.push({tool: delta.tool_calls?.[0]?.function.name || 'final', at: new Date().toISOString()});
      assert(result.requests.length <= 18, 'Unexpected model protocol replay');
      res.writeHead(200, {'content-type': 'text/event-stream'});
      for (const [part, end] of [[delta, null], [{}, finish]]) res.write('data: ' + JSON.stringify({id: 'large-' + result.requests.length, object: 'chat.completion.chunk', choices: [{index: 0, delta: part, finish_reason: end}]}) + '\n\n');
      res.end('data: [DONE]\n\n');
    } catch (error) {serverError = error; res.destroy(error);}
  });
});
try {
  await fs.mkdir(project); await fs.mkdir(home);
  await fs.mkdir(path.join(project, 'many'));
  await fs.writeFile(path.join(project,'.gitignore'),'/.nozeli/\n');
  await fs.writeFile(path.join(project, 'small.txt'), 'original small file\n');
  await writeBulk(path.join(project, 'archive-payload.bin'), bulkSize);
  await promisify(execFile)('tar', ['-cf', 'input.tar', 'archive-payload.bin'], {cwd: project});
  await fs.unlink(path.join(project, 'archive-payload.bin'));
  await writeBulk(path.join(project, 'bulk-a.bin'), bulkSize, 0x41);
  await writeBulk(path.join(project, 'bulk-b.bin'), bulkSize, 0x42);
  for (let batch = 0; batch < tinyCount; batch += 64) await Promise.all(Array.from({length: Math.min(64, tinyCount - batch)}, (_, i) => fs.writeFile(path.join(project, 'many', String(batch + i).padStart(5, '0') + '.txt'), 'synthetic ' + (batch + i) + '\n')));
  result.input = {archiveBytes: (await fs.stat(path.join(project, 'input.tar'))).size, totalBulkBytes: bulkSize * 2 + (await fs.stat(path.join(project, 'input.tar'))).size, fileCount: tinyCount + 4};
  assert(result.input.archiveBytes > 80 * MiB); assert(result.input.totalBulkBytes > 256 * MiB); assert(result.input.fileCount > 10000);
  const baseline = Object.fromEntries(await Promise.all(['input.tar', 'bulk-a.bin', 'bulk-b.bin', 'small.txt', 'many/00000.txt', 'many/10031.txt'].map(async rel => [rel, await digest(path.join(project, rel))])));
  result.baseline = baseline;
  await git('init', '-b', 'main'); await git('config', 'user.name', 'Synthetic smoke'); await git('config', 'user.email', 'synthetic@localhost');
  await git('add', '--all'); await git('commit', '-m', 'Synthetic large input');
  result.originalHead = await git('rev-parse', 'HEAD');
  const host = new DesktopHost(profile);
  try {projectId = (await host.pick(project)).project.id;} finally {await host.storage.db.close();}
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = await new Promise(resolve => {const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => {const value = socket.address().port; socket.close(() => resolve(value));});});
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key) || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)) delete env[key];
  Object.assign(env, {HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'), NOZELI_OMP_SOURCE_HOME: home, NOZELI_CONFIG_ROOT: config, NOZELI_USER_DATA: profile, NOZELI_TEST_INSTANCE: '1', NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0'});
  child = spawn(binary, [...(process.env.NOZELI_TEST_BINARY ? [] : [path.join(appRoot, 'src/main/main.cjs')]), '--ozone-platform=' + (process.env.NOZELI_OZONE || 'wayland')], {cwd: project, env, stdio: ['ignore', 'pipe', 'pipe']});
  child.on('error', error => {serverError = error;});
  exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {log += chunk;});
  sampler = setInterval(() => {sample().catch(error => {result.errors.push('RSS sampler: ' + error.message);});}, 250);
  browser = await until(() => puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null}).catch(() => null), 'Electron CDP', 45000);
  shell = await until(async () => {for (const page of await browser.pages()) if (await page.evaluate(() => window.__nozeliReady && window.__workspaceScope?.role === 'shell').catch(() => false)) return page;}, 'shell');
  shell.on('pageerror', error => result.errors.push(error.message));
  if (await shell.$eval('#configuration-setup', node => node.open)) await shell.click('#configuration-cancel');
  await call('config.initialize', {mode: 'independent'});
  await call('settings.providers.save', {provider: 'large-local', model: 'scripted', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', api: 'openai-completions', key: 'synthetic-loopback-only'});
  await call('settings.models.save', {frontdesk: 'large-local/scripted', orchestrator: 'large-local/scripted', worker: 'large-local/scripted'});
  await shell.click('[data-project-id="' + projectId + '"]');
  await shell.waitForFunction(id => window.__workspaceScope?.projectId === id, {}, projectId);
  await call('managed.enable', {projectId});
  await call('managed.task', {projectId, requestKey: 'large-synthetic-task', text: 'Create the independent synthetic large-file Work. In the isolated worktree verify the 88 MiB input.tar and 10,032 tiny files, change small.txt and generate a 68 MiB generated.bin using the deterministic local command. Publish a final static HTML result listing both files, without touching Git, networking, other projects or the original target. Original bytes must remain unchanged pending explicit user acceptance.'});
  const work = await until(async () => {
    const s = await state(), w = s.works[0];
    const failed = s.jobs.find(j => j.status === 'failed'); if (failed) throw Error(JSON.stringify(failed));
    if (w?.status === 'paused' && !s.busyTargets.length) throw Error('Worker paused: ' + JSON.stringify(w));
    return w?.status === 'review' && !s.busyTargets.includes(w.id) ? w : null;
  }, 'large Worker result');
  result.work = {id: work.id, directory: work.execution.directory, threadId: work.threadId};
  assert.equal(await git('rev-parse', 'HEAD'), result.originalHead);
  assert.equal(await git('status', '--porcelain'), '', 'Every tracked original input remains unchanged');
  for (const [rel, expected] of Object.entries(baseline)) assert.equal(await digest(path.join(project, rel)), expected, 'Original unchanged: ' + rel);
  assert.equal(await fs.stat(path.join(project, 'generated.bin')).then(() => true, () => false), false);
  check('>80 MiB archive, >256 MiB input and >10,000 files prepare in an isolated real Worker worktree; original bytes/HEAD stay unchanged before acceptance');
  const publishedState = await state(), receipt = publishedState.receipts.find(r => r.workId === work.id && r.kind === 'result');
  assert(receipt); result.frozenReceipt = structuredClone(receipt);
  const cas = path.join(project, '.nozeli', 'objects/sha256');
  assert.equal(await digest(path.join(cas, receipt.report.digest)), receipt.report.digest);
  assert.equal((await fs.stat(path.join(cas, receipt.report.digest))).size, receipt.report.byteLength);
  result.artifacts = [];
  for (const rel of ['small.txt', 'generated.bin']) {
    const frozen = receipt.snapshot.files.find(file => file.relPath === rel); assert(frozen, 'Frozen file ' + rel);
    assert.equal(await digest(path.join(work.execution.directory, rel)), frozen.digest);
    assert.equal(await digest(path.join(cas, frozen.objectDigest || frozen.digest)), frozen.digest);
    assert.equal((await fs.stat(path.join(work.execution.directory, rel))).size, frozen.size);
    result.artifacts.push(frozen);
  }
  assert.equal(result.artifacts.find(file => file.relPath === 'generated.bin').size, generatedSize);
  check('Frozen report and small/binary artifacts match immutable CAS SHA-256 and actual Worker file sizes');
  await fs.writeFile(path.join(out, 'published-state.json'), JSON.stringify(publishedState, null, 2));
  if (await shell.$eval('#toggle-sidebar', node => node.getAttribute('aria-expanded') !== 'true')) await shell.click('#toggle-sidebar');
  const reportTodo=publishedState.todos.find(todo=>todo.objectId===receipt.objectId&&todo.kind==='result');assert(reportTodo);
  await shell.waitForSelector('[data-managed-todo="'+reportTodo.id+'"]',{visible:true});
  await shell.screenshot({path: path.join(out, 'worker-published.png')});
  await shell.click('[data-managed-todo="'+reportTodo.id+'"]');
  const review = await until(async () => {for (const page of await browser.pages()) if (await page.$eval('[data-review-action="accept"]:not([disabled])', node => node.getClientRects().length > 0).catch(() => false)) return page;}, 'actionable rendered report');
  await review.screenshot({path: path.join(out, 'report-before-accept.png')});
  await review.click('[data-review-action="accept"]');
  await review.waitForSelector('[data-confirmation-confirm]', {visible: true}); await review.click('[data-confirmation-confirm]');
  const ended = await until(async () => {const w = (await state()).works.find(row => row.id === work.id); if (w.closure?.phase === 'blocked') throw Error(JSON.stringify(w.closure)); return w.closure?.phase === 'complete' ? w : null;}, 'real host acceptance/integration');
  assert.equal(ended.outcome, 'accept'); assert.notEqual(await git('rev-parse', 'HEAD'), result.originalHead);
  for (const artifact of result.artifacts) assert.equal(await digest(path.join(project, artifact.relPath)), artifact.digest);
  for (const rel of ['input.tar', 'bulk-a.bin', 'bulk-b.bin', 'many/00000.txt', 'many/10031.txt']) assert.equal(await digest(path.join(project, rel)), baseline[rel]);
  assert.equal(await git('status', '--porcelain'), '');
  assert.equal(await fs.stat(work.execution.directory).then(() => true, () => false), false);
  const final = await state(); assert.deepEqual(final.receipts.find(row => row.id === receipt.id), receipt);
  for (const artifact of result.artifacts) assert.equal(await digest(path.join(cas, artifact.objectDigest || artifact.digest)), artifact.digest);
  check('Actual host acceptance merges small and >64 MiB binary bytes, preserves inputs and immutable receipt/CAS, leaves clean Git and removes owned worktree');
  await review.waitForFunction(() => document.querySelector('[data-review-status]')?.textContent.includes('已合入'));
  await review.screenshot({path: path.join(out, 'report-accepted.png')});
  await fs.writeFile(path.join(out, 'final-state.json'), JSON.stringify(final, null, 2));
  await sample();
  assert([...observed.values()].some(row => row.nativeOMP), 'Observed actual native OMP descendant');
  check('Actual native OMP process observed under owned Electron; peak RSS recorded without a fragile threshold');
  await until(async () => !(await state()).busyTargets.length, 'settled native turns');
  await call('session.requestClose');
  result.exit = await Promise.race([exited, pause(45000).then(() => null)]);
  assert.deepEqual(result.exit, {code: 0, signal: null});
  for (let attempt = 0; attempt < 50 && (await ownedSurvivors()).length; attempt++) await pause(100);
  result.normalExitSurvivors = await ownedSurvivors();
  assert.deepEqual(result.normalExitSurvivors, [], 'Normal lifecycle leaves no observed owned descendants');
  assert.deepEqual(result.errors, []); check('Normal Electron exit code 0 and no renderer errors'); result.ok = true;
} catch (error) {
  result.error = error.stack; process.exitCode = 1;
  if (shell) {await shell.screenshot({path: path.join(out, 'failure.png')}).catch(() => {}); await fs.writeFile(path.join(out, 'failure-state.json'), JSON.stringify(await state().catch(() => null), null, 2));}
} finally {
  clearInterval(sampler);
  if (child?.exitCode === null) {
    await Promise.race([call('session.requestClose').catch(() => {}), pause(2000)]);
    await Promise.race([exited, pause(8000)]);
    if (child.exitCode === null) {
      // Signal only the root process we spawned and descendant PIDs still owned by it.
      await sample().catch(() => {});
      child.kill('SIGTERM'); await Promise.race([exited, pause(5000)]);
      if (child.exitCode === null) {child.kill('SIGKILL'); await exited;}
    }
  }
  result.cleanupSignalled = [];
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const survivors = await ownedSurvivors();
    for (const pid of survivors) {
      try {process.kill(pid, signal); result.cleanupSignalled.push({pid, signal});} catch (error) {if (error.code !== 'ESRCH') throw error;}
    }
    if (survivors.length) await pause(500);
  }
  result.cleanupSurvivors = await ownedSurvivors();
  await browser?.disconnect().catch(() => {});
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  result.processMemory = [...observed.values()];
  result.memorySummary = {electronMainPeakRSS: Math.max(0, ...result.processMemory.filter(row => row.main).map(row => row.peakRSS)), nativeOMPPeakRSS: Math.max(0, ...result.processMemory.filter(row => row.nativeOMP).map(row => row.peakRSS)), sampleIntervalMs: 250};
  await fs.writeFile(path.join(out, 'electron.log'), log);
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
