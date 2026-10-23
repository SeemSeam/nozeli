import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {staticReport} from './static-report.fixture.mjs';

// 回归焦点：
// P1 publish 本地 try 清理止步于 mutate.save —— state.json 落盘失败遗留
// object/manifest/artifacts 孤儿、重试换新 ID；P2 deviation 先写 body 后写
// manifest，manifest 失败遗留半成品 body。修复后：事务级回滚钩子仅在磁盘
// state.json 可读且确无对应收据（proven absent）时删除本事务自建文件；提交
// 结果不明/已提交时保留对象与已变更内存状态并上抛 commitUnknown hold；清理
// 失败以 rollbackFailures 附加在原始错误上，绝不静默、绝不替换原始错误。

async function fixture(t,{job=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-workspace-rollback-'));
  const store=await Workspace.open(path.join(root,'runtime'),path.join(root,'content'));
  const work=await store.submit('原始请求','任务简报',{name:'回滚验证'});
  await store.activate(work.id);
  if(job)store.state.jobs=[{id:'job-source',target:work.id,revision:1,status:'completed',text:'源任务文本',context:{}}];
  t.after(async()=>{await store.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true});});
  return {root,store,work};
}

async function listObjects(store){
  const dir=path.join(store.root,'objects');const out=[];
  const walk=async directory=>{for(const entry of await fs.readdir(directory,{withFileTypes:true})){const full=path.join(directory,entry.name);if(entry.isDirectory())await walk(full);else out.push(path.relative(dir,full));}};
  await walk(dir);return out.sort();
}

test('publish: state save failure before rename leaves no receipt/objects and restores exact state',async t=>{
  const {store,work}=await fixture(t);
  await fs.writeFile(path.join(store.content,'note.txt'),'artifact bytes');
  const html=staticReport('state save failure body');
  const priorState=structuredClone(store.state);
  const priorDisk=await fs.readFile(store.file);
  const priorObjects=await listObjects(store);
  const realSave=store.save.bind(store);
  store.save=async()=>{throw Object.assign(new Error('injected state save failure'),{code:'EINJECTED_SAVE'});};
  await assert.rejects(
    store.publish(work.id,1,'result',html,'receipt-save-fail',{files:[{relPath:'note.txt'}]}),
    error=>error.code==='EINJECTED_SAVE'&&!error.commitUnknown&&!error.rollbackFailures
  );
  store.save=realSave;
  assert.deepEqual(store.state,priorState,'in-memory state must be restored exactly (receipt/message/todo invisible)');
  assert.ok((await fs.readFile(store.file)).equals(priorDisk),'state.json on disk must be untouched');
  assert.deepEqual(await listObjects(store),priorObjects,'no orphan object/manifest/artifact files');
  const row=await store.publish(work.id,1,'result',html,'receipt-save-fail',{files:[{relPath:'note.txt'}]});
  assert.equal(row.id,'receipt-save-fail');
  assert.equal(store.state.receipts.length,1);
  assert.deepEqual(await listObjects(store),[`artifacts/${row.objectId}/note.txt`,`${row.objectId}.html`,`${row.objectId}.manifest.json`].sort());
  const replay=await store.publish(work.id,1,'result',html,'receipt-save-fail',{files:[{relPath:'note.txt'}]});
  assert.equal(replay.objectId,row.objectId,'retry reuses the same receipt instead of orphaning a new ID');
  assert.equal(store.state.receipts.length,1);
});

test('publish: save failure after rename keeps committed state and objects (commit unknown hold)',async t=>{
  const {store,work}=await fixture(t);
  const realSave=store.save.bind(store);
  store.save=async()=>{await realSave();throw Object.assign(new Error('injected post-rename failure'),{code:'EINJECTED_POST_RENAME'});};
  let hold=null;
  await assert.rejects(
    store.publish(work.id,1,'result',staticReport('post rename body'),'receipt-post-rename'),
    error=>{hold=error.commitUnknown;return error.code==='EINJECTED_POST_RENAME';}
  );
  store.save=realSave;
  assert.equal(hold?.scope,'publication');
  assert.equal(hold?.durable,'present');
  assert.equal(hold?.receiptId,'receipt-post-rename');
  const row=store.state.receipts.find(r=>r.id==='receipt-post-rename');
  assert.ok(row,'committed in-memory state is kept so failed settlement display can find the saved result');
  assert.equal(store.find(work.id).result.revision,1);
  const disk=JSON.parse(await fs.readFile(store.file,'utf8'));
  assert.ok(disk.receipts.some(r=>r.id==='receipt-post-rename'),'durable receipt exists');
  const objects=await listObjects(store);
  assert.ok(objects.includes(`${row.objectId}.html`),'objects must not be removed for a possibly committed receipt');
  assert.ok(objects.includes(`${row.objectId}.manifest.json`));
});

test('publish: unreadable durable state keeps everything and surfaces commit unknown',async t=>{
  const {root,store,work}=await fixture(t);
  const parked=path.join(root,'state.parked.json');
  const realSave=store.save.bind(store);
  store.save=async()=>{await realSave();await fs.rename(store.file,parked);throw Object.assign(new Error('injected state loss'),{code:'EINJECTED_STATE_LOSS'});};
  let hold=null;
  await assert.rejects(
    store.publish(work.id,1,'result',staticReport('unreadable state body'),'receipt-unreadable'),
    error=>{hold=error.commitUnknown;return error.code==='EINJECTED_STATE_LOSS';}
  );
  store.save=realSave;
  assert.equal(hold?.durable,'unknown');
  const row=store.state.receipts.find(r=>r.id==='receipt-unreadable');
  assert.ok(row,'no blind prior restore while durable outcome is unknown');
  assert.ok((await listObjects(store)).includes(`${row.objectId}.html`),'no cleanup when commit outcome is unknown');
  await fs.rename(parked,store.file);
});

test('deviation: Markdown body write failure removes partial object and restores exact state',async t=>{
  const {store,work}=await fixture(t,{job:true});
  const priorState=structuredClone(store.state);
  const priorDisk=await fs.readFile(store.file);
  const priorObjects=await listObjects(store);
  const objectsDir=path.join(store.root,'objects');
  const originalOpen=fs.open;
  const report=()=>store.reportDeviation(work.id,{id:'job-report',revision:1,context:{sourceJobId:'job-source'}},{changedGoal:'新目标',reason:'偏离原因',progress:'已有进展'},'deviation-receipt-1');
  try{
    fs.open=async(file,...args)=>{
      const handle=await originalOpen(file,...args);
      if(typeof file==='string'&&file.startsWith(objectsDir)&&file.endsWith('.md'))handle.writeFile=async()=>{throw Object.assign(new Error('injected body write failure'),{code:'EINJECTED_BODY'});};
      return handle;
    };
    await assert.rejects(report(),error=>error.code==='EINJECTED_BODY'&&!error.commitUnknown&&!error.rollbackFailures);
  }finally{fs.open=originalOpen;}
  assert.deepEqual(store.state,priorState);
  assert.ok((await fs.readFile(store.file)).equals(priorDisk));
  assert.deepEqual(await listObjects(store),priorObjects,'partial deviation body must not stay visible');
  assert.equal(store.deviationHeld(work.id),false);
  const event=await report();
  assert.equal(event.status,'pending');
  assert.equal(store.state.receipts.length,1);
  assert.equal(store.deviationHeld(work.id),true);
  assert.equal(store.find(work.id).status,'paused');
  const objects=await listObjects(store);
  assert.equal(objects.filter(f=>f.endsWith('.md')).length,1);
  assert.equal(objects.filter(f=>f.endsWith('.html')||f.endsWith('.manifest.json')).length,0,'deviation problem is a lightweight Markdown object without HTML/manifest');
});

test('deviation: state save failure removes both object files and restores exact state',async t=>{
  const {store,work}=await fixture(t,{job:true});
  const priorState=structuredClone(store.state);
  const priorDisk=await fs.readFile(store.file);
  const priorObjects=await listObjects(store);
  const realSave=store.save.bind(store);
  store.save=async()=>{throw Object.assign(new Error('injected deviation save failure'),{code:'EINJECTED_SAVE'});};
  await assert.rejects(
    store.reportDeviation(work.id,{id:'job-report',revision:1,context:{sourceJobId:'job-source'}},{changedGoal:'新目标',reason:'偏离原因',progress:'已有进展'},'deviation-receipt-2'),
    error=>error.code==='EINJECTED_SAVE'&&!error.commitUnknown
  );
  store.save=realSave;
  assert.deepEqual(store.state,priorState);
  assert.ok((await fs.readFile(store.file)).equals(priorDisk));
  assert.deepEqual(await listObjects(store),priorObjects,'both deviation object files must be rolled back');
  assert.equal(store.find(work.id).status,'running');
});

test('retainCandidate: invoked after validation, changeSetId override, evidence rollback only on proven-absent commit',async t=>{
  const {store,work}=await fixture(t);
  await fs.writeFile(path.join(store.content,'note.txt'),'artifact bytes');
  const html=staticReport('retain candidate body');
  let calls=0;const discarded=[];
  const retainCandidate=async()=>{calls++;return {changeSetId:'cs-retain-1',rollback:async()=>{discarded.push('cs-retain-1');}};};
  await assert.rejects(store.publish(work.id,1,'result','','receipt-invalid',{retainCandidate}),/invalid publication/);
  assert.equal(calls,0,'invalid report must not capture evidence');
  const realSave=store.save.bind(store);
  store.save=async()=>{throw Object.assign(new Error('injected save failure'),{code:'EINJECTED_SAVE'});};
  await assert.rejects(store.publish(work.id,1,'result',html,'receipt-retain',{files:[{relPath:'note.txt'}],retainCandidate}),error=>error.code==='EINJECTED_SAVE');
  store.save=realSave;
  assert.deepEqual(discarded,['cs-retain-1'],'proven-absent commit discards captured evidence exactly once');
  assert.equal(calls,1);
  assert.deepEqual(await listObjects(store),[]);
  const row=await store.publish(work.id,1,'result',html,'receipt-retain',{files:[{relPath:'note.txt'}],retainCandidate});
  assert.equal(row.changeSetId,'cs-retain-1');
  assert.deepEqual(discarded,['cs-retain-1']);
  const replay=await store.publish(work.id,1,'result',html,'receipt-retain',{files:[{relPath:'note.txt'}],retainCandidate});
  assert.equal(replay.objectId,row.objectId);
  assert.equal(calls,2,'receipt replay must not re-capture evidence');
  assert.equal(store.state.receipts.length,1);
});

test('retainCandidate rollback: skipped on unknown commit; failure surfaced without hiding original error',async t=>{
  const {store,work}=await fixture(t);
  const html=staticReport('evidence rollback body');
  const realSave=store.save.bind(store);
  const discarded=[];
  store.save=async()=>{await realSave();throw Object.assign(new Error('injected post-rename failure'),{code:'EINJECTED_POST_RENAME'});};
  await assert.rejects(
    store.publish(work.id,1,'result',html,'receipt-evidence-present',{retainCandidate:async()=>({changeSetId:'cs-present',rollback:async()=>{discarded.push('cs-present');}})}),
    error=>error.code==='EINJECTED_POST_RENAME'&&error.commitUnknown?.durable==='present'
  );
  store.save=realSave;
  assert.deepEqual(discarded,[],'evidence must not be discarded when commit outcome is present/unknown');
  const kept=store.state.receipts.find(r=>r.id==='receipt-evidence-present');
  assert.ok(kept);
  store.save=async()=>{throw Object.assign(new Error('injected save failure'),{code:'EINJECTED_SAVE'});};
  await assert.rejects(
    store.publish(work.id,1,'problem','# problem body\n\n等待用户决定。','receipt-evidence-fail',{retainCandidate:async()=>({rollback:async()=>{throw Object.assign(new Error('discard failed'),{code:'EINJECTED_DISCARD'});}})}),
    error=>{
      assert.equal(error.code,'EINJECTED_SAVE','original error must not be replaced');
      assert.equal(error.rollbackFailures?.length,1);
      assert.equal(error.rollbackFailures[0].code,'EINJECTED_DISCARD');
      return true;
    }
  );
  store.save=realSave;
  const objects=await listObjects(store);
  assert.deepEqual(objects,[`${kept.objectId}.html`,`${kept.objectId}.manifest.json`].sort(),'workspace-owned files of the failed attempt still cleaned; evidence failure surfaced, not silent');
});

test('publish: artifact changed after freeze fails before any write or capture',async t=>{
  const {store,work}=await fixture(t);
  await fs.writeFile(path.join(store.content,'note.txt'),'frozen bytes');
  const priorObjects=await listObjects(store);
  const priorDisk=await fs.readFile(store.file);
  let captures=0,activeCalls=0;
  const isActive=async()=>{activeCalls++;if(activeCalls===2)await fs.writeFile(path.join(store.content,'note.txt'),'changed bytes');return true;};
  await assert.rejects(
    store.publish(work.id,1,'result',staticReport('artifact flip body'),'receipt-flip',{files:[{relPath:'note.txt'}],isActive,retainCandidate:async()=>{captures++;return {};}}),
    /artifact changed during publication/
  );
  assert.equal(captures,0,'retainCandidate runs after the last artifact re-read, so nothing is captured');
  assert.deepEqual(await listObjects(store),priorObjects);
  assert.ok((await fs.readFile(store.file)).equals(priorDisk));
});

test('publish rollback: cleanup failure surfaced on the original error, remaining own files still removed',async t=>{
  const {store,work}=await fixture(t);
  await fs.writeFile(path.join(store.content,'note.txt'),'artifact bytes');
  const realSave=store.save.bind(store);
  store.save=async()=>{throw Object.assign(new Error('injected save failure'),{code:'EINJECTED_SAVE'});};
  const originalRm=fs.rm;let blocked=true;
  try{
    fs.rm=async(target,options)=>{
      const file=String(target);
      if(blocked&&file.endsWith('.html')&&file.startsWith(path.join(store.root,'objects')+path.sep)){blocked=false;throw Object.assign(new Error('injected rm failure'),{code:'EINJECTED_RM'});}
      return originalRm(target,options);
    };
    await assert.rejects(
      store.publish(work.id,1,'result',staticReport('cleanup failure body'),'receipt-rm-fail',{files:[{relPath:'note.txt'}]}),
      error=>{
        assert.equal(error.code,'EINJECTED_SAVE','original error must not be replaced by the cleanup failure');
        assert.equal(error.rollbackFailures?.length,1);
        assert.equal(error.rollbackFailures[0].code,'PUBLICATION_ROLLBACK_INCOMPLETE');
        return true;
      }
    );
  }finally{fs.rm=originalRm;}
  store.save=realSave;
  const objects=await listObjects(store);
  assert.deepEqual(objects.filter(f=>f.endsWith('.manifest.json')),[],'cleanup continues past the failed removal');
  assert.deepEqual(objects.filter(f=>f.startsWith('artifacts/')),[],'own artifact copies are removed');
  assert.equal(objects.filter(f=>f.endsWith('.html')).length,1,'the un-removable file stays visible via the surfaced failure, never silently dropped');
  assert.ok(!store.state.receipts.some(r=>r.id==='receipt-rm-fail'),'state stays rolled back');
});
