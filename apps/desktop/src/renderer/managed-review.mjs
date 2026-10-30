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

// The report owns decisions and unsent instructions only. Candidate files open
// in the ordinary document workspace, whose editor owns editing and undo.
export function mountManagedReview(parent,{invoke,projectId,workId,objectId,current=()=>true,confirm,onChanged=()=>{},onAvailability=()=>{},onOpenFile}){
 const root=document.createElement('section');root.className='managed-review';root.dataset.managedReview=objectId;
 const title=document.createElement('h3');title.textContent='成果审核';
 const status=document.createElement('p');status.className='managed-review-status';status.dataset.reviewStatus='';status.setAttribute('role','status');
 const versions=document.createElement('details');versions.className='managed-review-versions';versions.dataset.reviewVersions='';
 const versionsTitle=document.createElement('summary');versionsTitle.textContent='版本凭据';const versionText=document.createElement('p');versions.append(versionsTitle,versionText);
 const warning=document.createElement('p');warning.className='managed-review-warning';warning.dataset.reviewWarning='';warning.setAttribute('role','alert');
 const outdated=document.createElement('p');outdated.className='managed-review-warning';outdated.dataset.reviewReportOutdated='';outdated.setAttribute('role','status');outdated.hidden=true;
 const files=document.createElement('div');files.className='managed-review-files';files.tabIndex=-1;files.setAttribute('role','group');files.setAttribute('aria-label','成果文件；点击文件名在文档工作区查看差异');
 const fileDisclosure=document.createElement('details');fileDisclosure.className='managed-review-file-disclosure';
 const fileSummary=document.createElement('summary');fileSummary.textContent='审核文件';fileDisclosure.append(fileSummary,files);
 let fileDisclosureInitialized=false;
 const label=document.createElement('label');label.textContent='给原 Worker 的继续修改要求（保存不发送）';
 const instruction=document.createElement('textarea');instruction.dataset.reviewInstruction='';instruction.maxLength=8000;instruction.disabled=true;instruction.setAttribute('aria-label','给原 Worker 的继续修改要求');
 const instructionStatus=document.createElement('p');instructionStatus.dataset.reviewInstructionStatus='';instructionStatus.setAttribute('role','status');label.append(instruction,instructionStatus);
 const actions=document.createElement('div');actions.className='managed-review-actions';
 const button=(text,key,action)=>{const node=document.createElement('button');node.type='button';node.textContent=text;node.dataset.reviewAction=key;node.onclick=()=>action().catch(fail);return node;};
 const save=button('保存修改意见','save',async()=>{if(draft?.snapshot().error)await draft.retry();await saveAll();});
 const resume=button('拒绝此版并交原 Worker 修改…','continue',()=>decide('continue'));
 const accept=button('接受此审核版本…','accept',()=>decide('accept'));
 const reload=button('刷新审核状态','refresh',refresh);
 const recover=button('重新读取已保存意见…','recover-instruction',async()=>{if(composing||draft?.snapshot().pending)return;if(!await confirm('将用宿主已保存意见替换本窗口意见。未保存内容请先复制保留；不会发送给 Worker。','恢复已保存意见'))return;instructionReady=loadInstruction();await instructionReady;paint();});
 actions.append(save,resume,accept,reload,recover);root.append(title,status,versions,warning,outdated,fileDisclosure,label,actions);parent.append(root);
 const fileList=mountReviewFiles(files,{openFile,onError:fail});
 let data=null,busy=false,held=false,decisionState=null,disposed=false,composing=false,timer=null,draft=null,observing=false,observeAgain=false,readGeneration=0;
 const keys=new Map();
 const live=()=>!disposed&&current();
 async function call(method,args={}){const result=await invoke('managed.review.'+method,{projectId,workId,objectId,...args});if(!result.ok)throw Object.assign(Error(result.error?.message||'审核请求失败'),{code:result.error?.code});return result.value;}
 function fail(error){if(live()){warning.textContent=error.message+'；原报告和未发送意见仍保留。';if(!data)onAvailability(false,root);paint();}}
 function target(){return (data?.merge?.targetRef||data?.candidate?.targetRef||'工作绑定目标分支').replace(/^refs\/heads\//,'');}
 function paint(){
  const state=draft?.snapshot(),unavailable=!reviewVersionAvailable(data);
  save.disabled=busy||held||state?.pending||!state?.dirty;
  resume.disabled=busy||held||!draft||Boolean(state?.error)||unavailable||!data?.capabilities?.canContinue;
  accept.disabled=busy||held||!draft||Boolean(state?.error)||unavailable||!data?.capabilities?.canAccept;
  reload.disabled=busy||held;recover.disabled=busy||held||state?.pending||composing;instruction.disabled=(busy||held)&&!composing||!draft;
  outdated.hidden=!reviewReportOutdated(data?.files||[]);outdated.textContent='人工候选已修改：原报告解释的是 Worker 发布时的旧内容，尚未针对这些人工修改重新验证。保存文档不会派工；可交回原 Worker 检查，也可直接接受确切审核版本。';
  const merge=data?.merge;
  const outcome=merge?.status==='merged'?'已合入 '+target():merge?.status==='blocked'?'合入受阻：'+(merge.message||merge.blockedCode):merge?.status==='pending'||merge?.status==='queued'?'接受已记录 · 等待宿主合入 '+target():merge?.status==='merging'?'接受已记录 · 正在合入 '+target():decisionState==='accepted'||data?.accepted?'接受已记录 · 尚未确认合入成功':data?.status==='running'?'原 Worker 正在继续修改':decisionState==='continued'?'继续已记录 · 已交回原 Worker 队列':data?.continuation?.state==='blocked'?'继续修改受阻：'+(data.continuation.error?.message||'需核对执行目录'):data?.stale?'旧候选，只读 · 不可继续或接受':!data?.capabilities?.canAccept&&!data?.capabilities?.canContinue?'只读 · 当前不可继续或接受':'点击文件名，在文档工作区查看差异与编辑';
  status.textContent=held?'正在等待所有审核文档和意见持久化，并核对确切审核版本…':!data?'正在读取冻结候选…':unavailable?'冻结候选或审核版本不可用，不能继续或接受；原报告仍保留。':`第 ${data.revision} 版 · ${data.files?.length||0} 个文件 · ${outcome}`;
  versions.hidden=!data;versionText.textContent=data?`审核版本：${data.reviewVersion||'不可用'}${merge?.commit?'\n合入提交：'+merge.commit:''}\n列表计数：输入基线 → Worker 冻结候选（不含人工稿）。请在文档工作区查看差异；审核决定仍以确切审核版本为准。`:'';
  root.dataset.reviewState=merge?.status||(!data?.capabilities?.canAccept&&!data?.capabilities?.canContinue?'readonly':'review');
 }
 function loadInstruction(){return call('instruction.read').then(saved=>{
  if(disposed)return;instruction.value=saved.text;
  draft=createReviewDraft({text:saved.text,revision:saved.revision,save:({text,revision})=>call('instruction.save',{text,expectedRevision:revision}),onState:state=>{instructionStatus.textContent=state.error?'意见保存失败，输入仍保留：'+state.error.message:state.pending?'正在保存修改意见…':state.dirty?'修改意见尚未保存':'修改意见已保存（未发送）';if(live())paint();}});
  instructionStatus.textContent='修改意见已恢复（未发送）';paint();
 }).catch(error=>{instructionStatus.textContent='修改意见读取失败：'+error.message;throw error;});}
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
  fileList.update(data.files||[]);
  const fileCount=data.files?.length||0;fileSummary.textContent=`审核文件（${fileCount}）`;
  if(!fileDisclosureInitialized){fileDisclosure.open=fileCount<=8;fileDisclosureInitialized=true;}
  onAvailability(Boolean(data.files?.length),root);
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
