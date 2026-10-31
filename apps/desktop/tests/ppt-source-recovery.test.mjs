import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {DesktopHost} from '../src/main/host.mjs';import {readPptDraft,savePptDraft} from '../src/main/ppt-drafts.mjs';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ppt-source-recovery-')),projectRoot=path.join(root,'project');await fs.mkdir(projectRoot);const original=await fs.readFile(new URL('./fixtures/ppt/compatibility.pptx',import.meta.url));const absolute=path.join(projectRoot,'deck.pptx');await fs.writeFile(absolute,original);const host=new DesktopHost(path.join(root,'profile')),project=(await host.pick(projectRoot)).project;t.after(async()=>{await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});const file=await host.readFile(project.id,'deck.pptx');return {host,projectId:project.id,relPath:'deck.pptx',absolute,digest:file.digest,original};}
const model=text=>({slides:[{id:'slide',elements:[{id:'text',content:text}]}]});
test('external PPTX source changes preserve and recover the old model with its original bytes',async t=>{
 const f=await fixture(t);await savePptDraft({...f,model:model('HUMAN_PPT_DRAFT')});const external=Buffer.concat([f.original,Buffer.from('external ZIP trailer')]);await fs.writeFile(f.absolute,external);const current=await f.host.readFile(f.projectId,f.relPath);assert.notEqual(current.digest,f.digest);
 const saved=await savePptDraft({...f,model:model('HUMAN_PPT_DRAFT_2')});assert.equal(saved.sourceChanged,true);
 const recovered=await readPptDraft({...f,digest:current.digest});assert.equal(recovered.sourceChanged,true);assert.equal(recovered.sourceDigest,f.digest);assert.equal(recovered.currentDigest,current.digest);assert.equal(recovered.model.slides[0].elements[0].content,'HUMAN_PPT_DRAFT_2');assert.deepEqual(Buffer.from(recovered.sourceBytes),f.original);assert.deepEqual(await fs.readFile(f.absolute),external);
});
test('viewing current source does not delete older drafts and explicit recovery stays file-bound',async t=>{
 const f=await fixture(t);await savePptDraft({...f,model:model('old model')});await fs.writeFile(f.absolute,Buffer.concat([f.original,Buffer.from('new source')]));const next=await f.host.readFile(f.projectId,f.relPath);
 const source=await readPptDraft({...f,digest:next.digest,sourceOnly:true});assert.equal(source.model,null);assert.equal(source.recoverable[0].digest,f.digest);
 await savePptDraft({...f,digest:next.digest,model:model('new model')});const old=await readPptDraft({...f,digest:next.digest,recoverDigest:f.digest});assert.equal(old.model.slides[0].elements[0].content,'old model');
 const current=await readPptDraft({...f,digest:next.digest});assert.equal(current.model.slides[0].elements[0].content,'new model');assert.equal(current.sourceChanged,false);
 await assert.rejects(readPptDraft({...f,digest:next.digest,recoverDigest:'0'.repeat(64)}),/不属于/);
 await assert.rejects(readPptDraft({...f,relPath:'other.pptx',digest:next.digest,recoverDigest:f.digest}),/不属于/);
});
test('concurrent saves retain both source-version entries and never write the live PPTX',async t=>{
 const f=await fixture(t);const external=Buffer.concat([f.original,Buffer.from('second source')]);await fs.writeFile(f.absolute,external);const next=await f.host.readFile(f.projectId,f.relPath);
 await Promise.all([savePptDraft({...f,model:model('source one')}),savePptDraft({...f,digest:next.digest,model:model('source two')})]);const current=await readPptDraft({...f,digest:next.digest});assert.equal(current.model.slides[0].elements[0].content,'source two');assert.equal(current.recoverable.length,1);const older=await readPptDraft({...f,digest:next.digest,recoverDigest:f.digest});assert.equal(older.model.slides[0].elements[0].content,'source one');assert.deepEqual(await fs.readFile(f.absolute),external);
});

test('an unrelated requested digest does not implicitly select a different source draft',async t=>{
 const f=await fixture(t);await savePptDraft({...f,model:model('retained only for its source')});const result=await readPptDraft({...f,digest:'f'.repeat(64)});assert.equal(result.model,null);assert.deepEqual(await fs.readFile(f.absolute),f.original);
});
