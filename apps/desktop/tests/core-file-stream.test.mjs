import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Writable} from 'node:stream';
import {createHash} from 'node:crypto';
import {inspectFile,readSafeBytes,withSafeFile} from '../src/agents/managed/file-stream.mjs';
import {git,str,blobFile,blobDigest,gitStream,gitEntries,updateIndexRows} from '../src/agents/managed/git-service.mjs';
import {ExecutionWorkspace} from '../src/agents/managed/execution-workspace.mjs';

test('large binary streams through safe capture, Git, install and rollback',{skip:!['linux','darwin'].includes(process.platform)},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-core-stream-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await git(root,['init','--initial-branch=main']);
 const file=await fs.open(path.join(root,'large.bin'),'wx');const chunk=Buffer.alloc(1024*1024,0xa5),hash=createHash('sha256');
 try{for(let i=0;i<33;i++){await file.writeFile(chunk);hash.update(chunk);}}finally{await file.close();}
 const expected=hash.digest('hex'),captured=await blobFile(root,root,'large.bin');assert.equal(captured.digest,expected);assert.equal(captured.size,33*1024*1024);
 assert.equal(await blobDigest(root,captured.oid),expected);
 await assert.rejects(readSafeBytes(root,'large.bin'),{code:'TEXT_LIMIT'});
 const index=path.join(root,'.git','index');await updateIndexRows(root,index,[{rel:'large.bin',...captured}]);
 const tree=await str(root,['write-tree']),entries=await gitEntries(root,['ls-tree','-l','-z',tree]);assert.equal(Number(entries.get('large.bin')[3]),captured.size);
 const workspace=new ExecutionWorkspace({root:path.join(root,'.nozeli')}),m={repo:root};
 await workspace.installFile(m,{rel:'copy.bin',before:null,after:expected,mode:captured.mode,oid:captured.oid},false);
 assert.equal((await inspectFile(root,'copy.bin')).digest,expected);
 await workspace.installFile(m,{rel:'copy.bin',before:null,after:expected,beforeMode:null,beforeOid:null,mode:captured.mode,oid:captured.oid},true);
 assert.equal(await inspectFile(root,'copy.bin'),null);
 let bytes=0;await gitStream(root,['cat-file','blob',captured.oid],{output:new Writable({highWaterMark:4096,write(chunk,encoding,done){bytes+=chunk.length;setImmediate(done);}})});assert.equal(bytes,captured.size);
 const controller=new AbortController();await assert.rejects(gitStream(root,['cat-file','blob',captured.oid],{signal:controller.signal,onStdout(){controller.abort();}}));
 await assert.rejects(withSafeFile(root,'large.bin',async()=>{await fs.rename(path.join(root,'large.bin'),path.join(root,'moved.bin'));}),{code:'SOURCE_CHANGED'});
});

test('registered preparation resumes with the same bounded snapshot manifest',{skip:!['linux','darwin'].includes(process.platform)},async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-core-resume-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const content=path.join(root,'project'),data=path.join(root,'state');await fs.mkdir(content);await fs.writeFile(path.join(content,'a.txt'),'baseline');
 const store={root:data,content,projectId:'synthetic',state:{works:[{id:'resume'}]},storage:{requireOnline:async()=>{}}},workspace=new ExecutionWorkspace(store);
 const snapshot=workspace.snapshot.bind(workspace);workspace.snapshot=async()=>{throw Object.assign(new Error('synthetic interruption before input freeze'),{code:'SYNTHETIC_INTERRUPTION'});};
 await assert.rejects(workspace.prepare('resume'),{code:'SYNTHETIC_INTERRUPTION'});
 const registered=await workspace.readManifest('resume');assert.equal(registered.preparation,'registered');
 workspace.snapshot=snapshot;
 const resumed=await new ExecutionWorkspace(store).prepare('resume');assert.equal(resumed.preparation,'complete');assert.equal(resumed.directory,registered.directory);assert.equal(resumed.branchRef,registered.branchRef);assert.equal(resumed.baseCommit,registered.baseCommit);assert.equal(resumed.files['a.txt'].digest,createHash('sha256').update('baseline').digest('hex'));
 assert.equal(await fs.readFile(path.join(content,'a.txt'),'utf8'),'baseline');
});
