import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {DesktopHost} from '../src/main/host.mjs';
import {FileChanges} from '../src/domain/file-changes.mjs';
import {wordText} from '../src/main/word-anchors.mjs';
import {textChangeSet} from '../src/domain/tag-anchors.mjs';

const original=await fs.readFile(new URL('./fixtures/office/中文 文档.docx',import.meta.url));
test('native view preference survives process/origin changes and protects damaged metadata without touching Word',()=>fixture(async({host,state,source})=>{
 assert.deepEqual(await host.viewAuthorship(),{visible:true});await host.viewAuthorship(false);assert.deepEqual(await new DesktopHost(state).viewAuthorship(),{visible:false});assert.deepEqual(await fs.readFile(source),original);
 const preference=path.join(state,'nozeli','settings','view-preferences.json');await fs.writeFile(preference,'{damaged');await assert.rejects(host.viewAuthorship(true),error=>error.code==='METADATA_CORRUPT');assert.equal(await fs.readFile(preference,'utf8'),'{damaged');
}));
async function changed(bytes,change){const zip=await JSZip.loadAsync(bytes);zip.file('word/document.xml',change(await zip.file('word/document.xml').async('string')),{createFolders:false});return zip.generateAsync({type:'nodebuffer'});}
async function fixture(run){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-word-authors-')),root=path.join(dir,'project'),state=path.join(dir,'state');await fs.mkdir(root);await fs.writeFile(path.join(root,'sample.docx'),original);
 const host=new DesktopHost(state),projectId=(await host.pick(root)).project.id;
 try{await run({host,root,state,projectId,store:new FileChanges({storage:host.storage,projectId,root}),source:path.join(root,'sample.docx')});}finally{await host.storage.db.close().catch(()=>{});await fs.rm(dir,{recursive:true,force:true});}
}

test('Word baseline is unknown; precise user edits, original package and independent ledger survive host restart',()=>fixture(async({host,root,state,projectId,store,source})=>{
 const first=await host.readFile(projectId,'sample.docx');assert.equal(first.authorship.eventCount,0);assert.deepEqual(first.authorship.spans,[]);assert.equal((await store.read('sample.docx')).textSpace,'docx-main-text');assert.deepEqual(await fs.readFile(source),original);
 const next=await changed(original,xml=>xml.replace('原始首句','用户正文修改😀'));
 const text=await wordText(next),mapping=textChangeSet(first.authorshipText,text).toJSON();
 const saved=await host.saveWord(projectId,'sample.docx',first.digest,next,{anchorChanges:mapping});assert.equal(saved.authorship.spans.length,1);assert.equal(saved.authorship.lastChange.actor.kind,'user');assert.equal(saved.authorshipText,text);
 const event=(await host.documentHistory(projectId,'sample.docx')).events[0];assert.equal(event.type,'word-text');assert.equal(event.edits[0].removed,'原始首句');assert.equal(event.edits[0].insert,'用户正文修改😀');assert(Number.isFinite(Date.parse(event.time)));
 const reopened=await new DesktopHost(state).readFile(projectId,'sample.docx');assert.deepEqual(reopened.authorship,saved.authorship);assert.deepEqual(reopened.bytes,next);
 const beforeZip=await JSZip.loadAsync(original),afterZip=await JSZip.loadAsync(next);assert.deepEqual(Object.keys(afterZip.files).sort(),Object.keys(beforeZip.files).sort());for(const file of Object.keys(beforeZip.files))if(file!=='word/document.xml'&&!beforeZip.files[file].dir)assert.deepEqual(await afterZip.file(file).async('nodebuffer'),await beforeZip.file(file).async('nodebuffer'));
 assert.equal((await store.all()).length,1);const ledger=await host.storage.getProjectRecord(projectId,'file_changes',store.keys.key('sample.docx'));assert.match(store.keys.key('sample.docx'),/^[a-f0-9]{64}$/);assert.equal(ledger.value.relPath,'sample.docx');assert.ok(Number.isSafeInteger(ledger.revision)&&ledger.revision>=1);
}));

test('Word formatting creates a batch without claiming the text; identical saves do not invent a revision',()=>fixture(async({host,projectId,store})=>{
 let file=await host.readFile(projectId,'sample.docx');let bytes=await changed(original,xml=>xml.replace('原始首句','你写的新句'));
 await host.saveWord(projectId,'sample.docx',file.digest,bytes);file=await host.readFile(projectId,'sample.docx');const old=file.authorship.spans;
 bytes=await changed(bytes,xml=>xml.replace('<w:r><w:t>','<w:r><w:rPr><w:b/></w:rPr><w:t>'));
 const saved=await host.saveWord(projectId,'sample.docx',file.digest,bytes);assert.deepEqual(saved.authorship.spans,old);const history=await store.read('sample.docx');assert.equal(history.events.at(-1).type,'word-format');assert.deepEqual(history.events.at(-1).edits,[]);
 const duplicate=await host.saveWord(projectId,'sample.docx',saved.digest,bytes);assert.equal(duplicate.authorship.revision,saved.authorship.revision);
}));

test('external DOCX edits are unknown external changes; version-bound group pagination rejects stale positions',()=>fixture(async({host,projectId,source})=>{
 const first=await host.readFile(projectId,'sample.docx'),bytes=await changed(original,xml=>xml.replace('原始首句','由外部修改'));
 await fs.writeFile(source,bytes);const result=await host.documentStatus(projectId,'sample.docx');assert.equal(result.authorship.lastChange.actor.kind,'external');assert.equal(result.authorship.spans[0].actor.kind,'external');
 await assert.rejects(host.documentHistory(projectId,'sample.docx',{scope:{docId:first.authorship.docId,revision:0,digest:first.digest,from:0,to:10,kind:'text',actorIds:['user:local']}}),error=>error.code==='STALE_HISTORY');
 const events=(await host.documentHistory(projectId,'sample.docx')).events;assert.equal(events[0].actor.id,'external:unknown');assert.equal(events[0].edits[0].insert,'由外部修改');
}));

test('conflicting Word saves retain disk, authorship and the full exported recovery package',()=>fixture(async({host,projectId,source,store})=>{
 const first=await host.readFile(projectId,'sample.docx'),disk=await changed(original,xml=>xml.replace('原始首句','外部磁盘内容')),mine=await changed(original,xml=>xml.replace('原始首句','尚未保存的用户草稿'));
 await fs.writeFile(source,disk);let error;try{await host.saveWord(projectId,'sample.docx',first.digest,mine);}catch(e){error=e;}assert.equal(error.code,'CONFLICT');assert.deepEqual(await fs.readFile(error.details.recoveryPath),mine);assert.deepEqual(await fs.readFile(source),disk);assert.equal((await store.read('sample.docx')).revision,0);
 const reopened=await host.readFile(projectId,'sample.docx');assert.equal(reopened.authorship.lastChange.actor.kind,'external');
}));

test('damaged or unsupported Word history blocks overwrite while preserving both records and exported package',()=>fixture(async({host,projectId,store,source})=>{
 const first=await host.readFile(projectId,'sample.docx'),mine=await changed(original,xml=>xml.replace('原始首句','用户候选'));
 const key=store.keys.key('sample.docx'),pristine=await store.read('sample.docx');
 for(const damaged of [{...pristine,events:null},{...pristine,schemaVersion:200}]){
  await host.storage.putProject(projectId,'file_changes',key,damaged);let error;try{await host.saveWord(projectId,'sample.docx',first.digest,mine);}catch(e){error=e;}assert(['CHANGE_HISTORY_CORRUPT','SCHEMA_UNSUPPORTED'].includes(error.code));assert.deepEqual(await fs.readFile(source),original);assert.deepEqual((await host.storage.getProjectRecord(projectId,'file_changes',key)).value,damaged);assert.deepEqual(await fs.readFile(error.details.recoveryPath),mine);
  if(damaged.events===null)await host.storage.putProject(projectId,'file_changes',key,pristine);
 }
}));

test('Word prepared transaction recovers actual replacement and never attributes a failed replacement',()=>fixture(async({host,projectId,store,source,state})=>{
 const first=await host.readFile(projectId,'sample.docx'),mine=await changed(original,xml=>xml.replace('原始首句','崩溃前候选'));
 const replace=host.replaceFile.bind(host);host.replaceFile=async()=>{throw Error('injected before replacement');};await assert.rejects(host.saveWord(projectId,'sample.docx',first.digest,mine));assert((await store.read('sample.docx')).pending);assert.deepEqual(await fs.readFile(source),original);
 const unchanged=await host.readFile(projectId,'sample.docx');assert.equal(unchanged.authorship.revision,0);assert.equal((await store.read('sample.docx')).attempts[0].outcome,'not-written');
 host.replaceFile=async(...args)=>{await replace(...args);throw Error('injected after actual replacement');};await assert.rejects(host.saveWord(projectId,'sample.docx',first.digest,mine));assert.deepEqual(await fs.readFile(source),mine);assert((await store.read('sample.docx')).pending);
 const recovered=await new DesktopHost(state).readFile(projectId,'sample.docx');assert.equal(recovered.authorship.revision,1);assert.equal(recovered.authorship.lastChange.actor.kind,'user');assert.equal((await store.read('sample.docx')).pending,null);
}));

test('invalid precise Word mapping refuses source overwrite and retains the exported candidate',()=>fixture(async({host,projectId,source})=>{
 const first=await host.readFile(projectId,'sample.docx'),mine=await changed(original,xml=>xml.replace('原始首句','用户候选'));
 let error;try{await host.saveWord(projectId,'sample.docx',first.digest,mine,{anchorChanges:textChangeSet(first.authorshipText,first.authorshipText).toJSON()});}catch(e){error=e;}
 assert.match(error.message,/mapping/);assert.deepEqual(await fs.readFile(source),original);assert.deepEqual(await fs.readFile(error.details.recoveryPath),mine);
}));

test('canonical Word body includes tables, tabs and line breaks while excluding nested text boxes',async()=>{
 const bytes=await changed(original,xml=>xml.replace('原始首句','甲</w:t><w:tab/><w:t>乙</w:t><w:br/><w:t>丙').replace('</w:body>','<w:p><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>独立文本框</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p></w:body>'));
 const body=await wordText(bytes);assert.match(body,/甲\t乙\n丙/);assert.match(body,/项目\n数值\n中文样例\n42/);assert.doesNotMatch(body,/独立文本框/);
});
