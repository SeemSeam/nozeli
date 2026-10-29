import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {nativeFixture,appRoot} from './desktop-native.fixture.mjs';
import {contentToolForPage} from './native-content-tools.fixture.mjs';

// Entirely synthetic, two pages and an outline; no external PDF generator needed.
function outlinedPdf(){
 const stream=text=>{const value=`BT /F1 18 Tf 60 700 Td (${text}) Tj 0 -40 Td (Synthetic selection and region notes.) Tj ET`;return `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`;};
 const objects=['<< /Type /Catalog /Pages 2 0 R /Outlines 7 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 4 0 R >>',stream('Nozeli first page'),
 '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents 6 0 R >>',stream('Nozeli second page'),
 '<< /Type /Outlines /First 8 0 R /Last 8 0 R /Count 1 >>','<< /Title (Second page) /Parent 7 0 R /Dest [5 0 R /Fit] >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
 let text='%PDF-1.4\n',offsets=[0];for(const [i,object]of objects.entries()){offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${object}\nendobj\n`;}
 const xref=Buffer.byteLength(text);text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(text);
}
const original=outlinedPdf(),chinese=await fs.readFile(path.join(appRoot,'tests/fixtures/pdf/nozeli-sample.zh.pdf'));
const f=await nativeFixture('native-pdf',{'sample.pdf':original,'中文.pdf':chinese});
const notes=[];
async function saveNote(p,text){await p.waitForSelector('#note-form:not([hidden])');await p.type('#note-input',text);await p.click('#add-note');const note=await f.until(async()=>(await f.call('annotation.list',{projectId:f.id,relPath:'sample.pdf'})).annotations.find(n=>n.note===text),'saved '+text);notes.push(note);return note;}
try{
 await f.start();let p=await f.open('中文.pdf');await p.waitForSelector('#pdf-host .textLayer span');assert.match(await p.$eval('#pdf-host',n=>n.textContent),/[\u4e00-\u9fff]/);assert.deepEqual(await fs.readFile(path.join(f.project,'中文.pdf')),chinese);
 p=await f.open('sample.pdf');await p.waitForSelector('#pdf-host .textLayer span');
 await contentToolForPage(p,['view','pdf-outline']);await p.locator('#pdf-outline button').click();await p.waitForFunction(()=>document.querySelector('#pdf-page').value.includes('2'));
 await contentToolForPage(p,['view','page-prev']);await p.waitForFunction(()=>document.querySelector('#pdf-page').value.includes('1'));
 await contentToolForPage(p,['find']);await p.type('#pdf-query','Nozeli');await p.keyboard.press('Enter');await p.waitForFunction(()=>document.querySelector('#pdf-search-status').textContent.includes('/ 2 页匹配'));
 const width=await p.$eval('.pdf-page',n=>n.getBoundingClientRect().width);await contentToolForPage(p,['view','zoom-in']);await p.waitForFunction(w=>document.querySelector('.pdf-page').getBoundingClientRect().width>w,{},width);await contentToolForPage(p,['fitPage']);
 await p.waitForSelector('#pdf-host .textLayer span',{visible:true});await p.evaluate(()=>document.fonts.ready);await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));f.check('Chinese PDF reading plus synthetic outline navigation, two-page search and zoom');
 let b=await p.$eval('#pdf-host .textLayer span',n=>n.getBoundingClientRect().toJSON());await p.mouse.move(b.left+1,(b.top+b.bottom)/2);await p.mouse.down();await p.mouse.move(b.right-1,(b.top+b.bottom)/2,{steps:15});await p.mouse.up();await p.waitForSelector('#selection-menu:not([hidden])');await p.click('#selection-note');const selected=await saveNote(p,'文本选区备注');assert.equal(selected.kind,'pdf-selection');assert.match(selected.anchor.quote,/Nozeli/);
 await contentToolForPage(p,['view','region']);b=await p.$eval('.pdf-page',n=>n.getBoundingClientRect().toJSON());await p.mouse.move(b.left+b.width*.1,b.top+b.height*.4);await p.mouse.down();await p.mouse.move(b.left+b.width*.3,b.top+b.height*.55,{steps:15});await p.mouse.up();await p.waitForSelector('#selection-menu:not([hidden])');await p.click('#selection-note');const region=await saveNote(p,'页面区域备注');assert.equal(region.kind,'pdf-region');assert(region.anchor.rects[0].every(Number.isFinite));
 await contentToolForPage(p,['view','region']);await p.click('.pdf-page',{button:'right',offset:{x:20,y:20}});await p.locator('#document-context-menu:not([hidden]) [data-command="note-page"]').click();await p.waitForSelector('#note-form:not([hidden])');await contentToolForPage(p,['view','page-next']);const whole=await saveNote(p,'打开菜单时的整页备注');assert.equal(whole.kind,'pdf-page');assert.equal(whole.anchor.page,1);
 assert.deepEqual(await fs.readFile(path.join(f.project,'sample.pdf')),original);assert.equal((await f.call('managed.status',{projectId:f.id})).ready,false);f.check('text, region and whole-page notes retain source version; changing pages before saving keeps the frozen page');await f.screenshot(p,'pdf-notes');await f.close();await f.start();p=await f.open('sample.pdf');await p.waitForSelector('#pdf-host .textLayer span');const restored=(await f.call('annotation.list',{projectId:f.id,relPath:'sample.pdf'})).annotations;
 for(const before of notes){const after=restored.find(n=>n.id===before.id);assert.equal(after.materialDigest,before.materialDigest);assert.deepEqual(after.anchor,before.anchor);assert.equal(after.kind,before.kind);}assert.deepEqual(await fs.readFile(path.join(f.project,'sample.pdf')),original);f.check('cold restart keeps every PDF note on its exact original version, page and coordinates, without rewriting either PDF');await f.screenshot(p,'pdf-reopened');await f.close();await f.finish();
}catch(error){await f.finish(error);process.exitCode=1;}
