import {captureCrop} from './workspace-capture.mjs';
const intersection=(a,b)=>{const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y),r=Math.min(a.x+a.width,b.x+b.width),d=Math.min(a.y+a.height,b.y+b.height);return r>x&&d>y?{x,y,width:r-x,height:d-y}:null;};
function subtract(a,b){const i=intersection(a,b);if(!i)return[a];return [{x:a.x,y:a.y,width:a.width,height:i.y-a.y},{x:a.x,y:i.y+i.height,width:a.width,height:a.y+a.height-i.y-i.height},{x:a.x,y:i.y,width:i.x-a.x,height:i.height},{x:i.x+i.width,y:i.y,width:a.x+a.width-i.x-i.width,height:i.height}].filter(r=>r.width>0&&r.height>0);}
export function captureOutput(session,input){
 const mode=input.scopeMode??'none';if(!['none','window','rectangle','screen'].includes(mode))throw Error('截图范围无效');
 const scale=input.pixelScale;if(!Number.isFinite(scale)||scale<=0||scale>8)throw Error('截图像素比例无效');
 const selected=mode==='window'?session.tiles.filter(t=>t.id===input.windowId):mode==='screen'?session.tiles.filter(t=>t.displayId===input.displayId):session.tiles;
 if(!selected.length)throw Error('截图窗口已失效');
 const display=mode==='screen'?selected[0].displayBounds:null;
 const width=mode==='window'?selected[0].width:display?.width??session.width,height=mode==='window'?selected[0].height:display?.height??session.height;
 const crop=captureCrop(input.crop,Math.ceil(width*scale),Math.ceil(height*scale));
 if(mode==='rectangle'&&!input.crop)throw Error('矩形范围缺失');
 const sources=[];
 const layers=selected.flatMap(tile=>{const tx=mode==='window'?0:mode==='screen'?tile.windowBounds.x-display.x:tile.x,ty=mode==='window'?0:mode==='screen'?tile.windowBounds.y-display.y:tile.y;return tile.layers.map(layer=>({layer,tx,ty,rect:intersection({x:(tx+layer.bounds.x)*scale,y:(ty+layer.bounds.y)*scale,width:layer.bounds.width*scale,height:layer.bounds.height*scale},{x:tx*scale,y:ty*scale,width:tile.width*scale,height:tile.height*scale})}));}).filter(l=>l.rect);
 if(mode!=='none')for(let i=0;i<layers.length;i++){const {layer,rect,tx,ty}=layers[i];if(!layer.source)continue;let pieces=[intersection(rect,crop)].filter(Boolean);for(const top of layers.slice(i+1))pieces=pieces.flatMap(r=>subtract(r,top.rect));for(const r of pieces)sources.push({...layer.source,outputRegion:{x:r.x-crop.x,y:r.y-crop.y,width:r.width,height:r.height},captureRegion:{x:r.x/scale-tx,y:r.y/scale-ty,width:r.width/scale,height:r.height/scale},locationStatus:'viewport-only',selection:null});}
 return {mode,scale,crop,sources};
}
