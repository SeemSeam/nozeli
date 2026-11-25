import {createImportedSkillPicker} from './imported-skill-picker.mjs';
import './local-window.css';
import {createReviewDraft} from './managed-review-draft.mjs';
import {reviewVersionAvailable,reviewStaleMessage,reviewReportOutdated} from './managed-review-availability.mjs';
import {nativeDiscussionEnvironment} from './review-discussion-environment.mjs';
import {mountTaskReader,createTaskReadingMemory} from './session-timeline.mjs';
import {mountLocalWindow,ensureLocalWindowLayer,viewportWindowEnvironment} from './local-window.mjs';
import {createLocalWindowView} from './local-window-view.mjs';
import {mountFrozenMaterialViewer} from './frozen-material-viewer.mjs';
import { setActionButton } from './ui-actions.mjs';
import {mountCollaborationStatus} from './collaboration-status.mjs';

const discussionReasons={WORK_ENDED:'工作已结束',HISTORICAL_SESSION_READ_ONLY:'历史会话只读',REVIEW_CANDIDATE_STALE:'当前显示旧报告，请查看最新报告',REVIEW_CONTINUE_PENDING:'人工稿正在交回AI助手核对',WORK_BUSY:'工作处理中，请等待当前回合',WORK_STATE:'当前工作状态不可发送',WORK_DEVIATION_HELD:'工作偏离问题尚待处理',RECOVERY_REQUIRED:'原会话需要恢复',WORK_CONTROL_HELD:'工作已暂停或正在控制操作',CANDIDATE_REQUIRED:'冻结候选尚不可用'};
Object.assign(discussionReasons,{CHAT_EFFECT_UNKNOWN:'上轮执行效果待核对；补充可排队，但不会执行',SERVICE_FAULT_HELD:'模型服务故障尚未解除',WORK_PROBLEM_PENDING:'请先处理原任务的问题待办',NATIVE_DRAFT_PENDING:'原生会话仍有未发送草稿'});
const surfaces=new Set();
export async function flushManagedReviews(){
 try{for(const surface of surfaces)await surface.save();return {ok:true};}
 catch(error){return {ok:false,error:{code:error.code||'REVIEW_SAVE_FAILED',message:error.message}};}
}
export function applyManagedReviewBarrier(event){for(const surface of surfaces)surface.barrier(event);}
export function managedReviewComposing(){return [...surfaces].some(surface=>surface.composing);}

export function mountReviewDetail(parent,title,{inline=false}={}){
 if(inline){
  const detail=document.createElement('details');detail.className='managed-review-file-section';
  const trigger=document.createElement('summary');trigger.textContent=title;
  const body=document.createElement('div');body.className='managed-review-files';
  detail.append(trigger,body);parent.append(detail);
  return {trigger,body,open(){detail.open=true;}};
 }
 const trigger=document.createElement('button');trigger.type='button';trigger.textContent=title;
 const dialog=document.createElement('dialog');dialog.className='managed-review-detail';dialog.setAttribute('aria-label',title);
 const close=document.createElement('button');close.type='button';setActionButton(close,'close-view',{label:'关闭'});
 const heading=document.createElement('h3');heading.textContent=title;
 const body=document.createElement('div');body.className='managed-review-detail-body';
 dialog.append(close,heading,body);parent.append(trigger,dialog);
 trigger.setAttribute('aria-haspopup','dialog');trigger.onclick=()=>dialog.showModal();close.onclick=()=>dialog.close();
 return {trigger,dialog,body,open(){if(!dialog.open)dialog.showModal();}};
}

// Report/files stay in the workspace. Only the Work discussion floats; hiding it
// retains its DOM, selection, draft, scroll position and durable queue identity.
export function mountManagedReview(parent,{invoke,projectId,workId,sourceJobId,objectId,workName='',current=()=>true,confirm,onChanged=()=>{},onAvailability=()=>{},onOpenLatest,onDiscard,getDiscardState=()=>({allowed:false}),discussionHost=false,discussionReadOnly=false,workMode=false,earlyDiscussion=false}){
 const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;return el;};
 const root=node('footer','managed-review');root.dataset.managedReview=objectId;
 const heading=node('header','managed-review-heading');
 const taskName=workName||'当前工作';
 const version=node('span','managed-review-version');version.hidden=true;
 const status=node('p','managed-review-status');status.dataset.reviewStatus='';status.setAttribute('role','status');
 const warning=node('p','managed-review-warning');warning.dataset.reviewWarning='';warning.setAttribute('role','alert');
 const button=(text,key,action)=>{const el=node('button','',text);el.type='button';el.dataset.reviewAction=key;el.onclick=()=>Promise.resolve().then(action).catch(fail);return el;};
 const reopen=button('追加讨论','open-discussion',show);reopen.onclick=()=>show().catch(()=>{});
 reopen.setAttribute('aria-expanded','false');setActionButton(reopen,'discuss',{text:'追加讨论',label:'打开追加讨论窗口'});
 const openingStatus=node('p','managed-review-opening-status');openingStatus.setAttribute('role','status');openingStatus.hidden=true;
 const latest=node('a','','查看最新报告');latest.dataset.reviewAction='latest';latest.href='#';latest.hidden=true;latest.onclick=event=>{event?.preventDefault();return Promise.resolve(onOpenLatest?.()).catch(fail);};
 heading.append(version,status,latest);
 const outdated=node('p','managed-review-warning');outdated.dataset.reviewReportOutdated='';outdated.hidden=true;
 const versions=node('dialog','managed-review-detail');versions.dataset.reviewVersions='';versions.setAttribute('aria-label','版本与技术详情');const closeDetails=button('关闭','close-details',()=>versions.close());setActionButton(closeDetails,'close-view',{label:'关闭'});versions.append(closeDetails,node('h3','','版本与技术详情'));
 const versionText=node('p');versions.append(versionText);
 const actions=node('div','managed-review-actions');
 const discussionActions=node('div','managed-review-discussion-actions');
 const decision=node('div','managed-review-decision');const decisionButtons=node('div','managed-review-decision-buttons');
 root.append(heading,outdated,warning,actions,versions);parent.append(root);
 const discussionBody=node('div','note-projection tag-chat-window managed-review-discussion');
 const caption=node('span','tag-window-title',taskName);caption.title=taskName;
 const discussionMeta=node('p','managed-review-discussion-meta','追加讨论');
 const latestChat=button('查看最新报告','latest-discussion',()=>onOpenLatest?.());latestChat.hidden=true;latestChat.className='managed-review-latest';
 const readingResult=button('查看此版成果','reading-result',()=>navigate('report',objectId));
 const sources=node('details','managed-review-sources');sources.append(node('summary','','版本与来源'));const sourceText=node('p');sources.append(sourceText);
 const arrivals=button('有新内容 · 查看','new-content',async()=>{if(composing||document.getSelection()?.isCollapsed===false)throw Error('请先完成输入法组合或取消原文选区，当前阅读页保持不变');historyPage=null;await loadDiscussion(false,true);arrivals.hidden=true;});arrivals.hidden=true;
 const queue=node('p','tag-delivery');queue.setAttribute('role','status');queue.dataset.reviewQueue='';
 // U3-02：当前状态区。历史消息（如“系统已接管…无需重复提交”）不改写；
 // 这里按真实的 canSend/canAccept 补一条当前的暂停/不可继续说明。
 const currentState=node('p','managed-review-current-state');currentState.setAttribute('role','status');currentState.dataset.reviewCurrentState='';currentState.hidden=true;
 const transcript=node('div','session-timeline');transcript.setAttribute('aria-label','固定Task原始记录与讨论');
 const more=button('读取更早任务记录','history-more',()=>loadDiscussion(true));more.hidden=true;
 const locationStatus=node('p','managed-review-instruction-status');locationStatus.setAttribute('role','status');locationStatus.hidden=true;
 const history=node('div','managed-review-history session-surface');history.dataset.reviewDiscussionHistory='';const latestRange=button('返回最新范围／从最新连续翻页','history-latest',async()=>{if(composing||document.getSelection()?.isCollapsed===false)throw Error('请先完成输入法组合或取消选区');historyPage=null;await loadDiscussion(false,true);});latestRange.hidden=true;history.append(more,latestRange,locationStatus,transcript);
 const readingScroller=()=>{const body=history.closest('.local-window-body');return body&&getComputedStyle(history).overflowY==='visible'?body:history;};
 const readingProtected=()=>composing||document.getSelection?.()?.isCollapsed===false;
 let interaction=0,scrollGeneration=0;
 for(const type of ['wheel','pointerdown','keydown','compositionstart'])discussionBody.addEventListener(type,()=>{interaction++;},{capture:true,passive:true});
 function captureReading(){
  const scroll=readingScroller(),top=scroll.getBoundingClientRect().top;
  const anchor=[...transcript.querySelectorAll('[data-message],[data-host-delta]')].find(el=>el.getClientRects().length&&el.getBoundingClientRect().bottom>top);
  return {scrollTop:scroll.scrollTop,anchor,id:anchor?.dataset.message,delta:anchor?.dataset.hostDelta,offset:anchor?.getBoundingClientRect().top-top};
 }
 function restoreReading(scroll,view){
  let anchor=view?.anchor;
  if(!anchor||!transcript.contains(anchor)||!anchor.getClientRects().length)anchor=view&&(view.id||view.delta)&&[...transcript.querySelectorAll('[data-message],[data-host-delta]')].find(el=>(view.id?el.dataset.message===view.id:el.dataset.hostDelta===view.delta)&&el.getClientRects().length);
  if(anchor)scroll.scrollTop+=anchor.getBoundingClientRect().top-scroll.getBoundingClientRect().top-view.offset;
  else if(view)scroll.scrollTop=view.scrollTop;
 }
 function applyScroll(intent){
  if(!live()||intent.generation!==scrollGeneration||intent.interaction!==interaction||readingProtected()||!history.getClientRects().length)return;
  const scroll=readingScroller();
  if(intent.publication){
   const target=[...transcript.querySelectorAll('[data-publication-object]')].find(el=>el.dataset.publicationObject===intent.publication&&el.getClientRects().length);
   if(!target){locationStatus.textContent=cursor?'当前页未包含此版发布事件；可读取更早任务记录。':'当前任务记录范围未包含此版发布事件。';locationStatus.hidden=false;return;}
   const rect=target.getBoundingClientRect(),viewport=scroll.getBoundingClientRect();
   if(rect.top<viewport.top||rect.height>viewport.height)scroll.scrollTop+=rect.top-viewport.top;
   else if(rect.bottom>viewport.bottom)scroll.scrollTop+=rect.bottom-viewport.bottom;
  }else if(intent.latest)scroll.scrollTop=scroll.scrollHeight;
  else restoreReading(scroll,intent.view);
 }
 const mac=/mac/i.test(globalThis.navigator?.userAgentData?.platform||globalThis.navigator?.platform||'');
 const composer=node('div','tag-composer discussion-composer');const composerActions=node('div','discussion-composer-actions');
 const instruction=node('textarea','tag-editor');instruction.rows=2;instruction.maxLength=8000;instruction.dataset.reviewInstruction='';instruction.placeholder=(mac?'⌘ + Return 发送 · Return 换行':'Ctrl + Enter 发送 · Enter 换行')+(workMode?' · Tab 排队 · Esc 后按 Tab 移焦':'');
 const inputId='review-instruction-'+crypto.randomUUID();instruction.id=inputId;
 const inputLabel=node('label','managed-review-input-label','给原 Worker 的问题或修改要求');inputLabel.htmlFor=inputId;
 const sendReason=node('p','managed-review-send-reason discussion-composer-status');sendReason.id=inputId+'-reason';
 const send=button('发送','send',sendDiscussion);send.className='tag-send';send.setAttribute('aria-describedby',inputId+'-reason');instruction.setAttribute('aria-describedby',inputId+'-reason '+inputId+'-save');
 const unbound=()=>workMode&&!objectId;
 let escapeTab=false;
 const accept=button('采纳并结束','accept',acceptReview);setActionButton(accept,'accept',{text:'采纳并结束',label:'采纳并结束'});
 const discard=button('放弃并结束','discard',discardReview);
 const discardReason=node('p','managed-review-discard-reason');discardReason.dataset.reviewDiscardReason='';discardReason.setAttribute('role','status');discardReason.hidden=true;
 const decisionHint=node('p','managed-review-accept-hint','采纳会将当前审核稿写入项目，并结束工作。');
 const decisionStatus=node('p','managed-review-decision-status');decisionStatus.setAttribute('role','alert');decisionStatus.hidden=true;
 decisionStatus.dataset.reviewDecisionStatus='';
 accept.onclick=()=>acceptReview().catch(failDecision);discard.onclick=()=>discardReview().catch(failDecision);
 const instructionStatus=node('p','managed-review-instruction-status');instructionStatus.setAttribute('role','status');instructionStatus.dataset.reviewInstructionStatus='';
 instructionStatus.id=inputId+'-save';
 const retry=button('重试保存','retry-instruction',async()=>{if(draft)await draft.retry();else {instructionReady=loadInstruction();await instructionReady;}});retry.hidden=true;
 const returnDrafts=button('交回人工稿并发送','return-drafts',()=>sendDiscussion({applyDrafts:true}));returnDrafts.hidden=true;
 const workerSkill=createImportedSkillPicker({invoke,role:'worker',target:workId});workerSkill.bind(projectId);
 workerSkill.root.hidden=!workId||!!sourceJobId||discussionReadOnly;composerActions.append(workerSkill.root);
 composerActions.append(send);composer.append(inputLabel,instruction,sendReason,composerActions);discussionBody.append(discussionMeta,readingResult,sources,latestChat,queue,arrivals,history,composer,instructionStatus,retry);sources.append(returnDrafts);discussionBody.hidden=true;root.insertBefore(currentState,actions);
 let modelAllowed=false,modelShown=false;
 const agentModel=discussionHost&&!sourceJobId&&!discussionReadOnly&&window.__workspaceScope?.role==='review-discussion'?mountCollaborationStatus({
  root:composerActions,workTarget:workId,current:()=>modelAllowed&&modelShown?{projectId,target:workId}:null,
  call:async(op,p)=>{const result=await invoke('managed.'+op,{...p,projectId});if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code});return result.value;}
 }):null;
 if(agentModel)composerActions.prepend(composerActions.lastElementChild);
 if(sourceJobId)composer.hidden=true;
 if(sourceJobId)discussionBody.classList.add('managed-intake-discussion');
 const waiting=node('div','managed-review-waiting');waiting.hidden=true;if(workMode)discussionBody.insertBefore(waiting,composer);
 let waitingSignature='',queueOperation=false;
 function paintWaiting(readOnly){
  if(!workMode)return;
  const items=discussion?.queueItems||[],total=discussion?.queued??items.length,revision=discussion?.workRevision??discussion?.revision,locked=readOnly||held||busy||queueOperation||!Number.isInteger(revision);
  const startAllowed=!locked&&!discussion?.active&&discussion?.canDispatch===true;
  const signature=JSON.stringify([items,total,locked,startAllowed,revision]);if(signature===waitingSignature)return;waitingSignature=signature;
  const focused=waiting.contains(document.activeElement),focusId=document.activeElement?.dataset.queueId;
  waiting.hidden=!items.length;waiting.replaceChildren();if(!items.length){if(focused)instruction.focus({preventScroll:true});return;}
  const change=async (method,args)=>{if(locked||queueOperation)return;queueOperation=true;try{await workCall(method,{revision,...args});await refresh();}finally{queueOperation=false;paint();}};
  const list=node('ol');for(const item of items){const row=node('li','',(item.lane==='normal'?'普通':'下一回合')+'：'+item.text);const retract=button('撤回','queue-retract',()=>change('retract',{queueId:item.id}));retract.dataset.queueId=item.id;retract.setAttribute('aria-label','撤回：'+item.text);retract.disabled=locked;row.append(retract);list.append(row);}
  waiting.append(node('strong','','待发队列 · '+total+(total>items.length?'（显示前 '+items.length+' 条）':'')),list);if(startAllowed)waiting.append(button('开始处理队列','queue-dispatch',()=>change('dispatch',{})));
  if(focused)([...waiting.querySelectorAll('button:not(:disabled)')].find(b=>b.dataset.queueId===focusId)??waiting.querySelector('button:not(:disabled)')??instruction).focus({preventScroll:true});
 }
 if(discussionHost){root.hidden=true;root.append(discussionBody);}else{
  discussionActions.append(reopen,openingStatus);decisionButtons.append(accept,discard);decision.append(decisionHint,decisionButtons,discardReason,decisionStatus);actions.append(discussionActions,decision);
 }
 const navigate=async(kind,target,messageId)=>{const result=await invoke('workspace.reviewDiscussion.navigate',{projectId,workId,...(kind==='report'?{objectId:target||objectId}:{}),...(messageId?{messageId}:{}),kind});if(!result.ok)throw Error(result.error?.message||'固定任务阅读面暂不可打开');if(messageId&&result.value?.locationSupported===false)throw Error(result.value.reason||'过程面尚未支持原消息定位');return result.value;};
 const materials=discussionHost?mountFrozenMaterialViewer({read:async(_attachment,entry)=>{const result=await invoke('workspace.reviewDiscussion.materialRead',{projectId,workId,messageId:entry.id,index:entry.attachmentIndex});if(!result.ok)throw Error(result.error?.message||'冻结材料不可读取');return result.value;}}):null;
 let readingValues={},readingQueue=Promise.resolve(),readingError=null,readingLoaded=false,readingMemory=null;
 const readingDirty=new Map();
 const readingStatus=node('p','managed-review-instruction-status');readingStatus.setAttribute('role','status');readingStatus.dataset.reviewReadingStatus='';readingStatus.hidden=true;
 const readingRetry=button('重试任务阅读状态','retry-reading',async()=>{readingRetry.disabled=true;try{if(!readingLoaded)await loadReading();await persistReading();if(readingError)throw readingError;await loadDiscussion();}finally{readingRetry.disabled=false;}});readingRetry.hidden=true;discussionBody.append(readingStatus,readingRetry);
 const readingFailure=error=>{readingError=error;readingStatus.hidden=false;readingStatus.dataset.state='error';readingStatus.textContent=error.message+'；阅读选择与未发送草稿保留，请重试。';readingRetry.hidden=false;};
 const readingCall=async(action,payload)=>{const result=await invoke('workspace.reviewDiscussion.readingState.'+action,{projectId,workId,...payload});if(!result.ok)throw Error(result.error?.message||'任务阅读状态未保存');return result.value;};
 const loadReading=async()=>{try{const result=await readingCall('read',{});readingValues=result.state?.disclosures||{};readingMemory=null;readingLoaded=true;readingError=null;readingStatus.hidden=true;readingRetry.hidden=true;}catch(error){readingFailure(error);throw error;}};
 const readingReady=discussionHost?loadReading().catch(()=>{}):Promise.resolve();
 const persistReading=()=>{readingQueue=readingQueue.catch(()=>{}).then(async()=>{await readingReady;if(!readingLoaded)throw readingError||Error('任务阅读状态尚未读取');if(!readingDirty.size)return;for(let attempt=0;attempt<4;attempt++){const current=await readingCall('read',{}),state=current.state||{schema:1,revision:0,disclosures:{}},pending=new Map(readingDirty),disclosures={...state.disclosures};for(const [key,change] of pending){if(change.deleted)delete disclosures[key];else disclosures[key]=change.value;}const result=await readingCall('write',{expectedRevision:state.revision,disclosures});if(!result.conflict){for(const [key,change] of pending)if(readingDirty.get(key)===change)readingDirty.delete(key);readingError=null;readingStatus.hidden=true;readingRetry.hidden=true;return;}}throw Error('任务阅读状态发生并发更新，请重试');}).catch(readingFailure);return readingQueue;};
 const saveReading=values=>{for(const key of new Set([...Object.keys(readingValues),...Object.keys(values)])){if(JSON.stringify(readingValues[key])!==JSON.stringify(values[key]))readingDirty.set(key,Object.hasOwn(values,key)?{value:values[key]}:{deleted:true});}readingValues=values;if(readingLoaded)void persistReading();};
 const persistentReading={get:key=>(readingMemory??=createTaskReadingMemory(readingValues,saveReading)).get(key),has:key=>(readingMemory??=createTaskReadingMemory(readingValues,saveReading)).has(key),set(key,value){return (readingMemory??=createTaskReadingMemory(readingValues,saveReading)).set(key,value);},delete(key){return (readingMemory??=createTaskReadingMemory(readingValues,saveReading)).delete(key);}};
 const reader=discussionHost?mountTaskReader(transcript,{projectId,workId:sourceJobId?undefined:workId,sourceJobId,readingMemory:persistentReading,context:{copyText:text=>navigator.clipboard.writeText(text),onError:fail,onMaterial:(attachment,entry,index)=>materials.open(attachment,{...entry,attachmentIndex:index}),onQuote:sourceJobId?undefined:quote=>{if(instruction.disabled||instruction.readOnly||composing)return;instruction.value+=(instruction.value?'\n\n':'')+quote.text.split('\n').map(line=>'> '+line).join('\n')+'\n';draft?.setText(instruction.value);instruction.focus({preventScroll:true});paint();},filePaths:new Set()},call:async(method,args)=>{
  const routes={'timeline.read':'managed.timeline.read','timeline.page':'workspace.reviewDiscussion.processRead','timeline.export':'workspace.reviewDiscussion.exportOriginal'},op=routes[method];if(!op)throw Error('阅读体无写权限');
  const {sourceJobId:ignored,workId:ignoredWork,...params}=args;
  const result=await invoke(op,{...params,projectId,...(method!=='timeline.read'?{workId}:{})});if(!result.ok)throw Error(result.error?.message||'原文暂不可读取');return result.value;
 },onResult:receipt=>navigate('report',receipt.objectId)}):null;
 let data=null,discussion=null,draft=null,disposed=false,busy=false,held=false,composing=false,timer=null,observing=false,observeAgain=false,readGeneration=0,discussionGeneration=0,loadingHistory=false;
 let entries=new Map(),deltas=new Map(),cursor=null,latestPage=null,historyPage=null,retainedView=null,reviewWindow=null,reviewWindowReady=null;
 let opening=null,visibilityRevision=0,bindingGeneration=0,transitioning=false,binding=false,initialized=!discussionHost,childVisibility=Promise.resolve(),opened=false,showFailed=false;
 function setExpanded(shown){reopen.setAttribute('aria-expanded',String(shown));}
 function setOpening(pending){
  if(pending){reopen.setAttribute('aria-busy','true');reopen.setAttribute('aria-disabled','true');}
  else{reopen.removeAttribute('aria-busy');reopen.removeAttribute('aria-disabled');}
  setActionButton(reopen,'discuss',pending?{text:'正在打开…',label:'正在打开讨论窗口'}:{text:'追加讨论',label:'打开追加讨论窗口'});
 }
 const presented=new Set();
 function presentVisibleMessages(){
  if(sourceJobId)return;
  if(!discussionHost||disposed||document.visibilityState!=='visible'||!document.hasFocus()||discussionBody.hidden||!history.getClientRects().length||document.getSelection()?.isCollapsed===false)return;
  const viewport=readingScroller().getBoundingClientRect();
  for(const element of transcript.querySelectorAll('[data-message]')){
   const entry=entries.get(element.dataset.message),threadId=entry?.sessionId;
   if(!threadId||!entry.id||entry.availability==='read-required'||entry.streaming||entry.speaker!=='agent'||!element.getClientRects().length)continue;
   const rect=element.getBoundingClientRect();if(rect.top<viewport.top||rect.bottom>viewport.bottom||rect.left<viewport.left||rect.right>viewport.right)continue;
   const key=JSON.stringify([projectId,threadId,entry.id,objectId]);if(presented.has(key))continue;presented.add(key);
   void invoke('workspace.attention.presented',{projectId,sessionId:threadId,messageId:entry.id,objectId,revision:entry.revision}).then(result=>{if(!result?.ok)presented.delete(key);}).catch(()=>presented.delete(key));
  }
 }
 history.addEventListener('scroll',presentVisibleMessages);
 let accepted=false;
 const idleWaiters=new Set();
 const pendingKey='nozeli:review-discussion-send:'+projectId+':'+workId;
 let pendingSend=null,persistenceError=null;
 try{pendingSend=JSON.parse(window.localStorage?.getItem(pendingKey)||'null');}catch(error){persistenceError=error;}
 async function persistSend(envelope){
  // Work-scoped local persistence survives report replacement, tab closure
  // and restart; layout navigation state intentionally strips payload fields.
  if(envelope)window.localStorage?.setItem(pendingKey,JSON.stringify(envelope));else window.localStorage?.removeItem(pendingKey);
  pendingSend=envelope;
 }
 const keys=new Map();
 const live=()=>!disposed&&current();
 async function call(method,args={}){const op=discussionHost&&method==='discussion.send'&&args.objectId!==objectId?'workspace.reviewDiscussion.receipt':'managed.review.'+method;const result=await invoke(op,{projectId,workId,objectId,...args});if(!result.ok)throw Object.assign(Error(result.error?.message||'审核请求失败'),{code:result.error?.code});return result.value;}
 async function workCall(method,args={}){const result=await invoke('managed.work.chat.'+method,{projectId,workId,...args});if(!result.ok)throw Object.assign(Error(result.error?.message||'任务对话暂不可用'),{code:result.error?.code});return result.value;}
 function fail(error){if(live()){warning.textContent=error.message+'；原报告和未发送意见保留。';if(discussionHost){instructionStatus.dataset.state='error';instructionStatus.textContent='⚠ '+error.message+'；内容仍保留在当前窗口。';}paint();}}
 function failDecision(error){if(live()){decisionStatus.textContent=error.message+'；原报告和未发送意见保留。';decisionStatus.hidden=false;}}
 // Lazy shell mount: the window is created on first show so an unopened review
 // costs no display-view read; cold restore stays hidden per contract. The
 // same body node keeps transcript, draft and selection identity across
 // show/hide/collapse — only geometry ever changes.
 async function nativeCall(action,args={}){const binding=action==='intakeRead'?{projectId,workId}:{projectId,workId,objectId,workName:taskName};const result=await invoke('workspace.reviewDiscussion.'+action,{...binding,...args});if(!result.ok)throw Object.assign(Error(result.error?.message||'讨论窗口操作失败'),{code:result.error?.code});return result.value;}
 function ensureDiscussionWindow(){
  if(reviewWindowReady)return reviewWindowReady;
  if(!discussionHost){reviewWindow={show:()=>nativeCall('show'),hide:()=>nativeCall('hide'),flush:()=>nativeCall('flush'),dispose:()=>nativeCall('release')};reviewWindowReady=Promise.resolve(reviewWindow);return reviewWindowReady;}
  const layer=ensureLocalWindowLayer();
  const windowKey={projectId,ownerKind:'review',ownerId:workId,surfaceId:window.__workspaceScope?.ownerSurfaceId||'shell'};
  const initial={schema:1,revision:0,placement:{mode:'auto'},size:null,collapsed:false,hidden:true};
  const store=createLocalWindowView({invoke,key:windowKey,initial});
  reviewWindowReady=(async()=>{
   const state=await store.load();if(disposed)return null;
   const defaultRect=b=>({x:b.x+b.width-432,y:b.y+b.height-512,width:420,height:460});
   const environment=window.__workspaceScope?.role==='review-discussion'?nativeDiscussionEnvironment({invoke,scope:window.__workspaceScope,defaultRect,measureBounds:b=>({x:b.x+8,y:b.y+8,width:Math.max(0,b.width-16),height:Math.max(0,b.height-16)})}):viewportWindowEnvironment(layer,{defaultRect:()=>defaultRect({x:0,y:0,width:window.innerWidth,height:window.innerHeight})});
   const requestClose=window.__workspaceScope?.role==='review-discussion'?async()=>{const result=await invoke('workspace.reviewDiscussion.requestHide',{});if(!result.ok)throw Error(result.error?.message||'讨论窗口未能关闭');}:undefined;
   const win=mountLocalWindow({layer,key:windowKey,title:caption,body:discussionBody,state:{...state,hidden:true},environment,commitView:store.commitView,requestClose,beforeHide:async()=>{await saveAll();++scrollGeneration;if(history.getClientRects().length)retainedView=captureReading();},onError:fail});
   win.node.addEventListener('scroll',presentVisibleMessages,true);
   win.node.dataset.reviewDiscussion='';win.node.setAttribute('role','region');win.node.setAttribute('aria-label',caption.textContent);
   discussionBody.hidden=false;reviewWindow=win;return win;
  })().catch(error=>{reviewWindowReady=null;throw error;});return reviewWindowReady;
 }
 function show(options={}){
  if(discussionHost)return childTransition(()=>showDiscussion(options));
  if(!live())return Promise.resolve();
  if(opening)return opening;
  const generation=bindingGeneration,revision=visibilityRevision;
  setOpening(true);openingStatus.hidden=true;
  const stillCurrent=()=>live()&&generation===bindingGeneration;
  const request=(async()=>{
   const win=await ensureDiscussionWindow();if(!stillCurrent()||!win)return;
   const result=await win.show();
   if(!stillCurrent())return result;
   if(typeof result?.shown!=='boolean')throw Error('讨论窗口未返回显示状态');
   if(revision===visibilityRevision){
    setExpanded(result.shown);
   }
   if(!result.shown&&reopen.getAttribute('aria-expanded')==='false'){
    openingStatus.textContent=({inactive:'应用已不在前台。',geometry:'窗口位置尚未确认。','launcher-hidden':'原报告当前不可见。',superseded:'已切换到另一个讨论入口。','native-not-shown':'系统未显示讨论窗口。'}[result.reason]||'讨论窗口未显示。')+' 可再次点击「追加讨论」。';openingStatus.hidden=false;
   }
   return result;
  })().catch(error=>{
   if(!stillCurrent())return;
   openingStatus.textContent='讨论窗口未打开：'+error.message+' 可再次点击「追加讨论」。';openingStatus.hidden=false;
   throw error;
  }).finally(()=>{
   if(opening===request){opening=null;setOpening(false);}
  });
  opening=request;return request;
 }
 function childTransition(action){const next=childVisibility.catch(()=>{}).then(action);childVisibility=next;return next;}
 async function showDiscussion({locatePublication=false}={}){
  const intent={generation:++scrollGeneration,interaction,publication:locatePublication?objectId:null};
  transitioning=true;
  try{
   await ready;
   const win=await ensureDiscussionWindow();if(!live()||!win)throw Error('讨论窗口已失效');
   const shown=!win.node.hidden&&!win.snapshot().hidden;
   if(!shown||showFailed)await win.show();
   else if(window.__workspaceScope?.role==='review-discussion'){
    // The host bypasses this command for a pure activation. A delivered
    // command may require geometry for a new viewport epoch, even when the
    // local body is already unhidden.
    win.update();await win.flush();
   }
   showFailed=false;
   if(intent.publication){locationStatus.hidden=true;applyScroll(intent);}
   else if(!shown)applyScroll({...intent,view:retainedView,latest:!opened&&!retainedView});
   if(!shown)retainedView=null;
   opened=true;
   modelShown=true;agentModel?.update();
   if(earlyDiscussion&&objectId&&!data)void refresh(false).catch(fail);
  }catch(error){showFailed=true;throw error;}
  finally{transitioning=false;}
 }
 async function hide(){
  if(discussionHost)return childTransition(async()=>{
   ++scrollGeneration;transitioning=true;
   try{await reviewWindow?.hide();modelShown=false;agentModel?.clear();}finally{transitioning=false;}
  });
  if(!reviewWindow)return;
  const generation=bindingGeneration;
  await reviewWindow.hide();
  if(live()&&generation===bindingGeneration){++visibilityRevision;setExpanded(false);}
 }
 function paint(){
  const state=draft?.snapshot(),unavailable=!unbound()&&!reviewVersionAvailable(data);
  const differentLatest=Boolean(discussion?.latestObjectId&&discussion.latestObjectId!==objectId);
  const staleCode=data?.stale?.code||data?.stale?.reason||data?.stale?.detail?.reason;
  const historical=discussionReadOnly||!unbound()&&(differentLatest||staleCode==='SUPERSEDED'||(Number.isInteger(data?.workRevision)&&data.workRevision!==data.revision));
  const closed=accepted||['closing','ended'].includes(data?.status)||data?.accepted;
  const allowModel=!historical&&!closed&&!held&&!binding;
  if(agentModel&&modelAllowed!==allowModel){modelAllowed=allowModel;if(modelShown)agentModel.update();}
  send.disabled=discussionReadOnly||Boolean(persistenceError)||busy||held||composing||!draft||Boolean(state?.error)||(!pendingSend&&(unavailable||historical||closed||!discussion?.canSend||!instruction.value.trim()));
  accept.disabled=discussionHost||Boolean(persistenceError||pendingSend)||busy||held||composing||Boolean(state?.error)||unavailable||historical||closed||!data?.capabilities?.canAccept||!discussion||discussion.active||discussion.queued>0;
  const discardState=getDiscardState();discard.disabled=discussionHost||!onDiscard||!discardState?.allowed||busy||held||historical||closed||unavailable;discard.title=discardState?.message||'';
  discardReason.hidden=discussionHost||!data||historical||closed||!discard.disabled;
  discardReason.textContent=discardReason.hidden?'':'放弃并结束暂不可用：'+(held?'正在保存或核对审核决定，请等待当前操作完成。':busy?'当前审核操作尚未完成。':discardState?.message||(!onDiscard?'此报告没有可用的工作结束入口。':'正在核实当前工作处置条件。'));
  instruction.disabled=(!draft||held)&&!composing;instruction.readOnly=Boolean(busy||pendingSend||historical||closed||unavailable||!workMode&&discussion&&!discussion.canSend)&&!composing;
  latest.hidden=latestChat.hidden=!differentLatest||!onOpenLatest;
  version.hidden=!data;version.textContent=data?(data.publicationNumber?`报告 V${data.publicationNumber}`:`工作修订 ${data.revision}`):'';
  status.textContent=!data?'正在读取审核版本…':data.merge?.status==='merged'?'已应用到项目 · '+(data.merge.targetRef||'工作绑定分支'):data.merge?.status==='blocked'?'应用受阻 · '+(data.merge.message||data.merge.blockedCode||'请查看后台处理状态'):accepted?'采纳已记录 · 尚未确认应用成功':historical?'历史只读':closed?'审核已决定':'待审核';
  discussionMeta.textContent=sourceJobId?'主控 Orchestrator · 此请求的只读对话':unbound()?'原 Worker · 任务对话':data?`当前查看：报告发布 ${data.publicationNumber||data.revision} · 工作修订 ${data.revision} · ${historical?'历史只读':'当前候选'}`:'正在读取固定报告版本…';if(reviewWindow?.node)reviewWindow.node.setAttribute('aria-label',taskName+' · '+discussionMeta.textContent);
  readingResult.hidden=!objectId;
  readingResult.textContent=data?.publicationNumber?`查看报告 V${data.publicationNumber}`:'查看此版成果';sources.hidden=!objectId;
  versionText.textContent=data?`报告 V${data.publicationNumber||data.revision} · 工作修订 ${data.revision}\n审核版本：${data.reviewVersion||'不可用'}\n目标引用：${data.candidate?.targetRef||'项目目标分支'}\n文件差异基于冻结候选；人工稿保留在文档工作区。\nAI助手：原 Worker（原工作线程）；任务安排：主控交接。采用后由主控完成合入与收尾。`:'';
  sourceText.textContent=data?`当前阅读对象：${objectId}\n报告发布 ${data.publicationNumber||data.revision} · 工作修订 ${data.revision}\n后续发布事实不会替换此版正文或升级发送／决定版本。`:'固定版本正在读取。';
  const reasons=discussion?.reasons||[];
  const needsReport=reasons.some(reason=>(typeof reason==='string'?reason:reason?.code)==='REVIEW_BINDING_REQUIRED');
  const visibleReasons=reasons.map(reason=>{
   const code=typeof reason==='string'?reason:reason?.code;
   return code==='REVIEW_BINDING_REQUIRED'?null:typeof reason==='string'?(discussionReasons[reason]||reason):reason?.message;
  }).filter(Boolean);
  queue.textContent=sourceJobId?(discussion?.phase||'正在读取主控对话…'):discussion?[discussion.active?'AI助手正在处理':'',discussion.queued?`已排队 ${discussion.queued} 条`:'',...visibleReasons].filter(Boolean).join(' · '):'正在读取原始工作记录…';
  if(reviewReportOutdated(data?.files||[]))queue.textContent+=' · 已保存人工改稿；原报告未包含这些修改。';
  outdated.hidden=!reviewReportOutdated(data?.files||[]);outdated.textContent=outdated.hidden?'':'已保存人工改稿，采用时将使用人工稿。原报告未包含这些修改；如需AI助手核对，请先发送意见。';
  if(pendingSend)queue.textContent+=' · 上次发送回执待核对；重试只核对同一请求，不另派新任务。';
  workerSkill.root.hidden=!workId||!!sourceJobId||discussionReadOnly||historical||closed||!!pendingSend;
  if(pendingSend)queue.textContent+=pendingSend.importedSkill?` 原 Worker 技能：${pendingSend.importedSkill.id} · ${pendingSend.importedSkill.version}`:' 原 Worker 未使用导入技能。';
  if(persistenceError)queue.textContent+=' · 发送凭据无法读取；为避免重复派工，已暂停发送与接受。';
  queue.dataset.severity=persistenceError?'danger':!discussion?'unknown':discussion.active?'running':discussion.queued?'queued':historical||closed||unavailable||!discussion.canSend?'unknown':'review';
  if(!queue.textContent)queue.textContent=historical?'历史只读':closed?'审核已决定 · 请查看收尾状态':needsReport?'':unavailable||!discussion?.canSend?'当前线程状态待核实':'待审阅';
  if(data?.merge?.status==='blocked'){queue.dataset.severity='danger';queue.textContent='审核已决定 · 应用受阻：'+(data.merge.message||data.merge.blockedCode||'请查看后台处理状态');}
  // 当前状态区的暂停/不可继续说明：只在发送/采用确因任务状态被拦、且当前
  // 报告就是最新报告时出现；正常审阅、历史只读与已决定路径不受影响。
  const heldCauses={WORK_CONTROL_HELD:'当前任务处于人工暂停或控制操作中',WORK_STATE:'当前任务已暂停',RECOVERY_REQUIRED:'原会话有待处理的恢复决定，任务暂不能继续',WORK_DEVIATION_HELD:'工作偏离问题尚待处理，任务暂不能继续'};
  const heldCode=(discussion?.reasons||[]).map(reason=>typeof reason==='string'?reason:reason?.code).find(code=>Object.prototype.hasOwnProperty.call(heldCauses,code));
  const heldNotice=Boolean(data&&discussion&&heldCode&&!pendingSend&&!persistenceError&&!historical&&!closed&&!unavailable&&!discussion.active&&!discussion.queued);
  currentState.hidden=!heldNotice;
  if(heldNotice){
    status.textContent='当前任务已暂停';
    const blocked=[!discussion.canSend&&'发送',!data?.capabilities?.canAccept&&'采用'].filter(Boolean);
    currentState.textContent=heldCauses[heldCode]+'；'+(blocked.length>1?blocked.join('与')+'当前都不可用':blocked[0]+'当前不可用')+'，任务不会自动恢复。已发布的报告和文件仍可查看；未发送的意见保留。';
    if(discussionHost)queue.dataset.severity=heldCode==='RECOVERY_REQUIRED'||heldCode==='WORK_DEVIATION_HELD'?'decision':'paused';
  }
  const sendLabel=pendingSend?'核对上次发送':'发送';setActionButton(send,'send',{text:sendLabel,label:pendingSend?'核对或重试上次发送':'发送给原 Worker'});
  sendReason.textContent=!send.disabled?'':busy?'正在发送…':held?'正在保存或核对审核决定，请等待':composing?'请先完成输入法组合':persistenceError?'发送凭据无法读取，已暂停发送':state?.error?'草稿保存失败，请先重试保存':!draft?'正在读取本地草稿':discussionReadOnly||historical?'当前历史版本只读':closed?'审核已决定，不能继续发送':!pendingSend&&unavailable?'当前审核版本不可用':!pendingSend&&!discussion?.canSend?(visibleReasons.join(' · ')||(needsReport?'':'当前线程暂不可发送')):'';
  sendReason.hidden=!sendReason.textContent;
  returnDrafts.hidden=!(data?.files||[]).some(file=>file.draft&&file.draft.textDigest!==file.candidateDigest);returnDrafts.disabled=send.disabled||Boolean(pendingSend);
  more.hidden=!cursor;more.disabled=loadingHistory;
  if(!busy&&!held&&!composing){for(const resolve of idleWaiters)resolve();idleWaiters.clear();}
  paintWaiting(historical||closed);
 }
 async function loadInstruction(){
  const saved=await call('instruction.read');if(disposed)return;
  instruction.value=saved.text||pendingSend?.text||'';
  draft=createReviewDraft({text:saved.text,revision:saved.revision,save:({text,revision})=>call('instruction.save',{text,expectedRevision:revision}),onState:state=>{instructionStatus.dataset.state=state.error?'error':state.pending?'pending':'saved';instructionStatus.textContent=state.error?'⚠ 草稿保存失败，内容仍保留在当前窗口：'+(state.error.message||state.error):state.pending?'正在保存草稿…':state.dirty?'草稿尚未保存':'本地草稿已保存 · 未发送';retry.hidden=!state.error;paint();}});
  paint();
 }
 let instructionReady=discussionHost&&!sourceJobId?loadInstruction().catch(error=>{retry.hidden=false;fail(error);throw error;}):Promise.resolve();void instructionReady.catch(()=>{});
 instruction.addEventListener('compositionstart',()=>{composing=true;paint();});instruction.addEventListener('compositionend',()=>{composing=false;paint();});
 instruction.addEventListener('blur',()=>{escapeTab=false;});
 instruction.addEventListener('keydown',event=>{
  if(event.defaultPrevented||composing||event.isComposing||event.keyCode===229)return;
  if(event.key==='Enter'&&!event.shiftKey&&!event.altKey&&(mac?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey)){
   event.preventDefault();if(!event.repeat&&!instruction.readOnly&&!send.disabled)send.click();return;
  }
  if(event.shiftKey||event.ctrlKey||event.metaKey||event.altKey)return;
  if(workMode&&event.key==='Escape'&&instruction.value.trim()){event.preventDefault();event.stopPropagation();escapeTab=true;return;}
  if(workMode&&event.key==='Tab'&&escapeTab){escapeTab=false;paint();return;}
  if(workMode&&event.key==='Tab'&&!persistenceError&&!pendingSend&&!busy&&!held&&!instruction.readOnly&&!instruction.disabled&&instruction.value.trim()&&discussion?.canQueue){event.preventDefault();if(!event.repeat)void sendDiscussion({lane:'normal'}).catch(fail);}
 });
 instruction.addEventListener('input',()=>{draft?.setText(instruction.value);paint();clearTimeout(timer);timer=setTimeout(()=>void saveAll().catch(fail),600);});
 async function saveAll(){if(!discussionHost){await nativeCall('flush');return;}await instructionReady;if(composing)throw Object.assign(Error('请先完成输入法组合。'),{code:'COMPOSING'});clearTimeout(timer);await draft?.flush();await readingQueue;if(readingError)throw readingError;}
 async function loadDiscussion(append=false,latestRequested=false){
  if(append&&(!cursor||loadingHistory))return;
  if(append&&readingProtected())throw Error('请先取消原文选区或完成输入法组合；当前阅读页未被淘汰。');
  const generation=++discussionGeneration,scrollIntent={generation:scrollGeneration,interaction,latest:latestRequested};
  const scroll=reader&&!transitioning&&!binding&&history.getClientRects().length?readingScroller():null,scrollTop=scroll?.scrollTop;
  loadingHistory=true;paint();
  try{
   await readingReady;if(discussionHost&&!readingLoaded)throw readingError||Error('任务阅读状态尚未读取');
   const args={limit:100,...(append?{cursor}:{})};
   const next=await (sourceJobId?nativeCall('intakeRead',args):unbound()?workCall('read',args):call('discussion.read',args));if(!live()||generation!==discussionGeneration)return;
   if(!reader){discussion=next;return;}
   const frame=next.taskFrame;if(frame?.version!==1||!next.taskState)throw Error('宿主尚未提供统一Task阅读记录');
   // A selection/IME pins the visible page even if it began during the read.
   if(latestPage&&readingProtected()){
    if(binding)throw Error('请先取消原文选区或完成输入法组合；报告绑定未切换。');
    arrivals.hidden=false;return;
   }
   discussion=next;
   const scroller=readingScroller(),visible=history.getClientRects().length>0;
   const atBottom=visible&&scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<=40;
   if(!append&&!atBottom&&latestPage&&frame.entries?.some(entry=>!entries.has(entry.id)))arrivals.hidden=false;
   if(!latestRequested&&!append&&!atBottom&&latestPage&&!historyPage)historyPage=latestPage;
   // The committed frame gets at most one scroll intent. A transition or an
   // intervening user scroll makes this read's intent ineligible.
   const canScroll=visible&&!transitioning&&!binding&&scroll===scroller&&scroller.scrollTop===scrollTop;
   if(canScroll&&!latestRequested)scrollIntent.view=captureReading();
   if(append)historyPage=next;else latestPage=next;
   cursor=(historyPage||latestPage).taskFrame.nextCursor;
   const previous=entries;entries=new Map();deltas=new Map();
   for(const page of [historyPage,latestPage].filter(Boolean)){
    for(const entry of page.taskFrame.entries||[]){const old=entries.get(entry.id)||previous.get(entry.id);if(old&&!old.streaming&&entry.streaming){entries.set(old.id,old);continue;}if(entry.replacesId)entries.delete(entry.replacesId);entries.set(entry.id,entry);}
    for(const delta of page.taskFrame.deltas||[])deltas.set(delta.id,delta);
   }
   const snapshot={...frame,entries:[...entries.values()].sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id)),deltas:[...deltas.values()]},taskState={...latestPage.taskState};
   for(const field of ['jobs','receipts','todos','agents'])taskState[field]=[...new Map([...(historyPage?.taskState[field]||[]),...(latestPage.taskState[field]||[])].map(item=>[item.id,item])).values()];
   latestRange.hidden=!historyPage;
   reader.render({snapshot,state:taskState,pinnedObjectId:objectId,range:historyPage?'仅保留当前历史页与最新页（每页最多100条）；中间范围未常驻。更早沿原游标读取，或从最新范围连续翻页。':cursor?'当前为最新100条范围；更早原文沿固定任务游标可达。':'已读取当前宿主提供的任务范围。'});
   if(canScroll)applyScroll(scrollIntent);
   presentVisibleMessages();
   more.textContent='读取更早任务记录';
  }finally{if(generation===discussionGeneration){loadingHistory=false;paint();}}
 }
 async function refresh(withDiscussion=true){
  const generation=++readGeneration,next=sourceJobId||unbound()?null:await call('read');if(!live()||generation!==readGeneration)return;
  if(!next){data=null;await loadDiscussion();return;}
  data=next;const staleCode=data.stale?.code||data.stale?.reason||data.stale?.detail?.reason;
  warning.textContent=[['WORK_BUSY','WORK_RUNNING'].includes(staleCode)?'当前回合正在处理；接受须等待完成，讨论发送以队列状态为准。':reviewStaleMessage(data.stale),...(data.capabilities?.reasons||[]).map(reason=>typeof reason==='string'?reason:reason.message)].filter(Boolean).join('\n');
  onAvailability(Boolean(data.files?.length),root);paint();if(withDiscussion)await loadDiscussion();
 }
 async function sendDiscussion({applyDrafts=false,lane=workMode&&!applyDrafts?'next':undefined}={}){
  if(persistenceError||busy||held||composing||(lane==='normal'?(!discussion?.canQueue||!!pendingSend||instruction.readOnly||instruction.disabled||!instruction.value.trim()):send.disabled))return;busy=true;paint();let received=false;
  const selectedSkill=workerSkill.selection(projectId);
  try{
   await saveAll();
   const binding={objectId,reviewVersion:data?.reviewVersion,text:instruction.value,draftRevision:draft.snapshot().revision,...(unbound()?{revision:discussion.revision}:{}),...(selectedSkill?{importedSkill:selectedSkill}:{})};
   if(applyDrafts&&!pendingSend){const files=(data?.files||[]).filter(file=>file.draft&&file.draft.textDigest!==file.candidateDigest).map(file=>({relPath:file.relPath,revision:file.draft.revision,digest:file.draft.textDigest}));if(!files.length)throw Error('没有可交回的已保存人工稿');const text=`固定报告：${binding.objectId}\n审核版本：${binding.reviewVersion}\n`+files.map(file=>`${file.relPath} · 人工稿修订 ${file.revision} · 摘要 ${file.digest}`).join('\n')+'\n将这些确切已保存人工稿交回AI助手执行核对；不会因此合入项目，也不代表采纳或结束。';if(!confirm||!await confirm(text,'交回人工稿并发送',{cancelLabel:'保留原稿',confirmLabel:'确认交回并发送'}))return;}
   if(!pendingSend){
    if(binding.objectId!==objectId||binding.reviewVersion!==data?.reviewVersion||unbound()&&binding.revision!==discussion?.revision)throw Object.assign(Error('任务版本已变化，请重新核对；未自动改绑。'),{code:'REVIEW_TOKEN_CHANGED'});
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([projectId,workId,binding.objectId,binding.reviewVersion,binding.revision,binding.text,binding.draftRevision,applyDrafts===true,lane,...(selectedSkill?[selectedSkill]:[])])));
    const requestKey='review-discussion:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    await persistSend({projectId,workId,...binding,requestKey,applyDrafts:applyDrafts===true,lane});
   }
   const {objectId:sentObjectId,reviewVersion,revision,requestKey,text,applyDrafts:confirmedDrafts,lane:sentLane}=pendingSend;
   const envelope={requestKey,text,...(sentLane?{lane:sentLane}:{}),...(pendingSend.importedSkill?{importedSkill:pendingSend.importedSkill}:{})};
   if(!sentObjectId&&objectId){const receipt=await nativeCall('receipt',{...envelope,objectId:null,revision});if(!receipt?.accepted)throw Object.assign(Error('原任务未登记此输入；草稿保留，请核对当前版本后重新发送。'),{code:'WORK_REVISION_STALE'});}
   else if(!sentObjectId)await workCall('send',{...envelope,revision});
   else await call('discussion.send',{...envelope,objectId:sentObjectId,reviewVersion,...(confirmedDrafts===true?{applyDrafts:true}:{})});
   received=true;
   workerSkill.accepted(projectId,pendingSend.importedSkill);
   ++discussionGeneration;discussion=null;loadingHistory=false;
   // Clear only the accepted text, not a later IME/input draft.
   if(instruction.value===text){
    const saved=draft.snapshot();
    if(saved.revision===pendingSend.draftRevision){draft.setText('');await draft.flush();instruction.value='';}
    else if(saved.text==='')instruction.value='';
   }
   await persistSend(null);
   busy=false;paint();await onChanged();await refresh();
  }catch(error){
   const stale=['WORK_REVISION_STALE','REVIEW_TOKEN_CHANGED','REVIEW_VERSION_STALE','REVIEW_CANDIDATE_STALE'].includes(error.code);
   const rejected=stale||['WORK_CONTROL_HELD','NATIVE_DRAFT_PENDING','SERVICE_FAULT_HELD','REVIEW_BINDING_REQUIRED','WORK_PROBLEM_PENDING','RECOVERY_REQUIRED','WORK_DEVIATION_HELD','REVIEW_CONTINUE_PENDING'].includes(error.code)||/^(INVALID_|BAD_|CHAT_|WORK_BUSY$|WORK_STATE$|WORK_ENDED$|CANDIDATE_REQUIRED$|IPC_DENIED$)/.test(error.code||'')||/_DENIED$|_PAUSED$/.test(error.code||'');
   if(!received&&pendingSend?.importedSkill&&/SKILL/.test(error.code||''))await persistSend(null);
   if(!received&&rejected){await persistSend(null);await refresh();if(stale)throw Object.assign(Error('审核版本已变化，请重新核对最新报告与人工稿后再次发送；本次未自动重发。'),{code:error.code});}
   throw error;
  }
  finally{busy=false;paint();}
 }
 async function discardReview(){
  if(discard.disabled)return;
  decisionStatus.hidden=true;await saveAll();await nativeCall('modal',{held:true});try{await onDiscard?.();}finally{await nativeCall('modal',{held:false});}
 }
 async function acceptReview(){
  if(accept.disabled)return;decisionStatus.hidden=true;busy=true;paint();
  try{
   await saveAll();await nativeCall('modal',{held:true});const reviewVersion=data.reviewVersion;
   const fileCount=data.files?.length||0,target=(data.candidate?.targetRef||'项目目标分支').replace(/^refs\/heads\//,'');
   const summary=[taskName,`报告 V${data.publicationNumber||data.revision}`,`${fileCount} 个文件`].join(' · ');
   const paths=(data.files||[]).map(file=>`${file.relPath}${file.draft&&file.draft.textDigest!==file.candidateDigest?'（采用人工改稿）':''}`).join('\n');
   const unsent='\n未发送的意见不会交给AI，也不会用于修改本次采纳的文件；保留在本工作。';
   if(!await confirm(`${summary}\n${paths}${unsent}\n将当前审核稿写入项目（${target}），并结束这项工作。应用和后台清理完成后才显示已结束；完整审核版本可在“版本与技术详情”查看。`,taskName+' · 采纳并结束',{cancelLabel:'返回审阅',confirmLabel:'采纳并结束'})||!live())return;
   const key='accept:'+reviewVersion,requestKey=keys.get(key)||crypto.randomUUID();keys.set(key,requestKey);
   const response=await invoke('workspace.review.decide',{projectId,workId,objectId,action:'accept',reviewVersion,requestKey});
   if(!response.ok){if(response.error?.code==='REVIEW_TOKEN_CHANGED'){await refresh();throw Object.assign(Error('跨文档保存后审核版本已变化，请重新核对文档并再次确认。'),{code:response.error.code});}throw Object.assign(Error(response.error?.message||'审核决定失败'),{code:response.error?.code});}
   accepted=true;keys.delete(key);await onChanged();await refresh();
  }finally{try{await nativeCall('modal',{held:false});}finally{busy=false;paint();}}
 }
 async function observe(){
  if(!live()||!root.isConnected||!initialized||binding)return;
  if(observing||busy){observeAgain=true;return;}observing=true;
  try{do{observeAgain=false;await refresh();}while(observeAgain&&!busy&&!binding&&live());}catch(error){fail(error);}finally{observing=false;}
 }
 async function bind(nextObjectId){
  if(nextObjectId===objectId)return;
  await saveAll();if(!live())return;
  if(!discussionHost){await nativeCall('bind',{nextObjectId});if(!live())return;}
  const previous={objectId,data,discussion,accepted};
  ++readGeneration;++discussionGeneration;++scrollGeneration;++bindingGeneration;
  if(!discussionHost){opening=null;setOpening(false);setExpanded(false);openingStatus.hidden=true;}
  binding=true;objectId=nextObjectId;root.dataset.managedReview=objectId;accepted=false;data=null;discussion=null;paint();
  decisionStatus.hidden=true;
  try{await (earlyDiscussion?loadDiscussion():refresh());locationStatus.hidden=true;}
  catch(error){
   if(discussionHost){({objectId,data,discussion,accepted}=previous);root.dataset.managedReview=objectId;paint();}
   throw error;
  }finally{binding=false;paint();}
 }
 const onFocus=()=>void observe();window.addEventListener('focus',onFocus);
 let viewportFrame=0,viewportRefreshing=false,viewportAgain=false;
 async function refreshNativeViewport(){if(disposed||discussionHost||!reviewWindow)return;if(viewportRefreshing){viewportAgain=true;return;}viewportRefreshing=true;try{do{viewportAgain=false;await nativeCall('refresh');}while(viewportAgain&&!disposed);}catch(error){fail(error);}finally{viewportRefreshing=false;}}
 const onViewportChanged=()=>{if(!discussionHost&&reviewWindow&&!viewportFrame)viewportFrame=window.requestAnimationFrame(()=>{viewportFrame=0;void refreshNativeViewport();});};window.addEventListener('resize',onViewportChanged);
 const beforeUnload=event=>{if(composing||readingDirty.size||draft?.snapshot().dirty||draft?.snapshot().pending){void saveAll().catch(fail);event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
 const unsubscribe=window.nozeli?.subscribe('agent',event=>{if(event.projectId!==projectId)return;if(event.kind==='managed-state'&&modelShown&&modelAllowed)agentModel?.update({model:true});if(['managed-state','managed-timeline'].includes(event.kind))void observe();});
 const onStorage=event=>{if(event.key!==pendingKey)return;try{pendingSend=JSON.parse(event.newValue||'null');persistenceError=null;}catch(error){persistenceError=error;}paint();};window.addEventListener('storage',onStorage);
 const unsubscribeControl=window.nozeli?.subscribe('workspace.control',event=>{
  if(discussionHost||disposed||event.projectId!==projectId||event.workId!==workId)return;
  if(event.type==='review-discussion-latest'&&live())void Promise.resolve(onOpenLatest?.()).catch(fail);
  if(event.type==='review-discussion-visibility'&&event.objectId===objectId&&typeof event.shown==='boolean'){
   ++visibilityRevision;setExpanded(event.shown);if(event.shown)openingStatus.hidden=true;
  }
 });
 versions.addEventListener('close',()=>void nativeCall('modal',{held:false}).catch(fail));
 const ready=(discussionHost?Promise.all([instructionReady,earlyDiscussion?loadDiscussion():refresh()]):refresh()).then(()=>{initialized=true;}).catch(error=>{fail(error);if(discussionHost)throw error;});
 void ready.catch(()=>{});
 const surface={root,ready,save:saveAll,observe,refresh,show,hide,bind,updateAvailability:paint,async openDetails(){if(versions.open)return;await nativeCall('modal',{held:true});versions.showModal();},get composing(){return composing;},get processing(){return busy||held||composing;},get localWindow(){return reviewWindow;},barrier(event){if(event.projectId!==projectId||event.workId!==workId||event.objectId!==objectId)return;held=event.held===true;paint();},get retained(){return busy||held||composing||readingDirty.size>0||draft?.snapshot().dirty||draft?.snapshot().pending;},destroy(){if(surface.retained)return false;disposed=true;agentModel?.dispose();if(reviewWindow)void reviewWindow.dispose().catch(fail);unsubscribe?.();unsubscribeControl?.();clearTimeout(timer);if(viewportFrame)window.cancelAnimationFrame(viewportFrame);reader?.destroy();materials?.destroy();surfaces.delete(surface);window.removeEventListener('resize',onViewportChanged);window.removeEventListener('storage',onStorage);window.removeEventListener('focus',onFocus);window.removeEventListener('beforeunload',beforeUnload);root.remove();return true;}};
 surface.whenIdle=()=>{if(!surface.processing)return Promise.resolve();queue.textContent+=' · 已记录查看最新报告，将在当前保存完成后切换。';return new Promise(resolve=>idleWaiters.add(resolve));};
 surfaces.add(surface);return surface;
}
