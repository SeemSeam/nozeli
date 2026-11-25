import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createExperimentalWindowsPersistence as create, openExperimentalPersistenceParent as open} from '../src/platform/windows/experimental-persistence.mjs';
import {experimentalWindowsVersionedFilesystem as filesystem, experimentalWindowsReadFilesystem} from '../src/platform/windows/experimental-filesystem.mjs';
import {createFileStream} from '../src/agents/managed/file-stream.mjs';
import {ExecutionWorkspace} from '../src/agents/managed/execution-workspace.mjs';
import {selectFilesystemAdapter} from '../src/platform/shared/filesystem.mjs';
import {security} from './fixtures/windows-security.mjs';

const native = {skip:process.platform !== 'win32' || process.arch !== 'x64'};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const boundary = createFileStream({filesystem});
const options = (before, after) => ({expectedSha256:before===null?null:digest(before), expectedNewSha256:digest(after)});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-versioned-')), resources=[];
  t.after(async () => {for (const resource of resources.reverse()) resource.close(); await fs.rm(root,{recursive:true,force:true});});
  return {root, file:relative=>path.join(root,relative),
    parent() {const parent=open(root,'target'); resources.push(parent); return parent;},
    tx(parent) {const tx=parent.beginReplacement('target'); resources.push(tx); return tx;},
  };
}
function mutate(operation,...args) {
  const child=spawnSync(process.execPath,['-e',`try {require('node:fs')[process.argv[1]](...process.argv.slice(2));}
    catch(error) {console.log(error.code);process.exitCode=7;}`,operation,...args],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.ifError(child.error); assert.equal(child.signal,null); assert.equal(child.stderr,''); return child;
}

test('native streamed candidate keeps transaction state, hides chunks, flushes and preserves target ACL',native,async t=>{
  const f=await fixture(t); await fs.writeFile(f.file('target'),'base');
  const acl=security('inspect',f.file('target')), tx=f.tx(f.parent());
  assert.equal(tx.readChunk(1,2).toString(),'as'); assert.equal(tx.readChunk(4,2).length,0);
  assert.throws(()=>tx.writeCandidate(Buffer.from('x')),{code:'FS_TRANSACTION_STATE'});
  assert.throws(()=>tx.finishCandidate(),{code:'FS_TRANSACTION_STATE'});
  tx.beginCandidate('owned.pending');
  assert.throws(()=>tx.beginCandidate('other.pending'),{code:'FS_TRANSACTION_STATE'});
  assert.throws(()=>tx.prepare(Buffer.from('x'),'other.pending'),{code:'FS_TRANSACTION_STATE'});
  tx.writeCandidate(Buffer.alloc(1024*1024,0x5a)); tx.writeCandidate(Buffer.from('中文'));
  assert.equal(await fs.readFile(f.file('target'),'utf8'),'base');
  assert.deepEqual(await fs.readdir(f.root),['target']);
  assert.throws(()=>tx.commit(),{code:'FS_TRANSACTION_STATE'});
  tx.finishCandidate();
  assert.throws(()=>tx.readChunk(0,1),{code:'FS_TRANSACTION_STATE'});
  assert.throws(()=>tx.writeCandidate(Buffer.from('x')),{code:'FS_TRANSACTION_STATE'});
  tx.commit(); tx.close();
  assert.equal((await fs.stat(f.file('target'))).size,1024*1024+Buffer.byteLength('中文'));
  const after=security('inspect',f.file('target'));
  // AUTO_INHERITED SDDL bookkeeping may normalize; compare actual access
  // policy, including each inherited ACE, exactly as the native contract does.
  for(const key of ['owner','group','protected','rules']) assert.deepEqual(after[key],acl[key]);
});

test('native chunk input boundaries, wrong receivers and empty candidate do not bypass state checks',native,async t=>{
  const f=await fixture(t); await fs.writeFile(f.file('target'),'base'); const tx=f.tx(f.parent());
  for(const offset of [-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'0'])
    assert.throws(()=>tx.readChunk(offset,1),{code:'FS_READ_LIMIT'});
  for(const size of [0,-1,0.5,NaN,Infinity,1048577,'1'])
    assert.throws(()=>tx.readChunk(0,size),{code:'FS_READ_LIMIT'});
  assert.throws(()=>tx.readChunk(0),{code:'FS_READ_LIMIT'});
  assert.throws(()=>tx.beginCandidate('TARGET'),{code:'FS_NAME_REJECTED'});
  assert.throws(()=>tx.beginCandidate('../out'),{code:'FS_NAME_REJECTED'});
  for(const method of ['readChunk','beginCandidate','writeCandidate','finishCandidate'])
    assert.throws(()=>tx[method].call({},0,1),{code:'FS_HANDLE_REJECTED'});
  tx.beginCandidate('empty.pending');
  for(const bytes of ['x',new Uint16Array(1),new DataView(new ArrayBuffer(1)),new Uint8Array(new SharedArrayBuffer(1)),Buffer.alloc(1048577)])
    assert.throws(()=>tx.writeCandidate(bytes),{code:'FS_WRITE_LIMIT'});
  tx.writeCandidate(Buffer.alloc(0)); tx.finishCandidate(); tx.commit();
  assert.equal((await fs.stat(f.file('target'))).size,0);
  assert.throws(()=>tx.readChunk(0,1),{code:'FS_HANDLE_CLOSED'});
});

test('33 MiB base and candidate stream through locked CAS without whole-body transaction buffers',native,async t=>{
  const f=await fixture(t), chunk=Buffer.alloc(1024*1024,0xa5), next=Buffer.alloc(1024*1024,0x5a);
  const handle=await fs.open(f.file('target'),'wx'), oldHash=createHash('sha256'), newHash=createHash('sha256');
  try{for(let i=0;i<33;i++){await handle.writeFile(chunk);oldHash.update(chunk);newHash.update(next);}}finally{await handle.close();}
  const expected=oldHash.digest('hex'), wanted=newHash.digest('hex'); let produced=0;
  const result=await create(f.root).writeStream('target',(async function*(){for(let i=0;i<33;i++){produced++;yield next;}})(),{expectedSha256:expected,expectedNewSha256:wanted});
  assert.equal(result.state,'barriers-completed'); assert.equal(result.durability,'namespace-not-qualified');
  assert.equal(produced,33); const inspected=await boundary.inspectFile(f.root,'target');
  assert.equal(inspected.size,33*1024*1024); assert.equal(inspected.digest,wanted);
  assert.deepEqual(await fs.readdir(f.root),['target']);
});

test('producer failures roll back replacement/create and retain separately held recovery bytes',native,async t=>{
  const f=await fixture(t); await fs.writeFile(f.file('target'),'base'); await fs.writeFile(f.file('draft.recovery'),'candidate draft');
  for(const relative of ['target','new']){
    let closed=0;
    const source=(async function*(){try{yield Buffer.from('partial');throw Object.assign(Error('producer failed'),{code:'PRODUCER_FAILED'});}finally{closed++;}})();
    await assert.rejects(create(f.root).writeStream(relative,source,{expectedSha256:relative==='target'?digest('base'):null}),{code:'PRODUCER_FAILED'});
    assert.equal(closed,1); assert.equal(await fs.readFile(f.file('target'),'utf8'),'base');
    assert.equal(await fs.readFile(f.file('draft.recovery'),'utf8'),'candidate draft');
    assert.deepEqual((await fs.readdir(f.root)).sort(),['draft.recovery','target']);
  }
  await assert.rejects(create(f.root).writeStream('target',(async function*(){yield Buffer.from('partial');throw null;})(),{expectedSha256:digest('base')}),error=>error.code==='FS_WRITE_FAILED'&&error.cause===null);
  assert.equal(await fs.readFile(f.file('target'),'utf8'),'base');
  assert.equal(mutate('writeFileSync',f.file('target'),'released').status,0);
});

test('candidate mismatch, invalid source chunks and absent approval refuse publication',native,async t=>{
  const f=await fixture(t); await fs.writeFile(f.file('target'),'base');
  await assert.rejects(create(f.root).writeStream('target',[Buffer.from('candidate')],options('base','approved')),{code:'FS_CANDIDATE_CONFLICT'});
  for(const chunk of [1,'string',new Uint16Array(2),new Uint8Array(new SharedArrayBuffer(1))])
    await assert.rejects(create(f.root).writeStream('target',[chunk],{expectedSha256:digest('base')}),{code:'FS_WRITE_LIMIT'});
  for(const source of [null,'string',Buffer.from('not a chunk iterable')])
    await assert.rejects(create(f.root).writeStream('target',source),{code:'FS_WRITE_LIMIT'});
  await assert.rejects(boundary.writeVersioned(f.root,'target',Buffer.from('x'),{expectedSha256:digest('base')}),{code:'FS_VERSION_REJECTED'});
  assert.equal(await fs.readFile(f.file('target'),'utf8'),'base'); assert.deepEqual(await fs.readdir(f.root),['target']);
});

test('abort before or during chunk consumption retains old bytes and releases both create/CAS guards',native,async t=>{
  const f=await fixture(t); await fs.writeFile(f.file('target'),'base');
  const cancelled=new AbortController(); cancelled.abort();
  await assert.rejects(create(f.root).writeStream('absent/child',[],{signal:cancelled.signal}),{code:'ABORT_ERR'});
  for(const relative of ['target','new']){
    const controller=new AbortController(); let ended=false;
    const source=(async function*(){try{yield Buffer.from('first');controller.abort();yield Buffer.from('second');}finally{ended=true;}})();
    await assert.rejects(create(f.root).writeStream(relative,source,{expectedSha256:relative==='target'?digest('base'):null,signal:controller.signal}),{code:'ABORT_ERR'});
    assert.equal(ended,true); assert.equal(await fs.readFile(f.file('target'),'utf8'),'base');
    assert.deepEqual(await fs.readdir(f.root),['target']);
  }
  assert.equal(mutate('writeFileSync',f.file('target'),'released').status,0);
});

test('independent target writes and ancestor rename stay refused while streamed candidate is being produced',native,async t=>{
  const f=await fixture(t); await fs.writeFile(f.file('target'),'base');
  const source=(async function*(){
    for(let i=0;i<2;i++){
      for(const [operation,...args] of [['writeFileSync',f.file('target'),'racer'],['renameSync',f.root,f.root+'-moved']]){
        const result=mutate(operation,...args); assert.equal(result.status,7); assert.match(result.stdout.trim(),/^(EPERM|EACCES|EBUSY|UNKNOWN)$/);
      }
      yield Buffer.from('candidate');
    }
  })();
  await create(f.root).writeStream('target',source,options('base','candidatecandidate'));
  assert.equal(await fs.readFile(f.file('target'),'utf8'),'candidatecandidate');
});

test('shared reviewed-file application uses native versioned publication for large existing and new files',native,async t=>{
  const f=await fixture(t), before=Buffer.alloc(2*1024*1024,0x41), after=Buffer.alloc(2*1024*1024+3,0x42);
  await fs.writeFile(f.file('target'),before);
  const workspace=new ExecutionWorkspace({root:f.root},{filesystem});
  const plan=[{relPath:'target',fromDigest:digest(before),toDigest:digest(after),bytes:after},{relPath:'新 文件',fromDigest:null,toDigest:digest('new'),bytes:Buffer.from('new')}];
  await workspace.applyReviewedFiles({directory:f.root},plan);
  assert.deepEqual(await fs.readFile(f.file('target')),after); assert.equal(await fs.readFile(f.file('新 文件'),'utf8'),'new');
  await workspace.applyReviewedFiles({directory:f.root},plan);
  assert.deepEqual((await fs.readdir(f.root)).sort(),['target','新 文件'].sort());
  await assert.rejects(boundary.openWriteParent(f.root,'ordinary'),{code:'FS_PLATFORM_UNSUPPORTED'});
});

test('whole-plan drift refuses all writes and a winner arriving after preflight is retained by native CAS',native,async t=>{
  const f=await fixture(t); await fs.writeFile(f.file('first'),'base'); await fs.writeFile(f.file('target'),'external');
  const workspace=new ExecutionWorkspace({root:f.root},{filesystem});
  const plan=[{relPath:'first',fromDigest:digest('base'),toDigest:digest('draft'),bytes:Buffer.from('draft')},{relPath:'target',fromDigest:digest('base'),toDigest:digest('draft'),bytes:Buffer.from('draft')}];
  await assert.rejects(workspace.applyReviewedFiles({directory:f.root},plan),{code:'WORKTREE_DRIFT'});
  assert.equal(await fs.readFile(f.file('first'),'utf8'),'base');
  await fs.writeFile(f.file('target'),'base');
  const raced={...filesystem,async writeVersioned(...args){assert.equal(mutate('writeFileSync',f.file('target'),'external winner').status,0);return filesystem.writeVersioned(...args);}};
  const consumer=new ExecutionWorkspace({root:f.root},{filesystem:raced});
  await assert.rejects(consumer.applyReviewedFiles({directory:f.root},[plan[1]]),error=>error.code==='WORKTREE_DRIFT'&&!error.committed);
  assert.equal(await fs.readFile(f.file('target'),'utf8'),'external winner');
  assert.equal(plan[1].bytes.toString(),'draft'); assert.deepEqual((await fs.readdir(f.root)).sort(),['first','target']);
  await fs.writeFile(f.file('target'),'base');
  const laterRace={...filesystem,async writeVersioned(...args){if(args[1]==='target')assert.equal(mutate('writeFileSync',f.file('target'),'later external').status,0);return filesystem.writeVersioned(...args);}};
  await assert.rejects(new ExecutionWorkspace({root:f.root},{filesystem:laterRace}).applyReviewedFiles({directory:f.root},plan),error=>{
    assert.equal(error.code,'WORKTREE_DRIFT'); assert.equal(error.committed,true); assert.equal(error.durability,'uncertain');
    assert.deepEqual(error.appliedFiles,[{relPath:'first',candidateDigest:digest('draft')}]); return true;
  });
  assert.equal(await fs.readFile(f.file('first'),'utf8'),'draft'); assert.equal(await fs.readFile(f.file('target'),'utf8'),'later external');
});

test('shared candidate approval mismatch keeps original target and caller-held draft',native,async t=>{
  const f=await fixture(t); await fs.writeFile(f.file('target'),'base'); const draft=Buffer.from('actual draft');
  const workspace=new ExecutionWorkspace({root:f.root},{filesystem});
  await assert.rejects(workspace.applyReviewedFiles({directory:f.root},[{relPath:'target',fromDigest:digest('base'),toDigest:digest('different approved bytes'),bytes:draft}]),{code:'FS_CANDIDATE_CONFLICT'});
  assert.equal(await fs.readFile(f.file('target'),'utf8'),'base'); assert.equal(draft.toString(),'actual draft');
  assert.deepEqual(await fs.readdir(f.root),['target']);
});

test('streamed post-publication barrier failure retains committed bytes and never replays the source',native,async t=>{
  const f=await fixture(t); await fs.writeFile(f.file('target'),'base');
  for(const relative of ['target','new']){
    let consumed=0;
    const adapter=create(f.root,{directorySync:parent=>{parent.close();parent.syncDirectory();}});
    const source=(async function*(){consumed++;yield Buffer.from('published');})();
    await assert.rejects(adapter.writeStream(relative,source,options(relative==='target'?'base':null,'published')),error=>error.code==='FS_HANDLE_CLOSED'&&error.committed===true&&error.durability==='uncertain');
    assert.equal(consumed,1); assert.equal(await fs.readFile(f.file(relative),'utf8'),'published');
  }
  assert.deepEqual((await fs.readdir(f.root)).sort(),['new','target']);
});

test('managed Windows writes reject metadata case equivalents, aliases, reserved names and default adapters',native,async t=>{
  const f=await fixture(t);
  for(const relative of ['.GiT/config','.NoZeLi/state','.Gıt/config','.ccB/state','CREDENTIALS.json','con','NUL.txt','COM¹.bin','conout$','con .txt','LPT1 .x','dir~1/file','a:stream','../escape'])
    await assert.rejects(boundary.writeVersioned(f.root,relative,Buffer.from('x'),options(null,'x')),{code:'PATH_REJECTED'},relative);
  assert.deepEqual(await fs.readdir(f.root),[]);
  await fs.writeFile(f.file('first'),'base');
  const workspace=new ExecutionWorkspace({root:f.root},{filesystem});
  await assert.rejects(workspace.applyReviewedFiles({directory:f.root},[
    {relPath:'first',fromDigest:digest('base'),toDigest:digest('draft'),bytes:Buffer.from('draft')},
    {relPath:'.GiT/config',fromDigest:null,toDigest:digest('x'),bytes:Buffer.from('x')},
  ]),{code:'PATH_REJECTED'});
  assert.equal(await fs.readFile(f.file('first'),'utf8'),'base'); assert.deepEqual(await fs.readdir(f.root),['first']);
  assert.equal(selectFilesystemAdapter().supported,false);
  await assert.rejects(createFileStream().writeVersioned(f.root,'target',Buffer.from('x'),options(null,'x')),{code:'FS_PLATFORM_UNSUPPORTED'});
  await assert.rejects(createFileStream({filesystem:experimentalWindowsReadFilesystem}).writeVersioned(f.root,'target',Buffer.from('x'),options(null,'x')),{code:'FS_PLATFORM_UNSUPPORTED'});
});

test('shared post-publication verification failure preserves the external winner and committed uncertainty',native,async t=>{
  const f=await fixture(t); await fs.writeFile(f.file('target'),'base');
  const raced={...filesystem,async writeVersioned(...args){const receipt=await filesystem.writeVersioned(...args);assert.equal(mutate('writeFileSync',f.file('target'),'later winner').status,0);return receipt;}};
  const workspace=new ExecutionWorkspace({root:f.root},{filesystem:raced});
  await assert.rejects(workspace.applyReviewedFiles({directory:f.root},[{relPath:'target',fromDigest:digest('base'),toDigest:digest('draft'),bytes:Buffer.from('draft')}]),error=>error.code==='WORKTREE_DRIFT'&&error.committed===true&&error.durability==='uncertain');
  assert.equal(await fs.readFile(f.file('target'),'utf8'),'later winner'); assert.deepEqual(await fs.readdir(f.root),['target']);
});

test('a naturally exiting host with a live streaming candidate rolls back and releases all guards',native,async t=>{
  const f=await fixture(t); await fs.writeFile(f.file('target'),'base');
  const loader=new URL('../src/platform/windows/experimental-persistence.mjs',import.meta.url).href;
  const code=`const {openExperimentalPersistenceParent:open}=await import(process.argv[1]);
    globalThis.parent=open(process.argv[2],'target');globalThis.tx=parent.beginReplacement('target');
    tx.beginCandidate('owned.pending');tx.writeCandidate(Buffer.from('uncommitted'));console.log('written');`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code,loader,f.root],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.ifError(child.error); assert.equal(child.status,0,child.stderr); assert.equal(child.stdout.trim(),'written');
  assert.equal(await fs.readFile(f.file('target'),'utf8'),'base'); assert.deepEqual(await fs.readdir(f.root),['target']);
  assert.equal(mutate('writeFileSync',f.file('target'),'released').status,0);
});
