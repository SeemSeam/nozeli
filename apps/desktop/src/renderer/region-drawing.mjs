import {setIconButton} from './ui-icons.mjs';
import {DRAWING_SCHEMA,validateDrawing} from '../domain/region-drawing.mjs';
import './region-drawing.css';
const ns='http://www.w3.org/2000/svg';
export function drawingSvg(value){
 const drawing=validateDrawing(value),svg=document.createElementNS(ns,'svg');svg.classList.add('region-drawing-projection');svg.setAttribute('viewBox',`0 0 ${drawing.width} ${drawing.height}`);svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');
 for(const s of drawing.strokes){const line=document.createElementNS(ns,'polyline');line.setAttribute('points',s.points.map(([x,y])=>`${x*drawing.width},${y*drawing.height}`).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke',s.color);line.setAttribute('stroke-width',s.width*Math.min(drawing.width,drawing.height));line.setAttribute('stroke-linecap','round');line.setAttribute('stroke-linejoin','round');svg.append(line);
  if(s.points.length===1){const dot=document.createElementNS(ns,'circle');dot.setAttribute('cx',s.points[0][0]*drawing.width);dot.setAttribute('cy',s.points[0][1]*drawing.height);dot.setAttribute('r',s.width*Math.min(drawing.width,drawing.height)/2);dot.setAttribute('fill',s.color);svg.append(dot);}
 }return svg;
}
export function projectDrawing(parent,drawing,rect){if(!drawing)return;const svg=drawingSvg(drawing);Object.assign(svg.style,{position:'absolute',left:rect[0]*100+'%',top:rect[1]*100+'%',width:rect[2]*100+'%',height:rect[3]*100+'%',pointerEvents:'none'});parent.append(svg);}
export async function compositeDrawing(dataUrl,value){
 const d=validateDrawing(value),image=new Image();image.src=dataUrl;await image.decode();if(image.naturalWidth!==d.width||image.naturalHeight!==d.height)throw Error('涂鸦与原始截图尺寸不同');
 const c=document.createElement('canvas');c.width=d.width;c.height=d.height;const x=c.getContext('2d');x.drawImage(image,0,0);x.lineCap=x.lineJoin='round';
 for(const s of d.strokes){x.strokeStyle=x.fillStyle=s.color;x.lineWidth=s.width*Math.min(d.width,d.height);x.beginPath();s.points.forEach(([px,py],i)=>{if(i)x.lineTo(px*d.width,py*d.height);else x.moveTo(px*d.width,py*d.height);});if(s.points.length===1){x.arc(s.points[0][0]*d.width,s.points[0][1]*d.height,x.lineWidth/2,0,Math.PI*2);x.fill();}else x.stroke();}
 return c.toDataURL('image/png');
}
// Both native overlays and historical frozen records use this editor and vector schema.
export function mountDrawingEditor({getRect,getViewport,container=document.body,idPrefix='drawing',fullscreen=false,onChange=()=>{},onFinish=()=>{},onCancel=()=>{},onOwnership=()=>{},onError=()=>{},onAdjustRange,onSaveLocal}={}){
 const root=document.createElement('div');root.id=idPrefix==='drawing'?'region-drawing':idPrefix;root.className='region-drawing-editor';root.hidden=true;root.classList.toggle('drawing-fullscreen',fullscreen);
 const clip=document.createElement('div');clip.className='drawing-clip';const area=document.createElement('div');area.className='drawing-area';const background=document.createElement('img');background.draggable=false;background.alt='冻结画面';area.append(background);clip.append(area);
 const bar=document.createElement('div');bar.className='drawing-controls';bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','涂鸦');
 const button=(name,text)=>{const b=document.createElement('button');b.type='button';b.id=idPrefix+'-'+name;b.textContent=text;return b;};
 const pen=button('pen','画笔'),eraser=button('eraser','擦除笔画'),undo=button('undo','撤销'),redo=button('redo','重做'),finish=button('finish','完成'),cancel=button('cancel',fullscreen?'退出':'取消'),adjust=button('adjust','调整范围'),local=button('save-local','仅保存本地备注');
 const color=document.createElement('input');color.type='color';color.id=idPrefix+'-color';color.value='#c7362f';color.setAttribute('aria-label','画笔颜色');
 const width=document.createElement('select');width.id=idPrefix+'-width';width.setAttribute('aria-label','画笔粗细');for(const n of [2,4,8,12]){const o=document.createElement('option');o.value=n;o.textContent=n+' px';width.append(o);}width.value='4';
 const source=document.createElement('div');source.className='drawing-source';source.setAttribute('role','status');
 setIconButton(pen,'pencil',{text:'画笔',label:'画笔'});setIconButton(undo,'reset',{label:'撤销笔画'});finish.dataset.drawingAction='finish';bar.append(pen,eraser,color,width,undo,redo);if(onAdjustRange)bar.append(adjust);if(onSaveLocal)bar.append(local);bar.append(finish,cancel,source);root.append(clip,bar);container.append(root);
 let data=null,baseline=null,svg=null,stroke=null,tool='pen',frame=0,history=[],future=[],draft=null,finishing=false,generation=0,disposed=false;
 const setTool=t=>{tool=t;pen.setAttribute('aria-pressed',String(t==='pen'));eraser.setAttribute('aria-pressed',String(t==='eraser'));area.dataset.tool=t;};setTool('pen');pen.onclick=()=>setTool('pen');eraser.onclick=()=>setTool('eraser');
 function paint(){svg?.remove();svg=drawingSvg(data);area.append(svg);for(const control of bar.querySelectorAll('button,input,select'))control.disabled=finishing;undo.disabled=finishing||!history.length;redo.disabled=finishing||!future.length;root.setAttribute('aria-busy',String(finishing));}
 const changed=()=>{paint();onChange(structuredClone(data));};
 const checkpoint=()=>{history.push(structuredClone(data.strokes));future=[];};
 // Fullscreen: the frozen image fills the viewport with zero chrome reserve;
 // toolbar, status and recovery controls float above it, so the workspace
 // keeps exactly the size it had when frozen.
 function fittedRect(){const v=getViewport?.()||{left:0,top:0,right:innerWidth,bottom:innerHeight};const scale=Math.max(0,Math.min((v.right-v.left)/data.width,(v.bottom-v.top)/data.height));const w=data.width*scale,h=data.height*scale,left=v.left+(v.right-v.left-w)/2,top=v.top+(v.bottom-v.top-h)/2;return {left,top,right:left+w,bottom:top+h};}
 function layout(){if(!draft)return;const v=getViewport?.()||{left:0,top:0,right:innerWidth,bottom:innerHeight},r=getRect?getRect(draft):fittedRect();if(!r){clip.hidden=true;bar.style.left=Math.max(8,v.left)+'px';bar.style.top=Math.max(8,v.top)+'px';bar.dataset.hiddenRegion='true';}
  else{bar.dataset.hiddenRegion='false';const l=Math.max(r.left,v.left,0),t=Math.max(r.top,v.top,0),right=Math.min(r.right,v.right,innerWidth),bottom=Math.min(r.bottom,v.bottom,innerHeight);clip.hidden=right<=l||bottom<=t;Object.assign(clip.style,{left:l+'px',top:t+'px',width:Math.max(0,right-l)+'px',height:Math.max(0,bottom-t)+'px'});Object.assign(area.style,{left:r.left-l+'px',top:r.top-t+'px',width:r.right-r.left+'px',height:r.bottom-r.top+'px'});
   bar.style.maxWidth=Math.max(180,Math.min(innerWidth-16,v.right-v.left-16))+'px';const b=bar.getBoundingClientRect();bar.style.left=Math.max(8,Math.min(innerWidth-b.width-8,Math.max(v.left+8,r.left)))+'px';bar.style.top=fullscreen?Math.max(8,v.top+8)+'px':Math.max(8,Math.min(innerHeight-b.height-8,r.top-b.height-8>=v.top?r.top-b.height-8:bottom+8))+'px';}
  frame=requestAnimationFrame(layout);
 }
 function suspend(){generation++;stroke=null;cancelAnimationFrame(frame);root.hidden=true;if(draft){draft=null;onOwnership(false);}}
 function point(e){const r=area.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))];}
 function erase(p){const short=Math.min(data.width,data.height);let best=-1,distance=Infinity;data.strokes.forEach((s,i)=>{for(let j=0;j<s.points.length;j++){const a=s.points[j],b=s.points[j+1]||a,dx=(b[0]-a[0])*data.width,dy=(b[1]-a[1])*data.height,px=(p[0]-a[0])*data.width,py=(p[1]-a[1])*data.height,u=Math.max(0,Math.min(1,(px*dx+py*dy)/(dx*dx+dy*dy||1))),d=Math.hypot(px-u*dx,py-u*dy);if(d<distance&&d<=Math.max(8,s.width*short/2+5)){best=i;distance=d;}}});if(best>=0){checkpoint();data.strokes.splice(best,1);changed();}}
 area.onpointerdown=e=>{if(e.button!==0||finishing)return;e.preventDefault();e.stopPropagation();area.setPointerCapture(e.pointerId);const p=point(e);if(tool==='eraser'){erase(p);return;}if(data.strokes.length>=500)return onError('笔画已达上限，请另建选区。');checkpoint();stroke={color:color.value,width:Math.min(.2,Number(width.value)/Math.min(data.width,data.height)),points:[p]};data.strokes.push(stroke);paint();};
 area.onpointermove=e=>{if(!stroke)return;e.preventDefault();const p=point(e),prev=stroke.points.at(-1);if(Math.hypot((p[0]-prev[0])*data.width,(p[1]-prev[1])*data.height)<1)return;if(stroke.points.length>=10000)return;stroke.points.push(p);paint();};
 function completeStroke(){if(!stroke)return;stroke=null;try{data=validateDrawing(data);changed();}catch(error){data.strokes=history.pop();paint();onError(error.message);}}
 const up=e=>{if(area.hasPointerCapture(e.pointerId))area.releasePointerCapture(e.pointerId);completeStroke();};area.onpointerup=up;area.onpointercancel=up;
 undo.onclick=()=>{completeStroke();if(history.length){future.push(structuredClone(data.strokes));data.strokes=history.pop();changed();}};
 redo.onclick=()=>{completeStroke();if(future.length){history.push(structuredClone(data.strokes));data.strokes=future.pop();changed();}};
 cancel.onclick=async()=>{if(finishing||!draft)return;completeStroke();if(!fullscreen&&JSON.stringify(data.strokes)!==JSON.stringify(baseline?.strokes||[])&&!window.confirm('放弃本次笔迹修改？冻结画面和已保留草稿不会被删除。'))return;const old=baseline,target=draft;
  // Fullscreen hosts (workspace snapshot) own retention-gated exits: the
  // verdict only exists after awaits, so onCancel is awaited and may veto with
  // false — the editor then stays live with strokes, dirty revision and error
  // state intact and the host keeps handling the dialog. Any other result,
  // and every non-fullscreen selection editor, keep the legacy
  // suspend-then-cancel order unchanged.
  if(fullscreen){if(await onCancel(target,old)===false)return;suspend();return;}
  suspend();onCancel(target,old);};
 const save=async(destination)=>{if(!draft||finishing)return;completeStroke();finishing=true;paint();const target=draft;try{const image=await compositeDrawing(target.regionImage.dataUrl,data);if(draft!==target)return;const value=structuredClone(data);await (destination==='local'?onSaveLocal:onFinish)(target,value,image,{destination});if(draft===target)suspend();}catch(e){onError(e.message);}finally{finishing=false;if(draft)paint();}};
 finish.onclick=()=>void save('conversation');local.onclick=()=>void save('local');
 adjust.onclick=async()=>{if(finishing||!draft)return;completeStroke();finishing=true;paint();try{await onAdjustRange?.(draft,structuredClone(data));}catch(e){onError(e.message);}finally{finishing=false;if(draft)paint();}};
 const keyboard=e=>{if(!draft)return;const mod=e.ctrlKey||e.metaKey,key=e.key.toLowerCase();if(e.key==='Escape'||mod&&(key==='z'||key==='y'||e.key==='Enter')){e.preventDefault();e.stopImmediatePropagation();if(finishing)return;if(e.key==='Escape')cancel.click();else if(e.key==='Enter')finish.click();else if(key==='y'||e.shiftKey)redo.click();else undo.click();}};window.addEventListener('keydown',keyboard,true);
return {active:()=>!!draft,suspend,snapshot:()=>draft?{target:draft,drawing:structuredClone(data)}:null,async start(target){suspend();const token=generation,im=new Image();im.src=target.regionImage.dataUrl;await im.decode();if(disposed||token!==generation)return;const next=validateDrawing(target.drawing||{schema:DRAWING_SCHEMA,width:im.naturalWidth,height:im.naturalHeight,strokes:[]});if(next.width!==im.naturalWidth||next.height!==im.naturalHeight)throw Error('涂鸦与原始截图尺寸不同');draft=target;baseline=target.drawing?structuredClone(target.drawing):null;data=next;history=[];future=[];finishing=false;background.src=im.src;source.textContent=target.sourceSummary||((target.sources?.length)?target.sources.map(s=>s.summary||s.relPath||'工作区画面').join('；'):target.relPath?`${target.relPath} · 冻结版本 ${target.sourceDraftDigest||target.materialDigest||'待确认'} · 历史选区`:'工作区截图，未锚定文件');source.title=source.textContent;setTool('pen');root.hidden=false;onOwnership(true);paint();layout();},dispose(){disposed=true;window.removeEventListener('keydown',keyboard,true);suspend();root.remove();}};
}
export function mountRegionDrawing(options){return mountDrawingEditor(options);}
