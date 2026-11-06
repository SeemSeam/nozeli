import './local-window.css';
import {createReviewDraft} from './managed-review-draft.mjs';
import {reviewVersionAvailable,reviewStaleMessage,reviewReportOutdated} from './managed-review-availability.mjs';
import {nativeDiscussionEnvironment} from './review-discussion-environment.mjs';
import {mountThreadTranscript} from './discussion-thread.mjs';
import {projectReviewConversation} from '../domain/review-conversation.mjs';
import {mountLocalWindow,ensureLocalWindowLayer,viewportWindowEnvironment} from './local-window.mjs';
import {createLocalWindowView} from './local-window-view.mjs';

const discussionReasons={WORK_ENDED:'工作已结束',HISTORICAL_SESSION_READ_ONLY:'历史会话只读',REVIEW_CANDIDATE_STALE:'当前显示旧报告，请查看最新报告',REVIEW_CONTINUE_PENDING:'人工稿正在交回AI助手核对',WORK_BUSY:'工作处理中，请等待当前回合',WORK_STATE:'当前工作状态不可发送',WORK_DEVIATION_HELD:'工作偏离问题尚待处理',RECOVERY_REQUIRED:'原会话需要恢复',WORK_CONTROL_HELD:'工作已暂停或正在控制操作',CANDIDATE_REQUIRED:'冻结候选尚不可用'};
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
 const close=document.createElement('button');close.type='button';close.textContent='关闭';
 const heading=document.createElement('h3');heading.textContent=title;
 const body=document.createElement('div');body.className='managed-review-detail-body';
 dialog.append(close,heading,body);parent.append(trigger,dialog);
 trigger.setAttribute('aria-haspopup','dialog');trigger.onclick=()=>dialog.showModal();close.onclick=()=>dialog.close();
 return {trigger,dialog,body,open(){if(!dialog.open)dialog.showModal();}};
}

// Report/files stay in the workspace. Only the Work discussion floats; hiding it
// retains its DOM, selection, draft, scroll position and durable queue identity.
export function mountManagedReview(parent,{invoke,projectId,workId,objectId,workName='',current=()=>true,confirm,onChanged=()=>{},onAvailability=()=>{},onOpenLatest,onDiscard,getDiscardState=()=>({allowed:false}),discussionHost=false,discussionReadOnly=false}){
 const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;return el;};
 const root=node('section','managed-review');root.dataset.managedReview=objectId;
 const heading=node('header','managed-review-heading');
 const taskName=workName||'当前工作';
 const status=node('p','managed-review-status');status.dataset.reviewStatus='';status.setAttribute('role','status');
 const warning=node('p','managed-review-warning');warning.dataset.reviewWarning='';warning.setAttribute('role','alert');
 const button=(text,key,action)=>{const el=node('button','',text);el.type='button';el.dataset.reviewAction=key;el.onclick=()=>Promise.resolve().then(action).catch(fail);return el;};
 const reopen=button('审核讨论','open-discussion',()=>show());reopen.setAttribute('aria-expanded','false');
 const latest=node('a','','查看最新报告');latest.dataset.reviewAction='latest';latest.href='#';latest.hidden=true;latest.onclick=event=>{event?.preventDefault();return Promise.resolve(onOpenLatest?.()).catch(fail);};
 heading.append(status,latest);
 const outdated=node('p','managed-review-warning');outdated.dataset.reviewReportOutdated='';outdated.hidden=true;root.append(outdated);
 const versions=node('dialog','managed-review-detail');versions.dataset.reviewVersions='';versions.setAttribute('aria-label','版本与技术详情');const closeDetails=button('关闭','close-details',()=>versions.close());versions.append(closeDetails,node('h3','','版本与技术详情'));
 const versionText=node('p');versions.append(versionText);
 const actions=node('div','managed-review-actions');
 root.append(heading,warning,actions,versions);parent.append(root);
 const discussionBody=node('div','note-projection tag-chat-window managed-review-discussion');
 const caption=node('span','tag-window-title',taskName);caption.title=taskName;
 const discussionMeta=node('p','managed-review-discussion-meta','审核讨论');
 const latestChat=button('查看最新报告','latest-discussion',()=>onOpenLatest?.());latestChat.hidden=true;latestChat.className='managed-review-latest';
 const queue=node('p','tag-delivery');queue.setAttribute('role','status');queue.dataset.reviewQueue='';
 // U3-02：当前状态区。历史消息（如“系统已接管…无需重复提交”）不改写；
 // 这里按真实的 canSend/canAccept 补一条当前的暂停/不可继续说明。
 const currentState=node('p','managed-review-current-state');currentState.setAttribute('role','status');currentState.dataset.reviewCurrentState='';currentState.hidden=true;
 const transcript=node('div','tag-transcript');transcript.setAttribute('role','log');transcript.setAttribute('aria-label','原始工作上下文与AI助手对话');
 const more=button('加载更多原始记录','history-more',()=>loadDiscussion(true));more.hidden=true;
 const context=node('details','managed-review-context');context.dataset.reviewContext='';context.append(node('summary','','原始任务与主控交接'));
 const contextText=node('pre');context.append(contextText);
 const history=node('div','managed-review-history tag-transcript');history.dataset.reviewDiscussionHistory='';history.append(context,transcript,more);transcript.className='managed-review-rounds';
 const composer=node('div','tag-composer');
 const instruction=node('textarea','tag-editor');instruction.rows=2;instruction.maxLength=8000;instruction.dataset.reviewInstruction='';instruction.setAttribute('aria-label','给AI助手的问题或修改要求');instruction.placeholder='询问或提出修改；仅发送时交给AI助手';
 const inputId='review-instruction-'+crypto.randomUUID();instruction.id=inputId;
 const inputLabel=node('label','managed-review-input-label','向当前审核线程提出修改');inputLabel.htmlFor=inputId;
 const sendReason=node('p','managed-review-send-reason');sendReason.id=inputId+'-reason';
 const send=button('发送','send',sendDiscussion);send.className='tag-send';send.setAttribute('aria-describedby',inputId+'-reason');instruction.setAttribute('aria-describedby',inputId+'-reason '+inputId+'-save');
 const accept=button('采纳并结束','accept',acceptReview);accept.className='tag-execute';accept.title='将当前文件应用到项目，后台处理完成后结束工作';
 const discard=button('放弃并结束','discard',async()=>{await saveAll();await nativeCall('modal',{held:true});try{await onDiscard?.();}finally{await nativeCall('modal',{held:false});}});
 const discardReason=node('p','managed-review-warning');discardReason.dataset.reviewDiscardReason='';discardReason.setAttribute('role','status');discardReason.hidden=true;root.insertBefore(discardReason,versions);
 const instructionStatus=node('p','managed-review-instruction-status');instructionStatus.setAttribute('role','status');instructionStatus.dataset.reviewInstructionStatus='';
 instructionStatus.id=inputId+'-save';
 const retry=button('重试保存','retry-instruction',async()=>{if(draft)await draft.retry();else {instructionReady=loadInstruction();await instructionReady;}});retry.hidden=true;
 composer.append(inputLabel,instruction,send,sendReason);discussionBody.append(discussionMeta,latestChat,queue,history,composer,instructionStatus,retry);discussionBody.hidden=true;root.insertBefore(currentState,actions);
 if(discussionHost){root.hidden=true;root.append(discussionBody);}else actions.append(reopen,accept,discard);
 const renderThread=mountThreadTranscript(transcript,{scrollContainer:history});
 let data=null,discussion=null,draft=null,disposed=false,busy=false,held=false,composing=false,timer=null,observing=false,observeAgain=false,readGeneration=0,discussionGeneration=0,loadingHistory=false;
 let entries=new Map(),cursor=null,tailCursor=null,retainedView=null,reviewWindow=null,reviewWindowReady=null;
 const presented=new Set();
 function presentVisibleMessages(){
  if(!discussionHost||disposed||document.visibilityState!=='visible'||!document.hasFocus()||discussionBody.hidden||!history.getClientRects().length||document.getSelection()?.isCollapsed===false)return;
  const viewport=history.getBoundingClientRect();
  for(const element of transcript.querySelectorAll('[data-message-id]')){
   const entry=entries.get(element.dataset.messageId),threadId=entry?.sessionId;
   if(!threadId||!entry.id||entry.availability==='read-required'||entry.streaming||entry.speaker!=='worker'||!element.getClientRects().length)continue;
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
 function fail(error){if(live()){warning.textContent=error.message+'；原报告和未发送意见保留。';if(discussionHost){instructionStatus.dataset.state='error';instructionStatus.textContent='⚠ '+error.message+'；内容仍保留在当前窗口。';}paint();}}
 // Lazy shell mount: the window is created on first show so an unopened review
 // costs no display-view read; cold restore stays hidden per contract. The
 // same body node keeps transcript, draft and selection identity across
 // show/hide/collapse — only geometry ever changes.
 async function nativeCall(action,args={}){const result=await invoke('workspace.reviewDiscussion.'+action,{projectId,workId,objectId,workName:taskName,...args});if(!result.ok)throw Object.assign(Error(result.error?.message||'讨论窗口操作失败'),{code:result.error?.code});return result.value;}
 function ensureDiscussionWindow(){
  if(reviewWindow)return reviewWindowReady;
  if(!discussionHost){reviewWindow={show:()=>nativeCall('show'),hide:()=>nativeCall('hide'),flush:()=>nativeCall('flush'),dispose:()=>nativeCall('release')};reviewWindowReady=Promise.resolve(reviewWindow);return reviewWindowReady;}
  const layer=ensureLocalWindowLayer();
  const windowKey={projectId,ownerKind:'review',ownerId:workId,surfaceId:window.__workspaceScope?.ownerSurfaceId||'shell'};
  const initial={schema:1,revision:0,placement:{mode:'auto'},size:null,collapsed:false,hidden:true};
  const store=createLocalWindowView({invoke,key:windowKey,initial});
  reviewWindowReady=(async()=>{
   const state=await store.load();if(disposed)return null;
   const defaultRect=b=>({x:b.x+b.width-432,y:b.y+b.height-512,width:420,height:460});
   const environment=window.__workspaceScope?.role==='review-discussion'?nativeDiscussionEnvironment({invoke,scope:window.__workspaceScope,defaultRect,measureBounds:b=>({x:b.x+8,y:b.y+8,width:Math.max(0,b.width-16),height:Math.max(0,b.height-16)})}):viewportWindowEnvironment(layer,{defaultRect:()=>defaultRect({x:0,y:0,width:window.innerWidth,height:window.innerHeight})});
   const win=mountLocalWindow({layer,key:windowKey,title:caption,body:discussionBody,state:{...state,hidden:true},environment,commitView:store.commitView,beforeHide:async()=>{await saveAll();retainedView={scrollTop:history.scrollTop,text:instruction.value,start:instruction.selectionStart,end:instruction.selectionEnd};},onError:fail});
   win.node.dataset.reviewDiscussion='';win.node.setAttribute('role','region');win.node.setAttribute('aria-label',caption.textContent);
   discussionBody.hidden=false;reviewWindow=win;return win;
  })();return reviewWindowReady;
 }
 async function show(){const win=await ensureDiscussionWindow();if(!live()||!win)return;await win.show(reopen);reopen.setAttribute('aria-expanded','true');if(discussionHost){history.scrollTop=retainedView?retainedView.scrollTop:history.scrollHeight;if(retainedView&&!composing&&instruction.value===retainedView.text)instruction.setSelectionRange(retainedView.start,retainedView.end);win.header.focus({preventScroll:true});}}
 async function hide(){if(!reviewWindow)return;await reviewWindow.hide();reopen.setAttribute('aria-expanded','false');}
 function paint(){
  const state=draft?.snapshot(),unavailable=!reviewVersionAvailable(data);
  const differentLatest=Boolean(discussion?.latestObjectId&&discussion.latestObjectId!==objectId);
  const staleCode=data?.stale?.code||data?.stale?.reason||data?.stale?.detail?.reason;
  const historical=discussionReadOnly||differentLatest||staleCode==='SUPERSEDED'||(Number.isInteger(data?.workRevision)&&data.workRevision!==data.revision);
  const closed=accepted||['closing','ended'].includes(data?.status)||data?.accepted;
  send.disabled=discussionReadOnly||Boolean(persistenceError)||busy||held||composing||!draft||Boolean(state?.error)||(!pendingSend&&(unavailable||historical||closed||!discussion?.canSend||!instruction.value.trim()));
  accept.disabled=discussionHost||Boolean(persistenceError||pendingSend)||busy||held||composing||Boolean(state?.error)||unavailable||historical||closed||!data?.capabilities?.canAccept||!discussion||discussion.active||discussion.queued>0;
  const discardState=getDiscardState();discard.disabled=discussionHost||!onDiscard||!discardState?.allowed||busy||held||historical||closed||unavailable;discard.title=discardState?.message||'';
  discardReason.hidden=discussionHost||!data||historical||closed||!discard.disabled;
  discardReason.textContent=discardReason.hidden?'':'放弃并结束暂不可用：'+(held?'正在保存或核对审核决定，请等待当前操作完成。':busy?'当前审核操作尚未完成。':discardState?.message||(!onDiscard?'此报告没有可用的工作结束入口。':'正在核实当前工作处置条件。'));
  instruction.disabled=(!draft||busy||held)&&!composing;instruction.readOnly=Boolean(pendingSend||historical||closed||unavailable||discussion&&!discussion.canSend)&&!composing;
  latest.hidden=latestChat.hidden=!differentLatest||!onOpenLatest;
  status.textContent=!data?'正在读取审核版本…':data.merge?.status==='merged'?'已应用到项目 · '+(data.merge.targetRef||'工作绑定分支'):data.merge?.status==='blocked'?'应用受阻 · '+(data.merge.message||data.merge.blockedCode||'请查看后台处理状态'):accepted?'采用已记录 · 尚未确认应用成功':`报告 V${data.publicationNumber||data.revision} · ${historical?'历史只读':closed?'审核已决定':discussion?.active?'AI助手处理中':'待审核'}`;
  discussionMeta.textContent='审核讨论'+(data?` · 第${data.publicationNumber||data.revision}版${historical?' · 历史只读':''}`:'');if(reviewWindow?.node)reviewWindow.node.setAttribute('aria-label',taskName+' · '+discussionMeta.textContent);
  versionText.textContent=data?`报告 V${data.publicationNumber||data.revision} · 工作修订 ${data.revision}\n审核版本：${data.reviewVersion||'不可用'}\n目标引用：${data.candidate?.targetRef||'项目目标分支'}\n文件差异基于冻结候选；人工稿保留在文档工作区。\nAI助手：原 Worker（原工作线程）；任务安排：主控交接。采用后由主控完成合入与收尾。`:'';
  queue.textContent=discussion?[discussion.active?'AI助手正在处理':'',discussion.queued?`已排队 ${discussion.queued} 条`:'',...(discussion.reasons||[]).map(reason=>typeof reason==='string'?(discussionReasons[reason]||reason):reason.message)].filter(Boolean).join(' · '):'正在读取原始工作记录…';
  if(reviewReportOutdated(data?.files||[]))queue.textContent+=' · 已保存人工改稿；原报告未包含这些修改。';
  outdated.hidden=!reviewReportOutdated(data?.files||[]);outdated.textContent=outdated.hidden?'':'已保存人工改稿，采用时将使用人工稿。原报告未包含这些修改；如需AI助手核对，请先发送意见。';
  if(pendingSend)queue.textContent+=' · 上次发送回执待核对；重试只核对同一请求，不另派新任务。';
  if(persistenceError)queue.textContent+=' · 发送凭据无法读取；为避免重复派工，已暂停发送与接受。';
  queue.dataset.severity=persistenceError?'danger':!discussion?'unknown':discussion.active?'running':discussion.queued?'queued':historical||closed||unavailable||!discussion.canSend?'unknown':'review';
  if(!queue.textContent)queue.textContent=historical?'历史只读':closed?'审核已决定 · 请查看收尾状态':unavailable||!discussion?.canSend?'当前线程状态待核实':'待审阅';
  if(data?.merge?.status==='blocked'){queue.dataset.severity='danger';queue.textContent='审核已决定 · 应用受阻：'+(data.merge.message||data.merge.blockedCode||'请查看后台处理状态');}
  // 当前状态区的暂停/不可继续说明：只在发送/采用确因任务状态被拦、且当前
  // 报告就是最新报告时出现；正常审阅、历史只读与已决定路径不受影响。
  const heldCauses={WORK_CONTROL_HELD:'当前任务处于人工暂停或控制操作中',WORK_STATE:'当前任务已暂停',RECOVERY_REQUIRED:'原会话有待处理的恢复决定，任务暂不能继续',WORK_DEVIATION_HELD:'工作偏离问题尚待处理，任务暂不能继续'};
  const heldCode=(discussion?.reasons||[]).map(reason=>typeof reason==='string'?reason:reason?.code).find(code=>Object.prototype.hasOwnProperty.call(heldCauses,code));
  const heldNotice=Boolean(discussion&&heldCode&&!pendingSend&&!persistenceError&&!historical&&!closed&&!unavailable&&!discussion.active&&!discussion.queued);
  currentState.hidden=!heldNotice;
  if(heldNotice){
    status.textContent=`报告 V${data.publicationNumber||data.revision} · 当前任务已暂停`;
    const blocked=[!discussion.canSend&&'发送',!data?.capabilities?.canAccept&&'采用'].filter(Boolean);
    currentState.textContent=heldCauses[heldCode]+'；'+(blocked.length>1?blocked.join('与')+'当前都不可用':blocked[0]+'当前不可用')+'，任务不会自动恢复。已发布的报告和文件仍可查看；未发送的意见保留。';
    if(discussionHost)queue.dataset.severity=heldCode==='RECOVERY_REQUIRED'||heldCode==='WORK_DEVIATION_HELD'?'decision':'paused';
  }
  send.textContent=pendingSend?'核对 / 重试发送':discussion?.active||discussion?.queued?'排队发送':'发送';
  sendReason.textContent=!send.disabled?'':busy?'正在发送…':held?'正在保存或核对审核决定，请等待':composing?'请先完成输入法组合':persistenceError?'发送凭据无法读取，已暂停发送':state?.error?'草稿保存失败，请先重试保存':!draft?'正在读取本地草稿':discussionReadOnly||historical?'当前历史版本只读':closed?'审核已决定，不能继续发送':!pendingSend&&unavailable?'当前审核版本不可用':!pendingSend&&!discussion?.canSend?(discussion?.reasons||[]).map(reason=>typeof reason==='string'?(discussionReasons[reason]||reason):reason.message).filter(Boolean).join(' · ')||'当前线程暂不可发送':!instruction.value.trim()&&!pendingSend?'输入内容后可发送':'';
  sendReason.hidden=!sendReason.textContent;
  more.hidden=!cursor;more.disabled=loadingHistory;
  if(!busy&&!held&&!composing){for(const resolve of idleWaiters)resolve();idleWaiters.clear();}
 }
 async function loadInstruction(){
  const saved=await call('instruction.read');if(disposed)return;
  instruction.value=saved.text||pendingSend?.text||'';
  draft=createReviewDraft({text:saved.text,revision:saved.revision,save:({text,revision})=>call('instruction.save',{text,expectedRevision:revision}),onState:state=>{instructionStatus.dataset.state=state.error?'error':state.pending?'pending':'saved';instructionStatus.textContent=state.error?'⚠ 草稿保存失败，内容仍保留在当前窗口：'+(state.error.message||state.error):state.pending?'正在保存草稿…':state.dirty?'草稿尚未保存':'本地草稿已保存 · 未发送';retry.hidden=!state.error;paint();}});
  paint();
 }
 let instructionReady=discussionHost?loadInstruction().catch(error=>{retry.hidden=false;fail(error);throw error;}):Promise.resolve();void instructionReady.catch(()=>{});
 instruction.addEventListener('compositionstart',()=>{composing=true;paint();});instruction.addEventListener('compositionend',()=>{composing=false;paint();});
 instruction.addEventListener('input',()=>{draft?.setText(instruction.value);paint();clearTimeout(timer);timer=setTimeout(()=>void saveAll().catch(fail),600);});
 async function saveAll(){if(!discussionHost){await nativeCall('flush');return;}await instructionReady;if(composing)throw Object.assign(Error('请先完成输入法组合。'),{code:'COMPOSING'});clearTimeout(timer);await draft?.flush();}
 async function loadDiscussion(append=false){
  if(append&&(!cursor||loadingHistory))return;
  const generation=++discussionGeneration;loadingHistory=true;paint();
  try{
   const pageCursor=append?cursor:tailCursor;
   const next=await call('discussion.read',{limit:100,...(pageCursor?{cursor:pageCursor}:{})});if(!live()||generation!==discussionGeneration)return;
   discussion=next;tailCursor=pageCursor;cursor=next.nextCursor;
   const merge=page=>{for(const [index,entry]of (page.entries||[]).entries()){
    const row={...entry,order:entry.seq??((page.pageStart||0)+index)};
    if(entry.availability==='read-required')row.readReply=async options=>{
     if(!live())throw Error('审核工作面已切换');
     const result=await invoke('managed.timeline.read',{...options,projectId,id:entry.id});
     if(!live())throw Error('审核工作面已切换');
     if(!result.ok)throw Error(result.error?.message||'原始记录暂时不可读');
     return result.value?.entry??result.value;
    };
    entries.set(entry.id,row);
   }};
   merge(next);
   // One contiguous history page plus at most one latest page per event.
   // Intermediate records remain explicitly reachable, never silently omitted.
   if(next.latestCursor&&next.latestCursor!==pageCursor){
    const recent=await call('discussion.read',{limit:100,cursor:next.latestCursor});if(!live()||generation!==discussionGeneration)return;
    discussion=recent;merge(recent);
   }
   if(Number.isInteger(discussion.total)&&entries.size>=discussion.total)cursor=null;
   more.textContent=cursor?'加载下一页原始记录（中间记录尚未全部展开）':'原始记录已全部展开';
   const projection=projectReviewConversation([...entries.values()].sort((a,b)=>a.order-b.order));
   context.hidden=!projection.context.length;
   const originalContext=projection.context.map(entry=>[entry.label,entry.text].filter(Boolean).join('\n')).join('\n\n');if(contextText.textContent!==originalContext)contextText.textContent=originalContext;
   renderThread(projection.entries);
   window.requestAnimationFrame(presentVisibleMessages);
   if(cursor===pageCursor&&cursor)throw Error('原始记录分页游标未前进');
  }finally{if(generation===discussionGeneration){loadingHistory=false;paint();}}
 }
 async function refresh(){
  const generation=++readGeneration,next=await call('read');if(!live()||generation!==readGeneration)return;
  data=next;const staleCode=data.stale?.code||data.stale?.reason||data.stale?.detail?.reason;
  warning.textContent=[['WORK_BUSY','WORK_RUNNING'].includes(staleCode)?'当前回合正在处理；接受须等待完成，讨论发送以队列状态为准。':reviewStaleMessage(data.stale),...(data.capabilities?.reasons||[]).map(reason=>typeof reason==='string'?reason:reason.message)].filter(Boolean).join('\n');
  onAvailability(Boolean(data.files?.length),root);paint();await loadDiscussion();
 }
 async function sendDiscussion(){
  if(send.disabled)return;busy=true;paint();let received=false;
  try{
   await saveAll();
   if(!pendingSend){
    const text=instruction.value,reviewVersion=data.reviewVersion,draftRevision=draft.snapshot().revision;
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([projectId,workId,objectId,reviewVersion,text,draftRevision])));
    const requestKey='review-discussion:'+Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
    await persistSend({projectId,workId,objectId,reviewVersion,requestKey,text,draftRevision});
   }
   const {objectId:sentObjectId,reviewVersion,requestKey,text}=pendingSend;
   await call('discussion.send',{objectId:sentObjectId,reviewVersion,requestKey,text});
   received=true;
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
   const stale=['REVIEW_TOKEN_CHANGED','REVIEW_VERSION_STALE','REVIEW_CANDIDATE_STALE'].includes(error.code);
   const rejected=stale||/^(INVALID_|BAD_|WORK_BUSY$|WORK_STATE$|WORK_ENDED$|CANDIDATE_REQUIRED$|IPC_DENIED$)/.test(error.code||'')||/_DENIED$|_PAUSED$/.test(error.code||'');
   if(!received&&rejected){await persistSend(null);await refresh();if(stale)throw Object.assign(Error('审核版本已变化，请重新核对最新报告与人工稿后再次发送；本次未自动重发。'),{code:error.code});}
   throw error;
  }
  finally{busy=false;paint();}
 }
 async function acceptReview(){
  if(accept.disabled)return;busy=true;paint();
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
  if(!live()||!root.isConnected)return;
  if(observing||busy){observeAgain=true;return;}observing=true;
  try{do{observeAgain=false;await refresh();}while(observeAgain&&!busy&&live());}catch(error){fail(error);}finally{observing=false;}
 }
 async function bind(nextObjectId){
  if(nextObjectId===objectId)return;
  await saveAll();if(!live())return;if(!discussionHost)await nativeCall('bind',{nextObjectId});
  ++readGeneration;++discussionGeneration;objectId=nextObjectId;root.dataset.managedReview=objectId;accepted=false;data=null;discussion=null;paint();await refresh();
 }
 const onFocus=()=>void observe();window.addEventListener('focus',onFocus);
 let viewportFrame=0,viewportRefreshing=false,viewportAgain=false;
 async function refreshNativeViewport(){if(disposed||discussionHost||!reviewWindow)return;if(viewportRefreshing){viewportAgain=true;return;}viewportRefreshing=true;try{do{viewportAgain=false;await nativeCall('refresh');}while(viewportAgain&&!disposed);}catch(error){fail(error);}finally{viewportRefreshing=false;}}
 const onViewportChanged=()=>{if(!discussionHost&&reviewWindow&&!viewportFrame)viewportFrame=window.requestAnimationFrame(()=>{viewportFrame=0;void refreshNativeViewport();});};window.addEventListener('resize',onViewportChanged);
 const beforeUnload=event=>{if(composing||draft?.snapshot().dirty||draft?.snapshot().pending){void saveAll().catch(fail);event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
 const unsubscribe=window.nozeli?.subscribe('agent',event=>{if(event.projectId===projectId&&['managed-state','managed-timeline'].includes(event.kind))void observe();});
 const onStorage=event=>{if(event.key!==pendingKey)return;try{pendingSend=JSON.parse(event.newValue||'null');persistenceError=null;}catch(error){persistenceError=error;}paint();};window.addEventListener('storage',onStorage);
 const unsubscribeControl=window.nozeli?.subscribe('workspace.control',event=>{if(!discussionHost&&event.type==='review-discussion-latest'&&event.projectId===projectId&&event.workId===workId)void Promise.resolve(onOpenLatest?.()).catch(fail);});
 versions.addEventListener('close',()=>void nativeCall('modal',{held:false}).catch(fail));
 const ready=refresh().catch(fail);
 const surface={root,ready,save:saveAll,observe,refresh,show,hide,bind,updateAvailability:paint,async openDetails(){if(versions.open)return;await nativeCall('modal',{held:true});versions.showModal();},get composing(){return composing;},get processing(){return busy||held||composing;},get localWindow(){return reviewWindow;},barrier(event){if(event.projectId!==projectId||event.workId!==workId||event.objectId!==objectId)return;held=event.held===true;paint();},get retained(){return busy||held||composing||draft?.snapshot().dirty||draft?.snapshot().pending;},destroy(){if(surface.retained)return false;disposed=true;if(reviewWindow)void reviewWindow.dispose().catch(fail);unsubscribe?.();unsubscribeControl?.();clearTimeout(timer);if(viewportFrame)window.cancelAnimationFrame(viewportFrame);renderThread.disposeOriginalReaders();surfaces.delete(surface);window.removeEventListener('resize',onViewportChanged);window.removeEventListener('storage',onStorage);window.removeEventListener('focus',onFocus);window.removeEventListener('beforeunload',beforeUnload);root.remove();return true;}};
 surface.whenIdle=()=>{if(!surface.processing)return Promise.resolve();queue.textContent+=' · 已记录查看最新报告，将在当前保存完成后切换。';return new Promise(resolve=>idleWaiters.add(resolve));};
 surfaces.add(surface);return surface;
}
