import React,{createContext,useContext,useId,useLayoutEffect,useRef,useState} from 'react';
import './session-reading.css';
const h=React.createElement;
export const READING_LIMITS=Object.freeze({terms:64,length:80,input:8192});
const ReadingContext=createContext({enabled:false,terms:[]});
export const useSessionReading=()=>useContext(ReadingContext);
function viewStorage(){try{return globalThis.localStorage;}catch{return null;}}
export function normalizeReadingTerms(value){
 const values=Array.isArray(value)?value: String(value??'').slice(0,READING_LIMITS.input).split(/\r?\n/u);
 const terms=[];
 for(const value of values.slice(0,READING_LIMITS.input)){
  if(typeof value!=='string')continue;
  const term=value.trim();
  if(!term||term.length>READING_LIMITS.length||/[\u0000-\u001f\u007f]/u.test(term)||terms.includes(term))continue;
  terms.push(term);if(terms.length===READING_LIMITS.terms)break;
 }
 return terms;
}
export function readingStorageKey(projectId){return 'nozeli.session-reading.v1:'+encodeURIComponent(projectId);}
export function loadReadingPreferences(storage,projectId){
 try{const value=JSON.parse(storage?.getItem(readingStorageKey(projectId))||'null');return {enabled:value?.enabled===true,terms:normalizeReadingTerms(value?.terms||[])};}catch{return {enabled:false,terms:[]};}
}
export function saveReadingPreferences(storage,projectId,value){
 try{if(!storage)return false;storage.setItem(readingStorageKey(projectId),JSON.stringify({enabled:value.enabled===true,terms:normalizeReadingTerms(value.terms)}));return true;}catch{return false;}
}
const SKIP='code,pre,a,button,strong,em,mark,input,textarea,select,script,style,[contenteditable]:not([contenteditable="false"]),.conversation-file-link,[data-path],.conversation-math,[data-streaming="true"]';
// Only renderer-owned marks are removed. Neither source Markdown nor business state is mutated.
export function highlightReadingTerms(root,{terms,enabled,settled=true}){
 if(!settled)return;
 for(const mark of root.querySelectorAll('mark[data-session-term]')){const parent=mark.parentNode;mark.replaceWith(...mark.childNodes);parent.normalize();}
 if(!enabled)return;
 const remaining=new Set(normalizeReadingTerms(terms)),doc=root.ownerDocument;
 const walker=doc.createTreeWalker(root,4,{acceptNode:node=>node.parentElement?.closest(SKIP)?2:1});
 const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
 for(const node of nodes){
  if(!remaining.size)break;
  const text=node.data,matches=[];
  for(const term of remaining){const start=text.indexOf(term);if(start>=0)matches.push({term,start,end:start+term.length});}
  matches.sort((a,b)=>a.start-b.start||b.end-a.end);
  let end=0;
  const selected=[];
  for(const match of matches){if(match.start<end)continue;selected.push(match);remaining.delete(match.term);end=match.end;}
  // Work backwards so DOM Ranges retain their original offsets.
  for(const match of selected.reverse()){const range=doc.createRange();range.setStart(node,match.start);range.setEnd(node,match.end);const mark=doc.createElement('mark');mark.dataset.sessionTerm='';mark.className='session-term';range.surroundContents(mark);}
 }
}
// All Markdown node replacement (including preference changes) waits for selection / IME.
export function createReadingScheduler(root){
 const doc=root.ownerDocument;let composing=false,pending=null,disposed=false;
 const flush=()=>{const selection=doc.getSelection();if(disposed||composing||(selection&&!selection.isCollapsed))return;const task=pending;pending=null;task?.();};
 const start=()=>{composing=true;},end=()=>{composing=false;flush();};
 doc.addEventListener('selectionchange',flush);doc.addEventListener('compositionstart',start,true);doc.addEventListener('compositionend',end,true);
 return {update(task){pending=task;flush();},dispose(){disposed=true;pending=null;doc.removeEventListener('selectionchange',flush);doc.removeEventListener('compositionstart',start,true);doc.removeEventListener('compositionend',end,true);}};
}
export function useReadingMarkdown(ref,text,context,settled,render){
 const preferences=useSessionReading(),scheduler=useRef(null);
 useLayoutEffect(()=>{scheduler.current=createReadingScheduler(ref.current);return()=>{scheduler.current.dispose();scheduler.current=null;};},[]);
 useLayoutEffect(()=>{scheduler.current.update(()=>{render(ref.current,text||'',context);highlightReadingTerms(ref.current,{...preferences,settled});});},[text,context,settled,preferences,render]);
}
export function SessionReading({projectId,children}){
 const [preferences,setPreferences]=useState(()=>loadReadingPreferences(viewStorage(),projectId));
 const [draft,setDraft]=useState(()=>preferences.terms.join('\n')),[notice,setNotice]=useState('');const id=useId();
 const save=value=>{setPreferences(value);setNotice(saveReadingPreferences(viewStorage(),projectId,value)?'已保存此项目阅读设置':'当前环境无法保存；设置仅在本次视图有效');};
 return h(ReadingContext.Provider,{value:preferences},h('details',{className:'session-reading'},h('summary',null,'阅读 · 项目术语'),h('div',{className:'session-reading-controls'},h('label',null,h('input',{type:'checkbox',checked:preferences.enabled,onChange:event=>save({...preferences,enabled:event.target.checked})}),'高亮正文中每个术语的首次出现'),h('label',{htmlFor:id},'本项目术语（每行一个，精确匹配）'),h('textarea',{id,rows:3,maxLength:READING_LIMITS.input,value:draft,onChange:event=>setDraft(event.target.value),'aria-describedby':id+'-help'}),h('p',{id:id+'-help'},'不自动猜词。最多 64 个术语，每个最多 80 字符；空行、重复或超长词不采用。仅已结算正文，跳过代码、链接、强调与公式；纯文本分段不高亮。'),h('div',{className:'session-reading-actions'},h('button',{type:'button',onClick:()=>{const terms=normalizeReadingTerms(draft);setDraft(terms.join('\n'));save({...preferences,terms});}},'保存术语'),h('button',{type:'button',onClick:()=>{setDraft('');save({enabled:false,terms:[]});}},'清除术语与高亮')),h('p',{role:'status'},notice||`已配置 ${preferences.terms.length} 个术语 · 仅影响此项目会话视图`))),children);
}
