import './review-discussion.css';
import './settings-appearance.mjs';
import {mountManagedReview} from './managed-review.mjs';
export async function mountNativeReviewDiscussion({root,scope,invoke,subscribe}) {
 root.replaceChildren();
 const surface=mountManagedReview(root,{invoke,projectId:scope.projectId,workId:scope.workId,objectId:scope.objectId,workName:scope.workName,discussionHost:true,discussionReadOnly:scope.readOnly,onOpenLatest:async()=>{await surface.save();const result=await invoke('workspace.reviewDiscussion.latest',{});if(!result.ok)throw Error(result.error?.message||'最新报告暂不可打开');}});
 subscribe('session.flush',async()=>{try{await surface.save();await surface.localWindow?.flush();return {ok:true};}catch(error){return {ok:false,composing:surface.composing,error:{code:error.code||'REVIEW_SAVE_FAILED',message:error.message}};}});
 subscribe('workspace.control',event=>{if(event.type==='review-barrier')surface.barrier(event);if(event.type==='transfer-hold')surface.barrier({...scope,held:event.held});});
 subscribe('review-discussion.command',async command=>{
  try{if(command.action==='show')await surface.show();else if(command.action==='hide')await surface.hide();else if(command.action==='bind'){await surface.bind(command.objectId);scope.objectId=command.objectId;}else throw Error('未知讨论窗口命令');
   await invoke('session.flushed',{requestId:command.requestId,ok:true});
  }catch(error){await invoke('session.flushed',{requestId:command.requestId,ok:false,error:{code:error.code||'REVIEW_WINDOW_FAILED',message:error.message}});}
 });
 await surface.ready;
 const ready=await invoke('workspace.ready',{contentReady:true});if(!ready.ok)throw Error(ready.error?.message||'讨论窗口未就绪');
 window.__nozeliReady=true;return surface;
}
