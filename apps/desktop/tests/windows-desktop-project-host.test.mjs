import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DesktopHost} from '../src/main/host.mjs';
import {ensureExperimentalPrivateDirectory} from '../src/platform/windows/experimental-directories.mjs';
import {digestBytes} from '../src/domain/material-store.mjs';
import {security} from './fixtures/windows-security.mjs';
const native={skip:process.platform!=='win32'||process.arch!=='x64'};
async function fixture(t){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-desktop-source-')),profile=path.join(base,'profile'),root=path.join(base,'项目 空格'),hosts=[];await ensureExperimentalPrivateDirectory(base,profile);await fs.mkdir(root);const file=path.join(root,'paper.md');await fs.writeFile(file,'# Original 中文 🧭\r\n');
 t.after(async()=>{for(const host of hosts)await host.storage.db.close();await fs.rm(base,{recursive:true,force:true});});
 const host=()=>{const h=new DesktopHost(profile);hosts.push(h);return h;},h=host(),p=await h.registerDirectory(root);
 return {base,profile,root,file,h,p,host};
}
test('actual DesktopHost saves native text CAS, preserves source ACL and cold reopens shared history and baseline recovery',native,async t=>{
 const f=await fixture(t),read=await f.h.readFile(f.p.id,'paper.md'),original=Buffer.from(read.text),acl=security('inspect',f.file),text='# Saved 中文 🧭\n';
 await f.h.draft(f.p.id,'paper.md',read.digest,text);const saved=await f.h.save(f.p.id,'paper.md',read.digest,text);assert.equal(saved.digest,digestBytes(Buffer.from(text)));assert.equal(await fs.readFile(f.file,'utf8'),text);const after=security('inspect',f.file);for(const key of ['owner','group','protected','rules'])assert.deepEqual(after[key],acl[key]);
 assert.deepEqual(await f.h.storage.readRecoveryObject(f.p.id,read.digest),original);assert.equal((await f.h.readFile(f.p.id,'paper.md')).draft,null);await f.h.storage.db.close();const cold=f.host(),reopened=await cold.readFile(f.p.id,'paper.md');assert.equal(reopened.text,text);assert.equal(reopened.draft,null);assert.equal(reopened.authorshipError,null);assert.equal(reopened.digest,saved.digest);
});
test('an external source update retains its bytes and the original user draft on save conflict and cold reopen',native,async t=>{
 const f=await fixture(t),read=await f.h.readFile(f.p.id,'paper.md'),text='unsent user draft';await fs.writeFile(f.file,'external winner');await assert.rejects(f.h.save(f.p.id,'paper.md',read.digest,text),error=>error.code==='CONFLICT'&&error.details.draftKept===true);assert.equal(await fs.readFile(f.file,'utf8'),'external winner');await f.h.storage.db.close();const cold=f.host(),reopened=await cold.readFile(f.p.id,'paper.md');assert.equal(reopened.text,'external winner');assert.equal(reopened.draft.text,text);assert.equal(reopened.draft.baseDigest,read.digest);
});
test('a writer after the final shared precommit check is refused by native digest CAS and its winner survives',native,async t=>{
 const f=await fixture(t),read=await f.h.readFile(f.p.id,'paper.md'),replace=f.h.replaceFile.bind(f.h),text='user candidate';
 f.h.replaceFile=(abs,bytes,options)=>replace(abs,bytes,{...options,beforeCommit:async()=>{await options.beforeCommit();await fs.writeFile(abs,'late external winner');}});
 await assert.rejects(f.h.save(f.p.id,'paper.md',read.digest,text),error=>error.code==='CONFLICT'&&error.details.cause==='FS_VERSION_CONFLICT'&&error.details.draftKept);assert.equal(await fs.readFile(f.file,'utf8'),'late external winner');assert.deepEqual(await f.h.storage.readRecoveryObject(f.p.id,read.digest),Buffer.from(read.text));await f.h.storage.db.close();const reopened=await f.host().readFile(f.p.id,'paper.md');assert.equal(reopened.text,'late external winner');assert.equal(reopened.draft.text,text);
});
test('a missing original is recreated only after explicit confirmation and create-only publication never replaces a late winner',native,async t=>{
 const f=await fixture(t),read=await f.h.readFile(f.p.id,'paper.md');await fs.unlink(f.file);await assert.rejects(f.h.save(f.p.id,'paper.md',read.digest,'retained draft'),{code:'DELETED'});const saved=await f.h.save(f.p.id,'paper.md',read.digest,'recreated',{confirmOverwrite:true});assert.equal(saved.overwritten,true);assert.equal(await fs.readFile(f.file,'utf8'),'recreated');
 await assert.rejects(f.h.replaceFile(f.file,Buffer.from('clobber'),{createOnly:true}),{code:'FS_TARGET_EXISTS'});assert.equal(await fs.readFile(f.file,'utf8'),'recreated');await assert.rejects(f.h.replaceFile(f.file,Buffer.from('clobber')),{code:'FS_VERSION_REJECTED'});assert.equal(await fs.readFile(f.file,'utf8'),'recreated');
});
test('DesktopHost source reads refuse unselected sibling files and hardlink aliases',native,async t=>{
 const f=await fixture(t),outside=path.join(f.base,'sibling');await fs.writeFile(outside,'outside synthetic bytes');await assert.rejects(f.h.readSource(outside),{code:'PROJECT_SCOPE_REQUIRED'});const alias=path.join(f.root,'alias.md');await fs.link(f.file,alias);await assert.rejects(f.h.readFile(f.p.id,'alias.md'));assert.equal(await fs.readFile(f.file,'utf8'),'# Original 中文 🧭\r\n');assert.equal(await fs.readFile(outside,'utf8'),'outside synthetic bytes');
});
