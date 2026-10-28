import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {captureTextCopy,verifiedTextCopy} from '../src/renderer/document-export.mjs';
import {documentCommands,documentMoreCommands} from '../src/renderer/document-context-menu.mjs';

const source={type:'review',workId:'work-a',objectId:'report-a'};
test('exports the clicked human buffer as immutable UTF-8 bytes, not the published candidate',async()=>{
 let text='# 人工稿\n\nUnsaved wording 😀\n';const expected=text;
 const pending=captureTextCopy({text,relPath:'notes/reading.md',documentKey:'candidate-key',documentSource:source});text='typing after click';
 const snapshot=await pending,bytes=Buffer.from(await snapshot.blob.arrayBuffer());
 assert.equal(bytes.toString('utf8'),expected);assert.equal(snapshot.digest,createHash('sha256').update(bytes).digest('hex'));
 assert.equal(snapshot.byteLength,bytes.length);assert.equal(snapshot.filename,'reading-review-copy.md');assert.equal(snapshot.documentKey,'candidate-key');assert.deepEqual(snapshot.documentSource,source);
});
test('frozen version exports identify a frozen copy while preserving its exact body',async()=>{
 const snapshot=await captureTextCopy({text:'Frozen baseline\r\n',relPath:'reading.md',documentKey:'baseline-key',documentSource:{...source,type:'review-version',version:{kind:'baseline'}},frozen:true});
 assert.equal(await snapshot.blob.text(),'Frozen baseline\r\n');assert.equal(snapshot.filename,'reading-frozen-copy.md');assert.equal(snapshot.frozen,true);
});
test('native document file menu exposes both reading and editing exports with truthful labels',()=>{
 for(const [reading,label] of [[true,'导出当前审核稿副本…'],[false,'导出当前审核稿副本…'],[true,'导出冻结审核版本副本…']]){
  const surface={kind:'text',projectId:'p',relPath:'reading.md',reading,canExportTextCopy:true,exportTextCopyLabel:label};
  for(const build of [documentCommands,documentMoreCommands])assert.equal(build(surface).find(item=>item.id==='file').children.find(item=>item.id==='exportTextCopy').label,label);
 }
 assert.equal(documentCommands({kind:'text',projectId:'p',relPath:'source.md'}).find(item=>item.id==='file').children.some(item=>item.id==='exportTextCopy'),false);
});

test('download snapshot is rebuilt from verified host bytes and rejects stale publication fallback',async()=>{
 const local=await captureTextCopy({text:'Current human wording\n',relPath:'reading.md',documentKey:'candidate-key',documentSource:source});
 const receipt={relPath:local.relPath,documentSource:source,text:'Current human wording\n',digest:local.digest,byteLength:local.byteLength,origin:'buffer',dirty:true};
 const exported=await verifiedTextCopy(local,receipt);assert.notEqual(exported.blob,local.blob);assert.equal(await exported.blob.text(),receipt.text);assert.equal(exported.digest,receipt.digest);
 await assert.rejects(verifiedTextCopy(local,{...receipt,digest:'0'.repeat(64)}),/正文与摘要不一致/);
 await assert.rejects(verifiedTextCopy(local,{...receipt,byteLength:1}),/正文与摘要不一致/);
 await assert.rejects(verifiedTextCopy(local,{...receipt,documentSource:{...source,workId:'other-work'}}),/来源与当前文档不一致/);
 await assert.rejects(verifiedTextCopy(local,{...receipt,text:null}),/未改用本地正文/);
 const published=await captureTextCopy({text:'Old Worker publication',relPath:'reading.md',documentSource:source});
 await assert.rejects(verifiedTextCopy(local,{...receipt,text:'Old Worker publication',digest:published.digest,byteLength:published.byteLength,origin:'candidate'}),/等待同步后重新点击/);
});
