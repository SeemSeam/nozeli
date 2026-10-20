import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { processStamp, ownerAlive } from './process-ownership.mjs';
import {artifactSnapshot,digest} from './report-review.mjs';
import {reconcileTodos} from '../../domain/todo-management.mjs';
import {safeBytes} from './execution-workspace.mjs';
import {recordBusinessTimeline} from './session-index.mjs';

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
      try{store.state=JSON.parse(await fs.readFile(store.file,'utf8'));if(store.state.schema!==2||store.state.contentRoot!==content)throw new Error('incompatible workspace');}
      catch(error){if(error.code!=='ENOENT')throw error;store.state={schema:2,workspaceId:randomUUID(),contentRoot:content,limit:1,works:[],todos:[],receipts:[],memoryPending:[]};await store.save();}
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
  async reportDeviation(id,job,{changedGoal,reason,progress},receipt){return this.mutate(async()=>{
    const w=this.find(id),old=this.state.receipts.find(r=>r.id===receipt);
    if(old){if(old.workId!==id||old.sourceJobId!==job.id||old.deviation?.changedGoal!==changedGoal||old.deviation?.reason!==reason||old.deviation?.progress!==progress)throw Error('deviation receipt collision');return structuredClone(old.deviation);}
    if(w.status!=='running'||w.revision!==job.revision||this.deviationHeld(id))throw Error('stale or inactive deviation source');
    for(const value of [changedGoal,reason,progress])if(typeof value!=='string'||!value.trim()||value.length>32000)throw Error('invalid deviation report');
    const sourceJob=this.state.jobs.find(j=>j.id===job.context?.sourceJobId)||this.state.jobs.find(j=>j.id===job.id);
    if(!sourceJob)throw Error('missing admitted deviation source');
    const sourceText=job.context?.approvedSourceText??sourceJob.text,at=new Date().toISOString(),objectId=randomUUID(),todoId=randomUUID();
    const event={id:randomUUID(),revision:w.revision,version:1,status:'pending',changedGoal,reason,progress,admittedJobId:job.id,sourceJobId:sourceJob.id,sourceText,source:`state.json#job:${sourceJob.id}`,sourceContext:structuredClone(sourceJob.context||{}),todoId,objectId,at};
    const body=`# 任务偏离：等待用户决定\n\n## 原始任务\n${w.request}\n\n## 触发输入（尚未执行）\n${sourceText}\n\n来源作业：${sourceJob.id}\n\n## 拟改变的目标\n${changedGoal}\n\n## 偏离原因\n${reason}\n\n## 已有进展与未执行部分\n${progress}\n\n工作已暂停；只有用户明确选择继续本工作或交主控重新规划后才处理。`;
    await fs.writeFile(path.join(this.root,'objects',objectId+'.md'),body,{flag:'wx',mode:0o600});
    if(w.deviation){w.deviationHistory??=[];w.deviationHistory.push(structuredClone(w.deviation));}
    w.deviation=event;w.status='paused';w.problem={objectId,revision:w.revision};
    const row={id:receipt,workId:id,revision:w.revision,kind:'problem',text:body,objectId,sourceJobId:job.id,deviation:structuredClone(event),at};this.state.receipts.push(row);this.projectReceipt(row,{jobId:job.id});
    this.state.todos.push({id:todoId,workId:id,revision:w.revision,kind:'deviation',status:'open',sourceJobId:sourceJob.id,objectId,deviationId:event.id,expectedVersion:1,text:body});
    return structuredClone(event);
  });}
  async mutate(fn){
    if(this.closed||this.closing)throw new Error('workspace closed');
    const run=this.serial.then(async()=>{if(this.closed)throw new Error('workspace closed');const prior=structuredClone(this.state);try{const result=await fn();reconcileTodos(this.state,prior);recordBusinessTimeline(prior,this.state);await this.save();return result;}catch(error){this.state=prior;throw error;}});
    this.serial=run.catch(()=>{});return run;
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
  async publish(id,revision,kind,text,receipt,{jobId,files=[],changeSetId=null}={}){return this.mutate(async()=>{
    const w=this.find(id);
    if(!['problem','result'].includes(kind)||!text?.trim())throw new Error('invalid publication');
    const old=this.state.receipts.find(x=>x.id===receipt);if(old){if(old.workId!==id||old.revision!==revision||old.text!==text||old.kind!==kind||changeSetId&&old.changeSetId!==changeSetId)throw new Error('receipt collision');this.projectReceipt(old,{jobId});return old;}
    if(w.revision!==revision||w.status!=='running')throw new Error('stale or inactive run');
    const objectId=randomUUID();const file=path.join(this.root,'objects',`${objectId}.md`);await fs.writeFile(file,text,{flag:'wx',mode:0o600});
    const paths=[...files.map(f=>f.relPath),...(this.state.fileOperations||[]).filter(o=>o.workId===id).map(o=>o.relPath)];
    const snapshot=kind==='result'?{reportDigest:digest(Buffer.from(text)),directory:w.execution?.directory||this.content,candidate:structuredClone(w.execution?.candidate||null),files:await artifactSnapshot(w.execution?.directory||this.content,[...paths,...(w.execution?.candidate?.files||[])]),operationIds:(this.state.fileOperations||[]).filter(o=>o.workId===id).map(o=>o.id)}:undefined;
    if(snapshot){snapshot.artifactDirectory=path.join(this.root,'objects','artifacts',objectId);for(const entry of snapshot.files)if(entry.digest!==null){const target=path.join(snapshot.artifactDirectory,entry.relPath);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});const bytes=await safeBytes(snapshot.directory,entry.relPath);if(bytes===null||digest(bytes)!==entry.digest)throw Error('artifact changed during publication');const handle=await fs.open(target,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}}
    const row={id:receipt,workId:id,revision,kind,text,objectId,at:new Date().toISOString(),...(jobId?{sourceJobId:jobId,jobId}:{}),...(changeSetId?{changeSetId}:{}),...(snapshot?{snapshot}:{})};this.state.receipts.push(row);
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
      const relPath=`reports/${id}.md`,file=path.join(path.dirname(this.plan),relPath);
      const source=this.state.receipts.findLast(r=>r.workId===id&&r.revision===w.revision&&r.kind==='result')||this.state.receipts.findLast(r=>r.workId===id&&r.kind==='problem');
      let bytes,kind,sourceRef;
      if(source){bytes=await fs.readFile(path.join(this.root,'objects',source.objectId+'.md'));if(source.snapshot?.reportDigest&&digest(bytes)!==source.snapshot.reportDigest)throw Error('immutable Worker report digest mismatch');kind=source.kind==='result'?'worker-report':'worker-problem';sourceRef=`objects/${source.objectId}.md`;}
      else{kind='host-termination';sourceRef=`state.json#work:${id}`;bytes=Buffer.from(`# Host termination record\n\nWork: ${w.name||id}\nDecision: ${closure.decision||'unknown (legacy)'}\nEnded: ${w.endedAt}\nProvider stopped: confirmed\nNo final Worker result report exists for revision ${w.revision}. This record is not a successful completion report.\nSource: ${sourceRef}\n`);}
      if(closure.report){const existing=await fs.readFile(file);if(digest(existing)!==closure.report.digest)throw Error('archived report changed');return closure.report;}
      await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
      try{const handle=await fs.open(file,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}catch(error){if(error.code!=='EEXIST')throw error;if(!bytes.equals(await fs.readFile(file)))throw Error('existing archived report differs');}
      closure.report={relPath,digest:digest(bytes),kind,source:sourceRef,revision:w.revision,at:new Date().toISOString(),...(kind==='worker-report'?{summary:bytes.toString('utf8').split(/\n\s*\n/).map(s=>s.replace(/^#{1,6}\s+[^\n]*\n?/gm,'').trim()).find(Boolean)?.replace(/\s+/g,' ').slice(0,240)||''}:{})};
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
