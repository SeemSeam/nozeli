import './isolated-surfaces.css';
import {localWindowOcclusions,subscribeLocalWindowOcclusions} from './local-window.mjs';

const surfaces = new Set();
const key = () => crypto.randomUUID();
export const isWebEntry = path => /\.html?$/i.test(path || '');

function surface(parent, {invoke, profile, projectId, objectId, entryPath, onReference, onBuffersChanged, onEndMatter, endMatter, documentSource, snapshotNote, isCurrent = () => true}) {
  const id = key(), viewport = document.createElement('div'), status = document.createElement('p');
  viewport.dataset.previewKey=id;viewport.dataset.previewProfile=profile;
  viewport.className = 'isolated-viewport'; viewport.setAttribute('aria-label', profile === 'staticReport' ? '隔离的静态 HTML 报告' : '隔离的离线网页预览');
  status.className = 'isolated-status'; status.setAttribute('role', 'status');
  parent.append(status, viewport);
  let generation = 0, acceptedGeneration = 0, opened = false, disposed = false, frame = 0, boundsSequence = 0;
  // The served footer only exists when a host handler consumes its events, so
  // reports opened without onEndMatter never show dead links.
  const endMatterParam = onEndMatter ? (endMatter === 'files' ? 'files' : true) : undefined;
  const bounds = () => {const r=viewport.getBoundingClientRect(),full={x:r.left,y:r.top,width:r.width,height:r.height};if(document.hidden || !viewport.isConnected || document.querySelector('dialog[open], .nozeli-context-menu:not([hidden])'))return {...full,clip:{x:0,y:0,width:0,height:0}};
    // Preserve the HTML viewport. Ancestors and overlays only change its native
    // clipping parent; moving a discussion must not reflow the report text.
    let x=r.left,y=r.top,right=r.right,bottom=r.bottom;
    for(let node=viewport.parentElement;node&&node!==document.documentElement&&right>x&&bottom>y;node=node.parentElement){
      const style=getComputedStyle(node),clip=node.getBoundingClientRect();
      if(style.overflowX!=='visible'){x=Math.max(x,clip.left);right=Math.min(right,clip.right);}
      if(style.overflowY!=='visible'){y=Math.max(y,clip.top);bottom=Math.min(bottom,clip.bottom);}
    }
    // Native previews paint above DOM: expose the largest unobstructed portion
    // of the unchanged viewport without shrinking its page layout.
    for(const {rect} of localWindowOcclusions(document)){
      const ox=rect.x,oy=rect.y,or=ox+rect.width,ob=oy+rect.height;
      if(or<=x||ox>=right||ob<=y||oy>=bottom)continue;
      const areas=[[x,y,Math.max(x,ox),bottom],[Math.min(right,or),y,right,bottom],[x,y,right,Math.max(y,oy)],[x,Math.min(bottom,ob),right,bottom]];
      areas.sort((a,b)=>(b[2]-b[0])*(b[3]-b[1])-(a[2]-a[0])*(a[3]-a[1]));
      [x,y,right,bottom]=areas[0];
    }
    return {...full,clip:{x,y,width:Math.max(0,right-x),height:Math.max(0,bottom-y)}}; };
  const boundsPayload=(value=bounds())=>({key:id,windowId:window.__workspaceScope?.windowId,surfaceGeneration:window.__workspaceScope?.generation,boundsSequence:++boundsSequence,bounds:value});
  const layout = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if(opened && !disposed) void invoke('isolated-preview.bounds',boundsPayload()).then(result=>{if(!result.ok&&!disposed){status.textContent='窗口避让未应用：'+(result.error?.message||'布局更新失败');status.dataset.state='error';}}).catch(error=>{if(!disposed){status.textContent='窗口避让未应用：'+error.message;status.dataset.state='error';}}); }); };
  const syncLayout = async () => {
    cancelAnimationFrame(frame);
    if(disposed||!opened||!isCurrent())throw Error('预览已关闭或来源已变化');
    const result=await invoke('isolated-preview.bounds',boundsPayload());
    if(disposed||!isCurrent())throw Error('预览已关闭或来源已变化');
    if(!result.ok)throw Error(result.error?.message||'预览区域尚未更新');
  };
  const stopOcclusion=subscribeLocalWindowOcclusions(document,()=>opened&&!disposed&&isCurrent()?syncLayout():Promise.resolve());
  const observer = new ResizeObserver(layout); observer.observe(viewport);
  window.addEventListener('resize', layout); window.addEventListener('nozeli-layout-change', layout); document.addEventListener('scroll',layout,true);
  document.addEventListener('visibilitychange',layout);
  const modals=new MutationObserver(layout);modals.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open','hidden','class','style'],childList:true});
  const unsubscribe = window.nozeli.subscribe('isolated-preview', event => {
    if(disposed || event.key !== id || ![generation,acceptedGeneration].includes(event.generation)) return;
    if(event.type === 'reference') void openReference(event);
    if(event.type === 'end-matter' && onEndMatter) onEndMatter({action: event.action, relPath: event.relPath});
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
    document.body.append(dialog);await invoke('isolated-preview.bounds',boundsPayload({x:0,y:0,width:0,height:0}));const finish=()=>{dialog.close();dialog.remove();layout();};close.onclick=finish;dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});dialog.showModal();
    const line=Number(/:(\d+)(?::\d+)?$/.exec(reference.href||'')?.[1]);if(sourceText&&line>0)requestAnimationFrame(()=>{sourceText.scrollTop=(line-1)*parseFloat(getComputedStyle(sourceText).lineHeight);});
  }
  async function refresh(extra = {}) {
    if(disposed)return;
    if(!isCurrent()){dispose();return;}
    const current = ++generation;
    // Review documents bind the preview to their own publication source, so
    // capture never resolves a same-path project file as a stand-in.
    const own = documentSource?.(), source = own && own.type !== 'project' ? own : null, note = source ? snapshotNote?.() : null;
    status.textContent = '正在冻结当前内容…'; status.dataset.state = 'loading';
    try {
      const result = await invoke(opened ? 'isolated-preview.update' : 'isolated-preview.open', {key:id,profile,projectId,objectId,entryPath,generation:current,bounds:bounds(),theme:document.documentElement.dataset.theme,endMatter:endMatterParam,...(source?{documentSource:source}:{}),...extra});
      if(disposed || current !== generation) return;
      if(!isCurrent()){dispose();return;}
      if(!result.ok) throw Error(result.error?.message || '预览失败');
      opened = true; acceptedGeneration = current; status.dataset.state = 'ready';
      status.textContent = profile === 'staticReport' ? '' : `快照 ${current}${result.value?.unsaved || extra.buffers?.some(buffer=>buffer.dirty) ? ' · 含未保存编辑' : ''}${note ? ' · ' + note : ''} · 离线 · 刷新不保存文件`;
      layout();
    } catch(error) { if(!disposed && current === generation) {status.dataset.state='error';status.textContent=(profile==='staticReport'?'冻结报告读取失败；原件保留。':source?'当前审校内容未成功预览；上一版保留，可切换源码。':'当前编辑未成功预览；上一版保留。')+error.message;} }
  }
  function dispose() {
    if(disposed) return; disposed=true; ++generation; cancelAnimationFrame(frame);observer.disconnect();modals.disconnect();
    stopOcclusion();
    window.removeEventListener('resize',layout);window.removeEventListener('nozeli-layout-change',layout);document.removeEventListener('scroll',layout,true);unsubscribe?.();
    document.removeEventListener('visibilitychange',layout);
    void invoke('isolated-preview.close',{key:id}); surfaces.delete(api); parent.remove();
  }
  const api = {key:id,refresh,dispose,layout,syncLayout,status,viewport}; surfaces.add(api); return api;
}
export function closeIsolatedSurfaces() { for(const item of [...surfaces]) item.dispose(); }
window.addEventListener('pagehide',closeIsolatedSurfaces);

export function mountStaticReport(parent, {invoke,projectId,objectId,onReference,onEndMatter,endMatter}) {
  const shell=document.createElement('section');shell.className='isolated-report';parent.append(shell);
  const view=surface(shell,{invoke,profile:'staticReport',projectId,objectId,onReference,onEndMatter,endMatter});
  view.print=async()=>{const result=await invoke('isolated-preview.print',{key:view.key});if(!result.ok){view.status.dataset.state='error';view.status.textContent=result.error?.message||'打印失败';throw Error(view.status.textContent);}};
  view.focus=async()=>{await view.syncLayout();const result=await invoke('isolated-preview.focus',{key:view.key});if(!result.ok)throw Error(result.error?.message||'报告聚焦失败');};
  view.ready=view.refresh();return view;
}

export function mountWebWorkspace({getContext,invoke,layout,saveView,whenReady,documentSource,documentReadOnly,mountDiff}) {
  const reader=document.getElementById('reader-scroll'), source=document.getElementById('text-host');
  const toolbar=document.createElement('div');toolbar.id='web-preview-toolbar';toolbar.className='isolated-controls web-preview-toolbar';toolbar.hidden=true;
  const modes=document.createElement('div');modes.className='web-preview-modes';modes.setAttribute('role','group');modes.setAttribute('aria-label','HTML 查看方式');
  const buttons=new Map();
  for(const [value,label] of [['web','网页'],['source','源码'],['split','对照'],['compare','前后效果'],['diff','代码差异']]) {
    const button=document.createElement('button');button.id=`web-mode-${value}`;button.type='button';button.textContent=label;button.setAttribute('aria-pressed','false');
    button.onclick=()=>{setMode(value);void saveView?.();};buttons.set(value,button);modes.append(button);
  }
  const refreshButton=document.createElement('button'),label=document.createElement('label'),auto=document.createElement('input');
  refreshButton.id='web-preview-refresh';refreshButton.type='button';refreshButton.textContent='刷新';refreshButton.title='使用当前编辑缓冲刷新离线快照，不保存文件';
  auto.id='web-preview-auto';auto.type='checkbox';label.append(auto,' 自动刷新');label.title='仅本次打开生效；不保存文件';
  toolbar.append(modes,refreshButton,label);reader.before(toolbar);
  let view=null, before=null, pane=null, diff=null, diffStatus=null, diffBody=null, timer=0, automatic=false, mode=null, pending=false, refreshing=false, generation=0;
  const origin = () => { const own = documentSource?.(); return own && own.type !== 'project' ? own : null; };
  const identity = () => JSON.stringify(origin());
  const removed = () => ['removed','deleted'].includes(getContext().file?.review?.change);
  const reviewModes = () => {const own=origin();return own?.type==='review'||(own?.type==='review-version'&&own.version?.kind==='baseline'&&removed());};
  const originFrozen = () => { const own = origin(); return Boolean(own) && (own.type === 'review-version' || documentReadOnly?.() === true); };
  const originNote = () => {
    const own=origin(),ui=getContext(),review=ui.file?.review;
    if(!own)return null;
    if(own.type==='review-version')return removed()?'修改前冻结版本 · 修改后已删除':'审核来源：冻结版本';
    const human=review?.draftRevision>0||review?.humanEdited||review?.origin==='draft'||ui.dirty;
    return '审核来源：'+(human?'人工审核稿':'审核候选')+(originFrozen()?' · 只读已保存状态':ui.dirty?' · 含未保存编辑':'');
  };
  function disposeViews() {
    ++generation;view?.dispose();before?.dispose();diff?.destroy();pane?.remove();
    view=before=pane=diff=diffStatus=diffBody=null;pending=false;
  }
  function leave() {
    clearTimeout(timer);disposeViews();mode=null;
    reader.classList.remove('web-preview-split','web-preview-only');source.hidden=false;toolbar.hidden=true;automatic=false;auto.checked=false;layout();
  }
  function opened(savedMode) {
    if(!isWebEntry(getContext().file?.relPath))return;
    refreshButton.title=origin()?'使用当前审校来源刷新；不保存文件，不读取项目源文件':'使用当前编辑缓冲刷新离线快照，不保存文件';
    const review=reviewModes();buttons.get('compare').hidden=!review;buttons.get('diff').hidden=!review||!mountDiff;
    buttons.get('web').textContent=review?(removed()?'修改前效果（已删除）':'成果效果'):'网页';buttons.get('split').textContent=review?'源码＋效果':'对照';
    for(const value of review?['web','compare','diff','source','split']:['web','source','split','compare','diff'])modes.append(buttons.get(value));
    toolbar.hidden=false;setMode(savedMode||'web');
  }
  function baselineState() {
    const review=getContext().file?.review;
    if(review?.change==='added')return '新增文件 · 无修改前版本';
    if(review?.baselineUnavailable||!review?.baselineDigest)return '修改前版本不可用 · 未使用空文件或项目文件替代';
    return null;
  }
  async function refresh() {
    clearTimeout(timer);const ui=getContext();
    if(!pane || !ui.editor || ui.composing)return;
    if(refreshing){pending=true;return;}
    refreshing=true;refreshButton.disabled=true;
    const file=ui.file, project=ui.project, own=origin(), stamp=generation, sourceId=identity();
    const current=()=>generation===stamp&&getContext().file===file&&getContext().project===project&&identity()===sourceId;
    try {
      await whenReady?.();
      if(!current()||getContext().composing)return;
      const text=ui.editor.adapter.getText();
      // Publish the exact owning buffer, never save or replace its editor.
      if(!(own && originFrozen())&&!removed()){
        const published=await invoke('workspace.document.publish',{projectId:project.id,relPath:file.relPath,kind:'text',text,dirty:ui.dirty,digest:file.digest,documentStatus:{dirty:ui.dirty},...(own?{documentSource:own}:{})});
        if(!current())return;
        if(!published.ok)throw Error(published.error?.message||'缓冲读取失败');
        if(getContext().composing||ui.editor.adapter.getText()!==text){pending=automatic;return;}
      }
      if(mode==='diff'){
        diffStatus.dataset.state='loading';diffStatus.textContent='正在读取冻结基线…';
        const unavailable=baselineState();
        if(unavailable&&file.review?.change!=='added'){diffStatus.dataset.state='error';diffStatus.textContent=unavailable;return;}
        const baseline=file.review?.change==='added'?{ok:true,value:{text:''}}:await invoke('document.version',{projectId:project.id,relPath:file.relPath,documentSource:own,version:{kind:'baseline'}});
        if(!current())return;
        if(getContext().composing||ui.editor.adapter.getText()!==text){pending=automatic;return;}
        if(!baseline.ok)throw Error(baseline.error?.message||'冻结基线不可用');
        if(typeof baseline.value?.text!=='string'||(file.review?.baselineDigest&&baseline.value.digest!==file.review.baselineDigest))throw Error('冻结基线不可用或摘要不匹配');
        diff?.destroy();diffBody.replaceChildren();
        diff=mountDiff({parent:diffBody,leftPath:file.relPath,rightPath:file.relPath,leftText:baseline.value.text,rightText:removed()?'':text,leftLabel:unavailable||'修改前 · 冻结基线',rightLabel:removed()?'修改后 · 已删除':originNote()});
        diffStatus.dataset.state='ready';diffStatus.textContent='修改前 · 冻结基线 → '+(removed()?'修改后 · 已删除':originNote())+' · 刷新不保存文件';
      }else{
        await Promise.all([before?.refresh({buffers:[]}),view?.refresh(own?{documentSource:own}:{})]);
      }
    } catch(error) {
      if(current()){const status=diffStatus||view?.status||before?.status;if(status){status.dataset.state='error';status.textContent='当前内容未成功预览；可切换源码。'+error.message;}}
    } finally {
      refreshing=false;refreshButton.disabled=false;
      if(pending){pending=false;void refresh();}
    }
  }
  function setMode(value) {
    const ui=getContext();if(!isWebEntry(ui.file?.relPath))return;
    if(!['web','source','split','compare','diff'].includes(value)||(['compare','diff'].includes(value)&&!reviewModes())||(value==='diff'&&!mountDiff))value='web';
    if(value===mode)return;
    disposeViews();mode=value;clearTimeout(timer);
    const hidden=['web','compare','diff'].includes(mode);
    source.hidden=hidden;reader.classList.toggle('web-preview-only',hidden);reader.classList.toggle('web-preview-split',mode==='split');
    for(const [value,button] of buttons)button.setAttribute('aria-pressed',String(value===mode));
    refreshButton.hidden=label.hidden=mode==='source';
    if(mode!=='source'){
      pane=document.createElement('section');pane.id='web-preview-pane';pane.className='web-preview-pane';reader.append(pane);
      const ownerFile=ui.file,ownerProject=ui.project,ownerSource=identity(),ownerGeneration=generation;
      const isCurrent=()=>generation===ownerGeneration&&getContext().file===ownerFile&&getContext().project===ownerProject&&identity()===ownerSource;
      const makeSurface=(parent,own,note)=>surface(parent,{invoke,profile:'offlineDevelopment',projectId:ui.project.id,entryPath:ui.file.relPath,onBuffersChanged:changed,documentSource:own,snapshotNote:note,isCurrent});
      if(mode==='diff'){
        diffStatus=document.createElement('p');diffStatus.className='isolated-status';diffStatus.setAttribute('role','status');
        diffBody=document.createElement('div');diffBody.className='document-diff-body web-review-diff';pane.append(diffStatus,diffBody);
      }else if(mode==='compare'){
        pane.classList.add('web-review-pair');
        const own=origin(),baseline={type:'review-version',workId:own.workId,objectId:own.objectId,version:{kind:'baseline'}};
        for(const side of ['before','after']){
          const box=document.createElement('section'),heading=document.createElement('h3');box.className='web-review-side';heading.textContent=side==='before'?'修改前 · 冻结基线':'修改后 · 当前审校内容';box.append(heading);pane.append(box);
          const message=side==='before'?baselineState():removed()?'文件已删除 · 无修改后效果':null;
          if(message){const state=document.createElement('p');state.className='isolated-status';state.textContent=message;box.append(state);}
          else if(side==='before')before=makeSurface(box,()=>baseline,()=> '修改前 · 冻结基线');
          else view=makeSurface(box,documentSource,originNote);
        }
      }else view=makeSurface(pane,documentSource,originNote);
      void refresh();
    }
    layout();view?.layout();before?.layout();
  }
  refreshButton.onclick=()=>void refresh();auto.onchange=()=>{automatic=auto.checked;if(automatic)void refresh();};
  function changed(){if(!pane)return;const status=diffStatus||view?.status;if(status)status.textContent='当前编辑尚未预览 · 上一快照保留';clearTimeout(timer);if(automatic&&!getContext().composing)timer=setTimeout(()=>void refresh(),350);}
  return {leave,opened,changed,setMode,snapshot:()=>mode,active:()=>mode!==null};
}
