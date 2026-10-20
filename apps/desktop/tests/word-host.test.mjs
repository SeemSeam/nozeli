import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {DesktopHost} from '../src/main/host.mjs';
test('DOCX real package read/save/reopen, baseline recovery, conflict and invalid bytes',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-word-'));const root=path.join(dir,'project');await fs.mkdir(root);const host=new DesktopHost(path.join(dir,'state'));
 try{const original=await fs.readFile(new URL('./fixtures/office/中文 文档.docx',import.meta.url));await fs.writeFile(path.join(root,'test.docx'),original);const {project}=await host.pick(root);const file=await host.readFile(project.id,'test.docx');assert.equal(file.kind,'word');assert.deepEqual(file.bytes,original);
 const zip=await JSZip.loadAsync(original);zip.file('word/document.xml',(await zip.file('word/document.xml').async('string')).replace('原始首句','修改首句'));const bytes=await zip.generateAsync({type:'nodebuffer'});const saved=await host.saveWord(project.id,'test.docx',file.digest,bytes);assert.deepEqual((await host.readFile(project.id,'test.docx')).bytes,bytes);assert.deepEqual(await fs.readFile(saved.recoveryPath),bytes);
 await assert.rejects(host.saveWord(project.id,'test.docx',file.digest,original),e=>e.code==='CONFLICT');assert.deepEqual(await fs.readFile(path.join(root,'test.docx')),bytes);
 await assert.rejects(host.saveWord(project.id,'test.docx',saved.digest,Buffer.from('bad')));assert.deepEqual(await fs.readFile(path.join(root,'test.docx')),bytes);
 const backups=await fs.readdir(path.dirname(saved.recoveryPath));assert.equal(backups.length,2);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('Word sidecar validates frozen quote, survives unrelated edits, preserves ambiguous/deleted anchors',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-word-tags-')),root=path.join(dir,'project');await fs.mkdir(root);const host=new DesktopHost(path.join(dir,'state'));
 try{
  const bytes=await fs.readFile(new URL('./fixtures/office/中文 文档.docx',import.meta.url));await fs.writeFile(path.join(root,'test.docx'),bytes);const {project}=await host.pick(root),file=await host.readFile(project.id,'test.docx');
  const anchor={space:'docx-main-text',quote:'原始首句',prefix:'',suffix:''};
  await host.addAnnotation(project.id,{relPath:'test.docx',materialDigest:file.digest,kind:'word-selection',anchor,note:'**独立备注**'});
  await assert.rejects(host.addAnnotation(project.id,{relPath:'test.docx',materialDigest:file.digest,kind:'word-selection',anchor:{...anchor,quote:'不在原文中'},note:'invalid'}));
  let zip=await JSZip.loadAsync(bytes);const xml=await zip.file('word/document.xml').async('string');zip.file('word/document.xml',xml.replace('第二页','另一个页面'));await host.saveWord(project.id,'test.docx',file.digest,await zip.generateAsync({type:'nodebuffer'}));
  let notes=(await host.listAnnotations(project.id,'test.docx')).annotations;assert.equal(notes.length,1);assert.equal(notes[0].resolution.locationStatus,'exact');assert.equal(notes[0].note,'**独立备注**');
  const current=await host.readFile(project.id,'test.docx');zip=await JSZip.loadAsync(current.bytes);zip.file('word/document.xml',xml.replace('原始首句','原始首句 原始首句'));await host.saveWord(project.id,'test.docx',current.digest,await zip.generateAsync({type:'nodebuffer'}));
  notes=(await host.listAnnotations(project.id,'test.docx')).annotations;assert.equal(notes[0].resolution.anchor,null);assert.equal(notes[0].resolution.method,'ambiguous-word-quote');
  const current2=await host.readFile(project.id,'test.docx');zip.file('word/document.xml',xml.replace('原始首句','已删改'));await host.saveWord(project.id,'test.docx',current2.digest,await zip.generateAsync({type:'nodebuffer'}));notes=(await host.listAnnotations(project.id,'test.docx')).annotations;assert.equal(notes[0].resolution.method,'missing-word-quote');assert.equal(notes[0].anchor.quote,'原始首句');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('Word region retains normalized bounds and requires confirmation after document changes',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-word-region-')),root=path.join(dir,'project');await fs.mkdir(root);const host=new DesktopHost(path.join(dir,'state'));
 try{
  const bytes=await fs.readFile(new URL('./fixtures/office/中文 文档.docx',import.meta.url));await fs.writeFile(path.join(root,'test.docx'),bytes);const {project}=await host.pick(root),file=await host.readFile(project.id,'test.docx');
  const anchor={space:'docx-rendered-page-normalized',page:1,rotation:0,rects:[[.1,.2,.3,.1]],quote:''};
  const input={relPath:'test.docx',materialDigest:file.digest,kind:'word-region',anchor,note:'区域备注'};
  await host.addAnnotation(project.id,input);
  assert.deepEqual((await host.listAnnotations(project.id,'test.docx')).annotations[0].resolution.anchor,anchor);
  await assert.rejects(host.addAnnotation(project.id,{...input,anchor:{...anchor,rects:[[.9,.2,.3,.1]]}}));
  const zip=await JSZip.loadAsync(bytes);zip.file('word/document.xml',(await zip.file('word/document.xml').async('string')).replace('原始首句','修改首句'));await host.saveWord(project.id,'test.docx',file.digest,await zip.generateAsync({type:'nodebuffer'}));
  const note=(await host.listAnnotations(project.id,'test.docx')).annotations[0];assert.equal(note.resolution.anchor,null);assert.deepEqual(note.anchor,anchor);assert.equal(note.note,'区域备注');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
