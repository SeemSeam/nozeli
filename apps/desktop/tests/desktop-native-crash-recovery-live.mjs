// Focused PAID installed native-crash diagnostic, not full workflow acceptance.
// NOZELI_REAL_OMP=1 NOZELI_OMP_IMPORT_API_KEYS=1 node apps/desktop/tests/desktop-native-crash-recovery-live.mjs /absolute/release /absolute/FRESH-root
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {parse,stringify} from 'yaml';
import {createAcceptanceCollector} from './acceptance-request-control.mjs';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';
import {recoverOmpProvider} from '../src/agents/managed/omp-process-ownership.mjs';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';

const [release,root,...extra]=process.argv.slice(2);
assert.equal(process.env.NOZELI_REAL_OMP,'1','Explicit paid model opt-in required');
assert.equal(process.env.NOZELI_OMP_IMPORT_API_KEYS,'1','Explicit static-key import opt-in required');
assert.equal(process.platform,'linux');
assert(!extra.length&&[release,root].every(p=>typeof p==='string'&&path.isAbsolute(p)),'Absolute release and fresh root required');
await fs.access(path.join(release,'nozeli'));
await fs.mkdir(root,{mode:0o700});
const privateRoot=path.join(root,'.Nozeli'),profile=path.join(privateRoot,'desktop'),project=path.join(root,'project');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),run=promisify(execFile);
const owners=new Map(),checks=[],operations=[];
let collector,child,exit,browser,page,observer,id,runtime,failure,log='',stage='setup';
const save=(name,value)=>fs.writeFile(path.join(root,name),JSON.stringify(value,null,2),{mode:0o600});
const check=(name,value)=>{assert(value,name);checks.push(name);};
async function invoke(op,payload={}){
  const response=await page.evaluate(({op,payload})=>window.nozeli.invoke(op,payload),{op,payload});
  if(!response.ok)throw Object.assign(Error(op+': '+response.error?.message),{response});
  return response.value;
}
const state=async()=>{
  const s=(await invoke('managed.status',{projectId:id})).state;
  for(const record of Object.values(s.providers||{}))if(record.pid&&record.stamp)owners.set(record.pid,record);
  return s;
};
async function wait(fn,label,timeout=120000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const bad=collector?.snapshot().events.find(e=>e.kind==='transport-error'||e.kind==='response'&&e.status>=400);
    if(bad){await collector.stop('upstream-failure-no-retry');throw Error('Upstream failed; no retry: '+JSON.stringify(bad));}
    const value=await fn();if(value)return value;
    if(child&&(child.exitCode!==null||child.signalCode))throw Error('Electron exited during '+label);
    await pause(100);
  }
  throw Error('Timed out: '+label+'; no retry');
}
async function click(selector){await page.waitForSelector(selector,{visible:true});await page.locator(selector).setTimeout(15000).click();}
async function compose(text,background=false){
  const before=new Set((await state()).jobs.map(j=>j.id));
  await click('#composer');await page.keyboard.down('Control');await page.keyboard.press('KeyA');await page.keyboard.up('Control');
  await page.keyboard.sendCharacter(text);
  if(background)await click('#managed-submit-task');else{await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');}
  return wait(async()=>{const s=await state();return s.jobs.find(j=>!before.has(j.id)&&(j.text===text||j.text.startsWith(text+'\n\n')));},'exact input admitted',30000);
}
async function selectWork(work){
  const row='[data-managed-work="'+work.id+'"]';
  if(await page.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await click('#toggle-sidebar');
  await page.waitForSelector(row);await page.$eval(row+' details',n=>{if(!n.open)n.querySelector('summary').click();});
  await click(row+' [data-managed-work-discuss]');
  await page.waitForFunction(target=>document.querySelector('#conversation-panel').dataset.managedConversation===target,{},work.id);
}
async function review(workId,revision=0){
  return wait(async()=>{
    const s=await state(),w=s.works.find(w=>w.id===workId);
    const bad=s.jobs.find(j=>j.target===workId&&j.revision>revision&&['failed','unknown','interrupted'].includes(j.status));
    if(bad)throw Object.assign(Error('Native job failed; no retry'),{job:bad});
    if(w?.deviation?.status==='pending'||w?.status==='paused')throw Error('Work paused or deviation held; no automatic resolution');
    return w?.status==='review'&&w.revision>revision&&!s.busyTargets.includes(workId)?w:null;
  },'reviewed native result',300000);
}
async function close(){
  if(!page||child.exitCode!==null||child.signalCode)return;
  // Node waits for an attached main Inspector at process exit. Finish observation
  // before asking Electron to quit; this is not a native-cleanup bypass.
  if(observer){
    await observer.evaluate(`(()=>{if(globalThis.__nativeCrashOriginalInvoke)process.mainModule.require('electron').ipcMain._invokeHandlers.set('nozeli:invoke',__nativeCrashOriginalInvoke);return true;})()`);
    observer.close();observer=null;
  }
  await invoke('session.requestClose');
  const deadline=Date.now()+90000;
  let confirmed=false;
  while(Date.now()<deadline){
    if(child.exitCode!==null||child.signalCode){assert.deepEqual(await exit,{code:0,signal:null});return;}
    if(!page.isClosed()){
      const choice=await page.evaluate(()=>({open:document.querySelector('#quit-choice')?.open,error:document.querySelector('#quit-error')?.textContent})).catch(()=>null);
      if(choice?.error)throw Error('Actual cancel-and-exit failed: '+choice.error);
      if(choice?.open&&!confirmed){operations.push({kind:'actual-quit-confirm',choice:'cancel',at:Date.now()});await click('#quit-cancel');confirmed=true;}
    }
    await pause(100);
  }
  if(!page.isClosed())await page.screenshot({path:path.join(root,'close-retained.png'),fullPage:true}).catch(()=>{});
  throw Error('Actual close retained its window or process; no forced success');
}
try{
  await fs.mkdir(project);await fs.writeFile(path.join(project,'baseline.txt'),'OWNED_BASELINE\n');
  for(const args of [['init'],['config','user.name','Nozeli Owned Diagnostic'],['config','user.email','owned@invalid.local'],['add','.'],['commit','-m','Owned diagnostic baseline']])await run('git',['-C',project,...args]);
  collector=await createAcceptanceCollector({ledgerPath:path.join(root,'ledger.json'),allowedDestinations:['https://sub.1983070.xyz/responses','https://sub.1983070.xyz/v1/responses'],allowedModels:['gpt-6.1-sol']});
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
  const env={...process.env,PATH:'/usr/bin:/bin',NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:privateRoot,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'};
  for(const key of ['ELECTRON_RUN_AS_NODE','NOZELI_AGENT_FIXTURE','NOZELI_OMP_BIN','PI_CODING_AGENT_DIR','PI_CONFIG_DIR','OMP_PROFILE','PI_PROFILE','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','OMP_AUTH_BROKER_URL','OMP_AUTH_BROKER_TOKEN'])delete env[key];
  child=spawn(path.join(release,'nozeli'),['--ozone-platform='+(process.env.NOZELI_OZONE||'wayland'),'--inspect=0'],{cwd:project,env,detached:true,stdio:['ignore','pipe','pipe']});
  child.ownedStamp=await processStamp(child.pid);assert(child.ownedStamp);
  exit=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes;});
  await wait(async()=>{try{return(await fetch('http://127.0.0.1:'+port+'/json/version')).ok;}catch{return false;}},'debug endpoint',45000);
  const inspector=await wait(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'owned Inspector',15000);
  browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});
  page=await(await browser.waitForTarget(t=>t.url().startsWith('http://127.0.0.1:'))).page();await page.waitForFunction(()=>window.__nozeliReady);
  observer=await MainObserver.connect(inspector);
  // Observe the real GUI IPC response without issuing a second restart or changing
  // its result. Capture only the bounded evidence explicitly exposed by production.
  await observer.evaluate(`(()=>{const ipc=process.mainModule.require('electron').ipcMain;const original=ipc._invokeHandlers.get('nozeli:invoke');if(typeof original!=='function')throw Error('IPC observer unavailable');globalThis.__nativeCrashRestartEvidence=[];globalThis.__nativeCrashOriginalInvoke=original;ipc._invokeHandlers.set('nozeli:invoke',async function(event,op,payload){const response=await original.call(this,event,op,payload);if(op==='managed.restart')__nativeCrashRestartEvidence.push({ok:response.ok,cleanupEvidence:response.error?.details?.cleanupEvidence??null,code:response.error?.code??null});return response;});return true;})()`);
  await page.waitForSelector('#configuration-setup[open]');await click('#configuration-api-keys');await click('#configuration-import');
  await page.waitForFunction(()=>!document.querySelector('#configuration-setup').open);
  const control=path.join(privateRoot,'control');await fs.mkdir(control,{recursive:true});
  const extension=path.join(control,'acceptance.mjs');
  await fs.writeFile(extension,`import {installAcceptanceControl} from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname,'acceptance-request-control.mjs')).href)};\nexport default pi=>installAcceptanceControl(pi,{endpoint:${JSON.stringify(collector.endpoint)},roleInstance:process.env.NOZELI_AGENT_DIR,brokerURL:process.env.OMP_AUTH_BROKER_URL??null});\n`,{mode:0o600});
  const configPath=path.join(privateRoot,'omp/config.yml'),config=parse(await fs.readFile(configPath,'utf8'));
  config.modelRoles=Object.fromEntries(['default','smol','slow','plan','designer'].map(role=>[role,'paratera/gpt-6.1-sol']));config.defaultThinkingLevel='low';config.extensions=[extension];await fs.writeFile(configPath,stringify(config),{mode:0o600});
  await click('#pick-project');id=await wait(async()=>(await invoke('project.recent')).projects.find(p=>p.name==='project')?.id,'owned project');
  runtime=(await invoke('managed.status',{projectId:id})).runtimeRoot;assert(runtime.startsWith(profile+'/'));
  await invoke('managed.enable',{projectId:id});await wait(async()=>(await invoke('managed.status',{projectId:id})).ready,'native residents');
  stage='revision-one';
  await compose('新建独立Work，名称严格为“NativeCrash”。原任务包括本轮小成果和后续用户要求的原文件崩溃恢复核查，始终同一个Work。Worker只允许新建和修改crash-result.txt，不碰baseline.txt，不Git、不网络、不后台启动。先用真实工具写crash-result.txt为READY并保留换行，实际读回断言，发布result。之后等待用户后续要求，不自行继续。',true);
  const work=await wait(async()=>(await state()).works.find(w=>w.name==='NativeCrash'),'native Work');
  const first=await review(work.id),thread=first.threadId,directory=first.execution.directory,file=path.join(directory,'crash-result.txt');
  assert.equal(await fs.readFile(file,'utf8'),'READY\n');check('r1 actual file and published review',true);
  await selectWork(first);stage='revision-two';
  const accepted=await compose('继续原Work原任务的崩溃恢复核查，仅操作crash-result.txt。该文件已经存在，必须先用nozeli_document_read获取当前readHandle，再用nozeli_document_apply将完整内容改为NATIVE_CRASH_STARTED并保留换行，不能用bash/node覆盖现有文件。编辑成功后，启动一个真实前台bash工具调用执行node：先通过只读fs.readFileSync断言该文件精确为NATIVE_CRASH_STARTED加换行，向stdout输出NATIVE_WAIT_ACTIVE，然后setTimeout等待120秒；整个node不得写任何文件。设置足够工具timeout，不后台化，不发布结果，不Git，不新建任务。后续恢复核查时不得重放等待命令。');
  const executing=await wait(async()=>{
    const s=await state(),job=s.jobs.find(j=>j.id===accepted.id);
    if(job?.status!=='running'){
      if(['failed','interrupted','completed'].includes(job?.status))throw Error('Crash preparation ended before native waiting tool became active');
      return null;
    }
    if((await fs.readFile(file,'utf8'))!=='NATIVE_CRASH_STARTED\n')return null;
    const frame=await invoke('managed.timeline.page',{projectId:id,limit:200});
    const rows=frame.entries.filter(entry=>entry.jobId===accepted.id);
    const call=rows.flatMap(entry=>entry.toolCalls||[]).find(call=>call.name==='bash'&&JSON.stringify(call.input).includes('NATIVE_WAIT_ACTIVE'));
    const completed=call&&rows.some(entry=>entry.tool?.toolCallId===call.id&&!entry.streaming);
    if(!call||completed)return null;
    const screen=await invoke('managed.terminal.screen',{projectId:id,target:work.id});
    // Native tool stdout is rendered by the real PTY, not SessionIndex's
    // message-only stream DTO. Require a standalone output row, not the echoed
    // command/prompt containing this literal.
    const marker=screen.available&&screen.lines.some(line=>line.map(run=>run.text).join('').replace(/[│┃║]/g,'').trim()==='NATIVE_WAIT_ACTIVE');
    if(marker){await save('waiting-native-screen.json',{toolCallId:call.id,screen});return s;}
    return null;
  },'host-authorized partial write followed by actual native waiting bash start',120000);
  const owner=executing.providers[work.id];assert(owner?.pid&&owner.stamp&&await processStamp(owner.pid)===owner.stamp);
  operations.push({kind:'native-SIGKILL',pid:owner.pid,stamp:owner.stamp,jobId:accepted.id,at:Date.now()});process.kill(owner.pid,'SIGKILL');
  const failed=await wait(async()=>{const s=await state(),job=s.jobs.find(j=>j.id===accepted.id);return['failed','interrupted'].includes(job?.status)&&!s.busyTargets.includes(work.id)?s:null;},'durable native failure',90000);
  await save('after-native-crash-state.json',failed);
  check('partial file and exact accepted input survive',await fs.readFile(file,'utf8')==='NATIVE_CRASH_STARTED\n'&&failed.jobs.find(j=>j.id===accepted.id).text===accepted.text);
  const admissions=Object.keys(collector.snapshot().attempts).length,jobs=failed.jobs.length;
  await selectWork(failed.works.find(w=>w.id===work.id));stage='reading-mode-restart';
  await click('[data-managed-session-recovery="'+work.id+'"]');
  await wait(async()=>{
    const responses=await observer.evaluate('__nativeCrashRestartEvidence');
    if(responses.some(r=>!r.ok)){await save('restart-response.json',responses);throw Error('Actual reading-mode restart failed; inspect restart-response.json');}
    const s=await state(),agent=s.agents.find(a=>a.target===work.id);return agent&&!agent.closed&&!agent.restarting?agent:null;
  },'reading-mode explicit restart');
  await pause(2000);const restored=await state();await save('restart-response.json',await observer.evaluate('__nativeCrashRestartEvidence'));
  check('restart preserves original Work/thread/directory and zero replay',restored.jobs.length===jobs&&Object.keys(collector.snapshot().attempts).length===admissions&&restored.agents.find(a=>a.target===work.id).threadId===thread&&restored.works.find(w=>w.id===work.id).execution.directory===directory);
  assert.equal(await fs.readFile(file,'utf8'),'NATIVE_CRASH_STARTED\n');
  stage='explicit-continuation';await selectWork(restored.works.find(w=>w.id===work.id));
  await compose('继续原任务恢复核查，不重放原等待命令。仅操作crash-result.txt：先用nozeli_document_read获取当前readHandle并断言内容仍为NATIVE_CRASH_STARTED加换行；然后用nozeli_document_apply将完整内容改为NATIVE_CRASH_RECOVERED加换行。现有文件禁止用bash/node写。编辑成功后用只读node真实读取断言精确内容，发布result。原Work原文件，不Git不网络不新建任务。');
  const recovered=await review(work.id,failed.works.find(w=>w.id===work.id).revision);
  check('explicit continuation reads partial file and publishes on same thread',recovered.threadId===thread&&recovered.execution.directory===directory&&await fs.readFile(file,'utf8')==='NATIVE_CRASH_RECOVERED\n');
  stage='discard';await invoke('managed.end',{projectId:id,workId:work.id,revision:recovered.revision,decision:'discard'});
  await wait(async()=>{const w=(await state()).works.find(w=>w.id===work.id);if(w.closure?.phase==='blocked')throw Error(w.closure.error);return w.status==='ended'&&w.closure?.phase==='complete';},'explicit discard');
  assert.equal(await fs.readFile(path.join(project,'baseline.txt'),'utf8'),'OWNED_BASELINE\n');
  await save('final-state.json',await state());await close();stage='complete';
}catch(error){
  failure=error;await collector?.stop('failure');await save('error.json',{stage,message:error.message,stack:error.stack,response:error.response});
  if(page){await state().then(s=>save('failure-state.json',s)).catch(()=>{});await page.screenshot({path:path.join(root,'failure.png'),fullPage:true}).catch(()=>{});}
  if(observer)await observer.evaluate('__nativeCrashRestartEvidence').then(r=>save('restart-response.json',r)).catch(()=>{});
}finally{
  await collector?.stop(failure?'failure':'complete');
  if(observer){await observer.evaluate(`(()=>{if(globalThis.__nativeCrashOriginalInvoke)process.mainModule.require('electron').ipcMain._invokeHandlers.set('nozeli:invoke',__nativeCrashOriginalInvoke);return true;})()`).catch(()=>{});observer.close();}
  try{await close();}catch(error){failure??=error;}
  await browser?.disconnect().catch(()=>{});
  if(child?.ownedStamp&&await processStamp(child.pid)===child.ownedStamp){child.kill('SIGTERM');const ended=await Promise.race([exit,pause(5000).then(()=>null)]);if(!ended&&await processStamp(child.pid)===child.ownedStamp)process.kill(-child.pid,'SIGKILL');await Promise.race([exit,pause(5000)]);}
  if(runtime){const stored=JSON.parse(await fs.readFile(path.join(runtime,'state.json'),'utf8').catch(()=>'{}'));for(const record of Object.values(stored.providers||{}))if(record.pid&&record.stamp)owners.set(record.pid,record);}
  let reaped=true;
  for(const record of owners.values())try{assert.equal((await recoverOmpProvider(record,runtime)).verified,true);}catch(error){reaped=false;failure??=error;}
  if(reaped){
    if(runtime)for(const entry of await fs.readdir(path.join(runtime,'agents'),{withFileTypes:true}).catch(()=>[])){if(!entry.isDirectory())continue;const home=path.join(runtime,'agents',entry.name);await fs.cp(path.join(home,'sessions'),path.join(root,'native-history',entry.name),{recursive:true}).catch(e=>{if(e.code!=='ENOENT')throw e;});await fs.rm(home,{recursive:true,force:true});}
    await fs.rm(path.join(privateRoot,'omp'),{recursive:true,force:true});
  }
  await fs.writeFile(path.join(root,'electron.log'),log,{mode:0o600});await save('operations.json',operations);
  await save('result.json',{pass:!failure,stage,error:failure?.stack,checks,release,root,runtime,ownedKeysRemoved:reaped,ledger:collector?.snapshot(),scope:'Focused actual installed paid-model native SIGKILL after r1 publication/r2 partial file; real reading-mode restart, same-thread zero replay, explicit continuation and discard. Not full workflow acceptance. Restart response observation does not change IPC result.'});
  await collector?.close();
}
console.log(JSON.stringify({pass:!failure,stage,checks:checks.length,root}));process.exitCode=failure?1:0;
