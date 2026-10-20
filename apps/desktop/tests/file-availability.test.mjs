import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {DesktopHost} from '../src/main/host.mjs';
import {readFileAvailability} from '../src/renderer/file-availability.mjs';

test('path checks distinguish absent, directory and unsafe links without writing or using listing',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-availability-'));
  try{
    const project=path.join(root,'project');await fs.mkdir(project);
    const host=new DesktopHost(path.join(root,'profile')),id=(await host.pick(project)).project.id;
    await fs.writeFile(path.join(project,'old.md'),'original');
    await fs.mkdir(path.join(project,'directory'));
    await fs.symlink(path.join(project,'old.md'),path.join(project,'link'));
    await fs.writeFile(path.join(root,'outside'),'private');await fs.symlink(path.join(root,'outside'),path.join(project,'escape'));
    const before=await fs.readdir(project),result=await host.fileAvailability(id,['old.md','nested/missing.md','directory','link','escape','../outside','old.md']);
    assert.deepEqual(result.entries.map(e=>e.status),['present','missing','unavailable','unavailable','unavailable','unavailable']);
    assert.deepEqual(await fs.readdir(project),before);
    const read=await host.readFile(id,'old.md');await host.draft(id,'old.md',read.digest,'retained local edits');
    await fs.rename(path.join(project,'old.md'),path.join(project,'new.md'));
    assert.equal((await host.fileAvailability(id,['old.md'])).entries[0].status,'missing');
    const restarted=new DesktopHost(path.join(root,'profile')),retained=await restarted.readFile(id,'old.md');
    assert.equal(retained.diskPresent,false);assert.equal(retained.draft.text,'retained local edits');
    assert.equal(await fs.readFile(path.join(project,'new.md'),'utf8'),'original');
    await fs.writeFile(path.join(project,'old.md'),'recreated');
    assert.equal((await restarted.fileAvailability(id,['old.md'])).entries[0].status,'present');
    assert.equal((await restarted.readFile(id,'old.md')).sourceChanged,true);
    await fs.rm(path.join(project,'old.md'));await fs.mkdir(path.join(project,'old.md'));
    await restarted.retainDraft(id,'old.md',read.digest,'retained through directory replacement');
    assert.equal((await restarted.readDraftRecord(id,'old.md')).text,'retained through directory replacement');
    assert.equal((await restarted.readFile(id,'old.md')).draft.text,'retained through directory replacement');
    assert.equal((await fs.stat(path.join(project,'old.md'))).isDirectory(),true);
    await assert.rejects(()=>restarted.retainDraft(id,'other.md',read.digest,'unbound'),e=>e.code==='BASELINE_UNKNOWN');
    await assert.rejects(()=>host.fileAvailability(id,new Array(501).fill('old.md')),e=>e.code==='INVALID_PAYLOAD');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('large reference sets are checked in bounded batches independently of tree truncation',async()=>{
  const calls=[],paths=Array.from({length:1004},(_,i)=>`file-${i}.md`);
  const result=await readFileAvailability(async(op,p)=>{calls.push(p.paths.length);assert.equal(op,'file.availability');return {ok:true,value:{entries:p.paths.map(relPath=>({relPath,status:'present'}))}};},'project',paths);
  assert.deepEqual(calls,[500,500,4]);assert.equal(result.size,1004);
  await assert.rejects(()=>readFileAvailability(async()=>({ok:false,error:{message:'unreadable'}}),'p',['f']),/unreadable/);
});
