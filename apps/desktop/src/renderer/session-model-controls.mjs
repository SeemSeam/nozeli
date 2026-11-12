import {statusLine,disclosure,roleLabel} from './management-presentation.mjs';
// Only the read-only DTO is rendered; never stringify runtime/provider payloads here.
function renderContextDetails(root,value){
 root.replaceChildren();
 const add=(tag,text,parent=root)=>{const node=document.createElement(tag);node.textContent=text;parent.append(node);return node;};
 const text=value=>value===null||value===undefined?'未提供':String(value);
 const fields=entries=>{const list=document.createElement('dl');for(const [label,value]of entries){add('dt',label,list);add('dd',text(value),list);}root.append(list);};
 const bytes=value=>Number.isFinite(value)?`${value} 字节`:'未计量';
 const chars=value=>Number.isFinite(value)?`${value} 字符`:'未计量';
 const body=(label,value)=>{add('h3',label);if(typeof value==='string'){const pre=add('pre',value);pre.tabIndex=0;pre.setAttribute('aria-label',label);}else add('p','无可读取正文；以下元数据不代表完整内容。');};
 add('p','本地只读快照 · 展开或关闭不调用模型、不上传内容。准备内容、原生请求捕获与 provider 回执不是同一种证据。');
 if(!value){add('p','暂无上下文交付元数据；不能据此判断模型已收到内容。');return;}
 fields([['快照时间',value.generatedAt],['会话',value.session?.threadId],['归属',value.session?.ownerId],['上下文代次',value.session?.contextEpoch]]);
 const request=value.lastRequest;
 if(!request)add('p','暂无本会话的最近请求记录。');
 else{
  add('h3','最近一次请求');
  const evidence=request.evidence,stages={'prepared':'已准备（未证明提交）','submitted':'已提交（未证明准入）','native-admitted':'原生已准入（未证明精确记录）','native-record-confirmed':'原生条目已确认记录','settled':'回合已结束（不等于 provider 已收到）','unknown':'未知，需对账'};
  fields([['请求',request.jobId],['类型',request.type],['时间',request.at],['回合结果',request.status],['交付阶段',stages[evidence?.stage]||'未知，需对账'],['原生条目',evidence?.nativeEntry?.id],['条目摘要',evidence?.nativeEntry?.contentDigest],['证据说明',evidence?.note]]);
  add('h3','三层证据');
  fields([['宿主准备', '下方原文与来源是本地准备记录，不标为“模型实际看到”'],['原生请求捕获',evidence?.nativeContext?.captured===true?'已有本地 native context hook 捕获；不代表 provider 收到':'未提供捕获证据；原生条目记录不能替代最终请求视图'],['捕获说明',evidence?.nativeContext?.note],['Provider 回执',evidence?.providerObserved===true?'已有 provider 回执；不证明理解或当前上下文仍可见':'未确认收到；不能从回合成功、失败或网络到达推断']]);
  body('用户原文（已有本地记录）',request.userText?.exact);
  fields([['原文字数',chars(request.userText?.chars)],['原文摘要',request.userText?.digest]]);
  add('h3','显式材料来源');
  if(!request.materials?.length)add('p','未记录显式材料；不表示原生历史中没有材料。');
  for(const source of request.materials||[])fields([['来源',source.relPath],['位置',source.locationLabel],['类型',source.kind],['版本',source.version],['摘要',source.digest],['交付模式',({full:'全文准备',brief:'简要准备',none:'未交付'})[source.mode]||'未知'],['版本变化',source.changed===true?'已变化':source.changed===false?'未标记变化':'未知'],['用户备注',source.notePresent===true?'有（未在此复制正文）':source.notePresent===false?'无':'未知']]);
  add('h3','宿主新增内容');
  fields([['新增总量',chars(request.hostAdded?.chars)]]);
  for(const section of request.hostAdded?.sections||[])fields([['来源类别',({'user-text':'用户原文','explicit-material':'显式材料','explicit-handoff':'显式交接','data-projection':'宿主事实投影'})[section.origin]||section.origin],['内容量',chars(section.chars)]]);
  const projection=request.projection;
  if(projection){body('宿主投影（准备内容）',projection.exact);fields([['投影名称',projection.label],['投影版本',projection.version],['投影大小',bytes(projection.bytes)],['每请求上限',bytes(projection.perRequestLimitBytes)]]);}
  else add('p','未记录宿主投影；不据此推断历史请求。');
  add('h3','省略与完整性');
  if(!request.omissions?.length)add('p','未记录省略原因；不等于材料已完整交付或通读。');
  for(const omission of request.omissions||[])fields([['省略原因',omission.reason],['省略量',chars(omission.chars)]]);
 }
 add('h3','预算（字节不等于 token）');
 fields([['本 run 已用 / 上限',`${bytes(value.budget?.run?.usedBytes)} / ${bytes(value.budget?.run?.limitBytes)}`],['压缩代次已用 / 上限',`${bytes(value.budget?.epoch?.usedBytes)} / ${bytes(value.budget?.epoch?.limitBytes)}`],['预算代次',value.budget?.epoch?.contextEpoch],['回执预留',bytes(value.budget?.receiptReserveBytes)]]);
 add('h3','版本化来源与按需读取');
 for(const source of value.provenance?.sources||[])fields([['来源身份',source.identity],['类型',source.kind],['版本',source.version],['摘要',source.digest]]);
 for(const source of value.provenance?.toolReads||[])fields([['读取来源',source.source],['版本',source.version],['起始位置',source.offset],['读取量',chars(source.chars)]]);
 add('p','Pi 管理原生历史与压缩。旧交付记录不证明压缩后仍可见；此处不会解密或改写 provider 私有条目。');
 add('h3','本地失败分类（不回灌业务输入）');
 if(!value.diagnostics?.providerFailures?.length)add('p','暂无已分类失败记录。');
 for(const failure of value.diagnostics?.providerFailures||[])fields([['错误代码',failure.code],['分类',failure.category],['次数',failure.count],['最近时间',failure.lastAt]]);
}

// Native runtime facts, not an emulated terminal. Opening never wakes an owner.
export function mountSessionRuntimeControls({call,current,refresh,toast=()=>{}}){
 const button=document.createElement('button');button.type='button';button.id='chat-session-runtime';button.textContent='会话管理';button.hidden=true;
 const dialog=document.createElement('dialog');dialog.className='session-runtime-dialog';dialog.setAttribute('aria-label','会话管理与只读诊断');
 const title=document.createElement('h2'),status=document.createElement('p'),facts=document.createElement('pre'),diagnostics=document.createElement('textarea'),actions=document.createElement('div');
 title.textContent='会话管理';status.setAttribute('role','status');facts.tabIndex=0;facts.setAttribute('aria-label','原生结构化状态');diagnostics.readOnly=true;diagnostics.setAttribute('aria-label','原生诊断（只读）');actions.className='session-runtime-actions';
 const unavailable=document.createElement('p'),sessionLine=statusLine({key:'session',subject:'会话状态',state:{label:'正在读取'},notices:[]});unavailable.className='session-runtime-unavailable';
 const contextDetails=document.createElement('details'),contextSummary=document.createElement('summary'),contextBody=document.createElement('div');
 contextDetails.className='session-context-details';contextSummary.textContent='上下文详情';contextBody.className='session-context-body';contextDetails.append(contextSummary,contextBody);
 contextDetails.addEventListener('toggle',()=>{if(contextDetails.open)renderContextDetails(contextBody,info?.contextDetails);});
 const technical=disclosure({key:'session-diagnostics',label:'技术诊断',content:[facts,diagnostics]});technical.addEventListener('toggle',()=>{if(technical.open)paintDiagnostics();});
 const body=document.createElement('div');body.className='session-runtime-body';body.append(title,sessionLine.node,status,unavailable,contextDetails,technical);dialog.append(body,actions);document.body.append(dialog);
 let ctx=null,info=null,pending=false,serial=0;const keys=new Map();
 const same=()=>ctx&&current()?.projectId===ctx.projectId&&current()?.target===ctx.target&&current()?.agent?.ownerId===ctx.agent?.ownerId;
 const make=(label,run)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>void run();actions.append(b);return b;};
 const compact=make('压缩上下文',()=>command('compact')),reload=make('重新加载资源',()=>command('reload')),interrupt=make('停止当前回合',()=>command('interrupt')),read=make('刷新',load);
 make('连接与历史',()=>{if(!same())return;dialog.close();window.dispatchEvent(new Event('nozeli-agent-details'));});
 make('关闭',()=>dialog.close());
 compact.dataset.sessionCommand='compact';reload.dataset.sessionCommand='reload';interrupt.dataset.sessionCommand='interrupt';
 function paintDiagnostics(){if(!technical.open||!info)return;facts.textContent=JSON.stringify({target:info.target,ownerId:info.ownerId,threadId:info.threadId,capabilities:info.capabilities,...info.state},null,2);const value=info.diagnostics||'暂无原生诊断输出。';if(diagnostics.value!==value){const start=diagnostics.selectionStart,end=diagnostics.selectionEnd,scroll=diagnostics.scrollTop;diagnostics.value=value;diagnostics.setSelectionRange(start,end);diagnostics.scrollTop=scroll;}}
 function paint(){for(const [b,key]of [[compact,'compact'],[reload,'reload'],[interrupt,'interrupt']]){const wrongPhase=key==='interrupt'?!info?.busy||!info?.state?.jobId:info?.busy;b.hidden=info?.capabilities?.[key]!==true||(key==='interrupt'&&!info?.busy);b.disabled=pending||!same()||!info?.available||!info?.ownerId||wrongPhase||info.capabilities?.[key]!==true;b.title=wrongPhase?key==='interrupt'?'没有可中断的当前回合':'当前回合结束后可用':!info?.available?'原会话不可用，请使用连接与历史':'';}unavailable.textContent=info?.busy?'压缩与重新加载：当前回合结束后可用。':info&&!info.available?'原会话不可用，请查看连接与历史。':'';unavailable.hidden=!unavailable.textContent;read.disabled=pending;sessionLine.update({subject:roleLabel(ctx?.agent?.role??(ctx?.target==='frontdesk'?'frontdesk':ctx?.target==='orchestrator'?'orchestrator':'worker')),state:{label:!same()?'会话已变化':info?.busy?'处理中':info?.available?'待命':'状态待核实'},secondary:info?.state?.model?.id??info?.state?.model??''});}
 async function load(){
  if(!ctx||!same())return;
  const captured=ctx,ticket=++serial;pending=true;status.textContent='正在读取原会话状态…';paint();
  try{
   const value=await call('session.options',{target:captured.target,...(captured.agent?.ownerId?{ownerId:captured.agent.ownerId}:{})},captured.projectId);
   if(ticket!==serial||!same())return;
   info=value;paintDiagnostics();if(contextDetails.open&&!contextBody.childNodes.length)renderContextDetails(contextBody,value.contextDetails);
   status.textContent='';
  }catch(error){if(ticket===serial&&same()){info=null;contextBody.replaceChildren();status.textContent='读取失败：'+error.message+'；未唤醒会话。';}}
  finally{if(ticket===serial){pending=false;paint();}}
 }
 async function command(command){
  if(pending||!same()||!info?.ownerId||info.capabilities?.[command]!==true||(command==='interrupt'?!info.busy||!info.state?.jobId:info.busy))return;
  const captured=ctx,ownerId=info.ownerId,jobId=command==='interrupt'?info.state.jobId:undefined,identity=JSON.stringify([captured.projectId,captured.target,ownerId,command,jobId]),stillCurrent=()=>ctx===captured&&same();
  if(!window.confirm(command==='interrupt'?'停止当前回合？已完成修改保留；排队输入不取消，任务不结束。':command==='compact'?'压缩当前上下文？原记录保留，未发送草稿不会提交。':'重新加载此会话资源？不会重放任务或发送草稿。'))return;
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
 button.onclick=()=>{if(pending)return;ctx=current();info=null;title.textContent='会话管理 · '+roleLabel(ctx?.agent?.role??(ctx?.target==='frontdesk'?'frontdesk':ctx?.target==='orchestrator'?'orchestrator':'worker'));facts.textContent='';diagnostics.value='';technical.open=false;contextDetails.open=false;contextBody.replaceChildren();dialog.showModal();void load();};
 return {button,update({active,ownsConversation,projectId,history}){button.hidden=!(active&&ownsConversation&&projectId&&!history);if(dialog.open&&!same()){serial++;pending=false;info=null;contextDetails.open=false;contextBody.replaceChildren();status.textContent='会话归属已变化；此视图只保留原诊断，不会操作新会话。';paint();}},dispose(){serial++;button.remove();dialog.remove();keys.clear();}};
}
