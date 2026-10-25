import {mountPptAnnotations} from './ppt-annotations.mjs';
import {mountPptContextMenu} from './ppt-context-menu.mjs';
// PPTX edits are persisted as an independent model, never over the source package.
export async function mountPpt({parent,bytes,name,draft,readOnly=false,onChange,onExport,onSelection,onRegionMode,noteActions,tagActions,onContextMenu,onContextClose,onSelectionStart}){
 const host=document.createElement('div');host.style.cssText='height:100%;min-height:0;display:flex;flex-direction:column;background:var(--bg);color:var(--ink)';
 // Parent chrome tokens update in place; the vendor iframe keeps its native canvas.
 const bar=document.createElement('div');bar.hidden=true;bar.style.cssText='padding:6px 10px;display:flex;gap:12px;align-items:center;background:var(--paper);color:var(--ink);border-bottom:1px solid var(--line)';
 const info=document.createElement('span');info.textContent='PPTX · 编辑自动保存为 Nozeli 草稿，原件保持不变';
 const button=document.createElement('button');button.textContent='导出 PPTX 副本';button.id='ppt-export';bar.append(info,button);
 const frame=document.createElement('iframe');frame.id='ppt-frame';frame.title='PPTX 编辑器';frame.src='./ppt-vendor/index.html';frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.style.cssText='width:100%;flex:1;min-height:0;border:0';host.append(bar,frame);parent.replaceChildren(host);parent.hidden=false;
 let disposed=false,unsubscribe;const deadline=Date.now()+45000;
 try{
  let engine;
  while(!disposed){engine=frame.contentWindow?.__nozeliPptist;if(engine?.ready&&engine.store.slides.length)break;if(Date.now()>deadline)throw Error('PPTX 引擎打开超时');await new Promise(r=>setTimeout(r,100));}
  if(disposed)throw Error('PPTX 已关闭');
  engine.readClipboard=async()=>{if(disposed||!frame.isConnected)throw Error('PPTX 已关闭');const result=await window.nozeli.invoke('document.clipboard',{action:'read'});if(disposed||!frame.isConnected)throw Error('PPTX 已关闭');if(!result.ok)throw Error(result.error.message);return result.value;};
  engine.store.setSlides([]);engine.importFile([new frame.contentWindow.File([new Uint8Array(bytes)],name)],{cover:true});
  while(!engine.store.slides.length||engine.busy()){if(Date.now()>deadline)throw Error('PPTX 导入失败或超时');await new Promise(r=>setTimeout(r,100));}
  if(draft)engine.store.$patch(draft);
  await engine.resetHistory();
  engine.store.setTitle(name.replace(/\.pptx$/i,''));
  frame.contentWindow.onbeforeunload=null;
  const snapshot=()=>JSON.parse(JSON.stringify(engine.store.$state));
  // Do not stringify embedded image data on every store mutation. Snapshot only at save.
  if(!readOnly)unsubscribe=engine.store.$subscribe(()=>onChange(),{flush:'post'});
  if(readOnly){if(typeof engine.setReadOnly!=='function')throw Error('PPT 阅读引擎缺少只读能力，请重新构建引擎。');engine.setReadOnly(true);info.textContent='PPTX · 阅读副本';}
  let exporting;
  const exportBytes=()=>{
    if(disposed)return Promise.reject(Error('PPTX 已关闭'));
    if(exporting)return Promise.reject(Error('PPTX 正在导出，请完成后重试保留。'));
    exporting=new Promise((resolve,reject)=>{
      const finish=(error,bytes)=>{clearTimeout(timer);delete frame.contentWindow.__nozeliExport;error?reject(error):resolve(bytes);};
      const timer=setTimeout(()=>finish(Error('PPTX 导出超时')),45000);
      frame.contentWindow.__nozeliExport=async blob=>{try{finish(null,new Uint8Array(await blob.arrayBuffer()));}catch(error){finish(error);}};
      try{engine.exportFile();}catch(error){finish(error);}
    }).finally(()=>{exporting=null;});
    return exporting;
  };
  button.onclick=async()=>{button.disabled=true;try{await onExport(await exportBytes());}catch(e){bar.hidden=false;info.textContent=e.message;}finally{button.disabled=false;}};
  const annotations=readOnly?{dispose(){}}:mountPptAnnotations({host,frame,engine,onSelection,onRegionMode,noteActions,tagActions});
  const context=readOnly?{close(){},dispose(){}}:mountPptContextMenu({frame,onOpen:onContextMenu,onClose:onContextClose,onSelectionStart});
  return {...annotations,snapshot,snapshotModel:snapshot,export:exportBytes,applyModel:model=>{if(!readOnly)throw Error('Only a reading mirror accepts shared models.');const page=engine.store.slideIndex;engine.store.$patch(model);if(Number.isInteger(page)&&page<engine.store.slides.length)engine.store.setSlideIndex(page);},closeContextMenu:context.close,dispose(){context.dispose();annotations.dispose();disposed=true;unsubscribe?.();host.remove();}};
 }catch(e){host.remove();throw e;}
}
