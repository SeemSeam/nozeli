import './project-search-view.css';

// Both launchers share one host search session; the renderer never reads file content.
export function mountProjectSearchView({invoke, projectId, filter, tree, openAt, revealHit, focusOpened=()=>{}, toast, canSearch=()=>true}) {
  const make=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;};
  const panel=make('section','project-search');panel.id='project-search';panel.setAttribute('aria-label','项目搜索');
  const controls=make('div','project-search-controls');
  const modes=make('div','project-search-modes');modes.setAttribute('role','group');modes.setAttribute('aria-label','搜索范围');
  const files=make('button','','文件'),content=make('button','','内容');files.type=content.type='button';files.dataset.searchMode='files';content.dataset.searchMode='content';modes.append(files,content);
  const options=make('div','project-search-options');
  const toggles={};for(const [name,label,title] of [['caseSensitive','Aa','区分大小写'],['wholeWord','词','全词匹配'],['regex','.*','正则表达式']]){const button=make('button','',label);button.type='button';button.title=title;button.setAttribute('aria-label',title);button.setAttribute('aria-pressed','false');button.dataset.searchOption=name;toggles[name]=button;options.append(button);}
  const details=make('details','project-search-scope'),summary=make('summary','','包含 / 排除');details.append(summary);
  const scopes={};for(const [name,label] of [['include','包含路径'],['exclude','排除路径']]){const wrapper=make('label','',label),input=make('input');input.dataset.searchScope=name;input.placeholder='例如 src/**, *.md';input.autocomplete='off';wrapper.append(input);details.append(wrapper);scopes[name]=input;}
  controls.append(modes,options,details);controls.id='project-search-options';controls.setAttribute('popover','auto');controls.setAttribute('aria-label','搜索选项');document.body.append(controls);
  const feedback=make('div','project-search-feedback'),status=make('p');status.id='project-search-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const stop=make('button','','停止');stop.type='button';stop.dataset.searchStop='';stop.hidden=true;feedback.append(status,stop);
  const issues=make('details','project-search-issues'),issueHeading=make('summary','','搜索覆盖提示'),issueList=make('ul');issues.append(issueHeading,issueList);issues.hidden=true;
  const results=make('div','project-search-results');results.id='project-search-results';results.setAttribute('role','list');results.setAttribute('aria-label','项目搜索结果');
  panel.append(feedback,issues,results);tree.before(panel);
  const dialog=make('dialog');dialog.id='quick-open';dialog.setAttribute('aria-label','快速打开项目文件');
  const quick=make('input');quick.id='quick-open-input';quick.placeholder='搜索项目文件…';quick.setAttribute('aria-label','搜索项目文件');quick.maxLength=256;
  const close=make('button','','关闭');close.type='button';close.onclick=()=>dialog.close();dialog.append(quick,close);document.body.append(dialog);
  filter.placeholder='搜索…';filter.setAttribute('aria-label','搜索项目文件或内容');filter.setAttribute('aria-controls',results.id);filter.maxLength=256;filter.removeAttribute('aria-haspopup');
  filter.addEventListener('nozeli-search-options',()=>{
    const anchor=document.getElementById('file-tree-more')||filter,r=anchor.getBoundingClientRect();
    controls.style.position='fixed';controls.style.margin='0';controls.style.top=Math.min(r.bottom+6,innerHeight-240)+'px';controls.style.left=Math.max(8,Math.min(r.right-280,innerWidth-288))+'px';
    controls.showPopover();files.focus();
  });
  let mode='files',generation=0,timer=null,active=null,composing=false,target=filter,opening=false,hits=[],rendered=0,done=false,truncated=false,problem=[],failure='',returnFocus=null;
  let quickFocusPath=null,enterIntent=null;
  const sections=new Map();
  const current=token=>!token.cancelled&&token.generation===generation&&token.projectId===projectId()&&canSearch();
  const visible=()=>!!target.value.trim();
  function layout(){const searching=target===filter&&visible();tree.closest('#files')?.classList.toggle('project-search-active',searching);panel.dataset.active=String(visible());results.hidden=feedback.hidden=!visible();issues.hidden=!visible()||!problem.length;files.setAttribute('aria-pressed',String(mode==='files'));content.setAttribute('aria-pressed',String(mode==='content'));filter.placeholder='搜索…';filter.title=mode==='files'?'搜索文件名或路径 · 在“…”中切换搜索范围':'搜索文件内容 · 在“…”中切换搜索范围';filter.setAttribute('aria-label',mode==='files'?'搜索文件名或路径':'搜索文件内容');}
  function notify(){
    const counts=new Map();for(const hit of hits)counts.set(hit.relPath,(counts.get(hit.relPath)||0)+1);
    for(const [path,group] of sections)group.firstChild.textContent=`${path} (${counts.get(path)||0})`;
    const count=hits.length;
    status.textContent=failure?`搜索失败：${failure}`:[done?(count?`${count} 个匹配 · ${counts.size} 个文件`:'未找到匹配'):`搜索中… ${count} 个匹配`,truncated?'结果已截断，请缩小搜索范围':'',problem.length?`${problem.length} 项未完整搜索`:''].filter(Boolean).join(' · ');
    stop.hidden=!active;issues.hidden=!problem.length;issueList.replaceChildren(...problem.map(issue=>make('li','',`${issue.relPath?issue.relPath+'：':''}${issue.message}`)));layout();
  }
  function cancel(){clearTimeout(timer);timer=null;generation++;enterIntent=null;const previous=active;active=null;if(previous)void invoke('project.search.cancel',{projectId:previous.projectId,requestId:previous.requestId}).catch(()=>{});stop.hidden=true;}
  function reset(){cancel();hits=[];rendered=0;sections.clear();results.replaceChildren();problem=[];failure='';done=false;truncated=false;issueList.replaceChildren();layout();}
  function mark(node,text,needle){if(!needle){node.textContent=text;return;}const index=text.indexOf(needle);if(index<0){node.textContent=text;return;}node.append(document.createTextNode(text.slice(0,index)));const highlight=make('mark','',needle);node.append(highlight,document.createTextNode(text.slice(index+needle.length)));}
  async function activate(hit,where,token){
    if(opening||!current(token))return;
    opening=true;results.setAttribute('aria-busy','true');
    try{
      const opened=await openAt(hit.relPath,where);
      if(!current(token))return;
      if(!opened)throw Error('文件未打开，请查看错误提示后重试。');
      if(hit.kind!=='file'){
        if(!revealHit)throw Error('内容定位不可用。');
        const response=await revealHit({...hit,requestId:token.requestId});
        if(!current(token))return;
        if(response?.ok===false)throw Error(response.error?.message||'无法定位搜索匹配');
      }
      if(dialog.open){returnFocus=null;quickFocusPath=where==='current'?hit.relPath:null;dialog.close();}else status.textContent='已打开 '+hit.relPath;
    }catch(error){
      if(current(token)){status.textContent='打开失败：'+(error.message||'未知错误');toast(error.message||'打开失败');}
    }finally{opening=false;results.removeAttribute('aria-busy');}
  }
  function renderMore(){
    results.querySelector('[data-search-more]')?.remove();
    const end=Math.min(hits.length,rendered+80);
    for(;rendered<end;rendered++){
      const hit=hits[rendered];let group=sections.get(hit.relPath);
      if(!group){
        group=make('details','project-search-file');group.open=true;
        const heading=make('summary','',hit.relPath);heading.title=hit.relPath;
        group.append(heading);sections.set(hit.relPath,group);
        const item=make('div');item.setAttribute('role','listitem');item.append(group);results.append(item);
      }
      const row=make('div','project-search-hit'),button=make('button','project-search-open');
      button.type='button';button.dataset.openTarget='current';button.dataset.path=hit.relPath;button.dataset.hitIndex=String(rendered);
      const token={generation,projectId:projectId(),requestId:hit.requestId};
      if(hit.kind==='file')mark(button,hit.relPath,target.value.trim());
      else{
        const position=make('small','',`${hit.page?`第 ${hit.page} 页 · `:''}${hit.line}:${hit.column}${hit.source==='buffer'?' · 编辑缓冲':''}`),preview=make('span','project-search-preview');
        mark(preview,hit.preview||'',hit.matchText);button.append(position,preview);button.title=`${hit.relPath}:${hit.line}:${hit.column}`;
      }
      button.onclick=()=>void activate(hit,'current',token);row.append(button);
      if(hit.kind==='file'){
        const actions=make('details','project-search-open-options'),summary=make('summary','','打开…');actions.append(summary);
        for(const [label,where] of [['右侧','right'],['下方','bottom'],['新窗口','window']]){
          const alternate=make('button','',label);alternate.type='button';alternate.dataset.openTarget=where;alternate.setAttribute('aria-label',`${label}打开 ${hit.relPath}`);alternate.onclick=()=>void activate(hit,where,token);actions.append(alternate);
        }
        row.append(actions);
      }
      group.append(row);
    }
    for(const [path,group] of sections){const total=hits.filter(hit=>hit.relPath===path).length;group.firstChild.textContent=`${path} (${total})`;}
    if(rendered<hits.length){const more=make('button','','显示更多结果');more.type='button';more.dataset.searchMore='';more.onclick=renderMore;results.append(more);}
    if(enterIntent&&enterIntent.generation===generation&&enterIntent.projectId===projectId()&&enterIntent.query===target.value.trim()){
      const first=results.querySelector('.project-search-file[open] [data-open-target="current"]');
      if(first){enterIntent=null;first.click();}
    }
  }
  results.addEventListener('scroll',()=>{if(results.scrollHeight-results.scrollTop-results.clientHeight<100&&rendered<hits.length)renderMore();},{passive:true});
  async function run(){timer=null;const query=target.value.trim(),id=projectId();if(!query||!id||!canSearch())return;const token={generation,projectId:id,requestId:crypto.randomUUID()};active=token;notify();try{const response=await invoke('project.search.start',{projectId:id,requestId:token.requestId,query,mode:target===quick?'files':mode,caseSensitive:toggles.caseSensitive.getAttribute('aria-pressed')==='true',wholeWord:toggles.wholeWord.getAttribute('aria-pressed')==='true',regex:toggles.regex.getAttribute('aria-pressed')==='true',include:scopes.include.value,exclude:scopes.exclude.value});if(!current(token)){void invoke('project.search.cancel',{projectId:id,requestId:token.requestId}).catch(()=>{});return;}if(!response.ok)throw Error(response.error?.message||'无法开始搜索');while(current(token)){const response=await invoke('project.search.poll',{projectId:id,requestId:token.requestId});if(!current(token))return;if(!response.ok)throw Error(response.error?.message||'无法读取搜索结果');const value=response.value;if(value.requestId!==token.requestId)throw Error('搜索响应标识不一致');for(const batch of value.batches||[])for(const hit of batch.matches||[]){if(hits.length<1000)hits.push({...hit,requestId:token.requestId});else truncated=true;}truncated=truncated||!!value.truncated;for(const issue of value.issues||[])if(!problem.some(p=>p.relPath===issue.relPath&&p.message===issue.message))problem.push(issue);if(value.error)failure=typeof value.error==='string'?value.error:value.error.message||'搜索失败';done=!!value.done||!!value.cancelled||!!value.error;if(value.cancelled&&!failure)failure='搜索已取消，以上为部分结果';if(done)active=null;if(rendered<80)renderMore();notify();if(done)return;await new Promise(resolve=>setTimeout(resolve,80));}}catch(error){if(current(token)){active=null;done=true;failure=error.message||'搜索失败';notify();}}}
  function schedule(){reset();if(!visible()||composing)return;if(!projectId()||!canSearch()){failure='请先打开可用项目';notify();return;}status.textContent='等待搜索…';timer=setTimeout(()=>void run(),150);}
  function clear(){reset();filter.value='';quick.value='';layout();}
  for(const input of [filter,quick]){input.addEventListener('compositionstart',()=>{composing=true;cancel();});input.addEventListener('compositionend',()=>{composing=false;schedule();});input.addEventListener('input',event=>{event.stopImmediatePropagation();schedule();},true);}
  for(const button of [files,content])button.onclick=()=>{mode=button.dataset.searchMode;schedule();controls.hidePopover();filter.focus();};
  for(const button of Object.values(toggles))button.onclick=()=>{button.setAttribute('aria-pressed',String(button.getAttribute('aria-pressed')!=='true'));schedule();};
  for(const input of Object.values(scopes))input.addEventListener('input',schedule);
  stop.onclick=()=>{
    clearTimeout(timer);timer=null;
    const previous=active;active=null;
    if(previous){previous.cancelled=true;void invoke('project.search.cancel',{projectId:previous.projectId,requestId:previous.requestId}).catch(()=>{});}
    done=true;notify();status.textContent=`搜索已停止 · ${hits.length} 个部分匹配`;
  };
  function keys(event){
    if(event.isComposing||composing||event.defaultPrevented)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(dialog.open)dialog.close();else{clear();filter.focus();}return;}
    if(!['ArrowDown','ArrowUp','Enter'].includes(event.key))return;
    const all=[...results.querySelectorAll('.project-search-file[open] [data-open-target="current"]')];
    if(event.key==='Enter'){
      if(event.target===target){event.preventDefault();if(all[0])all[0].click();else if(visible()){
        enterIntent={generation,projectId:projectId(),query:target.value.trim()};
        if(!active){clearTimeout(timer);timer=null;void run();}
      }}return;
    }
    if(!all.length)return;
    event.preventDefault();
    const index=all.indexOf(document.activeElement),next=index<0?(event.key==='ArrowDown'?0:all.length-1):Math.max(0,Math.min(all.length-1,index+(event.key==='ArrowDown'?1:-1)));
    all[next].focus();if(next===all.length-1&&rendered<hits.length)renderMore();
  }
  filter.addEventListener('keydown',keys);panel.addEventListener('keydown',keys);dialog.addEventListener('keydown',keys);
  function restoreSidebar(){reset();target=filter;(document.getElementById('workspace-open-editors')||tree).before(panel);quick.value='';filter.value='';layout();}
  dialog.addEventListener('close',()=>{if(target!==quick)return;restoreSidebar();const path=quickFocusPath;quickFocusPath=null;const focus=returnFocus;returnFocus=null;if(path)void Promise.resolve(focusOpened(path)).catch(error=>toast(error.message));else if(focus?.isConnected)focus.focus({preventScroll:true});});
  function showSearch(){if(window.__workspaceScope?.role==='surface')return false;if(!projectId()||!canSearch()){toast('请先打开可用项目');return false;}if(!dialog.open){reset();returnFocus=document.activeElement;target=quick;dialog.insertBefore(panel,close);dialog.showModal();schedule();}quick.focus();quick.select();return true;}
  function contentSearch(){
    if(window.__workspaceScope?.role==='surface')return;
    if(dialog.open){dialog.close();restoreSidebar();returnFocus=null;}
    const toggle=document.getElementById('file-toggle'),app=document.getElementById('app');
    // The drawer is independent of desktop collapse and aria-expanded can lag a resize.
    const closed=innerWidth<=1000?!app?.classList.contains('drawer-files-open'):app?.classList.contains('files-collapsed');
    if(closed)toggle?.click();
    mode='content';target=filter;schedule();filter.focus();filter.select();
  }
  document.addEventListener('keydown',event=>{
    if(!(event.ctrlKey||event.metaKey)||event.altKey||event.isComposing||event.defaultPrevented)return;
    const key=event.key.toLowerCase(),contentShortcut=event.shiftKey&&key==='f',fileShortcut=!event.shiftKey&&key==='p';
    if(!contentShortcut&&!fileShortcut)return;
    const scope=window.__workspaceScope;
    if(scope?.role==='surface'){
      if(['terminal','project-terminal'].includes(scope.kind))return;
      event.preventDefault();
      void invoke('workspace.control',{type:contentShortcut?'content-search':'quick-open',projectId:projectId()}).then(response=>{if(response?.ok===false)toast(response.error?.message||'无法打开项目搜索');}).catch(error=>toast(error.message||'无法打开项目搜索'));
      return;
    }
    event.preventDefault();
    if(contentShortcut)contentSearch();else showSearch();
  });
  function invalidate(){if(dialog.open){returnFocus=null;dialog.close();}clear();}
  layout();return {search:showSearch,searchContent:contentSearch,invalidate};
}
