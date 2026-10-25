export const CAPTURE_PIXELS = 40_000_000;
export function captureCrop(rect,width,height){
  if(!rect)return {x:0,y:0,width,height};
  if(!['x','y','width','height'].every(k=>Number.isFinite(rect[k])))throw Error('截图范围无效');
  const x=Math.max(0,Math.floor(rect.x)),y=Math.max(0,Math.floor(rect.y)),right=Math.min(width,Math.ceil(rect.x+rect.width)),bottom=Math.min(height,Math.ceil(rect.y+rect.height));
  if(right<=x||bottom<=y)throw Error('截图范围为空');return {x,y,width:right-x,height:bottom-y};
}
