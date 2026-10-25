import fs from 'node:fs/promises';
// Test-only observations. No production APIs, clocks, IPC or rendering methods are replaced.
// Node elapsed times include CDP/wait overhead; next-rAF is not physical input-to-pixel latency.
export async function measureResponsiveness(context,label,action,records){
 await context.evaluate(()=>{
  if(window.__nozeliResponsivenessProbe)return;
  let active=null,frame=0;
  const keep=(items,value)=>{if(items.length<12000)items.push(value);else active.truncated=true;};
  const task=entry=>{if(active&&entry.startTime>=active.started)keep(active.longTasks,{startMs:entry.startTime-active.started,durationMs:entry.duration});};
  const observer=typeof PerformanceObserver==='function'?new PerformanceObserver(list=>list.getEntries().forEach(task)):null;
  let longTaskSupported=false;try{if(observer){observer.observe({type:'longtask',buffered:false});longTaskSupported=true;}}catch{}
  const input=event=>{if(!active||document.hidden||event.repeat)return;const current=active,at=performance.now();requestAnimationFrame(()=>{if(active===current)keep(current.inputToNextFrameMs,performance.now()-at);});};
  for(const name of ['pointerdown','pointermove','pointerup','keydown','input'])window.addEventListener(name,input,{capture:true,passive:true});
  const tick=now=>{if(!active)return;if(!document.hidden){if(active.previous!==null)keep(active.framesMs,now-active.previous);active.previous=now;}else active.previous=null;frame=requestAnimationFrame(tick);};
  window.__nozeliResponsivenessProbe={
   begin(label){if(active)throw Error('Responsiveness phase already active');active={label,started:performance.now(),previous:null,framesMs:[],inputToNextFrameMs:[],longTasks:[],truncated:false};frame=requestAnimationFrame(tick);},
   end(){if(!active)return null;observer?.takeRecords().forEach(task);cancelAnimationFrame(frame);const value=active;active=null;delete value.previous;return{...value,longTaskSupported,elapsedRendererMs:performance.now()-value.started,devicePixelRatio,hidden:document.hidden,heapUsedBytes:performance.memory?.usedJSHeapSize??null,domNodes:document.getElementsByTagName('*').length};}
  };
 });
 await context.evaluate(label=>window.__nozeliResponsivenessProbe.begin(label),label);
 const started=performance.now(),startedAtUnixMs=Date.now();let result,error;
 try{result=await action();}catch(caught){error=caught;}
 const elapsedMs=performance.now()-started;
 const nextFrameObserved=await context.evaluate(()=>new Promise(resolve=>{let done=false,first,second;const timer=setTimeout(()=>finish(false),180);function finish(value){if(done)return;done=true;clearTimeout(timer);cancelAnimationFrame(first);cancelAnimationFrame(second);resolve(value);}if(document.hidden)return finish(false);first=requestAnimationFrame(()=>{second=requestAnimationFrame(()=>finish(true));});})).catch(()=>false);
 const observed=await context.evaluate(()=>window.__nozeliResponsivenessProbe.end()).catch(caught=>({observationError:caught.message}));
 const percentile=(values,p)=>{if(!values?.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];};
 const summarize=values=>({count:values?.length??0,p50Ms:percentile(values,.5),p95Ms:percentile(values,.95),maxMs:values?.length?Math.max(...values):null});
 records.push({label,startedAtUnixMs,elapsedMs,failed:Boolean(error),nextFrameObserved,frames:summarize(observed?.framesMs),frameSamplesMs:observed?.framesMs??[],framesOver50ms:observed?.framesMs?.filter(ms=>ms>50).length??0,inputToNextFrame:summarize(observed?.inputToNextFrameMs),inputSamplesMs:observed?.inputToNextFrameMs??[],longTaskSupported:observed?.longTaskSupported??false,longTasks:observed?.longTasks??[],heapUsedBytes:observed?.heapUsedBytes??null,domNodes:observed?.domNodes??null,devicePixelRatio:observed?.devicePixelRatio??null,truncated:observed?.truncated??false,observationError:observed?.observationError});
 if(error)throw error;return result;
}
export function summarizeResponsiveness(records){
 const groups=new Map();for(const record of records){const group=groups.get(record.label)||[];group.push(record.elapsedMs);groups.set(record.label,group);}
 return [...groups].map(([label,values])=>{const sorted=values.sort((a,b)=>a-b),at=p=>sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*p)-1)];return{label,samples:sorted.length,p50Ms:at(.5),p95Ms:at(.95),maxMs:sorted.at(-1)};});
}

// Sum RSS includes shared pages more than once; it is a process-tree trend, not PSS or a leak proof.
export function observeProcessMemory(rootPid){
 const samples=[],started=performance.now();let flight=null,stopped=false;
 const sample=async()=>{
  const queue=[Number(rootPid)],seen=new Set(),processes=[];
  while(queue.length&&seen.size<192){
   const pid=queue.shift();if(seen.has(pid))continue;seen.add(pid);
   try{const [status,children]=await Promise.all([fs.readFile('/proc/'+pid+'/status','utf8'),fs.readFile('/proc/'+pid+'/task/'+pid+'/children','utf8')]);const rssKiB=Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]||0);processes.push({pid,rssKiB});queue.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
  }
  samples.push(processes.length?{atMs:performance.now()-started,atUnixMs:Date.now(),sumRssKiB:processes.reduce((sum,p)=>sum+p.rssKiB,0),processes}:{atMs:performance.now()-started,atUnixMs:Date.now(),exited:true});
 };
 const run=()=>{if(!stopped&&!flight&&samples.length<720)flight=sample().catch(error=>samples.push({atMs:performance.now()-started,error:error.message})).finally(()=>{flight=null;});};
 if(process.platform==='linux')run();const timer=process.platform==='linux'?setInterval(run,1000):null;timer?.unref();
 return{async stop(){const finalSample=!stopped;stopped=true;clearInterval(timer);if(flight)await flight;if(process.platform==='linux'&&finalSample)await sample().catch(()=>{});return{supported:process.platform==='linux',boundary:'Linux sum RSS of Electron app descendants; shared pages double-counted; no forced GC or no-leak claim',samples};}};
}
