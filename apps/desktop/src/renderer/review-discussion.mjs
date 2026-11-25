import './review-discussion.css';
import './settings-appearance.mjs';
import {mountManagedReview} from './managed-review.mjs';
export async function mountNativeReviewDiscussion({root,scope,invoke,subscribe}) {
 root.replaceChildren();
 const confirm=(message,title,{cancelLabel='取消',confirmLabel='确认'}={})=>new Promise(resolve=>{
  const trigger=document.activeElement,dialog=document.createElement('dialog');dialog.className='managed-review-detail';dialog.dataset.reviewDraftConfirmation='';
  const heading=document.createElement('h3'),text=document.createElement('p'),cancel=document.createElement('button'),accept=document.createElement('button');heading.textContent=title;text.textContent=message;text.style.whiteSpace='pre-wrap';cancel.textContent=cancelLabel;accept.textContent=confirmLabel;cancel.type=accept.type='button';
  const finish=value=>{dialog.remove();trigger?.focus({preventScroll:true});resolve(value);};cancel.onclick=()=>finish(false);accept.onclick=()=>finish(true);dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});dialog.append(heading,text,cancel,accept);root.append(dialog);dialog.showModal();cancel.focus();
 });
 const errorPayload=(error,fallback)=>({code:error.code||fallback,message:error.message});
 try{
  const surface=mountManagedReview(root,{invoke,projectId:scope.projectId,workId:scope.workId,sourceJobId:scope.sourceJobId,objectId:scope.objectId,workName:scope.workName,confirm,discussionHost:true,earlyDiscussion:true,discussionReadOnly:scope.readOnly,workMode:scope.workMode===true,onOpenLatest:async()=>{await surface.save();const result=await invoke('workspace.reviewDiscussion.latest',{});if(!result.ok)throw Error(result.error?.message||'最新报告暂不可打开');}});
  subscribe('session.flush',async()=>{try{await surface.save();await surface.localWindow?.flush();return {ok:true};}catch(error){return {ok:false,composing:surface.composing,error:errorPayload(error,'REVIEW_SAVE_FAILED')};}});
  subscribe('workspace.control',event=>{if(event.type==='review-barrier')surface.barrier(event);if(event.type==='transfer-hold')surface.barrier({...scope,held:event.held});});
  let commands=Promise.resolve();
  subscribe('review-discussion.command',command=>{
   const run=commands.catch(()=>{}).then(async()=>{
    let receipt;
    try{
     await surface.ready;
     if(command.action==='bind'){
      if(command.objectId!==scope.objectId){await surface.bind(command.objectId);scope.objectId=command.objectId;}
     }else if(command.action==='show'){
      if(command.objectId!==scope.objectId)throw Object.assign(Error('讨论窗口报告版本已变化'),{code:'REVIEW_BINDING_STALE'});
      await surface.show({locatePublication:command.locatePublication===true});
     }else if(command.action==='hide')await surface.hide();
     else throw Error('未知讨论窗口命令');
     receipt={ok:true};
    }catch(error){receipt={ok:false,error:errorPayload(error,'REVIEW_WINDOW_FAILED')};}
    await invoke('session.flushed',{requestId:command.requestId,...receipt});
   });
   commands=run;return run;
  });
  await surface.ready;
  const ready=await invoke('workspace.ready',{contentReady:true});
  if(!ready.ok)throw Object.assign(Error(ready.error?.message||'讨论窗口未就绪'),{code:ready.error?.code});
  window.__nozeliReady=true;return surface;
 }catch(error){
  await invoke('workspace.ready',{contentFailed:true,error:errorPayload(error,'REVIEW_INIT_FAILED')}).catch(()=>{});
  throw error;
 }
}
