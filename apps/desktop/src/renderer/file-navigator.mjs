import {createFileIcon} from './file-icons.mjs';
import './file-navigator.css';
import {readFileAvailability} from './file-availability.mjs';
import {mountContextMenu} from './context-menu.mjs';

export const isProjectDocument = view => view?.kind === 'document' && (!view.documentSource || view.documentSource.type === 'project');

export function mountFileNavigator({invoke, projectId, open, toast=()=>{}, workspaceGroups=()=>null, visibility=()=>({}), onRendered=()=>{}, rowHeight=32, overscan=8}){
  const tree=document.getElementById('file-tree'), filter=document.getElementById('file-filter');
  const canvas=document.createElement('div');canvas.className='tree-virtual-canvas';tree.replaceChildren(canvas);
  const editorMenu=mountContextMenu({id:'navigator-editor-menu',label:'已打开文件',onError:toast});
  tree.addEventListener('contextmenu',()=>editorMenu.close());
  const directories=new Map(), expanded=new Set(), selected=new Set(), sessions=new Map(), requests=new Map(), pendingLoads=new Map();
  let owner=null, revision=0, anchor=null, focusedPath=null, visible=[], frame=0, paintedStart=-1, paintedEnd=-1, paintedVisible=null;
  let transitioning=false,transitionGeneration=0;
  const unavailable = new Set();
  window.nozeli?.subscribe?.('workspace.control', event => {
    if (event.type === 'project-unavailable') unavailable.add(event.projectId);
    if (['project-unavailable','project-closed'].includes(event.type) && event.projectId === owner) {
      revision++; transitionGeneration++; searchSequence++; directories.clear(); visible=[]; selected.clear();
      clearTimeout(timer); if(overlay.open)overlay.close(); results.replaceChildren(); editorList.replaceChildren();
      tree.replaceChildren(); tree.textContent = event.type === 'project-unavailable' ? '项目目录不可用；可关闭或移除入口。' : '';
    }
  });
  window.addEventListener('nozeli-project-transition',event=>{transitioning=event.detail.active;transitionGeneration++;searchSequence++;clearTimeout(timer);if(transitioning){if(overlay.open)overlay.close();results.replaceChildren();}else{paintEditors();void checkEditorPaths();}});
  rowHeight=Math.max(20,Number(rowHeight)||32);overscan=Math.max(0,Math.min(20,Number(overscan)||8));
  tree.style.setProperty('--tree-row-height',`${rowHeight}px`);
  tree.setAttribute('aria-multiselectable','true');
  const rows=()=>[...tree.querySelectorAll('button[data-path]')];
  const paintSelection=()=>rows().forEach(b=>b.setAttribute('aria-selected',String(selected.has(b.dataset.path))));
  function select(path,event){const all=visible.filter(v=>v.entry).map(v=>v.entry.relPath);if(event.shiftKey&&anchor&&all.includes(anchor)){if(!event.ctrlKey&&!event.metaKey)selected.clear();const a=all.indexOf(anchor),b=all.indexOf(path);all.slice(Math.min(a,b),Math.max(a,b)+1).forEach(p=>selected.add(p));}else if(event.ctrlKey||event.metaKey){if(selected.has(path))selected.delete(path);else selected.add(path);anchor=path;}else{selected.clear();selected.add(path);anchor=path;}paintSelection();}
  function persistExpanded(){sessions.set(owner,[...expanded]);const id=owner;if(id)void invoke('tree.view',{projectId:id,expanded:[...expanded]}).then(r=>{if(!r.ok&&id===owner)toast('目录状态未保存：'+(r.error?.message||'未知错误'));}).catch(e=>toast(e.message));}
  function watch(path){if(window.__workspaceScope?.role==='surface')return;// Directory watching belongs to project navigation only; surfaces must not raise it.
    if(owner)void invoke('project.watch',{projectId:owner,parentRelPath:path}).then(result=>{if(!result.ok)toast('外部变更监听失败：'+(result.error?.message||'未知错误'));else if(result.value?.overflow)toast('目录监听已达上限，请手动刷新未覆盖目录。');}).catch(e=>toast(e.message));}
  tree.addEventListener('click',e=>{const b=e.target.closest('button[data-path]');if(!b)return;focusedPath=b.dataset.path;select(b.dataset.path,e);if(e.ctrlKey||e.metaKey||e.shiftKey){e.preventDefault();e.stopImmediatePropagation();}},true);
  function focusIndex(index){const item=visible[index];if(!item)return;const top=index*rowHeight,bottom=top+rowHeight;if(top<tree.scrollTop)tree.scrollTop=top;else if(bottom>tree.scrollTop+tree.clientHeight)tree.scrollTop=bottom-tree.clientHeight;focusedPath=item.entry?.relPath||null;paint();const node=item.entry?rows().find(b=>b.dataset.path===focusedPath):tree.querySelector(`button[data-index="${index}"]`);node?.focus({preventScroll:true});}
  tree.addEventListener('focusin',e=>{if(e.target.dataset.path)focusedPath=e.target.dataset.path;});
  tree.addEventListener('keydown',e=>{const i=Number(e.target.dataset.index);if(!Number.isInteger(i))return;if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const n=e.key==='Home'?0:e.key==='End'?visible.length-1:Math.max(0,Math.min(visible.length-1,i+(e.key==='ArrowDown'?1:-1)));focusIndex(n);if(e.shiftKey&&visible[n]?.entry)select(visible[n].entry.relPath,e);}if(e.key==='ArrowRight'&&e.target.classList.contains('dir')&&e.target.getAttribute('aria-expanded')!=='true'){e.preventDefault();e.target.click();}if(e.key==='ArrowLeft'){if(e.target.getAttribute('aria-expanded')==='true'){e.preventDefault();e.target.click();}else{const parent=e.target.dataset.path?.split('/').slice(0,-1).join('/'),n=visible.findIndex(v=>v.entry?.relPath===parent);if(n>=0){e.preventDefault();focusIndex(n);}}}});
  async function load(path,append=false){
    if (!projectId() || unavailable.has(projectId()) || transitioning) return false;
    const id=projectId(),token=revision,old=directories.get(path);
    if(pendingLoads.get(path)?.token===token)return false;
    const request=(requests.get(path)||0)+1,pending={token,request};requests.set(path,request);pendingLoads.set(path,pending);
    try{const r=await invoke('project.children',{projectId:id,parentRelPath:path,cursor:append?old?.nextCursor:undefined,limit:100,treeView:true});if(id!==projectId()||token!==revision||requests.get(path)!==request)return false;if(!r.ok){toast('目录读取失败：'+(r.error?.message||'未知错误'));return false;}directories.set(path,{...r.value,entries:append?[...(old?.entries||[]),...(r.value.entries||[])]:r.value.entries||[]});if(!path||expanded.has(path))watch(path);return true;}finally{if(pendingLoads.get(path)===pending)pendingLoads.delete(path);}
  }
  function flatten(){visible=[];const draw=(path,depth)=>{const page=directories.get(path);if(!page)return;for(const entry of page.entries){visible.push({entry,depth});if(entry.kind==='dir'&&expanded.has(entry.relPath)&&!entry.hiddenRoot)draw(entry.relPath,depth+1);}if(page.nextCursor)visible.push({parent:path,depth,more:true});else if(page.truncated)visible.push({parent:path,depth,incomplete:true});};draw('',0);}
  function paint(){
    if (!projectId() || unavailable.has(projectId())) return;
    const active=tree.contains(document.activeElement)?document.activeElement:null,hadFocus=!!active,activeIndex=active?.dataset.index;
    const start=Math.max(0,Math.floor(tree.scrollTop/rowHeight)-overscan),count=Math.min(100,Math.ceil((tree.clientHeight||400)/rowHeight)+overscan*2),end=Math.min(visible.length,start+count),fragment=document.createDocumentFragment();
    if(paintedVisible===visible&&paintedStart===start&&paintedEnd===end)return;
    paintedVisible=visible;paintedStart=start;paintedEnd=end;
    const mounted=new Map([...tree.querySelectorAll('button[data-index]')].map(node=>[Number(node.dataset.index),node]));
    canvas.style.height=`${visible.length*rowHeight}px`;if(canvas.parentNode!==tree)tree.replaceChildren(canvas);
    for(let index=start;index<end;index++){
      const retained=mounted.get(index);if(retained?._treeItem===visible[index]){fragment.append(retained);continue;}
      const {entry,depth,parent,more}=visible[index],b=document.createElement('button');b.type='button';b.dataset.index=String(index);b.style.paddingLeft=`${12+depth*12}px`;b.className='tree-virtual-row';
      b._treeItem=visible[index];
      b.style.position='absolute';b.style.top=`${index*rowHeight}px`;b.style.left='0';
      if(!entry){b.dataset.parent=parent;b.classList.add('tree-load-more');b.textContent=more?'加载更多…':'目录不完整，请刷新后重试。';b.disabled=!more||pendingLoads.get(parent)?.token===revision;b.onclick=async()=>{b.disabled=true;if(await load(parent,true))render();else b.disabled=pendingLoads.get(parent)?.token===revision;};fragment.append(b);continue;}
      b.dataset.path=entry.relPath;b.dataset.hiddenRoot=String(entry.hiddenRoot===true);b.dataset.kind=entry.kind;b.draggable=true;b.setAttribute('role','treeitem');b.setAttribute('aria-level',String(depth+1));b.setAttribute('aria-selected',String(selected.has(entry.relPath)));b.title=entry.relPath;
      const arrow=document.createElement('span');arrow.className='tree-expander';arrow.setAttribute('aria-hidden','true');arrow.textContent=entry.kind==='dir'?(expanded.has(entry.relPath)?'▾':'▸'):'';const label=document.createElement('span');label.className='tree-label';label.textContent=entry.name;b.append(arrow,createFileIcon(entry.relPath,{directory:entry.kind==='dir',expanded:expanded.has(entry.relPath)}),label);
      if(entry.hidden){b.classList.add('tree-hidden-item');const badge=document.createElement('span');badge.className='tree-hidden-label';badge.textContent='已隐藏';b.append(badge);}
      if(entry.kind==='dir'){b.classList.add('dir');b.setAttribute('aria-expanded',String(expanded.has(entry.relPath)));b.onclick=async()=>{if(entry.hiddenRoot){toast('隐藏文件夹不展开；请先恢复显示。');return;}if(expanded.has(entry.relPath)){expanded.delete(entry.relPath);persistExpanded();render();}else if(directories.has(entry.relPath)||await load(entry.relPath)){expanded.add(entry.relPath);watch(entry.relPath);persistExpanded();render();}};}else b.onclick=()=>open(entry.relPath);fragment.append(b);
    }
    canvas.replaceChildren(fragment);
    if(hadFocus){const node=focusedPath?rows().find(b=>b.dataset.path===focusedPath):tree.querySelector(`button[data-index="${activeIndex}"]`);node?.focus({preventScroll:true});}onRendered();
  }
  function render(){flatten();tree.scrollTop=Math.min(tree.scrollTop,Math.max(0,visible.length*rowHeight-tree.clientHeight));paint();}
  tree.addEventListener('scroll',()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;paint();});},{passive:true});
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>paint()).observe(tree);
  async function refresh(){
    if (unavailable.has(projectId())) return;
    const id=projectId(),switching=id!==owner;
    if(switching){revision++;if(owner)sessions.set(owner,[...expanded]);owner=id;expanded.clear();selected.clear();directories.clear();anchor=null;focusedPath=null;tree.scrollTop=0;searchSequence++;results.replaceChildren();editorList.replaceChildren();tree.replaceChildren();if(overlay.open)overlay.close();if(id){const state=await invoke('tree.view',{projectId:id});if(id!==projectId())return;for(const path of sessions.get(id)||state.value?.expanded||[])expanded.add(path);}}
    if(!id){render();return;}
    if(directories.has(''))await refreshDirectory('');else if(!await load(''))return;
    for(const path of expanded){if(id!==projectId())return;if(directories.has(path))await refreshDirectory(path);else await load(path);}
    if(id!==projectId())return;render();paintEditors();await checkEditorPaths();
  }
  async function refreshDirectory(parentRelPath=''){
    if (!projectId() || unavailable.has(projectId()) || transitioning) return;
    if(!directories.has(parentRelPath)||(parentRelPath&&!expanded.has(parentRelPath)))return;
    const id=owner,token=revision,target=Math.max(1,directories.get(parentRelPath).entries.length),request=(requests.get(parentRelPath)||0)+1;requests.set(parentRelPath,request);let cursor,page,entries=[];
    do{const r=await invoke('project.children',{projectId:id,parentRelPath,cursor,limit:100,treeView:true});if(id!==projectId()||token!==revision||requests.get(parentRelPath)!==request)return;if(!r.ok){toast('目录读取失败：'+(r.error?.message||'未知错误'));return;}page=r.value;entries.push(...(page.entries||[]));cursor=page.nextCursor;}while(cursor&&entries.length<target);
    directories.set(parentRelPath,{...page,entries});render();
  }
  async function openAt(path,where='current'){
    const id=projectId(),generation=transitionGeneration,api=workspaceGroups();
    const current=()=>id&&id===projectId()&&!transitioning&&generation===transitionGeneration&&(!api||api.snapshot()?.projectId===id);
    try{
      if(!current())throw Error('项目已切换或暂不可用，文件未打开。');
      if(!api){const result=await open(path);if(result?.ok===false)throw Error(result.error?.message||'文件打开失败');return true;}
      const existing=Object.values(api.snapshot()?.views||{}).find(v=>isProjectDocument(v)&&v.relPath===path&&!v.readOnly);
      if(where==='current'){
        if(existing){
          await api.activate(existing.id,api.activeGroup?.());
          // Retry honesty: a retained surface whose init terminally failed must not be
          // re-reported as a successful open. workspace.focus refuses such surfaces
          // with SURFACE_NOT_READY; other focus refusals (e.g. the writer already
          // living in another window) say nothing against the open itself.
          try{await api.focusView(existing.id);}catch(error){if(error?.code==='SURFACE_NOT_READY')throw error;}
        }else await api.open({kind:'document',relPath:path,documentSource:{type:'project'}});
        return true;
      }
      let viewId=existing?.id;
      if(!viewId){await api.open({kind:'document',relPath:path,documentSource:{type:'project'}});if(!current())throw Error('项目已切换，后续布局操作未执行。');viewId=Object.values(api.snapshot()?.views||{}).find(v=>isProjectDocument(v)&&v.relPath===path&&!v.readOnly)?.id;}
      if(!viewId)throw Error('打开的视图不可用');
      if(where==='right'||where==='bottom')await api.command({type:'splitOpen',viewId,groupId:api.activeGroup?.(),axis:where==='right'?'x':'y',side:'after'});
      else if(where==='window')await api.command({type:'floatOpen',viewId});
      else throw Error('未知的文件打开位置');
      return true;
    }catch(e){toast(e.message||'文件打开失败');return false;}
  }
  const overlay=document.createElement('dialog');overlay.id='quick-open';overlay.setAttribute('aria-label','快速打开');const input=document.createElement('input');input.id='quick-open-input';input.placeholder='搜索项目文件…';input.setAttribute('aria-label','搜索项目文件');const status=document.createElement('p');status.id='quick-open-status';status.setAttribute('role','status');const results=document.createElement('div');results.id='quick-open-results';results.setAttribute('role','list');results.setAttribute('aria-label','文件搜索结果');const close=document.createElement('button');close.type='button';close.textContent='关闭';close.onclick=()=>overlay.close();overlay.append(input,status,results,close);document.body.append(overlay);let timer,searchSequence=0,returnFocus=null,openingFile=false,focusHandoffViewId=null,skipLauncherRestore=false;
  const searchCurrent=(sequence,id,q)=>overlay.open&&sequence===searchSequence&&id===projectId()&&!transitioning&&q===input.value.trim();
  async function search(){
    const q=input.value.trim(),id=projectId(),sequence=++searchSequence;results.replaceChildren();
    if(!searchCurrent(sequence,id,q))return null;
    if(!q||!id){status.textContent='输入文件名或路径';return null;}
    status.textContent='搜索中…';
    try{
      const r=await invoke('project.search',{projectId:id,query:q,limit:100,treeView:true,filesOnly:true});
      if(!searchCurrent(sequence,id,q))return null;
      if(!r.ok){status.textContent=r.error?.message||'搜索失败';return null;}
      const entries=(r.value.entries||[]).filter(e=>e.kind!=='dir');status.textContent=(r.value.truncated||r.value.budgetExceeded)?'更多结果 · 搜索不完整，请缩小关键词':`${entries.length} 个结果`;
      for(const entry of entries){
        const row=document.createElement('div');row.className='quick-open-result';row.setAttribute('role','listitem');
        for(const [label,where] of [[entry.relPath,'current'],['在右侧打开','right'],['在下方打开','bottom'],['在新窗口打开','window']]){
          const b=document.createElement('button');b.type='button';b.dataset.openTarget=where;b.dataset.path=entry.relPath;b.textContent=label;b.title=where==='current'?entry.relPath:`${label}：${entry.relPath}`;if(where!=='current')b.setAttribute('aria-label',b.title);
          b.onclick=async()=>{
            if(openingFile||!searchCurrent(sequence,id,q))return;
            openingFile=true;for(const button of results.querySelectorAll('button'))button.disabled=true;status.textContent='正在打开文件…';
            try{
              const opened=await openAt(entry.relPath,where);
              if(searchCurrent(sequence,id,q)){
                if(opened){
                  // Only the current target owns the keyboard after a successful open:
                  // right/bottom/window place mirrors (or float the writer) where the
                  // layout — not this dialog — decides focus, so hand off only the
                  // concrete writer the user opened or activated.
                  const api=workspaceGroups();
                  const writer=where==='current'&&api?Object.values(api.snapshot()?.views||{}).find(v=>isProjectDocument(v)&&v.relPath===entry.relPath&&!v.readOnly):null;
                  focusHandoffViewId=writer?.id||null;skipLauncherRestore=where==='window';returnFocus=null;filter.disabled=true;overlay.close();
                }else status.textContent='文件未打开，请查看错误提示后重试。';
              }
            }finally{openingFile=false;for(const button of results.querySelectorAll('button'))button.disabled=false;}
          };row.append(b);
        }results.append(row);
      }
      return sequence;
    }catch(error){if(searchCurrent(sequence,id,q))status.textContent=error.message||'搜索失败';return null;}
  }
  const showSearch=()=>{
    if(window.__workspaceScope?.role==='surface')return false;
    if(!projectId()){toast('请先打开项目');return false;}
    if(transitioning){toast('项目正在切换，请稍后重试。');return false;}
    const opening=!overlay.open;
    if(opening){returnFocus=document.activeElement;filter.disabled=false;overlay.showModal();filter.setAttribute('aria-expanded','true');}
    input.focus();if(opening){input.select();void search();}return true;
  };
  const scheduleSearch=()=>{clearTimeout(timer);searchSequence++;results.replaceChildren();status.textContent=input.value.trim()?'搜索中…':'输入文件名或路径';timer=setTimeout(()=>void search(),150);};
  input.addEventListener('input',scheduleSearch);
  overlay.addEventListener('close',()=>{if(overlay.open)return;clearTimeout(timer);searchSequence++;results.replaceChildren();filter.setAttribute('aria-expanded','false');filter.disabled=false;const handoff=focusHandoffViewId;focusHandoffViewId=null;if(handoff){const api=workspaceGroups();if(api)void api.focusView(handoff).catch(e=>toast(e.message));return;}if(skipLauncherRestore){skipLauncherRestore=false;return;}const target=[returnFocus,filter,...document.querySelectorAll('[data-workspace-command]')].find(node=>node?.isConnected&&node!==document.body&&node.getClientRects().length&&!node.disabled);returnFocus=null;target?.focus({preventScroll:true});});
  overlay.addEventListener('keydown',async e=>{if(e.key==='Escape'&&!e.isComposing){e.preventDefault();overlay.close();return;}if(e.key==='Enter'&&e.target===input&&!e.isComposing){e.preventDefault();if(openingFile)return;clearTimeout(timer);const sequence=await search();if(sequence!==null&&sequence===searchSequence&&overlay.open)results.querySelector('button')?.click();return;}if(!['ArrowDown','ArrowUp'].includes(e.key)||e.isComposing)return;const all=[...results.querySelectorAll('[data-open-target="current"]:not(:disabled)')],i=all.indexOf(document.activeElement);if(all.length){e.preventDefault();all[(i<0?(e.key==='ArrowDown'?0:all.length-1):(i+(e.key==='ArrowDown'?1:-1)+all.length)%all.length)]?.focus();}});
  document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&!e.isComposing&&e.key.toLowerCase()==='p'){e.preventDefault();showSearch();}});
  filter.placeholder='快速打开文件…';filter.setAttribute('aria-label','快速打开项目文件');filter.setAttribute('aria-haspopup','dialog');filter.setAttribute('aria-controls','quick-open');filter.setAttribute('aria-expanded','false');
  filter.addEventListener('click',()=>showSearch());
  filter.addEventListener('keydown',e=>{if(['Enter','ArrowDown'].includes(e.key)&&!e.isComposing){e.preventDefault();showSearch();}});
  filter.addEventListener('input',e=>{e.stopImmediatePropagation();input.value=filter.value;if(showSearch()){input.setSelectionRange(input.value.length,input.value.length);scheduleSearch();}},true);
  const editors=document.createElement('details');editors.id='workspace-open-editors';editors.open=true;const heading=document.createElement('summary');heading.textContent='已打开';const editorList=document.createElement('div');editorList.className='workspace-open-editor-list';editors.append(heading,editorList);tree.before(editors);
  function paintEditors(){
    const api=workspaceGroups(),layout=api?.snapshot();editorList.replaceChildren();if(!layout||layout.projectId!==projectId())return;
    for(const [id,view] of Object.entries(layout.views||{})){
      if(view.kind==='conversation')continue;
      const row=document.createElement('div');row.className='workspace-open-editor-row';
      const b=document.createElement('button');b.type='button';b.dataset.editorView=id;
      const status=view.viewState?.documentStatus||{},review=view.documentSource&&view.documentSource.type!=='project'?view.documentSource:null;
      const origin=review?` · ${review.type==='review-version'?'冻结版本':'审核候选'} · ${review.workId} · ${review.objectId}`:'';
      b.dataset.documentSource=view.documentSource?.type||'project';
      b.textContent=(view.relPath?.split('/').pop()||view.viewState?.title||({report:'报告',diff:'Diff',history:'历史'}[view.kind])||view.kind)+origin+(status.dirty?' ●':'')+((view.readOnly||status.readOnly)?' [只读]':'')+(status.missing&&!review?' [缺失]':'');
      b.title=(view.relPath||b.textContent)+origin+(status.dirty?' · 未保存':'');
      if(view.relPath?.includes('/')){const parent=document.createElement('small');parent.textContent=' · '+view.relPath.split('/').slice(0,-1).join('/');b.append(parent);}
      const hidden=isProjectDocument(view)&&Array.from(visibility().hidden||[]).some(p=>view.relPath===p||view.relPath?.startsWith(p+'/'));if(hidden)b.title+=' · 已隐藏';
      b.onclick=()=>void api.command({type:'activate',viewId:id,groupId:api.activeGroup?.()}).catch(e=>toast(e.message));
      const close=document.createElement('button');close.type='button';close.textContent='×';close.title='关闭 '+b.textContent;close.dataset.editorClose=id;close.onclick=()=>void api.command({type:'close',viewId:id}).catch(e=>toast(e.message));row.append(b,close);editorList.append(row);
    }
  }
  editorList.addEventListener('contextmenu',event=>{const node=event.target.closest('[data-editor-view]'),view=workspaceGroups()?.snapshot()?.views[node?.dataset.editorView],id=projectId();if(!view)return;event.preventDefault();const api=workspaceGroups();editorMenu.open([{id:'split-x',label:'分屏打开（右侧）'},{id:'split-y',label:'分屏打开（下方）'},{id:'float',label:'在独立窗口打开'},...(isProjectDocument(view)?[{id:'locate',label:'在文件树中定位'}]:[]),{id:'close',label:'关闭'}],{x:event.clientX,y:event.clientY,run:key=>{if(id!==projectId())return;const viewId=view.id;if(key==='locate')return isProjectDocument(view)&&view.relPath&&locate(view.relPath);if(key==='split-x'||key==='split-y')return api.command({type:'splitOpen',viewId,groupId:api.activeGroup?.(),axis:key==='split-x'?'x':'y',side:'after'});if(key==='float')return api.command({type:'floatOpen',viewId});if(key==='close')return api.command({type:'close',viewId});}});});
  async function checkEditorPaths(){if(transitioning||!projectId()||unavailable.has(projectId()))return;const generation=transitionGeneration,api=workspaceGroups(),layout=api?.snapshot(),id=projectId();if(!layout||layout.projectId!==id)return;const paths=Object.values(layout.views).filter(v=>isProjectDocument(v)&&v.relPath).map(v=>v.relPath);try{const availability=await readFileAvailability(invoke,id,paths);if(transitioning||generation!==transitionGeneration||id!==projectId())return;for(const node of editorList.querySelectorAll('[data-editor-view]')){const view=layout.views[node.dataset.editorView],entry=isProjectDocument(view)?availability.get(view.relPath):null;if(entry?.status==='missing'){node.dataset.missing='true';}else if(entry?.status==='unavailable')node.dataset.missing='unavailable';}}catch(e){if(!transitioning&&generation===transitionGeneration&&id===projectId())toast(e.message);}}
  window.nozeli?.subscribe?.('workspace.control',event=>{if(event.type==='quick-open'&&event.projectId===projectId())showSearch();});
  if(document.documentElement.dataset.workspaceRole==='shell'){
    window.nozeli?.subscribe?.('workspace.changed',()=>queueMicrotask(()=>{paintEditors();void checkEditorPaths();}));
    window.nozeli?.subscribe?.('workspace.control',event=>{if(event.type==='file-tree-changed'&&event.projectId===projectId())void refreshDirectory(event.parentRelPath||'');if(event.type==='file-tree-watch-error'&&event.projectId===projectId())toast('目录监听不可用：'+event.message+'；可手动刷新。');});
  }
  function collapse(parent=''){for(const path of expanded)if(!parent||path===parent||path.startsWith(parent+'/'))expanded.delete(path);persistExpanded();render();}
  function applyClosed(closed){let changed=false;for(const path of closed||[])if(expanded.delete(path))changed=true;if(changed)persistExpanded();render();}
  async function locate(path){
    const id=projectId(),parts=path.split('/');
    for(let i=0;i<parts.length;i++){const parent=parts.slice(0,i).join('/'),child=parts.slice(0,i+1).join('/');if(!directories.has(parent)&&!await load(parent))return;while(!directories.get(parent)?.entries.some(e=>e.relPath===child)&&directories.get(parent)?.nextCursor){if(!await load(parent,true))return;}if(id!==projectId())return;if(i<parts.length-1){expanded.add(child);}}
    persistExpanded();render();const index=visible.findIndex(v=>v.entry?.relPath===path);if(index>=0)focusIndex(index);
  }
  return {render:refresh,refreshDirectory,search:showSearch,openAt,selection:()=>[...selected],paintEditors,collapse,applyClosed,locate};
}
