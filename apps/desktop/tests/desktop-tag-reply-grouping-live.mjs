// Real-Electron acceptance for per-request tag reply grouping: bundled OMP
// frontdesk, scripted loopback OpenAI-protocol model only. No user projects,
// profiles, credentials or paid calls. A real text selection becomes a discuss
// tag; each question is submitted through the actual tag editor (Ctrl+Enter);
// the scripted model answers with assistant text PLUS one genuinely allowed
// read tool call (nozeli_document_read) and then final assistant text — two
// durable canonical assistant entries in the SAME request. The tag transcript
// must keep ONE assistant bubble per request containing every segment while
// the main conversation session groups the same entries into one reply row.
// Installed release: NOZELI_INSTALLED_BINARY=/.../nozeli node apps/desktop/tests/desktop-tag-reply-grouping-live.mjs
// Development tree: NOZELI_TEST_APP_ROOT=/.../apps/desktop NOZELI_TEST_BINARY=/.../node_modules/.bin/electron node apps/desktop/tests/desktop-tag-reply-grouping-live.mjs
// No renderer message injection: every reply below comes from the real native
// CLI turn; the driver only reads state back for verification. The final
// stdout line is the evidence directory.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
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
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-tag-reply-grouping-'));
const project = path.join(out, 'source-project'), unrelatedCwd = path.join(out, 'unrelated-launch-directory'), home = path.join(out, 'home');
for (const directory of [project, unrelatedCwd, home]) await fs.mkdir(directory);
await fs.writeFile(path.join(project, 'material.txt'), 'Isolated tag reply grouping material line.\nA second line keeps the selection anchor stable.\n');
const rounds = [
  {name: 'round-1', question: 'TAG_GROUPING_Q1_5174 answer this selection in two parts', first: 'TAG_GROUPING_FIRST_PART_5174', final: 'TAG_GROUPING_FINAL_PART_5174'},
  {name: 'round-2', question: 'TAG_GROUPING_Q2_5175 one more grouped answer', first: 'TAG_ROUND2_FIRST_5175', final: 'TAG_ROUND2_FINAL_5175'},
];
const report = {ok: false, mode, scope: 'Real Electron (' + mode + ') + bundled native OMP frontdesk + real selection-discuss UI; deterministic local OpenAI SSE model (not a paid model); one assistant bubble per request in the tag transcript while the main session groups one reply', binary, installedApp, out, phases: [], errors: []};
const modelInputs = [], protocolErrors = [];
let activeRound, child, exit, browser, shell, documentPage, chat, projectId, mainLog = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // A loopback protocol violation is terminal evidence; never burn the full
    // timeout retrying against a 500-refusing scripted model.
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
      if (!activeRound) throw Error('Unexpected model request outside an active discussion round (replay guard)');
      activeRound.requests.push(modelInputs.length - 1);
      const ordinal = activeRound.requests.length;
      assert(ordinal <= 2, 'One discussion turn is exactly one text+tool-call request and one tool-result continuation');
      const toolCallId = 'tag-grouping-' + activeRound.name;
      if (ordinal === 1) {
        assert(input.tools?.some(tool => tool.function?.name === 'nozeli_document_read'), 'Real OMP frontdesk must advertise the allowed read tool nozeli_document_read');
        assert(input.tools?.some(tool => tool.function?.name === 'ask'), 'Real OMP must advertise its native ask tool');
        // The live thread legitimately retains earlier rounds (their user prompts
        // AND assistant answers). Replay means a former question arriving again
        // as NEWER user input than this round's own question. Identity is the
        // stable round name: activeRound is a per-round clone, never a rounds[]
        // member, so reference comparison would reject this round's own prompt.
        const userMessages = input.messages.filter(message => message.role === 'user');
        const textOf = message => JSON.stringify(message.content ?? '');
        const lastHit = question => userMessages.reduce((last, message, index) => textOf(message).includes(question) ? index : last, -1);
        const mine = lastHit(activeRound.question);
        assert(mine >= 0, 'This round\'s tag question must reach the real model request as user input');
        for (const other of rounds) if (other.name !== activeRound.name) {
          assert(lastHit(other.question) < mine, 'A previous question reappeared as newer user input than this round (replay): ' + other.question);
        }
      } else {
        const tool = input.messages.find(message => message.role === 'tool' && message.tool_call_id === toolCallId);
        assert(tool, 'Continuation must contain the executed nozeli_document_read result');
        assert(input.messages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === toolCallId)), 'Continuation must retain the original assistant tool call');
        activeRound.toolResult = String(tool.content ?? '').slice(0, 400);
      }
      const delta = ordinal === 1
        ? {role: 'assistant', content: activeRound.first, tool_calls: [{index: 0, id: toolCallId, type: 'function', function: {name: 'nozeli_document_read', arguments: JSON.stringify({relPath: 'material.txt'})}}]}
        : {role: 'assistant', content: activeRound.final};
      res.writeHead(200, {'content-type': 'text/event-stream'});
      for (const [fragment, finish] of [[delta, null], [{}, ordinal === 1 ? 'tool_calls' : 'stop']]) {
        res.write('data: ' + JSON.stringify({id: 'tag-grouping-' + modelInputs.length, object: 'chat.completion.chunk', choices: [{index: 0, delta: fragment, finish_reason: finish}]}) + '\n\n');
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
// Modern workspace surface selection: pages are identified by their live
// __workspaceScope identity, never by target order or a URL guess.
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
  // The native close confirmation belongs to whichever surface holds focus;
  // scan every live Nozeli page instead of assuming the shell.
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
    report.shutdownConfirmations.push({choice: '取消任务并退出', scope: 'This isolated test instance only; both discussion rounds already completed'});
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
// Transcript shape under test: one assistant bubble per request, one
// .tag-markdown[data-message-id] segment per canonical message.
async function tagBubbles() {
  return documentPage.evaluate(() => {
    const transcript = document.querySelector('.tag-discuss .tag-transcript');
    if (!transcript) return null;
    return [...transcript.querySelectorAll(':scope > .tag-message')].map(node => ({
      role: node.classList.contains('tag-message-user') ? 'user' : node.classList.contains('tag-message-assistant') ? 'assistant' : 'other',
      requestId: node.dataset.requestId ?? null,
      text: node.textContent,
      segments: [...node.querySelectorAll(':scope > .tag-markdown')].map(segment => ({messageId: segment.dataset.messageId ?? null, text: segment.textContent})),
    }));
  });
}
async function tagProjection() {
  const annotations = (await invoke('annotation.list', {projectId, relPath: 'material.txt'})).annotations || [];
  const history = annotations.flatMap(annotation => annotation.projection?.history || []);
  return history.map(entry => ({requestId: entry.requestId ?? null, status: entry.status, messageIds: entry.messageIds || []}));
}
// Canonical CLI proof: the timeline itself carries several durable frontdesk
// assistant entries for ONE request. Read back through the real ops only.
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
      if (entry) entries.push({id: entry.id, speaker: entry.speaker, target: entry.target, jobId: entry.jobId ?? null, requestId: entry.requestId ?? null, durable: entry.durable === true, text: entry.text || ''});
    }
    return {entries};
  }, {projectId, requestId});
}
async function mainSessionReplies() {
  return chat.$$eval('#managed-session-timeline article.session-message', nodes => nodes.map(node => ({
    role: node.dataset.role, text: node.textContent, processFolds: node.querySelectorAll('details.session-tool').length,
  })));
}
function check(phase, name, condition, evidence) {
  assert(condition, phase + ': ' + name);
  report.phases.at(-1).checks.push({name, evidence: evidence ?? null});
}
async function askRound(round) {
  activeRound = {...round, requests: []};
  report.phases.push({round: round.name, checks: []});
  await documentPage.bringToFront();
  await documentPage.locator('.tag-discuss .tag-editor').click();
  await documentPage.keyboard.type(round.question);
  await documentPage.keyboard.down('Control');
  await documentPage.keyboard.press('Enter');
  await documentPage.keyboard.up('Control');
  await documentPage.waitForFunction(text => [...document.querySelectorAll('.tag-transcript .tag-message-user')].some(node => node.textContent.includes(text)), {timeout: 45000}, round.question);
  await until(async () => (await status()).jobs.some(job => (job.text || '').includes(round.question) && job.status === 'completed'), 'native job completed for ' + round.name);
  await documentPage.waitForFunction(text => document.querySelector('.tag-discuss .tag-transcript')?.textContent.includes(text), {timeout: 45000}, round.final);
}
try {
  await launch();
  await invoke('config.initialize', {mode: 'independent'});
  await invoke('settings.providers.save', {operation:'create',provider:'tagreply-local',baseUrl:'http://127.0.0.1:' + server.address().port + '/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-only'}});
  await invoke('settings.models.save', {frontdesk:{model:{mode:'explicit',selector:'tagreply-local/scripted'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'explicit',selector:'tagreply-local/scripted'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'tagreply-local/scripted'},thinking:{mode:'native-default'}}});
  if (await shell.$eval('#configuration-setup', node => node.open)) await shell.click('#configuration-cancel');
  await shell.click('#pick-project');
  projectId = await until(async () => (await invoke('workspace.bootstrap')).projectId, 'source project');
  report.projectId = projectId;
  await invoke('managed.enable', {projectId});
  await until(async () => (await invoke('managed.status', {projectId})).ready, 'bundled OMP ready');
  // The shell owns navigation/state only; the reader, selection and tags live
  // on the actual native document surface for this file.
  await shell.waitForSelector('#file-tree button[data-path="material.txt"]', {visible: true});
  await shell.click('#file-tree button[data-path="material.txt"]');
  documentPage = await scoped(scope => scope.role === 'surface' && scope.kind === 'document' && scope.projectId === projectId && scope.relPath === 'material.txt', 'document surface for material.txt');
  documentPage.on('pageerror', error => report.errors.push('document: ' + error.message));
  await documentPage.waitForFunction(() => (window.__nozeliInput?.text() || '').includes('Isolated tag reply grouping material'));
  await documentPage.evaluate(() => { document.querySelector('.cm-content')?.focus(); window.__nozeliInput.select(8, 38); });
  await documentPage.waitForSelector('#selection-menu:not([hidden])', {visible: true});
  await documentPage.locator('#selection-discuss').click();
  await documentPage.waitForSelector('.tag-discuss .tag-editor', {visible: true});
  report.phases.push({round: 'tag-created', checks: []});
  check('tag-created', 'real selection became a discuss tag', true, await documentPage.$eval('.tag-discuss .tag-source blockquote', node => node.textContent.trim()));

  await askRound(rounds[0]);
  let bubbles = await tagBubbles();
  let projection = await until(async () => { const history = await tagProjection(); return history.length === 1 && history[0].messageIds.length >= 2 ? history : false; }, 'persisted round-1 projection binds multiple message ids');
  const round1 = projection[0];
  check('round-1', 'tag keeps ONE assistant bubble for the whole request', bubbles.filter(bubble => bubble.role === 'assistant').length === 1, bubbles);
  check('round-1', 'assistant bubble carries the request id', bubbles.find(bubble => bubble.role === 'assistant')?.requestId === round1.requestId, round1);
  const round1Bubble = bubbles.find(bubble => bubble.role === 'assistant');
  check('round-1', 'one assistant bubble retains BOTH canonical texts', round1Bubble.text.includes(rounds[0].first) && round1Bubble.text.includes(rounds[0].final), round1Bubble.text);
  check('round-1', 'each canonical message keeps its own segment in that one bubble', round1Bubble.segments.length === round1.messageIds.length && round1.messageIds.every(id => round1Bubble.segments.some(segment => segment.messageId === id)), round1Bubble.segments);
  check('round-1', 'the two texts are separate segments, not one merged body', round1Bubble.segments.some(segment => segment.text.includes(rounds[0].first)) && round1Bubble.segments.some(segment => segment.text.includes(rounds[0].final)));
  const canonical1 = await canonicalEntries(round1.requestId);
  const agents1 = canonical1.entries.filter(entry => entry.speaker === 'agent' && entry.target === 'frontdesk');
  check('round-1', 'timeline really holds multiple durable assistant entries for the SAME request', agents1.length >= 2 && agents1.every(entry => (entry.jobId || entry.requestId) === round1.requestId) && agents1.filter(entry => entry.durable).length >= 2, agents1);
  check('round-1', 'pre-tool text and final text are distinct canonical entries', agents1.some(entry => entry.text.includes(rounds[0].first)) && agents1.some(entry => entry.text.includes(rounds[0].final)), agents1.map(entry => entry.text.slice(0, 60)));
  report.phases.at(-1).requestId = round1.requestId;
  report.phases.at(-1).messageIds = round1.messageIds;
  await documentPage.evaluate(() => { window.__round1Bubble = document.querySelector('.tag-discuss .tag-transcript .tag-message-assistant'); });
  report.phases.at(-1).screenshots = [await screenshot(documentPage, 'round-1-one-tag-bubble-both-texts')];

  // Main conversation session: the SAME canonical entries group into ONE reply.
  await shell.waitForSelector('#workspace-open-conversation:not([disabled])', {visible: true});
  await shell.locator('#workspace-open-conversation').click();
  chat = await scoped(scope => scope.role === 'surface' && scope.kind === 'conversation' && scope.projectId === projectId, 'conversation surface');
  chat.on('pageerror', error => report.errors.push('conversation: ' + error.message));
  await chat.waitForSelector('#managed-session-timeline article.session-message[data-role="frontdesk"]');
  let replies = await until(async () => {
    const rows = await mainSessionReplies();
    return rows.filter(row => row.role === 'frontdesk').length === 1 && rows.filter(row => row.role === 'frontdesk')[0].text.includes(rounds[0].final) ? rows : false;
  }, 'main session groups round 1 into one reply row');
  let frontdesk1 = replies.filter(row => row.role === 'frontdesk');
  check('round-1', 'main session groups one reply for the same request', frontdesk1.length === 1, frontdesk1.map(row => row.text.slice(0, 80)));
  check('round-1', 'grouped main-session reply folds the extra canonical entries as process', frontdesk1[0].processFolds >= 1, frontdesk1[0].processFolds);
  check('round-1', 'exactly one user row so far', replies.filter(row => row.role === 'user').length === 1);
  report.phases.at(-1).screenshots.push(await screenshot(chat, 'round-1-main-session-one-reply'));

  await askRound(rounds[1]);
  bubbles = await tagBubbles();
  projection = await until(async () => { const history = await tagProjection(); return history.length === 2 && history.every(entry => entry.messageIds.length >= 2) ? history : false; }, 'persisted round-2 projection binds multiple message ids');
  const round2 = projection.find(entry => entry.requestId !== round1.requestId);
  const assistants = bubbles.filter(bubble => bubble.role === 'assistant');
  check('round-2', 'second question gets its own SEPARATE assistant bubble', assistants.length === 2, assistants.map(bubble => bubble.requestId));
  const round2Bubble = assistants.find(bubble => bubble.requestId === round2.requestId);
  check('round-2', 'second bubble carries only the second request texts', round2Bubble && round2Bubble.text.includes(rounds[1].first) && round2Bubble.text.includes(rounds[1].final) && !round2Bubble.text.includes(rounds[0].final), round2Bubble?.text);
  check('round-2', 'second bubble keeps per-message segments for its own request', round2Bubble.segments.length === round2.messageIds.length && round2.messageIds.every(id => round2Bubble.segments.some(segment => segment.messageId === id)), round2Bubble.segments);
  check('round-2', 'first bubble node survived the new render (keyed reuse)', await documentPage.evaluate(() => window.__round1Bubble === document.querySelector('.tag-discuss .tag-transcript .tag-message-assistant[data-request-id="' + window.__round1Bubble.dataset.requestId + '"]') && window.__round1Bubble.isConnected));
  const firstStill = assistants.find(bubble => bubble.requestId === round1.requestId);
  check('round-2', 'first bubble still retains both first-round texts', firstStill.text.includes(rounds[0].first) && firstStill.text.includes(rounds[0].final));
  report.phases.at(-1).requestId = round2.requestId;
  report.phases.at(-1).messageIds = round2.messageIds;
  report.phases.at(-1).screenshots = [await screenshot(documentPage, 'round-2-two-tag-bubbles-one-per-request')];
  replies = await until(async () => {
    const rows = await mainSessionReplies();
    return rows.filter(row => row.role === 'frontdesk').length === 2 && rows.filter(row => row.role === 'frontdesk').every(row => row.text.includes(rounds[0].final) || row.text.includes(rounds[1].final)) ? rows : false;
  }, 'main session groups round 2 into its own single reply row');
  check('round-2', 'main session still groups exactly one reply per request', replies.filter(row => row.role === 'frontdesk').length === 2 && replies.filter(row => row.role === 'user').length === 2, replies.map(row => row.role));

  // Reload restores the same per-request grouping from persisted history IDs,
  // rehydrated through timeline reads — never by replaying the model.
  activeRound = null;
  const requestsBeforeReload = modelInputs.length;
  const jobsBeforeReload = (await status()).jobs.length;
  await documentPage.reload({waitUntil: 'domcontentloaded'});
  await documentPage.waitForFunction(() => window.__nozeliReady);
  const restored = await until(async () => {
    const rows = await tagBubbles();
    if (!rows) return false;
    const first = rows.find(row => row.requestId === round1.requestId && row.role === 'assistant');
    const second = rows.find(row => row.requestId === round2.requestId && row.role === 'assistant');
    return first && second && first.text.includes(rounds[0].first) && first.text.includes(rounds[0].final) && second.text.includes(rounds[1].first) && second.text.includes(rounds[1].final) ? rows : false;
  }, 'reload restores both per-request bubbles with every segment text');
  report.phases.push({round: 'reload', checks: []});
  const restoredAssistants = restored.filter(row => row.role === 'assistant');
  check('reload', 'same per-request grouping after reload: exactly one bubble per request', restoredAssistants.length === 2, restoredAssistants.map(row => row.requestId));
  const restoredProjection = await tagProjection();
  check('reload', 'persisted history kept raw message ids for both requests', restoredProjection.length === 2 && restoredProjection.every(entry => entry.messageIds.length >= 2), restoredProjection);
  for (const [bubble, round] of [[restoredAssistants.find(row => row.requestId === round1.requestId), rounds[0]], [restoredAssistants.find(row => row.requestId === round2.requestId), rounds[1]]]) {
    check('reload', 'reloaded bubble keeps one segment per canonical message id for ' + round.name, bubble.segments.length >= 2 && bubble.segments.some(segment => segment.text.includes(round.first)) && bubble.segments.some(segment => segment.text.includes(round.final)), bubble.segments.map(segment => segment.messageId));
  }
  check('reload', 'reload replays no model request', modelInputs.length === requestsBeforeReload, {before: requestsBeforeReload, after: modelInputs.length});
  check('reload', 'reload creates no new job', (await status()).jobs.length === jobsBeforeReload);
  report.phases.at(-1).screenshots = [await screenshot(documentPage, 'reload-same-per-request-grouping')];

  await closeNormally();
  assert.equal(modelInputs.length, 4, 'Exactly two model requests per discussion round');
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
