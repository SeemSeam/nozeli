import test from 'node:test';
import assert from 'node:assert/strict';
import {createReadEvidenceJournal,readEvidenceFrames,READ_EVIDENCE_MAX_RECORDS} from '../../../integrations/pi/src/read-evidence-journal.mjs';

const MiB=1024*1024;
function fixture(t,{failure}={}){
 const chunks=[],syncs=[];let size=0;
 const lease={created:true,verify(){},close(){},stat:()=>({identity:'file',size:BigInt(size)}),
  append(bytes,offset){assert.equal(offset,size);assert.ok(bytes.length<=MiB);chunks.push(Buffer.from(bytes));size+=bytes.length;if(failure==='append')throw Error('synthetic append failure');},
  sync(){if(failure==='sync')throw Error('synthetic sync failure');syncs.push('file');}};
 const parent={identity:()=> 'parent',verify(){},close(){},openPrivateJournal:()=>lease};
 const agent={verify(){},close(){},openPrivateDirectory:()=>parent};
 const journal=createReadEvidenceJournal({openAgent:()=>agent,member:'reads',streamId:'stream',schema:1,mechanism:'test',directory:'reads',byteLimit:8*MiB,directorySync:handle=>syncs.push(handle===parent?'parent':'agent')});
 t.after(()=>journal.close());
 return {journal,chunks,syncs,bytes:()=>Buffer.concat(chunks)};
}

test('128th private read commits one batch; a later durable tail cannot change an earlier head',t=>{
 const {journal,chunks,syncs,bytes}=fixture(t);
 for(let i=0;i<127;i++)journal.retain({i},null);
 assert.deepEqual(chunks,[]);assert.deepEqual(syncs,[]);
 journal.retain({i:127},Buffer.from('first'));
 assert.deepEqual(syncs,['file','parent','agent']);
 const head=journal.snapshot();assert.equal(head.reads,128);
 journal.retain({},Buffer.from('tail'));journal.flush();
 const file=bytes(),prefix=[...readEvidenceFrames(file,head.headBytes,MiB)];
 assert.equal(prefix.at(-1).headSha256,head.headSha256);assert.equal(prefix.at(-1).bytes.toString(),'first');
 assert.equal([...readEvidenceFrames(file,file.length,MiB)].at(-1).bytes.toString(),'tail');
 assert.throws(()=>[...readEvidenceFrames(file,head.headBytes-1,MiB)]);
 file[head.headBytes-1]^=1;assert.throws(()=>[...readEvidenceFrames(file,head.headBytes,MiB)]);
});

test('byte threshold flushes queued reads and splits a large frame at the native append bound',t=>{
 const {journal,chunks,syncs,bytes}=fixture(t);
 journal.retain({},Buffer.alloc(MiB-1024,1));assert.deepEqual(syncs,[]);
 journal.retain({},Buffer.alloc(MiB+17,2));
 assert.deepEqual(syncs,['file','parent','agent','file']);
 assert.equal(chunks.length,3);assert.equal(chunks[1].length,MiB);
 const head=journal.snapshot(),frames=[...readEvidenceFrames(bytes(),head.headBytes,8*MiB)];
 assert.equal(frames.length,2);assert.equal(frames[1].bytes.length,MiB+17);assert.equal(frames[1].headSha256,head.headSha256);
});

for(const failure of ['append','sync'])test(`${failure} failure poisons read evidence without confirming or replaying writes`,t=>{
 const {journal,chunks}=fixture(t,{failure});journal.retain({},null);
 let original;assert.throws(()=>journal.flush(),error=>{original=error;return error.code==='PI_READ_EVIDENCE_UNCONFIRMED';});
 const count=chunks.length;
 for(const action of [()=>journal.snapshot(),()=>journal.retain({},null),()=>journal.flush()])assert.throws(action,error=>error===original);
 assert.equal(chunks.length,count);
});

test('private journal hard stops at its lifetime record bound',t=>{
 const {journal}=fixture(t);
 for(let i=0;i<READ_EVIDENCE_MAX_RECORDS;i++)journal.retain({},null);
 assert.equal(journal.snapshot().reads,READ_EVIDENCE_MAX_RECORDS);
 assert.throws(()=>journal.retain({},null),{code:'PI_READ_EVIDENCE_UNCONFIRMED'});
});

test('private journal rejects a frame exceeding the lifetime byte bound before appending it',t=>{
 const {journal,chunks}=fixture(t);
 const raw=Buffer.alloc(8*MiB);
 for(let i=0;i<7;i++)journal.retain({i},raw);
 const head=journal.snapshot(),written=chunks.length;
 assert.equal(head.reads,7);
 assert.throws(()=>journal.retain({},raw),{code:'PI_READ_EVIDENCE_UNCONFIRMED'});
 assert.equal(chunks.length,written);
 assert.throws(()=>journal.snapshot(),{code:'PI_READ_EVIDENCE_UNCONFIRMED'});
});
