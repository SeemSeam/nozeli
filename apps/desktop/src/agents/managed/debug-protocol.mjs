import fs from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';

const now=()=>new Date().toISOString();
const fail=code=>{throw Object.assign(Error(code),{code});};
const sourceFiles=['controller.mjs','context-reader.mjs','document-reader.mjs','pi-session.mjs','maintenance-ledger.mjs','debug-protocol.mjs'];
const digest=text=>createHash('sha256').update(text).digest('hex');
const clean=value=>value.replace(/(?:Bearer\s+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi,'[redacted]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
export const debugInstructions='系统内部 DEBUG 事件，不是用户业务任务。必须调用 nozeli_maintenance action=debug、debug.inspect 阅读宿主证据和只读源码，然后以 debug.report 提交 diagnosis/rootCause/fixPlan。status 或文字回答不算完成。报告仅为模型解释，不是已验证修复；不得派新 Work、重放原 prompt/未知效果、改源码、请求用户技术维修或绕过人工暂停/权限。仅模型/提供方不可用时保留停止事实。';
export const debugToolProperties={action:{type:'string',enum:['status','retry','scan','debug','debug.inspect','debug.report']},bugId:{type:'string'},attemptId:{type:'string'},sourceId:{type:'string'},startLine:{type:'integer',minimum:1},lineCount:{type:'integer',minimum:1,maximum:80},diagnosis:{type:'string',maxLength:1200},rootCause:{type:'string',maxLength:1200},fixPlan:{type:'string',maxLength:1200}};

// The debug ledger is interpretation/evidence only. It never changes repair
// verification, retries an original effect, or grants business authorization.
export class DebugProtocol{
 constructor(controller){this.host=controller;this.projection=Promise.resolve();}
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
   const sources=await this.sources();
   const debug=await this.update(bug.id,b=>{if(b.debug?.eventJobId===job.id&&b.debug.attemptId)return;const previousAttempt=b.debug?.previousAttempt;b.debug={schema:1,state:'running',eventJobId:job.id,attemptId:randomUUID(),binding,startedAt:now(),...(previousAttempt?{previousAttempt}:{}),evidence:{error:structuredClone(b.error),originalJob:original?{id:original.id,type:original.type,target:original.target,revision:original.revision??null,status:original.status,errorCode:original.errorCode??null,hostToolCode:original.hostToolCode??null,failureOrigin:original.failureOrigin??null}:null,sources},inspections:[]};},job);
   return {binding,attemptId:debug.attemptId,evidence:debug.evidence,debug,readOnly:true,continueTurn:true};
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
   return {debug,report:debug.report,verifiedFix:false,workResumed:false,continueTurn:true};
  }
  fail('DEBUG_REPORT_INVALID');
 }
 async completed(job){const bug=(await this.host.maintenance.read()).bugs.find(b=>b.id===job.context?.bugId&&b.projectId===this.host.projectId);if(bug?.status==='repaired')return true;try{await this.scope(job,bug?.id);}catch{return false;}return bug?.debug?.eventJobId===job.id&&bug.debug.state==='awaiting-fix'&&!!bug.debug.report&&bug.debug.inspections?.length>0;}
 async stopped(job,{modelUnavailable=false}={}){if(!job.context?.bugId)return;await this.update(job.context.bugId,b=>{b.debug??={schema:1,eventJobId:job.id};if(b.debug.eventJobId===job.id&&b.debug.state!=='awaiting-fix'){b.debug.state=modelUnavailable?'model-unavailable':'pending';b.debug.stoppedAt=now();}});}
}
