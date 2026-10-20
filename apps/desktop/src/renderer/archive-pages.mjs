// Retain only the displayed archive page; navigation history holds offsets, not bodies.
export function mountArchivePages(body,first,read,current,{document=globalThis.document,onError=()=>{}}={}) {
 const pre=document.createElement('pre'),label=document.createElement('p'),previous=document.createElement('button'),next=document.createElement('button');
 previous.type=next.type='button';previous.textContent='上一段';next.textContent='下一段';
 let page=first,busy=false;const offsets=[first.offset??0];let index=0;
 function paint(){pre.textContent=page.text||'';label.textContent=`原档案 · ${page.offset??offsets[index]}–${page.endOffset??((page.offset??offsets[index])+(page.text||'').length)} / ${page.totalChars??'?'} 字符`;previous.disabled=busy||index===0;next.disabled=busy||page.nextOffset==null;}
 async function move(destination){if(busy||!current())return;const offset=destination>index?page.nextOffset:offsets[destination];if(offset==null)return;busy=true;paint();try{const result=await read({offset,version:first.version});if(!current())return;if(result.version!==first.version)throw Error('原档案版本已变化，请重新打开。');offsets[destination]=offset;index=destination;page=result;}catch(error){if(current())onError(error);}finally{busy=false;if(current())paint();}}
 previous.onclick=()=>move(index-1);next.onclick=()=>move(index+1);body.append(label,pre,previous,next);paint();
}
