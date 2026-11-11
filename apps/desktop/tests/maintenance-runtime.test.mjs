import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {MaintenanceLedger,maintenanceBoundary,maintenanceError,sanitizeHostToolFailure} from '../src/agents/managed/maintenance-ledger.mjs';
import {DiagramRecovery} from '../src/agents/managed/diagram-recovery.mjs';
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
 const bugs=(await c.maintenanceStatus()).bugs;assert.equal(bugs.length,1);assert.equal(bugs[0].status,'repaired');assert.equal(bugs[0].jobId,accepted.jobId);assert.equal(bugs[0].attempts[0].status,'verified');assert(!c.store.state.jobs.some(j=>j.type==='maintenance'&&j.context.bugId===bugs[0].id),'host-first success never releases a redundant model event');assert(!c.store.state.todos.some(t=>t.status==='open'&&['system','recovery','problem'].includes(t.kind)));
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
 for(const code of ['USER_DIRTY','INPUT_OVERLAP','TARGET_OVERLAP','HEAD_DRIFT','USER_STAGED','INDEX_CHANGED','SOURCE_CHANGED','IDENTITY_CHANGED','UNPUBLISHED_CHANGES','GIT_BUSY','WORK_BUSY','MISSING_THREAD','PERMISSION_REQUIRED','EFFECT_RESULT_UNKNOWN','REPORT_RESOURCE_NOT_DECLARED','HTML_INVALID'])assert(maintenanceBoundary({code}),code);
 assert(!maintenanceBoundary({code:128,message:'fatal: cannot lock ref'}));
 assert(!maintenanceBoundary({code:'GIT_LOCKED'}));
 for(const code of ['ENOENT','ENOTDIR','EISDIR','EINVAL','ELOOP','ENOSPC','EROFS'])assert(!maintenanceBoundary({code},{phase:'closure'}),code);
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
 for(const code of ['INJECTED_PROJECT_COMMIT','PROJECT_UNAVAILABLE','STORAGE_UNAVAILABLE','OMP_SESSION_FILE_NOT_FOUND','PI_SESSION_FILE_NOT_FOUND'])assert(maintenanceBoundary({code}),code);
});

test('structured host-tool failure provenance survives only through the strict allowlist',async()=>{
 const digest='a'.repeat(64);
 const valid={schema:1,tool:'nozeli_diagram',callId:'call_9F',stage:'render',effect:'none',code:'ARCHIFY_RENDER_FAILED',validationKind:'render-output',ruleCodes:['single_svg'],issueCount:2,argumentsDigest:digest,diagramEvidence:{tool:'nozeli_diagram',stage:'validation',effect:'none',category:'schema',rules:[{code:'schema/required',count:2},{code:'clean-flow/endpoint-side-direction',count:1}]}};
 const kept=maintenanceError(Object.assign(Error('raw token=SECRET document body'),{hostToolFailure:valid}));
 assert.deepEqual(kept.hostToolFailure,{schema:1,tool:'nozeli_diagram',callId:'call_9F',stage:'render',effect:'none',code:'ARCHIFY_RENDER_FAILED',validationKind:'render-output',ruleCodes:['single_svg'],issueCount:2,argumentsDigest:digest,diagramEvidence:{tool:'nozeli_diagram',stage:'validation',effect:'none',category:'schema',rules:[{code:'schema/required',count:2},{code:'clean-flow/endpoint-side-direction',count:1}]}});
 assert(!JSON.stringify(kept).includes('SECRET'),'raw message never rides the structured block');
 // Exactly the sanitized block is durable; raw error text stays out of the ledger.
 const storage=memory(),ledger=new MaintenanceLedger(storage,'p');
 await ledger.record({phase:'tool',jobId:'j',error:Object.assign(Error('PRIVATE user document token=SECRET'),{code:'ARCHIFY_RENDER_FAILED',hostToolFailure:valid})});
 const persisted=(await ledger.read()).bugs[0].error;
 assert.deepEqual(persisted.hostToolFailure,kept.hostToolFailure);
 assert(!JSON.stringify(persisted).includes('PRIVATE'));assert(!JSON.stringify(persisted).includes('SECRET'));
 // Unrecognizable input is excluded wholesale; no forged evidence survives.
 for(const forged of [
  {schema:2,tool:'nozeli_diagram',callId:'c',stage:'render',effect:'none',code:'A'},
  {schema:1,tool:'rm -rf /etc',callId:'c',stage:'render',effect:'none',code:'A'},
  {schema:1,tool:'nozeli_dispatch',callId:'c',stage:'execute',effect:'none',code:'A'},
  {schema:1,tool:'nozeli_dispatch',callId:'c',stage:'tool',effect:'maybe',code:'A'},
  {schema:1,tool:'nozeli_diagram',callId:'call id with spaces',stage:'render',effect:'none',code:'A'},
  {schema:1,tool:'nozeli_diagram',callId:'c',stage:'validation',effect:'none',code:'A'},
  'not-an-object',null,42,[],{schema:1,tool:'nozeli_diagram',stage:'render',effect:'none',code:'A'},
 ])assert.equal(sanitizeHostToolFailure(forged),null,JSON.stringify(forged));
 // Only the recognized pure renderer may claim a pre-effect proof; anything
 // else degrades to unknown instead of fabricating safety.
 assert.deepEqual(sanitizeHostToolFailure({schema:1,tool:'nozeli_publish',callId:'c',stage:'tool',effect:'none',code:'PUBLISH_FAILED'}).effect,'unknown');
 // Invalid optional fields drop individually; machine fallbacks stay bounded.
 const partial=sanitizeHostToolFailure({schema:1,tool:'nozeli_diagram',callId:'c',stage:'render',effect:'none',code:'not a machine code',validationKind:'user label',ruleCodes:['single_svg','BAD CODE!'],issueCount:-3,argumentsDigest:'zzz',diagramEvidence:{tool:'nozeli_diagram',stage:'validation',effect:'none',category:'user label',rules:[{code:'x y',count:1}]}});
 assert.deepEqual(partial,{schema:1,tool:'nozeli_diagram',callId:'c',stage:'render',effect:'none',code:'HOST_TOOL_ERROR'});
 // Nested diagram evidence keeps only closed-vocabulary categories and rule
 // code histograms; labels and free text never enter.
 const nested=sanitizeHostToolFailure({schema:1,tool:'nozeli_diagram',callId:'c',stage:'render',effect:'none',code:'A',diagramEvidence:{tool:'nozeli_diagram',stage:'validation',effect:'none',category:'render-output',rules:[{code:'single_svg',count:1},{code:'finite_svg',count:2},{code:'has spaces',count:1},{code:'schema/required',count:0}]},correction:{retryTool:'nozeli_diagram',supportedFixes:['echo PRIVATE user id']}});
 assert.deepEqual(nested.diagramEvidence,{tool:'nozeli_diagram',stage:'validation',effect:'none',category:'render-output',rules:[{code:'single_svg',count:1},{code:'finite_svg',count:2}]});
 assert(!JSON.stringify(nested).includes('PRIVATE'));assert.equal(nested.correction,undefined,'worker-facing correction never persists');
});

test('resident mismatch escapes real startup unchanged with target and no maintenance recursion',async()=>{
 const {Controller}=await import('../src/agents/managed/controller.mjs');
 const storage=memory(),mismatch=Object.assign(Error('incompatible trusted tool schema'),{code:'PI_TOOLS_DIGEST_MISMATCH'});let starts=0,events=0;
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
 const bug=await c.maintenance.record({phase:'resident-preflight-orchestrator',error:{code:'PI_TOOLS_DIGEST_MISMATCH'}});
 for(let n=0;n<2;n++){await c.maintenance.attempt(bug.id);await c.maintenance.finish(bug.id,{outcome:'needs-version-fix'});}
 const other=await c.maintenance.record({phase:'resident-start-frontdesk',error:{code:'OMP_START_FAILED'}});
 const unknown=await c.maintenance.record({phase:'resident-start-frontdesk',error:{code:'PI_TOOLS_DIGEST_MISMATCH'}});
 await c.store.mutate(()=>{c.store.state.residents={frontdesk:{provider:'pi',threadId:'front-original',toolsDigest:'front-current'},orchestrator:{provider:'pi',threadId:'orchestrator-original',toolsDigest:'orchestrator-current'}};c.store.state.jobs.push({id:'repair',type:'maintenance',status:'queued',context:{bugId:bug.id}},{id:'business',type:'front',status:'queued',context:{}},{id:'other',type:'maintenance',status:'queued',context:{bugId:other.id}},{id:'unknown',type:'maintenance',status:'running',promptStartedAt:'already-admitted',context:{bugId:unknown.id}});c.store.state.drafts.frontdesk='unsent draft';});
 const previous={frontdesk:'front-original',orchestrator:'orchestrator-original'},before=structuredClone(c.store.state.jobs.slice(-3));
 await c.reconcileResidentSchemaMaintenance(previous);assert.equal(c.store.state.jobs.find(j=>j.id==='repair').status,'queued','no actual startup receipts yet');
 for(const target of ['frontdesk','orchestrator']){const resident=c.store.state.residents[target];c.sessions.set(target,{threadId:resident.threadId,toolsDigest:resident.toolsDigest,closed:false,stop:async()=>({confirmationComplete:true})});}
 await c.start();await c.start();
 assert.equal(c.store.state.jobs.find(j=>j.id==='repair').status,'completed');assert.equal(c.store.state.jobs.find(j=>j.id==='repair').completion,'current-schema-resumed');assert.deepEqual(c.store.state.jobs.slice(-3),before);assert.equal(c.store.state.drafts.frontdesk,'unsent draft');
 const persisted=new MaintenanceLedger(c.store.storage,c.projectId),saved=(await persisted.read()).bugs.find(b=>b.id===bug.id);assert.equal(saved.status,'repaired');assert.equal(saved.lastOutcome.verified,true);assert.equal(saved.lastOutcome.outcome,'current-schema-resumed');assert.equal(saved.attempts.length,0,'schema mismatch cannot admit replay attempts');assert.equal((await persisted.read()).bugs.find(b=>b.id===unknown.id).status,'detected');
});

async function repairFixture(){
 const {Controller}=await import('../src/agents/managed/controller.mjs');
 const job={id:'original',target:'w',revision:1,status:'failed'},work={id:'w',revision:1,status:'paused'};
 const c=Object.create(Controller.prototype);Object.assign(c,{projectId:'p',maintenance:new MaintenanceLedger(memory(),'p'),maintenanceActions:new Map(),maintenanceFlights:new Map(),current:new Map(),coldJobs:new Set(),store:{state:{jobs:[job],works:[work],todos:[]},mutate:async fn=>fn()},changed(){},kick(){}});
 const bug=await c.maintenance.record({phase:'publication',jobId:job.id,workId:work.id,revision:1,error:Error('host failure')});return {c,job,work,bug};
}

test('verified host repair settles exact never-admitted queued events and retains all other effects',async()=>{
 const {c,bug}=await repairFixture();c.maintenanceActions.set(bug.id,async()=>true);
 const event=(id,extra={})=>({id,target:'orchestrator',type:'maintenance',status:'queued',context:{bugId:bug.id},...extra});
 const rows=[event('safe'),event('running',{status:'running'}),event('prompt',{promptStartedAt:'before'}),event('admitted',{collabAttempts:[{status:'settled',everAdmitted:true}]}),event('unknown',{collabAttempts:[{status:'prepared'}]}),event('cold'),event('other',{context:{bugId:'other'}}),event('business',{type:'initial'})];
 c.coldJobs.add('cold');c.store.state.jobs.push(...rows);const retained=structuredClone(rows.slice(1));
 const result=await c.maintenanceRetry(bug.id,{binding:c.maintenanceBinding(bug)});assert.equal(result.status,'repaired');assert.equal(rows[0].status,'completed');assert.equal(rows[0].hostResolved,true);assert.deepEqual(rows.slice(1),retained);
 assert.equal((await c.maintenance.read()).bugs[0].lastOutcome.verified,true);assert.equal(c.hostOperations.size,0);
});

test('admitted event racing with durable settlement is never overwritten',async()=>{
 const {c,bug}=await repairFixture();const row={id:'event',target:'orchestrator',type:'maintenance',status:'queued',context:{bugId:bug.id}};c.store.state.jobs.push(row);
 c.maintenanceActions.set(bug.id,async()=>{row.status='running';row.collabAttempts=[{status:'admitted',everAdmitted:true}];return true;});
 await c.maintenanceRetry(bug.id);assert.equal(row.status,'running');assert.equal(row.hostResolved,undefined);
});

test('binding checks precede duplicate-flight join and retries remain single flight',async()=>{
 const {c,bug}=await repairFixture();let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);let calls=0;
 c.maintenanceActions.set(bug.id,async()=>{calls++;entered();await gate;return true;});
 const binding=c.maintenanceBinding(bug),first=c.maintenanceRetry(bug.id,{binding});await started;
 assert.equal(c.maintenanceCapability(bug).retryReason,'repair-in-flight');
 await assert.rejects(c.maintenanceRetry(bug.id,{binding:{...binding,revision:2}}),{code:'STALE_MAINTENANCE_BINDING'});
 const duplicate=c.maintenanceRetry(bug.id,{binding});release();assert.equal((await first).status,'repaired');assert.equal((await duplicate).status,'repaired');assert.equal(calls,1);assert.equal((await c.maintenance.read()).bugs[0].attempts.length,1);
});

test('cold action absence, unfinished attempts, storage unknown and human holds cannot authorize replay',async()=>{
 const {c,bug,job,work}=await repairFixture();assert.equal(c.maintenanceCapability(bug).retryReason,'original-action-unavailable');await c.maintenanceRetry(bug.id);assert.equal((await c.maintenance.read()).bugs[0].attempts.length,0);
 let calls=0;c.maintenanceActions.set(bug.id,async()=>{calls++;return true;});
 c.store.commitUnknown={};assert.equal(c.maintenanceCapability(bug).retryReason,'storage-result-unknown');await c.maintenanceRetry(bug.id);delete c.store.commitUnknown;
 c.store.lifecycleHold={};assert.equal(c.maintenanceCapability(bug).retryReason,'lifecycle-held');delete c.store.lifecycleHold;
 job.collabAttempts=[{status:'unknown'}];assert.equal(c.maintenanceCapability(bug).retryReason,'original-effect-unknown');delete job.collabAttempts;
 c.store.state.todos.push({workId:work.id,status:'open',kind:'recovery'});assert.equal(c.maintenanceCapability(bug).retryReason,'human-decision-required');c.store.state.todos=[];
 await c.maintenance.attempt(bug.id);const interrupted=(await c.maintenance.read()).bugs[0];assert.equal(c.maintenanceCapability(interrupted).retryReason,'interrupted-host-attempt');await c.maintenanceRetry(bug.id);assert.equal(calls,0);
});

test('explicit end and revision changes win both before and during a repair flight',async()=>{
 for(const change of [work=>work.status='ended',work=>work.revision++]){
  const {c,bug,work}=await repairFixture();let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  c.maintenanceActions.set(bug.id,async()=>{entered();await gate;return true;});const flight=c.maintenanceRetry(bug.id);await started;change(work);release();assert.equal((await flight).status,'cancelled');assert.equal((await c.maintenance.read()).bugs[0].lastOutcome.verified,false);
 }
});

test('verified business restoration can retry without repeating the executed host effect',async()=>{
 for(const phase of ['publication','session-start']){
  const {c,bug:original,work,job}=await repairFixture();const bug=phase==='publication'?original:await c.maintenance.record({phase,jobId:job.id,workId:work.id,revision:1,error:Error('startup failure')});
  work.maintenance={bugId:bug.id,status:'detected'};if(phase==='publication')work.result={revision:1};
  let effects=0,fail=true;c.maintenanceActions.set(bug.id,async()=>{effects++;return true;});
  c.store.mutate=async fn=>{if(fail)throw Object.assign(Error('business save failed'),{code:'SAVE_FAILED'});return fn();};
  await assert.rejects(c.maintenanceRetry(bug.id),/business save failed/);
  const pending=(await c.maintenance.read()).bugs.find(b=>b.id===bug.id);assert.equal(pending.status,'finalizing');assert.equal(pending.lastOutcome.verified,true);assert.equal(work.status,'paused');assert.equal(effects,1);assert.equal(c.maintenanceCapability(pending).retry,true);
  c.store.commitUnknown={};assert.equal(c.maintenanceCapability(pending).retryReason,'storage-result-unknown');await c.maintenanceRetry(bug.id);assert.equal(effects,1);delete c.store.commitUnknown;
  fail=false;const result=await c.maintenanceRetry(bug.id);assert.equal(result.status,'repaired');assert.equal(effects,1);assert.equal(work.maintenance,undefined);assert.equal(work.status,phase==='publication'?'review':'running');if(phase==='session-start')assert.equal(job.status,'queued');
 }
});

test('verification receipt save failure retains exact live effect fence, including final attempt',async()=>{
 const {c,bug,work}=await repairFixture();work.maintenance={bugId:bug.id};work.result={revision:1};
 await c.maintenance.attempt(bug.id);await c.maintenance.finish(bug.id,{outcome:'needs-version-fix'});
 let effects=0;c.maintenanceActions.set(bug.id,async()=>{effects++;return true;});const finish=c.maintenance.finish.bind(c.maintenance);let fail=true;
 c.maintenance.finish=async(id,options)=>{if(fail&&options?.verified)throw Error('receipt save failed');return finish(id,options);};
 await assert.rejects(c.maintenanceRetry(bug.id),/receipt save failed/);assert.equal(effects,1);const pending=(await c.maintenance.read()).bugs[0];assert.equal(pending.attempts.length,2);assert.equal(pending.attempts[1].status,'started');assert.equal(c.maintenanceCapability(pending).retry,true);
 const exact=c.maintenanceActions.get(bug.id);c.maintenanceActions.set(bug.id,async()=>{effects++;return true;});assert.equal(c.maintenanceCapability(pending).retry,false);c.maintenanceActions.set(bug.id,exact);
 fail=false;assert.equal((await c.maintenanceRetry(bug.id)).status,'repaired');assert.equal(effects,1);assert.equal(work.status,'review');
});

test('real ended Work closure repair retains its original immutable discard decision',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-closure-maintenance-'));
 const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),projectHome:home=>fs.mkdir(home,{recursive:true})});
 t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});c.kick=()=>{};
 const w=await c.store.submit('original request','original brief');const cleanup=c.store.cleanupWorkerHome.bind(c.store);let calls=0;
 c.store.cleanupWorkerHome=async(...args)=>{if(++calls===1)throw Error('transient closure cleanup');return cleanup(...args);};
 await c.endWork(w.id,{revision:w.revision,decision:'discard'});
 const ended=c.store.find(w.id),binding=structuredClone(ended.closure.binding),requestKey=ended.closure.requestKey,revision=ended.revision;
 const bug=(await c.maintenance.read()).bugs.find(b=>b.phase==='closure');assert(bug);assert.equal(ended.status,'ended');assert.equal(bug.status,'repaired');assert.equal(c.maintenanceCapability(bug).retryReason,'already-repaired');
 const event=c.store.state.jobs.find(job=>job.type==='maintenance'&&job.context?.bugId===bug.id);assert.equal(event.status,'completed');assert.equal(event.hostResolved,true);assert.equal(ended.maintenance,undefined);assert.equal(ended.closure.retryRequests,undefined);
 assert.equal((await c.maintenanceRetry(bug.id)).status,'repaired');assert.equal(calls,2);assert.equal(c.store.find(w.id).closure.phase,'complete');assert.equal(c.store.find(w.id).status,'ended');assert.equal(c.store.find(w.id).revision,revision);assert.equal(c.store.find(w.id).closure.decision,'discard');assert.equal(c.store.find(w.id).closure.requestKey,requestKey);assert.deepEqual(c.store.find(w.id).closure.binding,binding);
});

test('last verified repair attempt survives repeated business-save failures with finalization-only continuation',async()=>{
 const {c,bug,work}=await repairFixture();work.maintenance={bugId:bug.id,status:'detected'};work.result={revision:1};
 await c.maintenance.attempt(bug.id);await c.maintenance.finish(bug.id,{outcome:'needs-version-fix'});
 let effects=0,fail=true;const action=async()=>{effects++;return true;};c.maintenanceActions.set(bug.id,action);
 c.store.mutate=async fn=>{if(fail)throw Error('restoration persistence unavailable');return fn();};
 for(let n=0;n<3;n++){
  await assert.rejects(c.maintenanceRetry(bug.id),/restoration persistence unavailable/);
  const pending=(await c.maintenance.read()).bugs[0];assert.equal(pending.status,'finalizing');assert.equal(pending.attempts.length,2);assert.equal(pending.attempts[1].status,'verified');assert.equal(effects,1);
  assert.deepEqual(c.maintenanceCapability(pending),{retry:true,retryReason:null,retryMode:'finalize'});assert.equal(work.status,'paused');assert.equal(work.maintenance.bugId,bug.id);
 }
 const pending=(await c.maintenance.read()).bugs[0],retained=c.maintenanceVerified;
 c.maintenanceVerified=new Map();c.maintenanceActions=new Map();assert.equal(c.maintenanceCapability(pending).retry,false);assert.equal((await c.maintenanceRetry(bug.id)).status,'finalizing');assert.equal(effects,1);
 c.maintenanceVerified=retained;c.maintenanceActions.set(bug.id,action);fail=false;
 assert.equal((await c.maintenanceRetry(bug.id)).status,'repaired');assert.equal(effects,1);assert.equal(work.status,'review');assert.equal(work.maintenance,undefined);assert.equal((await c.maintenance.read()).bugs[0].attempts.length,2);assert.equal(c.maintenanceCapability((await c.maintenance.read()).bugs[0]).retryMode,null);
});

test('actual runJob keeps verified repair bookkeeping failures in maintenance rather than business recovery',async t=>{
 for(const failure of ['verification-receipt','business-bookkeeping']){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-runjob-finalization-'));let prepares=0,prompts=0,injected=false;
  class Session{constructor(spec){Object.assign(this,spec,{closed:false,busy:false});}async preflightToolsDigest(){}async assertToolsDigest(){}async start(thread){this.threadId=thread??randomUUID();return this;}async stop(){this.closed=true;return {confirmationComplete:true};}async prompt(){prompts++;return {text:'retained',threadId:this.threadId,completion:'provider-completed'};}}
  const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),sessionFactory:spec=>new Session(spec),projectHome:home=>fs.mkdir(home,{recursive:true})});
  t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});c.kick=()=>{};c.ensureWorkerDelivery=async()=>{};c.store.settle=async()=>{};
  const prepare=c.execution.prepare.bind(c.execution);c.execution.prepare=async(...args)=>{if(++prepares===1)throw Error('transient original snapshot');return prepare(...args);};
  if(failure==='verification-receipt'){
   const finish=c.maintenance.finish.bind(c.maintenance);c.maintenance.finish=async(id,options)=>{if(!injected&&options?.verified){injected=true;throw Error('one-shot verification receipt save');}return finish(id,options);};
  }else{
   const mutate=c.store.mutate.bind(c.store);c.store.mutate=async fn=>{if(!injected&&c.maintenanceVerified?.size){injected=true;throw Error('one-shot business bookkeeping save');}return mutate(fn);};
  }
  const w=await c.store.submit('original request','original brief');await c.store.activate(w.id);const accepted=await c.enqueue(w.id,'initial','original input');
  await c.runJob(c.store.state.jobs.find(j=>j.id===accepted.jobId));assert.equal(injected,true);assert.equal(prepares,2);assert.equal(prompts,0);
  const bug=(await c.maintenance.read()).bugs[0],job=c.store.state.jobs.find(j=>j.id===accepted.jobId),work=c.store.find(w.id);
  assert.equal(job.status,'failed');assert.equal(job.maintenanceBugId,bug.id);assert.equal(job.maintenanceFault.phase,'input-preparation');assert.equal(work.status,'paused');assert.equal(work.maintenance.bugId,bug.id);
  assert(!c.store.state.todos.some(todo=>todo.status==='open'&&['system','recovery','problem'].includes(todo.kind)),'host finalization must not request a business decision');
  assert(c.store.state.jobs.some(j=>j.type==='maintenance'&&j.context?.bugId===bug.id&&j.status==='queued'));
  assert.deepEqual(c.maintenanceCapability(bug),{retry:true,retryReason:null,retryMode:'finalize'});
  assert.equal((await c.maintenanceRetry(bug.id,{binding:c.maintenanceBinding(bug)})).status,'repaired');assert.equal(prepares,2,'bookkeeping continuation never reruns the verified host effect');assert.equal(prompts,0);assert.equal(c.store.find(w.id).status,'running');assert.equal(c.store.state.jobs.find(j=>j.id===accepted.jobId).status,'queued');assert.equal(c.store.find(w.id).maintenance,undefined);
 }
});

test('actual Worker completion cannot trigger missing-delivery recovery during deferred original publication repair',async t=>{
 const {staticReport}=await import('./static-report.fixture.mjs');const {readStoredReport}=await import('../src/agents/managed/report-descriptor.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-publication-completion-race-'));let prompts=0,publications=0,pendingResolve,enteredResolve,finishWorker,finishPublication;
 const pending=new Promise(resolve=>pendingResolve=resolve),entered=new Promise(resolve=>enteredResolve=resolve),workerGate=new Promise(resolve=>finishWorker=resolve),publicationGate=new Promise(resolve=>finishPublication=resolve);
 const content=staticReport('Original verified publication after host repair.');let toolResult;
 class Session{
  constructor(spec){Object.assign(this,spec,{closed:false,busy:false});}async preflightToolsDigest(){}async assertToolsDigest(){}async start(thread){this.threadId=thread??randomUUID();return this;}async stop(){this.closed=true;return {confirmationComplete:true};}
  async prompt(){this.busy=true;prompts++;try{
   await fs.writeFile(path.join(this.cwd,'result.txt'),'original Worker artifact bytes');
   toolResult=await this.onTool({tool:'nozeli_publish',arguments:{kind:'result',content,files:['result.txt']},callId:'original-publication-call'});pendingResolve();await workerGate;
   return {text:'Worker turn finished while host publication repair remains active',threadId:this.threadId,completion:'provider-completed'};
  }finally{this.busy=false;}}
 }
 const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),sessionFactory:spec=>new Session(spec),projectHome:home=>fs.mkdir(home,{recursive:true})});
 t.after(async()=>{finishWorker();finishPublication();await c.stop();await fs.rm(root,{recursive:true,force:true});});c.kick=()=>{};
 const publish=c.execution.publish.bind(c.execution);c.execution.publish=async(...args)=>{publications++;if(publications<=2)throw Error('transient original host publication');enteredResolve();await publicationGate;return publish(...args);};
 const w=await c.store.submit('original request','original brief');await c.store.activate(w.id);const accepted=await c.enqueue(w.id,'initial','exactly one original Worker input');
 const run=c.runJob(c.store.state.jobs.find(j=>j.id===accepted.jobId));await pending;assert.equal(toolResult.maintenance,true);assert.equal(toolResult.saved,false);
 const bug=(await c.maintenance.read()).bugs.find(b=>b.phase==='publication');assert(bug);const revision=c.store.find(w.id).revision;
 const repair=c.maintenanceRetry(bug.id,{binding:c.maintenanceBinding(bug)});await entered;
 assert.equal(c.store.find(w.id).status,'running','original publication action temporarily restores its active guard');assert.equal(c.store.find(w.id).maintenance.bugId,bug.id);
 finishWorker();await run;
 assert.equal(prompts,1);assert.equal(c.store.state.jobs.find(j=>j.id===accepted.jobId).status,'completed');assert.equal(c.store.find(w.id).status,'running','Worker completion must not settle the still-running exact host repair');
 assert(!c.store.state.todos.some(todo=>todo.workId===w.id&&todo.status==='open'&&['problem','recovery'].includes(todo.kind)));assert.equal(c.store.state.receipts.filter(r=>r.workId===w.id).length,0);
 finishPublication();assert.equal((await repair).status,'repaired');
 const final=c.store.find(w.id),receipts=c.store.state.receipts.filter(r=>r.workId===w.id);assert.equal(final.id,w.id);assert.equal(final.revision,revision);assert.equal(final.status,'review');assert.equal(final.maintenance,undefined);assert.equal(receipts.length,1);assert.equal(receipts[0].id,'original-publication-call');assert.equal(receipts[0].kind,'result');const storedReport=await readStoredReport(c.store,receipts[0]);assert.equal(createHash('sha256').update(storedReport).digest('hex'),receipts[0].report.digest);assert.equal(await c.store.readObject(receipts[0].snapshot.files.find(file=>file.relPath==='result.txt').digest).then(bytes=>bytes.toString()),'original Worker artifact bytes');
 assert.equal(prompts,1);assert.equal(publications,3);assert.equal(c.store.state.works.length,1);assert.equal(c.store.state.jobs.filter(j=>j.target===w.id).length,1);assert(!c.store.state.todos.some(todo=>todo.workId===w.id&&todo.status==='open'&&['problem','recovery'].includes(todo.kind)));
});

test('fatal host intake is durably system-owned with no Worker or original prompt replay',async t=>{
 for(const failure of [
  {code:'HOST_INTERNAL_FAILURE'},
  {code:'PI_HOST_TOOL_FAILED',failureOrigin:'host',hostToolCode:'INTERNAL_TOOL_FAILED'},
  {code:'PI_HOST_TOOL_FAILED'},
 ]){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-host-intake-'));let prompts=0,serviceFacts=0;
  class Session{constructor(spec){Object.assign(this,spec,{closed:false,busy:false});}async preflightToolsDigest(){}async assertToolsDigest(){}async start(thread){this.threadId=thread??randomUUID();return this;}async stop(){this.closed=true;return {confirmationComplete:true};}async prompt(){prompts++;throw Object.assign(Error('private document token must not enter ledger'),failure);}}
  const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),sessionFactory:spec=>new Session(spec),projectHome:home=>fs.mkdir(home,{recursive:true}),onServiceFault:async()=>{serviceFacts++;}});
  t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});c.kick=()=>{};
  const accepted=await c.enqueue('orchestrator','intake','开始落盘',{userGoal:'开始落盘'});
  await c.runJob(c.store.state.jobs.find(j=>j.id===accepted.jobId));
  const job=c.store.state.jobs.find(j=>j.id===accepted.jobId),ledger=new MaintenanceLedger(c.store.storage,c.projectId),bug=(await ledger.read()).bugs[0];
  assert.equal(job.status,'failed');assert.equal(job.maintenanceBugId,bug.id);assert.equal(job.maintenanceFault.phase,'runtime');assert.notEqual(job.diagnosticOnly,true);
  assert.equal(bug.status,'needs-version-fix');assert.deepEqual(bug.attempts,[]);assert(!JSON.stringify(bug).includes('private document'));
  const notice=c.store.state.messages.find(message=>message.jobId===job.id&&message.speaker==='system');assert(notice);assert(!notice.text.includes('private document'));assert(!notice.text.includes(bug.id));
  assert.equal(c.store.state.works.length,0);assert.equal(c.store.state.jobs.filter(j=>j.type==='maintenance'&&j.context.bugId===bug.id).length,1);
  assert(!c.store.state.todos.some(row=>row.status==='open'&&['system','recovery'].includes(row.kind)));
  assert.equal(c.maintenanceCapability(bug).retryReason,'original-action-unavailable');
  assert.equal(serviceFacts,1,'the existing service-fault outlet remains independent of internal bug ownership');
  await c.maintenanceRetry(bug.id);await c.maintenanceScan();assert.equal(prompts,1);assert.equal(c.store.state.works.length,0);assert.equal((await ledger.read()).bugs[0].status,'needs-version-fix');
 }
});

test('provider diagnostics never become internal maintenance or fan out paid diagnostic turns',async t=>{
 for(const code of ['PI_PROVIDER_FAILED','PI_AUTH_REQUIRED','PI_RATE_LIMIT','PI_PROMPT_FAILED','ECONNRESET']){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-provider-intake-'));let prompts=0;
  class Session{constructor(spec){Object.assign(this,spec,{closed:false,busy:false});}async preflightToolsDigest(){}async assertToolsDigest(){}async start(thread){this.threadId=thread??randomUUID();return this;}async stop(){this.closed=true;return {confirmationComplete:true};}async prompt(){prompts++;throw Object.assign(Error('provider unavailable'),{code});}}
  const c=await openTestController({runtimeRoot:path.join(root,'runtime'),contentRoot:path.join(root,'project'),sessionFactory:spec=>new Session(spec),projectHome:home=>fs.mkdir(home,{recursive:true})});
  t.after(async()=>{await c.stop();await fs.rm(root,{recursive:true,force:true});});c.kick=()=>{};
  const accepted=await c.enqueue('orchestrator','intake','original provider request');await c.runJob(c.store.state.jobs.find(j=>j.id===accepted.jobId));
  const job=c.store.state.jobs.find(j=>j.id===accepted.jobId);assert.equal(job.status,'failed');assert.equal(job.diagnosticOnly,true);assert.equal(job.maintenanceBugId,undefined);
  assert.equal((await c.maintenance.read()).bugs.length,0);assert.equal(c.store.state.diagnostics.providerFailures[0].count,1);assert.equal(c.store.state.jobs.length,1);assert.equal(prompts,1);assert.equal(c.store.state.works.length,0);
 }
});

test('historical host wrapper adoption is readonly and unknown effects never get a reconstructed action',async()=>{
 const {c,job}=await repairFixture();job.target='orchestrator';job.type='intake';job.error='historic failure';job.errorCode='PI_HOST_TOOL_FAILED';job.diagnosticOnly=true;job.promptStartedAt='already-started';job.collabAttempts=[{everAdmitted:true,status:'unknown'}];
 c.store.state.todos.push({sourceJobId:job.id,kind:'system',status:'open'});c.maintenanceEvent=async()=>{};
 // maintenanceScan always runs the real diagram recovery recipe scan; the
 // Object.create fixture must carry the same wiring as a production controller.
 c.diagramRecovery=new DiagramRecovery(c);
 const {adopted,automaticReplay}=await c.maintenanceScan();assert.equal(adopted.length,1);assert.equal(automaticReplay,false);assert.notEqual(job.diagnosticOnly,true);assert.equal(job.status,'failed');assert.equal(job.maintenanceFault.phase,'runtime');assert.equal(c.store.state.todos[0].status,'resolved');
 const bug=(await c.maintenance.read()).bugs.find(row=>row.id===job.maintenanceBugId);assert.equal(bug.status,'needs-version-fix');assert.equal(c.maintenanceCapability(bug).retry,false);assert.equal(c.maintenanceActions.size,0);
});

test('host origin preserves permission and unknown-effect boundaries and cannot enter provider diagnostic ledger',async()=>{
 const {c,job}=await repairFixture();
 for(const hostToolCode of ['PERMISSION_DENIED','STALE_REVISION','EXIT_UNCONFIRMED','EFFECT_RESULT_UNKNOWN']){
  const boundary={code:'PI_HOST_TOOL_FAILED',failureOrigin:'host',hostToolCode};
  assert.equal(c.internalRuntimeFailure(boundary),false,hostToolCode);assert.equal(c.providerRuntimeDiagnostic(boundary),false,hostToolCode);
 }
 const failure={code:'PI_PROMPT_FAILED',failureOrigin:'host',hostToolCode:'HOST_INTERNAL_FAILURE'};
 assert.equal(c.internalRuntimeFailure(failure),true);assert.equal(c.providerRuntimeDiagnostic(failure),false);
 await c.recordDiagnosticFailure(job,failure);assert.equal(c.store.state.diagnostics,undefined);assert.equal(job.diagnosticOnly,undefined);
});
