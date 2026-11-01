import './isolated-surfaces.css';

const surfaces = new Set();
const key = () => crypto.randomUUID();
export const isWebEntry = path => /\.html?$/i.test(path || '');

function surface(parent, {invoke, profile, projectId, objectId, entryPath, onReference, onBuffersChanged}) {
  const id = key(), viewport = document.createElement('div'), status = document.createElement('p');
  viewport.dataset.previewKey=id;viewport.dataset.previewProfile=profile;
  viewport.className = 'isolated-viewport'; viewport.setAttribute('aria-label', profile === 'staticReport' ? '隔离的静态 HTML 报告' : '隔离的离线网页预览');
  status.className = 'isolated-status'; status.setAttribute('role', 'status');
  parent.append(status, viewport);
  let generation = 0, acceptedGeneration = 0, opened = false, disposed = false, frame = 0;
  const bounds = () => { if(document.hidden || !viewport.isConnected || document.querySelector('dialog[open], .nozeli-context-menu:not([hidden])'))return {x:0,y:0,width:0,height:0};const r = viewport.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
  const layout = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if(opened && !disposed) void invoke('isolated-preview.bounds',{key:id,bounds:bounds()}); }); };
  const observer = new ResizeObserver(layout); observer.observe(viewport);
  window.addEventListener('resize', layout); window.addEventListener('nozeli-layout-change', layout); document.addEventListener('scroll',layout,true);
  document.addEventListener('visibilitychange',layout);
  const modals=new MutationObserver(layout);modals.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open','hidden','class','style'],childList:true});
  const unsubscribe = window.nozeli.subscribe('isolated-preview', event => {
    if(disposed || event.key !== id || ![generation,acceptedGeneration].includes(event.generation)) return;
    if(event.type === 'reference') void openReference(event);
    if(event.type === 'buffers-changed') onBuffersChanged?.();
    if(['console','resource-error','error','load-failed','terminated'].includes(event.type)) {
      status.textContent = '预览诊断：' + (event.message || event.error?.message || event.type); status.dataset.state = 'error';
    }
  });
  async function openReference(event) {
    const result=await invoke('isolated-preview.reference',{key:id,generation:event.generation,referenceId:event.referenceId});
    if(disposed||![generation,acceptedGeneration].includes(event.generation))return;
    if(!result.ok){status.textContent='冻结引用读取失败：'+(result.error?.message||'未知错误');return;}
    const reference=result.value;
    if(reference.kind==='external'){
      const confirm=document.createElement('button');confirm.type='button';confirm.textContent='在系统浏览器打开：'+reference.url;
      confirm.onclick=()=>void invoke('links.openExternal',{url:reference.url});status.replaceChildren(confirm);return;
    }
    if(reference.availability!=='unavailable'&&onReference&&/\.(?:md|markdown)$/i.test(reference.relPath||'')){await onReference(reference);return;}
    const dialog=document.createElement('dialog'),header=document.createElement('header'),title=document.createElement('h2'),close=document.createElement('button');
    dialog.className='report-reference-reader';title.textContent='冻结引用 · '+(reference.href||reference.relPath);close.type='button';close.textContent='关闭';header.append(title,close);dialog.append(header);
    let sourceText;
    if(reference.dataUrl&&reference.mediaType?.startsWith('image/')){const image=document.createElement('img');image.src=reference.dataUrl;image.alt=reference.relPath;dialog.append(image);}
    else {sourceText=document.createElement('pre');sourceText.tabIndex=0;sourceText.textContent=reference.text??'此冻结二进制文件不支持文本阅读。';dialog.append(sourceText);}
    const save=document.createElement('button');save.type='button';save.textContent='另存完整冻结工件';
    save.onclick=async()=>{save.disabled=true;try{const result=await invoke('isolated-preview.reference.save',{key:id,generation:event.generation,referenceId:event.referenceId});if(!result.ok)throw Error(result.error?.message||'另存失败');if(result.value?.saved)save.textContent='完整工件已另存';}catch(error){status.textContent='冻结工件另存失败：'+error.message;}finally{save.disabled=false;}};
    dialog.append(save);
    document.body.append(dialog);await invoke('isolated-preview.bounds',{key:id,bounds:{x:0,y:0,width:0,height:0}});const finish=()=>{dialog.close();dialog.remove();layout();};close.onclick=finish;dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});dialog.showModal();
    const line=Number(/:(\d+)(?::\d+)?$/.exec(reference.href||'')?.[1]);if(sourceText&&line>0)requestAnimationFrame(()=>{sourceText.scrollTop=(line-1)*parseFloat(getComputedStyle(sourceText).lineHeight);});
  }
  async function refresh(extra = {}) {
    const current = ++generation;
    status.textContent = '正在冻结当前内容…'; status.dataset.state = 'loading';
    try {
      const result = await invoke(opened ? 'isolated-preview.update' : 'isolated-preview.open', {key:id,profile,projectId,objectId,entryPath,generation:current,bounds:bounds(),theme:document.documentElement.dataset.theme,...extra});
      if(disposed || current !== generation) return;
      if(!result.ok) throw Error(result.error?.message || '预览失败');
      opened = true; acceptedGeneration = current; status.dataset.state = 'ready';
      status.textContent = profile === 'staticReport' ? '' : `快照 ${current}${result.value?.unsaved || extra.buffers?.some(buffer=>buffer.dirty) ? ' · 含未保存编辑' : ''} · 离线 · 刷新不保存文件`;
      layout();
    } catch(error) { if(!disposed && current === generation) {status.dataset.state='error';status.textContent=(profile==='staticReport'?'冻结报告读取失败；原件保留。':'当前编辑未成功预览；上一版保留。')+error.message;} }
  }
  function dispose() {
    if(disposed) return; disposed=true; ++generation; cancelAnimationFrame(frame);observer.disconnect();modals.disconnect();
    window.removeEventListener('resize',layout);window.removeEventListener('nozeli-layout-change',layout);document.removeEventListener('scroll',layout,true);unsubscribe?.();
    document.removeEventListener('visibilitychange',layout);
    void invoke('isolated-preview.close',{key:id}); surfaces.delete(api); parent.remove();
  }
  const api = {key:id,refresh,dispose,layout,status,viewport}; surfaces.add(api); return api;
}
export function closeIsolatedSurfaces() { for(const item of [...surfaces]) item.dispose(); }
window.addEventListener('pagehide',closeIsolatedSurfaces);

export function mountStaticReport(parent, {invoke,projectId,objectId,onReference}) {
  const shell=document.createElement('section');shell.className='isolated-report';parent.append(shell);
  const view=surface(shell,{invoke,profile:'staticReport',projectId,objectId,onReference});
  view.print=async()=>{const result=await invoke('isolated-preview.print',{key:view.key});if(!result.ok){view.status.dataset.state='error';view.status.textContent=result.error?.message||'打印失败';throw Error(view.status.textContent);}};
  void view.refresh();return view;
}

export function mountWebWorkspace({getContext,invoke,layout,saveView,whenReady}) {
  const reader=document.getElementById('reader-scroll'), source=document.getElementById('text-host');
  const toolbar=document.createElement('div');toolbar.id='web-preview-toolbar';toolbar.className='isolated-controls web-preview-toolbar';toolbar.hidden=true;
  const modes=document.createElement('div');modes.className='web-preview-modes';modes.setAttribute('role','group');modes.setAttribute('aria-label','HTML 查看方式');
  const buttons=new Map();
  for(const [value,label] of [['web','网页'],['source','源码'],['split','对照']]) {
    const button=document.createElement('button');button.id=`web-mode-${value}`;button.type='button';button.textContent=label;button.setAttribute('aria-pressed','false');
    button.onclick=()=>{setMode(value);void saveView?.();};buttons.set(value,button);modes.append(button);
  }
  const refreshButton=document.createElement('button'),label=document.createElement('label'),auto=document.createElement('input');
  refreshButton.id='web-preview-refresh';refreshButton.type='button';refreshButton.textContent='刷新网页';refreshButton.title='使用当前编辑缓冲刷新离线快照，不保存文件';
  auto.id='web-preview-auto';auto.type='checkbox';label.append(auto,' 自动刷新');label.title='仅本次打开生效；不保存文件';
  toolbar.append(modes,refreshButton,label);reader.before(toolbar);
  let view=null, timer=0, automatic=false, mode=null, pending=false, refreshing=false;
  function leave() {
    clearTimeout(timer);view?.dispose();view=null;mode=null;pending=false;
    reader.classList.remove('web-preview-split','web-preview-only');source.hidden=false;toolbar.hidden=true;automatic=false;auto.checked=false;layout();
  }
  function opened(savedMode) {if(isWebEntry(getContext().file?.relPath)){toolbar.hidden=false;setMode(['web','source','split'].includes(savedMode)?savedMode:'web');}}
  async function refresh() {
    clearTimeout(timer);const ui=getContext(), target=view;
    if(!target || !ui.editor || ui.composing)return;
    if(refreshing){pending=true;return;}
    refreshing=true;refreshButton.disabled=true;
    const file=ui.file, project=ui.project;
    try {
      await whenReady?.();
      if(view!==target || getContext().file!==file || getContext().project!==project)return;
      if(ui.composing)return;
      const text=ui.editor.adapter.getText();
      // Publish the owning editor's exact buffer, without saving or recreating it.
      const published=await invoke('workspace.document.publish',{projectId:project.id,relPath:file.relPath,kind:'text',text,dirty:ui.dirty,digest:file.digest,documentStatus:{dirty:ui.dirty}});
      if(view!==target || getContext().file!==file || getContext().project!==project)return;
      if(!published.ok)throw Error(published.error?.message||'缓冲读取失败');
      await target.refresh();
    } catch(error) {
      if(view===target){target.status.dataset.state='error';target.status.textContent='当前编辑未成功预览；上一版保留，可切换源码。'+error.message;}
    } finally {
      refreshing=false;refreshButton.disabled=false;
      if(pending){pending=false;void refresh();}
    }
  }
  function setMode(value) {
    const ui=getContext();if(!isWebEntry(ui.file?.relPath))return;
    mode=value;clearTimeout(timer);
    source.hidden=mode==='web';reader.classList.toggle('web-preview-only',mode==='web');reader.classList.toggle('web-preview-split',mode==='split');
    for(const [value,button] of buttons)button.setAttribute('aria-pressed',String(value===mode));
    refreshButton.hidden=label.hidden=mode==='source';
    if(mode==='source'){view?.dispose();view=null;pending=false;}
    else if(!view){
      const pane=document.createElement('section');pane.id='web-preview-pane';pane.className='web-preview-pane';reader.append(pane);
      view=surface(pane,{invoke,profile:'offlineDevelopment',projectId:ui.project.id,entryPath:ui.file.relPath,onBuffersChanged:changed});void refresh();
    }
    layout();view?.layout();
  }
  refreshButton.onclick=()=>void refresh();auto.onchange=()=>{automatic=auto.checked;if(automatic)void refresh();};
  function changed(){if(!view)return;view.status.textContent='当前编辑尚未预览 · 上一快照保留';clearTimeout(timer);if(automatic&&!getContext().composing)timer=setTimeout(()=>void refresh(),350);}
  return {leave,opened,changed,setMode,snapshot:()=>mode,active:()=>mode!==null};
}
