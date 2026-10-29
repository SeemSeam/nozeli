import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {nativeFixture} from './desktop-native.fixture.mjs';
import {contentToolForPage} from './native-content-tools.fixture.mjs';
const files={'plain.txt':'Alpha 中文\nSecond line\n','read.md':'# Alpha 中文\n\nMarkdown **preview**.\n','code.ts':'const alpha = 1;\n// 中文\n','paper.tex':'\\section{Alpha}\n中文正文\n','refs.bib':'@article{alpha,\n  title={中文标题},\n  year={2026}\n}\n'};
const f=await nativeFixture('native-text',files),saved=new Map(),notes=new Map();
const shortcut=async(p,key,shift=false)=>{await p.keyboard.down(process.platform==='darwin'?'Meta':'Control');if(shift)await p.keyboard.down('Shift');await p.keyboard.press(key);if(shift)await p.keyboard.up('Shift');await p.keyboard.up(process.platform==='darwin'?'Meta':'Control');};
try{
 await f.start();
 for(const [rel,source]of Object.entries(files).filter(([rel])=>!process.env.NOZELI_FORMAT||rel===process.env.NOZELI_FORMAT)){
  const p=await f.open(rel);await p.waitForFunction(()=>window.__nozeliInput?.text().length>0);assert.equal(await p.evaluate(()=>__nozeliInput.text()),source);assert.equal(await fs.readFile(path.join(f.project,rel),'utf8'),source);
  if(rel.endsWith('.md')){await p.waitForSelector('#text-preview:not([hidden])');assert.match(await p.$eval('#text-preview',n=>n.textContent),/Markdown preview/);await contentToolForPage(p,['view','text-mode']);}
  await p.evaluate(()=>{__nozeliInput.focus();const n=__nozeliInput.text().length;__nozeliInput.select(n,n);});
  await p.keyboard.sendCharacter('中文编辑 '+rel);let edited=await p.evaluate(()=>__nozeliInput.text());assert.equal(edited,source+'中文编辑 '+rel);
  let undoSteps=0;
  while(await p.evaluate(()=>__nozeliInput.text())!==source&&undoSteps<10){const previous=await p.evaluate(()=>__nozeliInput.text());await shortcut(p,'z');await p.waitForFunction(previous=>__nozeliInput.text()!==previous,{},previous);undoSteps++;}
  assert.equal(await p.evaluate(()=>__nozeliInput.text()),source);
  for(let i=0;i<undoSteps;i++){const previous=await p.evaluate(()=>__nozeliInput.text());await shortcut(p,'z',true);await p.waitForFunction(previous=>__nozeliInput.text()!==previous,{},previous);}assert.equal(await p.evaluate(()=>__nozeliInput.text()),edited);
  await shortcut(p,'s');await f.until(async()=>await fs.readFile(path.join(f.project,rel),'utf8')===edited,'save '+rel);saved.set(rel,edited);
  await p.evaluate(()=>{__nozeliInput.focus();__nozeliInput.select(0,5);});await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await p.keyboard.down('Shift');await p.keyboard.press('F10');await p.keyboard.up('Shift');await p.locator('#document-context-menu:not([hidden]) [data-command="note-here"]').click();
  await p.waitForSelector('#note-form:not([hidden])');await p.type('#note-input','本地选区备注 '+rel);await p.click('#add-note');
  const note=await f.until(async()=>{const list=await f.call('annotation.list',{projectId:f.id,relPath:rel});return list.annotations.find(n=>n.note==='本地选区备注 '+rel);},'selection note '+rel);assert.equal(note.anchor.quote,edited.slice(0,5));notes.set(rel,note);
  assert.equal((await f.call('managed.status',{projectId:f.id})).ready,false);await f.screenshot(p,rel.replace('.','-'));f.check(rel+': reading, selection note, Chinese keyboard edit, undo/redo and explicit save');
 }
 await f.close();await f.start();
 for(const [rel,edited]of saved){const p=await f.open(rel);await p.waitForFunction(text=>__nozeliInput.text()===text,{},edited);const current=(await f.call('annotation.list',{projectId:f.id,relPath:rel})).annotations.find(n=>n.id===notes.get(rel).id);assert.equal(current.materialDigest,notes.get(rel).materialDigest);assert.deepEqual(current.anchor,notes.get(rel).anchor);}
 f.check('cold restart reopens every text format with exact Chinese/newline content and original note versions');
 const p=await f.open('plain.txt');await p.evaluate(()=>{__nozeliInput.focus();const n=__nozeliInput.text().length;__nozeliInput.select(n,n);});await p.keyboard.sendCharacter(' UNSAVED_CONFLICT');const candidate=await p.evaluate(()=>__nozeliInput.text());await fs.writeFile(path.join(f.project,'plain.txt'),'EXTERNAL_CHANGE\n');await shortcut(p,'s');await p.waitForFunction(()=>!document.querySelector('#save-failure').hidden);assert.equal(await fs.readFile(path.join(f.project,'plain.txt'),'utf8'),'EXTERNAL_CHANGE\n');assert.equal(await p.evaluate(()=>__nozeliInput.text()),candidate);f.check('external change produces explicit conflict and retains the unsaved editor candidate plus external source');await f.screenshot(p,'text-conflict');
 await f.close();await f.finish();
}catch(error){await f.finish(error);process.exitCode=1;}
