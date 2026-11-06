import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';

const now=()=>new Date().toISOString();
const fail=code=>{throw Object.assign(Error(code),{code});};
const sourceFiles=['controller.mjs','context-reader.mjs','document-reader.mjs','pi-session.mjs','maintenance-ledger.mjs','workspace.mjs','debug-protocol.mjs'];
const digest=text=>createHash('sha256').update(text).digest('hex');
const clean=value=>value.replace(/(?:Bearer\s+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi,'[redacted]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
export const debugInstructions='系统内部 DEBUG 事件，不是用户业务任务。必须调用 nozeli_maintenance action=debug、debug.inspect 阅读宿主证据和只读源码，然后以 debug.report 提交 diagnosis/rootCause/fixPlan。status 或文字回答不算完成。报告仅为模型解释，不是已验证修复；不得自派新 Work、重放原 prompt/未知效果、改源码/安装程序、请求用户技术维修或绕过人工暂停/权限。报告保存后，若宿主返回 hostContinuation（已证明写入前拒绝的临时续行能力），必须在同一 attempt 主动调用 action=debug.continue 让原任务继续：verifiedFix 恒为 false，源码缺陷仍待修复，原请求不改写。仅模型/提供方不可用时保留停止事实。';
export const debugToolProperties={action:{type:'string',enum:['status','retry','scan','debug','debug.inspect','debug.report','debug.continue']},bugId:{type:'string'},attemptId:{type:'string'},sourceId:{type:'string'},startLine:{type:'integer',minimum:1},lineCount:{type:'integer',minimum:1,maximum:80},diagnosis:{type:'string',maxLength:1200},rootCause:{type:'string',maxLength:1200},fixPlan:{type:'string',maxLength:1200}};

// The debug ledger is interpretation/evidence only. It never changes repair
// verification, retries an original effect, or grants business authorization.
export class DebugProtocol{
 constructor(controller){this.host=controller;this.projection=Promise.resolve();this.continuationFlights=new Map();}
 async scope(job,bugId){
  const h=this.host,bug=(await h.maintenance.read()).bugs.find(b=>b.id===bugId&&b.projectId===h.projectId);
  if(!bug||job?.type!=='maintenance'||job.target!=='orchestrator'||job.context?.bugId!==bugId||h.current.get('orchestrator')?.id!==job.id||h.store.state.jobs.find(j=>j.id===job.id)?.status!=='running')fail('DEBUG_SCOPE_MISMATCH');
  const original=h.store.state.jobs.find(j=>j.id===bug.jobId),work=h.store.state.works.find(w=>w.id===bug.workId);
  if(bug.jobId&&(!original||(original.revision??null)!==bug.revision||original.status==='cancelled')||bug.workId&&(!work||work.revision!==bug.revision||bug.phase!=='closure'&&['closing','ended'].includes(work.status)))fail('DEBUG_BINDING_STALE');
  if(bug.status==='repaired'||['cancelled','human-boundary'].includes(bug.status))fail('DEBUG_BINDING_STALE');
  return {bug,original,binding:h.maintenanceBinding(bug)};
 }
 async update(bugId,fn,job=null){
  // Ledger commit is authoritative; projection can fail independently and is
  // recoverable through an identical request or cold reconciliation.
  const debug=await this.host.maintenance.mutate(state=>{const bug=state.bugs.find(b=>b.id===bugId&&b.projectId===this.host.projectId);if(!bug)fail('DEBUG_SCOPE_MISMATCH');
   if(job){const h=this.host,original=h.store.state.jobs.find(j=>j.id===bug.jobId),work=h.store.state.works.find(w=>w.id===bug.workId);if(h.current.get('orchestrator')?.id!==job.id||job.context?.bugId!==bugId||h.store.state.jobs.find(j=>j.id===job.id)?.status!=='running')fail('DEBUG_SCOPE_MISMATCH');if(bug.jobId&&(!original||(original.revision??null)!==bug.revision||original.status==='cancelled')||bug.workId&&(!work||work.revision!==bug.revision||bug.phase!=='closure'&&['closing','ended'].includes(work.status)))fail('DEBUG_BINDING_STALE');}
   fn(bug);return bug.debug;
  });
  await this.reconcile(bugId);
  return debug;
 }
 reconcile(bugId=null){
  const flight=this.projection.catch(()=>{}).then(async()=>{
   // Cold/interrupted temporary continuation: the durable business receipt on
   // the original intake routing is the only authority. Any bug still holding
   // a committed receipt (continuing or awaiting-fix) settles to the terminal
   // fact; an in-flight marker without a receipt falls back to the saved
   // diagnosis. Reconcile never dispatches or replays.
   if(bugId===null)for(const bug of (await this.host.maintenance.read()).bugs){
    if(bug.projectId!==this.host.projectId||!['continuing','awaiting-fix'].includes(bug.debug?.state))continue;
    await this.host.maintenance.mutate(state=>{const b=state.bugs.find(x=>x.id===bug.id);if(!b||!['continuing','awaiting-fix'].includes(b.debug?.state))return;
     const receipt=this.host.durableContinuationReceipt(b);
     if(receipt){b.debug.state='continued-with-known-fault';b.debug.continuation=receipt;b.debug.sourceRepairRequired=true;}
     else if(b.debug.state==='continuing'){b.debug.state='awaiting-fix';b.debug.stoppedAt=now();b.debug.continuationInterruptedAt=now();}
    });
   }
   const state=await this.host.maintenance.read();let projected=0;
   await this.host.store.mutate(()=>{for(const bug of state.bugs){
    if(bug.projectId!==this.host.projectId||bugId!==null&&bug.id!==bugId||!bug.debug)continue;
    const original=this.host.store.state.jobs.find(j=>j.id===bug.jobId),work=this.host.store.state.works.find(w=>w.id===bug.workId),event=this.host.store.state.jobs.find(j=>j.id===bug.debug.eventJobId&&j.type==='maintenance'&&j.context?.bugId===bug.id);
    if(!event||bug.jobId&&(!original||(original.revision??null)!==bug.revision)||bug.workId&&(!work||work.revision!==bug.revision))continue;
    const fields={debugState:bug.debug.state,debugEventJobId:bug.debug.eventJobId,debugAttemptId:bug.debug.attemptId??null};
    Object.assign(event,fields);if(original?.maintenanceBugId===bug.id)Object.assign(original,fields);
    if(work?.maintenance?.bugId===bug.id)work.maintenance.debugState=bug.debug.state;
    projected++;
   }});
   return {projected,modelReplayed:false};
  });this.projection=flight;return flight;
 }
 async queued(bugId,eventJobId){return this.update(bugId,bug=>{
  if(bug.debug?.eventJobId===eventJobId)return;
  if(bug.debug&&(bug.debug.report||!['pending','model-unavailable'].includes(bug.debug.state)))fail('DEBUG_EVENT_NOT_REACTIVATABLE');
  const old=bug.debug,previousAttempt=old?{eventJobId:old.eventJobId,attemptId:old.attemptId??null,state:old.state}:null;
  bug.debug={schema:1,state:'queued',eventJobId,queuedAt:now(),...(previousAttempt?{previousAttempt}:{})};
 });}
 async sources(){return Promise.all(sourceFiles.map(async(name,index)=>{const text=await fs.readFile(new URL(name,import.meta.url),'utf8');return {sourceId:'source:'+index,path:'src/agents/managed/'+name,lineCount:text.split('\n').length,digest:digest(text)};}));}
 async action(job,args){
  const {bug,original,binding}=await this.scope(job,args.bugId);
  if(args.action==='debug'){
   const sources=await this.sources(),capability=await this.host.debugContinuationCapability(bug);
   const debug=await this.update(bug.id,b=>{if(b.debug?.eventJobId===job.id&&b.debug.attemptId)return;const previousAttempt=b.debug?.previousAttempt;b.debug={schema:1,state:'running',eventJobId:job.id,attemptId:randomUUID(),binding,startedAt:now(),...(previousAttempt?{previousAttempt}:{}),evidence:{error:structuredClone(b.error),originalJob:original?{id:original.id,type:original.type,target:original.target,revision:original.revision??null,status:original.status,errorCode:original.errorCode??null,hostToolCode:original.hostToolCode??null,failureOrigin:original.failureOrigin??null}:null,continuationCapability:capability?{kind:capability.kind,name:capability.name??null,intent:capability.intent}:null,sources},inspections:[]};},job);
   return {binding,attemptId:debug.attemptId,evidence:debug.evidence,hostContinuation:capability,debug,readOnly:true,continueTurn:true};
  }
  const d=bug.debug;
  if(!d?.attemptId||d.eventJobId!==job.id||args.attemptId!==d.attemptId||JSON.stringify(d.binding)!==JSON.stringify(binding))fail('DEBUG_ATTEMPT_STALE');
  if(args.action==='debug.inspect'){
   const source=d.evidence.sources.find(s=>s.sourceId===args.sourceId);if(!source)fail('DEBUG_SOURCE_INVALID');
   const start=args.startLine??1,count=args.lineCount??60;if(!Number.isInteger(start)||start<1||!Number.isInteger(count)||count<1||count>80)fail('DEBUG_SOURCE_INVALID');
   const text=await fs.readFile(new URL(sourceFiles[Number(source.sourceId.slice(7))],import.meta.url),'utf8');if(digest(text)!==source.digest)fail('DEBUG_BINDING_STALE');
   const lines=text.split('\n');if(start>lines.length)fail('DEBUG_SOURCE_INVALID');
   const page=[];let bytes=0;for(const line of lines.slice(start-1,start-1+count)){const size=Buffer.byteLength(line+'\n');if(bytes+size>12288)break;page.push(line);bytes+=size;}if(!page.length)fail('DEBUG_SOURCE_INVALID');
   const receipt={sourceId:source.sourceId,digest:source.digest,startLine:start,endLine:start+page.length-1};
   await this.update(bug.id,b=>{if(b.debug.attemptId!==d.attemptId)fail('DEBUG_ATTEMPT_STALE');if(!b.debug.inspections.some(r=>JSON.stringify(r)===JSON.stringify(receipt))){if(b.debug.inspections.length>=32)fail('DEBUG_SOURCE_INVALID');b.debug.inspections.push(receipt);}},job);
   return {ok:true,value:{...receipt,path:source.path,text:page.join('\n')},readOnly:true,continueTurn:true};
  }
  if(args.action==='debug.report'){
   const report={};for(const key of ['diagnosis','rootCause','fixPlan']){const value=args[key];if(typeof value!=='string'||!value.trim()||value.length>1200)fail('DEBUG_REPORT_INVALID');report[key]=clean(value.trim());}
   const debug=await this.update(bug.id,b=>{
    const current=b.debug;
    if(current.attemptId!==d.attemptId||current.eventJobId!==job.id||JSON.stringify(current.binding)!==JSON.stringify(binding))fail('DEBUG_ATTEMPT_STALE');
    if(!current.inspections?.length)fail('DEBUG_INSPECTION_REQUIRED');
    if(current.report){if(['diagnosis','rootCause','fixPlan'].some(k=>current.report[k]!==report[k]))fail('DEBUG_REPORT_INVALID');return;}
    current.state='awaiting-fix';current.report={version:1,kind:'model-interpretation',verifiedFix:false,attemptId:d.attemptId,binding,...report,at:now()};
   },job);
   return {debug,report:debug.report,verifiedFix:false,workResumed:false,hostContinuation:await this.host.debugContinuationCapability(bug),continueTurn:true};
  }
  if(args.action==='debug.continue')return await this.#continue(job,bug);
  fail('DEBUG_REPORT_INVALID');
 }
 // Host-verified temporary runtime continuation: only capabilities the host
 // proved at the rejection site to be pre-effect rejections are admissible
 // (never inferred from generic error text). The durable business receipt on
 // the original intake routing is the single authority for repeats,
 // concurrency and cold restart — it is only ever read back, never re-run.
 async #continue(job,bug){
  if(!bug.debug.report||!bug.debug.inspections?.length)fail('DEBUG_CONTINUE_REPORT_REQUIRED');
  const prior=this.continuationFlights.get(bug.id)??Promise.resolve();
  const run=prior.catch(()=>{}).then(()=>this.#continueOnce(job,bug));
  this.continuationFlights.set(bug.id,run);
  try{return await run;}finally{if(this.continuationFlights.get(bug.id)===run)this.continuationFlights.delete(bug.id);}
 }
 async #continueOnce(job,bug){
  const committed=this.host.durableContinuationReceipt(bug);
  if(committed){
   if(!['awaiting-fix','continuing','continued-with-known-fault'].includes(bug.debug.state))fail('DEBUG_CONTINUE_STALE');
   const settled=await this.#settleContinued(bug,committed,job);
   return {ok:true,...committed,duplicate:true,debugState:settled?'continued-with-known-fault':'continuing',...(settled?{}:{projectionPending:true}),verifiedFix:false,sourceRepairRequired:true,continueTurn:true};
  }
  if(bug.debug.state==='continuing')fail('DEBUG_CONTINUE_STALE');
  const capability=await this.host.debugContinuationCapability(bug);
  if(!capability){
   const blocked=b=>{if(b.debug.state==='awaiting-fix')b.debug.lastContinueBlocked={code:'DEBUG_CONTINUE_UNAVAILABLE',at:now()};};
   try{await this.update(bug.id,blocked,job);}catch{/* blocked evidence is best-effort; the fence itself already held */}
   fail('DEBUG_CONTINUE_UNAVAILABLE');
  }
  await this.update(bug.id,b=>{if(b.debug.state!=='awaiting-fix')fail('DEBUG_CONTINUE_STALE');b.debug.state='continuing';b.debug.continuationStarted={attemptId:b.debug.attemptId,at:now()};},job);
  let receipt;
  try{receipt=await this.host.debugContinuation(bug.id,bug.debug.attemptId,capability);}
  catch(error){
   // Ledger rollback must run against the ledger's live bug (b), never the
   // detached scope snapshot: without a durable receipt no continuation
   // happened, so the saved diagnosis state is restored.
   const revert=b=>{if(b.debug.state==='continuing'){b.debug.state='awaiting-fix';b.debug.lastContinueBlocked={code:String(error?.code??'INTERNAL_FAILURE'),at:now()};}};
   try{await this.update(bug.id,revert,job);}catch{/* stopped()/reconcile repair an interrupted in-flight marker */}
   try{await this.update(bug.id,revert);}catch{/* bounded evidence only */}
   throw error;
  }
  const settled=await this.#settleContinued(bug,receipt,job);
  // The durable business receipt is committed and authoritative. If both
  // ledger settles failed, report the truth (still continuing, projection
  // pending) instead of fabricating a terminal debug state; stopped() and
  // cold reconcile settle from the same receipt.
  return {ok:true,...receipt,duplicate:false,debugState:settled?'continued-with-known-fault':'continuing',...(settled?{}:{projectionPending:true}),verifiedFix:false,sourceRepairRequired:true,continueTurn:true};
 }
 #continuationCommit(receipt){return b=>{if(b.debug.state==='continued-with-known-fault')return true;if(!['continuing','awaiting-fix'].includes(b.debug.state))fail('DEBUG_CONTINUE_STALE');b.debug.state='continued-with-known-fault';b.debug.continuation=structuredClone(receipt);b.debug.sourceRepairRequired=true;return true;};}
 async #settleContinued(bug,receipt,job){
  const commit=this.#continuationCommit(receipt);
  try{await this.update(bug.id,commit,job);return true;}
  catch(error){
   if(!job)return false;
   try{await this.update(bug.id,commit);return true;}catch{/* receipt stays authoritative; cold reconcile repairs the ledger */return false;}
  }
 }
 async completed(job){const bug=(await this.host.maintenance.read()).bugs.find(b=>b.id===job.context?.bugId&&b.projectId===this.host.projectId);if(bug?.status==='repaired')return true;try{await this.scope(job,bug?.id);}catch{return false;}return bug?.debug?.eventJobId===job.id&&['awaiting-fix','continued-with-known-fault'].includes(bug.debug.state)&&!!bug.debug.report&&bug.debug.inspections?.length>0;}
 async stopped(job,{modelUnavailable=false}={}){
  if(!job.context?.bugId)return;
  await this.update(job.context.bugId,b=>{
   b.debug??={schema:1,eventJobId:job.id};
   if(b.debug.eventJobId!==job.id)return;
   if(b.debug.state==='continuing'){
    // The turn stopped mid-continuation: settle strictly from the durable
    // business receipt; without a receipt no continuation happened.
    const receipt=this.host.durableContinuationReceipt(b);
    if(receipt){b.debug.state='continued-with-known-fault';b.debug.continuation=receipt;b.debug.sourceRepairRequired=true;}
    else{b.debug.state='awaiting-fix';b.debug.stoppedAt=now();b.debug.continuationInterruptedAt=now();}
    return;
   }
   // continued-with-known-fault is terminal: a later provider failure on the
   // same event never downgrades a committed continuation receipt.
   if(!['awaiting-fix','continued-with-known-fault'].includes(b.debug.state)){b.debug.state=modelUnavailable?'model-unavailable':'pending';b.debug.stoppedAt=now();}
  });
 }
}
