import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {ProjectStorage} from '../src/main/project-storage.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {reportDescriptor} from '../src/agents/managed/report-descriptor.mjs';
import {ResultMemory} from '../src/agents/managed/result-memory.mjs';

// Owned synthetic projects, actual project SQLite/object reads, no credentials/models.
// Invoke directly: node tests/result-memory-live.mjs. JSON evidence retained in /tmp.
const mode=process.argv[2],root=process.argv[3]??await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-result-memory-live-'));
if(!path.basename(root).startsWith('nozeli-result-memory-live-'))throw Error('Owned smoke directory required');
async function open(recoverStale=false){
 const storage=new ProjectStorage(path.join(root,'storage'));
 const binding=JSON.parse(await fs.readFile(path.join(root,'binding.json'),'utf8'));
 const store=await Workspace.open(path.join(root,'runtime'),binding.root,{storage,projectId:binding.id,recoverStale});
 return {storage,store,binding};
}
if(mode==='killed-reader'){
 const {store}=await open();const memory=new ResultMemory(store);
 const result=await memory.search({query:'轨道',limit:3});assert.equal(result.coverage.complete,true);
 process.stdout.write('MEMORY_READY_TO_KILL\n');
 await new Promise(()=>{});
}else{
 const report={ok:false,root,scope:'Linux actual SQLite, immutable objects, source pages, child SIGKILL cold recovery; synthetic reports; zero models',checks:[],performance:[]};
 let storage,store;
 try{
  await fs.mkdir(path.join(root,'project'),{recursive:true});storage=new ProjectStorage(path.join(root,'storage'));
  const binding=await storage.register(path.join(root,'project'));await fs.writeFile(path.join(root,'binding.json'),JSON.stringify(binding));
  store=await Workspace.open(path.join(root,'runtime'),binding.root,{storage,projectId:binding.id});
  for(const scale of [100,1000]){
   const works=[],receipts=[];const seedStart=performance.now();
   for(let i=store.state.works.length;i<scale;i++){
    const id=randomUUID(),objectId=randomUUID();
    const body=Buffer.from('# 轨道积分结果 '+i+'\n\n结论：采用方案B，保留能量约束。\n验证：Linux 合成数据；Windows/macOS未验证。\n限制：大输入需要重新测量。\n'+('Evidence source stable-result-'+i+' 😀 code_identifier_'+i+'\n').repeat(20));
    const descriptor=reportDescriptor(body,{format:'markdown',objectId});await store.putObject(body);
    works.push({id,agentId:randomUUID(),name:'轨道核验 '+i,request:'比较积分方案 '+i,brief:'Synthetic fixture only',revision:1,status:'ended',outcome:'accept',endedAt:new Date().toISOString(),closure:{phase:'complete',decision:'accept',revision:1,report:{digest:descriptor.digest,kind:'worker-report',revision:1},git:{complete:true,status:'merged',commit:'fixture-'+i}}});
    receipts.push({id:randomUUID(),workId:id,revision:1,kind:'result',objectId,report:descriptor,at:new Date().toISOString()});
   }
   await store.mutate(()=>{store.state.works.push(...works);store.state.receipts.push(...receipts);});
   const seedMs=performance.now()-seedStart,memory=new ResultMemory(store,{cacheMaxBytes:Number(process.env.NOZELI_MEMORY_SMOKE_CACHE_BYTES??8*1024*1024)});
   const lag=monitorEventLoopDelay({resolution:10});lag.enable();const timings=[];
   const start=performance.now();let result=await memory.search({query:'轨道',limit:10});const coldMs=performance.now()-start;
   assert.equal(result.coverage.complete,true);assert.equal(result.coverage.eligible,scale);
   const unique=new Set();do{for(const row of result.matches){assert(!unique.has(row.source.workId));unique.add(row.source.workId);}result=result.nextCursor?await memory.search({query:'轨道',limit:10,cursor:result.nextCursor}):null;}while(result);
   assert.equal(unique.size,scale,'Every stable report is reachable, not merely top-k');
   for(let i=0;i<30;i++){const start=performance.now();result=await memory.search({query:i%2?'能量约束':'code_identifier_42',limit:5});timings.push(performance.now()-start);assert(result.matches.length>0);}
   const exact=store.state.receipts[42],source={projectId:store.projectId,workId:exact.workId,objectId:exact.objectId,digest:exact.report.digest};
   const chunks=[];let offset=0;do{const page=await memory.read(source,{offset,maxBytes:1400});assert(Buffer.byteLength(JSON.stringify(page))<=1400);assert(page.endOffset>offset);chunks.push(page.text);offset=page.nextOffset;}while(offset!==null&&offset!==undefined);
   assert.equal(createHash('sha256').update(chunks.join('')).digest('hex'),exact.report.digest);
   lag.disable();timings.sort((a,b)=>a-b);
   report.performance.push({scale,seedMs,coldMs,warmMedianMs:timings[15],warmP95Ms:timings[28],eventLoopP99Ms:lag.percentile(99)/1e6,rssBytes:process.memoryUsage().rss,coverage:result.coverage});
   report.checks.push(scale+' reports: complete history pagination and Unicode exact-source byte-bounded read');
  }
  const original=store.state.receipts[42],source={projectId:store.projectId,workId:original.workId,objectId:original.objectId,digest:original.report.digest};
  await store.close();store=null;await storage.db.close();storage=null;
  const child=spawn(process.execPath,[import.meta.filename,'killed-reader',root],{stdio:['ignore','pipe','pipe']});
  let log='';const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Child readiness timeout: '+log));},60000);child.stdout.on('data',data=>{log+=data;if(log.includes('MEMORY_READY_TO_KILL')){clearTimeout(timer);resolve();}});child.stderr.on('data',data=>log+=data);child.once('exit',()=>{clearTimeout(timer);if(!log.includes('MEMORY_READY_TO_KILL'))reject(Error(log));});});
  child.kill('SIGKILL');assert.equal((await exit).signal,'SIGKILL');
  ({storage,store}=await open(true));const recovered=new ResultMemory(store);let result=await recovered.search({query:'code_identifier_42',limit:10}),found=false;
  do{found ||= result.matches.some(row=>row.source.objectId===source.objectId);result=result.nextCursor?await recovered.search({query:'code_identifier_42',limit:10,cursor:result.nextCursor}):null;}while(result);
  assert(found);const page=await recovered.read(source,{maxBytes:4096});assert(page.text.includes('Windows/macOS未验证'));
  report.checks.push('Actual child SIGKILL followed by stale-owner recovery preserves exact sources without replay');
  await assert.rejects(recovered.read({...source,projectId:randomUUID()}));
  const persisted=JSON.stringify(store.state);await storage.remove(store.projectId);await assert.rejects(recovered.search({query:'轨道'}));assert.equal(JSON.stringify(store.state),persisted);
  report.checks.push('Cross-project exact references and removed-project access rejected without managed-state mutation');
  report.ok=true;
 }catch(error){report.error=error.stack;process.exitCode=1;}
 finally{if(store&&!store.closed)await store.close().catch(()=>{});await storage?.db.close();await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
}
