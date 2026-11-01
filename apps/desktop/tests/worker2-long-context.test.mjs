import test from 'node:test';import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ContextReader} from '../src/agents/managed/context-reader.mjs';
import {workerInitialHandoff} from '../src/agents/managed/context-delivery.mjs';

test('long source pages have stable digest and contiguous readable line boundaries',()=>{
 const text=('# long source\n'+('Chinese 中文🙂 source line\n').repeat(1300)),r=new ContextReader();let ref=r.add(text,{source:'objects/long.md'}),joined='',offset=0,version=createHash('sha256').update(text).digest('hex');
 while(ref){const page=r.read(ref);assert.equal(page.offset,offset);assert.equal(page.version,version);assert.equal(page.text.length,page.endOffset-page.offset);assert(page.text.length<=10000);if(page.nextReadRef)assert(page.text.endsWith('\n'));joined+=page.text;offset=page.endOffset;ref=page.nextReadRef;}
 assert.equal(joined,text);assert.equal(offset,text.length);
});

test('a long original task hands off once, bounded, behind paged read refs',()=>{
 const work={id:'w-long',name:'长文任务',status:'running',revision:1,request:('论文正文段落。').repeat(20000),inputs:[{sourceJobId:'s1',text:('补充要求。').repeat(6000)}]};
 const reader=new ContextReader();
 const packet=workerInitialHandoff(work,reader,{previewChars:1200});
 assert(packet.includes('readRef'),'the remainder stays behind paged read refs');
 let cursor=[...reader.entries.keys()].find(key=>reader.entries.get(key).title==='原始任务（不可改写）'),total=0;
 while(cursor){const page=reader.read(cursor);total+=page.text.length;cursor=page.nextReadRef;}
 assert.equal(total,work.request.length,'the full original remains readable exactly once through paging');
});
