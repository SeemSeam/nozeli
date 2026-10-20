// Versioned, portable geometry. No document or renderer dependency.
export const DRAWING_SCHEMA='nozeli.region-drawing-v1';
export function validateDrawing(value){
 if(!value||value.schema!==DRAWING_SCHEMA||!Number.isInteger(value.width)||!Number.isInteger(value.height)||value.width<1||value.height<1||value.width>20000||value.height>20000||value.width*value.height>40_000_000||!Array.isArray(value.strokes)||value.strokes.length>500)throw Error('涂鸦格式或尺寸无效');
 let count=0;
 const strokes=value.strokes.map(s=>{
  if(!/^#[0-9a-f]{6}$/i.test(s.color||'')||!Number.isFinite(s.width)||s.width<=0||s.width>.2||!Array.isArray(s.points)||!s.points.length||s.points.length>10000)throw Error('笔迹颜色、粗细或点数量无效');
  count+=s.points.length;if(count>30000)throw Error('笔迹过多，请分成多个区域');
  const points=s.points.map(p=>{if(!Array.isArray(p)||p.length!==2||!p.every(n=>Number.isFinite(n)&&n>=0&&n<=1))throw Error('笔迹超出选区');return p.slice();});
  return {color:s.color.toLowerCase(),width:s.width,points};
 });return {schema:DRAWING_SCHEMA,width:value.width,height:value.height,strokes};
}
export function preferredRegionAssets(packets){
 return packets.filter(p=>/^(image|pdf|ppt)-region$/.test(p.kind)).map(p=>{
  const assets=p.information?.assets||[];
  const raw=assets.find(a=>a.role==='region-screenshot');
  const chosen=assets.find(a=>a.role==='annotated-region')||raw;
  if(!raw||!chosen||chosen.clipped)throw Error('区域截图缺失、不完整或校验失败，未发送；请重新框选。');
  return chosen;
 });
}

export function compactDrawingPacket(packet){
 const information=packet.information;if(!information?.drawing)return packet;
 const {strokes,...drawing}=information.drawing;
 return {...packet,information:{...information,drawing:{...drawing,strokeCount:strokes.length,vectorAsset:information.assets.find(a=>a.role==='drawing-strokes')}}};
}
