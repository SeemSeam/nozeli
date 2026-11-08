import {hasReadableText,isImportantEntry,isProcessEntry,hasProcessPayload,processLabel,turnPresentation,replyPresentation,processSummary,messageRole} from './session-presentation.mjs';
import React,{memo,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {createRoot} from 'react-dom/client';
import {renderTagMarkdown} from './tag-markdown.mjs';
import {createFileIcon} from './file-icons.mjs';
import {groupSessionWorkflows,followTranscriptTail,updateTranscriptTailLock} from './session-store.mjs';
import {useReadingMarkdown} from './session-reading.mjs';
import './session-timeline.css';
import {taskIdentityKey,taskIdentityTone} from '../domain/task-identity.mjs';
import {taskPresentation} from './task-presentation.mjs';
import './task-identity.css';
function TaskCard({row,state,projectId,onResult,context,call}){
 const view=taskPresentation(row,state),tone=taskIdentityTone(taskIdentityKey(projectId,state,row));
 // Published/review events repeat the status. Keep a distinct live action or host
 // diagnostic when it helps explain work that is still active or held up.
 const detail=(view.running||['running','error','blocked','failed','interrupted','unknown','closing','paused'].includes(view.status))&&view.latest&&view.latest!=='尚无新的宿主事件'&&!view.label.includes(view.latest)?view.latest:null;
 const route=async action=>{const result=await window.nozeli.invoke('workspace.control',{type:'task-workspace',action,projectId,...(row.workId?{workId:row.workId}:{}),...(row.sourceJobId?{sourceJobId:row.sourceJobId}:{})});if(!result.ok)throw Error(result.error?.message||'任务未能打开');};
 const [error,setError]=useState('');
 return h('article',{className:'session-task-card','data-workflow-id':row.id,'data-workflow-work':row.workId||undefined,'data-task-tone':tone,'data-state':view.status,'aria-label':view.name+' · '+view.label},
  h('header',null,h('strong',{title:view.name},view.name),h('span',{className:'session-task-status',role:'status'},view.label)),
  detail&&h('p',{className:'session-task-detail'},detail),
  (view.returnKey||view.revision>1&&view.trail.length>0)&&h('div',{className:'session-task-trail'},view.returnKey&&h('span',null,'审阅 / 补充已回流'),view.trail.length>0&&h('span',null,view.trail.join(' · '))),
  h(TaskConversation,{row,state,context,call}),
  h('nav',{'aria-label':'任务操作'},view.publication&&h('button',{type:'button','data-task-action':'result',onClick:()=>Promise.resolve(onResult?onResult(view.publication):route('overview')).catch(error=>setError(error.message))},'查看成果'),h('button',{type:'button','data-task-action':'process',onClick:()=>route('process').catch(error=>setError(error.message))},'查看过程'),!view.publication&&h('button',{type:'button','data-task-action':'overview',onClick:()=>route('overview').catch(error=>setError(error.message))},'任务概览')),error&&h('small',{role:'alert'},error));
}
const h=React.createElement;
const Markdown=memo(function Markdown({text,context,settled=false}){
 const ref=useRef(null),[wrapped]=useState(()=>new Set());
 const render=useMemo(()=>(root,value,options)=>{
  renderTagMarkdown(root,value,options);
  root.querySelectorAll('pre').forEach((pre,index)=>{
   const code=pre.querySelector('code');if(!code)return;
   const block=document.createElement('div');block.className='session-code-block';
   const toolbar=document.createElement('div');toolbar.className='session-code-toolbar';
   const language=pre.querySelector('.conversation-code-language')||document.createElement('span');language.className='conversation-code-language';language.textContent||='text';
   const wrap=document.createElement('button');wrap.type='button';wrap.className='session-code-wrap';wrap.textContent='自动换行';wrap.setAttribute('aria-label','代码自动换行');
   const apply=()=>{pre.classList.toggle('session-code-wrapped',wrapped.has(index));wrap.setAttribute('aria-pressed',String(wrapped.has(index)));};
   wrap.addEventListener('click',()=>{if(wrapped.has(index))wrapped.delete(index);else wrapped.add(index);apply();});apply();
   toolbar.append(language,wrap);const copy=pre.querySelector('.conversation-copy');if(copy){copy.textContent='复制';copy.setAttribute('aria-live','polite');toolbar.append(copy);}
   pre.tabIndex=0;pre.setAttribute('aria-label',language.textContent+' 代码');
   pre.before(block);block.append(toolbar,pre);
  });
 },[wrapped]);
 useReadingMarkdown(ref,text,context,settled,render);
 return h('div',{ref,className:'session-markdown'});
});
function FileIcon({path}){const ref=useRef(null);useLayoutEffect(()=>{ref.current.replaceChildren(createFileIcon(path));},[path]);return h('span',{ref,'aria-hidden':true});}
// Discover immutable field descriptors, then retain only one host-bounded UTF-8 page.
// Originals use plain text: arbitrary page boundaries never become executable markup.
const CONTENT_PAGE=16*1024;
function Content({value,context,plain=false,settled=false}){
 const [page,setPage]=useState(0);
 const text=useMemo(()=>typeof value==='string'?value:JSON.stringify(value??'',null,2),[value]);
 const pages=Math.max(1,Math.ceil(text.length/CONTENT_PAGE)),current=Math.min(page,pages-1),chunk=text.slice(current*CONTENT_PAGE,(current+1)*CONTENT_PAGE);
 return h('section',{className:'session-content'},pages>1&&h('nav',{'aria-label':'原文分段'},h('span',null,'原文 '+(current+1)+' / '+pages+' 段 · 每段最多 '+CONTENT_PAGE+' 字符；纯文本分段不进行术语高亮'),h('button',{type:'button',disabled:current===0,onClick:()=>setPage(current-1)},'上一段'),h('button',{type:'button',disabled:current===pages-1,onClick:()=>setPage(current+1)},'下一段')),plain||pages>1?h('pre',{className:'session-plain'},chunk):h(Markdown,{text:chunk,context,settled}));
}
function Fold({label,children}){
 const [open,setOpen]=useState(false);
 return h('details',{className:'session-tool',open},h('summary',{onClick:event=>{event.preventDefault();setOpen(value=>!value);},'aria-expanded':open},label),open&&children);
}
function ToolCalls({calls,context}){
 const [page,setPage]=useState(0),pages=Math.ceil(calls.length/20);
 return h(React.Fragment,null,h('nav',{'aria-label':'工具调用分页'},pages>1&&h(React.Fragment,null,h('button',{type:'button',disabled:page===0,onClick:()=>setPage(page-1)},'上一组调用'),h('span',null,(page+1)+' / '+pages),h('button',{type:'button',disabled:page>=pages-1,onClick:()=>setPage(page+1)},'下一组调用'))),calls.slice(page*20,page*20+20).map((tool,index)=>h(Fold,{key:tool.id||index,label:(tool.name||'工具')+' · '+(tool.id||'调用参数')},h(Content,{value:tool.input,context,plain:true}))));
}
function NativeBody({entry,context}){
 return h(React.Fragment,null,entry.reasoning&&h(Fold,{label:'推理'},h(Content,{value:entry.reasoning,context})),entry.toolCalls?.length>0&&h(Fold,{label:'工具调用 · '+entry.toolCalls.length},h(ToolCalls,{calls:entry.toolCalls,context})),entry.tool?h(Fold,{label:h(React.Fragment,null,h('span',{className:'session-tool-name'},entry.tool.name||'工具'),' · ',h('span',{className:'session-tool-status','data-status':entry.tool.status||(entry.streaming?'running':'record')},entry.tool.status||(entry.streaming?'执行中':'记录')))},entry.tool.input!=null&&h(Content,{value:entry.tool.input,context,plain:true}),h(Content,{value:entry.tool.output??entry.text,context})):h(Content,{value:entry.text,context,settled:!entry.streaming}));
}
function ProcessRecords({entries,context,call}){
 const meaningful=entries.filter(hasProcessPayload),empty=entries.length-meaningful.length;
 return h('div',{className:'session-process-records'},meaningful.map(item=>h('section',{key:item.id,'data-process-entry':item.id,'data-message':item.id},h(Fold,{label:processLabel(item)},h(HistoricalModel,{entry:item}),item.availability==='read-required'?h(ReadOriginal,{entry:item,call}):item.tool?h(React.Fragment,null,item.tool.input!=null&&h(Content,{value:item.tool.input,context,plain:true}),h(Content,{value:item.tool.output??item.text,context,plain:true})):h(NativeBody,{entry:item,context})))),empty>0&&h('small',{className:'session-empty-records'},empty+' 条无正文状态记录已省略；未删除原始历史。'));
}
function ReadOriginal({entry,call}){
 const [state,setState]=useState({read:null,page:null,history:[],loading:false,error:''}),request=useRef(0);
 useLayoutEffect(()=>{setState({read:null,page:null,history:[],loading:false,error:''});return()=>{request.current++;};},[entry.id]);
 const load=async(read,field,offset=0,history=[])=>{
  const token=++request.current;setState(old=>({...old,read,loading:true,error:''}));
  try{const result=await call('timeline.read',{id:entry.id,version:read.version,field,offset,limit:CONTENT_PAGE});if(token!==request.current)return;const page=result.entry||result;if(page.availability!=='available')throw Error(page.reason||'原文当前不可读取');setState({read,page,history,loading:false,error:''});}
  catch(error){if(token===request.current)setState(old=>({...old,loading:false,error:error.message}));}
 };
 const open=async()=>{
  const token=++request.current;setState({read:null,page:null,history:[],loading:true,error:''});
  try{const result=await call('timeline.read',{id:entry.id});if(token!==request.current)return;const original=result.entry||result;if(!original.read?.fields?.length)throw Error(original.reason||'原文没有可读取字段');await load(original.read,original.read.fields[0].field);}
  catch(error){if(token===request.current)setState(old=>({...old,loading:false,error:error.message}));}
 };
 const close=()=>{request.current++;setState({read:null,page:null,history:[],loading:false,error:''});};
 const exportOriginal=async()=>{
  const token=++request.current;setState(old=>({...old,loading:true,error:''}));
  try{await call('timeline.export',{id:entry.id,version:entry.read.originalExport.version});if(token===request.current)setState(old=>({...old,loading:false}));}
  catch(error){if(token===request.current)setState(old=>({...old,loading:false,error:error.message}));}
 };
 const labels={text:'正文',reasoning:'推理 / Reasoning','tool.input':'工具输入','tool.output':'工具输出',toolCalls:'工具调用（JSON）'};
 return h('section',{className:'session-original'},h('p',null,entry.reason||'此消息需单独读取原文。'),entry.read?.originalExport&&h(React.Fragment,null,h('p',null,'原始JSON可能包含工具原文和内部路径；仅导出到可信本地位置。'),h('button',{type:'button',disabled:state.loading,onClick:exportOriginal},'导出完整原始记录')),state.loading&&h('p',{role:'status'},'读取原文…'),state.error&&h('p',{role:'alert'},state.error),state.read?h(React.Fragment,null,h('button',{type:'button',onClick:close},'关闭原文并释放缓存'),h('nav',{'aria-label':'原文字段'},state.read.fields.map(({field})=>h('button',{key:field,type:'button',disabled:state.loading,'aria-pressed':state.page?.field===field,onClick:()=>load(state.read,field)},labels[field]||field))),state.page&&h('section',{className:'session-content'},h('nav',{'aria-label':'原文分段'},h('span',null,`${state.page.offset}–${state.page.nextOffset??state.page.totalBytes} / ${state.page.totalBytes} UTF-8 字节 · 纯文本安全阅读`),h('button',{type:'button',disabled:state.loading||!state.history.length,onClick:()=>load(state.read,state.page.field,state.history.at(-1),state.history.slice(0,-1))},'上一段'),h('button',{type:'button',disabled:state.loading||state.page.nextOffset==null,onClick:()=>load(state.read,state.page.field,state.page.nextOffset,[...state.history,state.page.offset])},'下一段')),h('pre',{className:'session-plain'},state.page.content)),state.error&&h('button',{type:'button',disabled:state.loading,onClick:()=>load(state.read,state.page?.field||state.read.fields[0].field,state.page?.offset||0,state.history)},'重试读取')):h('button',{type:'button',disabled:state.loading,onClick:open},'读取原文（分段）'));
}
function HistoricalModel({entry}){
 if(entry.speaker!=='agent'||entry.hostTurnStatus)return null;
 return h('small',{'data-history-model':entry.model?'recorded':'not-recorded'},entry.model?(entry.provider||'来源未记录')+' / '+entry.model:'模型未记录');
}
const Message=memo(function Message({entry,entries,state,context,onTask,call,unbound=false}){
 const process=entries?.filter(item=>item!==entry&&!item.hostTurnStatus)||[];
 const execution=entry.speaker==='user'||unbound?null:turnPresentation(entries||[entry],state);
 const role=messageRole(entry,state,{unbound});
 const name=role==='user'?'你':role==='system'?(entry.speaker==='tool'?'工具':'Nozeli'):role==='frontdesk'?'前台':role==='orchestrator'?'主控':'Worker';
 const background=Boolean(entry.taskRequestId)||entry.target==='orchestrator'||Boolean(entry.workId);
 // Only genuine background routing carries a provenance badge; foreground is the default and stays implicit.
 const inputRoute=role==='user'&&background?'background':null;
 const [copyState,setCopyState]=useState('idle');
 const [menuOpen,setMenuOpen]=useState(false);const menuRef=useRef(null);
 useEffect(()=>{
  if(!menuOpen)return;
  const dismiss=event=>{if(event.key==='Escape'||!menuRef.current?.contains(event.target))setMenuOpen(false);};
  document.addEventListener('keydown',dismiss,true);document.addEventListener('pointerdown',dismiss,true);
  return()=>{document.removeEventListener('keydown',dismiss,true);document.removeEventListener('pointerdown',dismiss,true);};
 },[menuOpen]);
 useLayoutEffect(()=>setCopyState('idle'),[entry.id,entry.text]);
 const copy=async()=>{
  if(copyState==='pending')return;setCopyState('pending');
  try{const result=await window.nozeli.invoke('document.clipboard',{action:'write',text:entry.text||''});if(!result.ok)throw Error(result.error?.message||'复制失败');setCopyState('copied');}
  catch(error){setCopyState('failed');context?.onError?.(error);}
 };
 if(isProcessEntry(entry)&&!entries&&!unbound)return hasProcessPayload(entry)?h('div',{className:'session-process-only','data-message':entry.id},h(ProcessRecords,{entries:[entry],context,call})):null;
 return h('article',{className:'session-message','data-message':entry.id,'data-managed-message':entry.id,'data-source':entry.source,'data-role':role,'aria-label':name+'的消息'},
  h('header',null,h('strong',null,name),inputRoute&&h('span',{className:'session-input-route','data-input-route':inputRoute,title:'此消息已提交后台处理；不表示任务已经执行完成'},'后台任务'),h(HistoricalModel,{entry}),execution&&h('span',{className:'session-execution-state','data-execution-state':execution.status,role:'status'},execution.label),entry.source==='legacy'&&h('small',null,'只读历史'),entry.source==='demo-fixture'&&h('small',{'data-demo-badge':true},'演示内容 · 离线固定回复'),entry.at&&h('time',{dateTime:entry.at,title:new Date(entry.at).toLocaleString()},new Date(entry.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))),
  entry.speaker==='agent'&&(entry.failed||entry.status==='failed')&&h('p',{role:'alert','data-reply-state':'failed'},'本次回复失败，原输入和记录已保留；不会自动重发。'),
  entry.speaker==='tool'&&isImportantEntry(entry)&&h('p',{role:'alert'},'工具执行受阻；原始诊断保留在下方详情中。'),
  entry.attachments?.length>0&&h('div',{className:'message-attachments'},entry.attachments.map((attachment,index)=>h('button',{key:attachment.digest||index,type:'button',className:'cm-chip cm-chip-main','data-digest':attachment.digest,title:'发送时冻结的材料 · '+attachment.name,onClick:()=>attachment.digest&&window.__openMaterialAttachment?.(attachment)},h(FileIcon,{path:attachment.name||'image.png'}),h('span',null,attachment.name||'图片材料')))),
  entry.materialSources?.length>0&&h(Fold,{label:(entry.materialSources.every(source=>source.kind==='web')?'网页材料':'选区来源')+' · '+entry.materialSources.length},entry.materialSources.map((source,index)=>h('section',{key:source.annotationId||index},h('p',null,source.kind==='web'?(source.title||source.url):h(React.Fragment,null,h('span',{className:'session-file-path'},source.relPath),(source.location?' · '+source.location:'')+(source.changed?' · 原版选区，当前版本已变化':''))),source.kind==='web'&&h('p',null,source.url),h('blockquote',null,source.quote),h('small',null,'版本 '+source.materialDigest)))),
  entry.drawingSources?.length>0&&h(Fold,{label:'涂鸦截图来源'},entry.drawingSources.map((image,index)=>h('section',{key:image.digest||index},image.sources?.length?image.sources.map((source,i)=>h('p',{key:source.sourceId||i},source.relPath?h('span',{className:'session-file-path'},source.relPath):'工作区画面',' · '+(source.locationStatus||'viewport-only')+(source.bufferDigest?' · 版本 '+source.bufferDigest:''))):h('p',null,'工作区截图，未锚定文件')))),
  process.length>0&&h(Fold,{label:processSummary(process,execution)},h(ProcessRecords,{entries:process,context,call})),
  entry.availability==='read-required'?h(ReadOriginal,{entry,context,call}):h(NativeBody,{entry,context}),
  entry.availability!=='read-required'&&hasReadableText(entry)&&!isProcessEntry(entry)&&(!entries||entries.includes(entry))&&h('details',{className:'message-actions','data-message-actions-menu':'',ref:menuRef,open:menuOpen},h('summary',{'data-message-actions-toggle':'','aria-label':name+'的消息操作','aria-haspopup':'menu','aria-expanded':menuOpen,onClick:event=>{event.preventDefault();setMenuOpen(value=>!value);}},'更多'),h('div',{className:'message-actions-list',role:'menu'},h('button',{type:'button',role:'menuitem','data-message-action':'quote',onClick:()=>{setMenuOpen(false);window.__composerMaterials?.setQuote({role:role==='orchestrator'?'orchestrator':entry.speaker,text:entry.text,time:entry.at||''});}},'引用'),h('button',{type:'button',role:'menuitem','data-message-action':'copy',onClick:copy,disabled:copyState==='pending','data-message-copy':copyState,'aria-live':'polite'},copyState==='pending'?'正在复制…':copyState==='copied'?'已复制纯文本':copyState==='failed'?'复制失败，重试':'复制纯文本'),onTask&&!background&&entry.source!=='legacy'&&h('button',{type:'button',role:'menuitem','data-message-action':'task',onClick:()=>{setMenuOpen(false);onTask(entry);}},'转为后台任务'))));
});
function Reply({row,...props}){
 const {answer,entry}=replyPresentation(row.entries,props.state);
 return h(Message,{...props,onTask:answer?.speaker==='agent'?props.onTask:null,entry,entries:row.entries});
}
function TaskConversation({row,state,context,call}){
 const seen=new Set(),messages=[];
 for(const part of row.rows)for(const entry of part.entries||(part.entry?[part.entry]:[])){
  if(seen.has(entry.id))continue;seen.add(entry.id);
  // Programmatic Worker handoffs remain in process, not user-authored discussion.
  if(entry.speaker==='user'&&entry.source==='host'&&(entry.originalTask||messageRole(entry,state)==='orchestrator'))continue;
  const conversational=entry.speaker==='user'||entry.speaker==='agent'&&!entry.tool&&!entry.toolCalls?.length&&(hasReadableText(entry)||entry.availability==='read-required');
  if(!entry.publication&&(conversational||part.unbound||isImportantEntry(entry)))messages.push({entry,unbound:part.unbound});
 }
 messages.sort((a,b)=>(a.entry.sequence??0)-(b.entry.sequence??0)||a.entry.id.localeCompare(b.entry.id));
 return h('section',{className:'session-task-conversation','aria-label':'任务对话与讨论'},messages.map(({entry,unbound})=>h(Message,{key:entry.id,entry,unbound,state,context,call})),!messages.length&&h('p',{className:'session-task-history-note'},'此页没有任务对话；原输入和完整记录可在“查看过程”读取。'));
}
function FrozenFiles({receipt,call,openFrozenChange,projectId}){
 const changeSetId=receipt.changeSetId||receipt.snapshot?.changeSetId;
 const [state,setState]=useState({files:[],loading:true,error:null,nextOffset:null,total:null,offset:0,requestOffset:0});
 const request=useRef(0);
 const load=async(offset=0)=>{
  const token=++request.current;setState(old=>({...old,loading:true,error:null,requestOffset:offset}));
  try{const page=await call('changes.list',{changeSetId,offset,limit:100});if(token!==request.current)return;setState({files:page.files.slice(0,100),loading:false,error:null,nextOffset:page.nextOffset,total:page.total,offset,requestOffset:offset});}
  catch(error){if(token===request.current)setState(old=>({...old,loading:false,error:error.message}));}
 };
 const openMaterial=async(file)=>{
  const token=request.current;
  try{const documentSource=!file.after&&file.before?{type:'review-version',workId:receipt.workId,objectId:receipt.objectId,version:{kind:'baseline'}}:{type:'review',workId:receipt.workId,objectId:receipt.objectId};const result=await window.nozeli.invoke('workspace.control',{type:'open-file',projectId,relPath:file.path,documentSource});if(!result.ok)throw Error(result.error?.message||'冻结成果无法打开');}
  catch(error){if(token===request.current)setState(old=>({...old,error:error.message}));}
 };
 useLayoutEffect(()=>{setState({files:[],loading:true,error:null,nextOffset:null,total:null,offset:0,requestOffset:0});if(changeSetId)void load();return()=>{request.current++;};},[changeSetId,projectId]);
 if(!changeSetId)return h('section',{className:'session-frozen-files'},'冻结变更不可用：此轮没有已绑定的变更集；未用模型清单或当前文件替代。');
 return h('section',{className:'session-frozen-files','data-change-set':changeSetId,'aria-label':'本轮冻结变更文件'},
  h('h4',null,'冻结变更',state.total==null?' · 文件数量未知':' · '+state.total+' 个文件'),h(Fold,{label:'版本依据'},'相对本次工作输入的冻结版本，不以当前文件代替。'),
  h('ul',null,state.files.map(file=>{const path=file.path,label=file.oldPath&&file.oldPath!==path?file.oldPath+' → '+path:path,hasMaterial=receipt.workId&&receipt.objectId&&(file.after||file.before),openDiff=()=>Promise.resolve(openFrozenChange?.({projectId,changeSetId,fileId:file.fileId})).catch(error=>setState(old=>({...old,error:error.message})));return h('li',{key:file.fileId},h('button',{type:'button','data-frozen-file':file.fileId,title:hasMaterial?'查看本轮成果内容与实际效果；已删除文件显示修改前':'查看本轮冻结差异；此记录没有可打开的成果版本',onClick:()=>hasMaterial?void openMaterial(file):void openDiff()},h(FileIcon,{path}),h('span',{className:'session-file-path'},label),h('small',{className:'session-file-status'},h('span',{'data-file-status':file.status},file.status),file.added!=null&&h('span',{className:'session-file-added'},' +'+file.added),file.deleted!=null&&h('span',{className:'session-file-deleted'},' −'+file.deleted))),hasMaterial&&h('button',{type:'button',className:'session-result-material','data-frozen-diff':file.fileId,title:'查看输入基线与发布冻结候选的只读代码差异',onClick:()=>void openDiff()},'代码差异'));})),
  state.loading&&h('p',{role:'status'},'读取冻结清单…'),state.error&&h('p',{role:'alert'},state.error,h('button',{type:'button',disabled:state.loading,onClick:()=>load(state.requestOffset)},'重试读取')),h('nav',{'aria-label':'冻结文件分页'},h('span',null,state.total?'第 '+(state.offset+1)+'–'+(state.offset+state.files.length)+' / '+state.total+' 个文件':''),state.offset>0&&h('button',{type:'button',disabled:state.loading,onClick:()=>load(Math.max(0,state.offset-100))},'上一页变更文件'),state.nextOffset!=null&&h('button',{type:'button',disabled:state.loading,onClick:()=>load(state.nextOffset)},'更多变更文件')));
}
function TimelineRow({row,...props}){
 const {state,context,call,projectId,onTask}=props;
 if(row.kind==='workflow')return h(TaskCard,{row,state,projectId,onResult:props.onResult,context,call});
 if(row.kind==='reply')return h(Reply,{row,state,context,onTask,call});
 if(row.kind==='delta')return h('article',{className:'session-host-delta','data-host-delta':row.delta.id},h('strong',null,'Nozeli · '+row.delta.kind),h(Content,{value:row.delta.text,context}));
 return h(Message,{entry:row.entry,unbound:row.unbound,state,context,onTask,call});
}
function Timeline({store,state,context,call,openFrozenChange,projectId,onTask,onResult,onPage,onLatest,historyPage,pageError,navigationContainer,initialScroll}){
 const snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot),ref=useRef(null),lock=useRef({current:true}),restoreTail=useRef(null),history=useRef(historyPage);
 const [atBottom,setAtBottom]=useState(true);history.current=historyPage;
 const restoration=useRef(initialScroll);
 const latestRequested=useRef(false);
 useLayoutEffect(()=>{store.setHistoryPage(Boolean(historyPage));return()=>store.setHistoryPage(false);},[store,historyPage]);
 useLayoutEffect(()=>{
  const scroll=ref.current.closest('#conversation'),doc=scroll.ownerDocument;let composing=false;
  const selected=()=>{const selection=doc.getSelection();return selection&&!selection.isCollapsed;};
  const measure=()=>setAtBottom(scroll.scrollHeight-scroll.scrollTop-scroll.clientHeight<=40);
  const update=()=>{const saved=restoration.current;if(saved&&Math.abs(scroll.scrollTop-Math.min(saved.top,Math.max(0,scroll.scrollHeight-scroll.clientHeight)))>1/32)scroll.scrollTop=saved.top;if(!latestRequested.current)updateTranscriptTailLock(scroll,lock.current);if(selected()||composing)lock.current.current=false;measure();};
  const selection=()=>{if(selected()){latestRequested.current=false;lock.current.current=false;}};
  const start=()=>{composing=true;latestRequested.current=false;},end=()=>{composing=false;};
  const follow=()=>{const saved=restoration.current;if(saved&&ref.current.children.length>1){lock.current.current=false;scroll.scrollTop=saved.top;measure();return;}if(latestRequested.current&&!history.current){lock.current.current=true;followTranscriptTail(scroll,lock.current);}else{if(selected()||composing)lock.current.current=false;if(!history.current)followTranscriptTail(scroll,lock.current);}measure();};
  restoreTail.current=follow;const observer=new ResizeObserver(follow);observer.observe(ref.current);
  const interact=()=>{restoration.current=null;latestRequested.current=false;};scroll.addEventListener('wheel',interact,{passive:true});scroll.addEventListener('pointerdown',interact);doc.addEventListener('keydown',interact);
  scroll.addEventListener('scroll',update,{passive:true});doc.addEventListener('selectionchange',selection);doc.addEventListener('compositionstart',start,true);doc.addEventListener('compositionend',end,true);
  return()=>{restoration.current=null;scroll.removeEventListener('wheel',interact);scroll.removeEventListener('pointerdown',interact);doc.removeEventListener('keydown',interact);restoreTail.current=null;observer.disconnect();scroll.removeEventListener('scroll',update);doc.removeEventListener('selectionchange',selection);doc.removeEventListener('compositionstart',start,true);doc.removeEventListener('compositionend',end,true);};
 },[]);
 useLayoutEffect(()=>{restoreTail.current?.();},[snapshot,state.receipts]);
 const latest=()=>{restoration.current=null;latestRequested.current=true;lock.current.current=true;if(historyPage)onLatest();else{restoreTail.current?.();setAtBottom(true);}};
 const rows=groupSessionWorkflows(snapshot,state.receipts,state);
 return h(React.Fragment,null,h('div',{ref,className:'session-timeline','data-session-version':'1',onToggleCapture:()=>{lock.current.current=false;}},h('nav',{'aria-label':'会话历史'},snapshot.hasMore&&h('button',{type:'button',onClick:()=>{lock.current.current=false;onPage(snapshot.nextCursor);}},'读取更早一页'),pageError&&h('p',{role:'alert'},pageError)),
  !rows.length&&h('p',{className:'session-empty'},'会话记录将在这里显示。输入和材料不会自动发送。'),rows.map(row=>h(TimelineRow,{key:row.id,row,state,context,call,openFrozenChange,projectId,onTask,onResult}))),
  createPortal((historyPage||!atBottom)?h('button',{type:'button',className:'session-jump-latest',onClick:latest},h('span',{'aria-hidden':true},'↓ '),historyPage?'返回最新消息':'回到最新'):null,navigationContainer));
}
export function mountSessionTimeline(container,props){const root=createRoot(container);return {render(next){const merged={...props,...next};root.render(h(Timeline,{...merged,key:merged.projectId}));},destroy(){root.unmount();}};}
function TaskProcess({snapshot,state,context,call,openFrozenChange,projectId,onPage,onLatest,loading,error}){
 const pageReceipts=(state.receipts||[]).filter(receipt=>snapshot.entries.some(entry=>Boolean(receipt.objectId)&&entry.objectId===receipt.objectId||Boolean(receipt.jobId||receipt.sourceJobId)&&entry.jobId===(receipt.jobId||receipt.sourceJobId)));
 const records=[...snapshot.entries.map(entry=>({id:entry.id,sequence:entry.sequence,entry})),...(snapshot.deltas||[]).map(delta=>({id:delta.id,sequence:delta.sequence,delta}))].sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.id.localeCompare(b.id));
 return h('div',{'data-task-process':true},
  h('nav',{'aria-label':'任务过程分页'},snapshot.hasMore&&h('button',{type:'button','data-task-page':'earlier',disabled:loading,onClick:()=>onPage(snapshot.nextCursor)},'更早一页'),h('button',{type:'button','data-task-page':'latest',disabled:loading,onClick:onLatest},'读取最新')),
  loading&&h('p',{role:'status'},'读取过程…'),error&&h('p',{role:'alert'},error),!records.length&&!loading&&h('p',null,'此页没有可读取记录。'),
  records.map(({id,entry,delta})=>delta?h('article',{key:id,'data-host-delta':id},h('strong',null,'Nozeli · '+delta.kind),h(Content,{value:delta.text,context,plain:true})):h('article',{key:id,'data-process-entry':entry.id,'data-role':messageRole(entry,state),className:'session-process-record'},
   h('header',null,h('strong',null,entry.speaker==='user'?'用户输入':entry.target==='orchestrator'?'主控':entry.target==='frontdesk'?'前台':'执行记录'),h('small',null,entry.at||'',entry.revision!=null?' · 修订 '+entry.revision:'')),
   h(HistoricalModel,{entry}),entry.availability==='read-required'?h(ReadOriginal,{entry,call}):h(NativeBody,{entry,context}),
   entry.attachments?.length>0&&h('div',{className:'message-attachments'},entry.attachments.map((attachment,index)=>h('button',{key:attachment.digest||index,type:'button',disabled:!attachment.digest||!window.__openMaterialAttachment,title:'发送时冻结的材料',onClick:()=>window.__openMaterialAttachment?.(attachment)},attachment.name||'冻结材料'))),
   (entry.materialSources?.length>0||entry.drawingSources?.length>0)&&h(Fold,{label:'冻结选区与材料来源'},h(Content,{value:{materialSources:entry.materialSources,drawingSources:entry.drawingSources},context,plain:true})))),
  pageReceipts.map(receipt=>h(FrozenFiles,{key:receipt.id||receipt.objectId,receipt,call,openFrozenChange,projectId})));
}
export function mountTaskProcess(container,props){const root=createRoot(container);return {render(next){root.render(h(TaskProcess,{...props,...next}));},destroy(){root.unmount();}};}
