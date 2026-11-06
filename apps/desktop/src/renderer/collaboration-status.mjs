import './management-presentation.css';
import './collaboration-status.css';
import {statusLine,disclosure,roleLabel} from './management-presentation.mjs';
import {STATUS_REFRESH_MS,STATUS_STALE_MS,snapshotStale,timingDisplay,prioritizeRows,statusCounts} from './collaboration-timing.mjs';
const make=(tag,text,className)=>{const node=document.createElement(tag);if(text!=null)node.textContent=text;if(className)node.className=className;return node;};
const shortModel=value=>{const id=value?.model??value;return typeof id==='string'?id.split('/').slice(1).join('/')||id:'未记录';};
export function mountCollaborationStatus({root,after,call,current,onSelect,toast=()=>{}}){
 const section=make('section',null,'collaboration-status');section.id='managed-collaboration';section.dataset.executionStrip='';section.setAttribute('aria-label','Agent 模型与状态');section.hidden=true;
 const summary=make('span',null,'collaboration-counts'),fault=make('span',null,'collaboration-fault'),all=make('button','状态详情','collaboration-details'),refreshButton=make('button','刷新状态'),chips=make('div',null,'collaboration-chips'),note=make('p',null,'collaboration-note'),freshness=make('span',null,'collaboration-freshness');
 all.type=refreshButton.type='button';all.setAttribute('aria-haspopup','dialog');freshness.dataset.agentFreshness='';section.append(chips,all);if(after?.parentNode===root)root.insertBefore(section,after.nextSibling);else root.append(section);
 let disposed=false,inViewport=true,heartbeat=null,ticker=null,staleTimer=null,readError=null;
 const list=make('dialog',null,'collaboration-dialog collaboration-agent-dialog'),listTitle=make('h2','Agent 状态'),listRows=make('div'),listClose=make('button','关闭'),heading=make('div',null,'collaboration-heading');heading.append(summary,fault,freshness,refreshButton);listClose.type='button';list.setAttribute('aria-label','Agent 状态');const explanation=make('p','本轮经过是 Job 的墙钟时间，不代表模型思考或 CPU 用时；等待、审核与暂停不继续计时。'),help=disclosure({key:'status-help',label:'状态说明',content:explanation}),agentSearch=make('input'),filterCount=make('p');agentSearch.type='search';agentSearch.placeholder='查找任务或助手';agentSearch.setAttribute('aria-label','查找任务或助手');agentSearch.hidden=true;filterCount.hidden=true;list.append(listTitle,heading,note,agentSearch,filterCount,listRows,help,listClose);document.body.append(list);
 const dialog=make('dialog',null,'collaboration-dialog'),dialogTitle=make('h2'),scopeNote=make('p'),facts=make('dl'),search=make('input'),options=make('div'),result=make('p'),footer=make('div',null,'collaboration-model-actions');search.type='search';search.placeholder='搜索模型或来源';search.setAttribute('aria-label','查找可用模型');result.setAttribute('role','status');dialog.setAttribute('aria-label','Agent 模型选择');dialog.append(dialogTitle,scopeNote,facts,search,options,result,footer);document.body.append(dialog);
 const confirm=make('button','保存选择'),cancelPending=make('button','撤销待切换'),inherit=make('button','恢复角色默认'),close=make('button','取消');for(const button of [confirm,cancelPending,inherit,close])button.type='button';footer.append(cancelPending,inherit,close,confirm);
 const modelConnection=make('button','管理连接');modelConnection.type='button';modelConnection.hidden=true;modelConnection.onclick=()=>{dialog.close();if(list.open)list.close();window.dispatchEvent(new CustomEvent('nozeli-open-settings',{detail:'settings-provider'}));};footer.prepend(modelConnection);
 let project=null,generation=0,flight=null,pending=false,frame=null,rows=new Map(),menu=null,choice=null,submitting=false,menuSerial=0,requestKey=null;
 const chipNodes=new Map(),workerLabels=new Map(),listNodes=new Map(),modelNodes=new Map();
 let menuFlight=null,menuAgain=false,menuDirty=false,menuForce=false,requestAction=null;
 const repairs=make('details',null,'collaboration-repairs'),repairSummary=make('summary','项目修复 · 正在读取'),repairNote=make('p',null,'collaboration-note'),repairRows=make('div'),repairMore=make('button','加载更多修复记录');repairMore.type='button';repairs.append(repairSummary,repairNote,repairRows,repairMore);list.insertBefore(repairs,listClose);
 repairSummary.dataset.maintenanceOpen='';
 const repairAlert=make('p',null,'collaboration-repair-alert'),repairOpen=make('button','查看修复记录');repairOpen.type='button';repairOpen.onclick=()=>{repairs.hidden=false;repairs.open=true;repairSummary.focus();};repairSummary.tabIndex=0;list.insertBefore(repairAlert,listRows);help.append(repairOpen);
 let repairFrame=null,repairValues=new Map(),repairPages=1,repairFlight=null,repairAgain=false,repairMorePending=false,repairStale=false,repairError=null;
 const repairNodes=new Map(),repairRequests=new Set();
 const repairReason=value=>({'no_live_action':'无可用的原修复动作','original-action-unavailable':'无可用的原修复动作，不重建或重放','owner-unavailable':'本机记录只读，未连接原运行时','owner-stopping':'原运行时正在停止','cold':'本机记录只读，未连接运行时','limit':'已达到修复次数上限','attempt-limit':'已达到修复次数上限','unknown':'原执行结果待核实','storage-result-unknown':'存储结果待核实，不重放','original-effect-unknown':'原业务执行结果待核实，不重放','interrupted-host-attempt':'上次修复执行结果待核实，不重放','permission':'权限受限','human-boundary':'需要用户明确决定或权限确认','human-decision-required':'原 Work 等待用户决定或验收','lifecycle-held':'项目生命周期受限，暂不可修复','original-job-changed':'原 Job 版本已变化，不重放','original-work-changed':'原 Work 版本已变化，不重放','repair-in-flight':'原修复正在执行','already-repaired':'已修复','unknown-bug':'修复记录待核实','unknown-maintenance-state':'修复状态待核实','attempt_limit':'已达到修复次数上限','no-live-action':'无可用的原修复动作','offline':'本机记录只读，未连接运行时'}[value]??value??'当前状态不可重试');
 const repairKey=row=>JSON.stringify([project,generation,row.id]);
 function paintRepairs(){
  const counts=repairFrame?.summary;repairSummary.textContent='项目修复记录'+(repairValues.size?' · '+repairValues.size:'');const attention=[counts?.inFlight?'修复中 '+counts.inFlight:null,counts?.queued?'排队 '+counts.queued:null,counts?.blocked?'有 '+counts.blocked+' 项处理受阻':null];repairAlert.textContent=repairStale?'修复状态待核实 · '+(repairError??'请刷新'):attention.filter(Boolean).join(' · ');if(counts?.blocked)repairAlert.textContent+=' · '+[...repairValues.values()].filter(row=>row.reason).map(row=>(row.workName??'项目事务')+'：'+repairReason(row.reason)).join('；');repairAlert.hidden=!repairAlert.textContent;repairs.hidden=!repairValues.size&&!repairStale&&!repairs.open;
  repairNote.textContent=repairStale?'上次修复快照，重试已禁用，请刷新。':'';repairNote.hidden=!repairNote.textContent;
  const wanted=new Set(repairValues.keys());for(const [id,node]of repairNodes)if(!wanted.has(id)){node.remove();repairNodes.delete(id);}
  for(const [id,row]of repairValues){let node=repairNodes.get(id);if(!node){node=make('details',null,'collaboration-repair');node.dataset.bugId=id;node.append(make('summary'),make('p',null,'collaboration-repair-facts'),make('p',null,'collaboration-repair-reason'));repairNodes.set(id,node);repairRows.append(node);}
   node.dataset.maintenanceId=id;node.dataset.maintenancePhase=row.phase??'';
   node.querySelector('summary').textContent=(repairStale?'上次：':'')+(row.stateLabel??row.status)+' · '+(row.workName??rows.get(row.workId)?.workName??(row.workId?'原工作':'项目系统事务'));
   node.querySelector('.collaboration-repair-facts').textContent='Work '+(row.workId??'未知')+' · 版本 '+(row.workRevision??'未知')+' · 阶段 '+(row.phase??'未知')+' · 尝试 '+row.attemptCount+'/'+row.maxAttempts+' · Job '+(row.jobId??'未知')+' · 绑定 '+JSON.stringify(row.binding);
   node.querySelector('.collaboration-repair-reason').textContent=[row.reason?repairReason(row.reason):null,(!row.capabilities?.retry&&row.reason!==row.capabilities?.retryReason?repairReason(row.capabilities?.retryReason):null)].filter(Boolean).join(' · ');
   let button=node.querySelector('button');if(!button){button=make('button');button.type='button';button.dataset.maintenanceRetry='';node.append(button);}button.textContent=row.capabilities?.retryMode==='finalize'?'完成维修收尾':'重试修复';button.disabled=repairStale||!row.capabilities?.retry||!['repair','finalize'].includes(row.capabilities?.retryMode)||repairRequests.has(repairKey(row));button.title=row.capabilities?.retryReason?repairReason(row.capabilities.retryReason):'';button.onclick=()=>void retryRepair(row,node);
  }
  repairMore.hidden=!repairFrame?.nextCursor;repairMore.disabled=repairStale||!!repairFlight;
  paintOverflow();
 }
 async function retryRepair(row,node){
  const id=project,gen=generation,key=repairKey(row);if(repairStale||!row.capabilities?.retry||repairRequests.has(key)||!still(id,gen))return;
  repairRequests.add(key);paintRepairs();try{await call('maintenance.retry',{bugId:row.id,binding:row.binding,expectedRetryMode:row.capabilities.retryMode},id);if(still(id,gen)&&repairs.open&&node.open)await refreshRepairs();}
  catch(error){if(still(id,gen)){repairStale=true;repairError='重试未确认：'+error.message+'；未自动重发。';paintRepairs();}}
  finally{repairRequests.delete(key);if(still(id,gen))paintRepairs();}
 }
 async function refreshRepairs({reset=true}={}){
  const id=current()?.projectId;if(!id||project!==id)return;
  if(repairFlight){if(reset)repairAgain=true;else repairMorePending=true;return repairFlight.promise;}
  const gen=generation,wanted=reset?repairPages:repairPages+1,token={};repairFlight=token;repairMore.disabled=true;
  token.promise=(async()=>{try{const incoming=new Map();let cursor=null,latest=null,pages=0,revision=null;
   for(let index=0;index<wanted;index++){const value=await call('maintenance.status',cursor?{cursor}:{},id);if(!still(id,gen))return;if(value.projectId!==id||value.schema!==1||(index&&value.revision!==revision))throw Error('修复快照版本已变化');revision=value.revision;latest=value;pages++;for(const row of value.rows)incoming.set(row.id,row);cursor=value.nextCursor;if(!cursor)break;}
   if(!still(id,gen))return;repairValues=incoming;repairFrame=latest;repairPages=pages;repairStale=false;repairError=null;paintRepairs();
  }catch(error){if(still(id,gen)){repairStale=true;repairError='读取未确认：'+error.message;paintRepairs();}}
  finally{if(repairFlight===token){repairFlight=null;if(still(id,gen)){paintRepairs();if(repairMorePending){repairMorePending=false;void refreshRepairs({reset:false});}else if(repairAgain){repairAgain=false;void refreshRepairs();}}}}})();return token.promise;
 }
 repairMore.onclick=()=>void refreshRepairs({reset:false});
 const modelSignature=row=>JSON.stringify([row?.ownerId,row?.ownerGeneration,row?.workRevision,row?.model]);
 // zeli: Late status replies may update only their originating project generation.
 const still=(id,gen)=>current()?.projectId===id&&project===id&&generation===gen;
 const selected=()=>current()?.target??'frontdesk';
 function modelControl(row,existing){const button=existing??make('button',null,'collaboration-model');button.type='button';const value=row.model??{},currentModel=value.effective??value.lastEffective;button.textContent=(value.effective?'当前：':value.lastEffective?'上次：':'')+(currentModel?shortModel(currentModel):'模型待核实')+(value.desired?' / 下次：'+shortModel(value.desired):'')+(value.syncState==='failed'?' · 切换失败':value.syncState==='unknown'?' · 待核实':value.desired?' · 待生效':'')+' ▾';button.title=row.capabilities?.model?'只修改该 Agent 的后续回合':'原状态只读，查看不会唤醒';button.setAttribute('aria-label',roleLabel(row.role)+' '+(row.workName??'')+' '+button.textContent);button.onclick=()=>void openModel(row);return button;}
 function rowNode(row,existing){
  let card=existing;
  if(!card){const select=make('button',null,'collaboration-select');select.type='button';const timing=make('span',null,'collaboration-timing');timing.dataset.agentTiming='';timing.setAttribute('aria-live','off');const detail=disclosure({key:row.target,label:'详情',content:make('pre')});card=statusLine({key:row.target,subject:select,secondary:timing,notices:[],actions:[modelControl(row),detail]}).node;card.classList.add('collaboration-agent');card.querySelector('.management-state').classList.add('collaboration-state');}
  card.dataset.agentTarget=row.target;card.dataset.state=row.primaryState;const select=card.querySelector('.collaboration-select'),state=card.querySelector('.collaboration-state');
  if(row.role==='worker'&&!workerLabels.has(row.target))workerLabels.set(row.target,'工作助手 '+(workerLabels.size+1));select.textContent=(workerLabels.get(row.target)??roleLabel(row.role))+(row.role==='worker'?' · '+(row.workName||row.displayName||row.target):'');select.setAttribute('aria-pressed',String(selected()===row.target));select.onclick=()=>onSelect?.(row.target);
  const stale=!!readError||snapshotStale(frame)||row.freshness?.stale||row.freshness?.known===false;
  state.textContent=(stale?'状态待核实 · 上次状态：':'')+(row.stateLabel??'状态待核实')+(row.manualControl?.paused?' · 已暂停后续':'');
  const messages=[row.activityText!==row.stateLabel?row.activityText:null,row.blockReason,row.queuedCount?'另有 '+row.queuedCount+' 条排队':null,row.model?.error?.message??row.model?.error];const notice=card.querySelector('.management-notices');notice.textContent=[...new Set(messages.filter(Boolean))].join(' · ');notice.hidden=!notice.textContent;modelControl(row,card.querySelector('.collaboration-model'));card.querySelector('pre').textContent=JSON.stringify({target:row.target,ownerId:row.ownerId,state:row.primaryState,freshness:row.freshness,model:row.model},null,2);paintClock(card,row);return card;
 }
 function syncRows(parent,values,cache){const focused=document.activeElement,wanted=new Set(values.map(row=>row.target)),freeze=parent.contains(focused);for(const [key,element]of cache)if(!wanted.has(key)){element.remove();cache.delete(key);}for(const [index,row]of values.entries()){const element=rowNode(row,cache.get(row.target));cache.set(row.target,element);if(!element.parentNode)parent.append(element);else if(!freeze&&parent.children[index]!==element)parent.insertBefore(element,parent.children[index]??null);}if(focused?.isConnected&&document.activeElement!==focused)focused.focus({preventScroll:true});}
 function filterAgents(){const query=agentSearch.value.trim().toLocaleLowerCase();let shown=0;for(const [target,node]of listNodes){const row=rows.get(target);node.hidden=!!query&&![roleLabel(row.role),row.workName,row.displayName,target].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);if(!node.hidden)shown++;}filterCount.hidden=!query;filterCount.textContent='显示 '+shown+'/'+rows.size;}
 agentSearch.oninput=filterAgents;
 function paint(){
  if(!frame)return;
  const values=prioritizeRows(rows.values(),selected()),counts=statusCounts(values);summary.textContent=[counts.active?'处理中 '+counts.active:null,counts.queued?'排队 '+counts.queued:null,counts.review?'待审阅 '+counts.review:null].filter(Boolean).join(' · ');summary.hidden=!summary.textContent;fault.textContent=counts.fault?'异常 '+counts.fault:'';fault.hidden=!counts.fault;fault.dataset.hasFault=String(counts.fault>0);
  syncRows(listRows,values,listNodes);agentSearch.hidden=values.length<=8&&!agentSearch.value;filterAgents();
  note.textContent=readError?'读取受阻：'+readError+'；保留上次快照，自动重试。':frame.freshness==='recorded'?'历史状态只读；查看不会启动 Agent。':'';note.hidden=!note.textContent;section.hidden=false;paintFreshness();paintChips();schedule();
 }
 function paintOverflow(){
  const faults=statusCounts([...rows.values()]).fault,blocked=repairFrame?.summary?.blocked??0,uncertain=!!readError||repairStale||snapshotStale(frame);
  all.dataset.attention=String(faults>0||blocked>0);all.dataset.uncertain=String(uncertain);
  all.title='计时与项目修复 · '+(frame?.totalAgents??rows.size)+' 个 Agent'+(faults?' · 异常 '+faults:'')+(blocked?' · 修复受阻 '+blocked:'')+(uncertain?' · 状态待核实':'');all.setAttribute('aria-label',all.title);
 }
 function paintChips(){
  const values=[...rows.values()];for(const row of values)if(row.role==='worker'&&!workerLabels.has(row.target))workerLabels.set(row.target,'工作助手 '+(workerLabels.size+1));
  const rank=row=>row.role==='frontdesk'?0:row.role==='orchestrator'?1:2;
  values.sort((a,b)=>rank(a)-rank(b));const inline=values,wanted=new Set(inline.map(row=>row.target));
  for(const [target,node]of chipNodes)if(!wanted.has(target)){node.remove();chipNodes.delete(target);}
  for(const [index,row]of inline.entries()){
   let node=chipNodes.get(row.target);if(!node){node=make('button',null,'collaboration-chip');node.type='button';node.setAttribute('aria-haspopup','dialog');const dot=make('span',null,'collaboration-dot');dot.setAttribute('aria-hidden','true');node.append(dot,make('span',null,'collaboration-role'),make('span',null,'collaboration-chip-state'));chipNodes.set(row.target,node);}
   const stale=!!readError||snapshotStale(frame)||row.freshness?.stale||row.freshness?.known===false,unknown=stale||row.primaryState==='unknown',state=row.stateLabel??row.primaryState;
   node.dataset.agentTarget=row.target;node.dataset.state=row.primaryState;node.dataset.freshness=unknown?'stale':'live';node.querySelector('.collaboration-role').textContent=({frontdesk:'前台',orchestrator:'主控'}[row.role]??workerLabels.get(row.target)??'Agent');node.lastChild.textContent=unknown?'待核实':state;
   node.title=[row.role,row.workName||row.displayName,unknown?'状态待核实 · 上次：'+state:state,row.manualControl?.paused?'后续已暂停':null,row.activityText,row.blockReason,row.model?.effective?'实际模型：'+shortModel(row.model.effective):'上次模型：'+shortModel(row.model?.lastEffective),row.model?.syncState==='failed'?'模型切换失败':row.model?.desired?'模型待生效':null,'点击切换后续回合模型'].filter(Boolean).join(' · ');node.setAttribute('aria-label',node.title);node.onclick=()=>void openModel(row);
   if(chips.children[index]!==node)chips.insertBefore(node,chips.children[index]??null);
  }
  paintOverflow();
 }
 function paintClock(node,row){const display=timingDisplay(row,frame,{readError:!!readError});const timing=node.querySelector('[data-agent-timing]');timing.hidden=!row.timing||(row.timing.kind!=='queued'&&!Number.isFinite(row.timing.elapsedMs));if(!readError||!timing.textContent)timing.textContent=display.text;else if(!timing.textContent.includes('上次快照'))timing.textContent+=' · 上次快照';node.dataset.freshness=display.stale?'stale':'live';timing.dataset.advancing=String(display.advancing);if(display.stale){const state=node.querySelector('.collaboration-state');state.textContent='状态待核实 · 上次状态：'+(row.stateLabel??'未知');}}
 function paintFreshness(){const stale=!!readError||snapshotStale(frame);section.dataset.freshness=stale?'stale':'live';freshness.hidden=!stale;freshness.textContent='状态待核实 · 上次更新 '+(frame?.observedAt?new Date(frame.observedAt).toLocaleTimeString():'时间未记录');}
 function paintClocks(){if(!frame)return;for(const [target,node]of listNodes)paintClock(node,rows.get(target));paintFreshness();paintChips();}
 function stopTimers(){clearInterval(heartbeat);clearInterval(ticker);clearTimeout(staleTimer);heartbeat=ticker=staleTimer=null;}
 function visible(){return !disposed&&!!project&&document.visibilityState!=='hidden'&&(inViewport||list.open||dialog.open);}
 function schedule(){
  stopTimers();if(!visible())return;heartbeat=setInterval(()=>{if(visible())void refresh();},STATUS_REFRESH_MS);
  if(frame&&!readError&&!snapshotStale(frame)){const remaining=STATUS_STALE_MS-(Date.now()-Date.parse(frame.observedAt));staleTimer=setTimeout(()=>{paintClocks();schedule();},Math.max(1,remaining));if([...rows.values()].some(row=>timingDisplay(row,frame).advancing))ticker=setInterval(paintClocks,1000);}
 }
 function visibilityChanged(){paintClocks();schedule();if(visible())void refresh();}
 const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{const next=entries[0]?.isIntersecting??false;if(next===inViewport)return;inViewport=next;visibilityChanged();}):null;observer?.observe(section);document.addEventListener('visibilitychange',visibilityChanged);
 async function refresh(){const agents=refreshAgents();return Promise.all([agents,refreshRepairs()]);}
 async function refreshAgents(){
  const id=current()?.projectId;if(!id){clear();return;}if(project!==id){clear();project=id;}
  if(flight){pending=true;return flight.promise;}
  const gen=generation,forceModel=menuForce,token={};menuForce=false;flight=token;schedule();
  token.promise=(async()=>{const incoming=new Map();let latest=null,pages=0,revision=null;try{
   let cursor=null;const cursors=new Set();do{const value=await call('collaboration.status',{...(cursor?{cursor}:{})},id);if(!still(id,gen))return;if(value.projectId!==id||value.schema!==1||(pages&&value.revision!==revision))throw Error('Agent 快照版本已变化');revision=value.revision;latest=value;pages++;for(const row of value.agents)incoming.set(row.target,row);cursor=value.nextCursor;if(cursor){if(cursors.has(cursor))throw Error('Agent 分页游标重复');cursors.add(cursor);}}while(cursor);
   if(!still(id,gen))return;rows=incoming;frame=latest;readError=null;paint();void refreshMenu(forceModel);
  }catch(error){if(still(id,gen)){readError=error.message;if(frame)paint();else{note.textContent='状态读取受阻：'+error.message;summary.textContent='状态待核实';fault.textContent='读取异常';fault.dataset.hasFault='true';section.hidden=false;paintFreshness();paintOverflow();schedule();}void refreshMenu(true);}}
  finally{if(flight===token){flight=null;if(pending){pending=false;if(current()?.projectId)void refresh();}}}})();return token.promise;
 }
 async function refreshMenu(force=false){
  if(!menu?.info||!dialog.open||submitting)return;const row=rows.get(menu.row.target),signature=modelSignature(row);if(!force&&signature===menu.signature)return;if(menuFlight){menuAgain=true;return;}
  const captured=menu,ticket=menuSerial;captured.signature=signature;
  menuFlight=(async()=>{try{const info=await call('model.options',{target:captured.row.target},captured.id);if(!still(captured.id,captured.gen)||ticket!==menuSerial||!dialog.open)return;captured.stale=!!captured.stale||info.ownerId!==captured.row.ownerId||info.ownerGeneration!==captured.row.ownerGeneration||info.workRevision!==captured.row.workRevision;captured.info={...info,available:info.available&&!captured.stale};if(!menuDirty)choice=info.desired?.model??info.override?.model??info.effective?.model??info.recorded?.model??null;paintMenu();if(captured.stale)scopeNote.textContent='会话归属或工作版本已变化；此菜单只读，请关闭重开后修改。';}catch(error){if(ticket===menuSerial){captured.info.available=false;paintMenu();result.textContent='模型事实读取未确认：'+error.message+'；原选择与草稿保留。';}}finally{menuFlight=null;if(menuAgain){menuAgain=false;if(menu?.info&&dialog.open)void refreshMenu(true);}}})();return menuFlight;
 }
 async function openModel(row){
  const id=project,gen=generation,ticket=++menuSerial;menu={id,gen,row,info:null,signature:modelSignature(row),stale:false};menuDirty=false;choice=null;requestKey=null;submitting=false;dialogTitle.textContent=(row.workName||row.displayName)+' · 后续回合模型';scopeNote.textContent='正在读取原 Agent 设置；此操作不会唤醒会话。';result.textContent='';options.replaceChildren();modelNodes.clear();facts.replaceChildren();search.value='';confirm.disabled=cancelPending.disabled=inherit.disabled=true;dialog.showModal();
  try{const info=await call('model.options',{target:row.target},id);if(!still(id,gen)||ticket!==menuSerial||!dialog.open)return;menu.row={...row,ownerId:info.ownerId,ownerGeneration:info.ownerGeneration,workRevision:info.workRevision};menu.info=info;choice=info.desired?.model??info.override?.model??info.effective?.model??info.recorded?.model??null;paintMenu();}catch(error){if(ticket===menuSerial)result.textContent='读取失败：'+error.message+'；原模型保持不变。';}
 }
 function paintMenu(){
  if(!menu?.info)return;const {info}=menu;
  scopeNote.textContent=!info.available?'原状态待核实或资源只读；不覆盖配置、不重发任务。':info.ownerAvailable?'仅影响当前 Agent 后续回合；运行中的回合不变。':'只保存下次模型选择；不启动进程。';
  facts.replaceChildren(make('dt',info.effective?'当前模型':'上次使用'),make('dd',shortModel(info.effective??info.recorded)));
  if(info.desired||info.override||!info.effective)facts.append(make('dt','下次使用'),make('dd',info.desired?shortModel(info.desired)+' · '+({saved:'待生效',pending:'待生效',failed:'切换失败',unknown:'待核实'}[info.state]??info.state):info.override?shortModel(info.override)+' · 本 Agent 选择':'继承角色默认 / 原生选择'));
  cancelPending.hidden=!info.desired||!['saved','pending','failed'].includes(info.state);cancelPending.disabled=submitting||!info.available;inherit.hidden=!info.override;inherit.disabled=submitting||!info.available;
  paintOptions();if(!info.models?.length)scopeNote.textContent+=' 没有可选模型；请管理连接并核对模型目录。';paintModelAvailability();
 }
 function paintModelAvailability(){modelConnection.hidden=!!menu?.info?.models?.length;const error=menu?.info?.error;if(error)scopeNote.textContent+=' '+(error.message??error.code??'模型切换失败');}
 function paintOptions(){
  if(!menu?.info)return;const info=menu.info,query=search.value.toLocaleLowerCase(),wanted=new Set();let selectedAvailable=false;
  for(const model of info.models??[]){
   const id=typeof model==='string'?model:model.selector??(model.provider&&model.id?model.provider+'/'+model.id:model.id),name=typeof model==='string'?model:model.name??model.id??id;if(!id)continue;wanted.add(id);
   let entry=modelNodes.get(id);if(!entry){const label=make('label',null,'collaboration-model-option'),radio=make('input'),caption=make('span'),source=make('small');radio.type='radio';radio.name='collaboration-model';radio.value=id;label.append(radio,caption,source);entry={label,radio,caption,source};modelNodes.set(id,entry);options.append(label);}
   entry.caption.textContent=name;entry.source.textContent=id;entry.label.hidden=choice!==id&&!(name+' '+id).toLocaleLowerCase().includes(query);entry.radio.checked=choice===id;entry.radio.disabled=submitting||!info.available||model.available===false;entry.radio.onchange=()=>{choice=id;menuDirty=true;requestKey=null;paintOptions();};if(choice===id&&!entry.radio.disabled)selectedAvailable=true;
  }
  for(const [id,entry]of modelNodes)if(!wanted.has(id)){if(id===choice||entry.label.contains(document.activeElement)){entry.radio.disabled=true;entry.label.hidden=false;entry.source.textContent=id+' · 当前目录不可用，原选择保留';}else{entry.label.remove();modelNodes.delete(id);}}
  confirm.disabled=submitting||!info.available||!selectedAvailable||choice===(info.desired?.model??info.override?.model??info.effective?.model);
 }
 async function change(action){
  if(submitting||!menu?.info||!still(menu.id,menu.gen))return;const captured=menu,info=captured.info,ticket=menuSerial;submitting=true;if(requestAction!==action)requestKey=null;requestAction=action;requestKey??=crypto.randomUUID();paintMenu();result.textContent='正在保存原 Agent 选择…';
  try{const value=await call('model.set',{target:captured.row.target,expectedRevision:info.revision??info.configurationRevision??0,requestKey,action,...(action==='set'?{model:choice}:{}),...(captured.row.workRevision!=null?{workRevision:captured.row.workRevision}:{}),...(captured.row.ownerId?{ownerId:captured.row.ownerId}:{})},captured.id);if(!still(captured.id,captured.gen)||ticket!==menuSerial)return;requestKey=null;menuDirty=false;result.textContent=value.state==='applied'?'模型已确认生效；历史与草稿未变。':value.state==='unknown'?'变更结果待核实；未重发任务，请刷新核对。':value.state==='cancelled'?'尚未生效的选择已撤销。':value.state==='failed'?'选择已保留，但原生应用未完成；请核对连接。':'选择已保存，等待安全边界或下次明确启动；未发送草稿。';captured.info=await call('model.options',{target:captured.row.target},captured.id);if(ticket!==menuSerial||!still(captured.id,captured.gen))return;choice=captured.info.desired?.model??captured.info.override?.model??captured.info.effective?.model??null;paintMenu();await refresh();}catch(error){if(ticket===menuSerial)result.textContent='操作未确认：'+error.message+'；原输入和草稿保持，不自动重试。';}finally{if(ticket===menuSerial){submitting=false;paintMenu();void refreshMenu(true);}}
 }
 function clearRepairs(){repairFrame=null;repairValues=new Map();repairPages=1;repairFlight=null;repairAgain=false;repairMorePending=false;repairStale=false;repairError=null;repairNodes.clear();repairRows.replaceChildren();repairs.open=false;repairMore.hidden=true;repairSummary.textContent='项目修复 · 正在读取';repairNote.textContent='';repairAlert.textContent='';repairAlert.hidden=true;}
 function clear(){stopTimers();generation++;menuSerial++;project=null;frame=null;flight=null;readError=null;rows.clear();chipNodes.clear();workerLabels.clear();listNodes.clear();chips.replaceChildren();listRows.replaceChildren();agentSearch.value='';filterCount.hidden=true;help.open=false;pending=false;menuForce=false;menuAgain=false;menuDirty=false;clearRepairs();section.hidden=true;for(const popup of [dialog,list])if(popup.open)popup.close();menu=null;}
 all.onclick=()=>{paint();list.showModal();schedule();};listClose.onclick=()=>list.close();list.addEventListener('close',schedule);refreshButton.onclick=()=>void refresh();search.oninput=paintOptions;close.onclick=()=>dialog.close();dialog.addEventListener('close',()=>{menuSerial++;menu=null;schedule();});confirm.onclick=()=>void change('set');cancelPending.onclick=()=>void change('cancel');inherit.onclick=()=>void change('inherit');
 return {refresh,clear,update({model=false}={}){if(disposed)return;menuForce||=model;const ctx=current();if(!ctx?.projectId){clear();return;}if(project!==ctx.projectId){clear();project=ctx.projectId;}void refresh();},dispose(){disposed=true;observer?.disconnect();document.removeEventListener('visibilitychange',visibilityChanged);clear();section.remove();dialog.remove();list.remove();}};
}
