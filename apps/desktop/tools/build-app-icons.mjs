// Rebuild shared application icons from the unchanged brand artwork.
// Transparency is baked into the PNG for native windows, Dock and ICNS.
import {createCanvas,loadImage} from '@napi-rs/canvas';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const image=await loadImage(path.join(root,'assets/brand/nozeli-paired-tabs-icon.png'));
const size=1024,scale=2,inset=80,extent=size-2*inset,radius=184;
const large=createCanvas(size*scale,size*scale),ctx=large.getContext('2d');
ctx.scale(scale,scale);
ctx.beginPath();ctx.roundRect(inset,inset,extent,extent,radius);ctx.clip();
ctx.drawImage(image,inset,inset,extent,extent);
const output=createCanvas(size,size);output.getContext('2d').drawImage(large,0,0,size,size);
const destination=path.join(root,'assets/nozeli.png');
await fs.writeFile(destination,output.toBuffer('image/png'));
const small=createCanvas(256,256);small.getContext('2d').drawImage(output,0,0,256,256);
await fs.writeFile(path.join(root,'assets/brand/nozeli-small-icon.png'),small.toBuffer('image/png'));
console.log(JSON.stringify({destination,width:size,height:size,smallSize:256,inset,radius}));
