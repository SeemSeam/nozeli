// Installed release OR source app-root Electron + real private OMP; synthetic projects and loopback scripted model only.
// Coverage: six sequential A/B switches, rapid queued switches, real held native input surviving a switch, real Worker via
// managed.task -> nozeli_dispatch -> native bash tool, explicit workspace.closeProject + reopen (same owners/threads, new
// owner only after intentional managed.restart), two normal app restarts checking BOTH projects (threads, drafts, jobs)
// with real follow-up rounds in both plus worker continuations, live provider PID evidence, resource headroom assertions.
// Worker stop/reconnect-at-capacity unit coverage lives in tests/agent-resource-native.test.mjs; the user-system-dependent
// tests/omp-native-worker-restart-live.mjs is intentionally NOT run here.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';
import {DatabaseSync} from 'node:sqlite';
const require=createRequire(import.meta.url);
const argv=process.argv.slice(2),flag=name=>{const i=argv.indexOf(name);return i>=0?argv[i+1]:null;};
const positional=argv.find((arg,index)=>!arg.startsWith('--')&&argv[index-1]!=='--app-root'&&argv[index-1]!=='--release')??null;
const releaseArg=flag('--release')??(flag('--app-root')?null:positional);
const appRoot=flag('--app-root')??(releaseArg?null:path.resolve(import.meta.dirname,'..'));
if(!releaseArg&&!appRoot)throw Error('need --app-root, --release or a legacy release directory argument');
const mode=releaseArg?{kind:'release',path:await fs.realpath(releaseArg)}:{kind:'app-root',path:await fs.realpath(appRoot)};
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-switch-installed-'));
const report={mode,out,ok:false,checks:[],exits:[],errors:[],requests:0,requestsLog:[],launches:[],rapid:null,closeReopen:null,worker:null,restarts:[],followUps:[],resources:null,docSurface:null,notes:[]};
console.log('EVIDENCE_ROOT='+out);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let child,browser,shell,exit,log='',held=false,pending=[];
const tool=(name,args,id)=>({role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const nonceOf=text=>String(text||'').match(/SWITCHW[0-9]+/g)?.at(-1)??null;
const rounds=new Map();
const answer=(res,delta,finish)=>{res.writeHead(200,{'content-type':'text/event-stream'});for(const [part,end] of [[delta,null],[{},finish]])res.write('data: '+JSON.stringify({id:'switch-local',object:'chat.completion.chunk',choices:[{index:0,delta:part,finish_reason:end}]})+'\n\n');res.end('data: [DONE]\n\n');};
const server=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{report.requests++;let input={};try{input=JSON.parse(body);}catch{}
 const names=(input.tools||[]).map(t=>t.function?.name||t.name),role=names.includes('nozeli_dispatch')?'orchestrator':names.includes('nozeli_skill_read')?'worker':'frontdesk';
 const lastUser=[...(input.messages||[])].reverse().find(m=>m.role==='user'),nonce=nonceOf(lastUser?.content);
 let delta,finish='stop';
 if(role==='orchestrator'&&!nonce){delta=tool('nozeli_manage',{action:'status',workName:'@state',text:'Report current work status without starting a Worker.'},'b-status-seed');finish='tool_calls';}
 else if(role==='frontdesk'||!nonce)delta={role:'assistant',content:'SWITCH_REPLY'};
 else{const round=rounds.get(nonce)??{orchestrator:0,worker:0};round[role]++;rounds.set(nonce,round); // counters are per role: orchestrator and worker share the nonce
  if(role==='orchestrator'){if(round.orchestrator===1){delta=tool('nozeli_dispatch',{name:nonce,brief:'Create '+nonce+'.txt with exact content '+nonce+' in this work, then finish.'},nonce+'-dispatch');finish='tool_calls';}else delta={role:'assistant',content:'Dispatched '+nonce};}
  else{if(round.worker===1){delta=tool('bash',{command:'printf '+nonce+' > '+nonce+'.txt'},nonce+'-bash');finish='tool_calls';}else delta={role:'assistant',content:'Verified '+nonce};}}
 report.requestsLog.push({role,nonce,tool:delta.tool_calls?.[0]?.function.name??null});
 if(held){pending.push({res,delta,finish});return;}answer(res,delta,finish);});});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const a=path.join(out,'project-a'),b=path.join(out,'project-b');
for(const dir of [a,b]){await fs.mkdir(dir);await fs.writeFile(path.join(dir,'notes.txt'),'Synthetic switch fixture\n');}
const {DesktopHost}=await import(new URL('../src/main/host.mjs',import.meta.url));
const fixtureHost=new DesktopHost(path.join(out,'config/desktop'));
const aid=(await fixtureHost.pick(a)).project.id,bid=(await fixtureHost.pick(b)).project.id;
await fixtureHost.storage.db.close();
const profile=path.join(out,'config/desktop');
async function providerPids(projectId){ // live native owner processes, verified against the durable stamp registry
 const catalog=new DatabaseSync(path.join(profile,'nozeli/storage-v2/catalog.sqlite'),{readOnly:true});let project;
 try{project=JSON.parse(catalog.prepare("SELECT value FROM records WHERE collection='instances' AND id=?").get(projectId).value);}finally{catalog.close();}
 const local=new DatabaseSync(path.join(profile,'nozeli/storage-v2/instances',project.instanceId,'ui.sqlite'),{readOnly:true});let providers;
 try{providers=JSON.parse(local.prepare("SELECT value FROM records WHERE collection='ui' AND id='managed:providers'").get().value);}finally{local.close();}
 const entries=await Promise.all(Object.entries(providers).map(async([target,owner])=>{assert.equal(await processStamp(owner.pid),owner.stamp,'live native owner '+target);return {target,pid:owner.pid};}));
 entries.sort((x,y)=>x.target.localeCompare(y.target));return entries;
}
async function until(fn,label,ms=90000){const end=Date.now()+ms;while(Date.now()<end){if(child&&(child.exitCode!==null||child.signalCode))throw Error('app exited: '+log);const value=await fn();if(value)return value;await pause(100);}throw Error('Timeout: '+label);}
async function raw(op,p={}){return shell.evaluate(({op,p})=>window.nozeli.invoke(op,p),{op,p});}
async function call(op,p={}){report.stage=op;const r=await raw(op,p);assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
async function launch(){
 const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
 const env={...process.env};for(const k of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(k)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(k))delete env[k];
 Object.assign(env,{HOME:path.join(out,'home'),XDG_CONFIG_HOME:path.join(out,'home/.config'),XDG_DATA_HOME:path.join(out,'home/.local/share'),XDG_CACHE_HOME:path.join(out,'home/.cache'),NOZELI_CONFIG_ROOT:path.join(out,'config'),NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_TEST_PICK:[a,b].join('\n'),NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
 await fs.mkdir(env.HOME,{recursive:true});
 const ozone='--ozone-platform=wayland';
 child=mode.kind==='release'?spawn(path.join(mode.path,'nozeli'),[ozone],{cwd:out,env,stdio:['ignore','pipe','pipe']}):spawn(require('electron'),[path.join(mode.path,'src/main/main.cjs'),ozone],{cwd:mode.path,env,stdio:['ignore','pipe','pipe']});
 report.launches.push({mode:mode.kind,path:mode.path,port});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const s of [child.stdout,child.stderr])s.on('data',v=>log+=v);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell ready');
 const watched=new WeakSet(),watch=page=>{if(page&&!watched.has(page)){watched.add(page);page.on('pageerror',e=>report.errors.push(e.message));}};
 for(const page of await browser.pages())watch(page);browser.on('targetcreated',async target=>{watch(await target.page().catch(()=>null));});
}
async function close(){ // normal close only when both projects are fully idle
 await until(async()=>{for(const id of [aid,bid]){const s=(await raw('managed.status',{projectId:id})).value?.state;if(!s)return false;if(s.jobs?.some(j=>['queued','running'].includes(j.status)))return false;if(s.busyTargets?.length)return false;}return true;},'both projects idle before close');
 await call('session.requestClose');const result=await Promise.race([exit,pause(30000).then(()=>null)]);assert.deepEqual(result,{code:0,signal:null});report.exits.push(result);await browser.disconnect();browser=null;child=null;}
async function select(id){await shell.click('#recent [data-project-id="'+id+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,id),'project activated');}
async function state(id){return (await call('managed.status',{projectId:id})).state;}
const owners=s=>s.agents.filter(x=>!x.closed).map(({target,ownerId,threadId})=>({target,ownerId,threadId})).sort((x,y)=>x.target.localeCompare(y.target));
const threads=s=>Object.fromEntries(['frontdesk','orchestrator'].map(r=>[r,s.residents?.[r]?.threadId??null]));
async function followUp(id,key,label){const before=report.requests;const sent=await call('managed.send',{projectId:id,target:'frontdesk',text:'Only reply SWITCH_REPLY; no tools.',requestKey:key});
 await until(async()=>(await state(id)).jobs.find(j=>j.id===sent.jobId)?.status==='completed','real follow-up reply '+label);
 assert.equal(report.requests,before+1,'follow-up '+label+' drove exactly one real native model round');
 report.followUps.push({project:id,label,jobId:sent.jobId,requestNumber:report.requests});return sent;}
async function workerFile(projectId,workId,nonce,key){const before=report.requests;
 const sent=await call('managed.send',{projectId:projectId,target:workId,text:'Continue this same work: create '+nonce+'.txt with exact content '+nonce+', then finish this turn.',requestKey:key});
 const work=await until(async()=>{const s=await state(projectId);const w=s.works.find(w=>w.id===workId);if(s.jobs.find(j=>j.id===sent.jobId)?.status!=='completed')return;if(!w?.execution?.directory)return;try{if(await fs.readFile(path.join(w.execution.directory,nonce+'.txt'),'utf8')!==nonce)return;}catch{return;}if(s.busyTargets?.includes(workId))return;return w;},'real worker continuation tool '+nonce,120000);
 assert.equal(report.requests,before+2,'worker turn '+nonce+' used exactly bash+reply native rounds');
 assert.equal(work.threadId,report.worker.threadId,'worker continuation keeps the original thread');report.worker.files.push({nonce,path:path.join(work.execution.directory,nonce+'.txt')});return work;}
try{
 await launch();await call('config.initialize',{mode:'independent'});
 await call('settings.providers.save',{provider:'switch-local',model:'scripted',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',api:'openai-completions',key:'synthetic-local-only'});
 await call('settings.models.save',{frontdesk:'switch-local/scripted',orchestrator:'switch-local/scripted',worker:'switch-local/scripted'});
 await select(aid);
 await call('settings.agents.save',{globalLimit:6});
 await call('managed.enable',{projectId:aid});
 await until(async()=>owners(await state(aid)).length===2,'A residents');
 const sent=await call('managed.send',{projectId:aid,target:'frontdesk',text:'Only reply SWITCH_REPLY; no tools.',requestKey:'switch-native-first'});
 await until(async()=>(await state(aid)).jobs.find(j=>j.id===sent.jobId)?.status==='completed','first reply');
 assert.equal(report.requests,1,'first real native round');
 const original=owners(await state(aid)),aThreads0=threads(await state(aid));
 await shell.evaluate(()=>window.__workspaceGroups.open({kind:'document',relPath:'notes.txt'}));
 const doc=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath==='notes.txt'&&window.__nozeliReady).catch(()=>false))return p;},'real document surface');
 const docId=await doc.evaluate(()=>window.__workspaceScope.viewId);
 await doc.evaluate(()=>window.__nozeliInput.insert('DOC_SWITCH_KEEP'));
 report.docSurface={viewId:docId,inputApi:'window.__nozeliInput.insert — surface test API; not synthetic keyboard or ordinary user input'};
 report.notes.push('doc screenshots: shell PNG cannot capture WebContentsView content; the doc page PNG is the real surface capture, with DOM size/focus metrics in report.docSurface');
 await select(bid);await call('managed.enable',{projectId:bid});await until(async()=>owners(await state(bid)).length===2,'B residents');
 // Empty native threads have no journal and may be regenerated on restart;
 // exercise a real B orchestrator turn before requiring durable identity.
 const bOrchestratorTurn=await call('managed.send',{projectId:bid,target:'orchestrator',text:'Only reply SWITCH_REPLY; no tools.',requestKey:'switch-b-orchestrator-seed'});
 await until(async()=>(await state(bid)).jobs.find(j=>j.id===bOrchestratorTurn.jobId)?.status==='completed','B orchestrator has durable history');
 const switchBaseline=report.requests;
 const second=owners(await state(bid)),bThreads0=threads(await state(bid));
 for(let n=0;n<6;n++){await select(aid);await select(bid);assert.deepEqual(owners(await state(aid)),original);assert.deepEqual(owners(await state(bid)),second);}
 assert.equal(report.requests,switchBaseline);report.checks.push('six A/B round trips keep all four native owners and threads; no replay');
 const rapidPlan=[aid,bid,aid,bid],samples=[];
 await shell.evaluate(()=>{window.__switchTransitions=0;window.__switchTransitionListener=event=>{if(!event.detail.active)window.__switchTransitions++;};window.addEventListener('nozeli-project-transition',window.__switchTransitionListener);});
 samples.push(...await shell.evaluate(plan=>plan.map(id=>{const button=document.querySelector('#recent [data-project-id="'+id+'"]');if(!button)throw Error('Missing rapid project control '+id);button.click();return window.__workspaceGroups?.snapshot()?.projectId??null;}),rapidPlan));
 await until(()=>shell.evaluate(({id,count})=>window.__switchTransitions>=count&&window.__workspaceGroups?.snapshot()?.projectId===id,{id:rapidPlan.at(-1),count:rapidPlan.length}),'all rapid queued switches settle on the final project');
 await shell.evaluate(()=>window.removeEventListener('nozeli-project-transition',window.__switchTransitionListener));
 assert.deepEqual(owners(await state(aid)),original);assert.deepEqual(owners(await state(bid)),second);assert.equal(report.requests,switchBaseline);
 report.rapid={plan:rapidPlan.map(id=>id===aid?'A':'B'),samples,input:'synchronous DOM button.click burst through the real recent-project handlers; six ordinary pointer-driven round trips precede this queue stress'};report.checks.push('rapid queued switches settle deterministically with stable owners and no replay');
 held=true;const job=await call('managed.send',{projectId:bid,target:'frontdesk',text:'Only reply SWITCH_REPLY; no tools.',requestKey:'switch-held-round'});await until(()=>pending.length===1,'native request held');await select(aid);held=false;for(const p of pending.splice(0))answer(p.res,p.delta,p.finish);
 await until(async()=>(await state(bid)).jobs.find(j=>j.id===job.jobId)?.status==='completed','background completes');await pause(600);assert.deepEqual(owners(await state(bid)),second);assert.equal(report.requests,switchBaseline+1);report.checks.push('real held native input survives a project switch and completes in the background with the same owners');
 assert((await doc.evaluate(()=>window.__nozeliInput.text())).includes('DOC_SWITCH_KEEP'),'switch round trips retain the real editor');
 await doc.screenshot({path:path.join(out,'switch-doc-live.png')});
 Object.assign(report.docSurface,await doc.evaluate(()=>({innerWidth,innerHeight,hasFocus:document.hasFocus(),text:window.__nozeliInput.text()})));
 assert(report.docSurface.innerWidth>0&&report.docSurface.innerHeight>0,'real document surface has nonzero DOM size');
 await shell.evaluate(viewId=>window.__workspaceGroups.command({type:'floatOpen',viewId}),docId);
 const detached=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.role==='detached'&&window.__nozeliReady).catch(()=>false))return p;},'detached root');
 const detachedId=await detached.evaluate(()=>window.__workspaceScope.windowId);await shell.evaluate(windowId=>window.__workspaceGroups.command({type:'dock',windowId}),detachedId);
 assert((await doc.evaluate(()=>window.__nozeliInput.text())).includes('DOC_SWITCH_KEEP'),'native window round trip retains editor content');
 const denied=await shell.evaluate(projectId=>window.nozeli.invoke('state.write',{projectId,state:{}}),bid);assert.equal(denied.error?.code,'PROJECT_SCOPE_DENIED','real cross-project write remains forbidden');
 report.checks.push('real edited document survives project switches and native float/dock; cross-project write remains denied');
 // real Worker via native orchestrator dispatch and native bash tool
 const taskBefore=report.requests;
 await call('managed.task',{projectId:aid,text:'Create SWITCHW1 evidence: create SWITCHW1.txt with exact content SWITCHW1 in the work directory, then finish.',requestKey:'task-switchw1'});
 const work=await until(async()=>{const s=await state(aid);const failed=s.jobs?.find(j=>j.status==='failed');if(failed)throw Error(JSON.stringify(failed));const w=s.works.find(w=>w.name==='SWITCHW1');if(!w?.execution?.directory)return;try{if(await fs.readFile(path.join(w.execution.directory,'SWITCHW1.txt'),'utf8')!=='SWITCHW1')return;}catch{return;}if(s.busyTargets?.includes(w.id))return;return w;},'real dispatched worker runs a native tool',120000);
 assert(work.threadId,'dispatched worker bound a real thread');
 assert.deepEqual(report.requestsLog.slice(taskBefore).map(({role,tool})=>({role,tool})),[{role:'orchestrator',tool:'nozeli_dispatch'},{role:'worker',tool:'bash'},{role:'worker',tool:null}],'one-way dispatch followed by a native Worker tool and final reply, with no replay');
 report.worker={workId:work.id,threadId:work.threadId,dispatchTool:'nozeli_dispatch (orchestrator) + bash (worker), real structured tool calls through the local scripted model',files:[{nonce:'SWITCHW1',path:path.join(work.execution.directory,'SWITCHW1.txt')}]};
 report.checks.push('managed.task dispatches a real native Worker via structured tool calls; worker executes a real bash tool in its execution worktree');
 const resources=await call('settings.agents.status',{projectId:aid});
 assert(resources.globalLimit>=resources.globalUsed&&resources.globalUsed<resources.globalLimit,'observed native owners stay below global capacity');assert.equal(resources.globalUsed,5,'observed owners are exactly A frontdesk+orchestrator+worker and B frontdesk+orchestrator');
 report.resources={globalLimit:resources.globalLimit,globalUsed:resources.globalUsed,agents:resources.agents.map(x=>({projectId:x.projectId===aid?'A':'B',target:x.target,state:x.state}))};
 report.checks.push('resource limit '+resources.globalLimit+' >= observed '+resources.globalUsed+' native owners, below capacity (at-limit behavior covered by agent-resource-native.test.mjs)');
 // explicit project close + reopen: same owner processes and threads; new owner only after intentional stop
 const bOwners=owners(await state(bid)),bPidsBefore=await providerPids(bid),beforeClose=report.requests;
 await call('workspace.closeProject',{projectId:bid,operationId:'switch-close-b-1'});
 const closed=await call('managed.status',{projectId:bid});
 assert.equal(closed.ready,true,'explicit close keeps native residents connected');assert.deepEqual(owners(closed.state),bOwners);
 const bPidsClosed=await providerPids(bid);assert.deepEqual(bPidsClosed,bPidsBefore,'explicit close never restarts resident processes');
 await select(bid);
 assert.deepEqual(owners(await state(bid)),bOwners,'reopen keeps the same owners and threads');
 assert.deepEqual(await providerPids(bid),bPidsBefore,'reopen reuses the identical live native processes');
 assert.equal(report.requests,beforeClose,'close/reopen replays nothing');
 const bFrontBefore=bOwners.find(x=>x.target==='frontdesk');
 const restartReceipt=await call('managed.restart',{projectId:bid,target:'frontdesk'});
 assert.equal(restartReceipt.restarted,true,'intentional stop restarts the frontdesk owner');
 const bAfterRestart=owners(await state(bid)),bFrontAfter=bAfterRestart.find(x=>x.target==='frontdesk');
 assert.notEqual(bFrontAfter.ownerId,bFrontBefore.ownerId,'intentional stop produces a new owner');
 assert.equal(bFrontAfter.threadId,bFrontBefore.threadId,'intentional stop resumes the same resident thread');
 assert.equal(bAfterRestart.find(x=>x.target==='orchestrator').ownerId,bOwners.find(x=>x.target==='orchestrator').ownerId,'untouched resident keeps its owner');
 assert.equal(report.requests,beforeClose,'explicit restart replays no input');
 report.closeReopen={bPidsBefore,reopenSamePids:true,restartedFrontdesk:{oldOwnerId:bFrontBefore.ownerId,newOwnerId:bFrontAfter.ownerId,threadId:bFrontAfter.threadId}};
 report.checks.push('explicit workspace.closeProject and reopen retain identical live owner processes and threads; a new owner appears only after the intentional managed.restart');
 await call('managed.draft',{projectId:bid,target:'frontdesk',text:'B_DRAFT_RESTART'});
 const aWork=work;
 await doc.evaluate(()=>window.__nozeliInput.insert('DOC_CLOSE_KEEP')); // latest edit while the first instance is still live
 await shell.screenshot({path:path.join(out,'switch-before-restart-1.png')});
 // two normal app restarts, BOTH projects each time, real follow-ups through the native CLI in both
 for(const round of [1,2]){
  const aJobs=(await state(aid)).jobs.length,bJobs=(await state(bid)).jobs.length,requestsBefore=report.requests;
  await close();
  if(round===1){const retainedHost=new DesktopHost(profile);const retained=await retainedHost.storage.getRecovery(aid,'workspace:'+docId);await retainedHost.storage.db.close();assert(retained?.candidate?.text?.includes('DOC_CLOSE_KEEP'),'normal close durably retains the latest document edit');}
  const entry={round,requestsBefore,jobs:{a:aJobs,b:bJobs}};
  await launch();
  await select(aid);await call('managed.connect',{projectId:aid});
  await until(async()=>owners(await state(aid)).length===2,'restart '+round+' A residents');
  const sA=await state(aid);
  assert.equal(sA.residents.frontdesk.threadId,aThreads0.frontdesk,'A frontdesk thread survives restart '+round);
  assert.equal(sA.residents.orchestrator.threadId,aThreads0.orchestrator,'A orchestrator thread survives restart '+round);
  assert.equal(sA.jobs.length,aJobs,'A jobs retained across restart '+round);
  const wKeep=sA.works.find(w=>w.id===aWork.id);assert(wKeep&&wKeep.threadId===report.worker.threadId,'A worker work and thread retained across restart '+round);
  assert.equal(report.requests,requestsBefore,'startup replays no model input');
  await providerPids(aid).then(pids=>entry.aProviders=pids);
  await shell.evaluate(()=>window.__workspaceGroups.open({kind:'document',relPath:'notes.txt'}));
  const doc2=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath==='notes.txt'&&window.__nozeliReady).catch(()=>false))return p;},'restart '+round+' document surface');
  const docText=await doc2.evaluate(()=>window.__nozeliInput.text());
  assert(docText.includes('DOC_CLOSE_KEEP'),'document draft restored after restart '+round);
  await doc2.screenshot({path:path.join(out,'switch-doc-restart-'+round+'.png')});
  Object.assign(report.docSurface,{['restart'+round]:await doc2.evaluate(()=>({innerWidth,innerHeight,hasFocus:document.hasFocus(),text:window.__nozeliInput.text()}))});
  await followUp(aid,'switch-follow-a-'+round,'A restart '+round);
  const nonce='SWITCHW'+(round+1);await workerFile(aid,aWork.id,nonce,'work-'+nonce.toLowerCase());
  entry.workerThreadStable=true;
  await select(bid);await call('managed.connect',{projectId:bid});
  await until(async()=>owners(await state(bid)).length===2,'restart '+round+' B residents');
  const sB=await state(bid);
  assert.equal(sB.residents.frontdesk.threadId,bFrontAfter.threadId,'B frontdesk thread survives restart '+round);
  assert.equal(sB.residents.orchestrator.threadId,bThreads0.orchestrator,'B orchestrator thread survives restart '+round);
  assert.equal(sB.jobs.length,bJobs,'B jobs retained across restart '+round);
  assert.equal(sB.drafts.frontdesk,'B_DRAFT_RESTART','B GUI draft retained across restart '+round);
  await providerPids(bid).then(pids=>entry.bProviders=pids);
  await followUp(bid,'switch-follow-b-'+round,'B restart '+round);
  await shell.screenshot({path:path.join(out,'switch-after-restart-'+round+'.png')});
  report.restarts.push(entry);
 }
 report.checks.push('two normal app restarts retain BOTH projects threads, drafts (A document + B composer), jobs and the worker work; real follow-up rounds proved live CLI connectivity in both projects each time');
 const finalResources=await call('settings.agents.status',{projectId:bid});
 assert(finalResources.globalUsed<finalResources.globalLimit,'final observed native owners remain below capacity');
 report.resources.final={globalLimit:finalResources.globalLimit,globalUsed:finalResources.globalUsed};
 assert.equal(report.exits.length,2);assert.deepEqual(report.exits[0],{code:0,signal:null});
 await close();assert.equal(report.exits.length,3);
 report.checks.push('three normal exits (initial + two restarts) all acknowledged with code 0 exit receipts');
 assert.deepEqual(report.errors,[]);report.ok=true;
}catch(e){report.failure=e.stack;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});process.exitCode=1;}
finally{for(const p of pending.splice(0))answer(p.res,p.delta,p.finish);if(child&&child.exitCode===null){try{await close();}catch{child?.kill('SIGTERM');}}await browser?.disconnect().catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
