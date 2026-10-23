import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Controller} from '../src/agents/managed/controller.mjs';

const page=(body)=>'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture report</title></head><body><main><h1>Fixture report</h1><p>'+body+'</p></main></body></html>';

// Actual Controller with a real execution worktree, a frozen candidate and a
// published result report whose manifest references notes.txt through a link.
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-accept-frozen-')),content=path.join(root,'project');
  await fs.mkdir(content);await fs.writeFile(path.join(content,'result.txt'),'original bytes');
  const options={runtimeRoot:path.join(root,'runtime'),contentRoot:content};
  const c=await Controller.open(options);const w=await c.store.submit('user task','worker brief',{name:'Alpha'});
  await c.store.activate(w.id);await c.execution.prepare(w.id);
  await fs.writeFile(path.join(c.execution.directory(w.id),'result.txt'),'candidate bytes');
  await fs.writeFile(path.join(c.execution.directory(w.id),'notes.txt'),'frozen note bytes');
  await c.execution.publish(c.store.find(w.id),{id:'report-job'},()=>true);
  await c.store.publish(w.id,1,'result',page('Source: <a href="notes.txt">notes</a> and result.txt.'),'report',{files:[{relPath:'result.txt'},{relPath:'notes.txt'}]});
  await c.store.settle(w.id);
  t.after(async()=>{if(!c.store.closed)await c.stop();await fs.rm(root,{recursive:true,force:true});});
  const receipt=c.store.state.receipts.find(r=>r.kind==='result'&&r.revision===1);
  assert.equal(receipt.snapshot.files.length,2);
  return {c,w:c.store.find(w.id),content,options,receipt,artifact:receipt.snapshot.artifactDirectory};
}

test('clean frozen report with manifest references is adopted',async t=>{
  const {c,w,content}=await fixture(t);
  await c.endWork(w.id,{revision:1,decision:'accept'});
  assert.equal(w.status,'ended');assert.equal(w.outcome,'accept');assert.equal(w.closure.phase,'complete');
  assert.equal(await fs.readFile(path.join(content,'result.txt'),'utf8'),'candidate bytes');
  assert.equal(await fs.readFile(path.join(content,'notes.txt'),'utf8'),'frozen note bytes');
  await assert.rejects(fs.stat(w.execution.directory),{code:'ENOENT'});
});

test('modified frozen snapshot bytes block adoption without current-file fallback',async t=>{
  const {c,w,content,artifact}=await fixture(t);
  await fs.writeFile(path.join(artifact,'result.txt'),'tampered bytes');
  await c.endWork(w.id,{revision:1,decision:'accept'});
  assert.equal(w.status,'ended');assert.equal(w.closure.phase,'blocked');
  assert.match(w.closure.error,/frozen report bytes/);
  assert.equal(await fs.readFile(path.join(content,'result.txt'),'utf8'),'original bytes');
  await assert.rejects(fs.stat(path.join(content,'notes.txt')),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(w.execution.directory,'result.txt'),'utf8'),'candidate bytes');
  await fs.writeFile(path.join(artifact,'result.txt'),'candidate bytes');
  await c.retryClosure(w.id);
  assert.equal(w.closure.phase,'complete');
  assert.equal(await fs.readFile(path.join(content,'result.txt'),'utf8'),'candidate bytes');
  assert.equal(await fs.readFile(path.join(content,'notes.txt'),'utf8'),'frozen note bytes');
});

test('deleted frozen reference artifact blocks adoption until restored',async t=>{
  const {c,w,content,artifact}=await fixture(t);
  await fs.unlink(path.join(artifact,'notes.txt'));
  await c.endWork(w.id,{revision:1,decision:'accept'});
  assert.equal(w.closure.phase,'blocked');assert.match(w.closure.error,/frozen report bytes/);
  assert.equal(await fs.readFile(path.join(content,'result.txt'),'utf8'),'original bytes');
  await assert.rejects(fs.stat(path.join(content,'notes.txt')),{code:'ENOENT'});
  await fs.writeFile(path.join(artifact,'notes.txt'),'frozen note bytes');
  await c.retryClosure(w.id);
  assert.equal(w.closure.phase,'complete');
  assert.equal(await fs.readFile(path.join(content,'result.txt'),'utf8'),'candidate bytes');
  assert.equal(await fs.readFile(path.join(content,'notes.txt'),'utf8'),'frozen note bytes');
});

test('manifest reference to bytes missing from the frozen snapshot blocks adoption',async t=>{
  const {c,w,content}=await fixture(t);
  await c.store.mutate(()=>{c.store.state.receipts.find(r=>r.id==='report').snapshot.files=c.store.state.receipts.find(r=>r.id==='report').snapshot.files.filter(f=>f.relPath!=='notes.txt');});
  await c.endWork(w.id,{revision:1,decision:'accept'});
  assert.equal(w.closure.phase,'blocked');assert.match(w.closure.error,/frozen report bytes/);
  assert.equal(await fs.readFile(path.join(content,'result.txt'),'utf8'),'original bytes');
  await assert.rejects(fs.stat(path.join(content,'notes.txt')),{code:'ENOENT'});
});
