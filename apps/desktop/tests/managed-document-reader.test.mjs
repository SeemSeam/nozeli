import test from 'node:test';
import assert from 'node:assert/strict';
import {DocumentReader} from '../src/agents/managed/document-reader.mjs';

test('document pages bind exact edit identity, metadata and Unicode source positions within serialized allowance',()=>{
  const reader=new DocumentReader(),text=('轨道🙂 "quoted"\n').repeat(7000),version={docId:'draft-42',revision:9,digest:'frozen-digest'};
  const ref=reader.add({relPath:'binary-stars.html',text,readHandle:'opaque-handle',version,buffer:true,authorship:{body:'private ledger body'},changesSinceLastRead:{text:'not model context'}});
  let next=ref,joined='',offset=0;
  while(next){
    const page=reader.read(next,1100);
    assert.ok(Buffer.byteLength(JSON.stringify(page),'utf8')<=1100);
    assert.equal(page.value.offset,offset);assert.equal(page.value.text,text.slice(offset,page.value.endOffset));
    assert.deepEqual(page.value.version,version);assert.equal(page.value.readHandle,'opaque-handle');assert.equal(page.value.buffer,true);
    assert.equal(page.value.authorship,undefined);assert.equal(page.value.changesSinceLastRead,undefined);
    assert.equal(page.continueTurn,true);assert.equal(page.hostControl,undefined);
    joined+=page.value.text;offset=page.value.endOffset;next=page.value.nextReadRef;
  }
  assert.equal(joined,text);assert.equal(offset,text.length);
  assert.throws(()=>new DocumentReader().read(ref,1100),{code:'READ_REF_EXPIRED'});
});

test('metadata alone cannot bypass allowance and denial retains unread position',()=>{
  const reader=new DocumentReader(),ref=reader.add({relPath:'file.txt',text:'🙂tail',readHandle:'h'.repeat(2000),version:'v'});
  assert.throws(()=>reader.read(ref,1000),{code:'HOST_CONTEXT_BUDGET_EXHAUSTED'});
  const page=reader.read(ref,3000);assert.equal(page.value.offset,0);assert.equal(page.value.text,'🙂tail');
});
