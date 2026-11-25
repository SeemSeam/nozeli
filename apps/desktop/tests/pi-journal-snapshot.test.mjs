import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const runtimeRoot=process.env.NOZELI_TEST_PI_ROOT??path.resolve(import.meta.dirname,'../../../integrations/pi');
const {parseConfirmedJournal}=await import(pathToFileURL(path.join(runtimeRoot,'src/journal-io.mjs')));
const header={type:'session',version:3,id:'synthetic-session',cwd:'D:\\synthetic'};
const message=(id,parentId=null)=>({type:'message',id,parentId,message:{role:'user',content:'中文 synthetic'}});
const encode=rows=>Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n')+'\n');
const parse=bytes=>parseConfirmedJournal(bytes,header.id);

test('confirmed snapshot preserves Unicode, embedded images, branch and compaction entries without changing bytes',()=>{
 const first=message('first');first.message.content=[{type:'text',text:'中文'},{type:'image',mimeType:'image/png',data:'synthetic-base64'}];
 const rows=[header,first,message('old','first'),message('alternate','first'),{type:'compaction',id:'compact',parentId:'alternate',firstKeptEntryId:'first',summary:'summary'}];
 const bytes=encode(rows),before=Buffer.from(bytes),result=parse(bytes);
 assert.deepEqual([result.header,...result.entries],rows);assert.deepEqual(bytes,before);
});

test('confirmed snapshot rejects malformed JSON, invalid UTF-8 and incomplete final records',()=>{
 const good=encode([header,message('first')]);
 for(const bytes of [Buffer.alloc(0),good.subarray(0,-1),Buffer.concat([good,Buffer.from('{bad}\n')]),Buffer.concat([good,Buffer.from([0xff,10])])])
  assert.throws(()=>parse(bytes),{code:'PI_JOURNAL_INVALID'});
});

test('corrupt journal never exposes content-derived JSON parser cause',()=>{
 const marker='SYNTHETIC_PRIVATE_JOURNAL_MARKER';
 const bytes=Buffer.concat([encode([header]),Buffer.from('{"private":"'+marker+'", BROKEN}\n')]);
 assert.throws(()=>parse(bytes),error=>{assert.equal(error.code,'PI_JOURNAL_INVALID');assert.equal(error.cause,undefined);assert(!String(error.stack).includes(marker));return true;});
});

test('confirmed snapshot rejects wrong sessions, legacy versions and duplicate headers without migration',()=>{
 for(const changed of [{...header,id:'another-session'},{...header,version:2},{...header,cwd:null}]){
  const bytes=encode([changed,message('first')]),before=Buffer.from(bytes);
  assert.throws(()=>parse(bytes),{code:'PI_JOURNAL_INVALID'});assert.deepEqual(bytes,before);
 }
 assert.throws(()=>parse(encode([header,message('first'),header])),{code:'PI_JOURNAL_INVALID'});
});

test('confirmed snapshot rejects duplicate IDs, missing parents and cycles before any projection',()=>{
 for(const rows of [[message('same'),message('same')],[message('child','missing')],[message('self','self')],[message('first','later'),message('later','first')],[{type:'message',id:'no-parent'}]])
  assert.throws(()=>parse(encode([header,...rows])),{code:'PI_JOURNAL_INVALID'});
});
