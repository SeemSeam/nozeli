import {createHash} from 'node:crypto';
import {HostError} from '../../main/host.mjs';

/**
 * Service fault gateway (docs/manual-task-control-repair-design.md §4.2/§7).
 * Facts enter ONLY through the real Pi failure pipeline (controller
 * onServiceFault → sanitized structured evidence). Classification reads
 * structured fields — never message text, stacks or bodies.
 *
 * Recovery semantics:
 *  - willRetry (native SDK retry in flight): diagnostic-only record; never
 *    gates, never alerts, never escalates — the native loop owns the retry.
 *  - Settled pre-admission transient: identity-scoped gate for ONE backoff
 *    window (constructor clock/backoffMs; ONE shared deadline wake, claimed
 *    durably per generation); the Core resume executor performs the real
 *    retry; refusal persists and escalates to the banner.
 *  - Settled post-entry or auth/balance/quota: user-critical immediately,
 *    reconciliation-only.
 */

const FAULT_KEY='managed:service-faults';
const MAX_FAULTS=32;
const MAX_AFFECTED=64;
const MAX_BATCHES=16;
const MAX_MEMBERS=64;
const MAX_LIMIT=50;
const REQUEST_KEY=/^[a-zA-Z0-9:_-]{8,160}$/;
const DEFAULT_BACKOFF_MS=30000;
const BACKOFF_MAX_CYCLES=2;

const CATEGORY_LABELS={auth:'登录或授权已失效',balance:'额度不足',quota:'额度或速率受限','service-transient':'服务暂时不可用'};

const now=()=>new Date().toISOString();
const fail=(code,message)=>{throw new HostError(code,message);};
const accountKey=(provider,origin,revision)=>'acct:'+createHash('sha256').update(JSON.stringify(['pi',provider,origin,Number.isSafeInteger(revision)?revision:null])).digest('hex').slice(0,24);

const TRANSIENT_NETWORK_CODES=new Set(['ECONNRESET','ECONNREFUSED','ECONNABORTED','ETIMEDOUT','EPIPE','ENOTFOUND','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT']);

export function classifyServiceFault(evidence){
 if(!evidence||typeof evidence!=='object')return null;
 if(evidence.willRetry===true)return null;
 const status=Number.isSafeInteger(evidence.httpStatus)?evidence.httpStatus:null;
 const network=typeof evidence.networkCode==='string'?evidence.networkCode:(evidence.http??[]).find(row=>row.networkCode)?.networkCode??null;
 let category=null;
 if(status===401||status===403)category='auth';
 else if(status===402)category='balance';
 else if(status===429)category='quota';
 else if(status>=500&&status<=504)category='service-transient';
 else if(status===null&&network&&TRANSIENT_NETWORK_CODES.has(network))category='service-transient';
 if(!category)return null;
 return {category,userCritical:category!=='service-transient'};
}

export function serviceFaultIdentity({provider,endpointOrigin,accountConfigId,category,modelScope}){
 return 'sf:'+createHash('sha256').update(JSON.stringify([provider??null,endpointOrigin??null,accountConfigId??null,category,modelScope??null])).digest('hex').slice(0,32);
}

const emptyRecord=()=>({schema:1,revision:0,faults:[],batches:[],nativeRetries:[]});

function sanitizeRecord(raw){
 if(raw==null)return emptyRecord();
 if(typeof raw!=='object'||Array.isArray(raw)||raw.schema!==1||!Number.isSafeInteger(raw.revision)||raw.revision<0||!Array.isArray(raw.faults)||!Array.isArray(raw.batches))fail('FAULT_RECORD_INVALID','故障账本结构未核实；未当作空记录继续。');
 if(raw.faults.some(fault=>!fault||typeof fault.faultRef!=='string'||!fault.faultRef.startsWith('sf:')||!['active','released'].includes(fault.state)||!Number.isSafeInteger(fault.generation)||fault.generation<1||!Number.isSafeInteger(fault.version)||fault.version<0||!Array.isArray(fault.affected)||!fault.source||typeof fault.source!=='object'))fail('FAULT_RECORD_INVALID','故障身份或版本损坏，保留原记录待核对。');
 if(raw.batches.some(batch=>!batch||typeof batch.batchRef!=='string'||!batch.batchRef.startsWith('sfb:')||!Array.isArray(batch.checkpoints)))fail('FAULT_RECORD_INVALID','故障批次结构损坏，保留原回执。');
 return {...raw,nativeRetries:Array.isArray(raw.nativeRetries)?raw.nativeRetries.slice(-128):[]};
}

const intentDigestOf=payload=>createHash('sha256').update(JSON.stringify(payload)).digest('hex');

export class ServiceFaults {
 constructor({host,storage,controllers,processBudget,lifecycleHolds=()=>null,sourceRevisionOf=async()=>null,modelForTarget=()=>null,liveEvaluate=async()=>({outcome:'stale',reason:'controller-integration-unavailable'}),afterRelease=()=>{},retryExpired=async()=>{},listener=()=>{},clock=()=>Date.now(),timers=globalThis,backoffMs=DEFAULT_BACKOFF_MS}={}){
  Object.assign(this,{host,storage:storage??host?.storage,controllers,processBudget,lifecycleHolds,sourceRevisionOf,modelForTarget,liveEvaluate,afterRelease,retryExpired,listener,clock,timers,backoffMs:Math.max(0,Number.isFinite(backoffMs)?backoffMs:DEFAULT_BACKOFF_MS)});
  this.flights=new Map();
  this.gateCache=new Map();     // projectId -> {unknownBlocked,faults:[…]}
  this.deadlineTimer=null;      // ONE shared bounded deadline wake (no polling)
  this.sourceRevisions=new Map();
  this.deadlineFlight=null;
  this.closedProjects=new Set();
  this.stopped=false;
  this.releaseScopes=new Map();
  this.releases=new Map();
  this.impactSignatures=new Map();
 }

 async prime(projectId){
  this.closedProjects.delete(projectId);
  const {record}=await this.read(projectId);
  for(const provider of new Set(record.faults.map(fault=>fault.source?.provider).filter(Boolean)))this.updateSourceRevision(provider,await this.sourceRevisionOf(provider));
  this.refreshGateCache(projectId,record,{resetUnknown:true});
  return record;
 }

 markUnknown(projectId){
  this.gateCache.set(projectId,{unknownBlocked:true,faults:[]});
  this.scheduleDeadline();
 }

 /** Project lifecycle close: drop its cache entry and reschedule wakes. */
 forget(projectId){
  this.closedProjects.add(projectId);
  this.gateCache.delete(projectId);
  this.impactSignatures.delete(projectId);
  this.scheduleDeadline();
 }

 async stop(){
  this.stopped=true;
  if(this.deadlineTimer){this.timers.clearTimeout(this.deadlineTimer);this.deadlineTimer=null;}
  await this.deadlineFlight;
  await Promise.allSettled([...this.flights.values()]);
 }
 updateSourceRevision(provider,revision){
  if(typeof provider==='string')this.sourceRevisions.set(provider,Number.isSafeInteger(revision)?revision:null);
 }

 async mutate(projectId,fn){
  const prior=this.flights.get(projectId)??Promise.resolve();
  const operation=prior.catch(()=>{}).then(async()=>{
   for(let attempt=0;attempt<4;attempt++){
    const {record,storageRevision}=await this.read(projectId);
    const working=structuredClone(record);
    const result=await fn(working);
    if(result===false)return null;
    if(working.faults.length>MAX_FAULTS)throw new HostError('FAULT_RECORD_CAPACITY','该项目活跃故障记录已满；拒绝新增，请先处理现有故障。');
    if(working.batches.length>MAX_BATCHES)throw new HostError('FAULT_RECORD_CAPACITY','该项目故障批次记录已满；拒绝新批次，原回执保持可查。');
    if(Buffer.byteLength(JSON.stringify(working))>512*1024)fail('FAULT_RECORD_CAPACITY','故障账本达到读取上限，原记录与回执保留。');
    try{
     await this.storage.putLocal(projectId,FAULT_KEY,working,{expectedRevision:storageRevision});
     this.refreshGateCache(projectId,working);
     return result??working;
    }catch(error){
     if(error?.code!=='STORAGE_CONFLICT')throw error;
    }
   }
   throw new HostError('FAULT_STORAGE_CONFLICT','故障记录并发冲突，请刷新后重试。');
  });
  this.flights.set(projectId,operation);
  try{return await operation;}finally{if(this.flights.get(projectId)===operation)this.flights.delete(projectId);}
 }

 async read(projectId){
  let row=null;
  try{row=await this.storage.getLocalRecord(projectId,FAULT_KEY,{maxBytes:512*1024});}
  catch(error){
   if(error?.code==='LOCAL_RECORD_TOO_LARGE')throw new HostError('FAULT_RECORD_INVALID','故障记录超出读取预算；请核对恢复中心，未自动降级读取。');
   throw error;
  }
  return {record:sanitizeRecord(row?.value??null),storageRevision:Number.isSafeInteger(row?.revision)?row.revision:0};
 }

 // Cache reads cannot erase an earlier unconfirmed fault write. Explicit
 // connection priming may re-establish trust after cold-input isolation.
 refreshGateCache(projectId,record,{resetUnknown=false}={}){
  const unknownBlocked=!resetUnknown&&this.gateCache.get(projectId)?.unknownBlocked===true;
  this.gateCache.set(projectId,{unknownBlocked,faults:record.faults.filter(f=>f.state==='active').map(f=>({faultRef:f.faultRef,provider:f.source?.provider??null,modelScope:f.source?.modelScope??null,sourceRevision:f.source?.revision??null,endpointOrigin:f.source?.endpointOrigin??null,accountConfigId:f.source?.accountConfigId??null,generation:f.generation,version:f.version,userCritical:f.userCritical===true,gate:f.gate===true,autoUntilMs:Number.isFinite(f.autoUntilMs)?f.autoUntilMs:null,retryClaim:f.retryClaim??null}))});
  this.scheduleDeadline();
 }
 dueCandidates(){
  const candidates=[];
  for(const [projectId,cache] of this.gateCache){
   const controller=this.controllers?.get(projectId);
   if(cache.unknownBlocked||this.closedProjects.has(projectId)||!controller||controller.stopping)continue;
   for(const fault of cache.faults??[])if(fault.gate&&!fault.userCritical&&Number.isFinite(fault.autoUntilMs)&&!['running','submitted'].includes(fault.retryClaim?.state))candidates.push({projectId,faultRef:fault.faultRef,at:fault.autoUntilMs});
  }
  return candidates.sort((a,b)=>a.at-b.at);
 }
 scheduleDeadline(){
  if(this.deadlineTimer){this.timers.clearTimeout(this.deadlineTimer);this.deadlineTimer=null;}
  if(this.stopped||this.deadlineFlight)return;
  const earliest=this.dueCandidates()[0];
  if(!earliest)return;
  this.deadlineTimer=this.timers.setTimeout(()=>{
   this.deadlineTimer=null;
   const due=this.dueCandidates().filter(item=>item.at<=this.clock());
   this.deadlineFlight=(async()=>{
    for(const item of due){
     if(this.stopped||this.closedProjects.has(item.projectId))continue;
     try{await this.retryExpired(item.projectId,item.faultRef);}
     catch{this.markUnknown(item.projectId);}
    }
   })().finally(()=>{this.deadlineFlight=null;this.scheduleDeadline();});
  },Math.max(0,earliest.at-this.clock()));
  this.deadlineTimer?.unref?.();
 }
 jobSource(projectId,job){
  const controller=this.controllers?.get(projectId),state=controller?.store?.state;
  if(!state||!job||typeof job.target!=='string')return null;
  const session=controller.sessions?.get(job.target),work=(state.works??[]).find(w=>w.id===job.target);
  const configured=this.modelForTarget(projectId,job.target);
  const selection=session&&!session.closed?(session.effective?.model??session.model):null;
  const model=typeof selection==='string'?selection:typeof configured==='string'?configured:typeof configured?.model==='string'?configured.model:work?.binding?.model??state.bindings?.[job.target]?.model??null;
  if(typeof model!=='string'||!model.includes('/'))return null;
  const provider=model.slice(0,model.indexOf('/'));
  return {provider,model,sourceRevision:this.sourceRevisions.get(provider)??null};
 }
 gateFor(projectId,job){
  if(job?.type==='maintenance')return null;
  const cache=this.gateCache.get(projectId),source=this.jobSource(projectId,job);
  if(cache?.unknownBlocked)return {held:true,reason:'service-fault-state-unknown',source};
  for(const [ownerId,entry] of this.gateCache)for(const fault of entry.faults??[]){
   const releasing=this.releaseScopes.get(fault.faultRef),authorization=releasing?.claims.get(projectId);
   if(authorization?.controller===this.controllers?.get(projectId)&&authorization?.jobIds.has(job.id)&&releasing.members.some(scope=>scope.projectId===ownerId&&scope.generation===fault.generation&&scope.version===fault.version))continue;
   if(!fault.gate||source?.provider!==fault.provider||fault.modelScope&&source.model!==fault.modelScope)continue;
   if(fault.accountConfigId&&fault.accountConfigId!==accountKey(source.provider,fault.endpointOrigin,source.sourceRevision))continue;
   if(!fault.accountConfigId&&fault.sourceRevision!==source.sourceRevision)continue;
   const local=(cache?.faults??[]).find(row=>row.faultRef===fault.faultRef),claim=local?.retryClaim;
   if(!fault.userCritical&&claim&&claim.generation===local.generation&&['running','submitted'].includes(claim.state)&&claim.jobIds?.includes(job.id))continue;
   return {held:true,reason:fault.userCritical?'service-fault':'service-fault-backoff',source};
  }
  return {held:false,source};
 }
 summaryFor(projectId){
  const cache=this.gateCache.get(projectId);
  if(!cache)return null;
  const held=cache.faults.filter(fault=>fault.gate);
  return {held:cache.unknownBlocked||held.length>0,count:held.length};
 }

 async observe(projectId,fact){
  if(!fact||typeof fact!=='object')return null;
  const evidence=fact.evidence&&typeof fact.evidence==='object'?fact.evidence:null;
  const classification=classifyServiceFault(evidence);
  if(!classification)return null;
  const provider=typeof evidence.provider==='string'&&evidence.provider.length<=64?evidence.provider:typeof fact.provider==='string'&&fact.provider.length<=64&&fact.provider!=='pi'?fact.provider:null;
  if(!provider)return null;
  const rows=evidence.http??[];
  const failingRow=[...rows].reverse().find(row=>row.networkCode||row.status>=400)??null;
  const endpointOrigin=typeof failingRow?.origin==='string'&&failingRow.origin.length<=300?failingRow.origin:typeof rows[0]?.origin==='string'&&rows[0].origin.length<=300?rows[0].origin:null;
  const modelScope=!['auth','balance'].includes(classification.category)&&typeof evidence.model==='string'&&evidence.model.length<=200?provider+'/'+evidence.model.split('/').pop():null;
  const currentRevision=await this.sourceRevisionOf(provider);
  this.updateSourceRevision(provider,currentRevision);
  const sourceRevision=fact.source?.provider===provider&&Object.hasOwn(fact.source,'sourceRevision')?fact.source.sourceRevision:currentRevision;
  const accountConfigId=accountKey(provider,endpointOrigin,sourceRevision);
  const identity=serviceFaultIdentity({provider,endpointOrigin,accountConfigId,category:classification.category,modelScope});
  const admitted=fact.admitted===true||fact.delivery==='native-record-confirmed';
  const recordConfirmed=fact.recordConfirmed===true||fact.delivery==='native-record-confirmed';
  const postEntry=admitted||recordConfirmed||evidence.phase==='post-entry';
  const jobId=typeof fact.job?.id==='string'&&fact.job.id.length<=200?fact.job.id:null;
  const target=typeof fact.job?.target==='string'&&fact.job.target.length<=200?fact.job.target:null;
  const at=now(),atMs=this.clock();
  const outcome=await this.mutate(projectId,record=>{
   let fault=record.faults.find(f=>f.faultRef===identity);
   if(!fault){
    record.faults.push(fault={faultRef:identity,category:classification.category,userCritical:classification.userCritical,source:{provider,endpointOrigin,accountConfigId,modelScope,revision:Number.isSafeInteger(sourceRevision)?sourceRevision:null},firstAt:at,lastAt:at,occurrenceCount:0,generation:1,version:0,state:'active',gate:false,releasedAt:null,affected:[],backoffCycles:0,autoUntilMs:null,occurrences:[],lastHttpStatus:null,recovering:false,retryClaim:null});
   }
   fault.lastHttpStatus=Number.isSafeInteger(evidence.httpStatus)?evidence.httpStatus:failingRow?.status??null;
   fault.occurrences=[...(fault.occurrences??[]),{at,httpStatus:fault.lastHttpStatus}].slice(-5);
   fault.lastAt=at;fault.occurrenceCount+=1;fault.version+=1;
   if(fault.state!=='active'){fault.state='active';fault.generation+=1;fault.releasedAt=null;fault.gate=false;fault.userCritical=classification.userCritical;fault.backoffCycles=0;fault.autoUntilMs=null;fault.retryClaim=null;}
   fault.retryClaim=null;
   fault.recovering=false;
   if(classification.userCritical||postEntry){
    fault.userCritical=true;fault.gate=true;fault.autoUntilMs=null;
   }else{
    fault.backoffCycles=(fault.backoffCycles??0)+1;
    if(fault.backoffCycles>BACKOFF_MAX_CYCLES){fault.userCritical=true;fault.gate=true;fault.autoUntilMs=null;}
    else{fault.gate=true;fault.autoUntilMs=atMs+this.backoffMs*Math.pow(2,fault.backoffCycles-1);}
   }
   if(jobId){
    let entry=fault.affected.find(a=>a.jobId===jobId);
    if(!entry){
     if(fault.affected.length>=MAX_AFFECTED)throw new HostError('FAULT_RECORD_CAPACITY','单故障受影响任务记录已满；拒绝扩容，请先处理现有故障。');
     fault.affected.push(entry={jobId,target,generation:fault.generation,admitted,recordConfirmed,firstAt:at,lastAt:at,attempts:0});
    }
    entry.lastAt=at;entry.generation=fault.generation;entry.admitted=entry.admitted||admitted;entry.recordConfirmed=entry.recordConfirmed||recordConfirmed;entry.attempts+=1;
   }
   record.revision+=1;
   return {faultRef:identity,generation:fault.generation,version:fault.version,category:fault.category,userCritical:fault.userCritical,gate:fault.gate,autoUntilMs:fault.autoUntilMs,recovering:fault.recovering};
  });
  this.listener({kind:'managed-faults',changed:[identity],observed:outcome});
  return outcome;
 }

 /**
  * Verified native success — the ONLY automatic gate release for non-critical
  * transient faults: a job on the SAME provider (+model scope) that ran a
  * REAL native provider turn to completion after the last occurrence.
  */
 noteProjectState(projectId,state){
  const cache=this.gateCache.get(projectId);
  if(!cache?.faults?.length)return;
  const impact=JSON.stringify((state?.jobs??[]).filter(job=>job.status==='queued').map(job=>[job.id,job.target,job.context?.boundWorkId??null,job.serviceSource?.model??null]));
  if(this.impactSignatures.get(projectId)!==impact){
   this.impactSignatures.set(projectId,impact);
   this.listener({kind:'managed-faults',projectId,changed:cache.faults.map(fault=>fault.faultRef)});
  }
  const successes=(state?.jobs??[]).filter(job=>job.status==='completed'&&job.promptStartedAt!=null&&job.completion==='provider-completed'&&job.type!=='maintenance'&&typeof job.finishedAt==='string'&&job.serviceSource?.provider);
  if(!successes.length)return;
  void this.mutate(projectId,record=>{
   let changed=false;
   for(const fault of record.faults){
    if(fault.state!=='active'||fault.category!=='service-transient'||fault.userCritical)continue;
    const verified=successes.some(job=>{
     const source=job.serviceSource;
     return source.provider===fault.source?.provider&&(!fault.source?.modelScope||source.model===fault.source.modelScope)&&accountKey(source.provider,fault.source.endpointOrigin,source.sourceRevision)===fault.source.accountConfigId&&job.finishedAt>=fault.lastAt;
    });
    if(verified){fault.state='released';fault.gate=false;fault.recovering=false;fault.releasedAt=now();fault.version++;changed=true;}
   }
   if(changed)record.revision++;
   return changed?{changed:true}:false;
  }).then(result=>{if(result){this.afterRelease();this.listener({kind:'managed-faults',changed:cache.faults.map(f=>f.faultRef),recovered:true});}}).catch(()=>this.markUnknown(projectId));
 }

 async recordNativeRetry(projectId,fact){
  if(!fact||!['auto_retry_start','auto_retry_end'].includes(fact.type)||typeof fact.jobId!=='string'||typeof fact.ownerId!=='string'||typeof fact.ownerGeneration!=='string'||!Number.isSafeInteger(fact.attempt)||fact.attempt<0)return;
  const identity=intentDigestOf([projectId,fact.jobId,fact.ownerId,fact.ownerGeneration,fact.type,fact.attempt]);
  return this.mutate(projectId,record=>{
   if(record.nativeRetries.some(row=>row.id===identity))return false;
   const row={id:identity,at:now(),jobId:fact.jobId,target:fact.target,type:fact.type,attempt:fact.attempt,phase:fact.type==='auto_retry_start'?'native-retry':'native-retry-finished'};
   if(Number.isSafeInteger(fact.maxAttempts)&&fact.maxAttempts>=0)row.maxAttempts=fact.maxAttempts;
   if(Number.isFinite(fact.delayMs)&&fact.delayMs>=0)row.delayMs=Math.min(fact.delayMs,3600000);
   if(typeof fact.success==='boolean')row.success=fact.success;
   record.nativeRetries.push(row);
   // Diagnostic retention only; never prune task/operation receipts.
   if(record.nativeRetries.length>128)record.nativeRetries.splice(0,record.nativeRetries.length-128);
   record.revision++;
   return {recorded:true};
  });
 }

 /**
  * Claim ONE due retry for a fault generation (durable, exactly-once): the
  * coordinator runs the Core resume executor and reports the outcome, which
  * is persisted here as accepted/refused-escalated — a late wake is never
  * silently discarded.
  */
 async claimRetry(projectId,faultRef,run){
  const claim=await this.mutate(projectId,record=>{
   const fault=record.faults.find(f=>f.faultRef===faultRef);
   if(!fault||fault.state!=='active'||!fault.gate||fault.userCritical||!Number.isFinite(fault.autoUntilMs)||fault.autoUntilMs>this.clock())return false;
   if(fault.retryClaim?.generation===fault.generation&&fault.retryClaim?.cycles===fault.backoffCycles)return false;
   const token=intentDigestOf([projectId,faultRef,fault.generation,fault.version,fault.backoffCycles]);
   const jobIds=fault.affected.filter(entry=>entry.generation===fault.generation&&!entry.admitted&&!entry.recordConfirmed).map(entry=>entry.jobId);
   fault.version++;
   fault.retryClaim={token,generation:fault.generation,cycles:fault.backoffCycles,version:fault.version,jobIds,state:'running',at:now()};
   fault.autoUntilMs=null;
   record.revision++;
   return structuredClone(fault.retryClaim);
  });
  if(!claim)return {claimed:false};
  let outcome;
  try{outcome={...(await run(claim.generation,claim.token)),state:'submitted'};}
  catch(error){outcome={state:'refused',reason:typeof error?.code==='string'?error.code:'recovery-unavailable'};}
  const settled=await this.mutate(projectId,record=>{
   const fault=record.faults.find(f=>f.faultRef===faultRef);
   if(!fault||fault.generation!==claim.generation||fault.version!==claim.version||fault.retryClaim?.token!==claim.token)return false;
   fault.retryClaim={...claim,...outcome,at:now()};
   if(outcome.state==='refused'){fault.userCritical=true;fault.gate=true;fault.version++;}
   // Admission is not recovery: unrelated jobs remain gated until native success.
   record.revision++;
   return {settled:outcome.state};
  });
  return {claimed:true,...outcome,obsolete:!settled};
 }

 async registeredProjects(){
  return (await this.storage.list()).filter(p=>!p.removed);
 }

 async status({projectId=null,cursor=null,limit=24}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_LIMIT)fail('FAULT_PAGE_INVALID','故障分页参数无效。');
  if(projectId!==null&&typeof projectId!=='string')fail('FAULT_PAGE_INVALID','故障范围无效。');
  let wrapper=null;
  if(cursor!==null&&cursor!==undefined){
   if(typeof cursor!=='string'||cursor.length>8192)fail('FAULT_CURSOR_STALE','故障状态游标无效，请刷新。');
   try{wrapper=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{fail('FAULT_CURSOR_STALE','故障状态游标无效，请刷新。');}
   if(wrapper.scope!==(projectId??'app'))fail('FAULT_CURSOR_STALE','故障范围已变化，请刷新。');
  }
  const projects=projectId?[...await this.registeredProjects()].filter(p=>p.id===projectId):await this.registeredProjects();
  if(projectId&&projects.length)await this.host.requireRegisteredProject(projectId);
  const members=[];
  for(const project of projects.slice(0,MAX_MEMBERS*4)){
   // A failed durable read must NOT look like "no faults": retain any prior
   // fail-closed cache and fail this read explicitly.
   let record,binding;
   try{record=(await this.read(project.id)).record;}
   catch(error){throw new HostError('FAULT_STATUS_UNAVAILABLE','项目 '+project.id+' 的故障记录暂不可读：'+error.message);}
   binding=await this.storage.getLocalRecord(project.id,'managed:binding').then(r=>r?.value??null).catch(()=>null);
   members.push({project,record,binding,connected:this.controllers?.get?.(project.id)!=null,lifecycleHeld:this.lifecycleHolds(project.id)===true});
   this.refreshGateCache(project.id,record);
  }
  const revision=createHash('sha256').update(JSON.stringify(members.map(m=>[m.project.id,m.project.instanceId,m.record.revision,m.connected,m.lifecycleHeld]))).digest('hex');
  if(wrapper&&wrapper.revision!==revision)fail('FAULT_CURSOR_STALE','故障状态已变化，请刷新。');
  const groups=new Map();
  for(const member of members){
   for(const fault of member.record.faults){
    let group=groups.get(fault.faultRef);
    if(!group)groups.set(fault.faultRef,group={faultRef:fault.faultRef,category:fault.category,source:fault.source,firstAt:fault.firstAt,lastAt:fault.lastAt,occurrenceCount:0,generation:0,state:'released',userCritical:false,projects:[]});
    group.occurrenceCount+=fault.occurrenceCount;
    group.generation=Math.max(group.generation,fault.generation);
    group.firstAt=group.firstAt<=fault.firstAt?group.firstAt:fault.firstAt;
    group.lastAt=fault.lastAt>=group.lastAt?group.lastAt:fault.lastAt;
    if(fault.state==='active')group.state='active';
    if(fault.userCritical)group.userCritical=true;
    group.projects.push({projectId:member.project.id,instanceId:member.project.instanceId,connection:member.connected?'live':'recorded',fault,enabled:member.binding?.enabled===true,lifecycleHeld:member.lifecycleHeld});
   }
  }
  const rows=[...groups.values()].filter(g=>g.state==='active').sort((a,b)=>(b.userCritical?1:0)-(a.userCritical?1:0)||String(b.lastAt).localeCompare(String(a.lastAt))||(a.faultRef<b.faultRef?-1:1)).map(group=>{
   const projects=group.projects.map(({projectId:id,instanceId,connection,fault,enabled,lifecycleHeld})=>{
    const affected=fault.state==='active'?this.snapshotAffected(id,fault):[];
    return {projectId:id,instanceId,connection,generation:fault.generation,version:fault.version,affectedCount:affected.length,
     blockedJobs:affected.slice(0,20).map(row=>row.jobId),
     blockedWorks:affected.filter(row=>row.target&&!['frontdesk','orchestrator'].includes(row.target)).slice(0,20).map(row=>({workId:row.target,jobId:row.jobId})),
     capability:{release:!enabled?'project-disconnected':lifecycleHeld?'project-disconnected':fault.state!=='active'?'stale':'eligible',reason:!enabled?'项目未启用托管':lifecycleHeld?'项目正在保留或关闭':fault.state!=='active'?'故障已解除':null}};
   });
   const scopeSnapshot=group.projects.filter(p=>p.fault.state==='active'&&p.enabled).map(p=>({projectId:p.projectId,instanceId:p.instanceId,faultRef:group.faultRef,generation:p.fault.generation,version:p.fault.version})).slice(0,MAX_MEMBERS);
   return {
    faultRef:group.faultRef,version:Math.max(...group.projects.map(p=>p.fault.version),0),generation:group.generation,
    occurrenceCount:group.occurrenceCount,firstAt:group.firstAt,lastAt:group.lastAt,
    category:group.category,userCritical:group.userCritical,state:group.state,
    title:CATEGORY_LABELS[group.category]??'外部服务故障',
    detail:CATEGORY_LABELS[group.category]+' · '+projects.length+'个项目 / '+projects.reduce((sum,project)=>sum+project.affectedCount,0)+'项输入',
    source:group.source,
    evidenceSummary:{httpStatus:group.projects.map(p=>p.fault.lastHttpStatus).find(s=>s!=null)??null,willRetry:group.projects.some(p=>p.fault.recovering===true),occurrences:group.projects.flatMap(p=>(p.fault.occurrences??[])).slice(0,5)},
    projects,
    release:{available:group.state==='active'&&scopeSnapshot.length>0,expectedVersion:Math.max(...scopeSnapshot.map(member=>member.version),0),scopeSnapshot,reason:group.state!=='active'?'故障已解除':scopeSnapshot.length?'':'当前没有可解除的已启用项目成员'},
   };
  });
  // Cursor comparison follows the row ORDER: criticality/time descending,
  // faultRef ascending. A row continues the page iff it sorts strictly
  // AFTER the cursor tuple in that order.
  const keyOf=row=>[row.userCritical?1:0,row.lastAt,row.faultRef];
  const cmp=(a,b)=>a[0]!==b[0]?b[0]-a[0]:a[1]!==b[1]?(a[1]<b[1]?1:-1):a[2]<b[2]?-1:a[2]>b[2]?1:0;
  const afterKey=Array.isArray(wrapper?.after)?wrapper.after:null;
  const filtered=afterKey?rows.filter(row=>cmp(keyOf(row),afterKey)>0):rows;
  const page=filtered.slice(0,limit);
  const next=filtered.length>limit?keyOf(page[page.length-1]):null;
  return {
   schema:1,scope:projectId??'app',revision,generatedAt:now(),
   freshness:{live:members.filter(m=>m.connected).map(m=>m.project.id)},
   faults:page,
   summary:{critical:rows.filter(r=>r.userCritical).length,projects:new Set(rows.flatMap(r=>r.projects.map(p=>p.projectId))).size,works:rows.reduce((sum,r)=>sum+r.projects.reduce((s,p)=>s+p.blockedWorks.length,0),0)},
   nextCursor:next?Buffer.from(JSON.stringify({scope:projectId??'app',revision,after:next})).toString('base64url'):null,
  };
 }

 snapshotAffected(projectId,fault){
  const entries=new Map((fault.affected??[]).map(row=>[row.jobId,structuredClone(row)]));
  const state=this.controllers?.get(projectId)?.store?.state;
  for(const job of state?.jobs??[]){
   if(job.status!=='queued'||job.type==='maintenance'||entries.has(job.id))continue;
   const source=this.jobSource(projectId,job);
   if(!source||source.provider!==fault.source?.provider||fault.source?.modelScope&&source.model!==fault.source.modelScope)continue;
   if(fault.source?.accountConfigId!==accountKey(source.provider,fault.source?.endpointOrigin,source.sourceRevision))continue;
   entries.set(job.id,{jobId:job.id,target:job.target,generation:fault.generation,admitted:false,recordConfirmed:false});
  }
  return [...entries.values()];
 }
 async release(payload={}){
  const {requestKey}=payload,intent=intentDigestOf(payload),prior=this.releases.get(requestKey);
  if(prior){if(prior.intent!==intent)fail('INVALID_PAYLOAD','解除键已绑定不同意图。');return prior.operation;}
  const operation=this.releaseOnce(structuredClone(payload));
  this.releases.set(requestKey,{intent,operation});
  try{return await operation;}finally{if(this.releases.get(requestKey)?.operation===operation)this.releases.delete(requestKey);}
 }
 async releaseOnce({faultRef,expectedVersion,scopeSnapshot,requestKey}={}){
  if(typeof faultRef!=='string'||!faultRef.startsWith('sf:')||faultRef.length>64)fail('INVALID_PAYLOAD','故障身份无效。');
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1)fail('INVALID_PAYLOAD','故障版本无效。');
  if(typeof requestKey!=='string'||!REQUEST_KEY.test(requestKey))fail('INVALID_PAYLOAD','故障解除键无效。');
  if(!Array.isArray(scopeSnapshot)||!scopeSnapshot.length||scopeSnapshot.length>MAX_MEMBERS||scopeSnapshot.some(m=>!m||typeof m.projectId!=='string'||typeof m.instanceId!=='string'||!m.instanceId||m.faultRef!==faultRef||!Number.isSafeInteger(m.generation)||m.generation<1||!Number.isSafeInteger(m.version)))fail('INVALID_PAYLOAD','故障解除范围无效。');
  const intent=intentDigestOf({faultRef,expectedVersion,scopeSnapshot});
  const projects=await this.registeredProjects();
  const memberRows=[];
  for(const project of projects){
   const [{record},binding]=await Promise.all([
    this.read(project.id),
    this.storage.getLocalRecord(project.id,'managed:binding').then(r=>r?.value??null).catch(()=>null),
   ]);
   const fault=record.faults.find(f=>f.faultRef===faultRef);
   if(fault)memberRows.push({project,record,fault,enabled:binding?.enabled===true});
  }
  if(!memberRows.length)fail('FAULT_VERSION_STALE','故障不存在或已解除，请刷新状态。');
  // Same key: resume from the merged authoritative durable checkpoints.
  for(const {record} of memberRows){
   const prior=record.batches.find(b=>b.requestKey===requestKey);
   if(prior){
    if(prior.intentDigest!==intent||prior.faultRef!==faultRef)fail('INVALID_PAYLOAD','解除键已绑定不同意图，拒绝重放。');
    return this.runBatch(this.mergeCheckpoints(prior,memberRows),memberRows);
   }
  }
  // Fresh flow: verify membership + instance + per-member generation/version
  // BEFORE any effect.
  const snapshotBy=new Map(scopeSnapshot.map(m=>[m.projectId,m]));
  for(const {project,fault} of memberRows){
   const expected=snapshotBy.get(project.id);
   if(fault.state==='active'&&!expected)continue;
   if(expected&&(!fault||fault.generation!==expected.generation||fault.version!==expected.version))fail('FAULT_VERSION_STALE','故障已更新（新代次或新发生），请刷新后重新解除。');
   if(expected&&expected.instanceId!==project.instanceId)fail('FAULT_SCOPE_STALE','故障成员项目实例已变化，请刷新后重新解除。');
  }
  const activeMembers=memberRows.filter(m=>m.fault.state==='active');
  const currentSnapshot=activeMembers.filter(m=>m.enabled).map(m=>({projectId:m.project.id,instanceId:m.project.instanceId,faultRef,generation:m.fault.generation,version:m.fault.version}));
  const wanted=JSON.stringify(scopeSnapshot.map(m=>[m.projectId,m.instanceId,m.generation,m.version]).sort());
  const current=JSON.stringify(currentSnapshot.map(m=>[m.projectId,m.instanceId,m.generation,m.version]).sort());
  if(wanted!==current)fail('FAULT_SCOPE_STALE','故障影响范围已变化，请刷新后重新解除。');
  if(Math.max(...scopeSnapshot.map(m=>m.version),0)!==expectedVersion)fail('FAULT_VERSION_STALE','故障版本已变化，请刷新后重新解除。');
  const batchRef='sfb:'+createHash('sha256').update(requestKey+intent).digest('hex').slice(0,32);
  const startedAt=now();
  // Each checkpoint persists its OWN member CAS (instance + generation +
  // version) and is re-verified immediately before that member's effect.
  const checkpoints=activeMembers.filter(member=>member.enabled).map(({project,fault})=>({projectId:project.id,instanceId:project.instanceId,faultRef,generation:fault.generation,version:fault.version,affected:this.snapshotAffected(project.id,fault),status:'pending',outcome:null,reason:null,workId:null,jobId:null,at:null}));
  const batch={batchRef,faultRef,requestKey,intentDigest:intent,startedAt,finishedAt:null,state:'running',checkpoints};
  for(const {project} of memberRows){
   await this.mutate(project.id,record=>{
    record.batches.push(structuredClone(batch));
    record.revision+=1;
    return {staged:true};
   });
  }
  return this.runBatch(batch,memberRows);
 }

 /**
  * Merge authoritative per-member checkpoints across every durable copy: a
  * member's own record holds its settled checkpoint; done always wins over
  * pending so a crash between member settlement and the final fan-out copy
  * can never re-execute a settled member.
  */
 mergeCheckpoints(prior,memberRows){
  const batch=structuredClone(prior);
  const authoritative=new Map(batch.checkpoints.map(c=>[c.projectId,c]));
  for(const {record} of memberRows){
   const copy=record.batches.find(b=>b.batchRef===batch.batchRef);
   if(!copy)continue;
   for(const checkpoint of copy.checkpoints??[]){
    const mine=authoritative.get(checkpoint.projectId);
    if(!mine)continue;
    if(({'pending':0,'executing':1,'done':2}[checkpoint.status]??-1)>({'pending':0,'executing':1,'done':2}[mine.status]??-1))authoritative.set(checkpoint.projectId,structuredClone(checkpoint));
   }
  }
  batch.checkpoints=[...authoritative.values()];
  return batch;
 }

 async runBatch(batch,memberRows){
  if(batch.state==='complete')return this.batchReceipt(batch);
  // Complete intent staging before effects, including recovery after a
  // previous member staging write failed.
  for(const {project} of memberRows)await this.mutate(project.id,record=>{
   if(record.batches.some(row=>row.batchRef===batch.batchRef))return false;
   record.batches.push(structuredClone(batch));record.revision++;return {staged:true};
  });
  const scopes={members:batch.checkpoints.map(checkpoint=>({projectId:checkpoint.projectId,generation:checkpoint.generation,version:checkpoint.version})),claims:new Map()};
  this.releaseScopes.set(batch.faultRef,scopes);
  try{
   for(const checkpoint of batch.checkpoints){
    if(checkpoint.status==='done')continue;
    const project=(await this.registeredProjects()).find(row=>row.id===checkpoint.projectId);
    const controller=this.controllers?.get(checkpoint.projectId);
    let outcome;
    if(checkpoint.status==='executing'){
     outcome={outcome:'needs-reconciliation',reason:'上次执行结果未落盘；未重复执行原输入。'};
    }else if(!project||project.instanceId!==checkpoint.instanceId){
     outcome={outcome:'stale',reason:'成员项目实例已变化；未执行。'};
    }else{
     const cleared=await this.mutate(checkpoint.projectId,record=>{
      const fault=record.faults.find(row=>row.faultRef===batch.faultRef);
      if(!fault||fault.state!=='active'||fault.generation!==checkpoint.generation||fault.version!==checkpoint.version)return false;
      const slot=record.batches.find(row=>row.batchRef===batch.batchRef)?.checkpoints.find(row=>row.projectId===checkpoint.projectId);
      if(!slot)fail('FAULT_BATCH_STALE','故障批次意图缺失，未执行。');
      slot.status='executing';
      fault.state='released';fault.gate=false;fault.recovering=false;fault.releasedAt=now();fault.version++;record.revision++;
      fault.releasedBy={batchRef:batch.batchRef,generation:checkpoint.generation,version:fault.version};
      return {fault:structuredClone(fault)};
     });
     if(!cleared)outcome={outcome:'stale',reason:'故障版本已变化；未执行。'};
     else if(!controller||controller.stopping)outcome={outcome:'project-disconnected',reason:'仅解除外部故障门；未连接项目或执行原输入。'};
     else{
      checkpoint.status='executing';
      cleared.fault.affected=checkpoint.affected??cleared.fault.affected;
      scopes.claims.set(checkpoint.projectId,{controller,jobIds:new Set(cleared.fault.affected.map(row=>row.jobId))});
      const assertCurrent=async()=>{
       const current=(await this.registeredProjects()).find(row=>row.id===checkpoint.projectId);
       if(current?.instanceId!==checkpoint.instanceId||this.controllers?.get(checkpoint.projectId)!==controller||controller.stopping)return false;
       const {record}=await this.read(checkpoint.projectId),fault=record.faults.find(row=>row.faultRef===batch.faultRef);
       return fault?.state==='released'&&fault.version===cleared.fault.version&&fault.generation===checkpoint.generation&&fault.releasedBy?.batchRef===batch.batchRef;
      };
      try{outcome=await assertCurrent()?await this.liveEvaluate(checkpoint.projectId,{batchRef:batch.batchRef,faultRef:batch.faultRef,generation:checkpoint.generation,fault:cleared.fault,assertCurrent}):{outcome:'stale',reason:'执行绑定已变化；未执行。'};}
      catch{outcome={outcome:'needs-reconciliation',reason:'执行结果待核对；未重复执行原输入。'};}
     }
    }
    Object.assign(checkpoint,{status:'done',outcome:outcome.outcome,reason:outcome.reason??null,workId:outcome.workId??null,jobId:outcome.jobId??null,detail:outcome.detail??null,at:now()});
    await this.mutate(checkpoint.projectId,record=>{
     const slot=record.batches.find(row=>row.batchRef===batch.batchRef)?.checkpoints.find(row=>row.projectId===checkpoint.projectId);
     if(!slot)fail('FAULT_BATCH_STALE','故障批次回执缺失，需核对。');
     Object.assign(slot,structuredClone(checkpoint));record.revision++;return {checkpointed:true};
    });
   }
   batch.state='complete';batch.finishedAt=now();
   for(const {project} of memberRows)await this.mutate(project.id,record=>{
    const target=record.batches.find(row=>row.batchRef===batch.batchRef);
    if(!target)fail('FAULT_BATCH_STALE','故障批次回执缺失，需核对。');
    Object.assign(target,structuredClone(batch));record.revision++;return {completed:true};
   });
  }finally{if(this.releaseScopes.get(batch.faultRef)===scopes)this.releaseScopes.delete(batch.faultRef);}
  this.afterRelease();
  this.listener({kind:'managed-faults',changed:[batch.faultRef],released:batch.batchRef});
  return this.batchReceipt(batch);
 }

 batchReceipt(batch){
  const results=batch.checkpoints.flatMap(c=>c.detail?.length?c.detail.map(row=>({...row,projectId:c.projectId,at:c.at})):[{projectId:c.projectId,outcome:c.outcome,reason:c.reason,...(c.workId?{workId:c.workId}:{}),...(c.jobId?{jobId:c.jobId}:{}),at:c.at}]);
  return {batchRef:batch.batchRef,faultRef:batch.faultRef,generation:Math.max(...batch.checkpoints.map(c=>c.generation??1),1),accepted:results.filter(r=>r.outcome==='accepted').length,waitingCapacity:results.filter(r=>r.outcome==='waiting-capacity').length,blocked:results.filter(r=>!['accepted','waiting-capacity'].includes(r.outcome)).length,results,state:batch.state,startedAt:batch.startedAt,finishedAt:batch.finishedAt};
 }

 async results({batchRef,cursor=null,limit=24}={}){
  if(typeof batchRef!=='string'||!batchRef.startsWith('sfb:')||batchRef.length>64)fail('INVALID_PAYLOAD','故障批次身份无效。');
  if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_LIMIT)fail('FAULT_PAGE_INVALID','故障分页参数无效。');
  let wrapper=null;
  if(cursor!==null&&cursor!==undefined){
   if(typeof cursor!=='string'||cursor.length>8192)fail('FAULT_CURSOR_STALE','批次游标无效，请刷新。');
   try{wrapper=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{fail('FAULT_CURSOR_STALE','批次游标无效，请刷新。');}
  }
  for(const project of await this.registeredProjects()){
   const {record}=await this.read(project.id).catch(()=>({record:emptyRecord()}));
   const batch=record.batches.find(b=>b.batchRef===batchRef);
   if(!batch)continue;
   const key=c=>c.projectId+(c.jobId??'');
   const rows=this.batchReceipt(batch).results.map(row=>({...row,instanceId:batch.checkpoints.find(checkpoint=>checkpoint.projectId===row.projectId)?.instanceId})).sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0);
   const after=wrapper?.after??null;
   const filtered=typeof after==='string'?rows.filter(row=>key(row)>after):rows;
   const page=filtered.slice(0,limit);
   const next=filtered.length>limit?key(page[page.length-1]):null;
   return {schema:1,batchRef,state:batch.state,faultRef:batch.faultRef,generation:batch.generation??null,revision:record.revision,rows:page,nextCursor:next?Buffer.from(JSON.stringify({batchRef,after:next})).toString('base64url'):null};
  }
  fail('FAULT_BATCH_NOT_FOUND','未找到该故障解除批次。');
 }
}
