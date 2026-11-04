import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {recoveryRead,managedResourceSummary} from '../src/main/storage-recovery.mjs';
import {exportNativeChunks,recoveryReference} from '../src/main/recovery-export.mjs';

const scope={projectId:'synthetic-project',instanceId:'synthetic-instance',purpose:'test'};
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nozeli-bounded-recovery-')),file=path.join(dir,'copy.sqlite'),db=new DatabaseSync(file);db.exec('CREATE TABLE records(collection TEXT,id TEXT,value TEXT,revision INTEGER DEFAULT 1,PRIMARY KEY(collection,id))');return {db,file,close(){db.close();fs.rmSync(dir,{recursive:true,force:true});}};}
function put(db,id,value,collection='recovery'){db.prepare('INSERT INTO records(collection,id,value) VALUES(?,?,?)').run(collection,id,JSON.stringify(value));}
const page=(db,options={})=>recoveryRead(db,'synthetic-inode','recoveryPage',{...scope,...options});

test('220MiB recovery copy pages only bounded scalar summaries, retains huge/corrupt/unknown without writes',()=>{
 const f=fixture();try{
  const payload='界'.repeat(350000),insert=f.db.prepare('INSERT INTO records(collection,id,value) VALUES(?,?,?)');
  f.db.exec('BEGIN');for(let i=0;i<220;i++)insert.run('recovery','workspace:'+String(i).padStart(4,'0'),JSON.stringify({kind:'draft',status:'retained',relPath:'file-'+i,model:payload,candidate:{text:payload.slice(0,30000)}}));f.db.exec('COMMIT');
  put(f.db,'workspace:huge',{kind:'draft',status:'future-status',candidate:'x'.repeat(9*1024*1024)});
  insert.run('recovery','workspace:bad','{bad json');put(f.db,'workspace:unknown',{kind:'future-kind',status:'future-status',collections:{private:['do not project']}});
  const before=f.db.prepare('SELECT count(*) n,sum(length(CAST(value AS BLOB))) bytes,total_changes() changes FROM records').get();assert.ok(before.bytes>200*1024*1024&&before.bytes<300*1024*1024);
  let cursor=null,count=0,sawBad=false,sawHuge=false,sawUnknown=false;
  do{const result=page(f.db,{cursor,limit:17,maxBytes:8192});assert.ok(Buffer.byteLength(JSON.stringify(result))<=8192);assert.ok(result.entries.length<=17);
   for(const row of result.entries){count++;assert.equal(row.value.candidate,undefined);assert.equal(row.value.collections,undefined);assert.equal(row.value.model,undefined);if(row.id==='workspace:bad'){sawBad=true;assert.equal(row.value.corrupt,true);}if(row.id==='workspace:huge'){sawHuge=true;assert.equal(row.value.needsCheck,true);}if(row.id==='workspace:unknown'){sawUnknown=true;assert.equal(row.value.needsCheck,true);}}
   cursor=result.nextCursor;
  }while(cursor);
  assert.equal(count,223);assert.ok(sawBad&&sawHuge&&sawUnknown);
  assert.throws(()=>recoveryRead(f.db,'synthetic-inode','recoveryRecord',{...scope,id:'workspace:huge'}),{code:'RECOVERY_RECORD_TOO_LARGE'});
  assert.throws(()=>recoveryRead(f.db,'synthetic-inode','recoveryRecord',{...scope,id:'workspace:bad'}),{code:'RECOVERY_RECORD_CORRUPT'});
  assert.deepEqual(f.db.prepare('SELECT count(*) n,sum(length(CAST(value AS BLOB))) bytes,total_changes() changes FROM records').get(),before);
 }finally{f.close();}
});

test('cursor binds incarnation, changes, scope; UTF8 chunks preserve exact raw bytes',()=>{
 const f=fixture();try{
  put(f.db,'a',{kind:'draft',status:'retained',text:'界🙂'.repeat(400)});put(f.db,'b',{status:'pending'});
  const first=page(f.db,{limit:1});assert.ok(first.nextCursor);
  assert.throws(()=>page(f.db,{cursor:first.nextCursor,projectId:'another'}),{code:'RECOVERY_CURSOR_INVALID'});
  assert.throws(()=>page(f.db,{cursor:first.nextCursor,instanceId:'another'}),{code:'RECOVERY_CURSOR_INVALID'});
  assert.throws(()=>page(f.db,{cursor:first.nextCursor,purpose:'other'}),{code:'RECOVERY_CURSOR_INVALID'});
  assert.throws(()=>page(f.db,{cursor:first.nextCursor,prefixes:['a']}),{code:'RECOVERY_CURSOR_INVALID'});
  const row=first.entries[0],parts=[];let offset=0;do{const chunk=recoveryRead(f.db,'synthetic-inode','recoveryChunk',{...scope,id:row.id,revision:row.revision,version:first.version,offset,maxBytes:7});assert.ok(chunk.bytes.length<=7);parts.push(Buffer.from(chunk.bytes));offset=chunk.nextOffset;if(offset===chunk.total)break;}while(true);
  assert.deepEqual(Buffer.concat(parts),Buffer.from(f.db.prepare("SELECT value FROM records WHERE id='a'").get().value));
  f.db.prepare("UPDATE records SET revision=revision+1 WHERE id='a'").run();
  assert.throws(()=>page(f.db,{cursor:first.nextCursor}),{code:'RECOVERY_CURSOR_INVALID'});
  assert.throws(()=>recoveryRead(f.db,'synthetic-inode','recoveryRecord',{...scope,id:'a',revision:1}),{code:'RECOVERY_REVISION_CHANGED'});
  const fresh=page(f.db,{limit:1}),other=new DatabaseSync(f.file);try{other.prepare("UPDATE records SET revision=revision+1 WHERE id='b'").run();assert.throws(()=>page(f.db,{cursor:fresh.nextCursor}),{code:'RECOVERY_CURSOR_INVALID'});assert.throws(()=>recoveryRead(other,'synthetic-inode','recoveryPage',{...scope,cursor:fresh.nextCursor}),{code:'RECOVERY_CURSOR_INVALID'});}finally{other.close();}
 }finally{f.close();}
});

test('pending SQL honors settled receipt overwrite/message evidence, unknown and corrupt stay visible',()=>{
 const f=fixture();try{
  put(f.db,'managed:pending:a',{kind:'business',status:'committed',collections:{managed_receipts:[{id:'receipt',value:{report:{digest:'a'.repeat(64)}}}],managed_messages:[{id:'m'}]}});
  put(f.db,'managed:pending:z',{kind:'business',status:'reconciled',collections:{managed_receipts:[{id:'receipt',value:{report:{digest:'b'.repeat(64)}}}],managed_messages:[{id:'m2'}]}});
  put(f.db,'managed:pending:native',{kind:'business',status:'pending',nativeMessageIds:['m','m2']});
  put(f.db,'managed:publication:new',{kind:'publication',status:'pending',receiptId:'receipt',report:{digest:'b'.repeat(64)}});
  put(f.db,'managed:publication:old',{kind:'publication',status:'pending',receiptId:'receipt',report:{digest:'a'.repeat(64)}});
  put(f.db,'managed:publication:unbound',{kind:'publication',status:'pending'});
  put(f.db,'managed:pending:unknown',{kind:'future',status:'future',nativeMessageIds:['m']});
  f.db.prepare("INSERT INTO records(collection,id,value) VALUES('recovery','managed:pending:bad','not json')").run();
  put(f.db,'workspace:draft',{status:'retained',relPath:'界'.repeat(200)});
  const result=page(f.db,{pendingOnly:true}),ids=result.entries.map(row=>row.id);
  assert.equal(result.entries.find(row=>row.id==='managed:publication:unbound').value.needsCheck,true);
  const draft=result.entries.find(row=>row.id==='workspace:draft').value;assert.equal(draft.relPath.length,128);assert.equal(draft.relPathTruncated,true);
  assert.ok(ids.includes('managed:pending:a'));assert.ok(ids.includes('managed:publication:old'));assert.ok(ids.includes('managed:pending:unknown'));assert.ok(ids.includes('managed:pending:bad'));assert.ok(ids.includes('workspace:draft'));
  assert.ok(!ids.includes('managed:pending:native'));assert.ok(!ids.includes('managed:publication:new'));assert.ok(!ids.includes('managed:pending:z'));
 }finally{f.close();}
});

test('resource summaries count online records/offline row-value cache without managed hydration',()=>{
 const f=fixture();try{
  const works=[{id:'a',status:'running',revision:1},{id:'b',status:'queued',revision:1},{id:'c',status:'ended',revision:2},{id:'d',status:'unknown',revision:3},{id:'e',status:'running',revision:0}];
  put(f.db,'limit',4,'managed_settings');for(const work of works)put(f.db,work.id,work,'managed_works');
  put(f.db,'managed:cache:settings',{limit:4},'ui');put(f.db,'managed:cache:works',works.map(value=>({id:value.id,value})),'ui');
  for(const options of [{},{offline:true}]){
   const summary=managedResourceSummary(f.db,options);
   assert.equal(summary.limit,4);assert.equal(summary.used,2);
   assert.equal(summary.pendingVerification,1,'unknown Work remains protected instead of being presented as free capacity');
  }
 }finally{f.close();}
});

test('native complete exports preserve multi-chunk UTF8 bytes and never overwrite existing destinations',async()=>{
 const f=fixture();try{
  const bytes=Buffer.from('界🙂\u0000\\\"\n'.repeat(40000)),target=path.join(path.dirname(f.file),'complete.json'),scope={generation:1,dead:false};
  const options={dialog:{showSaveDialog:async()=>({filePath:target})},scope,defaultName:'complete.json',expectedTotal:bytes.length,readChunk:async offset=>{const chunk=bytes.subarray(offset,offset+65536);return {bytes:chunk,offset,nextOffset:offset+chunk.length,total:bytes.length};}};
  assert.deepEqual(await exportNativeChunks(options),{exported:true,byteLength:bytes.length});assert.deepEqual(fs.readFileSync(target),bytes);
  await assert.rejects(exportNativeChunks(options),{code:'EEXIST'});assert.deepEqual(fs.readFileSync(target),bytes);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)).sort(),['complete.json','copy.sqlite']);
 }finally{f.close();}
});

test('changed scope or failed final source validation cannot publish partial native export',async()=>{
 const f=fixture();try{
  const target=path.join(path.dirname(f.file),'partial.json'),scope={generation:1,dead:false};
  const options={dialog:{showSaveDialog:async()=>({filePath:target})},scope,defaultName:'partial.json',expectedTotal:3,readChunk:async offset=>({bytes:Buffer.from('原'),offset,nextOffset:3,total:3})};
  await assert.rejects(exportNativeChunks({...options,finalize:async()=>{throw Object.assign(Error('changed source'),{code:'SOURCE_CHANGED'});}}),{code:'SOURCE_CHANGED'});
  await assert.rejects(exportNativeChunks({...options,readChunk:async offset=>{scope.generation++;return options.readChunk(offset);}}),{code:'RECOVERY_EXPORT_CHANGED'});
  assert.equal(fs.existsSync(target),false);assert.deepEqual(fs.readdirSync(path.dirname(f.file)),['copy.sqlite']);
 }finally{f.close();}
});

test('retained reference authority comes from exact receipt identity rather than supplied digest',()=>{
 const report={digest:'a'.repeat(64)},value={collections:{managed_receipts:[{id:'owner',value:{report}}]}};
 assert.equal(recoveryReference(value,{reference:'receipt',receiptId:'owner'}),report);
 assert.throws(()=>recoveryReference(value,{reference:'receipt',receiptId:'other',digest:report.digest}),{code:'RECOVERY_REFERENCE_DENIED'});
});
