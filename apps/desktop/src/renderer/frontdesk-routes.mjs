// A projection of controller proposals, never a separate routing queue.
function operationCaption(operation){
 const value=operation.value||operation,path=value.relPath||'项目文档';
 const saved=operation.ok===true&&['apply','create'].includes(operation.op);
 const version=value.revision!=null?'第 '+value.revision+' 版':value.digest?'版本 '+String(value.digest).slice(0,10):value.version?'版本 '+String(value.version).slice(0,10):'';
 return [path,saved?(operation.op==='create'?'已创建并保存':'修改已保存'):'历史操作记录',version].filter(Boolean).join(' · ');
}
export function frontdeskRouteText(route){
 return ['原始输入：',route.originalText||'','建议后台的原因：',route.reason||'','已完成的修改 / 操作（仅作历史，不重复执行）：',...(route.completedOperations||[]).map(operationCaption),'选择只决定原请求在哪里继续，不授权扩大范围。'].join('\n');
}
export function renderFrontdeskRoute(container,{document,route,pending=false,error='',resolve}){
 container.replaceChildren();container.dataset.frontdeskRoute=route.id;container.hidden=route.status!=='pending';
 if(container.hidden)return;
 const title=document.createElement('h3');title.textContent='前台建议转到后台 · 等待你的选择';container.append(title);
 for(const [action,label] of [['continue','继续在前台'],['background','送到后台']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.frontdeskRouteAction=action;button.disabled=pending;button.onclick=()=>resolve(action);container.append(button);}
 const section=(label,text)=>{const details=document.createElement('details'),summary=document.createElement('summary'),body=document.createElement('pre');summary.textContent=label;body.textContent=text;details.append(summary,body);container.append(details);};
 section('原始输入',route.originalText||'');section('建议原因',route.reason||'');
 const completed=route.completedOperations||[],summary=document.createElement('p');summary.dataset.frontdeskCompleted='';summary.textContent=completed.length?'已完成 '+completed.length+' 项修改 / 操作（保留，不重复执行）':'尚无已完成的文档修改';container.append(summary);
 for(const operation of completed.slice(0,3)){const line=document.createElement('p');line.dataset.frontdeskOperation='';line.textContent=operationCaption(operation);container.append(line);}
 if(completed.length>3)section('查看其余 '+(completed.length-3)+' 项已完成操作',completed.slice(3).map(operationCaption).join('\n'));
 if(completed.length)section('操作来源与完整回执（只读）',JSON.stringify(completed,null,2));
 const note=document.createElement('p');note.textContent='只选择原请求在前台继续或送到后台；不授权扩大范围。已完成的修改保留，不会因为选择前台而撤销。';container.append(note);
 if(error){const message=document.createElement('p');message.setAttribute('role','alert');message.textContent=error;container.append(message);}
}
export function mountFrontdeskRoutes({document,container,invoke,refresh,randomKey=()=>crypto.randomUUID()}){
 let state=null,projectId=null,ready=false,epoch=0;
 const pending=new Set(),keys=new Map(),errors=new Map();
 const identity=(id,route)=>JSON.stringify([id,route.id,route.version]);
 function paint(){
  container.replaceChildren();const routes=(state?.frontdeskRoutes||[]).filter(route=>route.status==='pending');container.hidden=!projectId||!routes.length;
  if(container.hidden)return;
  const source=projectId,token=epoch;
  for(const route of routes){const box=document.createElement('article'),key=identity(projectId,route);renderFrontdeskRoute(box,{document,route,pending:!ready||pending.has(key),error:errors.get(key)||'',resolve:action=>{if(source===projectId&&token===epoch)return resolve(route,action);}});container.append(box);}
 }
 async function resolve(route,action){
  const id=projectId,token=epoch,key=identity(id,route);
  if(!ready||pending.has(key)||!state?.frontdeskRoutes?.some(current=>current.id===route.id&&current.version===route.version&&current.status==='pending'))return;
  const requestIdentity=JSON.stringify([key,action]),requestKey=keys.get(requestIdentity)||randomKey();keys.set(requestIdentity,requestKey);pending.add(key);errors.delete(key);paint();
  try{
   const result=await invoke('managed.frontdesk.route.resolve',{projectId:id,proposalId:route.id,expectedVersion:route.version,action,requestKey});
   if(!result.ok)throw Object.assign(Error(result.error?.message||'决定未受理；原建议保留。'),{code:result.error?.code});
   if(result.value?.accepted!==true)throw Error('宿主未确认决定；原建议保留。');
   // A persisted receipt wins even if the subsequent snapshot refresh fails.
   if(id===projectId&&token===epoch){state={...state,frontdeskRoutes:state.frontdeskRoutes.filter(current=>current.id!==route.id||current.version!==route.version)};paint();}
   await refresh();keys.delete(requestIdentity);
  }catch(error){if(id===projectId&&token===epoch){errors.set(key,(error.code?error.code+'：':'')+error.message);try{await refresh();}catch{}}}
  finally{pending.delete(key);if(id===projectId&&token===epoch)paint();}
 }
 return {render(next,id,isReady){if(projectId!==id)epoch++;state=next;projectId=id;ready=isReady;paint();},clear(){epoch++;state=null;projectId=null;ready=false;paint();}};
}
