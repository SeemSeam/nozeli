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
export function mountRegionDrawing({getRect,getViewport,onChange,onFinish,onCancel,onOwnership,onError}){
 const root=document.createElement('div');root.id='region-drawing';root.hidden=true;
 const clip=document.createElement('div');clip.className='drawing-clip';const area=document.createElement('div');area.className='drawing-area';const background=document.createElement('img');background.draggable=false;area.append(background);clip.append(area);
 const bar=document.createElement('div');bar.className='drawing-controls';bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','选区涂鸦');
 const pen=document.createElement('button');pen.id='drawing-pen';pen.textContent='画笔';const eraser=document.createElement('button');eraser.id='drawing-eraser';eraser.textContent='擦除笔画';
 const color=document.createElement('input');color.type='color';color.id='drawing-color';color.value='#c7362f';color.setAttribute('aria-label','画笔颜色');
 const width=document.createElement('select');width.id='drawing-width';width.setAttribute('aria-label','画笔粗细');for(const n of [2,4,8,12]){const o=document.createElement('option');o.value=n;o.textContent=n+' px';width.append(o);}width.value='4';
 const undo=document.createElement('button');undo.id='drawing-undo';undo.textContent='撤销';const finish=document.createElement('button');finish.id='drawing-finish';finish.textContent='完成';const cancel=document.createElement('button');cancel.id='drawing-cancel';cancel.textContent='取消';setIconButton(pen,'pencil',{text:'画笔',label:'画笔'});setIconButton(undo,'reset',{label:'撤销笔画'});bar.append(pen,eraser,color,width,undo,finish,cancel);root.append(clip,bar);document.body.append(root);
 let data=null,baseline=null,svg=null,stroke=null,tool='pen',frame=0,history=[],draft=null,finishing=false;
 const setTool=t=>{tool=t;pen.setAttribute('aria-pressed',String(t==='pen'));eraser.setAttribute('aria-pressed',String(t==='eraser'));area.dataset.tool=t;};setTool('pen');pen.onclick=()=>setTool('pen');eraser.onclick=()=>setTool('eraser');
 function paint(){svg?.remove();svg=drawingSvg(data);area.append(svg);undo.disabled=!history.length;finish.disabled=finishing;}
 const changed=()=>{paint();onChange(structuredClone(data));};
 function layout(){if(!draft)return;const r=getRect(draft),v=getViewport();if(!r||!v){clip.hidden=true;bar.style.left=Math.max(8,v?.left||8)+'px';bar.style.top=Math.max(8,v?.top||8)+'px';bar.dataset.hiddenRegion='true';}
  else{bar.dataset.hiddenRegion='false';const l=Math.max(r.left,v.left,0),t=Math.max(r.top,v.top,0),right=Math.min(r.right,v.right,innerWidth),bottom=Math.min(r.bottom,v.bottom,innerHeight);clip.hidden=right<=l||bottom<=t;Object.assign(clip.style,{left:l+'px',top:t+'px',width:Math.max(0,right-l)+'px',height:Math.max(0,bottom-t)+'px'});Object.assign(area.style,{left:r.left-l+'px',top:r.top-t+'px',width:r.right-r.left+'px',height:r.bottom-r.top+'px'});
   bar.style.maxWidth=Math.max(180,Math.min(innerWidth-16,v.right-v.left-16))+'px';const b=bar.getBoundingClientRect();bar.style.left=Math.max(8,Math.min(innerWidth-b.width-8,Math.max(v.left+8,r.left)))+'px';bar.style.top=Math.max(8,Math.min(innerHeight-b.height-8,r.top-b.height-8>=v.top?r.top-b.height-8:bottom+8))+'px';}
  frame=requestAnimationFrame(layout);
 }
 function suspend(){if(!draft)return;stroke=null;cancelAnimationFrame(frame);root.hidden=true;draft=null;onOwnership(false);}
 function point(e){const r=area.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))];}
 function erase(p){const short=Math.min(data.width,data.height);let best=-1,distance=Infinity;data.strokes.forEach((s,i)=>{for(let j=0;j<s.points.length;j++){const a=s.points[j],b=s.points[j+1]||a,dx=(b[0]-a[0])*data.width,dy=(b[1]-a[1])*data.height,px=(p[0]-a[0])*data.width,py=(p[1]-a[1])*data.height,u=Math.max(0,Math.min(1,(px*dx+py*dy)/(dx*dx+dy*dy||1))),d=Math.hypot(px-u*dx,py-u*dy);if(d<distance&&d<=Math.max(8,s.width*short/2+5)){best=i;distance=d;}}});if(best>=0){history.push(structuredClone(data.strokes));data.strokes.splice(best,1);changed();}}
 area.onpointerdown=e=>{if(e.button!==0||finishing)return;e.preventDefault();e.stopPropagation();area.setPointerCapture(e.pointerId);const p=point(e);if(tool==='eraser'){erase(p);return;}if(data.strokes.length>=500)return onError('笔画已达上限，请另建选区。');history.push(structuredClone(data.strokes));stroke={color:color.value,width:Math.min(.2,Number(width.value)/Math.min(data.width,data.height)),points:[p]};data.strokes.push(stroke);paint();};
 area.onpointermove=e=>{if(!stroke)return;e.preventDefault();const p=point(e),prev=stroke.points.at(-1);if(Math.hypot((p[0]-prev[0])*data.width,(p[1]-prev[1])*data.height)<1)return;if(stroke.points.length>=10000)return;stroke.points.push(p);paint();};
 const up=e=>{if(area.hasPointerCapture(e.pointerId))area.releasePointerCapture(e.pointerId);if(stroke){stroke=null;try{validateDrawing(data);changed();}catch(error){data.strokes=history.pop();paint();onError(error.message);}}};area.onpointerup=up;area.onpointercancel=up;
 undo.onclick=()=>{if(history.length){data.strokes=history.pop();changed();}};
 cancel.onclick=()=>{const old=baseline;const target=draft;suspend();onCancel(target,old);};
 finish.onclick=async()=>{if(!draft||finishing)return;finishing=true;paint();const target=draft;try{const image=await compositeDrawing(target.regionImage.dataUrl,data);if(draft!==target)return;const value=structuredClone(data);suspend();await onFinish(target,value,image);}catch(e){onError(e.message);}finally{finishing=false;}};
 const keyboard=e=>{if(!draft)return;if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();cancel.click();}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.stopImmediatePropagation();undo.click();}};window.addEventListener('keydown',keyboard,true);
 return {active:()=>!!draft,suspend,async start(target){suspend();const im=new Image();im.src=target.regionImage.dataUrl;await im.decode();draft=target;baseline=target.drawing?structuredClone(target.drawing):null;data=validateDrawing(target.drawing||{schema:DRAWING_SCHEMA,width:im.naturalWidth,height:im.naturalHeight,strokes:[]});history=[];background.src=im.src;setTool('pen');root.hidden=false;onOwnership(true);paint();layout();},dispose(){window.removeEventListener('keydown',keyboard,true);suspend();root.remove();}};
}
