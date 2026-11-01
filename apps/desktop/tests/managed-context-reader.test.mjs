import test from 'node:test';import assert from 'node:assert/strict';
import {ContextReader,memoryContext} from '../src/agents/managed/context-reader.mjs';
test('paged reads retain complete Unicode source and reuse their continuation reference',()=>{
 const reader=new ContextReader(),text='甲🙂\n'.repeat(16000),ref=reader.add(text,{title:'原文',source:'source.md'});let cursor=ref,result='';
 const first=reader.read(ref);assert.equal(reader.read(ref).nextReadRef,first.nextReadRef);
 while(cursor){const page=reader.read(cursor);assert.ok(page.text.length<=10000);assert.equal(page.source,'source.md');result+=page.text;cursor=page.nextReadRef;}
 assert.equal(result,text);
 const stale=()=>reader.read('not-this-turn');
 assert.throws(stale,error=>error.code==='READ_REF_EXPIRED'&&/版本化原件/.test(error.message),'expired refs fail explicitly with a re-resolution path');
});
test('budget-aware paging clips a page to the caller allowance with a continuation ref',()=>{
 const reader=new ContextReader(),ref=reader.add('行\n'.repeat(9000),{title:'长文',source:'long.md'});
 const page=reader.read(ref,{maxChars:500});
 assert.equal(page.text.length,500);assert.equal(page.complete,false);assert(page.nextReadRef);
 assert.equal(page.offset+page.text.length,reader.read(page.nextReadRef).offset,'continuation is contiguous');
 const zero=reader.read(page.nextReadRef,{maxChars:0});
 assert.equal(zero.text.length,0);assert(zero.nextReadRef,'an exhausted allowance still exposes the continuation identity');
});
test('stable refs are turn-independent identities for one-time handoff sources',()=>{
 const reader=new ContextReader(),ref=reader.addStable('recovery/archive-1/request','原始任务正文',{title:'Original Work request',source:'objects/x',kind:'worker-recovery'});
 assert.equal(ref,reader.addStable('recovery/archive-1/request','different later bytes are ignored — identity is stable'));
 const page=reader.read(ref);assert.equal(page.text,'原始任务正文');assert.equal(page.complete,true);
});
test('long Plan Tree locates older relevant memory without injecting all unrelated bodies',()=>{
 const reader=new ContextReader();let memory='# Plan Tree\n';
 for(let i=0;i<120;i++)memory+=`\n<!-- work:w${i} -->\n## ${i===3?'恢复与草稿':'其他主题'+i}\n${i===3?'关键恢复约束：原线程续接，未发送草稿保留。':''}${'不相关正文'.repeat(1600)}\n<!-- /work:w${i} -->\n`;
 const context=memoryContext(memory,'恢复和草稿处理',reader);assert.ok(JSON.stringify(context).length<5000);assert.equal(context.matches[0].title,'恢复与草稿');
 assert.ok(reader.read(context.matches[0].readRef).text.includes('关键恢复约束'));let ref=context.allReadRef,text='';while(ref){const page=reader.read(ref);text+=page.text;ref=page.nextReadRef;}assert.equal(text,memory);
});
test('no search hit preserves a complete-memory browse reference',()=>{
 const reader=new ContextReader(),text='# 独立主题\nabc';const c=memoryContext(text,'完全不同要求',reader);assert.equal(c.matches.length,0);assert.equal(reader.read(c.allReadRef).text,text);
});
test('read references from different readers cannot accidentally address another source with the same title',()=>{
 const a=new ContextReader(),b=new ContextReader();const ref=a.add('A',{title:'Same'});b.add('B',{title:'Same'});
 assert.throws(()=>b.read(ref),error=>error.code==='READ_REF_EXPIRED');
});

test('byte-limited multilingual pages remain contiguous without splitting code points or losing source text',()=>{
 const reader=new ContextReader(),original='天文学🙂🚀，双星与行星。\n'.repeat(17),first=reader.add(original,{title:'原文',source:'paper.md'});
 let ref=first,offset=0,combined='';
 while(ref){
  const page=reader.read(ref,{maxBytes:31});
  assert.ok(Buffer.byteLength(page.text,'utf8')<=31);assert.ok(page.text.length>0);
  assert.equal(page.offset,offset);assert.equal(page.version,reader.read(first,{maxBytes:31}).version);
  assert.equal(page.text,new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(page.text,'utf8')));
  combined+=page.text;offset=page.endOffset;ref=page.nextReadRef;
 }
 assert.equal(combined,original);assert.equal(offset,original.length);
});

test('zero and sub-code-point byte budgets do not bypass the cap or consume a partial character',()=>{
 const reader=new ContextReader(),ref=reader.add('🙂原文',{source:'paper.md'});
 for(const maxBytes of [0,1,2,3])assert.throws(()=>reader.read(ref,{maxBytes}),{code:'HOST_CONTEXT_BUDGET_EXHAUSTED'});
 assert.equal(reader.reads.length,0);
 const page=reader.read(ref,{maxBytes:4});assert.equal(page.text,'🙂');assert.equal(page.endOffset,2);
 assert.equal(reader.read(page.nextReadRef,{maxBytes:6}).text,'原文');
});

test('changing a page allowance returns a continuation for that exact boundary, not an earlier cached page',()=>{
 const reader=new ContextReader(),ref=reader.add('甲乙丙丁戊己',{source:'paper.md'});
 const wide=reader.read(ref,{maxBytes:12});assert.equal(reader.read(wide.nextReadRef).offset,wide.endOffset);
 const narrow=reader.read(ref,{maxBytes:6});assert.equal(reader.read(narrow.nextReadRef).offset,narrow.endOffset);
 assert.equal(narrow.text+reader.read(narrow.nextReadRef).text,'甲乙丙丁戊己');
 const whole=reader.read(ref,{maxBytes:18});assert.equal(whole.complete,true);assert.equal(whole.nextReadRef,null);
});

test('serialized page limits include provenance and escaped JSON text without dropping the first page',()=>{
 const reader=new ContextReader(),original=('plain "quoted" \\ path\t\u0000🙂\n').repeat(70),ref=reader.add(original,{title:'论文引文',source:'paper.md'});
 let cursor=ref,joined='',end=0;
 while(cursor){
  const page=reader.read(cursor,{maxBytes:520,maxResultBytes:520,resultFields:{readOnly:true,continueTurn:true}});
  assert.ok(Buffer.byteLength(JSON.stringify(page),'utf8')<=520);assert.ok(page.text.length>0);assert.equal(page.offset,end);
  joined+=page.text;end=page.endOffset;cursor=page.nextReadRef;
 }
 assert.equal(joined,original);
 const before=reader.reads.length,size=reader.entries.size;
 assert.throws(()=>reader.read(ref,{maxResultBytes:100,resultFields:{readOnly:true,metadata:'x'.repeat(200)}}),{code:'HOST_CONTEXT_BUDGET_EXHAUSTED'});
 assert.equal(reader.reads.length,before);assert.equal(reader.entries.size,size);
});
