// Main conversation is frontdesk-only. Old recipient drafts stay source-bound.
export function conversationTargetReason(_state,target){
 if(target==='frontdesk')return '';
 if(typeof target!=='string'||!target)return '正在核对前台输入归属，原草稿保持。';
 return '主对话只使用前台；原后台目标的草稿已保留，不会改发。';
}
export function resolveConversationInput({projectId,frame={},state,local}){
 const identity=frame.conversationInput,viewText=typeof frame.workspace?.draft==='string'?frame.workspace.draft:'';
 const looseMaterials=frame.composerMaterials;
 const sameFront=identity?.projectId===projectId&&identity.target==='frontdesk';
 const originalTarget=typeof identity?.target==='string'?identity.target:null;
 const originalMaterials=identity?frame.conversationMaterials?.[originalTarget]??looseMaterials:looseMaterials;
 const durable=state?.drafts;
 const canonical=local!==undefined?local:durable&&Object.hasOwn(durable,'frontdesk')?durable.frontdesk:sameFront?viewText:'';
 const text=canonical??'',materials=identity?.projectId===projectId?frame.conversationMaterials?.frontdesk??(sameFront?looseMaterials:undefined):undefined;
 let retained=null;
 if(!sameFront&&(viewText||originalMaterials?.pending?.length||originalMaterials?.quote))retained={projectId:identity?.projectId??null,target:originalTarget,text:viewText,materials:originalMaterials,reason:identity?.projectId===projectId?'原后台会话草稿单独保留，主对话已回到前台；未转发、未执行。':'原稿来源尚未核实，已单独保留，未移入当前前台。'};
 else if(sameFront&&viewText&&viewText!==text)retained={projectId,target:'frontdesk',text:viewText,materials,reason:'窗口保留稿与当前前台草稿不同，未覆盖已保存稿。'};
 return {target:'frontdesk',text,materials,reason:'',retained};
}
