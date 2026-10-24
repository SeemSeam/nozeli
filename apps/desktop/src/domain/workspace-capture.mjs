export const CAPTURE_PIXELS = 40_000_000;
export function captureLayout(windows) {
  if(!Array.isArray(windows)||!windows.length||windows.length>32)throw Error('没有可捕获的窗口或窗口过多');
  let y=0,width=0;const tiles=windows.map(w=>{if(!Number.isSafeInteger(w.width)||!Number.isSafeInteger(w.height)||w.width<1||w.height<1)throw Error('窗口尺寸无效');const tile={...w,x:0,y};y+=w.height+32;width=Math.max(width,w.width);return tile;});
  const height=y-32;if(width>20000||height>20000||width*height>CAPTURE_PIXELS)throw Error('全部窗口超过图像容量，请选择单个窗口或矩形区域');
  return {width,height,tiles};
}
export function captureCrop(rect,width,height){
  if(!rect)return {x:0,y:0,width,height};
  if(!['x','y','width','height'].every(k=>Number.isFinite(rect[k])))throw Error('截图范围无效');
  const x=Math.max(0,Math.floor(rect.x)),y=Math.max(0,Math.floor(rect.y)),right=Math.min(width,Math.ceil(rect.x+rect.width)),bottom=Math.min(height,Math.ceil(rect.y+rect.height));
  if(right<=x||bottom<=y)throw Error('截图范围为空');return {x,y,width:right-x,height:bottom-y};
}
