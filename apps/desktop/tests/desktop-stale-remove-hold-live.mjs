// Real-Electron regression for the stale persisted remove hold (field shape:
// catalog lifecycle_holds action=remove + recovery journal lifecycle:<op>
// phase needs-attention, failedPhase prepared, PROJECT_LIFECYCLE_ACTIVE).
//
// Scenario, synthetic data only:
//   run 1  register a synthetic project, start real native OMP residents,
//          persist a draft, then SIGKILL the app (the crash that strands the
//          hold and leaves resident owners recorded);
//   seed   write the stale hold + needs-attention journal + a pending
//          business record directly into the closed on-disk sqlite stores;
//   run 2  relaunch the real app: an ordinary write (managed.draft) must stay
//          PROJECT_LIFECYCLE_ACTIVE, then the real right-click "从 Nozeli 移除项目"
//          entry must first verify stop stability (recorded resident owners
//          cleared, PIDs gone) and remove only the entry; source files, the
//          journal and pending business stay byte-preserved, nothing replays;
//   run 3  a further cold open must not resurrect the hold or the entry.
//
// Two launch modes (see failed-surface-exit-check.mjs):
//   node tests/desktop-stale-remove-hold-live.mjs --app-root <repo>/apps/desktop
//   node tests/desktop-stale-remove-hold-live.mjs --release <releases>/<timestamp>
//
// Isolation: synthetic project under a mkdtemp root, sanitized HOME/XDG_*,
// dedicated NOZELI_CONFIG_ROOT/NOZELI_USER_DATA, NOZELI_TEST_INSTANCE, a
// loopback-only scripted model and a dedicated CDP port. The real user
// profile, the real V directory and real credentials are never read. No
// NODE_OPTIONS observer is injected (packaged builds ignore it), so this
// report does not claim full-process network isolation.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import puppeteer from 'puppeteer-core';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';

const require=createRequire(import.meta.url);
const arguments_=process.argv.slice(2);
const option=name=>{const index=arguments_.indexOf(name);return index>=0?arguments_[index+1]:null;};
const appRootOption=option('--app-root'),releaseOption=option('--release');
assert(appRootOption||releaseOption,'pass --app-root <apps/desktop> or --release <release-dir>');
assert(!(appRootOption&&releaseOption),'pass exactly one of --app-root / --release');
const mode=appRootOption?'source':'installed';
const appRoot=appRootOption?path.resolve(appRootOption):null;
const release=releaseOption?path.resolve(releaseOption):null;
const binary=appRoot?createRequire(path.join(appRoot,'package.json'))('electron'):path.join(release,'nozeli');
const appArguments=appRoot?[path.join(appRoot,'src/main/main.cjs')]:[];

const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-stale-remove-hold-'+mode+'-'));
const projectRoot=path.join(out,'synthetic-project');
await fs.mkdir(projectRoot);await fs.writeFile(path.join(projectRoot,'source.txt'),'LIVE_SOURCE_PRESERVED\n');
const config=path.join(out,'config'),profile=path.join(config,'desktop');
const catalog=path.join(profile,'nozeli','storage-v2','catalog.sqlite');
const OLD_OPERATION_ID='e8cd9c4e-11f2-47f8-8650-bde8a7960381';
const report={ok:false,kind:'stale-remove-hold-live',mode,out,binary,appRoot,release,projectRoot,config,profile,
 coverage:'Synthetic project + isolated HOME/XDG/config/profile; loopback scripted model; packaged mode gets no NODE_OPTIONS observer and full-process isolation is not claimed. Real user profile and the real V directory are never read.',
 checks:[],scenes:[],modelRequests:[],normalExits:[],errors:[],stages:{}};
console.log('EVIDENCE_ROOT='+out);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=90000){
 const deadline=Date.now()+timeout;
 do{const value=await fn();if(value)return value;await pause(100);}while(Date.now()<deadline);
 throw new Error('Timed out: '+label);
}
const freePort=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
// Loopback scripted model: answers any completion with a plain stop. Business
// must never be replayed, so any request after the crash is recorded evidence.
const server=http.createServer((req,res)=>{let body='';req.on('data',bytes=>body+=bytes);req.on('end',()=>{
 report.modelRequests.push({at:new Date().toISOString(),path:req.url,body:body.slice(0,300)});
 res.writeHead(200,{'content-type':'text/event-stream'});
 for(const [delta,finish] of [[{role:'assistant',content:'synthetic local reply'},null],[{},'stop']])
  res.write('data: '+JSON.stringify({id:'stale-hold-local',object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
 res.end('data: [DONE]\n\n');
});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

function isolatedEnvironment(port){
 const env={...process.env};
 for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
 Object.assign(env,{HOME:path.join(out,'home'),XDG_CONFIG_HOME:path.join(out,'home','.config'),XDG_DATA_HOME:path.join(out,'home','.local','share'),XDG_CACHE_HOME:path.join(out,'home','.cache'),
  NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:projectRoot,
  NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
 return env;
}
let child,browser,shell,log='',exitPromise;
async function launch(label){
 const port=await freePort(),env=isolatedEnvironment(port);
 await fs.mkdir(env.HOME,{recursive:true,mode:0o700});
 log+='\n=== '+label+' launch on CDP '+port+' ===\n';
 child=spawn(binary,[...appArguments,'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland'),'--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]'],{cwd:out,env,stdio:['ignore','pipe','pipe']});
 exitPromise=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes;});
 browser=await until(async()=>{if(child.exitCode!==null||child.signalCode)throw Error(label+' exited during launch\n'+log);try{return await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});}catch{return false;}},label+' CDP');
 const observe=page=>page.on('pageerror',error=>report.errors.push(label+': '+(error.stack||error)));
 for(const page of await browser.pages())observe(page);
 browser.on('targetcreated',async target=>{const page=await target.page().catch(()=>null);if(page)observe(page);});
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__workspaceScope?.role==='shell'&&window.__nozeliReady).catch(()=>false))return page;},label+' shell window');
 if(await shell.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell.click('#configuration-cancel');
 return label;
}
async function raw(op,payload={}){return shell.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});}
async function call(op,payload={}){const result=await raw(op,payload);assert.equal(result.ok,true,op+': '+JSON.stringify(result.error));return result.value;}
async function requestCloseExpectZero(scene){
 const response=await shell.evaluate(()=>nozeli.invoke('session.requestClose',{}));
 assert(response.ok,'session.requestClose: '+JSON.stringify(response.error));
 const result=await Promise.race([exitPromise,pause(45000).then(()=>null)]);
 assert.deepEqual(result,{code:0,signal:null},scene+': normal close must exit 0');
 report.normalExits.push({scene,...result});
 await browser.disconnect();browser=null;shell=null;
}
const instancesRow=()=>{const db=new DatabaseSync(catalog,{readOnly:true});try{const row=db.prepare("SELECT id,value FROM records WHERE collection='instances'").get();return {id:row.id,project:JSON.parse(row.value)};}finally{db.close();}};
const holdsRows=()=>{const db=new DatabaseSync(catalog,{readOnly:true});try{return db.prepare("SELECT id,value FROM records WHERE collection='lifecycle_holds'").all();}finally{db.close();}};
const localRecords=(instanceId,id)=>{const db=new DatabaseSync(path.join(profile,'nozeli','storage-v2','instances',instanceId,'ui.sqlite'),{readOnly:true});try{const row=db.prepare("SELECT value FROM records WHERE collection='ui' AND id=?").get(id);return row?JSON.parse(row.value):null;}finally{db.close();}};
const recoveryRows=instanceId=>{const db=new DatabaseSync(path.join(profile,'nozeli','storage-v2','recovery',instanceId,'recovery.sqlite'),{readOnly:true});try{return db.prepare("SELECT id,value FROM records WHERE collection='recovery'").all();}finally{db.close();}};
async function providerOwners(instanceId){
 const providers=localRecords(instanceId,'managed:providers')??{};
 return Promise.all(Object.entries(providers).map(async([target,owner])=>({target,pid:owner.pid,stamp:owner.stamp,live:await processStamp(owner.pid)})));
}
const seeded={};
async function seedStaleState(){
 const {id:projectId,project}=instancesRow();
 assert.equal(path.resolve(project.root),projectRoot,'registered root must be the synthetic project');
 const owners=await providerOwners(project.instanceId);
 assert(owners.length>=2,'run 1 must leave at least two recorded native resident owners, got '+JSON.stringify(owners));
 report.stages.afterCrash={projectId,instanceId:project.instanceId,owners:owners.map(owner=>({target:owner.target,pid:owner.pid,stamp:owner.stamp,live:Boolean(owner.live)}))};
 const db=new DatabaseSync(catalog);
 try{
  db.prepare("INSERT INTO records(collection,id,value) VALUES('lifecycle_holds',?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value,revision=records.revision+1").run(projectId,JSON.stringify({operationId:OLD_OPERATION_ID,instanceId:project.instanceId,action:'remove'}));
 }finally{db.close();}
 const recoveryDirectory=path.join(profile,'nozeli','storage-v2','recovery',project.instanceId);
 await fs.mkdir(recoveryDirectory,{recursive:true,mode:0o700});
 const recovery=new DatabaseSync(path.join(recoveryDirectory,'recovery.sqlite'));
 try{
  recovery.exec('CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(collection,id))');
  seeded.journal=JSON.stringify({schema:1,projectId,operationId:OLD_OPERATION_ID,instanceId:project.instanceId,action:'remove',root:project.root,phase:'needs-attention',failedPhase:'prepared',error:{code:'PROJECT_LIFECYCLE_ACTIVE',message:'项目正在停用或等待停稳核查；未接受新操作。'},updatedAt:'2026-10-26T12:21:17.000Z'});
  seeded.pending=JSON.stringify({schema:1,kind:'business',status:'pending',automaticReplay:false,collections:{managed_jobs:[{id:'never-replay-live',value:{text:'synthetic held business input'}}]}});
  const put=recovery.prepare("INSERT INTO records(collection,id,value) VALUES('recovery',?,?) ON CONFLICT(collection,id) DO UPDATE SET value=excluded.value,revision=records.revision+1");
  put.run('lifecycle:'+OLD_OPERATION_ID,seeded.journal);put.run('managed:pending:held-business',seeded.pending);
 }finally{recovery.close();}
 assert.equal(holdsRows().length,1,'exactly the seeded lifecycle hold');
 report.checks.push('stale remove hold + needs-attention journal + pending business seeded into the closed on-disk stores (crash shape from the field incident)');
 return {projectId,project,owners};
}
async function rightClickRemoveEntry(projectId){
 const button=await until(async()=>shell.$('[data-project-id="'+projectId+'"]'),'recent entry button for the held project');
 await button.click({button:'right'});
 await shell.waitForSelector('#project-context-menu:not([hidden])',{visible:true});
 const open=await shell.evaluate(()=>({open:!document.getElementById('project-context-menu')?.hidden,items:[...document.querySelectorAll('#project-context-menu button')].map(item=>item.textContent)}));
 assert(open.open,'project context menu must open');assert(open.items.some(item=>item.includes('从 Nozeli 移除项目')),'menu must list the remove entry: '+JSON.stringify(open.items));
 await shell.screenshot({path:path.join(out,'02-held-context-menu.png')});report.scenes.push({name:'held-context-menu',file:'02-held-context-menu.png'});
 const items=await shell.$$('#project-context-menu button');
 const index=open.items.findIndex(item=>item.includes('从 Nozeli 移除项目'));
 assert(index>=0,'remove menu item must be present');
 await items[index].click();
 report.checks.push('real right-click entry "从 Nozeli 移除项目" dispatched from the shell window');
}
try{
 // Run 1: real registration, real native residents, then the crash.
 await launch('run1');
 await call('config.initialize',{mode:'independent'});
 await call('settings.providers.save',{provider:'stale-hold-local',model:'scripted',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',api:'openai-completions',key:'synthetic-local-only'});
 await call('settings.models.save',{frontdesk:'stale-hold-local/scripted',orchestrator:'stale-hold-local/scripted',worker:'stale-hold-local/scripted'});
 await shell.click('#pick-project');
 const picked=await until(async()=>{const scope=await call('workspace.bootstrap');if(!scope.projectId)return;const recent=await call('project.recent');return recent.projects.find(project=>path.resolve(project.rootDisplay)===projectRoot)?scope:null;},'synthetic project registered and active');
 const projectId=picked.projectId,{project}=instancesRow();
 report.stages.run1={projectId,instanceId:project.instanceId};
 await call('managed.enable',{projectId});
 await until(async()=>(await call('managed.status',{projectId})).ready===true,'bundled native residents ready');
 const owners=await providerOwners(project.instanceId);
 assert(owners.length>=2&&owners.every(owner=>owner.live),'live native resident PIDs required: '+JSON.stringify(owners));
 await call('managed.draft',{projectId,target:'frontdesk',text:'HELD_DRAFT_PRESERVE'});
 await shell.screenshot({path:path.join(out,'01-run1-residents.png')});report.scenes.push({name:'run1-residents',file:'01-run1-residents.png',owners:owners.map(owner=>({target:owner.target,pid:owner.pid}))});
 report.checks.push('run 1: synthetic project registered, real native residents running and recorded, unsent draft persisted');
 await browser.disconnect();browser=null;shell=null;
 child.kill('SIGKILL');
 const crashed=await exitPromise;
 assert.deepEqual([crashed.code,crashed.signal].join(','),[null,'SIGKILL'].join(','),'run 1 must die by SIGKILL');
 report.stages.run1.crash=crashed;
 await fs.writeFile(path.join(out,'run1-main.log'),log);

 // Seed the stale state exactly as the crashed process would have left it.
 const seededState=await seedStaleState();
 log='';

 // Run 2: cold restart under the hold.
 await launch('run2');
 const recent=await call('project.recent');
 assert(recent.projects.some(project=>project.id===seededState.projectId),'held project must still be listed for the right-click entry');
 const refused=await raw('managed.draft',{projectId:seededState.projectId,target:'frontdesk',text:'must be refused'});
 assert.equal(refused.ok,false);assert.equal(refused.error.code,'PROJECT_LIFECYCLE_ACTIVE','ordinary writes stay locked, got '+JSON.stringify(refused.error));
 report.checks.push('cold restart keeps ordinary writes PROJECT_LIFECYCLE_ACTIVE while the remove hold persists');
 const modelRequestsBeforeRemove=report.modelRequests.length;
 await rightClickRemoveEntry(seededState.projectId);
 const settled=await until(async()=>{
  if(!((await call('project.recent')).projects.some(project=>project.id===seededState.projectId)))return true;return false;
 },'held entry disappears from project.recent after the right-click remove');
 assert(settled);
 await until(()=>holdsRows().length===0,'persisted lifecycle hold row is released from the catalog');
 const stoppedOwners=await providerOwners(seededState.project.instanceId);
 assert(stoppedOwners.length===0,'recorded resident owners must be cleared by the verified stop: '+JSON.stringify(stoppedOwners));
 for(const owner of seededState.owners)assert.notEqual(await processStamp(owner.pid),owner.stamp,'recorded native owner '+owner.pid+' must be stopped (or its PID gone) before the entry removal completes');
 assert.equal(report.modelRequests.length,modelRequestsBeforeRemove,'remove must not replay any model business');
 report.checks.push('right-click remove verified stop stability first (recorded native owners cleared/stopped) and then removed only the entry');
 // Nothing on disk was deleted: source, manifest, journal, pending business.
 assert.equal(await fs.readFile(path.join(projectRoot,'source.txt'),'utf8'),'LIVE_SOURCE_PRESERVED\n');
 const manifest=await fs.readFile(path.join(projectRoot,'.nozeli','project.json'),'utf8');assert(JSON.parse(manifest).projectId===seededState.projectId,'project manifest untouched');
 const rows=recoveryRows(seededState.project.instanceId),byId=Object.fromEntries(rows.map(row=>[row.id,row.value]));
 assert.equal(byId['managed:pending:held-business'],seeded.pending,'pending business preserved byte-for-byte');
 const drafts=JSON.parse(byId['managed:drafts']??'{}');assert.equal(drafts.frontdesk,'HELD_DRAFT_PRESERVE','crash-time unsent draft preserved through the guarded remove');
 const journal=JSON.parse(byId['lifecycle:'+OLD_OPERATION_ID]);
 assert.equal(journal.action,'remove');assert.equal(journal.phase,'needs-attention');assert.equal(journal.operationId,OLD_OPERATION_ID);
 assert.equal(journal.projectId,seededState.projectId);assert.equal(journal.instanceId,seededState.project.instanceId);
 const receipt=rows.find(row=>row.id.startsWith('lifecycle:remove:')&&row.id!=='lifecycle:remove:'+OLD_OPERATION_ID&&JSON.parse(row.value).complete===true);
 assert(receipt,'a fresh-operation remove receipt must exist: '+JSON.stringify(rows.map(row=>row.id)));
 const after=instancesRow();assert.equal(after.id,seededState.projectId);assert.equal(after.project.removed,true,'entry removed in the catalog');
 report.stages.run2={journalPreserved:true,pendingByteIdentical:byId['managed:pending:held-business']===seeded.pending,freshReceipt:receipt.id,removedOwnerRecords:stoppedOwners.length};
 await shell.screenshot({path:path.join(out,'03-run2-after-remove.png')});report.scenes.push({name:'run2-after-remove',file:'03-run2-after-remove.png'});
 report.checks.push('entry removed under a fresh operationId while source, manifest, journal and pending business are preserved untouched');
 await requestCloseExpectZero('run2-remove-close');
 await fs.writeFile(path.join(out,'run2-main.log'),log);

 // Run 3: another cold open must not resurrect anything.
 log='';
 await launch('run3');
 const recent3=await call('project.recent');
 assert(!recent3.projects.some(project=>project.id===seededState.projectId),'removed entry must stay gone after a cold open');
 assert.equal(holdsRows().length,0,'no lifecycle hold may resurrect');
 assert(!await shell.$('[data-project-id="'+seededState.projectId+'"]'),'no recent entry button for the removed project');
 assert.equal((recoveryRows(seededState.project.instanceId).find(row=>row.id==='managed:pending:held-business')||{}).value,seeded.pending,'pending business still byte-identical after cold open');
 assert.equal(await fs.readFile(path.join(projectRoot,'source.txt'),'utf8'),'LIVE_SOURCE_PRESERVED\n');
 await shell.screenshot({path:path.join(out,'04-run3-cold.png')});report.scenes.push({name:'run3-cold',file:'04-run3-cold.png'});
 report.checks.push('cold open after the guarded remove resurrects neither the hold, the entry nor any pending business');
 await requestCloseExpectZero('run3-cold-close');
 await fs.writeFile(path.join(out,'run3-main.log'),log);
 assert.deepEqual(report.errors,[]);
 report.ok=true;
}catch(error){
 report.failure=error.stack;console.log(report.failure);
 if(shell){await shell.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.log(await shell.evaluate(()=>document.body.innerText.slice(-2500)).catch(()=>null));}
 process.exitCode=1;
}finally{
 await browser?.disconnect().catch(()=>{});
 if(child&&child.exitCode===null&&!child.signalCode){child.kill('SIGTERM');const stopped=await Promise.race([exitPromise.then(()=>true),pause(4000).then(()=>false)]);if(!stopped){child.kill('SIGKILL');await exitPromise;}}
 // Any resident orphans left by the crash are test-owned; reap them.
 if(report.stages.afterCrash)for(const owner of report.stages.afterCrash.owners){try{if(await processStamp(owner.pid)===owner.stamp){process.kill(owner.pid,'SIGKILL');}}catch{}}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 await fs.writeFile(path.join(out,'main-tail.log'),log).catch(()=>{});
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify({ok:report.ok,out,mode,checks:report.checks,normalExits:report.normalExits,modelRequests:report.modelRequests.length,errors:report.errors,failure:report.failure},null,2));
}
