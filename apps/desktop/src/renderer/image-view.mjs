import {projectDrawing} from './region-drawing.mjs';
import {makeNoteTag,makeAnchorTag} from './note-tag.mjs';
import './image-view.css';
export async function mountImage({parent,bytes,info,onSelection=()=>{},onZoom=()=>{},onRegion=()=>{},noteActions={},tagActions={}}){
 parent.replaceChildren();parent.hidden=false;
 const data=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes?.data??bytes),blob=new Blob([data],{type:info.mime});
 let bitmap;try{bitmap=await createImageBitmap(blob);}catch{throw Error('此图片无法解码；原文件未修改。');}
 if(bitmap.width!==info.width||bitmap.height!==info.height){bitmap.close();throw Error('图片显示方向或尺寸与原件不一致，未开启标注。');}
 // Freeze decoded pixels without Image.decode(), which waits for a paint in a hidden native view.
 const original=document.createElement('canvas');original.width=info.width;original.height=info.height;
 try{original.getContext('2d').drawImage(bitmap,0,0);}finally{bitmap.close();}
 const wrap=document.createElement('div');wrap.className='image-page';wrap.setAttribute('aria-label','图片查看与区域标注');
 const canvas=document.createElement('canvas');canvas.width=info.width;canvas.height=info.height;canvas.getContext('2d').drawImage(original,0,0);wrap.append(canvas);parent.append(wrap);
 const scroll=parent.parentElement;let disposed=false,scale=1,mode='fit',region=false,drawing=false,notes=[],tags=[],selection=null,drag=null;const open=new Map();
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
 function clear(){selection=null;wrap.querySelector('.region-preview')?.remove();onSelection(null);}
 function layout(){if(disposed)return;clear();if(mode==='fit')scale=Math.min((scroll.clientWidth-34)/info.width,(scroll.clientHeight-34)/info.height,1);scale=Math.max(.01,scale);wrap.style.width=info.width*scale+'px';wrap.style.height=info.height*scale+'px';onZoom({scale,mode,width:info.width,height:info.height});}
 const observer=new ResizeObserver(layout);observer.observe(scroll);layout();
 const modeRegion=value=>{region=value;wrap.classList.toggle('region-selecting',value);onRegion(value);if(!value&&drag){drag.preview.remove();drag=null;}clear();};
 wrap.addEventListener('pointerdown',e=>{if(drawing||!region||e.button!==0||e.target.closest('.note-anchor'))return;e.preventDefault();clear();const box=wrap.getBoundingClientRect();const preview=document.createElement('span');preview.className='region-preview';wrap.append(preview);drag={x:e.clientX,y:e.clientY,box,preview};wrap.setPointerCapture(e.pointerId);});
 function draw(e){if(!drag)return;const {box,x,y,preview}=drag;const endX=Math.max(box.left,Math.min(box.right,e.clientX)),endY=Math.max(box.top,Math.min(box.bottom,e.clientY));drag.rect=[(Math.min(x,endX)-box.left)/box.width,(Math.min(y,endY)-box.top)/box.height,Math.abs(x-endX)/box.width,Math.abs(y-endY)/box.height];const r=drag.rect;Object.assign(preview.style,{left:r[0]*100+'%',top:r[1]*100+'%',width:r[2]*100+'%',height:r[3]*100+'%'});}
 wrap.addEventListener('pointermove',draw);
 wrap.addEventListener('pointerup',e=>{if(!drag)return;draw(e);const {rect:r,box,preview}=drag;drag=null;if(wrap.hasPointerCapture(e.pointerId))wrap.releasePointerCapture(e.pointerId);if(r[2]*box.width<4||r[3]*box.height<4){preview.remove();return;}
  const x=Math.floor(r[0]*info.width),y=Math.floor(r[1]*info.height),w=Math.min(info.width-x,Math.ceil((r[0]+r[2])*info.width)-x),h=Math.min(info.height-y,Math.ceil((r[1]+r[3])*info.height)-y);
  const crop=document.createElement('canvas');crop.width=w;crop.height=h;crop.getContext('2d').drawImage(original,x,y,w,h,0,0,w,h);
  const imageDataUrl=crop.toDataURL('image/png');if(imageDataUrl.length>24*1024*1024){preview.remove();onSelection({error:'区域截图过大，请缩小选区。'});return;}
  region=false;wrap.classList.remove('region-selecting');onRegion(false);
  selection={kind:'image-region',anchor:{space:'image-normalized',width:info.width,height:info.height,rects:[r],quote:''},viewportRect:{left:box.left+r[0]*box.width,top:box.top+r[1]*box.height,right:box.left+(r[0]+r[2])*box.width,bottom:box.top+(r[1]+r[3])*box.height},material:{imageDataUrl}};onSelection(selection);
 });
 wrap.addEventListener('pointercancel',()=>{drag?.preview.remove();drag=null;clear();});
 return {pointAt(x,y){const b=wrap.getBoundingClientRect();if(x<b.left||x>b.right||y<b.top||y>b.bottom)return null;return {anchor:{space:'image-normalized',width:info.width,height:info.height,x:Math.min(1,Math.max(0,(x-b.left)/b.width)),y:Math.min(1,Math.max(0,(y-b.top)/b.height))}};},pointRect(a){if(!a||a.space!=='image-normalized'||a.width!==info.width||a.height!==info.height||!Number.isFinite(a.x))return null;const b=wrap.getBoundingClientRect();return {left:b.left+a.x*b.width,top:b.top+a.y*b.height,right:b.left+a.x*b.width,bottom:b.top+a.y*b.height};},drawingActive(value){drawing=value;},regionRect(a){if(a.space!=='image-normalized'||a.width!==info.width||a.height!==info.height)return null;const b=wrap.getBoundingClientRect(),r=a.rects[0];return {left:b.left+r[0]*b.width,top:b.top+r[1]*b.height,right:b.left+(r[0]+r[2])*b.width,bottom:b.top+(r[1]+r[3])*b.height};},viewState:()=>({mode,scale}),restoreView(value){mode=value.mode;scale=value.scale;layout();},captureRegion,current:()=>1,region:modeRegion,clearSelection:clear,setNotes(value){notes=value;paint();},setTags(value){tags=value;paint();},zoom(action){if(action===null)mode='fit';else if(action==='actual'){mode='manual';scale=1;}else{mode='manual';scale=Math.max(.05,Math.min(8,scale*action));}layout();},destroy(){disposed=true;observer.disconnect();parent.replaceChildren();parent.hidden=true;original.width=original.height=0;canvas.width=canvas.height=0;}};
}
