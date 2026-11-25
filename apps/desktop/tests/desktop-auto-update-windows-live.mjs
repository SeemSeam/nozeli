// Windows stable updater live GUI journeys (docs/release.md "Windows stable
// updater implementation contract", acceptance bullet). Real installed
// Nozeli.exe installations created per case on a dedicated C: root through the
// bundled installer, launched through the official Launch-Nozeli.ps1, driven
// over browser CDP on the real installed renderer. The release feed, tag API
// and checksums are a controlled loopback server (host-test-only seam:
// WINDOWS-UPDATE-TEST.json + NOZELI_TEST_UPDATE_INSTALLATION/FEED verified by
// the installed app). Version/commit metadata come from the actual
// source-bound candidate packages given on the CLI; the baseline package is
// never renamed. Startup-health failure is produced only by the
// identity-bound synthetic updateTest.failChildHealth on the real package;
// the intentionally invalid wrong-architecture fixture claims no valid source identity.
//
// Honesty of classification: gestures are VM/CDP keyboard/mouse input, not
// physical keyboard/IME/multi-display proof; the feed is synthetic loopback,
// not GitHub; timing of parent-exit/identity races uses Node-side process
// observation and is reported as such. No accounts, providers, model calls,
// signing, SmartScreen or power-loss claims. Not executed until the parent
// integration provides the preserved-env seams it owns; the driver fails
// loudly (and preserves a sanitized first-failure JSON) when a seam is absent.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
import {prepareReading} from './reading-setup.fixture.mjs';
import {zipDirectory, createFeedServer, processesUnder, appProcesses, terminateOriginalProcess, scanUpdateRecords, readJson, freePort, sleep, waitFor, compareVersions} from './fixtures/windows-update-live/windows-update-live-fixture.mjs';
import {openExperimentalProcessIdentity} from '../src/platform/windows/experimental-process-identity.mjs';

const SCENARIOS = ['success', 'startup-failure', 'interrupted', 'parent-exit', 'foreign-dirty', 'quarantine', 'refused'];
// A production package has ~22k members and each native copy flushes its
// file before publication. These are harness observation limits only.
const NATIVE_COPY_BUDGET = 900000;
// Initial fixture creation copies and revalidates the full release tree. The
// installed product's update, health, and recovery deadlines are unchanged.
const FIXTURE_INSTALL_BUDGET = 2700000;
// Promotion repeats the full validated native copy. Observe it separately
// from CDP; the helper's own startup health deadline remains authoritative.
const PROMOTION_OBSERVATION_BUDGET = FIXTURE_INSTALL_BUDGET;
const CDP_TIMEOUT = 1800000; // update.check replies after download/staging.
const usage = 'usage: desktop-auto-update-windows-live.mjs --output C:\\abs\\evidence --original C:\\abs\\candidate --target C:\\abs\\candidate [--original-zip C:\\abs\\release.zip] [--target-zip C:\\abs\\release.zip] [--foreign C:\\abs\\candidate] [--foreign-zip C:\\abs\\release.zip] [--scenarios ' + SCENARIOS.join(',') + ']';
function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--output', '--original', '--target', '--foreign', '--scenarios', '--original-zip', '--target-zip', '--foreign-zip'].includes(argv[index]) || !argv[index + 1] || options[argv[index]]) throw Error(usage);
    options[argv[index]] = argv[index + 1];
  }
  if (!options['--output'] || !options['--original'] || !options['--target']) throw Error(usage);
  const selected = (options['--scenarios'] ? options['--scenarios'].split(',') : SCENARIOS).map(value => value.trim());
  for (const name of selected) if (!SCENARIOS.includes(name)) throw Error('Unknown scenario ' + name + '; ' + usage);
  return {output: options['--output'], original: options['--original'], target: options['--target'], foreign: options['--foreign'] || null, scenarios: selected, originalZip: options['--original-zip'] || null, targetZip: options['--target-zip'] || null, foreignZip: options['--foreign-zip'] || null};
}
const args = parseArguments(process.argv.slice(2));
assert.equal(process.platform, 'win32', 'Requires native Windows');
assert.equal(process.arch, 'x64', 'Requires native Windows x64');
for (const value of [args.output, args.original, args.target, ...(args.foreign ? [args.foreign] : [])]) assert(path.isAbsolute(value), 'Absolute paths required: ' + value);
assert(/^c:\\/i.test(path.resolve(args.output)), 'Evidence/installation root must live on the C: volume (synthetic install roots/profiles on C:)');
const home = process.env.USERPROFILE || process.env.HOME;
// The installer itself rejects roots inside the OS account home ("dedicated
// non-daily installation root") and the daily profile tree; fail early with
// the same facts instead of a deep installer error.
if (home && path.resolve(args.output).toLowerCase().startsWith(path.resolve(home).toLowerCase() + path.sep)) throw Error('Evidence root is inside the OS account home; the installer requires a dedicated non-home installation root on C:');
if (home && path.resolve(args.output).toLowerCase().startsWith(path.resolve(home, '.Nozeli').toLowerCase() + path.sep)) throw Error('Output root overlaps the daily profile root; choose a dedicated C: directory');

const stopping = {value: false};
const launchers = new Set(), installations = new Set(), servers = new Set();
let browser = null;
async function cleanup() {
  stopping.value = true;
  try { await browser?.disconnect().catch(() => {}); browser = null; } catch {}
  // Do not act on an unproven incarnation during failed fixture teardown.
  report.retainedProcesses=[];
  report.installations=[];
  for (const install of installations) {
    const {root, feed, log, launches} = install;
    const evidence = {root, counters: feed ? {...feed.counters} : null, launcherLog: log.slice(-8000), launcherExits: launches.map(child => ({code: child.exitCode, signal: child.signalCode})), debugAttachment: install.debugAttachment ?? null};
    try { evidence.active = await install.activeReceipt(); } catch (error) { evidence.activeReadError = String(error.code ?? error.message); }
    report.installations.push(evidence);
    try {report.retainedProcesses.push(...await processesUnder(root));} catch(error) {report.retainedProcesses.push({root,error:String(error.message)});}
  }
  for (const child of launchers) { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
  for (const server of servers) await server.close().catch(() => {});
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143)); });

function installEnv() {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|ASKPASS/i.test(key) || ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
  env.Path = path.join(env.SystemRoot ?? env.SYSTEMROOT, 'System32');
  return env;
}
function runBundled(node, script, argv) {
  const timeout = ['install', 'upgrade'].includes(argv[0]) ? FIXTURE_INSTALL_BUDGET : NATIVE_COPY_BUDGET;
  const result = spawnSync(node, [script, ...argv], {env: installEnv(), encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024});
  assert.ifError(result.error);
  assert.equal(result.status, 0, script + ' ' + argv.join(' ') + '\n' + (result.stdout || '') + (result.stderr || ''));
  return JSON.parse(result.stdout);
}

// Real product tooling imported from the actual candidate payload (never from
// a renamed or rebuilt copy of the baseline package).
async function loadCandidate(directory) {
  const app = path.join(directory, 'resources/app');
  const tools = path.join(app, 'tools');
  const core = await import(pathToFileURL(path.join(tools, 'windows-install-core.mjs')).href);
  const pack = await import(pathToFileURL(path.join(tools, 'package-windows-candidate.mjs')).href);
  const checked = await pack.validateWindowsCandidate(directory);
  const manifest = checked.manifest; checked.tree.close();
  const release = await readJson(path.join(directory, 'RELEASE.json'));
  assert(manifest.platform === 'win32' && manifest.arch === 'x64', 'Candidate must be the Windows x64 package: ' + directory);
  assert(manifest.automaticUpdater === 'native-windows-health-v1', 'Candidate must carry the native Windows update protocol: ' + directory);
  assert(release && release.version === manifest.version && /^[0-9a-f]{40}$/.test(release.commit ?? ''), 'Candidate RELEASE.json must bind the exact version and source commit: ' + directory);
  assert(manifest.nativeProvenance?.commit === release.commit, 'Native provenance commit must match the release commit: ' + directory);
  if (manifest.commit !== undefined) assert(/^[0-9a-f]{40}$/.test(manifest.commit) && manifest.commit === release.commit, 'Candidate manifest top-level commit must be 40-hex and match RELEASE.json: ' + directory);
  return {directory, node: path.join(app, 'runtime/node/node.exe'), installer: path.join(tools, 'install-windows.mjs'), core, version: manifest.version, commit: release.commit, digest: checked.digest};
}

// A valid ZIP with an intentionally wrong candidate architecture. Admission
// must reach the architecture check without copying an entire valid release.
async function wrongArchitectureZip(target) {
  const directory = path.join(args.output, 'variants', 'wrong-arch');
  await fs.mkdir(path.join(directory, 'empty'), {recursive: true});
  await fs.writeFile(path.join(directory, 'WINDOWS-CANDIDATE.json'), JSON.stringify({
    schema: 1, application: 'Nozeli', platform: 'win32', arch: 'arm64', kind: 'windows-manual-candidate',
    automaticUpdater: 'native-windows-health-v1', version: target.version, entries: [{path: 'empty', type: 'directory'}],
  }), {flag: 'wx'});
  return zipDirectory(directory, {label: path.basename(target.directory)});
}

// Refuse hosts that cannot run the unchanged launcher before creating evidence
// or copying a payload. A permissive policy does not prove this script will run.
const powershell = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const policyQuery = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'], {env: installEnv(), encoding: 'utf8', timeout: 10000, windowsHide: true});
assert.ifError(policyQuery.error);
assert.equal(policyQuery.status, 0, 'Cannot read effective PowerShell execution policy: ' + (policyQuery.stderr ?? ''));
const executionPolicy = policyQuery.stdout.trim();
assert.match(executionPolicy, /^(RemoteSigned|Unrestricted|Bypass)$/, 'Effective PowerShell policy does not admit the unsigned original launcher; no fixture created');
const output = path.resolve(args.output);
await fs.mkdir(output); // EEXIST is an error even for an empty evidence root.

const checks = [];
const report = {ok: false, scenarios: [], inputScope: 'Real installed Nozeli.exe GUI journeys driven via browser CDP (VM/CDP keyboard and mouse, not physical keyboard/IME/multi-display); controlled loopback release feed/tag/checksum server (host-test-only synthetic seam); real source-bound candidate packages with real version/commit metadata, never renamed or relabeled; startup-health failure uses the identity-bound synthetic updateTest.failChildHealth on the real package; the wrong-architecture refusal uses an intentionally invalid adversarial fixture claiming no valid source; fault-injection termination binds the exact original process incarnation through the native HANDLE pin (allowTerminate) with journal creation-stamp verification and never acts on a PID after the open; no accounts, providers, model calls, signing, SmartScreen or power-loss durability claims', apiNeeds: [
  'install-windows.mjs launch must preserve NOZELI_TEST_UPDATE_INSTALLATION and NOZELI_TEST_UPDATE_FEED (the pair main.cjs verifies against WINDOWS-UPDATE-TEST.json) into the Nozeli.exe child env for synthetic installations',
  'the update helper must preserve NOZELI_DEBUG_PORT (and the NOZELI_TEST_UPDATE_* pair) into the successor app so the driver completes the real renderer acknowledgment over CDP',
  'attempt journal records in profile/updates must carry {token, phase} with phases prepared/helper-ready/promoting/awaiting-health/complete (+rolled-back/cancelled/error) and helperIdentity:{pid,start,creationTime100ns,stamp} so interruption journeys bind and terminate the exact original helper incarnation through the retained native HANDLE pin (allowTerminate build of nozeli_windows_process.node; parent rebuilds it)',
  'WINDOWS-UPDATE-TEST.json updateTest honored by the helper with bounded timing: failChildHealth + healthTimeout hold the successor at awaiting-health so interruption journeys can bind and terminate the exact helper (startup-health failure, quarantine, interrupted, foreign-dirty); pollMs widens the parent-exit identity loop. A bounded identity gate (hold before the helper identity snapshot) is still wanted for a fully deterministic parent-exit race; the driver classifies each run until then. No forged broken source builds',
]};
report.launcherExecutionPolicy = executionPolicy;

async function invoke(page, op, payload = {}) {
  const response = await page.evaluate(({op, payload}) => window.nozeli.invoke(op, payload), {op, payload});
  assert.equal(response.ok, true, op + ': ' + JSON.stringify(response));
  return response.value;
}

async function dispatchUpdateCheck(page) {
  // The IPC reply waits for native extraction, validation and promotion.
  // Dispatch once; observe that work outside the CDP call.
  await page.evaluate(() => { void window.nozeli.invoke('update.check', {}).catch(() => {}); });
}

async function checkUntilStaged(installation, page) {
  await dispatchUpdateCheck(page);
  await waitFor(async () => {
    const status = await readJson(path.join(installation.updates, 'status.json'));
    if (status?.phase === 'error' || status?.message === 'Update cancelled') throw Error('Update staging failed: ' + JSON.stringify(status));
    return status?.phase === 'ready' && status.availableVersion === installation.meta.version;
  }, 'native staging of ' + installation.meta.version, PROMOTION_OBSERVATION_BUDGET, {stopping});
  const status = await statusOf(page);
  assert.equal(status.phase, 'ready', JSON.stringify(status));
  assert.equal(status.availableVersion, installation.meta.version);
}
const statusOf = page => page.evaluate(() => window.nozeli.invoke('update.status', {})).then(result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; });
async function findShell(connection) {
  return waitFor(async () => {
    for (const target of await connection.pages()) if (await target.evaluate(() => location.href.startsWith('http://127.0.0.1:') && window.__nozeliReady === true && window.__workspaceScope?.role === 'shell').catch(() => false)) return target;
  }, 'installed shell renderer ready');
}
async function openSettings(page) {
  if (await page.$('#configuration-setup[open]')) await page.click('#configuration-cancel');
  await page.click('#open-settings');
  await page.waitForSelector('#settings-dialog[open]');
  await page.click('[data-settings-section="settings-update"]');
}

async function openSyntheticDocument(shell, project) {
  await shell.click('#pick-project');
  const picked = await waitFor(async () => {
    const recent = await invoke(shell, 'project.recent');
    return recent.projects.find(entry => entry.rootDisplay === project);
  }, 'synthetic project imported in installed shell', 30000, {stopping});
  await shell.waitForFunction(id => document.querySelector('#recent button[aria-current="true"]')?.dataset.projectId === id, {}, picked.id);
  await shell.click('#file-tree button[data-path="edit.txt"]');
  const editor = await waitFor(async () => {
    for (const surface of await browser.pages()) if (await surface.evaluate(() => window.__nozeliReady && window.__workspaceScope?.kind === 'document' && window.__workspaceScope?.relPath === 'edit.txt').catch(() => false)) return surface;
  }, 'edit.txt document surface', 30000, {stopping});
  await editor.waitForSelector('#text-host .cm-content', {visible: true});
  return editor;
}

async function installViaUi(page) {
  await page.evaluate(() => window.nozeli.invoke('update.preferences', {enabled: false}));
  await page.waitForFunction(() => [...document.querySelectorAll('#settings-update button')].some(node => node.textContent === '安装并重启' && !node.disabled));
  const handle = await page.evaluateHandle(() => [...document.querySelectorAll('#settings-update button')].find(node => node.textContent === '安装并重启'));
  await handle.asElement().click();
}

class Installation {
  constructor(name, archive, meta) {
    this.name = name;
    this.root = path.join(output, name, 'installation');
    this.profile = path.join(this.root, 'profile');
    this.updates = path.join(this.profile, 'desktop', 'updates');
    this.archive = archive;
    this.meta = meta;
    this.log = '';
    this.launches = [];
  }
  async create(original, updateTest = null) {
    installations.add(this);
    await fs.mkdir(path.dirname(this.root),{recursive:true});
    const created = runBundled(original.node, original.installer, ['install', '--root', this.root, '--candidate', original.directory]);
    this.installationId = created.root && (await readJson(path.join(this.root, 'WINDOWS-INSTALL.json'))).installationId;
    assert(/^[a-f0-9-]{36}$/.test(this.installationId ?? ''), 'Installation owner record missing installationId');
    this.feed = await createFeedServer({archive: this.archive, version: this.meta.version, commit: this.meta.commit});
    servers.add(this.feed);
    await original.core.writeRecord(this.root, 'WINDOWS-UPDATE-TEST.json', {schema: 1, installationId: this.installationId, synthetic: true, feed: this.feed.url, ...(updateTest ? {updateTest} : {})});
    // Explicit-check trials must not race the startup check. Quarantine alone
    // exercises the default automatic startup behavior across cold restarts.
    if (this.name !== 'quarantine') {
      const {ensureExperimentalPrivateDirectory} = await import('../src/platform/windows/experimental-directories.mjs');
      await ensureExperimentalPrivateDirectory(this.root, this.updates);
      await original.core.writeRecord(this.root, 'profile/desktop/updates/preferences.json', {enabled: false});
    }
    this.sentinel = path.join(this.profile, 'update-preservation-sentinel.txt');
    await fs.mkdir(this.profile, {recursive: true});
    await fs.writeFile(this.sentinel, 'User data survives update and rollback.\n');
    return this;
  }
  active() { return readJson(path.join(this.root, 'ACTIVE.json')); }
  async activeReceipt() {
    const bytes = await fs.readFile(path.join(this.root, 'ACTIVE.json'));
    return {value: JSON.parse(bytes), digest: createHash('sha256').update(bytes).digest('hex')};
  }
  async versionOf(id) { return (await readJson(path.join(this.root, 'versions', id, 'WINDOWS-CANDIDATE.json')))?.version ?? null; }
  async waitForCleanExit(run, {updating = false, timeout = 120000} = {}) {
    await waitFor(async () => {
      if (run.child.exitCode !== null || run.child.signalCode !== null) return true;
      if (updating) {
        const status = await readJson(path.join(this.updates, 'status.json'));
        if (status?.phase === 'error') throw Error('Original app update failed: ' + status.message);
      }
      return false;
    }, updating ? 'original app clean update exit' : 'launcher clean exit', timeout, {stopping});
    assert.equal(run.child.exitCode, 0, 'Launcher exited: ' + JSON.stringify({code: run.child.exitCode, signal: run.child.signalCode, log: this.log.slice(-4000)}));
    await run.exited;
  }
  cli(original, command, extra = []) { return runBundled(original.node, original.installer, [command, '--root', this.root, ...extra]); }
  async waitPhase(phases, timeout, deadline) {
    return waitFor(async () => {
      for (const record of await scanUpdateRecords(this.updates)) if (typeof record.value.token === 'string' && phases.includes(record.value.phase)) return record;
    }, 'attempt phase in ' + phases.join('/'), timeout, {deadline, stopping});
  }
  async records() { return scanUpdateRecords(this.updates); }
  async waitForHealthyPromotion() {
    return waitFor(async () => {
      const handoff = await readJson(path.join(this.updates, 'handoff.json'));
      if (!handoff) return false;
      if (['error', 'cancelled', 'rolled-back', 'recovery-blocked'].includes(handoff.phase)) {
        const {phase, code, message, stage, prePromotionOperation, win32Code, recoveryRequired} = handoff;
        throw Object.assign(Error(`Healthy promotion ended in ${phase}: ${code ?? message ?? 'no detail'}`), {
          promotionFailure: {phase, code, message, stage, prePromotionOperation, win32Code, recoveryRequired},
        });
      }
      return handoff.phase === 'complete' ? handoff : false;
    }, 'native promotion and token-bound renderer health before CDP attachment', PROMOTION_OBSERVATION_BUDGET, {stopping});
  }
  async connectOwnedDebug(app, previousEndpoint) {
    const expectedImage = path.resolve(app.executable);
    const relativeImage = path.relative(path.join(this.root, 'versions'), expectedImage);
    assert(relativeImage && !relativeImage.startsWith('..') && !path.isAbsolute(relativeImage), 'Debug image must be inside the installation versions directory');
    this.debugAttachment = {pid: app.pid, stamp: app.stamp, stage: 'identity-check'};
    const previousPort = previousEndpoint ? new URL(previousEndpoint).port : null;
    let pin;
    try {
      pin = openExperimentalProcessIdentity(app.pid);
      const identity = pin.snapshot();
      if (identity.state !== 'running' || identity.stamp !== app.stamp || path.resolve(identity.imagePath).toLowerCase() !== expectedImage.toLowerCase()) return null;
      const listeners = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-NetTCPConnection -OwningProcess ${identity.pid} -State Listen -ErrorAction SilentlyContinue | Where-Object LocalAddress -eq "127.0.0.1" | ForEach-Object LocalPort`], {encoding: 'utf8', timeout: 5000, windowsHide: true});
      this.debugAttachment.stage = listeners.status === 0 ? 'listener-discovery' : 'listener-query-failed';
      for (const port of listeners.stdout?.trim().split(/\s+/) ?? []) {
        if (port === previousPort || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) continue;
        if (pin.snapshot().state !== 'running') return null;
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`, {signal: AbortSignal.timeout(750), redirect: 'error'});
          if (!response.ok) continue;
          const {webSocketDebuggerUrl: endpoint} = await response.json();
          const endpointPort = /^ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[\w-]+$/.exec(endpoint ?? '')?.[1];
          if (endpointPort !== port || endpoint === previousEndpoint || pin.snapshot().state !== 'running') continue;
          this.debugAttachment.stage = 'websocket-connect';
          const connection = await puppeteer.connect({browserWSEndpoint: endpoint, defaultViewport: null, handshakeTimeout: 5000, protocolTimeout: previousEndpoint ? 10000 : CDP_TIMEOUT});
          this.debugAttachment.stage = 'connected';
          return connection;
        } catch { /* non-CDP listener or endpoint not ready */ }
      }
      return null;
    } finally { pin?.close(); }
  }
  async launch(extraEnv = {}, {dynamicDebug = false} = {}) {
    const port = dynamicDebug ? 0 : await freePort();
    const env = {...installEnv(), NOZELI_TEST_UPDATE_INSTALLATION: this.installationId, NOZELI_TEST_UPDATE_FEED: this.feed.url, NOZELI_DEBUG_PORT: String(port), NOZELI_HIDDEN: '0', NOZELI_SHOT_DIR: path.join(output, this.name), ...extraEnv};
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(this.root, 'Launch-Nozeli.ps1')], {cwd: this.root, env, stdio: ['ignore', 'pipe', 'pipe']});
    this.launches.push(child); launchers.add(child);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { this.log += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
    const initialActive = dynamicDebug ? await this.active() : null;
    const initialImage = initialActive ? path.join(this.root, 'versions', initialActive.active, 'Nozeli.exe').toLowerCase() : null;
    const app = await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) throw Error('Launcher exited before Electron: ' + JSON.stringify({code: child.exitCode, signal: child.signalCode, log: this.log.slice(-8000)}));
      const apps = await appProcesses(this.root);
      if (!dynamicDebug) return apps[0] ?? null;
      // Chromium subprocesses share the image. The earliest exact-image
      // incarnation is their browser parent, not the first arbitrary CIM row.
      return apps.filter(row => path.resolve(row.executable).toLowerCase() === initialImage)
        .sort((a, b) => a.creationDate.localeCompare(b.creationDate))[0] ?? null;
    }, 'installed Nozeli.exe after official launcher validation', NATIVE_COPY_BUDGET, {stopping});
    if (dynamicDebug) {
      const pin = openExperimentalProcessIdentity(app.pid);
      try {
        const {stamp, creationTime100ns} = pin.snapshot();
        assert.equal(Number(BigInt(creationTime100ns) / 10000n) - 11644473600000, app.startedAt, 'launcher app incarnation');
        app.stamp = stamp;
        browser = await waitFor(() => this.connectOwnedDebug({...app, stamp}), 'installation-owned initial CDP connection', 120000, {stopping});
      } finally { pin.close(); }
    } else {
      browser = await waitFor(() => puppeteer.connect({browserURL: 'http://127.0.0.1:' + port, defaultViewport: null, protocolTimeout: CDP_TIMEOUT}).catch(() => null), 'installed app CDP connection', 120000, {stopping});
    }
    const page = await findShell(browser);
    await prepareReading(page);
    this.feed.release();
    return {child, app, exited, page, port, endpoint: browser.wsEndpoint()};
  }
  async connectRollback(expectedVersion, run, rollback) {
    const restored = await this.active();
    assert.equal(restored.active, rollback.activeBefore.value.active, 'rollback restored the original image');
    assert.equal(restored.generation, rollback.activeAfter.value.generation + 1, 'rollback published the next generation');
    const image = path.join(this.root, 'versions', restored.active, 'Nozeli.exe');
    const failedChildTime = BigInt(rollback.childIdentity.creationTime100ns);
    const failedChildMs = Number(failedChildTime / 10000n) - 11644473600000;
    // After rollback, the detached bundled installer validates the restored
    // payload under its lock before spawning Electron. This is not CDP wait.
    const app = await waitFor(async () => (await appProcesses(this.root))
      .filter(row => path.resolve(row.executable).toLowerCase() === image.toLowerCase() && row.startedAt >= failedChildMs && row.startedAt > run.app.startedAt)
      .sort((a, b) => a.creationDate.localeCompare(b.creationDate))[0], 'restored installation browser after bundled installer validation', NATIVE_COPY_BUDGET, {stopping});
    const pin = openExperimentalProcessIdentity(app.pid);
    try {
      const {stamp, creationTime100ns} = pin.snapshot();
      assert.equal(Number(BigInt(creationTime100ns) / 10000n) - 11644473600000, app.startedAt, 'rollback app incarnation');
      assert(BigInt(creationTime100ns) > failedChildTime, 'restored browser must postdate the failed activation browser');
      return await this.connectVersion(expectedVersion, run.endpoint, {...app, stamp});
    } finally { pin.close(); }
  }
  async connectVersion(expectedVersion, previousEndpoint, exactApp) {
    let connection = null;
    await waitFor(async () => {
      connection = await this.connectOwnedDebug(exactApp, previousEndpoint);
      if (!connection) return false;
      if (previousEndpoint && connection.wsEndpoint() === previousEndpoint) {
        await connection.disconnect().catch(() => {});
        return false;
      }
      this.debugAttachment.stage = 'ready-shell';
      for (const target of await connection.pages()) {
        if (await target.evaluate(() => window.__nozeliReady === true && window.__workspaceScope?.role === 'shell').catch(() => false)) {
          this.debugAttachment.stage = 'version-check';
          const status = await target.evaluate(() => window.nozeli.invoke('update.status', {})).catch(() => null);
          if (status?.ok) this.debugAttachment.reportedVersion = status.value.currentVersion;
          if (status?.ok && status.value.currentVersion === expectedVersion) { this.successor = {browser: connection, page: target}; return true; }
        }
      }
      await connection.disconnect().catch(() => {});
      return false;
    }, 'successor renderer reporting version ' + expectedVersion, 120000, {stopping});
    browser = connection;
    return this.successor;
  }
  async requestClose(page) {
    if (await page.$('#settings-dialog[open]').catch(() => null)) {
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('#settings-dialog')?.open !== true, {timeout: 5000}).catch(() => {});
    }
    await invoke(page, 'session.requestClose');
    await waitFor(async () => !(await appProcesses(this.root)).length, 'installed app exit after requestClose', 60000, {stopping});
  }
}

let failure = null;
try {
  const original = await loadCandidate(args.original);
  const target = await loadCandidate(args.target);
  const identity = ({directory, version, commit, digest}) => ({directory, version, commit, candidateDigest: digest});
  report.candidates = {original: identity(original), target: identity(target)};
  assert(compareVersions(target.version, original.version) > 0, 'Target candidate must be a newer version than the original');
  const foreign = args.foreign ? await loadCandidate(args.foreign) : {directory: original.directory, version: original.version, node: original.node, installer: original.installer, core: original.core};

  // The attempt journal's helper identity field name belongs to the backend
  // record contract; accept the documented spellings and fail with the
  // contract need rather than guessing. Startup-health failure is produced by
  // the identity-bound synthetic updateTest.failChildHealth on the REAL
  // source-bound target package — never by editing packaged sources and
  // regenerating a manifest under the same commit (that would misrepresent
  // source identity). The intentionally invalid wrong-architecture fixture
  // claims no valid source.
  function helperIdentity(record) {
    const identity = record?.value?.helperIdentity ?? record?.value?.helper ?? null;
    const pid = Number.isInteger(identity?.pid ?? record?.value?.helperPid) ? (identity?.pid ?? record.value.helperPid) : null;
    const stamp = /^win32:(\d+):(\d+)$/.exec(identity?.stamp ?? '');
    const start100ns = stamp && Number(stamp[1]) === pid && stamp[2] === identity.creationTime100ns ? stamp[2] : null;
    return {pid, start100ns};
  }
  // The healthy-path archive is the parent's official source-bound release
  // ZIP when supplied; otherwise a deterministic ZIP of the exact target
  // candidate directory (same layout). Startup-health failure comes from the
  // record-bound updateTest.failChildHealth on this same real package. The
  // separate wrong-architecture fixture claims no valid source identity.
  const successZip = args.targetZip ? await fs.readFile(args.targetZip) : await zipDirectory(target.directory);
  if (args.originalZip) report.originalReleaseZip = {path: args.originalZip, sha256: createHash('sha256').update(await fs.readFile(args.originalZip)).digest('hex')};
  if (args.targetZip) report.targetReleaseZip = {path: args.targetZip, sha256: createHash('sha256').update(successZip).digest('hex')};
  const wrongArchZip = args.scenarios.includes('refused') ? await wrongArchitectureZip(target) : null;


  if (args.scenarios.includes('success')) {
    const scenario = {name: 'success', checks: [], counters: null, keyboardSave: null};
    const installation = await new Installation('success', successZip, target).create(original);
    const before = await installation.activeReceipt();
    assert.equal(before.value.generation, 1);
    assert.equal(before.value.versions[before.value.active], original.digest);
    // Import the synthetic folder through the installed shell and save in the real editor.
    const project = path.join(output, 'success', 'project'), saveTarget = path.join(project, 'edit.txt');
    await fs.mkdir(project, {recursive: true});
    await fs.writeFile(saveTarget, 'Original editable text.\n');
    const run = await installation.launch({NOZELI_TEST_PICK: project}, {dynamicDebug: true});
    const status = await statusOf(run.page);
    assert.equal(status.supported, true, 'Installed app must recognize the owned installation; if this reports check-only/source, the installed loopback seam env was not preserved through Launch-Nozeli.ps1');
    await openSettings(run.page);
    await invoke(run.page, 'update.preferences', {enabled: false});
    const checked = await invoke(run.page, 'update.check');
    assert.equal(checked.phase, 'ready', JSON.stringify(checked));
    assert.equal(installation.feed.counters.archive, 1);
    await run.page.click('#settings-close');
    {
      const editor = await openSyntheticDocument(run.page, project);
      await editor.click('#text-host .cm-content');
      await editor.waitForFunction(() => document.hasFocus() && document.activeElement?.closest('#text-host .cm-editor'));
      await editor.keyboard.down('Control'); await editor.keyboard.press('End'); await editor.keyboard.up('Control');
      await editor.keyboard.type('Saved before update.');
      await editor.keyboard.down('Control'); await editor.keyboard.press('s'); await editor.keyboard.up('Control');
      const saved = 'Original editable text.\nSaved before update.';
      await waitFor(async () => { try { return (await fs.readFile(saveTarget, 'utf8')) === saved; } catch { return false; } }, 'explicit Ctrl+S keyboard save reaches the source file', 30000, {stopping});
      scenario.keyboardSave = 'real editor keyboard Ctrl+S save verified on disk before the version switch';
    }
    await openSettings(run.page);
    await installViaUi(run.page);
    await installation.waitForCleanExit(run, {updating: true});
    await browser.disconnect().catch(() => {}); browser = null;
    const completedHandoff = await installation.waitForHealthyPromotion();
    scenario.promotion = {token: completedHandoff.token, phase: completedHandoff.phase, installedAt: completedHandoff.installedAt};
    const successor = await installation.connectVersion(target.version, run.endpoint, {
      ...completedHandoff.childIdentity, executable: path.join(completedHandoff.active, 'Nozeli.exe'),
    });
    const finalStatus = await statusOf(successor.page);
    assert.equal(finalStatus.currentVersion, target.version);
    const after = await installation.activeReceipt();
    const active = after.value;
    assert.equal(active.generation, before.value.generation + 1);
    assert.equal(active.previous, before.value.active);
    assert.equal(active.versions[active.active], target.digest);
    assert.equal(await installation.versionOf(active.active), target.version, 'ACTIVE.json must select the promoted target generation');
    assert.equal(await installation.versionOf(active.previous), original.version, 'previous generation retained');
    const {value: completed} = await installation.waitPhase(['complete'], 60000);
    assert.equal(completed.token, completedHandoff.token);
    assert.deepEqual(completed.activeBefore, before);
    assert.deepEqual(completed.activeAfter, after);
    assert.equal(completed.candidateDigest, target.digest);
    assert.match(completed.token, /^[a-f0-9]{64}$/);
    const ack = await readJson(path.join(installation.updates, `health-${completed.token}.json`));
    const health = {token: completed.token, version: target.version, commit: target.commit, payloadDigest: target.digest,
      release: path.join(installation.root, 'versions', active.active), pid: completed.childIdentity.pid, stamp: completed.childIdentity.stamp};
    assert(ack, 'independent helper completion must retain a renderer health receipt');
    assert.deepEqual(Object.fromEntries(Object.keys(health).map(key => [key, ack[key]])), health);
    scenario.activation = {before, after, health};
    scenario.launcherExit = run.child.exitCode;
    assert.equal(await fs.readFile(installation.sentinel, 'utf8'), 'User data survives update and rollback.\n');
    assert.equal(await fs.readFile(saveTarget,'utf8'),'Original editable text.\nSaved before update.');
    scenario.checks.push('real installed renderer ordered the update through the settings UI; original app exited cleanly; independent helper promoted the exact target generation on the installation volume; the real successor renderer acknowledged health with the original token identity and reports ' + target.version + '; profile sentinel survives');
    scenario.counters = {...installation.feed.counters};
    const child = openExperimentalProcessIdentity(health.pid);
    let helper;
    try {
      const pinned = child.snapshot();
      assert.equal(pinned.stamp, health.stamp);
      assert.equal(pinned.state, 'running');
      helper = openExperimentalProcessIdentity(completed.helperIdentity.pid);
      const helperPinned = helper.snapshot();
      assert.equal(helperPinned.stamp, completed.helperIdentity.stamp);
      assert.equal(helperPinned.state, 'running');
      const lockPath = path.join(installation.root, '.install-lock');
      assert((await fs.lstat(lockPath)).isDirectory(), 'Helper must retain the install lock while the successor runs');
      await installation.requestClose(successor.page);
      const closed = await waitFor(() => {
        const state = child.snapshot();
        return state.state === 'exited' ? state : null;
      }, 'exact healthy successor exit', 60000, {stopping});
      assert.equal(closed.exitCode, 0);
      const helperClosed = await waitFor(() => {
        const state = helper.snapshot();
        return state.state === 'exited' ? state : null;
      }, 'exact update helper exit after successor shutdown', 60000, {stopping});
      assert.equal(helperClosed.exitCode, 0);
      await waitFor(async () => {
        try { await fs.lstat(lockPath); return false; }
        catch (error) { if (error.code === 'ENOENT') return true; throw error; }
      }, 'helper released the install lock after successor exit', 60000, {stopping});
      scenario.successorExit = {pid: health.pid, stamp: closed.stamp, code: closed.exitCode, lockReleased: true};
      scenario.helperExit = {pid: helperClosed.pid, stamp: helperClosed.stamp, code: helperClosed.exitCode};
    } finally { try { helper?.close(); } finally { child.close(); } }
    report.scenarios.push(scenario);
  }

  if (args.scenarios.includes('startup-failure')) {
    const scenario = {name: 'startup-failure', checks: []};
    const installation = await new Installation('startup-failure', successZip, target).create(original, {failChildHealth: true});
    const before = await installation.activeReceipt();
    const document = path.join(output, 'startup-failure', 'document.txt');
    const saved = Buffer.from('Saved synthetic document before failed update.\n');
    await fs.writeFile(document, saved, {flag: 'wx'});
    const run = await installation.launch({}, {dynamicDebug: true});
    await openSettings(run.page);
    await invoke(run.page, 'update.preferences', {enabled: false});
    await invoke(run.page, 'update.check');
    await waitFor(async () => (await statusOf(run.page)).phase === 'ready', 'real target package staged', 300000, {stopping});
    await installViaUi(run.page);
    await installation.waitForCleanExit(run, {updating: true});
    await browser.disconnect().catch(() => {}); browser = null;
    const {value: rollback} = await installation.waitPhase(['rolled-back'], PROMOTION_OBSERVATION_BUDGET);
    const successor = await installation.connectRollback(original.version, run, rollback);
    const status = await statusOf(successor.page);
    assert.equal(status.currentVersion, original.version, 'startup-health failure must restore the original active binary');
    assert.equal(status.failedVersion, target.version, 'failed version must be quarantined in updater state');
    const after = await installation.activeReceipt();
    assert.match(rollback.message, /failed startup health check/i);
    assert.deepEqual(rollback.activeBefore, before);
    assert.equal(rollback.activeAfter.value.generation, before.value.generation + 1);
    assert.equal(rollback.activeAfter.value.versions[rollback.versionId], target.digest);
    assert.match(rollback.childIdentity.stamp, /^win32:\d+:\d+$/);
    assert.deepEqual(after.value, {...before.value, generation: before.value.generation + 2, previous: rollback.versionId,
      versions: {...before.value.versions, [rollback.versionId]: target.digest}});
    assert.equal(await installation.versionOf(after.value.active), original.version);
    assert.equal(await fs.readFile(installation.sentinel, 'utf8'), 'User data survives update and rollback.\n');
    assert.deepEqual(await fs.readFile(document), saved);
    scenario.activation = {before, promoted: rollback.activeAfter, after, failedChild: rollback.childIdentity};
    scenario.checks.push('The real target launched but failed startup health. Rollback restored the exact original binary selection at generation +2 and preserved the profile sentinel and document bytes.');
    await installation.requestClose(successor.page);
    report.scenarios.push(scenario);
  }

  if (args.scenarios.includes('interrupted')) {
    const scenario = {name: 'interrupted', checks: []};
    const installation = await new Installation('interrupted', successZip, target).create(original, {failChildHealth: true, healthTimeout: 180000});
    const run = await installation.launch({}, {dynamicDebug: true});
    await openSettings(run.page);
    await invoke(run.page, 'update.preferences', {enabled: false});
    await checkUntilStaged(installation, run.page);
    await installViaUi(run.page);
    await installation.waitForCleanExit(run, {updating: true});
    await browser.disconnect().catch(() => {}); browser = null;
    const pending = await installation.waitPhase(['awaiting-health'], PROMOTION_OBSERVATION_BUDGET);
    const identity = helperIdentity(pending);
    assert(identity.pid !== null, 'awaiting-health record must expose the helper process identity for interruption (parent API contract)');
    assert(identity.start100ns !== null, 'awaiting-health helperIdentity must carry the creation stamp (start/creationTime100ns) so the original helper incarnation is bound exactly, never best-effort');
    // Identity-bound interruption: resolve the helper by executable path under
    // the installation root, then terminate through the retained native HANDLE
    // pin after its creation stamp matches the journal. The helper's native
    // kill-on-close Job ends the whole successor tree with it.
    const helperRow = (await processesUnder(installation.root)).find(row => row.pid === identity.pid);
    assert(helperRow, 'helper pid ' + identity.pid + ' not present under its installation root');
    scenario.helperKill = await terminateOriginalProcess({root: installation.root, row: helperRow, expectedStart100ns: identity.start100ns});
    await waitFor(async () => (await appProcesses(installation.root)).length === 0 ? true : null, 'successor processes no longer enumerated after helper interruption', 60000, {stopping});
    // Only the interrupted helper injected failChildHealth into its child.
    // The official launcher starts the recovery renderer without that flag.
    assert.deepEqual(await installation.activeReceipt(), pending.value.activeAfter);
    const archiveBefore = installation.feed.counters.archive;
    const restart = await installation.launch({}, {dynamicDebug: true});
    const status = await statusOf(restart.page);
    assert.equal(status.currentVersion, target.version, 'restart reconciles the interrupted awaiting-health attempt by completing the real health acknowledgment');
    const {value: completed} = await installation.waitPhase(['complete'], 60000);
    assert.equal(completed.token, pending.value.token);
    assert.equal(completed.recoveryAuthorized, true, 'official launcher must record recovery authorization');
    assert.deepEqual(await installation.activeReceipt(), pending.value.activeAfter, 'restart must not replay activation');
    const health = {token: completed.token, version: target.version, commit: target.commit, payloadDigest: target.digest,
      release: path.join(installation.root, 'versions', completed.versionId), pid: restart.app.pid, stamp: restart.app.stamp, reconciled: true};
    const receipt = await readJson(path.join(installation.updates, `health-${completed.token}.json`));
    assert(receipt, 'Restart renderer must publish a health receipt for the original attempt');
    assert.deepEqual(Object.fromEntries(Object.keys(health).map(key => [key, receipt[key]])), health);
    scenario.activation = {before: pending.value.activeBefore, after: pending.value.activeAfter, health, recoveryAuthorized: true};
    assert.equal(installation.feed.counters.archive, archiveBefore, 'reconciliation must not re-download the archive');
    assert.equal(await fs.readFile(installation.sentinel, 'utf8'), 'User data survives update and rollback.\n');
    scenario.checks.push('After exact HANDLE-bound helper termination, the official launcher authorized recovery; the original attempt reached complete with no activation replay or re-fetch, and the profile survived.');
    await installation.requestClose(restart.page);
    await installation.waitForCleanExit(restart);
    await assert.rejects(fs.lstat(path.join(installation.root, '.install-lock')), {code: 'ENOENT'});
    scenario.shutdown = {launcherExit: restart.child.exitCode, lockReleased: true};
    scenario.counters = {...installation.feed.counters};
    report.scenarios.push(scenario);
  }

  if (args.scenarios.includes('parent-exit')) {
    const scenario = {name: 'parent-exit', checks: [], parentExitKillLanded: null};
    const installation = await new Installation('parent-exit', successZip, target).create(original, {parentDelayMs:5000});
    const initial = await installation.activeReceipt();
    assert.equal(initial.value.generation, 1);
    assert.equal(initial.value.versions[initial.value.active], original.digest);
    const run = await installation.launch({}, {dynamicDebug: true});
    await openSettings(run.page);
    await invoke(run.page, 'update.preferences', {enabled: false});
    await checkUntilStaged(installation, run.page);
    // Fire-and-forget install dispatch: the update.install IPC stays pending
    // across main's quit; awaiting it would blind the driver to the identity
    // window, so only the click event is delivered here.
    await run.page.evaluate(() => { const button = [...document.querySelectorAll('#settings-update button')].find(node => node.textContent === '安装并重启'); if (button) button.click(); });
    const ready=await waitFor(async()=>(await installation.records()).find(row=>row.value.phase==='prepared'&&row.value.testParentPinned===true),'helper retained parent before identity snapshot',300000,{stopping});
    // Kill only the parent Nozeli.exe (no tree): the detached helper with the
    // original parent HANDLE must observe the kernel exit and still activate.
    const rows = await appProcesses(installation.root);
    scenario.parentExitKillLanded = false;
    const parentRow = rows.find(row => row.pid === run.app.pid && row.startedAt === run.app.startedAt);
    assert(parentRow&&run.child.exitCode===null,'parent exited before the fixture could inject the race');
    assert.match(ready.value.parent?.creationTime100ns ?? '', /^\d+$/, 'prepared journal must bind the exact parent incarnation');
    assert.equal(ready.value.parent.stamp, `win32:${parentRow.pid}:${ready.value.parent.creationTime100ns}`);
    scenario.parentExitKill=await terminateOriginalProcess({root:installation.root,row:parentRow,expectedStart100ns:ready.value.parent.creationTime100ns});
    scenario.parentExitKillLanded=true;
    scenario.parentPin = {phase: ready.value.phase, testParentPinned: ready.value.testParentPinned, token: ready.value.token, stamp: ready.value.parent.stamp};
    await waitFor(() => run.child.exitCode !== null ? {} : null, 'launcher return after parent death', 180000, {stopping});
    await browser.disconnect().catch(() => {}); browser = null;
    const completedHandoff = await installation.waitForHealthyPromotion().catch(error => {
      report.parentExitFailure = {...scenario, promotion: error.promotionFailure};
      throw error;
    });
    const successor = await installation.connectVersion(target.version, run.endpoint, {
      ...completedHandoff.childIdentity, executable: path.join(completedHandoff.active, 'Nozeli.exe'),
    });
    const status = await statusOf(successor.page);
    assert.equal(status.currentVersion, target.version, 'kernel-observed parent exit during identity inspection must still permit activation');
    assert.equal(completedHandoff.token, ready.value.token);
    assert.deepEqual(completedHandoff.activeBefore, initial);
    const after = await installation.activeReceipt();
    assert.deepEqual(after, completedHandoff.activeAfter);
    assert.equal(after.value.generation, completedHandoff.activeBefore.value.generation + 1);
    assert.equal(after.value.versions[after.value.active], target.digest);
    const health = await readJson(path.join(installation.updates, `health-${completedHandoff.token}.json`));
    assert.equal(health?.stamp, completedHandoff.childIdentity.stamp);
    assert.equal(health.token, completedHandoff.token);
    assert.equal(health.version, target.version);
    assert.equal(health.commit, target.commit);
    assert.equal(health.payloadDigest, target.digest);
    scenario.activation = {before: completedHandoff.activeBefore, after, health};
    assert.equal(await fs.readFile(installation.sentinel, 'utf8'), 'User data survives update and rollback.\n');
    scenario.checks.push('The parent was stopped through its exact HANDLE after the helper pinned it; the successor reached the expected version.');
    await installation.requestClose(successor.page);
    await waitFor(async () => {
      if ((await processesUnder(installation.root)).length) return false;
      try { await fs.lstat(path.join(installation.root, '.install-lock')); return false; }
      catch (error) { if (error.code === 'ENOENT') return true; throw error; }
    }, 'parent-exit successor and helper closure with no install lock', 60000, {stopping});
    scenario.shutdown = {launcherExit: run.child.exitCode, lockReleased: true};
    assert.equal(installation.feed.counters.archive, 1);
    scenario.counters = {...installation.feed.counters};
    report.scenarios.push(scenario);
  }

  if (args.scenarios.includes('foreign-dirty')) {
    const scenario = {name: 'foreign-dirty', checks: []};
    const installation = await new Installation('foreign-dirty', successZip, target).create(original, {failChildHealth: true, healthTimeout: 180000});
    const initial = await installation.activeReceipt();
    const project = path.join(output, 'foreign-dirty', 'project');
    await fs.mkdir(project, {recursive: true});
    const source = 'Original text for an unsaved update note.\n';
    const file = path.join(project, 'edit.txt');
    await fs.writeFile(file, source);
    const run = await installation.launch({NOZELI_TEST_PICK: project}, {dynamicDebug: true});
    await openSettings(run.page);
    await invoke(run.page, 'update.preferences', {enabled: false});
    await checkUntilStaged(installation, run.page);
    await run.page.click('#settings-close');
    const editor = await openSyntheticDocument(run.page, project);
    await editor.click('#text-host .cm-content');
    await editor.keyboard.down('Control'); await editor.keyboard.press('Home'); await editor.keyboard.up('Control');
    await editor.keyboard.down('Shift');
    for (let i = 0; i < 12; i++) await editor.keyboard.press('ArrowRight');
    await editor.keyboard.up('Shift');
    await editor.waitForSelector('#selection-note', {visible: true});
    await editor.click('#selection-note');
    const draft = 'Unsaved update note draft';
    await editor.type('#note-input', draft);
    assert.equal(await editor.evaluate(async () => (await window.__nozeliUpdateState()).dirty), true, 'unsubmitted note must mark the document surface dirty');
    await openSettings(run.page);
    await installViaUi(run.page);
    const refused = await waitFor(async () => { const value = await statusOf(run.page); return value.phase === 'waiting-idle' ? value : null; }, 'dirty refusal (waiting-idle)', 60000, {stopping});
    assert.match(refused.message ?? '', /未保存|保存/, 'refusal must name unsaved work: ' + refused.message);
    assert.equal((await installation.records()).filter(record => typeof record.value.token === 'string').length, 0, 'no attempt record may be created while dirty');
    assert.equal(await editor.$eval('#note-input', node => node.value), draft);
    assert.equal(await fs.readFile(file, 'utf8'), source);
    assert.deepEqual(await installation.activeReceipt(), initial);
    assert.equal(installation.feed.counters.archive, 1);
    if (await run.page.$('#settings-dialog[open]')) await run.page.click('#settings-close');
    await editor.click('#cancel-note');
    await editor.waitForFunction(async () => !(await window.__nozeliUpdateState()).dirty, {timeout: 5000});
    scenario.checks.push('Keyboard-typed, unsubmitted local note blocks install with no attempt or activation. Refusal preserves the draft and source bytes; cancelling clears the dirty guard.');
    await installation.requestClose(run.page);
    await installation.waitForCleanExit(run);
    // Foreign winner: interrupt the healthy switch at awaiting-health, then a
    // foreign activation (bundled installer upgrade) wins the CAS; the
    // interrupted attempt must never roll back over it.
    const second = await installation.launch({}, {dynamicDebug: true});
    await openSettings(second.page);
    await invoke(second.page, 'update.preferences', {enabled: false});
    await checkUntilStaged(installation, second.page);
    await installViaUi(second.page);
    await installation.waitForCleanExit(second, {updating: true});
    await browser.disconnect().catch(() => {}); browser = null;
    const pending = await installation.waitPhase(['awaiting-health'], PROMOTION_OBSERVATION_BUDGET);
    const identity = helperIdentity(pending);
    assert(identity.pid !== null, 'awaiting-health record must expose the helper process identity (parent API contract)');
    assert(identity.start100ns !== null, 'awaiting-health helperIdentity must carry the creation stamp so the original helper incarnation is bound exactly');
    const helperRow = (await processesUnder(installation.root)).find(row => row.pid === identity.pid);
    assert(helperRow, 'helper pid ' + identity.pid + ' not present under its installation root');
    scenario.helperKill = await terminateOriginalProcess({root: installation.root, row: helperRow, expectedStart100ns: identity.start100ns});
    await waitFor(async () => (await appProcesses(installation.root)).length === 0 ? true : null, 'successor processes no longer enumerated after helper interruption', 60000, {stopping});
    const foreignResult = installation.cli(original, 'upgrade', ['--candidate', foreign.directory]);
    const winner = await installation.activeReceipt();
    assert.equal(winner.value.active, foreignResult.active);
    assert.notEqual(winner.value.active, pending.value.activeBefore.value.active);
    assert.notEqual(winner.value.active, pending.value.activeAfter.value.active);
    assert.equal(winner.value.generation, pending.value.activeAfter.value.generation + 1);
    const archiveBefore = installation.feed.counters.archive;
    const restart = await installation.launch({}, {dynamicDebug: true});
    const status = await statusOf(restart.page);
    assert.equal(status.currentVersion, foreign.version, 'foreign activation winner must be retained');
    await waitFor(async () => (await installation.records()).find(({value}) => value.token === pending.value.token && value.code === 'UPDATE_INTERRUPTED_RESOLVED'), 'interrupted attempt observes the independent activation', 60000, {stopping});
    assert.deepEqual(await installation.activeReceipt(), winner, 'reconciliation must preserve the exact foreign activation bytes');
    assert.equal(installation.feed.counters.archive, archiveBefore);
    scenario.activation = {interrupted: pending.value.activeAfter, foreign: winner};
    assert.equal(await fs.readFile(installation.sentinel, 'utf8'), 'User data survives update and rollback.\n');
    scenario.checks.push('interrupted awaiting-health attempt plus a foreign installer activation: reconciliation retains the foreign winner generation ' + foreignResult.active + ' and never repeats unknown business or rolls back over it');
    await installation.requestClose(restart.page);
    await installation.waitForCleanExit(restart);
    report.scenarios.push(scenario);
  }

  if (args.scenarios.includes('quarantine')) {
    const scenario = {name: 'quarantine', checks: []};
    const installation = await new Installation('quarantine', successZip, target).create(original, {failChildHealth: true});
    const run = await installation.launch({}, {dynamicDebug: true});
    await installation.waitForCleanExit(run, {timeout: PROMOTION_OBSERVATION_BUDGET});
    assert.equal(installation.feed.counters.archive, 1);
    await browser.disconnect().catch(() => {}); browser = null;
    const firstRollback = await installation.waitPhase(['rolled-back'], PROMOTION_OBSERVATION_BUDGET);
    const rolledBack = await installation.connectRollback(original.version, run, firstRollback.value);
    await waitFor(async () => (await statusOf(rolledBack.page).catch(() => null))?.failedVersion === target.version ? true : null, 'rolled-back app reports the quarantined failed version', 180000, {stopping});
    await installation.requestClose(rolledBack.page);
    await waitFor(async () => !(await processesUnder(installation.root)).length, 'clean stop', 60000, {stopping});
    const second = await installation.launch({}, {dynamicDebug: true});
    await waitFor(async () => {
      const value = await statusOf(second.page);
      return value.phase === 'error' && value.failedVersion === target.version && /automatic retry is paused/i.test(value.message) ? value : null;
    }, 'automatic startup check suppresses the quarantined version', 180000, {stopping});
    assert.equal(installation.feed.counters.archive, 1, 'automatic check on restart must not re-download the quarantined failed version');
    await dispatchUpdateCheck(second.page);
    await installation.waitForCleanExit(second, {timeout: PROMOTION_OBSERVATION_BUDGET});
    assert.equal(installation.feed.counters.archive, 2, 'explicit check re-fetches the failed version exactly once');
    await browser.disconnect().catch(() => {}); browser = null;
    const retryRollback = await waitFor(async () => (await installation.records()).find(({value}) => value.phase === 'rolled-back' && typeof value.token === 'string' && value.token !== firstRollback.value.token), 'explicit retry completed its own rollback', PROMOTION_OBSERVATION_BUDGET, {stopping});
    const retried = await installation.connectRollback(original.version, second, retryRollback.value);
    await waitFor(async () => { const value = await statusOf(retried.page); return value.phase === 'error' && value.failedVersion === target.version ? value : null; }, 'explicit retry fails and rolls back again', 600000, {stopping});
    await installation.requestClose(retried.page);
    await waitFor(async () => !(await processesUnder(installation.root)).length, 'clean stop', 60000, {stopping});
    const third = await installation.launch({}, {dynamicDebug: true});
    const heldAgain = await waitFor(async () => {
      const value = await statusOf(third.page);
      return value.phase === 'error' && value.failedVersion === target.version && /automatic retry is paused/i.test(value.message) ? value : null;
    }, 'automatic startup check suppresses the version after explicit retry fails', 180000, {stopping});
    assert.equal(installation.feed.counters.archive, 2, 'no automatic retry loop after the explicit re-failure');
    assert.equal(heldAgain.currentVersion, original.version);
    scenario.checks.push('failChildHealth startup-health failure on the real package quarantines the failed version: two automatic restart checks fetch nothing; one explicit check re-fetches exactly once, re-fails and re-rolls-back; no restart retry loop');
    await installation.requestClose(third.page);
    await installation.waitForCleanExit(third);
    report.scenarios.push(scenario);
  }

  if (args.scenarios.includes('refused')) {
    const scenario = {name: 'refused', checks: []};
    const installation = await new Installation('refused', successZip, target).create(original);
    const originalActive=await installation.activeReceipt();
    // Tampered archive: served bytes differ from the checksum manifest.
    const tamperedZip = Buffer.concat([successZip, Buffer.from('\nchecksum tamper\n')]);
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    assert.notEqual(hash(tamperedZip), hash(successZip));
    installation.feed.serve(tamperedZip);
    const second = await installation.launch();
    await openSettings(second.page);
    await invoke(second.page,'update.preferences',{enabled:false});
    await invoke(second.page, 'update.check');
    const tampered = await waitFor(async () => { const value = await statusOf(second.page); return value.phase === 'error' ? value : null; }, 'tampered archive refused', 300000, {stopping});
    assert.equal(installation.feed.counters.archive, 1);
    const downloads = (await fs.readdir(installation.updates)).filter(name => name.startsWith('download-'));
    assert.equal(downloads.length, 1);
    await assert.rejects(fs.stat(path.join(installation.updates, downloads[0], 'update.zip')), {code: 'ENOENT'});
    assert(!(await fs.readdir(installation.root)).some(name => name.startsWith('.nozeli-staging-')));
    assert.deepEqual(await installation.activeReceipt(),originalActive,'checksum refusal must preserve the exact activation state');
    assert.equal((await installation.records()).filter(record => typeof record.value.token === 'string').length, 0, 'refusal must not create an attempt');
    await installation.requestClose(second.page);
    const stopped = await waitFor(() => second.child.exitCode !== null ? {code: second.child.exitCode} : null, 'launcher clean stop', 60000, {stopping});
    assert.equal(stopped.code, 0);
    // Wrong-platform package: intentionally invalid architecture metadata.
    installation.feed.setPayload({archive: wrongArchZip, version: target.version, commit: target.commit});
    const third = await installation.launch();
    await invoke(third.page, 'update.check');
    const wrongArchitecture = await waitFor(async () => { const value = await statusOf(third.page); return value.phase === 'error' ? value : null; }, 'wrong-architecture package refused', 300000, {stopping});
    assert.equal(installation.feed.counters.archive, 2);
    const verifiedDownload = (await fs.readdir(installation.updates)).find(name => name.startsWith('download-') && !downloads.includes(name));
    assert(verifiedDownload, 'Wrong-architecture fixture must reach extraction after download');
    assert.equal(hash(await fs.readFile(path.join(installation.updates, verifiedDownload, 'update.zip'))), hash(wrongArchZip));
    const stagedManifest = await readJson(path.join(installation.root, verifiedDownload.replace(/^download-/, '.nozeli-staging-'), path.basename(target.directory), 'WINDOWS-CANDIDATE.json'));
    assert.equal(stagedManifest?.arch, 'arm64');
    assert(!(await fs.readdir(installation.root)).some(name => name.startsWith('.nozeli-update-')));
    scenario.refusals = {checksum: {message: tampered.message, expectedSha256: hash(successZip), servedSha256: hash(tamperedZip)},
      architecture: {message: wrongArchitecture.message, archiveSha256: hash(wrongArchZip), architecture: stagedManifest.arch}};
    assert.equal((await installation.records()).filter(record => typeof record.value.token === 'string').length, 0);
    assert.deepEqual(await installation.activeReceipt(),originalActive,'wrong-platform refusal must preserve the exact activation state');
    scenario.activation = originalActive;
    scenario.counters = {...installation.feed.counters};
    scenario.checks.push('Checksum-mismatched archive and wrong-architecture fixture are refused with no attempt and the exact activation state retained');
    await installation.requestClose(third.page);
    await installation.waitForCleanExit(third);
    report.scenarios.push(scenario);
  }

  report.ok = true;
} catch (error) {
  failure = {message: String(error?.message || error), stack: String(error?.stack || '').split('\n').slice(0, 24).join('\n')};
  if (error?.promotionFailure) failure.promotion = error.promotionFailure;
  report.ok = false;
  report.failure = failure;
} finally {
  await cleanup();
  report.checks = checks;
  const sanitized = JSON.parse(JSON.stringify(report, (key, value) => typeof value === 'string' ? value.slice(0, 12000) : value));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(sanitized, null, 2) + '\n');
  if (failure) {
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({failure: sanitized.failure, scenarios: sanitized.scenarios, parentExitFailure: sanitized.parentExitFailure}, null, 2) + '\n');
    console.error(failure.stack || failure.message);
    process.exitCode = 1;
  }
  console.log(JSON.stringify({ok: report.ok, scenarios: report.scenarios.map(scenario => scenario.name), checks: [...checks, ...report.scenarios.flatMap(scenario => scenario.checks ?? [])]}, null, 2));
}
