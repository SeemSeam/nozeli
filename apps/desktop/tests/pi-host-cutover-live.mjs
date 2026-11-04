// Real host controller + real private Pi owner + loopback scripted provider.
// Credential-free: no real account, no paid model (suite: live, NOZELI_TEST_LIVE=1).
// Run: node --test tests/pi-host-cutover-live.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Controller} from '../src/agents/managed/controller.mjs';
import {PiSession} from '../src/agents/managed/pi-session.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {serve,prepare} from './pi-provider.fixture.mjs';

// Provider handlers never assert: everything is decided from the recorded
// actual payloads after the turns settle, so a shape surprise cannot 500 the
// scenario. Text extraction tolerates string OR OpenAI content-block arrays.
const contentText=content=>typeof content==='string'?content:Array.isArray(content)?content.map(block=>block?.text??'').join('\n'):JSON.stringify(content??'');
const newestUser=request=>{const users=(request.messages||[]).filter(m=>m.role==='user');return users.length?contentText(users.at(-1).content):'';};
const hasTool=(request,name)=>(request.tools||[]).some(tool=>tool?.function?.name===name||tool?.name===name);

async function waitForJob(c,jobId,{label,root,provider,timeout=45000,expectFailure=false}={}){
  const end=Date.now()+timeout;
  const dump=async reason=>{
    const job=c.store.state.jobs.find(j=>j.id===jobId);
    const artifact={label,reason,job:job??null,providerTail:provider.requests.slice(-4).map(r=>({users:(r.messages||[]).filter(m=>m.role==='user').length,newest:newestUser(r),tools:(r.tools||[]).length})),providerErrors:provider.errors.map(e=>e.message)};
    await fs.writeFile(path.join(root,'failfast-'+label+'.json'),JSON.stringify(artifact,null,2)).catch(()=>{});
    return artifact;
  };
  while(Date.now()<end){
    const job=c.store.state.jobs.find(j=>j.id===jobId);
    if(job&&job.status==='completed')return job;
    if(!expectFailure&&job&&job.status==='failed')throw new Error('job failed ('+label+'): '+job.error+' / '+JSON.stringify(job.collabAttempts?.map(a=>a.status)??[]));
    if(expectFailure&&job&&job.status==='failed')return job;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const artifact=await dump('timeout');
  throw new Error('Timed out ('+label+'): '+JSON.stringify({status:artifact.job?.status??'missing',error:artifact.job?.error??null,attempts:artifact.job?.collabAttempts?.map(a=>a.status)??[],providerRequests:provider.requests.length}));
}

async function openHost(t,provider){
  const dirs=await prepare(provider.url);
  const storage=new ProjectStorage(path.join(dirs.root,'.test-storage'));
  t.after(()=>storage.db.close().catch(()=>{}));
  const project=await storage.register(dirs.cwd);
  const c=await Controller.open({storage,projectId:project.id,runtimeRoot:path.join(dirs.root,'runtime'),contentRoot:dirs.cwd,sessionFactory:spec=>new PiSession({...spec,model:spec.model??'local-fixture/scripted'}),piRuntime:{agentDir:dirs.agentDir},piSource:{modelFor:async()=>'local-fixture/scripted',roleDefaultsFor:async()=>({selector:'local-fixture/scripted',effort:null})},projectHome:async home=>{await fs.mkdir(home,{recursive:true});}});
  t.after(async()=>{
    // Stop first, then let every owner's async exit cleanup settle BEFORE the
    // store closes — a late cleanup hook must never hit STORAGE_CLOSED.
    const owners=[...c.sessions.values()];
    try{await c.stop();}catch{}
    await Promise.allSettled(owners.map(owner=>owner.controllerExitCleanup).filter(Boolean));
    await fs.rm(dirs.root,{recursive:true,force:true});
  });
  return {c,dirs};
}

test('real Pi ordinary chat delivers the exact raw text: one new verbatim user entry per turn, zero host-added text',async t=>{
  const provider=await serve(()=>({text:'ok'}));
  t.after(()=>provider.close());
  const {c,dirs}=await openHost(t,provider);
  await c.start();
  const inputs=[];
  for(let i=0;i<20;i++){
    const text='真实回合 '+i+'\n  保留空白🙂 ';
    inputs.push(text);
    const receipt=await c.send('frontdesk',text,{requestKey:'live-chat-'+i});
    const job=await waitForJob(c,receipt.jobId,{label:'live-chat-'+i,root:dirs.root,provider});
    assert.equal(job.text,text);
    assert.equal(job.requestContext.rawUserDeliveredVerbatim,true);
    assert.equal(job.requestContext.hostAddedChars,0,'zero host-added text; Pi-native history growth is not host-added');
    assert.equal(job.collabAttempts.at(-1).recordConfirmed,true,'exact-entry persistence barrier observed');
  }
  // Decided from the captured provider payloads, not from in-handler guesses.
  assert.equal(provider.errors.length,0,JSON.stringify(provider.errors.map(e=>e.message)));
  assert.equal(provider.requests.length,20,'exactly one model request per turn, no hidden calls');
  provider.requests.forEach((request,index)=>{
    const users=(request.messages||[]).filter(m=>m.role==='user');
    assert.equal(users.length,index+1,'native user history grows by exactly one entry per turn (request '+index+')');
    assert.equal(contentText(users.at(-1).content),inputs[index],'newest native user entry is byte-identical to the sent text (request '+index+')');
  });
  assert(!c.store.state.jobs.some(j=>j.type==='maintenance'||j.type==='backstage'));
});

test('five real provider refusals stay five failures with zero diagnostic fanout; fresh retry is not swallowed',async t=>{
  const provider=await serve(request=>newestUser(request).includes('被拒绝的输入')
    ?{status:400,error:{message:'content policy violation',type:'invalid_request_error',code:'content_policy_violation'}}
    :{text:'ok'});
  t.after(()=>provider.close());
  const {c,dirs}=await openHost(t,provider);
  await c.start();
  for(let i=0;i<5;i++){
    const receipt=await c.send('frontdesk','被拒绝的输入 '+i,{requestKey:'live-refused-'+i});
    const job=await waitForJob(c,receipt.jobId,{label:'live-refused-'+i,root:dirs.root,provider,expectFailure:true});
    assert.equal(job.status,'failed');
    assert.equal(job.collabAttempts.at(-1).status,'unknown','unknown fences the refused input');
  }
  assert.equal(c.store.state.jobs.filter(j=>j.type==='maintenance').length,0);
  assert.equal(c.store.state.jobs.filter(j=>j.type==='backstage').length,0);
  assert.equal(c.store.state.todos.filter(todo=>todo.kind==='system'&&todo.status==='open').length,0);
  assert.equal((c.store.state.receipts??[]).filter(r=>r.hostDiagnostic).length,0);
  const details=c.contextDetails('frontdesk');
  assert(details.diagnostics.providerFailures.some(row=>row.count===5),'deduplicated local failure counting');
  assert.equal(details.lastRequest.evidence.stage,'unknown');
  // Fresh, different input on the same native thread: new requestId, delivered.
  const receipt=await c.send('frontdesk','失败后的新输入',{requestKey:'live-after-refused'});
  const fresh=await waitForJob(c,receipt.jobId,{label:'live-after-refused',root:dirs.root,provider});
  assert.equal(fresh.requestContext.rawUserDeliveredVerbatim,true);
  assert.equal(fresh.collabAttempts.length,1);
  assert.equal(newestUser(provider.requests.at(-1)),'失败后的新输入','the retry reached the provider as the newest verbatim entry');
});

test('materials travel as native data entries with frozen versions, then resume briefly after confirmation',async t=>{
  const provider=await serve(()=>({text:'material ok'}));
  t.after(()=>provider.close());
  const {c,dirs}=await openHost(t,provider);
  await c.start();
  const body='冻结材料正文：被选中的一句话。\n'+('背景行。\n'.repeat(200));
  const version=await c.store.putObject(Buffer.from(body,'utf8'));
  const context={userInput:{text:'请基于材料回答。'},tagMaterial:{version,brief:'来源：notes.md · 第1行\n沿用前次已提供的选区与备注，原文件、版本和定位均未变化。',binding:'binding-test',reusable:true},materials:[{id:'tag:t1',version,title:'notes.md',kind:'tag-material',provenance:{source:'notes.md',versionLabel:'frozen-selection'}}]};
  const firstReceipt=await c.send('frontdesk','请基于材料回答。',{requestKey:'live-material-1',context});
  const first=await waitForJob(c,firstReceipt.jobId,{label:'live-material-1',root:dirs.root,provider});
  assert.equal(first.requestContext.materials[0].mode,'full');
  assert.equal(first.requestContext.materials[0].version,version);
  assert.equal(first.delivery.materials[0].version,version,'native entry carries the material identity');
  const ownerAfterFirst=c.sessions.get('frontdesk');
  const secondReceipt=await c.send('frontdesk','继续这句。',{requestKey:'live-material-2',context:{...context,userInput:{text:'继续这句。'}}});
  const second=await waitForJob(c,secondReceipt.jobId,{label:'live-material-2',root:dirs.root,provider});
  const ownerAfterSecond=c.sessions.get('frontdesk');
  t.diagnostic('material modes: first='+first.requestContext.materials[0].mode+' second='+second.requestContext.materials[0].mode+' ownerStable='+(ownerAfterFirst===ownerAfterSecond)+' epoch='+String(ownerAfterSecond?.contextEpoch));
  if(ownerAfterFirst===ownerAfterSecond)assert.equal(second.requestContext.materials[0].mode,'brief','same live owner + record-confirmed same version continues briefly (seeding must happen on first confirmation)');
  else assert.equal(second.requestContext.materials[0].mode,'full','a replaced owner has no visibility proof: full is the only truthful mode');
  c.tagMaterialDelivery.invalidate(ownerAfterSecond);
  const thirdReceipt=await c.send('frontdesk','压缩后重发材料。',{requestKey:'live-material-3',context:{...context,userInput:{text:'压缩后重发材料。'}}});
  const third=await waitForJob(c,thirdReceipt.jobId,{label:'live-material-3',root:dirs.root,provider});
  assert.equal(third.requestContext.materials[0].mode,'full','invalidated visibility re-delivers the full frozen body');
});

test('worker long task stays bounded: handoff once, projection per run, budget-guarded reads',async t=>{
  // First model call publishes a problem report through the real host tool
  // contract so the worker turn genuinely completes via host control.
  const provider=await serve(request=>hasTool(request,'nozeli_publish')
    ?{tool:'nozeli_publish',id:'publish-1',args:{kind:'problem',content:'长文已按分页读取并核对已读区间并集；本回合先交付问题报告说明剩余步骤。',files:[]}}
    :{text:'worker ack'});
  t.after(()=>provider.close());
  const {c,dirs}=await openHost(t,provider);
  // The live acceptance targets delivery, not Git worktree mechanics.
  c.execution.prepare=async id=>{await fs.mkdir(path.join(c.store.root,'execution',id),{recursive:true});};
  await c.start();c.kick=()=>{};
  const long='长论文正文。'.repeat(12000);
  const work=await c.store.submit(long,'长任务说明',{name:'长任务'});
  await c.store.activate(work.id);
  const accepted=await c.enqueue(work.id,'initial',c.initialWorkerText(c.store.find(work.id)));
  // kick is stubbed for determinism: run the admitted job explicitly.
  await c.runJob(c.store.state.jobs.find(j=>j.id===accepted.jobId));
  const initial=c.store.state.jobs.find(j=>j.id===accepted.jobId);
  assert.equal(initial.status,'completed','worker initial failed: '+initial.error);
  assert.ok(initial.requestContext.promptChars<9000,'bounded one-time handoff');
  assert.equal(initial.requestContext.projection.bytes<=4096,true,'small per-run projection');
  assert.equal(initial.delivery.projection.persisted,false,'projection never persists');
  assert.ok(initial.delivery.projection.llmCalls>=1,'projection captured through the native context hook');
  const session=c.sessions.get(work.id);
  const journal=await fs.readFile(session.sessionFile,'utf8');
  assert(!journal.includes('nozeli-current-state'),'projection absent from the native journal');
});
