import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './project-terminal-view.css';

// xterm's own stylesheet gets the existing page nonce, without relaxing CSP.
function terminalDocument(container) {
  const doc=container.ownerDocument,nonce=doc.querySelector('meta[name="nozeli-style-nonce"]')?.content;
  if(!nonce)return doc;
  return new Proxy(doc,{get(target,key){
    if(key==='createElement')return (name,options)=>{const element=target.createElement(name,options);if(String(name).toLowerCase()==='style')element.nonce=nonce;return element;};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
}

export async function mountProjectTerminal({root,scope,invoke,subscribe}) {
  const doc=root.ownerDocument,win=doc.defaultView,identity={projectId:scope.projectId,viewId:scope.viewId};
  const host=doc.createElement('section');host.className='project-terminal';host.setAttribute('aria-label','项目终端');
  const toolbar=doc.createElement('header');toolbar.className='project-terminal-toolbar';
  const title=doc.createElement('strong');title.textContent='终端';doc.title='终端';
  const status=doc.createElement('p');status.className='project-terminal-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const reconnect=doc.createElement('button');reconnect.type='button';reconnect.dataset.terminalAction='reconnect';reconnect.textContent='启动终端';
  const viewport=doc.createElement('div');viewport.className='project-terminal-viewport';viewport.setAttribute('aria-label','交互式终端');
  toolbar.append(title,status,reconnect);host.append(toolbar,viewport);root.replaceChildren(host);
  const terminal=new Terminal({documentOverride:terminalDocument(viewport),cursorBlink:!win.matchMedia('(prefers-reduced-motion: reduce)').matches,
    scrollback:5000,fontSize:14,fontFamily:'monospace',screenReaderMode:true,disableStdin:true,
    theme:{background:'#101512',foreground:'#e5ece7',cursor:'#e5ece7',selectionBackground:'#466b86'},
    // OSC 8 links remain inert; output never navigates or becomes application IPC.
    linkHandler:{activate(){},allowNonHttpProtocols:false}});
  const fit=new FitAddon();terminal.loadAddon(fit);terminal.open(viewport);
  terminal.textarea?.setAttribute('aria-label','项目终端输入');
  let instanceId=null,lastSeq=0,state='connecting',disposed=false,held=false,composing=false,connecting=false;
  let generation=0,timer=0,frame=0,inputBytes=0,inputError=null,inputQueue=Promise.resolve(),resizeQueue=Promise.resolve(),pollQueue=Promise.resolve();
  let lastSize='',attachRequested=false,restartRequested=false;
  const call=async(op,payload={})=>{const response=await invoke(op,payload);if(!response?.ok)throw Object.assign(Error(response?.error?.message||'终端操作失败'),{code:response?.error?.code});return response.value;};
  function paint(next,message){state=next;host.dataset.terminalState=state;host.dataset.instanceId=instanceId||'';status.textContent=message;
    terminal.options.disableStdin=held||state!=='running';reconnect.hidden=state==='running';reconnect.disabled=held||connecting;
    reconnect.textContent=state==='not-started'?'启动终端':'重新连接';}
  function fail(error){if(disposed)return;paint('error',error.message||'终端连接失败，请重新连接。');}
  const writeOutput=text=>new Promise(resolve=>{if(!text||disposed)return resolve();terminal.write(text,resolve);});
  function schedulePoll(delay=80){clearTimeout(timer);if(!disposed&&instanceId)timer=win.setTimeout(()=>{pollQueue=pollQueue.then(poll).catch(fail);},delay);}
  async function poll(){
    if(disposed||connecting||!instanceId)return;
    const id=instanceId,mine=generation;
    try{
      const value=await call('project-terminal.read',{...identity,instanceId:id,afterSeq:lastSeq});
      if(disposed||mine!==generation||value.instanceId!==id)return;
      if(value.truncated)await writeOutput('\r\n[较早输出已超出终端缓存范围]\r\n');
      for(const chunk of value.frames||[]){if(disposed||mine!==generation)return;if(chunk.seq<=lastSeq)continue;await writeOutput(chunk.data);lastSeq=chunk.seq;}
      if(disposed||mine!==generation)return;
      // An exited process can still have more bounded replay pages to drain.
      if(value.status==='exited'&&lastSeq>=value.nextSeq){paint('exited',`Shell 已退出${value.exitCode!=null?'（退出码 '+value.exitCode+'）':''}。重新连接将启动新 Shell。`);return;}
      schedulePoll(lastSeq<value.nextSeq?0:doc.hidden?250:80);
    }catch(error){if(mine!==generation||disposed)return;if(error.code==='TERMINAL_INSTANCE_STALE'){void attach(false);return;}fail(error);}
  }
  function fitTerminal(){
    frame=0;if(disposed||held||doc.hidden||!viewport.clientWidth||!viewport.clientHeight)return;
    fit.fit();
    const cols=Math.max(2,Math.min(500,terminal.cols)),rows=Math.max(2,Math.min(300,terminal.rows));
    if(cols!==terminal.cols||rows!==terminal.rows)terminal.resize(cols,rows);
    if(!instanceId||state!=='running')return;
    const id=instanceId,mine=generation,size=`${cols}:${rows}`;if(size===lastSize)return;lastSize=size;
    resizeQueue=resizeQueue.then(async()=>{if(disposed||held||mine!==generation)return;await call('project-terminal.resize',{...identity,instanceId:id,cols,rows});}).catch(error=>{if(mine===generation){lastSize='';fail(error);}});
  }
  function scheduleFit(){if(!frame&&!disposed)frame=win.requestAnimationFrame(fitTerminal);}
  async function attach(start){
    if(disposed)return;if(connecting){attachRequested=true;restartRequested ||= start;return;}
    connecting=true;clearTimeout(timer);const mine=++generation;paint('connecting','正在连接项目 Shell…');
    try{
      await pollQueue;fitTerminal();
      const value=await call('project-terminal.attach',{...identity,cols:Math.max(2,Math.min(500,terminal.cols)),rows:Math.max(2,Math.min(300,terminal.rows)),...(start?{restart:true}:{})});
      if(disposed||mine!==generation)return;
      if(value.instanceId!==instanceId){terminal.reset();lastSeq=0;lastSize='';inputError=null;}
      instanceId=value.instanceId;inputError=null;
      if(value.status==='not-started'){paint('not-started','终端未启动。点击启动；不会恢复执行上次命令。');return;}
      paint(value.status,value.status==='running'?'Shell · '+(value.shell?.name||'已连接'):'Shell 已退出。');
      if(value.cwd)status.title='初始目录：'+value.cwd;
      scheduleFit();schedulePoll(0);if(value.status==='running'&&doc.hasFocus())terminal.focus();
    }catch(error){fail(error);}
    finally{connecting=false;reconnect.disabled=held;if(attachRequested){const restart=restartRequested;attachRequested=false;restartRequested=false;void attach(restart);}}
  }
  const input=terminal.onData(text=>{
    if(disposed||held||state!=='running'||!instanceId)return;
    // Bound queued paste, split below the host's 16 KiB UTF-8 call budget.
    const bytes=new TextEncoder().encode(text).length;
    if(inputBytes+bytes>1024*1024){fail(Error('输入超过 1 MiB 队列上限，未发送本次输入；请缩小粘贴内容。'));return;}
    inputBytes+=bytes;const id=instanceId,mine=generation;
    const run=inputQueue.then(async()=>{
      for(let offset=0;offset<text.length;){
        if(disposed||mine!==generation||inputError)return;
        let end=Math.min(text.length,offset+4096);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
        await call('project-terminal.write',{...identity,instanceId:id,data:text.slice(offset,end)});offset=end;
      }
    });
    inputQueue=run.catch(error=>{if(mine===generation){inputError=error;fail(error);}}).finally(()=>{inputBytes-=bytes;});
  });
  terminal.attachCustomKeyEventHandler(event=>{
    const copy=(event.ctrlKey&&event.shiftKey&&!event.altKey&&!event.metaKey||event.metaKey&&!event.ctrlKey&&!event.altKey)&&event.key.toLowerCase()==='c';
    if(!copy)return true;
    if(event.type==='keydown'){event.preventDefault();const selection=terminal.getSelection();if(selection)void win.navigator.clipboard.writeText(selection).catch(error=>{status.textContent='复制失败：'+error.message;});}
    return false;
  });
  viewport.addEventListener('compositionstart',()=>{composing=true;});viewport.addEventListener('compositionend',()=>{composing=false;});
  reconnect.onclick=()=>void attach(true);
  const unsubscribers=[subscribe('session.flush',async()=>{
    if(composing)return {ok:false,composing:true,error:{code:'COMPOSING',message:'终端输入法组合尚未结束。'}};
    await inputQueue;await resizeQueue;
    if(inputError)return {ok:false,error:{code:'TERMINAL_INPUT_FAILED',message:'部分终端输入未确认送达，已暂停后续输入。请检查终端并显式重新连接；未送达的输入不会自动重放。'}};
    return {ok:true};
  }),subscribe('workspace.control',event=>{
    if(event.type==='project-terminal-open'&&event.projectId===scope.projectId&&event.viewId===scope.viewId){void attach(false);}
    else if(event.type==='focus-content'){if(state==='running')terminal.focus();else reconnect.focus();}
    else if(event.type==='transfer-hold'){held=event.held===true;host.inert=held;terminal.options.disableStdin=held||state!=='running';reconnect.disabled=held||connecting;if(!held)scheduleFit();}
    else if(event.type==='viewport-changed'||event.type==='host')scheduleFit();
  })];
  const resize=new ResizeObserver(scheduleFit);resize.observe(viewport);
  doc.addEventListener('visibilitychange',scheduleFit);win.addEventListener('resize',scheduleFit);
  win.addEventListener('beforeunload',()=>{
    disposed=true;generation++;clearTimeout(timer);win.cancelAnimationFrame(frame);resize.disconnect();input.dispose();
    for(const unsubscribe of unsubscribers)unsubscribe?.();doc.removeEventListener('visibilitychange',scheduleFit);win.removeEventListener('resize',scheduleFit);
    // Host owns shell lifetime; hiding/reparenting/unloading is not a stop request.
    void pollQueue.finally(()=>terminal.dispose());
  },{once:true});
  try{await call('workspace.ready',{});await attach(false);await call('workspace.ready',{contentReady:true});win.__nozeliReady=true;}
  catch(error){fail(error);await invoke('workspace.ready',{contentFailed:true,error:{code:error.code||'TERMINAL_INIT_FAILED',message:error.message}});}
}
