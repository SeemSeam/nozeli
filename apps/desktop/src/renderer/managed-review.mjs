import {createReviewDraft} from './managed-review-draft.mjs';
import {reviewVersionAvailable,reviewStaleMessage,reviewReportOutdated} from './managed-review-availability.mjs';
import {mountReviewFiles} from './managed-review-files.mjs';
import {mountThreadTranscript} from './discussion-thread.mjs';

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
export function mountManagedReview(parent,{invoke,projectId,workId,objectId,workName='',current=()=>true,confirm,onChanged=()=>{},onAvailability=()=>{},onOpenLatest,onOpenFile,onOpenMaterial}){
 const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text)el.textContent=text;return el;};
 const root=node('section','managed-review');root.dataset.managedReview=objectId;
 const heading=node('header','managed-review-heading');
 const taskName=workName||'当前工作';
 const title=node('h3','',taskName);
 const status=node('p','managed-review-status');status.dataset.reviewStatus='';status.setAttribute('role','status');
 const warning=node('p','managed-review-warning');warning.dataset.reviewWarning='';warning.setAttribute('role','alert');
 const button=(text,key,action)=>{const el=node('button','',text);el.type='button';el.dataset.reviewAction=key;el.onclick=()=>Promise.resolve().then(action).catch(fail);return el;};
 const reopen=button('讨论修改','open-discussion',()=>show());
 const latest=button('查看最新报告','latest',()=>onOpenLatest?.());latest.hidden=true;
 heading.append(title,status,reopen,latest);
 const outdated=node('p','managed-review-warning');outdated.dataset.reviewReportOutdated='';outdated.hidden=true;root.append(outdated);
 const versions=node('details','managed-review-versions');versions.dataset.reviewVersions='';versions.append(node('summary','','版本与审核状态'));
 const versionText=node('p');versions.append(versionText);
 const originalDetails=node('details'),originalLabel=node('summary','','原始任务安排与发布身份');
 const originalText=node('pre');originalDetails.append(originalLabel,originalText);versions.append(originalDetails);
 const files=node('div','managed-review-files');files.setAttribute('role','group');files.setAttribute('aria-label','成果文件与版本差异');
 const fileDetail=node('details','managed-review-file-section'),fileHeading=node('summary','','成果文件与差异');fileHeading.dataset.reviewFileHeading='';fileDetail.append(fileHeading,files);
 root.append(heading,warning,versions,fileDetail);parent.append(root);
 const floating=node('section','note-card managed-review-discussion');floating.dataset.reviewDiscussion='';floating.setAttribute('role','region');floating.setAttribute('aria-label',taskName+' · 讨论修改');
 const head=node('header','tag-head');head.tabIndex=0;head.setAttribute('aria-label','讨论修改窗口；方向键移动');
 const caption=node('span','tag-window-title',taskName+' · 讨论修改');caption.title=caption.textContent;
 const close=button('收起','hide-discussion',()=>hide());close.className='tag-close';head.append(caption,close);
 const layoutButton=button('自由摆放','discussion-layout',()=>{freeLayout=!freeLayout;syncReadingLayout();});
 layoutButton.title='默认保留阅读空间；也可自由拖动和调整讨论窗';head.insertBefore(layoutButton,close);
 const latestChat=button('查看最新报告','latest-discussion',()=>onOpenLatest?.());latestChat.hidden=true;head.insertBefore(latestChat,close);
 const queue=node('p','tag-delivery');queue.setAttribute('role','status');queue.dataset.reviewQueue='';
 // U3-02：当前状态区。历史消息（如“系统已接管…无需重复提交”）不改写；
 // 这里按真实的 canSend/canAccept 补一条当前的暂停/不可继续说明。
 const currentState=node('p','managed-review-current-state');currentState.setAttribute('role','status');currentState.dataset.reviewCurrentState='';currentState.hidden=true;
 const transcript=node('div','tag-transcript');transcript.setAttribute('role','log');transcript.setAttribute('aria-label','原始工作上下文与AI助手对话');
 transcript.dataset.reviewDiscussionHistory='';
 const more=button('加载更多原始记录','history-more',()=>loadDiscussion(true));more.hidden=true;
 const composer=node('div','tag-composer');
 const instruction=node('textarea','tag-editor');instruction.rows=2;instruction.maxLength=8000;instruction.dataset.reviewInstruction='';instruction.setAttribute('aria-label','给AI助手的问题或修改要求');instruction.placeholder='询问或提出修改；仅发送时交给AI助手';
 const send=button('发送','send',sendDiscussion);send.className='tag-send';
 const accept=button('采用并结束','accept',acceptReview);accept.className='tag-execute';accept.title='将当前文件应用到项目，后台处理完成后结束工作';
 const instructionStatus=node('p','managed-review-instruction-status');instructionStatus.setAttribute('role','status');instructionStatus.dataset.reviewInstructionStatus='';
 const retry=button('重试保存','retry-instruction',async()=>{if(draft)await draft.retry();else {instructionReady=loadInstruction();await instructionReady;}});retry.hidden=true;
 composer.append(instruction,send,accept);floating.append(head,queue,currentState,transcript,more,composer,instructionStatus,retry);root.append(floating);
 const closingHint=node('p','managed-review-instruction-status','采用当前文件并应用到项目，后台处理完成后结束工作。');floating.append(closingHint);
 const renderThread=mountThreadTranscript(transcript);
 const fileList=mountReviewFiles(files,{openFile:async file=>{await saveAll();return onOpenFile?.(file,{workId,objectId});},openMaterial:async file=>{await saveAll();return onOpenMaterial?.(file,{workId,objectId});},onError:fail});
 let data=null,discussion=null,draft=null,disposed=false,busy=false,held=false,composing=false,timer=null,observing=false,observeAgain=false,readGeneration=0,discussionGeneration=0,loadingHistory=false;
 let entries=new Map(),cursor=null,tailCursor=null,hidden=false,position=null,drag=null;
 const readingPane=parent.closest?.('#managed-doc')||parent;
 let freeLayout=false;
 function syncReadingLayout(){
  if(disposed||typeof readingPane.getBoundingClientRect!=='function')return;
  const rect=readingPane.getBoundingClientRect();
  const mode=freeLayout?'floating':rect.width>=760?'aside':'stack';
  root.dataset.reviewLayout=mode;
  layoutButton.textContent=freeLayout?'恢复并读':'自由摆放';
  layoutButton.setAttribute('aria-pressed',String(freeLayout));
  if(mode==='aside'){
   const width=Math.min(360,Math.max(300,Math.round(rect.width*.32)));
   readingPane.style.setProperty('--review-side-width',width+'px');
   root.style.setProperty('--review-side-width',width+'px');
   root.style.setProperty('--review-side-left',Math.max(8,rect.right-width-8)+'px');
   root.style.setProperty('--review-side-top',Math.max(8,rect.top+8)+'px');
   root.style.setProperty('--review-side-height',Math.max(220,rect.height-16)+'px');
  }else if(mode==='stack')root.style.setProperty('--review-stack-height',Math.max(190,Math.min(280,Math.round(rect.height*.42)))+'px');
  if(freeLayout&&position)place(...position);
  window.dispatchEvent?.(new Event('nozeli-layout-change'));
 }
 const readingObserver=new ResizeObserver(syncReadingLayout);readingObserver.observe(readingPane);
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
 async function call(method,args={}){const result=await invoke('managed.review.'+method,{projectId,workId,objectId,...args});if(!result.ok)throw Object.assign(Error(result.error?.message||'审核请求失败'),{code:result.error?.code});return result.value;}
 function fail(error){if(live()){warning.textContent=error.message+'；原报告和未发送意见保留。';paint();}}
 function show(){hidden=false;floating.hidden=!live();reopen.setAttribute('aria-expanded','true');syncReadingLayout();}
 function hide(){hidden=true;floating.hidden=true;reopen.setAttribute('aria-expanded','false');syncReadingLayout();if(floating.contains(document.activeElement))reopen.focus({preventScroll:true});}
 function paint(){
  const state=draft?.snapshot(),unavailable=!reviewVersionAvailable(data);
  const differentLatest=Boolean(discussion?.latestObjectId&&discussion.latestObjectId!==objectId);
  const staleCode=data?.stale?.code||data?.stale?.reason||data?.stale?.detail?.reason;
  const historical=differentLatest||staleCode==='SUPERSEDED'||(Number.isInteger(data?.workRevision)&&data.workRevision!==data.revision);
  const closed=accepted||['closing','ended'].includes(data?.status)||data?.accepted;
  send.disabled=Boolean(persistenceError)||busy||held||composing||!draft||Boolean(state?.error)||(!pendingSend&&(unavailable||historical||closed||!discussion?.canSend||!instruction.value.trim()));
  accept.disabled=Boolean(persistenceError||pendingSend)||busy||held||composing||!draft||Boolean(state?.error)||unavailable||historical||closed||!data?.capabilities?.canAccept||!discussion||discussion.active||discussion.queued>0;
  instruction.disabled=(!draft||busy||held)&&!composing;instruction.readOnly=Boolean(pendingSend||historical||closed||unavailable||discussion&&!discussion.canSend)&&!composing;
  latest.hidden=latestChat.hidden=!differentLatest||!onOpenLatest;
  status.textContent=!data?'正在读取审核版本…':data.merge?.status==='merged'?'已应用到项目 · '+(data.merge.targetRef||'工作绑定分支'):data.merge?.status==='blocked'?'应用受阻 · '+(data.merge.message||data.merge.blockedCode||'请查看后台处理状态'):accepted?'采用已记录 · 尚未确认应用成功':`报告 V${data.publicationNumber||data.revision} · ${historical?'历史只读':closed?'审核已决定':discussion?.active?'AI助手处理中':'待审核'}`;
  versionText.textContent=data?`报告 V${data.publicationNumber||data.revision} · 工作修订 ${data.revision}\n审核版本：${data.reviewVersion||'不可用'}\n目标引用：${data.candidate?.targetRef||'项目目标分支'}\n文件差异基于冻结候选；人工稿保留在文档工作区。\nAI助手：原 Worker（原工作线程）；任务安排：主控交接。采用后由主控完成合入与收尾。`:'';
  queue.textContent=discussion?[discussion.active?'AI助手正在处理':'',discussion.queued?`已排队 ${discussion.queued} 条`:'',...(discussion.reasons||[]).map(reason=>typeof reason==='string'?(discussionReasons[reason]||reason):reason.message)].filter(Boolean).join(' · '):'正在读取原始工作记录…';
  if(reviewReportOutdated(data?.files||[]))queue.textContent+=' · 已保存人工改稿；可直接采用，也可先发送意见请AI助手核对。';
  outdated.hidden=!reviewReportOutdated(data?.files||[]);outdated.textContent=outdated.hidden?'':'已保存人工改稿，采用时将使用人工稿。原报告未包含这些修改；如需AI助手核对，请先发送意见。';
  if(pendingSend)queue.textContent+=' · 上次发送回执待核对；重试只核对同一请求，不另派新任务。';
  if(persistenceError)queue.textContent+=' · 发送凭据无法读取；为避免重复派工，已暂停发送与接受。';
  // 当前状态区的暂停/不可继续说明：只在发送/采用确因任务状态被拦、且当前
  // 报告就是最新报告时出现；正常审阅、历史只读与已决定路径不受影响。
  const heldCauses={WORK_CONTROL_HELD:'当前任务处于人工暂停或控制操作中',WORK_STATE:'当前任务已暂停',RECOVERY_REQUIRED:'原会话有待处理的恢复决定，任务暂不能继续',WORK_DEVIATION_HELD:'工作偏离问题尚待处理，任务暂不能继续'};
  const heldCode=(discussion?.reasons||[]).map(reason=>typeof reason==='string'?reason:reason?.code).find(code=>Object.prototype.hasOwnProperty.call(heldCauses,code));
  const heldNotice=Boolean(discussion&&heldCode&&!pendingSend&&!persistenceError&&!historical&&!closed&&!unavailable&&!discussion.active&&!discussion.queued);
  currentState.hidden=!heldNotice;
  closingHint.hidden=heldNotice;
  if(heldNotice){
    status.textContent=`报告 V${data.publicationNumber||data.revision} · 当前任务已暂停`;
    const blocked=[!discussion.canSend&&'发送',!data?.capabilities?.canAccept&&'采用'].filter(Boolean);
    currentState.textContent=heldCauses[heldCode]+'；'+(blocked.length>1?blocked.join('与')+'当前都不可用':blocked[0]+'当前不可用')+'，任务不会自动恢复。已发布的报告和文件仍可查看；未发送的意见保留。';
  }
  send.textContent=pendingSend?'核对 / 重试发送':discussion?.active||discussion?.queued?'排队发送':'发送';
  more.hidden=!cursor;more.disabled=loadingHistory;
  floating.hidden=hidden||!live();
  syncReadingLayout();
  if(!busy&&!held&&!composing){for(const resolve of idleWaiters)resolve();idleWaiters.clear();}
 }
 async function loadInstruction(){
  const saved=await call('instruction.read');if(disposed)return;
  instruction.value=saved.text||pendingSend?.text||'';
  draft=createReviewDraft({text:saved.text,revision:saved.revision,save:({text,revision})=>call('instruction.save',{text,expectedRevision:revision}),onState:state=>{instructionStatus.textContent=state.error?'草稿保存失败，输入保留':state.pending?'正在保存草稿…':state.dirty?'草稿尚未保存':'草稿已保存（未发送）';retry.hidden=!state.error;paint();}});
  paint();
 }
 let instructionReady=loadInstruction().catch(error=>{retry.hidden=false;fail(error);throw error;});void instructionReady.catch(()=>{});
 instruction.addEventListener('compositionstart',()=>{composing=true;paint();});instruction.addEventListener('compositionend',()=>{composing=false;paint();});
 instruction.addEventListener('input',()=>{draft?.setText(instruction.value);paint();clearTimeout(timer);timer=setTimeout(()=>void saveAll().catch(fail),600);});
 async function saveAll(){await instructionReady;if(composing)throw Object.assign(Error('请先完成输入法组合。'),{code:'COMPOSING'});clearTimeout(timer);await draft?.flush();}
 async function loadDiscussion(append=false){
  if(append&&(!cursor||loadingHistory))return;
  const generation=++discussionGeneration;loadingHistory=true;paint();
  try{
   const pageCursor=append?cursor:tailCursor;
   const next=await call('discussion.read',{limit:100,...(pageCursor?{cursor:pageCursor}:{})});if(!live()||generation!==discussionGeneration)return;
   discussion=next;tailCursor=pageCursor;cursor=next.nextCursor;
   const merge=page=>{for(const [index,entry]of (page.entries||[]).entries())entries.set(entry.id,{...entry,order:entry.seq??((page.pageStart||0)+index)});};
   merge(next);
   // One contiguous history page plus at most one latest page per event.
   // Intermediate records remain explicitly reachable, never silently omitted.
   if(next.latestCursor&&next.latestCursor!==pageCursor){
    const recent=await call('discussion.read',{limit:100,cursor:next.latestCursor});if(!live()||generation!==discussionGeneration)return;
    discussion=recent;merge(recent);
   }
   if(Number.isInteger(discussion.total)&&entries.size>=discussion.total)cursor=null;
   more.textContent=cursor?'加载下一页原始记录（中间记录尚未全部展开）':'原始记录已全部展开';
   originalText.textContent=[...entries.values()].filter(entry=>entry.source==='publication'||entry.speaker==='orchestrator'&&entry.source==='user-input').map(entry=>[entry.id,entry.objectId,entry.text].filter(Boolean).join('\n')).join('\n\n');
   renderThread([...entries.values()].sort((a,b)=>a.order-b.order).map(entry=>{
     const speaker=entry.source==='work-handoff'?'任务安排':({user:'用户',agent:'AI助手',worker:'AI助手',orchestrator:'任务安排',system:'系统'}[entry.speaker]||entry.speaker);
     const arranged=entry.speaker==='orchestrator'&&entry.source==='user-input';
     const source={'work-request':'原始工作请求','work-handoff':'原始交接','user-input':arranged?'已交接':'原始用户输入','worker-reply':'原始回复',system:'系统原始记录',publication:'发布记录','review-discussion':'讨论修改'}[entry.source]||entry.source;
     const label=[speaker,source].filter(Boolean).join(' · '),text=arranged?'本任务要求与材料已交给AI助手；原始安排可在版本详情查看。':entry.text??(entry.source==='publication'?'报告已保存，可在主工作区查看。':'');
     return entry.speaker==='user'&&entry.source!=='work-handoff'?{requestId:entry.id,question:text,questionLabel:label}:{requestId:entry.id,reply:text,replyLabel:label,messageId:entry.id};
   }));
   if(cursor===pageCursor&&cursor)throw Error('原始记录分页游标未前进');
  }finally{if(generation===discussionGeneration){loadingHistory=false;paint();}}
 }
 async function refresh(){
  const generation=++readGeneration,next=await call('read');if(!live()||generation!==readGeneration)return;
  if(!data)fileDetail.open=next.files?.length===1;
  data=next;const staleCode=data.stale?.code||data.stale?.reason||data.stale?.detail?.reason;
  warning.textContent=[['WORK_BUSY','WORK_RUNNING'].includes(staleCode)?'当前回合正在处理；接受须等待完成，讨论发送以队列状态为准。':reviewStaleMessage(data.stale),...(data.capabilities?.reasons||[]).map(reason=>typeof reason==='string'?reason:reason.message)].filter(Boolean).join('\n');
  fileList.update(data.files||[]);onAvailability(Boolean(data.files?.length),root);paint();await loadDiscussion();
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
   await saveAll();const reviewVersion=data.reviewVersion;
   const fileCount=data.files?.length||0,target=(data.candidate?.targetRef||'项目目标分支').replace(/^refs\/heads\//,'');
   const summary=[taskName,`报告 V${data.publicationNumber||data.revision}`,`${fileCount} 个文件`].join(' · ');
   const paths=(data.files||[]).map(file=>`${file.relPath}${file.draft&&file.draft.textDigest!==file.candidateDigest?'（采用人工改稿）':''}`).join('\n');
   const unsent=instruction.value.trim()?'\n将采用当前文件；你尚未发送的意见不会交给AI，也不会用于修改本次采用的文件。':'';
   if(!await confirm(`${summary}\n${paths}${unsent}\n将当前审核稿写入项目（${target}），并结束这项工作。应用和后台清理完成后才显示已结束；完整审核版本可在“版本与审核状态”查看。`,taskName+' · 采用并结束',{cancelLabel:'返回审阅',confirmLabel:'采用并结束'})||!live())return;
   const key='accept:'+reviewVersion,requestKey=keys.get(key)||crypto.randomUUID();keys.set(key,requestKey);
   const response=await invoke('workspace.review.decide',{projectId,workId,objectId,action:'accept',reviewVersion,requestKey});
   if(!response.ok){if(response.error?.code==='REVIEW_TOKEN_CHANGED'){await refresh();throw Object.assign(Error('跨文档保存后审核版本已变化，请重新核对文档并再次确认。'),{code:response.error.code});}throw Object.assign(Error(response.error?.message||'审核决定失败'),{code:response.error?.code});}
   accepted=true;keys.delete(key);await onChanged();await refresh();
  }finally{busy=false;paint();}
 }
 async function observe(){
  if(!live()||!root.isConnected)return;
  if(observing||busy){observeAgain=true;return;}observing=true;
  try{do{observeAgain=false;await refresh();}while(observeAgain&&!busy&&live());}catch(error){fail(error);}finally{observing=false;}
 }
 async function bind(nextObjectId){
  if(nextObjectId===objectId)return;
  await saveAll();if(!live())return;
  ++readGeneration;++discussionGeneration;objectId=nextObjectId;root.dataset.managedReview=objectId;accepted=false;data=null;discussion=null;paint();await refresh();
 }
 function place(x,y){const rect=floating.getBoundingClientRect();position=[Math.max(0,Math.min(x,window.innerWidth-rect.width)),Math.max(0,Math.min(y,window.innerHeight-rect.height))];floating.style.left=position[0]+'px';floating.style.top=position[1]+'px';floating.style.right='auto';floating.style.bottom='auto';}
 head.addEventListener('pointerdown',event=>{if(!freeLayout||event.button!==0||event.target.closest('button'))return;const rect=floating.getBoundingClientRect();drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:rect.left,top:rect.top};head.setPointerCapture(event.pointerId);});
 head.addEventListener('pointermove',event=>{if(drag?.id===event.pointerId)place(drag.left+event.clientX-drag.x,drag.top+event.clientY-drag.y);});
 const stopDrag=()=>{drag=null;};head.addEventListener('pointerup',stopDrag);head.addEventListener('pointercancel',stopDrag);
 head.addEventListener('keydown',event=>{if(!freeLayout||event.target!==head)return;const offset={ArrowLeft:[-16,0],ArrowRight:[16,0],ArrowUp:[0,-16],ArrowDown:[0,16]}[event.key];if(offset){event.preventDefault();const rect=floating.getBoundingClientRect();place(rect.left+offset[0],rect.top+offset[1]);}});
 floating.addEventListener('keydown',event=>{if(event.key==='Escape'&&!composing){event.stopPropagation();hide();}});
 const onResize=()=>{syncReadingLayout();if(freeLayout&&position)place(...position);};window.addEventListener('resize',onResize);
 const onFocus=()=>void observe();window.addEventListener('focus',onFocus);
 const beforeUnload=event=>{if(composing||draft?.snapshot().dirty||draft?.snapshot().pending){void saveAll().catch(fail);event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
 const unsubscribe=window.nozeli?.subscribe('agent',event=>{if(event.projectId===projectId&&['managed-state','managed-timeline'].includes(event.kind))void observe();});
 const onStorage=event=>{if(event.key!==pendingKey)return;try{pendingSend=JSON.parse(event.newValue||'null');persistenceError=null;}catch(error){persistenceError=error;}paint();};window.addEventListener('storage',onStorage);
 const ready=refresh().catch(fail);
 const surface={root,ready,save:saveAll,observe,refresh,show,hide,bind,get composing(){return composing;},get processing(){return busy||held||composing;},barrier(event){if(event.projectId!==projectId||event.workId!==workId||event.objectId!==objectId)return;held=event.held===true;paint();},get retained(){return busy||held||composing||draft?.snapshot().dirty||draft?.snapshot().pending;},destroy(){if(surface.retained)return false;disposed=true;readingObserver.disconnect();unsubscribe?.();clearTimeout(timer);fileList.destroy();renderThread.disposeOriginalReaders();surfaces.delete(surface);window.removeEventListener('storage',onStorage);window.removeEventListener('resize',onResize);window.removeEventListener('focus',onFocus);window.removeEventListener('beforeunload',beforeUnload);root.remove();return true;}};
 surface.whenIdle=()=>{if(!surface.processing)return Promise.resolve();queue.textContent+=' · 已记录查看最新报告，将在当前保存完成后切换。';return new Promise(resolve=>idleWaiters.add(resolve));};
 surfaces.add(surface);show();return surface;
}
