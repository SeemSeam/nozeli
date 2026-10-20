import {createSessionStore,sessionMessages} from './session-store.mjs';
import {createIdentityHydration,createProjectFiles,restoredComposerDraft,bindComposerDrafts} from './surface-identity-state.mjs';
import {mountArchivePages as renderArchivePages} from './archive-pages.mjs';
import {mountSessionTimeline} from './session-timeline.mjs';
import {renderConfigurationNotice} from './configuration-notice.mjs';
import {deviationHeld} from '../domain/work-deviation.mjs';
import {renderDeviationGate} from './work-deviation.mjs';
import {mountFrontdeskRoutes,frontdeskRouteText} from './frontdesk-routes.mjs';
import {createWorkTerminalPreview} from './work-terminal-preview.mjs';
import {createProviderTerminal} from './provider-terminal.mjs';
import {createTerminalLayout,terminalTargets} from './managed-terminal-layout.mjs';
import {renderTagMarkdown} from './tag-markdown.mjs';
import {renderClosureStatus} from './curation-message.mjs';
import {managedWorkRecords,managedReviewTodos} from '../domain/managed-work-records.mjs';
import {managedProgress} from './managed-progress.mjs';
import {readFileAvailability,availabilityCaption} from './file-availability.mjs';
import {mountManagedTodos} from './managed-todos.mjs';
import './managed-agent-panel.css';
const $=id=>document.getElementById(id);
const labels={frontdesk:'前台',orchestrator:'Orchestrator',worker:'工作 Agent'};
const phases={queued:'排队中',running:'执行中',paused:'待回答/处理',review:'结果待审查',closing:'历史结束待处理',ended:'已结束'};

// Version checkpoint block for one work row: list commits, per-file compare
// that FREEZES a prep (the user's viewed current version), and user-triggered
// managed restore that only ever submits those preps — a click never re-fixes
// the baseline. Conflicts keep the human input and prompt a re-compare.
async function renderWorkVersions({box,record,projectId,call}){
 const signature=record.workId?`${record.workId}:${record.status}`:'';
 if(record.status!=='review'){if(box.dataset.signature){box.dataset.signature='';box.replaceChildren();}return;}
 // Refetch until this work has at least one checkpoint: the first review-time
 // render may race the (retryable) checkpoint publication.
 if(box.dataset.signature===signature&&box.dataset.empty!=='1')return;
 // 状态事件停稳后面板不会再重渲；空态（检查点可能仍在重试发布）按 3s 有界
 // 自轮询补齐，直到该工作出现首个检查点。
 if(box.dataset.signature===signature&&box.dataset.empty==='1'&&!box.dataset.polling){
  box.dataset.polling='1';
  setTimeout(()=>{delete box.dataset.polling;if(box.isConnected){box.dataset.signature='';void renderWorkVersions({box,record,projectId,call});}},3000);
 }
 // 记住已展开的检查点条目：后台补齐/刷新重建节点时不收起用户展开的对比。
 const openStates=new Map([...box.querySelectorAll('.managed-work-version')].map(d=>[d.querySelector('summary')?.textContent||'',d.open]));
 box.dataset.signature=signature;
 box.replaceChildren();
 const head=document.createElement('p');head.className='managed-work-versions-title';head.textContent='版本检查点（Git 影子仓）';box.append(head);
 let data;
 try{data=await call('versions.list',{projectId});}
 catch(error){box.append(Object.assign(document.createElement('p'),{className:'managed-work-versions-note',textContent:'版本检查点列表不可用：'+error.message}));return;}
 window.__verFetchDebug={workId:record.workId,raw:(data.checkpoints||[]).map(item=>item.workId),pending:(data.pending||[]).length};
 const pending=(data.pending||[]).filter(item=>item.requestId.startsWith(`work:${record.workId}:`));
 const checkpoints=(data.checkpoints||[]).filter(item=>item.workId===record.workId);
 if(pending.length)box.append(Object.assign(document.createElement('p'),{className:'managed-work-versions-note',textContent:'有未完成的版本检查点，将在下次状态刷新自动补齐。'}));
 if(!checkpoints.length&&!pending.length){box.dataset.empty='1';box.append(Object.assign(document.createElement('p'),{className:'managed-work-versions-note',textContent:'尚无版本检查点。'}));return;}
 box.dataset.empty='0';
 for(const checkpoint of checkpoints.slice(0,5)){
  const details=document.createElement('details');details.className='managed-work-version';
  const files=Object.keys(checkpoint.docs||{});
  const summary=document.createElement('summary');
  summary.textContent=`${new Date(checkpoint.committedAt).toLocaleString()} · ${files.length} 个文件`;
  details.append(summary);
  const body=document.createElement('div');body.className='managed-work-version-body';details.append(body);
  const preps=new Map(); // relPath → prepId，来自用户实际点击过的对比
  const note=()=>body.querySelector('.managed-work-versions-note:last-of-type');
  for(const relPath of files){
   const fileRow=document.createElement('div');fileRow.className='managed-work-version-file';
   const diffButton=document.createElement('button');diffButton.type='button';diffButton.className='managed-work-version-diff-button';diffButton.textContent='对比 '+relPath;
   diffButton.addEventListener('click',async()=>{
    diffButton.disabled=true;
    try{
     const diff=await call('versions.diff',{projectId,commit:checkpoint.commit,relPath});
     preps.set(relPath,diff.prepId);
     fileRow.querySelector('.managed-work-version-diff')?.remove();
     const pre=document.createElement('pre');pre.className='managed-work-version-diff';
     pre.textContent=`--- 检查点 ${checkpoint.commit.slice(0,10)} · ${relPath}\n${diff.checkpointText}\n\n--- 当前磁盘（已同步最新输入，基线固化于本次对比）\n${diff.currentText??'(文件不存在)'}`;
     fileRow.append(pre);
     note()?.remove();
    }catch(error){fileRow.append(Object.assign(document.createElement('p'),{className:'managed-work-versions-note',textContent:'对比失败：'+error.message}));}
    finally{diffButton.disabled=false;}
   });
   fileRow.append(diffButton);body.append(fileRow);
  }
  const restore=document.createElement('button');restore.type='button';restore.className='managed-work-version-restore';restore.textContent='恢复到此检查点（受管回退）';
  restore.addEventListener('click',async()=>{
   restore.disabled=true;
   try{
    const missing=files.filter(relPath=>!preps.has(relPath));
    if(missing.length)throw Object.assign(new Error('请先逐个点击“对比”确认当前内容后，再恢复（将使用你看到的对比结果作为基线）：'+missing.join('、')),{code:'PREP_REQUIRED'});
    const result=await call('versions.restore',{projectId,commit:checkpoint.commit,relPaths:files,preps:Object.fromEntries(preps),operationId:'ui-restore-'+crypto.randomUUID()});
    const notes=document.createElement('p');notes.className='managed-work-versions-note';
    notes.textContent=result.failed
      ?`未全部恢复：成功 ${result.completed}，未生效 ${result.failed}；未生效文件保留当前内容（含未保存输入），请重新点击“对比”获取新基线后再确认恢复。`
      :`恢复完成：成功 ${result.completed}。`;
    body.append(notes);
   }catch(error){
    const again=error.message&&(error.code==='CONFLICT'||error.code==='PREP_REQUIRED'||error.code==='UNSAVED'||/重新对比|先对比/.test(error.message));
    body.append(Object.assign(document.createElement('p'),{className:'managed-work-versions-note',textContent:(again?'未恢复：':'恢复失败：')+error.message}));
   }
   finally{restore.disabled=false;}
  });
  body.append(restore);
  details.open=openStates.get(summary.textContent)||false;
  box.append(details);
 }
}
export function mountManagedAgent({invoke,toast,openManaged,onMessages=()=>{},onConversation,openProjectFile,openExternal,openFrozenChange}){
 let projectId=null,active=false,ready=false,state=null,target='frontdesk',generation=0,refreshing=0;
 const sessionStore=createSessionStore();let historyPage=false,pageError='',timelineContext=null,contextKey='',pageRequest=0;
 const timelineBox=document.createElement('section');timelineBox.id='managed-session-timeline';$('conversation').insertBefore(timelineBox,$('reading-inbox'));
 const timelineUI=mountSessionTimeline(timelineBox,{});
 async function readTimeline(cursor){const id=projectId,gen=generation,request=++pageRequest;try{const frame=await call('timeline.page',{...(cursor?{cursor}:{}),limit:100},id);if(id!==projectId||gen!==generation||request!==pageRequest)return;historyPage=Boolean(cursor);pageError='';sessionStore.apply(id,frame,{replace:true});paintTimeline();}catch(error){if(id===projectId&&gen===generation){pageError=error.message;paintTimeline();}}}
 function paintTimeline(){if(!state)return;timelineBox.hidden=!active;const key=JSON.stringify([projectId,[...projectFilePaths]]);if(key!==contextKey){contextKey=key;timelineContext={filePaths:projectFilePaths,onFile:entry=>openProjectFile?.({projectId,...entry}),onExternal:openExternal,onError:error=>toast(error.message)};}timelineUI.render({store:sessionStore,state,context:timelineContext,call,openFrozenChange,projectId,historyPage,pageError,onPage:readTimeline,onLatest:()=>readTimeline(),onTask:entry=>{sourceMessage=entry.id;sourceBox.dataset.requestKey=crypto.randomUUID();sourceLabel.textContent='引用：'+entry.text.slice(0,160);sourceGoal.value='';sourceBox.hidden=false;sourceGoal.focus();}});const lifecycle=selectedSession();onConversation?.({count:sessionStore.getSnapshot().entries.length,state:lifecycle.state,label:lifecycle.reason||'统一会话'});}
 const identityReads=createIdentityHydration();
 const requestReads=new Map();
 const timelineSource={
  get projectId(){return projectId;},
  getMessages:()=>sessionMessages({...sessionStore.getLookupSnapshot(),entries:[...new Map([...identityReads.entries(),...sessionStore.getLookupSnapshot().entries].map(entry=>[entry.id,entry])).values()]},state),
  ensureMessage(id){
   const project=projectId,gen=generation;
   return identityReads.ensure(id,{has:key=>sessionStore.has(key),read:async key=>{const result=await call('timeline.read',{id:key},project);return result.entry||result;},pin:entry=>{if(project===projectId&&gen===generation)sessionStore.pin(entry);},onError:error=>{if(project===projectId&&gen===generation)toast('标签原消息无法读取：'+error.message);}});
  },
  ensureRequest(requestId){
   const project=projectId,gen=generation,key=project+':'+requestId;
   if(requestReads.has(key))return requestReads.get(key);
   const promise=(async()=>{let offset=0;do{const result=await call('timeline.request',{requestId,offset},project);if(project!==projectId||gen!==generation)return;await Promise.all(result.ids.map(id=>timelineSource.ensureMessage(id)));offset=result.nextOffset;}while(offset!=null);})();
   const settled=promise.catch(error=>{if(project===projectId&&gen===generation)toast('讨论历史读取失败：'+error.message);});requestReads.set(key,settled);return settled;
  },
  async readMessage(id,options={}){
   const project=projectId,gen=generation,result=await call('timeline.read',{id,...options},project);
   if(project!==projectId||gen!==generation)throw Error('项目已切换，请重新打开原文。');
   return result.entry||result;
  },
 };
 sessionStore.subscribe(()=>{if(active&&state){onMessages(timelineSource.getMessages(),timelineSource);paintTimeline();}});
 const progressBox=document.createElement('section');progressBox.id='managed-progress';progressBox.setAttribute('aria-label','工作进展');progressBox.setAttribute('role','status');progressBox.hidden=true;$('conversation').insertBefore(progressBox,$('reading-inbox'));let progressSignature=null;
 const closureBox=document.createElement('section');closureBox.id='managed-closure-progress';closureBox.hidden=true;$('conversation').insertBefore(closureBox,progressBox);let closureSignature=null;
 const routeBox=document.createElement('section');routeBox.id='managed-frontdesk-routes';routeBox.hidden=true;routeBox.setAttribute('aria-label','前台去向决定');$('conversation-panel').insertBefore(routeBox,$('conversation'));
 const routeUI=mountFrontdeskRoutes({document,container:routeBox,invoke,refresh});
 let projectFilePaths=new Set(),fileAvailability=new Map(),availabilityKey=null,availabilityRequest=0;
 const refreshProjectFiles=createProjectFiles({list:id=>invoke('project.list',{projectId:id}),current:()=>({projectId,generation}),apply:paths=>{projectFilePaths=paths;paintTimeline();}});
 const terminals=new Map(),drafts=new Map(),submissions=new Map(),submissionKeys=new Map(),retryKeys=new Map();let viewed=null,terminalLayout=null,reportRequest=0;
 const recoveryPending=new Set();
 const deviationPending=new Set(),deviationKeys=new Map(),deviationErrors=new Map();
 function paintDeviation(box,work){
  if(work?.readOnly){box.replaceChildren(Object.assign(document.createElement('p'),{textContent:'历史工作只读；原会话、报告和草稿保留，不提供恢复或重放操作。'}));return;}
  const key=projectId+':'+work.id;
  renderDeviationGate(box,{document,work,pending:!ready||deviationPending.has(key),error:deviationErrors.get(key)||'',resolve:action=>resolveDeviation(work,action),...(state.todos.some(t=>t.id===work.deviation?.todoId)?{inspectReport:()=>openTodo(work.deviation.todoId)}:{})});
 }
 async function resolveDeviation(work,action){
  const id=projectId,gen=generation,key=id+':'+work.id,d=work.deviation;if(!ready||deviationPending.has(key)||!deviationHeld(work))return;
  const identity=JSON.stringify([id,work.id,d.id,d.revision,d.version,action]),requestKey=deviationKeys.get(identity)||crypto.randomUUID();deviationKeys.set(identity,requestKey);
  deviationPending.add(key);deviationErrors.delete(key);render();
  try{const result=await call('deviation.resolve',{workId:work.id,deviationId:d.id,expectedRevision:d.revision,expectedVersion:d.version,action,requestKey},id);if(result.accepted!==true)throw Error('宿主未确认决定；原暂停保留。');await refresh();deviationKeys.delete(identity);}
  catch(error){if(id===projectId&&gen===generation){deviationErrors.set(key,(error.code?error.code+'：':'')+error.message);try{await refresh();}catch{} }}
  finally{deviationPending.delete(key);if(id===projectId&&gen===generation){render();for(const box of document.querySelectorAll('[data-deviation-gate]')){const current=state.works.find(w=>w.id===box.dataset.deviationGate);if(current)paintDeviation(box,current);}}}
 }
 const toolbar=document.createElement('div');toolbar.id='managed-todo-context';toolbar.setAttribute('role','status');toolbar.hidden=true;$('conversation-panel').insertBefore(toolbar,$('conversation'));
 const terminalBox=document.createElement('div');terminalBox.id='managed-terminal-grid';terminalBox.hidden=true;$('provider-console').append(terminalBox);
 const configurationNotice=document.createElement('p');configurationNotice.id='managed-configuration-notice';configurationNotice.setAttribute('role','status');configurationNotice.hidden=true;$('provider-console').insertBefore(configurationNotice,terminalBox);
 const button=(text,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=()=>Promise.resolve(fn()).catch(e=>toast(e.message));return b;};
 const call=async(op,p={},id=projectId)=>{const r=await invoke('managed.'+op,{projectId:id,...p});if(!r.ok)throw Object.assign(new Error(r.error.message),{code:r.error.code});return r.value;};
 const residentRecovery=document.createElement('section');residentRecovery.id='managed-resident-recovery';residentRecovery.hidden=true;residentRecovery.setAttribute('aria-label','常驻 Agent 会话恢复');$('conversation-panel').insertBefore(residentRecovery,$('conversation'));
 let residentStatus=null,handoffPending=false;
 const sessionRecovery=document.createElement('section');sessionRecovery.id='managed-session-recovery';sessionRecovery.hidden=true;sessionRecovery.setAttribute('aria-label','当前会话恢复');sessionRecovery.setAttribute('role','status');residentRecovery.after(sessionRecovery);
 let sessionRecoveryPending=false,sessionRecoveryError='';
 function selectedSession(){
  const agent=state?.agents?.find(a=>a.target===target),work=state?.works?.find(w=>w.id===target);
  if(viewed?.readOnly||work?.readOnly)return {state:'unavailable',reason:'当前内容只读，请返回原对话后发送。'};
  if(ready&&(work?.status==='queued'||deviationHeld(work)))return {state:'pending',canSend:true,reason:work.status==='queued'?'任务排队中；补充会保存到原任务，不代表 Agent 已就绪。':'任务偏离暂停；补充仅排队，需先明确处理偏离决定。'};
  if(agent?.closed)return {state:'failed',reason:'原生会话已退出'+(agent.exit?'（'+(agent.exit.signal??agent.exit.exitCode??agent.exit.code??'未知原因')+'）':'')+'；请显式恢复原会话，草稿不会自动发送。',closed:true};
  if(agent?.starting||agent?.restarting||state?.configuringTargets?.includes(target))return {state:'connecting',reason:'当前会话正在恢复或配置；输入保留，请等待后手动发送。'};
  if(!ready)return {state:'unavailable',reason:'Agent 尚未连接；请重试连接，草稿不会自动发送。'};
  return {state:'ready',reason:''};
 }
 function renderSessionRecovery(lifecycle){
  sessionRecovery.replaceChildren();sessionRecovery.hidden=!active||(!lifecycle.reason&&!sessionRecoveryError);
  if(sessionRecovery.hidden)return;
  sessionRecovery.append(Object.assign(document.createElement('p'),{textContent:lifecycle.reason||'原会话已连接；请核对后手动发送。'}));
  if(sessionRecoveryError)sessionRecovery.append(Object.assign(document.createElement('p'),{textContent:sessionRecoveryError}));
  if(viewed?.readOnly)return;
  if(lifecycle.closed||!ready){
   const id=projectId,gen=generation,t=target;
   const recover=button(lifecycle.closed?'恢复原会话（不重放）':'重试连接（不重放）',async()=>{
    if(sessionRecoveryPending)return;sessionRecoveryPending=true;sessionRecoveryError='';recover.disabled=true;
    try{if(lifecycle.closed){await call('restart',{target:t},id);if(id===projectId&&gen===generation)await refresh();}else await load(id);}
    catch(error){if(id===projectId&&gen===generation){sessionRecoveryError='恢复失败：'+error.message+'；原草稿保留，未重放。';toast(sessionRecoveryError);}}
    finally{sessionRecoveryPending=false;if(id===projectId&&gen===generation&&state)render();}
   });
   recover.dataset.managedSessionRecovery=t;recover.disabled=sessionRecoveryPending||Boolean(state?.busyTargets?.includes(t)||state?.agents?.find(a=>a.target===t)?.restarting||deviationHeld(state?.works?.find(w=>w.id===t)));sessionRecovery.append(recover);
  }
 }
 function renderResidentRecovery(status){
  residentStatus=status;residentRecovery.replaceChildren();
  const challenge=status?.handoff,archives=Object.entries(status?.state?.residentArchive||{}).flatMap(([role,slot])=>(slot.handoffs||[]).map(entry=>({...entry,role:entry.role||role})));
  residentRecovery.hidden=!active||(!status?.connectionError&&!challenge&&!archives.length);
  if(residentRecovery.hidden)return;
  const paragraph=text=>residentRecovery.append(Object.assign(document.createElement('p'),{textContent:text}));
  if(status.connectionError)paragraph('Agent 恢复失败：'+status.connectionError.message);
  if(challenge){
   const id=projectId,gen=generation,current=()=>id===projectId&&gen===generation&&residentStatus?.handoff?.token===challenge.token&&residentStatus?.handoff?.oldThreadId===challenge.oldThreadId;
   paragraph(`${labels[challenge.role]||challenge.role} · 已创建会话 ${challenge.oldThreadId} · 工具接口升级，等待你确认新会话接手`);
   paragraph(`${challenge.reason||'原会话工具接口不兼容'}；已有记录保留只读（空会话可能没有对话），Work 与草稿保留。尚未执行接手，不自动发送草稿或重放旧任务。`);
   paragraph(`工具 schema：${challenge.expectedToolsDigest} → ${challenge.newToolsDigest}`);
   const confirm=button('确认以新会话接手',async()=>{
    if(handoffPending||!current())return;
    if(!window.confirm(`确认让 ${labels[challenge.role]||challenge.role} 以新会话接手？\n原会话：${challenge.oldThreadId}\n旧历史保留只读；保留 Work、草稿和 required 意图，不自动重放任务，不发送草稿。`))return;
    if(!current())return;
    handoffPending=true;confirm.disabled=true;
    try{await call('resident.handoff',{role:challenge.role,token:challenge.token,oldThreadId:challenge.oldThreadId},id);if(current())await load(id);}
    finally{handoffPending=false;if(current())confirm.disabled=false;}
   });confirm.dataset.residentHandoff=challenge.role;confirm.disabled=handoffPending;residentRecovery.append(confirm);
  }
  for(const entry of archives){
   const id=projectId,gen=generation,archiveId=entry.archiveId||entry.id;
   const resident=status?.state?.residents?.[entry.role];paragraph(`${labels[entry.role]||entry.role} · 原会话 ${entry.oldThreadId||entry.threadId} → 新会话 ${resident?.threadId||'待启动'} · 第 ${entry.generation??resident?.handoff?.generation??'?'} 代来源：${entry.reason||'用户明确确认接手'}`);
   if(!archiveId)continue;
   const read=button('查看原会话历史（只读）',async()=>{
    if(id!==projectId||gen!==generation)return;
    const request=++reportRequest,current=()=>id===projectId&&gen===generation&&request===reportRequest;
    const result=await call('resident.history',{role:entry.role,archiveId},id);if(!current())return;
    const text=typeof result.text==='string'?result.text:(result.messages||[]).map(m=>`${m.role||m.speaker||'消息'}：${typeof m.text==='string'?m.text:''}`).join('\n\n');
    const title='原会话 '+(entry.oldThreadId||entry.threadId)+' · 只读历史';
    const opened=await openManaged({id:'resident-history:'+archiveId,projectId:id,title,text,history:true,isCurrent:current});if(opened?.ok===false||!current())return;
    viewed={history:true,readOnly:true,historyLabel:title};lockHistory();$('managed-doc').replaceChildren();mountArchivePages($('managed-doc'),result,options=>call('resident.history',{role:entry.role,archiveId,...options},id),current);
   });read.dataset.residentHistory=archiveId;residentRecovery.append(read);
  }
 }
 const workerRecovery=document.createElement('section');workerRecovery.id='managed-worker-recovery';workerRecovery.hidden=true;workerRecovery.setAttribute('aria-label','工作 Agent 显式会话恢复');$('conversation-panel').insertBefore(workerRecovery,$('conversation'));
 const workerHandoffs=new Set();let workerRecoverySignature=null;
 async function openWorkerArchive(work,archive){
  const id=projectId,gen=generation,request=++reportRequest,current=()=>id===projectId&&gen===generation&&request===reportRequest;
  try{
   const result=await call('worker.history',{workId:work.id,archiveId:archive.id,offset:0},id);if(!current())return;
   const title=(work.name||'工作')+' · 原会话接手档案（只读）',opened=await openManaged({id:'worker-history:'+archive.id,projectId:id,title,text:result.text,history:true,isCurrent:current});if(opened?.ok===false||!current())return;
   viewed={history:true,readOnly:true,historyLabel:title};lockHistory();const body=$('managed-doc');body.replaceChildren();const note=document.createElement('p');note.textContent='宿主保存的原始目标、输入、报告及对话来源档案；不是完整原生会话逐字转录。原生历史另行保留，未自动重放。';const source=document.createElement('p');source.textContent=result.source+' · '+result.version;body.append(note,source);
   mountArchivePages(body,result,options=>call('worker.history',{workId:work.id,archiveId:archive.id,...options},id),current);
  }catch(error){if(current())toast('原会话档案无法读取：'+error.message);}
 }
 function mountArchivePages(body,first,read,current){renderArchivePages(body,first,read,current,{document,onError:error=>toast(error.message)});}
 function renderWorkerRecovery(){
  const works=state.works.filter(w=>w.contextRecovery||(w.threadArchive||[]).length),signature=JSON.stringify([projectId,ready,works.map(w=>[w.id,w.name,w.status,w.revision,w.threadId,w.contextRecovery,w.threadArchive])]);if(signature===workerRecoverySignature)return;workerRecoverySignature=signature;workerRecovery.replaceChildren();workerRecovery.hidden=!works.length;
  for(const work of works){
   const heading=document.createElement('h3');heading.textContent=work.name||'工作会话';workerRecovery.append(heading);
   if(work.contextRecovery&&work.status!=='ended'){
    const explanation=document.createElement('p');explanation.textContent='原 Worker 会话不能继续使用：'+(work.contextRecovery.message||work.contextRecovery.code||'工具 schema 不兼容')+'。工作、Agent 身份、工作树与草稿保留；只在你确认后准备新原生会话，不自动发送草稿或重放任务。';workerRecovery.append(explanation);
    const id=projectId,gen=generation,oldThreadId=work.threadId,revision=work.revision,current=()=>id===projectId&&gen===generation&&state.works.some(w=>w.id===work.id&&w.revision===revision&&w.threadId===oldThreadId&&w.contextRecovery);
    const confirm=button('确认新会话接手原工作（不自动执行）',async()=>{if(workerHandoffs.has(work.id)||!current())return;if(!window.confirm('确认以新原生会话接手此工作？旧会话与来源档案保留只读；同一 Work、Agent 和工作树不变。确认本身不会执行任务或发送草稿，之后请显式发送新的讨论/修改输入。'))return;if(!current())return;workerHandoffs.add(work.id);confirm.disabled=true;try{await call('worker.handoff',{workId:work.id,revision,oldThreadId,confirmed:true},id);if(id===projectId&&gen===generation){await refresh();$('compose-status').textContent='原工作已准备新会话接手；尚未自动执行。请核对档案后显式发送新输入，草稿未发送。';}}catch(error){toast(error.message);}finally{workerHandoffs.delete(work.id);if(current())confirm.disabled=false;}});confirm.dataset.workerHandoff=work.id;confirm.disabled=!ready||!oldThreadId||workerHandoffs.has(work.id);workerRecovery.append(confirm);
   }
   for(const archive of work.threadArchive||[]){const read=button('查看原会话来源档案（只读）',()=>openWorkerArchive(work,archive));read.dataset.workerHistory=archive.id;workerRecovery.append(read);}
  }
 }
 const todoUI=mountManagedTodos({document,invoke,toast,openTodo,refresh,
  viewWork:id=>{const w=state?.works.find(w=>w.id===id);if(!w)return;if(w.status==='ended'){const row=[...workRows.values()].find(n=>managedWorkRecords(state).find(r=>r.id===n.dataset.managedRequest)?.workId===id);document.dispatchEvent(new CustomEvent('nozeli-reveal-work-sidebar'));row?.scrollIntoView({block:'nearest'});toast('原工作已结束；仅查看历史，不重启执行。');}else{select(id);}},
  recover:async(todo,id)=>{const gen=generation;if(id!==projectId)return;const w=state.works.find(w=>w.id===todo.workId),reason=recoveryReason(todo,w);if(reason)throw Error(reason);const result=await call(todo.kind==='git'?'git.retry':'recovery.resolve',{todoId:todo.id,workId:w.id,revision:todo.revision,sourceJob:todo.sourceJobId,requestKey:crypto.randomUUID()},id);if(!result.accepted)throw Error(result.error?.message||'恢复未受理');if(id!==projectId||gen!==generation)return;await refresh();if(id!==projectId||gen!==generation)return;if(todo.kind==='recovery'){select(w.id);toast('仅返回原线程核查，未重放执行。');}}
 });
 const exportDialog=document.createElement('dialog');exportDialog.id='managed-report-export';
 exportDialog.innerHTML='<form><h2>另存到项目目录</h2><p>在项目根目录创建 Markdown 副本，原报告保留。请使用未占用的名称。</p><label>文件名 <input name="filename" required maxlength="200" aria-label="报告副本文件名"></label><p role="status" class="managed-export-status"></p><button type="submit">另存副本</button><button type="button" data-export-cancel>取消</button></form>';document.body.append(exportDialog);
 let exportSource=null,exportPending=false;
 const exportInput=exportDialog.querySelector('input'),exportStatus=exportDialog.querySelector('[role=status]'),exportSubmit=exportDialog.querySelector('[type=submit]');
 exportDialog.querySelector('[data-export-cancel]').onclick=()=>exportDialog.close();
 exportDialog.querySelector('form').onsubmit=async event=>{
  event.preventDefault();if(exportPending||!exportSource)return;
  const source=exportSource,relPath=exportInput.value;exportPending=true;exportSubmit.disabled=true;exportInput.disabled=true;exportStatus.textContent='正在另存…';
  try{
   const result=await invoke('report.export',{projectId:source.projectId,objectId:source.objectId,relPath});
   if(!result.ok)throw new Error(result.error?.message||'报告另存失败');
   window.dispatchEvent(new CustomEvent('nozeli-report-exported',{detail:result.value}));
   if(exportSource===source){exportDialog.close();if(projectId===source.projectId)toast('已另存：'+result.value.relPath+'；原报告保留。');}
  }catch(error){if(exportSource===source)exportStatus.textContent=error.message;}
  finally{exportPending=false;exportSubmit.disabled=false;exportInput.disabled=false;}
 };
 function exportReport(source){if(exportPending)return toast('上一份报告正在另存，请稍候。');exportSource=source;exportInput.value='工作报告-r'+source.revision+'.md';exportStatus.textContent='';exportDialog.showModal();exportInput.focus();exportInput.select();}
 const workRows=new Map();
 const archive=document.createElement('details');archive.id='managed-work-archive';const archiveTitle=document.createElement('summary');archiveTitle.textContent='历史报告与已结束工作';archive.append(archiveTitle);$('work-items').after(archive);
 let historyItems=[],historyVersion=null,historyNext=null,historyTotal=0,historyMode='offline',historyRequest=0,historyLoading=false,historyNotice='',historyReceiptSignature=null;
 const historyList=document.createElement('div'),historyStatus=document.createElement('p'),historyActions=document.createElement('div');historyStatus.setAttribute('role','status');historyActions.className='managed-history-actions';
 const historyReload=button('重新加载历史',()=>loadHistory()),historyMore=button('加载更多历史',()=>loadHistory({more:true}));historyReload.dataset.historyReload='';historyMore.dataset.historyMore='';historyActions.append(historyReload,historyMore);archive.append(historyStatus,historyList,historyActions);
 function renderHistory(){
  archive.hidden=!historyLoading&&!historyItems.length&&!historyNotice;archiveTitle.textContent='历史报告与已结束工作'+(historyTotal?' · '+historyTotal:'');
  historyStatus.textContent=(historyMode==='offline'?'离线历史 · ':'只读历史 · ')+(historyLoading?'正在读取…':historyNotice||'条目尚未核验对象，打开时检查原件。');historyList.replaceChildren();
  for(const item of historyItems){const version=historyVersion,b=button('',()=>openHistory(item,version));b.dataset.managedHistoryObject=item.objectId;const title=document.createElement('strong'),excerpt=document.createElement('span');title.textContent=item.workName+' · 第 '+item.revision+' 版'+(item.kind==='problem'?'问题':'报告');excerpt.textContent=item.excerpt;b.append(title,excerpt);historyList.append(b);}
  historyReload.disabled=historyLoading;historyMore.hidden=historyNext===null;historyMore.disabled=historyLoading;
 }
 async function loadHistory({more=false,changed=false,attempt=0}={}){
  const id=projectId,gen=generation,request=++historyRequest;if(!id)return;
  if(!more){historyItems=[];historyVersion=null;historyNext=null;historyTotal=0;reportRequest++;}
  historyLoading=true;historyNotice=changed?'历史快照已变化，旧分页已丢弃并重载。':'';renderHistory();
  const result=await invoke('managed.history.list',{projectId:id,offset:more?historyNext:0,limit:50,...(more?{version:historyVersion}:{})}).catch(error=>({ok:false,error:{message:error.message}}));
  if(id!==projectId||gen!==generation||request!==historyRequest)return;
  historyLoading=false;
  if(!result.ok){
   if(result.error?.code==='REPORT_CHANGED'&&attempt===0)return loadHistory({changed:true,attempt:1});
   historyItems=[];historyVersion=null;historyNext=null;historyTotal=0;reportRequest++;historyNotice='历史读取失败：'+(result.error?.message||'未知错误')+'；原记录未改动，请手动重载。';renderHistory();return;
  }
  const page=result.value;if(page.projectId!==id)return;
  historyItems=more?[...historyItems,...page.items]:page.items;historyVersion=page.version;historyNext=page.nextOffset;historyTotal=page.total;historyMode=page.mode;renderHistory();
 }
 function lockHistory(){
  const locked=Boolean(viewed?.history);document.body.dataset.managedHistory=String(locked);$('compose-form').inert=locked;
  if(locked){$('composer').disabled=true;$('send-message').disabled=true;$('send-message').title='当前历史内容只读，请返回原对话后发送。';toolbar.hidden=false;toolbar.replaceChildren();toolbar.textContent=viewed.historyLabel+' · 只读，不发送或处理任务';toolbar.append(button('返回原对话',leaveHistory));}
 }
 async function openHistory(item,version){
  const id=projectId,gen=generation,request=++reportRequest,current=()=>id===projectId&&gen===generation&&request===reportRequest;
  const result=await invoke('managed.history.read',{projectId:id,objectId:item.objectId,version}).catch(error=>({ok:false,error:{message:error.message}}));if(!current())return;
  const changed=result.error?.code==='REPORT_CHANGED',text=result.ok?result.value.text:'历史读取失败：'+(result.error?.message||'未知错误')+'\n\n原历史条目保留；'+(changed?'请重载列表后重新选择原版本。':'请核对原件后重试。');
  if(result.ok&&(result.value.projectId!==id||result.value.version!==version))return;
  const title=item.workName+' · 第 '+item.revision+' 版'+(item.kind==='problem'?'问题':'报告');
  const opened=await openManaged({id:'history:'+item.objectId,projectId:id,objectId:item.objectId,title,text,history:true,historyMode:result.ok?result.value.mode:historyMode,historyError:!result.ok,isCurrent:current});if(opened?.ok===false||!current())return;
  viewed={history:true,readOnly:true,historyLabel:title};lockHistory();$('managed-doc').replaceChildren();
  let artifactFiles=[];if(result.ok){try{const listed=await call('artifact.list',{objectId:item.objectId},id);if(!current())return;artifactFiles=listed.files;}catch(error){toast('成果快照列表不可用：'+error.message);}}
  renderTagMarkdown($('managed-doc'),text,{filePaths:new Set(artifactFiles.map(f=>f.relPath)),onFile:t=>openArtifact({objectId:item.objectId,...t,sourceProject:id}),onExternal:url=>openExternal?.(url)});
  if(result.ok){const save=button('另存到项目目录',()=>exportReport({projectId:id,objectId:item.objectId,revision:item.revision}));save.dataset.managedReportExport=item.objectId;$('managed-doc').append(save);}
  if(changed)void loadHistory({changed:true});
 }
 let sourceMessage=null;
 const sourceBox=document.createElement('section');sourceBox.id='managed-source-task';sourceBox.hidden=true;sourceBox.setAttribute('aria-label','引用消息提交后台');
 const sourceLabel=document.createElement('p'),sourceGoal=document.createElement('textarea');sourceGoal.placeholder='补充这项任务要完成什么（可选）';sourceGoal.setAttribute('aria-label','引用任务的补充目标');
 const sourceSubmit=button('提交此引用到后台',async()=>{if(!sourceMessage)return;const id=projectId,source=sourceMessage,key=sourceBox.dataset.requestKey;sourceSubmit.disabled=true;try{const receipt=await call('message.task',{messageId:source,text:sourceGoal.value,requestKey:key},id);if(id===projectId&&source===sourceMessage){await refresh();if(id===projectId&&source===sourceMessage){sourceMessage=null;sourceBox.hidden=true;sourceGoal.value='';$('compose-status').textContent=receipt.transferring?'转交已接收，等待前台停稳；原输入草稿仍保留':'引用已交后台，原输入草稿仍保留';document.dispatchEvent(new CustomEvent('nozeli-reveal-work-sidebar'));}}}finally{sourceSubmit.disabled=false;}});
 sourceBox.append(sourceLabel,sourceGoal,sourceSubmit,button('移除引用',()=>{sourceMessage=null;sourceBox.hidden=true;sourceGoal.value='';}));$('compose-form').before(sourceBox);
 const preview=createWorkTerminalPreview({readScreen:(id,workId)=>call('terminal.screen',{target:workId},id),subscribe:fn=>window.nozeli.subscribe('agent',fn)});
 const name=t=>labels[t]||state?.works.find(w=>w.id===t)?.name||'工作 Agent';
 function show(activeValue){active=activeValue;toolbar.hidden=true;$('managed-submit-task').hidden=!active;if(!active){sessionRecovery.hidden=true;sessionRecovery.replaceChildren();sessionRecoveryError='';residentStatus=null;residentRecovery.hidden=true;residentRecovery.replaceChildren();workerRecovery.hidden=true;workerRecovery.replaceChildren();workerRecoverySignature=null;progressBox.hidden=true;closureBox.hidden=true;closureBox.replaceChildren();closureSignature=null;}terminalBox.hidden=!active;document.body.dataset.managedAgents=String(active);for(const el of document.querySelectorAll('[data-provider-role]'))el.hidden=active;}
 function remember(){if(projectId&&active){drafts.set(projectId+':'+target,$('composer').value);}}
 function select(t){remember();sessionRecoveryError='';target=t;const work=state?.works.find(w=>w.id===t);viewed=work?.readOnly?{workId:t,readOnly:true}:null;lockHistory();$('composer').value=drafts.get(projectId+':'+t)??state?.drafts?.[t]??'';render();}
 function render(){
  if(!active||!state)return;
  renderConfigurationNotice(configurationNotice,state.agents||[]);
  renderWorkerRecovery();
  routeUI.render(state,projectId,ready);
  const receiptSignature=state.receipts.length+':'+(state.receipts.at(-1)?.objectId||'');
  if(historyReceiptSignature!==null&&receiptSignature!==historyReceiptSignature)void loadHistory();
  historyReceiptSignature=receiptSignature;
  if(viewed?.routingQuestionId&&state.todos.find(q=>q.id===viewed.routingQuestionId)?.status!=='open')viewed=null;
  const records=managedWorkRecords(state);
  if(state.timeline&&!historyPage)sessionStore.apply(projectId,state.timeline,{replace:true});
  if(target!=='frontdesk'&&target!=='orchestrator'&&!state.works.some(w=>w.id===target&&w.status!=='ended')){const reportView=viewed;select('frontdesk');viewed=reportView;}
  if(viewed?.workId&&state.works.find(w=>w.id===viewed.workId)?.status==='closing'){viewed.readOnly=true;}
  $('conversation-panel').dataset.managedConversation=target;
  toolbar.replaceChildren();toolbar.hidden=!viewed;
  if(viewed){const w=state.works.find(w=>w.id===viewed.workId);toolbar.textContent=w?(w.name||'工作')+' · '+(records.find(r=>r.workId===w.id)?.phase||phases[w.status]||w.status):'待办 · '+(viewed.kind==='result'?'结果待审查':viewed.kind==='problem'||viewed.routingQuestionId?'待回答':'待处理');}

  const progress=managedProgress(state,target),signature=JSON.stringify(progress);
  if(signature!==progressSignature){progressSignature=signature;const wasOpen=progressBox.querySelector('details')?.open;progressBox.replaceChildren();const summary=document.createElement('strong');summary.textContent=progress.summary;progressBox.append(summary);for(const row of progress.requests){const p=document.createElement('p');p.textContent=row.text;p.dataset.managedRequestProgress=row.id;progressBox.append(p);}if(progress.works.length){const details=document.createElement('details'),label=document.createElement('summary');label.textContent=progress.works.length+' 项工作进展';details.open=wasOpen??progress.works.length<=3;details.append(label);for(const row of progress.works){const p=document.createElement('p');p.textContent=row.text;p.dataset.managedWorkProgress=row.id;details.append(p);}progressBox.append(details);}}
  progressBox.hidden=!progress.requests.length&&!progress.works.length;
  const lifecycle=selectedSession();renderSessionRecovery(lifecycle);
  $('ai-status').textContent=`${name(target)} · ${lifecycle.reason||progress.requests[0]?.text||'已就绪'} · ${progress.summary}`;$('ai-status').dataset.state=lifecycle.state;
  const canSend=lifecycle.canSend||lifecycle.state==='ready';$('selection-explain').disabled=!canSend;$('managed-submit-task').disabled=!canSend||!$('composer').value.trim();$('managed-submit-task').textContent=target==='frontdesk'?'提交后台任务':'补充此任务';
  $('composer').disabled=Boolean(viewed?.readOnly);$('send-message').disabled=!canSend;$('send-message').title=lifecycle.reason||'发送（Ctrl/Cmd+Enter）';$('managed-submit-task').hidden=!active||Boolean(viewed?.readOnly);
  if(viewed?.readOnly){const back=button('回到前台讨论',()=>{select('frontdesk');$('composer').disabled=false;});toolbar.append(back);}
  updateReviewActions();
  lockHistory();
  const closing=state.works.filter(w=>w.status==='ended'&&w.closure?.phase!=='complete'&&(target==='frontdesk'||target==='orchestrator'||target===w.id)),closureKey=JSON.stringify(closing);
  if(closureKey!==closureSignature){closureSignature=closureKey;closureBox.replaceChildren();for(const w of closing){const title=document.createElement('h3');title.textContent=w.name||'工作技术收尾';closureBox.append(title);renderClosureStatus(closureBox,w);if(w.closure?.phase==='blocked')closureBox.append(button('重试技术收尾（不重开工作）',async()=>{try{await call('retry',{workId:w.id});await refresh();}catch(error){toast(error.message);}}));}}
  closureBox.hidden=!closing.length;
  const reportStatus=$('managed-report-closure');if(reportStatus){const w=state.works.find(w=>w.id===viewed?.workId),key=JSON.stringify(w?.closure)+w?.status+w?.curated;if(reportStatus.dataset.signature!==key){reportStatus.dataset.signature=key;reportStatus.replaceChildren();renderClosureStatus(reportStatus,w);}}
  paintTimeline();
  const activeRecords=records.filter(r=>r.status!=='ended'),works=$('work-items'),recordIds=new Set(activeRecords.map(r=>r.id));
  for(const [id,row] of workRows)if(!recordIds.has(id)){row.remove();workRows.delete(id);}
  for(const [position,record] of [...activeRecords].reverse().entries()){
   let row=workRows.get(record.id);
   if(!row){row=document.createElement('div');row.className='managed-work-entry';row.dataset.managedRequest=record.id;
    const details=document.createElement('details'),summary=document.createElement('summary'),description=document.createElement('p'),list=document.createElement('div');details.className='managed-work-summary';description.className='managed-work-description';list.className='managed-work-history';details.append(summary,description,list);row.append(details);
    const trigger=button('终端',()=>{const current=managedWorkRecords(state).find(r=>r.id===row.dataset.managedRequest);if(current?.workId)preview.open({projectId,workId:current.workId,name:current.name,phase:current.phase,anchor:trigger});});trigger.className='managed-work-preview';trigger.setAttribute('aria-expanded','false');trigger.title='查看已有只读终端投影，不改变讨论目标';row.append(trigger);
    const controls=document.createElement('div');controls.className='managed-work-decisions';
    const discuss=button('继续讨论 / 修改',()=>{const current=managedWorkRecords(state).find(r=>r.id===row.dataset.managedRequest);if(current?.workId&&current.status!=='ended'){select(current.workId);$('composer').focus();}});discuss.dataset.managedWorkDiscuss='';controls.append(discuss);
    const review=button('查看当前报告',async()=>{const current=managedWorkRecords(state).find(r=>r.id===row.dataset.managedRequest),todo=managedReviewTodos(state).find(t=>t.workId===current?.workId&&t.kind==='result');if(todo)await openTodo(todo.id);else toast('尚无当前可审查报告；可继续讨论或明确丢弃成果并结束。');});review.dataset.managedWorkReview='';controls.append(review);
    const discard=button('丢弃成果并结束',async()=>{const current=state.works.find(w=>w.id===row.dataset.managedWork);if(!current||['closing','ended'].includes(current.status))return;if(!window.confirm('丢弃此工作尚未合入的成果并结束，将删除其专用工作树和分支；原项目文件、草稿与历史报告保留。确认？'))return;try{await call('end',{workId:current.id,revision:current.revision,decision:'discard'});await refresh();}catch(error){toast(error.message);}});discard.dataset.managedWorkDiscard='';controls.append(discard);
    details.append(controls);
    row.addEventListener('pointerenter',preview.enter);row.addEventListener('pointerleave',preview.leave);workRows.set(record.id,row);
   }
   if(record.workId)row.dataset.managedWork=record.workId;else delete row.dataset.managedWork;
   row.querySelector('summary').textContent=`${record.name} · ${record.phase}`;
   row.querySelector('.managed-work-preview').hidden=!record.workId;
   row.querySelector('.managed-work-decisions').hidden=!record.workId;
   const currentWork=state.works.find(w=>w.id===record.workId),hasCurrentReport=managedReviewTodos(state).some(t=>t.workId===record.workId&&t.kind==='result');
   for(const control of row.querySelectorAll('.managed-work-decisions button'))control.disabled=!ready||!currentWork||['closing','ended'].includes(currentWork.status);
   row.querySelector('[data-managed-work-review]').hidden=!hasCurrentReport;
   if(currentWork?.readOnly){row.querySelector('[data-managed-work-discuss]').hidden=true;row.querySelector('[data-managed-work-discard]').hidden=true;row.querySelector('[data-managed-work-review]').disabled=false;}
   row.querySelector('.managed-work-description').textContent=record.description||'';
   let gate=row.querySelector('[data-deviation-gate]');if(deviationHeld(currentWork)){if(!gate){gate=document.createElement('section');row.append(gate);}paintDeviation(gate,currentWork);}else gate?.remove();
   row.querySelector('[data-managed-work-discuss]').textContent=deviationHeld(currentWork)?'补充材料（仅排队）':'继续讨论 / 修改';
   const history=row.querySelector('.managed-work-history'),signature=JSON.stringify(record.events.slice(-8));if(history.dataset.signature!==signature){history.dataset.signature=signature;history.replaceChildren();for(const event of record.events.slice(-8)){const p=document.createElement('p');p.textContent=(event.at?new Date(event.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+' · ':'')+event.text;history.append(p);}}
   let versionsBox=row.querySelector('.managed-work-versions');if(!versionsBox){versionsBox=document.createElement('div');versionsBox.className='managed-work-versions';row.querySelector('.managed-work-summary').append(versionsBox);}
   void renderWorkVersions({box:versionsBox,record,projectId,call});
   if(works.children[position]!==row)works.insertBefore(row,works.children[position]||null);
  }
  preview.update({projectId,works:state.works.map(w=>({...w,phase:phases[w.status]}))});
  $('work-count').textContent=String(activeRecords.length);$('work-empty').hidden=activeRecords.length>0;
  todoUI.render(state,projectId);
  for(const box of $('managed-doc').querySelectorAll('[data-deviation-gate]')){const work=state.works.find(w=>w.id===box.dataset.deviationGate);if(work)paintDeviation(box,work);}
  for(const el of document.querySelectorAll('.workflow-panel .filters,.inbox-panel .filters'))el.hidden=true;
  renderTerminals();
 }
 async function openArtifact({objectId,relPath,line,sourceProject=projectId}){
  const gen=generation,request=++reportRequest,current=()=>sourceProject===projectId&&gen===generation&&request===reportRequest;
  try{
   const artifact=await call('artifact.read',{objectId,relPath},sourceProject);if(!current())return;
   const opened=await openManaged({id:'artifact:'+objectId+':'+relPath,projectId:sourceProject,objectId,title:relPath+' · 报告成果快照（只读）',text:artifact.text??'二进制成果：'+relPath+'（'+artifact.size+' 字节）',history:true,isCurrent:current});if(opened?.ok===false||!current())return;
   viewed={history:true,readOnly:true,historyLabel:relPath+' · 成果快照'};lockHistory();const body=$('managed-doc');body.replaceChildren();
   const note=document.createElement('p');note.textContent='报告发布时的工作树成果快照，未以原项目同名文件替代。'+(line?' 来源行：'+line:'');body.append(note);
   if(artifact.text!==null){const pre=document.createElement('pre');pre.textContent=artifact.text;body.append(pre);}
   const download=button('下载此成果快照',()=>{const bytes=Uint8Array.from(atob(artifact.base64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes])),link=document.createElement('a');link.href=url;link.download=relPath.split('/').at(-1);link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});body.append(download);
  }catch(error){toast('成果快照无法读取：'+error.message);}
 }
 async function refreshArtifactAvailability(force=false){
  if(!active||!state)return;
  const links=[...document.querySelectorAll('[data-managed-message] .conversation-file-link[data-path],#managed-doc .conversation-file-link[data-path]')].map(n=>n.dataset.path);
  const candidates=new Set(state.receipts.flatMap(r=>(r.snapshot?.files||[]).map(f=>f.relPath))),paths=[...new Set(links.filter(relPath=>!candidates.has(relPath)))],key=JSON.stringify([projectId,paths,state.artifacts||[]]);
  if(!force&&availabilityKey===key)return;availabilityKey=key;
  const id=projectId,gen=generation,request=++availabilityRequest;
  try{const checked=await readFileAvailability(invoke,id,paths);if(!active||id!==projectId||gen!==generation||request!==availabilityRequest)return;fileAvailability=checked;renderHistoricalLinks();}
  catch(error){if(id!==projectId||gen!==generation||request!==availabilityRequest)return;fileAvailability=new Map(paths.map(relPath=>[relPath,{relPath,status:'unavailable'}]));renderHistoricalLinks();toast('成果路径检查失败：'+error.message);}
 }
 function renderHistoricalLinks(){
  for(const link of document.querySelectorAll('[data-managed-message] .conversation-file-link[data-path],#managed-doc .conversation-file-link[data-path]')){
   const candidate=state.receipts.some(r=>r.snapshot?.files?.some(f=>f.relPath===link.dataset.path));if(candidate){link.dataset.availability='snapshot';link.title=link.dataset.path+' · 报告成果快照（只读，非原项目同名文件）';link.querySelector('.managed-link-availability')?.remove();continue;}
   const entry=fileAvailability.get(link.dataset.path);link.dataset.availability=entry?.status||'unknown';link.title=link.dataset.path+' · '+availabilityCaption(entry);
   let note=link.querySelector('.managed-link-availability');
   if(!['missing','unavailable'].includes(entry?.status)){note?.remove();continue;}
   if(!note){note=document.createElement('small');note.className='managed-link-availability';link.append(note);}
   note.textContent=' · '+availabilityCaption(entry);
  }
 }
 window.addEventListener('nozeli-project-files-refreshed',event=>{if(event.detail?.projectId===projectId)void refreshArtifactAvailability(true);});
 function recoveryCaption(result){return result.status==='inspection-required'?'已交还原线程核查；未重放执行，需核对文件后显式补充。':result.status==='committed'?'宿主确认 Git 已提交：'+(result.git?.commit||'详见原检查点回执'):'宿主确认本次 Git 未提交：'+(result.git?.reason||result.status);}
 function updateGitReceipt(todo){
  const box=$('managed-recovery-receipt');if(!box)return;
  const result=todo?.resolution;box.textContent=result?.accepted?recoveryCaption(result):'';box.hidden=!result?.accepted;
  const original=$('managed-original-issue');if(original&&result?.accepted&&!original.dataset.resolved){original.open=false;original.dataset.resolved='true';}
 }
 function recoveryReason(todo,w){
  if(todo?.resolution?.accepted)return recoveryCaption(todo.resolution);
  if(!todo||todo.status!=='open'||!w||todo.revision!==w.revision)return '事项或工作版本已变化，请刷新后核查';
  if(deviationHeld(w))return '任务偏离暂停尚未解除；请使用偏离决定按钮，通用恢复不能恢复执行。';
  if(!Number.isInteger(todo.revision)||!todo.sourceJobId||!state.jobs.some(j=>j.id===todo.sourceJobId))return '历史事项缺少来源身份，不能自动恢复或提交';
  if(!['paused','review'].includes(w.status)||state.busyTargets?.some(t=>t===w.id||t==='orchestrator')||state.agents?.some(a=>a.target===w.id&&a.starting)||state.jobs.some(j=>['queued','running','transferring'].includes(j.status)&&(j.target===w.id||j.context?.boundWorkId===w.id||j.context?.workId===w.id)))return '请等待原工作及主控停稳';
  if(state.drafts?.[w.id]||state.drafts?.orchestrator||state.nativeDraftTargets?.some(t=>t===w.id||t==='orchestrator'))return '原工作或主控还有未发送草稿，请先发送或明确清空';
  return '';
 }
 function updateReviewActions(){
  const footer=$('managed-result-actions');if(!viewed||!footer||!viewed.workId)return;
  const w=state.works.find(w=>w.id===viewed.workId);if(!w)return;
  const currentTodo=state.todos.find(t=>t.id===viewed.todoId);if(viewed.kind==='git')updateGitReceipt(currentTodo);
  const recovery=footer.querySelector('[data-managed-recovery-action]');if(recovery){const todo=state.todos.find(t=>t.id===viewed.todoId),reason=recoveryReason(todo,w);recovery.disabled=!ready||recoveryPending.has(projectId+':'+viewed.todoId)||Boolean(reason);recovery.title=reason;const note=footer.querySelector('[data-managed-recovery-note]');if(note){note.textContent=todo?.kind==='git'&&todo.resolution?.accepted?'':reason||todo?.lastRecoveryError?.message||'不会重放原执行；Git 仅重查原检查点，失败保留文件、index 和事项。';note.hidden=!note.textContent;}}
  if(w.status==='ended'){for(const b of footer.querySelectorAll('button:not([data-managed-closure-retry])'))b.remove();const retry=footer.querySelector('[data-managed-closure-retry]');if(retry)retry.disabled=!ready||w.closure?.phase!=='blocked';}
  const stale=viewed.kind==='result'&&(w.revision!==viewed.revision||w.status!=='review');
  const end=footer.querySelector('[data-managed-end-result]');if(end)end.disabled=!ready||stale;
  const discard=footer.querySelector('[data-managed-end-discard]');if(discard)discard.disabled=!ready||w.revision!==viewed.revision||(viewed.kind==='result'?w.status!=='review':w.status!=='paused');
  let note=$('managed-result-update');
  if(!stale){note?.remove();return;}
  if(!note){note=document.createElement('div');note.id='managed-result-update';note.setAttribute('role','status');footer.prepend(note);}
  note.replaceChildren();const text=document.createElement('span');text.textContent=`当前显示第 ${viewed.revision} 版报告，工作${phases[w.status]}。`;note.append(text);
  const latest=state.todos.filter(t=>t.workId===w.id&&t.kind==='result'&&t.revision===w.revision&&t.objectId).at(-1);
  if(latest&&latest.revision!==viewed.revision){text.textContent=`当前显示第 ${viewed.revision} 版报告，已有第 ${latest.revision} 版结果。`;const b=button('查看最新结果',()=>openTodo(latest.id));b.dataset.managedLatestReport=latest.id;note.append(b);}
 }
 async function openTodo(id){
  const todo=state.todos.find(t=>t.id===id);if(!todo)return;
  if(todo.kind==='frontdesk-route'){
   const proposal=state.frontdeskRoutes?.find(route=>route.id===todo.proposalId);
   const sourceProject=projectId,gen=generation;
   const result=await openManaged({id:todo.id,projectId:sourceProject,title:'前台去向决定',text:proposal?frontdeskRouteText(proposal):todo.text||'原去向建议记录已不可用；不会自动转交或重放。',writtenBack:null});
   if(result?.ok===false||sourceProject!==projectId||gen!==generation)return;
   select('frontdesk');viewed={todoId:todo.id,kind:todo.kind,readOnly:true};render();routeBox.scrollIntoView({block:'nearest'});
   const management=document.createElement('section');management.className='managed-todo-detail-actions';$('managed-doc').append(management);todoUI.details(management,todo.id);return;
  }
  const w=state.works.find(w=>w.id===todo.workId),sourceProject=projectId,gen=generation,request=++reportRequest;
  const receipt=state.receipts.find(r=>r.objectId===todo.objectId),text=receipt?.text||todo.text||'工作排队中；尚无正式报告。';
  const title=(w?.name||'主控事项')+(todo.revision?' · 第 '+todo.revision+' 版':'');
  const stillCurrent=()=>sourceProject===projectId&&gen===generation&&request===reportRequest&&state?.todos.some(t=>t.id===id&&(t.managementRevision||0)===(todo.managementRevision||0));
  const result=await openManaged({id:todo.id,projectId:sourceProject,objectId:todo.objectId,title,text,writtenBack:null});
  if(result?.ok===false)return;
  if(!stillCurrent()){if(sourceProject===projectId&&gen===generation&&request===reportRequest){$('managed-doc').replaceChildren();$('managed-doc').textContent='待办已变化或移除，请从待办面板重新查看。';}return;}
  const listing=await invoke('project.list',{projectId:sourceProject});if(!stillCurrent()){if(sourceProject===projectId&&gen===generation&&request===reportRequest){$('managed-doc').replaceChildren();$('managed-doc').textContent='待办已变化或移除，请重新查看。';}return;}
  const filePaths=new Set([...(listing.ok?listing.value.entries.filter(e=>e.kind!=='dir').map(e=>e.relPath):[]),...(state.artifacts||[]).map(a=>a.relPath),...(receipt?.snapshot?.files||[]).map(f=>f.relPath)]);projectFilePaths=filePaths;
  $('managed-doc').replaceChildren();let body=$('managed-doc');
  if(todo.kind==='git'){
   const current=document.createElement('p');current.id='managed-recovery-receipt';current.setAttribute('role','status');current.hidden=true;body.append(current);
   const original=document.createElement('details'),label=document.createElement('summary'),originalBody=document.createElement('div');original.id='managed-original-issue';label.textContent='原事项正文（历史记录，不代表当前处理结果）';original.open=!todo.resolution?.accepted;original.append(label,originalBody);body.append(original);body=originalBody;updateGitReceipt(todo);
  }
  renderTagMarkdown(body,text.replaceAll(']('+state.contentRoot+'/',']('),{filePaths,onFile:t=>receipt?.snapshot?.files?.some(f=>f.relPath===t.relPath)?openArtifact({objectId:receipt.objectId,...t,sourceProject}):openProjectFile?.({projectId:sourceProject,...t}),onExternal:url=>openExternal?.(url)});
  if(todo.kind==='deviation'&&w&&w.deviation?.todoId===todo.id){const gate=document.createElement('section');$('managed-doc').append(gate);paintDeviation(gate,w);}
  const business=todo.status==='open'&&!todo.reopenedAt&&w&&!w.readOnly&&todo.revision===w.revision&&['result','problem'].includes(todo.kind)&&!['closing','ended'].includes(w.status),routing=todo.status==='open'&&!todo.reopenedAt&&todo.kind==='routing'&&!w?.readOnly;
  select(business?w.id:'frontdesk');viewed={todoId:todo.id,workId:w?.id,revision:todo.revision,kind:todo.kind,routingQuestionId:routing?todo.id:null,readOnly:!business&&!routing};render();
  if(todo.objectId){const save=button('另存到项目目录',()=>exportReport({projectId:sourceProject,objectId:todo.objectId,revision:todo.revision}));save.dataset.managedReportExport=todo.objectId;$('managed-doc').append(save);}
  const footer=document.createElement('div');footer.id='managed-result-actions';
  const reportStatus=document.createElement('div');reportStatus.id='managed-report-closure';renderClosureStatus(reportStatus,w);$('managed-doc').append(reportStatus);
  const action= (caption,fn)=>button(caption,async()=>{try{await fn();await refresh();}catch(error){if(error.businessRejection)return;let notice=$('managed-review-error');if(!notice){notice=document.createElement('p');notice.id='managed-review-error';notice.setAttribute('role','alert');footer.append(notice);}notice.textContent=error.message;}});
  if(todo.status==='open'&&!todo.reopenedAt&&!w?.readOnly){
  if(w&&!['closing','ended'].includes(w.status)){
   footer.append(action(deviationHeld(w)?'补充材料（仅保存排队，不解除暂停）':'继续讨论 / 修改（原 Worker）',()=>{if(sourceProject!==projectId)return;viewed=null;select(w.id);$('composer').focus();$('compose-status').textContent=deviationHeld(w)?'偏离暂停中：发送内容只保存排队；请从 Work 卡显式决定。':'继续发送给原 Worker；保留同一工作、会话和工作树。';}));
  if(todo.kind==='result'&&w.status==='review'&&todo.revision===w.revision){const end=action('接受成果并结束',async()=>{await draftWriter.settled();const draft=drafts.has(sourceProject+':'+w.id)?drafts.get(sourceProject+':'+w.id):state.drafts?.[w.id];if((draft||'').trim())throw Error('原工作还有未发送草稿，请先发送或明确清空；报告保留。');if(!window.confirm('接受当前成果并结束业务工作；宿主随后安全合入和清理。若合入受阻，工作仍已结束，报告和工作树保留供技术重试。继续？'))return;await call('end',{workId:w.id,revision:todo.revision,decision:'accept'},sourceProject);});end.dataset.managedEndResult='';footer.append(end);}
  }
  if(w?.status==='ended'&&w.closure?.phase==='blocked'){const retry=action('重试技术收尾（不重开工作）',()=>call('retry',{workId:w.id},sourceProject));retry.dataset.managedClosureRetry='';footer.append(retry);}
  const job=state.jobs.find(j=>j.id===todo.sourceJobId);if(['system','routing'].includes(todo.kind)&&job?.type==='intake'&&['failed','interrupted','transferring'].includes(job.status))footer.append(action(job.status==='transferring'?'重试转交':'重试主控处理',()=>call('intake.retry',{jobId:job.id,requestKey:retryKeys.get(job.id)||crypto.randomUUID()},sourceProject)));
  if(['recovery','git'].includes(todo.kind)&&w&&!['closing','ended'].includes(w.status)){
   const op=todo.kind==='git'?'git.retry':'recovery.resolve',identity=sourceProject+':'+todo.id,hostIdentity=JSON.stringify([sourceProject,todo.kind,todo.id,w.id,todo.revision,todo.sourceJobId]);
   const retry=action(todo.kind==='git'?'重查并重试原 Git 检查点':'返回原线程核查（不重放执行）',async()=>{
    if(recoveryPending.has(identity))return;recoveryPending.add(identity);retry.disabled=true;
    try{
     const pending=state.todoActions?.find(a=>a.identity===hostIdentity&&!a.result),requestKey=pending?.requestKey||retryKeys.get(identity)||crypto.randomUUID();retryKeys.set(identity,requestKey);
     const result=await call(op,{todoId:todo.id,workId:w.id,revision:todo.revision,sourceJob:todo.sourceJobId,requestKey},sourceProject);
     if(typeof result.accepted!=='boolean')throw Error('宿主未返回明确恢复回执；保留原请求身份，请重试核查');
     retryKeys.delete(identity);await refresh();
     if(!result.accepted)throw Object.assign(Error(result.error?.message||'宿主拒绝恢复，原事项保留'),{businessRejection:true});
     if(sourceProject!==projectId||gen!==generation||viewed?.todoId!==todo.id)return;
     footer.querySelector('#managed-review-error')?.remove();
     if(todo.kind==='recovery'){viewed=null;select(result.workId);$('compose-status').textContent='未重放原执行，请先核对实际文件，再显式发送新补充。';toast('已返回原线程核查；没有自动执行或发送补充。');}
     else updateGitReceipt(state.todos.find(t=>t.id===todo.id));
    }finally{recoveryPending.delete(identity);if(sourceProject===projectId)updateReviewActions();}
   });retry.dataset.managedRecoveryAction=op;footer.append(retry);
   const notice=document.createElement('p');notice.dataset.managedRecoveryNote='';footer.append(notice);
   const inspect=action('查看原工作，核对后显式补充',()=>{if(sourceProject!==projectId)return;viewed=null;select(w.id);$('compose-status').textContent='仅打开原工作；请核对实际文件，再显式发送新补充，未重放执行。';});footer.append(inspect);
  }else if(viewed.readOnly){const notice=document.createElement('p');notice.textContent='此为历史或程序处理事项，不向原Worker发送业务输入。';footer.append(notice);}
  if(business){const discard=action('丢弃成果并结束',async()=>{if(!window.confirm('丢弃此工作尚未合入的成果并结束：宿主将删除其专用工作树和分支，不能继续在原 Worker 修改。原项目文件、草稿及历史报告保留。确认丢弃？'))return;await call('end',{workId:w.id,revision:todo.revision,decision:'discard'},sourceProject);});discard.dataset.managedEndDiscard='';footer.append(discard);}
  }
  $('managed-doc').append(footer);updateReviewActions();
  const management=document.createElement('section');management.className='managed-todo-detail-actions';$('managed-doc').append(management);todoUI.details(management,todo.id);
 }
 async function refresh(){const id=projectId,gen=generation,version=++refreshing;if(!id||!active)return;const s=await call('status',{},id);if(id!==projectId||gen!==generation||version!==refreshing)return;state=s.state;ready=Boolean(s.ready);renderResidentRecovery(s);if(state)render();}
 const resetSession=()=>{requestReads.clear();clear();};
 function clear({rememberDraft=true}={}){if(rememberDraft)remember();identityReads.clear();renderConfigurationNotice(configurationNotice,[]);routeUI.clear();todoUI.clear();reportRequest++;historyRequest++;pageRequest++;historyPage=false;pageError='';active=false;sessionStore.reset(null);timelineBox.hidden=true;historyReceiptSignature=null;historyItems=[];historyVersion=null;historyNext=null;historyTotal=0;historyLoading=false;historyNotice='';renderHistory();if(exportDialog.open)exportDialog.close();exportSource=null;sourceMessage=null;sourceBox.hidden=true;sourceGoal.value='';preview.close();for(const row of workRows.values())row.remove();workRows.clear();generation++;ready=false;state=null;toolbar.hidden=true;toolbar.replaceChildren();progressBox.hidden=true;progressBox.replaceChildren();progressSignature=null;delete $('conversation-panel').dataset.managedConversation;projectFilePaths=new Set();fileAvailability=new Map();availabilityKey=null;availabilityRequest++;target='frontdesk';viewed=null;lockHistory();$('composer').disabled=false;for(const t of terminals.values())t.dispose();terminals.clear();terminalLayout?.dispose();terminalLayout=null;terminalBox.replaceChildren();show(false);}
 async function load(id,{connect=true,draft}={}){
  const oldHistory=id===projectId&&viewed?.history?viewed:null,oldTarget=target,oldDraft=$('composer').value;
  resetSession();projectId=id;sessionStore.reset(id);if(!id)return false;if(oldHistory){viewed=oldHistory;target=oldTarget;$('composer').value=oldDraft;lockHistory();}
  if(draft!==undefined){drafts.set(id+':frontdesk',draft);$('composer').value=draft;}
  void refreshProjectFiles().catch(error=>toast('文件链接列表读取失败：'+error.message));
  residentStatus=null;residentRecovery.hidden=true;residentRecovery.replaceChildren();
  void loadHistory();const gen=generation,status=await call('status',{},id);if(gen!==generation)return false;if(!status.enabled)return false;
  show(true);renderResidentRecovery(status);$('send-message').disabled=true;$('ai-status').textContent='三角色正在恢复…';let connected;
  if(!connect){state=status.state;ready=false;if(!viewed?.history)$('composer').value=restoredComposerDraft({local:drafts.get(id+':frontdesk'),durable:state?.drafts?.frontdesk});if(state)render();await readTimeline();if(gen!==generation||id!==projectId)return true;$('ai-status').textContent='请完成 Nozeli 配置初始化；历史记录保持只读。';$('ai-status').dataset.state='unavailable';return true;}
  if(status.handoff){state=status.state;ready=false;if(state)render();$('ai-status').textContent='Agent 恢复失败：等待明确确认新会话接手';$('ai-status').dataset.state='failed';return true;}
  try{connected=await call('connect',{},id);}catch(error){
   if(gen!==generation)return true;terminalLayout?.dispose();terminalLayout=null;$('ai-status').textContent='Agent 恢复失败：'+error.message;$('ai-status').dataset.state='failed';
   const failed=await call('status',{},id).catch(()=>status);if(gen!==generation||id!==projectId)return true;state=failed.state;renderResidentRecovery({...failed,connectionError:failed.connectionError||{code:error.code,message:error.message}});
   sessionRecoveryError='恢复失败：'+error.message;renderSessionRecovery(selectedSession());
   const note=document.createElement('p');note.textContent='Agent 恢复失败：'+error.message;terminalBox.replaceChildren(note,button('重试连接',()=>{if(gen===generation&&id===projectId)return load(id);}));lockHistory();toast('Agent 恢复失败；可明确确认新会话接手，历史仍可只读。');return true;
  }
  if(gen!==generation)return true;ready=connected.ready===true;state=connected.state;renderResidentRecovery(connected);if(!ready){renderSessionRecovery(selectedSession());$('ai-status').textContent='Agent尚未就绪，请完成接手确认或重试连接';$('ai-status').dataset.state='failed';return true;}if(!viewed?.history)$('composer').value=restoredComposerDraft({local:drafts.get(id+':frontdesk'),durable:state?.drafts?.frontdesk});render();void loadHistory();return true;
 }
 async function enable(id){const gen=generation;projectId=id;sessionStore.reset(id);const connected=await call('enable',{},id);if(gen!==generation||id!==projectId)return;show(true);ready=connected.ready===true;state=connected.state;render();}
 function send(text,context={}){const lifecycle=selectedSession();if(!active||(!lifecycle.canSend&&lifecycle.state!=='ready'))return Promise.reject(Error(lifecycle.reason||'Agent 尚未启用；输入已保留。'));const key=JSON.stringify([projectId,target,text,context,viewed?.routingQuestionId]);if(submissions.has(key))return submissions.get(key);const requestKey=submissionKeys.get(key)||crypto.randomUUID();submissionKeys.set(key,requestKey);const promise=sendOnce(text,context,requestKey).then(result=>{submissionKeys.delete(key);return result;}).finally(()=>{if(submissions.get(key)===promise)submissions.delete(key);});submissions.set(key,promise);return promise;}
 async function sendOnce(text,{relPath,materialText,tags,background=false}={},requestKey){
  const id=projectId,t=target,old=$('composer').value,questionId=viewed?.routingQuestionId;
  await draftWriter.settled();
  const manual=background&&t==='frontdesk';
  const result=await call(manual?'task':'send',{...(!manual?{target:t}:{}),requestKey,text,...(questionId?{routingQuestionId:questionId}:{}),...(relPath?{relPath,materialText}:{}),...(tags?{tags}:{})},id);
  if(id===projectId&&t===target&&$('composer').value===old&&old===text){
   $('composer').value='';drafts.set(id+':'+t,'');
   $('composer').dispatchEvent(new Event('input'));
   delete $('compose-status').dataset.draftSaving;
   $('compose-status').textContent=manual?'已提交后台，进展见右侧':t!=='frontdesk'?'已补充此任务':'已接收';
  }else if(id===projectId){
   delete $('compose-status').dataset.draftSaving;
   $('compose-status').textContent='已接收上一稿，新输入仍保留';
  }
  await refresh().catch(error=>{if(id===projectId)toast('发送已接收，但状态刷新失败：'+error.message+'；不会自动重发。');});
  return result;
 }
 $('managed-submit-task').onclick=()=>window.__agentSend?.({background:true});
 const draftWriter=bindComposerDrafts({composer:$('composer'),current:()=>({projectId,target}),remember:({projectId,target,text})=>drafts.set(projectId+':'+target,text),persist:({projectId,target,text})=>call('draft',{target,text},projectId),onError:e=>toast('草稿保存失败：'+e.message),onInput:()=>{if(!active)return;const lifecycle=selectedSession();$('managed-submit-task').disabled=(!lifecycle.canSend&&lifecycle.state!=='ready')||!$('composer').value.trim();}});
 function renderTerminals(){
  if(!state)return;
  if(!terminalLayout)terminalLayout=createTerminalLayout({root:terminalBox,onVisibility:(t,v)=>{const instance=terminals.get(t);if(instance&&instance.layoutVisible!==v){instance.layoutVisible=v;instance.setVisible(v);}}});
  const targets=terminalTargets(state);
  for(const [t,instance] of terminals)if(!targets.includes(t)){instance.dispose();terminals.delete(t);}
  terminalLayout.update(state,t=>{
   const card=document.createElement('article');card.className='provider-role managed-agent-pane';card.dataset.managedTerminal=t;
   const h=document.createElement('header'),identity=document.createElement('div');identity.className='managed-agent-identity';
   const title=document.createElement('strong');identity.append(title);h.append(identity);
   const out=document.createElement('div');out.className='provider-output';
   const empty=document.createElement('div');empty.className='managed-terminal-empty';empty.textContent='正在准备终端…';out.append(empty);card.append(h,out);return card;
  },(t,card)=>{
   const w=state.works.find(w=>w.id===t),busy=state.busyTargets.includes(t),closing=w?.status==='closing';
   card.dataset.name=name(t);card.dataset.phase=w?.status||(busy?'running':'idle');card.querySelector('strong').textContent=name(t);
   const external=state.externalTerminalTargets?.includes(t);
   const out=card.querySelector('.provider-output');
   if(w?.readOnly){const view=terminals.get(t);if(view){terminals.delete(t);view.dispose();}out.replaceChildren(Object.assign(document.createElement('p'),{textContent:'历史会话只读；不会以 OMP 重连或重放原任务。'}));return;}
   if(deviationHeld(w)){const view=terminals.get(t);if(view){terminals.delete(t);view.dispose();}out.replaceChildren();const note=document.createElement('p');note.textContent='任务偏离暂停：原会话与部分成果保留，禁止原生输入、启动或重连；请在 Work 卡明确决定。只读终端投影与报告仍可查看。';out.append(note);card.querySelector('[data-terminal-recovery]')?.remove();delete out.dataset.autoAttachAttempted;return;}
   const agent=state.agents?.find(a=>a.target===t),transition=state.configuringTargets?.includes(t)||agent?.restarting;
   const view=terminals.get(t);
   if(view&&(agent?.closed||transition||(view.ownerId&&agent?.ownerId&&view.ownerId!==agent.ownerId)||(view.leaseId&&agent?.terminalId&&view.leaseId!==agent.terminalId))){
     terminals.delete(t);view.dispose();delete out.dataset.connectionId;delete out.dataset.autoAttachAttempted;
     out.dataset.terminalState=agent?.closed?'exited':'stale';out.replaceChildren();
   }
   if(agent?.closed&&!external)out.dataset.terminalState='exited';
   if(external&&terminals.has(t)){terminals.get(t).dispose();terminals.delete(t);out.replaceChildren();}
   if(external)out.dataset.terminalState='external';
   if(external||out.dataset.terminalState==='external'){let note=out.querySelector('.managed-terminal-empty');if(!note){note=document.createElement('div');note.className='managed-terminal-empty';out.append(note);}note.textContent=external?'系统终端正在操作此 Agent，会话保持同步。':'系统终端已断开，可重开或接回内置终端。';}
   const connection=out.dataset.terminalState,needsRetry=['exited','unavailable','external','stale'].includes(connection);
   let recovery=card.querySelector('[data-terminal-recovery]');
   if(needsRetry){
    if(!recovery){
     recovery=button('重新连接终端',async()=>{
       const id=projectId,gen=generation;recovery.disabled=true;
       try{
         await call('terminal.return',{target:t},id);
         const currentAgent=state.agents?.find(a=>a.target===t);
         if(currentAgent?.closed)await call('restart',{target:t},id);
         if(id!==projectId||gen!==generation)return;
         terminals.get(t)?.dispose();terminals.delete(t);out.dataset.autoAttachAttempted='true';
         await attach(t,out);await refresh();
       }finally{if(id===projectId&&gen===generation)recovery.disabled=false;}
     });
     recovery.dataset.terminalRecovery='';recovery.dataset.paneConnect='';card.querySelector('header').append(recovery);
    }
    recovery.textContent=connection==='external'?'接回内置终端':agent?.closed?'重新启动 Agent':'重新连接终端';
    recovery.disabled=!ready||busy||closing||transition;
   }else recovery?.remove();
  });
  if(ready)for(const t of targets){
   const card=terminalLayout.cards.get(t),out=card.querySelector('.provider-output'),w=state.works.find(w=>w.id===t);
   if(w?.readOnly||deviationHeld(w))continue;
   // Busy work may subscribe only when the host has already registered its PTY.
   // providers[target] is app-server ownership; only terminal:target denotes PTY.
   const agent=state.agents?.find(a=>a.target===t);
   if(!state.configuringTargets?.includes(t)&&!agent?.restarting&&!agent?.closed&&!state.externalTerminalTargets?.includes(t)&&out.dataset.terminalState!=='external'&&!terminals.has(t)&&!out.dataset.autoAttachAttempted&&(!state.busyTargets.includes(t)||state.providers?.['terminal:'+t])&&w?.status!=='closing'){
    out.dataset.autoAttachAttempted='true';const gen=generation;
    queueMicrotask(()=>{if(gen===generation&&active&&terminalLayout?.cards.get(t)===card)void attach(t,out).catch(error=>toast('终端连接失败：'+error.message));});
   }
  }
 }
 async function attach(t,out){
  if(state.works.find(w=>w.id===t)?.readOnly)throw Error('历史会话只读，不能连接原生终端。');
  if(deviationHeld(state.works.find(w=>w.id===t)))throw Error('任务偏离暂停中，请在 Work 卡明确决定。');
  if(terminals.has(t)){if(!['exited','unavailable','stale'].includes(out.dataset.terminalState))return;const old=terminals.get(t);terminals.delete(t);old.dispose();}
  const id=projectId,gen=generation,ownerId=state.agents?.find(a=>a.target===t)?.ownerId;out.replaceChildren();
  let instance;
  const current=()=>gen===generation&&id===projectId&&terminals.get(t)===instance&&(!instance.ownerId||!state.agents?.find(a=>a.target===t)?.ownerId||state.agents.find(a=>a.target===t).ownerId===instance.ownerId);
  const adapted=async(op,p)=>{try{
   if(op==='terminal.attach'){
    const r=await call('terminal.attach',{target:t,...(ownerId?{ownerId}:{})},id);
    if(!current()||(ownerId&&r.ownerId!==ownerId))return {ok:false,error:{code:'TERMINAL_STALE',message:'Agent 已变化，旧视图未附着。'}};
    instance.ownerId=r.ownerId??ownerId;instance.leaseId=r.terminalId;out.dataset.connectionId=r.terminalId;
    return {ok:true,value:{...r,available:true}};
   }
   if(op==='terminal.ack')return {ok:true,value:{}};
   if(op==='terminal.detach')return {ok:true,value:{detached:true}};
   if(!current())return {ok:false,error:{code:'TERMINAL_STALE',message:'终端连接已过期，请重新连接'}};
   if(op==='terminal.input')return {ok:true,value:await call('terminal.input',{target:t,terminalId:p.terminalId,data:p.data},id)};
   if(op==='terminal.resize')return {ok:true,value:await call('terminal.resize',{target:t,terminalId:p.terminalId,cols:p.cols,rows:p.rows},id)};
   throw Error('unsupported terminal action');
  }catch(e){return {ok:false,error:{code:e.code,message:e.message}};}};
  const subscribe=(_event,fn)=>window.nozeli.subscribe('agent',e=>{const lease=instance.leaseId??state.agents?.find(a=>a.target===t)?.terminalId;if(current()&&lease===e.terminalId&&e.projectId===id&&e.kind==='managed-terminal'&&e.target===t)fn({projectId:id,role:t,terminalId:e.terminalId,exitCode:e.exitCode,type:e.ended?'terminal.exit':'terminal.output',data:e.data,seq:e.seq});});
  instance=createProviderTerminal({container:out,invoke:adapted,subscribe,toast,onState:()=>{if(current()&&terminalLayout?.cards.get(t)?.contains(out))renderTerminals();}});
  instance.ownerId=ownerId;terminals.set(t,instance);renderTerminals();
  const r=await instance.attach({projectId:id,role:t});
  if(!current()){instance.dispose();return;}
  if(!r.available){terminals.delete(t);instance.dispose();out.replaceChildren();out.dataset.terminalState='unavailable';const error=document.createElement('div');error.className='managed-terminal-empty';error.textContent=r.reason||'连接失败，请重试';out.append(error);}
  renderTerminals();
 }
 function leaveHistory(){reportRequest++;if(!viewed?.history)return false;viewed=null;lockHistory();$('composer').disabled=false;toolbar.hidden=true;if(active)render();return true;}
 window.addEventListener('nozeli-content-closed',()=>{if(!leaveHistory()&&active)select('frontdesk');});
 window.addEventListener('nozeli-content-file-opened',leaveHistory);
 window.nozeli.subscribe('agent',e=>{if(e.kind==='managed-files-changed'&&e.projectId===projectId)void refreshProjectFiles().catch(error=>toast('文件链接列表读取失败：'+error.message));});
 window.nozeli.subscribe('agent',e=>{if(!active||e.projectId!==projectId)return;if(e.kind==='managed-state'){state=e.state;render();}if(e.kind==='managed-timeline'&&!historyPage){sessionStore.apply(projectId,e.timeline||e.frame,{replace:true});}if(e.kind==='managed-error')toast(e.text);});
 return {get active(){return active;},reachable:true,load,enable,send,refresh,clear(options){clear(options);if(options?.rememberDraft===false)projectId=null;},console:()=>{terminalBox.hidden=false;renderTerminals();},onReport:openTodo};
}
