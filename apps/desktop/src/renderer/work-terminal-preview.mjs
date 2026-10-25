import './work-terminal-preview.css';

// Observe the existing PTY screen; never attach, input, resize or acknowledge it.
export async function mountTerminalPreview({scope,invoke,subscribe}){
 const root=document.createElement('section');root.className='work-terminal-preview';root.setAttribute('aria-label','工作 Terminal 只读预览');
 const note=document.createElement('p');note.className='work-terminal-preview-note';note.textContent='只读 · 当前画面 · 非回滚历史，不接管输入';
 const status=document.createElement('p');status.setAttribute('role','status');
 const followBar=document.createElement('div');followBar.className='work-terminal-preview-follow';followBar.hidden=true;
 const followButton=document.createElement('button');followButton.type='button';followButton.textContent='回到当前画面';followButton.setAttribute('aria-label','回到当前画面底部');
 followBar.append(followButton);
 const viewport=document.createElement('div');viewport.className='work-terminal-preview-viewport';viewport.tabIndex=0;viewport.setAttribute('aria-label','终端当前画面，可滚动');
 const screen=document.createElement('pre');screen.className='work-terminal-preview-screen';viewport.append(screen);root.append(note,status,followBar,viewport);
 document.getElementById('app').replaceChildren(root);
 let version=-1,terminalId=null,inFlight=false,dirty=false,disposed=false,timer,follow=true;
 const atBottom=()=>viewport.scrollHeight-clientHeight<=viewport.scrollTop+2;
 viewport.addEventListener('scroll',()=>{const now=atBottom();if(now!==follow){follow=now;followBar.hidden=follow;followButton.disabled=follow;}},{passive:true});
 followButton.onclick=()=>{follow=true;followBar.hidden=true;viewport.scrollTop=viewport.scrollHeight;};

 async function refresh(){
  if(disposed)return;if(inFlight){dirty=true;return;}inFlight=true;dirty=false;
  try{
   const response=await invoke('managed.terminal.screen',{projectId:scope.projectId,target:scope.viewState.workId});
   if(disposed)return;
   if(!response.ok)throw Error(response.error?.message||'终端画面读取失败');
   const value=response.value;
   if(!value.available){status.textContent=value.reason;status.hidden=false;screen.replaceChildren();version=-1;terminalId=null;return;}
   status.hidden=true;
   if(terminalId===value.terminalId&&version===value.version)return;
   terminalId=value.terminalId;version=value.version;
   const fragment=document.createDocumentFragment();
   for(const runs of value.lines){const line=document.createElement('div');line.className='work-terminal-preview-line';
    for(const run of runs){const span=document.createElement('span');span.textContent=run.invisible?' '.repeat(run.cells):run.text;span.style.width=run.cells+'ch';let fg=run.fg||'#e5ece7',bg=run.bg||'#101512';if(run.inverse)[fg,bg]=[bg,fg];Object.assign(span.style,{color:fg,backgroundColor:bg,fontWeight:run.bold?'bold':'normal',fontStyle:run.italic?'italic':'normal',opacity:run.dim?'.5':'1',textDecoration:[run.underline?'underline':'',run.strike?'line-through':''].filter(Boolean).join(' ')});line.append(span);}
    fragment.append(line);
   }
   screen.replaceChildren(fragment);screen.dataset.terminalId=terminalId;screen.dataset.version=String(version);
   // The preview shows the current PTY screen only; short screens anchor to the
   // bottom and fresh frames keep following unless the user scrolled up to read.
   if(follow)viewport.scrollTop=viewport.scrollHeight;followBar.hidden=follow;followButton.disabled=follow;
  }catch(error){if(!disposed){status.hidden=false;status.textContent='预览暂不可用：'+error.message;}}
  finally{inFlight=false;if(dirty&&!disposed)schedule();}
 }
 function schedule(){dirty=true;if(!timer)timer=setTimeout(()=>{timer=null;void refresh();},80);}
 const unsubscribe=subscribe('agent',event=>{if(event.projectId!==scope.projectId)return;if(event.kind==='managed-state'||event.target===scope.viewState.workId&&['managed-terminal-screen','managed-terminal'].includes(event.kind))schedule();});
 subscribe('session.flush',()=>Promise.resolve({ok:true}));
 window.addEventListener('beforeunload',()=>{disposed=true;clearTimeout(timer);unsubscribe();},{once:true});
 await invoke('workspace.ready',{});await refresh();
 const ready=await invoke('workspace.ready',{contentReady:true});if(!ready.ok)throw Error(ready.error.message);
 window.__nozeliReady=true;
}
