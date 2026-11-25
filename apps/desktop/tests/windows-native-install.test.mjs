import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createExperimentalWindowsPersistence as create,openExperimentalPersistenceParent as open} from '../src/platform/windows/experimental-persistence.mjs';
import {experimentalWindowsVersionedFilesystem as filesystem} from '../src/platform/windows/experimental-filesystem.mjs';
import {createFileStream} from '../src/agents/managed/file-stream.mjs';
import {ExecutionWorkspace} from '../src/agents/managed/execution-workspace.mjs';
import {git,str,blobStream} from '../src/agents/managed/git-service.mjs';
import {runGit} from '../src/agents/managed/git-runtime.mjs';
import {Readable} from 'node:stream';

const native={skip:process.platform!=='win32'||process.arch!=='x64'};
const sha=bytes=>bytes===null?null:createHash('sha256').update(bytes).digest('hex');
async function fixture(t,{repo=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-install-')),resources=[];
 t.after(async()=>{for(const resource of resources.reverse())resource.close();await fs.rm(root,{recursive:true,force:true});});
 if(repo)await git(root,['init','--initial-branch=synthetic']);
 return {root,file:rel=>path.join(root,rel),workspace:new ExecutionWorkspace({root,content:root},{filesystem}),
  tx(){const parent=open(root,'target');resources.push(parent);const tx=parent.beginReplacement('target');resources.push(tx);return tx;},
  async object(bytes){if(bytes===null)return null;return (await runGit(root,['hash-object','-w','--stdin'],{input:Readable.from([Buffer.from(bytes)])})).toString().trim();},
 };
}
function child(code,args=[]){
 const result=spawnSync(process.execPath,['--input-type=module','-e',code,...args],{encoding:'utf8',windowsHide:true,timeout:10000});
 assert.ifError(result.error);assert.equal(result.signal,null);return result;
}
async function intent(f,rel,before,after){return {rel,before:sha(before),after:sha(after),beforeOid:await f.object(before),oid:await f.object(after),beforeMode:before===null?null:'100644',mode:after===null?null:'100644'};}

test('native deletion stays invisible until commit, blocks an independent writer and rolls back on close',native,async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('target'),'base');
 const tx=f.tx();tx.prepareDelete();
 assert.equal(await fs.readFile(f.file('target'),'utf8'),'base');
 const competing=child(`import fs from 'node:fs';try{fs.writeFileSync(process.argv[1],'winner');}catch(e){console.log(e.code);process.exitCode=7;}`,[f.file('target')]);
 assert.equal(competing.status,7);assert.match(competing.stdout,/EPERM|EACCES|EBUSY|UNKNOWN/);
 assert.throws(()=>tx.prepareDelete(),{code:'FS_TRANSACTION_STATE'});
 assert.throws(()=>tx.readChunk(0,1),{code:'FS_TRANSACTION_STATE'});
 tx.close();assert.equal(await fs.readFile(f.file('target'),'utf8'),'base');
 const committed=f.tx();committed.prepareDelete();committed.commit();committed.close();
 await assert.rejects(fs.stat(f.file('target')),{code:'ENOENT'});
 await fs.writeFile(f.file('target'),'recreated');
});

test('deletion refuses forged receivers and an open candidate without leaking its stage',native,async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('target'),'base');const tx=f.tx();
 assert.throws(()=>tx.prepareDelete.call({}));tx.beginCandidate('owned.pending');tx.writeCandidate(Buffer.from('candidate'));
 assert.throws(()=>tx.prepareDelete(),{code:'FS_TRANSACTION_STATE'});tx.close();
 assert.deepEqual(await fs.readdir(f.root),['target']);assert.equal(await fs.readFile(f.file('target'),'utf8'),'base');
 assert.throws(()=>tx.prepareDelete(),{code:'FS_HANDLE_CLOSED'});
});

test('process exit rolls back an uncommitted native deletion',native,async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('target'),'base');
 const loader=new URL('../src/platform/windows/experimental-persistence.mjs',import.meta.url).href;
 const result=child(`import {openExperimentalPersistenceParent as open} from ${JSON.stringify(loader)};
 const parent=open(process.argv[1],'target');const tx=parent.beginReplacement('target');tx.prepareDelete();process.exit(19);`,[f.root]);
 assert.equal(result.status,19,result.stderr);assert.equal(await fs.readFile(f.file('target'),'utf8'),'base');
 await fs.writeFile(f.file('target'),'released');
});

test('versioned deletion checks stale base, invalid approval and cancellation and preserves recovery draft',native,async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('target'),'winner');await fs.writeFile(f.file('draft.recovery'),'draft');
 const persistence=create(f.root);
 await assert.rejects(persistence.removeVersioned('target',{expectedSha256:sha('base')}),{code:'FS_VERSION_CONFLICT'});
 for(const expectedSha256 of [null,undefined,'bad'])await assert.rejects(persistence.removeVersioned('target',{expectedSha256}),{code:'FS_VERSION_REJECTED'});
 const controller=new AbortController();controller.abort();
 await assert.rejects(persistence.removeVersioned('target',{expectedSha256:sha('winner'),signal:controller.signal}),{code:'ABORT_ERR'});
 assert.equal(await fs.readFile(f.file('target'),'utf8'),'winner');assert.equal(await fs.readFile(f.file('draft.recovery'),'utf8'),'draft');
 const result=await persistence.removeVersioned('target',{expectedSha256:sha('winner')});
 assert.equal(result.deleted,true);assert.deepEqual(result.barriers,{directory:'flushed'});assert.equal(result.durability,'namespace-not-qualified');
 assert.deepEqual(await fs.readdir(f.root),['draft.recovery']);
});

test('deletion refuses hard links, directory reparse entries and readonly targets without repairs',native,async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('target'),'base');await fs.link(f.file('target'),f.file('alias'));
 await assert.rejects(create(f.root).removeVersioned('target',{expectedSha256:sha('base')}),{code:'FS_ENTRY_REJECTED'});
 await fs.unlink(f.file('alias'));await fs.mkdir(f.file('real'));await fs.symlink(f.file('real'),f.file('junction'),'junction');
 await assert.rejects(create(f.root).removeVersioned('junction/file',{expectedSha256:sha('base')}),{code:'FS_REPARSE_REJECTED'});
 await fs.chmod(f.file('target'),0o444);
 try{await assert.rejects(create(f.root).removeVersioned('target',{expectedSha256:sha('base')}));assert.equal(await fs.readFile(f.file('target'),'utf8'),'base');}
 finally{await fs.chmod(f.file('target'),0o666);}
});

test('a real closed-parent barrier failure retains committed deletion and uncertain durability',native,async t=>{
 const f=await fixture(t);await fs.writeFile(f.file('target'),'base');
 await assert.rejects(create(f.root,{directorySync:parent=>{parent.close();parent.syncDirectory();}}).removeVersioned('target',{expectedSha256:sha('base')}),error=>error.code==='FS_HANDLE_CLOSED'&&error.committed===true&&error.durability==='uncertain');
 await assert.rejects(fs.stat(f.file('target')),{code:'ENOENT'});assert.deepEqual(await fs.readdir(f.root),[]);
});

test('actual Git install and rollback handle changed, created and deleted Unicode files and preserve index/refs/drafts',native,async t=>{
 const f=await fixture(t,{repo:true}),rel='中文 空格/正文.txt';await fs.mkdir(f.file('中文 空格'));
 await fs.writeFile(f.file('draft.recovery'),'uncommitted draft');await fs.writeFile(f.file('tracked'),'index baseline');await git(f.root,['add','tracked']);
 const index=await fs.readFile(f.file('.git/index')),refs=await git(f.root,['for-each-ref']);
 for(const [before,after] of [['base','candidate'],[null,'new file'],['delete me',null]]){
  if(before===null)await fs.rm(f.file(rel),{force:true});else await fs.writeFile(f.file(rel),before);
  const plan=await intent(f,rel,before,after);
  await f.workspace.installFile({repo:f.root},plan,false);
  assert.equal((await f.workspace.files.inspectFile(f.root,rel))?.digest??null,sha(after));
  await f.workspace.installFile({repo:f.root},plan,true);
  assert.equal((await f.workspace.files.inspectFile(f.root,rel))?.digest??null,sha(before));
 }
 assert.deepEqual(await fs.readFile(f.file('.git/index')),index);assert.deepEqual(await git(f.root,['for-each-ref']),refs);
 assert.equal(await fs.readFile(f.file('draft.recovery'),'utf8'),'uncommitted draft');
});

test('Git install streams a 33 MiB object in both directions without bounded text APIs',native,async t=>{
 const f=await fixture(t,{repo:true}),before=Buffer.alloc(33*1024*1024,0x41),after=Buffer.alloc(before.length+7,0x42);
 const plan=await intent(f,'large',before,after);await fs.writeFile(f.file('large'),before);
 await f.workspace.installFile({repo:f.root},plan,false);assert.equal((await f.workspace.files.inspectFile(f.root,'large')).digest,sha(after));
 await f.workspace.installFile({repo:f.root},plan,true);assert.equal((await f.workspace.files.inspectFile(f.root,'large')).digest,sha(before));
});

test('install and rollback preserve independent winners and remain idempotent after completed publication',native,async t=>{
 const f=await fixture(t,{repo:true}),plan=await intent(f,'target','base','candidate');await fs.writeFile(f.file('target'),'winner');
 await assert.rejects(f.workspace.installFile({repo:f.root},plan,false),{code:'SOURCE_CHANGED'});
 await fs.writeFile(f.file('target'),'base');await f.workspace.installFile({repo:f.root},plan,false);
 await f.workspace.installFile({repo:f.root},plan,false);
 await fs.writeFile(f.file('target'),'later winner');
 await assert.rejects(f.workspace.installFile({repo:f.root},plan,true),{code:'SOURCE_CHANGED'});
 assert.equal(await fs.readFile(f.file('target'),'utf8'),'later winner');
 await fs.writeFile(f.file('target'),'candidate');await f.workspace.installFile({repo:f.root},plan,true);await f.workspace.installFile({repo:f.root},plan,true);
});

test('locked installation detects an independent change between inspection and native publication',native,async t=>{
 const f=await fixture(t,{repo:true}),plan=await intent(f,'target','base','candidate');await fs.writeFile(f.file('target'),'base');
 const racing={...filesystem,async writeVersionedStream(...args){await fs.writeFile(f.file('target'),'racing winner');return filesystem.writeVersionedStream(...args);}};
 const workspace=new ExecutionWorkspace({root:f.root},{filesystem:racing});
 await assert.rejects(workspace.installFile({repo:f.root},plan,false),error=>error.code==='SOURCE_CHANGED'&&error.nativeCode==='FS_VERSION_CONFLICT'&&!error.committed);
 assert.equal(await fs.readFile(f.file('target'),'utf8'),'racing winner');
});

test('missing/corrupt Git objects and an unapproved body preserve existing bytes and remove only owned stages',native,async t=>{
 const f=await fixture(t,{repo:true}),plan=await intent(f,'target','base','candidate');await fs.writeFile(f.file('target'),'base');
 for(const broken of [{...plan,oid:'1'.repeat(40)},{...plan,after:sha('different approved body')}])await assert.rejects(f.workspace.installFile({repo:f.root},broken,false));
 const object=f.file('.git/objects/'+plan.oid.slice(0,2)+'/'+plan.oid.slice(2));await fs.chmod(object,0o666);await fs.writeFile(object,'corrupt synthetic object');
 await assert.rejects(f.workspace.installFile({repo:f.root},plan,false));
 assert.equal(await fs.readFile(f.file('target'),'utf8'),'base');assert.deepEqual((await fs.readdir(f.root)).sort(),['.git','target']);
});

test('managed metadata, executable modes, missing parents and incomplete adapters fail without effects',native,async t=>{
 const f=await fixture(t,{repo:true}),plan=await intent(f,'target','base','candidate');await fs.writeFile(f.file('target'),'base');
 for(const rel of ['.GIT/config','.ＮＯＺＥＬＩ/state','NUL.txt','secrets/key','ALIAS~1/file'])await assert.rejects(f.workspace.installFile({repo:f.root},{...plan,rel},false),{code:'PATH_REJECTED'});
 await assert.rejects(f.workspace.installFile({repo:f.root},{...plan,mode:'100755'},false),{code:'FS_MODE_UNSUPPORTED'});
 await assert.rejects(f.workspace.installFile({repo:f.root},{...plan,rel:'missing/target',before:null},false));
 const incomplete={...filesystem,writeVersionedStream:undefined},workspace=new ExecutionWorkspace({root:f.root},{filesystem:incomplete});
 await assert.rejects(workspace.installFile({repo:f.root},plan,false),{code:'FS_PLATFORM_UNSUPPORTED'});
 await assert.rejects(createFileStream({filesystem:{...filesystem,removeVersioned:undefined}}).removeVersioned(f.root,'target',{expectedSha256:sha('base')}),{code:'FS_PLATFORM_UNSUPPORTED'});
 assert.equal(await fs.readFile(f.file('target'),'utf8'),'base');assert.deepEqual((await fs.readdir(f.root)).sort(),['.git','target']);
});

test('postpublication verification errors retain committed uncertainty and identify the file',native,async t=>{
 const f=await fixture(t,{repo:true}),plan=await intent(f,'target','base','candidate');await fs.writeFile(f.file('target'),'base');
 const racing={...filesystem,async writeVersionedStream(...args){await filesystem.writeVersionedStream(...args);await fs.writeFile(f.file('target'),'after-publication winner');}};
 const workspace=new ExecutionWorkspace({root:f.root},{filesystem:racing});
 await assert.rejects(workspace.installFile({repo:f.root},plan,false),error=>error.code==='SOURCE_CHANGED'&&error.relPath==='target'&&error.committed===true&&error.durability==='uncertain');
 assert.equal(await fs.readFile(f.file('target'),'utf8'),'after-publication winner');
});

test('lazy bounded Git blob streams validate IDs, propagate failures and reap after early consumer return',native,async t=>{
 const f=await fixture(t,{repo:true}),oid=await f.object(Buffer.alloc(5*1024*1024,0x5a));
 const lazy=blobStream(f.file('absent-repository'),oid);await lazy.return();
 for(const bad of ['HEAD','--help','1'.repeat(39)])await assert.rejects(async()=>{for await(const chunk of blobStream(f.root,bad))assert.fail('invalid object yielded');},{code:'GIT_OBJECT_REJECTED'});
 await assert.rejects(async()=>{for await(const chunk of blobStream(f.root,'2'.repeat(40)))assert.fail('missing object yielded');});
 for(let i=0;i<3;i++){let size=0;for await(const chunk of blobStream(f.root,oid)){size+=chunk.length;break;}assert.ok(size>0&&size<=256*1024);}
 const chunks=[];for await(const chunk of blobStream(f.root,oid))chunks.push(chunk);assert.equal(Buffer.concat(chunks).length,5*1024*1024);
 const controller=new AbortController();controller.abort();await assert.rejects(async()=>{for await(const chunk of blobStream(f.root,oid,{signal:controller.signal}))assert.fail('aborted object yielded');},{code:'ABORT_ERR'});
 assert.equal(await str(f.root,['rev-parse','--show-object-format']),'sha1');
});

test('SHA-256 Git objects install and rollback through the same streamed boundary',native,async t=>{
 const f=await fixture(t);await git(f.root,['init','--object-format=sha256','--initial-branch=synthetic']);
 const plan=await intent(f,'target','base','candidate');assert.equal(plan.oid.length,64);await fs.writeFile(f.file('target'),'base');
 await f.workspace.installFile({repo:f.root},plan,false);assert.equal(await fs.readFile(f.file('target'),'utf8'),'candidate');
 await f.workspace.installFile({repo:f.root},plan,true);assert.equal(await fs.readFile(f.file('target'),'utf8'),'base');
});

test('deletion detects a race after inspection and preserves a recreated external winner during rollback',native,async t=>{
 const f=await fixture(t,{repo:true}),plan=await intent(f,'target','base',null);await fs.writeFile(f.file('target'),'base');
 const racing={...filesystem,async removeVersioned(...args){await fs.writeFile(f.file('target'),'deletion race winner');return filesystem.removeVersioned(...args);}};
 const workspace=new ExecutionWorkspace({root:f.root},{filesystem:racing});
 await assert.rejects(workspace.installFile({repo:f.root},plan,false),error=>error.code==='SOURCE_CHANGED'&&error.nativeCode==='FS_VERSION_CONFLICT');
 assert.equal(await fs.readFile(f.file('target'),'utf8'),'deletion race winner');
 await fs.writeFile(f.file('target'),'base');await f.workspace.installFile({repo:f.root},plan,false);await f.workspace.installFile({repo:f.root},plan,false);
 await fs.writeFile(f.file('target'),'recreated winner');await assert.rejects(f.workspace.installFile({repo:f.root},plan,true),{code:'SOURCE_CHANGED'});
 assert.equal(await fs.readFile(f.file('target'),'utf8'),'recreated winner');
});

test('cancellation during locked deletion hashing leaves the large base and releases the transaction',native,async t=>{
 const f=await fixture(t),bytes=Buffer.alloc(4*1024*1024,0x61);await fs.writeFile(f.file('target'),bytes);
 const controller=new AbortController();setImmediate(()=>controller.abort());
 await assert.rejects(create(f.root).removeVersioned('target',{expectedSha256:sha(bytes),signal:controller.signal}),{code:'ABORT_ERR'});
 assert.equal(sha(await fs.readFile(f.file('target'))),sha(bytes));await fs.writeFile(f.file('target'),'released');
});
