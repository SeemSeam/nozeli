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

// The report owns its candidate list, unsent continuation note and two explicit
// version-bound decisions. Document workspaces remain the editing/diff surface.
export function mountManagedReview(parent,{invoke,projectId,workId,objectId,current=()=>true,confirm,onChanged=()=>{},onAvailability=()=>{},onOpenFile}){
 const root=document.createElement('section');root.className='managed-review';root.dataset.managedReview=objectId;
 const heading=document.createElement('header');heading.className='managed-review-heading';
 const title=document.createElement('h3');title.textContent='审核成果';
 const status=document.createElement('p');status.className='managed-review-status';status.dataset.reviewStatus='';status.setAttribute('role','status');
 heading.append(title,status);
 const versions=document.createElement('details');versions.className='managed-review-versions';versions.dataset.reviewVersions='';
 const versionsTitle=document.createElement('summary');versionsTitle.textContent='版本详情';const versionText=document.createElement('p');versions.append(versionsTitle,versionText);
 const warning=document.createElement('p');warning.className='managed-review-warning';warning.dataset.reviewWarning='';warning.setAttribute('role','alert');
 const outdated=document.createElement('p');outdated.className='managed-review-warning';outdated.dataset.reviewReportOutdated='';outdated.setAttribute('role','status');outdated.hidden=true;
 const filesSection=document.createElement('section');filesSection.className='managed-review-file-section';filesSection.setAttribute('aria-label','审核文件');
 const fileHeading=document.createElement('h4');fileHeading.dataset.reviewFileHeading='';
 const files=document.createElement('div');files.className='managed-review-files';files.tabIndex=-1;files.setAttribute('role','group');files.setAttribute('aria-label','成果文件；点击文件名在文档工作区查看差异');
 filesSection.append(fileHeading,files);
 const label=document.createElement('label');label.className='managed-review-instruction-label';label.textContent='需要修改时，写下交回原 Worker 的要求';
 const instruction=document.createElement('textarea');instruction.dataset.reviewInstruction='';instruction.maxLength=8000;instruction.disabled=true;instruction.setAttribute('aria-label','交回原 Worker 的修改要求');instruction.placeholder='可选；保存为本地意见，不会自动发送';
 const instructionStatus=document.createElement('p');instructionStatus.className='managed-review-instruction-status';instructionStatus.dataset.reviewInstructionStatus='';instructionStatus.setAttribute('role','status');label.append(instruction,instructionStatus);
 const actions=document.createElement('div');actions.className='managed-review-actions';
 const button=(text,key,action)=>{const node=document.createElement('button');node.type='button';node.textContent=text;node.dataset.reviewAction=key;node.onclick=()=>action().catch(fail);return node;};
 const resume=button('交回 Worker 修改','continue',()=>decide('continue'));
 const accept=button('接受并结束','accept',()=>decide('accept'));
 const retryInstruction=button('重试保存意见','retry-instruction',async()=>{if(draft){await draft.retry();return;}instructionReady=loadInstruction();await instructionReady;});retryInstruction.hidden=true;
 actions.append(resume,accept);
 root.append(heading,warning,outdated,versions,filesSection,label,actions);parent.append(root);
 const fileList=mountReviewFiles(files,{openFile,onError:fail});
 let data=null,busy=false,held=false,decisionState=null,disposed=false,composing=false,timer=null,draft=null,observing=false,observeAgain=false,readGeneration=0;
 const keys=new Map();
 const live=()=>!disposed&&current();
 async function call(method,args={}){const result=await invoke('managed.review.'+method,{projectId,workId,objectId,...args});if(!result.ok)throw Object.assign(Error(result.error?.message||'审核请求失败'),{code:result.error?.code});return result.value;}
 function fail(error){if(live()){warning.textContent=error.message+'；原报告和未发送意见仍保留。';if(!data)onAvailability(false,root);paint();}}
 function target(){return (data?.merge?.targetRef||data?.candidate?.targetRef||'工作绑定目标分支').replace(/^refs\/heads\//,'');}
 function paint(){
  const state=draft?.snapshot(),unavailable=!reviewVersionAvailable(data);
  resume.disabled=busy||held||!draft||Boolean(state?.error)||unavailable||!data?.capabilities?.canContinue;
  accept.disabled=busy||held||!draft||Boolean(state?.error)||unavailable||!data?.capabilities?.canAccept;
  instruction.disabled=(busy||held)&&!composing||!draft;
  retryInstruction.disabled=busy||held||state?.pending||composing;
  outdated.hidden=!reviewReportOutdated(data?.files||[]);outdated.textContent='人工候选已修改：原报告尚未针对这些修改重新验证。保存不会派工；可交回原 Worker 检查，或接受当前确切版本。';
  const merge=data?.merge;
  const outcome=merge?.status==='merged'?'已合入 '+target():merge?.status==='blocked'?'合入受阻：'+(merge.message||merge.blockedCode):merge?.status==='pending'||merge?.status==='queued'?'接受已记录 · 等待宿主合入 '+target():merge?.status==='merging'?'接受已记录 · 正在合入 '+target():decisionState==='accepted'||data?.accepted?'接受已记录 · 尚未确认合入成功':data?.status==='running'?'原 Worker 正在继续修改':decisionState==='continued'?'继续已记录 · 已交回原 Worker 队列':data?.continuation?.state==='blocked'?'继续修改受阻：'+(data.continuation.error?.message||'需核对执行目录'):data?.stale?'旧候选，只读 · 不可继续或接受':!data?.capabilities?.canAccept&&!data?.capabilities?.canContinue?'只读 · 当前不可继续或接受':'';
  status.textContent=held?'正在保存审核文档与意见，并核对确切版本…':!data?'正在读取冻结候选…':unavailable?'冻结候选或审核版本不可用，不能继续或接受；原报告仍保留。':`第 ${data.revision} 版${outcome?' · '+outcome:''}`;
  versions.hidden=!data;versionText.textContent=data?`审核版本：${data.reviewVersion||'不可用'}${merge?.commit?'\n合入提交：'+merge.commit:''}\n计数为输入基线与 Worker 冻结候选的差异，不含人工稿。`:'';
  root.dataset.reviewState=merge?.status||(!data?.capabilities?.canAccept&&!data?.capabilities?.canContinue?'readonly':'review');
 }
 function loadInstruction(){return call('instruction.read').then(saved=>{
  if(disposed)return;instruction.value=saved.text;
  draft=createReviewDraft({text:saved.text,revision:saved.revision,save:({text,revision})=>call('instruction.save',{text,expectedRevision:revision}),onState:state=>{showInstructionState(state.error?'意见保存失败，输入仍保留':state.pending?'正在保存意见…':state.dirty?'意见尚未保存':'意见已保存（未发送）',Boolean(state.error));if(live())paint();}});
  showInstructionState(saved.text?'已恢复未发送意见':'可选；输入后自动保存，不会自动发送');paint();
 }).catch(error=>{showInstructionState('意见读取失败：'+error.message,true);throw error;});}
 function showInstructionState(message,canRetry=false){const text=document.createElement('span');text.textContent=message;instructionStatus.replaceChildren(text);if(canRetry)instructionStatus.append(retryInstruction);retryInstruction.hidden=!canRetry;}
 let instructionReady=loadInstruction();void instructionReady.catch(fail);
 instruction.addEventListener('compositionstart',()=>{composing=true;});instruction.addEventListener('compositionend',()=>{composing=false;});
 instruction.addEventListener('input',()=>{draft?.setText(instruction.value);clearTimeout(timer);timer=setTimeout(()=>void saveAll().catch(fail),600);});
 async function saveAll(){
  try{await instructionReady;}catch(error){if(draft||instruction.value)throw error;}
  if(composing)throw Object.assign(Error('修改意见输入法组合尚未结束。'),{code:'COMPOSING'});
  clearTimeout(timer);if(draft)await draft.flush();
 }
 async function openFile(file){
  await saveAll();
  if(onOpenFile)return onOpenFile(file);
  const result=await invoke('workspace.control',{type:'open-file',projectId,relPath:file.relPath,documentSource:{type:'review',workId,objectId}});
  if(!result.ok)throw Error(result.error?.message||'审核文档打开失败');
 }
 async function refresh(){
  const request=++readGeneration,next=await call('read');if(!live()||request!==readGeneration)return;data=next;
  warning.textContent=[reviewStaleMessage(data.stale),...(data.capabilities?.reasons||[]).map(reason=>typeof reason.message==='string'?reason.message:'审核条件尚不满足')].filter(Boolean).join('\n');
  const fileCount=data.files?.length||0;fileHeading.textContent=`成果文件${fileCount?' · '+fileCount:''}`;filesSection.hidden=!fileCount;fileList.update(data.files||[]);
  onAvailability(Boolean(fileCount),root);
  paint();
 }
 async function decide(action){
  if(busy||held||!reviewVersionAvailable(data))return;busy=true;paint();
  try{
   await saveAll();
   const reviewed=data.reviewVersion;
   const message=action==='accept'?`接受审核版本 ${reviewed} 的确切内容。${reviewReportOutdated(data.files||[])?'人工修改尚未经原 Worker 重新验证。':''}宿主将安全合入 ${target()}；原用户授权和确切审核版本会被保留，遇到新的并发变化则展示差异供明确决定。`:`本次不接受审核版本 ${reviewed}；将已保存人工稿和修改要求交回原 Worker，保留同任务、线程和发布历史，不丢弃成果或结束工作。`;
   if(!await confirm(message,action==='accept'?'接受确切审核版本':'继续原 Worker')||!live())return;
   const key=action+':'+reviewed,requestKey=keys.get(key)||crypto.randomUUID();keys.set(key,requestKey);
   const response=await invoke('workspace.review.decide',{projectId,workId,objectId,action,reviewVersion:reviewed,requestKey,...(action==='continue'?{instruction:instruction.value}:{})});
   if(!response.ok){
    if(response.error?.code==='REVIEW_TOKEN_CHANGED'){
     await refresh();throw Object.assign(Error('跨文档保存后审核版本已变化。已显示最新状态，请重新核对文档并再次确认；本次未继续或接受。'),{code:'REVIEW_TOKEN_CHANGED'});
    }
    throw Object.assign(Error(response.error?.message||'审核决定未完成'),{code:response.error?.code});
   }
   keys.delete(key);decisionState=action==='continue'?'continued':'accepted';
   if(!live())return;data={...data,...response.value,accepted:data.accepted,capabilities:{canContinue:false,canAccept:false},...(action==='continue'?{status:'queued',stale:{code:'SUPERSEDED'}}:{status:'ended'})};await onChanged();
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
 const surface={root,ready,save:saveAll,observe,refresh,get composing(){return composing;},barrier(event){if(event.projectId!==projectId||event.workId!==workId||event.objectId!==objectId)return;held=event.held===true;paint();},get retained(){return busy||held||composing||draft?.snapshot().dirty||draft?.snapshot().pending;},destroy(){if(surface.retained)return false;disposed=true;clearTimeout(timer);fileList.destroy();surfaces.delete(surface);window.removeEventListener('focus',onFocus);window.removeEventListener('beforeunload',beforeUnload);root.remove();return true;}};surfaces.add(surface);return surface;
}
