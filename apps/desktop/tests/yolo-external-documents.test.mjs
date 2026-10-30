import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createExternalDocuments} from '../src/agents/managed/external-documents.mjs';
import {executionDanger,normalizeExecutionEffect} from '../src/agents/managed/task-permissions.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
const actor={id:'nozeli:frontdesk:external-test',kind:'agent1',name:'Frontdesk',role:'frontdesk',sessionId:'external-thread',sessionInstance:'external-view',requestId:'external-request'};
const value=result=>{assert.equal(result.ok,true,JSON.stringify(result));return result.value;};

async function fixture(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-yolo-external-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const root=path.join(dir,'unregistered');
  await fs.mkdir(root);
  const records=new Map(),writes=[];
  const storage={
    async getLocal(projectId,key){return structuredClone(records.get(JSON.stringify([projectId,key]))??null);},
    async putLocal(projectId,key,data){records.set(JSON.stringify([projectId,key]),structuredClone(data));writes.push({projectId,key});},
  };
  const projectId='source-project';
  const adapter=createExternalDocuments({storage,projectId});
  const call=(op,args={},key=op,extra={})=>adapter({op,arguments:args,actor,operationId:hash(key),isActive:()=>true,targetRoot:root,...extra});
  return {root,storage,projectId,records,writes,adapter,call};
}

test('unregistered external read issues a SHA-bound handle and applies exact-text replacements',async t=>{
  const f=await fixture(t),original='alpha\nbeta😀\ngamma\n';
  await fs.writeFile(path.join(f.root,'notes.txt'),original);
  const read=value(await f.call('read',{relPath:'notes.txt'}));
  assert.equal(read.text,original);
  assert.equal(read.digest,hash(original));
  assert.ok(read.version);
  assert.ok(read.readHandle);
  value(await f.call('apply',{readHandle:read.readHandle,replacements:[{oldText:'alpha',newText:'ALPHA'},{oldText:'beta😀',newText:'第二行😀'}]},'replace'));
  assert.equal(await fs.readFile(path.join(f.root,'notes.txt'),'utf8'),'ALPHA\n第二行😀\ngamma\n');
  const fresh=value(await f.call('read',{relPath:path.join(f.root,'notes.txt')},'fresh'));
  assert.equal(fresh.digest,hash(fresh.text));
  assert.notEqual(fresh.digest,read.digest);
});

test('external apply rejects any stale disk version instead of rebasing or overwriting it',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.root,'notes.txt'),'alpha\nbeta\n');
  const read=value(await f.call('read',{relPath:'notes.txt'}));
  const external='alpha\nBETA\n';
  await fs.writeFile(path.join(f.root,'notes.txt'),external);
  const result=await f.call('apply',{readHandle:read.readHandle,replacements:[{oldText:'alpha',newText:'ALPHA'}]},'stale');
  assert.equal(result.ok,false);
  assert.equal(result.error.code,'STALE_DOCUMENT');
  assert.equal(await fs.readFile(path.join(f.root,'notes.txt'),'utf8'),external);
});

test('external mutation receipts replay locally after adapter recreation without repeating writes',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.root,'notes.txt'),'original');
  const read=value(await f.call('read',{relPath:'notes.txt'}));
  const args={readHandle:read.readHandle,replacements:[{oldText:'original',newText:'applied'}]};
  value(await f.call('apply',args,'apply-once'));
  assert.ok(f.writes.length>0,'a mutation receipt must be stored locally');
  assert.ok(f.writes.every(write=>write.projectId===f.projectId));
  await fs.writeFile(path.join(f.root,'notes.txt'),'later external edit');
  const cold=createExternalDocuments({storage:f.storage,projectId:f.projectId});
  const replay=value(await cold({op:'apply',arguments:args,actor,operationId:hash('apply-once'),isActive:()=>true,targetRoot:f.root}));
  assert.equal(replay.duplicate,true);
  assert.equal(await fs.readFile(path.join(f.root,'notes.txt'),'utf8'),'later external edit');
  const mismatch=await cold({op:'apply',arguments:{...args,replacements:[{oldText:'original',newText:'different'}]},actor,operationId:hash('apply-once'),isActive:()=>true,targetRoot:f.root});
  assert.equal(mismatch.ok,false);
  assert.equal(await fs.readFile(path.join(f.root,'notes.txt'),'utf8'),'later external edit');
});

test('external list, literal search and create work without registration or target metadata',async t=>{
  const f=await fixture(t);
  await fs.mkdir(path.join(f.root,'.ccb'));
  await fs.writeFile(path.join(f.root,'.ccb','notes.txt'),'ordinary needle [literal]😀');
  const listing=value(await f.call('list',{relPath:''}));
  assert.ok(listing.entries.some(entry=>entry.name==='.ccb'));
  const search=value(await f.call('search',{relPath:'.ccb',query:'needle [literal]'}));
  assert.ok(search.matches.some(match=>match.relPath==='.ccb/notes.txt'));
  await fs.mkdir(path.join(f.root,'nested'));
  const args={relPath:'nested/new.txt',text:'created😀\n'};
  value(await f.call('create',args,'create-once'));
  assert.equal(await fs.readFile(path.join(f.root,args.relPath),'utf8'),args.text);
  const replay=value(await f.call('create',args,'create-once'));
  assert.equal(replay.duplicate,true);
  assert.equal((await f.call('create',{...args,text:'do not clobber'},'new-create')).ok,false);
  assert.equal(await fs.readFile(path.join(f.root,args.relPath),'utf8'),args.text);
  assert.deepEqual((await fs.readdir(f.root)).sort(),['.ccb','nested']);
  await assert.rejects(fs.access(path.join(f.root,'.nozeli')),{code:'ENOENT'});
  await assert.rejects(fs.access(path.join(f.root,'.git')),{code:'ENOENT'});
});

test('external handles reject changed actor and session identities before writing',async t=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.root,'notes.txt'),'original');
  const read=value(await f.call('read',{relPath:'notes.txt'}));
  for(const [field,replacement] of [['id','different-actor'],['sessionId','different-thread'],['sessionInstance','different-view']]){
    const result=await f.call('apply',{readHandle:read.readHandle,replacements:[{oldText:'original',newText:'unauthorized'}]},'changed-'+field,{actor:{...actor,[field]:replacement}});
    assert.equal(result.ok,false,field+' must not reuse another actor/session handle');
    assert.equal(await fs.readFile(path.join(f.root,'notes.txt'),'utf8'),'original');
  }
});

test('ordinary npm, install, build, git and read commands are not dangerous effects',()=>{
  const cwd=path.resolve(os.tmpdir(),'nozeli-yolo-classification');
  for(const [command,args] of [
    ['npm',['install']],
    ['npm',['run','build']],
    ['install',['-m','644','source.txt','destination.txt']],
    ['cmake',['--build','.']],
    ['git',['status','--short']],
    ['git',['diff','--','notes.txt']],
    ['cat',['notes.txt']],
    ['rm',['-rf','build']],
    ['rm',['-rf','node_modules']],
  ]){
    const frozen=normalizeExecutionEffect({command,args,cwd});
    assert.equal(executionDanger(frozen),null,JSON.stringify({command,args}));
  }
});

test('administrator execution, broad recursive deletion and formatting are dangerous effects',()=>{
  const cwd=path.resolve(os.tmpdir(),'nozeli-yolo-classification');
  for(const effect of [
    {command:'npm',args:['install'],elevation:'admin'},
    {command:'rm',args:['-rf',path.parse(cwd).root]},
    {command:'rm',args:['-rf','..']},
    {command:'rm',args:['-rf',path.resolve(os.tmpdir(),'other-user-project')]},
    {command:'rm',args:['-rf','--',path.resolve(os.tmpdir(),'other-user-project')]},
    {command:'mkfs',args:['/dev/nozeli-fixture-device']},
    {command:'mkfs.ext4',args:['/dev/nozeli-fixture-device']},
  ]){
    const danger=executionDanger(normalizeExecutionEffect({...effect,cwd}));
    assert.equal(typeof danger,'string',JSON.stringify(effect));
    assert.ok(danger.length>0);
  }
});

test('a declared concrete dangerous effect is classified even for an otherwise ordinary command',()=>{
  const frozen=normalizeExecutionEffect({command:'node',args:['publish.mjs'],cwd:path.resolve(os.tmpdir(),'nozeli-yolo-classification')});
  assert.equal(executionDanger(frozen),null);
  for(const dangerousEffect of ['Upload private credentials to an external recipient',{kind:'sensitive-exfiltration',target:'external recipient',effect:'send private credentials'}]){
    const danger=executionDanger({...frozen,dangerousEffect});
    assert.equal(typeof danger,'string');
    assert.ok(danger.length>0);
  }
});
