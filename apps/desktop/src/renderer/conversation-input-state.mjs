// The view remembers input identity; the existing managed draft store owns text.
export function conversationTargetReason(state,target){
 if(target==='frontdesk'||target==='orchestrator')return '';
 if(typeof target!=='string'||!target)return '草稿缺少可核实的接收目标，已保留，不能发送。';
 const work=state?.works?.find(w=>w.id===target);
 if(!work)return '原工作已不存在；草稿仍保留，不能改发给前台。';
 if(['ended','closing'].includes(work.status))return '原工作已结束；草稿仍保留，不会自动转给前台。';
 if(work.readOnly)return '原工作只读；草稿仍保留，不能发送。';
 return '';
}
export function resolveConversationInput({projectId,frame={},state,local}){
 const identity=frame.conversationInput,viewText=typeof frame.workspace?.draft==='string'?frame.workspace.draft:'';
 const looseMaterials=frame.composerMaterials;
 const hasMaterials=!!(looseMaterials?.pending?.length||looseMaterials?.quote);
 if(!identity&&(viewText||hasMaterials))return {target:null,text:viewText,materials:looseMaterials,reason:'旧窗口草稿缺少目标身份，已隔离保留；请明确选择接收者，原稿不会自动搬运。'};
 const target=identity?.target??'frontdesk';
 if(identity&&(identity.projectId!==projectId||typeof identity.target!=='string'||!identity.target))return {target:identity.target??null,text:viewText,materials:looseMaterials,reason:'草稿来源项目或目标无法核实，已隔离保留，不能发送。'};
 const reason=conversationTargetReason(state,target);
 const material=identity?frame.conversationMaterials?.[target]??looseMaterials:undefined;
 if(reason)return {target,text:viewText||state?.drafts?.[target]||'',materials:material,reason};
 const durable=state?.drafts;
 const text=local!==undefined?local:durable&&Object.hasOwn(durable,target)?durable[target]:viewText;
 return {target,text:text??'',materials:material,reason:'',retained:identity&&viewText&&viewText!==text?{projectId,target,text:viewText,materials:material,reason:'窗口保留稿与当前目标草稿不同，未覆盖当前已保存稿。'}:null};
}
