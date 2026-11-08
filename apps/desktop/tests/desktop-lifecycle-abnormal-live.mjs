// Parent-only serial smoke, real Linux installed app; no Inspector/runtime hooks.
// NOZELI_TEST_BINARY=/absolute/nozeli node tests/desktop-lifecycle-abnormal-live.mjs
// POSIX permissions stop a confirmed reset after metadata/local deletion but before
// recovery-directory deletion. SIGKILL then cold restart exercises persisted facts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';

assert.equal(process.platform,'linux');
assert.notEqual(process.getuid(),0,'Permission fault requires an unprivileged Linux user');
const source=path.resolve(import.meta.dirname,'..'),binary=process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-lifecycle-abnormal-')),home=path.join(out,'home'),config=path.join(out,'config'),profile=path.join(config,'desktop');
await fs.mkdir(home);
const host=new DesktopHost(profile),projects={};
for(const name of ['interrupted','ownership','effects','legacy','other']){
 const root=path.join(out,name);await fs.mkdir(root);await fs.writeFile(path.join(root,'original.txt'),name+' ORIGINAL\n');
 const p=(await host.pick(root)).project;projects[name]=await host.storage.requireRegistered(p.id);
 await host.storage.putLocal(p.id,'sentinel',{name});await host.storage.putRecovery(p.id,'sentinel',{name});
}
const p=projects.interrupted,storageRoot=host.storage.root,oldLocal=path.join(storageRoot,'instances',p.instanceId),oldRecovery=path.join(storageRoot,'recovery',p.instanceId),recoveryParent=path.dirname(oldRecovery);
// A crash-era journal with possible effects must not be replayed by an open.
const effects=projects.effects,effectOperation='unknown-effects-operation';
const effectHold=host.storage.holdProject(effects.id,{operationId:effectOperation,instanceId:effects.instanceId,action:'remove',root:effects.root});effectHold.needsStopCheck=true;await host.storage.persistProjectHold(effects.id,effectHold);
await host.storage.putRecovery(effects.id,'lifecycle:'+effectOperation,{schema:1,projectId:effects.id,instanceId:effects.instanceId,operationId:effectOperation,action:'remove',root:effects.root,phase:'needs-attention',failedPhase:'source-gone',error:{code:'STORAGE_RESULT_UNKNOWN',message:'Synthetic unknown effects'}});
// An old incomplete permanent-reset receipt lacks authority to resume deletion.
const legacy=projects.legacy,legacyOperation='legacy-reset-no-ownership';
const legacyHold=host.storage.holdProject(legacy.id,{operationId:legacyOperation,instanceId:legacy.instanceId,action:'reset-project',root:legacy.root});legacyHold.needsStopCheck=true;await host.storage.persistProjectHold(legacy.id,legacyHold);
await host.storage.db.request(host.storage.catalog,'put',{collection:'permanent_resets',id:legacyOperation,value:{schema:1,projectId:legacy.id,operationId:legacyOperation,root:legacy.root,phase:'deleting',relatedProjectIds:[legacy.id]}});
const unowned=path.join(projects.ownership.root,'.nozeli-reset-unknown');await fs.mkdir(unowned);await fs.writeFile(path.join(unowned,'do-not-delete'),'UNKNOWN OWNER\n');
await host.storage.db.close();
const report={ok:false,out,binary,checks:[],fault:'chmod recovery parent 0500; real EACCES after earlier targets deleted; SIGKILL; cold IPC reopen',scope:'Synthetic profiles/projects only; no model/provider configuration; no runtime hooks'};
let child,exited,browser,shell,log='',launchError;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+45000;while(Date.now()<end){if(launchError)throw launchError;if(child?.exitCode!==null||child?.signalCode)throw Error('Owned app exited: '+log);const value=await fn();if(value)return value;await pause(60);}throw Error('Timeout '+label);}
async function exists(file){try{await fs.lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function raw(op,payload={}){return shell.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});}
async function call(op,payload={}){const result=await raw(op,payload);assert(result.ok,op+': '+JSON.stringify(result));return result.value;}
async function launch(){
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
 Object.assign(env,{HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_STATE_HOME:path.join(home,'.local/state'),XDG_CACHE_HOME:path.join(home,'.cache'),NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
 launchError=null;child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(source,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':'wayland'))],{cwd:out,env,stdio:['ignore','pipe','pipe']});child.on('error',error=>launchError=error);exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'shell');
 if(await shell.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell.click('#configuration-cancel');
}
async function kill(){child.kill('SIGKILL');assert.deepEqual(await Promise.race([exited,pause(15000).then(()=>null)]),{code:null,signal:'SIGKILL'});await browser.disconnect();browser=null;child=null;}
async function otherUsable(){const other=projects.other;assert.equal((await call('project.open',{projectId:other.id})).project.id,other.id);await shell.click('[data-project-id="'+other.id+'"]');await shell.waitForSelector('#file-tree [data-path="original.txt"]');assert.equal(await fs.readFile(path.join(other.root,'original.txt'),'utf8'),'other ORIGINAL\n');}
try{
 await launch();
 const unknown=await raw('project.lifecycle.preview',{projectId:projects.ownership.id,action:'reset-project'});assert.equal(unknown.ok,false);assert.equal(unknown.error.code,'PROJECT_RESET_CONFLICT');assert.equal(await fs.readFile(path.join(unowned,'do-not-delete'),'utf8'),'UNKNOWN OWNER\n');report.checks.push('Unknown temporary-directory ownership refuses destructive preview and preserves its bytes');
 const unsafe=await raw('project.open',{projectId:effects.id});assert.equal(unsafe.ok,false);assert.equal(unsafe.error.code,'PROJECT_RECOVERY_UNSAFE');
 const missing=await raw('project.open',{projectId:legacy.id});assert.equal(missing.ok,false);assert.equal(missing.error.code,'PROJECT_RESET_OWNERSHIP_UNKNOWN');
 for(const row of [effects,legacy]){assert.equal(await fs.readFile(path.join(row.root,'original.txt'),'utf8'),(row===effects?'effects':'legacy')+' ORIGINAL\n');assert(await exists(path.join(storageRoot,'instances',row.instanceId)));assert(await exists(path.join(storageRoot,'recovery',row.instanceId)));}
 await otherUsable();report.checks.push('Unknown effects and legacy reset ownership block actual project.open without deletion; another project remains usable');
 const preview=await call('project.lifecycle.preview',{projectId:p.id,action:'reset-project'});
 await fs.chmod(recoveryParent,0o500);
 const interrupted=await raw('project.lifecycle.execute',{token:preview.token,confirmPermanentDelete:true});assert.equal(interrupted.ok,false);assert.equal(interrupted.error.code,'EACCES',JSON.stringify(interrupted));
 assert.equal(await exists(p.metadataRoot),false,'metadata was actually deleted');assert.equal(await exists(oldLocal),false,'local directory was actually deleted before fault');assert.equal(await exists(oldRecovery),true,'permission fault retains recovery directory identity');
 report.interruptedError=interrupted.error;await kill();await fs.chmod(recoveryParent,0o700);
 const stopped=new DesktopHost(profile);await stopped.storage.ready();const receipts=await stopped.storage.db.request(stopped.storage.catalog,'list',{collection:'permanent_resets'});const receipt=receipts.map(row=>row.value).find(row=>row.projectId===p.id);assert(receipt);assert.equal(receipt.phase,'deleting');assert.equal(receipt.error.code,'EACCES');report.operationId=receipt.operationId;report.expectedNewProjectId=receipt.newProjectId;await stopped.storage.db.close();
 // A genuinely replaced target must remain blocked: never relax inode checks
 // to compensate for the startup-created directory regression.
 await fs.mkdir(oldLocal);await fs.writeFile(path.join(oldLocal,'replacement-owner'),'REPLACED TARGET\n');const replacementStat=await fs.stat(oldLocal);
 await launch();const replaced=await raw('project.open',{projectId:p.id});assert.equal(replaced.ok,false);assert.equal(replaced.error.code,'PROJECT_IDENTITY_CONFLICT');assert.equal(await fs.readFile(path.join(oldLocal,'replacement-owner'),'utf8'),'REPLACED TARGET\n');assert.equal((await fs.stat(oldLocal)).ino,replacementStat.ino);assert.equal(await exists(oldRecovery),true);await otherUsable();await kill();
 await fs.rename(oldLocal,path.join(out,'preserved-replacement-target'));report.checks.push('Cold reset refuses a genuinely replaced local directory without deleting its bytes or other recovery targets');
 await launch();assert.equal(await exists(oldLocal),false,'cold startup must not recreate deleted local target before recovery IPC');const recovered=await raw('project.open',{projectId:p.id});assert(recovered.ok,'exact owned reset should resume after permission restoration: '+JSON.stringify(recovered));assert.equal(recovered.value.project.id,receipt.newProjectId);
 assert.equal(await exists(oldLocal),false);assert.equal(await exists(oldRecovery),false);assert.equal(await fs.readFile(path.join(p.root,'original.txt'),'utf8'),'interrupted ORIGINAL\n');
 await otherUsable();report.checks.push('Real partial deletion survives SIGKILL; cold IPC open finishes only the original operation/new identity; old local/recovery directories are not recreated');
 await call('session.requestClose');assert.deepEqual(await Promise.race([exited,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;await browser.disconnect();browser=null;
 await launch();assert.equal((await call('project.open',{projectId:receipt.newProjectId})).project.id,receipt.newProjectId);await otherUsable();assert.equal(await exists(oldLocal),false);assert.equal(await exists(oldRecovery),false);report.checks.push('Second cold start opens fresh identity and other project without recreating deleted recovery directories');
 await call('session.requestClose');assert.deepEqual(await Promise.race([exited,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;await browser.disconnect();browser=null;report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{await fs.chmod(recoveryParent,0o700).catch(()=>{});if(child?.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await exited;}await browser?.disconnect().catch(()=>{});await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
