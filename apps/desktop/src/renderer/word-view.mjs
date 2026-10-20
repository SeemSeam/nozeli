import { makeNoteTag, makeAnchorTag } from './note-tag.mjs';
import {groupAuthorship} from '../domain/authorship-groups.mjs';
import {authorshipLayer} from './authorship-gutter.mjs';
export async function mountWord({parent,bytes,name,onChange,onError,onSave,onSelection,noteActions,tagActions,onRegionMode,onZoom,onContextMenu,onContextClose,onContextCommand,onSelectionStart}){
 const frame=document.createElement('iframe');frame.title='Word 文档编辑器';frame.src='./word-frame.html';frame.style.cssText='display:block;width:100%;height:100%;min-height:0;border:0';frame.setAttribute('sandbox','allow-scripts allow-same-origin');
 const overlay=document.createElement('div');overlay.className='word-note-overlay';
 const cards=new Map();let notes=[],tags=[];
 let bodyText='',attribution=null,authorshipOptions={},layout=null;
 const authorLayer=authorshipLayer('word-authorship',group=>authorshipOptions.onOpen?.(group));
 function projectAuthors(){
  if(!authorshipOptions.visible||!attribution||!layout||layout.text!==bodyText||authorshipOptions.source!==bodyText){authorLayer.draw([]);return;}
  const groups=groupAuthorship(layout.units,attribution),fragments=[];
  for(const group of groups){
   const first=group.units[0],last=group.units.at(-1),start=first.top,end=group.kind==='deletion'?start+18:last.bottom;
   if(end<=layout.top||start>=layout.bottom)continue;
   fragments.push({group,top:Math.max(layout.top,start),height:Math.min(layout.bottom,end)-Math.max(layout.top,start),left:Math.max(0,Math.min(...group.units.map(unit=>unit.left))),page:first.page,continuation:start<layout.top});
  }
  authorLayer.draw(fragments);
 }
 function paint(){
  cards.clear();overlay.replaceChildren(marks);marks.replaceChildren();
  for(const note of notes){const card=makeNoteTag(note,noteActions);card.hidden=true;cards.set(note.id,card);overlay.append(card);}
  for(const tag of tags){const card=makeAnchorTag(tag,tagActions);card.hidden=true;cards.set(tag.id,card);overlay.append(card);}
  frame.contentWindow.postMessage({nozeliWord:channel,type:'anchors',anchors:[...notes,...tags].map(item=>({id:item.id,anchor:item.resolution?.anchor||item.anchor}))},location.origin);
 }

 const marks=document.createElement('div');marks.className='word-note-marks';overlay.append(marks);
 const channel=crypto.randomUUID(),pending=new Map();let disposed=false,readyResolve,readyReject;
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const timer=setTimeout(()=>readyReject(Error('Word 文档打开超时')),45000);
 const receive=event=>{
  if(event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.nozeliWord!==channel)return;
  const data=event.data;
  if(data.type==='ready'){bodyText=data.text;clearTimeout(timer);readyResolve();}
  else if(data.type==='zoom')onZoom?.(data.state);
  else if(data.type==='region-mode')onRegionMode?.(data.enabled);
  else if(data.type==='changed'){const before=bodyText;bodyText=data.text;onChange?.({before,text:bodyText,batches:data.batches});projectAuthors();}
  else if(data.type==='authorship-layout'){layout=data;projectAuthors();}
  else if(data.type==='context-close')onContextClose?.();
  else if(data.type==='context-menu')onContextMenu?.();
  else if(data.type==='context-command')onContextCommand?.(data.command);
  else if(data.type==='selection-start')onSelectionStart?.();
  else if(data.type==='external-link')void window.nozeli.invoke('links.openExternal',{url:data.url}).then(result=>{if(!result.ok)onError?.(Error(result.error.message));}).catch(error=>onError?.(error));
  else if(data.type==='clipboard'){
   void window.nozeli.invoke('document.clipboard',{action:data.action||'readRich',text:data.text}).then(result=>{if(!disposed)frame.contentWindow.postMessage({nozeliWord:channel,type:'clipboard-result',requestId:data.requestId,...(result.ok?{value:result.value}:{error:result.error.message})},location.origin);}).catch(error=>onError?.(error));
  }
  else if(data.type==='anchor-layout'){
   overlay.dataset.clipTop=String(Math.max(0,data.top));
   overlay.style.clipPath=`inset(${Math.max(0,data.top)}px 0 0)`;
   marks.replaceChildren();
   const occupied=new Map();
   for(const point of data.anchors){const card=cards.get(point.id);if(!card)continue;
    for(const rect of point.rects||[]){const mark=document.createElement('span');mark.className='pdf-note-mark word-note-mark';const tag=tags.find(t=>t.id===point.id);if(tag)mark.classList.add('tag-'+(tag.status==='followup'?'followup':tag.kind));Object.assign(mark.style,{left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px'});marks.append(mark);}
    card.hidden=point.status!=='visible';card.dataset.location=point.status;
    if(!card.hidden){const key=Math.round(point.left)+':'+Math.round(point.top),slot=occupied.get(key)||0;occupied.set(key,slot+1);card.style.left=Math.max(18,point.left+slot*22)+'px';card.style.top=point.top+'px';card.relayout?.();}
   }
  }
  else if(data.type==='selection'){
   if(data.error){onError?.(Error(data.error));onSelection?.(null);return;}
   const b=frame.getBoundingClientRect(),r=data.rect;
   const sx=b.width/(frame.clientWidth||b.width),sy=b.height/(frame.clientHeight||b.height);
   onSelection?.(data.anchor&&r?{kind:data.anchor.space==='docx-rendered-page-normalized'?'word-region':'word-selection',anchor:data.anchor,displayLocation:data.displayLocation,rect:{left:b.left+r.left*sx,right:b.left+r.right*sx,top:b.top+r.top*sy,bottom:b.top+r.bottom*sy}}:null);
  }
  else if(data.type==='save')onSave?.();
  else if(data.type==='exported'){pending.get(data.requestId)?.resolve(data.bytes);pending.delete(data.requestId);}
  else if(data.type==='error'){const error=Error(data.message);if(data.requestId){pending.get(data.requestId)?.reject(error);pending.delete(data.requestId);}else{clearTimeout(timer);readyReject(error);onError?.(error);}}
 };
 addEventListener('message',receive);
 frame.onload=()=>frame.contentWindow.postMessage({nozeliWord:channel,type:'open',bytes:new Uint8Array(bytes),name},location.origin);
 parent.replaceChildren(frame,authorLayer.node,overlay);parent.hidden=false;
 const dispose=()=>{if(disposed)return;disposed=true;clearTimeout(timer);removeEventListener('message',receive);for(const p of pending.values())p.reject(Error('Word 已关闭'));pending.clear();onContextClose?.();frame.remove();overlay.remove();authorLayer.node.remove();cards.clear();};
 try{await ready;}catch(error){dispose();throw error;}
 return {dispose,closeContextMenu:()=>frame.contentWindow.postMessage({nozeliWord:channel,type:'context-close'},location.origin),getText:()=>bodyText,setAuthorship:(value,options)=>{attribution=value;authorshipOptions=options;frame.contentWindow.postMessage({nozeliWord:channel,type:'authorship-state',enabled:Boolean(value&&options.visible)},location.origin);projectAuthors();},zoom:value=>frame.contentWindow.postMessage({nozeliWord:channel,type:'zoom',value},location.origin),region:enabled=>frame.contentWindow.postMessage({nozeliWord:channel,type:'region',enabled},location.origin),setNotes:value=>{notes=value;paint();},setTags:value=>{tags=value;paint();},locate:anchor=>frame.contentWindow.postMessage({nozeliWord:channel,type:'locate',anchor},location.origin),export:()=>new Promise((resolve,reject)=>{if(disposed)return reject(Error('Word 已关闭'));const id=crypto.randomUUID();const timeout=setTimeout(()=>{pending.delete(id);reject(Error('Word 导出超时，文档仍保留在窗口中'));},30000);pending.set(id,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}});frame.contentWindow.postMessage({nozeliWord:channel,type:'export',requestId:id},location.origin);})};
}
