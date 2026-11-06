const registries = new WeakMap();
function registry(doc) { let value = registries.get(doc); if (!value) registries.set(doc, value = { rows: new Map(), listeners: new Set(), z: 10 }); return value; }
export function localWindowOcclusions(doc = document) { return [...registry(doc).rows.values()].map(value => structuredClone(value)); }
export function subscribeLocalWindowOcclusions(doc, listener) { const value = registry(doc); value.listeners.add(listener); return () => value.listeners.delete(listener); }
export function ensureLocalWindowLayer(parent = document.body) {
  if(parent===parent.ownerDocument.body)parent=parent.querySelector('#app') || parent;
  let layer = [...parent.children].find(node => node.classList.contains('local-window-layer'));
  if (!layer) { layer = parent.ownerDocument.createElement('div'); layer.className = 'local-window-layer'; parent.append(layer); }
  return layer;
}
export function viewportWindowEnvironment(layer, { defaultRect = () => ({x:24,y:24,width:380,height:380}), epoch = () => 0 } = {}) {
  const doc = layer.ownerDocument, win = doc.defaultView;
  return {
    measure() { const viewport={x:0,y:0,width:doc.documentElement.clientWidth,height:doc.documentElement.clientHeight};const parent=layer.parentElement;const box=parent&&parent!==doc.body?parent.getBoundingClientRect():viewport;const x=Math.max(0,box.x),y=Math.max(0,box.y);return {bounds:{x,y,width:Math.max(0,Math.min(viewport.width,box.x+box.width)-x),height:Math.max(0,Math.min(viewport.height,box.y+box.height)-y)},defaultRect:typeof defaultRect === 'function' ? defaultRect() : defaultRect,epoch:typeof epoch === 'function' ? epoch() : epoch}; },
    toLocal: (x,y) => ({x,y}),
    subscribe(invalidate) { win.addEventListener('resize',invalidate); doc.addEventListener('scroll',invalidate,true); win.visualViewport?.addEventListener('resize',invalidate);const observer=typeof win.ResizeObserver==='function'?new win.ResizeObserver(invalidate):null; if(layer.parentElement)observer?.observe(layer.parentElement);const visibility=typeof win.MutationObserver==='function'?new win.MutationObserver(invalidate):null;for(let ancestor=layer;ancestor;ancestor=ancestor.parentElement)visibility?.observe(ancestor,{attributes:true,attributeFilter:['hidden','style','class','inert','aria-hidden']});return () => {visibility?.disconnect();observer?.disconnect();win.removeEventListener('resize',invalidate); doc.removeEventListener('scroll',invalidate,true); win.visualViewport?.removeEventListener('resize',invalidate); }; }
  };
}
export const defaultLocalWindowView = () => ({schema:1,revision:0,placement:{mode:'auto'},size:null,collapsed:false,hidden:false});
export function validLocalWindowView(value) {
  return value?.schema === 1 && Number.isSafeInteger(value.revision) && value.revision >= 0 && ['auto','manual'].includes(value.placement?.mode) && (value.placement.mode === 'auto' || [value.placement.x,value.placement.y].every(Number.isFinite)) && (value.size === null || value.size && [value.size.width,value.size.height].every(n => Number.isFinite(n) && n > 0)) && typeof value.collapsed === 'boolean' && typeof value.hidden === 'boolean';
}
export function localWindowRect(state, measured) {
  const b = measured.bounds, d = measured.defaultRect;
  const width = Math.max(0,Math.min(b.width,state.size?.width ?? d.width)), height = Math.max(0,Math.min(b.height,state.collapsed ? 36 : state.size?.height ?? d.height));
  const x = state.placement.mode === 'manual' ? state.placement.x : d.x, y = state.placement.mode === 'manual' ? state.placement.y : d.y;
  return {x:Math.max(b.x,Math.min(x,b.x+b.width-width)),y:Math.max(b.y,Math.min(y,b.y+b.height-height)),width,height};
}
export function mountLocalWindow({layer,key,title,body,actions,state=defaultLocalWindowView(),environment=viewportWindowEnvironment(layer),commitView,beforeHide,onError=()=>{}}) {
  const doc = layer.ownerDocument, win = doc.defaultView, reg = registry(doc), token = Symbol(), cleanups = [];
  let view = validLocalWindowView(state) ? structuredClone(state) : defaultLocalWindowView(), durable = structuredClone(view), measured, rect, confirmed = null;
  let gesture = null, frame = 0, sequence = 0, disposed = false, composing = false, entry = null, dirty = false, conflict = null, failure = null, keyboardTimer = 0;
  let saves = Promise.resolve(), publications = Promise.resolve();
  const node = doc.createElement('section'); node.className = 'local-window'; node.dataset.localWindow = JSON.stringify(key); node.setAttribute('aria-label',typeof title === 'string' ? title : '局部窗口');
  node.dataset.localWindowOwnerKind=key.ownerKind;node.dataset.localWindowOwnerId=key.ownerId;node.dataset.localWindowSurfaceId=key.surfaceId;
  const header = doc.createElement('div'); header.className = 'local-window-header'; header.tabIndex = 0; header.setAttribute('aria-label','移动窗口：方向键移动，Shift微调，Home恢复默认位置');
  header.dataset.localWindowHeader='';
  const caption = doc.createElement('span'); caption.className = 'local-window-title'; if (typeof title === 'string') caption.textContent = title; else if (title) caption.append(title);
  const button = (label,action) => { const b=doc.createElement('button'); b.type='button'; b.textContent=label; b.addEventListener('click',()=>{void Promise.resolve(action()).catch(report);}); return b; };
  const fold = button('收起',()=>api.collapse(!view.collapsed)), close = button('关闭',()=>api.hide());
  fold.dataset.localWindowCollapse='';close.dataset.localWindowHide='';
  header.append(caption,fold,close);
  const content = doc.createElement('div'); content.className='local-window-body'; if(body)content.append(body); if(actions)content.append(actions);
  const notice = doc.createElement('div'); notice.className='local-window-error'; notice.hidden=true; notice.setAttribute('role','alert');
  const errorText=doc.createElement('span'), reload=button('重新载入位置',()=>{if(!conflict)return;view=structuredClone(conflict);durable=structuredClone(view);dirty=false;conflict=null;failure=null;saves=Promise.resolve();notice.hidden=true;return paint();}), retry=button('保存本次位置',async()=>{if(conflict){view.revision=conflict.revision;durable=structuredClone(conflict);conflict=null;}failure=null;await paint();return persist('move');}); notice.append(errorText,reload,retry);
  const resize=doc.createElement('button'); resize.type='button'; resize.className='local-window-resize'; resize.setAttribute('aria-label','调整窗口大小：方向键，Shift微调');
  resize.dataset.localWindowResize='';
  node.append(header,content,notice,resize); layer.append(node);
  function report(error) { failure=error; errorText.textContent=error?.message || '窗口位置尚未保存；内容已保留。'; notice.hidden=false; reload.hidden=!conflict; onError(error); }
  function publish() {
    const current=++sequence, epoch=measured.epoch, row={key,epoch,sequence:current,rect:{...rect}};
    const visible=!view.hidden&&!disposed&&node.isConnected&&win.getComputedStyle(node).visibility!=='hidden'&&node.getClientRects().length>0;
    if(!visible)reg.rows.delete(token);else reg.rows.set(token,row);
    const rows=localWindowOcclusions(doc);
    const run=Promise.all([...reg.listeners].map(listener=>Promise.resolve().then(()=>listener(rows))).concat(environment.publishOcclusion ? [Promise.resolve().then(()=>environment.publishOcclusion({...row,visible}))] : []));
    publications=run.then(()=>{if(current===sequence&&!disposed&&epoch===measured.epoch)confirmed={rect:{...row.rect},hidden:view.hidden};},error=>{if(current!==sequence||disposed||epoch!==measured.epoch)return;cancel(false);if(confirmed){rect={...confirmed.rect};Object.assign(node.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});node.hidden=confirmed.hidden;if(confirmed.hidden)reg.rows.delete(token);else reg.rows.set(token,{...row,rect:{...rect}});}report(error);throw error;});
    publications.catch(()=>{}); return publications;
  }
  function paint() {
    if(disposed)return; const next=environment.measure();
    if(gesture && measured && next.epoch!==measured.epoch)cancel(false);
    measured=next;rect=localWindowRect(view,measured);
    Object.assign(node.style,{left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'});
    node.hidden=view.hidden;node.classList.toggle('is-collapsed',view.collapsed);content.hidden=view.collapsed;resize.hidden=view.collapsed;fold.textContent=view.collapsed?'展开':'收起';fold.setAttribute('aria-expanded',String(!view.collapsed));
    return publish();
  }
  function schedule() { if(!frame)frame=win.requestAnimationFrame(()=>{frame=0;paint();}); }
  function persist(reason) {
    dirty=true;
    const next=structuredClone(view);
    const run=saves.catch(()=>{}).then(async()=>{
      await publications;
      if(conflict)throw failure;
      if(!commitView)throw Error('窗口位置没有可用的保存通路，当前内容仍保留。');
      const result=await commitView({key,expectedRevision:durable.revision,next:{...next,revision:durable.revision},reason});
      if(result?.conflict){conflict=result.current;throw Error(`窗口位置冲突：本次基于版本 ${durable.revision}，已保存版本 ${conflict.revision}。请选择重新载入或保存本次位置。`);}
      const revision=typeof result==='number'?result:result?.revision;
      if(!Number.isSafeInteger(revision))throw Error('窗口位置保存未获确认。');
      durable={...next,revision};view.revision=revision;
      if(JSON.stringify({...view,revision})===JSON.stringify(durable))dirty=false;
      failure=null;notice.hidden=true;return revision;
    }).catch(error=>{report(error);throw error;});
    saves=run;run.catch(()=>{});return run;
  }
  function release() { const old=gesture;gesture=null;if(old){try{if(old.target.hasPointerCapture(old.id))old.target.releasePointerCapture(old.id);}catch{}} }
  function cancel(redraw=true) { if(!gesture)return;view={...gesture.original,revision:durable.revision};release();if(frame){win.cancelAnimationFrame(frame);frame=0;}if(redraw)paint(); }
  function down(event,mode) {
    if(gesture||event.button!==0||event.isPrimary===false||composing)return;
    if(mode==='move'&&event.composedPath().some(el=>el!==header&&el!==caption&&el.matches?.('button,input,textarea,select,a,summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="textbox"],[role="menuitem"],[data-no-drag]')))return;
    const start=environment.toLocal(event.clientX,event.clientY); gesture={id:event.pointerId,target:event.currentTarget,mode,start,rect:{...rect},original:structuredClone(view),moved:false};
    event.currentTarget.setPointerCapture(event.pointerId);node.style.zIndex=String(++reg.z);event.preventDefault();
  }
  function moving(event) { const g=gesture;if(!g||g.id!==event.pointerId)return;const point=environment.toLocal(event.clientX,event.clientY),dx=point.x-g.start.x,dy=point.y-g.start.y;if(!g.moved&&Math.hypot(dx,dy)<3)return;g.moved=true;if(g.mode==='move')view.placement={mode:'manual',x:g.rect.x+dx,y:g.rect.y+dy};else view.size={width:Math.max(160,g.rect.width+dx),height:Math.max(100,g.rect.height+dy)};schedule();event.preventDefault(); }
  function up(event) { if(!gesture||event.pointerId!==gesture.id)return;const {moved,mode}=gesture;release();if(frame){win.cancelAnimationFrame(frame);frame=0;}if(moved){paint();void persist(mode).catch(()=>{});} }
  function keys(event,mode) { if(event.target!==event.currentTarget||event.isComposing||composing)return;if(event.key==='Home'){event.preventDefault();void api.reset().catch(()=>{});return;}if(!event.key.startsWith('Arrow'))return;event.preventDefault();const step=event.shiftKey?1:10,dx=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,dy=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;if(mode==='move')view.placement={mode:'manual',x:rect.x+dx,y:rect.y+dy};else view.size={width:Math.max(160,rect.width+dx),height:Math.max(100,rect.height+dy)};paint();dirty=true;clearTimeout(keyboardTimer);keyboardTimer=setTimeout(()=>{keyboardTimer=0;void persist(mode).catch(()=>{});},180); }
  function listen(target,type,fn,options) { target.addEventListener(type,fn,options);cleanups.push(()=>target.removeEventListener(type,fn,options)); }
  for(const [target,mode] of [[header,'move'],[resize,'resize']]){listen(target,'pointerdown',e=>down(e,mode));listen(target,'keydown',e=>keys(e,mode));listen(target,'lostpointercapture',()=>cancel());}
  listen(doc,'pointermove',moving);listen(doc,'pointerup',up);listen(doc,'pointercancel',e=>{if(gesture?.id===e.pointerId)cancel();});listen(win,'blur',()=>cancel());
  listen(node,'compositionstart',()=>{composing=true;});listen(node,'compositionend',()=>{composing=false;});
  listen(node,'keydown',event=>{if(event.key!=='Escape'||event.isComposing||composing||event.defaultPrevented)return;if(gesture){event.preventDefault();event.stopPropagation();cancel();return;}if([...doc.querySelectorAll('dialog[open],[aria-modal="true"]:not([hidden]),.nozeli-context-menu:not([hidden])')].some(overlay=>overlay.getClientRects().length&&!overlay.contains(node)))return;event.preventDefault();event.stopPropagation();void api.hide().catch(()=>{});});
  listen(node,'pointerdown',()=>{node.style.zIndex=String(++reg.z);});
  let unsubscribe=environment.subscribe?.(schedule);
  const api={node,header,snapshot:()=>structuredClone(view),
    async show(opener) {entry=opener?.focus?opener:doc.activeElement;view.hidden=false;view.collapsed=false;await paint();return persist('hide');},
    async collapse(value=true) {cancel();view.collapsed=value;await paint();return persist('collapse');},
    async hide() {if(composing)throw Error('请先完成输入法组合，草稿仍保留。');await beforeHide?.();await api.flush();cancel();view.hidden=true;await paint();try{await persist('hide');}catch(error){view.hidden=false;paint();throw error;}entry?.focus?.({preventScroll:true});},
    async reset() {cancel();view.placement={mode:'auto'};view.size=null;await paint();return persist('reset');},
    update(value={}) {if(value.title!==undefined){caption.replaceChildren();if(typeof value.title==='string')caption.textContent=value.title;else caption.append(value.title);}if(value.state&&validLocalWindowView(value.state)&&!gesture&&!dirty){view=structuredClone(value.state);durable=structuredClone(view);}if(value.environment){cancel();unsubscribe?.();environment=value.environment;unsubscribe=environment.subscribe?.(schedule);}if(value.error)report(value.error);paint();},
    async flush() {cancel();if(keyboardTimer){clearTimeout(keyboardTimer);keyboardTimer=0;await persist('move');}await saves;await publications;if(failure)throw failure;},
    async dispose() {await api.flush();cancel(false);const previousHidden=view.hidden;view.hidden=true;try{await paint();}catch(error){view.hidden=previousHidden;throw error;}disposed=true;if(frame)win.cancelAnimationFrame(frame);clearTimeout(keyboardTimer);unsubscribe?.();cleanups.forEach(fn=>fn());reg.rows.delete(token);node.remove();}
  };
  node.localWindow=api;
  if(!validLocalWindowView(state))report(Error('窗口展示数据版本未知或损坏，原记录已保留。'));
  paint();return api;
}
