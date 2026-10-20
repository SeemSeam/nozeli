// Independent original-versus-candidate compatibility oracle; no Provider calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [originalFile,candidateFile]=process.argv.slice(2);
if(!originalFile||!candidateFile)throw Error('two turn-metrics module paths required');
const {turnMetrics:before}=await import(pathToFileURL(path.resolve(originalFile)).href);
const {turnMetrics:after}=await import(pathToFileURL(path.resolve(candidateFile)).href);
let seed=190713;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;},pick=a=>a[Math.floor(random()*a.length)];
const fields=['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
const usage=()=>{const value={};for(const f of fields){const k=pick(['absent','null','invalid','number']);if(k!=='absent')value[f]=k==='null'?null:k==='invalid'?pick([-1,'20',.5,Number.MAX_SAFE_INTEGER+1]):Math.floor(random()*100);}return value;};
let checked=0;
for(let i=0;i<3000;i++){
 const options={threadId:'thread',turnId:'turn',fresh:random()<.5,...(random()<.7?{baseline:pick([usage(),{},'invalid',null])}:{})};
 const events=[];
 for(let k=0;k<1+Math.floor(random()*70);k++){
  const threadId=pick(['thread','thread','foreign']),turnId=pick(['turn','turn','other']);
  const kind=pick(['usage','item','terminal','delta']);
  if(kind==='usage')events.push({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{total:random()<.85?usage():undefined}}});
  else if(kind==='item')events.push({method:'item/completed',params:{threadId,turnId,item:{id:'item-'+Math.floor(random()*5),type:pick(['commandExecution','fileChange','agentMessage','dynamicToolCall','mcpToolCall','webSearch'])}}});
  else if(kind==='terminal')events.push({method:'turn/completed',params:{threadId,turn:{id:turnId,status:pick(['completed','failed','interrupted'])}}});
  else events.push({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'text',delta:'some text'}});
 }
 try{assert.deepEqual(after(events,options),before(events,options));}catch(error){console.log(JSON.stringify({i,options,events,before:before(events,options),after:after(events,options)}));throw error;}
 checked++;
}
console.log(JSON.stringify({status:'PASS',independent_original_implementation_comparisons:checked,seed:190713,scope:'known thread/turn, cumulative malformed/missing/decreasing values, foreign interleaving, duplicate items/terminal, fixture only'}));
