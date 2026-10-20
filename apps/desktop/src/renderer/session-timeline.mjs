import React,{memo,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {renderTagMarkdown} from './tag-markdown.mjs';
import {createFileIcon} from './file-icons.mjs';
import {groupSession,followTranscriptTail,updateTranscriptTailLock} from './session-store.mjs';
import {SessionReading,useReadingMarkdown} from './session-reading.mjs';
import './session-timeline.css';
const h=React.createElement;
const Markdown=memo(function Markdown({text,context,settled=false}){
 const ref=useRef(null);
 useReadingMarkdown(ref,text,context,settled,renderTagMarkdown);
 return h('div',{ref,className:'session-markdown agent-message-body'});
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
 return h('details',{className:'session-tool',onToggle:event=>setOpen(event.currentTarget.open)},h('summary',null,label),open&&children);
}
function ToolCalls({calls,context}){
 const [page,setPage]=useState(0),pages=Math.ceil(calls.length/20);
 return h(React.Fragment,null,h('nav',{'aria-label':'工具调用分页'},pages>1&&h(React.Fragment,null,h('button',{type:'button',disabled:page===0,onClick:()=>setPage(page-1)},'上一组调用'),h('span',null,(page+1)+' / '+pages),h('button',{type:'button',disabled:page>=pages-1,onClick:()=>setPage(page+1)},'下一组调用'))),calls.slice(page*20,page*20+20).map((tool,index)=>h(Fold,{key:tool.id||index,label:(tool.name||'工具')+' · '+(tool.id||'调用参数')},h(Content,{value:tool.input,context,plain:true}))));
}
function NativeBody({entry,context}){
 return h(React.Fragment,null,entry.reasoning&&h(Fold,{label:'推理 / Reasoning'},h(Content,{value:entry.reasoning,context})),entry.toolCalls?.length>0&&h(Fold,{label:'工具调用 · '+entry.toolCalls.length},h(ToolCalls,{calls:entry.toolCalls,context})),entry.tool?h(Fold,{label:(entry.tool.name||'工具')+' · '+(entry.tool.status||(entry.streaming?'执行中':'记录'))},entry.tool.input!=null&&h(Content,{value:entry.tool.input,context,plain:true}),h(Content,{value:entry.tool.output??entry.text,context})):h(Content,{value:entry.text,context,settled:!entry.streaming}));
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
 const labels={text:'正文',reasoning:'推理 / Reasoning','tool.input':'工具输入','tool.output':'工具输出',toolCalls:'工具调用（JSON）'};
 return h('section',{className:'session-original'},h('p',null,entry.reason||'此消息需单独读取原文。'),state.loading&&h('p',{role:'status'},'读取原文…'),state.error&&h('p',{role:'alert'},state.error),state.read?h(React.Fragment,null,h('button',{type:'button',onClick:close},'关闭原文并释放缓存'),h('nav',{'aria-label':'原文字段'},state.read.fields.map(({field})=>h('button',{key:field,type:'button',disabled:state.loading,'aria-pressed':state.page?.field===field,onClick:()=>load(state.read,field)},labels[field]||field))),state.page&&h('section',{className:'session-content'},h('nav',{'aria-label':'原文分段'},h('span',null,`${state.page.offset}–${state.page.nextOffset??state.page.totalBytes} / ${state.page.totalBytes} UTF-8 字节 · 纯文本安全阅读`),h('button',{type:'button',disabled:state.loading||!state.history.length,onClick:()=>load(state.read,state.page.field,state.history.at(-1),state.history.slice(0,-1))},'上一段'),h('button',{type:'button',disabled:state.loading||state.page.nextOffset==null,onClick:()=>load(state.read,state.page.field,state.page.nextOffset,[...state.history,state.page.offset])},'下一段')),h('pre',{className:'session-plain'},state.page.content)),state.error&&h('button',{type:'button',disabled:state.loading,onClick:()=>load(state.read,state.page?.field||state.read.fields[0].field,state.page?.offset||0,state.history)},'重试读取')):h('button',{type:'button',disabled:state.loading,onClick:open},'读取原文（分段）'));
}
const Message=memo(function Message({entry,entries,context,onTask,call}){
 const process=entries?.filter(item=>item!==entry)||[];
 const streaming=entries?entries.some(item=>item.streaming):entry.streaming;
 const name=entry.speaker==='user'?'你':entry.speaker==='system'?'Nozeli':entry.target==='frontdesk'?'前台':entry.target==='orchestrator'?'Orchestrator':'Worker';
 const [copyState,setCopyState]=useState('idle');
 useLayoutEffect(()=>setCopyState('idle'),[entry.id,entry.text]);
 const copy=async()=>{
  if(copyState==='pending')return;setCopyState('pending');
  try{const result=await window.nozeli.invoke('document.clipboard',{action:'write',text:entry.text||''});if(!result.ok)throw Error(result.error?.message||'复制失败');setCopyState('copied');}
  catch(error){setCopyState('failed');context?.onError?.(error);}
 };
 return h('article',{className:'session-message agent-message agent-message-'+(entry.speaker==='user'?'user':'agent'),'data-message':entry.id,'data-managed-message':entry.id,'data-source':entry.source},
  h('header',null,h('strong',null,name),streaming&&h('span',{role:'status'},' · 输出中'),entry.source==='legacy'&&h('small',null,' · 只读历史'),entry.at&&h('time',{dateTime:entry.at},new Date(entry.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))),
  entry.speaker==='agent'&&(entry.failed||entry.status==='failed')&&h('p',{role:'alert','data-reply-state':'failed'},'本次回复失败，原输入和记录已保留；不会自动重发。'),
  entry.attachments?.length>0&&h('div',{className:'message-attachments'},entry.attachments.map((attachment,index)=>h('button',{key:attachment.digest||index,type:'button',className:'cm-chip cm-chip-main','data-digest':attachment.digest,title:'发送时冻结的材料 · '+attachment.name,onClick:()=>attachment.digest&&window.__openMaterialAttachment?.(attachment.digest)},h(FileIcon,{path:attachment.name||'image.png'}),h('span',null,attachment.name||'图片材料')))),
  entry.materialSources?.length>0&&h(Fold,{label:'选区来源 · '+entry.materialSources.length},entry.materialSources.map((source,index)=>h('section',{key:source.annotationId||index},h('p',null,source.relPath+(source.location?' · '+source.location:'')+(source.changed?' · 原版选区，当前版本已变化':'')),h('blockquote',null,source.quote),h('small',null,'版本 '+source.materialDigest)))),
  process.length>0&&h(Fold,{label:'执行过程 · '+process.length+' 条记录'},process.map(item=>h('section',{key:item.id,'data-process-entry':item.id},item.availability==='read-required'?h(ReadOriginal,{entry:item,call}):h(NativeBody,{entry:item,context})))),
  entry.availability==='read-required'?h(ReadOriginal,{entry,context,call}):h(NativeBody,{entry,context}),
  entry.availability!=='read-required'&&(!entries||entries.includes(entry))&&!(entry.speaker==='agent'&&(entry.failed||entry.status==='failed')&&!entry.text)&&h('div',{className:'message-actions'},h('button',{type:'button',onClick:()=>window.__composerMaterials?.setQuote({role:entry.speaker,text:entry.text||'',time:entry.at||''})},'引用'),h('button',{type:'button',onClick:copy,disabled:copyState==='pending','data-message-copy':copyState,'aria-live':'polite'},copyState==='pending'?'正在复制…':copyState==='copied'?'已复制纯文本':copyState==='failed'?'复制失败，重试':'复制纯文本'),onTask&&entry.source!=='legacy'&&h('button',{type:'button',onClick:()=>onTask(entry)},'转为后台任务')));
});
function Reply({row,...props}){
 let answer=null;
 for(let i=row.entries.length-1;i>=0;i--){const item=row.entries[i];if(item.speaker==='system'&&item.text||item.speaker==='agent'&&(item.failed||item.status==='failed'||!item.tool&&!item.toolCalls?.length&&(item.text||item.availability==='read-required'))){answer=item;break;}}
 const last=row.entries[row.entries.length-1];
 const entry=answer||{...last,speaker:'agent',text:'本轮尚无正文回复。',availability:'available',tool:null,toolCalls:[],reasoning:null};
 return h(Message,{...props,onTask:answer?.speaker==='agent'?props.onTask:null,entry,entries:row.entries});
}
function FrozenFiles({receipt,call,openFrozenChange,projectId}){
 const changeSetId=receipt.changeSetId||receipt.snapshot?.changeSetId;
 const [state,setState]=useState({files:[],loading:true,error:null,nextOffset:null,total:0,offset:0});
 const request=useRef(0);
 const load=async(offset=0)=>{
  const token=++request.current;setState(old=>({...old,loading:true,error:null}));
  try{const page=await call('changes.list',{changeSetId,offset,limit:100});if(token!==request.current)return;setState({files:page.files.slice(0,100),loading:false,error:null,nextOffset:page.nextOffset,total:page.total,offset});}
  catch(error){if(token===request.current)setState(old=>({...old,loading:false,error:error.message}));}
 };
 useLayoutEffect(()=>{if(changeSetId)void load();return()=>{request.current++;};},[changeSetId,projectId]);
 if(!changeSetId)return h('section',{className:'session-frozen-files'},'冻结变更不可用：此轮没有已绑定的变更集；未用模型清单或当前文件替代。');
 return h('section',{className:'session-frozen-files','data-change-set':changeSetId,'aria-label':'本轮冻结变更文件'},
  h('h4',null,'冻结变更 · 相对本次工作输入',!state.loading&&' · '+state.total+' 个文件'),
  h('ul',null,state.files.map(file=>{const path=file.path,label=file.oldPath&&file.oldPath!==path?file.oldPath+' → '+path:path;return h('li',{key:file.fileId},h('button',{type:'button','data-frozen-file':file.fileId,onClick:()=>Promise.resolve(openFrozenChange?.({projectId,changeSetId,fileId:file.fileId})).catch(error=>setState(old=>({...old,error:error.message})))},h(FileIcon,{path}),h('span',{className:'session-file-path'},label),h('small',null,file.status,file.added!=null?' +'+file.added:'',file.deleted!=null?' −'+file.deleted:'')));})),
  state.loading&&h('p',{role:'status'},'读取冻结清单…'),state.error&&h('p',{role:'alert'},state.error,h('button',{type:'button',onClick:()=>load(state.offset)},'重试读取')),h('nav',{'aria-label':'冻结文件分页'},h('span',null,state.total?'第 '+(state.offset+1)+'–'+(state.offset+state.files.length)+' / '+state.total+' 个文件':''),state.offset>0&&h('button',{type:'button',disabled:state.loading,onClick:()=>load(Math.max(0,state.offset-100))},'上一页变更文件'),state.nextOffset!=null&&h('button',{type:'button',disabled:state.loading,onClick:()=>load(state.nextOffset)},'更多变更文件')));
}
function Worker({row,state,context,call,openFrozenChange,projectId}){
 const [open,setOpen]=useState(false),work=state.works.find(work=>work.id===row.workId),running=row.entries.some(entry=>entry.streaming);
 return h('article',{className:'session-worker','data-worker-round':row.id},
  h('details',{open,onToggle:event=>setOpen(event.currentTarget.open)},h('summary',null,h('strong',null,work?.name||'Worker'),h('span',null,' · 第 '+(row.revision??'?')+' 轮 · '+row.entries.length+' 条'+(running?' · 输出中':''))),open&&h('div',{className:'session-worker-transcript'},row.entries.map(entry=>h(Message,{key:entry.id,entry,context,call})))),
  row.receipts.map(receipt=>h(FrozenFiles,{key:receipt.id||receipt.objectId,receipt,call,openFrozenChange,projectId})),
  !row.receipts.length&&h('p',{className:'session-freeze-pending'},'尚未冻结变更；完整输出可展开查阅。'));
}
function Timeline({store,state,context,call,openFrozenChange,projectId,onTask,onPage,onLatest,historyPage,pageError}){
 const snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot),ref=useRef(null),lock=useRef({current:true});
 useLayoutEffect(()=>{store.setHistoryPage(Boolean(historyPage));return()=>store.setHistoryPage(false);},[store,historyPage]);
 useLayoutEffect(()=>{const scroll=ref.current.closest('#conversation');const update=()=>updateTranscriptTailLock(scroll,lock.current);scroll.addEventListener('scroll',update,{passive:true});return()=>scroll.removeEventListener('scroll',update);},[]);
 useLayoutEffect(()=>{followTranscriptTail(ref.current.closest('#conversation'),lock.current);},[snapshot,state.receipts]);
 const rows=groupSession(snapshot,state.receipts);
 return h('div',{ref,className:'session-timeline','data-session-version':'1'},h('nav',{'aria-label':'会话历史'},historyPage&&h('button',{type:'button',onClick:onLatest},'返回最新消息'),snapshot.hasMore&&h('button',{type:'button',onClick:()=>onPage(snapshot.nextCursor)},'读取更早一页'),pageError&&h('p',{role:'alert'},pageError)),
  !rows.length&&h('p',{className:'session-empty'},'会话记录将在这里显示。输入和材料不会自动发送。'),rows.map(row=>row.kind==='worker'?h(Worker,{key:row.id,row,state,context,call,openFrozenChange,projectId}):row.kind==='reply'?h(Reply,{key:row.id,row,context,onTask,call}):row.kind==='delta'?h('article',{key:row.id,className:'session-host-delta','data-host-delta':row.delta.id},h('strong',null,'Nozeli · '+row.delta.kind),h(Content,{value:row.delta.text,context})):h(Message,{key:row.id,entry:row.entry,context,onTask,call})));
}
export function mountSessionTimeline(container,props){const root=createRoot(container);return {render(next){const merged={...props,...next};root.render(h(SessionReading,{projectId:merged.projectId,key:merged.projectId},h(Timeline,merged)));},destroy(){root.unmount();}};}
