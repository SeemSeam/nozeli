// Pointer-driven titles keep right-click available; native app-region drag consumes it.
export function mountWorkspaceTitleDrag({tree,call,toast}) {
  let session=null, pending=null, moving=false, sourceView=null,sourceGroup=null;
  const clear=()=>{for(const el of tree.querySelectorAll('[data-drop-side]'))delete el.dataset.dropSide;};
  let latestPoint=null,inFlight=null,finishing=false;
  function flushUpdate(){
    if(inFlight||!latestPoint||!pending)return inFlight;
    const current=pending,point=latestPoint;latestPoint=null;
    inFlight=(async()=>{const id=await current.started;if(id)await call('workspace.drag.update',{sessionId:id,...point});})().catch(error=>toast(error.message)).finally(()=>{inFlight=null;if(latestPoint&&pending)flushUpdate();});
    return inFlight;
  }
  async function finish(event,cancelled=false){
    if(!pending||finishing)return;finishing=true;
    const current=pending;
    try{while(inFlight||latestPoint){if(!inFlight)flushUpdate();await inFlight;}const id=await current.started;pending=null;if(id)await call(cancelled?'workspace.drag.cancel':'workspace.drag.end',{sessionId:id,cancelled,screenX:event.screenX,screenY:event.screenY});}
    catch(error){toast(error.message);}finally{pending=null;latestPoint=null;moving=false;finishing=false;clear();}
  }
  tree.addEventListener('pointerdown',event=>{
    const title=event.target.closest('.workspace-pane-header');
    if(!title||event.button!==0||event.target.closest('button')||pending||finishing)return;
    if(document.documentElement.dataset.workspaceRole==='detached'&&!event.target.closest('.workspace-pane-title'))return;
    const viewId=title.parentElement.querySelector('[data-view-id]')?.dataset.viewId;
    const groupId=title.parentElement.dataset.workspaceGroup;
    if(!viewId&&document.documentElement.dataset.workspaceRole!=='detached')return;
    title.setPointerCapture(event.pointerId);
    sourceView=viewId;sourceGroup=groupId;
    pending={x:event.clientX,y:event.clientY,screenX:event.screenX,screenY:event.screenY,viewId,groupId,started:Promise.resolve(null)};
  });
  tree.addEventListener('pointermove',event=>{
    if(!pending)return;
    if(!moving&&Math.hypot(event.clientX-pending.x,event.clientY-pending.y)>5){
      moving=true;
      pending.started=call('workspace.drag.begin',{...(pending.viewId?{viewId:pending.viewId}:{groupId:pending.groupId}),screenX:pending.screenX,screenY:pending.screenY}).then(result=>result.sessionId);
    }
    if(moving&&!finishing){latestPoint={screenX:event.screenX,screenY:event.screenY};flushUpdate();}
  });
  tree.addEventListener('pointerup',event=>void finish(event));
  tree.addEventListener('pointercancel',event=>void finish(event,true));
  tree.addEventListener('lostpointercapture',event=>{if(pending)void finish(event,true);});
  window.addEventListener('blur',event=>{if(pending)void finish(event,true);});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&pending)void finish(event,true);});
  window.nozeli.subscribe('workspace.control',event=>{
    if(event.type==='drag-session'){session=event.sessionId;if(!pending){sourceView=null;sourceGroup=null;}}
    if(event.type==='drag-ended'){session=null;sourceView=null;sourceGroup=null;clear();window.dispatchEvent(new Event('nozeli-layout-change'));}
    if(event.type!=='drag'||event.sessionId!==session)return;
    clear();
    const pane=[...tree.querySelectorAll('[data-workspace-group]')].find(el=>{const b=el.getBoundingClientRect();return event.clientX>=b.left&&event.clientX<b.right&&event.clientY>=b.top&&event.clientY<b.bottom;});
    if(!pane)return;
    const b=pane.getBoundingClientRect(),x=(event.clientX-b.left)/b.width,y=(event.clientY-b.top)/b.height;
    if(sourceGroup===pane.dataset.workspaceGroup||(sourceView&&sourceView===pane.querySelector('[data-view-id]')?.dataset.viewId))return;
    const side=x<.22?'left':x>.78?'right':y<.22?'top':y>.78?'bottom':'center';
    pane.dataset.dropSide=side;
    void call('workspace.drag.target',{sessionId:session,targetGroupId:pane.dataset.workspaceGroup,...(side==='center'?{}:{axis:['left','right'].includes(side)?'x':'y',side:['left','top'].includes(side)?'before':'after'})}).catch(error=>toast(error.message));
  });
}
