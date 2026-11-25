import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import JSZip from 'jszip';
import {DesktopHost} from '../src/main/host.mjs';
import {wordText} from '../src/main/word-anchors.mjs';
import {digestBytes} from '../src/domain/material-store.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {createExperimentalWindowsPersistence} from '../src/platform/windows/experimental-persistence.mjs';
import {security} from './fixtures/windows-security.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
const fixtures=path.join(import.meta.dirname,'fixtures');
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-office-native-')),profile=path.join(base,'profile'),root=path.join(base,'项目 空格'),hosts=[];await ensureExperimentalPrivateDirectory(base,profile);await fs.mkdir(root);
 t.after(async()=>{for(const host of hosts)await host.storage.db.close();await fs.rm(base,{recursive:true,force:true});});
 const make=()=>{const h=new DesktopHost(profile);hosts.push(h);return h;},host=make(),project=(await host.pick(root)).project;
 return {base,profile,root,host,project,make};
}
function independentWrite(file,bytes){const child=spawnSync(process.execPath,['-e',"const fs=require('node:fs');fs.writeFileSync(process.argv[1],fs.readFileSync(0))",file],{input:bytes,env:{...process.env,...(process.versions.electron?{ELECTRON_RUN_AS_NODE:'1'}:{})},encoding:'utf8',windowsHide:true,timeout:10000});assert.ifError(child.error);assert.equal(child.status,0,child.stderr);assert.equal(child.signal,null);}
async function edit(bytes,kind,label){const zip=await JSZip.loadAsync(bytes),name=kind==='word'?'word/document.xml':'xl/worksheets/sheet1.xml',text=kind==='word'?'原始首句':'原始单元格',xml=await zip.file(name).async('string'),old=xml.includes(text)?text:[...text].map(char=>'&#'+char.codePointAt(0)+';').join('');assert(xml.includes(old));zip.file(name,xml.replace(old,label));return zip.generateAsync({type:'nodebuffer'});}
for(const [kind,extension,filename]of [['word','docx','中文 文档.docx'],['sheet','xlsx','中文 表格.xlsx']]){
 const save=(f,digest,bytes)=>kind==='word'?f.host.saveWord(f.project.id,'document.'+extension,digest,bytes):f.host.saveSheet(f.project.id,'document.'+extension,digest,bytes);
 async function setup(t){const f=await fixture(t);f.original=await fs.readFile(path.join(fixtures,'office',filename));f.file=path.join(f.root,'document.'+extension);await fs.writeFile(f.file,f.original);f.read=await f.host.readFile(f.project.id,'document.'+extension);f.candidate=await edit(f.original,kind,'Native edited 中文');return f;}
 test(kind+' native Office read/save, ACL preservation, immutable original/candidate recovery and cold host reopen',native,async t=>{
  const f=await setup(t),acl=security('inspect',f.file),result=await save(f,f.read.digest,f.candidate);assert.equal(result.digest,digestBytes(f.candidate));assert.deepEqual(await fs.readFile(f.file),f.candidate);assert.deepEqual(await fs.readFile(result.recoveryPath),f.candidate);assert.deepEqual(await f.host.storage.readRecoveryObject(f.project.id,f.read.digest),f.original);
  const after=security('inspect',f.file);for(const key of ['owner','group','protected','rules'])assert.deepEqual(after[key],acl[key]);await f.host.storage.db.close();const cold=f.make(),reopened=await cold.readFile(f.project.id,'document.'+extension);assert.deepEqual(reopened.bytes,f.candidate);assert.equal(reopened.digest,result.digest);if(kind==='word'){assert(reopened.authorship);assert((await wordText(reopened.bytes)).includes('Native edited 中文'));}
 });
 test(kind+' independent external source writer and deleted source retain exact exported recovery bytes',native,async t=>{
  const f=await setup(t),winner=await edit(f.original,kind,'External winner 中文');independentWrite(f.file,winner);let conflict;await assert.rejects(save(f,f.read.digest,f.candidate),error=>{conflict=error;return error.code==='CONFLICT';});assert.deepEqual(await fs.readFile(conflict.details.recoveryPath),f.candidate);assert.deepEqual(await fs.readFile(f.file),winner);
  await fs.unlink(f.file);await assert.rejects(save(f,f.read.digest,f.candidate),error=>error.code==='DELETED'&&Boolean(error.details.recoveryPath));await assert.rejects(fs.stat(f.file),{code:'ENOENT'});await f.host.storage.db.close();const cold=f.make();assert.deepEqual(await cold.storage.readRecoveryObject(f.project.id,digestBytes(f.candidate)),f.candidate);
 });
 test(kind+' late external writer after shared validation loses no bytes to native source digest CAS',native,async t=>{
  const f=await setup(t),replace=f.host.replaceFile.bind(f.host),winner=await edit(f.original,kind,'Late independent winner');f.host.replaceFile=(abs,bytes,options)=>replace(abs,bytes,{...options,beforeCommit:async()=>{await options.beforeCommit();independentWrite(abs,winner);}});
  await assert.rejects(save(f,f.read.digest,f.candidate),error=>error.code==='FS_VERSION_CONFLICT'&&Boolean(error.details.recoveryPath));assert.deepEqual(await fs.readFile(f.file),winner);assert.deepEqual(await f.host.storage.readRecoveryObject(f.project.id,digestBytes(f.candidate)),f.candidate);
 });
 test(kind+' genuine native post-publication barrier failure survives Office and IPC details without replay',native,async t=>{
  const f=await setup(t);let calls=0;
  f.host.replaceFile=async(abs,bytes,options)=>{calls++;await options.beforeCommit();const root=f.host.storage.nativeRootForPath(abs);return createExperimentalWindowsPersistence(root,{directorySync:parent=>{parent.close();parent.syncDirectory();}}).writeStream(path.relative(root,abs).split(path.sep).join('/'),[bytes],{expectedSha256:options.expectedSha256,expectedNewSha256:digestBytes(bytes)});};
  await assert.rejects(save(f,f.read.digest,f.candidate),error=>error.code==='FS_HANDLE_CLOSED'&&error.committed===true&&error.durability==='uncertain'&&error.details.committed===true&&error.details.durability==='uncertain'&&error.message.includes('已发布')&&Boolean(error.details.recoveryPath));assert.equal(calls,1);assert.deepEqual(await fs.readFile(f.file),f.candidate);assert.deepEqual(await f.host.storage.readRecoveryObject(f.project.id,digestBytes(f.candidate)),f.candidate);await f.host.storage.db.close();const cold=f.make(),reopened=await cold.readFile(f.project.id,'document.'+extension);assert.deepEqual(reopened.bytes,f.candidate);if(kind==='word')assert.equal(reopened.authorshipError,null);
 });
}
test('readonly Word source reports READONLY, retains the exported draft and leaves the original untouched',native,async t=>{
 const f=await fixture(t),original=await fs.readFile(path.join(fixtures,'office','中文 文档.docx')),file=path.join(f.root,'document.docx');await fs.writeFile(file,original);
 const read=await f.host.readFile(f.project.id,'document.docx'),candidate=await edit(original,'word','Readonly edited 中文');await fs.chmod(file,0o444);
 try{
  let failure;await assert.rejects(f.host.saveWord(f.project.id,'document.docx',read.digest,candidate),error=>{failure=error;return error.code==='READONLY'&&Boolean(error.details.recoveryPath);});
  assert.deepEqual(await fs.readFile(failure.details.recoveryPath),candidate);
  assert.deepEqual(await f.host.storage.readRecoveryObject(f.project.id,digestBytes(candidate)),candidate);
  assert.deepEqual(await fs.readFile(file),original);
  await fs.chmod(file,0o666);
  const saved=await f.host.saveWord(f.project.id,'document.docx',read.digest,candidate);
  assert.deepEqual(await fs.readFile(file),candidate);assert.deepEqual(await fs.readFile(saved.recoveryPath),candidate);
 }finally{await fs.chmod(file,0o666).catch(()=>{});}
});
test('legacy DOC actual OLE parsing publishes native DOCX copies and collision suffixes without changing original',native,async t=>{
 const f=await fixture(t),original=await fs.readFile(path.join(fixtures,'legacy-word/test01.doc')),file=path.join(f.root,'旧版.doc');await fs.writeFile(file,original);const read=await f.host.readFile(f.project.id,'旧版.doc'),one=await f.host.importDoc(f.project.id,{relPath:'旧版.doc',digest:read.digest});assert.equal(one.mode,'body-only');assert((await wordText(await fs.readFile(path.join(f.root,one.relPath)))).trim());assert.deepEqual(await fs.readFile(one.recoveryPath),await fs.readFile(path.join(f.root,one.relPath)));const two=await f.host.importDoc(f.project.id,{relPath:'旧版.doc',digest:read.digest});assert.notEqual(two.relPath,one.relPath);assert.deepEqual(await fs.readFile(file),original);await f.host.storage.db.close();assert.equal((await f.make().readFile(f.project.id,one.relPath)).kind,'word');
});
test('DOC import create-only publication retains a late name winner and retries only a provably uncommitted collision',native,async t=>{
 const f=await fixture(t),bytes=await fs.readFile(path.join(fixtures,'office/中文 文档.docx'));await fs.writeFile(path.join(f.root,'renamed.doc'),bytes);const read=await f.host.readFile(f.project.id,'renamed.doc'),replace=f.host.replaceFile.bind(f.host);let calls=0;f.host.replaceFile=(abs,payload,options)=>replace(abs,payload,{...options,beforeCommit:async()=>{await options.beforeCommit();if(++calls===1)independentWrite(abs,Buffer.from('late target winner'));}});
 const result=await f.host.importDoc(f.project.id,{relPath:'renamed.doc',digest:read.digest});assert.equal(result.mode,'docx-copy');assert.equal(calls,2);assert.equal(await fs.readFile(path.join(f.root,'renamed.导入.docx'),'utf8'),'late target winner');assert.deepEqual(await fs.readFile(path.join(f.root,result.relPath)),bytes);assert.deepEqual(await fs.readFile(path.join(f.root,'renamed.doc')),bytes);
});
test('DOC import native post-publication uncertainty records exact candidate path and never allocates a second suffix',native,async t=>{
 const f=await fixture(t),bytes=await fs.readFile(path.join(fixtures,'office/中文 文档.docx'));await fs.writeFile(path.join(f.root,'renamed.doc'),bytes);const read=await f.host.readFile(f.project.id,'renamed.doc');let calls=0;f.host.replaceFile=async(abs,payload,options)=>{calls++;await options.beforeCommit();const root=f.host.storage.nativeRootForPath(abs);return createExperimentalWindowsPersistence(root,{directorySync:parent=>{parent.close();parent.syncDirectory();}}).writeStream(path.relative(root,abs).split(path.sep).join('/'),[payload],{expectedSha256:null});};
 await assert.rejects(f.host.importDoc(f.project.id,{relPath:'renamed.doc',digest:read.digest}),error=>error.committed===true&&error.details.committed===true&&error.details.relPath==='renamed.导入.docx'&&Boolean(error.details.recoveryPath));assert.equal(calls,1);assert.deepEqual(await fs.readFile(path.join(f.root,'renamed.导入.docx')),bytes);assert.deepEqual((await fs.readdir(f.root)).filter(name=>name.endsWith('.docx')),['renamed.导入.docx']);
});
