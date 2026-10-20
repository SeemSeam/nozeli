import './work-terminal-preview.css';

// A screen observer only: no attach, input, resize, ACK, focus or detach channel.
export function createWorkTerminalPreview({readScreen,subscribe,document:doc=document}){
 const popup=doc.createElement('aside');popup.className='work-terminal-preview';popup.hidden=true;popup.setAttribute('role','region');popup.setAttribute('aria-label','工作终端只读预览');
 const heading=doc.createElement('header'),title=doc.createElement('strong'),label=doc.createElement('small');label.textContent='只读预览';heading.append(title,label);
 const status=doc.createElement('p');status.className='work-terminal-preview-status';status.setAttribute('role','status');
 const viewport=doc.createElement('div');viewport.className='work-terminal-preview-viewport';const screen=doc.createElement('div');screen.className='work-terminal-preview-screen';viewport.append(screen);popup.append(heading,status,viewport);doc.body.append(popup);
 let current=null,generation=0,closeTimer,refreshTimer,unsubscribe=()=>{},inFlight=false,dirty=false,lastVersion=-1,lastTerminal=null,endedTerminal=null,snapshot=null;
 const win=doc.defaultView;
 const cellWidth=doc.createElement('canvas').getContext('2d');cellWidth.font='13px monospace';const cell=cellWidth.measureText('M').width,rowHeight=18;
 function cancelLeave(){clearTimeout(closeTimer);closeTimer=null;}
 function close(){generation++;cancelLeave();clearTimeout(refreshTimer);refreshTimer=null;unsubscribe();unsubscribe=()=>{};current?.anchor.removeAttribute('aria-expanded');current=null;snapshot=null;popup.hidden=true;screen.replaceChildren();}
 function leaving(){cancelLeave();closeTimer=setTimeout(()=>{if(current&&(current.anchor.parentElement?.matches(':hover')||popup.matches(':hover')))return;close();},120);}
 popup.addEventListener('pointerenter',cancelLeave);popup.addEventListener('pointerleave',leaving);
 popup.addEventListener('wheel',e=>e.preventDefault(),{passive:false});popup.addEventListener('contextmenu',e=>e.preventDefault());popup.addEventListener('pointerdown',e=>e.preventDefault());
 function place(){
  if(!current)return;
  const anchor=current.anchor,rect=anchor.getBoundingClientRect(),style=win.getComputedStyle(anchor),app=anchor.closest('#app'),sidebarHidden=app?.classList.contains('narrow-layout')?!app.classList.contains('drawer-side-open'):app?.classList.contains('side-collapsed');
  if(!anchor.isConnected||!anchor.getClientRects().length||style.visibility==='hidden'||sidebarHidden||rect.bottom<0||rect.top>win.innerHeight){close();return;}
  const width=Math.max(180,Math.min(720,win.innerWidth-24));
  popup.style.width=width+'px';
  popup.style.left=Math.max(12,Math.min(win.innerWidth-width-12,rect.left-width-8))+'px';
  popup.style.maxHeight=Math.max(100,win.innerHeight-24)+'px';
  viewport.style.height=Math.max(40,Math.min(420,win.innerHeight-96))+'px';
  const height=popup.getBoundingClientRect().height;
  popup.style.top=Math.max(12,Math.min(win.innerHeight-height-12,rect.top))+'px';
  if(snapshot){
   const fit=Math.min(1,viewport.clientWidth/(snapshot.cols*cell),viewport.clientHeight/(snapshot.rows*rowHeight)),scale=Math.max(.75,fit);label.textContent=fit<.75?'只读预览 · 画面裁切':'只读预览';screen.style.top=Math.min(0,viewport.clientHeight-snapshot.rows*rowHeight*scale)+'px';
   screen.style.width=snapshot.cols*cell+'px';screen.style.height=snapshot.rows*rowHeight+'px';screen.style.transform=`scale(${scale})`;
  }
 }
 function paint(value){
  snapshot=value;screen.replaceChildren();
  for(const runs of value.lines){const line=doc.createElement('div');line.className='work-terminal-preview-line';
   for(const run of runs){const span=doc.createElement('span');span.textContent=run.invisible?' '.repeat(run.cells):run.text;span.style.width=run.cells*cell+'px';
    let fg=run.fg||'#e5ece7',bg=run.bg||'#101512';if(run.inverse)[fg,bg]=[bg,fg];span.style.color=fg;span.style.backgroundColor=bg;span.style.fontWeight=run.bold?'bold':'normal';span.style.fontStyle=run.italic?'italic':'normal';span.style.opacity=run.dim?'.5':'1';span.style.textDecoration=[run.underline?'underline':'',run.strike?'line-through':''].filter(Boolean).join(' ');line.append(span);}
   screen.append(line);
  }
  status.textContent='';status.hidden=true;viewport.hidden=false;place();
 }
 async function refresh(){
  if(!current)return;if(inFlight){dirty=true;return;}
  const mine=generation,request=current;inFlight=true;dirty=false;
  try{
   const value=await readScreen(request.projectId,request.workId);
   if(mine!==generation)return;
   if(!value.available){status.hidden=false;status.textContent=value.reason||'暂无终端画面';viewport.hidden=true;snapshot=null;return;}
   if(value.terminalId===endedTerminal)return;
   if(value.terminalId!==lastTerminal){lastTerminal=value.terminalId;lastVersion=-1;}
   if(value.version>=lastVersion){lastVersion=value.version;paint(value);}
  }catch(error){if(mine===generation){status.hidden=false;status.textContent='预览暂不可用：'+error.message;viewport.hidden=true;}}
  finally{inFlight=false;if(dirty&&current){dirty=false;refreshTimer=setTimeout(()=>{refreshTimer=null;void refresh();},80);}}
 }
 function open({projectId,workId,name,phase,anchor}){
  if(current?.projectId===projectId&&current.workId===workId){close();return;}
  close();current={projectId,workId,anchor};lastTerminal=null;endedTerminal=null;lastVersion=-1;label.textContent='只读预览';title.textContent=name+' · '+phase;status.textContent='正在读取终端画面…';status.hidden=false;viewport.hidden=true;popup.hidden=false;anchor.setAttribute('aria-expanded','true');place();if(!current)return;
  unsubscribe=subscribe(e=>{
   if(!current||e.projectId!==projectId||e.target!==workId)return;
   if(e.kind==='managed-terminal-screen'){dirty=true;if(!refreshTimer)refreshTimer=setTimeout(()=>{refreshTimer=null;void refresh();},80);}
   if(e.kind==='managed-terminal'&&e.ended&&(!lastTerminal||e.terminalId===lastTerminal)){endedTerminal=e.terminalId;status.hidden=false;status.textContent='终端已断开，画面停止更新。';viewport.hidden=!snapshot;}
  });void refresh();
 }
 function update({projectId,works}){
  if(!current)return;if(projectId!==current.projectId){close();return;}
  const work=works.find(w=>w.id===current.workId);if(!work||['ended','closing'].includes(work.status)){close();return;}
  title.textContent=work.name+' · '+work.phase;place();
 }
 function onOutside(e){if(current&&!popup.contains(e.target)&&!current.anchor.parentElement?.contains(e.target))close();}
 function onKey(e){if(e.key==='Escape')close();}
 doc.addEventListener('pointerdown',onOutside,true);doc.addEventListener('keydown',onKey,true);
 const observer=new MutationObserver(()=>{if(current)place();});observer.observe(doc.getElementById('app')||doc.body,{attributes:true,subtree:true,attributeFilter:['class','hidden']});
 win.addEventListener('resize',place);doc.addEventListener('scroll',place,true);
 return {open,close,update,enter(e){if(current?.anchor.parentElement===e.currentTarget)cancelLeave();},leave(e){if(current?.anchor.parentElement===e.currentTarget)leaving();},dispose(){close();observer.disconnect();win.removeEventListener('resize',place);doc.removeEventListener('scroll',place,true);doc.removeEventListener('pointerdown',onOutside,true);doc.removeEventListener('keydown',onKey,true);popup.remove();}};
}
