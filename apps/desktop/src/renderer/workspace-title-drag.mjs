// Pointer-driven titles keep right-click available; native app-region drag consumes it.
export function mountWorkspaceTitleDrag({tree,call,toast}) {
  let session=null, pending=null, moving=false, sourceView=null;
  const clear=()=>{for(const el of tree.querySelectorAll('[data-drop-side]'))delete el.dataset.dropSide;};
  async function finish(event,cancelled=false){
    if(!pending)return;
    const current=pending;pending=null;
    try{const id=await current.started;if(id)await call(cancelled?'workspace.drag.cancel':'workspace.drag.end',{sessionId:id,cancelled,screenX:event.screenX,screenY:event.screenY});}
    catch(error){toast(error.message);}finally{moving=false;clear();}
  }
  tree.addEventListener('pointerdown',event=>{
    const title=event.target.closest('.workspace-pane-header');
    if(!title||event.button!==0||event.target.closest('button'))return;
    const viewId=title.parentElement.querySelector('[data-view-id]')?.dataset.viewId;
    if(!viewId)return;
    title.setPointerCapture(event.pointerId);
    sourceView=viewId;
    pending={x:event.clientX,y:event.clientY,screenX:event.screenX,screenY:event.screenY,viewId,started:Promise.resolve(null)};
  });
  tree.addEventListener('pointermove',event=>{
    if(!pending)return;
    if(!moving&&Math.hypot(event.clientX-pending.x,event.clientY-pending.y)>5){
      moving=true;
      pending.started=call('workspace.drag.begin',{viewId:pending.viewId,screenX:pending.screenX,screenY:pending.screenY}).then(result=>result.sessionId);
    }
    if(moving){const current=pending;void current.started.then(id=>pending===current&&call('workspace.drag.update',{sessionId:id,screenX:event.screenX,screenY:event.screenY})).catch(error=>toast(error.message));}
  });
  tree.addEventListener('pointerup',event=>void finish(event));
  tree.addEventListener('pointercancel',event=>void finish(event,true));
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&pending)void finish(event,true);});
  window.nozeli.subscribe('workspace.control',event=>{
    if(event.type==='drag-session'){session=event.sessionId;if(!pending)sourceView=null;}
    if(event.type==='drag-ended'){session=null;sourceView=null;clear();window.dispatchEvent(new Event('nozeli-layout-change'));}
    if(event.type!=='drag'||event.sessionId!==session)return;
    clear();
    const pane=[...tree.querySelectorAll('[data-workspace-group]')].find(el=>{const b=el.getBoundingClientRect();return event.clientX>=b.left&&event.clientX<b.right&&event.clientY>=b.top&&event.clientY<b.bottom;});
    if(!pane)return;
    const b=pane.getBoundingClientRect(),x=(event.clientX-b.left)/b.width,y=(event.clientY-b.top)/b.height;
    if(sourceView===pane.querySelector('[data-view-id]')?.dataset.viewId)return;
    const side=x<.22?'left':x>.78?'right':y<.22?'top':y>.78?'bottom':'center';
    pane.dataset.dropSide=side;
    void call('workspace.drag.target',{sessionId:session,targetGroupId:pane.dataset.workspaceGroup,...(side==='center'?{}:{axis:['left','right'].includes(side)?'x':'y',side:['left','top'].includes(side)?'before':'after'})}).catch(error=>toast(error.message));
  });
}
