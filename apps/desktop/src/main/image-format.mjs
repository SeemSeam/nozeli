import {imageSize} from 'image-size';
export const imageExtension = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const mime={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',bmp:'image/bmp',avif:'image/avif',heif:'image/avif'};
export function imageInfo(bytes){
 let value;try{value=imageSize(bytes);}catch{throw Error('图片格式损坏或无法识别。');}
 if(!mime[value.type]||!value.width||!value.height||value.width*value.height>40_000_000||Math.max(value.width,value.height)>20000)throw Error('图片格式不支持，或超过 4000 万像素 / 单边 20000 像素限制。');
 const swap=[5,6,7,8].includes(value.orientation);
 return {width:swap?value.height:value.width,height:swap?value.width:value.height,mime:mime[value.type],orientation:value.orientation||1,animated:value.type==='gif'||value.type==='webp'||value.type==='png'};
}
