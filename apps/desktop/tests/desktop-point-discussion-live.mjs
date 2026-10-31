// Real-Electron acceptance for Design-2 point discussions: bundled OMP
// frontdesk, deterministic loopback OpenAI-protocol model only. No user
// projects, profiles, credentials or paid calls. A right-click document
// position WITHOUT a selection becomes a real position discussion (在此讨论);
// the explicit send goes through the actual tag composer, and the frozen
// material must be the correct source (digest-verified, real
// nozeli_document_read round-trip, no fabricated quote/screenshot). Ordinary
// 解释 stays selection-only: disabled without an effective selection, and a
// real selection explanation freezes that quote. Opening/saving never
// dispatches. Development tree:
//   NOZELI_TEST_APP_ROOT=/.../apps/desktop NOZELI_TEST_BINARY=/.../node_modules/.bin/electron node apps/desktop/tests/desktop-point-discussion-live.mjs
// Installed release: NOZELI_INSTALLED_BINARY=/.../nozeli node apps/desktop/tests/desktop-point-discussion-live.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';

assert.equal(process.platform, 'linux', 'Native installed acceptance currently requires Linux');
if (Boolean(process.env.NOZELI_TEST_APP_ROOT) !== Boolean(process.env.NOZELI_TEST_BINARY)) throw Error('Development mode requires both NOZELI_TEST_APP_ROOT and NOZELI_TEST_BINARY');
const mode = process.env.NOZELI_INSTALLED_BINARY ? 'installed' : process.env.NOZELI_TEST_APP_ROOT ? 'development' : null;
if (!mode) throw Error('Pass NOZELI_INSTALLED_BINARY (installed release executable) or both NOZELI_TEST_APP_ROOT and NOZELI_TEST_BINARY (development tree)');
const binary = await fs.realpath(mode === 'installed' ? process.env.NOZELI_INSTALLED_BINARY : process.env.NOZELI_TEST_BINARY);
const installedApp = mode === 'installed' ? path.join(path.dirname(binary), 'resources/app') : await fs.realpath(process.env.NOZELI_TEST_APP_ROOT);
const manifest = JSON.parse(await fs.readFile(path.join(installedApp, 'package.json'), 'utf8'));
await fs.access(path.join(installedApp, mode === 'installed' ? (manifest.main || 'src/main/main.cjs') : 'src/main/main.cjs'));
await fs.access(path.join(installedApp, 'runtime/omp/omp'), fs.constants.X_OK);
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-point-discussion-'));
const project = path.join(out, 'source-project'), unrelatedCwd = path.join(out, 'unrelated-launch-directory'), home = path.join(out, 'home');
for (const directory of [project, unrelatedCwd, home]) await fs.mkdir(directory);
const material = 'Isolated point discussion source material line.\nThe model must read exactly this frozen file through the allowed tool.\nA third line keeps the text surface plain and stable.\n';
await fs.writeFile(path.join(project, 'material.txt'), material);
const materialDigest = crypto.createHash('sha256').update(material).digest('hex');
const rounds = [
  {name: 'point-round', question: 'POINT_DISCUSSION_Q_6101 answer this document position in two parts', first: 'POINT_FIRST_PART_6101', final: 'POINT_FINAL_PART_6101'},
  {name: 'explain-round', question: '请解释这处选区。', first: 'EXPLAIN_FIRST_6102', final: 'EXPLAIN_FINAL_6102'},
];
const report = {ok: false, mode, scope: 'Real Electron (' + mode + ') + bundled native OMP frontdesk + real right-click position-discuss UI; deterministic local OpenAI SSE model (not a paid model); point material frozen to the correct source; explain requires an effective selection', binary, installedApp, out, materialDigest, phases: [], errors: []};
const modelInputs = [], protocolErrors = [];
let activeRound, child, exit, browser, shell, documentPage, chat, projectId, pointAnnotationId, mainLog = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (protocolErrors.length) throw Error('Protocol error (failing fast): ' + protocolErrors[0]);
    const value = await fn();
    if (value) return value;
    await pause(100);
  }
  throw Error('Timeout: ' + label);
}
async function save() {
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(out, 'model-requests.json'), JSON.stringify(modelInputs, null, 2));
}
// Deterministic loopback model: text + one real allowed read tool call, then
// the final text — two canonical assistant entries in the SAME request.
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      assert.equal(req.method, 'POST');
      assert.match(req.url, /^\/v1\/chat\/completions\/?$/);
      const input = JSON.parse(body);
      modelInputs.push(input);
      if (!activeRound) throw Error('Unexpected model request outside an active round (implicit-dispatch guard)');
      activeRound.requests.push(modelInputs.length - 1);
      const ordinal = activeRound.requests.length;
      assert(ordinal <= 2, 'One discussion turn is exactly one text+tool-call request and one tool-result continuation');
      const toolCallId = 'point-live-' + activeRound.name;
      if (ordinal === 1) {
        assert(input.tools?.some(tool => tool.function?.name === 'nozeli_document_read'), 'Real OMP frontdesk must advertise the allowed read tool nozeli_document_read');
        const userMessages = input.messages.filter(message => message.role === 'user');
        assert(userMessages.some(message => JSON.stringify(message.content ?? '').includes(activeRound.question)), 'This round\'s question must reach the real model request as user input');
      } else {
        const tool = input.messages.find(message => message.role === 'tool' && message.tool_call_id === toolCallId);
        assert(tool, 'Continuation must contain the executed nozeli_document_read result');
        activeRound.toolResult = String(tool.content ?? '').slice(0, 400);
      }
      const delta = ordinal === 1
        ? {role: 'assistant', content: activeRound.first, tool_calls: [{index: 0, id: toolCallId, type: 'function', function: {name: 'nozeli_document_read', arguments: JSON.stringify({relPath: 'material.txt'})}}]}
        : {role: 'assistant', content: activeRound.final};
      res.writeHead(200, {'content-type': 'text/event-stream'});
      for (const [fragment, finish] of [[delta, null], [{}, ordinal === 1 ? 'tool_calls' : 'stop']]) {
        res.write('data: ' + JSON.stringify({id: 'point-live-' + modelInputs.length, object: 'chat.completion.chunk', choices: [{index: 0, delta: fragment, finish_reason: finish}]}) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      protocolErrors.push(error.stack);
      res.writeHead(500, {'content-type': 'application/json'});
      res.end(JSON.stringify({error: {message: error.message}}));
    }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const debugPort = await new Promise(resolve => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
});
const env = {...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'), NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: path.join(out, '.Nozeli'), NOZELI_USER_DATA: path.join(out, '.Nozeli/desktop'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(debugPort), NOZELI_HIDDEN: '0'};
for (const key of Object.keys(env)) if (/^(?:CCB_|CODEX_|PI_|OMP_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
delete env.NOZELI_AGENT_FIXTURE;
async function invoke(op, payload = {}, page = shell) {
  const result = await page.evaluate(({op, payload}) => nozeli.invoke(op, payload), {op, payload});
  if (!result.ok) throw Object.assign(Error(op + ': ' + result.error.message), {code: result.error.code});
  return result.value;
}
async function status() { return (await invoke('managed.status', {projectId})).state; }
async function scoped(predicate, label) {
  return until(async () => {
    for (const page of await browser.pages()) {
      const scope = await page.evaluate(() => window.__workspaceScope).catch(() => null);
      if (scope && predicate(scope) && await page.evaluate(() => window.__nozeliReady)) return page;
    }
  }, label);
}
async function launch() {
  child = spawn(binary, [...(mode === 'development' ? [path.join(installedApp, 'src/main/main.cjs')] : []), '--ozone-platform=' + (process.env.NOZELI_TEST_OZONE_PLATFORM || process.env.NOZELI_OZONE || 'wayland')], {cwd: unrelatedCwd, env, stdio: ['ignore', 'pipe', 'pipe']});
  exit = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({code, signal})); child.once('error', reject); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { mainLog += data; });
  await until(async () => { try { browser = await puppeteer.connect({browserURL: 'http://127.0.0.1:' + debugPort, defaultViewport: null}); return true; } catch { return false; } }, 'installed browser');
  shell = await scoped(scope => scope.role === 'shell', 'workspace shell surface');
  shell.on('pageerror', error => report.errors.push('shell: ' + error.message));
  await shell.waitForFunction(() => window.__nozeliReady);
}
async function closeNormally() {
  await invoke('session.requestClose');
  const confirmPage = await Promise.race([
    (async () => {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        for (const page of await browser.pages()) {
          if (await page.$eval('#quit-choice', node => node.open).catch(() => false)) return page;
        }
        if (child.exitCode !== null) return null;
        await pause(150);
      }
      return null;
    })(),
    exit.then(() => null),
  ]);
  if (confirmPage) {
    report.shutdownConfirmations ??= [];
    report.shutdownConfirmations.push({choice: '取消任务并退出', scope: 'This isolated test instance only; both rounds already completed'});
    await confirmPage.click('#quit-cancel');
  }
  assert.deepEqual(await Promise.race([exit, pause(45000).then(() => null)]), {code: 0, signal: null}, 'App must exit normally, not be killed');
  await browser.disconnect();
  browser = undefined;
}
async function screenshot(page, name) {
  await page.bringToFront();
  const filename = name + '.png';
  await page.screenshot({path: path.join(out, filename)});
  return filename;
}
const menu = '#document-context-menu';
const itemState = command => documentPage.evaluate(({menu, command}) => {const node = document.querySelector(menu + ' [data-command="' + command + '"]'); return node ? {present: true, disabled: node.disabled || node.getAttribute('aria-disabled') === 'true', label: node.textContent.trim()} : {present: false, disabled: true, label: ''};}, {menu, command});
async function annotations() {
  return (await invoke('annotation.list', {projectId, relPath: 'material.txt'})).annotations || [];
}
async function canonicalEntries(requestId) {
  return shell.evaluate(async ({projectId, requestId}) => {
    const ids = [];
    let offset = 0;
    for (;;) {
      const page = await nozeli.invoke('managed.timeline.request', {projectId, requestId, offset});
      if (!page.ok) return {error: page.error.message};
      ids.push(...(page.value?.ids || []));
      offset = page.value?.nextOffset ?? null;
      if (offset == null) break;
    }
    const entries = [];
    for (const id of ids) {
      const read = await nozeli.invoke('managed.timeline.read', {projectId, id});
      const entry = read.ok ? (read.value?.entry ?? read.value) : null;
      if (entry) entries.push({id: entry.id, speaker: entry.speaker, target: entry.target, requestId: entry.requestId ?? null, durable: entry.durable === true, text: entry.text || '', materialSources: entry.materialSources || []});
    }
    return {entries};
  }, {projectId, requestId});
}
const phase=round=>{let existing=report.phases.find(item=>item.round===round);if(!existing){existing={round,checks:[]};report.phases.push(existing);}return existing;};
function check(phase, name, condition, evidence) {
  assert(condition, phase.round + ': ' + name);
  phase.checks.push({name, evidence: evidence ?? null});
}
try {
  await launch();
  await invoke('config.initialize', {mode: 'independent'});
  await invoke('settings.providers.save', {operation:'create',provider:'point-local',baseUrl:'http://127.0.0.1:' + server.address().port + '/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-only'}});
  await invoke('settings.models.save', {frontdesk:{model:{mode:'explicit',selector:'point-local/scripted'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'explicit',selector:'point-local/scripted'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'point-local/scripted'},thinking:{mode:'native-default'}}});
  if (await shell.$eval('#configuration-setup', node => node.open)) await shell.click('#configuration-cancel');
  await shell.click('#pick-project');
  projectId = await until(async () => (await invoke('workspace.bootstrap')).projectId, 'source project');
 report.projectId = projectId;report.scene=process.env.NOZELI_POINT_DISCUSSION_SCENE||'full';
 const explainOnly=process.env.NOZELI_POINT_DISCUSSION_SCENE==='explain';
  await invoke('managed.enable', {projectId});
  await until(async () => (await invoke('managed.status', {projectId})).ready, 'bundled OMP ready');
  await shell.waitForSelector('#file-tree button[data-path="material.txt"]', {visible: true});
  await shell.click('#file-tree button[data-path="material.txt"]');
  documentPage = await scoped(scope => scope.role === 'surface' && scope.kind === 'document' && scope.projectId === projectId && scope.relPath === 'material.txt', 'document surface for material.txt');
  documentPage.on('pageerror', error => report.errors.push('document: ' + error.message));
  await documentPage.waitForFunction(() => (window.__nozeliInput?.text() || '').includes('Isolated point discussion source material'));

  // ---- Phase 1: right-click WITHOUT a selection → position discussion ----
  if(!explainOnly){
  const pointPhase=phase('point-created');
  const leaf = await documentPage.evaluate(() => {const leaf = document.querySelector('#text-host .cm-line, #text-preview [data-md-from]'); const b = leaf.getBoundingClientRect(); return {x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2};});
  await documentPage.mouse.click(leaf.x, leaf.y, {button: 'right'});
  await documentPage.waitForSelector(menu + ':not([hidden])', {timeout: 15000});
  const noteItem = await itemState('note-here');
  check(pointPhase, 'no-selection right-click offers 在此备注 (a position, not a selection)', noteItem.present && !noteItem.disabled && noteItem.label.includes('在此'), noteItem);
  const explainItem = await itemState('explain-selection');
  check(pointPhase, 'explain stays disabled without an effective selection', explainItem.disabled === true, explainItem);
  const discussItem = await itemState('discuss-here');
  check(pointPhase, '在此讨论 is offered on the document position', discussItem.present && !discussItem.disabled && discussItem.label.includes('在此'), discussItem);
  const beforeRequests = modelInputs.length;
  await documentPage.click(menu + ' [data-command="discuss-here"]');
  await documentPage.waitForSelector('.tag-discuss .tag-composer .tag-editor', {visible: true, timeout: 15000});
  check(pointPhase, 'opening the position discussion dispatches nothing', modelInputs.length === beforeRequests, {before: beforeRequests, after: modelInputs.length});
  check(pointPhase, 'position discussion is clearly labeled (no fake quote card)', await documentPage.$eval('.tag-discuss', node => node.textContent.includes('位置讨论')));
  const created = (await annotations()).find(item => item.kind === 'text-point');
  assert(created, 'a text-point annotation was persisted for the discussion');
  pointAnnotationId = created.id;
  check(pointPhase, 'point anchor is zero-length and quote-free', created.anchor.start === created.anchor.end && created.anchor.quote === '', created.anchor);

  // The real host material handoff for the point (no fabricated quote, no
  // screenshot, accurate nearby context from the frozen material).
  const materialHandoff = await invoke('tag.material', {projectId, relPath: 'material.txt', annotationId: pointAnnotationId}, documentPage);
  check(pointPhase, 'tag.material returns the point kind with no quote', materialHandoff.kind === 'text-point' && !(materialHandoff.information?.location?.context?.quote), materialHandoff.information?.location);
  check(pointPhase, 'nearby context is computed from the frozen material', typeof materialHandoff.information?.location?.context?.before === 'string' && material.includes(materialHandoff.information.location.context.before.slice(0, 20)), materialHandoff.information?.location?.context);
  check(pointPhase, 'point kinds never claim a verified object mapping', materialHandoff.execution.locationVerified === false && materialHandoff.execution.reasons.some(reason => reason.includes('位置点')), materialHandoff.execution);

  // ---- Phase 2: explicit send → the frozen source is THIS file ----
  const roundPhase=phase('point-round');
  activeRound = {...rounds[0], requests: []};
  await documentPage.locator('.tag-discuss .tag-composer .tag-editor').click();
  await documentPage.keyboard.type(rounds[0].question);
  await documentPage.keyboard.down('Control');
  await documentPage.keyboard.press('Enter');
  await documentPage.keyboard.up('Control');
  await documentPage.waitForFunction(text => [...document.querySelectorAll('.tag-transcript .tag-message-user')].some(node => node.textContent.includes(text)), {timeout: 45000}, rounds[0].question);
  await until(async () => (await status()).jobs.some(job => (job.text || '').includes('POINT_DISCUSSION_Q_6101') && job.status === 'completed'), 'native point discussion job completed');
  await documentPage.waitForFunction(text => document.querySelector('.tag-discuss .tag-transcript')?.textContent.includes(text), {timeout: 45000}, rounds[0].final);
  const projection = (await annotations()).find(item => item.id === pointAnnotationId);
  const round1 = projection?.projection?.history?.at(-1);
  check(roundPhase, 'the point discussion persisted its round', Boolean(round1?.requestId && (round1.messageIds || []).length >= 2), round1);
  const canonical = await canonicalEntries(round1.requestId);
  const userEntry = canonical.entries.find(entry => entry.speaker === 'user');
  const promptProof = JSON.stringify(modelInputs[0] || {});
  check(roundPhase, 'the point discussion reached the real model with THIS file and the frozen point context (accurate 前文/后文, no fabricated quote)', promptProof.includes('material.txt') && promptProof.includes('位置') && promptProof.includes('Isola') && promptProof.includes('ted point discussion source material'), promptProof.slice(0, 400));
  if (userEntry?.materialSources?.length) check(roundPhase, 'recorded material sources freeze THIS file digest', userEntry.materialSources.every(source => source.materialDigest === materialDigest), userEntry.materialSources);
  const agentEntries = canonical.entries.filter(entry => entry.speaker === 'agent' && entry.target === 'frontdesk');
  // Identical identity comparison to the proven desktop-tag-reply-grouping-live
  // helper: the timeline binds entries by jobId FIRST, requestId second.
  // HBI86w evidence: canonical entries carry jobId:null and a NATIVE
  // requestId (same across the round) — identity is projection.messageIds
  // membership; the job binding itself is already proven by the timeline
  // request lookup that produced these entries.
  const roundEntries = canonical.entries.filter(entry => (round1.messageIds || []).includes(entry.id));
  const timelineEvidence = {projection: {requestId: round1.requestId, messageIds: round1.messageIds}, canonical: canonical.entries.map(entry => ({id: entry.id, speaker: entry.speaker, target: entry.target, jobId: entry.jobId ?? null, requestId: entry.requestId ?? null, durable: entry.durable, text: entry.text.slice(0, 40)}))};
  roundPhase.checks.push({name: 'canonical timeline evidence (recorded before assertion)', evidence: timelineEvidence});
  check(roundPhase, 'the projection\'s canonical messages share one native request and carry both texts', roundEntries.filter(entry => entry.speaker !== 'user').length >= 2 && new Set(roundEntries.map(entry => entry.requestId)).size === 1 && roundEntries.some(entry => entry.text.includes(rounds[0].first)) && roundEntries.some(entry => entry.text.includes(rounds[0].final)), timelineEvidence);
  check(roundPhase, 'the model actually read the correct source through the allowed tool', (activeRound.toolResult || '').includes('Isolated point discussion source material'), activeRound.toolResult);
  roundPhase.requestId = round1.requestId;
  roundPhase.messageIds = round1.messageIds;
  roundPhase.screenshots = [await screenshot(documentPage, 'point-round-one-bubble-both-texts')];
  }
  // ---- Phase 3: ordinary explanation requires an effective selection ----
  const explainPhase=phase('explain-round');
  // Collapse any auto-open tag card so the pointer never crosses widget UI.
  await documentPage.keyboard.press('Escape').catch(()=>{});
  // Deliberate pointer selection (click + shift-click across the first two
  // lines) — no hidden toolbar, no programmatic selection-menu dependency.
  const positions = await documentPage.evaluate(() => {const lines=[...document.querySelectorAll('.cm-line')];const a=lines[0].getBoundingClientRect();const b=lines[1]?lines[1].getBoundingClientRect():a;return {x1:a.left+8,y1:a.top+a.height/2,x2:b.right-8,y2:b.top+b.height/2};});
  await documentPage.mouse.click(positions.x1, positions.y1);
  await documentPage.keyboard.down('Shift');
  await documentPage.mouse.click(positions.x2, positions.y2);
  await documentPage.keyboard.up('Shift');
  // Authoritative truth: the ADAPTER range + source slice — document.getSelection
  // can cross floating card UI and must never stand in for the source quote.
  const authoritative = await documentPage.evaluate(() => {const selection = window.__nozeliInput.selection(); const text = window.__nozeliInput.text(); return selection && selection.to > selection.from ? {from: selection.from, to: selection.to, quote: text.slice(selection.from, selection.to)} : null;});
  assert(authoritative && authoritative.quote.trim().length > 20, 'authoritative adapter selection captured (from/to/quote): ' + JSON.stringify(authoritative));
  const selectedText = authoritative.quote;
  await documentPage.mouse.click((positions.x1 + positions.x2) / 2, (positions.y1 + positions.y2) / 2, {button: 'right'});
  await documentPage.waitForSelector(menu + ':not([hidden])', {timeout: 15000});
  const explainNow = await itemState('explain-selection');
  check(explainPhase, 'explain becomes enabled for an effective selection', explainNow.disabled === false, {state: explainNow, selectedHead: selectedText.slice(0, 30)});
  activeRound = {...rounds[1], requests: []};
  await documentPage.click(menu + ' [data-command="explain-selection"]');
  await until(async () => (await status()).jobs.some(job => (job.text || '').includes('请解释这处选区。') && job.status === 'completed'), 'native explain job completed');
  await documentPage.waitForFunction(text => document.querySelector('.tag-transcript')?.textContent.includes(text), {timeout: 45000}, rounds[1].final);
  // selection-explain binds requestId/messageId/status at the PROJECTION TOP
  // LEVEL (it never appends history — only discussion saves do). Use the
  // same annotation's projection fields; never fabricate a history entry.
  const explainAnnotation = (await annotations()).find(item => item.kind === 'text-selection');
  const explainProjection = explainAnnotation?.projection ?? null;
  explainPhase.checks.push({name: 'explain binding evidence (recorded before assertion)', evidence: {projection: explainProjection, authoritative}});
  check(explainPhase, 'the explanation bound its request and messages on the projection', Boolean(explainProjection?.requestId) && (explainProjection?.messageIds || []).length >= 1, explainProjection);
  const explainMaterial = explainAnnotation ? await invoke('tag.material', {projectId, relPath: 'material.txt', annotationId: explainAnnotation.id}, documentPage) : null;
  explainPhase.checks.push({name: 'explain quote evidence (recorded before assertion)', evidence: {authoritative, frozenQuote: explainMaterial?.anchor?.quote ?? null, promptContains: JSON.stringify(modelInputs.at(-2) ?? {}).includes(selectedText.slice(0, 20))}});
  check(explainPhase, 'the host-frozen explain quote equals the real pointer selection and reaches the model', explainMaterial?.anchor?.quote === selectedText && JSON.stringify(modelInputs.at(-2) ?? {}).includes(selectedText.slice(0, 20)), {frozenQuote: explainMaterial?.anchor?.quote?.slice(0, 60) ?? null, selectedHead: selectedText.slice(0, 60), promptContainsSelection: JSON.stringify(modelInputs.at(-2) ?? {}).includes(selectedText.slice(0, 20))});
  explainPhase.requestId = explainProjection.requestId;
  explainPhase.screenshots = [await screenshot(documentPage, 'explain-selection-frozen-quote')];

  // ---- Phase 4: reload restores the point discussion without replay ----
  if(!explainOnly){
  activeRound = null;
  const requestsBeforeReload = modelInputs.length;
  await documentPage.reload({waitUntil: 'domcontentloaded'});
  await documentPage.waitForFunction(() => window.__nozeliReady);
  await until(async () => documentPage.querySelector('.tag-discuss .tag-transcript')?.textContent.includes(rounds[0].final), 'reload restores the point discussion transcript');
  check(reloadPhase, 'reload replays no model request', modelInputs.length === requestsBeforeReload, {before: requestsBeforeReload, after: modelInputs.length});
  const reloadPhase=phase('reload');
  reloadPhase.screenshots = [await screenshot(documentPage, 'reload-point-discussion-restored')];

  }
  assert.equal(modelInputs.length, explainOnly?2:4, explainOnly?'Explain-only scene: exactly two model requests':'Exactly two model requests per round (text+tool, tool-result continuation)');
  assert.deepEqual(protocolErrors, []);
  assert.deepEqual(report.errors, []);
  report.modelRequests = modelInputs.length;
  report.ok = true;
} catch (error) {
  process.exitCode = 1;
  report.error = error.stack;
  report.protocolErrors = protocolErrors;
  if (documentPage || shell) await screenshot(documentPage ?? shell, 'failure').catch(() => {});
  console.error(error.stack);
} finally {
  if (child?.exitCode === null) {
    await invoke('session.requestClose').catch(() => {});
    await Promise.race([exit.catch(() => {}), pause(15000)]);
    // Failure cleanup is scoped to this driver's child only; never kill user processes.
    if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([exit.catch(() => {}), pause(5000)]); }
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await browser?.disconnect();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(out, 'main.log'), mainLog);
  await save();
  console.log(out);
}
