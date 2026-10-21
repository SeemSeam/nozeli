import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Controller} from '../src/agents/managed/controller.mjs';

const historyBytes=id=>JSON.stringify({type:'session',id,version:3,timestamp:'2026-10-18T00:00:00.000Z',cwd:'/fixture'})+'\n'+JSON.stringify({type:'message',id:'historic-message',message:{role:'assistant',content:[{type:'text',text:'old immutable history'}]}})+'\n';
// Zero-model fixture: never launches a provider, accesses credentials or sends input.
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'resident-handoff-'));
 const calls=[];let nextId=0,failNew=false;
 const c=await Controller.open({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'content'),projectHome:async()=>{},sessionFactory:(spec,target)=>{
  const session=new EventEmitter();Object.assign(session,{toolsDigest:'current-schema',busy:false,closed:false,phase:'ready',sideEffectFacts:[],inFlightToolCalls:new Set()});
  session.start=async resumeId=>{calls.push({target,resumeId});session.threadId=resumeId??`new-${++nextId}`;session.sessionFile=path.join(spec.home,'sessions',session.threadId+'.jsonl');await mkdir(path.dirname(session.sessionFile),{recursive:true});if(!resumeId)await writeFile(session.sessionFile,historyBytes(session.threadId));if(failNew&&!resumeId){failNew=false;throw Error('startup after identity failed');}return session;};
  session.assertToolsDigest=expected=>{if(expected!=='current-schema')throw Object.assign(Error('historical schema not equivalent'),{code:'OMP_TOOLS_DIGEST_MISMATCH'});};
  session.preflightToolsDigest=async expected=>{session.assertToolsDigest(expected);return {expectedDigest:expected,toolsDigest:session.toolsDigest,compatible:true};};
  session.stop=async()=>{session.closed=true;return {confirmationComplete:true,exited:true};};session.prompt=()=>{throw Error('no model calls permitted');};return session;
 }});
 t.after(()=>c.stop());
 const oldFile=path.join(c.store.root,'agents','resident-frontdesk-omp','sessions','old-frontdesk.jsonl');await mkdir(path.dirname(oldFile),{recursive:true});await writeFile(oldFile,historyBytes('old-frontdesk'));
 await c.store.mutate(()=>{c.store.state.residents.frontdesk={provider:'omp',threadId:'old-frontdesk',toolsDigest:'legacy-schema',zeroActivity:false};});
 await assert.rejects(c.session('frontdesk'),e=>e.code==='OMP_TOOLS_DIGEST_MISMATCH'&&e.target==='frontdesk'&&e.expectedToolsDigest==='legacy-schema'&&e.actualToolsDigest==='current-schema');
 return {c,calls,oldFile,failNext:()=>{failNew=true;}};
}

test('prepare stops idle owners but cancellation leaves old identity and history intact',async t=>{
 const {c,calls,oldFile}=await fixture(t);await c.session('orchestrator');const owner=c.sessions.get('orchestrator');
 const before=structuredClone(c.store.state.residents.frontdesk),count=calls.length;
 const challenge=await c.prepareResidentHandoff('frontdesk');assert.equal(owner.closed,true);assert.deepEqual(c.store.state.residents.frontdesk,before);assert.equal(calls.length,count);assert.equal(c.store.state.residentArchive?.frontdesk?.handoffs,undefined);assert.equal(await readFile(oldFile,'utf8'),historyBytes('old-frontdesk'));assert.deepEqual(await c.prepareResidentHandoff('frontdesk'),challenge);
 await assert.rejects(c.session('frontdesk'),{code:'OMP_HANDOFF_CONFIRMATION_REQUIRED'});
});

test('concurrent confirmation creates one generation and preserves jobs drafts Work required intent and history',async t=>{
 const {c,calls,oldFile}=await fixture(t);
 const work=await c.store.submit('retained Work','retained brief');
 await c.store.mutate(()=>{c.store.state.drafts.frontdesk='unsent user draft';c.store.state.jobs.push({id:'finished',target:'frontdesk',status:'completed',text:'old input',promptStartedAt:'then'});c.store.find(work.id).requiredMaintenance=[{text:'keep required intent'}];});
 const kept=structuredClone({jobs:c.store.state.jobs,works:c.store.state.works,drafts:c.store.state.drafts,messages:c.store.state.messages});
 const challenge=await c.prepareResidentHandoff('frontdesk');
 await assert.rejects(c.confirmResidentHandoff({...challenge,role:'orchestrator'}),{code:'OMP_HANDOFF_TOKEN_INVALID'});
 await assert.rejects(c.confirmResidentHandoff({...challenge,token:'wrong'}),{code:'OMP_HANDOFF_TOKEN_INVALID'});
 const [a,b]=await Promise.all([c.confirmResidentHandoff(challenge),c.confirmResidentHandoff(challenge)]);assert.deepEqual(a,b);assert.equal(a.threadId,'new-1');assert.equal(calls.filter(x=>x.resumeId==null).length,1);
 assert.equal(c.store.state.residentArchive.frontdesk.handoffs.length,1);assert.equal(c.store.state.residents.frontdesk.generation,1);assert.equal(c.store.state.residents.frontdesk.handoff.status,'ready');assert.equal(await readFile(oldFile,'utf8'),historyBytes('old-frontdesk'));
 assert.deepEqual({jobs:c.store.state.jobs,works:c.store.state.works,drafts:c.store.state.drafts,messages:c.store.state.messages},kept);
});

test('failed startup retry pins the same new thread and does not rearchive',async t=>{
 const {c,calls,failNext}=await fixture(t);const challenge=await c.prepareResidentHandoff('frontdesk');failNext();
 await assert.rejects(c.confirmResidentHandoff(challenge),/startup after identity failed/);assert.equal(c.store.state.residents.frontdesk.threadId,'new-1');assert.equal(c.store.state.residentArchive.frontdesk.handoffs.length,1);
 const result=await c.confirmResidentHandoff(challenge);assert.equal(result.threadId,'new-1');assert.equal(calls.filter(x=>x.resumeId==null).length,1);assert.equal(calls.at(-1).resumeId,'new-1');assert.equal(c.store.state.residentArchive.frontdesk.handoffs.length,1);
});

for(const scenario of ['queued','running','manual','closing','unknown','unresolved','unconfirmed'])test(`prepare refuses ${scenario} without changing identity`,async t=>{
 const {c}=await fixture(t);const before=structuredClone(c.store.state.residents.frontdesk);
 if(['queued','running','manual'].includes(scenario))c.store.state.jobs.push({id:scenario,target:'frontdesk',status:scenario==='manual'?'running':scenario,manual:scenario==='manual'});
 if(scenario==='closing'){const w=await c.store.submit('closing Work','brief');c.store.find(w.id).status='closing';}
 if(['unknown','unresolved','unconfirmed'].includes(scenario))c.sessions.set('orchestrator',{sideEffectFacts:scenario==='unknown'?[{outcome:'unverified-cancelled'}]:[],blockedTicket:scenario==='unresolved'?{}:null,pid:scenario==='unconfirmed'?123:null,stop:async()=>({confirmationComplete:false})});
 await assert.rejects(c.prepareResidentHandoff('frontdesk'),e=>['OMP_HANDOFF_BUSY','OMP_HANDOFF_UNRESOLVED','OMP_HANDOFF_SIDE_EFFECTS_UNKNOWN','OMP_EXIT_UNCONFIRMED'].includes(e.code));assert.deepEqual(c.store.state.residents.frontdesk,before);assert.equal(c.store.state.residentArchive?.frontdesk?.handoffs,undefined);
 if(scenario==='closing')c.store.state.works[0].status='paused';
 if(scenario==='unconfirmed')c.sessions.get('orchestrator').stop=async()=>({confirmationComplete:true});
});

test('confirm rechecks safety after prepare and refuses newly queued input',async t=>{
 const {c}=await fixture(t);const challenge=await c.prepareResidentHandoff('frontdesk');c.store.state.jobs.push({id:'late',target:'orchestrator',status:'queued'});
 await assert.rejects(c.confirmResidentHandoff(challenge),{code:'OMP_HANDOFF_BUSY'});assert.equal(c.store.state.residents.frontdesk.threadId,'old-frontdesk');
});

test('start waits for all resident startups before exposing mismatch',async t=>{
 const {c}=await fixture(t);let release;const gate=new Promise(resolve=>{release=resolve;});const original=c.sessionFactory;
 await c.store.mutate(()=>{c.store.state.residents.orchestrator={provider:'omp',threadId:'old-orchestrator',toolsDigest:'current-schema',zeroActivity:false};});
 c.sessionFactory=(spec,target)=>{const session=original(spec,target);if(target==='orchestrator'){const preflight=session.preflightToolsDigest;session.preflightToolsDigest=async expected=>{await gate;return preflight(expected);};}return session;};
 let settled=false;const started=c.start().finally(()=>{settled=true;});const rejected=assert.rejects(started,{code:'OMP_TOOLS_DIGEST_MISMATCH'});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);release();await rejected;assert.equal(c.starting.size,0);assert.equal(c.started,false);
});

test('schema preflight rejects before any resident spawn and preserves old history bytes',async t=>{
 const {c,calls,oldFile}=await fixture(t);const before=await readFile(oldFile);assert.equal(calls.length,0,'single-resident mismatch never resumed the old CLI');
 await assert.rejects(c.start(),e=>e.code==='OMP_TOOLS_DIGEST_MISMATCH'&&e.expectedToolsDigest==='legacy-schema'&&e.actualToolsDigest==='current-schema');
 assert.equal(calls.length,0,'all-resident preflight prevents even compatible/new peers from spawning');assert.equal(c.sessions.size,0);assert.deepEqual(await readFile(oldFile),before);
 const challenge=await c.prepareResidentHandoff('frontdesk');assert.equal(challenge.oldThreadId,'old-frontdesk');assert.equal(c.store.state.residents.frontdesk.threadId,'old-frontdesk');assert.deepEqual(await readFile(oldFile),before);assert.equal(calls.length,0);
});

for(const scenario of ['missing','empty','native-message','unknown-entry','admitted'])test(`empty schema upgrade proves zero activity: ${scenario}`,async t=>{
 const {c,oldFile,calls}=await fixture(t);
 await c.store.mutate(()=>{c.store.state.residents.frontdesk.zeroActivity=true;c.store.state.drafts.frontdesk='保留的未发送草稿';});
 if(scenario==='missing')await (await import('node:fs/promises')).unlink(oldFile);
 else if(scenario==='empty')await writeFile(oldFile,JSON.stringify({type:'session',id:'old-frontdesk'})+'\n');
 else if(scenario==='unknown-entry')await writeFile(oldFile,JSON.stringify({type:'session',id:'old-frontdesk'})+'\n'+JSON.stringify({type:'unknown-new-format'})+'\n');
 if(scenario==='admitted')await c.store.mutate(()=>c.store.state.jobs.push({id:'attempted',target:'frontdesk',status:'failed',promptStartedAt:1}));
 const before=scenario==='missing'?null:await readFile(oldFile,'utf8');
 if(['missing','empty'].includes(scenario)){
  const session=await c.session('frontdesk');assert.equal(session.threadId,'new-1');
  assert.equal(calls.filter(x=>x.resumeId==null).length,1);
  assert.equal(c.store.state.recoveryEvents.at(-1).type,'omp-empty-schema-updated');
  assert.equal(c.store.state.jobs.length,0);assert.equal(c.store.state.messages.length,0);
 }else await assert.rejects(c.session('frontdesk'),{code:'OMP_TOOLS_DIGEST_MISMATCH'});
 assert.equal(c.store.state.drafts.frontdesk,'保留的未发送草稿');
 assert.equal(c.store.state.residentArchive?.frontdesk?.handoffs,undefined);
 if(before!==null)assert.equal(await readFile(oldFile,'utf8'),before);
});

test('frontdesk clear creates only a fresh frontdesk owner and preserves all source ledgers',async t=>{
 const {c,calls,oldFile}=await fixture(t);await c.session('orchestrator');const orchestrator=c.sessions.get('orchestrator');
 await c.store.mutate(()=>{c.store.state.drafts.frontdesk='retained GUI draft';c.store.state.jobs.push({id:'old-front',target:'frontdesk',type:'front',text:'OLD_SENTINEL',status:'completed',context:{}});c.store.state.messages.push({id:'old-message',target:'frontdesk',speaker:'user',jobId:'old-front',text:'OLD_SENTINEL'});});
 const before=structuredClone({jobs:c.store.state.jobs,messages:c.store.state.messages,works:c.store.state.works,drafts:c.store.state.drafts,orchestrator:c.store.state.residents.orchestrator});
 const result=await c.clearFrontdeskContext();assert.equal(result.cleared,true);assert.equal(result.oldThreadId,'old-frontdesk');assert.notEqual(result.threadId,result.oldThreadId);assert.equal(c.sessions.get('orchestrator'),orchestrator);assert.equal(orchestrator.closed,false);
 assert.deepEqual({jobs:c.store.state.jobs,messages:c.store.state.messages,works:c.store.state.works,drafts:c.store.state.drafts,orchestrator:c.store.state.residents.orchestrator},before);
 assert.equal(c.store.state.residentArchive.frontdesk.handoffs.at(-1).id,result.archiveId);assert.equal(c.store.state.frontdeskContextEpoch.messageId,'old-message');assert.equal(await readFile(oldFile,'utf8'),historyBytes('old-frontdesk'));assert.equal(calls.filter(x=>x.target==='frontdesk'&&x.resumeId==null).length,1);
});

for(const scenario of ['busy','nativeDraft','queued','lease','tools','restart','configuration'])test(`frontdesk clear rejects ${scenario} before durable changes`,async t=>{
 const {c,calls}=await fixture(t);const session=new EventEmitter();Object.assign(session,{closed:false,busy:false,inFlightToolCalls:new Set()});c.sessions.set('frontdesk',session);
 if(scenario==='busy')session.busy=true;if(scenario==='nativeDraft')c.nativeDraftTargets.add('frontdesk');if(scenario==='queued')c.store.state.jobs.push({id:'queued',target:'frontdesk',status:'queued'});if(scenario==='lease')c.externalTerminalTargets.add('frontdesk');if(scenario==='tools')session.inFlightToolCalls.add('tool');if(scenario==='restart')c.restarting=new Map([['frontdesk',Promise.resolve()]]);if(scenario==='configuration')c.configuring.add('frontdesk');
 const before=JSON.stringify(c.store.state),count=calls.length;await assert.rejects(c.clearFrontdeskContext(),{code:'FRONTDESK_CONTEXT_CLEAR_BUSY'});assert.equal(JSON.stringify(c.store.state),before);assert.equal(calls.length,count);c.sessions.delete('frontdesk');c.restarting?.clear();
});

test('clear fences simultaneous clear, send and manual admissions until new identity is ready',async t=>{
 const {c}=await fixture(t);const first=c.clearFrontdeskContext();await assert.rejects(c.clearFrontdeskContext(),{code:'FRONTDESK_CONTEXT_CLEAR_BUSY'});await assert.rejects(c.send('frontdesk','must not disappear'),{code:'FRONTDESK_CONTEXT_CLEAR_BUSY'});await assert.rejects(c.openManualJob('frontdesk','late','must not disappear'),{code:'FRONTDESK_CONTEXT_CLEAR_BUSY'});await first;assert(!c.store.state.jobs.some(j=>j.text==='must not disappear'));
});

test('clear startup failure retains new identity and archive, never resumes the old context',async t=>{
 const {c,failNext,calls}=await fixture(t);failNext();await assert.rejects(c.clearFrontdeskContext(),/startup after identity failed/);assert.equal(c.store.state.residents.frontdesk.threadId,'new-1');assert.equal(c.store.state.residents.frontdesk.contextClear.status,'start-failed');assert.equal(c.store.state.residentArchive.frontdesk.handoffs.length,1);await assert.rejects(c.send('frontdesk','unsafe retry'),{code:'FRONTDESK_CONTEXT_CLEAR_BUSY'});assert(!calls.slice(1).some(call=>call.resumeId==='old-frontdesk'));
});

test('clear disk failure keeps old durable identity and prevents implicit resume',async t=>{
 const {c,calls}=await fixture(t);const save=c.store.save;c.store.save=async()=>{throw Error('disk failure');};try{await assert.rejects(c.clearFrontdeskContext(),/disk failure/);}finally{c.store.save=save;}assert.equal(c.store.state.residents.frontdesk.threadId,'old-frontdesk');assert.equal(c.store.state.residentArchive?.frontdesk?.handoffs,undefined);assert.equal(calls.filter(call=>call.resumeId==null).length,0);await assert.rejects(c.send('frontdesk','unsafe retry'),{code:'FRONTDESK_CONTEXT_CLEAR_BUSY'});
});

test('clear unconfirmed stop retains identity and never starts a replacement',async t=>{
 const {c,calls}=await fixture(t);const owner={pid:123,closed:false,stop:async()=>({confirmationComplete:false})};c.sessions.set('frontdesk',owner);await assert.rejects(c.clearFrontdeskContext(),{code:'OMP_EXIT_UNCONFIRMED'});assert.equal(c.store.state.residents.frontdesk.threadId,'old-frontdesk');assert.equal(c.sessions.get('frontdesk'),owner);assert.equal(calls.filter(call=>call.resumeId==null).length,0);c.sessions.delete('frontdesk');
});

test('frontdesk replacement reserves only after old owner releases its single budget slot',async t=>{
 const {c}=await fixture(t);let occupied=1,reclaims=0;const old={closed:false,pid:123,stop:async()=>{occupied--;old.closed=true;return {confirmationComplete:true};}};c.sessions.set('frontdesk',old);
 c.processBudget={get available(){return occupied===0;},reclaim:async()=>{reclaims++;},reserve:(_project,target)=>{assert.equal(target,'frontdesk');assert.equal(occupied,0);occupied++;return {};},bind:()=>({started(){},spawned(){}})};
 await c.clearFrontdeskContext();assert.equal(occupied,1);assert.equal(reclaims,0);c.processBudget=null;
});
