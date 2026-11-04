// Reusable manual work-control test library: real DesktopHost + ProjectStorage +
// Workspace ledger + ManagedProjects, deterministic scripted owners and loopback
// providers. No real accounts, no paid models, no per-test developer paths.
//
// Tiers:
//  * integration (this fixture, scripted ControlSession owners + FakeClock):
//    deterministic barriers only — correctness never depends on timer sleeps.
//  * live (this fixture, real Pi runtime + loopback HTTP): real owners, files,
//    PIDs and exit confirmations; deadline polling only for native processes.
//
// Shared contract seam: `controlApi` centralizes every manual-control /
// fault-gateway API so a rename after peer integration touches one place,
// never suite logic.
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {runGit} from '../src/agents/managed/git-runtime.mjs';
import {serve as serveLoopback} from './pi-provider.fixture.mjs';

// ── deterministic primitives ────────────────────────────────────────────────
export function barrier(){
  let open,opened=false;
  const promise=new Promise(resolve=>{open=value=>{if(!opened){opened=true;resolve(value);}};});
  return {promise,open,get opened(){return opened;}};
}
// Real storage and Git finish asynchronously; wait for observed conditions,
// never infer readiness from a fixed number of event-loop iterations.
export async function spin(fn,label='condition',timeout=15000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await fn();if(value)return value;await new Promise(resolve=>setImmediate(resolve));}
  throw Error('Timed out: '+label);
}
export async function drain(controller){
  do{while(controller.kicking||controller.running.size||controller.starting.size)await new Promise(resolve=>setImmediate(resolve));}while(controller.kicking||controller.running.size);
}
export async function drainIdle(manager){while(manager.idleLifecycle.flight)await manager.idleLifecycle.flight;}
// Deadline polling is reserved for real native processes (live tier).
export async function until(fn,label,timeout=45000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,25));}
  throw Error('Timed out: '+label);
}
export class FakeClock {
  time=0;timers=new Map();unrefs=0;
  now=()=>this.time;
  setTimeout=(fn,delay)=>{const token={unref:()=>this.unrefs++};this.timers.set(token,{at:this.time+delay,fn});return token;};
  clearTimeout=token=>this.timers.delete(token);
  async advance(ms,lifecycle){this.time+=ms;for(const [token,timer] of [...this.timers])if(timer.at<=this.time){this.timers.delete(token);timer.fn();}await drainIdle({idleLifecycle:lifecycle});}
}

// ── scripted owner (integration tier) ───────────────────────────────────────
let sessionSerial=0;
// A Provider-compatible deterministic owner. `script(session,text,job)` may
// await barriers; throwing propagates as a genuine turn failure through the
// real Controller.runJob failure path (the path real provider errors use).
export class ControlSession extends EventEmitter {
  constructor(spec,target,{script=async()=>'ok'}={}){
    super();
    Object.assign(this,{role:spec?.role??'worker',model:spec?.model??'fixture/scripted',target,closed:false,busy:false,script,prompts:[],stops:[],interrupts:[],toolsDigest:'agent-control'});
    this.serial=++sessionSerial;this.epoch='epoch-'+this.serial;this.viewOwnerId='owner-'+this.serial;this.pid=null;this.threadId=null;
    this.controllerExitCleanup=Promise.resolve();
    this.exitSignal=new Promise(resolve=>{this.confirmExit=resolve;});
  }
  activitySnapshot(){return {known:this.activityUnknown!==true,freshness:this.activityUnknown?'unknown':'live',busy:this.busy,promptPreparing:false,compaction:false,retry:false,configuration:false,command:false,settling:false,nativeDrainPending:0,toolCount:0,hostToolCount:0,interactionCount:0,tools:[],interactions:[],activityRevision:this.activityRevision??1};}
  async preflightToolsDigest(){}async assertToolsDigest(){}
  async start(thread){this.pid=100000+this.serial;this.groupRecord={pid:this.pid};this.threadId=thread??'thread-'+this.serial;return this;}
  async prompt(text,{job}={}){
    this.busy=true;this.activityRevision=(this.activityRevision??1)+1;this.emit('activity');
    const entry={text,jobId:job?.id??null,target:job?.target??this.target};
    this.prompts.push(entry);this.current={entry};
    let outcome;
    try{outcome=await Promise.race([this.script(this,text,job),this.exitSignal.then(()=>{this.cancelled=true;return '';})]);}
    finally{this.busy=false;this.current=null;this.activityRevision++;this.emit('activity');}
    if(outcome instanceof Error)throw outcome;
    if(this.cancelled){this.cancelled=false;return {text:'',threadId:this.threadId,metrics:{},providerStatus:'cancelled',completion:'cancelled'};}
    return {text:String(outcome??'ok'),threadId:this.threadId,metrics:{},completion:'provider-completed'};
  }
  // Deterministic long turn: holds until cancelled or closed (no timers).
  holdUntilCancelled(){return ()=>new Promise(resolve=>{
    if(this.cancelled||this.closed)resolve('long turn output');else this.releaseHeld=()=>{this.releaseHeld=null;resolve('long turn output');};
  });}
  cancelPending(){if(this.current){this.cancelled=true;this.releaseHeld?.();return true;}return false;}
  finishPending(){if(this.current){this.releaseHeld?.();return true;}return false;}
  async interrupt(){const stopped=this.cancelPending();this.interrupts.push({stopped});return {stopped};}
  async stopIdle(){const activity=this.activitySnapshot();if(!activity.known||activity.busy)throw Object.assign(Error('Cannot reclaim a busy or unverified owner'),{code:'PI_BUSY'});return this.stop();}
  async stop(){
    if(this.closed)return this.exitReceipt??{confirmationComplete:true};
    this.stops.push({pid:this.pid});
    if(this.stopError)throw this.stopError;
    const receipt=this.exitReceipt??{confirmationComplete:true};
    this.closed=receipt.confirmationComplete===true&&!this.keepOpen;
    if(this.closed)this.confirmExit();
    if(this.closed)this.releaseHeld?.();
    if(this.closed){this.pid=null;this.emit('exit');}
    return receipt;
  }
}

// ── owned roots and real hosts ──────────────────────────────────────────────
export async function ownedRoot(prefix='nozeli-agent-control-'){
  // os.tmpdir() honors TMPDIR (large /var/tmp on this workstation).
  return fs.mkdtemp(path.join(os.tmpdir(),prefix));
}
export async function controlHost({files={'paper.txt':'Original synthetic source.\n'},git=true}={}){
  const out=await ownedRoot(),content=path.join(out,'project'),profile=path.join(out,'private','desktop');
  await fs.mkdir(content,{recursive:true});
  for(const [name,body] of Object.entries(files))await fs.writeFile(path.join(content,name),body);
  const gitRun=async(...args)=>(await runGit(content,args)).toString().trim();
  if(git){await gitRun('init','-b','main');await gitRun('config','user.name','Synthetic Control');await gitRun('config','user.email','control@localhost');await gitRun('add','--all');await gitRun('commit','-m','Synthetic baseline');}
  const host=new DesktopHost(profile);
  const project=(await host.pick(content)).project;
  project.instanceId=(await host.requireRegisteredProject(project.id)).instanceId;
  const done=async()=>{await host.storage.db.close();await fs.rm(out,{recursive:true,force:true});};
  return {out,content,profile,host,project,git:gitRun,done};
}
export function controlManager({host,profile,clock,idleTimeoutMs,sessionFactory=null,piSource=null,piRuntime=null,openController=null,serviceFaultBackoffMs}={}){
  const build=openController??(options=>Controller.open({...options,...(sessionFactory?{sessionFactory}:{})}));
  return new ManagedProjects({userDataDir:profile,host,legacy:{projects:new Map()},idleClock:clock,idleTimeoutMs,openController:build,piSource,piRuntime,...(serviceFaultBackoffMs!==undefined?{serviceFaultBackoffMs}:{})});
}
// Stop owners and close stores BEFORE removing roots; never rm live owners.
export async function teardown({manager}){
  const problems=[];
  if(manager){try{await manager.stop();}catch(error){problems.push('manager: '+error.message);}}
  if(problems.length)throw Error('teardown incomplete: '+problems.join('; '));
}

// ── work/queue seeding: one durable transaction, bounded projections ─────────
// Seeds N queued Works in a single store.mutate against the real ledger — no
// per-row filesystem churn; activation still performs the real agentHome mkdir
// only for the works the scheduler actually admits.
export async function seedQueuedWorks(store,count,{limit=2,prefix='seed-work'}={}){
  return store.mutate(()=>{
    store.state.limit=limit;
    for(let index=0;index<count;index++){
      store.state.works.push({id:`${prefix}-${String(index+1).padStart(4,'0')}-${store.state.workspaceId.slice(0,8)}`,agentId:'seed-'+index+'-'+store.state.workspaceId.slice(0,8),request:`Synthetic request ${index+1}: publish the exact seeded summary.`,brief:`Seeded brief ${index+1}`,status:'queued',revision:0,name:`${prefix} ${index+1}`});
    }
  });
}

// ── shared manual-control / fault contract seam ─────────────────────────────
const controllerRequests=new WeakMap(),gatewayRequests=new WeakMap();
export const controlApi={
  // Gateway path (UI parity): managed.work.control and its pure-read sibling.
  invoke:(manager,payload)=>manager.invoke('managed.work.control',payload),
  invokeStatus:(manager,payload)=>manager.invoke('managed.work.control.status',payload),
  // Direct host path shared with the gateway. expectedControlVersion and
  // expectedWorkRevision are REQUIRED by the final core contract; unless a
  // test pins them explicitly (CAS suites) they are read from the live
  // production capability DTO and ledger — never invented here.
  async controllerControl(controller,payload){
    let requests=controllerRequests.get(controller);if(!requests)controllerRequests.set(controller,requests=new Map());
    let defaults=requests.get(payload.requestKey);
    if(!defaults){
      const caps=await controller.workControlCapabilities(payload.workId??payload.jobId);
      if(!Number.isSafeInteger(caps?.controlVersion)||typeof caps.projectInstanceId!=='string')throw Object.assign(Error('production capabilities must expose control version and project instance'),{code:'TEST_CAPABILITY_CONTRACT'});
      defaults={projectId:controller.projectId,expectedControlVersion:caps.controlVersion,expectedProjectInstanceId:caps.projectInstanceId,...(caps.workId?{expectedWorkRevision:caps.workRevision}:{})};
      requests.set(payload.requestKey,defaults);
    }
    const filled={...defaults,...payload};
    return controller.workControl(filled);
  },
  capabilities:(controller,workOrJob)=>Promise.resolve(controller.workControlCapabilities(workOrJob)),
  held:(controller,targetOrJob)=>controller.workExecutionHeld(targetOrJob),
  // Gateway mutating op additionally requires the live project instance.
  async invokeBound(manager,project,payload){
    let requests=gatewayRequests.get(manager);if(!requests)gatewayRequests.set(manager,requests=new Map());
    let defaults=requests.get(payload.requestKey);
    if(!defaults){
      const caps=await controlApi.invokeStatus(manager,{projectId:payload.projectId,...(payload.workId?{workId:payload.workId}:{jobId:payload.jobId})});
      if(!Number.isSafeInteger(caps.controlVersion))throw Error('production controlVersion missing');
      defaults={expectedProjectInstanceId:project.instanceId,expectedControlVersion:caps.controlVersion,...(caps.workId?{expectedWorkRevision:caps.workRevision}:{})};
      requests.set(payload.requestKey,defaults);
    }
    return controlApi.invoke(manager,{...defaults,...payload});
  },
  faultStatus:(manager,payload={})=>manager.invoke('managed.fault.status',payload),
  faultRelease:(manager,payload)=>manager.invoke('managed.fault.release',payload),
  faultResults:(manager,payload)=>manager.invoke('managed.fault.results',payload),
};
export const stopStateOf=response=>response?.controlApplied?.stop?.state??response?.stop?.state??null;

// ── live-tier helpers ───────────────────────────────────────────────────────
export {serveLoopback};
export async function writePiModels(agentDir,url,{provider='control-local'}={}){
  await fs.mkdir(agentDir,{recursive:true});
  await fs.writeFile(path.join(agentDir,'models.json'),JSON.stringify({providers:{[provider]:{baseUrl:url,api:'openai-completions',apiKey:'local-nonsecret',models:[{id:'scripted',name:'Scripted Control',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:65536,maxTokens:4096}]}}}),{mode:0o600});
}
export function liveResult(out,scope){
  return {ok:false,out,checks:[],scope};
}
