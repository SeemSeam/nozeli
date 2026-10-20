import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {DesktopHost} from '../src/main/host.mjs';import {FileTags} from '../src/domain/file-tags.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ioAAAAASUVORK5CYII=','base64');
test('image material validates dimensions/regions and preserves immutable screenshot with stale-version protection',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-image-'));const root=path.join(dir,'project');await fs.mkdir(root);await fs.writeFile(path.join(root,'sample.png'),png);const host=new DesktopHost(path.join(dir,'profile'));const {project}=await host.pick(root);
 try{const file=await host.readFile(project.id,'sample.png');assert.equal(file.kind,'image');assert.equal(file.image.width,1);assert.ok(file.bytes);
 const input={relPath:'sample.png',materialDigest:file.digest,kind:'image-region',anchor:{space:'image-normalized',width:1,height:1,rects:[[0,0,1,1]],quote:''},note:'检查图像区域',regionImage:{dataUrl:'data:image/png;base64,'+png.toString('base64'),captureMode:'image-pixels'}};
 const {annotation}=await host.addAnnotation(project.id,input);const packet=await host.tagMaterial(project.id,{relPath:'sample.png',annotationId:annotation.id});assert.deepEqual(packet.information.location.pixelRects,[{x:0,y:0,width:1,height:1}]);assert.equal(packet.information.assets[0].captureMode,'image-pixels');assert.equal(packet.resolution.locationStatus,'exact');
 const tags=await new FileTags(root).read('sample.png');assert.equal(tags.tags[0].note,input.note);assert.equal(tags.tags[0].information.assets.length,1);
 await assert.rejects(host.addAnnotation(project.id,{...input,anchor:{...input.anchor,width:2}}),/尺寸/);
 await assert.rejects(host.addAnnotation(project.id,{...input,anchor:{...input.anchor,rects:[[.9,0,.5,1]]}}),/inside/);
 await assert.rejects(host.addAnnotation(project.id,{...input,regionImage:null}),/截图/);
 await fs.writeFile(path.join(root,'sample.png'),Buffer.concat([png,Buffer.from('changed')]));const stale=await host.tagMaterial(project.id,{relPath:'sample.png',annotationId:annotation.id});assert.equal(stale.resolution.anchor,null);assert.equal(stale.information.assets[0].digest,packet.information.assets[0].digest);
 await fs.writeFile(path.join(root,'bad.png'),'not image');await assert.rejects(host.readFile(project.id,'bad.png'),/损坏/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
