export async function mountSheet({parent,bytes,name,onChange,onError,onSave,onContextMenu,onContextClose}){
 const frame=document.createElement('iframe');frame.title='电子表格编辑器';frame.src='./sheet-frame.html';frame.style.cssText='display:block;width:100%;height:100%;min-height:0;border:0';frame.setAttribute('sandbox','allow-scripts allow-same-origin');
 const channel=crypto.randomUUID(),pending=new Map();let disposed=false,readyResolve,readyReject;
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const timer=setTimeout(()=>readyReject(Error('电子表格打开超时')),45000);
 const receive=event=>{
  if(event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.nozeliSheet!==channel)return;
  const data=event.data;
  if(data.type==='ready'){clearTimeout(timer);readyResolve();}
  else if(data.type==='changed')onChange?.();
  else if(data.type==='save')onSave?.();
  else if(data.type==='context-menu')onContextMenu?.();
  else if(data.type==='context-close')onContextClose?.();
  else if(data.type==='clipboard')void window.nozeli.invoke('document.clipboard',{action:data.action,text:data.text}).then(result=>{if(!disposed)frame.contentWindow.postMessage({nozeliSheet:channel,type:'clipboard-result',requestId:data.requestId,...(result.ok?{value:result.value}:{error:result.error.message})},location.origin);}).catch(error=>onError?.(error));
  else if(data.type==='exported'){pending.get(data.requestId)?.resolve(data.bytes);pending.delete(data.requestId);}
  else if(data.type==='error'){const error=Error(data.message);if(data.requestId){pending.get(data.requestId)?.reject(error);pending.delete(data.requestId);}else{clearTimeout(timer);readyReject(error);onError?.(error);}}
 };
 addEventListener('message',receive);
 frame.onload=()=>frame.contentWindow.postMessage({nozeliSheet:channel,type:'open',bytes:new Uint8Array(bytes),name},location.origin);
 parent.replaceChildren(frame);parent.hidden=false;
 const dispose=()=>{if(disposed)return;disposed=true;clearTimeout(timer);removeEventListener('message',receive);for(const p of pending.values())p.reject(Error('电子表格已关闭'));pending.clear();onContextClose?.();frame.remove();};
 try{await ready;}catch(error){dispose();throw error;}
 const request=type=>new Promise((resolve,reject)=>{if(disposed)return reject(Error('电子表格已关闭'));const id=crypto.randomUUID();const timeout=setTimeout(()=>{pending.delete(id);reject(Error('电子表格导出超时，文档仍保留在窗口中'));},30000);pending.set(id,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}});frame.contentWindow.postMessage({nozeliSheet:channel,type,requestId:id},location.origin);});
 return {dispose,closeContextMenu:()=>frame.contentWindow.postMessage({nozeliSheet:channel,type:'context-close'},location.origin),export:()=>request('export'),snapshot:()=>request('snapshot')};
}
