import './management-presentation.css';
import { appendDrawingMaterial } from '../domain/drawing-delivery.mjs';
import {createSessionStore,sessionMessages} from './session-store.mjs';
import {createIdentityHydration,createProjectFiles,bindComposerDrafts} from './surface-identity-state.mjs';
import {resolveConversationInput,conversationTargetReason} from './conversation-input-state.mjs';
import {mountArchivePages as renderArchivePages} from './archive-pages.mjs';
import {mountSessionTimeline} from './session-timeline.mjs';
import {renderConfigurationNotice} from './configuration-notice.mjs';
import {deviationHeld} from '../domain/work-deviation.mjs';
import {mountFrontdeskRoutes,frontdeskRouteText} from './frontdesk-routes.mjs';
import {mountSessionRuntimeControls} from './session-model-controls.mjs';
import {renderTagMarkdown} from './tag-markdown.mjs';
import {mountStaticReport} from './isolated-surfaces.mjs';
import {renderClosureStatus as renderCompletedClosureStatus} from './curation-message.mjs';
import {managedWorkRecords,managedReviewTodos,managedInboxTodos,resultSettlementIssue,openMergeConstraintTodo,intakeSystemFault,publicationOrdinal,publicationHumanEdited} from '../domain/managed-work-records.mjs';
import {renderMergeConstraintCard} from './merge-constraint.mjs';
import {managedProgress} from './managed-progress.mjs';
import {readFileAvailability,availabilityCaption} from './file-availability.mjs';
import {mountManagedTodos} from './managed-todos.mjs';
import {mountContextMenu} from './context-menu.mjs';
import {mountAttentionDialogue} from './attention-dialogue.mjs';
import {mountManagedReview,flushManagedReviews,mountReviewDetail} from './managed-review.mjs';
import {appendReviewFileIdentity,reviewDiffUnavailable} from './managed-review-files.mjs';
import {reviewInlineAvailable} from './managed-review-availability.mjs';
import './managed-agent-panel.css';
import {mountProblemDecision} from './problem-decision.mjs';
import {mountCollaborationStatus} from './collaboration-status.mjs';
import {mountWorkControl} from './managed-work-control.mjs';
import {mountServiceFaults} from './managed-service-faults.mjs';
import {workRecordCategory,workRecordControlTarget,workDispositionNotice} from './managed-work-directory.mjs';
import {renderWorkOverview,renderRequestOverview} from './managed-work-overview.mjs';
import {mountWorkProgress} from './managed-work-progress.mjs';
import {taskIdentityKey,taskIdentityTone} from '../domain/task-identity.mjs';
const $=id=>document.getElementById(id);
const labels={frontdesk:'前台',orchestrator:'Orchestrator',worker:'工作 Agent'};
const phases={queued:'排队中',running:'执行中',paused:'待回答/处理',review:'结果待审查',closing:'审核已决定 · 收尾未完成',ended:'已结束'};

function closureProcessingStatus(work){
 return work?.closure?.phase==='blocked'?'决定已记录 · 故障已记录，由后台维护处理':'决定已记录 · 系统正在完成收尾';
}
function renderClosureStatus(parent,work){
 if(work?.status!=='closing')return renderCompletedClosureStatus(parent,work);
 const status=document.createElement('p');status.setAttribute('role','status');status.textContent=closureProcessingStatus(work);parent.append(status);
 const retained=document.createElement('p');retained.textContent='原决定、报告与未发送意见保留；系统继续处理原任务收尾，不重放 Worker。';parent.append(retained);
}

// Version details retain viewed preps; opening them never re-fixes a baseline.
async function renderWorkVersions({box,record,projectId,call}){
 if(!box.isConnected||!box.closest('dialog')?.open)return;
 if(box.closest('[data-work-overview-technical]')?.open===false)return;
 const signature=record.workId?`${record.workId}:${record.status}`:'';
 if(record.status!=='review'){if(box.dataset.signature){box.dataset.signature='';box.replaceChildren();}return;}
 // Refetch until this work has at least one checkpoint: the first review-time
 // render may race the (retryable) checkpoint publication.
 if(box.dataset.signature===signature&&box.dataset.empty!=='1')return;
 // 状态事件停稳后面板不会再重渲；空态（检查点可能仍在重试发布）按 3s 有界
 // 自轮询补齐，直到该工作出现首个检查点。
 if(box.dataset.signature===signature&&box.dataset.empty==='1'&&!box.dataset.polling){
  box.dataset.polling='1';
  setTimeout(()=>{delete box.dataset.polling;if(box.isConnected&&box.closest('dialog')?.open){box.dataset.signature='';void renderWorkVersions({box,record,projectId,call});}},3000);
 }
 // 记住已展开的检查点条目：后台补齐/刷新重建节点时不收起用户展开的对比。
 const openStates=new Map([...box.querySelectorAll('.managed-work-version')].map(d=>[d.querySelector('summary')?.textContent||'',d.open]));
 box.dataset.signature=signature;
 box.replaceChildren();
 const head=document.createElement('p');head.className='managed-work-versions-title';head.textContent='版本检查点（Git 影子仓）';box.append(head);
 let data;
 try{data=await call('versions.list',{projectId});}
 catch(error){box.append(Object.assign(document.createElement('p'),{className:'managed-work-versions-note',textContent:'版本检查点列表不可用：'+error.message}));return;}
 window.__verFetchDebug={workId:record.workId,raw:(data.checkpoints||[]).map(item=>item.workId),pending:(data.pending||[]).length};
 const pending=(data.pending||[]).filter(item=>item.requestId.startsWith(`work:${record.workId}:`));
 const checkpoints=(data.checkpoints||[]).filter(item=>item.workId===record.workId);
 if(pending.length)box.append(Object.assign(document.createElement('p'),{className:'managed-work-versions-note',textContent:'有未完成的版本检查点，将在下次状态刷新自动补齐。'}));
 if(!checkpoints.length&&!pending.length){box.dataset.empty='1';box.append(Object.assign(document.createElement('p'),{className:'managed-work-versions-note',textContent:'尚无版本检查点。'}));return;}
 box.dataset.empty='0';
 for(const checkpoint of checkpoints.slice(0,5)){
  const details=document.createElement('details');details.className='managed-work-version';
  const files=Object.keys(checkpoint.docs||{});
  const summary=document.createElement('summary');
  summary.textContent=`${new Date(checkpoint.committedAt).toLocaleString()} · ${files.length} 个文件`;
  details.append(summary);
  const body=document.createElement('div');body.className='managed-work-version-body';details.append(body);
  const preps=new Map(); // relPath → prepId，来自用户实际点击过的对比
  const note=()=>body.querySelector('.managed-work-versions-note:last-of-type');
  for(const relPath of files){
   const fileRow=document.createElement('div');fileRow.className='managed-work-version-file';
   const diffButton=document.createElement('button');diffButton.type='button';diffButton.className='managed-work-version-diff-button';diffButton.textContent='对比 '+relPath;
   diffButton.addEventListener('click',async()=>{
    diffButton.disabled=true;
    try{
     const diff=await call('versions.diff',{projectId,commit:checkpoint.commit,relPath});
     preps.set(relPath,diff.prepId);
     fileRow.querySelector('.managed-work-version-diff')?.remove();
     const pre=document.createElement('pre');pre.className='managed-work-version-diff';
     pre.textContent=`--- 检查点 ${checkpoint.commit.slice(0,10)} · ${relPath}\n${diff.checkpointText}\n\n--- 当前磁盘（已同步最新输入，基线固化于本次对比）\n${diff.currentText??'(文件不存在)'}`;
     fileRow.append(pre);
     note()?.remove();
    }catch(error){fileRow.append(Object.assign(document.createElement('p'),{className:'managed-work-versions-note',textContent:'对比失败：'+error.message}));}
    finally{diffButton.disabled=false;}
   });
   fileRow.append(diffButton);body.append(fileRow);
  }
  const restore=document.createElement('button');restore.type='button';restore.className='managed-work-version-restore';restore.textContent='恢复到此检查点（受管回退）';
  restore.addEventListener('click',async()=>{
   restore.disabled=true;
   try{
    const missing=files.filter(relPath=>!preps.has(relPath));
    if(missing.length)throw Object.assign(new Error('请先逐个点击“对比”确认当前内容后，再恢复（将使用你看到的对比结果作为基线）：'+missing.join('、')),{code:'PREP_REQUIRED'});
    const result=await call('versions.restore',{projectId,commit:checkpoint.commit,relPaths:files,preps:Object.fromEntries(preps),operationId:'ui-restore-'+crypto.randomUUID()});
    const notes=document.createElement('p');notes.className='managed-work-versions-note';
    notes.textContent=result.failed
      ?`未全部恢复：成功 ${result.completed}，未生效 ${result.failed}；未生效文件保留当前内容（含未保存输入），请重新点击“对比”获取新基线后再确认恢复。`
      :`恢复完成：成功 ${result.completed}。`;
    body.append(notes);
   }catch(error){
    const again=error.message&&(error.code==='CONFLICT'||error.code==='PREP_REQUIRED'||error.code==='UNSAVED'||/重新对比|先对比/.test(error.message));
    body.append(Object.assign(document.createElement('p'),{className:'managed-work-versions-note',textContent:(again?'未恢复：':'恢复失败：')+error.message}));
   }
   finally{restore.disabled=false;}
  });
  body.append(restore);
  details.open=openStates.get(summary.textContent)||false;
  box.append(details);
 }
}
export function mountManagedAgent({invoke,toast,openManaged,onMessages=()=>{},openProjectFile,openExternal,openFrozenChange}){
 let projectId=null,active=false,ready=false,state=null,target='frontdesk',generation=0,refreshing=0,fixtureMode=false;
 const scope=window.__workspaceScope;
 const ownsConversation=!scope||(scope.role==='surface'&&scope.kind==='conversation');
 let pendingConversation=null;
 let inputIdentityReason='正在核对输入归属…',inputEpoch=0;
 if(!scope||scope.role==='shell'||scope.role==='surface'&&scope.kind==='report')window.__workspaceOpenTodo=async id=>{await refresh();return openTodo(id);};
 if(scope?.role==='surface'&&scope.kind==='history')window.__workspaceOpenHistory=report=>report.artifactPath?openArtifact({objectId:report.objectId,relPath:report.artifactPath,sourceProject:report.projectId}):report.workerArchive?openWorkerArchive(report.workerArchive.work,report.workerArchive.archive):openHistory({objectId:report.objectId,revision:report.revision,workName:report.workName||report.title,kind:report.kind},report.version);
 const sessionStore=createSessionStore();let historyPage=false,pageError='',timelineContext=null,contextKey='',pageRequest=0;
 let applyingTimeline=false;
 function applyTimeline(frame){applyingTimeline=true;try{sessionStore.apply(projectId,frame,{replace:true});}finally{applyingTimeline=false;}}
 const timelineBox=document.createElement('section');timelineBox.id='managed-session-timeline';$('conversation').insertBefore(timelineBox,$('reading-inbox'));
 const navigationContainer=document.createElement('div');navigationContainer.className='session-navigation-slot';$('conversation-panel').insertBefore(navigationContainer,$('compose-form'));
 const permissionSlot=scope?.role==='surface'&&scope.kind==='conversation'?document.createElement('section'):null;
 let permissionView=null;
 if(permissionSlot){permissionSlot.hidden=true;$('conversation').insertBefore(permissionSlot,$('reading-inbox'));}
 if(ownsConversation)$('conversation-panel').classList.add('session-surface');
 const timelineUI=mountSessionTimeline(timelineBox,{navigationContainer,initialScroll:scope?.viewState?.conversationScroll,onResult:async receipt=>{const todo=state?.todos.find(todo=>todo.objectId===receipt.objectId&&todo.workId===receipt.workId);if(todo)return openTodo(todo.id);return openHistory({...receipt,workName:state?.works.find(work=>work.id===receipt.workId)?.name||'任务'});}});
 const call=async(op,p={},id=projectId)=>{const r=await invoke('managed.'+op,{projectId:id,...p});if(!r.ok)throw Object.assign(new Error(r.error.message),{code:r.error.code});return r.value;};
 window.nozeli.subscribe('workspace.control',event=>{
  if(event.type!=='task-workspace'||event.projectId!==projectId)return;
  if(event.action==='locate'&&ownsConversation){const card=[...timelineBox.querySelectorAll('.session-task-card')].find(node=>event.workId?node.dataset.workflowWork===event.workId:node.dataset.workflowId==='workflow:intake:'+event.sourceJobId);if(card){card.scrollIntoView({block:'center',behavior:'instant'});card.tabIndex=-1;card.focus({preventScroll:true});}else toast('原卡不在当前历史页；请读取对应会话历史，不会跳转或改写当前页。');}
  else if(event.action==='inspect'&&scope?.role==='shell'){
   if(event.section==='report'&&event.workId)void openWorkReport(event.workId).catch(error=>toast(error.message));
   else if(event.section==='control'&&event.workId)inspectRetainedProgress(event.workId);
   else if(['details','versions'].includes(event.section)&&event.workId){inspectWork(event.workId);if(event.section==='versions'){const technical=workInfo.querySelector('[data-work-overview-technical]');if(technical)technical.open=true;}}
   else if(event.section==='request'&&event.sourceJobId){const record=managedWorkRecords(state).find(record=>record.jobIds?.includes(event.sourceJobId));if(record){const control=workRecordControlTarget(record,state);if(control)workControl.open(control);else inspectRequest(record);}}
  }
 });
 async function readTimeline(cursor){const id=projectId,gen=generation,request=++pageRequest;try{const frame=await call('timeline.page',{...(cursor?{cursor}:{}),limit:100},id);if(id!==projectId||gen!==generation||request!==pageRequest)return;historyPage=Boolean(cursor);pageError='';applyTimeline(frame);paintTimeline();}catch(error){if(id===projectId&&gen===generation){pageError=error.message;paintTimeline();}}}
 function paintTimeline(){if(!state)return;timelineBox.hidden=!active;const key=JSON.stringify([projectId,[...projectFilePaths]]);if(key!==contextKey){contextKey=key;timelineContext={filePaths:projectFilePaths,onFile:entry=>openProjectFile?.({projectId,...entry}),onExternal:openExternal,onError:error=>toast(error.message)};}timelineUI.render({store:sessionStore,state,context:timelineContext,call,openFrozenChange,projectId,historyPage,pageError,onPage:readTimeline,onLatest:()=>readTimeline(),onTask:entry=>{sourceMessage=entry.id;sourceBox.dataset.requestKey=crypto.randomUUID();sourceLabel.textContent='引用：'+entry.text.slice(0,160);sourceGoal.value='';sourceBox.hidden=false;sourceGoal.focus();}});}
 const identityReads=createIdentityHydration();
 const requestReads=new Map();
 const timelineSource={
  get projectId(){return projectId;},
  getMessages:()=>sessionMessages({...sessionStore.getLookupSnapshot(),entries:[...new Map([...identityReads.entries(),...sessionStore.getLookupSnapshot().entries].map(entry=>[entry.id,entry])).values()]},state),
  ensureMessage(id){
   const project=projectId,gen=generation;
   return identityReads.ensure(id,{has:key=>sessionStore.has(key),read:async key=>{const result=await call('timeline.read',{id:key},project);return result.entry||result;},pin:entry=>{if(project===projectId&&gen===generation)sessionStore.pin(entry);},onError:error=>{if(project===projectId&&gen===generation)toast('标签原消息无法读取：'+error.message);}});
  },
  ensureRequest(requestId){
   const project=projectId,gen=generation,key=project+':'+requestId;
   if(requestReads.has(key))return requestReads.get(key);
   const promise=(async()=>{let offset=0;do{const result=await call('timeline.request',{requestId,offset},project);if(project!==projectId||gen!==generation)return;await Promise.all(result.ids.map(id=>timelineSource.ensureMessage(id)));offset=result.nextOffset;}while(offset!=null);})();
   const settled=promise.catch(error=>{if(project===projectId&&gen===generation)toast('讨论历史读取失败：'+error.message);});requestReads.set(key,settled);return settled;
  },
  async readMessage(id,options={}){
   const project=projectId,gen=generation,result=await call('timeline.read',{id,...options},project);
   if(project!==projectId||gen!==generation)throw Error('项目已切换，请重新打开原文。');
   return result.entry||result;
  },
 };
 sessionStore.subscribe(()=>{if(active&&state){todoUI.messages(sessionStore.getSnapshot().entries,projectId);onMessages(timelineSource.getMessages(),timelineSource);if(!applyingTimeline)paintTimeline();}});
 const agentDetails=document.createElement('dialog');agentDetails.id='managed-agent-details';agentDetails.setAttribute('role','dialog');agentDetails.setAttribute('aria-modal','true');agentDetails.setAttribute('aria-labelledby','managed-agent-details-title');
 agentDetails.dataset.mode='connection';
 const agentDetailsTitle=document.createElement('h2');agentDetailsTitle.id='managed-agent-details-title';agentDetailsTitle.textContent='连接与历史';
 const agentDetailsBody=document.createElement('div');agentDetailsBody.className='managed-agent-details-body';
 const agentDetailsClose=document.createElement('button');agentDetailsClose.type='button';agentDetailsClose.textContent='关闭';agentDetailsClose.addEventListener('click',()=>agentDetails.close());
 agentDetails.append(agentDetailsTitle,agentDetailsBody,agentDetailsClose);document.body.append(agentDetails);
 agentDetailsBody.append($('ai-status'));
 const agentDetailsStatus=document.createElement('p');agentDetailsStatus.setAttribute('role','status');agentDetailsBody.prepend(agentDetailsStatus);
 window.addEventListener('nozeli-agent-details',()=>{
  agentDetailsStatus.textContent=projectId?'正在读取当前项目连接与历史…':'请先选择项目。';
  agentDetails.dataset.mode='connection';
  agentDetailsTitle.textContent='连接与历史';delete workInfo.dataset.workId;
  if(!agentDetails.open)agentDetails.showModal();
  if(projectId)void refresh().then(()=>{agentDetailsStatus.textContent='';}).catch(error=>{agentDetailsStatus.textContent='状态读取失败：'+error.message+'；原记录与草稿未改动。';});
 });
 const progressBox=document.createElement('section');progressBox.id='managed-progress';progressBox.setAttribute('aria-label','工作进展');progressBox.setAttribute('role','status');progressBox.hidden=true;agentDetailsBody.append(progressBox);let progressSignature=null;
 const identityNotice=document.createElement('section');identityNotice.id='managed-input-identity';identityNotice.hidden=true;identityNotice.setAttribute('role','status');$('conversation').insertBefore(identityNotice,$('reading-inbox'));
 const closureBox=document.createElement('section');closureBox.id='managed-closure-progress';closureBox.hidden=true;agentDetailsBody.append(closureBox);let closureSignature=null;
 const workInfo=document.createElement('section');workInfo.id='managed-current-work';workInfo.hidden=true;agentDetailsBody.append(workInfo);
 const requestInfo=document.createElement('section');requestInfo.id='managed-current-request';requestInfo.hidden=true;agentDetailsBody.append(requestInfo);
 const routeBox=document.createElement('section');routeBox.id='managed-frontdesk-routes';routeBox.hidden=true;routeBox.setAttribute('aria-label','前台去向决定');$('conversation-panel').insertBefore(routeBox,$('conversation'));
 const routeUI=mountFrontdeskRoutes({document,container:routeBox,invoke,refresh});
 let projectFilePaths=new Set(),fileAvailability=new Map(),availabilityKey=null,availabilityRequest=0;
 const refreshProjectFiles=createProjectFiles({list:id=>invoke('project.list',{projectId:id}),current:()=>({projectId,generation}),apply:paths=>{projectFilePaths=paths;paintTimeline();}});
 const drafts=new Map(),submissions=new Map(),submissionKeys=new Map(),retryKeys=new Map();let viewed=null,reportRequest=0;
 const recoveryPending=new Set();
 const attentionDrafts=new Map();let attentionView=null;
 const problemDrafts=new Map();
const mergePending=new Set(),mergeKeys=new Map(),mergeErrors=new Map();
const constraintVersion=todo=>todo?.constraintVersion;
function paintMergeConstraint(box,work,todo){
 renderMergeConstraintCard(box,{document,work,todo,pending:mergePending.has(projectId+':'+work.id),error:mergeErrors.get(projectId+':'+work.id)||'',choose:choice=>resolveMergeConstraint(work,todo,choice),...(workResultPublication(work)?{inspectReport:()=>openWorkReport(work.id)}:{})});
}
async function resolveMergeConstraint(work,todo,choice){
 const id=projectId,gen=generation,key=id+':'+work.id;
 if(!projectId||mergePending.has(key)||!Number.isSafeInteger(constraintVersion(todo)))return;
 if(choice==='never-commit'&&!window.confirm('确认禁止合入并保留此工作的原候选？\n以后合入需另行一次性批准。原报告、草稿与历史保留，不重开工作、不重放任务。'))return;
 const identity=JSON.stringify([id,work.id,todo.id,constraintVersion(todo),choice]),requestKey=mergeKeys.get(identity)||crypto.randomUUID();mergeKeys.set(identity,requestKey);
 mergePending.add(key);mergeErrors.delete(key);render();
 try{
  const result=await call('merge.constraint',{workId:work.id,expectedVersion:constraintVersion(todo),decision:choice,requestKey},id);
  if(result.workId!==work.id||result.status!==choice||!Number.isSafeInteger(result.version))throw Error('宿主未返回匹配的策略决定回执；请刷新核对原候选与收尾状态。');
  mergeKeys.delete(identity);await refresh();
 }catch(error){if(id===projectId&&gen===generation){mergeErrors.set(key,(error.code?error.code+'：':'')+error.message);try{await refresh();}catch{}}}
 finally{mergePending.delete(key);if(id===projectId&&gen===generation){render();for(const box of document.querySelectorAll('[data-merge-constraint-gate]')){const w=state.works.find(x=>x.id===box.dataset.mergeConstraintGate),t=w&&openMergeConstraintTodo(state,w.id);if(w&&t)paintMergeConstraint(box,w,t);else{box.replaceChildren();box.removeAttribute('data-merge-constraint-gate');const note=document.createElement('p');note.setAttribute('role','status');note.textContent='策略决定已记录；当前技术收尾：'+(w?.closure?.phase==='complete'?'已完成':w?.closure?.error||w?.closure?.phase||'请刷新查看');box.append(note);}}}}
}
function workResultPublication(work){
 if(!work)return null;
 const direct=work.result?.objectId?state.receipts.find(r=>r.objectId===work.result.objectId):null;
 if(direct)return direct;
 if(work.result?.objectId)return {objectId:work.result.objectId,workId:work.id,revision:work.result.revision??work.revision,kind:'result'};
 return state.receipts.findLast(r=>r.workId===work.id&&r.kind==='result')||null;
}
async function openWorkReport(workId){
 const work=state?.works.find(w=>w.id===workId);if(!work)return;
 const publication=workResultPublication(work);
 if(!publication){toast('原成果报告尚未持久化；可稍后从历史列表查看。');return;}
 if(agentDetails.open)agentDetails.close();
 const currentTodo=state.todos.find(t=>t.workId===work.id&&t.kind==='result'&&t.objectId===publication.objectId&&t.revision===work.revision);
 if(work.status!=='ended'&&publication.revision===work.revision&&currentTodo)return openTodo(currentTodo.id);
 return openHistory({objectId:publication.objectId,workId:work.id,workName:work.name||'工作',revision:publication.revision??work.revision??1,kind:'result'});
}
 function paintDeviation(box,work){
  box.replaceChildren(Object.assign(document.createElement('p'),{textContent:work?.readOnly?'历史工作只读；原会话、报告和草稿保留。':'后台正在核对任务范围；原工作、来源输入、已有进展和草稿保留，不会自动扩大范围或重放。'}));
 }
 const toolbar=document.createElement('div');toolbar.id='managed-todo-context';toolbar.setAttribute('role','status');toolbar.hidden=true;agentDetailsBody.append(toolbar);
 const configurationNotice=document.createElement('p');configurationNotice.id='managed-configuration-notice';configurationNotice.setAttribute('role','status');configurationNotice.hidden=true;agentDetailsBody.prepend(configurationNotice);
 const button=(text,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=()=>Promise.resolve(fn()).catch(e=>toast(e.message));return b;};
 let backgroundSubmitting=false;
 const backgroundSubmit=button('提交后台',async()=>{
  if(backgroundSubmitting||!ownsConversation||$('send-message').disabled)return;
  backgroundSubmitting=true;updateBackgroundSubmit();
  try{await window.__agentSend({background:true});}
  finally{backgroundSubmitting=false;updateBackgroundSubmit();}
 });
 backgroundSubmit.id='submit-background';backgroundSubmit.hidden=!ownsConversation;backgroundSubmit.disabled=true;
 $('send-message').before(backgroundSubmit);
 function updateBackgroundSubmit(){
  backgroundSubmit.disabled=!ownsConversation||backgroundSubmitting||$('send-message').disabled;
  backgroundSubmit.textContent=backgroundSubmitting?'正在提交…':'提交后台';
  backgroundSubmit.title=backgroundSubmitting?'正在等待宿主接收；草稿与材料尚未清除。':$('send-message').disabled?$('send-message').title:'将当前要求和材料直接交给主控创建后台任务，不先发送给前台。';
 }
 const collaboration=mountCollaborationStatus({root:$('conversation-panel')??$('conversation'),after:$('compose-form'),call,current:()=>ownsConversation&&active&&!fixtureMode&&!viewed?.history?{projectId,target}:null,onSelect:select,toast});
 const controlContext=()=>({projectId,generation});
 const workControl=mountWorkControl({call,current:controlContext,toast});
 const serviceFaults=mountServiceFaults({root:document.querySelector('.topbar'),invoke,current:()=>!scope||scope.role==='shell'?controlContext():null,onChange:()=>{if(active&&state)render();}});
 // 单层导航：从连接页进入故障页先关闭本模态；返回时恢复连接页与原入口焦点，不再叠两层管理模态。
 const faultDetails=button('服务故障与记录',()=>{const fromConnection=agentDetails.open,id=projectId;if(fromConnection)agentDetails.close();serviceFaults.open({onClosed:fromConnection?()=>{if(id===projectId&&!agentDetails.open){agentDetails.showModal();faultDetails.focus();}}:null});});agentDetailsBody.append(faultDetails);
 let clearingFrontdesk=false;
 const clearFrontdeskContext=button('清空前台上下文',async()=>{
  if(!ownsConversation||target!=='frontdesk'||!projectId||clearingFrontdesk)return;
  const id=projectId,gen=generation;clearingFrontdesk=true;clearFrontdeskContext.disabled=true;
  try{await draftWriter.settled();await call('frontdesk.context.clear',{},id);if(id!==projectId||gen!==generation)return;await refresh();await readTimeline();toast('前台上下文已清空；主控、工作和对话历史保持不变。');}
  finally{clearingFrontdesk=false;if(id===projectId&&gen===generation)render();}
 });
 clearFrontdeskContext.id='chat-clear-frontdesk-context';clearFrontdeskContext.className='chat-context-clear chat-menu-action';clearFrontdeskContext.title='仅重开前台上下文，不清空主控或工作；原对话历史保留';clearFrontdeskContext.hidden=!ownsConversation;clearFrontdeskContext.disabled=true;$('conversation-head').querySelector('.conversation-controls').append(clearFrontdeskContext);
 const residentRecovery=document.createElement('section');residentRecovery.id='managed-resident-recovery';residentRecovery.hidden=true;residentRecovery.setAttribute('aria-label','常驻 Agent 会话恢复');agentDetailsBody.append(residentRecovery);
 const runtimeControls=mountSessionRuntimeControls({call,toast,current:()=>({projectId,target,agent:state?.agents?.find(a=>a.target===target)}),refresh});
 runtimeControls.button.classList.add('chat-menu-action');
 $('conversation-head').querySelector('.conversation-controls').append(runtimeControls.button);
 let residentStatus=null,handoffPending=false;
 function inputReason(){return inputIdentityReason||conversationTargetReason(state,target);}
 function retainInput(record){if(!scope||!record?.text&&!record?.materials?.pending?.length&&!record?.materials?.quote)return;const entries=scope.viewState?.retainedConversationInputs||[];if(!entries.some(item=>JSON.stringify(item)===JSON.stringify(record)))scope.viewState={...scope.viewState,retainedConversationInputs:[...entries,record]};}
 function captureInput(){
  if(!ownsConversation||!projectId)return;
  const text=$('composer').value,materials=window.__composerMaterials?.snapshotPersist();
  if(inputReason()){retainInput({projectId:scope?.viewState?.conversationInput?.projectId||projectId,target,text,materials,reason:inputReason()});return;}
  drafts.set(projectId+':'+target,text);
  if(scope)scope.viewState={...scope.viewState,conversationInput:{projectId,target},conversationMaterials:{...scope.viewState?.conversationMaterials,[target]:materials}};
 }
 function restoreInput(frame){
  if(scope&&frame?.conversationInput?.projectId!==projectId){for(const [sourceTarget,materials] of Object.entries(frame?.conversationMaterials||{}))retainInput({projectId:frame?.conversationInput?.projectId||null,target:sourceTarget,materials,reason:'材料来源项目未核实，未移入当前输入。'});scope.viewState={...scope.viewState,conversationMaterials:{}};}
  const local=drafts.get(projectId+':frontdesk');
  const restored=resolveConversationInput({projectId,frame,state,local});target=restored.target;inputIdentityReason=restored.reason;
  $('composer').value=restored.text;window.__composerMaterials?.restore(restored.materials,{projectId,target});if(restored.retained)retainInput(restored.retained);
  const legacyTarget=frame.conversationInput?.projectId===projectId?frame.conversationInput.target:null;if(legacyTarget&&legacyTarget!=='frontdesk'&&state?.drafts?.[legacyTarget]&&(restored.retained?.target!==legacyTarget||restored.retained?.text!==state.drafts[legacyTarget]))retainInput({projectId,target:legacyTarget,text:state.drafts[legacyTarget],materials:frame.conversationMaterials?.[legacyTarget],reason:'原后台目标草稿保持独立，主对话只使用前台；未发送。'});
  if(!inputReason())captureInput();
 }
 function renderInputIdentity(){
  if(!ownsConversation)return;const reason=inputReason(),lifecycle=selectedSession(),notice=reason||sessionRecoveryError||(lifecycle.state!=='ready'?lifecycle.reason:''),retained=scope?.viewState?.retainedConversationInputs||[];
  identityNotice.hidden=!notice&&!retained.length;identityNotice.replaceChildren();$('composer').readOnly=Boolean(reason);
  if(notice)identityNotice.append(Object.assign(document.createElement('p'),{textContent:notice}));
  if(retained.length){const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='保留的原归属草稿 · '+retained.length;details.append(summary);for(const item of retained){const text=document.createElement('textarea');text.readOnly=true;text.value=item.text||'';text.setAttribute('aria-label','保留的原归属草稿');details.append(Object.assign(document.createElement('p'),{textContent:item.reason||'原稿保持，未移入当前输入'}),text);if(item.materials?.pending?.length)details.append(Object.assign(document.createElement('p'),{textContent:'原材料：'+item.materials.pending.map(a=>a.name||a.relPath||'材料').join('、')}));}identityNotice.append(details);}
  $('context-bar').textContent=($('project-name').textContent||'当前项目')+' · 前台对话';
 }
 let sessionRecoveryError='';
 function selectedSession(recipient=target,independent=false){
  if(!independent&&ownsConversation&&inputReason())return {state:'unavailable',reason:inputReason()};
  if(recipient!=='frontdesk')return {state:'unavailable',reason:'主对话仅使用前台；后台任务请从任务概览查看。'};
  const agent=state?.agents?.find(a=>a.target==='frontdesk');
  if(!independent&&viewed?.readOnly)return {state:'unavailable',reason:'当前内容只读，请返回前台后发送。'};
  if(agent?.starting||agent?.restarting||state?.configuringTargets?.includes(recipient))return {state:'connecting',canSend:ready,reason:'会话正在连接；已发送的消息由系统排队，未发送草稿保留。'};
  if(!ready)return {state:'unavailable',reason:'对话连接暂不可用；草稿已保留，连接状态将在这里更新。'};
  if(agent?.closed||!agent)return {state:'idle',canSend:true,reason:'会话暂未连接；发送时由系统恢复，未发送草稿保留。'};
  return {state:'ready',reason:''};
 }
 function renderResidentRecovery(status){
  residentStatus=status;residentRecovery.replaceChildren();
  const challenge=status?.handoff,archives=Object.entries(status?.state?.residentArchive||{}).flatMap(([role,slot])=>(slot.handoffs||[]).map(entry=>({...entry,role:entry.role||role})));
  residentRecovery.hidden=!active||(!status?.connectionError&&!challenge&&!archives.length);
  if(residentRecovery.hidden)return;
  const paragraph=text=>residentRecovery.append(Object.assign(document.createElement('p'),{textContent:text}));
  if(status.connectionError)paragraph('Agent 恢复失败：'+status.connectionError.message);
  if(challenge){
   const id=projectId,gen=generation,current=()=>id===projectId&&gen===generation&&residentStatus?.handoff?.token===challenge.token&&residentStatus?.handoff?.oldThreadId===challenge.oldThreadId;
   paragraph(`${labels[challenge.role]||challenge.role} · 已创建会话 ${challenge.oldThreadId} · 工具接口升级，等待你确认新会话接手`);
   paragraph(`${challenge.reason||'原会话工具接口不兼容'}；已有记录保留只读（空会话可能没有对话），Work 与草稿保留。尚未执行接手，不自动发送草稿或重放旧任务。`);
   paragraph(`工具 schema：${challenge.expectedToolsDigest} → ${challenge.newToolsDigest}`);
   const confirm=button('确认以新会话接手',async()=>{
    if(handoffPending||!current())return;
    if(!window.confirm(`确认让 ${labels[challenge.role]||challenge.role} 以新会话接手？\n原会话：${challenge.oldThreadId}\n旧历史保留只读；保留 Work、草稿和 required 意图，不自动重放任务，不发送草稿。`))return;
    if(!current())return;
    handoffPending=true;confirm.disabled=true;
    try{await call('resident.handoff',{role:challenge.role,token:challenge.token,oldThreadId:challenge.oldThreadId},id);if(current())await refresh();}
    finally{handoffPending=false;if(current())confirm.disabled=false;}
   });confirm.dataset.residentHandoff=challenge.role;confirm.disabled=handoffPending;residentRecovery.append(confirm);
  }
  for(const entry of archives){
   const id=projectId,gen=generation,archiveId=entry.archiveId||entry.id;
   const resident=status?.state?.residents?.[entry.role];paragraph(entry.reason==='user-frontdesk-context-clear'?'前台 · 上下文已清空，原对话历史已归档保留。':`${labels[entry.role]||entry.role} · 原会话 ${entry.oldThreadId||entry.threadId} → 新会话 ${resident?.threadId||'待启动'} · 第 ${entry.generation??resident?.handoff?.generation??'?'} 代来源：${entry.reason||'用户明确确认接手'}`);
   if(!archiveId)continue;
   const read=button('查看原会话历史（只读）',async()=>{
    if(id!==projectId||gen!==generation)return;
    const request=++reportRequest,current=()=>id===projectId&&gen===generation&&request===reportRequest;
    const result=await call('resident.history',{role:entry.role,archiveId},id);if(!current())return;
    const text=typeof result.text==='string'?result.text:(result.messages||[]).map(m=>`${m.role||m.speaker||'消息'}：${typeof m.text==='string'?m.text:''}`).join('\n\n');
    const title='原会话 '+(entry.oldThreadId||entry.threadId)+' · 只读历史';
    const opened=await openManaged({id:'resident-history:'+archiveId,projectId:id,title,text,history:true,isCurrent:current});if(opened?.ok===false||!current())return;
    if(agentDetails.open)agentDetails.close();viewed={history:true,readOnly:true,historyLabel:title};lockHistory();$('managed-doc').replaceChildren();mountArchivePages($('managed-doc'),result,options=>call('resident.history',{role:entry.role,archiveId,...options},id),current);
   });read.dataset.residentHistory=archiveId;residentRecovery.append(read);
  }
 }
 const workerRecovery=document.createElement('section');workerRecovery.id='managed-worker-recovery';workerRecovery.hidden=true;workerRecovery.setAttribute('aria-label','工作 Agent 显式会话恢复');agentDetailsBody.append(workerRecovery);
 const workerHandoffs=new Set();let workerRecoverySignature=null;
 async function openWorkerArchive(work,archive){
  const id=projectId,gen=generation,request=++reportRequest,current=()=>id===projectId&&gen===generation&&request===reportRequest;
  try{
   const result=await call('worker.history',{workId:work.id,archiveId:archive.id,offset:0},id);if(!current())return;
   const title=(work.name||'工作')+' · 原会话接手档案（只读）',opened=await openManaged({id:'worker-history:'+archive.id,projectId:id,title,text:result.text,history:true,workerArchive:{work:{id:work.id,name:work.name},archive:{id:archive.id}},isCurrent:current});if(opened?.ok===false||!current()||scope?.kind!=='history')return;
   if(agentDetails.open)agentDetails.close();viewed={history:true,readOnly:true,historyLabel:title};lockHistory();const body=$('managed-doc');body.replaceChildren();const note=document.createElement('p');note.textContent='宿主保存的原始目标、输入、报告及对话来源档案；不是完整原生会话逐字转录。原生历史另行保留，未自动重放。';const source=document.createElement('p');source.textContent=result.source+' · '+result.version;body.append(note,source);
   mountArchivePages(body,result,options=>call('worker.history',{workId:work.id,archiveId:archive.id,...options},id),current);
  }catch(error){if(current())toast('原会话档案无法读取：'+error.message);}
 }
 function mountArchivePages(body,first,read,current){renderArchivePages(body,first,read,current,{document,onError:error=>toast(error.message)});}
 function renderWorkerRecovery(){
  const works=state.works.filter(w=>w.contextRecovery||(w.threadArchive||[]).length),signature=JSON.stringify([projectId,ready,works.map(w=>[w.id,w.name,w.status,w.revision,w.threadId,w.contextRecovery,w.threadArchive])]);if(signature===workerRecoverySignature)return;workerRecoverySignature=signature;workerRecovery.replaceChildren();workerRecovery.hidden=!works.length;
  for(const work of works){
   const heading=document.createElement('h3');heading.textContent=work.name||'工作会话';workerRecovery.append(heading);
 if(work.contextRecovery&&!['closing','ended'].includes(work.status)){
    const explanation=document.createElement('p');explanation.textContent='原 Worker 会话不能继续使用：'+(work.contextRecovery.message||work.contextRecovery.code||'工具 schema 不兼容')+'。工作、Agent 身份、工作树与草稿保留；只在你确认后准备新原生会话，不自动发送草稿或重放任务。';workerRecovery.append(explanation);
    const id=projectId,gen=generation,oldThreadId=work.threadId,revision=work.revision,current=()=>id===projectId&&gen===generation&&state.works.some(w=>w.id===work.id&&w.revision===revision&&w.threadId===oldThreadId&&w.contextRecovery);
    const confirm=button('确认新会话接手原工作（不自动执行）',async()=>{if(workerHandoffs.has(work.id)||!current())return;if(!window.confirm('确认以新原生会话接手此工作？旧会话与来源档案保留只读；同一 Work、Agent 和工作树不变。确认本身不会执行任务或发送草稿，之后请显式发送新的讨论/修改输入。'))return;if(!current())return;workerHandoffs.add(work.id);confirm.disabled=true;try{await call('worker.handoff',{workId:work.id,revision,oldThreadId,confirmed:true},id);if(id===projectId&&gen===generation){await refresh();agentDetailsStatus.textContent='原工作已准备新会话接手；尚未自动执行。请核对档案后显式发送新输入，草稿未发送。';}}catch(error){toast(error.message);}finally{workerHandoffs.delete(work.id);if(current())confirm.disabled=false;}});confirm.dataset.workerHandoff=work.id;confirm.disabled=!ready||!oldThreadId||workerHandoffs.has(work.id);workerRecovery.append(confirm);
   }
   for(const archive of work.threadArchive||[]){const read=button('查看原会话来源档案（只读）',()=>openWorkerArchive(work,archive));read.dataset.workerHistory=archive.id;workerRecovery.append(read);}
  }
 }
 const todoUI=mountManagedTodos({document,invoke,toast,openTodo,refresh,
  viewWork:id=>inspectWork(id),
  recover:async(todo,id)=>{const gen=generation;if(id!==projectId)return;const w=state.works.find(w=>w.id===todo.workId),reason=recoveryReason(todo,w);if(reason)throw Error(reason);const result=await call(todo.kind==='git'?'git.retry':'recovery.resolve',{todoId:todo.id,workId:w.id,revision:todo.revision,sourceJob:todo.sourceJobId,requestKey:crypto.randomUUID()},id);if(!result.accepted)throw Error(result.error?.message||'恢复未受理');if(id!==projectId||gen!==generation)return;await refresh();if(id!==projectId||gen!==generation)return;if(todo.kind==='recovery'){inspectWork(w.id);toast('已打开任务概览核查，未接入Worker对话、未重放执行。');}}
 });
 document.addEventListener('nozeli-attention-read-change',event=>{if(event.detail?.projectId===projectId&&active&&state)render();});
 const relayedPresentations=new Set();
 document.addEventListener('nozeli-attention-presented',event=>{
  if(scope?.role!=='surface'||!['conversation','report'].includes(scope.kind))return;
  const detail=event.detail||{},sessionId=detail.sessionId||detail.threadId;
  if(detail.projectId!==projectId||!sessionId||!detail.messageId)return;
  const key=JSON.stringify([projectId,sessionId,detail.messageId,detail.objectId,detail.revision]);
  if(relayedPresentations.has(key))return;relayedPresentations.add(key);
  void invoke('workspace.attention.presented',{...detail,sessionId}).then(result=>{if(!result?.ok)relayedPresentations.delete(key);}).catch(()=>relayedPresentations.delete(key));
 });
 window.nozeli.subscribe('workspace.control',event=>{if(event.type==='attention-presented'&&(!scope||scope.role==='shell')&&event.projectId===projectId)document.dispatchEvent(new CustomEvent('nozeli-attention-presented',{detail:event}));});
 let presentationFrame=0;
 function schedulePresentedReplies(){
  if(presentationFrame)return;
  presentationFrame=requestAnimationFrame(()=>{
   presentationFrame=0;
   if(!ownsConversation||!active||document.visibilityState!=='visible'||!document.hasFocus()||timelineBox.hidden)return;
   const viewport=$('conversation').getBoundingClientRect();
   for(const entry of sessionStore.getSnapshot().entries){
    if(entry.speaker!=='agent'||entry.streaming||entry.availability==='read-required'||!entry.text||!(entry.sessionId||entry.threadId))continue;
    const message=timelineBox.querySelector('.session-message[data-message="'+CSS.escape(entry.id)+'"],.session-orchestrator-reply[data-message="'+CSS.escape(entry.id)+'"]');
    if(!message||!message.getClientRects().length)continue;
    const rect=message.getBoundingClientRect();
    if(rect.top<viewport.top||rect.bottom>viewport.bottom||rect.left<viewport.left||rect.right>viewport.right)continue;
    document.dispatchEvent(new CustomEvent('nozeli-attention-presented',{detail:{projectId,threadId:entry.sessionId||entry.threadId,messageId:entry.id,objectId:entry.objectId,revision:entry.revision}}));
   }
  });
 }
 new MutationObserver(schedulePresentedReplies).observe(timelineBox,{childList:true,subtree:true,characterData:true});
 $('conversation').addEventListener('scroll',schedulePresentedReplies,{passive:true});
 window.addEventListener('focus',schedulePresentedReplies);document.addEventListener('visibilitychange',schedulePresentedReplies);
 const exportDialog=document.createElement('dialog');exportDialog.id='managed-report-export';
 exportDialog.innerHTML='<form><h2>另存到项目目录</h2><p data-export-description></p><label>文件名 <input name="filename" required maxlength="200" aria-label="报告副本文件名"></label><p role="status" class="managed-export-status"></p><button type="submit">另存副本</button><button type="button" data-export-cancel>取消</button></form>';document.body.append(exportDialog);
 let exportSource=null,exportPending=false;
 const exportInput=exportDialog.querySelector('input'),exportStatus=exportDialog.querySelector('[role=status]'),exportSubmit=exportDialog.querySelector('[type=submit]');
 exportDialog.querySelector('[data-export-cancel]').onclick=()=>exportDialog.close();
 exportDialog.querySelector('form').onsubmit=async event=>{
  event.preventDefault();if(exportPending||!exportSource)return;
  const source=exportSource,relPath=exportInput.value;exportPending=true;exportSubmit.disabled=true;exportInput.disabled=true;exportStatus.textContent='正在另存…';
  try{
   const result=await invoke('report.export',{projectId:source.projectId,objectId:source.objectId,relPath});
   if(!result.ok)throw new Error(result.error?.message||'报告另存失败');
   window.dispatchEvent(new CustomEvent('nozeli-report-exported',{detail:result.value}));
   if(exportSource===source){exportDialog.close();if(projectId===source.projectId)toast('已另存：'+result.value.relPath+'；原报告保留。');}
  }catch(error){if(exportSource===source)exportStatus.textContent=error.message;}
  finally{exportPending=false;exportSubmit.disabled=false;exportInput.disabled=false;}
 };
 function exportReport(source){if(exportPending)return toast('上一份报告正在另存，请稍候。');exportSource=source;const html=source.report?.format==='html-static';exportInput.value='工作报告-r'+source.revision+(html?'.html':'.md');exportDialog.querySelector('[data-export-description]').textContent='在项目根目录创建 '+(html?'自包含 HTML':'Markdown')+' 副本，原报告保留。请使用未占用的名称。';exportStatus.textContent='';exportDialog.showModal();exportInput.focus();exportInput.select();}
 const reviewSurfaces=new Map();
 function retireReviews(){
  for(const [key,surface]of reviewSurfaces){
   const lease=surface.lease;
   void surface.hide().then(()=>surface.save()).then(()=>{if(reviewSurfaces.get(key)===surface&&surface.lease===lease&&surface.destroy())reviewSurfaces.delete(key);}).catch(error=>toast('审核草稿尚未保存，仍保留原窗口内容：'+error.message));
  }
 }
 window.addEventListener('pagehide',()=>{for(const surface of reviewSurfaces.values())void surface.save().then(()=>surface.destroy()).catch(()=>{});});
 function reportBody(parent){
  const body=document.createElement('div');body.className='managed-report-body';parent.append(body);return body;
 }
 function mountReport(parent,options){
  const doc=reportDocument;
  return mountStaticReport(parent,{...options,onEndMatter:event=>void reportEndAction(doc,event).catch(error=>reportFailure(error.message))});
 }
 async function reportEndAction(doc,event){
  if(!doc||reportDocument!==doc||projectId!==doc.projectId)throw Error('报告归属已变化，请从原报告重新打开成果。');
  if(event.action==='file')return openArtifact({objectId:doc.objectId,relPath:event.relPath,sourceProject:doc.projectId});
  if(event.action==='diff')return openArtifactDiff({objectId:doc.objectId,relPath:event.relPath,sourceProject:doc.projectId});
  if(event.action==='details'){
   if(doc.review)return doc.review.openDetails();
   return reportDialog('版本与技术详情',body=>{const facts=document.createElement('p');facts.textContent=[doc.title||'报告',doc.publicationNumber?'报告 V'+doc.publicationNumber:'工作修订 '+doc.revision,doc.historical?'历史只读':'当前报告',doc.objectId?'冻结对象：'+doc.objectId:'冻结对象不可用'].join('\n');facts.style.whiteSpace='pre-wrap';body.append(facts);});
  }
  throw Error('报告内容入口无效，未执行任何操作。');
 }
 let reportLabelWrite=null;
 async function syncReportPresentation(doc){
  if(!scope?.viewId||!['report','history'].includes(scope.kind)||!doc?.objectId||doc.projectId!==projectId||reportDocument!==doc)return;
  const work=state?.works.find(work=>work.id===doc.workId),number=doc.publicationNumber??publicationOrdinal(state,doc.workId,doc.objectId);
  const old=doc.historical||Boolean(work?.result?.objectId&&work.result.objectId!==doc.objectId);
  const human=publicationHumanEdited(state,{kind:doc.kind||'result',workId:doc.workId,objectId:doc.objectId});
  const title=[work?.name||doc.report?.title||'任务',number?'报告 V'+number:'工作修订 '+doc.revision,old?'历史版':'当前版',human?'人工稿':''].filter(Boolean).join(' · ');
  if(scope.viewState?.title===title&&scope.viewState?.report?.objectId===doc.objectId)return;
  if(reportLabelWrite){await reportLabelWrite;if(reportDocument===doc)return syncReportPresentation(doc);return;}
  const viewState={...scope.viewState,title,report:{...scope.viewState?.report,title,projectId:doc.projectId,workId:doc.workId,objectId:doc.objectId,revision:doc.revision,publicationNumber:number,report:doc.report}};
  reportLabelWrite=invoke('workspace.command',{projectId:doc.projectId,requestKey:crypto.randomUUID(),command:{type:'restoreViewState',viewId:scope.viewId,viewState}});
  try{const result=await reportLabelWrite;if(!result.ok)throw Error(result.error?.message||'报告归属未保存');if(reportDocument===doc&&projectId===doc.projectId){scope.viewState=viewState;doc.publicationNumber=number;}}finally{reportLabelWrite=null;}
 }
 async function appendReview(parent,doc){
  doc.workId??=state?.receipts.find(receipt=>receipt.objectId===doc.objectId)?.workId;
  if(!doc.workId||!doc.objectId||doc.report?.source==='demo-fixture')return;
 try{await syncReportPresentation(doc);}catch(error){const blocked=document.createElement('p');blocked.setAttribute('role','alert');blocked.textContent='讨论修改不可用：报告归属未确认。'+error.message;parent.append(blocked);return;}
 if(projectId!==doc.projectId||reportDocument!==doc)return;
 const key=JSON.stringify([doc.projectId,doc.workId]);
 for(const [otherKey,other]of reviewSurfaces)if(otherKey!==key)await other.hide();
 let surface=reviewSurfaces.get(key);
 if(!surface){surface=mountManagedReview(parent,{invoke,projectId:doc.projectId,workId:doc.workId,objectId:doc.objectId,workName:state?.works.find(work=>work.id===doc.workId)?.name||doc.title||'当前任务',current:()=>projectId===doc.projectId&&reportDocument?.workId===doc.workId,confirm:confirmDecision,onChanged:refresh,onOpenLatest:()=>refreshReviewPublication(true),getDiscardState:()=>({allowed:!dispositionPending&&Boolean(disposition?.discard?.allowed)&&disposition?.binding?.objectId===reportDocument?.objectId,message:dispositionError||disposition?.discard?.message||'正在核实放弃条件…'}),onDiscard:()=>{const current=reportDocument;if(current?.workId!==doc.workId||current.projectId!==doc.projectId)throw Error('报告归属已变化，未放弃工作。');return disposeWork(doc.workId,'discard',current);}});reviewSurfaces.set(key,surface);}
 else {await surface.hide();parent.append(surface.root);await surface.bind(doc.objectId);await surface.observe();}
  surface.lease=(surface.lease||0)+1;
  doc.review=surface;
 appendClosureAccess(surface.root,doc);
  return surface;
 }
 function appendClosureAccess(parent,doc){
  if(parent.querySelector('[data-review-closure]'))return;
  const box=document.createElement('section');box.className='managed-review-closure';box.dataset.reviewClosure='';box.hidden=true;
  const status=document.createElement('p');status.setAttribute('role','status');status.dataset.closureState='';
  const link=(label,run)=>{const a=document.createElement('a');a.href='#review-closure';a.textContent=label;a.onclick=event=>{event.preventDefault();if(projectId===doc.projectId)void Promise.resolve().then(run).catch(error=>reportFailure(error.message));};return a;};
  const inspect=link('收尾状态',()=>inspectWork(doc.workId)),gate=link('处理收尾待办',()=>{const todo=state?.todos.find(todo=>todo.workId===doc.workId&&todo.status==='open'&&['merge-consent','merge-constraint'].includes(todo.kind));return todo?openTodo(todo.id):queryDisposition();});gate.dataset.closureGate='';gate.hidden=true;
  const detail=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('p');summary.textContent='收尾说明';body.dataset.closureDetail='';detail.append(summary,body);box.append(status,inspect,gate,detail);parent.append(box);
 }
 function appendLatestReview(parent,doc,current){
  const latest=managedReviewTodos(state??{}).find(todo=>todo.kind==='result'&&todo.workId===doc.workId&&todo.objectId!==doc.objectId);
  if(!latest)return;
  const link=button('查看最新待审报告 · '+(latest.publicationLabel||'工作修订 '+latest.revision),async()=>{
   if(!current())return;
   const pending=managedReviewTodos(state??{}).find(todo=>todo.id===latest.id&&todo.workId===doc.workId&&todo.objectId===latest.objectId);
   if(!pending){toast('最新待审报告已变化，请从待办面板重新查看。');return;}
   const saved=await flushManagedReviews();if(!saved.ok){toast(saved.error.message);return;}
   if(!current())return;
   const result=await invoke('workspace.control',{type:'report',projectId:doc.projectId,report:{id:pending.id,todoId:pending.id,projectId:doc.projectId,objectId:pending.objectId,revision:pending.revision,title:pending.title||'最新待审报告'}});
   if(!result.ok)toast(result.error?.message||'最新待审报告未打开；原报告和意见保留。');
  });
  link.dataset.latestReview=latest.id;link.dataset.latestReviewObject=latest.objectId;parent.append(link);
 }
 async function appendFrozenArtifacts(parent,objectId,sourceProject,current){
  if(!objectId)return;
  const doc=reportDocument;
  const section=document.createElement('section');section.className='managed-frozen-artifacts';section.dataset.frozenArtifacts='';const heading=document.createElement('h3');heading.textContent='成果与依据';section.append(heading);parent.append(section);
  const note=text=>{const p=document.createElement('p');p.textContent=text;section.append(p);return p;};
  try{
   const result=await call('artifact.list',{objectId},sourceProject);if(!current()||!section.isConnected)return;
   const metadata=result.endMatter;
   note('打开时的冻结清单／人工稿核验快照'+(metadata?.generatedAt?'（'+metadata.generatedAt+'）':'')+'；后续变化不会自动刷新，当前未保存等风险见审核栏。');
   const files=new Map((result.files||[]).map(file=>[file.relPath,file]));for(const file of metadata?.files||[])files.set(file.relPath,{...files.get(file.relPath),...file});
   if(metadata?.metadataState!=='verified'||metadata.metadataError)note('文件修改类型或人工稿状态未完全核实'+(metadata?.metadataError?'：'+metadata.metadataError:'；不会以当前项目文件替代。'));
   if(!files.size)note('本报告没有单独交付成果文件。');
   for(const file of files.values()){
    const row=document.createElement('div');row.className='managed-review-file-header';const name=document.createElement('strong');name.textContent=file.relPath;row.append(name);
    const detail=document.createElement('span');detail.textContent=[{added:'新增',modified:'修改',removed:'删除',renamed:'重命名',copied:'复制','type-changed':'类型变化',unchanged:'未修改',unknown:'修改类型未核实'}[file.change]||'修改类型未核实',file.draftRevision>0&&file.draftDigest?'有已保存人工稿（不含在冻结交付 Diff 中）':''].filter(Boolean).join(' · ');row.append(detail);
    const contentLink=(label,action)=>{const a=document.createElement('a');a.href='#report-artifact';a.textContent=label;a.onclick=event=>{event.preventDefault();if(current())void reportEndAction(doc,{action,relPath:file.relPath}).catch(error=>reportFailure(error.message));};return a;};
    row.append(contentLink('查看成果','file'),contentLink(file.binary?'冻结版本信息':'冻结交付 Diff','diff'));section.append(row);
    if(file.baselineUnavailable)note('冻结基线不可用，不以当前项目文件或空文本替代。');if(file.binary)note('二进制文件不支持文本比较，可查看冻结版本信息。');if(file.availability&&file.availability!=='available')note('预览不可用：'+(file.reason||file.availability));
   }
   note('相关方法：未单独提供已分类的方法材料；以报告原文及冻结引用为准。');note('相关数据：未单独提供已分类的数据材料；以报告原文及冻结引用为准。');note('冻结交付 Diff 为冻结输入 → 本次发布候选，不包含人工改稿。');
   if(metadata?.references?.length){const label=document.createElement('h4');label.textContent='报告已有冻结引用（未分类）';section.append(label);for(const ref of metadata.references)note(ref.href||ref.relPath||ref.url||ref.id);}
   const details=document.createElement('a');details.href='#report-details';details.textContent='版本与技术详情';details.onclick=event=>{event.preventDefault();if(current())void reportEndAction(doc,{action:'details'}).catch(error=>reportFailure(error.message));};section.append(details);
  }catch(error){if(current())note('冻结成果列表不可用：'+error.message+'；报告原文保留。');}
 }
 const workRows=new Map();
 let workQuotaText='处理名额待核对';
 const categoryByProject=new Map(),categoryScroll=new Map();
 const extraCategories=[{id:'all',label:'全部'},{id:'submitted',label:'提交'},{id:'orchestrating',label:'编排'},{id:'queued',label:'排队'},{id:'work',label:'执行中'},{id:'review',label:'待审'},{id:'fault',label:'故障'},{id:'closing',label:'结束处理'}];
 const categoryIds=['active','ended',...extraCategories.map(item=>item.id)];
 const categoryKey=()=> 'nozeli:work-category:'+projectId;
 function currentCategory(){let saved=categoryByProject.get(projectId);if(!saved){try{saved=localStorage.getItem(categoryKey());}catch{}saved??=scope?.viewState?.workCategory;}return categoryIds.includes(saved)?saved:'active';}
 function setCategory(category){if(!projectId||!categoryIds.includes(category))return;categoryScroll.set(projectId+':'+currentCategory(),$('work-items').scrollTop);categoryByProject.set(projectId,category);try{localStorage.setItem(categoryKey(),category);}catch{}if(scope)scope.viewState={...scope.viewState,workCategory:category};render();$('work-items').scrollTop=categoryScroll.get(projectId+':'+category)||0;}
 for(const filter of document.querySelectorAll('[data-managed-category]'))filter.addEventListener('click',()=>setCategory(filter.dataset.managedCategory));
 const categoryMore=$('managed-work-category-more'),categoryMenu=mountContextMenu({id:'managed-work-filter-menu',label:'更多工作分类',onOpen:()=>categoryMore.setAttribute('aria-expanded','true'),onClose:()=>categoryMore.setAttribute('aria-expanded','false')});
 categoryMore.onclick=()=>{if(!projectId)return;const source=projectId,gen=generation;categoryMenu.open([...extraCategories.map(item=>({id:'filter-'+item.id,label:item.label,checked:currentCategory()===item.id})),{separator:true},{notice:workQuotaText},{notice:'待审、暂停或结束处理未完成的任务仍可能占用名额。'}],{anchor:categoryMore.getBoundingClientRect(),focus:categoryMore,run:id=>{if(source===projectId&&gen===generation)setCategory(id.slice('filter-'.length));}});};
 const workMenu=mountContextMenu({id:'managed-work-menu',label:'工作操作',onError:message=>toast(message)});
 function inspectWork(id){const work=state?.works.find(w=>w.id===id);if(!work)return;workInfo.dataset.workId=id;agentDetails.dataset.mode='work';agentDetailsTitle.textContent='任务概览';if(!agentDetails.open)agentDetails.showModal();render();}
 function inspectRequest(record){requestInfo.dataset.requestId=record.id;agentDetails.dataset.mode='request';agentDetailsTitle.textContent='请求概览';if(!agentDetails.open)agentDetails.showModal();render();}
 let retainedDialog=null,retainedView=null;
 function closeRetainedProgress(){retainedView?.close();retainedView=null;if(retainedDialog){const old=retainedDialog;retainedDialog=null;if(old.open)old.close();old.remove();}}
 function inspectRetainedProgress(workId){
  const work=state?.works.find(work=>work.id===workId);if(!work)return;
  closeRetainedProgress();if(agentDetails.open)agentDetails.close();
  const source=projectId,gen=generation,dialog=document.createElement('dialog'),body=document.createElement('section'),title=document.createElement('h2');
  dialog.className='managed-report-dialog';dialog.dataset.retainedProgressDialog=workId;dialog.setAttribute('aria-label',(work.name||'任务')+' · 保留进展');title.textContent=(work.name||'任务')+' · 保留进展';
  const close=button('关闭',()=>closeRetainedProgress());dialog.append(title,body,close);document.body.append(dialog);retainedDialog=dialog;
  const current=()=>source===projectId&&gen===generation&&retainedDialog===dialog;
  const route=async action=>{if(!current())return;closeRetainedProgress();try{await action();}catch(error){toast('保留内容未改变：'+error.message);}};
  retainedView=mountWorkProgress({root:body,document,loadProgress:async()=>{const value=await call('work.progress.read',{workId},source);if(!current())throw Error('项目已变化，请重新进入原任务');return value;},
   onReturnReading:()=>{if(current())closeRetainedProgress();},
   onOpenReport:pub=>route(async()=>{const todo=state?.todos.find(todo=>todo.workId===workId&&todo.objectId===pub.objectId);if(todo)return openTodo(todo.id);const opened=await openManaged({id:pub.objectId,objectId:pub.objectId,workId,projectId:source,title:(work.name||'任务')+' · 保留报告',text:'',isCurrent:()=>source===projectId});if(opened?.ok===false)throw Error(opened.error?.message||'报告未打开');}),
   onOpenFile:(pub,file)=>route(()=>openArtifact({objectId:pub.objectId,relPath:file.relPath,sourceProject:source})),
   onCopyText:async text=>{if(!current())throw Error('项目已变化，未复制其他任务内容');const result=await invoke('document.clipboard',{action:'write',text});if(!result.ok)throw Error(result.error?.message||'复制失败');}
  });
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeRetainedProgress();});dialog.showModal();close.focus();
 }
 window.addEventListener('nozeli-project-change',closeRetainedProgress);window.addEventListener('pagehide',closeRetainedProgress);
 async function openWorkMenu(row,event){
  event.preventDefault();const record=managedWorkRecords(state).find(r=>r.id===row.dataset.managedRequest),work=state.works.find(w=>w.id===record?.workId),controlTarget=record&&workRecordControlTarget(record,state);if(!record)return;if(!controlTarget){inspectRequest(record);return;}
  const source=projectId,gen=generation,anchor=row.querySelector('.managed-work-open'),rect=anchor.getBoundingClientRect();anchor.focus({preventScroll:true});
  let capability;try{capability=await call('work.control.status',controlTarget.workId?{workId:controlTarget.workId}:{jobId:controlTarget.jobId},source);}catch(error){if(source===projectId&&gen===generation)toast('控制能力未确认：'+error.message);}
  if(source!==projectId||gen!==generation||!row.isConnected)return;
 workMenu.open([...(work&&workResultPublication(work)?[{id:'report',label:'查看成果报告'}]:[]),{id:'details',label:'任务概览'},...(['closing','ended'].includes(work?.status)?[]:['pause','stop-current','resume']).map(action=>({id:'control-'+action,label:{pause:'暂停调度…','stop-current':'停止当前执行…',resume:'恢复…'}[action],enabled:capability?.[action==='stop-current'?'stopCurrent':action]?.allowed===true})),...(work?[{separator:true},{id:'discard',label:work.status==='queued'?'取消排队…':'丢弃成果并收尾…',enabled:!work.readOnly&&!['closing','ended'].includes(work.status)}]:[])],{x:event.clientX??rect.left,y:event.clientY??rect.bottom,run:id=>{if(source!==projectId||gen!==generation)return;if(id.startsWith('control-'))workControl.open(controlTarget);else if(id==='details'){if(work)inspectWork(work.id);else workControl.open(controlTarget);}else if(id==='report')return openWorkReport(work.id);else if(id==='discard')return disposeWork(work.id,'discard');}});
 }
 const archive=document.createElement('details');archive.id='managed-work-archive';const archiveTitle=document.createElement('summary');archiveTitle.textContent='历史报告与已结束工作';archive.append(archiveTitle);agentDetailsBody.append(archive);
 let historyItems=[],historyVersion=null,historyNext=null,historyTotal=0,historyMode='offline',historyRequest=0,historySelectionRequest=0,historyLoading=false,historyNotice='',historyReceiptSignature=null;
 const historyList=document.createElement('div'),historyStatus=document.createElement('p'),historyActions=document.createElement('div');historyStatus.setAttribute('role','status');historyActions.className='managed-history-actions';
 const historyReload=button('重新加载历史',()=>loadHistory()),historyMore=button('加载更多历史',()=>loadHistory({more:true}));historyReload.dataset.historyReload='';historyMore.dataset.historyMore='';historyActions.append(historyReload,historyMore);archive.append(historyStatus,historyList,historyActions);
 function renderHistory(){
  archive.hidden=!historyLoading&&!historyItems.length&&!historyNotice;archiveTitle.textContent='历史报告与已结束工作'+(historyTotal?' · '+historyTotal:'');
  historyStatus.textContent=(historyMode==='offline'?'离线历史 · ':'只读历史 · ')+(historyLoading?'正在读取…':historyNotice||'条目尚未核验对象，打开时检查原件。');historyList.replaceChildren();
  for(const item of historyItems){const version=historyVersion,b=button('',()=>openHistory(item,version));b.dataset.managedHistoryObject=item.objectId;const title=document.createElement('strong'),excerpt=document.createElement('span');title.textContent=item.workName+' · '+(item.publicationNumber?'报告 V'+item.publicationNumber:'工作修订 '+item.revision)+(item.kind==='problem'?' · 问题':'');excerpt.textContent=item.excerpt;b.append(title,excerpt);historyList.append(b);}
  historyReload.disabled=historyLoading;historyMore.hidden=historyNext===null;historyMore.disabled=historyLoading;
 }
 async function loadHistory({more=false,changed=false,attempt=0}={}){
  const id=projectId,gen=generation,request=++historyRequest;if(!id)return;
  if(!more){historyItems=[];historyVersion=null;historyNext=null;historyTotal=0;historySelectionRequest++;}
  historyLoading=true;historyNotice=changed?'历史快照已变化，旧分页已丢弃并重载。':'';renderHistory();
  const result=await invoke('managed.history.list',{projectId:id,offset:more?historyNext:0,limit:50,...(more?{version:historyVersion}:{})}).catch(error=>({ok:false,error:{message:error.message}}));
  if(id!==projectId||gen!==generation||request!==historyRequest)return;
  historyLoading=false;
  if(!result.ok){
   if(result.error?.code==='REPORT_CHANGED'&&attempt===0)return loadHistory({changed:true,attempt:1});
   historyItems=[];historyVersion=null;historyNext=null;historyTotal=0;historySelectionRequest++;historyNotice='历史读取失败：'+(result.error?.message||'未知错误')+'；原记录未改动，请手动重载。';renderHistory();return;
  }
  const page=result.value;if(page.projectId!==id)return;
  historyItems=more?[...historyItems,...page.items]:page.items;historyVersion=page.version;historyNext=page.nextOffset;historyTotal=page.total;historyMode=page.mode;renderHistory();
 }
 function lockHistory(){
  const locked=Boolean(viewed?.history);document.body.dataset.managedHistory=String(locked);$('compose-form').inert=locked;
  if(locked){$('composer').disabled=true;$('send-message').disabled=true;$('send-message').title='当前历史内容只读，请返回原对话后发送。';toolbar.hidden=false;toolbar.replaceChildren();toolbar.textContent=viewed.historyLabel+' · 只读，不发送或处理任务';toolbar.append(button('返回原对话',leaveHistory));}
  updateBackgroundSubmit();
 }
 async function openHistory(item,version){
  const saved=await flushManagedReviews();if(!saved.ok){toast(saved.error.message);return;}
  // A list refresh invalidates a selected history version, not an unrelated todo.
  const id=projectId,gen=generation,request=++reportRequest,listRequest=historySelectionRequest,current=()=>id===projectId&&gen===generation&&request===reportRequest&&listRequest===historySelectionRequest;
  const result=await invoke('managed.history.read',{projectId:id,objectId:item.objectId,version}).catch(error=>({ok:false,error:{message:error.message}}));if(!current())return;
  const changed=result.error?.code==='REPORT_CHANGED',text=result.ok?(result.value.report.format==='markdown'?result.value.body:undefined):'历史读取失败：'+(result.error?.message||'未知错误')+'\n\n原历史条目保留；'+(changed?'请重载列表后重新选择原版本。':'请核对原件后重试。');
  if(result.ok&&(result.value.projectId!==id||result.value.objectId!==item.objectId||version!==undefined&&result.value.version!==version))return;
  const resolvedVersion=result.ok?result.value.version:version;
  const title=item.workName+' · '+(item.publicationNumber?'报告 V'+item.publicationNumber:'工作修订 '+item.revision)+(item.kind==='problem'?' · 问题':'')+'（历史）';
  const opened=await openManaged({id:'history:'+item.objectId,projectId:id,objectId:item.objectId,title,text:result.ok&&result.value.report.format==='html-static'?'静态 HTML 报告':text,revision:item.revision,publicationNumber:item.publicationNumber,workName:item.workName,kind:item.kind,version:resolvedVersion,report:result.ok?result.value.report:null,history:true,historyMode:result.ok?result.value.mode:historyMode,historyError:!result.ok,isCurrent:current});if(opened?.ok===false||!current()||scope?.kind!=='history')return;
 if(agentDetails.open)agentDetails.close();viewed={history:true,readOnly:true,historyLabel:title};lockHistory();$('managed-doc').replaceChildren();
  let artifactFiles=[];if(result.ok){try{const listed=await call('artifact.list',{objectId:item.objectId},id);if(!current())return;artifactFiles=listed.files;}catch(error){toast('成果快照列表不可用：'+error.message);}}
  reportDocument={projectId:id,objectId:item.objectId,title,revision:item.revision,publicationNumber:item.publicationNumber,workId:item.workId,version:resolvedVersion,report:result.value?.report,verified:result.ok,historical:true,kind:item.kind,error:result.error?.message};disposition=null;
 const body=reportBody($('managed-doc'));
 if(result.ok&&result.value.report.format==='html-static')reportDocument.view=mountReport(body,{invoke,projectId:id,objectId:item.objectId,onReference:t=>openArtifact({objectId:item.objectId,...t,sourceProject:id})});
 else renderTagMarkdown(body,text,{filePaths:new Set(artifactFiles.map(f=>f.relPath)),onFile:t=>openArtifact({objectId:item.objectId,...t,sourceProject:id}),onExternal:url=>openExternal?.(url)});
  if(reportDocument.view){await reportDocument.view.ready;if(!current())return;}
  if(result.ok&&!reportDocument.view)await appendFrozenArtifacts(body,item.objectId,id,current);
  if(result.ok&&item.kind==='result')await appendReview($('managed-doc'),reportDocument);
 if(!reportDocument.review){const footer=document.createElement('div');footer.id='managed-result-actions';const status=document.createElement('p');status.dataset.reportState='';status.textContent='历史版本 · '+(item.publicationNumber?'报告 V'+item.publicationNumber:'工作修订 '+item.revision);footer.append(status);$('managed-doc').append(footer);}
  if(item.kind==='result'){const notice=document.createElement('p');notice.className='managed-report-state';notice.dataset.reportState='';notice.textContent='历史阅读 · '+(item.publicationNumber?'报告 V'+item.publicationNumber:'工作修订 '+item.revision);appendLatestReview(notice,reportDocument,current);$('managed-doc').prepend(notice);}
 if(reportDocument.review)void queryDisposition();
  if(changed)void loadHistory({changed:true});
 }
 let sourceMessage=null;
 const sourceBox=document.createElement('section');sourceBox.id='managed-source-task';sourceBox.hidden=true;sourceBox.setAttribute('aria-label','引用消息提交后台');
 const sourceLabel=document.createElement('p'),sourceGoal=document.createElement('textarea');sourceGoal.placeholder='补充这项任务要完成什么（可选）';sourceGoal.setAttribute('aria-label','引用任务的补充目标');
 const sourceSubmit=button('提交此引用到后台',async()=>{if(!sourceMessage)return;const id=projectId,source=sourceMessage,key=sourceBox.dataset.requestKey;sourceSubmit.disabled=true;try{const receipt=await call('message.task',{messageId:source,text:sourceGoal.value,requestKey:key},id);if(id===projectId&&source===sourceMessage){await refresh();if(id===projectId&&source===sourceMessage){sourceMessage=null;sourceBox.hidden=true;sourceGoal.value='';$('compose-status').textContent=receipt.transferring?'转交已接收，等待前台停稳；原输入草稿仍保留':'引用已交后台，原输入草稿仍保留';document.dispatchEvent(new CustomEvent('nozeli-reveal-work-sidebar'));}}}finally{sourceSubmit.disabled=false;}});
 sourceBox.append(sourceLabel,sourceGoal,sourceSubmit,button('移除引用',()=>{sourceMessage=null;sourceBox.hidden=true;sourceGoal.value='';}));$('compose-form').before(sourceBox);
 const name=t=>labels[t]||state?.works.find(w=>w.id===t)?.name||'工作 Agent';
 function show(activeValue){active=activeValue;toolbar.hidden=true;if(!active){permissionView=null;if(permissionSlot){permissionSlot.hidden=true;permissionSlot.replaceChildren();delete permissionSlot.dataset.conversationPermission;}identityNotice.hidden=true;identityNotice.replaceChildren();sessionRecoveryError='';residentStatus=null;residentRecovery.hidden=true;residentRecovery.replaceChildren();workerRecovery.hidden=true;workerRecovery.replaceChildren();workerRecoverySignature=null;progressBox.hidden=true;closureBox.hidden=true;closureBox.replaceChildren();closureSignature=null;}document.body.dataset.managedAgents=String(active);}
 function remember(){if(ownsConversation&&projectId)captureInput();}
 function select(t){if(t&&t!=='frontdesk'){if(state?.works.some(work=>work.id===t))return inspectWork(t);window.dispatchEvent(new Event('nozeli-agent-details'));return;}if(!ownsConversation)return invoke('workspace.control',{type:'conversation-action',projectId,action:'select',target:'frontdesk'});remember();inputEpoch++;inputIdentityReason='';sessionRecoveryError='';target='frontdesk';if(scope)scope.viewState={...scope.viewState,conversationInput:{projectId,target:'frontdesk'}};viewed=null;$('composer').value=drafts.get(projectId+':frontdesk')??state?.drafts?.frontdesk??'';window.__composerMaterials?.restore(scope?.viewState?.conversationMaterials?.frontdesk,{projectId,target:'frontdesk'});captureInput();lockHistory();render();const detail={projectId};document.dispatchEvent(new CustomEvent('nozeli-conversation-input-change',{detail}));void detail.persist?.catch(error=>toast('输入归属保存失败：'+error.message));}
 function render(){
  if(fixtureMode){if(state)todoUI.render(state,projectId);updateReviewActions();return;}
  if(!active||!state)return;
  if(ownsConversation)collaboration.update({model:true});
  clearFrontdeskContext.disabled=clearingFrontdesk||!ready||target!=='frontdesk'||Boolean(viewed?.history)||state.busyTargets?.includes('frontdesk');
  renderConfigurationNotice(configurationNotice,state.agents||[]);
  renderWorkerRecovery();
  routeUI.render({...state,frontdeskRoutes:[]},projectId,ready);
  const receiptSignature=state.receipts.length+':'+(state.receipts.at(-1)?.objectId||'');
  if(historyReceiptSignature!==null&&receiptSignature!==historyReceiptSignature)void loadHistory();
  historyReceiptSignature=receiptSignature;
  if(viewed?.routingQuestionId&&state.todos.find(q=>q.id===viewed.routingQuestionId)?.status!=='open')viewed=null;
  const records=managedWorkRecords(state);
 if(state.timeline&&!historyPage){if(ownsConversation)applyTimeline(state.timeline);else sessionStore.apply(projectId,state.timeline,{replace:true});}
  if(!ownsConversation&&target!=='frontdesk'&&target!=='orchestrator'&&!state.works.some(w=>w.id===target&&w.status!=='ended'))target='frontdesk';
  if(viewed?.workId&&state.works.find(w=>w.id===viewed.workId)?.status==='closing'){viewed.readOnly=true;}
  $('conversation-panel').dataset.managedConversation=target;
  toolbar.replaceChildren();toolbar.hidden=!viewed;
  if(viewed){const w=state.works.find(w=>w.id===viewed.workId);toolbar.textContent=w?(w.name||'工作')+' · '+(records.find(r=>r.workId===w.id)?.phase||phases[w.status]||w.status):'待办 · '+(viewed.kind==='result'?'结果待审查':viewed.kind==='problem'||viewed.routingQuestionId?'待回答':'待处理');}

  const progress=managedProgress(state,target),signature=JSON.stringify(progress);
  renderInputIdentity();
  if(signature!==progressSignature){progressSignature=signature;const wasOpen=progressBox.querySelector('details')?.open;progressBox.replaceChildren();const summary=document.createElement('strong');summary.textContent=progress.summary;progressBox.append(summary);for(const row of progress.requests){const p=document.createElement('p');p.textContent=row.text;p.dataset.managedRequestProgress=row.id;progressBox.append(p);}if(progress.works.length){const details=document.createElement('details'),label=document.createElement('summary');label.textContent=progress.works.length+' 项工作进展';details.open=wasOpen??progress.works.length<=3;details.append(label);for(const row of progress.works){const p=document.createElement('p');p.textContent=row.text;p.dataset.managedWorkProgress=row.id;details.append(p);}progressBox.append(details);}}
  progressBox.hidden=!progress.requests.length&&!progress.works.length;
  const lifecycle=selectedSession();
  runtimeControls.update({active,ownsConversation,projectId,history:Boolean(viewed?.history)});
  $('ai-status').textContent=`${name(target)} · ${lifecycle.reason||progress.requests[0]?.text||'已就绪'} · ${progress.summary}`;$('ai-status').dataset.state=lifecycle.state;
  const canSend=lifecycle.canSend||lifecycle.state==='ready';$('selection-explain').disabled=!canSend;
  $('composer').disabled=Boolean(viewed?.readOnly);$('send-message').disabled=!canSend;$('send-message').title=canSend?'发送（Ctrl/Cmd+Enter）':lifecycle.reason;
  updateBackgroundSubmit();
  if(viewed?.readOnly){const back=button('回到前台讨论',()=>{select('frontdesk');$('composer').disabled=false;});toolbar.append(back);}
  updateReviewActions();
  lockHistory();
 const closing=state.works.filter(w=>w.status==='closing'&&(target==='frontdesk'||target==='orchestrator'||target===w.id)),closureKey=JSON.stringify(closing.map(w=>[w.id,w.outcome,w.closure]));
 if(closureKey!==closureSignature){closureSignature=closureKey;closureBox.replaceChildren();for(const w of closing){const title=document.createElement('h3');title.textContent=w.name||'工作收尾';closureBox.append(title);renderClosureStatus(closureBox,w);const constraint=openMergeConstraintTodo(state,w.id);if(constraint){const choose=button('处理合入策略决定',()=>openTodo(constraint.id));closureBox.append(choose);}}}
  closureBox.hidden=!closing.length;
  const reportStatus=$('managed-report-closure');if(reportStatus){const w=state.works.find(w=>w.id===viewed?.workId),key=JSON.stringify(w?.closure)+w?.status+w?.curated;if(reportStatus.dataset.signature!==key){reportStatus.dataset.signature=key;reportStatus.replaceChildren();renderClosureStatus(reportStatus,w);}}
  if(ownsConversation)paintTimeline();
 // Fixed categories derive from original jobs/Works; no synthetic stage is stored.
 const category=currentCategory(),ongoingRecords=[],historicalRecords=[];
 for(const record of records){const ongoing=record.status!=='ended'||Boolean(record.workId)&&record.closurePhase!=='complete';if(category==='all'||category==='active'&&ongoing||category!=='active'&&workRecordCategory(record,state,serviceFaults.recordState(record,projectId))===category)(ongoing?ongoingRecords:historicalRecords).push(record);}
 const orderedRecords=ongoingRecords.reverse().concat(historicalRecords.reverse());
 const works=$('work-items'),recordIds=new Set(orderedRecords.map(record=>record.id));
 for(const filter of document.querySelectorAll('[data-managed-category]'))filter.setAttribute('aria-pressed',String(filter.dataset.managedCategory===category));
 const extraCategory=extraCategories.find(item=>item.id===category);categoryMore.textContent='…';categoryMore.classList.toggle('active',Boolean(extraCategory));categoryMore.title=extraCategory?'更多工作分类，当前：'+extraCategory.label:'更多工作分类';categoryMore.setAttribute('aria-label',categoryMore.title);
  for(const [id,row] of workRows)if(!recordIds.has(id)){row.remove();workRows.delete(id);}
  for(const [position,record] of orderedRecords.entries()){
   let row=workRows.get(record.id);
   if(!row){row=document.createElement('div');row.className='managed-work-entry';row.dataset.managedRequest=record.id;
    const open=button('',async()=>{const current=managedWorkRecords(state).find(r=>r.id===row.dataset.managedRequest);if(!current)return;const sourceJobId=current.id.startsWith('request:')?current.id.slice(8):undefined;const result=await invoke('workspace.control',{type:'task-workspace',action:'overview',projectId,...(current.workId?{workId:current.workId}:{}),...(sourceJobId?{sourceJobId}:{})});if(!result.ok)toast(result.error?.message||'任务概览未打开');});open.className='managed-work-open';
    const workName=document.createElement('span'),workStatus=document.createElement('span'),workDetail=document.createElement('span');workName.className='managed-work-name';workStatus.className='managed-work-status';workDetail.className='managed-work-detail';open.append(workName,workStatus,workDetail);row.append(open);workRows.set(record.id,row);
    row.addEventListener('contextmenu',event=>openWorkMenu(row,event));open.addEventListener('keydown',event=>{if(event.key==='ContextMenu'||event.key==='Menu'||event.shiftKey&&event.key==='F10')openWorkMenu(row,event);});
   }
   if(record.workId)row.dataset.managedWork=record.workId;else delete row.dataset.managedWork;
   row.dataset.state=record.status;
   row.dataset.taskTone=taskIdentityTone(taskIdentityKey(projectId,state,{workId:record.workId,sourceJobId:record.id.startsWith('request:')?record.id.slice(8):undefined}));
   row.querySelector('.managed-work-name').textContent=record.name;
   const controlTarget=workRecordControlTarget(record,state),controlRecord=controlTarget?.workId?state.works.find(w=>w.id===controlTarget.workId):state.jobs?.find(j=>j.id===controlTarget?.jobId),held=controlRecord?.status!=='ended'&&controlRecord?.manualControl?.pause!=null;
 // 可扫描短状态 + 次级等待说明同排显示；完整状态事实仍保留在标题/无障碍名称里。
 const statusText=controlRecord?.status==='ended'?'已结束':controlRecord?.status==='closing'?closureProcessingStatus(controlRecord):(held?'已暂停后续 · ':'')+(serviceFaults.recordState(record,projectId)||record.phase||record.status),split=statusText.indexOf(' · '),status=row.querySelector('.managed-work-status');status.textContent=split<0?statusText:statusText.slice(0,split);status.dataset.state=record.status;
 row.querySelector('.managed-work-detail').textContent='';
 const open=row.querySelector('.managed-work-open');open.title=record.name+' · '+statusText+' · 任务概览';open.setAttribute('aria-label',open.title);open.disabled=!record.workId&&!record.jobIds?.length;
   if(works.children[position]!==row)works.insertBefore(row,works.children[position]||null);
  }
  const selectedRequest=records.find(record=>record.id===requestInfo.dataset.requestId&&!record.workId);requestInfo.hidden=agentDetails.dataset.mode!=='request'||!selectedRequest;
  if(agentDetails.open&&!requestInfo.hidden){const technicalOpen=requestInfo.querySelector('[data-request-diagnostics]')?.open===true;requestInfo.replaceChildren(renderRequestOverview({document,record:selectedRequest,serviceState:serviceFaults.recordState(selectedRequest,projectId)}));requestInfo.querySelector('[data-request-diagnostics]').open=technicalOpen;}
  const selectedWork=state.works.find(w=>w.id===workInfo.dataset.workId),showWork=agentDetails.dataset.mode==='work';workInfo.hidden=!showWork||!selectedWork;
 if(agentDetails.open&&showWork&&selectedWork){
  const constraintTodo=openMergeConstraintTodo(state,selectedWork.id),publication=workResultPublication(selectedWork),lineage=records.find(r=>r.workId===selectedWork.id),signature=JSON.stringify([projectId,selectedWork.id,selectedWork.status,selectedWork.revision,selectedWork.request,selectedWork.deviation,selectedWork.manualControl,selectedWork.closure,selectedWork.outcome,publication?.objectId,publication?.revision,constraintTodo?.id,constraintTodo?.status,constraintTodo?.constraintVersion,lineage?.phase,lineage?.waitingOn,state.drafts?.[selectedWork.id]]);
  if(workInfo.dataset.signature!==signature){
   const previous=workInfo.querySelector('[data-work-overview]'),technicalOpen=previous?.dataset.workOverview===selectedWork.id&&previous.querySelector('[data-work-overview-technical]')?.open===true;
   workInfo.dataset.signature=signature;workInfo.replaceChildren();
   const versions=document.createElement('div');versions.className='managed-work-versions';
   const facts=document.createElement('section');facts.className='managed-work-closure';facts.dataset.managedWorkLifecycle=selectedWork.id;
   if(selectedWork.closure||selectedWork.status==='ended')renderClosureStatus(facts,selectedWork);
   else facts.append(Object.assign(document.createElement('p'),{textContent:'尚无结束记录。'}));
   const technicalSections=[versions,facts];
   if(state.drafts?.[selectedWork.id]){const retained=document.createElement('section'),heading=document.createElement('h4'),draft=document.createElement('textarea'),note=document.createElement('p');heading.textContent='原后台草稿（只读保留）';draft.readOnly=true;draft.value=state.drafts[selectedWork.id];draft.setAttribute('aria-label','原后台任务未发送草稿');note.textContent='未发送、未转给前台。可查看复制；主对话仍在前台，后台修改须显式交接。';retained.append(heading,draft,note);technicalSections.push(retained);}
   if(lineage?.events?.length){const events=document.createElement('section'),label=document.createElement('h4'),body=document.createElement('pre');label.textContent='事件记录';body.textContent=lineage.events.map(e=>(e.at?new Date(e.at).toLocaleString():'')+' · '+e.text).join('\n');events.append(label,body);technicalSections.push(events);}
   const required=document.createElement('section');
   if(deviationHeld(selectedWork))paintDeviation(required,selectedWork);
   if(constraintTodo){const card=document.createElement('section');paintMergeConstraint(card,selectedWork,constraintTodo);required.append(card);}
   const activeWork=!['ended','closing'].includes(selectedWork.status)&&!selectedWork.readOnly;
 const overview=renderWorkOverview({document,work:selectedWork,publication,phase:lineage?.phase,waitingOn:lineage?.waitingOn,onInspectWork:inspectWork,onProgress:()=>inspectRetainedProgress(selectedWork.id),onReport:publication?()=>openWorkReport(selectedWork.id).catch(error=>toast(error.message)):undefined,onControl:activeWork?()=>workControl.open({workId:selectedWork.id,name:selectedWork.name||'任务'}):undefined,onEnd:activeWork?()=>disposeWork(selectedWork.id,'discard'):undefined,requiredSection:required.childNodes.length?required:undefined,technicalSections,technicalOpen,disabled:dispositionPending,unsentDraft:state.drafts?.[selectedWork.id]?{onOpen:()=>{const technical=workInfo.querySelector('[data-work-overview-technical]');if(technical){technical.open=true;technical.querySelector('textarea')?.focus();}}}:null});
   workInfo.append(overview);
   const technical=overview.querySelector('[data-work-overview-technical]');technical?.addEventListener('toggle',()=>{if(technical.open)void renderWorkVersions({box:versions,record:{workId:selectedWork.id,status:selectedWork.status},projectId,call});});
  }
  const technical=workInfo.querySelector('[data-work-overview-technical]'),versions=workInfo.querySelector('.managed-work-versions');if(technical?.open&&versions)void renderWorkVersions({box:versions,record:{workId:selectedWork.id,status:selectedWork.status},projectId,call});
 }
 $('work-empty').hidden=orderedRecords.length>0;$('work-empty').textContent=records.length?'此分类下暂无任务。':'还没有开展的工作。';
 workQuotaText=Number.isSafeInteger(state.quotaUsed)&&Number.isSafeInteger(state.limit)?'处理名额：已占用 '+state.quotaUsed+' 项，上限 '+state.limit+' 项':'处理名额待核对';
  todoUI.render({...state,todos:[...state.todos].sort((a,b)=>Number(b.kind==='result')-Number(a.kind==='result'))},projectId);
 if(attentionView)attentionView.ui.update(state.todos.find(t=>t.id===attentionView.todoId));
 if(permissionView)permissionView.ui.update(state.todos.find(t=>t.id===permissionView.todoId));
  for(const box of document.querySelectorAll('[data-deviation-gate]')){const work=state.works.find(w=>w.id===box.dataset.deviationGate);if(work)paintDeviation(box,work);}
  for(const el of document.querySelectorAll('.inbox-panel .filters'))el.hidden=true;
 }
 async function openArtifactDiff({objectId,relPath,sourceProject=projectId}){
  const saved=await flushManagedReviews();if(!saved.ok){toast(saved.error.message);return;}
  const gen=generation;
  try{
   const review=await call('review.read',{objectId},sourceProject);if(sourceProject!==projectId||gen!==generation)return;
   const file=review.files?.find(entry=>entry.relPath===relPath);
   if(!review.workId||!file)throw Error('此路径不在报告冻结文件清单中；未读取同名项目文件。');
   if(!openFrozenChange)throw Error('冻结差异入口不可用。');
   const target=review.changeSetId&&file.changeFileId?{projectId:sourceProject,changeSetId:review.changeSetId,fileId:file.changeFileId}:{projectId:sourceProject,workId:review.workId,objectId,relPath};
   const result=await openFrozenChange(target);if(result?.ok===false)throw Error(result.error?.message||'冻结差异未打开');
  }catch(error){toast('冻结差异不可用：'+error.message+'；可点击成果文件名查看内容与效果。');}
 }
 async function openArtifact({objectId,relPath,sourceProject=projectId}){
  const saved=await flushManagedReviews();if(!saved.ok){toast(saved.error.message);return;}
  const gen=generation,current=()=>sourceProject===projectId&&gen===generation;
  try{
   const review=await call('review.read',{objectId},sourceProject);if(!current())return;
   const file=review.files?.find(file=>file.relPath===relPath);
   if(!review.workId||!file)throw Error('此路径不在报告冻结文件清单中；未打开同名项目文件。');
   const removed=['removed','deleted'].includes(file.status||file.change),documentSource=removed?{type:'review-version',workId:review.workId,objectId,version:{kind:'baseline'}}:{type:'review',workId:review.workId,objectId};
   const opened=await invoke('workspace.control',{type:'open-file',projectId:sourceProject,relPath,documentSource});
   if(!opened.ok)throw Error(opened.error?.message||'原生审核文档未能打开');
  }catch(error){toast('审核文档无法读取：'+error.message);}
 }
 async function refreshArtifactAvailability(force=false){
  if(!active||!state)return;
  const links=[...document.querySelectorAll('[data-managed-message] .conversation-file-link[data-path],#managed-doc .conversation-file-link[data-path]')].map(n=>n.dataset.path);
  const candidates=new Set(state.receipts.flatMap(r=>(r.snapshot?.files||[]).map(f=>f.relPath))),paths=[...new Set(links.filter(relPath=>!candidates.has(relPath)))],key=JSON.stringify([projectId,paths,state.artifacts||[]]);
  if(!force&&availabilityKey===key)return;availabilityKey=key;
  const id=projectId,gen=generation,request=++availabilityRequest;
  try{const checked=await readFileAvailability(invoke,id,paths);if(!active||id!==projectId||gen!==generation||request!==availabilityRequest)return;fileAvailability=checked;renderHistoricalLinks();}
  catch(error){if(id!==projectId||gen!==generation||request!==availabilityRequest)return;fileAvailability=new Map(paths.map(relPath=>[relPath,{relPath,status:'unavailable'}]));renderHistoricalLinks();toast('成果路径检查失败：'+error.message);}
 }
 function renderHistoricalLinks(){
  for(const link of document.querySelectorAll('[data-managed-message] .conversation-file-link[data-path],#managed-doc .conversation-file-link[data-path]')){
   const candidate=state.receipts.some(r=>r.snapshot?.files?.some(f=>f.relPath===link.dataset.path));if(candidate){link.dataset.availability='snapshot';link.title=link.dataset.path+' · 报告成果快照（只读，非原项目同名文件）';link.querySelector('.managed-link-availability')?.remove();continue;}
   const entry=fileAvailability.get(link.dataset.path);link.dataset.availability=entry?.status||'unknown';link.title=link.dataset.path+' · '+availabilityCaption(entry);
   let note=link.querySelector('.managed-link-availability');
   if(!['missing','unavailable'].includes(entry?.status)){note?.remove();continue;}
   if(!note){note=document.createElement('small');note.className='managed-link-availability';link.append(note);}
   note.textContent=' · '+availabilityCaption(entry);
  }
 }
 window.addEventListener('nozeli-project-files-refreshed',event=>{if(event.detail?.projectId===projectId)void refreshArtifactAvailability(true);});
 function recoveryCaption(result){return result.status==='inspection-required'?'已交还原线程核查；未重放执行，需核对文件后显式补充。':result.status==='committed'?'宿主确认 Git 已提交：'+(result.git?.commit||'详见原检查点回执'):'宿主确认本次 Git 未提交：'+(result.git?.reason||result.status);}
 function updateGitReceipt(todo){
  const box=$('managed-recovery-receipt');if(!box)return;
  const result=todo?.resolution;box.textContent=result?.accepted?recoveryCaption(result):'';box.hidden=!result?.accepted;
  const original=$('managed-original-issue');if(original&&result?.accepted&&!original.dataset.resolved){original.open=false;original.dataset.resolved='true';}
 }
 function recoveryReason(todo,w){
  if(todo?.resolution?.accepted)return recoveryCaption(todo.resolution);
  if(!todo||todo.status!=='open'||!w||todo.revision!==w.revision)return '事项或工作版本已变化，请刷新后核查';
  if(deviationHeld(w))return '任务偏离暂停尚未解除；请使用偏离决定按钮，通用恢复不能恢复执行。';
  if(!Number.isInteger(todo.revision)||!todo.sourceJobId||!state.jobs.some(j=>j.id===todo.sourceJobId))return '历史事项缺少来源身份，不能自动恢复或提交';
  if(!['paused','review'].includes(w.status)||state.busyTargets?.some(t=>t===w.id||t==='orchestrator')||state.agents?.some(a=>a.target===w.id&&a.starting)||state.jobs.some(j=>['queued','running','transferring'].includes(j.status)&&(j.target===w.id||j.context?.boundWorkId===w.id||j.context?.workId===w.id)))return '请等待原工作及主控停稳';
  if(state.drafts?.[w.id]||state.drafts?.orchestrator)return '原工作或主控还有未发送草稿，请先发送或明确清空';
  return '';
 }
 let reportDocument=null,disposition=null,dispositionError='',dispositionRequest=0,dispositionPending=false;
 let reportMenuAnchor={x:6,y:6};
 const dispositionKeys=new Map();
 const restoreReportTitleFocus=()=>void invoke('workspace.control',{type:'report-tools-closed',projectId,viewId:scope?.viewId});
 const reportMenu=mountContextMenu({id:'managed-report-menu',label:'报告操作',onClose:restoreReportTitleFocus,onError:message=>reportFailure(message)});
 function reportFailure(message){const node=$('managed-review-error');if(node){node.textContent=message;node.hidden=false;}else toast(message);}
 function reportDialog(title,fill){const trigger=document.activeElement,dialog=document.createElement('dialog');dialog.className='managed-report-dialog';const heading=document.createElement('h2'),content=document.createElement('section'),close=button('关闭',()=>dialog.close());heading.textContent=title;fill(content);dialog.append(heading,content,close);document.body.append(dialog);dialog.addEventListener('close',()=>{dialog.remove();if(trigger?.isConnected&&trigger!==document.body)trigger.focus({preventScroll:true});else restoreReportTitleFocus();},{once:true});dialog.showModal();close.focus();return dialog;}
 function todoDetails(id){reportDialog('待办详情',content=>{todoUI.details(content,id);const note=document.createElement('p');note.textContent='提醒管理不结束工作。静态 HTML 禁止脚本，冻结原件只读。';content.append(note);});}
 async function queryDisposition(){const source=projectId,gen=generation,doc=reportDocument,request=++dispositionRequest;if(!doc?.workId)return;disposition=null;dispositionError='';updateReviewActions();try{const value=await call('disposition',{workId:doc.workId},source);if(source!==projectId||gen!==generation||doc!==reportDocument||request!==dispositionRequest)return;disposition=value;}catch(error){if(source!==projectId||gen!==generation||doc!==reportDocument||request!==dispositionRequest)return;dispositionError=error.message;}updateReviewActions();}
 async function confirmDecision(message,title='确认成果决定',options=null){const labels=options||{},cancelLabel=labels.cancelLabel||'取消',confirmLabel=labels.confirmLabel||'确认';return new Promise(resolve=>{const trigger=document.activeElement,dialog=document.createElement('dialog');dialog.className='managed-report-dialog';dialog.dataset.confirmationDialog='';const heading=document.createElement('h2'),text=document.createElement('p'),cancel=button(cancelLabel,()=>finish(false)),confirm=button(confirmLabel,()=>finish(true));cancel.dataset.confirmationCancel='';confirm.dataset.confirmationConfirm='';heading.textContent=title;text.textContent=message;confirm.className='ui-action';cancel.className='ui-action';dialog.append(heading,text,cancel,confirm);document.body.append(dialog);function finish(value){dialog.close();dialog.remove();trigger?.focus?.({preventScroll:true});resolve(value);}dialog.oncancel=event=>{event.preventDefault();finish(false);};dialog.showModal();cancel.focus();});}
 async function disposeWork(workId,decision,documentIdentity=null){
  if(decision==='accept'&&documentIdentity?.review)return reportFailure('请在协作审核区接受确切审核版本。');
  if(dispositionPending)return;
  const source=projectId,gen=generation;dispositionPending=true;updateReviewActions();
  try{
   await draftWriter.settled();
   if(documentIdentity?.review)await documentIdentity.review.save();
   const reportDiscard=decision==='discard'&&Boolean(documentIdentity?.review);
   const prepared=reportDiscard?await invoke('workspace.review.prepareDiscard',{projectId:source,workId,objectId:documentIdentity.objectId,revision:documentIdentity.revision}):null;
   if(prepared&&!prepared.ok)throw Error(prepared.error?.message||'关联人工稿尚未完整保存，未放弃工作。');
   const capability=prepared?prepared.value:await call('disposition',{workId},source),binding=structuredClone(capability.binding),permission=capability[decision];
   if(source!==projectId||gen!==generation||documentIdentity&&documentIdentity!==reportDocument)return;
   if(documentIdentity&&(binding.revision!==documentIdentity.revision||binding.objectId!==documentIdentity.objectId))throw Error('报告版本已变化，请查看最新成果后决定。');
   if(!permission?.allowed)throw Error(permission?.message||'宿主不允许此操作。');
   const w=state.works.find(w=>w.id===workId),queueCancel=w?.status==='queued'&&binding.revision===0;
   const discard=decision==='discard'&&!queueCancel;
   const notice=workDispositionNotice({work:w,binding,decision})+(discard?'\n不把候选合入项目，不删除项目文件。已有报告、冻结成果、人工稿和未发送意见保留为只读历史；意见不会自动发送。':'');
   if(!await confirmDecision(notice,queueCancel?'取消这项排队工作？':discard?'放弃并结束':'确认成果决定',queueCancel?{cancelLabel:'保留排队',confirmLabel:'取消排队'}:discard?{cancelLabel:'返回审阅',confirmLabel:'放弃并结束'}:null))return;
   if(source!==projectId||gen!==generation||documentIdentity&&documentIdentity!==reportDocument)return;
   const identity=JSON.stringify([source,decision,binding]),requestKey=dispositionKeys.get(identity)||crypto.randomUUID();dispositionKeys.set(identity,requestKey);
   if(reportDiscard){const result=await invoke('workspace.review.discard',{projectId:source,workId,objectId:documentIdentity.objectId,binding,requestKey});if(!result.ok)throw Error(result.error?.message||'放弃决定尚未确认，原成果保留。');}
   else await call('end',{workId,binding,requestKey,revision:binding.revision,decision},source);
   dispositionKeys.delete(identity);
   if(source===projectId&&gen===generation)await refresh();
  }catch(error){if(source===projectId&&gen===generation)reportFailure(error.message);}
  finally{dispositionPending=false;if(source===projectId&&gen===generation)void queryDisposition();}
 }
 function openReportTools(){
  const doc=reportDocument;if(!doc)return;
  const items=[],actions=new Map(),add=(id,label,run,enabled=true)=>{items.push({id,label,enabled});actions.set(id,run);};
  add('save','另存报告到项目…',()=>exportReport(doc),doc.verified);
  add('copy','复制报告源码',async()=>{const result=await invoke('report.copySource',{projectId:doc.projectId,objectId:doc.objectId});if(!result.ok)throw Error(result.error?.message||'冻结报告源码复制失败');},doc.verified);
  if(doc.view)add('print','打印报告',()=>doc.view.print());
  if(!doc.verified)items.push({notice:'冻结源码不可用：'+(doc.error||'此事项没有冻结报告对象。')});
  items.push({separator:true});
  if(doc.workId)add('work','查看关联任务概览',()=>inspectWork(doc.workId));
  if(doc.todoId)add('todo','查看待办详情',()=>todoDetails(doc.todoId));
  reportMenu.open(items,{x:reportMenuAnchor.x,y:reportMenuAnchor.y,run:id=>actions.get(id)?.()});
 }
 window.nozeli.subscribe('workspace.control',event=>{if(event.type==='content-command'&&event.command==='report-tools'&&event.projectId===projectId&&event.viewId===scope?.viewId){reportMenuAnchor={x:Math.max(6,event.anchor?.x||0),y:Math.max(6,event.anchor?.y||0)};openReportTools();}});
 window.nozeli.subscribe('workspace.control',event=>{if(event.type==='focus-content'&&['report','history'].includes(scope?.kind))void reportDocument?.review?.observe();});
 function updateReviewActions(){
  void refreshReviewPublication().catch(error=>toast('最新报告未切换；当前报告与草稿保留：'+error.message));
  const footer=$('managed-result-actions'),doc=reportDocument;if(!doc)return;
  void syncReportPresentation(doc).catch(error=>toast('报告标题未更新，原件保留：'+error.message));
  doc.review?.updateAvailability();
 if(doc.review){const work=state?.works.find(work=>work.id===doc.workId),signature=JSON.stringify([work?.status,work?.revision,work?.closure,work?.result?.objectId,work?.review?.drafts]);if(doc.reviewSignature!==signature){doc.reviewSignature=signature;void doc.review.observe();if(work?.status==='closing')void queryDisposition();}}
 const closure=doc.review?.root.querySelector('[data-review-closure]'),work=state?.works.find(work=>work.id===doc.workId);
 const closureMatches=Boolean(work?.closure?.binding&&work.closure.binding.objectId===doc.objectId&&work.closure.binding.revision===doc.revision);
 const summary=$('managed-doc')?.querySelector(':scope > .managed-report-state[data-report-state]');
 if(summary&&closureMatches&&work.status==='ended'&&work.closure.phase==='complete')summary.textContent=(doc.publicationNumber?'报告 V'+doc.publicationNumber:'工作修订 '+doc.revision)+' · '+(work.outcome==='accept'?'已接受':'已丢弃')+' · 全部收尾已完成';
 if(closure){
  closure.hidden=!closureMatches||work.status!=='closing';const note=closure.querySelector('[data-closure-state]');note.textContent=closureProcessingStatus(work);
  const gate=closure.querySelector('[data-closure-gate]');gate.hidden=!state.todos.some(todo=>todo.workId===doc.workId&&todo.status==='open'&&['merge-consent','merge-constraint'].includes(todo.kind));
  const detail=closure.querySelector('[data-closure-detail]');detail.textContent='原决定、报告与未发送意见保留；系统继续处理原任务收尾，故障由后台维护处理，不重放 Worker。';
 }
  if(!footer)return;
  doc.problemDecision?.update();
  if(doc.report?.source==='demo-fixture'){
   const todo=state?.todos.find(todo=>todo.id===doc.todoId),status=footer.querySelector('[data-report-state]'),reason=footer.querySelector('[data-report-reason]');
   if(status)status.textContent=todo?.resolution?.choice==='accept'?'已接受演示结论（未改动真实任务）':todo?.resolution?.choice==='discard'?'已丢弃演示结论（示例文件保留）':todo?.status==='open'?'【演示内容】待决定；查看或稍后不会接受':'演示事项已关闭或移除，报告原件保留。';
   for(const button of footer.querySelectorAll('[data-demo-decision]'))button.disabled=dispositionPending||todo?.status!=='open';
   if(reason)reason.textContent='固定教学报告；本操作仅记录本地演示决定，不写入论文、不启动真实 Worker。';
   return;
  }
  const w=state?.works.find(w=>w.id===doc.workId);if(!w)return;
  const status=footer.querySelector('[data-report-state]'),reason=footer.querySelector('[data-report-reason]'),discuss=footer.querySelector('[data-report-discuss]'),accept=footer.querySelector('[data-managed-end-result]');
 const history=doc.historical||w.revision!==doc.revision||Boolean(w.closure?.binding&&!closureMatches),ended=w.status==='ended',closing=w.status==='closing',decided=ended||closing,outcome=w.outcome||w.closure?.decision,decision=outcome==='accept'?'已接受':outcome==='discard'?'已丢弃':'原决定需核查';
 if(status)status.textContent=decided&&closureMatches?decision+(ended?' · 全部收尾已完成':' · '+closureProcessingStatus(w)):history?'历史版本 · '+(doc.publicationNumber?'报告 V'+doc.publicationNumber:'工作修订 '+doc.revision):decided?'原决定绑定需核查 · '+(doc.publicationNumber?'报告 V'+doc.publicationNumber:'工作修订 '+doc.revision):(doc.kind==='problem'?'需要补充':'待审阅')+' · '+(doc.publicationNumber?'报告 V'+doc.publicationNumber:'工作修订 '+doc.revision);
 if(discuss){discuss.hidden=decided||history;discuss.dataset.uiAction=doc.kind==='problem'?'primary':'secondary';}
 if(accept){accept.hidden=Boolean(doc.review)||decided||history||doc.kind!=='result';accept.disabled=Boolean(doc.review)||dispositionPending||!doc.verified||!disposition?.accept?.allowed;accept.textContent=dispositionPending?'正在处理…':'接受并收尾…';}
  if(reason){
   reason.replaceChildren();
 let message=closing&&closureMatches?'原决定与报告保留；系统继续处理原任务收尾，故障由后台维护处理，不重放 Worker。':dispositionError?'无法核实：'+dispositionError:!disposition&&!history&&!ended?'正在核实处置条件…':!history&&!ended&&doc.kind==='result'&&!disposition?.accept?.allowed?disposition?.accept?.message||'':'';
   reason.textContent=typeof message==='string'?message:JSON.stringify(message);
   if(dispositionError&&!closing)reason.append(button('重新核实',()=>queryDisposition()));
  }
  const recovery=footer.querySelector('[data-managed-recovery-action]');if(recovery){const todo=state.todos.find(t=>t.id===viewed?.todoId),why=recoveryReason(todo,w);recovery.disabled=!ready||Boolean(why);const note=footer.querySelector('[data-managed-recovery-note]');if(note)note.textContent=why;}
 }
 let publicationRefresh=null;
 async function refreshReviewPublication(explicit=false){
  if(explicit){
   const requested=reportDocument,sourceProject=projectId;
   await requested?.review?.whenIdle();
   if(publicationRefresh)await publicationRefresh;
   if(reportDocument!==requested||projectId!==sourceProject)return;
  }
  const doc=reportDocument,work=state?.works.find(work=>work.id===doc?.workId),objectId=work?.result?.objectId;
  if(!doc?.review||!objectId||objectId===doc.objectId||(!explicit&&(doc.historical||doc.view))||publicationRefresh||doc.review.processing)return;
  const body=$('managed-doc')?.querySelector('.managed-report-body'),selection=document.getSelection();
  if(!body||(!explicit&&selection&&!selection.isCollapsed&&body.contains(selection.anchorNode)))return;
  const sourceProject=projectId,originalObjectId=doc.objectId;
  const current=()=>projectId===sourceProject&&reportDocument===doc&&doc.objectId===originalObjectId;
  publicationRefresh=(async()=>{
   await doc.review.save();
   if(!current())return;
   const result=await invoke('managed.history.read',{projectId:sourceProject,objectId});
   if(!result.ok)throw Error(result.error?.message||'最新报告不可读取');if(!current())return;
   const report=result.value.report,revision=work.revision,publicationNumber=result.value.publicationNumber??publicationOrdinal(state,work.id,objectId);
   // Metadata-only restore authorizes the actual report object without opening
   // a tab, selecting a group, touching document buffers or moving focus.
   if(scope?.viewId){
    const entryTitle=(work.name||'任务')+' · '+(publicationNumber?'报告 V'+publicationNumber:'工作修订 '+revision);
    const viewState={...scope.viewState,title:entryTitle,report:{...scope.viewState?.report,title:entryTitle,projectId:sourceProject,workId:doc.workId,objectId,revision,publicationNumber,report}};
    const saved=await invoke('workspace.command',{projectId:sourceProject,requestKey:crypto.randomUUID(),command:{type:'restoreViewState',viewId:scope.viewId,viewState}});
    if(!saved.ok)throw Error(saved.error?.message||'最新报告归属未保存');if(!current())return;scope.viewState=viewState;
   }
   const scroll=$('reader-scroll'),top=scroll?.scrollTop;
   doc.view?.dispose();body.replaceChildren();doc.objectId=objectId;doc.revision=revision;doc.publicationNumber=publicationNumber;doc.report=report;doc.historical=false;doc.verified=true;
   if(report.format==='html-static')doc.view=mountReport(body,{invoke,projectId:sourceProject,objectId,onReference:t=>openArtifact({objectId,...t,sourceProject})});
   else {doc.view=null;renderTagMarkdown(body,result.value.body||'',{onFile:t=>openArtifact({objectId,...t,sourceProject}),onExternal:url=>openExternal?.(url)});await appendFrozenArtifacts(body,objectId,sourceProject,()=>projectId===sourceProject&&reportDocument===doc&&doc.objectId===objectId);}
   await doc.review.bind(objectId);if(scroll&&top!==undefined)scroll.scrollTop=top;
   disposition=null;void queryDisposition();
  })();
  try{await publicationRefresh;}finally{publicationRefresh=null;}
 }
 async function openTodo(id){
  const permission=state?.todos.find(todo=>todo.id===id&&(['effect-permission','effect-grant'].includes(todo.destination?.kind)||todo.destination?.kind==='conversation'&&todo.destination.question?.method==='approve'));
  if(permission){
   if(!permissionSlot){const result=await invoke('workspace.control',{type:'conversation-action',action:'todo',todoId:id,projectId,target:'frontdesk'});if(result?.ok===false)toast(result.error?.message||'原对话未能打开');return;}
   const signature=JSON.stringify(permission.destination);
   if(permissionView?.todoId===id&&permissionView.signature===signature){permissionView.ui.update(permission);permissionSlot.scrollIntoView({block:'nearest'});return;}
   const sourceProject=projectId,gen=generation,view={todoId:id,signature,ui:null};
   const current=()=>sourceProject===projectId&&gen===generation&&permissionView===view&&state?.todos.some(todo=>todo.id===id&&todo.status==='open'&&JSON.stringify(todo.destination)===signature);
   permissionView=view;permissionSlot.replaceChildren();permissionSlot.dataset.conversationPermission=id;permissionSlot.hidden=false;
   const destination=permission.destination,sourceName=labels[destination.target]||state.works?.find(work=>work.id===destination.target)?.name||'';
   view.ui=mountAttentionDialogue(permissionSlot,{document,projectId:sourceProject,todo:permission,invoke,current,onRefresh:refresh,drafts:attentionDrafts,confirm:confirmDecision,meta:{projectName:($('project-name')?.textContent||'').trim(),sourceName}});
   permissionSlot.scrollIntoView({block:'nearest'});return;
  }
  const saved=await flushManagedReviews();if(!saved.ok){toast(saved.error.message);return;}
  const preservedProblem=state?.todos.find(todo=>todo.id===id&&todo.kind==='problem'&&todo.status==='open'&&state.works.some(work=>work.id===todo.workId&&work.status==='paused'&&work.problem?.objectId===todo.objectId&&work.revision===todo.revision));
  // Explicit report navigation is not an inbox notification or an authorization.
  const presented=managedInboxTodos(state??{}).find(t=>t.id===id)??preservedProblem;
  if(!presented){toast('此记录属于后台运行诊断，不是用户待办。');return;}
  const todo=managedReviewTodos(state??{}).find(t=>t.id===id)||(['result','problem'].includes(presented?.kind)?presented:null);
  const readOnlyResult=Boolean(todo?.kind==='result'&&!presented?.pending);
  if(!todo){
   const historical=state?.todos.find(t=>t.id===id);if(!historical)return;
   const sourceProject=projectId,gen=generation,request=++reportRequest,current=()=>sourceProject===projectId&&gen===generation&&request===reportRequest;
   const opened=await openManaged({id,todoId:id,projectId:sourceProject,title:historical.title||'后台记录',text:historical.text||'',attention:true,isCurrent:current});
   if(opened?.ok===false||!current()||scope?.kind!=='report')return;
   reportDocument=null;disposition=null;attentionView=null;todoUI.details($('managed-doc'),id);return;
  }
  if(todo.origin==='instance-attention'||['frontdesk-route','cross-project-permission','effect-permission','effect-grant'].includes(todo.destination?.kind)){
   const sourceProject=projectId,gen=generation,request=++reportRequest;
   const current=()=>sourceProject===projectId&&gen===generation&&request===reportRequest;
   const opened=await openManaged({id:todo.id,todoId:todo.id,projectId:sourceProject,title:todo.title||'待办对话',text:todo.text||'',attention:true,isCurrent:current});
   if(opened?.ok===false||!current()||scope?.kind!=='report')return;
   reportDocument=null;disposition=null;attentionView=null;
   const content=$('managed-doc');content.replaceChildren();
   const destination=todo.destination||{};
   const sourceName=labels[destination.target]||state.works?.find(w=>w.id===destination.target)?.name||'',projectName=($('project-name')?.textContent||'').trim();
   const ui=mountAttentionDialogue(content,{document,projectId:sourceProject,todo,invoke,current,onRefresh:refresh,drafts:attentionDrafts,confirm:confirmDecision,meta:{...(projectName?{projectName}:{}),...(sourceName?{sourceName}:{})},
    openSettings:section=>{if(!current())throw Error('项目已变化，请重新打开原待办。');window.dispatchEvent(new CustomEvent('nozeli-open-settings',{detail:section}));},
    recover:destination.target?async()=>{
     if(!current())throw Error('项目已变化，请重新打开原待办。');
     const agent=state.agents?.find(a=>a.target===destination.target);
     if(destination.ownerId&&agent?.ownerId!==destination.ownerId)throw Error('原会话身份已变化，请刷新核对；不会恢复其他会话。');
     if(!agent?.closed)throw Error('原会话尚未退出；不会重启活动会话或重放任务。请核对说明与设置后刷新。');
     await call('restart',{target:destination.target},sourceProject);await refresh();
    }:async()=>{await refresh();renderResidentRecovery(residentStatus);const recovery=document.createElement('section');content.append(recovery);for(const element of [residentRecovery,workerRecovery])if(!element.hidden)recovery.append(element);if(!recovery.childNodes.length)recovery.textContent='当前没有可执行的恢复动作；连接状态会在原对话中更新。';}
   });
   attentionView={todoId:todo.id,ui};return;
  }
  if(todo.kind==='merge-consent'){
   // One-time local-merge authorization card: the decision payload (request
   // id/version + exact 8-field binding) is read from the host disposition,
   // never fabricated client-side; duplicate clicks stay idempotent.
   const sourceProject=projectId,gen=generation,request=++reportRequest;
   const current=()=>sourceProject===projectId&&gen===generation&&request===reportRequest;
   let consent=null;
   try{consent=(await call('disposition',{workId:todo.workId},sourceProject))?.mergeConsent??null;}catch{}
   const opened=await openManaged({id:todo.id,todoId:todo.id,projectId:sourceProject,title:todo.title||'合入批准',text:todo.text||'',attention:true,isCurrent:current});
   if(opened?.ok===false||!current()||scope?.kind!=='report')return;
   reportDocument=null;disposition=null;attentionView=null;
   const content=$('managed-doc');content.replaceChildren();
   const enriched={...todo,destination:{kind:'merge-consent',workId:todo.workId,requestId:consent?.request?.id??null,expectedVersion:consent?.request?.version??null,sourceJobId:null,question:{method:'merge-consent',title:'一次性本地合入批准（非提权执行）',effectHash:consent?.request?.effectHash??null,binding:consent?.binding??null,candidateCommit:consent?.binding?.candidateCommit??null,reviewVersion:consent?.binding?.reviewVersion??null,repo:consent?.binding?.repo??null,targetRef:consent?.binding?.targetRef??null,note:'仅授权把已审校候选提交到原仓库目标分支；不涉及 root/提权执行，不重放 Worker，不改写原请求。'}}};
   const ui=mountAttentionDialogue(content,{document,projectId:sourceProject,todo:enriched,invoke,current,onRefresh:refresh,drafts:attentionDrafts,confirm:confirmDecision,meta:{...(($('project-name')?.textContent||'').trim()?{projectName:($('project-name')?.textContent||'').trim()}:{})},openSettings:()=>{},recover:async()=>{await refresh();}});
   attentionView={todoId:todo.id,ui};return;
  }
 if(todo.kind==='merge-constraint'){
  // Host-authored merge strategy gate: three explicit decisions bound to the
  // todo's constraintVersion; no default, no reopen, no replay.
  const sourceProject=projectId,gen=generation,request=++reportRequest;
  const current=()=>sourceProject===projectId&&gen===generation&&request===reportRequest;
  const opened=await openManaged({id:todo.id,todoId:todo.id,projectId:sourceProject,title:todo.title||'合并策略决定',text:todo.text||'',attention:true,isCurrent:current});
  if(opened?.ok===false||!current()||scope?.kind!=='report')return;
  reportDocument=null;disposition=null;attentionView=null;
  if(agentDetails.open)agentDetails.close();
  const content=$('managed-doc');content.replaceChildren();
  const w=state.works.find(x=>x.id===todo.workId);
  const intro=document.createElement('p');intro.textContent='宿主在技术收尾处等待明确的合并策略；本视图只读，不重开工作、不重放任务、不自动发送草稿。';content.append(intro);
  if(w){const card=document.createElement('section');content.append(card);paintMergeConstraint(card,w,todo);const facts=document.createElement('section');content.append(facts);renderClosureStatus(facts,w);}
  const management=document.createElement('section');management.className='managed-todo-detail-actions';content.append(management);todoUI.details(management,todo.id);
  return;
 }
  if(scope?.kind!=='report'){
    return openManaged({id:todo.id,todoId:todo.id,projectId,title:todo.title||state.works.find(w=>w.id===todo.workId)?.name||'待办',text:todo.text||''});
  }
  if(todo.kind==='frontdesk-route'){
   const proposal=state.frontdeskRoutes?.find(route=>route.id===todo.proposalId);
   const sourceProject=projectId,gen=generation;
   const result=await openManaged({id:todo.id,projectId:sourceProject,title:'前台去向决定',text:proposal?frontdeskRouteText(proposal):todo.text||'原去向建议记录已不可用；不会自动转交或重放。',writtenBack:null});
   if(result?.ok===false||sourceProject!==projectId||gen!==generation)return;
   viewed={todoId:todo.id,kind:todo.kind,readOnly:true};render();routeBox.scrollIntoView({block:'nearest'});
   const management=document.createElement('section');management.className='managed-todo-detail-actions';$('managed-doc').append(management);todoUI.details(management,todo.id);return;
  }
  const w=state.works.find(w=>w.id===todo.workId),sourceProject=projectId,gen=generation,request=++reportRequest;
  const receipt=state.receipts.find(r=>r.objectId===todo.objectId);
  const source=todo.objectId?await invoke('managed.history.read',{projectId:sourceProject,objectId:todo.objectId}):null;
  if(sourceProject!==projectId||gen!==generation||request!==reportRequest)return;
  const descriptor=source?.ok?source.value.report:receipt?.report;
  const text=source?.ok?(descriptor.format==='markdown'?source.value.body:undefined):todo.kind==='result'?'报告暂不可读取：'+(source?.error?.message||'此提醒未记录报告对象。')+'；原任务和提醒保留，未重新执行。':source?'报告读取失败：'+(source.error?.message||'未知错误')+'；原件保留。':todo.text||'当前没有正文。';
  const title=presented?.title||todo.title||(w?.name||'用户事项')+' · '+(presented?.publicationLabel||'工作修订 '+todo.revision);
  const stillCurrent=()=>sourceProject===projectId&&gen===generation&&request===reportRequest&&state?.todos.some(t=>t.id===id&&(t.managementRevision||0)===(todo.managementRevision||0));
  const result=await openManaged({id:todo.id,todoId:todo.id,projectId:sourceProject,objectId:todo.objectId,title,text:source?.ok&&descriptor?.format==='html-static'?'静态 HTML 报告':text,publicationNumber:presented?.publicationVersion,report:descriptor,writtenBack:null});
  if(result?.ok===false)return;
  if(!stillCurrent()){if(sourceProject===projectId&&gen===generation&&request===reportRequest){$('managed-doc').replaceChildren();$('managed-doc').textContent='待办已变化或移除，请从待办面板重新查看。';}return;}
  const listing=readOnlyResult?(todo.objectId?await invoke('managed.artifact.list',{projectId:sourceProject,objectId:todo.objectId}):null):await invoke('project.list',{projectId:sourceProject});if(!stillCurrent()){if(sourceProject===projectId&&gen===generation&&request===reportRequest){$('managed-doc').replaceChildren();$('managed-doc').textContent='待办已变化或移除，请重新查看。';}return;}
  const filePaths=readOnlyResult?new Set((listing?.ok?listing.value.files:[]).map(file=>file.relPath)):new Set([...(listing.ok?listing.value.entries.filter(e=>e.kind!=='dir').map(e=>e.relPath):[]),...(state.artifacts||[]).map(a=>a.relPath),...(receipt?.snapshot?.files||[]).map(f=>f.relPath)]);projectFilePaths=filePaths;
 $('managed-doc').replaceChildren();let body=['result','problem'].includes(todo.kind)?reportBody($('managed-doc')):$('managed-doc');
  if(todo.kind==='git'){
   const current=document.createElement('p');current.id='managed-recovery-receipt';current.setAttribute('role','status');current.hidden=true;body.append(current);
   const original=document.createElement('details'),label=document.createElement('summary'),originalBody=document.createElement('div');original.id='managed-original-issue';label.textContent='原事项正文（历史记录，不代表当前处理结果）';original.open=!todo.resolution?.accepted;original.append(label,originalBody);body.append(original);body=originalBody;updateGitReceipt(todo);
  }
  reportDocument={projectId:sourceProject,objectId:todo.objectId??null,title,revision:todo.revision,publicationNumber:source?.value?.publicationNumber??presented?.publicationVersion,workId:w?.id,todoId:todo.id,kind:todo.kind,report:descriptor,verified:Boolean(source?.ok),historical:readOnlyResult||!w||w.revision!==todo.revision,error:source?.error?.message};disposition=null;dispositionError='';
  if(source?.ok&&descriptor?.format==='html-static')reportDocument.view=mountReport(body,{invoke,projectId:sourceProject,objectId:todo.objectId,onReference:t=>openArtifact({objectId:todo.objectId,...t,sourceProject})});
  else renderTagMarkdown(body,text.replaceAll(']('+state.contentRoot+'/',']('),{filePaths,onFile:t=>readOnlyResult||receipt?.snapshot?.files?.some(f=>f.relPath===t.relPath)?openArtifact({objectId:todo.objectId,...t,sourceProject}):openProjectFile?.({projectId:sourceProject,...t}),onExternal:url=>openExternal?.(url)});
  // Freeze the report source before review reads may attach a local controller.
  // refresh catches preview errors, so failed previews still expose review controls.
  if(reportDocument.view){await reportDocument.view.ready;if(!stillCurrent())return;}
 if(source?.ok&&!reportDocument.view&&['result','problem'].includes(todo.kind))await appendFrozenArtifacts(body,todo.objectId,sourceProject,stillCurrent);
 if(source?.ok&&todo.kind==='result')await appendReview($('managed-doc'),reportDocument);
  if(readOnlyResult){
   const summary=document.createElement('p');summary.className='managed-report-state';summary.dataset.reportState='';summary.textContent=[presented.versionLabel,presented.statusLabel,presented.historical?'历史报告只读 · 此版不能接受或交回修改':w?.status==='closing'?closureProcessingStatus(w):'本轮尚在处理 · 暂不接受审阅决定'].filter(Boolean).join(' · ');appendLatestReview(summary,reportDocument,stillCurrent);$('managed-doc').prepend(summary);
   viewed={todoId:todo.id,workId:w?.id,revision:todo.revision,kind:todo.kind,readOnly:true};render();
 if(reportDocument.review){void queryDisposition();return;}
 const management=document.createElement('section');management.className='managed-todo-detail-actions';$('managed-doc').append(management);const detail=mountReviewDetail(management,'查看待办详情');todoUI.details(detail.body,todo.id);return;
  }
  if(source?.ok&&todo.kind==='problem'&&w&&todo.status==='open'&&w.revision===todo.revision&&!deviationHeld(w)){
   reportDocument.problemDecision=mountProblemDecision($('managed-doc'),{document,projectId:sourceProject,work:w,publication:{objectId:todo.objectId,revision:todo.revision},drafts:problemDrafts,current:()=>stillCurrent()&&state.works.some(work=>work.id===w.id&&work.status==='paused'&&work.revision===todo.revision&&work.problem?.objectId===todo.objectId),invoke:(op,p)=>invoke(op,{...p,projectId:sourceProject}),refresh,discard:()=>disposeWork(w.id,'discard',reportDocument)});
  }
  if(todo.kind==='deviation'&&w&&w.deviation?.todoId===todo.id){const gate=document.createElement('section');$('managed-doc').append(gate);paintDeviation(gate,w);}
  const business=todo.status==='open'&&!todo.reopenedAt&&w&&!w.readOnly&&todo.revision===w.revision&&['result','problem'].includes(todo.kind)&&!['closing','ended'].includes(w.status),routing=todo.status==='open'&&!todo.reopenedAt&&todo.kind==='routing'&&!w?.readOnly;
  // Report identity is local reading state, not a request to open its online conversation.
  viewed={todoId:todo.id,workId:w?.id,revision:todo.revision,kind:todo.kind,routingQuestionId:routing?todo.id:null,readOnly:!business&&!routing};render();
 if(reportDocument?.review){if(!fixtureMode)void queryDisposition();return;}
  const footer=document.createElement('div');footer.id='managed-result-actions';
  const action= (caption,fn)=>button(caption,async()=>{try{await fn();await refresh();}catch(error){if(error.businessRejection)return;let notice=$('managed-review-error');if(!notice){notice=document.createElement('p');notice.id='managed-review-error';notice.setAttribute('role','alert');footer.append(notice);}notice.textContent=error.message;}});
  if(todo.source==='demo-fixture')for(const [choice,caption]of [['accept','接受演示结论'],['discard','丢弃演示结论']]){
   const decide=action(caption,async()=>{if(!stillCurrent())throw Error('原演示事项已变化，请重新打开');dispositionPending=true;updateReviewActions();try{const result=await call('todo.manage',{todoId:todo.id,expectedRevision:todo.managementRevision||0,action:'demo-'+choice,requestKey:crypto.randomUUID()},sourceProject);if(!result.accepted)throw Error('未取得演示决定回执');}finally{dispositionPending=false;updateReviewActions();}});
   decide.dataset.demoDecision=choice;footer.append(decide);
  }
  if(todo.status==='open'&&!todo.reopenedAt&&!w?.readOnly){
  if(w&&!['closing','ended'].includes(w.status)){
   const discuss=action('回到前台讨论',()=>{if(sourceProject!==projectId)return;select('frontdesk');});discuss.dataset.reportDiscuss='';discuss.className='ui-action';footer.append(discuss);
   if(todo.kind==='result'){const end=action('接受并结束…',()=>disposeWork(w.id,'accept',reportDocument));end.dataset.managedEndResult='';end.className='ui-action';end.dataset.uiAction='primary';end.setAttribute('aria-describedby','managed-report-reason');footer.append(end);}
  }
  const job=state.jobs.find(j=>j.id===todo.sourceJobId);if(['system','routing'].includes(todo.kind)&&job?.type==='intake'&&!intakeSystemFault(job)&&(job.status==='transferring'||w&&['failed','interrupted'].includes(job.status)))footer.append(action(job.status==='transferring'?'重试转交':'重试主控处理',()=>call('intake.retry',{jobId:job.id,requestKey:retryKeys.get(job.id)||crypto.randomUUID()},sourceProject)));
  if(['recovery','git'].includes(todo.kind)&&w&&!['closing','ended'].includes(w.status)){
   const op=todo.kind==='git'?'git.retry':'recovery.resolve',identity=sourceProject+':'+todo.id,hostIdentity=JSON.stringify([sourceProject,todo.kind,todo.id,w.id,todo.revision,todo.sourceJobId]);
   const retry=action(todo.kind==='git'?'重查并重试原 Git 检查点':'返回原线程核查（不重放执行）',async()=>{
    if(recoveryPending.has(identity))return;recoveryPending.add(identity);retry.disabled=true;
    try{
     const pending=state.todoActions?.find(a=>a.identity===hostIdentity&&!a.result),requestKey=pending?.requestKey||retryKeys.get(identity)||crypto.randomUUID();retryKeys.set(identity,requestKey);
     const result=await call(op,{todoId:todo.id,workId:w.id,revision:todo.revision,sourceJob:todo.sourceJobId,requestKey},sourceProject);
     if(typeof result.accepted!=='boolean')throw Error('宿主未返回明确恢复回执；保留原请求身份，请重试核查');
     retryKeys.delete(identity);await refresh();
     if(!result.accepted)throw Object.assign(Error(result.error?.message||'宿主拒绝恢复，原事项保留'),{businessRejection:true});
     if(sourceProject!==projectId||gen!==generation||viewed?.todoId!==todo.id)return;
     footer.querySelector('#managed-review-error')?.remove();
     if(todo.kind==='recovery'){viewed=null;inspectWork(result.workId);$('compose-status').textContent='未重放原执行；可回前台讨论或显式提交后台补充。';toast('已打开任务概览；主对话仍在前台。');}
     else updateGitReceipt(state.todos.find(t=>t.id===todo.id));
    }finally{recoveryPending.delete(identity);if(sourceProject===projectId)updateReviewActions();}
   });retry.dataset.managedRecoveryAction=op;footer.append(retry);
   const notice=document.createElement('p');notice.dataset.managedRecoveryNote='';footer.append(notice);
   const inspect=action('查看原任务概览',()=>{if(sourceProject!==projectId)return;inspectWork(w.id);});footer.append(inspect);
  }
  }
  const status=document.createElement('p');status.dataset.reportState='';status.className='managed-report-state';footer.prepend(status);const reason=document.createElement('p');reason.id='managed-report-reason';reason.dataset.reportReason='';reason.setAttribute('role','status');footer.append(reason);const error=document.createElement('p');error.id='managed-review-error';error.setAttribute('role','alert');error.hidden=true;footer.append(error);
  $('managed-doc').append(footer);if(fixtureMode)updateReviewActions();else void queryDisposition();
 }
 async function refresh(){const id=projectId,gen=generation,version=++refreshing;if(!id)return;let s;try{s=await call('status',{},id);}catch(error){if(id===projectId&&gen===generation&&version===refreshing)todoUI.unavailable(id);throw error;}if(id!==projectId||gen!==generation||version!==refreshing)return;state=s.state;if(!state){todoUI.unavailable(id);return;}if(fixtureMode){render();return;}ready=Boolean(s.ready);if(ready&&state?.agents?.some(a=>a.target==='frontdesk'&&!a.closed))sessionRecoveryError='';if(!active&&s.enabled)show(true);renderResidentRecovery(s);if(state)render();}
 const resetSession=()=>{workMenu.close();categoryMenu.close();delete workInfo.dataset.workId;requestReads.clear();clear();};
 window.addEventListener('nozeli-project-change',()=>{permissionView=null;if(permissionSlot){permissionSlot.hidden=true;permissionSlot.replaceChildren();delete permissionSlot.dataset.conversationPermission;}});
 window.addEventListener('nozeli-project-change',()=>{reportMenu.close();workMenu.close();categoryMenu.close();reportDocument=null;disposition=null;++dispositionRequest;});
 function observeFixture(id,snapshot){if(snapshot?.source!=='demo-fixture')throw Error('不是登记的演示来源');projectId=id;state=snapshot;fixtureMode=true;active=false;ready=false;render();}
 function clear({rememberDraft=true}={}){collaboration.clear();retireReviews();fixtureMode=false;if(rememberDraft)remember();if(agentDetails.open)agentDetails.close();agentDetailsStatus.textContent='';workInfo.hidden=true;workInfo.replaceChildren();delete workInfo.dataset.signature;$('ai-status').textContent='';delete $('ai-status').dataset.state;identityReads.clear();renderConfigurationNotice(configurationNotice,[]);routeUI.clear();todoUI.clear();mergePending.clear();mergeErrors.clear();reportRequest++;historyRequest++;pageRequest++;historyPage=false;pageError='';active=false;sessionStore.reset(null);timelineBox.hidden=true;historyReceiptSignature=null;historyItems=[];historyVersion=null;historyNext=null;historyTotal=0;historyLoading=false;historyNotice='';renderHistory();if(exportDialog.open)exportDialog.close();exportSource=null;sourceMessage=null;sourceBox.hidden=true;sourceGoal.value='';for(const row of workRows.values())row.remove();workRows.clear();generation++;ready=false;state=null;toolbar.hidden=true;toolbar.replaceChildren();progressBox.hidden=true;progressBox.replaceChildren();progressSignature=null;delete $('conversation-panel').dataset.managedConversation;projectFilePaths=new Set();fileAvailability=new Map();availabilityKey=null;availabilityRequest++;target='frontdesk';viewed=null;lockHistory();$('composer').disabled=false;show(false);}
 async function load(id,{connect=true,input,observe=false}={}){
  if(id!==projectId){const saved=await flushManagedReviews();if(!saved.ok){toast(saved.error.message);return false;}retireReviews();}
  let frame=input?.frame||scope?.viewState||{};
  const reloading=ownsConversation&&projectId===id&&state;
  if(reloading){captureInput();frame={...scope?.viewState,workspace:{...scope?.viewState?.workspace,draft:$('composer').value},composerMaterials:window.__composerMaterials?.snapshotPersist()};}
  if(input&&!reloading&&input.projectId!==id)frame={...frame,conversationInput:{projectId:input.projectId,target:frame.conversationInput?.target}};
  const oldHistory=id===projectId&&viewed?.history?viewed:null,oldTarget=target,oldDraft=$('composer').value;
  resetSession();projectId=id;sessionStore.reset(id);inputEpoch++;inputIdentityReason='正在核对输入归属…';if(ownsConversation){target=null;$('composer').readOnly=true;$('send-message').disabled=true;}
  if(id)todoUI.loading(id);
  updateBackgroundSubmit();
  workControl.clear();serviceFaults.clear();void serviceFaults.refresh();
  if(!id)return false;if(oldHistory){viewed=oldHistory;target=oldTarget;$('composer').value=oldDraft;lockHistory();}
  void refreshProjectFiles().catch(error=>toast('文件链接列表读取失败：'+error.message));residentStatus=null;residentRecovery.hidden=true;residentRecovery.replaceChildren();void loadHistory();
  const gen=generation;let status;try{status=await call('status',{},id);}catch(error){if(gen===generation&&id===projectId)todoUI.unavailable(id);throw error;}if(gen!==generation||id!==projectId)return false;
  state=status.state;if(!state)todoUI.unavailable(id);if(ownsConversation&&!oldHistory)restoreInput(frame);
  if(pendingConversation&&pendingConversation.projectId===projectId){const event=pendingConversation;pendingConversation=null;if(event.action==='select')select(event.target);if(event.action==='todo')await openTodo(event.todoId);}
  if(!status.enabled){show(true);ready=false;if(state)render();else if(ownsConversation){renderInputIdentity();$('composer').disabled=false;$('send-message').disabled=true;}return false;}
  updateBackgroundSubmit();
  show(true);ready=Boolean(status.ready);renderResidentRecovery(status);if(state)render();
  if(observe){ready=Boolean(status.ready);if(state)render();return true;}
  if(!connect){ready=false;if(state)render();await readTimeline();return true;}
  if(status.handoff){ready=false;if(state)render();return true;}
  // A restored input surface is ready before the native reconnect receipt: host
  // controls must remain deliverable while that receipt is outstanding.
  void (async()=>{
   let connected;
   try{connected=await call('connect',{},id);}catch(error){
    if(gen!==generation||id!==projectId)return;const failed=await call('status',{},id).catch(()=>status);if(gen!==generation||id!==projectId)return;state=failed.state;sessionRecoveryError='恢复失败：'+error.message+'；原目标和草稿保留，未重放。';renderResidentRecovery({...failed,connectionError:failed.connectionError||{code:error.code,message:error.message}});render();return;
   }
   if(gen!==generation||id!==projectId)return;ready=connected.ready===true;state=connected.state;if(ready)sessionRecoveryError='';renderResidentRecovery(connected);render();
   if(pendingConversation){const event=pendingConversation;pendingConversation=null;if(event.action==='select')select(event.target);if(event.action==='todo')await openTodo(event.todoId);}void loadHistory();
  })().catch(error=>{if(gen===generation&&id===projectId)toast('原会话恢复失败：'+error.message);});
  return true;
 }
 async function enable(id){const gen=generation;projectId=id;sessionStore.reset(id);const connected=await call('enable',{},id);if(gen!==generation||id!==projectId)return;show(true);ready=connected.ready===true;state=connected.state;render();}
 function send(text,context={}){if(!context.preserveDraft&&target!=='frontdesk')return Promise.reject(Error('主对话仅发送给前台；原后台草稿保持，未改发。'));const recipient='frontdesk',lifecycle=selectedSession(recipient,context.preserveDraft===true);if(!active||(!lifecycle.canSend&&lifecycle.state!=='ready'))return Promise.reject(Error(lifecycle.reason||'前台尚未就绪；输入已保留。'));const key=JSON.stringify([projectId,recipient,text,context]);if(submissions.has(key))return submissions.get(key);const requestKey=submissionKeys.get(key)||crypto.randomUUID();submissionKeys.set(key,requestKey);const promise=sendOnce(text,context,requestKey).then(result=>{submissionKeys.delete(key);return result;}).finally(()=>{if(submissions.get(key)===promise)submissions.delete(key);});submissions.set(key,promise);return promise;}
 async function sendOnce(text,{relPath,materialText,tags,imageAttachments,fileAttachments,textMaterials,drawingSources,background=false,composerText,preserveDraft=false}={},requestKey){
  const id=projectId,t='frontdesk',old=composerText,epoch=inputEpoch,materials=window.__composerMaterials,materialToken=materials?.token();
  await draftWriter.settled();
  const manual=background;
  const result=await call(manual?'task':'send',{...(!manual?{target:'frontdesk'}:{}),requestKey,text,...(preserveDraft?{preserveDraft:true}:{}),...(relPath?{relPath,materialText}:{}),...(tags?{tags}:{}),...(textMaterials?.length?{textMaterials}:{}),...(imageAttachments?.length?{imageAttachments,drawingSources}:{}),...(fileAttachments?.length?{fileAttachments}:{})},id);
  const currentMaterialToken=materials?.token();
  if(!preserveDraft&&old!==undefined&&id===projectId&&t===target&&epoch===inputEpoch&&materialToken?.revision===currentMaterialToken?.revision&&$('composer').value===old){
   $('composer').value='';drafts.set(id+':'+t,'');materials?.confirmSent(materialToken);
   $('composer').dispatchEvent(new Event('input'));
   delete $('compose-status').dataset.draftSaving;
   $('compose-status').textContent=manual?'已提交后台，处理与交接进展见对话记录':'前台已接收';
  }else if(!preserveDraft&&id===projectId){
   delete $('compose-status').dataset.draftSaving;
   $('compose-status').textContent='已接收上一稿，新输入仍保留';
  }
  await refresh().catch(error=>{if(id===projectId)toast('发送已接收，但状态刷新失败：'+error.message+'；不会自动重发。');});
  return result;
 }
 const draftWriter=ownsConversation?bindComposerDrafts({composer:$('composer'),current:()=>projectId&&!inputReason()?{projectId,target}:null,remember:({projectId,target,text})=>drafts.set(projectId+':'+target,text),persist:({projectId,target,text})=>call('draft',{target,text},projectId),onError:e=>toast('草稿保存失败：'+e.message),onInput:()=>{inputEpoch++;captureInput();}}):{settled:()=>Promise.resolve()};
 function leaveHistory(){reportRequest++;if(!viewed?.history)return false;viewed=null;lockHistory();$('composer').disabled=false;toolbar.hidden=true;if(active)render();return true;}
 window.addEventListener('nozeli-content-closed',()=>{if(!leaveHistory()&&active&&ownsConversation)select('frontdesk');});
 window.nozeli.subscribe('workspace.control',event=>{
  if(event.type!=='drawing-material'||!ownsConversation||event.projectId!==projectId||event.projectId!==scope?.projectId)return;
  try{
   if(target==='frontdesk'&&!inputReason()){
    window.__composerMaterials?.appendDrawing(event);
    captureInput();
   }else if(scope){
    const previous=scope.viewState?.conversationMaterials?.frontdesk;
    const materials=appendDrawingMaterial(previous,event);
    scope.viewState={...scope.viewState,conversationMaterials:{...scope.viewState?.conversationMaterials,frontdesk:materials}};
   }
   const detail={projectId};document.dispatchEvent(new CustomEvent('nozeli-conversation-input-change',{detail}));
   void detail.persist?.catch(error=>toast('涂鸦草稿保存失败：'+error.message));
  }catch(error){toast('涂鸦材料未追加：'+error.message);}
 });
 window.nozeli.subscribe('workspace.control',event=>{if(event.type==='conversation-action'&&['select','todo'].includes(event.action)&&ownsConversation&&event.projectId===scope.projectId){if(!state||event.projectId!==projectId){pendingConversation=event;return;}if(event.action==='select')select(event.target);if(event.action==='todo')void openTodo(event.todoId);}});
 window.nozeli.subscribe('workspace.control',event=>{if(event.type!=='conversation-unavailable'||event.projectId!==projectId)return;if(!event.retained)backgroundSubmit.disabled=true;if(!ownsConversation){target='frontdesk';sessionRecoveryError=event.error?.message||'';if(state)render();}});
 window.addEventListener('nozeli-content-file-opened',leaveHistory);
 window.nozeli.subscribe('agent',e=>{if(e.kind==='managed-files-changed'&&e.projectId===projectId)void refreshProjectFiles().catch(error=>toast('文件链接列表读取失败：'+error.message));});
 window.nozeli.subscribe('agent',e=>{if((!active&&!fixtureMode)||e.projectId!==projectId)return;if(e.kind==='managed-state'){state=e.state;if(fixtureMode){render();return;}if(!ready)void refresh().catch(error=>toast(error.message));else render();}if(e.kind==='managed-timeline'&&!historyPage){sessionStore.apply(projectId,e.timeline||e.frame,{replace:true});}if(e.kind==='managed-error')toast(e.text);});
 window.nozeli.subscribe('agent',e=>{if(e.kind==='managed-faults')void serviceFaults.refresh();});
 window.addEventListener('nozeli-project-change',()=>{workControl.clear();serviceFaults.clear();});
 window.nozeli.subscribe('agent',e=>{if(e.projectId===projectId&&active&&!fixtureMode&&e.kind==='managed-activity')collaboration.update();});
 return {get active(){return active;},reachable:true,load,enable,send,refresh,observeFixture,flushDrafts:()=>draftWriter.settled(),clear(options){workControl.clear();serviceFaults.clear();clear(options);if(options?.rememberDraft===false)projectId=null;},onReport:openTodo};
}
