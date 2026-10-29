import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {nativeFixture} from './desktop-native.fixture.mjs';
import {contentToolForPage} from './native-content-tools.fixture.mjs';
const f=await nativeFixture('native-image',{'other.txt':'Other document\n'}),originals=new Map(),notes=new Map();
try{
 await f.start();const images=await f.shell.evaluate(()=>{const c=document.createElement('canvas');c.width=900;c.height=600;const x=c.getContext('2d');x.fillStyle='#ff0000';x.fillRect(0,0,450,600);x.fillStyle='#0000ff';x.fillRect(450,0,450,600);return ['png','jpeg','webp'].map(type=>({type,data:c.toDataURL('image/'+type).split(',')[1]}));});
 for(const image of images){const bytes=Buffer.from(image.data,'base64');originals.set('sample.'+image.type,bytes);await fs.writeFile(path.join(f.project,'sample.'+image.type),bytes);}
 for(const [rel,original]of originals){
  const p=await f.open(rel);await p.waitForSelector('#image-host canvas');await contentToolForPage(p,['actual']);await p.waitForFunction(()=>Math.round(document.querySelector('.image-page').getBoundingClientRect().width)===900);await contentToolForPage(p,['fit']);
  await contentToolForPage(p,['view','region']);const b=await p.$eval('.image-page',n=>n.getBoundingClientRect().toJSON());await p.mouse.move(b.left+b.width*.1,b.top+b.height*.35);await p.mouse.down();await p.mouse.move(b.left+b.width*.3,b.top+b.height*.55,{steps:12});await p.mouse.up();await p.waitForSelector('#selection-menu:not([hidden])');await p.click('#selection-note');await p.waitForSelector('#note-form:not([hidden])');await p.type('#note-input','区域备注 '+rel);await p.click('#add-note');await p.waitForSelector('#image-host .note-anchor');
  const note=await f.until(async()=>{const list=await f.call('annotation.list',{projectId:f.id,relPath:rel});return list.annotations[0];},'image note');assert.equal(note.kind,'image-region');assert(note.anchor.rects[0].every(Number.isFinite));notes.set(rel,note);assert.deepEqual(await fs.readFile(path.join(f.project,rel)),original);await f.screenshot(p,rel.replace('.','-'));f.check(rel+': decode, actual-size/fit zoom and physical region note without changing source bytes');
 }
 assert.equal((await f.call('managed.status',{projectId:f.id})).ready,false);await f.close();await f.start();
 for(const [rel,original]of originals){const p=await f.open(rel);await p.waitForSelector('#image-host .note-anchor');const note=(await f.call('annotation.list',{projectId:f.id,relPath:rel})).annotations[0];assert.deepEqual(note.anchor,notes.get(rel).anchor);assert.equal(note.materialDigest,notes.get(rel).materialDigest);assert.deepEqual(await fs.readFile(path.join(f.project,rel)),original);}
 f.check('cold restart restores every image region at the original normalized coordinates and source version');await f.close();await f.finish();
}catch(error){await f.finish(error);process.exitCode=1;}
