import {createReviewDraft} from './managed-review-draft.mjs';
import {reviewVersionAvailable,reviewStaleMessage,reviewReportOutdated} from './managed-review-availability.mjs';
import {mountReviewFiles} from './managed-review-files.mjs';

const surfaces=new Set();
export async function flushManagedReviews(){
 try{for(const surface of surfaces)await surface.save();return {ok:true};}
 catch(error){return {ok:false,error:{code:error.code||'REVIEW_SAVE_FAILED',message:error.message}};}
}
export function applyManagedReviewBarrier(event){for(const surface of surfaces)surface.barrier(event);}
export function managedReviewComposing(){return [...surfaces].some(surface=>surface.composing);}

// Keep detail nodes mounted: closing a dialog never discards selection or drafts.
export function mountReviewDetail(parent,title){
 const trigger=document.createElement('button');trigger.type='button';trigger.textContent=title;
 const dialog=document.createElement('dialog');dialog.className='managed-review-detail';dialog.setAttribute('aria-label',title);
 const close=document.createElement('button');close.type='button';close.textContent='关闭';
 const heading=document.createElement('h3');heading.textContent=title;
 const body=document.createElement('div');body.className='managed-review-detail-body';
 dialog.append(close,heading,body);parent.append(trigger,dialog);
 trigger.setAttribute('aria-haspopup','dialog');trigger.onclick=()=>dialog.showModal();close.onclick=()=>dialog.close();
 return {trigger,dialog,body,open(){if(!dialog.open)dialog.showModal();}};
}

// The report owns its candidate list, unsent continuation note and two explicit
// version-bound decisions. Document workspaces remain the editing/diff surface.
export function mountManagedReview(parent,{invoke,projectId,workId,objectId,current=()=>true,confirm,onChanged=()=>{},onAvailability=()=>{},onOpenFile,onOpenMaterial}){
 const root=document.createElement('section');root.className='managed-review';root.dataset.managedReview=objectId;
 const heading=document.createElement('header');heading.className='managed-review-heading';
 const title=document.createElement('h3');title.textContent='审核成果 · 决定下一步';
 const status=document.createElement('p');status.className='managed-review-status';status.dataset.reviewStatus='';status.setAttribute('role','status');
 heading.append(title,status);
 const versions=mountReviewDetail(heading,'版本详情');versions.trigger.dataset.reviewVersions='';
 const versionText=document.createElement('p');versions.body.append(versionText);
 const warning=document.createElement('p');warning.className='managed-review-warning';warning.dataset.reviewWarning='';warning.setAttribute('role','alert');
 const outdated=document.createElement('p');outdated.className='managed-review-warning';outdated.dataset.reviewReportOutdated='';outdated.setAttribute('role','status');outdated.hidden=true;
 const filesSection=document.createElement('div');filesSection.className='managed-review-file-section';
 const fileDetail=mountReviewDetail(filesSection,'成果文件与差异'),fileHeading=fileDetail.trigger;fileHeading.dataset.reviewFileHeading='';
 const files=document.createElement('div');files.className='managed-review-files';files.tabIndex=-1;files.setAttribute('role','group');files.setAttribute('aria-label','成果文件；点击文件名查看内容或实际效果，使用差异入口查看版本差异');
 fileDetail.body.append(files);
 const instructionSection=document.createElement('div');instructionSection.className='managed-review-instructions';instructionSection.id='managed-review-instructions-'+crypto.randomUUID();instructionSection.hidden=true;instructionSection.tabIndex=-1;
 const instructionHeading=document.createElement('h4');instructionHeading.textContent='讨论问题与修改要求';instructionSection.append(instructionHeading);
 const label=document.createElement('label');label.className='managed-review-instruction-label';label.textContent='给原 Worker 的问题或修改要求（可选）';
 const instruction=document.createElement('textarea');instruction.dataset.reviewInstruction='';instruction.maxLength=8000;instruction.disabled=true;instruction.setAttribute('aria-label','给原 Worker 的问题或修改要求');instruction.placeholder='写下需要解释的问题或希望调整的内容；输入只保存本地意见';
 const instructionStatus=document.createElement('p');instructionStatus.className='managed-review-instruction-status';instructionStatus.dataset.reviewInstructionStatus='';instructionStatus.setAttribute('role','status');label.append(instruction,instructionStatus);
 const actions=document.createElement('div');actions.className='managed-review-actions';
 const button=(text,key,action)=>{const node=document.createElement('button');node.type='button';node.textContent=text;node.dataset.reviewAction=key;node.onclick=()=>action().catch(fail);return node;};
 const resume=button('发送给原 Worker 继续处理','continue',()=>decide('continue'));
 const accept=button('接受并收尾','accept',()=>decide('accept'));
 const instructionDetail=mountReviewDetail(root,'讨论问题与修改要求');instructionDetail.trigger.remove();instructionDetail.body.append(instructionSection);
 const discuss=button('继续讨论 / 修改','open-instruction',async()=>{revealInstruction();instructionDetail.open();(instruction.disabled?instructionSection:instruction).focus();});discuss.setAttribute('aria-haspopup','dialog');discuss.setAttribute('aria-controls',instructionSection.id);
 const continueChoice=document.createElement('div');continueChoice.className='managed-review-choice';
 const continueHint=document.createElement('p');continueHint.textContent='先写问题或修改意见，不会立即派工。';continueChoice.append(discuss);instructionSection.append(continueHint);
 const acceptChoice=document.createElement('div');acceptChoice.className='managed-review-choice';
 const acceptHint=document.createElement('p');acceptHint.textContent='确认确切版本；主控完成全部收尾后才结束。';acceptChoice.append(accept);
 const retryInstruction=button('重试保存意见','retry-instruction',async()=>{if(draft){await draft.retry();return;}instructionReady=loadInstruction();await instructionReady;});retryInstruction.hidden=true;
 const instructionActions=document.createElement('div');instructionActions.className='managed-review-actions';instructionActions.append(resume);
 const sendHint=document.createElement('p');sendHint.className='managed-review-send-hint';sendHint.textContent='发送前仍需确认：已保存人工稿与意见将交回原 Worker 继续处理，可能修改候选成果；不是只读聊天。';
 instructionSection.append(label,sendHint,instructionActions);actions.append(continueChoice,acceptChoice);actions.setAttribute('role','group');actions.setAttribute('aria-label','审核决定');
 const detail=mountReviewDetail(heading,'审核状态详情');detail.body.append(acceptHint,warning,outdated);
 root.append(heading,actions,filesSection);parent.append(root);
 const compactDetail=mountReviewDetail(root,'详情');compactDetail.trigger.className='managed-review-compact-detail';compactDetail.trigger.hidden=true;
 const fullStatus=document.createElement('p');compactDetail.body.append(fullStatus);
 // Dialogs stay at their original mounted root even when their launchers move.
 root.append(fileDetail.dialog);
 const fileList=mountReviewFiles(files,{openFile,openMaterial:openMaterial,onError:fail});
 let data=null,busy=false,held=false,decisionState=null,disposed=false,composing=false,timer=null,draft=null,observing=false,observeAgain=false,readGeneration=0;
 const keys=new Map();
 let compact=false;
 const compactSlots=new Map(),pane=parent.closest('#reader-scroll')||parent;
 function syncCompact(){
  if(disposed||!root.isConnected||root.querySelector('dialog[open]'))return;
  const font=parseFloat(getComputedStyle(root).fontSize)||13;
  const next=pane.clientWidth<22*font||pane.clientHeight<30*font;
  const changed=compact!==next;compact=next;root.dataset.compact=String(compact);compactDetail.trigger.hidden=!compact;
  const closing=data?.status==='closing';compactDetail.trigger.textContent=closing?'恢复':warning.textContent||!outdated.hidden?'提示':'详情';compactDetail.trigger.setAttribute('aria-label',closing?'查看收尾状态与安全恢复操作':'查看审核状态、版本与成果文件');
  const secondary=[title,versions.trigger,detail.trigger,filesSection,root.querySelector('[data-review-closure]'),...root.querySelectorAll(':scope > [data-frozen-artifacts]'),...parent.querySelectorAll(':scope > .managed-report-state'),...[...compactSlots.keys()].filter(node=>node.matches('.managed-report-state,[data-frozen-artifacts]'))];
  if(closing)secondary.push(actions);
  const wanted=new Set(compact?secondary.filter(Boolean):[]);
  const focused=document.activeElement;
  for(const [node,marker] of compactSlots)if(!wanted.has(node)){marker.replaceWith(node);compactSlots.delete(node);}
  for(const node of wanted)if(!compactSlots.has(node)){const marker=document.createComment('review-detail-slot');node.before(marker);compactSlots.set(node,marker);compactDetail.body.append(node);}
  if(focused&&focused!==document.body&&focused.isConnected&&document.activeElement!==focused){if(compactDetail.body.contains(focused))compactDetail.trigger.focus({preventScroll:true});else focused.focus({preventScroll:true});}
  if(changed)paint();
 }
 const compactObserver=new ResizeObserver(syncCompact);compactObserver.observe(pane);compactObserver.observe(root);
 const compactChildren=new MutationObserver(syncCompact);compactChildren.observe(root,{childList:true});compactChildren.observe(parent,{childList:true});
 root.addEventListener('close',syncCompact,true);
 const live=()=>!disposed&&current();
 async function call(method,args={}){const result=await invoke('managed.review.'+method,{projectId,workId,objectId,...args});if(!result.ok)throw Object.assign(Error(result.error?.message||'审核请求失败'),{code:result.error?.code});return result.value;}
 function fail(error){if(live()){warning.textContent=error.message+'；原报告和未发送意见仍保留。';if(!data)onAvailability(false,root);paint();}}
 function target(){return (data?.merge?.targetRef||data?.candidate?.targetRef||'工作绑定目标分支').replace(/^refs\/heads\//,'');}
 function paint(){
  const state=draft?.snapshot(),unavailable=!reviewVersionAvailable(data);
 const historical=Number.isInteger(data?.workRevision)&&data.workRevision!==data.revision;
 resume.disabled=busy||held||Boolean(decisionState)||['closing','ended'].includes(data?.status)||!draft||Boolean(state?.error)||unavailable||!data?.capabilities?.canContinue;
 accept.disabled=busy||held||Boolean(decisionState)||['closing','ended'].includes(data?.status)||!draft||Boolean(state?.error)||unavailable||!data?.capabilities?.canAccept;
 discuss.disabled=busy||held;
 const notesReadOnly=unavailable||Boolean(data?.stale)||Boolean(decisionState)||data?.accepted||['running','closing','ended'].includes(data?.status)||(!data?.capabilities?.canContinue&&!data?.capabilities?.canAccept);
  instruction.readOnly=Boolean(notesReadOnly)&&!composing;
 discuss.textContent=notesReadOnly?(compact?'意见':'查看审核意见'):(compact?'修改':'继续讨论 / 修改');discuss.setAttribute('aria-label',notesReadOnly?'查看审核意见':'继续讨论 / 修改');accept.textContent=compact?'接受':'接受并收尾';accept.setAttribute('aria-label','接受确切审核版本并交由主控收尾');
  continueHint.textContent=notesReadOnly?'当前版本不可继续；仍可查看和复制保留的意见。':'先写问题或修改意见，不会立即派工。';
  sendHint.textContent=notesReadOnly?'当前版本只读，不能编辑或发送意见；已有文字仍保留，可选择复制。':!data?.capabilities?.canContinue?'当前不能发送给原 Worker；可先保存本地意见，具体原因见上方状态。':'发送前仍需确认：已保存人工稿与意见将交回原 Worker 继续处理，可能修改候选成果；不是只读聊天。';
  instruction.disabled=(busy||held)&&!composing||!draft;
  retryInstruction.disabled=busy||held||state?.pending||composing;
  outdated.hidden=!reviewReportOutdated(data?.files||[]);outdated.textContent='人工候选已修改：原报告尚未针对这些修改重新验证。保存不会派工；可交回原 Worker 检查，或接受当前确切版本。';
  const merge=data?.merge;
  const outcome=merge?.status==='merged'?'已合入 '+target():merge?.status==='blocked'?'合入受阻：'+(merge.message||merge.blockedCode):merge?.status==='pending'||merge?.status==='queued'?'接受已记录 · 等待宿主合入 '+target():merge?.status==='merging'?'接受已记录 · 正在合入 '+target():decisionState==='accepted'||data?.accepted?'接受已记录 · 尚未确认合入成功':data?.status==='running'?'原 Worker 正在继续修改':decisionState==='continued'?'继续已记录 · 已交回原 Worker 队列':data?.continuation?.state==='blocked'?'继续修改受阻：'+(data.continuation.error?.message||'需核对执行目录'):data?.stale?'旧候选，只读 · 不可继续或接受':!data?.capabilities?.canAccept&&!data?.capabilities?.canContinue?'只读 · 当前不可继续或接受':'';
 status.textContent=held?'正在保存审核文档与意见，并核对确切版本…':!data?'正在读取冻结候选…':historical?`第 ${data.revision} 版 · 历史只读（当前工作第 ${data.workRevision} 版）`:data.status==='closing'?`第 ${data.revision} 版 · 审核已决定，收尾未完成`:unavailable?'冻结候选或审核版本不可用，不能继续或接受；原报告仍保留。':`第 ${data.revision} 版 · ${outcome||'待审核'}`;
 fullStatus.textContent=status.textContent;
 if(compact)status.textContent=held?'正在核对版本…':!data?'正在读取…':`第 ${data.revision} 版 · ${historical?'历史只读':data.status==='closing'?'收尾未完成':data.status==='ended'?'已结束':data.stale?'历史只读':data.status==='review'?'待审核':'状态详情'}`;
 versions.trigger.hidden=!data;versionText.textContent=data?`审核版本：${data.reviewVersion||'不可用'}${merge?.commit?'\n合入提交：'+merge.commit:''}\n计数为输入基线与 Worker 冻结候选的差异，不含人工稿。`:'';
 detail.trigger.textContent=warning.textContent||!outdated.hidden?'审核提示 · 查看详情':'审核状态详情';
  root.dataset.reviewState=merge?.status||(!data?.capabilities?.canAccept&&!data?.capabilities?.canContinue?'readonly':'review');
  syncCompact();
 }
 function loadInstruction(){return call('instruction.read').then(saved=>{
  if(disposed)return;instruction.value=saved.text;
  draft=createReviewDraft({text:saved.text,revision:saved.revision,save:({text,revision})=>call('instruction.save',{text,expectedRevision:revision}),onState:state=>{showInstructionState(state.error?'意见保存失败，输入仍保留':state.pending?'正在保存意见…':state.dirty?'意见尚未保存':'意见已保存（未发送）',Boolean(state.error));if(live())paint();}});
  showInstructionState(saved.text?'已恢复未发送意见':'可选；输入后自动保存，不会自动发送');if(saved.text)revealInstruction();paint();
 }).catch(error=>{showInstructionState('意见读取失败：'+error.message,true);throw error;});}
 function revealInstruction(){instructionSection.hidden=false;}
 function showInstructionState(message,canRetry=false){const text=document.createElement('span');text.textContent=message;instructionStatus.replaceChildren(text);if(canRetry){instructionStatus.append(retryInstruction);revealInstruction();}retryInstruction.hidden=!canRetry;instructionHeading.textContent=canRetry?'讨论与修改 · 意见需处理':instruction.value?'讨论与修改 · 有未发送意见':'讨论问题与修改要求';}
 let instructionReady=loadInstruction();void instructionReady.catch(fail);
 instruction.addEventListener('compositionstart',()=>{composing=true;});instruction.addEventListener('compositionend',()=>{composing=false;paint();});
 instruction.addEventListener('input',()=>{draft?.setText(instruction.value);clearTimeout(timer);timer=setTimeout(()=>void saveAll().catch(fail),600);});
 async function saveAll(){
  try{await instructionReady;}catch(error){if(draft||instruction.value)throw error;}
  if(composing)throw Object.assign(Error('修改意见输入法组合尚未结束。'),{code:'COMPOSING'});
  clearTimeout(timer);if(draft)await draft.flush();
 }
 async function openFile(file){
  await saveAll();if(!live())return;
  if(!onOpenFile)throw Error('冻结差异入口不可用；未打开同名项目文件。');
  return onOpenFile(file,{changeSetId:data?.changeSetId,workId,objectId});
 }
 async function openMaterial(file){
  await saveAll();if(!live())return;
  if(onOpenMaterial)return onOpenMaterial(file);
  const result=await invoke('workspace.control',{type:'open-file',projectId,relPath:file.relPath,documentSource:{type:'review',workId,objectId}});
  if(!result.ok)throw Error(result.error?.message||'审核材料打开失败');
 }
 async function refresh(){
  const request=++readGeneration,next=await call('read');if(!live()||request!==readGeneration)return;data=next;
  warning.textContent=[reviewStaleMessage(data.stale),...(data.capabilities?.reasons||[]).map(reason=>typeof reason.message==='string'?reason.message:'审核条件尚不满足')].filter(Boolean).join('\n');
  const fileCount=data.files?.length||0;fileHeading.textContent=`成果文件${fileCount?' · '+fileCount:''} · 查看文件与差异`;filesSection.hidden=!fileCount;fileList.update(data.files||[]);
  onAvailability(Boolean(fileCount),root);
  paint();
 }
 async function decide(action){
 if(busy||held||decisionState||['closing','ended'].includes(data?.status)||!data?.capabilities?.[action==='accept'?'canAccept':'canContinue']||!reviewVersionAvailable(data))return;busy=true;paint();
  try{
   await saveAll();
   const reviewed=data.reviewVersion;
   const message=action==='accept'?`接受审核版本 ${reviewed} 的确切内容。${reviewReportOutdated(data.files||[])?'人工修改尚未经原 Worker 重新验证。':''}宿主将安全合入 ${target()}；原用户授权和确切审核版本会被保留，遇到新的并发变化则展示差异供明确决定。`:`本次不接受审核版本 ${reviewed}；将已保存人工稿和问题或修改要求交回原 Worker 继续处理，可能修改候选成果，并非只读聊天。保留同任务、线程和发布历史，不丢弃成果或结束工作。`;
   if(!await confirm(message,action==='accept'?'接受确切审核版本':'发送给原 Worker')||!live())return;
   const key=action+':'+reviewed,requestKey=keys.get(key)||crypto.randomUUID();keys.set(key,requestKey);
   const response=await invoke('workspace.review.decide',{projectId,workId,objectId,action,reviewVersion:reviewed,requestKey,...(action==='continue'?{instruction:instruction.value}:{})});
   if(!response.ok){
    if(response.error?.code==='REVIEW_TOKEN_CHANGED'){
     await refresh();throw Object.assign(Error('跨文档保存后审核版本已变化。已显示最新状态，请重新核对文档并再次确认；本次未继续或接受。'),{code:'REVIEW_TOKEN_CHANGED'});
    }
    throw Object.assign(Error(response.error?.message||'审核决定未完成'),{code:response.error?.code});
   }
   keys.delete(key);decisionState=action==='continue'?'continued':'accepted';
 if(!live())return;data={...data,...response.value,capabilities:{canContinue:false,canAccept:false}};await onChanged();await refresh();
  }finally{busy=false;if(live())paint();}
 }
 async function observe(){
  if(busy||!live()||!root.isConnected)return;
  if(observing){observeAgain=true;return;}
  observing=true;
  try{do{observeAgain=false;await refresh();}while(observeAgain&&!busy&&live()&&root.isConnected);}
  catch(error){fail(error);}finally{observing=false;}
 }
 const onFocus=()=>void observe();window.addEventListener('focus',onFocus);
 const beforeUnload=event=>{if(composing||draft?.snapshot().dirty||draft?.snapshot().pending){void saveAll().catch(fail);event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
 const ready=refresh().catch(fail);
 const surface={root,ready,save:saveAll,observe,refresh,get composing(){return composing;},barrier(event){if(event.projectId!==projectId||event.workId!==workId||event.objectId!==objectId)return;held=event.held===true;paint();},get retained(){return busy||held||composing||draft?.snapshot().dirty||draft?.snapshot().pending;},destroy(){if(surface.retained)return false;disposed=true;compactObserver.disconnect();compactChildren.disconnect();root.removeEventListener('close',syncCompact,true);clearTimeout(timer);fileList.destroy();surfaces.delete(surface);window.removeEventListener('focus',onFocus);window.removeEventListener('beforeunload',beforeUnload);root.remove();return true;}};surfaces.add(surface);return surface;
}
