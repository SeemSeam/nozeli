import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';

// Linux-only test observer. CPU 100% means one logical core, not the whole machine.
// PSS apportions shared pages; RSS sums them repeatedly. Neither includes GPU VRAM.
export function observeProcessResources(rootPid){
 const supported=process.platform==='linux',samples=[],phases=[];
 const ticksPerSecond=supported?Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}).trim()):null;
 if(supported&&(!Number.isFinite(ticksPerSecond)||ticksPerSecond<=0))throw Error('Invalid Linux clock tick rate');
 const started=performance.now();let currentPhase='startup',previous=null,stopped=false,flight=null;
 const kib=(text,name)=>{const match=text.match(new RegExp('^'+name+':\\s+(\\d+)','m'));return match?Number(match[1]):null;};
 const sample=async()=>{
  const at=performance.now(),phase=currentPhase,queue=[Number(rootPid)],seen=new Set(),processes=[],errors=[];
  while(queue.length&&seen.size<192){
   const pid=queue.shift();if(seen.has(pid))continue;seen.add(pid);
   try{
    const [stat,status,children,command]=await Promise.all([fs.readFile('/proc/'+pid+'/stat','utf8'),fs.readFile('/proc/'+pid+'/status','utf8'),fs.readFile('/proc/'+pid+'/task/'+pid+'/children','utf8'),fs.readFile('/proc/'+pid+'/cmdline','utf8')]);
    const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/),identity=pid+':'+fields[19];
    let smaps=null;try{smaps=await fs.readFile('/proc/'+pid+'/smaps_rollup','utf8');}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))errors.push({pid,source:'smaps_rollup',code:error.code});}
    processes.push({pid,identity,cpuTicks:Number(fields[11])+Number(fields[12]),rssKiB:kib(status,'VmRSS'),pssKiB:smaps?kib(smaps,'Pss'):null,privateKiB:smaps?(kib(smaps,'Private_Clean')??0)+(kib(smaps,'Private_Dirty')??0):null,kind:command.match(/--type=([^\0 ]+)/)?.[1]??(pid===Number(rootPid)?'main':'child')});
    queue.push(...children.trim().split(/\s+/).filter(Boolean).map(Number));
   }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))errors.push({pid,source:'proc',code:error.code});}
  }
  if(!processes.length){samples.push({atMs:at-started,atUnixMs:Date.now(),phase,exited:true,errors});return;}
  const elapsed=previous?(at-previous.at)/1000:null,prior=new Map(previous?.processes.map(process=>[process.identity,process])??[]);
  const classified=processes.map(process=>{const before=prior.get(process.identity),ticks=before?Math.max(0,process.cpuTicks-before.cpuTicks):process.cpuTicks;return{...process,cpuPercentOneCore:elapsed&&previous.phase===phase?ticks/ticksPerSecond/elapsed*100:null};});
  const cpu=classified.every(process=>Number.isFinite(process.cpuPercentOneCore))?classified.reduce((sum,process)=>sum+process.cpuPercentOneCore,0):null;
  const pssComplete=classified.every(process=>Number.isFinite(process.pssKiB));
  samples.push({atMs:at-started,atUnixMs:Date.now(),phase,intervalMs:elapsed?elapsed*1000:null,cpuPercentOneCore:cpu,sumRssKiB:classified.reduce((sum,process)=>sum+(process.rssKiB??0),0),sumPssKiB:pssComplete?classified.reduce((sum,process)=>sum+process.pssKiB,0):null,privateKiB:pssComplete?classified.reduce((sum,process)=>sum+process.privateKiB,0):null,pssComplete,processCount:classified.length,vanishedProcesses:previous?previous.processes.filter(process=>!classified.some(current=>current.identity===process.identity)).length:0,observationMs:performance.now()-at,errors,processes:classified});
  previous={at,phase,processes:classified};
 };
 const run=()=>{if(!stopped&&!flight&&samples.length<900)flight=sample().catch(error=>samples.push({phase:currentPhase,atMs:performance.now()-started,error:error.message})).finally(()=>{flight=null;});};
 if(supported)run();const timer=supported?setInterval(run,1000):null;timer?.unref();
 return{
  mark(label){currentPhase=label;phases.push({label,atMs:performance.now()-started,atUnixMs:Date.now()});},
  async stop(){stopped=true;clearInterval(timer);if(flight)await flight;if(supported)await sample();return{supported,ticksPerSecond,boundary:'App process descendants only; CPU 100%=one core; new-process CPU included, exited-between-sample CPU may be missed; PSS apportions shared memory, summed RSS double-counts shared pages; no GPU VRAM, no forced GC, no long-term leak verdict; 1s sampling, 900-sample/192-process caps',phases,samples};}
 };
}
