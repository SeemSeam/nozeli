
// Native runtime facts, not an emulated terminal. Opening never wakes an owner.
export function mountSessionRuntimeControls({call,current,refresh,toast=()=>{}}){
 const button=document.createElement('button');button.type='button';button.id='chat-session-runtime';button.textContent='会话管理';button.hidden=true;
 const dialog=document.createElement('dialog');dialog.className='session-runtime-dialog';dialog.setAttribute('aria-label','会话管理与只读诊断');
 const title=document.createElement('h2'),status=document.createElement('p'),facts=document.createElement('pre'),diagnostics=document.createElement('textarea'),actions=document.createElement('div');
 title.textContent='会话管理';status.setAttribute('role','status');facts.tabIndex=0;facts.setAttribute('aria-label','原生结构化状态');diagnostics.readOnly=true;diagnostics.setAttribute('aria-label','原生诊断（只读）');actions.className='session-runtime-actions';
 const note=document.createElement('p');note.textContent='压缩保留会话但改变上下文；重载刷新运行时资源，两者仅空闲时可用。停止只针对显示的当前回合，保留已完成效果与排队补充，不结束工作、不发送草稿。完整工具记录在时间线中展开阅读。';
 dialog.append(title,status,note,actions,facts,diagnostics);document.body.append(dialog);
 let ctx=null,info=null,pending=false,serial=0;const keys=new Map();
 const same=()=>ctx&&current()?.projectId===ctx.projectId&&current()?.target===ctx.target&&current()?.agent?.ownerId===ctx.agent?.ownerId;
 const make=(label,run)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>void run();actions.append(b);return b;};
 const compact=make('压缩当前上下文',()=>command('compact')),reload=make('重载运行时资源',()=>command('reload')),interrupt=make('停止当前回合',()=>command('interrupt')),read=make('刷新状态与诊断',load);
 make('查看连接与恢复操作',()=>{if(!same())return;dialog.close();window.dispatchEvent(new Event('nozeli-agent-details'));});
 make('关闭',()=>dialog.close());
 compact.dataset.sessionCommand='compact';reload.dataset.sessionCommand='reload';interrupt.dataset.sessionCommand='interrupt';
 function paint(){for(const [b,key]of [[compact,'compact'],[reload,'reload'],[interrupt,'interrupt']]){const wrongPhase=key==='interrupt'?!info?.busy||!info?.state?.jobId:info?.busy;b.disabled=pending||!same()||!info?.available||!info?.ownerId||wrongPhase||info.capabilities?.[key]!==true;b.title=wrongPhase?key==='interrupt'?'没有可中断的当前回合':'当前回合执行中，结束后可操作':!info?.available?'原会话不可用，请使用恢复操作':info?.capabilities?.[key]!==true?'此运行时不支持该操作':'';}read.disabled=pending;}
 async function load(){if(!ctx||!same())return;const captured=ctx,ticket=++serial;pending=true;status.textContent='正在读取原会话状态…';paint();try{const value=await call('session.options',{target:captured.target,...(captured.agent?.ownerId?{ownerId:captured.agent.ownerId}:{})},captured.projectId);if(ticket!==serial||!same())return;info=value;facts.textContent=JSON.stringify({target:value.target,ownerId:value.ownerId,threadId:value.threadId,...value.state},null,2);diagnostics.value=value.diagnostics||'暂无原生诊断输出。';status.textContent=value.busy?'当前回合执行中；压缩与重载需等待空闲。':value.available?'原会话状态已读取；操作不会发送输入。':'原会话不可用；请在连接与历史中恢复原会话。';}catch(error){if(ticket===serial&&same()){info=null;status.textContent='读取失败：'+error.message+'；未唤醒会话。';}}finally{if(ticket===serial){pending=false;paint();}}}
 async function command(command){
  if(pending||!same()||!info?.ownerId||info.capabilities?.[command]!==true||(command==='interrupt'?!info.busy||!info.state?.jobId:info.busy))return;
  const captured=ctx,ownerId=info.ownerId,jobId=command==='interrupt'?info.state.jobId:undefined,identity=JSON.stringify([captured.projectId,captured.target,ownerId,command,jobId]),stillCurrent=()=>ctx===captured&&same();
  if(!window.confirm(command==='interrupt'?'确认停止显示的当前回合？已完成修改保留，排队补充不取消，工作不结束。':command==='compact'?'确认压缩当前会话上下文？原记录保留，未发送草稿不会提交。':'确认重载当前运行时资源？不会重放任务或发送草稿。'))return;
  if(!same())return;
  const requestKey=keys.get(identity)||crypto.randomUUID();keys.set(identity,requestKey);pending=true;
  status.textContent='正在'+(command==='interrupt'?'停止当前回合':command==='compact'?'压缩上下文':'重载资源')+'…';paint();
  try{
   const receipt=await call('session.command',{target:captured.target,ownerId,command,requestKey,...(jobId?{jobId}:{})},captured.projectId);
   if(receipt?.accepted!==true)throw Error('宿主未确认操作');
   keys.delete(identity);if(stillCurrent()){info=null;status.textContent='操作已完成；输入草稿保持不变。请刷新状态后进行其他操作。';}
   try{await refresh?.();}catch(error){if(stillCurrent())status.textContent+=' 状态刷新失败：'+error.message+'；不会自动重发操作。';}
  }catch(error){if(stillCurrent())status.textContent='操作未完成：'+error.message+'；草稿保留。';else toast('原会话操作未完成：'+error.message);}
  finally{if(ctx===captured){pending=false;paint();}}
 }
 button.onclick=()=>{if(pending)return;ctx=current();info=null;facts.textContent='';diagnostics.value='';dialog.showModal();void load();};
 return {button,update({active,ownsConversation,projectId,history}){button.hidden=!(active&&ownsConversation&&projectId&&!history);if(dialog.open&&!same()){serial++;pending=false;info=null;status.textContent='会话归属已变化；此视图只保留原诊断，不会操作新会话。';paint();}},dispose(){serial++;button.remove();dialog.remove();keys.clear();}};
}
