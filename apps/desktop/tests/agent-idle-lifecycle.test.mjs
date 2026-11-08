import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentIdleLifecycle} from '../src/agents/managed/agent-idle-lifecycle.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {DesktopHost} from '../src/main/host.mjs';

class Clock {
 time=0;timers=new Map();unrefs=0;
 now=()=>this.time;
 setTimeout=(fn,delay)=>{const token={unref:()=>this.unrefs++};this.timers.set(token,{at:this.time+delay,fn});return token;};
 clearTimeout=token=>this.timers.delete(token);
 async advance(ms,lifecycle){this.time+=ms;for(const [token,timer] of [...this.timers])if(timer.at<=this.time){this.timers.delete(token);timer.fn();}await drain(lifecycle);}
}
async function drain(lifecycle){while(lifecycle.flight)await lifecycle.flight;}
function fake(){return {sessions:new Map([['idle',{}],['busy',{busy:true}]]),store:{},stops:[],canReclaimIdle(target,s){return !this.stopping&&this.sessions.get(target)===s&&!s.busy;},async reclaimIdle(target){this.stops.push(target);this.sessions.delete(target);return true;}};}
function setup(options={}){const clock=new Clock(),controllers=new Map(),errors=[],lifecycle=new AgentIdleLifecycle({controllers,clock,idleTimeoutMs:100,onError:(id,error)=>errors.push({id,error}),...options});return {clock,controllers,errors,lifecycle};}

test('default grace is five minutes, with one unref deadline and busy peer retained',async()=>{
 const f=setup({idleTimeoutMs:undefined}),c=fake();f.controllers.set('active',c);f.lifecycle.observe();await drain(f.lifecycle);
 assert.equal(f.lifecycle.idleTimeoutMs,300000);assert.equal(f.clock.timers.size,1);assert.ok(f.clock.unrefs);
 await f.clock.advance(299999,f.lifecycle);assert.deepEqual(c.stops,[]);
 await f.clock.advance(1,f.lifecycle);assert.deepEqual(c.stops,['idle']);assert.equal(f.controllers.get('active'),c);assert.ok(c.sessions.has('busy'));assert.equal(f.clock.timers.size,0);f.lifecycle.stop();
});

test('busy transitions reset continuous eligibility even inside a coalesced event burst',async()=>{
 const f=setup(),c=fake();f.controllers.set('p',c);f.lifecycle.observe();await drain(f.lifecycle);await f.clock.advance(60,f.lifecycle);
 const s=c.sessions.get('idle');s.busy=true;f.lifecycle.observe();s.busy=false;f.lifecycle.observe();await drain(f.lifecycle);
 await f.clock.advance(40,f.lifecycle);assert.deepEqual(c.stops,[]);await f.clock.advance(60,f.lifecycle);assert.deepEqual(c.stops,['idle']);f.lifecycle.stop();
});

test('session and controller replacements receive their own complete grace',async()=>{
 const f=setup(),c=fake();f.controllers.set('p',c);f.lifecycle.observe();await drain(f.lifecycle);await f.clock.advance(80,f.lifecycle);
 c.sessions.set('idle',{});f.lifecycle.observe();await drain(f.lifecycle);await f.clock.advance(20,f.lifecycle);assert.deepEqual(c.stops,[]);
 const replacement=fake();f.controllers.set('p',replacement);f.lifecycle.observe();await drain(f.lifecycle);await f.clock.advance(80,f.lifecycle);assert.deepEqual(replacement.stops,[]);
 await f.clock.advance(20,f.lifecycle);assert.deepEqual(replacement.stops,['idle']);assert.deepEqual(c.stops,[]);f.lifecycle.stop();
});

test('deadline rechecks safety without an intervening state event',async()=>{
 const f=setup(),c=fake();f.controllers.set('p',c);f.lifecycle.observe();await drain(f.lifecycle);c.sessions.get('idle').busy=true;
 await f.clock.advance(100,f.lifecycle);assert.deepEqual(c.stops,[]);assert.equal(f.clock.timers.size,0);f.lifecycle.stop();
});

test('concurrent state/activity events cannot overlap or duplicate an owner stop',async()=>{
 const f=setup(),c=fake();let release,entered=0;const gate=new Promise(resolve=>release=resolve);
 c.reclaimIdle=async target=>{entered++;await gate;c.sessions.delete(target);return true;};f.controllers.set('p',c);f.lifecycle.observe();await drain(f.lifecycle);
 f.clock.time=100;f.lifecycle.observe();await Promise.resolve();assert.equal(entered,1);
 for(let i=0;i<20;i++)f.lifecycle.observe();release();await drain(f.lifecycle);assert.equal(entered,1);assert.equal(f.clock.timers.size,0);f.lifecycle.stop();
});

test('unconfirmed idle stop is attempted once and retains owner evidence',async()=>{
 const f=setup(),c=fake();let attempts=0;c.reclaimIdle=async()=>{attempts++;throw Error('unconfirmed');};const owner=c.sessions.get('idle');f.controllers.set('p',c);f.lifecycle.observe();await drain(f.lifecycle);
 await f.clock.advance(100,f.lifecycle);for(let i=0;i<5;i++){f.lifecycle.observe();await drain(f.lifecycle);await f.clock.advance(100,f.lifecycle);}
 assert.equal(attempts,1);assert.equal(c.sessions.get('idle'),owner);assert.equal(f.errors.length,1);assert.equal(f.clock.timers.size,0);f.lifecycle.stop();
});

test('input racing with expiry cancels that stop without disabling future idle expiry',async()=>{
 const f=setup(),c=fake();let attempts=0;const stop=c.reclaimIdle.bind(c);c.reclaimIdle=async target=>{attempts++;if(attempts===1){c.sessions.get(target).busy=true;return false;}return stop(target);};f.controllers.set('p',c);f.lifecycle.observe();await drain(f.lifecycle);
 await f.clock.advance(100,f.lifecycle);assert.ok(c.sessions.has('idle'));assert.equal(f.clock.timers.size,0);c.sessions.get('idle').busy=false;f.lifecycle.observe();await drain(f.lifecycle);
 await f.clock.advance(99,f.lifecycle);assert.ok(c.sessions.has('idle'));await f.clock.advance(1,f.lifecycle);assert.equal(c.sessions.has('idle'),false);assert.equal(attempts,2);f.lifecycle.stop();
});

test('removal, unavailable project and teardown clear deadlines without stopping owners',async()=>{
 for(const mode of ['remove','offline','stop']){const f=setup(),c=fake();f.controllers.set('p',c);f.lifecycle.observe();await drain(f.lifecycle);
 if(mode==='remove'){f.controllers.delete('p');f.lifecycle.forget('p');}else if(mode==='offline'){c.store.offline=true;f.lifecycle.observe();}else f.lifecycle.stop();
 await drain(f.lifecycle);assert.equal(f.clock.timers.size,0);assert.equal(f.lifecycle.entries.size,0);await f.clock.advance(1000,f.lifecycle);assert.deepEqual(c.stops,[]);}
});

async function realFixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-idle-')),content=path.join(root,'content');await fs.mkdir(content);
 const host=new DesktopHost(path.join(root,'profile')),{project}=await host.pick(content),clock=new Clock(),prompts=[],opens=[];let serial=0;
 // Idle expiry covers existing residents, not first-run semantic inventory.
 const existing=await host.storage.requireRegistered(project.id);existing.semanticInitializationEligible=false;
 await host.storage.db.request(host.storage.catalog,'put',{collection:'instances',id:project.id,value:existing});
 class Session extends EventEmitter{
  constructor(spec,target){super();Object.assign(this,spec,{target,closed:false,busy:false,toolsDigest:'idle-test'});}
  async preflightToolsDigest(){}async assertToolsDigest(){}
  async start(thread){this.pid=++serial;this.threadId=thread??'idle-thread-'+serial;return this;}
  async stop(){if(this.failStop)throw Error('idle exit unconfirmed');this.closed=true;return {confirmationComplete:true};}
  async prompt(text){prompts.push({text,threadId:this.threadId,target:this.target});return {text:'reply',threadId:this.threadId,metrics:{},completion:'provider-completed'};}
 }
 const manager=new ManagedProjects({userDataDir:path.join(root,'profile'),host,legacy:{projects:new Map()},idleTimeoutMs:100,idleClock:clock,openController:options=>{opens.push(options);return Controller.open({...options,projectHome:home=>fs.mkdir(home,{recursive:true}),sessionFactory:(spec,target)=>new Session(spec,target)});}});
 t.after(async()=>{for(const c of manager.controllers.values())for(const s of c.sessions.values())s.failStop=false;await manager.stop();await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 await manager.connect(project.id,{enable:true});await drain(manager.idleLifecycle);return {manager,clock,project,prompts,opens};
}

test('native busy bursts reset the idle deadline before renderer activity coalescing',async t=>{
 const {manager:m,clock,project}=await realFixture(t),c=m.controllers.get(project.id),owner=c.sessions.get('frontdesk');let pending=0;
 owner.activitySnapshot=()=>({known:true,busy:false,nativeDrainPending:pending});await clock.advance(60,m.idleLifecycle);
 pending=1;owner.emit('activity');pending=0;owner.emit('activity');await drain(m.idleLifecycle);
 await clock.advance(40,m.idleLifecycle);assert.equal(c.sessions.get('frontdesk'),owner);assert.equal(owner.closed,false);
 await clock.advance(60,m.idleLifecycle);assert.equal(c.sessions.has('frontdesk'),false);assert.equal(owner.closed,true);
});

test('automatic expiry retains active Controller and busy peer; accepted queue wakes exact thread only',async t=>{
 const {manager:m,clock,project,prompts,opens}=await realFixture(t),id=project.id,c=m.controllers.get(id);m.activeProjectId=id;
 const front=c.sessions.get('frontdesk'),thread=front.threadId,peer=c.sessions.get('orchestrator');peer.busy=true;c.changed();await drain(m.idleLifecycle);
 assert.ok(m.processBudget.available>0,'expiry is independent of capacity pressure');await clock.advance(100,m.idleLifecycle);
 assert.equal(m.controllers.get(id),c);assert.equal(c.sessions.has('frontdesk'),false);assert.equal(c.sessions.get('orchestrator'),peer);assert.equal(m.processBudget.used,1);
 await m.setActiveProject(id);await m.resourceStatus(id);await m.config(id);m.modelSync();assert.equal(c.sessions.has('frontdesk'),false);assert.equal(opens.length,1);assert.equal(prompts.length,0);
 const accepted=await c.send('frontdesk','legitimate accepted input',{requestKey:'idle-wake-1'});
 for(let i=0;i<100&&c.store.state.jobs.find(j=>j.id===accepted.jobId)?.status!=='completed';i++)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(c.sessions.get('frontdesk')?.threadId,thread);assert.equal(prompts.filter(p=>p.text==='legitimate accepted input').length,1);assert.equal(c.store.state.jobs.find(j=>j.id===accepted.jobId)?.status,'completed');
 assert.equal(opens.length,1,'idle expiry and wake retain the original project service');
});

test('never-admitted cold input resumes exactly once when explicit demand reopens a Controller',async t=>{
 const {manager:m,clock,project,prompts}=await realFixture(t),id=project.id,c=m.controllers.get(id);
 await clock.advance(100,m.idleLifecycle);assert.equal(c.sessions.size,0);
 while(c.kicking||c.running.size)await new Promise(resolve=>setImmediate(resolve));
 c.kick=()=>{};
 const accepted=await c.send('frontdesk','cold input must not replay',{requestKey:'cold-idle-1'});
 assert.equal(c.store.state.jobs.find(j=>j.id===accepted.jobId)?.status,'queued');
 await m.stopProject(id);await m.connect(id,{enable:true});
 const reopened=m.controllers.get(id);assert.notEqual(reopened,c);
 const fresh=await reopened.send('frontdesk','new explicit input after cold reopen',{requestKey:'fresh-idle-2'});while(reopened.kicking||reopened.running.size)await new Promise(resolve=>setImmediate(resolve));assert.equal(reopened.store.state.jobs.find(j=>j.id===fresh.jobId)?.status,'completed');assert.equal(reopened.store.state.jobs.find(j=>j.id===accepted.jobId)?.status,'completed');assert.equal(prompts.filter(p=>p.text==='new explicit input after cold reopen').length,1);
 assert.equal(prompts.filter(p=>p.text==='cold input must not replay').length,1);
});

test('automatic stop failure preserves the original owner and budget without retry spam',async t=>{
 const {manager:m,clock,project}=await realFixture(t),c=m.controllers.get(project.id),owner=c.sessions.get('frontdesk'),events=[];
 m.onEvent(event=>events.push(event));owner.failStop=true;const before=m.processBudget.used;
 await clock.advance(100,m.idleLifecycle);assert.equal(c.sessions.get('frontdesk'),owner);assert.equal(m.processBudget.used,before-1,'only confirmed idle peer donates capacity');
 const failures=events.filter(event=>event.kind==='managed-error'&&event.text.includes('空闲 Agent')).length;assert.equal(failures,1);
 for(let i=0;i<3;i++){c.changed();await drain(m.idleLifecycle);await clock.advance(1000,m.idleLifecycle);}
 assert.equal(events.filter(event=>event.kind==='managed-error'&&event.text.includes('空闲 Agent')).length,1);assert.equal(c.sessions.get('frontdesk'),owner);assert.equal(m.processBudget.used,1);
});

test('host transactions and executing repairs protect only their exact targets and reset idle grace synchronously',async t=>{
 const {manager:m,clock,project}=await realFixture(t),c=m.controllers.get(project.id),front=c.sessions.get('frontdesk'),orchestrator=c.sessions.get('orchestrator');
 await clock.advance(60,m.idleLifecycle);
 const endOriginal=c.beginHostOperation('frontdesk','publication');
 const endRepair=c.beginHostOperation('orchestrator','repair:publication','bug:exact');
 assert.equal(c.canReclaimIdle('frontdesk',front),false);assert.equal(c.canReclaimIdle('orchestrator',orchestrator),false);
 assert.deepEqual([...c.hostOperations.values()],[{target:'frontdesk',phase:'publication'},{target:'orchestrator',phase:'repair:publication',bugId:'bug:exact'}]);
 await clock.advance(100,m.idleLifecycle);assert.equal(c.sessions.get('frontdesk'),front);assert.equal(c.sessions.get('orchestrator'),orchestrator);
 endOriginal();endRepair();await drain(m.idleLifecycle);await clock.advance(99,m.idleLifecycle);assert.equal(c.sessions.get('frontdesk'),front);
 await clock.advance(1,m.idleLifecycle);assert.equal(c.sessions.has('frontdesk'),false);assert.equal(c.sessions.has('orchestrator'),false);assert.equal(c.hostOperations.size,0);
});

test('project stop waits for an active host transaction before stopping its owner',async t=>{
 const {manager:m,project}=await realFixture(t),c=m.controllers.get(project.id),owner=c.sessions.get('frontdesk');
 const end=c.beginHostOperation('frontdesk','publication');let stopped=false;const original=owner.stop.bind(owner);owner.stop=async()=>{stopped=true;return original();};
 const flight=c.stop();await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);end();await flight;assert.equal(stopped,true);assert.equal(c.hostOperations.size,0);
});
