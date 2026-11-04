import {openTestController} from './project-storage.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {AgentProcessBudget} from '../src/agents/managed/agent-process-budget.mjs';
import {DesktopHost} from '../src/main/host.mjs';
import {readManagedState} from '../src/agents/managed/managed-storage.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';

const hostFor=(...stores)=>({
 storage:stores[0].storage,
 requireProject:id=>stores.find(store=>store.projectId===id).storage.requireOnline(id),
 requireRegisteredProject:id=>stores.find(store=>store.projectId===id).storage.requireRegistered(id),
});

async function fixture(t,{limit=2,startGate,failStart=false,onStarting=()=>{}}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-budget-')),controllers=[];let sequence=0;
 const budget=new AgentProcessBudget({limit,onAvailable:()=>controllers.forEach(c=>c.kick())});
 class Session extends EventEmitter{
  constructor(spec,target){super();Object.assign(this,spec,{target,closed:false,busy:false,toolsDigest:'test-schema'});}
  async preflightToolsDigest(){}
  async assertToolsDigest(){}
  async start(id){onStarting();if(startGate)await startGate;if(failStart)throw Error('controlled start failure');this.pid=++sequence;this.threadId=id??'thread-'+sequence;return this;}
  async stop(){if(this.failStop)throw Error('controlled stop failure');this.closed=true;return {confirmationComplete:true};}
  async prompt(){return {text:'reply',threadId:this.threadId,metrics:{},completion:'provider-completed'};}
 }
 const open=async id=>{const c=await openTestController({projectId:id,runtimeRoot:path.join(root,id,'runtime'),contentRoot:path.join(root,id,'content'),processBudget:budget,sessionFactory:(spec,target)=>new Session(spec,target)});controllers.push(c);return c;};
 t.after(async()=>{for(const c of controllers){for(const s of c.sessions.values())s.failStop=false;await c.stop();}await fs.rm(root,{recursive:true,force:true});});
 return {root,budget,controllers,open};
}

test('cross-project simultaneous starts reserve before native startup and same target is single-flight',async t=>{
 let release,entered;const ready=new Promise(r=>entered=r);let startsEntered=0;const gate=new Promise(r=>release=r),f=await fixture(t,{startGate:gate,onStarting:()=>{if(++startsEntered===2)entered();}});const [a,b]=await Promise.all([f.open('a'),f.open('b')]);
 const starts=[a.session('frontdesk'),b.session('frontdesk')];await ready;
 let duplicate;try{assert.equal(f.budget.used,2);await assert.rejects(a.session('orchestrator'),{code:'AGENT_PROCESS_LIMIT'});duplicate=a.session('frontdesk');assert.equal(startsEntered,2,'same-target admission must not start a second native owner');}
 finally{release();await Promise.all(starts);}assert.equal(await duplicate,await starts[0]);assert.equal(startsEntered,2);assert.equal(f.budget.used,2);
});

test('failed startup releases its reservation and confirmed stop recovers a slot',async t=>{
 const f=await fixture(t,{failStart:true}),a=await f.open('a');await assert.rejects(a.session('frontdesk'),/controlled start failure/);assert.equal(f.budget.used,0);
 const slot=f.budget.reserve('a','manual'),s=new EventEmitter();s.pid=1;s.stop=async()=>({confirmationComplete:true});f.budget.bind(slot,s);await s.stop();assert.equal(f.budget.used,0);
});

test('unknown native exit and failed stop keep capacity until confirmed recovery',async()=>{
 let available=0;const b=new AgentProcessBudget({limit:2,onAvailable:()=>available++}),slot=b.reserve('a','frontdesk'),s=new EventEmitter();s.pid=123;let failure=true;
 s.stop=async()=>{if(failure)throw Error('stop failed');return {confirmationComplete:true};};b.bind(slot,s);s.emit('exit',{code:null});assert.equal(b.used,1);await assert.rejects(s.stop());assert.equal(b.used,1);failure=false;await s.stop();assert.equal(b.used,0);assert.equal(available,1);
});

test('idle reclaim protects drafts, terminals and long-running owners; resume preserves original thread',async t=>{
 const f=await fixture(t),a=await f.open('a');const s=await a.session('frontdesk'),thread=s.threadId;
 a.running.set('frontdesk',Promise.resolve());assert.equal(await a.reclaimIdle('frontdesk'),false);a.running.clear();
 a.nativeDraftTargets.add('frontdesk');assert.equal(await a.reclaimIdle('frontdesk'),false);a.nativeDraftTargets.clear();
 a.externalTerminalTargets.add('frontdesk');assert.equal(await a.reclaimIdle('frontdesk',{hiddenTerminal:true}),false);a.externalTerminalTargets.clear();
 a.terminals.set('frontdesk',{close:async()=>a.terminals.delete('frontdesk')});assert.equal(await a.reclaimIdle('frontdesk'),false);
 assert.equal(await a.reclaimIdle('frontdesk',{hiddenTerminal:true}),true);assert.equal(f.budget.used,0);assert.equal((await a.session('frontdesk')).threadId,thread);assert.equal(a.store.state.jobs.length,0);
});

test('failed idle reclamation cannot donate its slot',async t=>{
 const f=await fixture(t),a=await f.open('a'),s=await a.session('frontdesk');s.failStop=true;await assert.rejects(a.reclaimIdle('frontdesk'));assert.equal(f.budget.used,1);assert.equal(a.sessions.get('frontdesk'),s);
});

test('idle reclaim requires affirmative quiet Pi activity, not just an idle host',async t=>{
 const f=await fixture(t),c=await f.open('a'),s=await c.session('frontdesk');
 let activity={known:true,busy:false};s.activitySnapshot=()=>activity;
 assert.equal(c.canReclaimIdle('frontdesk',s),true);
 for(const unsafe of [null,{}, {known:false},{freshness:'unknown'},{busy:true},{hostBusy:true},{runActive:true},{promptPreparing:true},{compaction:true},{retry:true},{toolCount:1},{hostToolCount:1},{tools:[{}]},{interactionCount:1},{interactions:[{}]},{settling:true},{nativeDrainPending:1},{configuration:true},{command:'reload'}]){
  activity=unsafe===null?null:{known:true,busy:false,...unsafe};if(unsafe&&Object.keys(unsafe).length===0)activity={};
  assert.equal(await c.reclaimIdle('frontdesk'),false,JSON.stringify(unsafe));assert.equal(f.budget.used,1);assert.equal(s.closed,false);
 }
 s.activitySnapshot=()=>{throw Error('activity unavailable');};assert.equal(await c.reclaimIdle('frontdesk'),false);
 activity={known:true,busy:false};s.activitySnapshot=()=>activity;assert.equal(await c.reclaimIdle('frontdesk'),true);assert.equal(f.budget.used,0);
});

test('idle reclaim protects host uncertainty, lifecycle transitions and accepted manual work',async t=>{
 const f=await fixture(t),c=await f.open('a'),s=await c.session('frontdesk');
 for(const key of ['commitUnknown','nativeCommitUnknown']){c.store[key]=true;assert.equal(await c.reclaimIdle('frontdesk'),false,key);c.store[key]=false;}
 for(const key of ['bindingTransitions','handoffPreparing','residentHandoffs','handoffConfirmations']){c[key]=new Set(['frontdesk']);assert.equal(await c.reclaimIdle('frontdesk'),false,key);c[key].clear();}
 for(const key of ['modelDefaultsApplying','frontdeskContextClear']){c[key]=true;assert.equal(await c.reclaimIdle('frontdesk'),false,key);c[key]=false;}
 for(const key of ['closures','pendingEnds','publicationSerial']){c[key].set?c[key].set('frontdesk',Promise.resolve()):c[key].add('frontdesk');assert.equal(await c.reclaimIdle('frontdesk'),false,key);c[key].delete('frontdesk');}
 for(const job of [{target:'frontdesk',status:'transferring'},{target:'orchestrator',context:{boundWorkId:'frontdesk'},status:'queued'},{target:'frontdesk',status:'failed',manual:true}]){
  c.store.state.jobs.push(job);assert.equal(await c.reclaimIdle('frontdesk'),false,JSON.stringify(job));c.store.state.jobs.pop();
 }
 const slot=[...f.budget.slots][0];slot.state='unconfirmed';assert.equal(await c.reclaimIdle('frontdesk'),false);slot.state='live';
 assert.equal(c.canReclaimIdle('frontdesk',{...s}),false);assert.equal(await c.reclaimIdle('frontdesk'),true);
});

test('hidden terminal close rechecks native activity, accepted input and exact owner before stopping',async t=>{
 const f=await fixture(t),c=await f.open('a'),s=await c.session('frontdesk');let activity={known:true};s.activitySnapshot=()=>activity;
 for(const change of ['native','input','owner']){
  let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  c.terminals.set('frontdesk',{close:async()=>{entered();await gate;c.terminals.delete('frontdesk');}});
  const reclaim=c.reclaimIdle('frontdesk',{hiddenTerminal:true});await ready;
  if(change==='native')activity={known:true,retry:true};
  if(change==='input')await c.enqueue('frontdesk','front','accepted during terminal close');
  const replacement={...s};if(change==='owner')c.sessions.set('frontdesk',replacement);
  release();assert.equal(await reclaim,false,change);assert.equal(s.closed,false);assert.equal(f.budget.used,1);assert.equal(c.reclaiming.size,0);
  if(change==='owner'){assert.equal(c.sessions.get('frontdesk'),replacement);c.sessions.set('frontdesk',s);}
  activity={known:true};c.store.state.jobs=[];
 }
 assert.equal(await c.reclaimIdle('frontdesk'),true,'own reclaim fence must not prevent safe unload');
});

test('unconfirmed idle stop retains both provider registration and process slot',async t=>{
 const f=await fixture(t),c=await f.open('a'),s=await c.session('frontdesk'),provider=c.store.state.providers.frontdesk;
 s.stopIdle=async()=>({confirmationComplete:false});await assert.rejects(c.reclaimIdle('frontdesk'),{code:'PI_EXIT_UNCONFIRMED'});
 assert.equal(c.sessions.get('frontdesk'),s);assert.equal(c.store.state.providers.frontdesk,provider);assert.equal(f.budget.used,1);assert.equal(c.reclaiming.size,0);
});

test('input accepted during unload resumes original thread once after the reclaim fence clears',async t=>{
 let starts=0;const f=await fixture(t,{onStarting:()=>starts++}),c=await f.open('a'),s=await c.session('frontdesk'),thread=s.threadId;
 let entered,release;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);s.stopIdle=async()=>{entered();await gate;return s.stop();};
 const reclaim=c.reclaimIdle('frontdesk');await ready;c.started=true;
 const input=await c.enqueue('frontdesk','front','legitimate input during unload');
 // Drain the kick that sees the fence; unload finalization must supply the next one.
 while(c.kicking)await new Promise(r=>setImmediate(r));
 assert.equal(c.store.state.jobs.find(job=>job.id===input.jobId).status,'queued');
 let completed;const done=new Promise(r=>completed=r);const observe=()=>{if(c.store.state.jobs.find(job=>job.id===input.jobId)?.status==='completed')completed();};c.on('state',observe);t.after(()=>c.off('state',observe));
 const resumed=[c.session('frontdesk'),c.session('frontdesk')];release();assert.equal(await reclaim,true);const [first,second]=await Promise.all(resumed);await done;
 assert.equal(first,second);assert.equal(first.threadId,thread);assert.equal(c.sessions.get('frontdesk'),first);assert.equal(starts,2);assert.equal(c.store.state.jobs.length,1);assert.equal(c.reclaiming.size,0);assert.equal(f.budget.used,1);
});

test('idle reclaim never removes a replacement owner or its provider registration',async t=>{
 const f=await fixture(t),c=await f.open('a'),s=await c.session('frontdesk'),replacement={threadId:'replacement-thread'},provider={pid:999,ownerId:'replacement-owner'};
 s.stopIdle=async()=>{const receipt=await s.stop();c.sessions.set('frontdesk',replacement);c.store.state.providers.frontdesk=provider;return receipt;};
 try{assert.equal(await c.reclaimIdle('frontdesk'),true);assert.equal(c.sessions.get('frontdesk'),replacement);assert.equal(c.store.state.providers.frontdesk,provider);assert.equal(f.budget.used,0);}
 finally{c.sessions.set('frontdesk',s);}
});

test('startup fence release notifies observers when the exact owner becomes idle eligible',async t=>{
 const f=await fixture(t),c=await f.open('a');let eligibleOwner;
 c.on('state',()=>{const owner=c.sessions.get('frontdesk');if(owner&&c.canReclaimIdle('frontdesk',owner))eligibleOwner=owner;});
 const owner=await c.session('frontdesk');assert.equal(eligibleOwner,owner);assert.equal(c.starting.size,0);
});

test('resource limits persist only after disk succeeds and reject a reduction below occupancy',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-budget-disk-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'agent-resources.json'),b=new AgentProcessBudget({file});
 await b.save(4);const reloaded=new AgentProcessBudget({file});await reloaded.load();assert.equal(reloaded.limit,4);for(let n=0;n<3;n++)b.reserve('a','target-'+n);await assert.rejects(b.save(2),{code:'AGENT_LIMIT_IN_USE'});assert.equal(b.limit,4);
 b.persist=async()=>{throw Object.assign(Error('disk denied'),{code:'EACCES'});};await assert.rejects(b.save(6),{code:'EACCES'});assert.equal(b.limit,4);assert.equal(JSON.parse(await fs.readFile(file)).globalLimit,4);
});

test('project limit uses Workspace transaction, counts paused and review, and rolls back global disk on project failure',async t=>{
 const f=await fixture(t,{limit:8}),a=await f.open('a'),projectId=a.projectId,manager=new ManagedProjects({userDataDir:f.root,host:hostFor(a.store),legacy:{projects:new Map()}});manager.processBudget=f.budget;manager.resourceReady=Promise.resolve();manager.controllers.set(projectId,a);
 await a.store.mutate(()=>{a.store.state.limit=3;a.store.state.works.push({id:'paused',status:'paused',revision:1},{id:'review',status:'review',revision:1});});
 await assert.rejects(manager.saveResourceLimits({globalLimit:7,projectId,projectLimit:1}),{code:'AGENT_LIMIT_IN_USE'});assert.equal(a.store.state.limit,3);assert.equal(f.budget.limit,8);
 const result=await manager.saveResourceLimits({globalLimit:7,projectId,projectLimit:2});assert.equal(result.projectUsed,2);assert.equal(result.projectLimit,2);assert.equal((await readManagedState(a.store.storage,projectId)).limit,2);
 await a.store.mutate(()=>{a.store.state.works=[];});
});

test('capacity pressure reclaims inactive LRU then active idle resident and never the demanded owner',async t=>{
 const f=await fixture(t,{limit:2}),a=await f.open('a'),b=await f.open('b'),manager=new ManagedProjects({userDataDir:f.root,host:hostFor(a.store,b.store),legacy:{projects:new Map()}});manager.processBudget=f.budget;manager.resourceReady=Promise.resolve();manager.controllers.set(a.projectId,a);manager.controllers.set(b.projectId,b);manager.activeProjectId=b.projectId;
 await a.session('frontdesk');await b.session('orchestrator');await manager.reclaimInactive(b.projectId,{target:'worker'});assert.equal(a.sessions.size,0);assert.equal(b.sessions.size,1);
 await b.session('frontdesk');await manager.reclaimInactive(b.projectId,{target:'orchestrator'});assert.equal(b.sessions.has('orchestrator'),true);assert.equal(b.sessions.has('frontdesk'),false);
});

test('project activation preserves both projects idle owners without waking sleeping roles',async t=>{
 const f=await fixture(t,{limit:4}),a=await f.open('a'),b=await f.open('b'),m=new ManagedProjects({userDataDir:f.root,host:hostFor(a.store,b.store),legacy:{projects:new Map()},openController:async()=>{throw Error('project activation must not open a controller');}});
 m.processBudget=f.budget;m.resourceReady=Promise.resolve();m.controllers.set(a.projectId,a);m.controllers.set(b.projectId,b);
 await a.session('frontdesk');const owner=await b.session('frontdesk');
 const result=await m.setActiveProject(b.projectId);assert.equal(m.activeProjectId,b.projectId);assert.equal(result.globalUsed,2);assert.equal(a.sessions.size,1);assert.equal(b.sessions.get('frontdesk'),owner);assert.equal(owner.closed,false);
 await m.setActiveProject(a.projectId);const again=await m.setActiveProject(b.projectId);assert.equal(again.globalUsed,2);assert.equal(a.sessions.size,1);assert.equal(b.sessions.get('frontdesk'),owner);assert.equal(b.sessions.has('orchestrator'),false,'activation never starts another resident');
});

test('cold inventory counts unknown providers in every unconnected project before admitting new owners',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-budget-restore-')),host=new DesktopHost(root),m=new ManagedProjects({userDataDir:root,host,legacy:{projects:new Map()}});t.after(async()=>{await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 for(const name of ['a','b']){const content=path.join(root,name);await fs.mkdir(content);const {project}=await host.pick(content);await host.storage.putLocal(project.id,'managed:providers',{frontdesk:{pid:123,home:'/outside',kind:'omp-tui'}});}
 const [a,b]=await Promise.all([m.resourceStatus(),m.resourceStatus()]);assert.equal(a.globalUsed,2);assert.equal(b.globalUsed,2);assert.equal(m.processBudget.agents().every(slot=>slot.state==='unconfirmed'),true);
});

test('cap two dispatch cycle reclaims idle residents without failing accepted queued work',async t=>{
 const f=await fixture(t,{limit:2}),c=await f.open('active'),m=new ManagedProjects({userDataDir:f.root,host:hostFor(c.store),legacy:{projects:new Map()}});m.processBudget=f.budget;m.controllers.set(c.projectId,c);m.activeProjectId=c.projectId;f.budget.reclaim=(id,target)=>m.reclaimInactive(id,{target});
 await c.start();const originalFront=c.store.state.residents.frontdesk.threadId;
 const orchestrator=c.sessions.get('orchestrator');orchestrator.prompt=async(text,{job}={})=>{
  // Orchestrator also answers host maintenance turns; a dispatch-only stub would fail
  // that turn after any transient worktree-prep fault and surface as an unrelated
  // failed job, masking the cap/reclaim behavior under test.
  if(job?.type==='maintenance')return {text:'maintenance event reviewed',threadId:orchestrator.threadId,metrics:{},completion:'provider-completed'};
  await orchestrator.onTool({tool:'nozeli_dispatch',arguments:{name:'Task',brief:'brief'},callId:'dispatch-fixture'});return {text:'dispatched',threadId:orchestrator.threadId,metrics:{}};
 };
 await c.enqueue('orchestrator','intake','request');
 // Await the actual dispatcher; direct pump then gives a deterministic scheduler boundary.
 while(c.running.size||c.kicking)await new Promise(r=>setImmediate(r));await c.pump();
 while(c.running.size||c.kicking)await new Promise(r=>setImmediate(r));
 const work=c.store.state.works[0];assert(work);assert.equal(c.store.state.jobs.every(job=>job.status==='completed'),true,JSON.stringify(c.store.state.jobs.map(({target,type,status,error})=>({target,type,status,error}))));assert.equal(f.budget.used<=2,true);assert.equal(c.store.find(work.id).status,'paused');
 const response=await c.send('frontdesk','next discussion');assert.equal(response.accepted,true);
 while(c.running.size||c.kicking)await new Promise(r=>setImmediate(r));
 assert.equal(c.sessions.get('frontdesk').threadId,originalFront);assert.equal(c.store.state.jobs.at(-1).status,'completed');
});

test('activation epoch rejects stale project restoration and resource project ids are strict',async()=>{
 let release;const gate=new Promise(r=>release=r),m=new ManagedProjects({userDataDir:'/unused-resource-epoch',host:{storage:{},requireRegisteredProject:async id=>{if(id==='a')await gate;return {id};}},legacy:{projects:new Map()}});m.initializeResources=async()=>{};m.reclaimInactive=async()=>{};m.resourceStatus=async id=>({projectId:id});const connected=[];m.connect=async id=>{connected.push(id);return {id};};
 const a=m.setActiveProject('a'),b=m.setActiveProject('b');assert.deepEqual(await b,{projectId:'b'});release();assert.deepEqual(await a,{superseded:true});assert.deepEqual(connected,[]);assert.equal(m.activeProjectId,'b');
 for(const id of [42,'',' padded ',{},'x'.repeat(201)])await assert.rejects(ManagedProjects.prototype.resourceStatus.call(m,id),{code:'INVALID_PAYLOAD'});
});

test('project store disk error rolls back both live quota and global persisted limit',async t=>{
 const f=await fixture(t,{limit:8}),c=await f.open('a'),projectId=c.projectId,m=new ManagedProjects({userDataDir:f.root,host:hostFor(c.store),legacy:{projects:new Map()}});m.processBudget=f.budget;m.resourceReady=Promise.resolve();m.controllers.set(projectId,c);f.budget.file=path.join(f.root,'agent-resources.json');await f.budget.save(8);
 const save=c.store.save.bind(c.store);c.store.save=async()=>{throw Object.assign(Error('project disk error'),{code:'EIO'});};
 await assert.rejects(m.saveResourceLimits({globalLimit:5,projectId,projectLimit:3}),{code:'EIO'});assert.equal(c.store.state.limit,1);assert.equal(f.budget.limit,8);assert.equal(JSON.parse(await fs.readFile(f.budget.file)).globalLimit,8);c.store.save=save;
});

test('full global budget leaves accepted inputs queued rather than failing them',async t=>{
 const f=await fixture(t),c=await f.open('a');f.budget.reserve('other','frontdesk');f.budget.reserve('other','orchestrator');c.started=true;
 const accepted=await c.enqueue('frontdesk','front','retained input');while(c.kicking)await new Promise(r=>setImmediate(r));const job=c.store.state.jobs.find(job=>job.id===accepted.jobId);assert.equal(job.status,'queued');assert.equal(job.error,undefined);
 f.budget.release([...f.budget.slots][0]);while(c.kicking||c.running.size)await new Promise(r=>setImmediate(r));assert.equal(c.store.state.jobs.find(job=>job.id===accepted.jobId).status,'completed');
});

test('preflight that starts a native owner consumes capacity and stops before returning',async t=>{
 const f=await fixture(t),c=await f.open('a');let during=0,stops=0;
 await c.store.mutate(()=>{c.store.state.residents.frontdesk={threadId:'historical',toolsDigest:'test-schema',zeroActivity:false};});
 c.sessionFactory=spec=>({toolsDigest:'test-schema',preflightToolsDigest:async function(){this.pid=55;during=f.budget.used;},stop:async function(){stops++;return {confirmationComplete:true};}});
 const result=await c.makeSession('frontdesk',{preflightOnly:true});assert.equal(result.preflight,true);assert.equal(during,1);assert.equal(stops,1);assert.equal(f.budget.used,0);assert.equal(c.sessions.size,0);
});
test('collaboration status is a bounded pure read and does not create an owner or mutate state',async t=>{
 const f=await fixture(t),a=await f.open('a'),manager=new ManagedProjects({userDataDir:f.root,host:hostFor(a.store),legacy:{projects:new Map()}});manager.processBudget=f.budget;manager.controllers.set(a.projectId,a);const before=structuredClone(a.store.state),result=await manager.invoke('managed.collaboration.status',{projectId:a.projectId});
 assert.equal(result.schema,1);assert.equal(result.projectId,a.projectId);assert.equal(result.freshness,'live');assert.equal(result.agents.filter(row=>row.target==='frontdesk').length,1);assert.equal(a.sessions.size,0);assert.deepEqual(a.store.state,before);
});

test('host original and repair operations protect owners without consuming Work or process quota',async t=>{
 const f=await fixture(t),c=await f.open('host-only'),owner=await c.session('frontdesk'),used=f.budget.used,works=c.store.state.works.length;
 const finish=c.beginHostOperation('frontdesk','publication'),repair=c.beginHostOperation('frontdesk','repair:publication','bug:quota');
 assert.equal(c.hostOperations.size,2);assert.equal(f.budget.used,used);assert.equal(c.store.state.works.length,works);assert.equal(await c.reclaimIdle('frontdesk'),false);assert.equal(c.sessions.get('frontdesk'),owner);
 finish();assert.equal(await c.reclaimIdle('frontdesk'),false);repair();assert.equal(await c.reclaimIdle('frontdesk'),true);assert.equal(f.budget.used,0);assert.equal(c.store.state.works.length,works);
});
