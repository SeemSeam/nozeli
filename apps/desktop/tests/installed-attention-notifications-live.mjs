// Real Electron consumer regression, replacing the removed generic-topbar suite.
// Synthetic report/permission/message/fault facts are persisted through real Host,
// Workspace, AttentionLedger and ServiceFaults APIs before the UI reads them.
// No webpage mock, model call, real HTTP-fault classification or native resume claim.
// Source: node tests/installed-attention-notifications-live.mjs
// Package: NOZELI_INSTALLED_BINARY=/absolute/release/nozeli node tests/installed-attention-notifications-live.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';
import {freePort,pause,until} from './installed-attention-harness.mjs';
import {staticReport} from './static-report.fixture.mjs';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';

const require=createRequire(import.meta.url);
const installed=process.env.NOZELI_INSTALLED_BINARY;
const app=await fs.realpath(installed?path.join(path.dirname(installed),'resources/app'):process.env.NOZELI_TEST_APP_ROOT||path.resolve(import.meta.dirname,'..'));
const binary=await fs.realpath(installed||process.env.NOZELI_TEST_BINARY||require('electron'));
const load=rel=>import(pathToFileURL(path.join(app,rel)).href);
const [{DesktopHost},{Workspace},{managedRuntime,readManagedState},{AttentionLedger},{ServiceFaults},{ManagedProjects}]=await Promise.all([
 load('src/main/host.mjs'),load('src/agents/managed/workspace.mjs'),load('src/agents/managed/managed-storage.mjs'),load('src/agents/managed/attention-ledger.mjs'),load('src/agents/managed/service-faults.mjs'),load('src/agents/managed-projects.mjs'),
]);
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-fault-only-top-'));
const profile=path.join(out,'config/desktop'),home=path.join(out,'home'),projectRoot=path.join(out,'project');
await fs.mkdir(home);await fs.mkdir(projectRoot);await fs.writeFile(path.join(projectRoot,'paper.txt'),'Owned synthetic source; must remain unchanged.\n');
const report={ok:false,out,binary,app,checks:[],screenshots:[],matrix:[],errors:[],scope:'Actual Electron + real Host/SQLite/Workspace/AttentionLedger/ServiceFaults. Synthetic durable report, permission, message and structured fault injection; no paid provider, HTTP classification, native execution/resume or webpage backend mock. Invalid durable fault-record probe exercises actual backend status failure, not an OS I/O-failure claim.'};
const seedHost=new DesktopHost(profile),project=(await seedHost.pick(projectRoot)).project;
const store=await Workspace.open(await managedRuntime(seedHost.storage,project.id),projectRoot,{storage:seedHost.storage,projectId:project.id});
const work=await store.submit('FAULT_ONLY_REPORT','Synthetic immutable publication',{name:'FAULT_ONLY_REPORT'});
await store.activate(work.id);
// Publication alone leaves a Work running, so it is correctly excluded from
// the inbox. Seed the completed round and settle through the real Workspace.
const reportJobId='fault-only-report-job';
await store.mutate(()=>{store.state.jobs??=[];store.state.jobs.push({id:reportJobId,target:work.id,revision:1,type:'initial',status:'completed',text:'Synthetic retained publication; no model execution',context:{},completedAt:new Date().toISOString()});});
await store.publish(work.id,1,'result',staticReport('FAULT_ONLY_REPORT retained report'),'fault-only-report-receipt',{jobId:reportJobId});
await store.settle(work.id);
await store.mutate(()=>{
 store.state.messages??=[];
 store.state.messages.push({id:'fault-only-message',sessionId:'fault-only-thread',speaker:'agent',target:work.id,workId:work.id,text:'FAULT_ONLY_MESSAGE unread retained message',createdAt:new Date().toISOString()});
});
await store.setDraft('frontdesk','FAULT_ONLY_UNSENT_DRAFT');
const ledger=new AttentionLedger(seedHost.storage);
// Project a real pending, frozen sensitive-effect request through the same
// manager/AttentionLedger path used by cold managed.status. Never grant it.
const seedManager=new ManagedProjects({userDataDir:profile,host:seedHost});
const prepared=await seedManager.permissions.prepareEffect(project.id,{sourceJobId:reportJobId,permissionTaskId:'fault-only-permission-task',role:'frontdesk',effectType:'host-exec',frozenEffect:{version:1,command:'/usr/bin/synthetic-never-execute',args:[],cwd:projectRoot,scope:'host-exec',action:'admin',elevation:'admin'},originalText:'FAULT_ONLY_PERMISSION synthetic authorization; never approve implicitly'});
assert.equal(prepared.status,'required');
await seedManager.attentionState(project.id,store.state);
seedManager.idleLifecycle.stop();await seedManager.serviceFaults.stop();
const permission=(await ledger.read(project.id)).todos.find(t=>t.destination?.requestId===prepared.request.id);
const resultTodo=store.state.todos.find(t=>t.kind==='result'&&t.workId===work.id);
assert(resultTodo);assert(permission);
assert.equal(store.find(work.id).status,'review');
assert.equal(permission.destination.expectedVersion,prepared.request.version);
const seededSummary=(await seedManager.projectAttentionSummary({projectIds:[project.id]})).projects[0];
assert.equal(seededSummary.complete,true,'seed contains every durable attention collection');
assert.equal(seededSummary.pendingCount,2,'settled report and undecided authorization are both inbox-eligible');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const business=state=>({works:state.works,todos:state.todos,jobs:state.jobs,receipts:state.receipts,messages:state.messages,drafts:state.drafts});
const before=hash(business(await readManagedState(seedHost.storage,project.id)));
const attentionBefore=await ledger.read(project.id);
const permissionBefore=await seedManager.permissions.read(project.id);
await store.close();
await seedHost.storage.putLocal(project.id,'managed:binding',{schema:1,enabled:true,roles:{frontdesk:{provider:'pi'},orchestrator:{provider:'pi'},worker:{provider:'pi'}}});
await seedHost.storage.db.close();
let child,browser,shell,observer,exit,log='';
const mark=text=>{report.checks.push(text);console.log('PASS '+text);};
async function invoke(op,payload={}){
 const reply=await shell.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});
 assert(reply.ok,op+': '+JSON.stringify(reply.error));return reply.value;
}
async function withHost(fn){const host=new DesktopHost(profile);try{return await fn(host);}finally{await host.storage.db.close();}}
async function injectFault(provider){
 return withHost(async host=>{
  const faults=new ServiceFaults({host,storage:host.storage,controllers:new Map(),sourceRevisionOf:async()=>null,modelForTarget:()=>provider+'/scripted',listener:()=>{}});
  try{return await faults.observe(project.id,{job:{id:'fault-only-job-'+provider,target:work.id},admitted:false,recordConfirmed:false,evidence:{schema:1,phase:'pre-admission',provider,model:provider+'/scripted',httpStatus:402,http:[{origin:'http://127.0.0.1:9',pathname:'/v1/chat/completions',method:'POST',status:402,at:new Date().toISOString()}]}});}
  finally{await faults.stop();}
 });
}
async function reload(){await shell.reload({waitUntil:'domcontentloaded'});await shell.waitForFunction(()=>window.__nozeliReady);await shell.click('#recent [data-project-id="'+project.id+'"]');await until(()=>shell.evaluate(id=>document.querySelector('#recent [data-project-id="'+id+'"]')?.getAttribute('aria-current')==='true'&&window.__workspaceGroups?.snapshot()?.projectId===id&&document.querySelector('#project-name')?.textContent==='project',project.id),'explicitly reactivated project after renderer reload');}
const faultDialog='dialog.managed-control-dialog[open]';
async function refreshFaults(){for(const button of await shell.$$(faultDialog+' > button')){if(await button.evaluate(n=>n.textContent==='刷新故障状态')){await button.click();return;}}throw Error('Fault details refresh action missing');}
async function countIs(count){await until(()=>shell.$eval('[data-fault-summary]',(n,count)=>n.textContent.includes(count+'项')||n.textContent.includes(count+' 项'),count).catch(()=>false),'compact fault count '+count);}
async function noGenericTop(){assert.equal(await shell.$$eval('[data-attention-prompt],[data-attention-feedback]',nodes=>nodes.length),0,'removed generic prompt and resolution feedback never mount');}
async function unchangedAttention(){
 const state=(await invoke('managed.status',{projectId:project.id})).state;
 assert.deepEqual(state.attentionNotified,attentionBefore.notified,'background reads never acknowledge');
 assert.equal(state.todos.find(t=>t.id===resultTodo.id)?.status,'open');
 assert.equal(state.todos.find(t=>t.id===permission.id)?.status,'open');
 assert.equal(hash(business(await withHost(host=>readManagedState(host.storage,project.id)))),before,'all original business records and drafts remain unchanged');
 const permissions=await withHost(host=>host.storage.getLocal(project.id,'managed:task-permissions'));
 assert.deepEqual(permissions.requests,permissionBefore.requests,'pending authorization remains frozen and undecided');
 assert.deepEqual(permissions.grants,permissionBefore.grants,'background reads never grant permission');
 assert.deepEqual(permissions.decisions,permissionBefore.decisions,'background reads never decide permission');
 assert.deepEqual(permissions.executions,permissionBefore.executions,'synthetic command is never executed');
}
async function shot(name){const file=path.join(out,name+'.png');await shell.screenshot({path:file});report.screenshots.push(file);}
try{
 const port=await freePort(),env={...process.env};
 for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(?:NOZELI_|CCB_|CODEX_|PI_|OMP_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)||key==='ELECTRON_RUN_AS_NODE'))delete env[key];
 Object.assign(env,{HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_CACHE_HOME:path.join(home,'.cache'),NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:path.join(out,'config'),NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
 child=spawn(binary,[...(installed?[]:[path.join(app,'src/main/main.cjs')]),'--inspect=0','--ozone-platform='+(process.env.NOZELI_TEST_OZONE_PLATFORM||process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':'wayland'))],{cwd:out,env,stdio:['ignore','pipe','pipe']});
 exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);
 child.on('error',error=>report.errors.push(error.stack));
 browser=await until(async()=>{if(child.exitCode!==null)throw Error(log);return puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null,protocolTimeout:20000}).catch(()=>null);},'owned Electron debug endpoint');
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'real workspace shell');
 shell.on('pageerror',error=>report.errors.push(error.stack));
 observer=await MainObserver.connect(await until(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'owned main Inspector'));
 // Observe actual host IPC without changing the handler or its return values.
 await observer.evaluate(`(()=>{const ipc=process.mainModule.require('electron').ipcMain,original=ipc._invokeHandlers.get('nozeli:invoke');globalThis.__faultOnlyCalls=[];globalThis.__faultOnlyOriginalInvoke=original;ipc._invokeHandlers.set('nozeli:invoke',async function(event,op,payload){if(/^(managed\\.(attention\\.ack|fault\\.|task|send|respond))/.test(op))__faultOnlyCalls.push({op,payload});return original.call(this,event,op,payload);});return true;})()`);
 if(await shell.$eval('#configuration-setup',n=>n.open).catch(()=>false))await shell.click('#configuration-cancel');
 await shell.click('#recent [data-project-id="'+project.id+'"]');
 await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,project.id),'project opens');
 // Workspace binding precedes the asynchronous managed-state render. Wait for
 // the actual project facts, then explicitly open the sidebar before hit tests.
 await until(async()=>{const status=await invoke('managed.status',{projectId:project.id});return status.state.works.some(w=>w.id===work.id&&w.status==='review')&&status.state.todos.some(t=>t.id===permission.id&&t.status==='open');},'selected project durable report and pending authorization');
 if(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await shell.click('#toggle-sidebar');
 await until(()=>shell.$eval('#inbox-count',n=>n.textContent==='2'),'report plus permission right inbox');
 await noGenericTop();
 assert.equal(await shell.$eval('.managed-service-faults',n=>n.hidden),true,'nonfault arrivals never create a top banner');
 await until(()=>shell.$eval('#recent [data-project-id="'+project.id+'"] [data-project-attention-badge]',n=>n.textContent==='2'),'independent project report plus permission count');
 for(const id of [resultTodo.id,permission.id]){
  const selector='[data-managed-todo="'+id+'"]';
  await shell.waitForSelector(selector,{visible:true});await shell.focus(selector);
  assert.equal(await shell.$eval(selector,n=>{const r=n.getBoundingClientRect();return !n.disabled&&document.activeElement===n&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),true,'right todo remains keyboard/pointer reachable');
 }
 await until(()=>shell.$eval('[data-todo-row="'+resultTodo.id+'"] .managed-todo-unread',n=>!n.hidden&&n.textContent==='新消息'),'original message unread presentation');
 assert.match(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-label')),/未读消息/);
 await unchangedAttention();await shot('01-no-top-report-permission-message');
 mark('Report and permission remain reachable in the real right inbox; independent project count and message unread survive without generic top UI or acknowledgment');
 await injectFault('fault-alpha');await reload();await countIs(1);await noGenericTop();
 await shot('02-single-fault');
 await injectFault('fault-beta');await reload();await countIs(2);
 assert.equal(await shell.$$eval('.managed-service-faults [data-fault-release],.managed-service-faults [data-fault-receipt],.managed-service-faults article',nodes=>nodes.length),0,'compact top contains neither individual cards, release nor receipts');
 assert.equal(await shell.$$eval('.managed-service-faults button',nodes=>nodes.length),1,'one top details action');
 for(const theme of ['light','dark'])for(const palette of ['sage','slate']){
  await invoke('settings.appearance.save',{theme,palette,font:'system',size:14});
  await shell.waitForFunction(({theme,palette})=>document.documentElement.dataset.theme===theme&&document.documentElement.dataset.palette===palette,{}, {theme,palette});
  const geometry=await shell.$eval('.managed-service-faults',n=>{const r=n.getBoundingClientRect(),s=n.querySelector('[data-fault-summary]').getBoundingClientRect(),b=n.querySelector('button').getBoundingClientRect();return {width:innerWidth,height:r.height,inside:r.left>=0&&r.right<=innerWidth+1,singleRow:Math.min(s.bottom,b.bottom)>Math.max(s.top,b.top),overflow:document.documentElement.scrollWidth>innerWidth+1};});
  assert(geometry.inside&&geometry.singleRow&&!geometry.overflow);report.matrix.push({theme,palette,...geometry});await shot('03-'+theme+'-'+palette);
 }
 for(const width of [390,320]){
  await invoke('workspace.control',{type:'window-control',action:'resize',width,height:700});
  await until(()=>shell.evaluate(()=>document.querySelector('#app').classList.contains('narrow-layout')),'native narrow layout');
  assert.equal(await shell.$eval('.managed-service-faults',n=>{const r=n.getBoundingClientRect(),a=n.querySelector('[data-fault-summary]').getBoundingClientRect(),b=n.querySelector('button').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&Math.min(a.bottom,b.bottom)>Math.max(a.top,b.top)&&document.documentElement.scrollWidth<=innerWidth+1;}),true);
  await shot('04-narrow-'+width);await shell.click('[data-fault-overview-details]');await shell.waitForSelector(faultDialog,{visible:true});await shot('04-narrow-'+width+'-details');await shell.keyboard.press('Escape');
 }
 await invoke('workspace.control',{type:'window-control',action:'resize',width:1280,height:900});
 mark('One and multiple actual durable faults project into one count/details row; four theme combinations and two native narrow sizes captured');
 await shell.click('[data-fault-overview-details]');await shell.waitForSelector(faultDialog,{visible:true});
 assert.equal(await shell.$$eval(faultDialog+' [data-fault-list] [data-fault-release]',nodes=>nodes.length),2);
 await shell.click(faultDialog+' [data-fault-list] [data-fault-details]');
 assert.match(await shell.$eval(faultDialog,n=>n.textContent),/来源|故障证据/);
 // Invalid durable record forces the REAL managed.fault.status read to fail.
 const savedFaultRecord=await withHost(host=>host.storage.getLocal(project.id,'managed:service-faults'));
 try{
  await withHost(host=>host.storage.putLocal(project.id,'managed:service-faults',{schema:-1}));
  const failedRead=await shell.evaluate(()=>nozeli.invoke('managed.fault.status',{}));assert.equal(failedRead.ok,false);assert.equal(failedRead.error.code,'FAULT_STATUS_UNAVAILABLE');
  await refreshFaults();
  await until(()=>shell.$eval('[data-fault-summary]',n=>/待核实/.test(n.textContent)),'known count retained as stale');
  await countIs(2);
  assert.equal(await shell.$$eval(faultDialog+' [data-fault-release]',nodes=>nodes.length>0&&nodes.every(n=>n.disabled)),true,'stale durable read disables every release');
  assert.match(await shell.$eval(faultDialog,n=>n.textContent),/读取未确认|上次快照|待核实/);await shot('05-stale-read-disabled');
 }finally{await withHost(host=>host.storage.putLocal(project.id,'managed:service-faults',savedFaultRecord));}
 await refreshFaults();await until(()=>shell.$eval(faultDialog+' [data-fault-release]',n=>!n.disabled),'restored authoritative read enables release');
 mark('Actual backend invalid-record read fails closed: prior count remains stale and release is disabled until a successful fresh read');
 // Fault reads are available before setup; explicit release correctly requires
 // independent configuration even for a synthetic cold member. No provider is configured.
 await invoke('config.initialize',{mode:'independent'});
 for(const remaining of [1,0]){
  await shell.click(faultDialog+' [data-fault-list] [data-fault-release]');
  await until(async()=>(await invoke('managed.fault.status')).summary.critical===remaining,'real fault release settles '+remaining);
  await shell.waitForSelector(faultDialog+' [data-fault-receipt]',{visible:true});
  assert.equal(await shell.$eval(faultDialog+' [data-fault-receipt]',n=>n.closest('dialog')?.open),true);
  assert.equal(await shell.$$eval('.managed-service-faults [data-fault-receipt]',nodes=>nodes.length),0);
  await shell.locator(faultDialog+' [data-fault-receipt] button').filter(n=>n.textContent==='查看批次详情').click();
  await until(()=>shell.$eval(faultDialog,n=>/本批核对已完成/.test(n.textContent)),'durable batch results');
  assert.match(await shell.$eval(faultDialog,n=>n.textContent),/未连接|冷开记录|核查|已接受继续请求|工作已结束/);
  await shot('06-release-receipt-'+remaining);
  if(remaining){await shell.keyboard.press('Escape');await countIs(remaining);await shell.click('[data-fault-overview-details]');await shell.waitForSelector(faultDialog,{visible:true});}
 }
 await until(()=>shell.$eval('.managed-service-faults',n=>n.hidden),'recovered top hides even while batch receipt remains in dialog');
 await shell.keyboard.press('Escape');await noGenericTop();await unchangedAttention();await shot('07-recovered-no-top');
 const calls=await observer.evaluate('globalThis.__faultOnlyCalls');report.ipc=calls;
 assert.equal(calls.filter(c=>c.op==='managed.attention.ack').length,0,'removing or refreshing top never sends an ack');
 assert.equal(calls.filter(c=>['managed.task','managed.send','managed.respond'].includes(c.op)).length,0,'projection never sends work or approval');
 assert.equal(calls.filter(c=>c.op==='managed.fault.release').length,2,'each explicit dialog click produces one release');
 mark('Explicit release and durable per-member receipts live only in the original dialog; all clear removes the top without acknowledging or resolving report/permission');
 await observer.evaluate(`(()=>{const ipc=process.mainModule.require('electron').ipcMain;ipc._invokeHandlers.set('nozeli:invoke',__faultOnlyOriginalInvoke);delete globalThis.__faultOnlyOriginalInvoke;return true;})()`);
 observer.close();observer=null;
 await invoke('session.requestClose');
 assert.deepEqual(await Promise.race([exit,pause(30000).then(()=>null)]),{code:0,signal:null},'owned app exits normally');child=null;
 await browser.disconnect();browser=null;
 await withHost(async host=>{
  assert.equal(hash(business(await readManagedState(host.storage,project.id))),before);
  assert.deepEqual(await new AttentionLedger(host.storage).read(project.id),attentionBefore);
  const permissions=await host.storage.getLocal(project.id,'managed:task-permissions');
  for(const key of ['requests','grants','decisions','executions'])assert.deepEqual(permissions[key],permissionBefore[key]);
  const durable=await host.storage.getLocal(project.id,'managed:service-faults');assert.equal(durable.faults.every(f=>f.state==='released'),true);assert.equal(durable.batches.length,2);
 });
 assert.equal(await fs.readFile(path.join(projectRoot,'paper.txt'),'utf8'),'Owned synthetic source; must remain unchanged.\n');
 assert.deepEqual(report.errors,[]);mark('Normal exit preserves original source, drafts, reports, jobs, messages, todo state and complete unacknowledged ledger');report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});console.error(error.stack);}
finally{
 observer?.close();
 if(child?.exitCode===null){await shell?.evaluate(()=>nozeli.invoke('session.requestClose')).catch(()=>{});await Promise.race([exit,pause(10000)]);if(child.exitCode===null)child.kill('SIGTERM');}
 await browser?.disconnect().catch(()=>{});
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'main.log'),log);console.log(out);
}
