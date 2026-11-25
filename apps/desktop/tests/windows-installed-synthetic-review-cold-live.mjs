// Dedicated installed-Windows synthetic journey driver: explicit send →
// review → accept → cold reopen, all against one real isolated installation.
//
//   node tests/windows-installed-synthetic-review-cold-live.mjs \
//     --output C:\nozeli-test\<strictly-fresh-evidence-dir> \
//     --candidate C:\abs\<extracted-windows-candidate>
//
// The installation is created through the candidate payload's own bundled
// installer (install-windows.mjs install), and EVERY app start goes through
// the installation's original generated launcher Launch-Nozeli.ps1, invoked
// exactly as: powershell.exe -NoProfile -NonInteractive -File
// <root>\Launch-Nozeli.ps1 — with no execution-policy option and no
// environment override of any policy setting. Before anything is created the
// driver probes the effective PowerShell execution policy and fails loudly if
// it is Restricted; it never works around a restrictive policy. The driver
// never spawns Nozeli.exe directly and never bypasses the launcher's payload
// verification. The only child seams used are the variables the launcher
// itself preserves: NOZELI_DEBUG_PORT (CDP), NOZELI_HIDDEN and
// NOZELI_SHOT_DIR. Installed profiles ignore NOZELI_TEST_PICK by design, so
// the synthetic project is registered into the installation's dedicated
// profile before first launch through the candidate payload's own production
// DesktopHost (same code the installed app runs).
//
// Cleanup policy: closing is protocol-level only (session.requestClose over
// CDP, then a bounded observation that the installation's Nozeli.exe
// processes drained). There is no PID-based termination. A failed run
// retains the whole fixture (installation, profile, project, evidence) and
// records the still-observed processes as facts. A launcher exit code is
// reported as a launcher-level fact; the native app exit is proven by the
// drained process observation, never by the launcher code alone.
//
// Honesty of classification: the model is a deterministic loopback
// OpenAI-completions server (synthetic; no paid model, no model-quality
// claim); gestures are CDP keyboard/mouse input, not physical keyboard/IME
// proof; the cold reopen proves persisted accepted state with zero model
// replay across a real drained launcher exit/relaunch, not OS crash or
// power-loss recovery; installer/updater durability, signing and SmartScreen
// are not covered. Not executed as part of authoring this file.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
import {prepareReading} from './reading-setup.fixture.mjs';
import {appProcesses, freePort, processesUnder, readJson, waitFor} from './fixtures/windows-update-live/windows-update-live-fixture.mjs';

const usage = 'usage: windows-installed-synthetic-review-cold-live.mjs --output C:\\abs\\strictly-fresh-evidence-dir --candidate C:\\abs\\extracted-windows-candidate';
function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--output', '--candidate'].includes(argv[index]) || !argv[index + 1] || options[argv[index]]) throw Error(usage);
    options[argv[index]] = argv[index + 1];
  }
  if (!options['--output'] || !options['--candidate']) throw Error(usage);
  return {output: options['--output'], candidate: options['--candidate']};
}
const args = parseArguments(process.argv.slice(2));
assert.equal(process.platform, 'win32', 'Requires native Windows');
assert.equal(process.arch, 'x64', 'Requires native Windows x64');
for (const value of [args.output, args.candidate]) assert(path.isAbsolute(value), 'Absolute paths required: ' + value);
assert(/^c:\\/i.test(path.resolve(args.output)), 'Evidence/installation root must live on the C: volume (synthetic install roots/profiles on C:)');
const home = process.env.USERPROFILE || process.env.HOME;
if (home && path.resolve(args.output).toLowerCase().startsWith(path.resolve(home).toLowerCase() + path.sep)) throw Error('Evidence root is inside the OS account home; the installer requires a dedicated non-home installation root on C:');
if (home && path.resolve(args.output).toLowerCase().startsWith(path.resolve(home, '.Nozeli').toLowerCase() + path.sep)) throw Error('Output root overlaps the daily profile root; choose a dedicated C: directory');
const related = (a, b) => { const rel = path.relative(a, b); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
if (related(path.resolve(args.candidate), path.resolve(args.output))) throw Error('Candidate and evidence/installation root must be disjoint');

// Harness observation limits only; the installed product's own deadlines are unchanged.
const INSTALL_BUDGET = 2700000;   // full validated native copy for install
const LAUNCH_BUDGET = 900000;     // launcher payload verification + app start + CDP
const READY_BUDGET = 900000;     // resident native owners (cold concurrent anchored-IO starts)
const REVIEW_BUDGET = 600000;     // dispatch → read → apply → publish → review
const MERGE_BUDGET = 300000;      // host-coordinated accept merge
const EXIT_BUDGET = 600000;       // native stop/flush before the drained close
const FAILURE_DRAIN_BUDGET = 120000; // bounded protocol-level drain attempt on failure

const output = path.resolve(args.output);

const report = {
  ok: false,
  invocation: {node: process.execPath, script: path.resolve(process.argv[1] ?? ''), argv: process.argv.slice(2)},
  scope: 'One real isolated Windows installation created by the candidate payload\'s bundled installer; every start through the original generated Launch-Nozeli.ps1 with no execution-policy option or environment override (effective policy probed before any mutation); deterministic loopback synthetic model; explicit background send through the real #submit-background renderer control after filling the composer, with the durable orchestrator intake asserted through state; review and accept through the real report surface controls; cold reopen through a fully drained launcher close/relaunch proving persisted accepted state with zero model replay',
  notCovered: ['physical keyboard/IME/multi-display input', 'paid model quality', 'OS crash or power-loss recovery', 'installer/updater durability, signing, SmartScreen', 'execution-policy changes (the effective policy is observed, never changed)'],
  checks: [], errors: [], modelRequests: [], launcherInvocations: [], launches: [],
};

const stopping = {value: false};
const launchers = new Set();
let browser = null, shell = null, server = null, installationRoot = null, projectId = null;
let expectedReportTodoId = null;

function powershell() { return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); }

async function failureProbe(action, budget = 10000) {
  let timer;
  try {
    return await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('failure probe timed out')), budget); })]);
  } finally { clearTimeout(timer); }
}

// Protocol-level cleanup only. No PID-based termination: the app is asked to
// close through its own renderer admission, the drain is observed with a
// bounded budget, and anything still alive is recorded as a retained fact
// alongside the retained fixture.
async function cleanup() {
  stopping.value = true;
  if (browser && shell) {
    try { report.failureCloseReply = await failureProbe(() => shell.evaluate(() => window.nozeli.invoke('session.requestClose', {}))); }
    catch (error) { report.failureCloseError = error.message; }
  }
  if (installationRoot && launchers.size && !report.ok) {
    try {
      await waitFor(async () => report.launches.every(run => run.exit || run.spawnError) && (await processesUnder(installationRoot)).length === 0, 'failure cleanup launcher exit and installed image drain', FAILURE_DRAIN_BUDGET);
    } catch (error) { report.failureDrainError = error.message; }
  }
  await browser?.disconnect().catch(() => {}); browser = null; shell = null;
  for (const child of launchers) { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
  server?.closeAllConnections?.();
  await new Promise(resolve => (server ? server.close(() => resolve(null)) : resolve(null)));
  if (installationRoot) { try { report.retainedProcesses = await processesUnder(installationRoot); } catch (error) { report.retainedProcesses = [{error: String(error.message)}]; } }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)); });

// ---------- preflight: effective execution policy, before any mutation ----------
const policyProbe = spawnSync(powershell(), ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'], {env: installEnv(), encoding: 'utf8', timeout: 30000, windowsHide: true});
assert.ifError(policyProbe.error, 'Execution-policy preflight could not run PowerShell');
assert.equal(policyProbe.status, 0, 'Execution-policy preflight failed: ' + (policyProbe.stderr || policyProbe.stdout || 'no output'));
const executionPolicy = (policyProbe.stdout || '').trim();
assert(/^[A-Za-z]+$/.test(executionPolicy), 'Unexpected execution-policy probe output: ' + JSON.stringify(policyProbe.stdout));
report.executionPolicy = executionPolicy;
assert.match(executionPolicy, /^(RemoteSigned|Unrestricted|Bypass)$/, 'Effective PowerShell policy does not admit the unsigned original launcher; no fixture created');

// ---------- strictly fresh evidence root ----------
await fs.mkdir(output); // Atomic admission: even an empty existing directory is refused.

function installEnv() {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ASKPASS/i.test(key) || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
  env.Path = path.join(env.SystemRoot ?? env.SYSTEMROOT, 'System32');
  return env;
}
function runBundled(node, script, argv) {
  const result = spawnSync(node, [script, ...argv], {env: installEnv(), encoding: 'utf8', timeout: INSTALL_BUDGET, windowsHide: true, maxBuffer: 32 * 1024 * 1024});
  assert.ifError(result.error);
  assert.equal(result.status, 0, script + ' ' + argv.join(' ') + '\n' + (result.stdout || '') + (result.stderr || ''));
  return JSON.parse(result.stdout);
}

// Real product tooling imported from the actual candidate payload (never from
// a rebuilt or renamed copy).
async function loadCandidate(directory) {
  const app = path.join(directory, 'resources', 'app');
  const pack = await import(pathToFileURL(path.join(app, 'tools', 'package-windows-candidate.mjs')).href);
  const checked = await pack.validateWindowsCandidate(directory);
  const manifest = checked.manifest; checked.tree.close();
  assert.equal(manifest.platform, 'win32', 'Candidate must be the Windows package: ' + directory);
  assert.equal(manifest.arch, 'x64', 'Candidate must be the x64 package: ' + directory);
  const release = await readJson(path.join(directory, 'RELEASE.json'));
  assert(release && release.version === manifest.version && /^[0-9a-f]{40}$/.test(release.commit ?? ''), 'Candidate RELEASE.json must bind the exact version and source commit');
  assert.equal(manifest.nativeProvenance?.commit, release.commit, 'Native provenance must match the release commit');
  if (manifest.commit !== undefined) assert.equal(manifest.commit, release.commit, 'Candidate commit must match the release commit');
  return {directory, app, node: path.join(app, 'runtime', 'node', 'node.exe'), installer: path.join(app, 'tools', 'install-windows.mjs'), version: manifest.version, commit: release.commit, digest: checked.digest};
}

async function invoke(page, op, payload = {}) {
  const response = await page.evaluate(({op, payload}) => window.nozeli.invoke(op, payload), {op, payload});
  assert.equal(response.ok, true, op + ': ' + JSON.stringify(response));
  return response.value;
}
async function findShell(connection) {
  return waitFor(async () => {
    for (const target of await connection.pages()) if (await target.evaluate(() => location.href.startsWith('http://127.0.0.1:') && window.__nozeliReady === true && window.__workspaceScope?.role === 'shell').catch(() => false)) return target;
  }, 'installed shell renderer ready', LAUNCH_BUDGET, {stopping});
}
async function observe(connection) {
  const watch = page => page.on('pageerror', error => report.errors.push(error.message));
  for (const page of await connection.pages()) watch(page);
  connection.on('targetcreated', async target => { const page = await target.page(); if (page) watch(page); });
}

// ---------- synthetic project + deterministic loopback model ----------
const REL = 'reading.md';
const WORK_NAME = 'Windows installed synthetic accept work';
const baseline = '# Windows installed synthetic project\n\nBaseline paragraph.\n';
const candidate = '# Windows installed synthetic project\n\nAccepted synthetic candidate.\n';
const reportHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Installed synthetic result</title></head><body><main><h1>Installed synthetic result</h1><p>WINDOWS-INSTALLED-SYNTHETIC-RESULT</p><a href="reading.md">Review Markdown</a></main></body></html>';
const TASK_TEXT = 'WINDOWS-INSTALLED-COLD-ACCEPT：在本次工作中通过宿主文档工具把 reading.md 修改为指定候选文本，发布包含 reading.md 的结果报告并等待审核；在用户明确采纳之前不得改动项目原文件。';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const tool = (name, args, id) => ({role: 'assistant', tool_calls: [{index: 0, id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]});

try {
  installationRoot = path.join(output, 'installation');
  const projectRoot = path.join(output, 'synthetic-project');

  // Deterministic loopback synthetic model (started inside the failure
  // boundary so a setup failure still reports and cleans up).
  let orchestratorStage = 0, workerStage = 0;
  const modelErrors = [];
  report.modelErrors = modelErrors;
  server = http.createServer((req, res) => {
    report.modelRequestCount = (report.modelRequestCount ?? 0) + 1;
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const input = JSON.parse(body), names = (input.tools || []).map(t => t.function?.name);
        const orchestrator = names.includes('nozeli_dispatch'), worker = !orchestrator && names.some(name => name && name.startsWith('nozeli_'));
        let delta, finish = 'tool_calls';
        if (orchestrator) {
          if (orchestratorStage++ === 0) delta = tool('nozeli_dispatch', {name: WORK_NAME, brief: 'Revise reading.md into the exact requested candidate through host document tools and publish the result for review. Never touch the project source before explicit acceptance.'}, 'dispatch-installed');
          else throw Error('unexpected extra orchestrator model round after dispatch');
        } else if (worker) {
          const lastTool = (input.messages ?? []).filter(m => m.role === 'tool').at(-1) ?? null;
          if (workerStage === 0) { workerStage = 1; delta = tool('nozeli_document_read', {relPath: REL}, 'read-installed'); }
          else if (workerStage === 1) {
            assert(lastTool?.tool_call_id === 'read-installed', 'native document read reply required; last tool: ' + JSON.stringify(lastTool?.tool_call_id ?? null));
            const reply = typeof lastTool.content === 'string' ? JSON.parse(lastTool.content) : lastTool.content;
            const read = reply.value ?? reply;
            assert.equal(read.relPath, REL);
            assert.equal(read.text, baseline, 'worker must read the exact project baseline');
            delta = tool('nozeli_document_apply', {readHandle: read.readHandle, replacements: [{oldText: baseline, newText: candidate}]}, 'apply-installed');
            workerStage = 2;
          } else if (workerStage === 2) {
            assert(lastTool?.tool_call_id === 'apply-installed', 'native document apply reply required; last tool: ' + JSON.stringify(lastTool?.tool_call_id ?? null));
            delta = tool('nozeli_publish', {kind: 'result', content: reportHtml, files: [REL]}, 'publish-installed');
            workerStage = 3;
          } else throw Error('unexpected extra worker model round after publication');
        } else { delta = {role: 'assistant', content: 'FRONT_REPLY'}; finish = 'stop'; }
        report.modelRequests.push({role: orchestrator ? 'orchestrator' : worker ? 'worker' : 'frontdesk', tool: delta.tool_calls?.[0]?.function?.name ?? null});
        res.writeHead(200, {'content-type': 'text/event-stream'});
        for (const [part, end] of [[delta, null], [{}, finish]]) res.write('data: ' + JSON.stringify({id: 'installed-' + report.modelRequests.length, object: 'chat.completion.chunk', choices: [{index: 0, delta: part, finish_reason: end}]}) + '\n\n');
        res.end('data: [DONE]\n\n');
      } catch (error) { modelErrors.push(error.stack); res.destroy(error); }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });

  // ---------- installation + profile seeding ----------
  const original = await loadCandidate(path.resolve(args.candidate));
  const installed = runBundled(original.node, original.installer, ['install', '--root', installationRoot, '--candidate', original.directory]);
  const ownerRecord = await readJson(path.join(installationRoot, 'WINDOWS-INSTALL.json'));
  assert(/^[a-f0-9-]{36}$/.test(ownerRecord?.installationId ?? ''), 'Installation owner record missing installationId');
  // The original launcher is the byte-frozen generated script bound by the owner record.
  assert.equal(ownerRecord.launcherSha256, digest(await fs.readFile(path.join(installationRoot, 'Launch-Nozeli.ps1'))), 'Owner record must bind the exact original launcher digest');
  report.installation = {root: installationRoot, installationId: ownerRecord.installationId, active: installed.active, version: original.version, commit: original.commit, candidateDigest: original.digest};
  report.checks.push('real isolated installation created through the bundled installer and original launcher digest bound by the owner record');

  await fs.mkdir(projectRoot, {recursive: true});
  await fs.writeFile(path.join(projectRoot, REL), baseline);
  // The installed profile ignores NOZELI_TEST_PICK, so registration goes through
  // the candidate payload's own production DesktopHost before the first launch.
  const profileDesktop = path.join(installationRoot, 'profile', 'desktop');
  const {ensureExperimentalPrivateDirectory} = await import(pathToFileURL(path.join(original.app, 'src', 'platform', 'windows', 'experimental-directories.mjs')).href);
  await ensureExperimentalPrivateDirectory(installationRoot, profileDesktop);
  const {DesktopHost} = await import(pathToFileURL(path.join(original.app, 'src', 'main', 'host.mjs')).href);
  const seedHost = new DesktopHost(profileDesktop);
  try { projectId = (await seedHost.pick(projectRoot)).project.id; }
  finally { await seedHost.storage.db.close(); }
  report.project = {root: projectRoot, projectId, baselineDigest: digest(Buffer.from(baseline)), candidateDigest: digest(Buffer.from(candidate))};

  // ---------- launcher-driven app lifecycle ----------
  const state = async () => (await invoke(shell, 'managed.status', {projectId})).state;
  const idle = async () => waitFor(async () => {
    const s = await state().catch(() => null);
    if (!s) return false;
    if (s.jobs?.some(job => ['queued', 'running', 'transferring'].includes(job.status))) return false;
    return !s.busyTargets?.length;
  }, 'managed runtime idle', EXIT_BUDGET, {stopping});

  async function launch() {
    const launcher = path.join(installationRoot, 'Launch-Nozeli.ps1');
    assert.equal(digest(await fs.readFile(launcher)), ownerRecord.launcherSha256, 'Original launcher bytes changed before start');
    const port = await freePort();
    const invocation = {executable: powershell(), args: ['-NoProfile', '-NonInteractive', '-File', launcher], cwd: installationRoot, env: {NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0', NOZELI_SHOT_DIR: output}};
    report.launcherInvocations.push(invocation);
    const child = spawn(invocation.executable, invocation.args, {cwd: invocation.cwd, env: {...installEnv(), ...invocation.env}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    launchers.add(child);
    let log = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk; });
    const evidence = {pid: child.pid, debugPort: port};
    report.launches.push(evidence);
    const exited = new Promise((resolve, reject) => {
      child.once('error', error => { evidence.spawnError = error.message; reject(error); });
      child.once('exit', (code, signal) => { evidence.exit = {code, signal}; resolve(evidence.exit); });
    });
    void exited.catch(() => {}); // Launch may fail before close starts waiting.
    browser = await waitFor(async () => {
      if (evidence.spawnError) throw Error(evidence.spawnError);
      if (child.exitCode !== null || child.signalCode !== null) throw Error('Launcher exited before the app accepted CDP: ' + JSON.stringify({code: child.exitCode, signal: child.signalCode, log: log.slice(-8000)}));
      return puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null, protocolTimeout: LAUNCH_BUDGET}).catch(() => null);
    }, 'installed app CDP connection through the original launcher', LAUNCH_BUDGET, {stopping});
    await observe(browser);
    shell = await findShell(browser);
    await prepareReading(shell);
    await invoke(shell, 'session.resize', {width: 1440, height: 1000});
    await invoke(shell, 'workspace.windows.focus', {windowId: 'main'});
    await shell.bringToFront();
    await shell.waitForFunction(() => document.visibilityState === 'visible');
    return {child, exited, log: () => log, evidence};
  }
  async function close(run, label) {
    await idle();
    assert((await appProcesses(installationRoot)).length > 0, 'Expected to observe this installation’s running Nozeli.exe before close');
    await invoke(shell, 'session.requestClose');
    await waitFor(async () => run.evidence.exit && (await processesUnder(installationRoot)).length === 0, 'launcher exit and no installed image paths observed after requestClose (' + label + ')', EXIT_BUDGET, {stopping});
    const exit = await run.exited;
    assert.deepEqual(exit, {code: 0, signal: null}, 'Launcher reported a non-clean exit (' + label + '): ' + run.log().slice(-4000));
    run.evidence.observedInstalledImagesAfterClose = [];
    await browser.disconnect(); browser = null; shell = null;
  }
  async function conversation() {
    for (const page of await browser.pages()) if (await page.evaluate(id => window.__nozeliReady && window.__workspaceScope?.kind === 'conversation' && window.__workspaceScope.projectId === id, projectId).catch(() => false)) return page;
    await shell.click('#workspace-open-conversation');
    return waitFor(async () => {
      for (const page of await browser.pages()) if (await page.evaluate(id => window.__nozeliReady && window.__workspaceScope?.kind === 'conversation' && window.__workspaceScope.projectId === id, projectId).catch(() => false)) return page;
    }, 'conversation surface', READY_BUDGET, {stopping});
  }
  async function reportPageOf(todoId) {
    expectedReportTodoId = todoId;
    await shell.evaluate(id => window.__workspaceOpenTodo(id), todoId);
    const page = await waitFor(async () => {
      for (const target of await browser.pages()) if (await target.evaluate(id => window.__nozeliReady && window.__workspaceScope?.kind === 'report' && window.__workspaceScope?.viewState?.report?.todoId === id, todoId).catch(() => false)) return target;
    }, 'report surface for todo ' + todoId, READY_BUDGET, {stopping});
    await page.bringToFront();
    return page;
  }
  const assertScriptedTurn = () => {
    // Successful dispatch is a terminal routing decision, not a chat reply.
    // Compare each role's own sequence; cross-role ordering is not required.
    const orchestratorCalls = report.modelRequests.filter(request => request.role === 'orchestrator');
    const workerCalls = report.modelRequests.filter(request => request.role === 'worker');
    assert.deepEqual(orchestratorCalls.map(request => request.tool), ['nozeli_dispatch'], 'orchestrator script sequence: ' + JSON.stringify(orchestratorCalls));
    assert.deepEqual(workerCalls.map(request => request.tool), ['nozeli_document_read', 'nozeli_document_apply', 'nozeli_publish'], 'worker script sequence: ' + JSON.stringify(workerCalls));
    assert.equal(report.modelRequests.filter(request => request.role === 'frontdesk').length, 0, 'explicit background send must not create a frontdesk model turn');
    assert.deepEqual(modelErrors, [], 'no model scripting errors');
    report.modelOrder = report.modelRequests.map(request => request.role + ':' + (request.tool ?? 'text'));
  };

  // ----- launch 1: configure, explicit send, review, accept -----
  const first = await launch();
  await invoke(shell, 'config.initialize', {mode: 'independent'});
  await invoke(shell, 'settings.providers.save', {operation: 'create', provider: 'installed-synthetic-local', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', api: 'openai-completions', models: [{id: 'scripted'}], credential: {action: 'replace', value: 'synthetic-local-only'}});
  await invoke(shell, 'settings.models.save', {frontdesk: {model: {mode: 'explicit', selector: 'installed-synthetic-local/scripted'}, thinking: {mode: 'native-default'}}, orchestrator: {model: {mode: 'explicit', selector: 'installed-synthetic-local/scripted'}, thinking: {mode: 'native-default'}}, worker: {model: {mode: 'explicit', selector: 'installed-synthetic-local/scripted'}, thinking: {mode: 'native-default'}}});
  report.checks.push('synthetic loopback provider and explicit model selectors configured through the installed settings surface');

  await shell.click('#recent [data-project-id="' + projectId + '"]');
  await shell.waitForFunction(id => window.__workspaceScope?.projectId === id, {}, projectId);
  await invoke(shell, 'managed.enable', {projectId});
  await waitFor(async () => (await invoke(shell, 'managed.status', {projectId})).ready, 'resident native owners', READY_BUDGET, {stopping});

  const chat = await conversation();
  await waitFor(async () => chat.$eval('#conversation-panel', node => node.dataset.managedConversation === 'frontdesk').catch(() => false), 'frontdesk conversation recipient', READY_BUDGET, {stopping});
  await waitFor(async () => chat.$eval('#send-message', node => !node.disabled).catch(() => false), 'conversation send enabled', READY_BUDGET, {stopping});
  const jobsBeforeSubmit = (await state()).jobs.map(job => job.id);
  await chat.locator('#composer').fill(TASK_TEXT);
  // The real renderer control (提交后台, managed-agent-panel.mjs #submit-background)
  // carries the explicit background admission; its click handler reports
  // failures through the UI toast, so durability is asserted through state.
  await waitFor(async () => chat.$eval('#submit-background', node => !node.hidden && !node.disabled).catch(() => false), 'submit-background control enabled', READY_BUDGET, {stopping});
  await chat.click('#submit-background');
  await waitFor(async () => {
    const s = await state();
    return s.jobs.some(job => !jobsBeforeSubmit.includes(job.id) && job.type === 'intake' && job.target === 'orchestrator') || null;
  }, 'durable orchestrator intake job after the explicit background submit', READY_BUDGET, {stopping});
  await waitFor(async () => await chat.$eval('#composer', node => node.value).catch(() => null) === '', 'composer cleared after explicit send admission', READY_BUDGET, {stopping});
  report.checks.push('explicit background send (提交后台) through the real #submit-background control admitted with a durable orchestrator intake');

  const work = await waitFor(async () => {
    const s = await state();
    const failed = s.jobs.find(job => job.status === 'failed');
    if (failed) throw Error('job failed: ' + JSON.stringify(failed));
    if (s.busyTargets.includes('orchestrator')) return null;
    return s.works.find(w => w.name === WORK_NAME && w.status === 'review' && !s.busyTargets.includes(w.id) && w.execution?.directory) || null;
  }, 'synthetic Work reaches review', REVIEW_BUDGET, {stopping});
  const workId = work.id;
  assert.equal((await state()).works.length, 1, 'exactly one Work');
  assert.equal(typeof work.threadId, 'string', 'persisted Worker thread identity');
  assert.equal(await fs.readFile(path.join(projectRoot, REL), 'utf8'), baseline, 'project source untouched before acceptance');
  assert.equal(await fs.readFile(path.join(work.execution.directory, REL), 'utf8'), candidate, 'candidate lives only in the execution worktree');
  assertScriptedTurn();
  const addedJobs = (await state()).jobs.filter(job => !jobsBeforeSubmit.includes(job.id));
  const intakes = addedJobs.filter(job => job.type === 'intake' && job.target === 'orchestrator');
  assert.equal(intakes.length, 1, 'exactly one durable orchestrator intake job');
  assert.equal(intakes[0].status, 'completed', 'orchestrator intake settled');
  assert.equal(intakes[0].routing?.action, 'dispatch');
  assert.equal(intakes[0].routing?.workId, workId, 'dispatch receipt binds the reviewed Work');
  assert.equal(addedJobs.filter(job => job.target === workId && job.type === 'initial').length, 1, 'one original Worker input job');
  assert.equal(addedJobs.filter(job => job.target === 'frontdesk' && job.type === 'front').length, 0, 'no frontdesk chat job from the explicit background submit');

  let s = await state();
  const receipt = s.receipts.findLast(r => r.workId === workId && r.kind === 'result');
  assert(receipt, 'result receipt present');
  const todo = s.todos.find(t => t.objectId === receipt.objectId);
  assert(todo, 'review todo present');
  const review = await invoke(shell, 'managed.review.read', {projectId, workId, objectId: receipt.objectId});
  assert.equal(review.files.find(f => f.relPath === REL).baselineText, baseline, 'frozen review baseline');
  assert(review.reviewVersion !== undefined, 'review version present');
  report.checks.push('real native Worker read/apply/published an immutable report and the Work waits in review with the project source preserved');

  const page = await reportPageOf(todo.id);
  await page.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]');
  const previewKey = await page.$eval('.managed-report-body .isolated-viewport', node => node.dataset.previewKey);
  const preview = await invoke(page, 'isolated-preview.snapshot', {key: previewKey});
  const guest = await waitFor(async () => (await browser.pages()).find(target => target.url().startsWith(preview.origin + '/')), 'isolated report guest', READY_BUDGET, {stopping});
  assert((await guest.evaluate(() => document.body.innerText)).includes('WINDOWS-INSTALLED-SYNTHETIC-RESULT'), 'native report guest renders the frozen synthetic report');
  await guest.waitForSelector('[data-nozeli-endmatter-action="file"]');
  await page.waitForFunction(() => { const button = document.querySelector('[data-review-action="accept"]'); return button && !button.disabled && button.getClientRects().length > 0; });
  await page.screenshot({path: path.join(output, '01-review-report.png')});
  await guest.screenshot({path: path.join(output, '01-review-content.png')});
  report.checks.push('frozen report renders the review surface with the candidate file and an actionable accept control');

  await page.click('[data-review-action="accept"]');
  await page.waitForSelector('[data-confirmation-confirm]', {visible: true});
  await page.click('[data-confirmation-confirm]');
  const merged = await waitFor(async () => {
    const read = await invoke(shell, 'managed.review.read', {projectId, workId, objectId: receipt.objectId});
    if (read.merge?.status === 'blocked') throw Error('accept merge blocked: ' + JSON.stringify(read.merge));
    return read.merge?.status === 'merged' ? read : null;
  }, 'host-coordinated accept merge', MERGE_BUDGET, {stopping});
  assert.equal(merged.merge.executor, 'host');
  const closed = await waitFor(async () => { const w = (await state()).works.find(w => w.id === workId); return w.status === 'ended' && w.closure?.phase === 'complete' ? w : null; }, 'accept decision closure complete', MERGE_BUDGET, {stopping});
  const retirement = closed.closure.stopReceipt?.provider;
  const owner = retirement?.registration?.record;
  const proof = retirement?.proof;
  assert.equal(owner?.phase, 'retired');
  assert.equal(owner?.identity?.platform, 'win32');
  assert.equal(owner?.supervision?.inputCustodyVerified, true);
  assert.equal(owner?.supervision?.outputCustodyVerified, true);
  assert.equal(proof?.scope, 'same-host-exact-job-and-journal');
  for (const key of ['allProcessIncarnationsObserved', 'stdoutEOF', 'stderrEOF', 'protocolComplete']) assert.equal(proof?.[key], true, key);
  const readOnlyReport = async reportPage => {
    await reportPage.waitForFunction(ref => {
      const status = document.querySelector('[data-review-status]');
      return status?.getClientRects().length > 0 && status.textContent.includes(ref);
    }, {timeout: MERGE_BUDGET}, merged.merge.targetRef);
    const state = await reportPage.evaluate(() => {
      const accept = document.querySelector('[data-review-action="accept"]');
      return {present: Boolean(accept), disabled: accept?.disabled ?? null, status: document.querySelector('[data-review-status]')?.textContent};
    });
    assert(!state.present || state.disabled === true, 'accepted report must not offer a second accept');
    return state;
  };
  report.mergedReport = await readOnlyReport(page);
  assert.equal(await fs.readFile(path.join(projectRoot, REL), 'utf8'), candidate, 'accepted candidate merged into the project');
  const {runGit} = await import(pathToFileURL(path.join(original.app, 'src', 'agents', 'managed', 'git-runtime.mjs')).href);
  assert.equal((await runGit(projectRoot, ['symbolic-ref', 'HEAD'])).toString().trim(), 'refs/heads/main', 'project stays on main');
  assert.equal((await runGit(projectRoot, ['show', 'HEAD:' + REL])).toString(), candidate, 'git HEAD carries the accepted candidate');
  await page.screenshot({path: path.join(output, '02-merged-report.png')});
  const requestsAfterAccept = report.modelRequestCount;
  const jobsAfterAccept = (await state()).jobs.map(job => job.id);
  const headAfterAccept = (await runGit(projectRoot, ['rev-parse', 'HEAD'])).toString().trim();
  report.identity = {projectId, workId, threadId: work.threadId, objectId: receipt.objectId, reviewVersion: review.reviewVersion, merge: merged.merge};
  report.workerRetirement = {phase: owner.phase, inputCustodyVerified: owner.supervision.inputCustodyVerified, outputCustodyVerified: owner.supervision.outputCustodyVerified, proof};
  report.beforeReopen = {modelRequestCount: requestsAfterAccept, jobs: jobsAfterAccept, head: headAfterAccept};
  report.checks.push('explicit accept through the real report control merged the exact candidate through the host and closed the Work');

  // ----- cold reopen through the original launcher -----
  await close(first, 'initial journey');
  const second = await launch();
  await shell.click('#recent [data-project-id="' + projectId + '"]');
  await shell.waitForFunction(id => window.__workspaceScope?.projectId === id, {}, projectId);
  await invoke(shell, 'managed.connect', {projectId});
  await waitFor(async () => (await invoke(shell, 'managed.status', {projectId})).ready, 'resident native owners after cold reopen', READY_BUDGET, {stopping});
  assert.equal(report.modelRequestCount, requestsAfterAccept, 'no model requests after cold-reopen readiness');
  assert.deepEqual(modelErrors, [], 'no model scripting errors after reopen');
  s = await state();
  const reopened = s.works.find(w => w.id === workId);
  assert.equal(s.works.length, 1, 'still exactly one Work after cold reopen');
  assert.equal(reopened.status, 'ended');
  assert.equal(reopened.closure?.phase, 'complete');
  assert.equal(reopened.threadId, work.threadId, 'Work and thread identity survive cold reopen');
  assert.deepEqual((await state()).jobs.map(job => job.id), jobsAfterAccept, 'no new jobs after cold reopen');
  const frozen = await invoke(shell, 'managed.review.read', {projectId, workId, objectId: receipt.objectId});
  assert.equal(frozen.merge?.status, 'merged', 'accepted merge receipt survives cold reopen');
  assert.deepEqual(frozen.merge, merged.merge, 'host merge receipt is unchanged across cold reopen');
  assert.equal(frozen.files.find(f => f.relPath === REL).baselineText, baseline, 'frozen review object unchanged');
  assert.equal(await fs.readFile(path.join(projectRoot, REL), 'utf8'), candidate, 'merged project file survives cold reopen');
  assert.equal((await runGit(projectRoot, ['rev-parse', 'HEAD'])).toString().trim(), headAfterAccept, 'git HEAD unchanged across cold reopen');
  const todoAgain = s.todos.find(t => t.objectId === receipt.objectId);
  assert.equal(todoAgain?.id, todo.id, 'the accepted report remains accessible from its original todo');
  const coldPage = await reportPageOf(todoAgain.id);
  await coldPage.waitForFunction(({projectId, workId, objectId, todoId}) => {
    const scope = window.__workspaceScope, report = scope?.viewState?.report;
    const status = document.querySelector('#managed-doc [data-report-state]');
    return scope?.projectId === projectId && report?.workId === workId && report?.objectId === objectId && report?.todoId === todoId &&
      document.visibilityState === 'visible' && status?.getClientRects().length > 0 && Boolean(status.textContent.trim());
  }, {timeout: MERGE_BUDGET}, {projectId, workId, objectId: receipt.objectId, todoId: todo.id});
  await coldPage.waitForSelector('.managed-report-body .isolated-status[data-state="ready"]', {timeout: MERGE_BUDGET});
  const coldKey = await coldPage.$eval('.managed-report-body .isolated-viewport', node => node.dataset.previewKey);
  const coldPreview = await invoke(coldPage, 'isolated-preview.snapshot', {key: coldKey});
  assert.equal(coldPreview.projectId, projectId);
  assert.equal(coldPreview.profile, 'staticReport');
  assert.equal(coldPreview.files.find(file => file.path === coldPreview.entryPath)?.digest, receipt.report.digest, 'cold guest serves the original frozen bytes');
  const coldGuest = await waitFor(async () => (await browser.pages()).find(target => target.url() === `${coldPreview.origin}/${coldPreview.entryPath}`), 'cold isolated report guest', READY_BUDGET, {stopping});
  await coldGuest.waitForFunction(() => document.body?.innerText.includes('WINDOWS-INSTALLED-SYNTHETIC-RESULT'), {timeout: MERGE_BUDGET});
  const coldActions = await coldPage.evaluate(() => {
    const doc = document.querySelector('#managed-doc');
    const accepts = [...doc.querySelectorAll('[data-review-action="accept"], [data-managed-end-result]')];
    return {status: doc.querySelector('[data-report-state]')?.innerText, controls: accepts.map(node => ({disabled: node.disabled, visible: Boolean(node.getClientRects().length)}))};
  });
  assert(coldActions.controls.every(control => control.disabled === true), 'historical report must not offer a second accept');
  report.postReopenReport = {todoId: todoAgain.id, objectId: receipt.objectId, preview: coldPreview, guestMarker: true, ...coldActions};
  await coldPage.screenshot({path: path.join(output, '03-cold-reopen-report.png')});
  await coldGuest.screenshot({path: path.join(output, '03-cold-reopen-content.png')});
  report.checks.push('cold reopen renders the exact frozen accepted report in its isolated guest with no actionable accept');
  assert.deepEqual(report.errors, [], 'no renderer page errors across both launcher runs');
  const jobsBeforeClose = (await state()).jobs.map(job => job.id);
  assert.deepEqual(jobsBeforeClose, jobsAfterAccept, 'opening the accepted report adds no jobs');
  await close(second, 'cold reopen journey');
  assert.equal(report.modelRequestCount, requestsAfterAccept, 'no model requests after the clean second close');
  assert.deepEqual(modelErrors, [], 'no model scripting errors through the clean second close');
  report.afterReopen = {jobsBeforeClose, modelRequestCountAfterClose: report.modelRequestCount};
  report.checks.push('fully drained launcher close and cold reopen preserve the accepted Work, closure, merge receipt, project file and git HEAD with zero model replay after both readiness and the clean second close');
  report.ok = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
  if (shell) await failureProbe(() => shell.screenshot({path: path.join(output, 'failure.png')})).catch(() => {});
  if (browser && expectedReportTodoId) {
    const reports = [];
    for (const target of await failureProbe(() => browser.pages()).catch(() => [])) {
      const dom = await failureProbe(() => target.evaluate(({projectId, todoId}) => {
        const scope = window.__workspaceScope;
        if (scope?.kind !== 'report' || scope.projectId !== projectId || scope.viewState?.report?.todoId !== todoId) return null;
        const doc = document.querySelector('#managed-doc');
        const accept = doc?.querySelector('[data-review-action="accept"]');
        const preview = doc?.querySelector('.isolated-status');
        return {viewId:scope.viewId, projectId, todoId, workId:scope.viewState.report.workId, objectId:scope.viewState.report.objectId, ready:window.__nozeliReady, visibility:document.visibilityState,
          documentVisible:Boolean(doc?.getClientRects().length), documentText:doc?.innerText, reviewStatus:doc?.querySelector('[data-review-status]')?.innerText, reportState:doc?.querySelector('[data-report-state]')?.innerText,
          alerts:[...document.querySelectorAll('[role="alert"]')].filter(node => node.getClientRects().length).map(node => node.innerText),
          accept:accept?{disabled:accept.disabled,visible:Boolean(accept.getClientRects().length)}:null,
          preview:preview?{state:preview.dataset.state,text:preview.textContent}:null};
      }, {projectId, todoId:expectedReportTodoId})).catch(error => ({snapshotError:error.message}));
      if (!dom) continue;
      reports.push(dom);
      if (!dom.snapshotError) await failureProbe(() => target.screenshot({path:path.join(output, `failure-report-${reports.length}.png`)})).catch(error => { dom.screenshotError = error.message; });
    }
    report.failureReports = reports;
  }
  if (shell && projectId) await fs.writeFile(path.join(output, 'failure-state.json'), JSON.stringify(await failureProbe(() => invoke(shell, 'managed.status', {projectId})).catch(() => null), null, 2)).catch(() => {});
} finally {
  // The fixture is retained on failure; cleanup is protocol-level only and
  // records whatever is still observed rather than terminating by PID.
  await cleanup();
  for (const run of report.launches) if (run.exit === undefined) run.exit = {code: null, signal: null, note: 'launcher exit was not observed'};
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ok: report.ok, output, executionPolicy: report.executionPolicy ?? null, checks: report.checks.length, error: report.error ?? null}, null, 2));
}
