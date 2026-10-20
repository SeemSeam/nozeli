import test from 'node:test';import assert from 'node:assert/strict';
import {ContextReader,memoryContext} from '../src/agents/managed/context-reader.mjs';
test('paged reads retain complete Unicode source and reuse their continuation reference',()=>{
 const reader=new ContextReader(),text='甲🙂\n'.repeat(16000),ref=reader.add(text,{title:'原文',source:'source.md'});let cursor=ref,result='';
 const first=reader.read(ref);assert.equal(reader.read(ref).nextReadRef,first.nextReadRef);
 while(cursor){const page=reader.read(cursor);assert.ok(page.text.length<=10000);assert.equal(page.source,'source.md');result+=page.text;cursor=page.nextReadRef;}
 assert.equal(result,text);assert.throws(()=>reader.read('not-this-turn'),/unknown/);
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
 const a=new ContextReader(),b=new ContextReader();const ref=a.add('A',{title:'Same'});b.add('B',{title:'Same'});assert.throws(()=>b.read(ref),/unknown/);
});
