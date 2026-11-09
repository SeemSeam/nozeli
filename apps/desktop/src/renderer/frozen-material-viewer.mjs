import {renderTagMarkdown} from './tag-markdown.mjs';

// The same immutable bytes reader is used by composer previews and Task readers.
// No file opening, attachment creation or document mutation lives in this module.
export function renderFrozenMaterialBody(body,{name='',mime='',size,bytes}){
 const extension=name.split('.').at(-1)?.toLowerCase();
 const textLike=mime.startsWith('text/')||mime==='application/json'||/^(txt|md|markdown|mdx|json|ya?ml|toml|ini|log|csv|js|mjs|cjs|ts|jsx|tsx|css|scss|less|html?|xml|svg|py|sh|c|h|cpp|go|rs|java|rb|php|vue|svelte)$/.test(extension);
 if(mime.startsWith('image/')){const image=document.createElement('img');image.className='mv-image';image.src=`data:${mime};base64,${bytes}`;image.alt=name;body.append(image);return;}
 if(extension==='pdf'||mime==='application/pdf'){const frame=document.createElement('iframe');frame.className='mv-pdf';frame.src=`data:application/pdf;base64,${bytes}`;frame.title=name+'（发送时冻结的只读 PDF）';body.append(frame);return;}
 if(textLike){
  let text=null;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(bytes),character=>character.charCodeAt(0)));}catch{}
  if(text!==null&&!text.includes('\u0000')){const rendered=document.createElement('div');rendered.className='session-markdown';renderTagMarkdown(rendered,text,{});body.append(rendered);return;}
 }
 const note=document.createElement('p');note.className='mv-meta';note.textContent=`${name} · ${mime||'二进制材料'} · ${size??'未知'} 字节。此格式没有内置解析预览；以下链接为发送时冻结的完整副本，不读取当前同名文件。`;
 const download=document.createElement('a');download.textContent='保存完整冻结副本';download.href=`data:application/octet-stream;base64,${bytes}`;download.download=name||'frozen-material';body.append(note,download);
}

export function mountFrozenMaterialViewer({read}){
 const dialog=document.createElement('dialog');dialog.className='managed-review-detail frozen-material-viewer session-surface';dialog.setAttribute('aria-label','发送时冻结的材料');
 const title=document.createElement('h3'),close=document.createElement('button'),body=document.createElement('div');close.type='button';close.textContent='关闭';body.className='mv-body';body.tabIndex=0;dialog.append(close,title,body);document.body.append(dialog);
 let generation=0,opener=null;const dismiss=()=>{generation++;dialog.close();body.replaceChildren();opener?.focus({preventScroll:true});opener=null;};close.onclick=dismiss;dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});
 return {async open(attachment,entry){const request=++generation;opener=document.activeElement;title.textContent=attachment.name||'冻结材料';body.textContent='读取发送时的完整冻结副本…';if(!dialog.open)dialog.showModal();close.focus();try{const value=await read(attachment,entry);if(request!==generation)return;body.replaceChildren();title.textContent=(value.name||attachment.name||'材料')+' · 发送时冻结 · 只读';renderFrozenMaterialBody(body,value);}catch(error){if(request===generation)body.textContent='冻结材料读取失败：'+error.message+'；未改读当前同名文件。';}},destroy(){generation++;dialog.remove();}};
}
