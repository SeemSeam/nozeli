import {createHash} from 'node:crypto';
import {manualControlProjection,workControlCapabilitiesFromState,workControlHeldFor} from './work-control.mjs';
const fail=code=>Object.assign(Error(code),{code});
const label=value=>typeof value==='string'?value.slice(0,128):null;
const identity=value=>typeof value==='string'&&value.length<=512?value:null;
const selector=value=>{const model=typeof value==='string'?value:value?.model;return typeof model==='string'&&model.length<=512?{model,effort:typeof value?.effort==='string'?value.effort:null}:null;};
const activeJob=job=>['queued','running','transferring'].includes(job.status);
const heldWork=work=>['pending','replanned'].includes(work?.deviation?.status);
const visibleWork=work=>work.status!=='ended'||work.closure&&work.closure.phase!=='complete';
const names={frontdesk:'前台',orchestrator:'主控'};
const labels={unloaded:'未连接', 'not-started':'未启动',sleeping:'休眠 · 按需恢复',idle:'待命',starting:'准备中',running:'执行中',tool:'使用工具',compacting:'整理上下文',retrying:'连接重试中',waiting:'需要处理',queued:'排队中',settling:'保存结果中',review:'结果待审阅',paused:'已暂停',ended:'已结束',stopping:'正在停止',unknown:'状态待核实',failed:'连接失败',configuring:'正在应用设置'};
labels.closing='决定已记录 · 等待收尾';
// Wall time for one exact accepted round, never accumulated model/CPU time.
const timestamp=(value,now)=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return null;const ms=Date.parse(value);return Number.isFinite(ms)&&ms>=0&&ms<=now?ms:null;};
const relevantJob=(job,target,work)=>Boolean(identity(job.id))&&job.target===target&&(!work||Number.isSafeInteger(work.revision)&&job.revision===work.revision);
function roundTiming({jobs,current,work,target,primaryState,session,facts,live,coldJobs,now,observedAt}){
 const empty={jobId:null,kind:'unavailable',startedAt:null,endedAt:null,queuedAt:null,elapsedMs:null,advancing:false,observedAt};
 if(!live)return empty;
 const relevant=jobs.filter(job=>relevantJob(job,target,work));
 const exact=current&&relevant.find(job=>job.id===current.id&&job.target===current.target&&job.revision===current.revision);
 const executing=relevant.filter(job=>['running','transferring'].includes(job.status));
 const active=exact??(!current&&executing.length===1?executing[0]:null);
 if(active&&['running','transferring'].includes(active.status)){
  const started=timestamp(active.startedAt,now),safe=session&&!session.closed&&facts?.known===true&&!coldJobs?.has(active.id)&&(!work||work.status==='running')&&!manualControlProjection(work).paused&&active.finishedAt==null&&active.completedAt==null&&['running','tool','compacting','retrying','settling','starting'].includes(primaryState);
  return {...empty,jobId:identity(active.id),...(safe&&started!==null?{kind:'running',startedAt:new Date(started).toISOString(),elapsedMs:now-started,advancing:true}:{})};
 }
 if(['queued','waiting','paused'].includes(primaryState)){
  const queued=relevant.filter(job=>job.status==='queued'&&!coldJobs?.has(job.id)).sort((a,b)=>(timestamp(a.createdAt??a.at,now)??Infinity)-(timestamp(b.createdAt??b.at,now)??Infinity))[0];
  if(queued){const at=timestamp(queued.createdAt??queued.at,now);return {...empty,jobId:identity(queued.id),kind:'queued',queuedAt:at===null?null:new Date(at).toISOString()};}
  if(work?.status==='queued'){const at=timestamp(work.createdAt,now);return {...empty,kind:'queued',queuedAt:at===null?null:new Date(at).toISOString()};}
 }
 if(!['idle','sleeping','not-started','review','paused','ended','waiting','failed'].includes(primaryState))return empty;
 // A later successful round supersedes historical failures; no fallback to an
 // older completed duration when the latest finished round lacks valid facts.
 let latest=null,latestAt=-Infinity;
 for(const job of relevant){if(!['completed','failed','interrupted','cancelled'].includes(job.status))continue;const at=timestamp(job.finishedAt??job.completedAt,Infinity)??timestamp(job.startedAt,Infinity)??timestamp(job.createdAt??job.at,Infinity);if(at!==null&&at>=latestAt){latest=job;latestAt=at;}}
 if(!latest)return empty;
 const started=timestamp(latest.startedAt,now),ended=timestamp(latest.finishedAt??latest.completedAt,now);
 return {...empty,jobId:identity(latest.id),...(started!==null&&ended!==null&&ended>=started?{kind:'completed',startedAt:new Date(started).toISOString(),endedAt:new Date(ended).toISOString(),elapsedMs:ended-started}:{})};
}
export function collaborationProjection({projectId,instanceId,controller=null,recorded=null,slots=[],capacityAvailable=null,enabled=false,connecting=false,connectionError=null,limit=24,cursor=null,modelOptions=new Map()}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>50||cursor&&typeof cursor!=='string'||typeof projectId!=='string')throw fail('COLLABORATION_PAGE_INVALID');
 const state=controller?.store?.state,live=Boolean(controller),works=state?.works??recorded?.works??[],residents=state?.residents??recorded?.residents??{};
 const now=Date.now(),observedAt=new Date(now).toISOString();
 // 纯读控制事实：人工门/回执来自 works/jobs 记录本身，冷开（recorded）同样成立。
 const pureState={works,jobs:state?.jobs??[]};
 const jobs=state?.jobs??[],byTarget=new Map();let legalQueued=0,executing=0,coldCount=0,heldQueuedCount=0;
 const hash=createHash('sha256').update(JSON.stringify([projectId,instanceId,live,enabled,connecting,connectionError?.code??null,controller?.stopping??false,!!controller?.store?.commitUnknown,!!controller?.store?.nativeCommitUnknown,recorded?.revision??null]));
 // Hash persisted timing inputs, not elapsed wall time: page cursors survive ticks.
 for(const job of jobs)hash.update(JSON.stringify([job.id,job.target,job.revision??null,job.status,job.createdAt??null,job.at??null,job.startedAt??null,job.finishedAt??null,job.completedAt??null]));
 for(const [target,job] of controller?.current??[])hash.update(JSON.stringify(['current-job',target,job?.id,job?.target,job?.revision??null]));
 for(const job of jobs){if(!activeJob(job))continue;const cold=controller.coldJobs?.has(job.id),held=workControlHeldFor(pureState,job);if(cold)coldCount++;else if(job.status==='queued'){if(held)heldQueuedCount++;else legalQueued++;}else executing++;let rows=byTarget.get(job.target);if(!rows)byTarget.set(job.target,rows=[]);rows.push(job);hash.update(JSON.stringify([job.id,job.target,job.status,cold===true,held===true,job.resourceBlocked===true,job.context?.pendingIntakeId??null]));}
 const projectSlots=slots.filter(slot=>slot.projectId===projectId),providers=recorded?.providers??Object.keys(state?.providers??{}).map(target=>({target}));
 let totalWorks=0,recordedRunning=recorded?.recordedRunning===true,waitingCount=recorded?.waitingCount??0;for(const work of works){if(!visibleWork(work))continue;totalWorks++;if(!live&&work.status==='running')recordedRunning=true;if(live&&['review','paused','ended','closing'].includes(work.status))waitingCount++;const manual=manualControlProjection(work);hash.update(JSON.stringify([work.id??work.target,work.name,work.status,work.revision,work.threadId,heldWork(work),work.readOnly===true,work.closure?.phase??null,manual.controlVersion,manual.paused,manual.stop?.state??null]));}
 for(const work of works)hash.update(JSON.stringify(['work-timing',work.id??work.target,work.createdAt??null,controller?.coldQueued?.has(work.id??work.target)===true]));
 const serviceFault=controller?.serviceFaultSummary?.()??null;if(serviceFault)hash.update(JSON.stringify([serviceFault.held??false,serviceFault.count??0]));
 const faultGates=new Map();for(const target of ['frontdesk','orchestrator',...works.map(work=>work.id??work.target)]){const held=Boolean(controller?.serviceFaultGate?.({target})?.held);faultGates.set(target,held);hash.update(JSON.stringify(['service-fault',target,held]));}
 const activity=new Map();
 for(const [target,session] of controller?.sessions??[]){
  const facts=session.activitySnapshot?.()??null;activity.set(target,facts);
  hash.update(JSON.stringify([target,session.viewOwnerId,session.closed,session.busy,session.phase,facts?.activityRevision??null,facts?.known??null,session.model,session.desiredModel,session.pendingModel,session.modelError?.code??null]));
 }
 for(const slot of projectSlots)hash.update(JSON.stringify([slot.target,slot.state]));
 for(const key of ['starting','restarting','reclaiming','configuring','nativeDraftTargets','externalTerminalTargets','current','running'])for(const target of controller?.[key]?.keys?.()??controller?.[key]??[])hash.update(JSON.stringify([key,target]));
 hash.update(JSON.stringify([controller?.closures?.size??0,!!controller?.mergeDrain,[...(controller?.hostOperations??[])],[...(controller?.maintenanceFlights?.keys?.()??[])],providers.map(value=>value.target),(state?.backstageEvents??[]).map(event=>[event.key,event.status,event.jobId])]));
 const revision=hash.digest('hex');let after='';if(cursor){try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString());if(value.projectId!==projectId||value.instanceId!==instanceId||value.revision!==revision||typeof value.after!=='string')throw Error();after=value.after;}catch{throw fail('COLLABORATION_CURSOR_STALE');}}
 const rows=[];const targetRows=(target,work)=>{
  const session=controller?.sessions?.get(target),facts=activity.get(target),resident=residents[target],threadId=identity(session?.threadId??work?.threadId??resident?.threadId),slot=projectSlots.find(value=>value.target===target),registered=providers.find(value=>value.target===target),targetJobs=byTarget.get(target)??[],eligible=targetJobs.filter(job=>!controller?.coldJobs?.has(job.id)&&!workControlHeldFor(pureState,job)),cold=targetJobs.some(job=>controller?.coldJobs?.has(job.id)),targetHeld=targetJobs.filter(job=>job.status==='queued'&&workControlHeldFor(pureState,job)).length;
  const storageUnknown=!!controller?.store?.commitUnknown||!!controller?.store?.nativeCommitUnknown;
  const unconfirmed=slot?.state==='unconfirmed'||!!registered&&(!session||session.closed)||session?.closed&&slot!=null;
  let primaryState=live?(threadId?'sleeping':'not-started'):(threadId?'sleeping':'unloaded'),reason=null,protectedActivity=false;
  const running=controller?.running?.has(target)||controller?.current?.has(target),starting=controller?.starting?.has(target)||controller?.restarting?.has(target);
  if(unconfirmed||storageUnknown||session&&!session.closed&&facts&&facts.known!==true){primaryState='unknown';reason=storageUnknown?'存储提交结果待核对':'原生状态或退出尚未核实';protectedActivity=true;}
  else if(starting||connecting&&!session){primaryState='starting';protectedActivity=true;}
  else if(controller?.reclaiming?.has(target)||controller?.stopping&&session&&!session.closed){primaryState='stopping';protectedActivity=true;}
  else if(session&&!session.closed){
   primaryState='idle';
   if(facts?.interactionCount>0||session.interactions?.length){primaryState='waiting';reason='原生交互待处理';protectedActivity=true;}
   else if(facts?.compaction||session.phase==='compacting'){primaryState='compacting';protectedActivity=true;}
   else if(facts?.retry){primaryState='retrying';protectedActivity=true;}
   else if(facts?.toolCount>0||facts?.hostToolCount>0||session.inFlightToolCalls?.size){primaryState='tool';protectedActivity=true;}
   else if(facts?.configuration||facts?.command||controller?.configuring?.has(target)){primaryState='configuring';protectedActivity=true;}
   else if(facts?.promptPreparing){primaryState='starting';protectedActivity=true;}
   else if(facts?.settling||facts?.nativeDrainPending>0||running&&!session.busy){primaryState='settling';protectedActivity=true;}
   else if(session.busy||facts?.runActive||running){primaryState='running';protectedActivity=true;}
  }else if(running){primaryState='starting';protectedActivity=true;}
  if(!protectedActivity){
   if(heldWork(work)){primaryState='paused';reason='任务偏离待决定';}
   else if(manualControlProjection(work).paused){primaryState='paused';reason='任务已人工暂停，输入保留';}
   else if(work?.status==='queued'&&controller?.coldQueued?.has(target)){primaryState='paused';reason='冷恢复任务待核查，不自动执行';}
   else if(cold&&!eligible.length){primaryState='paused';reason='冷恢复输入待核查，不自动重放';}
   else if(eligible.length){primaryState='queued';reason=controller?.nativeDraftTargets?.has(target)?'未发送原生草稿阻断':eligible.some(job=>job.context?.pendingIntakeId&&jobs.some(parent=>parent.id===job.context.pendingIntakeId&&activeJob(parent)))?'等待原交接处理':!session&&capacityAvailable===false?'等待运行名额':'等待已接受输入';}
   else if(work?.status==='queued'){primaryState='queued';reason=live?'等待工作运行名额':'已保存排队任务，未连接执行服务';}
   else if(work?.status==='review')primaryState='review';
   else if(work?.status==='paused')primaryState='paused';
   else if(work?.status==='ended'||work?.status==='closing'){primaryState=work.status;if(work.closure?.phase!=='complete')reason=work.needsReconciliation?.message??'工作决定已记录，技术收尾尚未完成';}
   else if(connectionError&&(!connectionError.target||connectionError.target===target)&&!session){primaryState='failed';reason='连接或恢复失败，原输入保留';}
  }
  if(controller?.nativeDraftTargets?.has(target))reason??='存在未发送原生草稿';
  if(controller?.externalTerminalTargets?.has(target))reason??='终端正在使用';
  if(!live&&work?.status==='running'){primaryState='unknown';reason='已保存执行记录，不证明当前仍在运行';protectedActivity=true;}
  const options=modelOptions.get(target),effective=options?selector(options.effective):session&&!session.closed&&facts?.known!==false?selector(session.effective??session.model):null,lastEffective=selector(options?.recorded??resident?.model??work?.model),desired=options?.desired??(session?.pendingModel?{model:session.desiredModel,effort:session.pendingModel.effort??null}:null);
  if(['submitted','unknown'].includes(options?.state)){primaryState='unknown';reason='模型配置结果待核实，不自动重试';protectedActivity=true;}
  const readOnly=work?.readOnly===true||work?.readOnly===1||work?.provider&&work.provider!=='pi'||work?.binding?.provider&&work.binding.provider!=='pi';
  const controlFacts=work?workControlCapabilitiesFromState(pureState,{workId:work.id??work.target},{projectId,live:live&&controller?.stopping!==true,storageUnknown,lifecycleHeld:controller?.stopping===true||!!controller?.store?.lifecycleHold,ownerBinding:session&&!session.closed?{ownerId:session.viewOwnerId,ownerGeneration:session.epoch,currentJobId:controller?.current?.get(target)?.id??null,workRevision:work.revision??null}:null}):null;
  const serviceFaultHeld=faultGates.get(target)===true;
  if(serviceFaultHeld&&!protectedActivity&&!['paused','review','closing','ended','failed'].includes(primaryState)){primaryState='waiting';reason='服务故障待处理，输入与原线程保留';}
  const timing=roundTiming({jobs,current:controller?.current?.get(target),work,target,primaryState,session,facts,live,coldJobs:controller?.coldJobs,now,observedAt});
  const latestJob=timing.jobId?jobs.find(job=>job.id===timing.jobId&&relevantJob(job,target,work)):null;
  if(!protectedActivity&&!reason&&['idle','sleeping','not-started'].includes(primaryState)&&latestJob?.status==='failed'){primaryState='waiting';reason='本轮执行失败，原输入与线程保留';}
  const activityText=reason??(latestJob?.status==='completed'?'本轮结果已保存':primaryState==='review'?'当前结果待审阅':primaryState==='queued'?'已接受输入，等待执行':labels[primaryState]);
  const row={target,role:names[target]?target:'worker',displayName:names[target]??'工作 Agent',workId:work?.id??work?.target??null,workRevision:work?.revision??null,workName:label(work?.name),workStatus:work?.status??null,primaryState,stateLabel:labels[primaryState],activityText:reason,blockReason:reason,protectedActivity,queuedCount:eligible.filter(job=>job.status==='queued').length,heldQueuedCount:targetHeld,manualControl:work?manualControlProjection(work):null,serviceFaultHeld,ownerId:identity(session?.viewOwnerId),ownerGeneration:identity(session?.epoch),threadId,readOnly:Boolean(readOnly),model:{effective,lastEffective,desired,syncState:options?.state??(session?.modelError?'failed':desired?'pending':effective?'applied':'recorded'),configurationRevision:options?.revision??0},capabilities:{select:true,model:!readOnly&&primaryState!=='unknown'&&!controller?.stopping,send:!readOnly&&!['unknown','stopping','closing','ended'].includes(primaryState)&&!storageUnknown,respond:primaryState==='waiting',...(controlFacts?{pause:controlFacts.pause,stopCurrent:controlFacts.stopCurrent,resume:controlFacts.resume,stopBinding:controlFacts.binding}:{pause:{allowed:false,reason:'unknown-target'},stopCurrent:{allowed:false,reason:'unknown-target'},resume:{allowed:false,reason:'unknown-target'},stopBinding:null})},freshness:{source:live?'live':'recorded',known:primaryState!=='unknown',activityRevision:facts?.activityRevision??null}};
  row.timing=timing;
  row.activityText=activityText;
  return row;
 };
 const residentsRows=['frontdesk','orchestrator'].map(target=>targetRows(target,null));let protectedCount=residentsRows.filter(row=>row.protectedActivity).length;
 const selected=[];for(const work of works){if(!visibleWork(work))continue;const target=work.id??work.target;if(!identity(target))throw fail('COLLABORATION_ID_INVALID');const row=targetRows(target,work);if(row.protectedActivity)protectedCount++;if(target>after){let at=selected.findIndex(item=>item.target>target);if(at<0)at=selected.length;selected.splice(at,0,row);if(selected.length>limit+1)selected.pop();}}
 const more=selected.length>limit;if(more)selected.pop();rows.push(...residentsRows,...selected);
 const unknownSlots=projectSlots.some(slot=>slot.state==='unconfirmed')||providers.some(value=>!controller?.sessions?.get(value.target)||controller.sessions.get(value.target).closed)||recorded?.providersTruncated;
 const pendingEvents=(state?.backstageEvents??[]).filter(event=>event.status==='queued'&&jobs.some(job=>job.id===event.jobId&&activeJob(job)&&!controller?.coldJobs?.has(job.id))).length;
 const pendingTechnicalOperations=(controller?.closures?.size??0)+(controller?.mergeDrain?1:0)+(controller?.hostOperations?.size??0)+(controller?.maintenanceFlights?.size??0);
 const projectKeepsRunning=protectedCount>0||legalQueued>0||executing>0||pendingEvents>0||pendingTechnicalOperations>0||unknownSlots||recordedRunning||connecting;
 const result={schema:1,projectId,enabled,revision,agents:rows,totalAgents:(recorded?.totalWorks??totalWorks)+2,nextCursor:more?Buffer.from(JSON.stringify({projectId,instanceId,revision,after:selected.at(-1).target})).toString('base64url'):null,project:{state:projectKeepsRunning?'active-runtime':waitingCount||rows.some(row=>['waiting','failed'].includes(row.primaryState))?'waiting':'resident-idle',projectKeepsRunning:Boolean(projectKeepsRunning),protectedCount,pendingAcceptedJobs:legalQueued,heldQueuedJobs:heldQueuedCount,...(serviceFault?{serviceFault:{held:serviceFault.held===true,count:serviceFault.count??0}}:{}),pendingDependencyEvents:pendingEvents,pendingTechnicalOperations,coldJobs:coldCount,unknownOwners:Boolean(unknownSlots),recordedRunning},freshness:live?'live':'recorded',observedAt};
 if(Buffer.byteLength(JSON.stringify(result))>64*1024)throw fail('COLLABORATION_PAGE_TOO_LARGE');return result;
}
