// Explicit integration smoke: node --test tests/auto-update-package-smoke.mjs
// Uses only temporary real Electron packages and a loopback synthetic release server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import * as tar from 'tar';
const require = createRequire(import.meta.url);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function json(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function waitFor(callback, milliseconds = 120000) {
  const expires = Date.now() + milliseconds;
  while (Date.now() < expires) { const value = await callback(); if (value) return value; await pause(100); }
  throw Error('Timed out waiting for package update smoke');
}
async function copyDependency(name, app, seen = new Set()) {
  if (seen.has(name)) return; seen.add(name);
  const manifestFile = require.resolve(name + '/package.json');
  const manifest = await json(manifestFile);
  await fs.cp(path.dirname(manifestFile), path.join(app, 'node_modules', name), {recursive: true, mode: fs.constants.COPYFILE_FICLONE});
  for (const child of Object.keys(manifest.dependencies || {})) await copyDependency(child, app, seen);
}
async function realPackage(directory, version, fails) {
  await fs.mkdir(directory);
  const electron = path.dirname(require('electron'));
  await fs.cp(electron, directory, {recursive: true, mode: fs.constants.COPYFILE_FICLONE});
  await fs.rename(path.join(directory, 'electron'), path.join(directory, 'nozeli'));
  const app = path.join(directory, 'resources/app');
  await fs.mkdir(path.join(app, 'src/main'), {recursive: true});
  await fs.mkdir(path.join(app, 'dist/renderer'), {recursive: true});
  for (const name of ['auto-update.mjs', 'auto-update-helper.mjs', 'auto-update-files.mjs', 'auto-update-extract.mjs']) await fs.copyFile(path.join(source, 'src/main', name), path.join(app, 'src/main', name));
  await copyDependency('tar', app);
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({name: 'nozeli-desktop', version, type: 'module', main: 'src/main/main.cjs'}));
  await fs.writeFile(path.join(app, 'dist/renderer/app.js'), '');
  await fs.writeFile(path.join(directory, 'AppRun'), '#!/bin/sh\nexec "$(dirname "$0")/nozeli" "$@"\n', {mode: 0o755});
  const metadata = {application: 'Nozeli', version, platform: 'linux', arch: 'x64', state: 'validated', commit: 'a'.repeat(40), format: 'portable-tar.gz'};
  for (const name of ['RELEASE.json', 'INSTALLATION.json']) await fs.writeFile(path.join(directory, name), JSON.stringify(metadata));
  await fs.writeFile(path.join(app, 'src/main/main.cjs'), `const {app}=require('electron');\nconst fs=require('node:fs');\napp.whenReady().then(async()=>{\nfs.appendFileSync(process.env.NOZELI_SMOKE_LOG,JSON.stringify({version:${JSON.stringify(version)},pid:process.pid})+'\\n');\n${fails ? 'app.exit(17);' : "await (await import('./auto-update-helper.mjs')).acknowledgeUpdateHealth({appRoot:app.getAppPath()}); setInterval(()=>{},1000);"}\n});\n`);
  return app;
}
for (const kind of ['managed', 'portable']) for (const fails of [false, true]) test(`real Electron ${kind} ${fails ? 'startup failure rolls back' : 'promotion and health receipt'}`, {skip: process.platform !== 'linux' || process.arch !== 'x64' || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY), timeout: 300000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nozeli-real-update-'));
  const processes = new Set(); let driver;
  t.after(async () => {
    if (driver?.pid) { try { process.kill(driver.pid, 'SIGKILL'); } catch {} }
    const log = await fs.readFile(path.join(root, 'launches.jsonl'), 'utf8').catch(() => '');
    for (const line of log.trim().split('\n').filter(Boolean)) processes.add(JSON.parse(line).pid);
    for (const pid of processes) { try { process.kill(-pid, 'SIGTERM'); } catch {} }
    await pause(500);
    await fs.rm(root, {recursive: true, force: true});
  });
  const installation = path.join(root, 'installation'); await fs.mkdir(installation);
  const base = kind === 'managed' ? path.join(installation, 'releases') : installation; await fs.mkdir(base, {recursive: true});
  const old = path.join(base, 'old');
  const oldApp = await realPackage(old, '1.0.0-alpha.1', false);
  if (kind === 'managed') await fs.symlink(old, path.join(installation, 'current'));
  const publish = path.join(root, 'publish'); await fs.mkdir(publish);
  const label = 'Nozeli-1.0.0-alpha.2-linux-x64';
  await realPackage(path.join(publish, label), '1.0.0-alpha.2', fails);
  const archiveFile = path.join(root, label + '.tar.gz');
  await tar.c({cwd: publish, gzip: true, file: archiveFile}, [label]);
  const bytes = await fs.readFile(archiveFile), checksum = crypto.createHash('sha256').update(bytes).digest('hex');
  const server = http.createServer((request, response) => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    if (request.url.startsWith('/releases')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([{tag_name: 'v1.0.0-alpha.2', prerelease: true, assets: [{name: label + '.tar.gz', size: bytes.length, browser_download_url: origin + '/archive'}, {name: 'SHA256SUMS.txt', size: 150, browser_download_url: origin + '/sums'}]}]));
    } else if (request.url === '/sums') response.end(checksum + '  ' + label + '.tar.gz\n');
    else if (request.url === '/archive') { response.setHeader('Content-Length', bytes.length); response.end(bytes); }
    else if (request.url === '/git/ref/tags/v1.0.0-alpha.2') response.end(JSON.stringify({ref: 'refs/tags/v1.0.0-alpha.2', object: {type: 'commit', sha: 'a'.repeat(40)}}));
    else { response.statusCode = 404; response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const stateDir = path.join(root, 'state');
  const driverFile = path.join(oldApp, 'src/main/smoke-driver.mjs');
  await fs.writeFile(driverFile, `import {AutoUpdater} from './auto-update.mjs';\nconst updater=new AutoUpdater({currentVersion:'1.0.0-alpha.1',appRoot:${JSON.stringify(oldApp)},stateDir:${JSON.stringify(stateDir)},canInstall:async()=>({ready:true}),prepareShutdown:async()=>true,quit:()=>process.exit(0),dependencies:{feed:${JSON.stringify('http://127.0.0.1:' + server.address().port + '/releases')},tagApiBase:${JSON.stringify('http://127.0.0.1:' + server.address().port)},allowLoopback:true}});\nawait updater.check();\nconsole.error(JSON.stringify(updater.status()));process.exit(2);\n`);
  driver = spawn(path.join(old, 'nozeli'), [driverFile], {env: {...process.env, ELECTRON_RUN_AS_NODE: '1', NOZELI_SMOKE_LOG: path.join(root, 'launches.jsonl')}, stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; driver.stdout.on('data', data => { output += data; }); driver.stderr.on('data', data => { output += data; });
  const [exit] = await once(driver, 'exit'); assert.equal(exit, 0, output);
  const handoff = await waitFor(async () => { const value = await json(path.join(stateDir, 'handoff.json')).catch(() => null); return ['installed', 'rolled-back', 'error'].includes(value?.phase) ? value : null; }, 150000);
  assert.equal(handoff.phase, fails ? 'rolled-back' : 'installed', JSON.stringify(handoff));
  const active = kind === 'managed' ? await fs.realpath(path.join(installation, 'current')) : old;
  assert.equal((await json(path.join(active, 'RELEASE.json'))).version, fails ? '1.0.0-alpha.1' : '1.0.0-alpha.2');
  if (!fails) {
    const receipt = await json(path.join(stateDir, 'health-' + handoff.token + '.json'));
    assert.equal(receipt.version, '1.0.0-alpha.2'); processes.add(receipt.pid);
  } else await waitFor(async () => (await fs.readFile(path.join(root, 'launches.jsonl'), 'utf8').catch(() => '')).includes('1.0.0-alpha.1'));
  // The terminal health journal precedes the helper's finally cleanup.
  await waitFor(async () => { try { await fs.access(path.join(installation, '.installer-lock')); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } }, 5000);
});
