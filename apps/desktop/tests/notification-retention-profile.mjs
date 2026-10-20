// No Provider calls. Run both frozen trees in separate node --expose-gc
// processes. Source notices and complete output are identical in each run.
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';

const [source,mode='after',countText='20000',roundsText='4']=process.argv.slice(2);
if(!source||!['before','after'].includes(mode)||!global.gc)throw Error('usage: node --expose-gc profile.mjs frozen-managed-dir before|after deltaCount rounds');
const {CodexSession}=await import(pathToFileURL(path.join(path.resolve(source),'codex-session.mjs')));
const count=Number(countText),rounds=Number(roundsText);
const session=new CodexSession({model:'gpt-6.1-sol',effort:'low'});session.threadId='profile-thread';
let round=0,peakHeap=0,peakRss=0;
const sample=()=>{const m=process.memoryUsage();peakHeap=Math.max(peakHeap,m.heapUsed);peakRss=Math.max(peakRss,m.rss);};
const memory=()=>{global.gc();const m=process.memoryUsage();return {heapUsed:m.heapUsed,rss:m.rss};};
const initial=memory(),cpu0=process.cpuUsage(),time0=performance.now();
const samples=[];const hashes=[];const metrics=[];
session.rpc=async()=>{
 const tid=`profile-turn-${round}`,answer=Array.from({length:count},(_,i)=>`line ${i}: 😀 text\n`).join('');
 setImmediate(()=>{
  const send=m=>session.consume(JSON.stringify(m)+'\n');
  send({method:'turn/started',params:{threadId:session.threadId,turn:{id:tid,status:'inProgress'}}});
  for(let i=0;i<count;i++){
   send({method:'item/agentMessage/delta',params:{threadId:session.threadId,turnId:tid,itemId:'body',delta:`line ${i}: 😀 text\n`}});
   if(i%512===0)sample();
  }
  send({method:'item/completed',params:{threadId:session.threadId,turnId:tid,item:{id:'body',type:'agentMessage',text:answer}}});
  send({method:'thread/tokenUsage/updated',params:{threadId:session.threadId,turnId:tid,tokenUsage:{total:{inputTokens:(round+1)*100,outputTokens:(round+1)*count,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0,totalTokens:(round+1)*(100+count)}}}});
  send({method:'turn/completed',params:{threadId:session.threadId,turn:{id:tid,status:'completed',items:[]}}});sample();
 });return {turn:{id:tid}};
};
for(round=0;round<rounds;round++){
 const result=await session.prompt('identical no-provider profile input',{timeout:120000});
 hashes.push(createHash('sha256').update(result.text).digest('hex'));metrics.push(result.metrics.tokens);
 const m=memory();samples.push({round:round+1,...m,retainedEvents:session.diagnostics?.length??session.events.length,diagnosticBytes:session.diagnostics?.bytes??null,answerChars:result.text.length});
}
const cpu=process.cpuUsage(cpu0);
console.log(JSON.stringify({mode,count,rounds,node:process.version,elapsedMs:performance.now()-time0,cpuUserMs:cpu.user/1000,cpuSystemMs:cpu.system/1000,initial,peakHeap,peakRss,samples,hashes,metrics},null,2));
