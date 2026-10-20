#!/usr/bin/env node
// No-model performance probe; baseline is an explicitly supplied frozen source.
import {spawn} from 'node:child_process';import fs from 'node:fs/promises';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
const mode=process.env.NOZELI_METRICS_PROBE_MODE;
const count=Number(process.env.NOZELI_METRICS_PROBE_COUNT||250000);
function event(i){return {method:'thread/tokenUsage/updated',params:{threadId:'perf-thread',turnId:'perf-turn',tokenUsage:{total:{inputTokens:i*10,cachedInputTokens:i*5,cacheWriteInputTokens:0,outputTokens:i,reasoningOutputTokens:0,totalTokens:i*11},last:{inputTokens:10,cachedInputTokens:5,outputTokens:1,totalTokens:11,reasoningOutputTokens:0,cacheWriteInputTokens:0}}}};}
if(mode){
 const module=mode==='baseline'?await import(pathToFileURL(process.env.NOZELI_METRICS_BASELINE).href):await import('../src/agents/managed/turn-metrics.mjs');
 global.gc?.();const before=process.memoryUsage(),started=performance.now(),cpu=process.cpuUsage(),opts={threadId:'perf-thread',turnId:'perf-turn',fresh:true};let metrics,items;
 let heapMax=before.heapUsed,rssMax=before.rss;const sample=()=>{const m=process.memoryUsage();heapMax=Math.max(heapMax,m.heapUsed);rssMax=Math.max(rssMax,m.rss);};
 if(mode==='baseline'){items=[];for(let i=0;i<count;i++){items.push(event(i));if(i%4096===0)sample();}}else{items=module.createTurnMetricsAccumulator(opts);for(let i=0;i<count;i++){items.observe(event(i));if(i%4096===0)sample();}}
 const ingestionMs=performance.now()-started;const terminal={method:'turn/completed',params:{threadId:opts.threadId,turn:{id:opts.turnId,status:'completed'}}};
 if(mode==='baseline'){items.push(terminal);metrics=module.turnMetrics(items,opts);}else{items.observe(terminal);metrics=items.result();}
 sample();const totalMs=performance.now()-started,cpuUsed=process.cpuUsage(cpu),after=process.memoryUsage();console.log(JSON.stringify({mode,count,inputSerializedBytes:Buffer.byteLength(JSON.stringify(event(count-1)))*count,before,after,heapMax,rssMax,ingestionMs,settlementMs:totalMs-ingestionMs,totalMs,cpuUserMs:cpuUsed.user/1000,cpuSystemMs:cpuUsed.system/1000,metrics}));
}else{
 const baseline=process.env.NOZELI_METRICS_BASELINE,out=process.env.NOZELI_METRICS_PROBE_OUT;if(!baseline||!out)throw Error('explicit frozen baseline module and output required');
 const runs=[];for(const selected of ['baseline','streaming']){const result=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--expose-gc',new URL(import.meta.url).pathname],{env:{...process.env,NOZELI_METRICS_PROBE_MODE:selected},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.once('error',reject);child.once('close',code=>code===0?resolve(JSON.parse(stdout)):reject(Error(stderr)));});runs.push(result);}
 assert.deepEqual(runs[0].metrics,runs[1].metrics);const evidence={status:'PASS',node:process.version,baseline,count,runs};await fs.writeFile(out,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}
