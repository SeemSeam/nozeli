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
  let generation = 0, opened = false, disposed = false, frame = 0;
  const bounds = () => { if(document.querySelector('dialog[open], .nozeli-context-menu:not([hidden])'))return {x:0,y:0,width:0,height:0};const r = viewport.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
  const layout = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if(opened && !disposed) void invoke('isolated-preview.bounds',{key:id,bounds:bounds()}); }); };
  const observer = new ResizeObserver(layout); observer.observe(viewport);
  window.addEventListener('resize', layout); window.addEventListener('nozeli-layout-change', layout); document.addEventListener('scroll',layout,true);
  const modals=new MutationObserver(layout);modals.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open','hidden'],childList:true});
  const unsubscribe = window.nozeli.subscribe('isolated-preview', event => {
    if(disposed || event.key !== id || event.generation !== generation) return;
    if(event.type === 'reference') void openReference(event);
    if(event.type === 'buffers-changed') onBuffersChanged?.();
    if(['console','resource-error','error','load-failed','terminated'].includes(event.type)) {
      status.textContent = '预览诊断：' + (event.message || event.error?.message || event.type); status.dataset.state = 'error';
    }
  });
  async function openReference(event) {
    const result=await invoke('isolated-preview.reference',{key:id,generation,referenceId:event.referenceId});
    if(disposed||event.generation!==generation)return;
    if(!result.ok){status.textContent='冻结引用读取失败：'+(result.error?.message||'未知错误');return;}
    const reference=result.value;
    if(reference.kind==='external'){
      const confirm=document.createElement('button');confirm.type='button';confirm.textContent='在系统浏览器打开：'+reference.url;
      confirm.onclick=()=>void invoke('links.openExternal',{url:reference.url});status.replaceChildren(confirm);return;
    }
    if(onReference&&/\.(?:md|markdown)$/i.test(reference.relPath||'')){await onReference(reference);return;}
    const dialog=document.createElement('dialog'),header=document.createElement('header'),title=document.createElement('h2'),close=document.createElement('button');
    dialog.className='report-reference-reader';title.textContent='冻结引用 · '+(reference.href||reference.relPath);close.type='button';close.textContent='关闭';header.append(title,close);dialog.append(header);
    let sourceText;
    if(reference.dataUrl&&reference.mediaType?.startsWith('image/')){const image=document.createElement('img');image.src=reference.dataUrl;image.alt=reference.relPath;dialog.append(image);}
    else {sourceText=document.createElement('pre');sourceText.tabIndex=0;sourceText.textContent=reference.text??'此冻结二进制文件不支持文本阅读。';dialog.append(sourceText);}
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
      opened = true; status.dataset.state = 'ready';
      status.textContent = profile === 'staticReport' ? '' : `快照 ${current}${result.value?.unsaved || extra.buffers?.some(buffer=>buffer.dirty) ? ' · 含未保存编辑' : ''} · 离线 · 刷新不保存文件`;
      layout();
    } catch(error) { if(!disposed && current === generation) {status.dataset.state='error';status.textContent=(profile==='staticReport'?'冻结报告读取失败；原件保留。':'当前编辑未成功预览；上一版保留。')+error.message;} }
  }
  function dispose() {
    if(disposed) return; disposed=true; ++generation; cancelAnimationFrame(frame);observer.disconnect();modals.disconnect();
    window.removeEventListener('resize',layout);window.removeEventListener('nozeli-layout-change',layout);document.removeEventListener('scroll',layout,true);unsubscribe?.();
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

export function mountWebWorkspace({getContext,invoke,layout}) {
  const reader=document.getElementById('reader-scroll'), toggle=document.createElement('button');
  toggle.id='web-preview-toggle';toggle.type='button';toggle.textContent='预览当前缓冲';toggle.hidden=true;toggle.setAttribute('aria-pressed','false');
  // Non-conversation surfaces are chrome-less by design (no desk-header/reader-bar),
  // so the real preview entry mounts with the content, next to #reader-scroll like
  // the PDF toolbar; header tools are only a shell fallback.
  const contentPane=document.getElementById('primary-pane'), tools=document.querySelector('#reader > .desk-header .desk-tools');
  if(contentPane)contentPane.insertBefore(toggle,document.getElementById('reader-scroll'));
  else if(tools)tools.append(toggle);
  else document.getElementById('code-jump').before(toggle);
  let view=null, pane=null, timer=0, automatic=false;
  function leave() {clearTimeout(timer);view?.dispose();view=null;pane=null;reader.classList.remove('web-preview-split');toggle.hidden=true;toggle.setAttribute('aria-pressed','false');automatic=false;layout();}
  function opened() {toggle.hidden=!isWebEntry(getContext().file?.relPath);}
  async function refresh() {
    clearTimeout(timer);const ui=getContext();if(!view || !ui.editor || ui.composing)return;
    const file=ui.file, project=ui.project, text=ui.editor.adapter.getText();
    // Publish the owning editor's exact buffer before the host captures all other
    // editor owners. This does not save or recreate any project file.
    const published=await invoke('workspace.document.publish',{projectId:project.id,relPath:file.relPath,kind:'text',text,dirty:ui.dirty,digest:file.digest,documentStatus:{dirty:ui.dirty}});
    if(!view || getContext().file!==file || getContext().project!==project)return;
    if(!published.ok){view.status.dataset.state='error';view.status.textContent='当前编辑未成功预览：'+published.error?.message;return;}
    await view.refresh();
  }
  toggle.onclick=()=>{
    if(view){leave();opened();return;}
    const ui=getContext();if(!isWebEntry(ui.file?.relPath))return;
    pane=document.createElement('section');pane.id='web-preview-pane';pane.className='web-preview-pane';reader.append(pane);
    const controls=document.createElement('div');controls.className='isolated-controls';pane.append(controls);
    const refreshButton=document.createElement('button'),stop=document.createElement('button'),label=document.createElement('label'),auto=document.createElement('input');
    refreshButton.id='web-preview-refresh';refreshButton.type='button';refreshButton.textContent='刷新当前缓冲';stop.type='button';stop.textContent='关闭预览';auto.id='web-preview-auto';auto.type='checkbox';label.append(auto,' 自动预览（仅本次打开）');controls.append(refreshButton,label,stop);
    view=surface(pane,{invoke,profile:'offlineDevelopment',projectId:ui.project.id,entryPath:ui.file.relPath,onBuffersChanged:changed});
    refreshButton.onclick=()=>void refresh();stop.onclick=()=>{leave();opened();};auto.onchange=()=>{automatic=auto.checked;if(automatic)void refresh();};
    reader.classList.add('web-preview-split');toggle.setAttribute('aria-pressed','true');layout();void refresh();
  };
  function changed(){if(!view)return;view.status.textContent='当前编辑尚未预览 · 上一快照保留';clearTimeout(timer);if(automatic&&!getContext().composing)timer=setTimeout(()=>void refresh(),350);}
  return {leave,opened,changed};
}
