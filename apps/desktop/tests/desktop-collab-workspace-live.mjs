// Real, paid, installed Linux acceptance. Never run against daily current/profile.
// Prerequisites: Node >=22, desktop dependencies (puppeteer-core/yaml), a visible
// Wayland/X11 session, an absolute independent release containing nozeli, and a
// configured system paratera static API key. OAuth is NOT imported. No models probe.
// Run (ROOT must not exist):
// NOZELI_REAL_OMP=1 NOZELI_OMP_IMPORT_API_KEYS=1 node \
//   apps/desktop/tests/desktop-collab-workspace-live.mjs /absolute/release /absolute/fresh-root
// Optional NOZELI_OZONE=x11; MODE=full is the only supported mode. Failures are
// terminal: inspect result.json/error.json/ledger.json, never rerun in the same root.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {parse, stringify} from 'yaml';
import {createAcceptanceCollector} from './acceptance-request-control.mjs';
import {resolveSystemOmpSource} from '../src/agents/managed/omp-system-source.mjs';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';
import {recoverOmpProvider} from '../src/agents/managed/omp-process-ownership.mjs';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';

const [release, root, ...extra] = process.argv.slice(2);
assert.equal(process.env.NOZELI_REAL_OMP, '1', 'Explicit paid-model opt-in required');
assert.equal(process.env.NOZELI_OMP_IMPORT_API_KEYS, '1', 'Explicit static-key import opt-in required');
assert.equal(process.platform, 'linux');
assert.equal(process.env.MODE || 'full', 'full', 'No silent partial/fault-only acceptance');
assert(extra.length === 0 && [release, root].every(p => typeof p === 'string' && path.isAbsolute(p)), 'Absolute release and fresh root required');
await fs.access(path.join(release, 'nozeli'));
await fs.mkdir(root, {mode: 0o700}); // exclusive fresh root; never reset a ledger
const privateRoot = path.join(root, '.Nozeli'), profile = path.join(privateRoot, 'desktop');
const project = path.join(root, 'project'), run = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], operations = [], observations = {streams: [], deviations: []}, owners = new Map();
const expectedFaults = new Set();
let collector, child, exit, browser, page, id, runtime, failure, inspectorURL, log = '';
const save = (name, value) => fs.writeFile(path.join(root, name), JSON.stringify(value, null, 2), {mode: 0o600});
function check(name, value, evidence) {
  assert(value, name); checks.push({name, at: new Date().toISOString(), evidence});
}
async function invoke(op, payload = {}) {
  operations.push({layer: 'production-ipc', op, payload, at: Date.now()});
  const response = await page.evaluate(({op, payload}) => window.nozeli.invoke(op, payload), {op, payload});
  if (!response.ok) throw Object.assign(Error(op + ': ' + response.error?.message), {response});
  return response.value;
}
const state = async () => (await invoke('managed.status', {projectId: id})).state;
async function wait(fn, label, timeout = 300000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ledger = collector?.snapshot();
    if (ledger?.stopped) throw Error('Collector stopped: ' + ledger.stopped);
    const bad = ledger?.events.find(e => e.kind === 'transport-error' || e.kind === 'response' && e.status >= 400);
    if (bad) { await collector.stop('upstream-failure-no-retry'); throw Error('Upstream failure; no acceptance retry: ' + JSON.stringify(bad)); }
    const value = await fn(); if (value) return value;
    if (child && (child.exitCode !== null || child.signalCode)) throw Error('Electron exited during ' + label);
    await pause(150);
  }
  throw Error('Timeout: ' + label + ' (not retried)');
}
async function click(selector) {
  operations.push({layer: 'real-dom-click', selector, at: Date.now()});
  await page.waitForSelector(selector, {visible: true});
  await page.locator(selector).setTimeout(15000).click();
}
// A physical keypress returns before async draft persistence/admission completes.
// Never treat a momentarily empty queue as this input's completed result.
async function compose(text, background = false) {
  const previousJobs=new Set((await state()).jobs.map(job=>job.id));
  await click('#composer');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.sendCharacter(text);
  if(background)await click('#managed-submit-task');
  else {operations.push({layer:'real-dom-keyboard',key:'Control+Enter',at:Date.now()});await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');}
  return wait(async()=>{const s=await state();return s.jobs.find(job=>!previousJobs.has(job.id)&&(job.text===text||job.text.startsWith(text+'\n\n')));},'exact input durable admission',30000);
}
async function timeline() {
  const entries = new Map(), deltas = new Map(); let cursor;
  do {
    const frame = await invoke('managed.timeline.page', {projectId: id, limit: 200, ...(cursor ? {cursor} : {})});
    for (let entry of frame.entries) {
      if (entry.availability === 'read-required') {
        const original = await invoke('managed.timeline.read', {projectId: id, id: entry.id});
        entry = original.entry || original;
      }
      entries.set(entry.id, entry);
    }
    for (const delta of frame.deltas) deltas.set(delta.id, delta);
    assert(!frame.hasMore || frame.nextCursor && frame.nextCursor !== cursor, 'History cursor advances');
    cursor = frame.hasMore ? frame.nextCursor : null;
  } while (cursor);
  return {entries: [...entries.values()], deltas: [...deltas.values()]};
}
async function settled(label) {
  return wait(async () => {
    const s = await state();
    const failed = s.jobs.find(j => ['failed', 'unknown'].includes(j.status)&&!expectedFaults.has(j.id));
    if (failed) throw Object.assign(Error(label + ': job ' + failed.id + ' ' + failed.status), {job: failed});
    for (const record of Object.values(s.providers || {})) if (record.pid && record.stamp) owners.set(record.pid, record);
    const deviation = s.works.find(w => ['pending', 'replanned'].includes(w.deviation?.status));
    if (deviation) { observations.deviations.push(deviation.deviation); throw Error('Actual deviation held; do not auto-resolve or replay'); }
    return !s.jobs.some(j => ['queued', 'running'].includes(j.status)) && !s.busyTargets.length ? s : null;
  }, label);
}
async function review(name, revision = 0) {
  return wait(async () => {
    const s = await state(), w = s.works.find(w => w.name === name);
    const bad = s.jobs.find(j => ['failed', 'unknown'].includes(j.status)&&!expectedFaults.has(j.id));
    if (bad) throw Object.assign(Error('Job failed without retry'), {job: bad});
    if (w?.status === 'paused') { observations.deviations.push(w.deviation || {workId: w.id}); throw Error('Worker paused; original failure retained'); }
    return w?.status === 'review' && w.revision > revision && !s.busyTargets.includes(w.id) ? w : null;
  }, name + ' review');
}
async function git(...args) { return (await run('git', ['-C', project, ...args], {maxBuffer:8*1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout; }
async function gitSnapshot() {
  return {head: await git('rev-parse', 'HEAD'), index: createHash('sha256').update(await git('ls-files','--stage','-z')).digest('hex'),
    status: await git('status', '--porcelain=v1', '-z'), staged: await git('diff', '--cached', '--binary'), dirty: await git('diff', '--binary')};
}
const source = resolveSystemOmpSource();
async function officialMetadata() {
  const result = {};
  for (const name of ['config.yml', 'config.yaml', 'models.yml', 'models.yaml', 'agent.db', 'auth.db']) {
    const stat = await fs.stat(path.join(source.agentDir, name)).catch(e => {if (e.code !== 'ENOENT') throw e;});
    if (stat) result[name] = {size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino};
  }
  return result;
}
const officialBefore = await officialMetadata();
async function launch() {
  const logOffset=log.length;
  const port = await new Promise(resolve => {const server = net.createServer(); server.listen(0, '127.0.0.1', () => {const p = server.address().port; server.close(() => resolve(p));});});
  const env = {...process.env, PATH: '/usr/bin:/bin', NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: privateRoot,
    NOZELI_USER_DATA: profile, NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0'};
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NOZELI_AGENT_FIXTURE', 'NOZELI_OMP_BIN', 'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR', 'OMP_PROFILE', 'PI_PROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'OMP_AUTH_BROKER_URL', 'OMP_AUTH_BROKER_TOKEN']) delete env[key];
  child = spawn(path.join(release, 'nozeli'), ['--ozone-platform=' + (process.env.NOZELI_OZONE || 'wayland'),'--inspect=0'], {cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  const stamp = await processStamp(child.pid); child.ownedStamp = stamp;
  exit = new Promise(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {log += bytes;});
  await wait(async () => {try {return (await fetch('http://127.0.0.1:' + port + '/json/version')).ok;} catch {return false;}}, 'Electron debugging endpoint', 45000);
  inspectorURL=await wait(()=>log.slice(logOffset).match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'owned main Inspector',15000);
  browser = await puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null});
  const target = await browser.waitForTarget(t => t.url().startsWith('http://127.0.0.1:'));
  page = await target.page(); await page.waitForFunction(() => window.__nozeliReady);
  // Observe actual renderer projections, not state.messages. No prompt interception.
  await page.evaluate(() => {
    window.__collabLiveObservations = {frames: [], domSamples: []};
    new MutationObserver(() => {
      const nodes = [...document.querySelectorAll('[data-message]')];
      const ids = nodes.map(n => n.dataset.message);
      const sample = {at: Date.now(), ids, native: nodes.filter(n => n.dataset.source === 'native').map(n => n.dataset.message), duplicate: new Set(ids).size !== ids.length};
      if (sample.duplicate || nodes.some(n => n.querySelector('[role="status"]'))) window.__collabLiveObservations.domSamples.push(sample);
    }).observe(document.querySelector('#conversation'), {childList: true, subtree: true, characterData: true});
    window.nozeli.subscribe('agent', e => {
      if (e.kind === 'managed-timeline') window.__collabLiveObservations.frames.push(e);
    });
  });
}
async function collectFrames() {
  if (!page) return;
  observations.streams.push(...await page.evaluate(() => window.__collabLiveObservations.frames.splice(0)));
  observations.domSamples = [...(observations.domSamples || []), ...await page.evaluate(() => window.__collabLiveObservations.domSamples.splice(0))];
}
async function close() {
  if (!page || !child || child.exitCode !== null || child.signalCode) return;
  await collectFrames(); await invoke('session.requestClose');
  assert.deepEqual(await Promise.race([exit, pause(90000).then(() => null)]), {code: 0, signal: null}, 'Normal app exit');
  await browser.disconnect(); browser = null; page = null;
}
async function selectWork(work) {
  const row = '[data-managed-work="' + work.id + '"]';
  if (await page.$eval('#toggle-sidebar', node => node.getAttribute('aria-expanded') !== 'true')) await click('#toggle-sidebar');
  await page.waitForSelector(row);
  await page.$eval(row + ' details', node => {if (!node.open) node.querySelector('summary').click();});
  await click(row + ' [data-managed-work-discuss]');
  await page.waitForFunction(target => document.querySelector('#conversation-panel').dataset.managedConversation === target, {}, work.id);
}
async function frozen(work, marker) {
  if(await page.$eval('#conversation-panel',node=>node.classList.contains('compact-composer')))await click('#chat-history-toggle');
  const s = await state();
  const receipt = s.receipts.filter(r => r.workId === work.id && r.revision === work.revision && (r.changeSetId || r.snapshot?.changeSetId)).at(-1);
  assert(receipt, 'Host result must have immutable changeSetId');
  const changeSetId = receipt.changeSetId || receipt.snapshot.changeSetId;
  const listing = await invoke('managed.changes.list', {projectId: id, changeSetId, limit: 100});
  const file = listing.files.find(f => f.path === 'shared.txt'); assert(file, 'Git frozen list contains shared.txt');
  const value = await invoke('managed.changes.read', {projectId: id, changeSetId, fileId: file.fileId});
  assert.equal(value.availability, 'available'); assert(value.after.text.includes(marker));
  const selector = '[data-change-set="' + changeSetId + '"] [data-frozen-file="' + file.fileId + '"]';
  await page.waitForSelector(selector);
  check('Frozen files outside collapsed native output: ' + work.name,
    await page.$eval(selector, node => !node.closest('details')) && await page.$eval(selector, node => !node.closest('.session-worker').querySelector('details').open));
  const before = await page.evaluate(() => {
    const node = document.querySelector('#reader-scroll .cm-content');
    window.__collabRetainedEditor = node;
    return {text: node?.textContent, scroll: document.querySelector('#reader-scroll').scrollTop, draft: document.querySelector('#composer').value};
  });
  await click(selector); await page.waitForSelector('.frozen-change-reader .cm-editor');
  check('Frozen Diff truly readonly: ' + work.name, await page.$$eval('.frozen-change-reader .cm-content', nodes => nodes.length === 2 && nodes.every(n => n.getAttribute('contenteditable') === 'false')));
  check('Frozen Diff contains candidate not original live file: ' + work.name, await page.$eval('.frozen-change-reader', (node, marker) => node.textContent.includes(marker), marker));
  await page.screenshot({path: path.join(root, 'diff-' + work.name + '-r' + work.revision + '.png')});
  await click('.frozen-change-reader .document-diff-head button');
  const after = await page.evaluate(() => ({sameNode: document.querySelector('#reader-scroll .cm-content') === window.__collabRetainedEditor,
    text: document.querySelector('#reader-scroll .cm-content')?.textContent, scroll: document.querySelector('#reader-scroll').scrollTop, draft: document.querySelector('#composer').value}));
  check('Diff back retains exact editor, selection container, scroll and unsent draft: ' + work.name,
    after.sameNode && after.text === before.text && after.scroll === before.scroll && after.draft === before.draft);
  // Expand the React Worker details through its real summary; inner tool folds too.
  await page.$eval(selector, node => node.closest('.session-worker').querySelector('summary').click());
  await page.waitForSelector('.session-worker-transcript [data-source="native"]');
  // React mounts nested tool content only after toggle, so open each real level.
  for (let level = 0; level < 4; level++) {
    await page.evaluate(() => {for (const summary of document.querySelectorAll('.session-worker-transcript details:not([open]) > summary')) summary.click();});
    await pause(75);
  }
  const native = (await timeline()).entries.filter(e => e.target === work.id && e.source === 'native' && !e.streaming);
  check('Full Worker native originals and tool identities: ' + work.name,
    native.some(e => e.speaker === 'agent') && native.some(e => e.tool?.toolCallId && e.tool.name));
  const currentNative = native.filter(entry => entry.revision === work.revision);
  const mountedIds = await page.$$eval('.session-worker-transcript [data-source="native"]', nodes => nodes.map(node => node.dataset.message));
  check('Expanded current round renders every native entry identity: ' + work.name,
    currentNative.length > 0 && currentNative.every(entry => mountedIds.includes(entry.id)));
  await page.screenshot({path: path.join(root, 'native-' + work.name + '-r' + work.revision + '.png'), fullPage: true});
  await page.$eval(selector, node => node.closest('.session-worker').querySelector('summary').click());
  return {changeSetId, fileId: file.fileId, value, listing};
}

async function stabilityAndRecovery(adoptedGit) {
  // All fault signals target this run's birth-stamped processes, never daily Nozeli.
  await page.focus('#composer');await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.press('Backspace');
  const began=Date.now();
  await compose('新建独立Work，名称严格为“Stability”。原任务包括长任务稳定性及之后人工要求的故障恢复核查，始终同一个Work，不扩展范围。Worker仅可新建/修改stability-heartbeat.jsonl和stability-result.txt，不碰其他文件，不Git不网络。先运行真实前台等待的node程序：以JSONL写入13条记录，tick从0到12，每条有Date.now()生成的at；第0条立即写，后续每15秒追加一条，总等待至少180秒，不得伪造时间或后台启动。设置足够长的工具timeout并等程序真实退出；然后写stability-result.txt为LONG_DONE并保留换行，实际读取两文件断言13条与时间跨度至少175000毫秒，发布result。后续用户会在这两个文件范围内安排崩溃恢复核查；不得自行派工或结束Work。',true);
  const work=await wait(async()=>{const s=await state();const w=s.works.find(w=>w.name==='Stability');return w?.execution?.directory?w:null;},'long task admitted');
  const heartbeat=path.join(work.execution.directory,'stability-heartbeat.jsonl'),result=path.join(work.execution.directory,'stability-result.txt');
  await wait(async()=>{try{return (await fs.readFile(heartbeat,'utf8')).trim().split('\n').length>=2;}catch(e){if(e.code!=='ENOENT')throw e;return false;}},'actual long task heartbeats',120000);
  await page.focus('#composer');await page.keyboard.sendCharacter('UNSENT_DURING_LONG_TASK');
  await wait(async()=>(await state()).drafts.frontdesk==='UNSENT_DURING_LONG_TASK','long task unsent draft');
  const beforeRenderer=await state(),rendererAdmissions=Object.keys(collector.snapshot().attempts).length;
  const nativeOwner=beforeRenderer.providers[work.id];assert(nativeOwner?.pid&&nativeOwner.stamp);
  const observer=await MainObserver.connect(inspectorURL);
  try{
    await observer.install(root,'owned-long-renderer-crash');
    const rendererBefore=await observer.state();
    // Only dialog choices are controlled here. The renderer really dies and the
    // installed WindowRecovery performs its real save settlement and reload.
    await observer.evaluate(`(()=>{const dialog=process.mainModule.require('electron').dialog;globalThis.__originalRecoveryDialog=dialog.showMessageBox;globalThis.__recoveryChoices=[];dialog.showMessageBox=function(win,options){if(['工作区恢复','确认重新加载'].includes(options.title)){__recoveryChoices.push({title:options.title,response:1});return Promise.resolve({response:1});}return __originalRecoveryDialog.call(this,win,options);};return true;})()`);
    const rendererStamp=await processStamp(rendererBefore.rendererPid);assert(rendererStamp,'Owned renderer birth identity exists');
    assert.equal(await processStamp(child.pid),child.ownedStamp);
    operations.push({layer:'actual-renderer-crash',pid:rendererBefore.rendererPid,stamp:rendererStamp,signal:'SIGKILL',dialogChoice:'explicit test-controlled confirmation',at:Date.now()});
    process.kill(rendererBefore.rendererPid,'SIGKILL');
    await wait(async()=>await observer.evaluate('__recoveryChoices.length===2'),'explicit renderer recovery confirmations',30000);
    await wait(async()=>{try{return await page.evaluate(()=>window.__nozeliReady===true&&document.querySelector('#composer')?.value==='UNSENT_DURING_LONG_TASK');}catch{return false;}},'actual renderer reload during long task',45000);
    const choices=await observer.evaluate('__recoveryChoices');
    assert.deepEqual(choices,[{title:'工作区恢复',response:1},{title:'确认重新加载',response:1}]);
    const rendererAfter=await observer.state();
    check('Renderer was physically replaced while main process remained alive',rendererAfter.rendererPid!==rendererBefore.rendererPid&&!rendererAfter.crashed&&await processStamp(child.pid)===child.ownedStamp,{beforePid:rendererBefore.rendererPid,afterPid:rendererAfter.rendererPid});
    const afterRenderer=await state();
    check('Actual renderer crash/reload keeps running native owner, draft, job and thread without replay',afterRenderer.jobs.length===beforeRenderer.jobs.length&&afterRenderer.providers[work.id]?.pid===nativeOwner.pid&&await processStamp(nativeOwner.pid)===nativeOwner.stamp&&Object.keys(collector.snapshot().attempts).length===rendererAdmissions&&afterRenderer.drafts.frontdesk==='UNSENT_DURING_LONG_TASK');
    await page.evaluate(()=>{window.__collabLiveObservations={frames:[],domSamples:[]};window.nozeli.subscribe('agent',event=>{if(event.kind==='managed-timeline')window.__collabLiveObservations.frames.push(event);});});
    await save('renderer-crash-choices.json',choices);await page.screenshot({path:root+'/renderer-recovered.png',fullPage:true});
  }finally{
    await observer.evaluate("process.mainModule.require('electron').dialog.showMessageBox=__originalRecoveryDialog;true").catch(()=>{});observer.close();
  }
  const done=await review('Stability');await settled('actual 180 second long task');
  const beats=(await fs.readFile(heartbeat,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(beats.map(row=>row.tick),Array.from({length:13},(_,i)=>i));
  assert(beats.every((row,i)=>Number.isSafeInteger(row.at)&&(!i||row.at-beats[i-1].at>=14000)));
  check('Real native long task stays connected for at least 180 seconds with real timed file evidence',Date.now()-began>=180000&&beats.at(-1).at-beats[0].at>=175000&&await fs.readFile(result,'utf8')==='LONG_DONE\n',{elapsedMs:Date.now()-began,beats});
  check('Long task never consumes unrelated unsent main draft',(await state()).drafts.frontdesk==='UNSENT_DURING_LONG_TASK');
  await save('long-task-state.json',await state());await page.screenshot({path:root+'/long-task.png',fullPage:true});

  const startInterruptedRound=async(marker)=>{
    await selectWork((await state()).works.find(w=>w.id===work.id));
    await compose(`继续原Work原任务的崩溃恢复核查，只操作stability-result.txt，保留heartbeat不变。先通过宿主文档工具真实读取并用返回的readHandle安全修改已有stability-result.txt为${marker}并保留换行，不得用shell或node覆盖已有文件。随后运行真实前台bash工具调用：node -e "setTimeout(()=>console.log('CRASH_WAIT_DONE'),120000)"；设置足够timeout，必须实际等待，工具中不写文件。不要后台化，不新增文件，不Git，不提前发布结果。等待完成后再次通过宿主文档工具读并修改为${marker}_UNEXPECTED_COMPLETION；若之后恢复时用户要求核查，先真实读取当前文件，不重放本条执行。`);
    return wait(async()=>{
      const s=await state(),job=s.jobs.findLast(j=>j.target===work.id&&j.status==='running');
      if(!job||(await fs.readFile(result,'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return '';}))!==marker+'\n')return null;
      const entries=(await timeline()).entries.filter(entry=>entry.jobId===job.id),waiting=entries.find(entry=>entry.toolCalls?.some(call=>call.name==='bash'&&JSON.stringify(call.input).includes('CRASH_WAIT_DONE')));
      const finished=waiting?.toolCalls?.some(call=>entries.some(entry=>entry.tool?.toolCallId===call.id));
      return waiting&&!finished?{job,state:s}:null;
    },marker+' actual tool executing',120000);
  };
  const resume=async(marker,oldThread)=>{
    const before=await state(),count=Object.keys(collector.snapshot().attempts).length;
    await selectWork(before.works.find(w=>w.id===work.id));
    await page.focus('#composer');await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');await page.keyboard.sendCharacter('UNSENT_RECOVERY_DRAFT');
    await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');
    await pause(300);
    check('Closed session rejects keyboard send visibly without consuming draft: '+marker,(await state()).jobs.length===before.jobs.length&&await page.$eval('#composer',n=>n.value==='UNSENT_RECOVERY_DRAFT')&&await page.$eval('#ai-status',n=>n.dataset.state==='failed'));
    await click('[data-managed-session-recovery="'+work.id+'"]');
    await wait(async()=>{const s=await state(),agent=s.agents.find(a=>a.target===work.id);const error=await page.$eval('#managed-session-recovery',n=>n.textContent);if(error.includes('恢复失败'))throw Error(error);return agent&&!agent.closed&&!agent.restarting?agent:null;},marker+' reading-mode recovery',120000);
    await pause(2000);
    const restored=await state();
    assert.equal(restored.jobs.length,before.jobs.length);
    assert.equal(restored.agents.find(a=>a.target===work.id).threadId,oldThread);
    check('Explicit recovery keeps unsent input intact: '+marker,restored.drafts[work.id]==='UNSENT_RECOVERY_DRAFT'&&await page.$eval('#composer',n=>n.value==='UNSENT_RECOVERY_DRAFT'));
    check('Explicit restart restores original Worker thread without replay: '+marker,Object.keys(collector.snapshot().attempts).length===count);
    await selectWork(restored.works.find(w=>w.id===work.id));
    await compose(`继续原任务的恢复核查，不重放原等待命令。先通过宿主文档工具实际读取stability-result.txt确认其仍为${marker}，读取heartbeat验证13条未变，然后使用当前readHandle将stability-result.txt安全修改为${marker}_RECOVERED并保留换行，用node仅真实读取断言后发布result。仅限原Work原文件，不shell覆盖已有文件，不Git不新建任务。`);
    const recovered=await review('Stability',before.works.find(w=>w.id===work.id).revision);await settled(marker+' explicit continuation');
    check('Explicit continuation preserves Work, original thread and execution directory: '+marker,recovered.id===work.id&&recovered.threadId===oldThread&&recovered.execution.directory===work.execution.directory&&await fs.readFile(result,'utf8')===marker+'_RECOVERED\n');
    assert.deepEqual((await fs.readFile(heartbeat,'utf8')).trim().split('\n').map(line=>JSON.parse(line)),beats);
    return recovered;
  };
  const native=await startInterruptedRound('NATIVE_CRASH_STARTED');
  const owner=native.state.providers?.[work.id];assert(owner?.pid&&owner.stamp&&await processStamp(owner.pid)===owner.stamp);
  owners.set(owner.pid,owner);operations.push({layer:'owned-native-fault',pid:owner.pid,stamp:owner.stamp,signal:'SIGKILL',jobId:native.job.id});
  process.kill(owner.pid,'SIGKILL');
  await wait(async()=>{const s=await state(),j=s.jobs.find(j=>j.id===native.job.id);return ['failed','interrupted'].includes(j?.status)&&!s.busyTargets.includes(work.id)?s:null;},'native crash recorded',90000);
  expectedFaults.add(native.job.id);
  check('Native crash preserves the exact accepted input and partial real file',await fs.readFile(result,'utf8')==='NATIVE_CRASH_STARTED\n'&&(await state()).jobs.find(j=>j.id===native.job.id).text===native.job.text);
  await resume('NATIVE_CRASH_STARTED',done.threadId);

  const host=await startInterruptedRound('HOST_CRASH_STARTED');
  for(const record of Object.values(host.state.providers||{}))if(record.pid&&record.stamp)owners.set(record.pid,record);
  const ledgerAtCrash=Object.keys(collector.snapshot().attempts).length,jobCount=host.state.jobs.length;
  await collectFrames();await save('before-host-crash-state.json',host.state);
  assert.equal(await processStamp(child.pid),child.ownedStamp);
  operations.push({layer:'owned-electron-fault',pid:child.pid,stamp:child.ownedStamp,signal:'SIGKILL',jobId:host.job.id});child.kill('SIGKILL');
  await exit;await browser.disconnect();browser=null;page=null;
  await launch();check('Crash reopen preserves initialized config',!await page.$eval('#configuration-setup',node=>node.open));
  await click('#pick-project');await invoke('managed.enable',{projectId:id});
  const afterHost=await wait(async()=>{const s=await state(),j=s.jobs.find(j=>j.id===host.job.id);return ['failed','interrupted'].includes(j?.status)&&!s.busyTargets.length?s:null;},'host crash ownership recovery',120000);
  expectedFaults.add(host.job.id);
  check('Host crash recovers native owners without HTTP or job replay',Object.keys(collector.snapshot().attempts).length===ledgerAtCrash&&afterHost.jobs.length===jobCount&&afterHost.jobs.find(j=>j.id===host.job.id).text===host.job.text);
  check('Host crash keeps partial file, user draft and original Work/thread',await fs.readFile(result,'utf8')==='HOST_CRASH_STARTED\n'&&afterHost.drafts.frontdesk==='UNSENT_DURING_LONG_TASK'&&afterHost.works.find(w=>w.id===work.id).threadId===done.threadId);
  assert.deepEqual(await gitSnapshot(),adoptedGit);
  const recovered=await resume('HOST_CRASH_STARTED',done.threadId);
  await save('recovered-state.json',await state());await page.screenshot({path:root+'/recovered-final.png',fullPage:true});
  await invoke('managed.end',{projectId:id,workId:work.id,revision:recovered.revision,decision:'discard'});
  await wait(async()=>{const w=(await state()).works.find(w=>w.id===work.id);if(w.closure?.phase==='blocked')throw Error(w.closure.error);return w.status==='ended'&&w.closure?.phase==='complete';},'recovered Work clean disposal',120000);
  assert.deepEqual(await gitSnapshot(),adoptedGit);assert.deepEqual(await officialMetadata(),officialBefore);
  check('Both crash recoveries leave original staged/dirty files and official config unchanged',true);
  await save('fault-jobs.json',(await state()).jobs.filter(j=>expectedFaults.has(j.id)));
}

try {
  await fs.mkdir(project);
  for (const [name, text] of Object.entries({'shared.txt': 'BASE_SHARED\n', 'frontdesk.md': '# Frontdesk\nBASE_FRONT\n', 'reader.js': 'const retained = "OWNED_READER";\n', 'staged.txt': 'BASE_STAGE\n', 'dirty.txt': 'BASE_DIRTY\n'})) await fs.writeFile(path.join(project, name), text);
  await git('init'); await git('config', 'user.name', 'Nozeli Owned Acceptance'); await git('config', 'user.email', 'owned-acceptance@invalid.local');
  await git('add', '.'); await git('commit', '-m', 'Owned acceptance input');
  await fs.writeFile(project + '/staged.txt', 'USER_STAGED_PROTECTED\n'); await git('add', 'staged.txt');
  await fs.writeFile(project + '/dirty.txt', 'USER_DIRTY_PROTECTED\n');
  const originalGit = await gitSnapshot();
  collector = await createAcceptanceCollector({ledgerPath: root + '/ledger.json',
    allowedDestinations: ['https://sub.1983070.xyz/responses', 'https://sub.1983070.xyz/v1/responses'], allowedModels: ['gpt-6.1-sol'],
    onStop: async reason => {if (!['complete', 'failure'].includes(reason) && child?.exitCode === null) child.kill('SIGTERM');}});
  await launch();
  await page.waitForSelector('#configuration-setup[open]');
  await click('#configuration-api-keys'); await click('#configuration-import');
  await page.waitForFunction(() => !document.querySelector('#configuration-setup').open);
  const setup = await invoke('config.status'); check('Explicit private static-key import only', setup.initialized && setup.choice === 'import');
  const control = path.join(privateRoot, 'control'); await fs.mkdir(control, {recursive: true});
  const extension = path.join(control, 'acceptance.mjs');
  await fs.writeFile(extension, `import {installAcceptanceControl} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, 'acceptance-request-control.mjs')).href)};\nexport default pi => installAcceptanceControl(pi,{endpoint:${JSON.stringify(collector.endpoint)},roleInstance:process.env.NOZELI_AGENT_DIR,brokerURL:process.env.OMP_AUTH_BROKER_URL??null});\n`, {mode: 0o600});
  const configPath = path.join(privateRoot, 'omp/config.yml'), config = parse(await fs.readFile(configPath, 'utf8'));
  config.modelRoles = Object.fromEntries(['default', 'smol', 'slow', 'plan', 'designer'].map(role => [role, 'paratera/gpt-6.1-sol']));
  config.defaultThinkingLevel = 'low'; config.extensions = [extension];
  await fs.writeFile(configPath, stringify(config), {mode: 0o600});
  await click('#pick-project');
  id = await wait(async () => (await invoke('project.recent')).projects.find(p => p.name === 'project')?.id, 'owned project');
  runtime=(await invoke('managed.status',{projectId:id})).runtimeRoot;
  assert(runtime.startsWith(profile + '/'), 'Runtime must be under private profile before starting native owners');
  await invoke('managed.enable', {projectId: id});
  runtime = (await wait(async () => {const s = await invoke('managed.status', {projectId: id}); return s.ready ? s : null;}, 'native residents', 120000)).runtimeRoot;
  assert(runtime.startsWith(profile + '/'), 'Runtime must be under private profile');
  await invoke('managed.limit',{projectId:id,limit:2});
  await compose('直接修改frontdesk.md：将BASE_FRONT替换为FRONTDESK_CAS_SAVED。使用现有文档工具读取当前版本并保存，不能绕过版本检查。不转后台，不操作其他文件，不使用网络或其他Agent。回复明确说明保存结果。');
  await settled('Frontdesk actual document operation');
  check('Frontdesk saves through production document CAS', (await fs.readFile(project + '/frontdesk.md', 'utf8')).includes('FRONTDESK_CAS_SAVED') &&
    (await invoke('document.history', {projectId: id, relPath: 'frontdesk.md'})).events.some(e => e.actor.role === 'frontdesk'));
  const firstFront=(await state()).jobs.filter(j=>j.target==='frontdesk');assert.equal(firstFront.length,1,'one physical Ctrl+Enter accepts exactly one input');
  const firstNative=(await timeline()).entries.filter(e=>e.jobId===firstFront[0].id&&['agent','tool'].includes(e.speaker));
  await page.waitForFunction(ids=>[...document.querySelectorAll('.session-message')].filter(n=>ids.includes(n.dataset.message)).length===1,{},firstNative.map(e=>e.id));
  check('Actual frontdesk tool round has one reply bubble and one action row',await page.$$eval('.session-message',(nodes,ids)=>{const rows=nodes.filter(n=>ids.includes(n.dataset.message));return rows.length===1&&rows[0].querySelectorAll(':scope>.message-actions').length===1;},firstNative.map(e=>e.id)));
  const baselineGit = await gitSnapshot();
  assert.equal(baselineGit.head, originalGit.head); assert.equal(baselineGit.index, originalGit.index); assert.equal(baselineGit.staged, originalGit.staged);
  await click('#file-tree button[data-path="reader.js"]');
  await page.waitForFunction(() => document.querySelector('#file-path').textContent === 'reader.js');
  const beforeTag=(await state()).jobs.length;
  await page.evaluate(()=>window.__nozeliInput.select(0,Math.min(30,window.__nozeliInput.text().length)));
  await click('#selection-discuss');await page.waitForSelector('.tag-editor',{visible:true});
  await page.focus('.tag-editor');await page.keyboard.sendCharacter('请只解释这个选区中retained的字符串值，不修改任何文件，不转后台。标记TAG_KEYBOARD_REAL。');
  await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');
  await wait(async()=>(await state()).jobs.length===beforeTag+1,'selection keyboard unique admission');
  await settled('selection tag real keyboard response');
  check('Selection Ctrl+Enter gets one real native reply without altering the source',await page.$eval('.tag-transcript',n=>n.textContent.includes('OWNED_READER'))&&await fs.readFile(project+'/reader.js','utf8')==='const retained = "OWNED_READER";\n');
  const task = (name, marker) => `新建一个独立Work，名称严格为“${name}”。Orchestrator只调度，不读写业务文件；Worker在自己的独立worktree执行：读取shared.txt，将内容改为${marker}并保留换行，新增${name.toLowerCase()}-new.txt内容为${marker}_NEW。运行node读取断言两文件的精确内容。发布result明确列出两个实际文件和验证结果，报告包含标记${marker}。不要Git操作、不要网络、不要其他Agent，不碰dirty.txt/staged.txt/reader.js/frontdesk.md。仅在真实越出范围时先报告任务偏移，不要人为扩展任务。`;
  await compose(task('CollabA', 'WORK_A_FIRST'), true);
  const a = await review('CollabA'); await settled('A first review');
  await compose(task('CollabB', 'WORK_B_FIRST'), true);
  const b = await review('CollabB'); await settled('B first review');
  check('Two independent actual Git worktrees', a.execution.directory !== b.execution.directory && a.execution.directory !== project && b.execution.directory !== project &&
    (await run('git', ['-C', a.execution.directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim() === (await run('git', ['-C', b.execution.directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim());
  check('Same path has genuinely isolated candidate contents', (await fs.readFile(a.execution.directory + '/shared.txt', 'utf8')).trim() === 'WORK_A_FIRST' &&
    (await fs.readFile(b.execution.directory + '/shared.txt', 'utf8')).trim() === 'WORK_B_FIRST' && (await fs.readFile(project + '/shared.txt', 'utf8')).trim() === 'BASE_SHARED');
  await page.focus('#composer'); await page.keyboard.sendCharacter('UNSENT_FRONTDESK_DRAFT_DO_NOT_SEND');
  await wait(async () => (await state()).drafts.frontdesk === 'UNSENT_FRONTDESK_DRAFT_DO_NOT_SEND', 'draft persistence');
  const oldA = await frozen(a, 'WORK_A_FIRST'), oldB = await frozen(b, 'WORK_B_FIRST');
  check('Actual frozen Git lists contain both modifications and additions', [oldA, oldB].every(v => v.listing.files.length === 2 && v.listing.files.some(f => f.status === 'A')));
  await selectWork(a);
  await compose('在原Work原线程继续，将shared.txt改为WORK_A_SECOND并保留换行，更新collaba-new.txt为WORK_A_SECOND_NEW。用node读取断言后发布新的result，明确列出真实两文件。不要新建Work，不要Git，不扩大范围。', true);
  const a2 = await review('CollabA', a.revision); await settled('A GUI continuation');
  check('GUI supplement keeps original Worker thread and worktree', a2.threadId === a.threadId && a2.execution.directory === a.execution.directory && (await state()).works.length === 2);
  await frozen(a2, 'WORK_A_SECOND');
  await selectWork(b);
  if (!await page.$eval('body', node => node.classList.contains('provider-console-open'))) await click('#provider-console-toggle');
  const terminalSelector = '[data-managed-terminal="' + b.id + '"] .xterm-helper-textarea';
  await page.waitForSelector(terminalSelector);
  await page.waitForFunction(target => document.querySelector('[data-managed-terminal="' + target + '"] .provider-output')?.dataset.terminalState === 'attached', {}, b.id);
  const beforeManual = await state(), manualIds = new Set(beforeManual.jobs.map(j => j.id));
  const attachment = await invoke('managed.terminal.attach', {projectId: id, target: b.id});
  // Real human keyboard path through xterm -> native PTY -> native manual admission.
  operations.push({layer: 'real-native-tui-keyboard', target: b.id, terminalId: attachment.terminalId, at: Date.now()});
  await page.focus(terminalSelector);
  await page.keyboard.sendCharacter('在原Work原线程继续，将shared.txt改为WORK_B_NATIVE并保留换行。用node读取断言，发布新的result说明NATIVE_MANUAL_B完成，仍待审查。不得新建Work、不得Git、不扩大范围。');
  await pause(300); await page.keyboard.press('Enter');
  const b2 = await review('CollabB', b.revision), afterManual = await settled('B actual native TUI continuation');
  const added = afterManual.jobs.filter(j => !manualIds.has(j.id));
  check('Native input has one manual job and zero secondary GUI prompts', added.length === 1 && added[0].manual === true && added[0].type === 'manual' && added[0].manualPromptId && added[0].target === b.id);
  check('Native manual round preserves thread and terminal identity', b2.threadId === b.threadId && attachment.threadId === b.threadId &&
    (await invoke('managed.terminal.attach', {projectId: id, target: b.id})).terminalId === attachment.terminalId);
  const manualNative = (await timeline()).entries.filter(e => e.jobId === added[0].id && e.source === 'native');
  check('Manual job owns native tool results and original session', manualNative.some(e => e.tool?.toolCallId && e.tool.name) && manualNative.every(e => e.sessionId === b.threadId));
  await click('#provider-console-toggle');
  await frozen(b2, 'WORK_B_NATIVE');
  await collectFrames();
  const projection = await timeline();
  check('Durable native timeline has no stream-entry duplicates', projection.entries.every(e => !e.streaming) &&
    new Set(projection.entries.filter(e => e.source === 'native').map(e => e.sessionId + ':' + e.entryId)).size === projection.entries.filter(e => e.source === 'native').length);
  const frames = observations.streams.flatMap(e => (e.frame || e.timeline || e).entries || []);
  const streams = frames.filter(e => e.streaming && e.source === 'native');
  check('Observed actual native stream replacement, not aggregated messages', streams.length > 0 && streams.every(stream => projection.entries.some(e => !e.streaming && e.source === 'native' && (e.id === stream.id || e.replacesId === stream.id || e.sessionId === stream.sessionId && e.requestId === stream.requestId))));
  check('Actual rendered streaming messages remain identity-deduplicated', observations.domSamples.length > 0 && observations.domSamples.every(sample => !sample.duplicate));
  check('Orchestrator displays committed host deltas', projection.deltas.length > 0 && await page.$$eval('[data-host-delta]', nodes => nodes.length > 0));
  check('Orchestrator never performs Worker business document edits', !projection.entries.some(e => e.target === 'orchestrator' && e.tool && /nozeli_document_apply|write|edit|bash/.test(e.tool.name)));
  assert.deepEqual(await gitSnapshot(), baselineGit);
  check('Original HEAD/index/staged/dirty and source files protected', true);
  // Explicit decisions through exact existing production IPC, not test/controller internals.
  // Acceptance authorizes host integration of the precise frozen candidate only.
  for (const [work, decision] of [[a2, 'accept'], [b2, 'discard']]) {
    await invoke('managed.end', {projectId: id, workId: work.id, revision: work.revision, decision});
    await wait(async () => {const w = (await state()).works.find(w => w.id === work.id); if (w.closure?.phase === 'blocked') throw Error(w.closure.error); return w.status === 'ended' && w.outcome === decision && w.closure?.phase === 'complete';}, decision + ' technical cleanup', 120000);
    check(decision + ' removes only owned execution worktree', !await fs.stat(work.execution.directory).catch(e => {if (e.code !== 'ENOENT') throw e;}));
  }
  for (const old of [oldA, oldB]) {
    assert.deepEqual(await invoke('managed.changes.read', {projectId: id, changeSetId: old.changeSetId, fileId: old.fileId}), old.value);
  }
  check('Old immutable changeSets remain readable after both cleanups', true);
  const adoptedGit=await gitSnapshot();
  assert.equal(adoptedGit.staged,baselineGit.staged);assert.notEqual(adoptedGit.head,baselineGit.head);
  assert.equal((await fs.readFile(project+'/shared.txt','utf8')).trim(),'WORK_A_SECOND');
  assert.equal(await fs.readFile(project+'/dirty.txt','utf8'),'USER_DIRTY_PROTECTED\n');
  assert.equal(await fs.readFile(project+'/staged.txt','utf8'),'USER_STAGED_PROTECTED\n');
  const beforeCold = await state(), ledgerCount = Object.keys(collector.snapshot().attempts).length;
  const identities = s => ({residents: Object.fromEntries(Object.entries(s.residents).map(([k, v]) => [k, v.threadId])), works: s.works.map(w => [w.id, w.threadId, w.revision])});
  await save('before-cold-state.json', beforeCold); await save('timeline.json', projection);
  await close(); await launch();
  check('Cold open does not repeat setup', !await page.$eval('#configuration-setup', node => node.open));
  await click('#pick-project'); await invoke('managed.enable', {projectId: id});
  await wait(async () => (await invoke('managed.status', {projectId: id})).ready, 'cold residents', 120000);
  await pause(3000);
  const cold = await state();
  assert.deepEqual(identities(cold), identities(beforeCold));
  assert.deepEqual(cold.jobs.map(j => [j.id, j.status]), beforeCold.jobs.map(j => [j.id, j.status]));
  check('Cold open preserves sessions with zero HTTP admission and zero job replay', Object.keys(collector.snapshot().attempts).length === ledgerCount);
  check('Unsent frontdesk draft survives all operations and cold reopen', cold.drafts.frontdesk === 'UNSENT_FRONTDESK_DRAFT_DO_NOT_SEND');
  assert.deepEqual(await gitSnapshot(), adoptedGit); assert.deepEqual(await officialMetadata(), officialBefore);
  check('Accepted Git state, protected user files and official auth/config metadata survive cold reopen', true);
  await stabilityAndRecovery(adoptedGit);
  await save('final-state.json', await state()); await page.screenshot({path: root + '/cold-final.png', fullPage: true});
  observations.deviation = {triggered: observations.deviations.length > 0, policy: 'Only real scope deviations reported; no random provoke/retry. Deterministic deviation/unknown coverage belongs to separate tests.'};
  await close(); check('Final Electron exit is normal', true);
} catch (error) {
  failure = error;
  await collector?.stop('failure');
  await save('error.json', {name: error.name, message: error.message, stack: error.stack, response: error.response, job: error.job});
  if (page) {
    await Promise.race([state().then(value=>save('failure-state.json',value),e=>save('failure-state.json',{error:e.stack})),pause(10000)]);
    if(!page.isClosed())await Promise.race([page.screenshot({path: root + '/failure.png',fullPage:true}).catch(()=>{}),pause(10000)]);
  }
} finally {
  // Stop paid admission first on failure; never auto-discard a failed Work or retry it.
  await collector?.stop(failure ? 'failure' : 'complete');
  if (page) await collectFrames().catch(() => {});
  try {await close();} catch (e) {failure ??= e;}
  await browser?.disconnect().catch(() => {});
  // Last-resort owned Electron group reap, gated by Linux PID birth identity.
  if (child?.ownedStamp && await processStamp(child.pid) === child.ownedStamp) {
    child.kill('SIGTERM');
    const ended = await Promise.race([exit, pause(5000).then(() => null)]);
    if (!ended && await processStamp(child.pid) === child.ownedStamp) process.kill(-child.pid, 'SIGKILL');
    await Promise.race([exit, pause(5000)]);
  }
  // Native OMP providers can outlive Electron. Verify private-home identity before signals.
  if (runtime) {
    const stored = JSON.parse(await fs.readFile(runtime + '/state.json', 'utf8').catch(() => '{}'));
    for (const record of Object.values(stored.providers || {})) if (record.pid && record.stamp) owners.set(record.pid, record);
  }
  let reaped = true;
  for (const record of owners.values()) {
    try {
      const receipt = await recoverOmpProvider(record, runtime);
      assert.equal(receipt.verified, true, 'Native owner and descendants reaped');
    } catch (e) {reaped = false; failure ??= e;}
  }
  if (reaped) {
    // Retain raw native journals, errors and frozen objects, never copied credentials.
    if (runtime) for (const entry of await fs.readdir(runtime + '/agents', {withFileTypes: true}).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const home = path.join(runtime, 'agents', entry.name);
      await fs.cp(home + '/sessions', root + '/native-history/' + entry.name, {recursive: true}).catch(e => {if (e.code !== 'ENOENT') throw e;});
      await fs.rm(home, {recursive: true, force: true});
    }
    await fs.rm(privateRoot + '/omp', {recursive: true, force: true});
  }
  await fs.writeFile(root + '/electron.log', log, {mode: 0o600});
  await save('observations.json', observations); await save('operations.json', operations);
  await save('result.json', {pass: !failure, error: failure?.stack, checks, release, root, runtime,
    officialBefore, officialAfter: await officialMetadata(), ownedKeysRemoved: reaped, ledger: collector?.snapshot(),
    scope: 'Actual installed Electron, paid native OMP, two isolated Workers, GUI/native continuations, immutable Git Diff, exact accept/discard and cold zero replay; real 180-second timed native tool, real renderer/native/main process termination and explicit same-thread recovery. Renderer recovery confirmation choices are controlled through the owned main Inspector, not OS-dialog input acceptance. No model-list probes, user papers, OAuth copies, simulated model responses or automatic failed-operation retries.'});
  await collector?.close();
}
console.log(JSON.stringify({pass: !failure, checks: checks.length, root}));
process.exitCode = failure ? 1 : 0;
