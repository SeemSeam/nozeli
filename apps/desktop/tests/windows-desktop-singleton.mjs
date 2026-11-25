// Actual main entry, Electron singleton IPC and Windows process lifecycle.
// Synthetic account scope only; never acquires the user's product singleton.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {security} from './fixtures/windows-security.mjs';

const [out,application,executable,peerApplication,peerExecutable]=process.argv.slice(2);
assert.equal(process.platform,'win32');assert(out&&path.isAbsolute(out),'fresh absolute output required');await fs.mkdir(out);
const root=path.resolve(application||path.join(import.meta.dirname,'..')),command=executable||createRequire(import.meta.url)('electron');
const account=path.join(out,'account'),singleton=path.join(account,'.Nozeli/application-singleton'),project=path.join(out,'项目 空格');await fs.mkdir(project);
await fs.writeFile(path.join(project,'first.txt'),'First routed file 中文.\n');await fs.writeFile(path.join(project,'second.txt'),'Second relative routed file.\n');
await fs.writeFile(path.join(project,'peer.txt'),'Different executable routed file.\n');
const runs=[],processes=[],checks=[],errors=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));let current,browser,shell,stage='';
function environment(label){
 const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
 env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');const config=path.join(out,'profiles',label,'.Nozeli');
 Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_TEST_SINGLETON_ROOT:singleton,NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:path.join(config,'desktop'),NOZELI_HIDDEN:'0',NOZELI_SHOT_DIR:out});return env;
}
function start(label,args=[],{cwd=out,port,peer=false}={}){
 const env=environment(label);if(port)env.NOZELI_DEBUG_PORT=String(port);
 const binary=peer?peerExecutable:command,appRoot=peer?peerApplication:root,isPackaged=peer?path.basename(binary).toLowerCase()!=='electron.exe':Boolean(executable);
 const child=spawn(binary,isPackaged?args:[path.join(appRoot,'src/main/main.cjs'),...args],{cwd,env,stdio:['ignore','pipe','pipe']});
 const run={label,pid:child.pid,command:binary,cwd,args,config:env.NOZELI_CONFIG_ROOT,singleton,systemOnlyPath:env.Path,log:''};runs.push(run);
 for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>run.log+=bytes);
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{run.exit={code,signal};resolve(run.exit);});});const process={child,run,exited};processes.push(process);return process;
}
async function until(fn,label,ms=35000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;if(current?.run.exit)throw Error(JSON.stringify(current.run));await pause(80);}throw Error('Timed out: '+label);}
async function exitOf(process,expected=0){const value=await Promise.race([process.exited,pause(20000).then(()=>{throw Error('Process did not exit: '+process.run.label);})]);if(expected!==null)assert.deepEqual(value,{code:expected,signal:null},process.run.log);return value;}
async function invoke(op,payload={},target=shell){const result=await target.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert.equal(result.ok,true,JSON.stringify(result));return result.value;}
async function launch(label){
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});current=start(label,[],{port});
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'debug endpoint');
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'actual shell');
 browser.on('targetcreated',async target=>{const page=await target.page();page?.on('pageerror',error=>errors.push(error.message));});shell.on('pageerror',error=>errors.push(error.message));
 await shell.evaluate(()=>{window.__singletonWakeCount=0;nozeli.subscribe('external.open',()=>window.__singletonWakeCount++);});
 if(await shell.$eval('#configuration-setup',node=>node.open))await shell.click('#configuration-cancel');await invoke('session.resize',{width:1280,height:900});assert((await invoke('workspace.windows.list')).some(win=>win.visible));
}
async function document(rel,text){const page=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(rel=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath===rel,rel).catch(()=>false))return page;},'routed document '+rel);await page.waitForFunction(text=>window.__nozeliInput?.text?.().includes(text),{},text);return page;}
async function close(){void invoke('session.requestClose').catch(()=>{});await exitOf(current);await browser.disconnect();browser=null;}
async function absentProfile(process){await assert.rejects(fs.lstat(process.run.config),{code:'ENOENT'});}
async function onlyFixtureProject(){assert.deepEqual((await invoke('project.recent')).projects.map(row=>row.rootDisplay),[project],'launch routing must never register its executable/source entry as a project');}
try{
 stage='primary native singleton';await launch('primary');const acl=security('inspect',singleton);assert.equal(acl.protected,true);assert.equal(acl.owner,acl.currentSid);assert(acl.rules.every(rule=>[acl.currentSid,'S-1-5-18','S-1-5-32-544'].includes(rule.sid)));checks.push('actual visible main entry acquires a protected native private synthetic account singleton before profile initialization; independent ACL inspection confirms the account owner and restricted principals');
 stage='secondary absolute routing';const secondary=start('secondary',[path.join(project,'first.txt')]);await exitOf(secondary);await absentProfile(secondary);const first=await document('first.txt','First routed file 中文.');await onlyFixtureProject();
 await first.bringToFront();await first.evaluate(()=>window.__nozeliInput.focus());await first.keyboard.down('Control');await first.keyboard.press('End');await first.keyboard.up('Control');await first.keyboard.type(' Retained local draft');const draft=await first.evaluate(()=>window.__nozeliInput.text());checks.push('secondary exits zero without creating its different profile and routes the absolute Unicode/spaced file through actual Electron second-instance IPC');
 stage='relative routing retains first surface';const relative=start('relative',['second.txt'],{cwd:project});await exitOf(relative);await absentProfile(relative);await document('second.txt','Second relative routed file.');await onlyFixtureProject();assert.equal(await first.evaluate(()=>window.__nozeliInput.text()),draft);assert.equal(await fs.readFile(path.join(project,'first.txt'),'utf8'),'First routed file 中文.\n');checks.push('relative file arguments use the launching process cwd and keep the existing document and unsaved text intact');
 stage='root identity pin';await assert.rejects(fs.rename(singleton,singleton+'-moved'),error=>['EPERM','EACCES','EBUSY'].includes(error.code));checks.push('independent rename cannot replace the singleton directory while the primary owns its native directory pin');
 stage='concurrent secondaries';const burst=[0,1,2].map(n=>start('burst-'+n));await Promise.all(burst.map(async process=>{await exitOf(process);await absentProfile(process);}));await onlyFixtureProject();assert.equal(current.child.exitCode,null);checks.push('three concurrent secondary processes all exit zero without creating their distinct profiles or replacing the original primary');
 if(peerExecutable){stage='different executable path contention';const peer=start('peer',[path.join(project,'peer.txt')],{peer:true});await exitOf(peer);await absentProfile(peer);await document('peer.txt','Different executable routed file.');await onlyFixtureProject();assert.equal(await first.evaluate(()=>window.__nozeliInput.text()),draft);checks.push('another executable path and package form shares the synthetic account lock and forwards a previously unopened file with the original sender argv/cwd; only the synthetic project is registered');}
 stage='helper entry bypass';for(const flag of ['--nozeli-terminal-client','--nozeli-handoff','--nozeli-document']){const helper=start(flag.slice(2),[flag]);await exitOf(helper,1);await absentProfile(helper);assert.equal(current.child.exitCode,null);}checks.push('all three helper dispatch entries bypass the product singleton and reject missing payloads with exit one without initializing a product profile');
 await shell.screenshot({path:path.join(out,'routed-shell.png')});stage='normal exit takeover';await close();await launch('normal-successor');checks.push('a new actual main process acquires the same singleton after normal primary exit');
 stage='crash and takeover';current.child.kill('SIGKILL');const crash=await exitOf(current,null);assert(crash.code!==0||crash.signal);await browser.disconnect();browser=null;await launch('crash-successor');await close();checks.push('after terminating only the harness-owned primary process, another actual main process acquires the original singleton and closes normally');
 stage='existing ACL drift preserved';const drift=security('add-write',singleton),refused=start('acl-refused');await exitOf(refused,1);await absentProfile(refused);assert.deepEqual(security('inspect',singleton),drift);checks.push('after shutdown a broadened existing singleton ACL is refused before profile creation and remains unchanged for explicit recovery');
 assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:true,stage,checks,errors,application:root,packaged:Boolean(executable),peerApplication,scope:'synthetic account singleton and launch routing; not real-account coexistence or managed/draft crash recovery',acl,runs},null,2));console.log(JSON.stringify({ok:true,checks,out},null,2));
}catch(error){
 const pages=[];for(const page of await browser?.pages()??[])pages.push(await page.evaluate(()=>({scope:window.__workspaceScope,ready:window.__nozeliReady,wakes:window.__singletonWakeCount,text:document.body.innerText.slice(-12000)})).catch(error=>({error:error.message})));
 // Consume at most one pending request only after the run has already failed;
 // never use this diagnostic to drive the successful product journey.
 const pending=await shell?.evaluate(()=>nozeli.invoke('session.takeOpen')).catch(error=>({error:error.message}));
 await fs.writeFile(path.join(out,'failure-state.json'),JSON.stringify({pages,pending},null,2));await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:false,stage,error:error.stack,checks,errors,runs},null,2));throw error;
}
finally{await browser?.disconnect();for(const process of processes)if(process.child.exitCode===null&&!process.run.exit){process.child.kill('SIGKILL');await process.exited;}for(const run of runs)await fs.writeFile(path.join(out,run.label+'.log'),run.log);}
