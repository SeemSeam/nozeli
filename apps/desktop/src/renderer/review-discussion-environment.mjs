// Native transport only: local-window remains the sole geometry/gesture owner.
export function nativeDiscussionEnvironment({invoke,scope,defaultRect,measureBounds=bounds=>bounds}) {
 let geometry=scope.geometry,listener=null,invalidateGeometry=null,last='',running=null,pending=null,active=null;
 const call=async payload=>{const result=await invoke('workspace.reviewDiscussion.bounds',payload);if(!result.ok)throw Object.assign(Error(result.error?.message||'讨论位置未获确认'),{code:result.error?.code});if(result.value?.stale||result.value?.sequence!==payload.sequence){if(result.value?.geometry?.epoch>geometry.epoch){geometry=result.value.geometry;scope.geometry=geometry;invalidateGeometry?.();}throw Object.assign(Error('讨论位置回执已过期，当前输入仍保留。'),{code:'REVIEW_GEOMETRY_STALE'});}return result.value;};
 async function drain(){while(pending){const next=pending;pending=null;active=next;try{if(next.signature!==last)await call(next.payload);last=next.signature;next.resolve();}catch(error){next.reject(error);}finally{active=null;}}}
 function start(){if(running)return;running=drain().finally(()=>{running=null;if(pending)start();});}
 return {
  measure(){const bounds=measureBounds(geometry.bounds);return {bounds,defaultRect:defaultRect(bounds),epoch:geometry.epoch,nativeGeometry:geometry};},
  paintRect(rect){return {x:0,y:0,width:rect.width,height:rect.height};},
  toLocal(_x,_y,event){return {x:(event.screenX-geometry.origin.x)/geometry.zoomFactor,y:(event.screenY-geometry.origin.y)/geometry.zoomFactor};},
  subscribe(invalidate){invalidateGeometry=invalidate;listener=window.nozeli.subscribe('workspace.control',event=>{if(event.type==='review-discussion-geometry'&&event.geometry?.epoch>geometry.epoch){geometry=event.geometry;scope.geometry=geometry;invalidate();}});return ()=>{invalidateGeometry=null;listener?.();};},
  publishOcclusion(row,frame){
   const native=frame?.nativeGeometry;
   if(!native||native.epoch!==row.epoch)return Promise.reject(Object.assign(Error('窗口矩形缺少同代测量坐标。'),{code:'REVIEW_GEOMETRY_STALE'}));
   const rect={x:native.origin.x+row.rect.x*native.zoomFactor,y:native.origin.y+row.rect.y*native.zoomFactor,width:row.rect.width*native.zoomFactor,height:row.rect.height*native.zoomFactor};
   const payload={generation:scope.generation,epoch:row.epoch,sequence:row.sequence,rect,visible:row.visible},signature=JSON.stringify([payload.epoch,payload.rect,payload.visible]);
   if(pending?.signature===signature)return pending.promise;
   if(!pending&&active?.signature===signature)return active.promise;
   if(signature===last&&!pending&&!active)return Promise.resolve();
   let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
   if(pending)pending.resolve();pending={payload,signature,resolve,reject,promise};
   start();
   return promise;
  }
 };
}
