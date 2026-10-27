import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';

const SECRET = /AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i;
const PROVIDER = /^(?:CCB_|CODEX_|OMP_|PI_|ANTHROPIC_|OPENAI_)/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fixed acceptance expectation, never the catalog authority. The shipped flow
// catalog is enumerated live and must match these ids before a run counts.
import {demoSteps} from '../src/domain/guided-demo.mjs';
export const expectedStepIds = Object.freeze(demoSteps.map(step => step.id));
export const stepIndex = id => {
  const index = expectedStepIds.indexOf(id);
  assert(index >= 0, `unknown demo step: ${id}`);
  return index;
};

async function emptyDirectory(directory) {
  const entries = await fs.readdir(directory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert(entries !== null, 'NOZELI_GUIDED_DEMO_ROOT must already exist; create a fresh directory for every run');
  assert.equal(entries.length, 0, 'NOZELI_GUIDED_DEMO_ROOT must be fresh and empty; an earlier run is evidence, not a replay target');
}

function isolatedEnvironment(root, port, observer) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (PROVIDER.test(key) || SECRET.test(key) || key.startsWith('NOZELI_')) delete env[key];
  Object.assign(env, {
    HOME: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'home', '.config'),
    XDG_DATA_HOME: path.join(root, 'home', '.local', 'share'),
    XDG_CACHE_HOME: path.join(root, 'home', '.cache'),
    NOZELI_TEST_INSTANCE: '1',
    NOZELI_CONFIG_ROOT: path.join(root, 'config'),
    NOZELI_USER_DATA: path.join(root, 'config', 'desktop'),
    NOZELI_GUIDED_DEMO_ROOT: path.join(root, 'examples'),
    NOZELI_DEBUG_PORT: String(port),
    NOZELI_HIDDEN: '0',
    NOZELI_SHOT_DIR: root,
    NOZELI_GUIDED_DEMO_OBSERVER: path.join(root, 'native-observer.jsonl'),
    NODE_OPTIONS: `--require=${observer}`,
  });
  // Ambient injection is removed above; this is the test-owned pre-main observer.
  return env;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function descendants(pid, found = new Map()) {
  let children;
  try { children = await fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'); }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return found; throw error; }
  for (const value of children.trim().split(/\s+/).filter(Boolean)) {
    const child = Number(value);
    try {
      const [exe, command] = await Promise.all([
        fs.readlink(`/proc/${child}/exe`),
        fs.readFile(`/proc/${child}/cmdline`, 'utf8'),
      ]);
      found.set(child, {pid: child, exe, command: command.replaceAll('\0', ' ')});
      await descendants(child, found);
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return found;
}

async function digestFile(file) {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function digestTree(root, relativePaths) {
  const hash = crypto.createHash('sha256');
  for (const relative of [...relativePaths].sort()) hash.update(relative).update('\0').update(await fs.readFile(path.join(root, relative))).update('\0');
  return hash.digest('hex');
}

export async function createGuidedDemoHarness({kind}) {
  assert.equal(process.platform, 'linux', 'This live evidence is Linux-only and must not be presented as cross-platform acceptance');
  const appRoot = path.resolve(process.env.NOZELI_TEST_APP_ROOT || path.resolve(import.meta.dirname, '..'));
  const binaryValue = process.env.NOZELI_TEST_BINARY;
  assert(binaryValue && path.isAbsolute(binaryValue), 'NOZELI_TEST_BINARY must be an absolute Electron executable path');
  const binary = await fs.realpath(binaryValue);
  const rootValue = process.env.NOZELI_GUIDED_DEMO_ROOT;
  assert(rootValue && path.isAbsolute(rootValue), 'NOZELI_GUIDED_DEMO_ROOT must be an absolute fresh evidence root');
  const root = path.resolve(rootValue);
  assert(root !== appRoot && !root.startsWith(appRoot + path.sep), 'Evidence root must be outside the application tree');
  await emptyDirectory(root);
  for (const directory of ['home', 'config/desktop', 'examples']) await fs.mkdir(path.join(root, directory), {recursive: true, mode: 0o700});
  const port = await freePort();
  const observer = path.join(import.meta.dirname, 'guided-demo-native-observer.cjs');
  const env = isolatedEnvironment(root, port, observer);
  async function setPickDirectory(directory){
    const real=await fs.realpath(directory),relative=path.relative(root,real);
    assert(relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),'Test picker must select only a test-owned directory');
    env.NOZELI_TEST_PICK=real;
  }
  const manifest = JSON.parse(await fs.readFile(path.join(appRoot, 'assets/guided-demo/manifest.json'), 'utf8'));
  const version = {
    controls: await digestTree(appRoot,['src/main/guided-demo-controls.mjs','src/renderer/guided-demo-controls.mjs','src/renderer/guided-demo-controls.html','src/renderer/guided-demo-controls.css','src/renderer/settings-appearance.css','dist/renderer/guided-demo-controls.html','dist/renderer/guided-demo-controls.js','dist/renderer/guided-demo-controls.css']),
    renderer: await digestTree(appRoot, ['src/domain/guided-demo.mjs','src/renderer/app.mjs','src/renderer/guided-demo.mjs','src/renderer/guided-demo-surface.mjs','src/renderer/guided-demo-conversation.mjs','src/renderer/guided-demo.css','src/renderer/agent-panel.mjs','src/renderer/workspace-groups.mjs','src/renderer/tag-session-projection.mjs','src/renderer/session-timeline.mjs','src/renderer/composer-materials.mjs','dist/renderer/app.js','dist/renderer/app.css','dist/renderer/index.html','dist/renderer/word-frame.js','dist/renderer/sheet-frame.mjs']),
    main: await digestTree(appRoot, ['src/main/main.cjs','src/main/guided-demo.mjs','src/main/guided-demo-files.mjs','src/main/workspace-native.mjs','src/main/project-lifecycle.mjs','src/main/host.mjs','src/agents/managed-projects.mjs','src/preload/preload.cjs']),
    assets: await digestTree(appRoot, ['assets/guided-demo/manifest.json', ...manifest.files.map(file => `assets/guided-demo/${file.path}`)]),
    binary: await digestFile(binary),
    audit: await digestTree(path.resolve(import.meta.dirname,'..'), ['tests/guided-demo-live-helper.mjs','tests/guided-demo-native-observer.cjs','tests/guided-demo-exit-live.mjs','tests/guided-demo-flow-live.mjs','tests/guided-demo-failed-surface-live.mjs']),
  };
  version.gate = crypto.createHash('sha256').update(JSON.stringify(version)).digest('hex');
  const report = {ok: false, kind, root, appRoot, binary, version, chapters: [], checks: [], scenes: [], errors: [], network: [], processes: [], observer: {coverage: 'NODE_OPTIONS observes Node child_process APIs and blocks non-loopback Node networking before main entry. Chromium host-resolver rules reduce DNS-name access but do not prove isolation against literal-IP/native-addon/OS networking; CDP enumerates renderer requests only after attachment. The report therefore records these limits and never claims zero full-process network.', events: []}};
  let child, exited, browser, log = '', launchError;
  const networkPages=new Map(),localPreviewPages=new Map();

  async function until(fn, label, timeout = 45_000) {
    const deadline = Date.now() + timeout;
    do {
      if (launchError) throw launchError;
      if (child && (child.exitCode !== null || child.signalCode)) throw Error(`Electron exited while waiting for ${label}\n${log}`);
      const value = await fn();
      if (value) return value;
      await pause(75);
    } while (Date.now() < deadline);
    throw Error(`Timed out: ${label}`);
  }

  async function launch() {
    launchError = null;
    const args = [path.join(appRoot, 'src/main/main.cjs'), `--ozone-platform=${process.env.NOZELI_OZONE || 'wayland'}`, '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'];
    child = spawn(binary, args, {cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe']});
    child.once('error', error => { launchError = error; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; });
    exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
    browser = await until(async () => {
      try { return await puppeteer.connect({browserURL: `http://127.0.0.1:${port}`, defaultViewport: null}); }
      catch { return null; }
    }, 'isolated Electron debug endpoint');
    for (const page of await browser.pages()) observePage(page);
    browser.on('targetcreated', async target => { const page = await target.page().catch(() => null); if (page) observePage(page); });
    await until(async () => (await fs.readFile(env.NOZELI_GUIDED_DEMO_OBSERVER, 'utf8').catch(() => '')).includes('observer-ready'), 'pre-main observer readiness', 5_000);
  }

  function observePage(page) {
    page.on('pageerror', error => report.errors.push(String(error.stack || error)));
    page.on('request', request => {
      let url;
      try { url = new URL(request.url()); } catch { return; }
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return;
      const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
      const entry={url:request.url(),method:request.method(),loopback};report.network.push(entry);networkPages.set(entry,page);
    });
  }

  async function scope(predicate, label = 'scoped WebContents') {
    return until(async () => {
      for (const page of await browser.pages()) {
        const value = await page.evaluate(async () => {
          if (!window.nozeli) return null;
          const result = await window.nozeli.invoke('workspace.bootstrap', {});
          return result.ok ? result.value : null;
        }).catch(() => null);
        if (value && predicate(value)) {
          await page.waitForFunction(() => window.__nozeliReady === true, {timeout: 15_000});
          return {page, scope: value};
        }
      }
      return null;
    }, label);
  }

  async function startLearning(page) {
    await page.click('#start-demo-entry');
    const {page:controls}=await scope(value=>value.role==='demo-controls','native learning controls');
    await until(async()=>{const value=await invoke(controls,'workspace.bootstrap');return value.visible&&value.model.status==='playing';},'learning starts directly');
    return controls;
  }

  // One user drag is exactly one seek command. Resending until arrival hid
  // seek races, so this waits only for the control to be usable, commits
  // once, and lets any failure surface as itself.
  async function seek(controls,index,label='seek') {
    const value=await until(async()=>{
      const current=await invoke(controls,'workspace.bootstrap');
      if(!current.visible||!current.model?.seekable||!['playing','paused'].includes(current.model.status))return null;
      return current.model.stepIndex===index||current;
    },`${label}: controls not seekable`,30_000);
    if(value.model.stepIndex===index)return value;
    return invoke(controls,'workspace.demoControls.action',{sessionId:value.model.sessionId,epoch:value.model.epoch,controlId:'seek',stepIndex:index});
  }

  async function invoke(page, operation, payload = {}) {
    const result = await page.evaluate(({operation, payload}) => window.nozeli.invoke(operation, payload), {operation, payload});
    assert(result.ok, `${operation}: ${JSON.stringify(result.error)}`);
    return result.value;
  }

  async function capture(page, name, facts = {}) {
    const file = `${name}.png`;
    await page.screenshot({path: path.join(root, file)});
    report.scenes.push({name, file, ...facts});
    if(facts.projectId){
      const result=await invoke(page,'workspace.windows.list',{projectId:facts.projectId});
      const visible=new Set(result.flatMap(window=>(window.surfaces||[]).filter(surface=>surface.visible&&surface.bounds?.width>0&&surface.bounds?.height>0).map(surface=>surface.viewId)));
      for(const target of await browser.pages()){
        if(target===page)continue;
        const identity=await target.evaluate(async()=>{const result=await window.nozeli?.invoke('workspace.bootstrap',{});return result?.ok?result.value:null;}).catch(()=>null);
        if(identity?.projectId!==facts.projectId||!visible.has(identity.viewId))continue;
        const image=name+'-'+identity.viewId+'.png';await target.screenshot({path:path.join(root,image)});report.scenes.push({name:name+' content',file:image,projectId:facts.projectId,viewId:identity.viewId,relPath:identity.relPath,kind:identity.kind});
      }
    }
  }

  async function auditIsolation() {
    const pages=await browser.pages(),snapshots=[];
    for(const page of pages){
      const owned=await page.evaluate(async()=>{if(!window.nozeli)return [];const values=[];for(const node of document.querySelectorAll('.isolated-viewport[data-preview-key]')){const result=await window.nozeli.invoke('isolated-preview.snapshot',{key:node.dataset.previewKey});if(result.ok)values.push(result.value);}return values;}).catch(()=>[]);
      snapshots.push(...owned);
    }
    for(const snapshot of snapshots)for(const page of pages)if(page.url().startsWith(snapshot.origin+'/'))localPreviewPages.set(page,snapshot);
    report.localPreviews=[...new Map([...localPreviewPages.values()].map(snapshot=>[snapshot.origin,snapshot])).values()];
    for(const entry of report.network){const snapshot=localPreviewPages.get(networkPages.get(entry));if(snapshot&&new URL(entry.url).origin===snapshot.origin)entry.localPreview={origin:snapshot.origin,projectId:snapshot.projectId,intercepted:true};}
    assert(!report.network.some(entry=>!entry.loopback&&!entry.localPreview),`External Chromium network observed after CDP attachment: ${JSON.stringify(report.network.filter(entry=>!entry.loopback&&!entry.localPreview))}`);
    const observerText = await fs.readFile(env.NOZELI_GUIDED_DEMO_OBSERVER, 'utf8');
    report.observer.events = observerText.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert(report.observer.events.some(event => event.type === 'observer-ready'), 'Pre-main native observer did not load');
    assert(!report.observer.events.some(event => event.type === 'network'), `External Node network attempted: ${JSON.stringify(report.observer.events.filter(event => event.type === 'network'))}`);
    const attempts = report.observer.events.filter(event => event.type === 'child');
    const forbiddenPattern = /(?:^|[\\/\s_-])(?:omp|codex|claude|ccb)(?:[\\/\s_-]|$)|--provider(?:=|\s+)(?:omp|codex|claude|ccb)/i;
    // The settings tour opens the real provider section; listing locally stored
    // accounts is an app-level query, not a demo-task or model execution.
    const localSettingsQuery = entry => {
      const [binary, verb, list, flag] = entry.command;
      return binary === path.join(report.appRoot, 'runtime/omp/omp') && verb === 'auth-broker' && list === 'list' && flag === '--json';
    };
    const childViolations = attempts.filter(entry => forbiddenPattern.test(entry.command.join(' ')) && !localSettingsQuery(entry));
    report.observer.settingsQueries = attempts.filter(localSettingsQuery).length;
    assert.deepEqual(childViolations, [], 'Native/model/CCB child attempt observed');
    const processes = [...(await descendants(child.pid)).values()];
    report.processes = processes;
    const asCommand = entry => Array.isArray(entry.command) ? [entry.exe, ...entry.command] : [entry.exe, ...String(entry.command ?? '').split(' ').filter(Boolean)];
    assert.deepEqual(processes.filter(entry => forbiddenPattern.test(asCommand(entry).join(' ')) && !localSettingsQuery({command: asCommand(entry)})), [], 'Native/model/CCB subprocess remains');
    assert(!log.includes('GUIDED_DEMO_OBSERVER_FAILURE'), 'Pre-main observer reported an evidence write failure');
  }

  async function closeNormally(page) {
    const response = await page.evaluate(() => window.nozeli.invoke('session.requestClose', {}));
    assert(response.ok, `session.requestClose: ${JSON.stringify(response.error)}`);
    const result = await Promise.race([exited, pause(15_000).then(() => null)]);
    assert.deepEqual(result, {code: 0, signal: null}, 'Normal product close must flush and exit 0; forced cleanup never counts');
    report.normalExit = result;
    await browser?.disconnect(); browser = null;
  }

  async function cleanupAfterFailure() {
    if (!child || child.exitCode !== null || child.signalCode) return;
    report.ok = false; report.cleanup = {forced: true}; child.kill('SIGTERM');
    const stopped = await Promise.race([exited.then(() => true), pause(4_000).then(() => false)]);
    if (!stopped) { child.kill('SIGKILL'); await exited; report.cleanup.signal = 'SIGKILL'; }
    else report.cleanup.signal = 'SIGTERM';
  }

  async function save() {
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(path.join(root, 'main.log'), log);
  }

  return {appRoot, binary, root, report, version, launch, until, scope, startLearning, seek, invoke, capture, setPickDirectory, auditIsolation, closeNormally, cleanupAfterFailure, save, get browser() { return browser; }, get child() { return child; }};
}
