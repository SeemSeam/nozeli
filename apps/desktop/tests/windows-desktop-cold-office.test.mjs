import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
import {fixture} from './fixtures/windows-live-surface-host.mjs';
import {encodeRecoveryBytes} from '../src/domain/office-recovery.mjs';

const native={skip:process.platform!=='win32'||process.arch!=='x64'},hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const cases=[['word','docx','office/中文 文档.docx'],['sheet','xlsx','office/中文 表格.xlsx'],['ppt','pptx','ppt/compatibility.pptx'],['pdf','pdf','pdf/nozeli-sample.zh.pdf'],['image','png','tex/pipeline.png']];
async function restart(f){
  await f.host.settled();await f.host.storage.db.close();
  const input=path.join(f.base,'cold-office.json'),output=input+'.output.json';
  await fs.writeFile(input,JSON.stringify({profile:f.profile,projectId:f.source.id,relative:f.surface.relPath,viewId:f.surface.viewId}));
  const child=spawn(process.execPath,[path.join(import.meta.dirname,'fixtures/windows-cold-source-child.mjs'),input,output],{windowsHide:true,env:{...process.env},stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',data=>stderr+=data);
  const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
  const result=JSON.parse(await fs.readFile(output,'utf8'));assert.equal(exit.signal,null);assert.notEqual(result.pid,process.pid);return {...result,exit,stderr};
}
async function setup(t,[kind,extension,file]){
  const f=await fixture(t,'材料.'+extension);f.workspace.buffers.delete(f.key);
  const original=await fs.readFile(path.join(import.meta.dirname,'fixtures',file));await fs.writeFile(path.join(f.a,f.surface.relPath),original);
  return {...f,kind,original};
}
async function remember(f,candidate,generation=1){
  return f.workspace.saveRecovery(f.surface,{projectId:f.source.id,viewId:f.surface.viewId,relPath:f.surface.relPath,generation,kind:f.kind,sourceDigest:hash(f.original),baseDigest:hash(f.original),candidate,workspace:{draft:'Office 未发送备注'}});
}
for(const item of cases)test(item[0]+' whole-process restart reads immutable original binary when the current source name is foreign',native,async t=>{
  const f=await setup(t,item);await f.run('cut');const foreign=Buffer.from('FOREIGN SOURCE WINNER');await fs.writeFile(path.join(f.a,f.surface.relPath),foreign);
  const cold=await restart(f);assert(cold.ok,JSON.stringify(cold.error));assert(cold.held);assert.equal(cold.writeCode,'TRANSFER_HELD');assert.equal(cold.before.kind,f.kind);
  assert.deepEqual(Buffer.from(Object.values(cold.before.bytes)),f.original);assert.deepEqual(Buffer.from(cold.exported.bytes,'base64'),f.original);assert.equal(cold.exported.origin,'retained-source');assert.equal(cold.exported.digest,hash(f.original));
  assert.deepEqual(Buffer.from(Object.values(cold.snapshot.bytes)),f.original);assert.deepEqual(await fs.readFile(path.join(f.a,f.surface.relPath)),foreign);assert.deepEqual(await fs.readFile(path.join(f.b,f.surface.relPath)),f.original);
});
for(const item of cases.slice(0,3))test(item[0]+' retained edited package is validated, displayed, mirrored and exported after independent restart',native,async t=>{
  const f=await setup(t,item);await f.run('cut');
  const zip=await JSZip.loadAsync(f.original);zip.file('nozeli-synthetic-retained.txt','Retained edit 中文');const bytes=await zip.generateAsync({type:'uint8array'});
  const candidate={bytes:encodeRecoveryBytes(bytes),...(f.kind==='ppt'?{model:{slides:[{id:'retained-slide',elements:[{id:'retained-text',type:'text',content:'Retained PPT 中文'}]}]}}:{})};
  await remember(f,candidate);await fs.writeFile(path.join(f.a,f.surface.relPath),'FOREIGN');const live=await f.workspace.readDocument(f.surface,{projectId:f.source.id,relPath:f.surface.relPath});assert.deepEqual(Buffer.from(live.bytes),Buffer.from(bytes));
  const mirror=f.makeSurface(f.surface.relPath);mirror.readOnly=true;await f.workspace.treeRecovery.journal.ensure(mirror);
  const mirrored=await f.workspace.readDocument(mirror,{projectId:f.source.id,relPath:f.surface.relPath});assert.deepEqual(Buffer.from(mirrored.bytes),Buffer.from(bytes));assert(mirrored.treeRecoveryRetained);
  const mirrorSnapshot=await f.workspace.invoke(mirror,'workspace.document.snapshot',{projectId:f.source.id,relPath:f.surface.relPath});assert.deepEqual(Buffer.from(mirrorSnapshot.bytes),Buffer.from(bytes));
  f.workspace.surfaces.delete(mirror.viewId);
  const cold=await restart(f);assert(cold.ok,JSON.stringify(cold.error));assert(cold.held);assert.deepEqual(Buffer.from(Object.values(cold.before.bytes)),Buffer.from(bytes));assert.equal(cold.before.digest,hash(f.original));assert.equal(cold.before.treeRecoveryCandidateDigest,hash(bytes));
  assert.equal(cold.exported.origin,'retained-edit');assert.equal(cold.exported.dirty,true);assert.equal(cold.exported.sourceDigest,hash(f.original));assert.equal(cold.exported.digest,hash(bytes));assert.deepEqual(Buffer.from(cold.exported.bytes,'base64'),Buffer.from(bytes));assert.deepEqual(Buffer.from(Object.values(cold.snapshot.bytes)),Buffer.from(bytes));assert.equal(cold.bootstrap.viewState.workspace.draft,'Office 未发送备注');
  assert.deepEqual(await fs.readFile(path.join(f.b,f.surface.relPath)),f.original);assert.equal(await fs.readFile(path.join(f.a,f.surface.relPath),'utf8'),'FOREIGN');
});
test('complete unsupported sheet snapshot is restored intact and refuses misleading partial XLSX export',native,async t=>{
  const f=await setup(t,cases[1]);await f.run('cut');
  const sheets=[{id:'retained',name:'保留编辑',row:50,column:20,data:[[{v:'Retained cell',bl:1,it:1}],[{v:55,f:'SUM(B2:B3)'}]],config:{merge:{'0_0':{r:0,c:0,rs:1,cs:2}}}}];
  const candidate={sheetSnapshot:encodeRecoveryBytes(Buffer.from(JSON.stringify({schema:'nozeli-sheet-recovery-v1',sheets,original:Array.from(f.original)})))};
  await remember(f,candidate);const cold=await restart(f);assert(cold.ok,JSON.stringify(cold.error));assert(cold.held);assert.deepEqual(cold.before.treeRecoverySheetSnapshot,sheets);assert.deepEqual(cold.snapshot.treeRecoverySheetSnapshot,sheets);assert.equal(cold.exported.error.code,'SHEET_SNAPSHOT_EXPORT_REQUIRED');assert.deepEqual(cold.before.treeRecoverySnapshot.candidate,candidate);assert.deepEqual(await fs.readFile(path.join(f.b,f.surface.relPath)),f.original);
});
test('a corrupt host-bound Office candidate is refused before any fallback to the foreign current source',native,async t=>{
  const f=await setup(t,cases[0]);await f.run('cut');await remember(f,{bytes:encodeRecoveryBytes(f.original)});
  const key='workspace:'+f.surface.viewId,row=await f.host.storage.readRecoveryRecord(f.source.id,key);
  await f.host.storage.putRecovery(f.source.id,key,{...row.value,candidate:{bytes:encodeRecoveryBytes(Buffer.from('invalid DOCX'))}},{expectedRevision:row.revision});await fs.writeFile(path.join(f.a,f.surface.relPath),'FOREIGN');
  const cold=await restart(f);assert.equal(cold.ok,false);assert(cold.held);assert.equal(await fs.readFile(path.join(f.a,f.surface.relPath),'utf8'),'FOREIGN');assert.deepEqual(await fs.readFile(path.join(f.b,f.surface.relPath)),f.original);
});
