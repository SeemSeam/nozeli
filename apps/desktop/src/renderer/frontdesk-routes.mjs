// A projection of controller proposals, never a separate routing queue.
function operationCaption(operation){
 const value=operation.value||operation,path=value.relPath||'项目文档';
 const saved=operation.ok!==false&&['apply','create'].includes(operation.op);
 const version=value.revision!=null?'第 '+value.revision+' 版':value.digest?'版本 '+String(value.digest).slice(0,10):value.version?'版本 '+String(value.version).slice(0,10):'';
 return [path,saved?(operation.op==='create'?'已创建并保存':'修改已保存'):'历史操作记录',version].filter(Boolean).join(' · ');
}
export function frontdeskRouteText(route){
 return ['原任务：',route.originalText||'','剩余动作：',route.remainingActions||route.reason||'','建议原因：',route.reason||'','已完成的修改 / 操作（仅作历史，不重复执行）：',...(route.completedOperations||[]).map(operationCaption),'选择只决定原请求在哪里继续，不授权扩大范围。'].join('\n');
}
export function appendFrontdeskRouteContext(container,{document,route}){
 const section=(key,label,text)=>{const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('pre');details.dataset.frontdeskContext=key;summary.textContent=label;body.textContent=text;details.append(summary,body);container.append(details);};
 section('original','原任务',route.originalText||'');section('remaining','剩余动作',route.remainingActions||route.reason||'');section('reason','建议原因',route.reason||'');
 const completed=route.completedOperations||[],summary=document.createElement('p');summary.dataset.frontdeskCompleted='';summary.textContent=completed.length?'已完成 '+completed.length+' 项修改 / 操作（保留，不重复执行）':'尚无已完成的文档修改';container.append(summary);
 for(const operation of completed.slice(0,3)){const line=document.createElement('p');line.dataset.frontdeskOperation='';line.textContent=operationCaption(operation);container.append(line);}
 if(completed.length>3)section('more-receipts','查看其余 '+(completed.length-3)+' 项已完成操作',completed.slice(3).map(operationCaption).join('\n'));
 if(completed.length)section('receipts','操作来源与完整回执（只读）',JSON.stringify(completed,null,2));
 const note=document.createElement('p');note.textContent='这是处理方式选择，不是安全授权。仅继续原范围剩余工作；已完成修改保留且不重放。暂不继续会暂停本请求，不自动重试；不会发送对话草稿，也不授予额外路径、凭据或系统权限。';container.append(note);
}
export function renderFrontdeskRoute(container,{document,route,pending=false,error='',resolve}){
 container.replaceChildren();container.dataset.frontdeskRoute=route.id;container.hidden=route.status!=='pending';
 if(container.hidden)return;
 const title=document.createElement('h3');title.textContent='处理方式决定 · 等待你的选择';container.append(title);
 appendFrontdeskRouteContext(container,{document,route});
 for(const [action,label] of [['continue','继续前台'],['background','送到后台'],['cancel','暂不继续']]){const button=document.createElement('button');button.type='button';button.className='ui-action';button.textContent=label;button.dataset.frontdeskRouteAction=action;button.disabled=pending;button.onclick=()=>{if(!button.disabled)return resolve(action);};container.append(button);}
 if(error){const message=document.createElement('p');message.setAttribute('role','alert');message.textContent=error;container.append(message);}
}
export function mountFrontdeskRoutes({document,container,invoke,refresh}){
 let state=null,projectId=null,ready=false,epoch=0;
 const pending=new Set(),settled=new Set(),errors=new Map();
 const identity=(id,route)=>JSON.stringify([id,route.id,route.version,route.sourceJobId]);
 const attention=route=>state?.todos?.find(todo=>{const d=todo.destination;return todo.status==='open'&&d?.kind==='frontdesk-route'&&d.proposalId===route.id&&d.expectedVersion===route.version&&d.sourceJobId===route.sourceJobId;});
 function paint(){
  container.replaceChildren();const routes=(state?.frontdeskRoutes||[]).filter(route=>route.status==='pending'&&!settled.has(identity(projectId,route)));container.hidden=!projectId||!routes.length;
  if(container.hidden)return;
  const source=projectId,token=epoch;
  for(const route of routes){const box=document.createElement('article'),key=identity(projectId,route),todo=attention(route);renderFrontdeskRoute(box,{document,route,pending:!ready||!todo||pending.has(key),error:errors.get(key)||(!todo?'正在核对原待办；请刷新后再决定。':''),resolve:action=>{if(source===projectId&&token===epoch)return resolve(route,action);}});container.append(box);}
 }
 async function resolve(route,action){
  const id=projectId,token=epoch,key=identity(id,route),todo=attention(route);
  if(!ready||!todo||pending.has(key)||settled.has(key)||!state?.frontdeskRoutes?.some(current=>identity(id,current)===key&&current.status==='pending'))return;
  pending.add(key);errors.delete(key);paint();
  try{
   const result=await invoke('managed.attention.respond',{projectId:id,attentionKind:'frontdesk-route',attentionId:route.id,expectedVersion:route.version,action,sourceJobId:route.sourceJobId,requestKey:'attention:'+route.id+':'+route.version+':'+action});
   if(!result.ok)throw Object.assign(Error(result.error?.message||'决定未受理；原建议保留。'),{code:result.error?.code});
   if(result.value?.accepted!==true)throw Error('宿主未确认决定；原建议保留。');
   // Both views use the ledger authority; a successful receipt stays settled even
   // when an out-of-order snapshot still contains the earlier pending proposal.
   settled.add(key);if(id===projectId&&token===epoch)paint();
   await refresh();
  }catch(error){if(id===projectId&&token===epoch){errors.set(key,(error.code?error.code+'：':'')+error.message);try{await refresh();}catch{}}}
  finally{pending.delete(key);if(id===projectId&&token===epoch)paint();}
 }
 return {render(next,id,isReady){if(projectId!==id)epoch++;state=next;projectId=id;ready=isReady;paint();},clear(){epoch++;state=null;projectId=null;ready=false;paint();}};
}
