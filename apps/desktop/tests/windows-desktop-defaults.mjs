// Actual Windows entry/settings/independent setup and whole-process restart.
// Source checkouts are check-only on Windows x64: update checks run (loopback
// test feed), state lives in the native private updater record namespace, and
// installation authority is absent. A forged Linux/mac-style health handoff
// injected through the environment must be explicitly rejected: no receipt,
// no crash. Preexisting unsafe updater files (enabled preferences, unfinished
// foreign handoff, damaged status) survive byte-for-byte and never activate.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';

// The preexisting unsafe updater files live under the product's native private
// directory: its DACL must not grant any broad non-owner principal write
// access (plain fs.writeFile here only works because the private parent
// inherits the owner-only ACL to same-user test writers).
function assertPrivateUserOnlyAcl(directory){
 const escaped=directory.replaceAll("'", "''");
 const script=`(Get-Acl -LiteralPath '${escaped}').Access | ForEach-Object { "{0}|{1}|{2}|{3}" -f $_.IdentityReference, $_.FileSystemRights, $_.AccessControlType, $_.IsInherited }`;
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:30000,windowsHide:true});
 assert.ifError(result.error);
 const rows=(result.stdout||'').split(/\r?\n/).map(line=>/^([^|]+)\|([^|]+)\|([^|]+)\|(True|False)$/.exec(line.trim())).filter(Boolean).map(match=>({identity:match[1].trim(),rights:match[2],access:match[3],inherited:match[4]==='True'}));
 assert(rows.length>0,'native private updater directory ACL must be readable: '+directory);
 const broad=rows.filter(row=>row.access==='Allow'&&/\\Users$|Everyone|Authenticated Users/i.test(row.identity)&&/Write|Modify|FullControl/i.test(row.rights));
 assert.deepEqual(broad,[],`native private updater directory must not grant broad non-owner write: ${JSON.stringify(broad)}`);
 return rows.length;}

const [out,application,executable]=process.argv.slice(2),root=path.resolve(application||path.join(import.meta.dirname,'..')),packaged=Boolean(executable);
assert.equal(process.platform,'win32');assert(out&&path.isAbsolute(out),'fresh absolute evidence output required');await fs.mkdir(out);
const config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),updates=path.join(profile,'updates'),receipt=path.join(out,'health-'+'a'.repeat(64)+'.json');
const requests=[],checks=[],errors=[],runs=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const server=http.createServer((req,res)=>{requests.push({url:req.url,method:req.method});res.setHeader('content-type','application/json');res.end('[]');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const feed='http://127.0.0.1:'+server.address().port+'/releases';let child,browser,shell,exited,stage='',log='';
async function until(fn,label,ms=30000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error(log);await pause(80);}throw Error('Timed out: '+label);}
async function raw(op,payload={}){return shell.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});}
async function invoke(op,payload={}){const result=await raw(op,payload);assert.equal(result.ok,true,op+': '+JSON.stringify(result));return result.value;}
// Behavior only, no policy wording pinned: a Windows source checkout must
// support checks (no UPDATE_PLATFORM_UNSUPPORTED) while holding no
// installation authority, and must never leak POSIX-only internals.
function sourceCheckOnly(value){assert.equal(value.checksSupported,true);assert.equal(value.reason,null);assert.equal(value.supported,false);assert(!value.message.includes('getuid'));return value;}
function onlyReleaseListRequests(){for(const request of requests)assert(request.url.split('?')[0]==='/releases','source checkout must only enumerate the release list, never fetch assets: '+request.url);}
async function noReceipt(){await assert.rejects(fs.lstat(receipt),{code:'ENOENT'});const updateFiles=await fs.readdir(updates).catch(()=>[]);assert(!updateFiles.some(name=>/^health-/.test(name)),'forged health must not produce a receipt: '+updateFiles.join(','));}
async function launch(){
 const port=await new Promise(resolve=>{const socket=net.createServer();socket.listen(0,'127.0.0.1',()=>{const port=socket.address().port;socket.close(()=>resolve(port));});});
 const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_SHOT_DIR:out,NOZELI_TEST_UPDATE_FEED:feed,NOZELI_UPDATE_RECEIPT:receipt,NOZELI_UPDATE_TOKEN:'a'.repeat(64)});
 const command=executable||createRequire(import.meta.url)('electron');child=spawn(command,packaged?[]:[path.join(root,'src/main/main.cjs')],{cwd:out,env,stdio:['ignore','pipe','pipe']});const run={pid:child.pid,command,systemOnlyPath:env.Path,enabledLoopbackUpdaterFixture:true,forgedHealthReceipt:receipt};runs.push(run);
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'ready shell');shell.on('pageerror',error=>errors.push(error.message));
 run.nativeWindows=await invoke('workspace.windows.list');assert(run.nativeWindows.some(win=>win.visible));await invoke('session.resize',{width:1280,height:900});
 sourceCheckOnly(await invoke('update.status'));
}
async function close(){void raw('session.requestClose').catch(()=>{});const exit=await Promise.race([exited,pause(15000).then(()=>null)]);runs.at(-1).exit=exit;assert.deepEqual(exit,{code:0,signal:null});await browser.disconnect();browser=null;}
async function updateUI({active=true,captureOnly=false}={}){
 await shell.click('#open-settings');await shell.click('[data-settings-section="settings-update"]');
 if(active)await shell.waitForFunction(()=>document.querySelector('#settings-update button')?.disabled===false,{timeout:10000});
 const state=await shell.$eval('#settings-update',node=>({text:node.innerText,checkbox:[...node.querySelectorAll('input[type="checkbox"]')].map(input=>({disabled:input.disabled,checked:input.checked})),buttons:[...node.querySelectorAll('button')].map(button=>({text:button.textContent,disabled:button.disabled,hidden:button.hidden}))}));
 assert(!state.text.includes('getuid'));assert(!state.text.includes('Linux'));
 if(!captureOnly){
  // Check-only source surface: the check control is usable, installation is
  // not offered, and the toggle reflects the enabled preference.
  assert(state.checkbox.length===1&&!state.checkbox[0].disabled&&state.checkbox[0].checked);
  assert(state.buttons.find(button=>button.text==='立即检查更新')?.disabled===false);
  assert(!state.buttons.some(button=>button.text==='安装并重启'&&!button.disabled&&!button.hidden),'source checkout must not offer installation');
 }
 return state;}
try{
 stage='visible startup with forged health handoff rejected';await launch();assert.equal((await invoke('config.status')).initialized,false);if(await shell.$eval('#configuration-setup',node=>node.open))await shell.click('#configuration-cancel');await noReceipt();checks.push('actual Windows main entry stays visible and healthy with a forged update health handoff in the environment; the check-capable source checkout explicitly rejects it: no receipt, no handoff, no crash');
 stage='real settings and IPC check-only boundary';const firstUI=await updateUI();const enabled=await invoke('update.preferences',{enabled:true});assert.equal(enabled.enabled,true);const checked=sourceCheckOnly(await invoke('update.check'));assert(!['installing','downloading','staging','promoting'].includes(checked.phase));await pause(500);onlyReleaseListRequests();assert(requests.length>=1,'an explicit check must actually contact the configured feed');const updateFiles=await fs.readdir(updates).catch(()=>[]);assert(updateFiles.includes('preferences.json'),'preferences must persist into the native private updater record namespace: '+updateFiles.join(','));await noReceipt();await shell.screenshot({path:path.join(out,'update-settings.png')});await shell.click('#settings-close');checks.push('actual update settings keep the check control usable without offering installation; explicit IPC check contacts only the release list and persists preferences into the native private updater state; direct IPC cannot start a download, stage or activation');
 stage='independent configuration through actual UI';await shell.click('#open-settings');await shell.click('[data-settings-section="settings-general"]');await shell.click('#settings-initialize');await shell.waitForSelector('#configuration-setup[open]',{visible:true});await shell.click('#configuration-independent');await shell.waitForFunction(()=>!document.querySelector('#configuration-setup').open);const setup=await invoke('config.status');assert.equal(setup.initialized,true);assert.equal(setup.choice,'independent');assert.equal(setup.apiKeyImportSupported,false);
 const journal=JSON.parse(await fs.readFile(path.join(config,'migrations/setup-v1.json'),'utf8'));assert.equal(journal.phase,'complete');assert.match(journal.stageIdentity,/^[a-f0-9]{16}:[a-f0-9]{32}$/);await assert.rejects(fs.lstat(journal.stage),{code:'ENOENT'});assert.deepEqual((await invoke('project.recent')).projects,[]);checks.push('actual independent setup button completes the shared native CAS journal and removes only the original empty stage; no project/provider/model session is created');
 await close();
 stage='existing unsafe updater files and full restart';const aclRules=assertPrivateUserOnlyAcl(updates);const originals={'preferences.json':'{"enabled":true,"external":"retained"}\n','handoff.json':'{"phase":"awaiting-health","external":"retained"}\n','status.json':'{damaged retained state'};for(const [name,bytes]of Object.entries(originals))await fs.writeFile(path.join(updates,name),bytes);
 const requestsBefore=requests.length;
 await launch();assert.equal(await shell.$eval('#configuration-setup',node=>node.open),false);assert.deepEqual(await invoke('config.status'),setup);const secondUI=await updateUI({captureOnly:true});const damaged=await invoke('update.check');assert.equal(damaged.phase,'error','unsafe preexisting updater state must disable updates, not reset it');assert.equal(damaged.enabled,false);assert(!damaged.message.includes('getuid'));assert.equal(requests.length,requestsBefore,'damaged state must not turn network access back on');assert.deepEqual((await fs.readdir(updates)).sort(),Object.keys(originals).sort());for(const [name,bytes]of Object.entries(originals))assert.equal(await fs.readFile(path.join(updates,name),'utf8'),bytes);await noReceipt();await shell.click('#settings-close');await close();checks.push('guard refusal only (not an update-implementation pass): whole-process restart retains completed independent setup, refuses the unsafe preexisting updater state (enabled preferences, unfinished foreign handoff, damaged status, all inside the native private user-only directory — '+aclRules+' ACL rules with no broad non-owner write) by disabling updates without resetting or rewriting any file byte-for-byte, contacts no endpoint, and still rejects the forged health receipt');
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:true,checks,errors,out,runs,packaged,application:root,releaseRequests:requests,firstUI,secondUI},null,2));console.log(JSON.stringify({ok:true,checks,out},null,2));
} catch(error) {
 await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
 const diagnostics=await shell?.evaluate(()=>({text:document.body.innerText,dialogs:[...document.querySelectorAll('dialog')].map(node=>({id:node.id,open:node.open,text:node.innerText}))})).catch(()=>null);
 await fs.writeFile(path.join(out,'failure-page.json'),JSON.stringify(diagnostics??null,null,2));
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:false,stage,error:error.stack,checks,errors,out,runs,packaged,application:root,releaseRequests:requests},null,2));
 throw error;
}
finally{await fs.writeFile(path.join(out,'main.log'),log);await browser?.disconnect();if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);}await new Promise(resolve=>server.close(resolve));}
