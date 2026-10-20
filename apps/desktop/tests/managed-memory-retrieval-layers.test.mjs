import test from 'node:test';import assert from 'node:assert/strict';
import {ContextReader,memoryContext} from '../src/agents/managed/context-reader.mjs';

test('historical Work summaries cannot crowd a matching organized topic out of primary memory retrieval',()=>{
 const history=Array.from({length:12},(_,i)=>`<!-- work:w${i} -->\n# 服务端口\n旧报告记服务端口8042，未证明当前生效。\n<!-- /work:w${i} -->`).join('\n');
 const reader=new ContextReader(),found=memoryContext('# Plan Tree\n'+history,'服务端口',reader,[{path:'topics/service-rules.md',text:'# 项目规则\n当前用户约定服务端口8142。来源：用户新决定；旧文档仍8042。\n离线不重试。超时7/9秒冲突未决。'}]);
 assert(found.matches.some(m=>m.source==='memory/topics/service-rules.md'),'organized topic must be in primary matching sources');
 const topic=found.matches.find(m=>m.source==='memory/topics/service-rules.md');const page=reader.read(topic.readRef);
 assert(page.text.includes('8142')&&page.text.includes('冲突未决'));
 assert(found.historyMatches.length>0,'history remains explicitly retrievable');
 const old=reader.read(found.historyMatches[0].readRef);assert(old.source.includes('#work:'));assert(old.text.includes('8042'));
});

test('legacy memory with no matching topic remains retrievable but is labelled historical',()=>{
 const reader=new ContextReader(),found=memoryContext('<!-- work:old -->\n# 编译失败\n工具链错误未解决。\n<!-- /work:old -->','编译失败',reader,[]);
 assert.equal(found.matches.length,1);assert.equal(found.matches[0].kind,'history');assert(reader.read(found.matches[0].readRef).text.includes('未解决'));
});
