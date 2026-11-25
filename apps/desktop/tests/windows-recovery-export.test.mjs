import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {exportNativeChunks,exportRecoveryRecord} from '../src/main/recovery-export.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {createWindowsRecoveryExportIO} from '../src/platform/windows/recovery-export.mjs';
import {security} from './fixtures/windows-security.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-recovery-export-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
function source(root,bytes,options={}){return {scope:{generation:1,dead:false},defaultName:'恢复.json',dialog:{async showSaveDialog(){return {filePath:path.join(root,'恢复.json')};}},expectedTotal:bytes.length,async readChunk(offset){const chunk=bytes.subarray(offset,offset+65536);return {bytes:chunk,offset,nextOffset:offset+chunk.length,total:bytes.length};},...options};}

test('native export streams exact UTF8 bytes with private ACL in a public selected directory',native,async t=>{
 const root=await fixture(t);security('broad-parent',root);const bytes=Buffer.from('界🙂\n'.repeat(40000)),args=source(root,bytes),result=await exportNativeChunks(args);
 assert.equal(result.exported,true);assert.equal(result.durability,'namespace-not-qualified');assert.deepEqual(await fs.readFile(path.join(root,'恢复.json')),bytes);assert.equal(security('inspect',path.join(root,'恢复.json')).protected,true);assert.deepEqual(await fs.readdir(root),['恢复.json']);
});
test('a late independent export winner is never overwritten and only the owned stage is removed',native,async t=>{
 const root=await fixture(t),args=source(root,Buffer.from('candidate'),{finalize:()=>fs.writeFile(path.join(root,'恢复.json'),'external winner',{flag:'wx'})});await assert.rejects(exportNativeChunks(args));assert.equal(await fs.readFile(path.join(root,'恢复.json'),'utf8'),'external winner');assert.deepEqual(await fs.readdir(root),['恢复.json']);
});
test('changed surface generation cancels before publication and retains the source',native,async t=>{
 const root=await fixture(t),bytes=Buffer.from('unchanged recovery'),scope={generation:1,dead:false};await assert.rejects(exportNativeChunks(source(root,bytes,{scope,finalize(){scope.generation++;}})),{code:'RECOVERY_EXPORT_CHANGED'});assert.deepEqual(await fs.readdir(root),[]);assert.equal(bytes.toString(),'unchanged recovery');
});

test('surface closed after sync but before final native publication removes only its owned stage',native,async t=>{
 const root=await fixture(t),scope={generation:1,dead:false},nativeIO=createWindowsRecoveryExportIO();
 const io={...nativeIO,async open(target){const output=await nativeIO.open(target);return {...output,async publish(options){scope.dead=true;return output.publish(options);}};}};
 await assert.rejects(exportNativeChunks(source(root,Buffer.from('retained original'),{scope,io})),{code:'RECOVERY_EXPORT_CHANGED'});assert.deepEqual(await fs.readdir(root),[]);
});
test('junction export parent refuses before writing to an outside directory',native,async t=>{
 const root=await fixture(t),outside=await fixture(t),link=path.join(root,'link');await fs.symlink(outside,link,'junction');await assert.rejects(exportNativeChunks(source(link,Buffer.from('retained'))));assert.deepEqual(await fs.readdir(outside),[]);
});
test('real directory barrier failure retains published bytes and committed uncertainty',native,async t=>{
 const root=await fixture(t),bytes=Buffer.from('published result'),io=createWindowsRecoveryExportIO({directorySync(parent){parent.close();parent.syncDirectory();}});await assert.rejects(exportNativeChunks(source(root,bytes,{io})),error=>error.committed===true&&error.durability==='uncertain'&&error.details.committed===true);assert.deepEqual(await fs.readFile(path.join(root,'恢复.json')),bytes);await assert.rejects(exportNativeChunks(source(root,Buffer.from('no replay'))));assert.deepEqual(await fs.readFile(path.join(root,'恢复.json')),bytes);
});
test('cancelled native dialog performs no reads and creates no stage',native,async t=>{
 const root=await fixture(t),args=source(root,Buffer.from('source'),{dialog:{async showSaveDialog(){return {canceled:true};}},readChunk(){assert.fail('cancelled export must not read source');}});assert.deepEqual(await exportNativeChunks(args),{cancelled:true});assert.deepEqual(await fs.readdir(root),[]);
});
test('invalid chunk framing and late source validation failure leave no published output',native,async t=>{
 const root=await fixture(t),bytes=Buffer.from('source');await assert.rejects(exportNativeChunks(source(root,bytes,{readChunk(){return {bytes,offset:1,nextOffset:bytes.length+1,total:bytes.length};}})),{code:'RECOVERY_EXPORT_CHANGED'});assert.deepEqual(await fs.readdir(root),[]);await assert.rejects(exportNativeChunks(source(root,bytes,{finalize(){throw Object.assign(Error('record revision changed'),{code:'RECOVERY_REVISION_CHANGED'});}})),{code:'RECOVERY_REVISION_CHANGED'});assert.deepEqual(await fs.readdir(root),[]);
});

test('real SQLite recovery records and project/offline material references export exact bytes without consuming the retained originals',native,async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-recovery-export-record-')),project=path.join(root,'project');await fs.mkdir(project);
 const storage=new ProjectStorage(path.join(root,'profile'),{experimentalWindowsRoot:root,experimentalWindowsInitialization:true});
 t.after(async()=>{await storage.db.close();await fs.rm(root,{recursive:true,force:true});});const projectId=(await storage.register(project)).id;
 const bytes=Buffer.from('保留的原始材料🙂\n'.repeat(14000)),record={kind:'object',status:'pending',...(await storage.putRecoveryObject(projectId,bytes))},id='managed:object-pending:export';await storage.putRecovery(projectId,id,record);
 let target=path.join(root,'record.json');const dialog={async showSaveDialog(){return {filePath:target};}},scope={generation:1,dead:false};
 const selection=async()=>{const page=await storage.recoveryPage(projectId,{prefixes:[id],purpose:'recovery-ui'});const row=page.entries.find(row=>row.id===id);assert.ok(row);return {storage,dialog,scope,projectId,id,revision:row.revision,version:page.version};};
 assert.equal((await exportRecoveryRecord(await selection())).exported,true);assert.deepEqual(await fs.readFile(target),Buffer.from(JSON.stringify(record)));
 target=path.join(root,'offline.bin');assert.equal((await exportRecoveryRecord({...await selection(),reference:'object'})).exported,true);assert.deepEqual(await fs.readFile(target),bytes);
 const online=await storage.putObject(projectId,bytes);assert.equal(online.digest,record.digest);target=path.join(root,'project.bin');assert.equal((await exportRecoveryRecord({...await selection(),reference:'object'})).exported,true);assert.deepEqual(await fs.readFile(target),bytes);
 assert.deepEqual(await storage.getRecovery(projectId,id),record);assert.deepEqual(await storage.readRecoveryObject(projectId,record.digest),bytes);assert.deepEqual(await storage.readObject(projectId,record.digest),bytes);
 target=path.join(root,'stale.json');const stale=await selection();await storage.putRecovery(projectId,id,{...record,external:'new winner'});await assert.rejects(exportRecoveryRecord(stale),{code:'RECOVERY_VERSION_CHANGED'});await assert.rejects(fs.stat(target),{code:'ENOENT'});assert.equal((await storage.getRecovery(projectId,id)).external,'new winner');
});
