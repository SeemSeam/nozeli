import './local-window.css';
import {normalizeWebUrl} from '../domain/web-url.mjs';
import {largestUnobstructedRect} from '../domain/web-window-clip.mjs';
import {mountWebDiscussion} from './web-discussion-panel.mjs';
import {mountLocalWindow,ensureLocalWindowLayer,viewportWindowEnvironment,localWindowOcclusions,subscribeLocalWindowOcclusions} from './local-window.mjs';
import {createLocalWindowView} from './local-window-view.mjs';
import './online-browser-view.css';

// This is trusted chrome only. The website is a main-process-owned, preload-free guest.
// The guest keeps the FULL viewport rect: a floating discussion window publishes
// its occlusion rect and the largest unobstructed portion of the unchanged
// viewport is sent as `clip`, so avoiding the window never reflows the page or
// shrinks the guest bounds (web.bounds carries a monotonic sequence so a stale
// receipt cannot reclip a newer layout).
export function mountOnlineBrowser({root,scope,invoke,subscribe}){
 const doc=root.ownerDocument,win=doc.defaultView,key=crypto.randomUUID();
 const identity={viewId:scope.viewId,key,generation:scope.generation};
 const host=doc.createElement('section');host.className='online-browser';host.setAttribute('aria-label','网站浏览器');
 const toolbar=doc.createElement('form');toolbar.className='online-browser-toolbar';toolbar.setAttribute('aria-label','浏览器导航');
 const button=(label,action)=>{const el=doc.createElement('button');el.type='button';el.textContent=label;el.setAttribute('aria-label',label);el.dataset.browserAction=action;toolbar.append(el);return el;};
 const back=button('后退','back'),forward=button('前进','forward'),reload=button('刷新','reload');
 const address=doc.createElement('input');address.type='text';address.inputMode='url';address.autocomplete='off';address.spellcheck=false;address.maxLength=8192;address.setAttribute('aria-label','网站地址（HTTP 或 HTTPS）');toolbar.append(address);
 const go=doc.createElement('button');go.type='submit';go.textContent='前往';toolbar.append(go);
 const status=doc.createElement('p');status.className='online-browser-status';status.hidden=true;status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const viewport=doc.createElement('div');viewport.className='online-browser-viewport';viewport.setAttribute('aria-label','网站内容');
 const content=doc.createElement('div');content.className='online-browser-content';content.append(viewport);host.append(toolbar,status,content);root.replaceChildren(host);
 let state={url:normalizeWebUrl(scope.url),title:new URL(scope.url).host,loading:false,canGoBack:false,canGoForward:false};
 let draft=typeof scope.viewState?.addressDraft==='string'?scope.viewState.addressDraft:state.url;
 let dirtyDraft=typeof scope.viewState?.addressDraft==='string',composing=false,held=false,opened=false,disposed=false,frame=0,timer=0,saveQueue=Promise.resolve();
 let discussion=null,discussionWindow=null,discussionUrl=null,discussionReady=Promise.resolve(),boundsSequence=0;
 address.value=draft;win.__nozeliReady=false;
 const call=async(op,payload={})=>{const result=await invoke(op,payload);if(!result?.ok)throw Object.assign(new Error(result.error?.message||'浏览器操作失败'),{code:result.error?.code});return result.value;};
 const fail=error=>{status.textContent=error.message;status.hidden=false;status.classList.add('is-error');scheduleBounds();};
 function paint(){doc.title=state.title||new URL(state.url).host;back.disabled=held||!opened||!state.canGoBack;forward.disabled=held||!opened||!state.canGoForward;reload.disabled=held||!opened;address.disabled=held;go.disabled=held||!opened;reload.textContent=state.loading?'停止':'刷新';reload.setAttribute('aria-label',reload.textContent);reload.dataset.browserAction=state.loading?'stop':'reload';host.setAttribute('aria-busy',String(Boolean(state.loading)));status.classList.toggle('is-error',Boolean(state.error));status.textContent=state.error?(typeof state.error==='string'?state.error:state.error.message||'网站加载失败'):state.loading?'正在加载…':'';status.hidden=!status.textContent;}
 // One floating discussion window per committed URL: the same body node moves
 // into the new shell after the previous URL's draft is saved, so inputs,
 // thread DOM and selection identity are never rebuilt.
 async function ensureDiscussionWindow(url){
  if(discussionWindow&&discussionUrl===url)return discussionWindow;
  // dispose does not run beforeHide: the previous URL's draft is saved here,
  // then the old shell is disposed and the same body node moves to the new one.
  if(discussionWindow){const previous=discussionWindow;await discussion.flush();await previous.dispose();discussionWindow=null;}
  const layer=ensureLocalWindowLayer(host);
  const windowKey={projectId:scope.projectId,ownerKind:'web',ownerId:url,surfaceId:scope.viewId};
  const initial={schema:1,revision:0,placement:{mode:'auto'},size:null,collapsed:false,hidden:true};
  const view=createLocalWindowView({invoke,key:windowKey,initial});
  let windowState=initial;
  try{windowState=await view.load();}catch(error){fail(error);}
  if(!discussion){discussion=mountWebDiscussion({call,identity,onError:fail,isHidden:()=>!discussionWindow||discussionWindow.node.hidden});discussion.setPage(state.url);discussion.setHeld(held);}
  discussionUrl=url;
  discussionWindow=mountLocalWindow({layer,key:windowKey,title:'网页讨论 · '+new URL(url).host,body:discussion.node,state:windowState,environment:viewportWindowEnvironment(layer,{defaultRect:()=>{const rect=viewport.getBoundingClientRect(),width=Math.min(340,Math.max(200,rect.width-24)),height=Math.min(500,Math.max(160,rect.height-24));return {x:Math.max(12,rect.right-width-12),y:Math.max(12,rect.top+12),width,height};},epoch:()=>identity.generation}),commitView:view.commitView,beforeHide:()=>discussion.flush(),onError:fail});
  scheduleBounds();
  return discussionWindow;
 }
 function openDiscussion(next){
  discussionReady=discussionReady.then(async()=>{
   const current=await ensureDiscussionWindow(next.url);
   if(disposed)return;
   await discussion.open(next);
   await current.show();
   scheduleBounds();
  }).catch(fail);
  return discussionReady;
 }
 function receive(value){if(disposed||value?.viewId!==identity.viewId||value.key!==key||value.generation!==identity.generation)return;try{if(value.url)normalizeWebUrl(value.url);}catch{return;}state={...state,...value};if(!dirtyDraft&&doc.activeElement!==address){draft=state.url;address.value=draft;}discussion?.setPage(state.url);if(value.discussionOpen)void openDiscussion(value.discussionOpen);paint();scheduleBounds();}
 function save(){clearTimeout(timer);timer=0;const viewState={...scope.viewState};if(dirtyDraft)viewState.addressDraft=address.value;else delete viewState.addressDraft;scope.viewState=viewState;const run=saveQueue.then(()=>call('workspace.command',{projectId:scope.projectId,requestKey:crypto.randomUUID(),command:{type:'restoreViewState',viewId:scope.viewId,viewState}}));saveQueue=run.catch(()=>{});return run;}
 async function flush(){if(composing)return {ok:false,composing:true,error:{code:'COMPOSING',message:'地址输入尚未结束。'}};try{await discussion?.flush();if(discussionWindow)await discussionWindow.flush();await save();return {ok:true};}catch(error){return {ok:false,error:{code:error.code||'WEB_STATE_SAVE_FAILED',message:error.message}};}}
 function overlay(){return held||doc.hidden||Boolean([...doc.querySelectorAll('dialog[open], [aria-modal="true"]:not([hidden]), .nozeli-context-menu:not([hidden]), details[open]')].some(el=>el.getClientRects().length));}
 // Largest unobstructed portion of the unchanged viewport: ancestor overflow
 // first, then every live local-window occlusion row (same-document CSS px).
 function visibleClip(rows){
  const r=viewport.getBoundingClientRect();
  let x=r.left,y=r.top,right=r.right,bottom=r.bottom;
  for(let node=viewport.parentElement;node&&node!==doc.documentElement&&right>x&&bottom>y;node=node.parentElement){
   const style=getComputedStyle(node),clip=node.getBoundingClientRect();
   if(style.overflowX!=='visible'){x=Math.max(x,clip.left);right=Math.min(right,clip.right);}
   if(style.overflowY!=='visible'){y=Math.max(y,clip.top);bottom=Math.min(bottom,clip.bottom);}
  }
  return largestUnobstructedRect({x,y,width:right-x,height:bottom-y},rows);
 }
 function sendBounds(rows=localWindowOcclusions(doc)){
  boundsSequence+=1;
  const rect=viewport.getBoundingClientRect(),covered=overlay()||!viewport.getClientRects().length;
  return call('web.bounds',{...identity,sequence:boundsSequence,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},clip:covered?{x:0,y:0,width:0,height:0}:visibleClip(rows),overlay:covered});
 }
 function bounds(){frame=0;if(!opened||disposed)return Promise.resolve();return sendBounds().catch(fail);}
 function scheduleBounds(){if(!frame&&!disposed)frame=win.requestAnimationFrame(()=>{frame=0;void bounds();});}
 // The occlusion listener returns the actual web.bounds application promise, so
 // the controller's publication awaits a real applied receipt; a rejected or
 // stale receipt is left to propagate to the shell (revert + visible error).
 const unsubscribeOcclusions=subscribeLocalWindowOcclusions(doc,rows=>{if(!opened||disposed)return;const request=sendBounds(rows);request.catch(fail);return request;});
 async function action(action){try{await ready;if(held||disposed)return;const value=await call('web.action',{...identity,action});if(value)receive(value);}catch(error){fail(error);}}
 back.onclick=()=>void action('back');forward.onclick=()=>void action('forward');reload.onclick=()=>void action(state.loading?'stop':'reload');
 address.addEventListener('compositionstart',()=>{composing=true;});address.addEventListener('compositionend',()=>{composing=false;});
 address.addEventListener('input',()=>{draft=address.value;dirtyDraft=true;clearTimeout(timer);timer=win.setTimeout(()=>void save().catch(fail),300);});
 toolbar.onsubmit=async event=>{event.preventDefault();if(composing||held)return;try{const url=normalizeWebUrl(address.value);await ready;await save();const value=await call('web.navigate',{...identity,url});dirtyDraft=false;draft=url;address.value=url;if(value)receive(value);await save();}catch(error){fail(error);}};
 const unsubscribers=[subscribe('web.state',receive),subscribe('agent',event=>{if(event.projectId===scope.projectId)void discussion?.refresh();}),subscribe('session.flush',flush),subscribe('workspace.control',event=>{if(event.type==='host'){Object.assign(scope,event);scheduleBounds();}else if(event.type==='transfer-hold'){held=event.held===true;discussion?.setHeld(held);paint();scheduleBounds();}else if(event.type==='viewport-changed')scheduleBounds();})];
 const resize=new ResizeObserver(scheduleBounds);resize.observe(host);resize.observe(viewport);
 const mutation=new MutationObserver(scheduleBounds);mutation.observe(doc.body,{attributes:true,subtree:true,attributeFilter:['hidden','open','class','style']});
 win.addEventListener('resize',scheduleBounds);win.addEventListener('nozeli-layout-change',scheduleBounds);doc.addEventListener('scroll',scheduleBounds,true);doc.addEventListener('visibilitychange',scheduleBounds);win.visualViewport?.addEventListener('resize',scheduleBounds);
 paint();
 const ready=(async()=>{await call('workspace.ready',{});const value=await call('web.open',{...identity,url:state.url});opened=true;if(value)receive(value);paint();scheduleBounds();await call('workspace.ready',{contentReady:true});win.__nozeliReady=true;return value;})();
 void ready.catch(fail);
 return {ready,flush,snapshot:()=>({...state,addressDraft:address.value}),async close(){await ready;if(discussionWindow)await discussionWindow.hide().catch(()=>{});await discussion?.flush();await save();await call('web.close',identity);opened=false;paint();},dispose(){disposed=true;void discussionWindow?.dispose().catch(()=>{});discussion?.dispose();clearTimeout(timer);if(frame)win.cancelAnimationFrame(frame);resize.disconnect();mutation.disconnect();unsubscribeOcclusions();for(const unsubscribe of unsubscribers)if(typeof unsubscribe==='function')unsubscribe();win.removeEventListener('resize',scheduleBounds);win.removeEventListener('nozeli-layout-change',scheduleBounds);doc.removeEventListener('scroll',scheduleBounds,true);doc.removeEventListener('visibilitychange',scheduleBounds);win.visualViewport?.removeEventListener('resize',scheduleBounds);host.remove();}};
}
