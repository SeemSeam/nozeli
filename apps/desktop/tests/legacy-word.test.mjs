import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {DesktopHost} from '../src/main/host.mjs';import {wordText} from '../src/main/word-anchors.mjs';
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-doc-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const root=path.join(dir,'project');await fs.mkdir(root);const host=new DesktopHost(path.join(dir,'profile'));const id=(await host.pick(root)).project.id;return {root,host,id};}
test('real OLE DOC imports body into a valid DOCX copy, never overwrites original or collisions',async t=>{
 const {root,host,id}=await fixture(t);const original=await fs.readFile(new URL('./fixtures/legacy-word/test01.doc',import.meta.url));await fs.writeFile(path.join(root,'旧版.doc'),original);
 const file=await host.readFile(id,'旧版.doc');assert.equal(file.kind,'legacy-word');const first=await host.importDoc(id,{relPath:file.relPath,digest:file.digest});assert.equal(first.mode,'body-only');
 const opened=await host.readFile(id,first.relPath);assert.equal(opened.kind,'word');assert.ok((await wordText(Buffer.from(opened.bytes))).trim());
 const second=await host.importDoc(id,{relPath:file.relPath,digest:file.digest});assert.notEqual(first.relPath,second.relPath);assert.deepEqual(await fs.readFile(path.join(root,'旧版.doc')),original);
 await fs.writeFile(path.join(root,'旧版.doc'),'changed');await assert.rejects(host.importDoc(id,{relPath:file.relPath,digest:file.digest}),/已变化/);
});
test('DOCX with doc extension copies bytes exactly; invalid DOC is rejected without an output',async t=>{
 const {root,host,id}=await fixture(t);const bytes=await fs.readFile(new URL('./fixtures/office/中文 文档.docx',import.meta.url));await fs.writeFile(path.join(root,'renamed.doc'),bytes);
 const source=await host.readFile(id,'renamed.doc'),result=await host.importDoc(id,{relPath:'renamed.doc',digest:source.digest});assert.equal(result.mode,'docx-copy');assert.deepEqual(await fs.readFile(path.join(root,result.relPath)),bytes);
 await fs.writeFile(path.join(root,'bad.doc'),'not Word');const bad=await host.readFile(id,'bad.doc');await assert.rejects(host.importDoc(id,{relPath:'bad.doc',digest:bad.digest}),/不是旧版/);assert.equal((await fs.readdir(root)).filter(s=>s.startsWith('bad.')).length,1);
});
