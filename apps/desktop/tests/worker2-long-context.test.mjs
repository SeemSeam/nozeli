import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {ContextReader} from '../src/agents/managed/context-reader.mjs';
import {prepareDelivery} from '../src/agents/managed/context-delivery.mjs';

test('long source pages have stable digest and contiguous readable line boundaries',()=>{
 const text=('# long source\n'+('Chinese 中文🙂 source line\n').repeat(1300)),r=new ContextReader();let ref=r.add(text,{source:'objects/long.md'}),joined='',offset=0,version=createHash('sha256').update(text).digest('hex');
 while(ref){const page=r.read(ref);assert.equal(page.offset,offset);assert.equal(page.version,version);assert.equal(page.text.length,page.endOffset-page.offset);assert(page.text.length<=10000);if(page.nextReadRef)assert(page.text.endsWith('\n'));joined+=page.text;offset=page.endOffset;ref=page.nextReadRef;}
 assert.equal(joined,text);assert.equal(offset,text.length);
});


test('long unseen dialogue identifies truncated messages and preserves Unicode boundary',()=>{
 const state={limit:2,works:[],todos:[],messages:[{id:'source-id',jobId:'old',target:'frontdesk',speaker:'user',text:'x'.repeat(1199)+'🙂TAIL'}]};
 const p=prepareDelivery(state,{target:'orchestrator',threadId:'t',job:{id:'new'},used:0});const rows=JSON.parse(p.sections.find(([title])=>title==='未见前台消息')[1]);
 assert.equal(rows[0].id,'source-id');assert.equal(rows[0].text,'x'.repeat(1199));assert.equal(rows[0].totalChars,1205);assert(rows[0].truncated);assert(p.sections.some(([title,text])=>title==='截断正文'&&text.includes('@conversation')));
});
