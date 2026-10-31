// Real-Electron acceptance for the native ask dialogue: bundled OMP ask, scripted
// loopback OpenAI protocol model only. No user projects, profiles, credentials or paid calls.
// Installed release: NOZELI_INSTALLED_BINARY=/.../nozeli node apps/desktop/tests/installed-attention-dialogue-live.mjs
// Development tree (no packaging needed): NOZELI_TEST_APP_ROOT=/.../apps/desktop NOZELI_TEST_BINARY=/.../node_modules/.bin/electron node apps/desktop/tests/installed-attention-dialogue-live.mjs
// The final stdout line is the evidence directory. This driver never patches a release.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';

assert.equal(process.platform, 'linux', 'Native installed acceptance currently requires Linux');
// Two real-Electron launch modes; both exercise the bundled native OMP ask.
if (Boolean(process.env.NOZELI_TEST_APP_ROOT) !== Boolean(process.env.NOZELI_TEST_BINARY)) throw Error('Development mode requires both NOZELI_TEST_APP_ROOT and NOZELI_TEST_BINARY');
const mode = process.env.NOZELI_INSTALLED_BINARY ? 'installed' : process.env.NOZELI_TEST_APP_ROOT ? 'development' : null;
if (!mode) throw Error('Pass NOZELI_INSTALLED_BINARY (installed release executable) or both NOZELI_TEST_APP_ROOT and NOZELI_TEST_BINARY (development tree)');
const binary = await fs.realpath(mode === 'installed' ? process.env.NOZELI_INSTALLED_BINARY : process.env.NOZELI_TEST_BINARY);
const installedApp = mode === 'installed' ? path.join(path.dirname(binary), 'resources/app') : await fs.realpath(process.env.NOZELI_TEST_APP_ROOT);
const manifest = JSON.parse(await fs.readFile(path.join(installedApp, 'package.json'), 'utf8'));
await fs.access(path.join(installedApp, mode === 'installed' ? (manifest.main || 'src/main/main.cjs') : 'src/main/main.cjs'));
await fs.access(path.join(installedApp, 'runtime/omp/omp'), fs.constants.X_OK);
const out = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-installed-attention-'));
const project = path.join(out, 'source-project'), otherProject = path.join(out, 'other-project');
const unrelatedCwd = path.join(out, 'unrelated-launch-directory'), home = path.join(out, 'home');
for (const directory of [project, otherProject, unrelatedCwd, home]) await fs.mkdir(directory);
await fs.writeFile(path.join(project, 'sample.txt'), 'Owned installed attention acceptance project\n');
const cases = [
  {name: 'single-select', questions: [{id: 'route', question: 'ATTENTION_SINGLE: Choose an analysis route', options: [{label: 'Keep route', preview: 'PREVIEW_KEEP_ROUTE_4729'}, {label: 'Change route'}]}], expected: ['Change route']},
  {name: 'multi-and-custom', questions: [
    {id: 'checks', question: 'ATTENTION_MULTI: Choose all checks', multi: true, options: [{label: 'Review logs'}, {label: 'Review config'}, {label: 'Review UI'}]},
    {id: 'custom', question: 'ATTENTION_CUSTOM: Give a custom route', options: [{label: 'Default route'}]},
  ], expected: ['Review logs', 'Review UI', 'CUSTOM_UNSENT_ANSWER_4729', 'UNSENT_NOTE_4729']},
  {name: 'explicit-cancellation', questions: [{id: 'cancel', question: 'ATTENTION_CANCEL: Explicitly cancel this question', options: [{label: 'Do not select this'}]}], expected: []},
];
const report = {ok: false, mode, scope: 'Real Electron (' + mode + ') + bundled native OMP ask + real workspace UI clicks; deterministic local OpenAI SSE model (not a paid model)', binary, installedApp, unrelatedCwd, out, scenarios: [], errors: []};
const modelInputs = [], protocolErrors = [];
let activeCase, child, exit, browser, shell, projectId, otherId, mainLog = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, ms = 90000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await pause(100); }
  throw Error('Timeout: ' + label);
}
async function save() {
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(out, 'model-requests.json'), JSON.stringify(modelInputs, null, 2));
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      assert.equal(req.method, 'POST');
      assert.match(req.url, /^\/v1\/chat\/completions\/?$/);
      const input = JSON.parse(body);
      modelInputs.push(input);
      assert(activeCase, 'Unexpected model request outside a scenario');
      activeCase.requests.push(modelInputs.length - 1);
      const ordinal = activeCase.requests.length;
      assert(ordinal <= (activeCase.name === 'explicit-cancellation' ? 1 : 2), 'Native cancellation must not continue the model; submitted answers permit exactly one tool-result continuation');
      const toolCallId = 'installed-ask-' + activeCase.name;
      if (ordinal === 1) {
        assert(input.tools?.some(tool => tool.function?.name === 'ask'), 'Real OMP must advertise its native ask tool');
        assert(input.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('RUN_' + activeCase.name)), 'Scenario prompt must reach the real model request');
      } else {
        const tool = input.messages.find(message => message.role === 'tool' && message.tool_call_id === toolCallId);
        assert(tool, 'Continuation must contain the result of the original ask tool call');
        assert(input.messages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === toolCallId)), 'Continuation must retain the original assistant tool call');
        activeCase.toolResult = tool;
        for (const text of activeCase.expected) {
          assert(JSON.stringify(tool.content).includes(text), 'Native tool result must contain ' + text);
          assert(!input.messages.filter(message => message.role === 'user').some(message => JSON.stringify(message.content).includes(text)), 'Answer must not become a user prompt: ' + text);
        }
      }
      const delta = ordinal === 1
        ? {role: 'assistant', tool_calls: [{index: 0, id: toolCallId, type: 'function', function: {name: 'ask', arguments: JSON.stringify({questions: activeCase.questions})}}]}
        : {role: 'assistant', content: 'RECORDED_' + activeCase.name};
      res.writeHead(200, {'content-type': 'text/event-stream'});
      for (const [fragment, finish] of [[delta, null], [{}, ordinal === 1 ? 'tool_calls' : 'stop']]) {
        res.write('data: ' + JSON.stringify({id: 'installed-' + modelInputs.length, object: 'chat.completion.chunk', choices: [{index: 0, delta: fragment, finish_reason: finish}]}) + '\n\n');
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
const env = {...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'), NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: path.join(out, '.Nozeli'), NOZELI_USER_DATA: path.join(out, '.Nozeli/desktop'), NOZELI_TEST_PICK: project + '\n' + otherProject, NOZELI_DEBUG_PORT: String(debugPort), NOZELI_HIDDEN: '0', NOZELI_SHOT_DIR: path.join(out, 'window-operations')};
for (const key of Object.keys(env)) if (/^(?:CCB_|CODEX_|PI_|OMP_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)) delete env[key];
delete env.ELECTRON_RUN_AS_NODE;
delete env.NOZELI_AGENT_FIXTURE;
async function invoke(op, payload = {}, page = shell) {
  const result = await page.evaluate(({op, payload}) => nozeli.invoke(op, payload), {op, payload});
  if (!result.ok) throw Object.assign(Error(op + ': ' + result.error.message), {code: result.error.code});
  return result.value;
}
async function status() { return (await invoke('managed.status', {projectId})).state; }
async function launch() {
  child = spawn(binary, [...(mode === 'development' ? [path.join(installedApp, 'src/main/main.cjs')] : []), '--ozone-platform=' + (process.env.NOZELI_TEST_OZONE_PLATFORM || 'wayland')], {cwd: unrelatedCwd, env, stdio: ['ignore', 'pipe', 'pipe']});
  exit = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({code, signal})); child.once('error', reject); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { mainLog += data; });
  await until(async () => { try { browser = await puppeteer.connect({browserURL: 'http://127.0.0.1:' + debugPort, defaultViewport: null}); return true; } catch { return false; } }, 'installed browser');
  shell = await until(async () => { for (const page of await browser.pages()) try { if ((await page.evaluate(() => window.__workspaceScope))?.role === 'shell') return page; } catch {} }, 'workspace shell');
  shell.on('pageerror', error => report.errors.push(error.message));
  await shell.waitForFunction(() => window.__nozeliReady);
}
async function closeNormally() {
  await invoke('session.requestClose');
  const confirm=shell.waitForSelector('#quit-choice[open]',{timeout:45000}).then(()=>true,()=>false);
  if(await Promise.race([exit.then(()=>false),confirm])){report.shutdownConfirmations??=[];report.shutdownConfirmations.push({choice:'取消任务并退出',scope:'This isolated test instance only; native ask was already explicitly cancelled'});await screenshot(shell,'normal-exit-confirmation');await shell.click('#quit-cancel');}
  assert.deepEqual(await Promise.race([exit, pause(45000).then(() => null)]), {code: 0, signal: null}, 'Installed app must exit normally, not be killed');
  await browser.disconnect();
  browser = undefined;
}
async function screenshot(page, name) {
  await page.bringToFront();
  const filename = name + '.png';
  await page.screenshot({path: path.join(out, filename)});
  return filename;
}
async function rawResponse(page, todoId, answer, cancel = false) {
  return page.evaluate(payload => nozeli.invoke('managed.attention.respond', payload), {projectId, todoId, answer, ...(cancel ? {cancel: true} : {})});
}
async function setAppearance(theme, page) {
  await invoke('settings.appearance.save', {theme, palette: 'sage', font: 'system', size: 13});
  // Every real Nozeli page must apply the broadcast theme; nothing is swallowed.
  const nozeliPages = [];
  for (const candidate of new Set([shell, ...await browser.pages()])) {
    if (!candidate) continue;
    if (await candidate.evaluate(() => window.__workspaceScope ?? null).catch(() => null)) nozeliPages.push(candidate);
  }
  assert(nozeliPages.includes(page), 'The page being captured must be a live Nozeli workspace page');
  for (const candidate of nozeliPages) await candidate.waitForFunction(theme => document.documentElement.dataset.theme === theme, {timeout: 45000}, theme);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme, 'Captured page theme must match before screenshot');
}
async function resizeConversationWindow(page, width, height) {
  // Real native window resize, confirmed by host-side surface bounds and the live
  // viewport — never by a guessed CSS class or a sleep.
  const viewId = await page.evaluate(() => window.__workspaceScope?.viewId);
  const boundsNow = async () => (await invoke('workspace.windows.list', {projectId})).flatMap(window => window.surfaces).find(surface => surface.viewId === viewId)?.bounds;
  const before = await boundsNow();
  await invoke('session.resize', {width, height}, page);
  await until(async () => {
    const bounds = await boundsNow();
    return bounds && bounds.width > 0 && bounds.width <= width && bounds.width !== before?.width ? bounds : false;
  }, 'native window resize reaches the conversation surface bounds', 45000);
  await page.waitForFunction(width => innerWidth > 0 && innerWidth <= width, {timeout: 45000}, width);
}
try {
  await launch();
  await invoke('config.initialize', {mode: 'independent'});
  await invoke('settings.providers.save', {operation:'create',provider:'attention-local',baseUrl:'http://127.0.0.1:' + server.address().port + '/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-only'}});
  await invoke('settings.models.save', {frontdesk:{model:{mode:'explicit',selector:'attention-local/scripted'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'explicit',selector:'attention-local/scripted'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'attention-local/scripted'},thinking:{mode:'native-default'}}});
  if (await shell.$eval('#configuration-setup', node => node.open)) await shell.click('#configuration-cancel');
  await shell.click('#pick-project');
  projectId = await until(async () => (await invoke('workspace.bootstrap')).projectId, 'source project');
  report.projectId = projectId;
  await invoke('managed.enable', {projectId});
  await until(async () => (await invoke('managed.status', {projectId})).ready, 'bundled OMP ready');
  for (const definition of cases) {
    activeCase = {...definition, requests: [], screenshots: [], ok: false};
    report.scenarios.push(activeCase);
    // Submit from the source project, then leave while the native question is pending.
    await until(async () => (await invoke('workspace.bootstrap')).projectId === projectId, 'source project active before send');
    const sent = await invoke('managed.send', {projectId, target: 'frontdesk', text: 'RUN_' + definition.name + ': call the native ask tool once, then record its result.', requestKey: 'installed-attention-' + definition.name});
    await invoke('project.pick', {directory: otherProject});
    otherId = await until(async () => { const id = (await invoke('workspace.bootstrap')).projectId; return id && id !== projectId ? id : false; }, 'other project active');
    // Raw project.pick updates the native binding, not the shell renderer's ui.project.
    // Rehydrate before clicking its notification, matching the baseline live harness.
    await shell.reload({waitUntil: 'domcontentloaded'});
    await shell.waitForFunction(() => window.__nozeliReady);
    assert.equal((await invoke('workspace.bootstrap')).projectId, otherId);
    const todo = await until(async () => (await status()).todos.find(item => item.origin === 'instance-attention' && item.status === 'open' && item.destination?.kind === 'conversation'), 'real native ask todo');
    activeCase.todoId = todo.id;
    activeCase.jobId = sent.jobId;
    activeCase.source = todo.destination;
    assert.equal(todo.destination.question.method, 'askDialog');
    assert(todo.destination.interactionId && todo.destination.ownerId, 'Native source binding must be present');
    assert.equal((await status()).todos.filter(item => item.origin === 'instance-attention' && item.status === 'open' && item.destination?.kind === 'conversation').length, 1);
    assert.equal((await invoke('workspace.bootstrap')).projectId, otherId, 'Pending source ask must not navigate the foreground project');
    await shell.waitForSelector('[data-attention-prompt]:not([hidden])');
    activeCase.screenshots.push(await screenshot(shell, definition.name + '-cross-project-notification'));
    if (definition.name === 'single-select') {
      // Native project activation and inline prompt layout can reflow between
      // pointerdown and pointerup; locators wait for a stable clickable target.
      await shell.evaluate(() => {
        window.__attentionClickEvidence = [];
        for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => {
          const target = event.target instanceof Element ? event.target : null;
          window.__attentionClickEvidence.push({type, x: event.clientX, y: event.clientY, target: target?.outerHTML.slice(0, 1200), promptVisible: Boolean(document.querySelector('[data-attention-prompt]:not([hidden])'))});
        }, true);
      });
      assert.equal((await status()).attentionNotified.includes(todo.id), false, 'Prompt starts unacknowledged');
      await shell.locator('[data-project-id="' + projectId + '"]').click();
      await until(async () => (await invoke('workspace.bootstrap')).projectId === projectId, 'recent-project click activates source');
      await shell.waitForFunction(id => document.querySelector('[data-project-id="' + id + '"][aria-current="true"]') && document.querySelector('#project-name')?.textContent === 'source-project', {}, projectId);
      await shell.waitForSelector('[data-attention-prompt]:not([hidden])', {visible: true});
      assert.equal((await status()).attentionNotified.includes(todo.id), false, 'Project navigation alone must not acknowledge prompt');
      activeCase.screenshots.push(await screenshot(shell, 'single-select-source-before-sidebar-reveal'));
      if (await shell.$eval('#app', node => node.classList.contains('side-collapsed'))) {
        await shell.locator('#toggle-sidebar').click();
        await shell.waitForFunction(() => !document.querySelector('#app').classList.contains('side-collapsed'));
      }
      activeCase.screenshots.push(await screenshot(shell, 'single-select-source-sidebar-revealed'));
      assert.equal((await status()).attentionNotified.includes(todo.id), false, 'Revealing sidebar must not acknowledge the visible prompt');
      const todoButton = '[data-managed-todo="' + todo.id + '"]';
      await shell.waitForSelector(todoButton, {visible: true});
      await shell.locator(todoButton).click();
      activeCase.clickEvidence = await shell.evaluate(() => window.__attentionClickEvidence);
      await save();
    } else await shell.click('[data-attention-prompt] button:first-of-type');
    const selector = '[data-attention-conversation="' + todo.id + '"]';
    const conversation = await until(async () => { for (const page of await browser.pages()) try { if (await page.$(selector)) return page; } catch {} }, 'source todo workspace dialogue');
    conversation.on('pageerror', error => report.errors.push(error.message));
    await conversation.waitForSelector(selector + ' [data-attention-submit]');
    await until(async () => (await invoke('workspace.bootstrap')).projectId === projectId, 'source project activated');
    if (definition.name === 'single-select') {
      assert.equal((await status()).attentionNotified.includes(todo.id), false, 'Direct sidebar navigation must leave the prompt unacknowledged');
      await shell.waitForSelector('[data-attention-prompt]:not([hidden])', {visible: true});
      const scope = await conversation.evaluate(() => window.__workspaceScope);
      const nativeSurface = await until(async () => {
        const windows = await invoke('workspace.windows.list', {projectId});
        return windows.flatMap(window => window.surfaces).find(surface => surface.viewId === scope.viewId && surface.visible === true && surface.bounds.width > 0 && surface.bounds.height > 0);
      }, 'native conversation remains visible beneath an unacknowledged attention prompt');
      const prompt = await shell.$eval('[data-attention-prompt]', node => {
        const rect = node.getBoundingClientRect();
        return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
      });
      const bounds = nativeSurface.bounds;
      assert(prompt.width > 0 && prompt.height > 0, 'Unacknowledged prompt must remain rendered');
      assert(prompt.x + prompt.width <= bounds.x || bounds.x + bounds.width <= prompt.x || prompt.y + prompt.height <= bounds.y || bounds.y + bounds.height <= prompt.y, 'Attention prompt must not overlap native conversation bounds');
      activeCase.unacknowledgedSidebarRegression = {ok: true, prompt, nativeSurface};
      activeCase.screenshots.push(await screenshot(conversation, 'single-select-unacknowledged-prompt-visible-conversation'));
    } else await until(async () => (await status()).attentionNotified.includes(todo.id), 'notification click acknowledgement persisted');
    assert.equal((await status()).todos.find(item => item.id === todo.id).status, 'open', 'Opening notification must not answer');
    assert.equal(activeCase.requests.length, 1, 'Opening reminder must not issue another model request');
    if (definition.name === 'single-select') {
      // Inject only a malformed answer into the real native bridge; no snapshots or responders are mocked.
      const invalid = await rawResponse(conversation, todo.id, {kind: 'submit', results: [{id: 'route', selectedOptions: ['NONEXISTENT_OPTION']}]});
      assert.equal(invalid.ok, false);
      assert.equal(invalid.error.code, 'INTERACTION_ANSWER_INVALID');
      assert.equal((await status()).todos.find(item => item.id === todo.id).status, 'open');
      assert.equal(activeCase.requests.length, 1, 'Invalid native answer must not resume the model');
      activeCase.invalidAnswer = invalid.error;
      // Expanding an inline option preview must never select its card.
      await conversation.click(selector + ' [data-attention-preview="Keep route"] summary');
      await conversation.waitForSelector(selector + ' [data-attention-preview="Keep route"][open]', {visible: true});
      assert.equal(await conversation.$eval(selector + ' input[value="Keep route"]', node => node.checked), false, 'Expanding a preview must not select its option');
      // Real user path: click the whole choice card, never a bare input or a script shortcut.
      await conversation.click(selector + ' [data-attention-option="Change route"] label');
      await conversation.waitForSelector(selector + ' [data-attention-option="Change route"][data-attention-selected="true"]');
      assert.equal(await conversation.$eval(selector + ' [data-attention-option="Keep route"]', node => node.dataset.attentionSelected), undefined, 'Unchosen card stays unmarked');
      assert.equal((await status()).todos.find(item => item.id === todo.id).status, 'open', 'Selecting a choice card must not submit the answer');
      assert.equal(activeCase.requests.length, 1, 'Selecting a choice card must not resume the model');
    } else if (definition.name === 'multi-and-custom') {
      // Optional custom/note fields start collapsed and keep accessible names.
      assert.equal(await conversation.$eval(selector + ' [data-attention-extra="custom:1"]', node => node.open), false, 'Custom answer starts collapsed');
      assert.equal(await conversation.$eval(selector + ' [data-attention-extra="note:1"]', node => node.open), false, 'Note starts collapsed');
      assert.equal(await conversation.$eval(selector + ' [data-attention-input="custom:1"]', node => node.getAttribute('aria-label')), '其他回答（可选）', 'Collapsed field control keeps its accessible name');
      await conversation.click(selector + ' [data-attention-option="Review logs"] label');
      await conversation.click(selector + ' [data-attention-option="Review UI"] label');
      await conversation.waitForSelector(selector + ' [data-attention-option="Review UI"][data-attention-selected="true"]');
      assert.equal((await status()).todos.find(item => item.id === todo.id).status, 'open', 'Selecting choice cards must not submit the answer');
      assert.equal(activeCase.requests.length, 1, 'Selecting choice cards must not resume the model');
      await conversation.click(selector + ' [data-attention-extra="custom:1"] summary');
      await conversation.waitForSelector(selector + ' [data-attention-extra="custom:1"][open] [data-attention-input="custom:1"]', {visible: true});
      await conversation.type(selector + ' [data-attention-input="custom:1"]', 'CUSTOM_UNSENT_ANSWER_4729');
      await conversation.click(selector + ' [data-attention-extra="note:1"] summary');
      await conversation.waitForSelector(selector + ' [data-attention-extra="note:1"][open] [data-attention-input="note:1"]', {visible: true});
      await conversation.type(selector + ' [data-attention-input="note:1"]', 'UNSENT_NOTE_4729');
    }
    if (definition.name !== 'explicit-cancellation') {
      activeCase.screenshots.push(await screenshot(conversation, definition.name + '-unsent-before-reload'));
      await conversation.reload({waitUntil: 'domcontentloaded'});
      await conversation.waitForSelector(selector + ' [data-attention-submit]');
      if (definition.name === 'single-select') {
        assert.equal(await conversation.$eval(selector + ' input[value="Change route"]', node => node.checked), true);
        assert.equal(await conversation.$eval(selector + ' [data-attention-option="Change route"]', node => node.dataset.attentionSelected), 'true', 'Restored draft re-marks the selected card');
        assert.equal(await conversation.$eval(selector + ' [data-attention-option="Keep route"]', node => node.dataset.attentionSelected), undefined, 'Restored unchosen card stays unmarked');
      } else {
        assert.deepEqual(await conversation.$$eval(selector + ' input[type="checkbox"]:checked', nodes => nodes.map(node => node.value)), ['Review logs', 'Review UI']);
        assert.deepEqual(await conversation.$$eval(selector + ' [data-attention-selected="true"]', nodes => nodes.map(node => node.dataset.attentionOption)), ['Review logs', 'Review UI'], 'Restored multi-selection re-marks exactly the chosen cards');
        assert.equal(await conversation.$eval(selector + ' [data-attention-input="custom:1"]', node => node.value), 'CUSTOM_UNSENT_ANSWER_4729');
        assert.equal(await conversation.$eval(selector + ' [data-attention-extra="custom:1"]', node => node.open), true, 'Nonempty custom draft reopens its collapsed field after reload');
        assert.equal(await conversation.$eval(selector + ' [data-attention-input="note:1"]', node => node.value), 'UNSENT_NOTE_4729');
        assert.equal(await conversation.$eval(selector + ' [data-attention-extra="note:1"]', node => node.open), true, 'Nonempty note draft reopens its collapsed field after reload');
      }
      assert.equal((await status()).todos.find(item => item.id === todo.id).status, 'open', 'Reload retains a draft, not a submitted answer');
      assert.equal(activeCase.requests.length, 1);
      activeCase.reloadRetainedUnsentInputs = true;
    }
    if (definition.name === 'single-select') {
      // Keyboard-only pass: Tab reaches the native radio inside its card, arrow keys
      // move the selection, and the selected card stays observably marked.
      let tabs = 0;
      await until(async () => {
        await conversation.keyboard.press('Tab'); tabs += 1;
        return await conversation.evaluate(scope => { const node = document.activeElement; return node?.tagName === 'INPUT' && node.type === 'radio' && node.closest(scope) !== null; }, selector);
      }, 'keyboard Tab reaches a native choice input', 45000);
      const focus = await conversation.evaluate(() => { const node = document.activeElement; return {value: node.value, focusVisible: node.matches(':focus-visible')}; });
      assert.equal(focus.value, 'Change route', 'The drafted radio is the keyboard entry point');
      assert.equal(focus.focusVisible, true, 'Keyboard focus on the native radio must be visibly indicated');
      await conversation.keyboard.press('ArrowUp');
      await until(async () => await conversation.$eval(selector + ' input[value="Keep route"]', node => node.checked), 'arrow key moves the native radio selection');
      assert.equal(await conversation.$eval(selector + ' [data-attention-option="Keep route"]', node => node.dataset.attentionSelected), 'true', 'Keyboard selection marks the card');
      assert.equal(await conversation.$eval(selector + ' [data-attention-option="Change route"]', node => node.dataset.attentionSelected), undefined, 'The previously selected card loses its stale marker');
      activeCase.screenshots.push(await screenshot(conversation, 'single-select-keyboard-selected-card'));
      await conversation.keyboard.press('ArrowDown');
      await until(async () => await conversation.$eval(selector + ' input[value="Change route"]', node => node.checked), 'arrow key restores the drafted selection');
      activeCase.keyboardSelection = {...focus, tabs};
    }
    if (definition.name === 'multi-and-custom') {
      // Real theme + width evidence on the fully drafted dialogue.
      await setAppearance('light', conversation);
      activeCase.screenshots.push(await screenshot(conversation, definition.name + '-light'));
      await setAppearance('dark', conversation);
      activeCase.screenshots.push(await screenshot(conversation, definition.name + '-dark'));
      await setAppearance('light', conversation);
      await resizeConversationWindow(conversation, 480, 860);
      const overflow = await conversation.evaluate(() => ({scrollWidth: document.documentElement.scrollWidth, innerWidth}));
      assert(overflow.scrollWidth <= overflow.innerWidth + 1, 'Narrow width must not force horizontal scrolling: ' + JSON.stringify(overflow));
      activeCase.narrowWidth = overflow;
      activeCase.screenshots.push(await screenshot(conversation, definition.name + '-narrow-480'));
      await resizeConversationWindow(conversation, 1280, 860);
    }
    activeCase.screenshots.push(await screenshot(conversation, definition.name + '-ready'));
    if (definition.name === 'explicit-cancellation') {
      // Cancellation is a two-step intent: dismiss and Escape prove nothing is sent.
      await conversation.click(selector + ' [data-attention-cancel]');
      await conversation.waitForSelector('[data-confirmation-dialog]', {visible: true});
      activeCase.screenshots.push(await screenshot(conversation, 'explicit-cancellation-confirmation-open'));
      await conversation.click('[data-confirmation-dialog] [data-confirmation-cancel]');
      await until(async () => !(await conversation.$('[data-confirmation-dialog]')), 'dismissed cancellation confirmation closes the dialog');
      assert.equal((await status()).todos.find(item => item.id === todo.id).status, 'open', 'Dismissing the confirmation must not interrupt the native turn');
      assert.equal(activeCase.requests.length, 1, 'Dismissing the confirmation must not touch the model');
      await conversation.click(selector + ' [data-attention-cancel]');
      await conversation.waitForSelector('[data-confirmation-dialog]', {visible: true});
      await conversation.keyboard.press('Escape');
      await until(async () => !(await conversation.$('[data-confirmation-dialog]')), 'Escape dismisses the cancellation confirmation');
      assert.equal((await status()).todos.find(item => item.id === todo.id).status, 'open', 'Escape must not interrupt the native turn');
      await conversation.click(selector + ' [data-attention-cancel]');
      await conversation.waitForSelector('[data-confirmation-dialog]', {visible: true});
      await conversation.click('[data-confirmation-dialog] [data-confirmation-confirm]');
    } else await conversation.click(selector + ' [data-attention-submit]');
    const cancelled = definition.name === 'explicit-cancellation';
    await until(async () => {
      assert.deepEqual(protocolErrors, [], 'Local model protocol assertions');
      const state = await status();
      const job = state.jobs.find(item => item.id === sent.jobId);
      return state.todos.find(item => item.id === todo.id)?.status === 'resolved' && (cancelled ? ['failed', 'cancelled', 'canceled'].includes(job?.status) : job?.status === 'completed');
    }, cancelled ? 'same source todo resolves and native cancellation interrupts original job' : 'same source todo resolves and native tool continuation completes');
    const expectedRequests = cancelled ? 1 : 2;
    assert.equal(activeCase.requests.length, expectedRequests);
    if (cancelled) {
      const state = await status();
      const job = state.jobs.find(item => item.id === sent.jobId);
      if (job.status === 'failed') assert.match(job.error, /Interrupted by user/i, 'Native ask cancellation must retain its intentional user-interruption error');
      activeCase.nativeCancellation = {semantics: 'Intentional native ask interruption; no model continuation', job, systemReminders: state.todos.filter(item => item.sourceJobId === sent.jobId && item.kind === 'system')};
      assert.equal(activeCase.toolResult, undefined, 'Cancellation must not fabricate a tool-result continuation');
    } else assert(activeCase.toolResult, 'Native result must be observed in the next model request');
    const repeat = await rawResponse(conversation, todo.id, {kind: 'submit', results: [{id: definition.questions[0].id, selectedOptions: [definition.questions[0].options[0].label]}]});
    assert.equal(repeat.ok, false, 'Repeat/stale submit must be refused');
    assert(['ATTENTION_STALE', 'INTERACTION_STALE'].includes(repeat.error.code), 'Repeat must fail specifically because its source is stale');
    assert.equal(activeCase.requests.length, expectedRequests, 'Stale submit cannot become a model request');
    activeCase.staleSubmission = repeat.error;
    activeCase.screenshots.push(await screenshot(conversation, definition.name + '-resolved'));
    activeCase.ok = true;
    await save();
  }
  report.cancelledTurnReminders=[];
  for(const issue of (await status()).todos.filter(todo=>todo.kind==='system'&&todo.status==='open')){
    await shell.waitForSelector('[data-attention-prompt]:not([hidden])',{visible:true});await shell.click('[data-attention-prompt] button:last-of-type');
    await until(async()=>(await status()).attentionNotified.includes(issue.id),'explicitly defer the native interrupted-turn reminder');
    assert.equal((await status()).todos.find(todo=>todo.id===issue.id).status,'open','Deferring an interruption reminder never resolves its underlying issue');report.cancelledTurnReminders.push({todoId:issue.id,status:'open',notification:'explicitly deferred'});
  }
  const requestsBeforeRestart = modelInputs.length;
  activeCase = undefined;
  await closeNormally();
  await launch();
  await shell.waitForSelector('[data-project-id="' + projectId + '"]');
  await shell.click('[data-project-id="' + projectId + '"]');
  await until(async () => (await invoke('workspace.bootstrap')).projectId === projectId, 'restored source project');
  const restored = await status();
  for (const scenario of report.scenarios) {
    assert.equal(restored.todos.find(todo => todo.id === scenario.todoId)?.status, 'resolved', 'Normal restart preserves resolved source todo');
    if (scenario.name !== 'single-select') assert(restored.attentionNotified.includes(scenario.todoId), 'Acknowledged notification must remain acknowledged');
  }
  assert.equal(restored.todos.filter(todo => todo.origin === 'instance-attention' && todo.status === 'open' && todo.destination?.kind === 'conversation').length, 0, 'No native ask is replayed on restart');
  assert.equal(await shell.$eval('[data-attention-prompt]', node => node.hidden), true, 'Resolved notification must not replay');
  report.restartScreenshot = await screenshot(shell, 'normal-restart-no-replay');
  await closeNormally();
  assert.equal(modelInputs.length, requestsBeforeRestart, 'Normal restart must not replay any model request');
  assert.deepEqual(protocolErrors, []);
  assert.deepEqual(report.errors, []);
  report.restart = {ok: true, normalExit: true, requestsBefore: requestsBeforeRestart, requestsAfter: modelInputs.length};
  report.ok = true;
} catch (error) {
  process.exitCode = 1;
  report.error = error.stack;
  report.protocolErrors = protocolErrors;
  if (shell && report.scenarios.at(-1)?.name === 'single-select') report.scenarios.at(-1).clickEvidence = await shell.evaluate(() => window.__attentionClickEvidence).catch(() => null);
  report.failureStatus = projectId && shell ? await status().catch(() => null) : null;
  if (shell) await screenshot(shell, 'failure').catch(() => {});
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
