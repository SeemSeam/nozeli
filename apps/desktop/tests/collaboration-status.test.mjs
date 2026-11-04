import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {DesktopHost} from '../src/main/host.mjs';import {ManagedProjects} from '../src/agents/managed-projects.mjs';import {collaborationProjection} from '../src/agents/managed/collaboration-status.mjs';
const controller=()=>({store:{state:{works:[],jobs:[],residents:{}}},sessions:new Map(),starting:new Map(),running:new Map(),current:new Map(),reclaiming:new Map(),configuring:new Set(),nativeDraftTargets:new Set(),externalTerminalTargets:new Set(),coldJobs:new Set()});
const project=(c,extra={})=>collaborationProjection({projectId:'p',instanceId:'i',controller:c,...extra});
test('running peer keeps project service active while another Agent remains safely sleeping',()=>{const c=controller();c.store.state.works=[{id:'w',status:'running',revision:1,threadId:'original'}];c.sessions.set('w',{viewOwnerId:'owner',epoch:'generation',threadId:'original',busy:true,phase:'prompt-inflight',activitySnapshot:()=>({known:true,activityRevision:1,runActive:true})});const value=project(c);assert.equal(value.project.projectKeepsRunning,true);assert.equal(value.agents.find(row=>row.target==='w').primaryState,'running');assert.equal(value.agents.find(row=>row.target==='orchestrator').primaryState,'not-started');assert.equal(c.sessions.size,1);});
test('unknown activity, original interaction, tools and host settlement never become idle',()=>{for(const [facts,expected]of [[{known:false},'unknown'],[{known:true,interactionCount:1},'waiting'],[{known:true,toolCount:2},'tool'],[{known:true,compaction:true},'compacting'],[{known:true,retry:true},'retrying'],[{known:true,settling:true},'settling']]){const c=controller();c.sessions.set('frontdesk',{viewOwnerId:'owner',threadId:'original',phase:'idle',busy:false,activitySnapshot:()=>facts});const value=project(c);assert.equal(value.agents[0].primaryState,expected);assert.equal(value.project.projectKeepsRunning,true);}});
test('cold inputs remain blocked and do not count as executable queue capacity',()=>{const c=controller();c.store.state.jobs=[{id:'old',target:'frontdesk',status:'queued'}];c.coldJobs.add('old');const value=project(c);assert.equal(value.project.pendingAcceptedJobs,0);assert.equal(value.project.coldJobs,1);assert.equal(value.project.projectKeepsRunning,false);assert.equal(value.agents[0].primaryState,'paused');assert.match(value.agents[0].blockReason,/不自动重放/);});
test('live pagination preserves exact identities and invalidates concurrent Work changes',()=>{const c=controller();for(let i=0;i<120;i++)c.store.state.works.push({id:'w'+String(i).padStart(3,'0'),name:'n'.repeat(20000),status:'queued',revision:0});const seen=new Set();let cursor=null;do{const value=project(c,{limit:7,cursor});assert(value.agents.length<=9);assert(Buffer.byteLength(JSON.stringify(value))<65536);for(const row of value.agents.filter(row=>row.workId)){assert(!seen.has(row.target));seen.add(row.target);assert(row.workName.length<=128);}cursor=value.nextCursor;}while(cursor);assert.equal(seen.size,120);const first=project(c,{limit:1});c.store.state.works[0].revision++;assert.throws(()=>project(c,{limit:1,cursor:first.nextCursor}),{code:'COLLABORATION_CURSOR_STALE'});});
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-collaboration-')),directory=path.join(root,'project');await fs.mkdir(directory);const host=new DesktopHost(path.join(root,'profile')),registered=await host.registerDirectory(directory),manager=new ManagedProjects({userDataDir:path.join(root,'profile'),host,legacy:{projects:new Map()},openController:async()=>{throw Error('must not start Controller');}});t.after(async()=>{await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});return {root,host,manager,id:registered.id};}
test('real cached large Work metadata is paged without controller creation or recovery hydration',async t=>{const f=await fixture(t),rows=[];for(let i=0;i<61;i++)rows.push({id:'w'+String(i).padStart(3,'0'),value:{id:'w'+String(i).padStart(3,'0'),name:'Work '+i,status:'queued',revision:0,request:'x'.repeat(180000)}});await f.host.storage.putLocal(f.id,'managed:cache:works',rows);await f.host.storage.putLocal(f.id,'managed:works:w060',{threadId:'thread-original',binding:{provider:'pi'}});let cursor=null,count=0;do{const value=await f.manager.invoke('managed.collaboration.status',{projectId:f.id,limit:10,...(cursor?{cursor}:{})});assert.equal(f.manager.controllers.size,0);assert.equal(f.manager.processBudget.used,0);assert(Buffer.byteLength(JSON.stringify(value))<65536);count+=value.agents.filter(row=>row.workId).length;cursor=value.nextCursor;}while(cursor);assert.equal(count,61);const record=await f.host.storage.managedAgentPage(f.id,{target:'w060',limit:1});assert.equal(record.works[0].threadId,'thread-original');assert.equal(record.works[0].provider,'pi');});
test('reading live status cannot invoke snapshot cloning, backstage, kick, or alter work and draft state',async t=>{const f=await fixture(t),c=controller();c.snapshot=()=>{throw Error('full snapshot forbidden');};c.processBackstage=()=>{throw Error('dispatch forbidden');};c.kick=()=>{throw Error('wake forbidden');};c.store.state.drafts={frontdesk:'Keep draft'};c.store.state.works=[{id:'work',name:'Original',status:'review',revision:1,threadId:'original'}];f.manager.controllers.set(f.id,c);const before=structuredClone(c.store.state),value=await f.manager.invoke('managed.collaboration.status',{projectId:f.id});assert.equal(value.agents.find(row=>row.target==='work').primaryState,'review');assert.equal(value.project.projectKeepsRunning,false);assert.deepEqual(c.store.state,before);});


test('recorded runtime and pending closure remain visible independently of page boundaries',async t=>{const f=await fixture(t);await f.host.storage.putLocal(f.id,'managed:cache:works',[{id:'a',value:{id:'a',name:'Queue',status:'queued',revision:0}},{id:'z',value:{id:'z',name:'Interrupted source',status:'running',revision:1}},{id:'m',value:{id:'m',name:'Pending cleanup',status:'ended',revision:1,closure:{phase:'blocked'}}},{id:'n',value:{id:'n',status:'ended',revision:1,closure:{phase:'complete'}}}]);let cursor=null;const targets=[];do{const page=await f.manager.invoke('managed.collaboration.status',{projectId:f.id,limit:1,...(cursor?{cursor}:{})});assert.equal(page.project.projectKeepsRunning,true);assert.equal(page.totalAgents,5);targets.push(...page.agents.filter(row=>row.workId).map(row=>row.target));cursor=page.nextCursor;}while(cursor);assert.deepEqual(targets,['a','m','z']);const closure=await f.host.storage.managedAgentPage(f.id,{target:'m',limit:1});assert.equal(closure.works[0].closure.phase,'blocked');});
test('unconfirmed target outside provider prefix cannot receive a dormant model override',async t=>{const f=await fixture(t);await f.host.storage.putLocal(f.id,'managed:cache:works',[{id:'zz-target',value:{id:'zz-target',status:'paused',revision:1}}]);await f.host.storage.putLocal(f.id,'managed:works:zz-target',{threadId:'original',binding:{provider:'pi'}});const providers={};for(let i=0;i<70;i++)providers['a'+i]={ownerId:'unverified'};providers['zz-target']={ownerId:'unverified-target'};await f.host.storage.putLocal(f.id,'managed:providers',providers);f.manager.modelCatalog=async()=>[{selector:'p/a',provider:'p',id:'a'}];await assert.rejects(f.manager.invoke('managed.model.set',{projectId:f.id,target:'zz-target',workRevision:1,expectedRevision:0,requestKey:'no-unverified-target',model:'p/a'}),{code:'PI_OWNER_UNCONFIRMED'});assert.equal(await f.host.storage.getLocalRecord(f.id,'managed:model-intent:zz-target'),null);assert.equal(f.manager.controllers.size,0);});

const clock=Date.parse('2026-11-03T12:00:00.000Z');
const iso=offset=>new Date(clock+offset).toISOString();
function timedController(target='w'){
 const c=controller(),work={id:target,status:'running',revision:2,threadId:'thread'};
 if(target==='w')c.store.state.works=[work];
 c.sessions.set(target,{viewOwnerId:'owner',epoch:'generation',threadId:'thread',busy:true,activitySnapshot:()=>({known:true,runActive:true})});
 const job={id:'current-round',target,revision:2,status:'running',createdAt:iso(-60000),startedAt:iso(-10000)};
 c.store.state.jobs=[job];c.current.set(target,job);return {c,job,work};
}
const agent=(c,target='w',extra={})=>project(c,extra).agents.find(row=>row.target===target);
test('all roles time the exact current round and new job identities reset elapsed time',t=>{
 t.mock.method(Date,'now',()=>clock);
 for(const target of ['frontdesk','orchestrator','w']){
  const {c,job}=timedController(target);c.store.state.jobs.unshift({...job,id:'original-round',status:'completed',startedAt:iso(-100000),finishedAt:iso(-70000)});
  let row=agent(c,target);assert.equal(row.timing.jobId,job.id);assert.equal(row.timing.elapsedMs,10000);assert.equal(row.timing.advancing,true);assert.equal(row.timing.observedAt,project(c).observedAt);
  const next={...job,id:'new-round',startedAt:iso(-1000)};c.store.state.jobs.push(next);c.current.set(target,next);
  row=agent(c,target);assert.equal(row.timing.jobId,'new-round');assert.equal(row.timing.elapsedMs,1000);
 }
});
test('timing rejects wrong target, stale Work revision and mismatched current source',t=>{
 t.mock.method(Date,'now',()=>clock);
 for(const change of [job=>job.target='other',job=>job.revision=1]){const {c,job}=timedController();change(job);assert.equal(agent(c).timing.kind,'unavailable');}
 const {c,job}=timedController();c.current.set('w',{...job,id:'not-in-state'});assert.equal(agent(c).timing.advancing,false);
});
test('finished timing freezes and latest successful round supersedes an older failure',t=>{
 let now=clock;t.mock.method(Date,'now',()=>now);
 const {c,job,work}=timedController();job.status='completed';job.finishedAt=iso(-2000);work.status='review';c.current.clear();c.sessions.get('w').busy=false;c.sessions.get('w').activitySnapshot=()=>({known:true});
 c.store.state.jobs.push({...job,id:'old-failure',status:'failed',startedAt:iso(-80000),finishedAt:iso(-70000),error:'old private failure'});
 let row=agent(c);assert.equal(row.primaryState,'review');assert.equal(row.timing.jobId,job.id);assert.equal(row.timing.elapsedMs,8000);assert.equal(row.timing.advancing,false);assert.match(row.activityText,/结果已保存/);
 now+=60000;assert.equal(agent(c).timing.elapsedMs,8000);
 work.status='running';assert.doesNotMatch(agent(c).activityText,/失败/);
});
test('queue acceptance is separate from execution start and cannot count as runtime',t=>{
 t.mock.method(Date,'now',()=>clock);const {c,job}=timedController();job.status='queued';delete job.startedAt;c.current.clear();c.sessions.clear();
 const timing=agent(c).timing;assert.equal(timing.kind,'queued');assert.equal(timing.queuedAt,job.createdAt);assert.equal(timing.startedAt,null);assert.equal(timing.elapsedMs,null);assert.equal(timing.advancing,false);
});
test('unknown, cold, paused, review and recorded facts never advance an execution timer',t=>{
 t.mock.method(Date,'now',()=>clock);
 for(const change of [({c})=>c.sessions.get('w').activitySnapshot=()=>({known:false}),({c})=>c.coldJobs.add('current-round'),({work})=>work.status='paused',({work})=>work.status='review',({c})=>c.store.commitUnknown=true]){const fixture=timedController();change(fixture);assert.equal(agent(fixture.c).timing.advancing,false);assert.equal(agent(fixture.c).timing.elapsedMs,null);}
 const row=project(null,{recorded:{works:[{id:'w',status:'running',revision:2,threadId:'thread'}],jobs:[{id:'recorded',target:'w',revision:2,status:'running',startedAt:iso(-10000)}]}}).agents.find(row=>row.target==='w');assert.equal(row.primaryState,'unknown');assert.equal(row.timing.kind,'unavailable');assert.equal(row.timing.advancing,false);
});
test('missing, invalid, future and reversed timestamps never fabricate durations',t=>{
 t.mock.method(Date,'now',()=>clock);
 for(const startedAt of [null,'not-a-time',iso(1000)]){const {c,job}=timedController();job.startedAt=startedAt;assert.equal(agent(c).timing.elapsedMs,null);assert.equal(agent(c).timing.advancing,false);}
 for(const finishedAt of [null,'bad',iso(1000),iso(-20000)]){const {c,job,work}=timedController();job.status='completed';job.finishedAt=finishedAt;work.status='review';c.sessions.clear();c.current.clear();assert.equal(agent(c).timing.elapsedMs,null);assert.equal(agent(c).timing.advancing,false);}
});
test('service fault hold is visible for every idle role without hiding protected operations',t=>{
 t.mock.method(Date,'now',()=>clock);
 for(const target of ['frontdesk','orchestrator','w']){const {c,job}=timedController(target);c.serviceFaultGate=()=>({held:true});assert.equal(agent(c,target).primaryState,'running');job.status='failed';job.finishedAt=iso(-1000);c.current.clear();c.sessions.get(target).busy=false;c.sessions.get(target).activitySnapshot=()=>({known:true});if(target==='w')c.store.state.works[0].status='running';const row=agent(c,target);assert.equal(row.primaryState,'waiting');assert.equal(row.serviceFaultHeld,true);assert.match(row.blockReason,/服务故障/);assert.equal(row.timing.advancing,false);}
});
test('elapsed ticks preserve cursors while actual timing fact and current identity changes invalidate them',t=>{
 let now=clock;t.mock.method(Date,'now',()=>now);const {c,job}=timedController();c.store.state.works.push({id:'z',status:'queued',revision:0});const first=project(c,{limit:1});now+=1000;const next=project(c,{limit:1,cursor:first.nextCursor});assert.equal(next.revision,first.revision);assert.notEqual(next.observedAt,first.observedAt);assert.equal(agent(c).timing.elapsedMs,11000);
 job.startedAt=iso(-9000);assert.throws(()=>project(c,{limit:1,cursor:first.nextCursor}),{code:'COLLABORATION_CURSOR_STALE'});
 const fresh=project(c,{limit:1});c.current.set('w',{...job,id:'replacement'});assert.throws(()=>project(c,{limit:1,cursor:fresh.nextCursor}),{code:'COLLABORATION_CURSOR_STALE'});
});
test('completed history stays bound to current Work revision and manual holds do not advance',t=>{
 t.mock.method(Date,'now',()=>clock);const {c,job,work}=timedController();
 job.status='completed';job.finishedAt=iso(-5000);work.status='review';c.current.clear();c.sessions.clear();
 c.store.state.jobs.push({...job,id:'newer-but-old-revision',revision:1,finishedAt:iso(-1000)});
 assert.equal(agent(c).timing.jobId,job.id);work.revision=3;assert.equal(agent(c).timing.kind,'unavailable');
 const active=timedController();active.work.manualControl={pause:{requestKey:'user-pause',at:iso(-1000)},version:1};assert.equal(agent(active.c).timing.advancing,false);
});
test('service gates preserve review and paused states and invalidate pagination on hold changes',t=>{
 t.mock.method(Date,'now',()=>clock);const {c,job,work}=timedController();let held=false;c.serviceFaultGate=()=>({held});job.status='completed';job.finishedAt=iso(-1000);c.current.clear();c.sessions.clear();c.store.state.works.push({id:'z',status:'queued',revision:0});
 const page=project(c,{limit:1});held=true;assert.throws(()=>project(c,{limit:1,cursor:page.nextCursor}),{code:'COLLABORATION_CURSOR_STALE'});
 for(const state of ['paused','review']){work.status=state;assert.equal(agent(c).primaryState,state);assert.equal(agent(c).serviceFaultHeld,true);assert.equal(agent(c).timing.advancing,false);}
});
test('unactivated Work remains visibly queued without fabricating an execution job or start',t=>{
 t.mock.method(Date,'now',()=>clock);const c=controller();const work={id:'waiting-worker',revision:0,status:'queued',createdAt:iso(-4000)};c.store.state.works=[work];
 let row=agent(c,work.id);assert.equal(row.primaryState,'queued');assert.match(row.blockReason,/运行名额/);assert.equal(row.timing.kind,'queued');assert.equal(row.timing.jobId,null);assert.equal(row.timing.queuedAt,work.createdAt);assert.equal(row.timing.startedAt,null);assert.equal(row.timing.advancing,false);
 delete work.createdAt;assert.equal(agent(c,work.id).timing.queuedAt,null);
 c.coldQueued=new Set([work.id]);row=agent(c,work.id);assert.equal(row.primaryState,'paused');assert.equal(row.timing.advancing,false);
 c.coldQueued.clear();work.manualControl={pause:{requestKey:'user-pause',at:iso(-1000)},version:1};assert.equal(agent(c,work.id).primaryState,'paused');
 const recorded=project(null,{recorded:{works:[{id:'saved-queue',revision:0,status:'queued'}]}}).agents.find(row=>row.target==='saved-queue');assert.equal(recorded.primaryState,'queued');assert.equal(recorded.timing.advancing,false);assert.equal(recorded.freshness.source,'recorded');
});
test('queueJob at and native manual completedAt retain authoritative timing with strict precedence',t=>{
 let now=clock;t.mock.method(Date,'now',()=>now);const {c,job,work}=timedController();c.store.state.works.push({id:'z',status:'queued',revision:0});
 job.status='queued';job.at=iso(-60000);delete job.createdAt;delete job.startedAt;c.current.clear();c.sessions.clear();
 assert.equal(agent(c).timing.queuedAt,job.at);const queuePage=project(c,{limit:1});job.at=iso(-50000);assert.throws(()=>project(c,{limit:1,cursor:queuePage.nextCursor}),{code:'COLLABORATION_CURSOR_STALE'});
 job.createdAt='invalid-present';assert.equal(agent(c).timing.queuedAt,null);delete job.createdAt;
 job.status='completed';job.startedAt=iso(-10000);job.completedAt=iso(-2000);work.status='review';let row=agent(c);assert.equal(row.timing.kind,'completed');assert.equal(row.timing.endedAt,job.completedAt);assert.equal(row.timing.elapsedMs,8000);
 now+=1000;assert.equal(agent(c).timing.elapsedMs,8000);const completedPage=project(c,{limit:1});job.completedAt=iso(-1000);assert.throws(()=>project(c,{limit:1,cursor:completedPage.nextCursor}),{code:'COLLABORATION_CURSOR_STALE'});
 for(const invalid of ['invalid-present',iso(10000),iso(-20000)]){job.finishedAt=invalid;assert.equal(agent(c).timing.elapsedMs,null);assert.equal(agent(c).timing.advancing,false);}
 delete job.finishedAt;job.completedAt=iso(-1000);assert.equal(agent(c).timing.elapsedMs,9000);
});