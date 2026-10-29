import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import {nativeFixture,appRoot} from './desktop-native.fixture.mjs';
const zip=await JSZip.loadAsync(await fs.readFile(path.join(appRoot,'tests/fixtures/office/中文 表格.xlsx')));
zip.file('customXml/nozeli-unknown.xml','<synthetic keep="unchanged">unknown package part</synthetic>');const original=await zip.generateAsync({type:'nodebuffer'});
const f=await nativeFixture('native-sheet',{'sample.xlsx':original});
const shortcut=async(p,key)=>{await p.keyboard.down(process.platform==='darwin'?'Meta':'Control');await p.keyboard.press(key);await p.keyboard.up(process.platform==='darwin'?'Meta':'Control');};
async function frameFor(p){await p.waitForFunction(()=>document.querySelector('#word-host iframe')?.contentWindow?.nozeliSheetEditor,{timeout:45000});return p.frames().find(frame=>frame.url().endsWith('/sheet-frame.html'));}
async function edit(p,frame,r,c,value){
 await frame.click('canvas',{offset:{x:c===0?80:155,y:r===0?30:50}});await frame.click('canvas',{offset:{x:c===0?80:155,y:r===0?30:50}});
 await frame.waitForFunction(({r,c})=>nozeliSheetEditor.getSelection()?.[0]?.row[0]===r&&nozeliSheetEditor.getSelection()?.[0]?.column[0]===c,{}, {r,c});
 await frame.click('canvas',{button:'right',offset:{x:c===0?80:155,y:r===0?30:50}});
 await frame.waitForSelector('#sheet-context-menu:not([hidden]) [data-command="formula"]',{visible:true});await frame.click('#sheet-context-menu [data-command="formula"]');
 await p.keyboard.sendCharacter(value);await p.keyboard.press('Enter');
 await frame.waitForFunction(({r,c,value})=>String(nozeliSheetEditor.getCellValue(r,c))===value,{}, {r,c,value});
}
try{
 await f.start();let page=await f.open('sample.xlsx'),frame=await frameFor(page);
 assert.deepEqual(await fs.readFile(path.join(f.project,'sample.xlsx')),original);assert.equal(await frame.evaluate(()=>nozeliSheetEditor.getCellValue(0,0)),'原始单元格');
 await edit(page,frame,0,0,'中文单元格');await edit(page,frame,1,1,'35');await shortcut(page,'s');
 await f.until(async()=>{const z=await JSZip.loadAsync(await fs.readFile(path.join(f.project,'sample.xlsx')));return (await z.file('xl/worksheets/sheet1.xml').async('string')).includes('中文单元格');},'XLSX explicit save');
 const saved=await JSZip.loadAsync(await fs.readFile(path.join(f.project,'sample.xlsx')));
 for(const name of ['xl/charts/chart1.xml','xl/drawings/drawing1.xml','xl/drawings/_rels/drawing1.xml.rels','customXml/nozeli-unknown.xml'])assert.deepEqual(await saved.file(name).async('nodebuffer'),await zip.file(name).async('nodebuffer'),name+' retained byte-for-byte');
 f.check('XLSX opens without rewriting; real formula-editor keyboard changes save, preserving chart/drawing and unknown OOXML parts');await f.screenshot(page,'sheet-saved');await f.close();await f.start();page=await f.open('sample.xlsx');frame=await frameFor(page);
 assert.equal(await frame.evaluate(()=>nozeliSheetEditor.getCellValue(0,0)),'中文单元格');assert.equal(await frame.evaluate(()=>Number(nozeliSheetEditor.getCellValue(1,1))),35);assert.equal(await frame.evaluate(()=>nozeliSheetEditor.getCellValue(2,0)),'乙');
 f.check('cold restart retains saved cells and untouched neighboring values');await f.screenshot(page,'sheet-cold-reopened');
 const beforeFailure=await fs.readFile(path.join(f.project,'sample.xlsx'));await frame.evaluate(()=>nozeliSheetEditor.setCellFormat(1,0,'bl',1));await page.waitForFunction(()=>!document.querySelector('#save-failure').hidden,{timeout:15000});assert.deepEqual(await fs.readFile(path.join(f.project,'sample.xlsx')),beforeFailure);await frame.evaluate(()=>nozeliSheetEditor.handleUndo());await page.waitForFunction(()=>document.querySelector('#save-failure').hidden,{timeout:15000});f.check('unsupported formatting produces explicit save failure without changing source; undo restores saving');
 assert.equal((await f.call('managed.status',{projectId:f.id})).ready,false);await f.close();await f.finish();
}catch(error){await f.finish(error);process.exitCode=1;}
