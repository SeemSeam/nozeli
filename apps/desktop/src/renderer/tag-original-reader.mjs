// A single visible original page; never a second transcript cache.
export function makeOriginalReplyReader(read, document = globalThis.document) {
  const root=document.createElement('span'), status=document.createElement('span'), content=document.createElement('pre');
  const open=document.createElement('button'), next=document.createElement('button'), previous=document.createElement('button'), fields=document.createElement('select'), close=document.createElement('button');
  open.type=next.type=previous.type=close.type='button';
  open.textContent='分段读取完整原文';next.textContent='下一段';previous.textContent='返回首段';close.textContent='收起原文';
  status.textContent='回复已持久保存；正文较长，请按需分段读取。';
  content.style.whiteSpace='pre-wrap';content.style.overflowWrap='anywhere';
  let descriptor=null, offset=0, nextOffset=null, busy=false, serial=0;
  const hide=()=>{content.hidden=fields.hidden=next.hidden=previous.hidden=close.hidden=true;};hide();
  const controls=()=>{open.disabled=fields.disabled=busy;next.disabled=busy||nextOffset==null;previous.disabled=busy||offset===0;};
  async function page(start){
    if(busy)return;busy=true;const request=++serial;controls();
    try{
      if(!descriptor){const entry=await read();if(request!==serial)return;descriptor=entry.read;if(!descriptor?.version||!descriptor.fields?.length)throw Error('原文读取描述不可用。');for(const field of descriptor.fields){const option=document.createElement('option');option.value=field.field;option.textContent=field.field;fields.append(option);}fields.value=descriptor.fields[0].field;}
      const result=await read({version:descriptor.version,field:fields.value,offset:start,limit:16384});
      if(request!==serial)return;
      offset=result.offset;nextOffset=result.nextOffset;content.textContent=result.content;
      status.textContent=`原文 ${result.field} · 字节 ${offset}–${nextOffset??result.totalBytes} / ${result.totalBytes}`;
      content.hidden=fields.hidden=next.hidden=previous.hidden=close.hidden=false;
    }catch(error){if(request===serial)status.textContent='原文读取失败：'+error.message;}
    finally{if(request===serial){busy=false;controls();}}
  }
  open.onclick=()=>page(0);next.onclick=()=>page(nextOffset);previous.onclick=()=>page(0);fields.onchange=()=>page(0);
  close.onclick=()=>{serial++;busy=false;content.textContent='';descriptor=null;fields.replaceChildren();offset=0;nextOffset=null;hide();controls();status.textContent='回复已持久保存；正文较长，请按需分段读取。';};
  root.append(status,open,fields,previous,next,close,content);return root;
}
