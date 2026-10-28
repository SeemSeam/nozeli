import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processStamp, ownerAlive } from './process-ownership.mjs';
import {artifactSnapshot,digest} from './report-review.mjs';
import {reconcileTodos} from '../../domain/todo-management.mjs';
import {mergeConsentRequirement,sameMergeConsentBinding,mergeConsentBindingFields,explicitNeverCommitStatement,mergeConstraintChoices} from '../../domain/work-disposition.mjs';
import {safeBytes} from './execution-workspace.mjs';
import {recordBusinessTimeline} from './session-index.mjs';
import {prepareHtmlReport,HTML_REPORT_OBJECT_MAX_BYTES} from './html-report.mjs';
import {decodeReportState,reportDescriptor,reportExtension,readStoredReport,MAX_REPORT_BYTES} from './report-descriptor.mjs';
import {readManagedState,saveManagedState,readManagedObject,listManagedPending,reconcileManagedPending,retainManagedNativeProjection} from './managed-storage.mjs';
export async function atomicJson(file,value){
  const tmp=`${file}.${randomUUID()}.tmp`;const handle=await fs.open(tmp,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
  try{await fs.rename(tmp,file);}catch(error){await fs.rm(tmp,{force:true});throw error;}
}
const inside=(a,b)=>a===b || (!path.relative(a,b).startsWith(`..${path.sep}`) && path.relative(a,b)!=='..' && !path.isAbsolute(path.relative(a,b)));
function mergeAuthorizationRecord(w,reviewVersion){
  const requirement=mergeConsentRequirement(w);
  return {schema:1,workId:w.id,revision:w.revision,objectId:w.result?.objectId??null,candidateCommit:w.execution?.candidate?.commit??null,reviewVersion:reviewVersion??null,repo:w.execution?.repo??null,commonDir:w.execution?.commonDir??null,targetRef:w.execution?.targetRef??null,targetHead:w.execution?.targetHead??null,basis:'user-accept',consentRequired:requirement.required,consentOrigin:requirement.required?requirement.origin:null,at:new Date().toISOString()};
}
export class Workspace {
  static async open(runtimeRoot,contentRoot,{recoverStale=false,checkpoint=async()=>{},storage,projectId,offline=false}={}){
    if(!storage||!projectId)throw Error('Project storage binding required');
    const project=await storage.requireRegistered(projectId);
    await fs.mkdir(runtimeRoot,{recursive:true,mode:0o700});
    const runtime=await fs.realpath(runtimeRoot),content=project.root;
    if(inside(runtime,content)||inside(content,runtime))throw new Error('runtime and content roots overlap');
    const lock=path.join(runtime,'host.lock');let handle;
    try{handle=await fs.open(lock,'wx',0o600);}catch(error){
      if(error.code!=='EEXIST')throw error;
      if(!recoverStale)throw new Error('workspace owned or stale lock requires recovery');
      const gate=path.join(runtime,'recovery.lock');const guard=await fs.open(gate,'wx',0o600);
      try{const before=await fs.readFile(lock,'utf8');const old=JSON.parse(before);if(await ownerAlive(old))throw new Error('workspace owned by live host');if(await fs.readFile(lock,'utf8')!==before)throw new Error('workspace owner changed');await fs.unlink(lock);handle=await fs.open(lock,'wx',0o600);}
      finally{await guard.close();await fs.unlink(gate);}
    }
    const owner=JSON.stringify({pid:process.pid,hostId:randomUUID(),stamp:await processStamp(process.pid)});
    await handle.writeFile(owner);await handle.close();
    const store=new Workspace(runtime,content,lock,owner);Object.assign(store,{checkpoint,storage,projectId,offline,operationId:randomUUID(),objectRoot:path.join(project.metadataRoot,'objects','sha256')});
    try{
      store.state=decodeReportState(await readManagedState(storage,projectId,{offline,onCollections:collections=>{store.committedCollections=collections;}}));
      for(const dir of ['agents','evidence'])await fs.mkdir(path.join(runtime,dir),{recursive:true,mode:0o700});
      store.plan=path.join(project.metadataRoot,'memory','plantree','index.md');
      if(!offline){await storage.requireOnline(projectId);await fs.mkdir(path.dirname(store.plan),{recursive:true,mode:0o700});await fs.writeFile(store.plan,'# Plan Tree\n\nProject semantic memory.\n',{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e;});}
      return store;
    }catch(error){await store.close();throw error;}
  }
  constructor(root,content,lock,owner){Object.assign(this,{root,content,lock,owner});this.serial=Promise.resolve();this.draftSerial=Promise.resolve();this.draftVersions=new Map();}
  save(options){
    // A queued mutation or native exit callback may predate stop's ALS scope.
    // Only this managed store receives the actual, still-current hold object.
    return this.lifecycleHold?this.storage.withLifecycleOwner(this.projectId,this.lifecycleHold,()=>saveManagedState(this,options)):saveManagedState(this,options);
  }
  persistNativeFacts(){
    const jobs=(this.state.jobs??[]).map(job=>({id:job.id,target:job.target,local:Object.fromEntries(['collabAttempts','manualPromptId','sessionFile','transport'].filter(key=>job[key]!==undefined).map(key=>[key,job[key]]))}));
    return this.storage.putRecovery(this.projectId,'managed:native-facts',structuredClone({schema:1,projectId:this.projectId,sessionIndex:this.state.sessionIndex,jobs,messages:this.state.sessionIndex?.portableMessages??[]}));
  }
  async mutateNative(fn){
    if(this.closed||this.closing)throw Error('workspace closed');
    const run=this.serial.then(async()=>{
      if(this.closed)throw Error('workspace closed');
      if(this.nativeCommitUnknown)throw Object.assign(Error('Native journal commit outcome requires explicit recovery'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:this.nativeCommitUnknown});
      const prior=structuredClone(this.state);
      try{
        const result=await fn();recordBusinessTimeline(prior,this.state);
        await retainManagedNativeProjection(this,(this.state.sessionIndex?.portableMessages??[]).filter(row=>!(prior.sessionIndex?.portableMessages??[]).some(old=>old.id===row.id)));
        // Native receipt ACKs depend only on this instance's recovery WAL, never on the removable project ledger.
        await this.persistNativeFacts();return result;
      }catch(error){
        if(error.code==='STORAGE_RESULT_UNKNOWN'||error.commitUnknown){this.nativeCommitUnknown=error.commitUnknown??{projectId:this.projectId,nativeFacts:true};this.commitUnknown=this.nativeCommitUnknown;error.commitUnknown=this.nativeCommitUnknown;throw error;}
        const drafts=this.state.drafts;this.state=prior;if(drafts!==undefined)this.state.drafts=drafts;throw error;
      }
    });
    this.serial=run.catch(()=>{});return run;
  }
  persistDrafts(){
    const run=this.draftSerial.catch(()=>{}).then(()=>this.storage.putRecovery(this.projectId,'managed:drafts',structuredClone(this.state.drafts??{})));
    this.draftSerial=run;return run;
  }
  setDraft(target,value){
    this.state.drafts??={};this.state.drafts[target]=value;this.draftVersions.set(target,(this.draftVersions.get(target)??0)+1);return this.persistDrafts();
  }
  confirmDrafts(intents){
    const run=this.draftSerial.catch(()=>{}).then(async()=>{
      const drafts=structuredClone(this.state.drafts??{}),confirmed=[];
      for(const intent of intents)if((this.draftVersions.get(intent.target)??0)===intent.version&&drafts[intent.target]===intent.value){drafts[intent.target]='';confirmed.push(intent);}
      if(!confirmed.length)return;
      await this.storage.putRecovery(this.projectId,'managed:drafts',drafts);
      for(const intent of confirmed)if((this.draftVersions.get(intent.target)??0)===intent.version&&this.state.drafts?.[intent.target]===intent.value)this.state.drafts[intent.target]='';
    });
    this.draftSerial=run;return run;
  }
  listPending(){return listManagedPending(this.storage,this.projectId);}
  reconcilePending(options){return reconcileManagedPending(this.storage,this.projectId,options);}
  async putObject(bytes){
    bytes=Buffer.from(bytes);const {digest:objectDigest}=await this.storage.putRecoveryObject(this.projectId,bytes);
    await this.storage.putRecovery(this.projectId,'managed:recovery-object:'+objectDigest,{digest:objectDigest,byteLength:bytes.length,operationId:this.operationId});
    try{return (await this.storage.putObject(this.projectId,bytes)).digest;}catch(error){this.offline=true;await this.storage.putRecovery(this.projectId,'managed:object-pending:'+objectDigest,{operationId:this.operationId,digest:objectDigest,status:'pending',error:{code:error.code,message:error.message}});return objectDigest;}
  }
  async readObject(digest){return readManagedObject(this.storage,this.projectId,digest);}
  async requireOnline(){if(this.commitUnknown)throw Object.assign(Error('Workspace commit outcome requires explicit reconciliation'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:this.commitUnknown});await this.storage.requireOnline(this.projectId);this.offline=false;}
  async close(){if(this.closed)return;this.closing=true;await this.serial;await this.draftSerial;if(await fs.readFile(this.lock,'utf8')!==this.owner)throw new Error('workspace owner changed');await fs.unlink(this.lock);this.closed=true;}
  used(){return this.state.works.filter(w=>w.status!=='queued'&&w.status!=='ended'&&w.revision>0).length;}
  find(id){const w=this.state.works.find(w=>w.id===id);if(!w)throw new Error('unknown work');return w;}
  deviationHeld(id){const w=this.find(id);return ['pending','replanned'].includes(w.deviation?.status);}
  async reportDeviation(id,job,{changedGoal,reason,progress},receipt){return this.mutate(async tx=>{
    const w=this.find(id),old=this.state.receipts.find(r=>r.id===receipt);
    if(old){if(old.workId!==id||old.sourceJobId!==job.id||old.deviation?.changedGoal!==changedGoal||old.deviation?.reason!==reason||old.deviation?.progress!==progress)throw Error('deviation receipt collision');return structuredClone(old.deviation);}
    if(w.status!=='running'||w.revision!==job.revision||this.deviationHeld(id))throw Error('stale or inactive deviation source');
    for(const value of [changedGoal,reason,progress])if(typeof value!=='string'||!value.trim()||value.length>32000)throw Error('invalid deviation report');
    const sourceJob=this.state.jobs.find(j=>j.id===job.context?.sourceJobId)||this.state.jobs.find(j=>j.id===job.id);
    if(!sourceJob)throw Error('missing admitted deviation source');
    const sourceText=job.context?.approvedSourceText??sourceJob.text,at=new Date().toISOString(),objectId=randomUUID(),todoId=randomUUID();
    const event={id:randomUUID(),revision:w.revision,version:1,status:'pending',changedGoal,reason,progress,admittedJobId:job.id,sourceJobId:sourceJob.id,sourceText,source:`state.json#job:${sourceJob.id}`,sourceContext:structuredClone(sourceJob.context||{}),todoId,objectId,at};
    // 宿主偏离问题与 Worker problem 同为轻量 Markdown；来源身份保留在 event/收据字段，不依赖正文格式。
    const body='# 任务偏离：等待用户决定\n\n'+[['原始任务',w.request],['触发输入（尚未执行）',sourceText],['拟改变的目标',changedGoal],['偏离原因',reason],['已有进展与未执行部分',progress]].map(([title,value])=>'## '+title+'\n\n'+value+'\n').join('\n')+'\n工作已暂停；只有用户明确决定后才处理。\n';
    await this.putObject(Buffer.from(body));
    if(w.deviation){w.deviationHistory??=[];w.deviationHistory.push(structuredClone(w.deviation));}
    w.deviation=event;w.status='paused';w.problem={objectId,revision:w.revision};
    const report=reportDescriptor(Buffer.from(body),{format:'markdown',objectId,title:'任务偏离：等待用户决定'});
    const row={id:receipt,workId:id,revision:w.revision,kind:'problem',report,objectId,sourceJobId:job.id,deviation:structuredClone(event),at};this.state.receipts.push(row);this.projectReceipt(row,{jobId:job.id});
    this.state.todos.push({id:todoId,workId:id,revision:w.revision,kind:'deviation',status:'open',sourceJobId:sourceJob.id,objectId,deviationId:event.id,expectedVersion:1,text:report.excerpt});
    return structuredClone(event);
  });}
  // Serialize business mutations; immutable objects remain retained when a commit fails.
  async mutate(fn){
    if(this.closed||this.closing)throw new Error('workspace closed');
    if(this.commitUnknown)throw Object.assign(Error('Workspace commit outcome requires explicit reconciliation'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:this.commitUnknown});
    const run=this.serial.then(async()=>{
      if(this.closed)throw new Error('workspace closed');
      if(this.commitUnknown)throw Object.assign(Error('Workspace commit outcome requires explicit reconciliation'),{code:'STORAGE_RESULT_UNKNOWN',commitUnknown:this.commitUnknown});
      const prior=structuredClone(this.state);
      const rollback=[],draftIntents=[];
      const tx={onRollback:async hook=>{if(typeof hook!=='function')throw new Error('rollback hook must be a function');rollback.push(hook);},consumeDraft:(target,value)=>{
        if(this.state.drafts?.[target]===value)draftIntents.push({target,value,version:this.draftVersions.get(target)??0});
      }};
      try{
        const result=await fn(tx);
        reconcileTodos(this.state,prior);recordBusinessTimeline(prior,this.state);
        await this.save({draftIntents});
        return result;
      }catch(error){
        if(error.code==='STORAGE_RESULT_UNKNOWN'||error.commitUnknown){
          this.commitUnknown=error.commitUnknown??{projectId:this.projectId,pendingId:error.pendingId};
          error.commitUnknown=this.commitUnknown;this.offline=true;
          // The project may already reference retained Git candidates and objects. Never compensate an unknown commit.
          throw error;
        }
        const tentative=this.state,drafts=this.state.drafts;this.state=prior;if(drafts!==undefined)this.state.drafts=drafts;
        let held=null;const failures=[];
        for(const hook of rollback){
          let outcome;try{outcome=await hook(error);}catch(failure){failures.push(failure);if(failure.code==='STORAGE_RESULT_UNKNOWN'||failure.commitUnknown){held=failure.commitUnknown??{projectId:this.projectId};break;}continue;}
          if(outcome?.commitUnknown){held??=outcome.commitUnknown;break;}
        }
        if(held){const latestDrafts=this.state.drafts;this.state=tentative;if(latestDrafts!==undefined)this.state.drafts=latestDrafts;if(failures.length)error.rollbackFailures=failures;error.commitUnknown=held;this.commitUnknown=held;this.offline=true;throw error;}
        if(failures.length)error.rollbackFailures=failures;
        throw error;
      }
    });
    this.serial=run.catch(()=>{});return run;
  }
  submit(request,brief,options={}){return this.mutate(()=>this.submitState(request,brief,options));}
  submitState(request,brief,{name,sourceJob}={}){
    if(!request?.trim()||!brief?.trim())throw new Error('task requires original request and brief');
    const previous=sourceJob&&this.state.works.find(w=>w.sourceJob===sourceJob);if(previous)return structuredClone(previous);
    const w={id:randomUUID(),agentId:randomUUID(),request,brief,status:'queued',revision:0};
    if(sourceJob)w.sourceJob=sourceJob;
    if(name!=null){const base=String(name).trim().slice(0,110)||'工作';let unique=base,index=2;while(this.state.works.some(other=>other.status!=='ended'&&other.name===unique))unique=base+' · '+index++;w.name=unique;}
    this.state.works.push(w);this.state.todos.push({id:randomUUID(),workId:w.id,kind:'queue',status:'open'});
    // 明确永久“永不提交”的原文表述进入版本绑定约束待办（用户显式选择/撤回），
    // 不靠原文扫描做永久veto；宽泛“先不要提交”不触发（接受即本地合入授权）。
    if(explicitNeverCommitStatement(request)){w.mergeConstraint={schema:1,version:1,mode:'unresolved',origin:'detected',detectedAt:new Date().toISOString()};this.state.todos.push({id:randomUUID(),workId:w.id,revision:w.revision,kind:'merge-constraint',status:'open',constraintVersion:1,text:'原文包含明确“永不提交”表述：请一次性确认这是“禁止合入直到另行授权”（永久，合入需另行一次性批准）还是临时暂缓/无约束。原请求不改写。'});}
    return structuredClone(w);
  }
  async activateState(w,{initialize}={}){
    if(this.deviationHeld(w.id))throw Object.assign(Error('user deviation decision required'),{code:'DEVIATION_HELD'});if(w.status!=='queued')throw new Error('work not queued');if(this.used()>=this.state.limit)throw new Error('quota full');
    await fs.mkdir(this.agentHome(w.id),{recursive:true,mode:0o700});w.status='running';w.revision++;
    for(const t of this.state.todos)if(t.workId===w.id&&t.kind==='queue')t.status='resolved';
    initialize?.(w);return structuredClone(w);
  }
  activate(id,options){return this.mutate(()=>this.activateState(this.find(id),options));}
  activateNext(options){return this.mutate(()=>{const w=this.state.works.find(w=>w.status==='queued'&&(!options?.isEligible||options.isEligible(w)));return w&&this.used()<this.state.limit?this.activateState(w,options):null;});}
  agentHome(id){return path.join(this.root,'agents',this.find(id).agentId);}
  bind(id,threadId){return this.mutate(()=>{this.find(id).threadId=threadId;});}
  projectReceipt(row,{jobId}={}){
    this.state.messages??=[];
    if(!this.state.messages.some(m=>m.objectId===row.objectId))this.state.messages.push({id:randomUUID(),target:row.workId,speaker:row.origin==='host-diagnostic'?'system':'agent',objectId:row.objectId,publication:row.kind,revision:row.revision,...(jobId?{jobId}:{})});
  }
  async publish(id,revision,kind,body,receipt,{jobId,files=[],changeSetId=null,isActive=()=>true,publicationInputDigest=null,retainCandidate=null,hostDiagnostic=false}={}){return this.mutate(async tx=>{
    const w=this.find(id);
    // kind 显式决定对象格式：result=自包含静态 HTML，problem=轻量 Markdown 文本；不嗅探正文、不接受另一种正文。
    const format=kind==='result'?'html-static':kind==='problem'?'markdown':null;
    if(!format||typeof body!=='string'||!body.trim()||Buffer.byteLength(body)>8*1024*1024)throw new Error('invalid publication');
    const publicationDigest=digest(Buffer.from(JSON.stringify(format==='markdown'?{kind,text:body,files}:{kind,html:body,files})));
    const old=this.state.receipts.find(x=>x.id===receipt);if(old){if(old.workId!==id||old.revision!==revision||old.publicationDigest!==publicationDigest||old.kind!==kind||changeSetId&&old.changeSetId!==changeSetId)throw new Error('receipt collision');this.projectReceipt(old,{jobId});return old;}
    const diagnostic=hostDiagnostic===true&&kind==='problem'&&this.state.jobs?.some(job=>job.id===jobId&&job.target===id&&job.revision===revision&&['failed','interrupted','completed'].includes(job.status));
    const active=()=>{if(w.revision!==revision||!(w.status==='running'||diagnostic&&w.status==='paused')||!isActive())throw new Error('stale or inactive run');};active();
    const objectId=randomUUID(),directory=w.execution?.directory||this.content;
    const paths=[...files.map(f=>f.relPath),...(this.state.fileOperations||[]).filter(o=>o.workId===id).map(o=>o.relPath),...(w.execution?.candidate?.files||[])];
    const frozenFiles=await artifactSnapshot(directory,paths),frozenBytes=new Map();
    for(const entry of frozenFiles)if(entry.digest!==null){const bytes=await safeBytes(directory,entry.relPath);if(bytes===null||digest(bytes)!==entry.digest)throw Error('artifact changed during publication');frozenBytes.set(entry.relPath,bytes);}
    const assetPath=value=>{if(typeof value!=='string'||value.includes('\\')||value.includes('\u0000')||path.posix.isAbsolute(value)||value.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('invalid report resource path');return value;};
    const referencePath=href=>{const clean=href.split('#')[0];let rel;try{rel=decodeURIComponent(clean);}catch{throw Error('invalid report reference');}const line=/:\d+(?::\d+)?$/.exec(rel);if(line)rel=rel.slice(0,line.index);return assetPath(rel);};
    const declared=new Set(files.map(file=>file.relPath));
    // Markdown problem 不经 HTML 准备/引用冻结；files 冻结与工件复制对两种 kind 一致保留。
    const prepared=format==='html-static'?await prepareHtmlReport(body,{readAsset:async rel=>{rel=assetPath(rel);const bytes=frozenBytes.get(rel);if(!bytes||!declared.has(rel))throw Object.assign(Error('Report image must be included in files: '+rel),{code:'REPORT_RESOURCE_NOT_DECLARED'});return {bytes,digest:digest(bytes)};},resolveReference:async href=>{
      if(/^https?:\/\//i.test(href)){const url=new URL(href);if(url.username||url.password)throw Error('invalid external reference');return {kind:'external',url:url.href};}
      const relPath=referencePath(href);let entry=frozenFiles.find(f=>f.relPath===relPath);
      if(!entry){const bytes=await safeBytes(directory,relPath);if(bytes===null)throw Error('missing report reference: '+relPath);entry={relPath,digest:digest(bytes),size:bytes.length};frozenFiles.push(entry);frozenBytes.set(relPath,bytes);}
      if(entry.digest===null)throw Error('missing report reference: '+relPath);
      return {kind:'artifact',relPath,digest:entry.digest,byteLength:entry.size,mediaType:'application/octet-stream'};
    }}):null;
    const bytes=prepared?Buffer.from(prepared.html):Buffer.from(body),manifestBytes=prepared?Buffer.from(JSON.stringify(prepared.manifest)):null;
    if(bytes.length>(format==='html-static'?HTML_REPORT_OBJECT_MAX_BYTES:MAX_REPORT_BYTES))throw Error('report exceeds frozen resource budget');active();
    if(kind==='result'&&w.execution?.candidate?.fileDigests)for(const entry of frozenFiles)if((w.execution.candidate.fileDigests[entry.relPath]??null)!==entry.digest)throw Error('Report artifact differs from frozen candidate: '+entry.relPath);
    const report=prepared?reportDescriptor(bytes,{format,objectId,title:prepared.title,excerpt:prepared.excerpt,manifestDigest:digest(manifestBytes)}):reportDescriptor(bytes,{format,objectId});
    const snapshot={reportDigest:report.digest,candidate:w.execution?.candidate?{commit:w.execution.candidate.commit,tree:w.execution.candidate.tree,jobId:w.execution.candidate.jobId}:null,files:frozenFiles,operationIds:(this.state.fileOperations||[]).filter(o=>o.workId===id).map(o=>o.id)};
    await this.storage.putRecovery(this.projectId,'managed:publication:'+receipt,{operationId:this.operationId,workId:id,revision,receiptId:receipt,objectId,report,files:frozenFiles,status:'prepared'});
    for(const entry of frozenFiles)if(entry.digest!==null){const current=await safeBytes(directory,entry.relPath);if(current===null||digest(current)!==entry.digest)throw Error('artifact changed during publication');}
    if(retainCandidate!=null){
      if(typeof retainCandidate!=='function')throw new Error('retainCandidate must be a function');
      const retained=await retainCandidate();
      if(retained!=null){
        if(typeof retained!=='object'||Array.isArray(retained))throw new Error('invalid retainCandidate result');
        if(retained.changeSetId!=null){if(typeof retained.changeSetId!=='string'||!retained.changeSetId.trim())throw new Error('invalid retained changeSetId');changeSetId=retained.changeSetId;}
        if(retained.rollback!=null){if(typeof retained.rollback!=='function')throw new Error('invalid retainCandidate rollback');tx.onRollback(()=>retained.rollback());}
      }
    }
    for(const entry of frozenFiles)if(entry.digest!==null)entry.objectDigest=await this.putObject(frozenBytes.get(entry.relPath));
    await this.putObject(bytes);if(manifestBytes)await this.putObject(manifestBytes);
    snapshot.manifestDigest=await this.putObject(Buffer.from(JSON.stringify({version:1,report,files:frozenFiles})));
    active();
    const row={id:receipt,workId:id,revision,kind,report,publicationDigest,publicationInputDigest,objectId,at:new Date().toISOString(),...(diagnostic?{origin:'host-diagnostic'}:{}),...(jobId?{sourceJobId:jobId,jobId}:{}),...(changeSetId?{changeSetId}:{}),snapshot};this.state.receipts.push(row);
    this.projectReceipt(row,{jobId});
    if(kind==='result')w.result={objectId,revision};else w.problem={objectId,revision};
    if(kind==='result')for(const todo of this.state.todos)if(todo.workId===id&&todo.kind==='result'&&['open','iterating'].includes(todo.status))todo.status='superseded';
    this.state.todos.push({id:randomUUID(),workId:id,kind,objectId,revision,status:'open'});return row;
  });}
  settleState(id){const w=this.find(id);if(w.status!=='running')throw new Error('not running');const question=w.problem?.revision===w.revision,report=w.result?.revision===w.revision;w.status=question?'paused':report?'review':'paused';if(!question&&!report){const source=this.state.jobs?.findLast(j=>j.target===id&&j.revision===w.revision);this.state.todos.push({id:randomUUID(),workId:id,revision:w.revision,...(source?{sourceJobId:source.id}:{}),kind:'recovery',status:'open',text:'Worker 回合已结束，但尚未发布最终成果或问题报告；工作未完成，候选与原线程保留。请继续原 Worker 完成交付，不能据此接受成果。'});}}
  settle(id){return this.mutate(()=>this.settleState(id));}
  continueState(id){const w=this.find(id);if(this.deviationHeld(id))throw Object.assign(Error('user deviation decision required'),{code:'DEVIATION_HELD'});if(!['paused','review'].includes(w.status))throw new Error('cannot continue');w.status='running';w.revision++;for(const t of this.state.todos)if(t.workId===id&&t.status==='open'){if(t.kind==='problem')t.status='resolved';else if(t.kind==='result')t.status='iterating';}return w.revision;}
  continue(id){return this.mutate(()=>this.continueState(id));}
  // P5 事务窗口闭合：人工续改建账与收尾结算各自单事务（崩溃/落盘失败整体回滚，
  // 不留"Work 已 continue 无 job"或"job 已 completed Work 仍 running"的半状态）。
  continueWithManualJob(id,job){return this.mutate(()=>{const revision=this.continueState(id);job.revision=revision;job.context.boundWorkId=id;this.state.jobs.push(job);return revision;});}
  settleWithManualJob(id,job,{error,agentMessage,systemMessage}={}){return this.mutate(()=>{this.settleState(id);const saved=this.state.jobs.find(j=>j.id===job.id);if(error){saved.status='failed';saved.error=String(error).slice(0,400);}else{saved.status='completed';saved.completedAt=new Date().toISOString();}if(agentMessage)this.state.messages.push(agentMessage);else if(systemMessage)this.state.messages.push(systemMessage);});}
  async end(id,{by,revision,decision,binding,requestKey,validateAdmission,reviewed}){
    await this.mutate(()=>{
      const w=this.find(id);if(by!=='user'||!['accept','discard'].includes(decision))throw Error('explicit user accept/discard decision required');
      if(revision!==w.revision)throw Error('stale work revision');
      const fields=['workId','revision','objectId','candidateCommit'],current={workId:id,revision:w.revision,objectId:w.result?.objectId??null,candidateCommit:w.execution?.candidate?.commit??null};
      if(!binding||typeof binding!=='object'||Array.isArray(binding)||Object.keys(binding).length!==fields.length||fields.some(key=>!Object.hasOwn(binding,key)||binding[key]!==current[key]))throw Error('stale or invalid disposition binding');
      if(typeof requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(requestKey))throw Error('invalid disposition request key');
      if(this.state.works.some(other=>other.id!==id&&other.closure?.requestKey===requestKey))throw Error('disposition request key collision');
      if(w.status==='ended'){
        const closure=w.closure;
        if(w.outcome||closure?.decision){
          if(w.outcome!==decision||closure?.decision!==decision)throw Error('work already ended with another decision');
          if(!closure.binding||fields.some(key=>closure.binding[key]!==binding[key]))throw Error('work already ended without matching disposition binding');
          if(closure.requestKey!==requestKey)throw Error('work already ended with another disposition request key');
          if(reviewed&&(!closure.reviewedVersion||closure.reviewedVersion.reviewVersion!==reviewed.reviewVersion))throw Error('work already ended with another reviewed version');
          return;
        }
        if(closure?.git?.complete||closure?.workerHome?.cleaned||closure?.phase==='complete')throw Error('legacy resources already disposed; preserve historical outcome');
        validateAdmission?.();
        w.outcome=decision;w.closure??={revision:w.revision,at:w.endedAt};if(decision==='accept')w.closure.mergeAuthorization=mergeAuthorizationRecord(w,null);Object.assign(w.closure,{decision,binding:{...current},requestKey,phase:'requested',dispositionAt:new Date().toISOString()});return;
      }
      validateAdmission?.();
      const at=new Date().toISOString();w.status='ended';w.endedBy='user';w.endedAt=at;w.outcome=decision;w.closure={decision,binding:{...current},requestKey,phase:'requested',at,revision:w.revision};if(decision==='accept')w.closure.mergeAuthorization=mergeAuthorizationRecord(w,reviewed?.reviewVersion??null);
      // 人工审校接受（P1原子性）：决定、人工版本绑定与Orchestrator合入队列
      // 入账同一durable事务——两事务间崩溃会把已接受的Work按旧候选合入，丢人工修改。
      if(reviewed){
        if(decision!=='accept'||typeof reviewed.reviewVersion!=='string'||!Array.isArray(reviewed.files))throw Error('invalid reviewed binding');
        w.closure.reviewedVersion={reviewVersion:reviewed.reviewVersion,objectId:reviewed.objectId,at,files:reviewed.files};
        w.closure.merge={status:'pending',targetRef:w.execution?.targetRef??null,at,executor:'host',attempts:[{at,phase:'requested'}]};
        this.state.mergeQueue??=[];
        const queued=this.state.mergeQueue.find(e=>e.workId===id);
        if(queued){if(queued.reviewVersion!==reviewed.reviewVersion)throw Error('merge queue already holds another reviewed version');}
        else this.state.mergeQueue.push({workId:id,requestKey,reviewVersion:reviewed.reviewVersion,status:'pending',admittedAt:at,actor:'user',executor:'host',attempts:[],...(w.closure.mergeAuthorization?.consentRequired?{consentRequired:true,consentOrigin:w.closure.mergeAuthorization.consentOrigin??null}:{})});
      }
      for(const todo of this.state.todos)if(todo.workId===id&&['open','iterating'].includes(todo.status)&&['result','problem','routing','recovery','deviation'].includes(todo.kind)){todo.status='cancelled';todo.resolution={status:'work-ended',decision,at,revision:w.revision};}
      for(const j of this.state.jobs||[])if((j.target===id||j.context?.boundWorkId===id||j.context?.workId===id)&&['queued','transferring'].includes(j.status)){j.status='cancelled';j.interruptionReason='user-ended';j.finishedAt=at;}
    });
    await this.checkpoint('end-intent',{workId:id});
  }
  // 合入授权（MergeAuthorization）：与接受决定同事务原子落账，绑定精确的
  // 接受候选、人工审校版本集、仓库与目标head ref。临时no-auto-commit请求在
  // 用户接受时即本地合入授权（basis:'user-accept'）；结构化never-commit约束
  // 只标记consentRequired，合入仍需专门待办的一次性人工覆盖。
  #ensureMergeConsentTodo(w){
    if(!this.state.todos.some(t=>t.workId===w.id&&t.kind==='merge-consent'&&t.status==='open'))this.state.todos.push({id:randomUUID(),workId:w.id,revision:w.revision,kind:'merge-consent',status:'open',text:'等待一次性合入批准：候选 '+String(w.closure.mergeAuthorization?.candidateCommit??'').slice(0,12)+(w.closure.mergeAuthorization?.reviewVersion?'（人工审校版本已绑定）':'')+'；批准后按原队列本地合入，不重放Worker、不改写原请求'});
  }
  ensureMergeConsentRequestState(id,{requestId,version=1,effectHash,at}){
    return this.mutate(()=>{
      const w=this.find(id),authorization=w.closure?.mergeAuthorization;
      if(!authorization?.consentRequired||authorization.consent)return null;
      if(authorization.request?.id===requestId)return authorization.request;
      authorization.request={id:requestId,version,effectHash,createdAt:at,pending:true};
      this.#ensureMergeConsentTodo(w);
      return authorization.request;
    });
  }
  // 一次性人工覆盖：批准只把原mergeQueue行恢复为pending（绝不新建行、不重放
  // Worker、不改写work.request）；拒绝保留阻断现场与全部资源。requestKey幂等、
  // 版本绑定；绑定与落账授权不一致即拒绝（stale approval），零合入。
  resolveMergeConsentState(id,{requestId,expectedVersion,action,requestKey,binding}){
    return this.mutate(()=>{
      const w=this.find(id),authorization=w.closure?.mergeAuthorization;
      if(w.status!=='ended'||w.closure?.decision!=='accept'||!authorization?.consentRequired)throw Object.assign(Error('此工作没有待人工覆盖的合入同意'),{code:'NO_MERGE_CONSENT_REQUIRED'});
      if(authorization.request?.id!==requestId||authorization.request?.version!==expectedVersion)throw Object.assign(Error('合入同意请求已过期，请刷新核对'),{code:'STALE_ATTENTION'});
      const consent=authorization.consent;
      if(consent){
        if(consent.requestKey!==requestKey)throw Object.assign(Error('此合入同意已按另一确认身份处理'),{code:'REVIEW_REQUEST_COLLISION'});
        if(consent.status!==(action==='approve'?'approved':'denied'))throw Object.assign(Error('已完成的合入同意决定不可更改'),{code:'DECISION_CHANGED'});
        return {duplicate:true,status:consent.status,at:consent.at};
      }
      if(!binding||typeof binding!=='object'||Array.isArray(binding)||Object.keys(binding).length!==mergeConsentBindingFields.length||!sameMergeConsentBinding(binding,Object.fromEntries(mergeConsentBindingFields.map(key=>[key,authorization[key]??null]))))throw Object.assign(Error('批准绑定与落账的合入授权不一致；未合入，请按当前候选刷新后确认'),{code:'STALE_APPROVAL'});
      const at=new Date().toISOString(),status=action==='approve'?'approved':'denied';
      authorization.consent={status,requestKey,at,by:'user'};
      authorization.request={...authorization.request,version:authorization.request.version+1,pending:false,decidedAt:at,status};
      const row=(this.state.mergeQueue||[]).find(e=>e.workId===id);
      const deniedText='用户拒绝了此合入覆盖；决定、候选与人工审校版本完整保留';
      if(action==='approve'){if(row){row.status='pending';row.retriedAt=at;row.consentApprovedAt=at;}if(w.closure.merge){w.closure.merge.status='pending';delete w.closure.merge.blockedCode;delete w.closure.merge.message;}}
      else{if(row){row.status='blocked';row.lastError=deniedText;}if(w.closure.merge){w.closure.merge.status='blocked';w.closure.merge.blockedCode='MERGE_CONSENT_DENIED';w.closure.merge.message=deniedText;}}
      for(const todo of this.state.todos)if(todo.workId===id&&todo.kind==='merge-consent'&&todo.status==='open'){todo.status='resolved';todo.resolution={status,at,revision:w.revision};}
      return {duplicate:false,status,at};
    });
  }
  // 合入约束策略的一次性确认与后续显式设置/撤回（版本绑定CAS，requestKey
  // 幂等；同key改选拒绝，新key=用户新的显式决定）。确认never-commit时保持
  // 合入需另经一次性merge-consent覆盖；确认hold/none时解除阻断并恢复原
  // 队列行（不重放Worker、不改写原请求、不新建队列行）。
  resolveMergeConstraintState(id,{expectedVersion,choice,requestKey}){
    return this.mutate(()=>{
      const w=this.find(id);let constraint=w.mergeConstraint;
      if(!mergeConstraintChoices.includes(choice))throw Object.assign(Error('合入约束选择无效'),{code:'INVALID_PAYLOAD'});
      if(typeof requestKey!=='string'||!/^[a-zA-Z0-9:_-]{8,160}$/.test(requestKey))throw Object.assign(Error('合入约束确认身份无效'),{code:'INVALID_PAYLOAD'});
      if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw Object.assign(Error('合入约束版本无效'),{code:'INVALID_PAYLOAD'});
      if(!constraint){
        // 无既有约束时的显式设置入口（用户主动选择“禁止合入直到另行授权”
        // 或确认临时/无约束）：expectedVersion=0 表示从零设置，随后走同一
        // 版本绑定决定流（含已结束工作的授权/队列联动）。
        if(expectedVersion!==0)throw Object.assign(Error('此工作没有待确认的合入约束策略；新设置请用版本0'),{code:'STALE_ATTENTION'});
        w.mergeConstraint={schema:1,version:0,mode:'unresolved',origin:'user-choice',detectedAt:new Date().toISOString()};
        constraint=w.mergeConstraint;
      }
      if(constraint.resolvedRequestKey===requestKey){
        if(constraint.mode!==choice)throw Object.assign(Error('已完成的合入约束决定不可更改；如需调整请发起新的显式决定'),{code:'DECISION_CHANGED'});
        return {duplicate:true,status:choice,version:constraint.version};
      }
      if(constraint.resolvedRequestKey&&constraint.resolvedRequestKey!==requestKey&&constraint.version!==expectedVersion)throw Object.assign(Error('合入约束版本已变化，请刷新核对'),{code:'STALE_ATTENTION'});
      if(!constraint.resolvedRequestKey&&constraint.version!==expectedVersion)throw Object.assign(Error('合入约束版本已变化，请刷新核对'),{code:'STALE_ATTENTION'});
      const at=new Date().toISOString();
      constraint.version+=1;constraint.mode=choice;constraint.resolvedAt=at;constraint.resolvedRequestKey=requestKey;if(choice==='never-commit')constraint.confirmedAt=at;
      const authorization=w.closure?.mergeAuthorization;
      if(w.status==='ended'&&w.closure?.decision==='accept'&&authorization){
        if(choice==='never-commit'){authorization.consentRequired=true;authorization.consentOrigin=authorization.consentOrigin??'structured';}
        else{
          authorization.consentRequired=false;authorization.consentOrigin=null;
          if(authorization.request&&!authorization.consent)authorization.request={...authorization.request,version:authorization.request.version+1,pending:false,status:'superseded',decidedAt:at};
          if(w.closure.merge){w.closure.merge.status='pending';delete w.closure.merge.blockedCode;delete w.closure.merge.message;}
          const row=(this.state.mergeQueue||[]).find(e=>e.workId===id);
          if(row){row.status='pending';row.retriedAt=at;}
          for(const todo of this.state.todos)if(todo.workId===id&&todo.kind==='merge-consent'&&todo.status==='open'){todo.status='resolved';todo.resolution={status:'superseded',at,revision:w.revision};}
        }
      }
      for(const todo of this.state.todos)if(todo.workId===id&&todo.kind==='merge-constraint'&&todo.status==='open'){todo.status='resolved';todo.resolution={status:choice,at,revision:w.revision};}
      return {duplicate:false,status:choice,version:constraint.version};
    });
  }
  // ── 人工审校（managed.review.*）：与业务账本同事务的状态转移 ──────────────
  // 草稿只进durable审校库与账本摘要，绝不写worktree/主仓库/模型来源。
  reviewSaveState(id,{objectId,relPath,textDigest,expectedDraftRevision}){
    return this.mutate(()=>{
      const w=this.find(id);
      if(w.status==='ended')throw Object.assign(Error('工作已结束；审稿不再修改'),{code:'WORK_ENDED'});
      if(w.readOnly)throw Object.assign(Error('历史执行资源只读'),{code:'HISTORICAL_SESSION_READ_ONLY'});
      const candidateCommit=w.execution?.candidate?.commit??null;
      if(objectId!==(w.result?.objectId??null)||!candidateCommit)throw Object.assign(Error('此报告不是当前待审候选；草稿只属于最新发布'),{code:'REVIEW_CANDIDATE_STALE'});
      // 存在未收口的续作意图时禁止新草稿：避免旧plan在恢复时套用新正文，
      // 也不会把被阻断的续作悄悄换成别的版本（保守阻止，直到续作完成/处理）。
      if((w.review?.continuations||[]).some(c=>['applying','blocked'].includes(c.state)))throw Object.assign(Error('存在未完成的续作意图（可能被外部变化阻断）；请先重试续作或等待处理完成，再修改草稿'),{code:'REVIEW_CONTINUE_PENDING'});
      w.review??={drafts:{},history:{},continuations:[]};
      w.review.revisionCursor??={};
      if(w.review.objectId&&w.review.objectId!==objectId){
        // 新发布：轮换审校命名空间。旧发布未消费草稿退出active（正文仍在
        // durable记录），revision按cursor单调续号，第二轮永不覆盖第一轮正文。
        w.review.drafts={};w.review.candidateCommit=candidateCommit;w.review.objectId=objectId;
      }else{w.review.candidateCommit=candidateCommit;w.review.objectId=objectId;}
      const held=w.review.drafts[relPath];
      const current=held&&held.objectId===objectId?held.revision:0;
      if(expectedDraftRevision!==current)throw Object.assign(Error('草稿版本已变化，请重新读取（另一窗口的保存已生效，你的输入请以当前版本为准）'),{code:'REVIEW_DRAFT_STALE',currentDraftRevision:current});
      const revision=(held?.revision??w.review.revisionCursor[relPath]??0)+1,at=new Date().toISOString();
      w.review.drafts[relPath]={revision,textDigest,savedAt:at,objectId,candidateCommit};
      w.review.revisionCursor[relPath]=Math.max(w.review.revisionCursor[relPath]??0,revision);
      w.review.history??={};w.review.history[relPath]??=[];
      w.review.history[relPath].push({revision,textDigest,savedAt:at,objectId});if(w.review.history[relPath].length>20)w.review.history[relPath].splice(0,w.review.history[relPath].length-20);
      return {draftRevision:revision,savedAt:at};
    });
  }
  // 续作意图先落账（state:'applying'）再写worktree；本方法是幂等收口：标记旧
  // 报告stale、continueState（running+revision++）、同Work建manual job、消费已
  // 应用草稿——单事务完成；apply按摘要幂等，崩溃恢复不会 double-apply。
  reviewContinueState(id,{requestKey}){
    return this.mutate(()=>{
      const w=this.find(id);
      const record=w.review?.continuations?.find(c=>c.requestKey===requestKey);
      if(!record)throw Object.assign(Error('续作意图不存在'),{code:'REVIEW_CONTINUE_UNKNOWN'});
      if(record.state==='queued')return {duplicate:true,jobId:record.jobId,revision:record.revision};
      if(w.status==='ended'){record.state='abandoned';record.error??={code:'WORK_ENDED',message:'工作已结束；续作意图保留为历史'};return {abandoned:true};}
      if(!['applying','blocked'].includes(record.state))throw Object.assign(Error('续作意图状态无效'),{code:'REVIEW_CONTINUE_STATE'});
      if(!['paused','review'].includes(w.status))throw Object.assign(Error(w.status==='running'?'工作正在执行；不能同时续作':'当前状态不能续作'),{code:w.status==='running'?'WORK_BUSY':'WORK_STATE'});
      if((this.state.jobs||[]).some(j=>(j.target===id||j.context?.boundWorkId===id)&&['queued','running'].includes(j.status)))throw Object.assign(Error('此工作有待执行输入；不能同时续作'),{code:'WORK_BUSY'});
      const at=new Date().toISOString(),plan=record.files||[];
      for(const r of this.state.receipts)if(r.workId===id&&!r.stale)r.stale={code:'SUPERSEDED',at,requestKey};
      const revision=this.continueState(id);
      const job={id:randomUUID(),key:'review-continue:'+requestKey,target:id,type:'manual',text:record.instruction,context:{boundWorkId:id,manual:true,permissionTaskId:randomUUID(),reviewContinuation:{requestKey,reviewVersion:record.reviewVersion,at,files:plan.map(f=>({relPath:f.relPath,fromDigest:f.fromDigest,toDigest:f.toDigest,draftRevision:f.draftRevision}))}},status:'queued',promptStartedAt:null,at,revision};
      this.state.jobs.push(job);
      this.state.messages.push({id:randomUUID(),target:id,speaker:'user',text:record.instruction,jobId:job.id});
      for(const f of plan){const held=w.review.drafts[f.relPath];if(held){w.review.revisionCursor??={};w.review.revisionCursor[f.relPath]=Math.max(w.review.revisionCursor[f.relPath]??0,held.revision);delete w.review.drafts[f.relPath];}}
      Object.assign(record,{state:'queued',jobId:job.id,revision,queuedAt:at});delete record.error;
      return {jobId:job.id,revision};
    });
  }
  // 审校续作指令草稿（UI作曲框独立durable存储，不与主对话草稿混用）：
  // 按(objectId)命名空间CAS；正文存recovery库，账本只留摘要。
  reviewInstructionState(id,{objectId,textDigest,expectedRevision}){
    return this.mutate(()=>{
      const w=this.find(id);
      if(w.status==='ended')throw Object.assign(Error('工作已结束；续作指令不再修改'),{code:'WORK_ENDED'});
      if(w.readOnly)throw Object.assign(Error('历史执行资源只读'),{code:'HISTORICAL_SESSION_READ_ONLY'});
      if(objectId!==(w.result?.objectId??null))throw Object.assign(Error('此报告不是当前待审候选'),{code:'REVIEW_CANDIDATE_STALE'});
      w.review??={drafts:{},history:{},continuations:[]};w.review.instruction??={};
      const held=w.review.instruction.objectId===objectId?w.review.instruction:null;
      const current=held?.revision??0;
      if(expectedRevision!==current)throw Object.assign(Error('指令草稿版本已变化，请重新读取'),{code:'REVIEW_INSTRUCTION_STALE',currentRevision:current});
      const revision=current+1,at=new Date().toISOString();
      w.review.instruction={revision,textDigest,savedAt:at,objectId};
      return {revision,savedAt:at};
    });
  }
  async markStopped(id,receipt){await this.mutate(()=>{const w=this.find(id);if(w.status!=='ended')throw Error('work not ended');w.closure.stopped=true;w.closure.stopReceipt=receipt||{at:new Date().toISOString(),confirmed:true};w.closure.phase='report';});await this.checkpoint('stopped-state',{workId:id});}
  async archiveReport(id){
    return this.mutate(async()=>{
      const w=this.find(id),closure=w.closure;if(!closure?.stopped)throw Error('provider stop must be confirmed before archival');
      let relPath,file;
      const source=this.state.receipts.findLast(r=>r.workId===id&&r.revision===w.revision&&r.kind==='result')||this.state.receipts.findLast(r=>r.workId===id&&r.kind==='problem');
      let bytes,kind,sourceRef;
      if(source){bytes=await readStoredReport(this,source);kind=source.kind==='result'?'worker-report':'worker-problem';sourceRef=`objects/sha256/${source.report.digest}`;}
      else{kind='host-termination';sourceRef=`project.sqlite#managed_works:${id}`;bytes=Buffer.from(`# Host termination record\n\nWork: ${w.name||id}\nDecision: ${closure.decision||'unknown'}\nEnded: ${w.endedAt}\nProvider stopped: confirmed\nNo final Worker result report exists for revision ${w.revision}. This is not a successful completion report.\n`);}
      if(closure.report){await this.readObject(closure.report.digest);return closure.report;}
      const objectDigest=await this.putObject(bytes);relPath=`../../objects/sha256/${objectDigest}`;
      closure.report={relPath,digest:objectDigest,kind,source:sourceRef,format:source?.report.format||'markdown',mediaType:source?.report.mediaType||'text/markdown',revision:w.revision,at:new Date().toISOString(),...(kind==='worker-report'?{summary:source.report.excerpt.slice(0,240)}:{})};
      await this.updateArchiveState(w);return structuredClone(closure.report);
    });
  }
  async updateArchiveState(w){
    const report=w.closure?.report;if(!report)return;
    await this.requireOnline();
    const directory=path.dirname(this.plan),metadataPath=`project.sqlite#managed_works:${w.id}`;
    const previous=await fs.readFile(this.plan,'utf8'),marker=`<!-- report:${w.id} -->`,end=`<!-- /report:${w.id} -->`;
    const clean=text=>String(text||'').replace(/[\r\n]+/g,' ').replace(/[<>\[\]]/g,'').slice(0,240);
    const fact=w.closure.git?.status||'technical closure '+w.closure.phase;
    const block=`${marker}\n- [${clean(w.name)||w.id}](${report.relPath}) — user ${w.outcome||'legacy outcome unknown'}; ${report.kind}; ${clean(fact)}. [Host facts](${metadataPath}); source: ${report.source}; revision ${w.revision}.${report.summary?' Worker report excerpt: '+clean(report.summary):''}\n${end}`;
    let next;const start=previous.indexOf(marker),close=start<0?-1:previous.indexOf(end,start);
    if(start<0)next=previous+'\n'+block+'\n';else if(close>=0)next=previous.slice(0,start)+block+previous.slice(close+end.length);else throw Error('Incomplete report index marker; preserve root for recovery');
    if(next!==previous){const temporary=`${this.plan}.${randomUUID()}.tmp`;const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(next);await handle.sync();}finally{await handle.close();}if(await fs.readFile(this.plan,'utf8')!==previous){await fs.rm(temporary,{force:true});throw Error('Plan Tree changed during archival; retry without overwriting user edits');}await fs.rename(temporary,this.plan);}
    if(process.platform!=='win32'){const handle=await fs.open(directory,'r');try{await handle.sync();}finally{await handle.close();}}
  }
  updateClosureArchive(id){return this.mutate(()=>this.updateArchiveState(this.find(id)));}
  async cleanupWorkerHome(id){
    const w=this.find(id);if(!w.closure?.stopped||!w.closure.report||!w.closure.git?.complete)throw Error('Worker home cleanup prerequisites missing');
    const home=this.agentHome(id),parent=path.join(this.root,'history','workers'),dest=path.join(parent,id);
    if(!inside(path.join(this.root,'agents'),home)||home===path.join(this.root,'agents'))throw Error('Worker home outside owned directory');
    const stat=await fs.lstat(home).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    const present=async file=>fs.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(stat){
      if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Worker home is not an owned ordinary directory');
      await fs.mkdir(dest,{recursive:true,mode:0o700});const archiveStat=await fs.lstat(dest);if(!archiveStat.isDirectory()||archiveStat.isSymbolicLink())throw Error('Worker history archive is not an ordinary directory');
      const sessions=path.join(home,'sessions'),saved=path.join(dest,'sessions'),sessionStat=await present(sessions);
      if(sessionStat){if(!sessionStat.isDirectory()||sessionStat.isSymbolicLink())throw Error('Worker session history is not an ordinary directory');if(await present(saved))throw Error('Session history exists in both active and archived home');await fs.rename(sessions,saved);}
      await fs.rm(home,{recursive:true});
    }
    const archived=await present(dest);if(archived?.isSymbolicLink())throw Error('Linked Worker history archive');
    await this.mutate(()=>{w.closure.workerHome={cleaned:true,...(archived?{historyPath:dest}:{}),at:new Date().toISOString()};});
  }
}
