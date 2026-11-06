// Real Electron (source app-root) + real private native Pi owners with a local
// loopback scripted provider only: no paid model, no personal credentials. No
// source patches, no mock renderer echoes — every assertion observes production
// host IPC, production workspace surfaces and live native owner processes.
// Frontdesk-only main conversation regression:
//  · main composer is always frontdesk; a fresh view restores the canonical
//    durable frontdesk draft, never a Worker draft;
//  · a persisted legacy Worker input identity (viewState identity + window
//    draft + legacy durable draft) reloads as a frontdesk view with the legacy
//    input quarantined read-only in retainedConversationInputs — copied
//    nowhere, sent nowhere; unrelated Works' durable drafts are not scanned
//    into the view and stay untouched in the store;
//  · direct Worker/Orchestrator conversation admission is denied before any
//    host work (CONVERSATION_TARGET_REJECTED): conversation-action from every
//    scope, and Worker-target managed.send from the conversation surface —
//    with no owner change and no model request;
//  · task rows open the overview dialog (original backend draft readable
//    read-only) or the frozen report — never a Worker conversation; report
//    reading and 回到前台讨论 leave the frontdesk recipient and draft intact;
//  · ordinary send produces exactly one frontdesk job; explicit 提交后台任务
//    routes exactly one orchestrator intake (managed.task) and a real
//    dispatched Worker whose bash/publish run only inside its execution
//    worktree; synthetic project sources never change;
//  · per-project draft isolation, view reload persistence, and a full app
//    restart that replays no model input while retaining threads, works,
//    drafts and the quarantine;
//  · optional NOZELI_FRONTDESK_PROJECT: a small read-only real-content copy
//    (README + one renderer source) is placed in synthetic project A before
//    registration and the originals are hashed before/after; the original
//    repository is never registered, opened or written.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';

const exec=promisify(execFile),require=createRequire(import.meta.url);
const root=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-frontdesk-only-'));
const report={out,ok:false,scope:'Actual Electron binary (source main) and private resident native Pi owners; loopback scripted model only'+(process.env.NOZELI_FRONTDESK_PROJECT?'; actual content copy from NOZELI_FRONTDESK_PROJECT (read-only, hashed before/after)':'')+'; synthetic projects only; no paid model, no personal credentials',checks:[],failures:[],exits:[],requests:0,requestsLog:[],launches:[],worker:null,denials:[],restart:null,realCopies:[],notes:[]};
console.log('EVIDENCE_ROOT='+out);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const tool=(name,args,id)=>({role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const rounds=new Map();
const answer=(res,delta,finish)=>{res.writeHead(200,{'content-type':'text/event-stream'});for(const [part,end] of [[delta,null],[{},finish]])res.write('data: '+JSON.stringify({id:'frontdesk-local',object:'chat.completion.chunk',choices:[{index:0,delta:part,finish_reason:end}]})+'\n\n');res.end('data: [DONE]\n\n');};
const server=http.createServer((req,res)=>{let body='';req.on('data',bytes=>body+=bytes);req.on('end',()=>{report.requests++;let input={};try{input=JSON.parse(body);}catch{}
  const names=(input.tools||[]).map(t=>t.function?.name||t.name);
  const role=names.includes('nozeli_dispatch')?'orchestrator':names.includes('nozeli_publish')?'worker':'frontdesk';
  const text=(input.messages||[]).map(message=>typeof message.content==='string'?message.content:(Array.isArray(message.content)?message.content:[]).map(part=>part.text??'').join('\n')).join('\n');
  const nonce=(text.match(/FRONTW[0-9]+/g)||[]).sort((x,y)=>Number(y.slice(6))-Number(x.slice(6)))[0]??null;
  let delta,finish='stop';
  if(role==='frontdesk')delta={role:'assistant',content:'FRONT_REPLY'};
  else if(role==='orchestrator'){
    const round=rounds.get(nonce)??{orchestrator:0,worker:0};round.orchestrator++;rounds.set(nonce,round);
    if(nonce&&round.orchestrator===1){delta=tool('nozeli_dispatch',{name:nonce,brief:'Create '+nonce+'.txt with exact content '+nonce+' inside this work execution directory, then publish the final result and finish.'},nonce+'-dispatch');finish='tool_calls';}
    else delta={role:'assistant',content:nonce?'Dispatched '+nonce:'FRONT_REPLY'};
  }else{
    const round=rounds.get(nonce)??{orchestrator:0,worker:0};round.worker++;rounds.set(nonce,round);
    if(nonce&&round.worker===1){delta=tool('bash',{command:'printf '+nonce+' > '+nonce+'.txt'},nonce+'-bash');finish='tool_calls';}
    else if(nonce&&round.worker===2){delta=tool('nozeli_publish',{kind:'result',content:'<h1>'+nonce+' result</h1><p>Real dispatched native Worker published through its own tools.</p>',files:[]},nonce+'-publish');finish='tool_calls';}
    else delta={role:'assistant',content:'Verified '+(nonce??'FRONTW')};
  }
  report.requestsLog.push({role,nonce,tool:delta.tool_calls?.[0]?.function.name??null});
  answer(res,delta,finish);});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));

const hashOf=async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const git=async(cwd,...args)=>(await exec('git',['-c','user.name=Frontdesk Only Fixture','-c','user.email=frontdesk-only@example.invalid',...args],{cwd,maxBuffer:16*1024*1024})).stdout.trim();
const a=path.join(out,'project-a'),b=path.join(out,'project-b');
// Optional read-only real-content copy lands in synthetic project A BEFORE the
// baseline commit; the original repository is never registered or written.
const realRoot=process.env.NOZELI_FRONTDESK_PROJECT?await fs.realpath(process.env.NOZELI_FRONTDESK_PROJECT).catch(()=>null):null;
if(process.env.NOZELI_FRONTDESK_PROJECT&&!realRoot)report.notes.push('NOZELI_FRONTDESK_PROJECT unreadable; continuing synthetic-only');
for(const dir of [a,b]){await fs.mkdir(dir);await fs.writeFile(path.join(dir,'notes.txt'),'Synthetic frontdesk-only fixture source.\n');await fs.writeFile(path.join(dir,'.gitignore'),'/.nozeli/\n');}
for(const rel of realRoot?['README.md','apps/desktop/src/renderer/managed-agent-panel.mjs']:[]){
  try{await fs.copyFile(path.join(realRoot,rel),path.join(a,'real-'+rel.replaceAll('/','__')));report.realCopies.push({rel,sha256:await hashOf(path.join(realRoot,rel))});}
  catch(error){report.notes.push('real copy skipped '+rel+': '+error.code);}
}
for(const dir of [a,b]){await git(dir,'init','--initial-branch=main');await git(dir,'add','.');await git(dir,'commit','-m','synthetic baseline');}
// Seed durable facts with the production controller (synthetic state only):
// a queued Work (cold at open, so the app never auto-runs it), an ended Work
// with a complete closure (releases its slot), and legacy drafts keyed by
// target. The queued seed is the persisted legacy conversation target.
const profile=path.join(out,'config/desktop');
const host=new DesktopHost(profile);
const aid=(await host.pick(a)).project.id,bid=(await host.pick(b)).project.id;
const runtimeRoot=path.join(await host.storage.localDirectory(aid),'execution');
const controller=await Controller.open({storage:host.storage,projectId:aid,runtimeRoot,contentRoot:a});
const seedQueued=await controller.store.submit('Frontdesk-only queued seed','Synthetic queued Work whose UI entry must open an overview, never a Worker conversation',{name:'FRONTQ 排队种子'});
const seedEnded=await controller.store.submit('Frontdesk-only ended seed','Synthetic ended Work that only carries an unrelated durable draft',{name:'FRONTEND 已结束种子'});
await controller.store.activate(seedEnded.id);
await controller.store.mutate(()=>{const ended=controller.store.find(seedEnded.id);ended.status='ended';ended.endedAt=new Date().toISOString();ended.closure={phase:'complete',decision:'discard',revision:1};
  controller.store.state.drafts.frontdesk='FRONT_KEEP_A';controller.store.state.drafts[seedQueued.id]='WORKER_DRAFT_KEEP';controller.store.state.drafts[seedEnded.id]='OTHER_WORKER_DRAFT';});
await controller.stop();
await host.storage.db.close();

let child,browser,shell,chat,exit,log='';
const until=async(fn,label,ms=90000)=>{const end=Date.now()+ms;while(Date.now()<end){if(child&&(child.exitCode!==null||child.signalCode))throw Error('app exited: '+log);const value=await fn();if(value)return value;await pause(100);}throw Error('Timeout: '+label);};
const invoke=async(page,op,p={})=>page.evaluate(({op,p})=>window.nozeli.invoke(op,p),{op,p});
const raw=async(op,p={})=>invoke(shell,op,p);
const call=async(op,p={})=>{report.stage=op;const r=await raw(op,p);assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;};
const findPage=async(kind,projectId)=>{for(const page of await browser.pages())if(await page.evaluate(({kind,projectId})=>window.__nozeliReady&&window.__workspaceScope?.kind===kind&&(!projectId||window.__workspaceScope.projectId===projectId),{kind,projectId}).catch(()=>false))return page;return null;};
const scoped=async(kind,projectId)=>until(()=>findPage(kind,projectId),kind+' surface'+(projectId?' '+projectId:''));
const state=async id=>(await call('managed.status',{projectId:id})).state;
const owners=s=>s.agents.filter(x=>!x.closed).map(({target,ownerId,threadId})=>({target,ownerId,threadId})).sort((x,y)=>x.target.localeCompare(y.target));
const recipient=async page=>page.$eval('#conversation-panel',node=>node.dataset.managedConversation);
const retainedTexts=async page=>page.evaluate(()=>[...document.querySelectorAll('#managed-input-identity textarea[aria-label="保留的原归属草稿"]')].map(node=>node.value));
const composerValue=page=>page.$eval('#composer',node=>node.value);
const snapshot=async dir=>{const files={};const walk=async current=>{for(const entry of await fs.readdir(current,{withFileTypes:true})){if(entry.name==='.git'||entry.name==='.nozeli')continue;const file=path.join(current,entry.name);if(entry.isDirectory())await walk(file);else files[path.relative(dir,file)]=crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');}};await walk(dir);return files;};
async function launch(){
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
  Object.assign(env,{HOME:path.join(out,'home'),XDG_CONFIG_HOME:path.join(out,'home/.config'),XDG_DATA_HOME:path.join(out,'home/.local/share'),XDG_CACHE_HOME:path.join(out,'home/.cache'),NOZELI_CONFIG_ROOT:path.join(out,'config'),NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_TEST_PICK:[a,b].join('\n'),NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
  await fs.mkdir(env.HOME,{recursive:true});
  child=spawn(require('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform=wayland','--inspect=0'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  report.launches.push({port});exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);
  browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
  shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'shell ready');
}
async function select(id){await shell.click('#recent [data-project-id="'+id+'"]');await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,id),'project '+id+' activated');}
async function conversation(projectId){
  const existing=await findPage('conversation',projectId);if(existing)return existing;
  await shell.click('#workspace-open-conversation');
  return until(()=>findPage('conversation',projectId),'conversation surface '+projectId);
}
async function idle(...ids){await until(async()=>{for(const id of ids){const s=(await raw('managed.status',{projectId:id})).value?.state;if(!s)return false;if(s.jobs?.some(j=>['queued','running','transferring'].includes(j.status)))return false;if(s.busyTargets?.length)return false;}return true;},'projects idle '+ids.join(','),180000);}
async function close(){await idle(aid,bid);await call('session.requestClose');const result=await Promise.race([exit,pause(30000).then(()=>null)]);assert.deepEqual(result,{code:0,signal:null});report.exits.push(result);await browser.disconnect();browser=null;child=null;}
async function check(label,fn){try{await fn();report.checks.push(label);console.log('PASS '+label);}catch(error){report.failures.push({label,message:error.message});console.log('FAIL '+label+': '+error.message);for(const page of [chat,shell])await page?.screenshot({path:path.join(out,'failure-'+report.failures.length+'.png')}).catch(()=>{});}}
const sidebar=async page=>{if(await page.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true').catch(()=>false))await page.click('#toggle-sidebar');};
const clickInPage=async(page,selector,label)=>{await page.waitForSelector(selector,{visible:true});await page.click(selector);};
const sendHotkey=async page=>{await until(()=>page.$eval('#send-message',node=>!node.disabled),'send enabled');await page.focus('#composer');await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');};
const sourcesBefore={a:await snapshot(a),b:await snapshot(b)};
try{
  await launch();
  await call('config.initialize',{mode:'independent'});
  await call('settings.providers.save',{operation:'create',provider:'frontdesk-local',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'synthetic-local-only'}});
  await call('settings.models.save',{frontdesk:{model:{mode:'explicit',selector:'frontdesk-local/scripted'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'explicit',selector:'frontdesk-local/scripted'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'frontdesk-local/scripted'},thinking:{mode:'native-default'}}});
  await select(aid);
  await call('settings.agents.save',{globalLimit:8});
  await call('managed.enable',{projectId:aid});
  await until(async()=>owners(await state(aid)).length===2,'A residents');
  await call('managed.limit',{projectId:aid,limit:4});
  const residentsA=owners(await state(aid));
  chat=await conversation(aid);

  await check('fresh conversation is frontdesk with the canonical durable draft',async()=>{
    await until(async()=>(await recipient(chat))==='frontdesk','frontdesk recipient');
    await until(()=>chat.$eval('#send-message',node=>!node.disabled),'send enabled');
    assert.equal(await composerValue(chat),'FRONT_KEEP_A');
    assert.equal(await chat.$eval('#composer',node=>node.readOnly),false);
    assert.match(await chat.$eval('#context-bar',node=>node.textContent),/前台对话$/);
    assert.deepEqual(await retainedTexts(chat),[],'no quarantine on a fresh frontdesk view');
  });

  // Persisted legacy Worker identity (viewState identity + window draft) must
  // reload as frontdesk with the legacy input quarantined, never migrated.
  const bootstrap=await invoke(chat,'workspace.bootstrap',{});
  assert(bootstrap.ok,'bootstrap: '+JSON.stringify(bootstrap.error));
  const restore=await invoke(chat,'workspace.command',{projectId:aid,requestKey:crypto.randomUUID(),command:{type:'restoreViewState',viewId:bootstrap.value.viewId,viewState:{conversationInput:{projectId:aid,target:seedQueued.id},workspace:{draft:'WORKER_WINDOW_DRAFT'}}}});
  assert(restore.ok,'restoreViewState accepted: '+JSON.stringify(restore.error));
  await chat.reload();await chat.waitForFunction(()=>window.__nozeliReady);
  await check('persisted Worker identity reloads as a frontdesk quarantine',async()=>{
    await until(async()=>(await recipient(chat))==='frontdesk','recipient stays frontdesk after legacy restore');
    assert.equal(await composerValue(chat),'FRONT_KEEP_A','canonical frontdesk draft, not the Worker window draft');
    assert.equal(await chat.$eval('#composer',node=>node.readOnly),false,'frontdesk input stays writable');
    assert.equal(await chat.$eval('#managed-input-identity',node=>node.hidden),false,'quarantine notice visible');
    const texts=await retainedTexts(chat);
    assert(texts.includes('WORKER_WINDOW_DRAFT'),'legacy window draft listed read-only: '+JSON.stringify(texts));
    assert(texts.includes('WORKER_DRAFT_KEEP'),'legacy target durable draft listed read-only: '+JSON.stringify(texts));
    assert(!texts.includes('OTHER_WORKER_DRAFT'),'unrelated Works drafts are not scanned into the view');
    assert(!texts.includes('FRONT_KEEP_A'),'frontdesk canonical draft is never listed as retained');
    const s=await state(aid);
    assert.equal(s.drafts[seedQueued.id],'WORKER_DRAFT_KEEP','legacy durable draft intact in the store');
    assert.equal(s.drafts[seedEnded.id],'OTHER_WORKER_DRAFT','other durable draft intact in the store');
    assert.equal(s.drafts.frontdesk,'FRONT_KEEP_A','frontdesk canonical draft intact');
    assert(!(s.agents||[]).some(agent=>agent.target===seedQueued.id),'no Worker owner was started for the legacy target');
  });

  // Native denials before any owner count change: conversation-action with an
  // explicit non-frontdesk target is denied from EVERY scope (shell included);
  // managed.send with a Worker target is denied on the conversation surface —
  // the main-window shell keeps host-internal managed.send scripting. No
  // admission, no Worker wake, no model request either way.
  await check('direct Worker/Orchestrator conversation admission denied from every scope',async()=>{
    const before=report.requests;
    for(const [name,page] of [['shell',shell],['conversation',chat]]){
      for(const target of [seedQueued.id,'orchestrator']){
        const result=await invoke(page,'workspace.control',{type:'conversation-action',projectId:aid,action:'select',target});
        assert.equal(result.ok,false,'conversation-action select '+target+' must be denied ('+name+')');
        assert.equal(result.error?.code,'CONVERSATION_TARGET_REJECTED','exact native denial, got '+JSON.stringify(result.error));
        report.denials.push({scope:name,op:'workspace.control/conversation-action',target});
      }
    }
    const sent=await invoke(chat,'managed.send',{projectId:aid,target:seedQueued.id,text:'must never be admitted',requestKey:'frontdesk-deny-'+crypto.randomUUID()});
    assert.equal(sent.ok,false,'managed.send to Worker target must be denied on the conversation surface');
    assert.equal(sent.error?.code,'CONVERSATION_TARGET_REJECTED','exact native denial, got '+JSON.stringify(sent.error));
    report.denials.push({scope:'conversation',op:'managed.send',target:seedQueued.id});
    assert.equal(report.requests,before,'denials cause no model request');
    assert.deepEqual(owners(await state(aid)),residentsA,'resident owners unchanged by denials');
    assert.equal(await recipient(chat),'frontdesk','conversation recipient unchanged');
  });

  // Ordinary send: exactly one frontdesk job, nothing else.
  const jobsBeforeSend=(await state(aid)).jobs.map(job=>job.id);
  const requestsBeforeSend=report.requests;
  await chat.locator('#composer').fill('Only reply FRONT_REPLY; no tools.');
  await sendHotkey(chat);
  await check('ordinary send produces exactly one frontdesk job',async()=>{
    const job=await until(async()=>{const s=await state(aid);const added=s.jobs.filter(j=>!jobsBeforeSend.includes(j.id));return added.length===1&&added[0].status==='completed'?added[0]:null;},'frontdesk job completes alone');
    assert.equal(job.target,'frontdesk');assert.equal(job.type,'front');
    await until(async()=>(await composerValue(chat))==='','composer cleared on acceptance');
    assert.equal(await recipient(chat),'frontdesk');
    const s=await state(aid);
    assert.notEqual(s.drafts.frontdesk,'Only reply FRONT_REPLY; no tools.','sent draft consumed, not left stale');
    assert.equal(report.requests,requestsBeforeSend+1,'exactly one scripted frontdesk round');
    assert.deepEqual(report.requestsLog.at(-1),{role:'frontdesk',nonce:null,tool:null});
  });

  // Task row on the queued seed opens the overview dialog with the original
  // backend draft readable — never a Worker conversation, no model request.
  await check('queued task row opens the overview with the original backend draft',async()=>{
    await sidebar(shell);
    const requestsBefore=report.requests;
    await clickInPage(shell,'[data-managed-work="'+seedQueued.id+'"] .managed-work-open','queued work row');
    await until(()=>shell.$eval('#managed-agent-details',node=>node.open),'overview dialog open');
    assert.equal(await shell.$eval('#managed-agent-details',node=>node.dataset.mode),'work');
    await shell.click('[data-work-overview-technical]>summary');
    await shell.waitForSelector('#managed-agent-details [aria-label="原后台任务未发送草稿"]',{visible:true});
    assert.equal(await shell.$eval('#managed-agent-details [aria-label="原后台任务未发送草稿"]',node=>node.value),'WORKER_DRAFT_KEEP','original backend draft readable');
    assert.equal(await shell.$eval('#managed-agent-details [aria-label="原后台任务未发送草稿"]',node=>node.readOnly),true,'original backend draft stays read-only');
    assert.equal(await recipient(chat),'frontdesk','recipient unchanged by task click');
    assert.equal(report.requests,requestsBefore,'task click causes no model request');
    await shell.keyboard.press('Escape');
    await until(()=>shell.$eval('#managed-agent-details',node=>!node.open),'overview dialog closed');
  });

  // Real dispatched Worker through managed.task: one orchestrator intake, real
  // native tools, file writes only inside the execution worktree.
  const jobsBeforeTask=(await state(aid)).jobs.map(job=>job.id);
  const requestsBeforeTask=report.requests;
  await call('managed.task',{projectId:aid,text:'Create FRONTW1 evidence: create FRONTW1.txt with exact content FRONTW1 in this work execution directory, then publish the result and finish.',requestKey:'frontdesk-task-w1'});
  const work1=await until(async()=>{const s=await state(aid);const failed=s.jobs?.find(j=>!jobsBeforeTask.includes(j.id)&&j.status==='failed');if(failed)throw Error('task failed: '+JSON.stringify(failed));const w=s.works.find(w=>w.name==='FRONTW1');if(!w?.execution?.directory||w.status!=='review')return false;if(await fs.readFile(path.join(w.execution.directory,'FRONTW1.txt'),'utf8').catch(()=>'')!=='FRONTW1')return false;if(s.busyTargets?.includes(w.id))return false;return w;},'dispatched FRONTW1 Worker publishes and reaches review',150000);
  await check('explicit managed.task routes exactly one orchestrator intake and one dispatched Worker',async()=>{
    const s=await state(aid);
    const added=s.jobs.filter(j=>!jobsBeforeTask.includes(j.id));
    assert.equal(added.filter(j=>j.type==='intake'&&j.target==='orchestrator').length,1,'exactly one orchestrator intake job');
    assert(work1.threadId,'dispatched Worker bound a real thread');
    assert(['review','ended'].includes(work1.status),'published work awaits review, got '+work1.status);
    const start=report.requestsLog.findIndex(row=>row.nonce==='FRONTW1'&&row.role==='orchestrator');
    assert(start>=0,'orchestrator round observed');
    assert.equal(added.filter(job=>job.target===work1.id&&job.type==='initial').length,1,'one original Worker input');
    assert.equal(s.works.filter(work=>work.name==='FRONTW1').length,1,'no duplicate Work');
    assert.equal(report.requestsLog.slice(start).filter(row=>row.tool==='nozeli_dispatch').length,1,'dispatch effect is not replayed');
    report.worker={workId:work1.id,threadId:work1.threadId,file:path.join(work1.execution.directory,'FRONTW1.txt')};
  });
  await check('Worker writes only inside its execution worktree; project sources unchanged',async()=>{
    assert.equal(await fs.readFile(report.worker.file,'utf8'),'FRONTW1');
    assert.deepEqual(await snapshot(a),sourcesBefore.a,'synthetic project A unchanged');
    assert.deepEqual(await snapshot(b),sourcesBefore.b,'synthetic project B unchanged');
  });

  // Review-state task row opens the frozen report; reading it and returning to
  // discussion leave the frontdesk recipient and draft untouched.
  await chat.locator('#composer').fill('A_DRAFT_KEEP');
  await until(async()=>(await state(aid)).drafts.frontdesk==='A_DRAFT_KEEP','A draft persisted');
  const draftBeforeReport=await composerValue(chat);
  const requestsBeforeReport=report.requests;
  await check('review task row opens the frozen report; discussion returns to frontdesk',async()=>{
    await clickInPage(shell,'[data-managed-work="'+work1.id+'"] .managed-work-open','review work row');
    const reportPage=await scoped('report',aid);
    await reportPage.waitForSelector('.isolated-status[data-state="ready"]');
    const body=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>document.body?.innerText.includes('FRONTW1 result')).catch(()=>false))return page;},'original frozen Worker report');await body.screenshot({path:path.join(out,'frontdesk-report-actual.png')});
    assert.equal(await recipient(chat),'frontdesk','recipient unchanged by report opening');
    assert.equal(await composerValue(chat),draftBeforeReport,'frontdesk draft unchanged by report reading');
    assert.equal(report.requests,requestsBeforeReport,'report reading causes no model request');
    const conversations=await Promise.all((await browser.pages()).map(page=>page.evaluate(()=>window.__workspaceScope?.kind==='conversation'?document.querySelector('#conversation-panel')?.dataset.managedConversation:null).catch(()=>null)));
    assert(conversations.every(value=>value===null||value==='frontdesk'),'no Worker conversation surface exists');
    await clickInPage(shell,'#workspace-open-conversation','return to frontdesk conversation');
    await until(async()=>(await recipient(chat))==='frontdesk','discussion returns to frontdesk');
    assert.equal(await composerValue(chat),draftBeforeReport,'frontdesk draft unchanged by discussion return');
    assert.equal(await chat.$eval('#composer',node=>node.readOnly),false);
    assert.equal(report.requests,requestsBeforeReport,'discussion return causes no model request');
    assert.equal(await reportPage.evaluate(()=>window.__workspaceScope?.kind),'report','report surface stays a report');
  });

  // Programmatic background setup after filling the composer; not DOM-send evidence.
  const jobsBeforeSubmit=(await state(aid)).jobs.map(job=>job.id);
  const requestsBeforeSubmit=report.requests;
  await chat.locator('#composer').fill('Create FRONTW2 evidence: create FRONTW2.txt with exact content FRONTW2 in this work execution directory, then publish the result and finish.');
  await chat.evaluate(()=>{globalThis.__statusLog=[];const node=document.querySelector('#compose-status');new MutationObserver(()=>globalThis.__statusLog.push(node.textContent)).observe(node,{childList:true,characterData:true,subtree:true});});
  await chat.evaluate(()=>window.__agentSend({background:true}));
  const work2=await until(async()=>{const s=await state(aid);const w=s.works.find(w=>w.name==='FRONTW2');if(!w?.execution?.directory||w.status!=='review')return false;if(await fs.readFile(path.join(w.execution.directory,'FRONTW2.txt'),'utf8').catch(()=>'')!=='FRONTW2')return false;if(s.busyTargets?.includes(w.id))return false;return w;},'submit-background FRONTW2 publishes and reaches review',150000);
  await check('programmatic background driver (non-DOM) routes exactly one orchestrator intake',async()=>{
    const s=await state(aid);
    const added=s.jobs.filter(j=>!jobsBeforeSubmit.includes(j.id));
    assert.equal(added.filter(j=>j.type==='intake'&&j.target==='orchestrator').length,1,'exactly one orchestrator intake job');
    assert.equal(added.filter(j=>j.target==='frontdesk'&&j.type==='front').length,0,'no frontdesk chat job from the background submit');
    const start=report.requestsLog.findIndex(row=>row.nonce==='FRONTW2'&&row.role==='orchestrator');
    assert(start>=0,'orchestrator round observed');
    assert.equal(added.filter(job=>job.target===work2.id&&job.type==='initial').length,1,'one original Worker input');
    assert.equal(s.works.filter(work=>work.name==='FRONTW2').length,1,'no duplicate Work');
    assert.equal(report.requestsLog.slice(start).filter(row=>row.tool==='nozeli_dispatch').length,1,'background routing is not replayed');
    assert(['review','ended'].includes(work2.status),'FRONTW2 awaits review');
  });

  // Per-project draft isolation on a second synthetic project.
  await select(bid);
  await call('managed.enable',{projectId:bid});
  await until(async()=>owners(await state(bid)).length===2,'B residents');
  const chatB=await conversation(bid);
  await check('project B starts an isolated frontdesk composer',async()=>{
    await until(async()=>(await recipient(chatB))==='frontdesk','B frontdesk recipient');
    assert.equal(await composerValue(chatB),'','no A-side draft leaks into B');
    assert.deepEqual(await retainedTexts(chatB),[],'no A-side quarantine leaks into B');
    assert.equal(await chatB.$eval('#composer',node=>node.readOnly),false);
  });
  await chatB.locator('#composer').fill('B_DRAFT_KEEP');
  await until(async()=>(await state(bid)).drafts.frontdesk==='B_DRAFT_KEEP','B draft persisted');
  await select(aid);
  await check('project drafts stay isolated per project',async()=>{
    await until(async()=>(await recipient(chat))==='frontdesk','A recipient');
    assert.equal(await composerValue(chat),'','A frontdesk draft was consumed by the background submit');
    const texts=await retainedTexts(chat);
    assert(texts.includes('WORKER_DRAFT_KEEP'),'A quarantine retained');
    assert(!texts.includes('B_DRAFT_KEEP'),'B draft never leaks into A');
    assert.equal((await state(bid)).drafts.frontdesk,'B_DRAFT_KEEP','B draft stored on B only');
    assert.notEqual((await state(aid)).drafts.frontdesk??'','B_DRAFT_KEEP','A draft store has no B text');
  });

  // Reload persistence: canonical draft + quarantine survive a view reload.
  await chat.locator('#composer').fill('A_DRAFT_KEEP');
  await until(async()=>(await state(aid)).drafts.frontdesk==='A_DRAFT_KEEP','A draft persisted again');
  await chat.reload();await chat.waitForFunction(()=>window.__nozeliReady);
  await check('reload retains the canonical frontdesk draft and the quarantine',async()=>{
    await until(async()=>(await recipient(chat))==='frontdesk','frontdesk after reload');
    await until(async()=>(await composerValue(chat))==='A_DRAFT_KEEP','canonical draft restored');
    const texts=await retainedTexts(chat);
    assert(texts.includes('WORKER_DRAFT_KEEP')&&texts.includes('WORKER_WINDOW_DRAFT'),'quarantine persists across reload');
    assert(!texts.includes('B_DRAFT_KEEP'),'B draft never leaks into A');
    assert.equal(await chat.$eval('#composer',node=>node.readOnly),false);
  });
  await chat.screenshot({path:path.join(out,'frontdesk-composer.png')});

  // Full app restart: no replay; residents/threads/works/drafts/quarantine kept.
  const requestsBeforeRestart=report.requests;
  const beforeRestart={a:await state(aid),b:await state(bid)};
  const realHashesBefore=await Promise.all(report.realCopies.map(({rel})=>hashOf(path.join(realRoot,rel))));
  await close();
  await launch();
  await select(aid);await call('managed.connect',{projectId:aid});
  await until(async()=>owners(await state(aid)).length===2,'restart A residents');
  const chat2=await conversation(aid);
  report.restart={requestsBeforeRestart,requestsAfterReconnect:null};
  await check('restart replays no model input and retains every durable fact',async()=>{
    assert.equal(report.requests,requestsBeforeRestart,'no model replay on restart');
    const s=await state(aid);
    assert.equal(s.jobs.length,beforeRestart.a.jobs.length,'A jobs retained');
    assert.equal(s.drafts.frontdesk,'A_DRAFT_KEEP','A canonical draft retained');
    assert.equal(s.drafts[seedQueued.id],'WORKER_DRAFT_KEEP','legacy Worker draft still source-bound');
    assert.equal(s.drafts[seedEnded.id],'OTHER_WORKER_DRAFT','other durable draft still in place');
    assert.equal(s.works.find(w=>w.id===seedQueued.id)?.status,'queued','queued seed still queued, never auto-run');
    assert(!(s.agents||[]).some(agent=>agent.target===seedQueued.id),'still no Worker owner for the queued seed');
    for(const work of [work1,work2]){const kept=s.works.find(w=>w.id===work.id);assert(kept,'work '+work.id+' retained');assert.equal(kept.threadId,work.threadId,'thread retained for '+work.id);}
    await until(async()=>(await recipient(chat2))==='frontdesk','frontdesk after restart');
    await until(async()=>(await composerValue(chat2))==='A_DRAFT_KEEP','draft restored after restart');
    const texts=await retainedTexts(chat2);
    assert(texts.includes('WORKER_DRAFT_KEEP')&&texts.includes('WORKER_WINDOW_DRAFT'),'quarantine retained after restart');
    assert.equal(await chat2.$eval('#composer',node=>node.readOnly),false);
    const denied=await invoke(shell,'workspace.control',{type:'conversation-action',projectId:aid,action:'select',target:seedQueued.id});
    assert.equal(denied.ok,false,'Worker conversation still denied after restart');
    assert.equal(denied.error?.code,'CONVERSATION_TARGET_REJECTED');
    assert.equal(report.requests,requestsBeforeRestart,'denial after restart still causes no request');
  });
  const jobsBeforeFollowUp=(await state(aid)).jobs.map(job=>job.id);
  await chat2.locator('#composer').fill('Only reply FRONT_REPLY; no tools.');
  await sendHotkey(chat2);
  await check('explicit follow-up after restart proves live frontdesk owners',async()=>{
    await until(async()=>{const s=await state(aid);return s.jobs.find(j=>!jobsBeforeFollowUp.includes(j.id)&&j.status==='completed');},'follow-up completes');
    assert.equal(report.requests,requestsBeforeRestart+1,'exactly one new scripted round');
    report.restart.requestsAfterReconnect=report.requests;
  });
  await select(bid);await call('managed.connect',{projectId:bid});
  await until(async()=>owners(await state(bid)).length===2,'restart B residents');
  await check('project B retains its isolated draft after restart',async()=>{
    assert.equal(report.requests,report.restart.requestsAfterReconnect,'B reconnect replays nothing');
    const s=await state(bid);
    assert.equal(s.jobs.length,beforeRestart.b.jobs.length,'B jobs retained');
    assert.equal(s.drafts.frontdesk,'B_DRAFT_KEEP','B draft retained');
  });

  await check('synthetic project sources and optional real-content originals never change',async()=>{
    assert.deepEqual(await snapshot(a),sourcesBefore.a,'project A sources unchanged end-to-end');
    assert.deepEqual(await snapshot(b),sourcesBefore.b,'project B sources unchanged end-to-end');
    for(const [index,copy] of report.realCopies.entries())assert.equal(await hashOf(path.join(realRoot,copy.rel)),realHashesBefore[index],'original '+copy.rel+' untouched');
  });

  await close();
  assert.equal(report.exits.length,2);assert.deepEqual(report.exits[0],{code:0,signal:null});
  report.checks.push('two normal exits acknowledged with code 0 receipts');
  assert.deepEqual(report.failures,[]);
  report.ok=true;
}catch(error){
  report.failure=error.stack;process.exitCode=1;
  for(const page of [chat,shell])await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
}finally{
  if(child&&child.exitCode===null){try{await close();}catch{child.kill('SIGTERM');}}
  await browser?.disconnect().catch(()=>{});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await fs.writeFile(path.join(out,'main.log'),log);
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
