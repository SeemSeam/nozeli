// Capture metadata describes observed content; it never infers identity from titles or pixels.
const copyAnchor=value=>{if(value==null)return null;const {imageDataUrl,...anchor}=structuredClone(value);return anchor;};
const digest=value=>typeof value==='string'&&value.length>0?value:null;
const rect=value=>value&&['left','top','right','bottom'].every(k=>Number.isFinite(value[k]))&&value.right>value.left&&value.bottom>value.top?{left:value.left,top:value.top,right:value.right,bottom:value.bottom}:null;
export function describeDrawingSource({scope={},file,bufferDigest,selection,viewport,versionVerified=false,selectionVerified=false,resource,generation}={}) {
 const projectId=scope.projectId||file?.projectId||null;
 const relPath=file?.relPath||null;
 const materialDigest=digest(file?.materialDigest)||digest(file?.digest);
 const currentBufferDigest=digest(bufferDigest);
 const report=resource?.kind==='report'&&resource.objectId&&digest(resource.digest)?{kind:'report',objectId:resource.objectId,digest:resource.digest}:null;
 const version=currentBufferDigest?{kind:'buffer',digest:currentBufferDigest}:versionVerified&&(materialDigest||report?.digest)?{kind:'material',digest:materialDigest||report.digest}:null;
 const identity=projectId&&(relPath||report)&&version?{projectId,...(relPath?{relPath}:{}),...(report?{resource:report}:{}),version}:null;
 // A selected capture rectangle is NOT a document selection. Only a driver can vouch for an anchor.
 const exact=identity&&selectionVerified&&selection?.anchor;
 const locationStatus=identity?(exact?'exact':'viewport-only'):'workspace-only';
 const source={schema:'nozeli.drawing-source-v1',projectId,windowId:scope.windowId||null,viewId:scope.viewId||null,generation:generation??scope.generation??null,kind:file?.kind||scope.kind||'workspace',identity,version,locationStatus,viewport:rect(viewport),selection:exact?{kind:selection.kind||null,anchor:copyAnchor(selection.anchor)}:null};
 source.summary=identity?`${relPath||'报告 '+report.objectId} · ${version.kind==='buffer'?'未保存缓冲':'材料版本'} ${version.digest} · ${exact?'驱动已核验选区':'仅视口，无精确位置锚点'}`:'工作区截图，未锚定文件（来源版本或身份未核验）';
 return source;
}
export function captureDrawingSources(options={}) {
 const source=describeDrawingSource(options);
 return {schema:'nozeli.drawing-sources-v1',sources:[source],summary:source.summary};
}
// Mounted by each actual content renderer. Reads state without saving or moving focus.
export function mountDrawingSourceAdapter({getSource,invoke,subscribe}) {
 const unsubscribe=subscribe('workspace.control',event=>{
  if(event.type!=='capture-source-request'||!event.requestId)return;
  void Promise.resolve().then(()=>getSource(event)).then(options=>{
   const descriptor=captureDrawingSources(options);
   return invoke('workspace.capture.source',{requestId:event.requestId,...descriptor});
  }).catch(error=>invoke('workspace.capture.source',{requestId:event.requestId,error:{code:'SOURCE_UNAVAILABLE',message:error.message}}));
 });
 return {dispose(){unsubscribe?.();}};
}
