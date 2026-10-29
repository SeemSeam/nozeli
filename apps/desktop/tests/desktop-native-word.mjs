import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import {nativeFixture,appRoot} from './desktop-native.fixture.mjs';
import {contentToolForPage} from './native-content-tools.fixture.mjs';
const original=await fs.readFile(path.join(appRoot,'tests/fixtures/office/中文 文档.docx'));
const f=await nativeFixture('native-word',{'sample.docx':original,'other.md':'# Other document\n'});
const shortcut=async(page,key)=>{await page.keyboard.down(process.platform==='darwin'?'Meta':'Control');await page.keyboard.press(key);await page.keyboard.up(process.platform==='darwin'?'Meta':'Control');};
const frameFor=async page=>{await page.waitForFunction(()=>document.querySelector('#word-host iframe')?.contentWindow?.nozeliWordEditor?.activeEditor?.state?.doc,{timeout:45000});return page.frames().find(frame=>frame.url().endsWith('/word-frame.html'));};
try{
 await f.start();let page=await f.open('sample.docx'),frame=await frameFor(page);
 assert.deepEqual(await fs.readFile(path.join(f.project,'sample.docx')),original,'opening never writes the original');
 const before=await frame.evaluate(()=>{const d=nozeliWordEditor.activeEditor.state.doc;let tables=0;d.descendants(n=>{if(n.type.name==='table')tables++;});return {tables,text:d.textContent};});assert(before.tables>0);assert.match(before.text,/原始首句/);
 await contentToolForPage(page,['view','fit']);await frame.waitForFunction(()=>nozeliWordEditor.getZoomState().mode==='fit-width');await frame.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
 const coords=await frame.evaluate(()=>{const w=document.createTreeWalker(document.querySelector('#document'),NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const i=n.textContent.indexOf('原始首句');if(i<0)continue;const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+4);if(!r.getBoundingClientRect().width)continue;n.parentElement.scrollIntoView({block:'center'});const b=r.getBoundingClientRect();return{x:b.left+1,y:(b.top+b.bottom)/2,right:b.right-1};}throw Error('visible quote missing');});
 const offset=await page.$eval('#word-host iframe',n=>{const r=n.getBoundingClientRect();return{x:r.left,y:r.top};});
 await page.mouse.move(offset.x+coords.x,offset.y+coords.y);await page.mouse.down();await page.mouse.move(offset.x+coords.right,offset.y+coords.y,{steps:12});await page.mouse.up();
 const selectedQuote=await frame.evaluate(()=>getSelection().toString());assert(selectedQuote.length>0&&'原始首句'.includes(selectedQuote));
 await page.waitForSelector('#selection-menu:not([hidden])');await page.click('#selection-note');await page.waitForSelector('#note-form:not([hidden])');await page.type('#note-input','保留原版本的 Word 批注');await page.click('#add-note');await page.waitForSelector('.word-note-overlay .note-anchor:not([hidden])');
 const notes=(await f.call('annotation.list',{projectId:f.id,relPath:'sample.docx'})).annotations;assert.equal(notes.length,1);const note=notes[0];assert.equal(note.anchor.quote,selectedQuote);f.check('DOCX reading and physical text-selection note preserve the original version');
 const selectText=async text=>{
  const point=await frame.evaluate(text=>{const w=document.createTreeWalker(document.querySelector('#document'),NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const i=n.textContent.indexOf(text);if(i<0)continue;const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+text.length);if(!r.getBoundingClientRect().width)continue;n.parentElement.scrollIntoView({block:'center'});const b=r.getBoundingClientRect();return{x:b.left+1,y:(b.top+b.bottom)/2,right:b.right-1};}throw Error('visible text missing: '+text);},text);
  const b=await page.$eval('#word-host iframe',n=>{const r=n.getBoundingClientRect();return{x:r.left,y:r.top};});await page.mouse.move(b.x+point.x,b.y+point.y);await page.mouse.down();await page.mouse.move(b.x+point.right,b.y+point.y,{steps:10});await page.mouse.up();
  await frame.waitForFunction(text=>{const s=getSelection().toString();return s.length>0&&text.includes(s);},{},text);
 };
 await selectText('未修改标记');await page.keyboard.type('NOZELI_BODY ');await page.keyboard.sendCharacter('中文正文 ');
 await selectText('中文样例');await page.keyboard.type('NOZELI_TABLE ');await page.keyboard.sendCharacter('中文表格 ');await shortcut(page,'s');
 await f.until(async()=>{const z=await JSZip.loadAsync(await fs.readFile(path.join(f.project,'sample.docx')));const xml=await z.file('word/document.xml').async('string');return xml.includes('NOZELI_BODY')&&xml.includes('NOZELI_TABLE');},'body and table saves');
 await page.waitForSelector('.word-authorship .authorship-user');assert.match(await page.$eval('body',n=>n.innerText),/你/);
 const saved=await JSZip.loadAsync(await fs.readFile(path.join(f.project,'sample.docx'))),baseline=await JSZip.loadAsync(original);
 for(const name of ['word/media/image1.png','word/footnotes.xml','word/header1.xml','word/footer1.xml']){assert(saved.file(name),name+' retained');if(name.endsWith('.png'))assert.deepEqual(await saved.file(name).async('nodebuffer'),await baseline.file(name).async('nodebuffer'));}
 const xml=await saved.file('word/document.xml').async('string');assert.match(xml,/<w:tbl[ >]/);assert.match(xml,/中文正文/);assert.match(xml,/中文表格/);f.check('real Chinese keyboard edits in body and table save as DOCX with table, image, header/footer and footnotes retained; authorship visible');
 await f.screenshot(page,'word-edited');await f.close();await f.start();page=await f.open('sample.docx');frame=await frameFor(page);
 const after=await frame.evaluate(()=>{const d=nozeliWordEditor.activeEditor.state.doc;let tables=0;d.descendants(n=>{if(n.type.name==='table')tables++;});return {tables,text:d.textContent};});assert.equal(after.tables,before.tables);assert.match(after.text,/NOZELI_BODY/);assert.match(after.text,/NOZELI_TABLE/);assert.match(after.text,/原始首句/);
 const reopened=(await f.call('annotation.list',{projectId:f.id,relPath:'sample.docx'})).annotations.find(n=>n.id===note.id);assert.equal(reopened.materialDigest,note.materialDigest);assert.deepEqual(reopened.anchor,note.anchor);await page.waitForSelector('#word-notes .note-anchor');assert.match(await page.$eval('#word-notes',n=>n.textContent),/位置待确认/);assert.match(await page.$eval('#word-notes',n=>n.textContent),/保留原版本的 Word 批注/);await f.screenshot(page,'word-cold-reopened');
 f.check('normal exit and cold restart reparse saved body/table; changed quote context is explicitly unresolved, retaining original note anchor/version');assert.equal((await f.call('managed.status',{projectId:f.id})).ready,false);await f.close();await f.finish();
}catch(error){await f.finish(error);process.exitCode=1;}
