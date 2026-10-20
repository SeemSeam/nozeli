import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import puppeteer from 'puppeteer-core';
import {MainObserver,processIdentity,assertOwned} from './post-install-startup-recovery-fixture.mjs';

// No Provider/model or shared build. Run Linux/Wayland with explicit fixed release:
// NOZELI_INSTALLED_ROOT=<07-46 absolute release> node tests/post-install-startup-recovery-audit.mjs
const syntaxObserver=new MainObserver();syntaxObserver.evaluate=expression=>new vm.Script(expression);await syntaxObserver.install('/tmp/syntax-only-not-created','syntax');
if(process.platform!=='linux')throw Error('This isolation audit is Linux-only');
const release=await fs.realpath(process.env.NOZELI_INSTALLED_ROOT||'missing-explicit-release');
if(path.basename(release)!=='2026-10-13T07-46-21-704Z')throw Error('Fixed 07-46 release required');
const exe=await fs.realpath(path.join(release,'nozeli')),app=path.join(release,'resources/app'),{DesktopHost}=await import(pathToFileURL(path.join(app,'src/main/host.mjs')));
const parent=path.join(os.homedir(),'.local/state/nozeli-runtime-tests');await fs.mkdir(parent,{recursive:true});
const waylandRuntime=process.env.XDG_RUNTIME_DIR||path.join('/run/user',String(process.getuid()));
const waylandDisplay=process.env.WAYLAND_DISPLAY||'wayland-0';
assert((await fs.stat(path.join(waylandRuntime,waylandDisplay))).isSocket(),'Actual Wayland socket required');
assert((await fs.stat(path.join(waylandRuntime,'bus'))).isSocket(),'Actual user bus socket required');
const out=await fs.mkdtemp(path.join(parent,'startup-audit-'));await fs.chmod(out,0o700);
const delay=ms=>new Promise(r=>setTimeout(r,ms)),hash=b=>createHash('sha256').update(b).digest('hex');
const important=['src/main/main.cjs','src/preload/preload.cjs','src/main/host.mjs','src/renderer/app.mjs'];
async function sourceHashes(){return Object.fromEntries(await Promise.all(important.map(async p=>[p,hash(await fs.readFile(path.join(app,p)))])));}
const beforeHashes=await sourceHashes(),cases=[],active=new Set();
await fs.writeFile(path.join(out,'source-before.json'),JSON.stringify(beforeHashes,null,2));
const port=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
async function wait(fn,label,ms=25000){const end=Date.now()+ms;let last;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(e){if(e.fatal)throw e;last=e.message;}await delay(100);}throw Error('timeout '+label+(last?': '+last:''));}
const bounded=(promise,label,ms=5000)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('timeout '+label)),ms);timer.unref();})]);
async function invoke(run,op,p={}){const r=await bounded(run.page.evaluate(({op,p})=>nozeli.invoke(op,p),{op,p}),'IPC '+op);if(!r.ok)throw Error(op+': '+r.error.message);return r.value;}
async function ui(run){return bounded(run.page.evaluate(()=>({ready:window.__nozeliReady,path:document.querySelector('#file-path')?.textContent,text:window.__nozeliInput?.text?.(),composer:document.querySelector('#composer')?.value,status:document.querySelector('#save-status')?.textContent,lastOpen:window.__lastOpen,saveFailure:!document.querySelector('#save-failure')?.hidden})),'read UI');}
async function attachPage(run){run.browser??=await puppeteer.connect({browserURL:`http://127.0.0.1:${run.port}`,defaultViewport:null,protocolTimeout:5000});run.page=(await run.browser.pages()).find(p=>p.url().startsWith('http://127.0.0.1:'));assert(run.page);run.page.on('pageerror',error=>run.errors.push(error.message));await run.page.waitForFunction(()=>window.__nozeliReady,{timeout:25000,polling:100});if(await run.page.$eval('#agent-setup',n=>n.open))await run.page.evaluate(()=>document.querySelector('#agent-skip').click());return run.page;}
async function launch(record,file){
 const debugPort=await port(),tag=randomUUID();
 const env={...process.env,PATH:path.join(record.dir,'empty-bin'),NOZELI_CODEX_SOURCE_HOME:path.join(record.dir,'empty-provider-home'),XDG_RUNTIME_DIR:waylandRuntime,WAYLAND_DISPLAY:waylandDisplay,DBUS_SESSION_BUS_ADDRESS:process.env.DBUS_SESSION_BUS_ADDRESS||'unix:path='+path.join(waylandRuntime,'bus'),NOZELI_USER_DATA:record.profile,NOZELI_DEBUG_PORT:String(debugPort),NOZELI_TEST_INSTANCE:'0',NOZELI_HIDDEN:'1',NOZELI_OZONE:'wayland',NOZELI_STARTUP_AUDIT_ID:tag,NOZELI_TEST_PICK:record.project};
 for(const key of ['ELECTRON_RUN_AS_NODE','NOZELI_AGENT_FIXTURE','NOZELI_REAL_CODEX','NOZELI_EDITOR_LAB'])delete env[key];
 const child=spawn(exe,['--ozone-platform=wayland','--inspect=0',file],{cwd:record.dir,env,stdio:['ignore','pipe','pipe'],detached:true});
 const run={child,exe,profile:record.profile,tag,port:debugPort,env,log:'',errors:[],record};active.add(run);
 run.exited=new Promise(resolve=>child.once('exit',(code,signal)=>{run.exit={code,signal};record.lastExit=run.exit;resolve(run.exit);}));child.on('error',error=>{run.spawnError=error;});
 for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{run.log+=bytes;void fs.appendFile(path.join(record.dir,'main.log'),bytes);});
 run.identity=await wait(()=>processIdentity(child.pid),'owned identity');record.processes??=[];record.processes.push(await assertOwned(run));
 await wait(()=>run.log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'main Inspector');
 await wait(()=>{if(run.exit)throw Object.assign(Error('Owned main exited before renderer ready: '+JSON.stringify(run.exit)),{fatal:true});return attachPage(run).then(()=>true);},'renderer ready');
 run.observer=await MainObserver.connect(run.log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)[1]);await run.observer.install(record.dir,record.name);const boot=await invoke(run,'agents.bootstrap',{projectId:record.projectId});assert(boot.providers.every(p=>!p.available));assert.equal((await invoke(run,'managed.status',{projectId:record.projectId})).enabled,false);
 return run;
}
async function second(run,file){
 const child=spawn(exe,['--ozone-platform=wayland',pathToFileURL(file).href],{cwd:run.record.dir,env:{...run.env,NOZELI_DEBUG_PORT:String(await port())},stdio:['ignore','pipe','pipe'],detached:true});let log='';for(const s of [child.stdout,child.stderr])s.on('data',d=>log+=d);
 const result=await bounded(new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal,pid:child.pid}))),'second instance exit',12000);
 assert.equal(result.code,0);await fs.appendFile(path.join(run.record.dir,'second-instance.log'),log);run.record.secondInvocations??=[];run.record.secondInvocations.push({...result,file});return result;
}
async function snapshot(run,label){
 const data={label,at:Date.now(),main:await run.observer.state(),ui:await ui(run).catch(e=>({unavailable:e.message}))};
 await fs.writeFile(path.join(run.record.dir,label+'.json'),JSON.stringify(data,null,2));
 try{data.capture=await run.observer.capture(label);}catch(error){data.capture={error:error.message};}
 await fs.writeFile(path.join(run.record.dir,label+'.json'),JSON.stringify(data,null,2));return data;
}
async function closeNormally(run){
 await run.observer.action('close');run.observer.close();run.observer=null;
 const result=await bounded(run.exited,'normal close flush',12000);assert.deepEqual(result,{code:0,signal:null});await run.browser?.disconnect();active.delete(run);run.record.normalCloses=(run.record.normalCloses||0)+1;
}
async function cleanup(run){
 await run.browser?.disconnect().catch(()=>{});run.observer?.close();
 if(!run.exit){run.record.ownedTermination??=[];const identity=await assertOwned(run);run.record.ownedTermination.push({signal:'SIGTERM',identity,reason:'Own fault case cleanup; not verified flush'});process.kill(-run.child.pid,'SIGTERM');await Promise.race([run.exited,delay(1500)]);
  if(!run.exit){await assertOwned(run);run.record.ownedTermination.push({signal:'SIGKILL',identity,reason:'Own fault process did not stop; memory not guaranteed'});process.kill(-run.child.pid,'SIGKILL');await bounded(run.exited,'owned fault termination',8000);}}
 await fs.writeFile(path.join(run.record.dir,'main.log'),run.log);active.delete(run);
}
async function reapCase(record){
 const knownGroups=new Set((record.processes||[]).map(p=>p.group)),identities=[];
 for(const entry of await fs.readdir('/proc')){if(!/^\d+$/.test(entry))continue;try{
  const p=await processIdentity(Number(entry));if(!knownGroups.has(p.group))continue;
  let ancestor=p,ancestry=false;for(let i=0;i<12;i++){const main=(record.processes||[]).find(m=>m.pid===ancestor.pid&&m.start===ancestor.start&&m.exe===ancestor.exe);if(main){ancestry=true;break;}if(ancestor.parent<2)break;try{ancestor=await processIdentity(ancestor.parent);}catch{break;}}
  const proof=ancestry||p.environment.includes('NOZELI_USER_DATA='+record.profile)||p.command.some(c=>c.includes(record.profile))||(p.cwd===record.dir&&p.command.some(c=>c.includes(record.project)));
  assert(proof,'Group member lacks own profile/path proof');identities.push(p);
 }catch(e){if(['ENOENT','ESRCH','EACCES'].includes(e.code))continue;throw e;}}
 const actions=[];for(const signal of ['SIGTERM','SIGKILL']){
  for(const p of identities){try{const live=await processIdentity(p.pid);if(live.exe!==p.exe||live.start!==p.start||live.group!==p.group)continue;process.kill(p.pid,signal);actions.push({signal,pid:p.pid,exe:p.exe,start:p.start,group:p.group});}catch(e){if(!['ENOENT','ESRCH','EACCES'].includes(e.code))throw e;}}
  await delay(600);
 }
 const remaining=[];for(const p of identities){try{const live=await processIdentity(p.pid);if(live.start===p.start)remaining.push({pid:p.pid,exe:p.exe});}catch(e){if(!['ENOENT','ESRCH','EACCES'].includes(e.code))throw e;}}
 record.processAudit={examined:identities.length,actions,remaining};assert.deepEqual(remaining,[],'Own fault processes must be cleaned');
}
async function seed(record){
 await fs.mkdir(record.project,{recursive:true});for(const [file,text] of [['A.txt','Alpha baseline\n'],['B.txt','Beta baseline\n'],['held.txt','Held source unchanged\n']])await fs.writeFile(path.join(record.project,file),text);
 const host=new DesktopHost(record.profile);record.projectId=(await host.pick(record.project)).project.id;
 await fs.mkdir(path.join(record.dir,'empty-bin'));await fs.mkdir(path.join(record.dir,'empty-provider-home'));
 const binding=path.join(record.profile,'nozeli','managed-v1',record.projectId,'binding.json');await fs.mkdir(path.dirname(binding),{recursive:true});await fs.writeFile(binding,JSON.stringify({schema:1,enabled:false}));
 record.noProviderSetup={emptyPath:path.join(record.dir,'empty-bin'),emptySourceHome:path.join(record.dir,'empty-provider-home'),managedEnabled:false};return host;
}
async function persistedDraft(run,record){
 const file=await invoke(run,'file.read',{projectId:record.projectId,relPath:'held.txt'});record.durableDraft='DURABLE_CONFLICT_'+record.name;
 await invoke(run,'file.draft',{projectId:record.projectId,relPath:'held.txt',baseDigest:file.digest,text:record.durableDraft});
 await fs.writeFile(path.join(record.project,'held.txt'),'External user bytes retained\n');
 record.durableComposer='PERSISTED_COMPOSER_'+record.name;
 await run.page.evaluate(text=>{const node=document.querySelector('#composer');node.value=text;node.dispatchEvent(new Event('input',{bubbles:true}));},record.durableComposer);
 await wait(async()=>JSON.stringify(await invoke(run,'state.read',{projectId:record.projectId})).includes(record.durableComposer),'composer persisted');
 const saved=await invoke(run,'file.read',{projectId:record.projectId,relPath:'held.txt'});assert.equal(saved.draft.text,record.durableDraft);
 await fs.writeFile(path.join(record.dir,'durable-before.json'),JSON.stringify({draft:saved.draft,view:await invoke(run,'state.read',{projectId:record.projectId})},null,2));
}
async function verifyDurable(run,record){
 const saved=await invoke(run,'file.read',{projectId:record.projectId,relPath:'held.txt'});assert.equal(saved.draft.text,record.durableDraft);assert.equal(await fs.readFile(path.join(record.project,'held.txt'),'utf8'),'External user bytes retained\n');
 const view=await invoke(run,'state.read',{projectId:record.projectId});assert(JSON.stringify(view).includes(record.durableComposer));record.checks.push('persisted conflict draft/composer survive without overwriting external source');
 await fs.writeFile(path.join(record.dir,'durable-after.json'),JSON.stringify({draft:saved.draft,view},null,2));
}
async function memoryOnly(run,record){
 record.memoryMarker='MEMORY_ONLY_'+record.name;
 const data=await run.page.evaluate(marker=>{const editor=document.querySelector('#text-host .cm-editor');editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));__nozeliInput.insert('\n'+marker);return {text:__nozeliInput.text(),status:document.querySelector('#save-status')?.textContent};},record.memoryMarker);
 assert(data.text.includes(record.memoryMarker));assert(!(await fs.readFile(path.join(record.project,'A.txt'),'utf8')).includes(record.memoryMarker));await fs.writeFile(path.join(record.dir,'memory-before.json'),JSON.stringify(data,null,2));
}
async function auditNoProvider(record){
 const found=[];async function visit(root){for(const entry of await fs.readdir(root,{withFileTypes:true}).catch(()=>[])){const p=path.join(root,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory()){if(['Cache','Code Cache','GPUCache','DawnWebGPUCache','DawnGraphiteCache'].includes(entry.name))continue;await visit(p);}else if(entry.name==='auth.json')found.push(p);}}
 await visit(record.profile);assert.deepEqual(found,[]);assert.equal(await fs.stat(path.join(record.profile,'nozeli','managed-v1',record.projectId,'runtime')).then(()=>true,()=>false),false,'No managed runtime allowed');record.checks.push('no authentication copies');
 const records=[];async function states(root){for(const entry of await fs.readdir(root,{withFileTypes:true}).catch(()=>[])){const p=path.join(root,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())await states(p);else if(entry.name==='state.json'&&p.includes('managed-v1')){const s=JSON.parse(await fs.readFile(p));records.push({file:p,jobs:s.jobs?.length||0,providers:Object.keys(s.providers||{}).length});assert.equal(s.jobs?.length||0,0);assert.equal(Object.keys(s.providers||{}).length,0);}}}
 await states(path.join(record.profile,'nozeli'));record.providerAudit={authCopies:found,runtimes:records};
}
console.log(JSON.stringify({out,release,mode:'actual-installed-electron-owned-faults-not-original-root-cause'}));
const selected=process.env.NOZELI_STARTUP_CASES?.split(',')||['normal','renderer-crash','renderer-stall'];assert(selected.every(n=>['normal','renderer-crash','renderer-stall'].includes(n)));
for(const name of selected){
 const dir=path.join(out,name),record={name,dir,profile:path.join(dir,'profile'),project:path.join(dir,'中文 项目'),checks:[],gaps:[]};await fs.mkdir(dir);cases.push(record);let run;
 try{
  await seed(record);run=await launch(record,path.join(record.project,'A.txt'));await wait(async()=>(await ui(run)).path==='A.txt','cold initial file');await snapshot(run,'ready');
  const lock=await fs.readlink(path.join(record.profile,'SingletonLock'));assert(lock.endsWith('-'+run.child.pid));record.singletonLock=lock;record.checks.push('private real singleton locks only owned main');
  if(name==='normal'){
   await run.page.evaluate(()=>{__nozeliInput.insert('\nNORMAL_SWITCH_FLUSH');const node=document.querySelector('#composer');node.value='NORMAL_COMPOSER';node.dispatchEvent(new Event('input',{bubbles:true}));});
   await second(run,path.join(record.project,'B.txt'));await wait(async()=>(await ui(run)).path==='B.txt','normal second handoff');assert.match(await fs.readFile(path.join(record.project,'A.txt'),'utf8'),/NORMAL_SWITCH_FLUSH/);record.checks.push('second file URI opens and flushes outgoing dirty file');
   await run.page.evaluate(()=>__nozeliInput.insert('\nNORMAL_CLOSE_FLUSH'));await snapshot(run,'before-close');await closeNormally(run);assert.match(await fs.readFile(path.join(record.project,'B.txt'),'utf8'),/NORMAL_CLOSE_FLUSH/);
   run=await launch(record,path.join(record.project,'B.txt'));await wait(async()=>(await ui(run)).text?.includes('NORMAL_CLOSE_FLUSH'),'close text restored');assert.equal((await ui(run)).composer,'NORMAL_COMPOSER');record.checks.push('normal close/restart retains file and unsent composer');await snapshot(run,'restored');await closeNormally(run);
  }else{
   await persistedDraft(run,record);await memoryOnly(run,record);await snapshot(run,'before-fault');
   if(name==='renderer-crash'){
    await assertOwned(run);const renderer=await processIdentity((await run.observer.state()).rendererPid);assert.equal(renderer.exe,exe);assert.equal(renderer.group,run.child.pid);assert(renderer.command.some(c=>c.includes(record.profile)&&c.includes('--type=renderer')));const again=await processIdentity(renderer.pid);assert.equal(again.start,renderer.start);record.faultInjection={signal:'SIGKILL',target:'own renderer only; avoids platform crash dump hang',pid:renderer.pid,exe:renderer.exe,start:renderer.start,group:renderer.group};process.kill(renderer.pid,'SIGKILL');await wait(async()=>(await run.observer.state()).crashed,'actual renderer crash');await snapshot(run,'crashed');
    await second(run,path.join(record.project,'B.txt'));await run.observer.action('close');await delay(9000);const stayed=await run.observer.state();assert.equal(run.exit,undefined);assert.equal(stayed.destroyed,false);record.checks.push('dead renderer does not falsely confirm close');record.gaps.push('renderer gone is log-only; close timeout leaves no product recovery action');await snapshot(run,'close-timeout');
    await run.observer.action('reload');await attachPage(run);await wait(async()=>(await ui(run)).path==='B.txt','crash reload drains handoff');await verifyDurable(run,record);assert(!(await fs.readFile(path.join(record.project,'A.txt'),'utf8')).includes(record.memoryMarker));const afterMemory=await invoke(run,'file.read',{projectId:record.projectId,relPath:'A.txt'});assert(!afterMemory.draft?.text?.includes(record.memoryMarker));await fs.writeFile(path.join(record.dir,'memory-after.json'),JSON.stringify({diskText:afterMemory.text,draft:afterMemory.draft??null},null,2));record.checks.push('explicit test reload drains queued handoff; memory-only edit absent from disk and durable draft');
    await snapshot(run,'after-reload');await closeNormally(run);
   }else{
    // Finite real busy JS. It stops by itself; no automatic product kill/reload.
    await run.page.evaluate(()=>{setTimeout(()=>{const until=Date.now()+20000;while(Date.now()<until){}},100);});await delay(400);
    void run.page._client().send('Input.dispatchKeyEvent',{type:'keyDown',key:'Shift',code:'ShiftLeft',modifiers:8}).catch(()=>{});void run.page._client().send('Input.dispatchKeyEvent',{type:'keyUp',key:'Shift',code:'ShiftLeft'}).catch(()=>{});
    await second(run,path.join(record.project,'B.txt'));await run.observer.action('close');await delay(1000);await run.observer.action('close');await delay(8000);
    const stayed=await run.observer.state();assert.equal(run.exit,undefined);assert.equal(stayed.destroyed,false);assert.equal(stayed.sends.filter(r=>r.channel==='nozeli:flush').length,1);record.checks.push('busy renderer close attempts coalesce without false flush');await snapshot(run,'stall-timeout');
    await wait(async()=>(await ui(run)).text?.includes(record.memoryMarker),'finite stall releases',20000);const resumed=await ui(run);record.resumed=resumed;assert.equal(resumed.path,'A.txt');assert(resumed.text.includes(record.memoryMarker));record.checks.push('waiting preserves live composing memory and external bytes');record.gaps.push('handoff exits 0 while renderer stalls; composing flush refusal consumes file request without opening');
    const old=stayed.sends.find(r=>r.channel==='nozeli:flush').requestId;const stale=await invoke(run,'session.flushed',{requestId:old,ok:true});assert.equal(stale.accepted,false);record.checks.push('late flush ack after timeout is rejected');await snapshot(run,'stall-released');
    await run.page.evaluate(()=>document.querySelector('#text-host .cm-editor').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));await wait(async()=>(await fs.readFile(path.join(record.project,'A.txt'),'utf8')).includes(record.memoryMarker),'explicit composition end saves memory');
    await second(run,path.join(record.project,'B.txt'));await wait(async()=>(await ui(run)).path==='B.txt','explicit resend after stall');await verifyDurable(run,record);record.checks.push('explicit resend succeeds after input composition settles');await closeNormally(run);
   }
   run=await launch(record,path.join(record.project,'B.txt'));await wait(async()=>(await ui(run)).path==='B.txt','post-fault restart');await verifyDurable(run,record);await snapshot(run,'restart');await closeNormally(run);record.checks.push('same private profile can restart normally after explicit recovery');
  }
  await auditNoProvider(record);record.status='OBSERVED';
 }catch(error){record.status='HARNESS_FAILED';record.failure=error.stack;if(run?.observer){await snapshot(run,'failure').catch(e=>{record.failureCapture=e.message;});}console.error(JSON.stringify({case:name,failure:error.message}));}
 finally{for(const own of [...active].filter(r=>r.record===record))await cleanup(own).catch(error=>{record.cleanupError=error.message;});await reapCase(record).catch(error=>{record.cleanupError=error.message;});await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(record,null,2));}
 console.log(JSON.stringify({case:name,status:record.status,checks:record.checks.length,gaps:record.gaps}));
}
const afterHashes=await sourceHashes();await fs.writeFile(path.join(out,'source-after.json'),JSON.stringify(afterHashes,null,2));assert.deepEqual(afterHashes,beforeHashes,'Installed production files must remain unchanged');
const results={status:cases.some(c=>c.status==='HARNESS_FAILED'||c.cleanupError)?'HARNESS_FAILED':'COMPLETED_WITH_REPRODUCED_GAPS',out,release,platform:process.platform,sourceUnchanged:true,cases,originalBlankRootCause:'unknown',limits:['NOZELI_HIDDEN=1 with Wayland showInactive avoids focus; native compositor feedback not guaranteed by app-content screenshots','no Provider/model; no default profile or user backup inspected','memory-only data is not guaranteed after renderer/process termination']};
await fs.writeFile(path.join(out,'result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({out,status:results.status}));if(results.status==='HARNESS_FAILED')process.exitCode=1;
