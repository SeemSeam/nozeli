// Storage-v2 GC collects only old local scratch; immutable versions and project records survive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {ShadowVersions} from '../src/agents/managed/shadow-versions.mjs';
import {DesktopHost} from '../src/main/host.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-shadow-gc-')),project=path.join(root,'project');await fs.mkdir(project);await fs.writeFile(path.join(project,'doc.md'),'seed');
 const host=new DesktopHost(path.join(root,'profile')),{project:p}=await host.pick(project);await host.save(p.id,'doc.md',sha('seed'),'frozen document');
 const versions=new ShadowVersions({projectRoot:project,projectId:p.id,storage:host.storage});await versions.ensureRepo();await fs.mkdir(versions.requestsDir,{recursive:true});
 t.after(async()=>{await host.storage.db.close();await fs.rm(root,{recursive:true,force:true});});
 const scratch=async(name,text,age=7200000)=>{const file=path.join(versions.requestsDir,name);await fs.writeFile(file,text);const now=new Date(Date.now()-age);await fs.utimes(file,now,now);return file;};
 return {root,project,host,id:p.id,versions,scratch};
}
test('only old recognized scratch is recycled; young files and unknown names survive',async t=>{
 const f=await fixture(t),old=await f.scratch('old.index','old'),young=await f.scratch('young.meta.json','young',0),unrelated=await f.scratch('other.txt','keep');
 const r=await f.versions.collectGarbage();assert.equal(r.freedBytes,3);assert.equal(await fs.stat(old).then(()=>true,()=>false),false);
 assert.equal(await fs.readFile(young,'utf8'),'young');assert.equal(await fs.readFile(unrelated,'utf8'),'keep');
});
test('byte and file budgets prevent over-deletion and do not bypass oversized objects',async t=>{
 const f=await fixture(t),a=await f.scratch('a.blob.tmp','12345678'),b=await f.scratch('b.index','12345678');
 const none=await f.versions.collectGarbage({maxBytes:7});assert.equal(none.deleted.length,0);assert.equal(await fs.readFile(a,'utf8'),'12345678');assert.equal(await fs.readFile(b,'utf8'),'12345678');
 const one=await f.versions.collectGarbage({maxBytes:16,maxFiles:1});assert.equal(one.deleted.length,1);assert.equal(one.freedBytes,8);assert.equal((await fs.readdir(f.versions.requestsDir)).length,1);
});
test('scratch symlinks and directories are retained without following or altering outside content',async t=>{
 const f=await fixture(t),outside=path.join(f.root,'outside');await fs.writeFile(outside,'sentinel');
 const link=path.join(f.versions.requestsDir,'linked.blob.tmp'),dir=path.join(f.versions.requestsDir,'directory.index');await fs.symlink(outside,link);await fs.mkdir(dir);await fs.writeFile(path.join(dir,'keep'),'nested');
 const r=await f.versions.collectGarbage({tempAgeMs:0});assert.equal(r.deleted.length,0);assert((await fs.lstat(link)).isSymbolicLink());assert.equal(await fs.readFile(outside,'utf8'),'sentinel');assert.equal(await fs.readFile(path.join(dir,'keep'),'utf8'),'nested');
});
test('GC preserves immutable checkpoint bytes, Git chain, restore preps and user history',async t=>{
 const f=await fixture(t),checkpoint=await f.versions.checkpoint({requestId:'retained',workId:'w',relPaths:['doc.md']});
 const prep=await f.versions.prepare({commit:checkpoint.commit,relPath:'doc.md',currentDigest:sha('frozen document')});
 const head=await f.versions.git(['rev-parse','refs/heads/nozeli/versions']);
 const ledger=await f.host.storage.listProject(f.id,'file_changes'),before=await f.host.storage.listProject(f.id,'version_preps');
 await f.scratch('stale.index','discard');await f.versions.collectGarbage({tempAgeMs:0});
 assert.equal((await f.versions.readBlob(checkpoint.commit,'doc.md')).toString(),'frozen document');assert.deepEqual(await f.versions.git(['rev-parse','refs/heads/nozeli/versions']),head);
 assert.deepEqual(await f.host.storage.listProject(f.id,'file_changes'),ledger);assert.deepEqual(await f.host.storage.listProject(f.id,'version_preps'),before);assert.equal((await f.versions.readPrep(prep.prepId)).checkpointDigest,sha('frozen document'));assert.equal(await fs.readFile(path.join(f.project,'doc.md'),'utf8'),'frozen document');
});
test('queued checkpoint and collection keep the newest committed snapshot readable',async t=>{
 const f=await fixture(t);await f.scratch('stale.meta.json','discard');
 const checkpoint=f.versions.checkpoint({requestId:'concurrent',workId:'w',relPaths:['doc.md']}),collection=f.versions.collectGarbage({tempAgeMs:0});
 const [saved]=await Promise.all([checkpoint,collection]);assert.equal((await f.versions.readBlob(saved.commit,'doc.md')).toString(),'frozen document');
 const reused=await f.versions.checkpoint({requestId:'concurrent',workId:'w',relPaths:['doc.md']});assert.equal(reused.commit,saved.commit);assert.equal(reused.reused,true);
});
