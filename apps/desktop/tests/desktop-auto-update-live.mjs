// Real Nozeli managed-update smoke. Run explicitly after building renderer/runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import * as tar from 'tar';
import {packageRelease} from '../tools/local-release.mjs';
const source = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const OLD = '0.0.0-updater-smoke.1', NEW = '0.0.0-updater-smoke.2', commit = 'c'.repeat(40);
await fs.mkdir(path.join(source, '.test-output'), {recursive: true});
const out = await fs.mkdtemp(path.join(source, '.test-output', 'desktop-auto-update-'));
const root = path.join(out, 'installation'), configurationRoot = path.join(out, '.Nozeli'), profile = path.join(configurationRoot, 'desktop');
const home = path.join(out, 'home');
const old = path.join(root, 'releases', 'old'), published = path.join(root, 'releases', 'Nozeli-' + NEW + '-linux-x64');
const checks = []; let child, browser, page, server, error, logs = '', childExit, newPid;
const pageEvents = [], observedPages = new Set();
const debugEndpoints = [];
let releaseFeed;
const fixturePromise = new Promise(resolve => { releaseFeed = resolve; });
function observe(candidate) {
  if (observedPages.has(candidate)) return;
  observedPages.add(candidate);
  candidate.on('console', message => pageEvents.push({url: candidate.url(), type: message.type(), text: message.text()}));
  candidate.on('pageerror', failure => pageEvents.push({url: candidate.url(), type: 'pageerror', text: failure.stack || String(failure)}));
}
async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function waitFor(callback, message, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await callback(); if (value) return value; await pause(100); }
  throw Error('Timeout: ' + message);
}
async function connect(previousEndpoint = null) {
  const connection = await waitFor(async () => {
    const endpoint = await fs.readFile(path.join(home, '.config', 'Nozeli', 'DevToolsActivePort'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    const [port, browserPath] = endpoint.trim().split('\n');
    if (!/^\d+$/.test(port) || !browserPath?.startsWith('/devtools/browser/') || endpoint === previousEndpoint) return null;
    const candidate = await require('puppeteer-core').connect({browserWSEndpoint: 'ws://127.0.0.1:' + port + browserPath, defaultViewport: null, protocolTimeout: 15000}).catch(() => null);
    if (candidate) debugEndpoints.push({port: Number(port), browserPath, endpoint});
    return candidate;
  }, 'fresh ephemeral debug connection');
  browser = connection; // Preserve access for evidence if shell readiness fails.
  const nextPage = await waitFor(async () => {
    for (const candidate of await connection.pages()) {
      observe(candidate);
      const shell = await candidate.evaluate(() => window.__workspaceScope?.role === 'shell').catch(() => false);
      if (shell) return candidate;
    }
    return null;
  }, 'scoped shell page', 60000);
  page = nextPage;
  await waitFor(() => nextPage.evaluate(() => window.__nozeliReady === true).catch(() => false), 'scoped shell renderer ready', 60000);
  return {browser: connection, page: nextPage};
}
async function stamp(directory, version) {
  const appManifest = path.join(directory, 'resources/app/package.json'), manifest = await json(appManifest);
  manifest.version = version; await fs.writeFile(appManifest, JSON.stringify(manifest, null, 2) + '\n');
  const markerFile = path.join(directory, 'INSTALLATION.json'), marker = await json(markerFile);
  marker.version = version; await fs.writeFile(markerFile, JSON.stringify(marker, null, 2) + '\n');
  await fs.writeFile(path.join(directory, 'RELEASE.json'), JSON.stringify({application: 'Nozeli', version, platform: 'linux', arch: 'x64', commit, format: 'portable-tar.gz'}) + '\n');
  await fs.writeFile(path.join(directory, 'AppRun'), '#!/bin/sh\nexec "$(dirname "$0")/nozeli" "$@"\n', {mode: 0o755});
}
try {
  await fs.mkdir(path.join(root, 'releases'), {recursive: true});
  await fs.mkdir(profile, {recursive: true});
  const sentinel = path.join(profile, 'update-preservation-sentinel.txt');
  await fs.writeFile(sentinel, 'Generated user data must survive a real package update.\n');
  await packageRelease({root, release: old, source}); await stamp(old, OLD);
  await fs.cp(old, published, {recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE}); await stamp(published, NEW);
  await fs.symlink(old, path.join(root, 'current'));
  const archive = path.join(out, path.basename(published) + '.tar.gz');
  await tar.c({cwd: path.dirname(published), gzip: true, file: archive}, [path.basename(published)]);
  const bytes = await fs.readFile(archive), checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  const assetName = path.basename(archive);
  server = http.createServer((request, response) => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    if (request.url.startsWith('/releases')) {
      // Fixture network latency keeps the automatic check pending until the real
      // settings modal is open; no application guard or state is overridden.
      void fixturePromise.then(() => {
        if (!response.destroyed) response.end(JSON.stringify([{tag_name: 'v' + NEW, prerelease: true, assets: [{name: assetName, size: bytes.length, browser_download_url: origin + '/archive'}, {name: 'SHA256SUMS.txt', size: 160, browser_download_url: origin + '/sums'}]}]));
      });
    }
    else if (request.url === '/git/ref/tags/v' + NEW) response.end(JSON.stringify({ref: 'refs/tags/v' + NEW, object: {type: 'commit', sha: commit}}));
    else if (request.url === '/sums') response.end(checksum + '  ' + assetName + '\n');
    else if (request.url === '/archive') { response.setHeader('Content-Length', bytes.length); response.end(bytes); }
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {...process.env};
  for (const key of Object.keys(env)) if (key !== 'XAUTHORITY' && (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key) || ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key))) delete env[key];
  await fs.mkdir(home);
  Object.assign(env, {HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), XDG_CACHE_HOME: path.join(home, '.cache'), NOZELI_TEST_INSTANCE: '1', NOZELI_CONFIG_ROOT: configurationRoot, NOZELI_USER_DATA: profile, NOZELI_DEBUG_PORT: '0', NOZELI_HIDDEN: '0', NOZELI_OZONE: 'x11', NOZELI_TEST_UPDATE_FEED: 'http://127.0.0.1:' + server.address().port + '/releases'});
  child = spawn(path.join(old, 'nozeli'), ['--ozone-platform=x11'], {cwd: old, detached: true, env, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.on('data', bytes => { logs += bytes; }); child.stderr.on('data', bytes => { logs += bytes; });
  childExit = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  ({browser, page} = await connect());
  if (await page.$('#configuration-setup[open]')) await page.click('#configuration-cancel');
  await page.click('#open-settings');
  await page.waitForSelector('#settings-dialog[open]');
  await page.click('[data-settings-section="settings-update"]');
  await page.waitForSelector('#settings-update', {visible: true});
  releaseFeed();
  await page.waitForFunction(async () => { const response = await window.nozeli.invoke('update.status', {}); return response.ok && response.value.phase === 'waiting-idle'; }, {timeout: 180000, polling: 100});
  const blocked = await page.evaluate(() => window.nozeli.invoke('update.status', {}));
  assert.equal(blocked.value.currentVersion, OLD); assert.equal(blocked.value.availableVersion, NEW);
  assert.equal(await fs.realpath(path.join(root, 'current')), old);
  assert.equal((await json(path.join(profile, 'updates/status.json'))).phase, 'waiting-idle');
  assert.equal(await page.$eval('#settings-dialog', element => element.open), true);
  await page.screenshot({path: path.join(out, 'settings-update-waiting-idle.png')});
  checks.push('real automatic download/staging completes but open application-update settings modal blocks restart');
  await page.click('#settings-close');
  const oldExit = await Promise.race([childExit, pause(60000).then(() => null)]);
  assert.deepEqual(oldExit, {code: 0, signal: null}, 'old real app exits normally through host idle lifecycle');
  await browser.disconnect().catch(() => {}); browser = null;
  const handoff = await waitFor(async () => { const value = await json(path.join(profile, 'updates/handoff.json')).catch(() => null); return ['installed', 'rolled-back', 'error'].includes(value?.phase) ? value : null; }, 'new real app startup health', 180000);
  assert.equal(handoff.phase, 'installed', JSON.stringify(handoff));
  const receipt = await json(path.join(profile, 'updates', 'health-' + handoff.token + '.json')); newPid = receipt.pid;
  assert.equal(receipt.version, NEW); assert.equal(receipt.release, await fs.realpath(path.join(root, 'current')));
  assert.equal(await fs.realpath(path.join(root, 'previous')), old);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'Generated user data must survive a real package update.\n');
  checks.push('closing settings permits real old-app normal exit, managed promotion, new renderer startup health, previous-release preservation and unchanged user data');
  ({browser, page} = await connect(debugEndpoints[0].endpoint));
  assert.notEqual(debugEndpoints[1].browserPath, debugEndpoints[0].browserPath, 'updated app publishes a fresh debug endpoint');
  const state = await page.evaluate(() => window.nozeli.invoke('update.status', {}));
  assert.equal(state.ok, true); assert.equal(state.value.currentVersion, NEW);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'Generated user data must survive a real package update.\n');
  checks.push('fresh ephemeral debug endpoint exposes actual updated shell and current version');
  if (await page.$('#configuration-setup[open]')) await page.click('#configuration-cancel');
  void page.evaluate(() => window.nozeli.invoke('session.requestClose', {})).catch(() => {});
  await waitFor(async () => { try { process.kill(newPid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } }, 'updated app normal shutdown', 30000);
  await assert.rejects(fs.access(path.join(root, '.installer-lock')));
  checks.push('updated real Nozeli closes normally via session.requestClose; installer lock released');
} catch (caught) {
  error = caught.stack; console.error(error);
  const pages = browser ? await browser.pages().catch(() => []) : [];
  const evidence = [];
  for (const candidate of pages) {
    observe(candidate);
    evidence.push(await candidate.evaluate(async () => ({url: location.href, scope: window.__workspaceScope, ready: window.__nozeliReady, dom: document.documentElement.outerHTML.slice(0, 100000), update: window.__workspaceScope?.role === 'shell' ? await window.nozeli.invoke('update.status', {}) : null})).catch(failure => ({url: candidate.url(), error: String(failure)})));
  }
  await fs.writeFile(path.join(out, 'failure-state.json'), JSON.stringify({pages: evidence, pageEvents, persistedUpdate: await json(path.join(profile, 'updates/status.json')).catch(() => null), handoff: await json(path.join(profile, 'updates/handoff.json')).catch(() => null)}, null, 2));
  if (page && !page.isClosed()) await page.screenshot({path: path.join(out, 'failure.png')}).catch(() => {});
} finally {
  await browser?.disconnect().catch(() => {});
  // Discover only same-user processes executing this generated installation,
  // including a helper/new app whose receipt was not written before failure.
  const owned = new Map();
  async function identify(pid) {
    try {
      const stat = await fs.stat('/proc/' + pid);
      const executable = await fs.realpath('/proc/' + pid + '/exe');
      if (stat.uid !== process.getuid() || !executable.startsWith(root + path.sep)) return null;
      const value = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
      return value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
    } catch (error) { if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) return null; throw error; }
  }
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry), stamp = await identify(pid);
    if (stamp) owned.set(pid, stamp);
  }
  // Stop main/helper processes before Chromium children to avoid manufacturing
  // GPU/renderer failures in evidence collected from an otherwise running app.
  const mains = [];
  for (const [pid, stamp] of owned) {
    const argv = await fs.readFile('/proc/' + pid + '/cmdline', 'utf8').catch(() => '');
    if (!argv.includes('--type=') && await identify(pid) === stamp) mains.push([pid, stamp]);
  }
  for (const [pid, stamp] of mains) if (await identify(pid) === stamp) { try { process.kill(pid, 'SIGTERM'); } catch (failure) { if (failure.code !== 'ESRCH') throw failure; } }
  await pause(1500);
  for (const [pid, stamp] of mains) if (await identify(pid) === stamp) { try { process.kill(pid, 'SIGKILL'); } catch (failure) { if (failure.code !== 'ESRCH') throw failure; } }
  await pause(200);
  for (const [pid, stamp] of owned) if (await identify(pid) === stamp) { try { process.kill(pid, 'SIGKILL'); } catch (failure) { if (failure.code !== 'ESRCH') throw failure; } }
  child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
  releaseFeed();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await fs.writeFile(path.join(out, 'main.log'), logs);
  await fs.writeFile(path.join(out, 'debug-endpoints.json'), JSON.stringify(debugEndpoints, null, 2));
  await fs.writeFile(path.join(out, 'page-events.json'), JSON.stringify(pageEvents, null, 2));
  const report = {ok: !error, checks, error};
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({out, ...report}, null, 2)); process.exitCode = error ? 1 : 0;
}
