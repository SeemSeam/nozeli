import {projectDrawing} from './region-drawing.mjs';
import {makeNoteTag,makeAnchorTag} from './note-tag.mjs';
import './image-view.css';
export async function mountImage({parent,bytes,info,onSelection=()=>{},onZoom=()=>{},onRegion=()=>{},onPan=()=>{},noteActions={},tagActions={}}){
 parent.replaceChildren();parent.hidden=false;
 const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes?.data??bytes),blob=new Blob([data],{type:info.mime});
 let bitmap;try{bitmap=await createImageBitmap(blob);}catch{throw Error('此图片无法解码；原文件未修改。');}
 if(bitmap.width!==info.width||bitmap.height!==info.height){bitmap.close();throw Error('图片显示方向或尺寸与原件不一致，未开启标注。');}
 // Freeze decoded pixels without Image.decode(), which waits for a paint in a hidden native view.
 const original=document.createElement('canvas');original.width=info.width;original.height=info.height;
 try{original.getContext('2d').drawImage(bitmap,0,0);}finally{bitmap.close();}
 const wrap=document.createElement('div');wrap.className='image-page';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','图片查看与区域标注；加减键缩放，0原始尺寸，F适应，空格临时拖动');
 const canvas=document.createElement('canvas');canvas.width=info.width;canvas.height=info.height;canvas.getContext('2d').drawImage(original,0,0);wrap.append(canvas);parent.append(wrap);
 const scroll=parent.parentElement;let disposed=false,scale=1,mode='fit',region=false,drawing=false,notes=[],tags=[],selection=null,drag=null,panDrag=null,panPreferred=true,spaceHeld=false;const open=new Map(),cleanups=[];
 const remember=()=>{for(const n of wrap.querySelectorAll('.note-anchor'))open.set(n.dataset.annotation,n.querySelector('.note-index')?.getAttribute('aria-expanded')==='true');};
 function paint(){remember();const retained=new Map([...wrap.querySelectorAll('.note-anchor')].filter(node=>tags.some(tag=>tag.id===node.dataset.annotation)).map(node=>[node.dataset.annotation,node]));wrap.querySelectorAll('.image-region-mark,.image-point-mark,.note-anchor,.region-drawing-projection').forEach(n=>{if(!retained.has(n.dataset.annotation))n.remove();});
  for(const [items,conversation] of [[notes,false],[tags,true]])for(const item of items){
   const a=item.anchor;if(a?.space!=='image-normalized')continue;
   if(Number.isFinite(a.x)&&Number.isFinite(a.y)&&!a.rects){
    const mark=document.createElement('span');mark.className='image-region-mark image-point-mark'+(conversation?` tag-${item.status==='followup'?'followup':item.kind}`:'');Object.assign(mark.style,{left:a.x*100+'%',top:a.y*100+'%',width:'10px',height:'10px',borderRadius:'50%',transform:'translate(-5px,-5px)',background:'#ac383855'});wrap.append(mark);
    const node=conversation?(retained.get(item.id)||makeAnchorTag({...item,open:open.get(item.id)??item.open},tagActions)):makeNoteTag(item,{...noteActions,open:id=>open.get(id)??noteActions.open?.(id)});
    if(conversation)node.updateConversation?.(item);Object.assign(node.style,{position:'absolute',left:a.x*100+'%',top:a.y*100+'%'});if(node.parentElement!==wrap)wrap.append(node);node.fitConversation?.();
    continue;
   }
   for(const r of a.rects){const mark=document.createElement('span');mark.className='image-region-mark';Object.assign(mark.style,{left:r[0]*100+'%',top:r[1]*100+'%',width:r[2]*100+'%',height:r[3]*100+'%'});wrap.append(mark);}
   const r=a.rects[0];projectDrawing(wrap,item.information?.drawing||item.drawing,r);const node=conversation?(retained.get(item.id)||makeAnchorTag({...item,open:open.get(item.id)??item.open},tagActions)):makeNoteTag(item,{...noteActions,open:id=>open.get(id)??noteActions.open?.(id)});
   if(conversation)node.updateConversation?.(item);Object.assign(node.style,{position:'absolute',left:r[0]*100+'%',top:r[1]*100+'%'});if(node.parentElement!==wrap)wrap.append(node);node.fitConversation?.();
  }
 }
 function captureRegion(anchor){
  if(anchor.space!=='image-normalized'||anchor.width!==info.width||anchor.height!==info.height)throw Error('图片选区版本不匹配');
  const [rx,ry,rw,rh]=anchor.rects[0],x=Math.floor(rx*info.width),y=Math.floor(ry*info.height),w=Math.min(info.width-x,Math.ceil((rx+rw)*info.width)-x),h=Math.min(info.height-y,Math.ceil((ry+rh)*info.height)-y);
  const crop=document.createElement('canvas');crop.width=w;crop.height=h;crop.getContext('2d').drawImage(original,x,y,w,h,0,0,w,h);return {dataUrl:crop.toDataURL('image/png'),captureMode:'image-pixels',clipped:false};
 }
 const minScale=.05,maxScale=8;
 const blocked=target=>target.closest?.('.note-anchor,.local-window,input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"])');
 const canPan=()=>scroll.scrollWidth>scroll.clientWidth+1||scroll.scrollHeight>scroll.clientHeight+1;
 function cursor(){wrap.classList.toggle('image-pan-ready',!drawing&&canPan()&&(spaceHeld||panPreferred&&!region));wrap.classList.toggle('image-panning',Boolean(panDrag));}
 function reportPan(){cursor();onPan(panPreferred&&!region);}
 function release(id){try{if(wrap.hasPointerCapture(id))wrap.releasePointerCapture(id);}catch{}}
 function stopPan(){const old=panDrag;panDrag=null;if(old)release(old.id);cursor();}
 function cancelRegion(){const old=drag;drag=null;if(old){old.preview.remove();release(old.id);}}
 function clear(){selection=null;wrap.querySelector('.region-preview')?.remove();onSelection(null);}
 function layout({point}={}){
  if(disposed)return;
  const padding=getComputedStyle(parent),px=parseFloat(padding.paddingLeft)+parseFloat(padding.paddingRight),py=parseFloat(padding.paddingTop)+parseFloat(padding.paddingBottom);
  const width=scroll.clientWidth-px,height=scroll.clientHeight-py;if(width<=0||height<=0)return;
  stopPan();cancelRegion();clear();
  const viewport=scroll.getBoundingClientRect(),before=wrap.getBoundingClientRect();
  point??={x:viewport.left+scroll.clientLeft+scroll.clientWidth/2,y:viewport.top+scroll.clientTop+scroll.clientHeight/2};
  const x=before.width?Math.max(0,Math.min(info.width,(point.x-before.left)*info.width/before.width)):info.width/2;
  const y=before.height?Math.max(0,Math.min(info.height,(point.y-before.top)*info.height/before.height)):info.height/2;
  if(mode==='fit')scale=Math.min(width/info.width,height/info.height,1);
  wrap.style.width=info.width*scale+'px';wrap.style.height=info.height*scale+'px';
  if(mode==='fit')scroll.scrollLeft=scroll.scrollTop=0;
  else {const after=wrap.getBoundingClientRect();scroll.scrollLeft+=after.left+x*scale-point.x;scroll.scrollTop+=after.top+y*scale-point.y;}
  for(const node of wrap.querySelectorAll('.note-anchor'))node.relayout?.();
  cursor();onZoom({scale,mode,width:info.width,height:info.height,minScale,maxScale});
 }
 function zoom(action,point){
  if(disposed||drawing)return;
  if(action===null)mode='fit';
  else if(action==='actual'){mode='manual';scale=1;}
  else {if(!Number.isFinite(action)||action<=0||action<1&&scale<=minScale)return;mode='manual';scale=Math.max(minScale,Math.min(maxScale,scale*action));}
  layout({point});
 }
 const observer=new ResizeObserver(()=>layout());observer.observe(scroll);layout();
 function modeRegion(value){stopPan();cancelRegion();region=Boolean(value);wrap.classList.toggle('region-selecting',region);onRegion(region);reportPan();clear();}
 function down(e){
  if(drawing||e.isPrimary===false||blocked(e.target)||drag||panDrag)return;
  const pan=e.button===1||e.button===0&&(spaceHeld||panPreferred&&!region);
  if(pan&&canPan()&&e.pointerType!=='touch'){
   e.preventDefault();clear();wrap.focus({preventScroll:true});panDrag={id:e.pointerId,button:e.button,x:e.clientX,y:e.clientY,left:scroll.scrollLeft,top:scroll.scrollTop};wrap.setPointerCapture(e.pointerId);cursor();return;
  }
  if(!region||e.button!==0)return;
  e.preventDefault();clear();wrap.focus({preventScroll:true});const box=wrap.getBoundingClientRect(),preview=document.createElement('span');preview.className='region-preview';wrap.append(preview);drag={id:e.pointerId,x:e.clientX,y:e.clientY,box,preview};wrap.setPointerCapture(e.pointerId);
 }
 function draw(e){if(!drag)return;const {box,x,y,preview}=drag;const endX=Math.max(box.left,Math.min(box.right,e.clientX)),endY=Math.max(box.top,Math.min(box.bottom,e.clientY));drag.rect=[(Math.min(x,endX)-box.left)/box.width,(Math.min(y,endY)-box.top)/box.height,Math.abs(x-endX)/box.width,Math.abs(y-endY)/box.height];const r=drag.rect;Object.assign(preview.style,{left:r[0]*100+'%',top:r[1]*100+'%',width:r[2]*100+'%',height:r[3]*100+'%'});}
 function move(e){
  const active=panDrag||drag;if(!active||active.id!==e.pointerId)return;
  if(e.pointerType==='mouse'&&!(e.buttons&(panDrag?.button===1?4:1))){stopPan();cancelRegion();return;}
  if(!wrap.hasPointerCapture(e.pointerId))wrap.setPointerCapture(e.pointerId);
  if(panDrag){scroll.scrollLeft=panDrag.left-(e.clientX-panDrag.x);scroll.scrollTop=panDrag.top-(e.clientY-panDrag.y);}
  else draw(e);e.preventDefault();
 }
 function up(e){
  if(panDrag?.id===e.pointerId){stopPan();return;}if(!drag||drag.id!==e.pointerId)return;
  draw(e);const {rect:r,box,preview,id}=drag;drag=null;release(id);
  if(r[2]*box.width<4||r[3]*box.height<4){preview.remove();return;}
  const anchor={space:'image-normalized',width:info.width,height:info.height,rects:[r],quote:''},imageDataUrl=captureRegion(anchor).dataUrl;
  if(imageDataUrl.length>24*1024*1024){preview.remove();onSelection({error:'区域截图过大，请缩小选区。'});return;}
  region=false;wrap.classList.remove('region-selecting');onRegion(false);reportPan();
  selection={kind:'image-region',anchor,viewportRect:{left:box.left+r[0]*box.width,top:box.top+r[1]*box.height,right:box.left+(r[0]+r[2])*box.width,bottom:box.top+(r[1]+r[3])*box.height},material:{imageDataUrl}};onSelection(selection);
 }
 function cancel(e){if(panDrag?.id===e.pointerId)stopPan();if(drag?.id===e.pointerId){cancelRegion();clear();}}
 function blur(){spaceHeld=false;stopPan();cancelRegion();cursor();}
 function key(e){
  if(e.defaultPrevented||e.isComposing||e.ctrlKey||e.metaKey||e.altKey||blocked(e.target)||drawing)return;
  if(e.key==='Escape'&&(panDrag||drag||region)){e.preventDefault();e.stopPropagation();blur();modeRegion(false);return;}
  if(e.code==='Space'&&canPan()){e.preventDefault();spaceHeld=true;cursor();return;}
  const action=['+','='].includes(e.key)?1.2:e.key==='-'?1/1.2:e.key==='0'?'actual':e.key.toLowerCase()==='f'?null:undefined;
  if(action!==undefined){e.preventDefault();e.stopPropagation();zoom(action);}
 }
 function wheel(e){if(!(e.ctrlKey||e.metaKey)||!e.deltaY||blocked(e.target))return;e.preventDefault();if(drawing||drag||panDrag)return;const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?scroll.clientHeight:1);zoom(Math.exp(-Math.max(-100,Math.min(100,delta))*.002),e.target.closest('.image-page')===wrap?{x:e.clientX,y:e.clientY}:undefined);}
 function listen(target,type,fn,options){target.addEventListener(type,fn,options);cleanups.push(()=>target.removeEventListener(type,fn,options));}
 listen(wrap,'pointerdown',down);listen(document,'pointermove',move,true);listen(document,'pointerup',up,true);listen(document,'pointercancel',cancel,true);
 listen(wrap,'lostpointercapture',e=>{if(e.pointerType!=='mouse')cancel(e);});
 listen(scroll,'wheel',wheel,{passive:false});listen(scroll,'keydown',key);
 listen(document,'keyup',e=>{if(e.code==='Space'){spaceHeld=false;cursor();}},true);listen(window,'blur',blur);reportPan();
 function selectRegion(rect){const r=[...rect];if(r.length!==4||r.some(v=>!Number.isFinite(v))||r[0]<0||r[1]<0||r[2]<=0||r[3]<=0||r[0]+r[2]>1||r[1]+r[3]>1)throw Error('图片选区范围无效');clear();const b=wrap.getBoundingClientRect(),anchor={space:'image-normalized',width:info.width,height:info.height,rects:[r],quote:''},preview=document.createElement('span');preview.className='region-preview';Object.assign(preview.style,{left:r[0]*100+'%',top:r[1]*100+'%',width:r[2]*100+'%',height:r[3]*100+'%'});wrap.append(preview);selection={kind:'image-region',anchor,viewportRect:{left:b.left+r[0]*b.width,top:b.top+r[1]*b.height,right:b.left+(r[0]+r[2])*b.width,bottom:b.top+(r[1]+r[3])*b.height},material:{imageDataUrl:captureRegion(anchor).dataUrl}};onSelection(selection);return selection;}
 parent.selectRegion=selectRegion;
 // Semantic tutorials use the same source crop and selection callback as pointer input.
 return {
  pointAt(x,y){const b=wrap.getBoundingClientRect();if(x<b.left||x>b.right||y<b.top||y>b.bottom)return null;return {anchor:{space:'image-normalized',width:info.width,height:info.height,x:Math.min(1,Math.max(0,(x-b.left)/b.width)),y:Math.min(1,Math.max(0,(y-b.top)/b.height))}};},
  pointRect(a){if(!a||a.space!=='image-normalized'||a.width!==info.width||a.height!==info.height||!Number.isFinite(a.x))return null;const b=wrap.getBoundingClientRect();return {left:b.left+a.x*b.width,top:b.top+a.y*b.height,right:b.left+a.x*b.width,bottom:b.top+a.y*b.height};},
  drawingActive(value){drawing=value;if(drawing)blur();cursor();},
  regionRect(a){if(a.space!=='image-normalized'||a.width!==info.width||a.height!==info.height)return null;const b=wrap.getBoundingClientRect(),r=a.rects[0];return {left:b.left+r[0]*b.width,top:b.top+r[1]*b.height,right:b.left+(r[0]+r[2])*b.width,bottom:b.top+(r[1]+r[3])*b.height};},
  viewState:()=>({mode,scale,scrollLeft:scroll.scrollLeft,pan:panPreferred}),
  restoreView(value){
   mode=value?.mode==='manual'?'manual':'fit';
   if(Number.isFinite(value?.scale)&&value.scale>0)scale=Math.max(minScale,Math.min(maxScale,value.scale));
   panPreferred=value?.pan!==false;layout();
   if(mode==='manual'&&Number.isFinite(value?.scrollLeft))scroll.scrollLeft=Math.max(0,value.scrollLeft);
   reportPan();
  },
  captureRegion,current:()=>1,region:modeRegion,
  pan(value){panPreferred=Boolean(value);stopPan();if(panPreferred&&region)modeRegion(false);reportPan();},
  clearSelection:clear,
  setNotes(value){notes=value;paint();},
  setTags(value){tags=value;paint();},
  zoom,
  destroy(){
   disposed=true;observer.disconnect();blur();cleanups.forEach(stop=>stop());
   if(parent.selectRegion===selectRegion)delete parent.selectRegion;
   parent.replaceChildren();parent.hidden=true;original.width=original.height=0;canvas.width=canvas.height=0;
  },
 };
}
