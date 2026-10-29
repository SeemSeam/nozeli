import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import {createHash} from 'node:crypto';
import {nativeFixture,appRoot} from './desktop-native.fixture.mjs';
import {contentToolForPage} from './native-content-tools.fixture.mjs';
const original=await fs.readFile(path.join(appRoot,'tests/fixtures/ppt/compatibility.pptx')),digest=createHash('sha256').update(original).digest('hex');
const f=await nativeFixture('native-ppt',{'sample.pptx':original},{inspect:true});
const frameFor=async p=>{await p.waitForFunction(()=>document.querySelector('#ppt-frame')?.contentWindow?.__nozeliPptist?.store.slides.length,{timeout:60000});return p.frames().find(frame=>frame.url().includes('/ppt-vendor/'));};
const geometry=async frame=>JSON.parse(await frame.evaluate(()=>JSON.stringify(__nozeliPptist.store.slides.map(s=>s.elements.map(e=>({type:e.type,left:e.left,top:e.top,width:e.width,height:e.height,rotate:e.rotate}))))));
try{
 await f.start();let p=await f.open('sample.pptx'),frame=await frameFor(p);assert.equal(await frame.evaluate(()=>__nozeliPptist.store.slides.length),3);const before=await geometry(frame);
 const element=await frame.evaluateHandle(()=>[...document.querySelectorAll('.editable-element .ProseMirror')].find(n=>n.textContent.includes('NOZELI_PPTIST_TITLE')));await element.asElement().click({count:2});await p.keyboard.down(process.platform==='darwin'?'Meta':'Control');await p.keyboard.press('a');await p.keyboard.up(process.platform==='darwin'?'Meta':'Control');await p.keyboard.sendCharacter('NOZELI_EDIT 中文演示');await p.keyboard.press('Escape');await frame.waitForFunction(()=>JSON.stringify(__nozeliPptist.store.slides).includes('NOZELI_EDIT'));
 await f.until(async()=>JSON.stringify(await f.call('ppt.draft',{projectId:f.id,relPath:'sample.pptx',digest})).includes('NOZELI_EDIT'),'independent PPT draft');assert.deepEqual(await fs.readFile(path.join(f.project,'sample.pptx')),original);await f.screenshot(p,'ppt-edited');f.check('embedded PPT keyboard edit persists as an independent draft; original bytes unchanged');
 await f.close();await f.start();p=await f.open('sample.pptx');frame=await frameFor(p);assert.match(await frame.evaluate(()=>JSON.stringify(__nozeliPptist.store.slides)),/NOZELI_EDIT 中文演示/);assert.deepEqual(await geometry(frame),before);f.check('cold restart restores draft text and unchanged slide element geometry');
 const exportedPath=path.join(f.project,'exported.pptx');await f.chooseSavePath(exportedPath);await contentToolForPage(p,['file','exportPpt']);const bytes=await f.until(()=>fs.readFile(exportedPath).catch(()=>null),'PPT export');const z=await JSZip.loadAsync(bytes);assert.match(await z.file('ppt/slides/slide1.xml').async('string'),/NOZELI_EDIT/);assert.deepEqual(await fs.readFile(path.join(f.project,'sample.pptx')),original);
 for(const destination of [path.join(f.project,'sample.pptx'),exportedPath]){await f.chooseSavePath(destination);const reply=await p.evaluate(payload=>nozeli.invoke('ppt.export',payload),{projectId:f.id,relPath:'sample.pptx',digest,bytes:[...bytes]});assert.equal(reply.ok,false);assert.deepEqual(await fs.readFile(exportedPath),bytes);assert.deepEqual(await fs.readFile(path.join(f.project,'sample.pptx')),original);}
 f.check('real renderer export and host exclusive write create a separate PPTX; source and existing destination overwrite attempts are refused (save dialog destination automated)');
 p=await f.open('exported.pptx');frame=await frameFor(p);assert.equal(await frame.evaluate(()=>__nozeliPptist.store.slides.length),3);assert.match(await frame.evaluate(()=>JSON.stringify(__nozeliPptist.store.slides)),/NOZELI_EDIT/);await f.screenshot(p,'ppt-export-reopened');f.check('exported copy reopens in the packaged presentation engine');await f.close();await f.finish();
}catch(error){await f.finish(error);process.exitCode=1;}
