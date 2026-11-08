import {mountTaskProcess} from './session-timeline.mjs';
import {taskIdentityKey,taskIdentityTone} from '../domain/task-identity.mjs';
import {taskPresentation} from './task-presentation.mjs';
import './task-workspace.css';

// A trusted, scope-bound reader. Conversation transport and drafts never mount here.
export async function mountTaskWorkspace({root,scope,invoke,subscribe}){
 const projectId=scope.projectId,taskScope=Object.freeze({...scope.viewState?.taskScope});
 if(!projectId||(!taskScope.workId&&!taskScope.sourceJobId)){root.ownerDocument.defaultView.__nozeliInitError={code:'TASK_SCOPE_MISSING',message:'任务阅读身份缺失'};throw Error('任务阅读身份缺失');}
 const doc=root.ownerDocument,win=doc.defaultView,pages=new Map();
 let state={},current=null,disposed=false,composing=false,saveTimer=0,saveQueue=Promise.resolve();
 const host=doc.createElement('section');host.className='task-workspace-surface';host.setAttribute('aria-label','只读任务工作面');root.replaceChildren(host);
 const applyFont=value=>{if(Number.isFinite(value))host.style.setProperty('--conversation-font',Math.max(11,Math.min(24,value))+'px');};
 applyFont(scope.workspace?.conversationFontSize??scope.viewState?.workspace?.conversationFontSize);
 const call=async(op,params={})=>{
  if(disposed)throw Error('任务阅读面已关闭');
  const result=await invoke('managed.'+op,{...params,...(op==='timeline.page'?taskScope:{}),projectId});
  if(!result.ok)throw Object.assign(Error(result.error?.message||'任务读取失败'),{code:result.error?.code});
  return result.value;
 };
 const fail=(page,error)=>{page.status.textContent=error.message;page.status.setAttribute('role','alert');};
 const button=(label,run)=>{const b=doc.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>void Promise.resolve().then(run).catch(error=>fail(pages.get(current),error));return b;};
 function reading(page){const selection=doc.getSelection();return page.reading||composing||Boolean(selection&&!selection.isCollapsed&&page.root.contains(selection.anchorNode));}
 function save(){
  if(!current||disposed)return saveQueue;
  clearTimeout(saveTimer);
  const taskReading=Object.fromEntries([...pages].map(([mode,page])=>[mode,{scrollTop:page.root.scrollTop,cursor:page.cursor||null}]));
  const viewState={...scope.viewState,taskScope:{...taskScope},taskMode:current,taskReading};scope.viewState=viewState;
  saveQueue=saveQueue.catch(()=>{}).then(async()=>{const r=await invoke('workspace.command',{projectId,requestKey:crypto.randomUUID(),command:{type:'restoreViewState',viewId:scope.viewId,viewState}});if(!r.ok)throw Error(r.error?.message||'阅读位置未保存');});
  return saveQueue;
 }
 function scheduleSave(){clearTimeout(saveTimer);saveTimer=win.setTimeout(()=>void save().catch(error=>fail(pages.get(current),error)),250);}
 async function route(action,section){const result=await invoke('workspace.control',{type:'task-workspace',action,...(section?{section}:{}),...taskScope,projectId});if(!result.ok||result.value?.routed===false)throw Error(result.error?.message||'原任务入口当前不可用；未创建新会话。');}
 function updateIdentity(page){const view=taskPresentation(taskScope,state);page.root.dataset.taskTone=taskIdentityTone(taskIdentityKey(projectId,state,taskScope));page.heading.textContent='任务过程 · '+view.name;page.status.textContent='当前：'+view.label;page.status.removeAttribute('role');doc.title=page.heading.textContent;}
 const openFrozenChange=async target=>{const result=await invoke('workspace.control',{type:'report',projectId,report:{kind:'diff',target}});if(!result.ok)throw Error(result.error?.message||'冻结差异当前不可打开');};
 function render(page){page.ui.render({snapshot:page.snapshot||{entries:[],deltas:[],hasMore:false},state,context:{onError:error=>fail(page,error)},call,openFrozenChange,projectId,loading:page.loading,error:page.error,onPage:cursor=>read(page,cursor),onLatest:()=>{page.reading=false;page.dirty=false;void read(page);}});}
 async function read(page,cursor,{automatic=false}={}){
  const serial=++page.request;page.loading=true;page.error='';if(!automatic)render(page);
  try{
   const snapshot=await call('timeline.page',{...(cursor?{cursor}:{}),limit:100});
   if(disposed||serial!==page.request)return;
   if(automatic&&reading(page)){page.loading=false;page.dirty=true;return;}
   const scroll=page.root.scrollTop,again=page.dirty;page.cursor=cursor||null;page.snapshot=snapshot;page.loading=false;page.dirty=false;render(page);
   win.requestAnimationFrame(()=>{if(!disposed)page.root.scrollTop=page.restoreScroll??scroll;page.restoreScroll=null;});scheduleSave();
   if(again&&!page.cursor&&!reading(page))void read(page,undefined,{automatic:true});
  }catch(error){if(disposed||serial!==page.request)return;page.loading=false;page.error=error.message;render(page);}
 }
 function refresh(){const page=pages.get('process');if(!page||page.cursor||reading(page))return;if(page.loading){page.dirty=true;return;}void read(page,undefined,{automatic:true});}
 function open(mode,{focus=false}={}){
  mode=mode==='overview'?'overview':'process';current=mode;
  for(const page of pages.values())page.root.hidden=true;
  let page=pages.get(mode);
  if(!page){
   const content=doc.createElement('section'),heading=doc.createElement('h2'),toolbar=doc.createElement('nav'),status=doc.createElement('p'),body=doc.createElement('div');content.className='task-workspace-page';content.tabIndex=-1;toolbar.setAttribute('aria-label','任务阅读操作');status.setAttribute('aria-live','polite');
   page={root:content,heading,status,body,reading:false,dirty:false,request:0,cursor:scope.viewState?.taskReading?.[mode]?.cursor||null,restoreScroll:scope.viewState?.taskReading?.[mode]?.scrollTop||0};pages.set(mode,page);
   toolbar.append(button(mode==='process'?'任务概览':'查看过程',()=>route(mode==='process'?'overview':'process')),button('定位原卡',()=>route('locate')));content.append(toolbar,heading,status,body);host.append(content);
   content.addEventListener('scroll',scheduleSave,{passive:true});for(const event of ['wheel','pointerdown','keydown'])content.addEventListener(event,()=>{page.reading=true;},{passive:true});
   if(mode==='process'){page.ui=mountTaskProcess(body,{});page.initialRead=read(page,page.cursor);}
   else{
    const note=doc.createElement('p');note.textContent='只读任务概览。查看不会发送消息；控制、成果与历史版本经原工作区受控入口打开。';body.append(note);
    for(const [label,section] of taskScope.workId? [['任务详情与控制','details'],['报告与审阅','report'],['保留进展（非完整过程）','control'],['历史版本','versions']]:[['请求详情与控制','request']])body.append(button(label,()=>route('inspect',section)));
    const original=doc.createElement('pre');original.textContent=(state.jobs||[]).find(job=>job.id===taskScope.sourceJobId)?.context?.userGoal||'';body.append(original);
   }
  }
  page.root.hidden=false;updateIdentity(page);if(focus)page.root.focus({preventScroll:true});scheduleSave();
  return page.initialRead;
 }
 const unsubscribers=[subscribe('agent',event=>{if(event.projectId!==projectId||disposed)return;if(event.kind==='managed-state'){state=event.state||{};for(const page of pages.values())updateIdentity(page);}if(event.kind==='managed-timeline')refresh();}),subscribe('session.flush',async()=>{if(composing)return {ok:false,composing:true};try{await save();return {ok:true};}catch(error){return {ok:false,error:{code:'TASK_READING_SAVE_FAILED',message:error.message}};}}),subscribe('workspace.control',event=>{
  if(event.type==='host'){
   const incoming=event.viewState?.taskScope;
   if(event.projectId!==projectId||event.viewId!==scope.viewId||event.kind!=='task-process'||event.resourceId!==scope.resourceId||event.readOnly!==true||!incoming||incoming.workId!==taskScope.workId||incoming.sourceJobId!==taskScope.sourceJobId||Object.keys(incoming).some(key=>!['workId','sourceJobId'].includes(key))||event.generation<scope.generation)return;
   scope.windowId=event.windowId;scope.generation=event.generation;scope.viewState={...scope.viewState,...event.viewState,taskScope:{...taskScope}};applyFont(event.workspace?.conversationFontSize);open(event.viewState.taskMode,{focus:false});return;
  }
  if(event.type==='task-workspace'&&event.projectId===projectId&&['process','overview'].includes(event.action))open(event.action,{focus:true});
  else if(event.type==='focus-content')pages.get(current)?.root.focus({preventScroll:true});
  else if(event.type==='transfer-hold'||event.type==='lifecycle-hold')host.inert=event.held===true;
  else if(event.type==='settings')applyFont(event.workspace?.conversationFontSize);
 })];
 host.addEventListener('compositionstart',()=>{composing=true;});host.addEventListener('compositionend',()=>{composing=false;});
 win.addEventListener('beforeunload',()=>{disposed=true;clearTimeout(saveTimer);for(const unsubscribe of unsubscribers)unsubscribe?.();for(const page of pages.values())page.ui?.destroy();},{once:true});
 try{
  const ready=await invoke('workspace.ready',{});if(!ready.ok)throw Error(ready.error?.message||'任务工作面未就绪');
  const status=await call('status');state=status.state||{};await open(scope.viewState?.taskMode);
  const result=await invoke('workspace.ready',{contentReady:true});if(!result.ok)throw Error(result.error?.message||'任务内容未就绪');win.__nozeliReady=true;
 }catch(error){const failure={code:error.code||'TASK_READING_FAILED',message:error.message};win.__nozeliInitError=failure;host.textContent='任务过程无法读取：'+error.message;host.setAttribute('role','alert');await invoke('workspace.ready',{contentFailed:true,error:failure});}
}
