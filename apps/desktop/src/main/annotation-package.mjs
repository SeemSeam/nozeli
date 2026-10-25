import {validateDrawing} from '../domain/region-drawing.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {anchorText} from '../domain/tag-anchors.mjs';
import {wordText} from './word-anchors.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
export async function pptSnapshot(storage,projectId,relPath,digest){
 const key=hash(relPath+'\0'+digest);
 const record=await storage.getRecovery(projectId,'ppt:'+key);
 if(record?.schema!=='nozeli-pptist-draft-v1'||record.sourceDigest!==digest||!Array.isArray(record.model?.slides))throw Error('PPT 草稿版本无效');
 const {slides,theme,viewportSize,viewportRatio,title}=record.model;
 const model={slides,theme,viewportSize,viewportRatio,title};
 const bytes=Buffer.from(JSON.stringify({schema:record.schema,engine:record.engine,sourceDigest:digest,model}));
 return {model,bytes,digest:hash(bytes)};
}
function geometry(e){return {left:e.left,top:e.top,width:e.width,height:e.height,rotation:e.rotate||0};}
function linePosition(text,offset){const before=text.slice(0,offset),last=before.lastIndexOf('\n');return {line:before.split('\n').length,column:offset-last,offset};}
export async function buildAnnotationPackage({store,projectId,relPath,kind,anchor,materialDigest,material,image,drawing,annotatedImage,sourceDraftDigest,displayLocation}){
 const ref=async(bytes,mime,role)=>{const {digest}=await store.putMaterial(bytes);return {role,digest,mime,bytes:bytes.length,relPath:path.posix.join('.nozeli/objects/sha256',digest)};};
 const result={schema:'nozeli.annotation-material-v1',capturedAt:new Date().toISOString(),source:{digest:materialDigest,relPath:path.posix.join('.nozeli/objects/sha256',materialDigest),format:path.extname(relPath).slice(1)},location:{kind,anchor},assets:[],limitations:[]};
 const loc=result.location;
 if(kind==='text-selection'){
  const text=anchorText(material.toString('utf8'));loc.offsetEncoding='utf16-lf-normalized';loc.start=linePosition(text,anchor.start);loc.end=linePosition(text,anchor.end);loc.label=`第 ${loc.start.line} 行第 ${loc.start.column} 列至第 ${loc.end.line} 行第 ${loc.end.column} 列`;loc.context={before:text.slice(Math.max(0,anchor.start-200),anchor.start),quote:anchor.quote,after:text.slice(anchor.end,anchor.end+200)};
 }else if(kind==='image-region'){
  loc.coordinateSpace='image-normalized';loc.imageSize={width:anchor.width,height:anchor.height};
  loc.pixelRects=anchor.rects.map(([x,y,w,h])=>({x:Math.floor(x*anchor.width),y:Math.floor(y*anchor.height),width:Math.ceil((x+w)*anchor.width)-Math.floor(x*anchor.width),height:Math.ceil((y+h)*anchor.height)-Math.floor(y*anchor.height)}));
  const r=loc.pixelRects[0];loc.label=`图片区域 x=${r.x}, y=${r.y}, ${r.width}×${r.height} 像素（原图 ${anchor.width}×${anchor.height}）`;
 }else if(kind.startsWith('ppt-')){
  const snapshot=await pptSnapshot(store.storage,projectId,relPath,materialDigest);if(drawing&&sourceDraftDigest!==snapshot.digest)throw Error('PPT草稿版本已变化，旧涂鸦已保留，请重新确认原区域');const index=snapshot.model.slides.findIndex(s=>s.id===anchor.slideId);if(index<0)throw Error('备注对应的 PPT 幻灯片已不存在，请重新选取');
  const slide=snapshot.model.slides[index];loc.page=index+1;loc.label=`第 ${index+1} 张幻灯片`;loc.coordinateSpace='nozeli-pptist-draft';loc.pageSize={width:snapshot.model.viewportSize,height:snapshot.model.viewportSize*snapshot.model.viewportRatio};
  if(anchor.elementId){const element=slide.elements.find(e=>e.id===anchor.elementId);if(!element)throw Error('备注对应的 PPT 对象已不存在');loc.object={id:element.id,type:element.type,...geometry(element)};loc.context={quote:anchor.quote,prefix:anchor.prefix,suffix:anchor.suffix};}
  result.draft=await ref(snapshot.bytes,'application/json','pptist-draft');result.draft.schema='nozeli-pptist-draft-v1';
 }else if(kind==='word-selection'){
  const text=await wordText(material),start=text.indexOf(anchor.quote);loc.label='Word 文字选区';loc.context={quote:anchor.quote,prefix:anchor.prefix,suffix:anchor.suffix};if(start>=0&&text.indexOf(anchor.quote,start+1)<0)loc.extractedTextOffset=start;
 }else{loc.page=anchor.page;loc.label=`第 ${anchor.page} 页${kind.endsWith('-region')?'区域':'文字选区'}`;loc.coordinateSpace=anchor.space;}
 if(Number.isInteger(displayLocation?.page)&&displayLocation.page>0&&displayLocation.page<100000){loc.renderedPage=displayLocation.page;loc.label+='（渲染第 '+displayLocation.page+' 页）';}
 if(displayLocation?.pageSize&&['width','height'].every(k=>Number.isFinite(displayLocation.pageSize[k])&&displayLocation.pageSize[k]>0&&displayLocation.pageSize[k]<100000)){loc.renderedPageSize=displayLocation.pageSize;}
 if(kind.endsWith('-region')){
  if(image){
   const match=/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(image.dataUrl||'');if(!match||match[1].length>24*1024*1024)throw Error('区域截图数据无效或过大');const bytes=Buffer.from(match[1],'base64');if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('区域截图不是 PNG');
   const asset=await ref(bytes,'image/png','region-screenshot');asset.width=bytes.readUInt32BE(16);asset.height=bytes.readUInt32BE(20);asset.captureMode=['pdf-canvas','image-pixels','pptist-slide'].includes(image.captureMode)?image.captureMode:'visible-window-region';asset.clipped=!!image.clipped;if(kind==='image-region'){const r=loc.pixelRects[0];if(asset.width!==r.width||asset.height!==r.height)throw Error('区域截图尺寸与图片像素框不一致');}result.assets.push(asset);
   if(drawing){
    if(!['image-region','pdf-region','ppt-region'].includes(kind)||asset.clipped)throw Error('此区域不能保存涂鸦');
    result.drawing=validateDrawing(drawing);
    if(result.drawing.width!==asset.width||result.drawing.height!==asset.height)throw Error('笔迹与原始区域尺寸不一致');
    const m=/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(annotatedImage||'');if(!m||m[1].length>24*1024*1024)throw Error('缺少有效的涂鸦合成PNG');
    const composite=Buffer.from(m[1],'base64');if(composite.length<24||composite.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||composite.readUInt32BE(16)!==asset.width||composite.readUInt32BE(20)!==asset.height)throw Error('涂鸦合成PNG与原始区域尺寸不一致');
    result.assets.push({...await ref(composite,'image/png','annotated-region'),width:asset.width,height:asset.height,captureMode:asset.captureMode,clipped:false});
    result.assets.push(await ref(Buffer.from(JSON.stringify(result.drawing)),'application/json','drawing-strokes'));
   }
   if(asset.clipped)result.limitations.push('截图仅包含窗口可见部分，不代表完整区域');
  }else result.limitations.push('创建时未获得区域截图，不能假定区域内容');
 }
 if(drawing&&!result.drawing)throw Error('涂鸦缺少原始区域截图');
 return result;
}

export async function verifyAnnotationPackage(store, information) {
 if (!information) return null;
 const result=structuredClone(information);
 for (const ref of [result.source,result.draft,...(result.assets||[])].filter(Boolean)) {
  const bytes=await store.getMaterial(ref.digest);
  ref.relPath=path.posix.join('.nozeli/objects/sha256',ref.digest);
  ref.bytes=bytes.length;
 }

 return result;
}
