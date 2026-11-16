// Explicit real .app UI/IPC -> original process exit -> standalone helper ->
// new real renderer health (success), or deliberate startup failure/interruption.
// Version labels and signatures are fixture-only; this is not release qualification.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {sameUserSnapshot, processStamp} from '../src/platform/darwin/process-ownership.mjs';
import {validateMacPackage, extractMacPackage, macApplication, detectMacInstallation} from '../src/main/auto-update-macos.mjs';
import {atomicJson} from '../src/main/auto-update-files.mjs';
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Requires native darwin arm64; Linux is not Mac qualification');
const input = process.env.NOZELI_MAC_UPDATE_APP;
assert(input && path.isAbsolute(input), 'NOZELI_MAC_UPDATE_APP must select a freshly built real Nozeli.app');
const scenario = process.env.NOZELI_MAC_UPDATE_SCENARIO || 'success';
assert(['success', 'failure', 'interrupted'].includes(scenario));
const source = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url);
const OLD = '0.0.0-updater-native.1', NEW = '0.0.0-updater-native.2', commit = 'c'.repeat(40);
await fs.mkdir(path.join(source, '.test-output'), {recursive: true});
const out = await fs.realpath(await fs.mkdtemp(path.join(source, '.test-output/macos-update-')));
const root = path.join(out, 'installation'), old = path.join(root, 'Nozeli.app'), published = path.join(out, 'published/Nozeli.app');
const home = path.join(out, 'home'), configurationRoot = path.join(out, '.Nozeli'), profile = path.join(configurationRoot, 'desktop');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function waitFor(read, label, timeout = 180000) { const end = Date.now() + timeout; while (Date.now() < end) { if(stopping)throw Error('Native qualification aborted'); const result = await read(); if (result) return result; await sleep(100); } throw Error('Timeout: ' + label); }
async function stamp(bundle, version) {
  const app = macApplication(bundle), manifest = await json(path.join(app, 'package.json')); manifest.version = version;
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(bundle, 'Contents/Resources/RELEASE.json'), JSON.stringify({application:'Nozeli', version, platform:'darwin', arch:'arm64', format:'app-zip', commit, codesign:'ad-hoc', notarized:false, developerId:false}));
  for (const [key, value] of Object.entries({NozeliReleaseVersion:version, CFBundleVersion:'0.0.0', CFBundleShortVersionString:'0.0.0'})) execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, path.join(bundle,'Contents/Info.plist')]);
  execFileSync('/usr/bin/codesign', ['--force','--sign','-',bundle]);
  await validateMacPackage(bundle, version, commit);
}
let browser, server, child, error, logs = '', newPid, stopping = false;
const checks = [], env = {...process.env};
for (const key of Object.keys(env)) if (/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key) || /AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key) || ['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
let debugPort;
async function connect(previous) {
  browser = await waitFor(async () => {
    const connection = await require('puppeteer-core').connect({browserURL:'http://127.0.0.1:' + debugPort, defaultViewport:null, protocolTimeout:15000}).catch(() => null);
    if (connection && connection.wsEndpoint() === previous) { await connection.disconnect(); return null; }
    return connection;
  }, 'real app debug connection');
  const page = await waitFor(async () => { for (const page of await browser.pages()) if (await page.evaluate(() => window.__workspaceScope?.role === 'shell' && window.__nozeliReady === true).catch(() => false)) return page; }, 'real shell renderer ready');
  return page;
}
async function openSettings(page) {
  if (await page.$('#configuration-setup[open]')) await page.click('#configuration-cancel');
  await page.click('#open-settings'); await page.waitForSelector('#settings-dialog[open]'); await page.click('[data-settings-section="settings-update"]');
}
async function install(page) {
  await page.evaluate(() => window.nozeli.invoke('update.preferences',{enabled:false}));
  await page.waitForFunction(() => [...document.querySelectorAll('#settings-update button')].some(node => node.textContent === '安装并重启' && !node.disabled));
  const handle = await page.evaluateHandle(() => [...document.querySelectorAll('#settings-update button')].find(node => node.textContent === '安装并重启'));
  await handle.asElement().click();
}
async function terminateOwned(signal) {
  for (const row of await sameUserSnapshot()) {
    if (row.euid !== process.getuid() || row.ruid !== process.getuid() || !row.path?.startsWith(root + path.sep)) continue;
    const stamp = await processStamp(row.pid), expectedStart = ':' + row.startSec + String(row.startUsec).padStart(6, '0');
    if (stamp?.endsWith(expectedStart) && await processStamp(row.pid) === stamp) try { process.kill(row.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
process.once('SIGTERM', async () => {
  stopping = true;
  try { await browser?.disconnect().catch(()=>{}); await terminateOwned('SIGTERM'); await sleep(1500); await terminateOwned('SIGKILL'); }
  finally { process.exit(143); }
});
try {
  await fs.mkdir(root, {mode:0o700}); await fs.mkdir(path.dirname(published)); await fs.mkdir(profile,{recursive:true}); await fs.mkdir(home);
  const copy = {recursive:true,verbatimSymlinks:true,mode:fs.constants.COPYFILE_FICLONE};
  await fs.cp(input,old,copy); await fs.cp(input,published,copy);
  if (scenario !== 'success') {
    const entry = path.join(macApplication(published),'src/main/main.cjs');
    await fs.rename(entry, entry.replace('main.cjs','native-original-main.cjs'));
    await fs.writeFile(entry, scenario === 'failure' ? "require('electron').app.whenReady().then(()=>require('electron').app.exit(17));\n" : "if(process.env.NOZELI_NATIVE_RECOVERY==='1')require('./native-original-main.cjs');else require('electron').app.whenReady().then(()=>setInterval(()=>{},1000));\n");
  }
  await stamp(old,OLD); await stamp(published,NEW);
  await assert.rejects(validateMacPackage(published, OLD, commit), /metadata/);
  await assert.rejects(validateMacPackage(published, NEW, 'd'.repeat(40)), /GitHub release tag/);
  const escaped = path.join(published, 'Contents/Resources/escape');
  await fs.symlink(out, escaped);
  await assert.rejects(validateMacPackage(published, NEW, commit), /link escapes/);
  await fs.unlink(escaped);
  const renderer = path.join(macApplication(published), 'dist/renderer/app.js'), rendererBytes = await fs.readFile(renderer);
  await fs.appendFile(renderer, '\n/* deliberate native signature tamper */\n');
  await assert.rejects(validateMacPackage(published, NEW, commit));
  await fs.writeFile(renderer, rendererBytes);
  const permissions = (await fs.stat(old)).mode & 0o777;
  await fs.chmod(old, 0o555);
  await assert.rejects(detectMacInstallation(macApplication(old)), /EACCES|EROFS/);
  await fs.chmod(old, permissions);
  await fs.chmod(old, 0o775);
  await assert.rejects(detectMacInstallation(macApplication(old)), /Unsafe updater directory/);
  await fs.chmod(old, permissions);
  checks.push('Native sealed package refuses wrong version/tag commit, escaping bundle link, tampered signed renderer and nonwritable/unsafe application permissions');
  const archive = path.join(out,`Nozeli-${NEW}-macos-arm64.zip`);
  execFileSync('/usr/bin/ditto',['-c','-k','--sequesterRsrc','--keepParent',published,archive]);
  // Actual ditto ZIP parser/signature consumer, including framework symlinks.
  const unpacked = path.join(out,'unpacked'); await extractMacPackage(archive,unpacked,NEW,undefined,commit); await fs.rm(unpacked,{recursive:true});
  const payload = await fs.readFile(archive), checksum = crypto.createHash('sha256').update(payload).digest('hex');
  let releaseFeed; const feedReady = new Promise(resolve => { releaseFeed = resolve; });
  server = http.createServer((request,response) => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    if (request.url.startsWith('/releases')) void feedReady.then(() => response.end(JSON.stringify([{tag_name:'v'+NEW, assets:[{name:path.basename(archive),size:payload.length,browser_download_url:origin+'/archive'},{name:'SHA256SUMS.txt',size:160,browser_download_url:origin+'/sums'}]}])));
    else if (request.url === '/git/ref/tags/v'+NEW) response.end(JSON.stringify({ref:'refs/tags/v'+NEW,object:{type:'commit',sha:commit}}));
    else if (request.url === '/sums') response.end(checksum+'  '+path.basename(archive)+'\n');
    else if (request.url === '/archive') { response.setHeader('Content-Length',payload.length); response.end(payload); }
    else { response.statusCode=404;response.end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const reserve = http.createServer(); await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve)); debugPort=reserve.address().port; await new Promise(resolve=>reserve.close(resolve));
  Object.assign(env,{HOME:home,USERPROFILE:home,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:configurationRoot,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(debugPort),NOZELI_TEST_UPDATE_FEED:'http://127.0.0.1:'+server.address().port+'/releases'});
  const sentinel=path.join(profile,'update-preservation-sentinel.txt'); await fs.writeFile(sentinel,'User data survives update and rollback.\n');
  child=spawn(path.join(old,'Contents/MacOS/Nozeli'),[],{cwd:root,env,detached:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>{logs+=chunk;}); child.stderr.on('data',chunk=>{logs+=chunk;});
  const childExit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  let page=await connect(); const firstEndpoint=browser.wsEndpoint(); await openSettings(page); releaseFeed();
  await waitFor(async()=>{const result=await page.evaluate(()=>window.nozeli.invoke('update.status',{}));assert.equal(result.ok,true,JSON.stringify(result));if(['error','unsupported'].includes(result.value.phase))throw Error(JSON.stringify(result.value));return result.value.phase==='waiting-idle';},'Mac staged update');
  assert.equal((await json(path.join(old,'Contents/Resources/RELEASE.json'))).version,OLD);
  checks.push('Real old renderer settings modal blocks staged update; idle guard is not replaced');
  await install(page);await waitFor(async()=>{const result=await page.evaluate(()=>window.nozeli.invoke('update.status',{})).catch(()=>null);if(result?.ok&&result.value.phase==='error')throw Error(JSON.stringify(result.value));return child.exitCode!==null||child.signalCode;},'old app safe update exit',60000);assert.deepEqual(await childExit,{code:0,signal:null});
  await browser.disconnect(); browser=null;
  const journalFile=path.join(profile,'updates/handoff.json');
  if(scenario==='interrupted') {
    const pending=await waitFor(async()=>{const value=await json(journalFile).catch(()=>null);return value?.phase==='awaiting-health'?value:null;},'promoted unacknowledged app');
    const stamp=await processStamp(pending.helperIdentity.pid); assert.equal(stamp,pending.helperIdentity.start); process.kill(pending.helperIdentity.pid,'SIGKILL');
    // Durable fixture for a second helper interruption at its ready boundary.
    // The first exchange and helper death above are real, not injected success.
    await atomicJson(journalFile, {...pending, recovery:true, phase:'helper-ready'});
    await terminateOwned('SIGTERM'); await sleep(1500);
    // Same sealed app now starts its real main and consumes the durable recovery journal.
    child=spawn(path.join(old,'Contents/MacOS/Nozeli'),[],{cwd:root,env:{...env,NOZELI_NATIVE_RECOVERY:'1'},detached:true,stdio:'ignore'});
    page=await connect(firstEndpoint); await openSettings(page);
    await page.evaluate(()=>window.nozeli.invoke('update.check',{}));
    await install(page); await browser.disconnect(); browser=null;
  }
  const handoff=await waitFor(async()=>{const value=await json(journalFile).catch(()=>null);return ['installed','rolled-back','error'].includes(value?.phase)?value:null;},'startup health or rollback');
  assert.equal(handoff.phase,scenario==='success'?'installed':'rolled-back',JSON.stringify(handoff));
  assert.equal((await json(path.join(old,'Contents/Resources/RELEASE.json'))).version,scenario==='success'?NEW:OLD);
  assert.equal(await fs.readFile(sentinel,'utf8'),'User data survives update and rollback.\n');
  if(scenario==='success') {
    const receipt=await json(path.join(profile,'updates/health-'+handoff.token+'.json'));newPid=receipt.pid;assert.equal(receipt.version,NEW);
    assert.equal((await json(path.join(handoff.backup,'Contents/Resources/RELEASE.json'))).version,OLD);
    page=await connect(firstEndpoint); assert.equal((await page.evaluate(()=>window.nozeli.invoke('update.status',{}))).value.currentVersion,NEW);
    if(await page.$('#configuration-setup[open]'))await page.click('#configuration-cancel');
    execFileSync('/usr/bin/osascript',['-e','tell application '+JSON.stringify(old)+' to quit']);
    await waitFor(async()=>!(await processStamp(newPid)),'new app normal native Quit event shutdown',30000);
    checks.push('Install UI -> normal original exit -> independent Node helper -> atomic .app swap -> real new renderer health -> normal native Quit event');
  } else {
    page = await connect(firstEndpoint);
    assert.equal((await page.evaluate(()=>window.nozeli.invoke('update.status',{}))).value.currentVersion, OLD);
    checks.push('Real helper '+scenario+' restores and launches the old signed .app renderer without rolling back persistent user data');
    execFileSync('/usr/bin/osascript',['-e','tell application '+JSON.stringify(old)+' to quit']);
  }
} catch(failure) { error=failure.stack;console.error(error);console.error(logs.slice(-12000));const handoff=await json(path.join(profile,'updates/handoff.json')).catch(()=>null);console.error('Final update phase:',handoff?.phase,handoff?.message);const helperLogs={};for(const file of await fs.readdir(path.join(profile,'updates')).catch(()=>[]))if(/^helper-[a-f0-9]+\.log$/.test(file)){helperLogs[file]=(await fs.readFile(path.join(profile,'updates',file),'utf8')).slice(-12000);console.error(helperLogs[file]);}await fs.writeFile(path.join(out,'update-status.json'),JSON.stringify({status:await json(path.join(profile,'updates/status.json')).catch(()=>null),handoff,helperLogs})); }
finally {
  await browser?.disconnect().catch(()=>{}); await terminateOwned('SIGTERM'); await sleep(1500); await terminateOwned('SIGKILL');
  child?.stdout?.destroy();child?.stderr?.destroy();child?.unref();
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await fs.writeFile(path.join(out,'main.log'),logs);
  const report={ok:!error,scenario,checks,error,scope:'Fresh full Nozeli.app copies with synthetic versions and ad-hoc fixture seals; success runs unchanged full main/renderer; failure/interruption explicitly inject startup failure only. Not public-release signing or old-Mac bootstrap qualification.'};
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,...report},null,2));process.exitCode=error?1:0;
}
