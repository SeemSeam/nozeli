import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {MaintenanceLedger,maintenanceBoundary,maintenanceError} from '../src/agents/managed/maintenance-ledger.mjs';
import {openTestController} from './project-storage.fixture.mjs';
const memory=()=>{const values=new Map();return {getLocal:async(p,k)=>structuredClone(values.get(p+':'+k)),putLocal:async(p,k,v)=>values.set(p+':'+k,structuredClone(v))};};

test('maintenance deduplicates durable occurrences, redacts context and never retries unknown started attempt after restart',async()=>{
 const storage=memory(),ledger=new MaintenanceLedger(storage,'p');const event={phase:'publication',jobId:'j',workId:'w',revision:1,error:Error('token=secret user full document')};
 const first=await ledger.record(event);await ledger.record(event);assert.equal((await ledger.read()).bugs.length,1);assert.equal((await ledger.read()).bugs[0].occurrences,2);assert(!JSON.stringify(await ledger.read()).includes('secret'));assert(first.version);
 assert(await ledger.attempt(first.id));const reopened=new MaintenanceLedger(storage,'p');assert.equal(await reopened.attempt(first.id),null);await reopened.finish(first.id,{outcome:'needs-version-fix'});assert(await reopened.attempt(first.id));await reopened.finish(first.id,{verified:true,outcome:'receipt-observed'});assert.equal(await reopened.attempt(first.id),null);assert.equal((await reopened.read()).bugs[0].status,'repaired');
 assert.equal((await new MaintenanceLedger(storage,'other').read()).bugs.length,0);
});

test('automatic pre-prompt startup repair keeps original job and Work without user fault todo',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-maintenance-start-'));let starts=0,prompts=0;
 class Session{constructor(spec){Object.assign(this,spec,{closed:false,busy:false});}async preflightToolsDigest(){}async assertToolsDigest(){}async start(thread){this.threadId=thread??randomUUID();return this;}async stop(){this.closed=true;return {confirmationComplete:true};}async prompt(){prompts++;return {text:'retained',threadId:this.threadId,completion:'provider-completed'};}}
 const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),sessionFactory:spec=>new Session(spec),projectHome:home=>fs.mkdir(home,{recursive:true})});
 t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});c.kick=()=>{};
 const prepare=c.execution.prepare.bind(c.execution);c.execution.prepare=async(...args)=>{if(++starts===1)throw Error('Worker snapshot transient');return prepare(...args);};
 const w=await c.store.submit('original request','original brief');await c.store.activate(w.id);const accepted=await c.enqueue(w.id,'initial','original input');
 // Avoid conflating the separate missing-delivery policy with this startup receipt.
 c.ensureWorkerDelivery=async()=>{};c.store.settle=async()=>{};
 await c.runJob(c.store.state.jobs.find(j=>j.id===accepted.jobId));
 assert.equal(starts,2);assert.equal(prompts,1);assert.equal(c.store.state.works.length,1);assert.equal(c.store.state.jobs.find(j=>j.id===accepted.jobId).status,'completed');
 const bugs=(await c.maintenanceStatus()).bugs;assert.equal(bugs.length,1);assert.equal(bugs[0].status,'repaired');assert.equal(bugs[0].jobId,accepted.jobId);assert.equal(bugs[0].attempts[0].status,'verified');assert(c.store.state.jobs.some(j=>j.type==='maintenance'&&j.context.bugId===bugs[0].id));assert(!c.store.state.todos.some(t=>t.status==='open'&&['system','recovery','problem'].includes(t.kind)));
});

test('maintenance transaction bounds retries, cancellation wins, and permission failures are not swallowed',async()=>{
 const {Controller}=await import('../src/agents/managed/controller.mjs');
 const storage=memory(),job={id:'j',target:'w',revision:1,status:'running'},work={id:'w',revision:1,status:'running'};
 const c=Object.create(Controller.prototype);Object.assign(c,{projectId:'p',maintenance:new MaintenanceLedger(storage,'p'),maintenanceActions:new Map(),maintenanceFlights:new Map(),stopping:false,store:{state:{jobs:[job],works:[work]},mutate:async fn=>fn()},changed(){},kick(){},maintenanceEvent:async()=>{}});
 let calls=0;await assert.rejects(c.maintenanceTransaction(job,'publication',async()=>{calls++;throw Error('host failure');}),{code:'MAINTENANCE_PENDING'});assert.equal(calls,2);assert.equal(work.status,'paused');const bug=(await c.maintenanceStatus()).bugs[0];await c.maintenanceRetry(bug.id);await c.maintenanceRetry(bug.id);assert.equal(calls,3);assert.equal((await c.maintenanceStatus()).bugs[0].attempts.length,2);
 const permission=Object.assign(Error('native permission required'),{code:'EACCES'});await assert.rejects(c.maintenanceTransaction(job,'publication',async()=>{throw permission;}),error=>error===permission);assert(maintenanceBoundary(permission));assert.equal((await c.maintenanceStatus()).bugs.length,1);
 const other=await c.maintenance.record({phase:'publication',jobId:'j',workId:'w',revision:2,error:Error('different')});c.maintenanceActions.set(other.id,async()=>{calls++;return true;});await c.maintenanceRetry(other.id);assert.equal(calls,3);assert.equal((await c.maintenanceStatus()).bugs.find(b=>b.id===other.id).status,'cancelled');
 const reopened=Object.create(Controller.prototype);Object.assign(reopened,c,{maintenance:new MaintenanceLedger(storage,'p'),maintenanceActions:new Map(),maintenanceFlights:new Map()});await reopened.maintenanceRetry(other.id);assert.equal(calls,3);
});

test('all conflict and model-invalid resource guards stay outside silent maintenance',()=>{
 for(const code of ['USER_DIRTY','INPUT_OVERLAP','TARGET_OVERLAP','HEAD_DRIFT','USER_STAGED','INDEX_CHANGED','SOURCE_CHANGED','IDENTITY_CHANGED','UNPUBLISHED_CHANGES','GIT_BUSY','GIT_LOCKED','WORK_BUSY','MISSING_THREAD','PERMISSION_REQUIRED','EFFECT_RESULT_UNKNOWN','REPORT_RESOURCE_NOT_DECLARED','HTML_INVALID'])assert(maintenanceBoundary({code}),code);
 assert(!maintenanceBoundary({code:128,message:'fatal: cannot lock ref'}));
});

test('maintenance provider failure cannot recursively enqueue maintenance or replay a started effect',async()=>{
 const {Controller}=await import('../src/agents/managed/controller.mjs');const job={id:'maintenance-job',type:'maintenance',target:'orchestrator',status:'running'},storage=memory();let events=0,runs=0;
 const c=Object.create(Controller.prototype);Object.assign(c,{maintenance:new MaintenanceLedger(storage,'p'),maintenanceActions:new Map(),maintenanceFlights:new Map(),store:{state:{jobs:[job],works:[]},mutate:async fn=>fn()},maintenanceEvent:async()=>{events++;},changed(){}});
 await assert.rejects(c.maintenanceTransaction(job,'session-start',async()=>{runs++;throw Error('provider unavailable');}),{code:'MAINTENANCE_PENDING'});assert.equal(runs,1);assert.equal(events,0);assert.equal(c.maintenanceActions.size,0);assert.equal((await c.maintenanceStatus()).bugs[0].status,'needs-version-fix');
});

test('maintenance status is readonly even with interrupted durable attempt and no writable business store',async()=>{
 const {Controller}=await import('../src/agents/managed/controller.mjs');const ledger=new MaintenanceLedger(memory(),'p');const bug=await ledger.record({phase:'publication',error:Error('transient')});await ledger.attempt(bug.id);
 const c=Object.create(Controller.prototype);Object.assign(c,{maintenance:ledger,maintenanceFlights:new Map(),store:{mutate(){throw Error('offline write forbidden');}}});
 assert.equal((await c.maintenanceStatus()).bugs[0].status,'needs-version-fix');assert.equal((await ledger.read()).bugs[0].status,'repairing');
});

test('Git ref lock diagnostics retain only categorized symptom and app-relative source frames',()=>{
 const error=Object.assign(Error('cannot lock ref secret-token document body'),{code:128});error.stack='Error: secret-token\n at git (/home/private/apps/desktop/src/agents/managed/git.mjs:21:4)\n at user (/private/user/document.mjs:1:2)';
 const context=maintenanceError(error);assert.equal(context.symptom,'git-ref-lock');assert.deepEqual(context.frames,['src/agents/managed/git.mjs:21:4']);assert(!JSON.stringify(context).includes('secret-token'));assert(!JSON.stringify(context).includes('/home/private'));
 for(const code of ['INJECTED_PROJECT_COMMIT','PROJECT_UNAVAILABLE','STORAGE_UNAVAILABLE','OMP_SESSION_FILE_NOT_FOUND'])assert(maintenanceBoundary({code}),code);
});

test('resident mismatch escapes real startup unchanged with target and no maintenance recursion',async()=>{
 const {Controller}=await import('../src/agents/managed/controller.mjs');
 const storage=memory(),mismatch=Object.assign(Error('incompatible trusted tool schema'),{code:'OMP_TOOLS_DIGEST_MISMATCH'});let starts=0,events=0;
 const c=Object.create(Controller.prototype);Object.assign(c,{projectId:'p',sessions:new Map(),maintenance:new MaintenanceLedger(storage,'p'),maintenanceActions:new Map(),maintenanceFlights:new Map(),store:{requireOnline:async()=>{},state:{jobs:[],works:[],residents:{}}},prepareOnline:async()=>{},assertFrontdeskContextAdmission(){},makeSession:async target=>{if(target==='orchestrator')throw mismatch;return {preflight:true};},session:async()=>{starts++;},maintenanceEvent:async()=>{events++;}});
 await assert.rejects(c.start(),error=>error===mismatch&&error.target==='orchestrator'&&error.role==='orchestrator');
 assert.equal(starts,0);assert.equal(events,0);assert.equal(c.started,undefined);assert.equal(c.maintenanceActions.size,0);assert.deepEqual((await c.maintenance.read()).bugs,[]);
 assert(maintenanceBoundary(mismatch));
});

test('bootstrap internal fault records diagnostics without repair into an unstarted controller',async()=>{
 const {Controller}=await import('../src/agents/managed/controller.mjs');
 const storage=memory(),failure=Object.assign(Error('native bootstrap failed'),{code:'OMP_START_FAILED'});let calls=0,events=0;
 const c=Object.create(Controller.prototype);Object.assign(c,{projectId:'p',maintenance:new MaintenanceLedger(storage,'p'),maintenanceActions:new Map(),maintenanceFlights:new Map(),store:{state:{jobs:[],works:[]}},maintenanceEvent:async()=>{events++;}});
 await assert.rejects(c.maintenanceTransaction(null,'resident-start-frontdesk',async()=>{calls++;throw failure;}),error=>error===failure);
 assert.equal(calls,1);assert.equal(events,0);assert.equal(c.maintenanceActions.size,0);const bugs=(await c.maintenance.read()).bugs;assert.equal(bugs.length,1);assert.equal(bugs[0].status,'needs-version-fix');assert.deepEqual(bugs[0].attempts,[]);
});

test('verified same-thread resident startup durably settles only obsolete queued mismatch repair events',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-bootstrap-reconciled-'));
 const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),projectHome:home=>fs.mkdir(home,{recursive:true})});
 t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});c.kick=()=>{};
 const bug=await c.maintenance.record({phase:'resident-preflight-orchestrator',error:{code:'OMP_TOOLS_DIGEST_MISMATCH'}});
 for(let n=0;n<2;n++){await c.maintenance.attempt(bug.id);await c.maintenance.finish(bug.id,{outcome:'needs-version-fix'});}
 const other=await c.maintenance.record({phase:'resident-start-frontdesk',error:{code:'OMP_START_FAILED'}});
 const unknown=await c.maintenance.record({phase:'resident-start-frontdesk',error:{code:'OMP_TOOLS_DIGEST_MISMATCH'}});
 await c.store.mutate(()=>{c.store.state.residents={frontdesk:{provider:'omp',threadId:'front-original',toolsDigest:'front-current'},orchestrator:{provider:'omp',threadId:'orchestrator-original',toolsDigest:'orchestrator-current'}};c.store.state.jobs.push({id:'repair',type:'maintenance',status:'queued',context:{bugId:bug.id}},{id:'business',type:'front',status:'queued',context:{}},{id:'other',type:'maintenance',status:'queued',context:{bugId:other.id}},{id:'unknown',type:'maintenance',status:'running',promptStartedAt:'already-admitted',context:{bugId:unknown.id}});c.store.state.drafts.frontdesk='unsent draft';});
 const previous={frontdesk:'front-original',orchestrator:'orchestrator-original'},before=structuredClone(c.store.state.jobs.slice(-3));
 await c.reconcileResidentSchemaMaintenance(previous);assert.equal(c.store.state.jobs.find(j=>j.id==='repair').status,'queued','no actual startup receipts yet');
 for(const target of ['frontdesk','orchestrator']){const resident=c.store.state.residents[target];c.sessions.set(target,{threadId:resident.threadId,toolsDigest:resident.toolsDigest,closed:false,stop:async()=>({confirmationComplete:true})});}
 await c.start();await c.start();
 assert.equal(c.store.state.jobs.find(j=>j.id==='repair').status,'completed');assert.equal(c.store.state.jobs.find(j=>j.id==='repair').completion,'current-schema-resumed');assert.deepEqual(c.store.state.jobs.slice(-3),before);assert.equal(c.store.state.drafts.frontdesk,'unsent draft');
 const persisted=new MaintenanceLedger(c.store.storage,c.projectId),saved=(await persisted.read()).bugs.find(b=>b.id===bug.id);assert.equal(saved.status,'repaired');assert.equal(saved.lastOutcome.verified,true);assert.equal(saved.lastOutcome.outcome,'current-schema-resumed');assert.equal(saved.attempts.length,2);assert.equal((await persisted.read()).bugs.find(b=>b.id===unknown.id).status,'detected');
});
