import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processStamp, ownerAlive } from './process-ownership.mjs';
import {artifactSnapshot,digest} from './report-review.mjs';
import {reconcileTodos} from '../../domain/todo-management.mjs';
import {safeBytes} from './execution-workspace.mjs';
import {recordBusinessTimeline} from './session-index.mjs';
import {prepareHtmlReport,HTML_REPORT_OBJECT_MAX_BYTES} from './html-report.mjs';
import {decodeReportState,reportDescriptor,reportExtension,readStoredReport,MAX_REPORT_BYTES} from './report-descriptor.mjs';

export async function atomicJson(file,value){
  const tmp=`${file}.${randomUUID()}.tmp`;const handle=await fs.open(tmp,'wx',0o600);
  try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}
  try{await fs.rename(tmp,file);}catch(error){await fs.rm(tmp,{force:true});throw error;}
}
const inside=(a,b)=>a===b || (!path.relative(a,b).startsWith(`..${path.sep}`) && path.relative(a,b)!=='..' && !path.isAbsolute(path.relative(a,b)));
export class Workspace {
  static async open(runtimeRoot,contentRoot,{recoverStale=false,checkpoint=async()=>{}}={}){
    await fs.mkdir(runtimeRoot,{recursive:true,mode:0o700});await fs.mkdir(contentRoot,{recursive:true});
    const runtime=await fs.realpath(runtimeRoot),content=await fs.realpath(contentRoot);
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
    const store=new Workspace(runtime,content,lock,owner);store.checkpoint=checkpoint;
    try{
      let original;try{original=JSON.parse(await fs.readFile(store.file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(original!==undefined){if(!original||original.schema!==2||original.contentRoot!==content)throw new Error('incompatible workspace');store.state=decodeReportState(original);if(original.reportStateVersion!==1){for(const receipt of store.state.receipts)await readStoredReport(store,receipt);await store.save();}}
      else{store.state={schema:2,reportStateVersion:1,workspaceId:randomUUID(),contentRoot:content,limit:1,works:[],todos:[],receipts:[],memoryPending:[]};await store.save();}
      for(const dir of ['objects','agents','memory','evidence'])await fs.mkdir(path.join(runtime,dir),{recursive:true,mode:0o700});
      store.plan=path.join(runtime,'memory','plan-tree.md');await fs.writeFile(store.plan,'# Plan Tree\n\nWorker reports and sourced host closure facts.\n',{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e;});
      return store;
    }catch(error){await store.close();throw error;}
  }
  constructor(root,content,lock,owner){Object.assign(this,{root,content,lock,owner});this.file=path.join(root,'state.json');this.serial=Promise.resolve();}
  save(){return atomicJson(this.file,this.state);}
  async close(){if(this.closed)return;this.closing=true;await this.serial;if(await fs.readFile(this.lock,'utf8')!==this.owner)throw new Error('workspace owner changed');await fs.unlink(this.lock);this.closed=true;}
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
    // P2：对象写入失败/save 失败整体回滚（仅删自建对象文件）。
    const objectFiles=[];
    tx.onRollback(async()=>{
      const durable=await this.#durableReceipt(receipt);
      if(durable!=='absent')return {commitUnknown:{scope:'deviation',receiptId:receipt,workId:id,objectId,objectFiles:[...objectFiles],durable}};
      const failures=[];
      for(const file of objectFiles)await fs.rm(file,{force:true}).catch(failure=>failures.push(failure));
      if(failures.length)throw Object.assign(new Error('deviation rollback cleanup incomplete'),{code:'DEVIATION_ROLLBACK_INCOMPLETE',files:[...objectFiles],failures});
    });
    for(const [suffix,data] of [['.md',Buffer.from(body)]]){const file=path.join(this.root,'objects',objectId+suffix),handle=await fs.open(file,'wx',0o600);objectFiles.push(file);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}}
    if(w.deviation){w.deviationHistory??=[];w.deviationHistory.push(structuredClone(w.deviation));}
    w.deviation=event;w.status='paused';w.problem={objectId,revision:w.revision};
    const report=reportDescriptor(Buffer.from(body),{format:'markdown',objectId,title:'任务偏离：等待用户决定'});
    const row={id:receipt,workId:id,revision:w.revision,kind:'problem',report,objectId,sourceJobId:job.id,deviation:structuredClone(event),at};this.state.receipts.push(row);this.projectReceipt(row,{jobId:job.id});
    this.state.todos.push({id:todoId,workId:id,revision:w.revision,kind:'deviation',status:'open',sourceJobId:sourceJob.id,objectId,deviationId:event.id,expectedVersion:1,text:report.excerpt});
    return structuredClone(event);
  });}
  // 事务化变更：fn(tx) 内通过 tx.onRollback 注册回滚钩子；save 失败或 fn 抛错时按注册
  // 顺序执行钩子。钩子返回 {commitUnknown} 表示磁盘提交结果不明或已提交：立即停止一切
  // 后续清理（保留对象文件与已变更的内存状态，使其与可能已生效的磁盘状态对齐），并把
  // hold 附加到原始错误上抛出；否则恢复事务前状态。清理钩子自身的失败不吞掉原始错误，
  // 收集为 error.rollbackFailures 一并上抛。仅当磁盘 state.json 可读且其中确无对应收据
  // （proven absent）时才允许删除本事务自建文件。
  async mutate(fn){
    if(this.closed||this.closing)throw new Error('workspace closed');
    const run=this.serial.then(async()=>{
      if(this.closed)throw new Error('workspace closed');
      const prior=structuredClone(this.state);
      const rollback=[];
      const tx={onRollback:async hook=>{if(typeof hook!=='function')throw new Error('rollback hook must be a function');rollback.push(hook);}};
      try{
        const result=await fn(tx);
        reconcileTodos(this.state,prior);recordBusinessTimeline(prior,this.state);
        await this.save();
        return result;
      }catch(error){
        let held=null;const failures=[];
        for(const hook of rollback){
          let outcome;try{outcome=await hook(error);}catch(failure){failures.push(failure);continue;}
          if(outcome?.commitUnknown){held??=outcome.commitUnknown;break;}
        }
        if(held){if(failures.length)error.rollbackFailures=failures;error.commitUnknown=held;throw error;}
        this.state=prior;
        if(failures.length)error.rollbackFailures=failures;
        throw error;
      }
    });
    this.serial=run.catch(()=>{});return run;
  }
  // 提交不确定性判定：事务失败后从磁盘重读 state.json。收据已在磁盘 => 'present'；
  // 可读且无该收据 => 'absent'；读不出或解析不了 => 'unknown'（不可证明缺席，按已提交对待）。
  async #durableReceipt(receiptId){
    if(typeof receiptId!=='string'||!receiptId)return 'unknown';
    let text;try{text=await fs.readFile(this.file,'utf8');}catch{return 'unknown';}
    try{const stored=JSON.parse(text);const receipts=stored&&Array.isArray(stored.receipts)?stored.receipts:[];return receipts.some(r=>r&&r.id===receiptId)?'present':'absent';}catch{return 'unknown';}
  }
  submit(request,brief,options={}){return this.mutate(()=>this.submitState(request,brief,options));}
  submitState(request,brief,{name,sourceJob}={}){
    if(!request?.trim()||!brief?.trim())throw new Error('task requires original request and brief');
    const previous=sourceJob&&this.state.works.find(w=>w.sourceJob===sourceJob);if(previous)return structuredClone(previous);
    const w={id:randomUUID(),agentId:randomUUID(),request,brief,status:'queued',revision:0};
    if(sourceJob)w.sourceJob=sourceJob;
    if(name!=null){const base=String(name).trim().slice(0,110)||'工作';let unique=base,index=2;while(this.state.works.some(other=>other.status!=='ended'&&other.name===unique))unique=base+' · '+index++;w.name=unique;}
    this.state.works.push(w);this.state.todos.push({id:randomUUID(),workId:w.id,kind:'queue',status:'open'});return structuredClone(w);
  }
  async activateState(w,{initialize}={}){
    if(this.deviationHeld(w.id))throw Object.assign(Error('user deviation decision required'),{code:'DEVIATION_HELD'});if(w.status!=='queued')throw new Error('work not queued');if(this.used()>=this.state.limit)throw new Error('quota full');
    await fs.mkdir(this.agentHome(w.id),{recursive:true,mode:0o700});w.status='running';w.revision++;
    for(const t of this.state.todos)if(t.workId===w.id&&t.kind==='queue')t.status='resolved';
    initialize?.(w);return structuredClone(w);
  }
  activate(id,options){return this.mutate(()=>this.activateState(this.find(id),options));}
  activateNext(options){return this.mutate(()=>{const w=this.state.works.find(w=>w.status==='queued');return w&&this.used()<this.state.limit?this.activateState(w,options):null;});}
  agentHome(id){return path.join(this.root,'agents',this.find(id).agentId);}
  bind(id,threadId){return this.mutate(()=>{this.find(id).threadId=threadId;});}
  projectReceipt(row,{jobId}={}){
    this.state.messages??=[];
    if(!this.state.messages.some(m=>m.objectId===row.objectId))this.state.messages.push({id:randomUUID(),target:row.workId,speaker:'agent',objectId:row.objectId,publication:row.kind,revision:row.revision,...(jobId?{jobId}:{})});
  }
  async publish(id,revision,kind,body,receipt,{jobId,files=[],changeSetId=null,isActive=()=>true,publicationInputDigest=null,retainCandidate=null}={}){return this.mutate(async tx=>{
    const w=this.find(id);
    // kind 显式决定对象格式：result=自包含静态 HTML，problem=轻量 Markdown 文本；不嗅探正文、不接受另一种正文。
    const format=kind==='result'?'html-static':kind==='problem'?'markdown':null;
    if(!format||typeof body!=='string'||!body.trim()||Buffer.byteLength(body)>8*1024*1024)throw new Error('invalid publication');
    const publicationDigest=digest(Buffer.from(JSON.stringify(format==='markdown'?{kind,text:body,files}:{kind,html:body,files})));
    const old=this.state.receipts.find(x=>x.id===receipt);if(old){if(old.workId!==id||old.revision!==revision||old.publicationDigest!==publicationDigest||old.kind!==kind||changeSetId&&old.changeSetId!==changeSetId)throw new Error('receipt collision');this.projectReceipt(old,{jobId});return old;}
    const active=()=>{if(w.revision!==revision||w.status!=='running'||!isActive())throw new Error('stale or inactive run');};active();
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
    const snapshot={reportDigest:report.digest,directory,candidate:structuredClone(w.execution?.candidate||null),files:frozenFiles,operationIds:(this.state.fileOperations||[]).filter(o=>o.workId===id).map(o=>o.id),artifactDirectory:path.join(this.root,'objects','artifacts',objectId)};
    // P1 事务化发布：最终快照校验后、写任何报告对象前注册回滚钩子。save 失败不再遗留
    // object/manifest/artifacts 孤儿；仅删除本事务自建文件（wx 新建），未知文件一律保留。
    for(const entry of frozenFiles)if(entry.digest!==null){const current=await safeBytes(directory,entry.relPath);if(current===null||digest(current)!==entry.digest)throw Error('artifact changed during publication');}
    const created=[],artifactFiles=[];
    tx.onRollback(async()=>{
      const durable=await this.#durableReceipt(receipt);
      if(durable!=='absent')return {commitUnknown:{scope:'publication',receiptId:receipt,workId:id,objectId,artifactDirectory:snapshot.artifactDirectory,objectFiles:[...created,...artifactFiles],durable}};
      const failures=[];
      for(const file of [...created,...artifactFiles])await fs.rm(file,{force:true}).catch(failure=>failures.push(failure));
      const directories=new Set([snapshot.artifactDirectory]);
      for(const file of artifactFiles)for(let dir=path.dirname(file);dir!==snapshot.artifactDirectory&&inside(snapshot.artifactDirectory,dir);dir=path.dirname(dir))directories.add(dir);
      for(const dir of [...directories].sort((a,b)=>b.split(path.sep).length-a.split(path.sep).length))await fs.rmdir(dir).catch(failure=>{if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(failure.code))failures.push(failure);});
      if(failures.length)throw Object.assign(new Error('publication rollback cleanup incomplete'),{code:'PUBLICATION_ROLLBACK_INCOMPLETE',files:[...created,...artifactFiles],failures});
    });
    if(retainCandidate!=null){
      if(typeof retainCandidate!=='function')throw new Error('retainCandidate must be a function');
      const retained=await retainCandidate();
      if(retained!=null){
        if(typeof retained!=='object'||Array.isArray(retained))throw new Error('invalid retainCandidate result');
        if(retained.changeSetId!=null){if(typeof retained.changeSetId!=='string'||!retained.changeSetId.trim())throw new Error('invalid retained changeSetId');changeSetId=retained.changeSetId;}
        if(retained.rollback!=null){if(typeof retained.rollback!=='function')throw new Error('invalid retainCandidate rollback');tx.onRollback(async()=>{await retained.rollback();});}
      }
    }
    for(const entry of frozenFiles)if(entry.digest!==null){const target=path.join(snapshot.artifactDirectory,entry.relPath);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});const handle=await fs.open(target,'wx',0o600);artifactFiles.push(target);try{await handle.writeFile(frozenBytes.get(entry.relPath));await handle.sync();}finally{await handle.close();}}
    for(const [suffix,data] of prepared?[['.html',bytes],['.manifest.json',manifestBytes]]:[[reportExtension(report),bytes]]){const file=path.join(this.root,'objects',objectId+suffix),handle=await fs.open(file,'wx',0o600);created.push(file);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}}
    active();
    const row={id:receipt,workId:id,revision,kind,report,publicationDigest,publicationInputDigest,objectId,at:new Date().toISOString(),...(jobId?{sourceJobId:jobId,jobId}:{}),...(changeSetId?{changeSetId}:{}),snapshot};this.state.receipts.push(row);
    this.projectReceipt(row,{jobId});
    if(kind==='result')w.result={objectId,revision};else w.problem={objectId,revision};
    if(kind==='result')for(const todo of this.state.todos)if(todo.workId===id&&todo.kind==='result'&&['open','iterating'].includes(todo.status))todo.status='superseded';
    this.state.todos.push({id:randomUUID(),workId:id,kind,objectId,revision,status:'open'});return row;
  });}
  settleState(id){const w=this.find(id);if(w.status!=='running')throw new Error('not running');const question=w.problem?.revision===w.revision,report=w.result?.revision===w.revision;w.status=question?'paused':report?'review':'paused';if(!question&&!report){const source=this.state.jobs?.findLast(j=>j.target===id&&j.revision===w.revision);this.state.todos.push({id:randomUUID(),workId:id,revision:w.revision,...(source?{sourceJobId:source.id}:{}),kind:'recovery',status:'open',text:'turn ended without report'});}}
  settle(id){return this.mutate(()=>this.settleState(id));}
  continueState(id){const w=this.find(id);if(this.deviationHeld(id))throw Object.assign(Error('user deviation decision required'),{code:'DEVIATION_HELD'});if(!['paused','review'].includes(w.status))throw new Error('cannot continue');w.status='running';w.revision++;for(const t of this.state.todos)if(t.workId===id&&t.status==='open'){if(t.kind==='problem')t.status='resolved';else if(t.kind==='result')t.status='iterating';}return w.revision;}
  continue(id){return this.mutate(()=>this.continueState(id));}
  // P5 事务窗口闭合：人工续改建账与收尾结算各自单事务（崩溃/落盘失败整体回滚，
  // 不留"Work 已 continue 无 job"或"job 已 completed Work 仍 running"的半状态）。
  continueWithManualJob(id,job){return this.mutate(()=>{const revision=this.continueState(id);job.revision=revision;job.context.boundWorkId=id;this.state.jobs.push(job);return revision;});}
  settleWithManualJob(id,job,{error,agentMessage,systemMessage}={}){return this.mutate(()=>{this.settleState(id);const saved=this.state.jobs.find(j=>j.id===job.id);if(error){saved.status='failed';saved.error=String(error).slice(0,400);}else{saved.status='completed';saved.completedAt=new Date().toISOString();}if(agentMessage)this.state.messages.push(agentMessage);else if(systemMessage)this.state.messages.push(systemMessage);});}
  async end(id,{by,revision,decision}){
    await this.mutate(()=>{
      const w=this.find(id);if(by!=='user'||!['accept','discard'].includes(decision))throw Error('explicit user accept/discard decision required');
      if(w.status==='ended'){if(w.outcome===decision)return;if(w.outcome||w.closure?.decision)throw Error('work already ended with another decision');if(w.closure?.git?.complete||w.closure?.workerHome?.cleaned||w.closure?.phase==='complete')throw Error('legacy resources already disposed; preserve historical outcome');if(revision!==w.revision)throw Error('stale work revision');w.outcome=decision;w.closure??={revision:w.revision,at:w.endedAt};w.closure.decision=decision;w.closure.phase='requested';w.closure.dispositionAt=new Date().toISOString();return;}
      if(revision!==w.revision)throw Error('stale work revision');
      const at=new Date().toISOString();w.status='ended';w.endedBy='user';w.endedAt=at;w.outcome=decision;w.closure={decision,phase:'requested',at,revision:w.revision};
      for(const todo of this.state.todos)if(todo.workId===id&&['open','iterating'].includes(todo.status)&&['result','problem','routing','recovery','deviation'].includes(todo.kind)){todo.status='cancelled';todo.resolution={status:'work-ended',decision,at,revision:w.revision};}
      for(const j of this.state.jobs||[])if((j.target===id||j.context?.boundWorkId===id||j.context?.workId===id)&&['queued','transferring'].includes(j.status)){j.status='cancelled';j.interruptionReason='user-ended';j.finishedAt=at;}
    });
    await this.checkpoint('end-intent',{workId:id});
  }
  async markStopped(id,receipt){await this.mutate(()=>{const w=this.find(id);if(w.status!=='ended')throw Error('work not ended');w.closure.stopped=true;w.closure.stopReceipt=receipt||{at:new Date().toISOString(),confirmed:true};w.closure.phase='report';});await this.checkpoint('stopped-state',{workId:id});}
  async archiveReport(id){
    return this.mutate(async()=>{
      const w=this.find(id),closure=w.closure;if(!closure?.stopped)throw Error('provider stop must be confirmed before archival');
      let relPath,file;
      const source=this.state.receipts.findLast(r=>r.workId===id&&r.revision===w.revision&&r.kind==='result')||this.state.receipts.findLast(r=>r.workId===id&&r.kind==='problem');
      let bytes,kind,sourceRef;
      if(source){bytes=await readStoredReport(this,source);kind=source.kind==='result'?'worker-report':'worker-problem';sourceRef=`objects/${source.objectId}${reportExtension(source.report)}`;}
      else{kind='host-termination';sourceRef=`state.json#work:${id}`;bytes=Buffer.from(`# Host termination record\n\nWork: ${w.name||id}\nDecision: ${closure.decision||'unknown (legacy)'}\nEnded: ${w.endedAt}\nProvider stopped: confirmed\nNo final Worker result report exists for revision ${w.revision}. This record is not a successful completion report.\nSource: ${sourceRef}\n`);}
      relPath=`reports/${id}${source?reportExtension(source.report):'.md'}`;file=path.join(path.dirname(this.plan),relPath);
      if(closure.report){const existing=await fs.readFile(file);if(digest(existing)!==closure.report.digest)throw Error('archived report changed');return closure.report;}
      await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
      try{const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}catch(error){if(error.code!=='EEXIST')throw error;if(!bytes.equals(await fs.readFile(file)))throw Error('existing archived report differs');}
      closure.report={relPath,digest:digest(bytes),kind,source:sourceRef,format:source?.report.format||'markdown',mediaType:source?.report.mediaType||'text/markdown',revision:w.revision,at:new Date().toISOString(),...(kind==='worker-report'?{summary:source.report.excerpt.slice(0,240)}:{})};
      await this.updateArchiveState(w);return structuredClone(closure.report);
    });
  }
  async updateArchiveState(w){
    const report=w.closure?.report;if(!report)return;
    const directory=path.dirname(this.plan),metadataPath=`reports/${w.id}.json`;
    await atomicJson(path.join(directory,metadataPath),{schema:1,workId:w.id,name:w.name,request:w.request,approvedScopes:structuredClone(w.approvedScopes||[]),deviation:structuredClone(w.deviation||null),deviationHistory:structuredClone(w.deviationHistory||[]),revision:w.revision,status:w.status,outcome:w.outcome||null,endedAt:w.endedAt,report:structuredClone(report),stopReceipt:structuredClone(w.closure.stopReceipt||null),workerHome:structuredClone(w.closure.workerHome||null),phase:w.closure.phase,git:structuredClone(w.closure.git||null),error:w.closure.error||null});
    const previous=await fs.readFile(this.plan,'utf8'),marker=`<!-- report:${w.id} -->`,end=`<!-- /report:${w.id} -->`;
    const clean=text=>String(text||'').replace(/[\r\n]+/g,' ').replace(/[<>\[\]]/g,'').slice(0,240);
    const fact=w.closure.git?.status||'technical closure '+w.closure.phase;
    const block=`${marker}\n- [${clean(w.name)||w.id}](${report.relPath}) — user ${w.outcome||'legacy outcome unknown'}; ${report.kind}; ${clean(fact)}. [Host facts](${metadataPath}); source: ${report.source}; revision ${w.revision}.${report.summary?' Worker report excerpt: '+clean(report.summary):''}\n${end}`;
    let next;const start=previous.indexOf(marker),close=start<0?-1:previous.indexOf(end,start);
    if(start<0)next=previous+'\n'+block+'\n';else if(close>=0)next=previous.slice(0,start)+block+previous.slice(close+end.length);else throw Error('Incomplete report index marker; preserve root for recovery');
    if(next!==previous){const temporary=`${this.plan}.${randomUUID()}.tmp`;const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(next);await handle.sync();}finally{await handle.close();}if(await fs.readFile(this.plan,'utf8')!==previous){await fs.rm(temporary,{force:true});throw Error('Plan Tree changed during archival; retry without overwriting user edits');}await fs.rename(temporary,this.plan);}
    if(process.platform!=='win32')for(const target of [directory,path.join(directory,'reports')]){const handle=await fs.open(target,'r');try{await handle.sync();}finally{await handle.close();}}
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
