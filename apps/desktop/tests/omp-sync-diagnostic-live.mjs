// Actual bundled OMP/relay/guest sync probe. No prompt, model response fixture,
// protocol echo server or production timeout/result changes. Linux signals only
// target this probe's PID incarnation; transcript contains metadata only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import http from 'node:http';
import {OmpTuiSession} from '../src/agents/managed/omp-tui-session.mjs';
import {openFrame} from '../src/agents/managed/collab/guest.mjs';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';
import {observeSyncBarrier} from './sync-barrier-observer.fixture.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-sync-diagnostic-')),seed=path.join(root,'seed'),cwd=path.join(root,'project');await fs.mkdir(seed);await fs.mkdir(cwd);
let inference=0,session,owner,stopped=false,releaseConsumer,releaseFlush,restoreHooks=()=>{};
const result={root,events:[],cases:[],scope:'Actual bundled native OMP without prompts; only temporary guest queue/flush holds, pre-handoff guard, and owned native SIGSTOP/SIGCONT. Internal native receive/return timestamps remain unobservable.'};
const server=http.createServer((req,res)=>{inference++;req.resume();res.writeHead(503).end('No model turns allowed');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
await fs.writeFile(path.join(seed,'config.yml'),'startup:\n  checkUpdate: false\n  showSplash: false\nmarketplace:\n  autoUpdate: "off"\nautoResume: false\nsetupVersion: 2\nmodelRoles:\n  default: sync-local/no-turns\n');
await fs.writeFile(path.join(seed,'models.yml'),`providers:\n  sync-local:\n    api: openai-completions\n    baseUrl: http://127.0.0.1:${server.address().port}/v1\n    auth: none\n    models:\n      - id: no-turns\n        input: [text]\n`);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+4000;do{if(fn())return;await pause(10);}while(Date.now()<end);throw Error('Probe wait: '+label);}
let activeCase='startup';const operationCases=new Map();
function event(phase,nonce=null,extra={}){result.events.push({at:Date.now(),case:activeCase,phase,...(nonce?{nonce}:{}),...extra});}
function classify(name){const rows=result.events.filter(row=>row.case===name),has=phase=>rows.some(row=>row.phase===phase);return !has('socket-handoff')?'not-sent':!has('raw-sync-return')?'no-return-observed':!has('consume-complete')?'returned-awaiting-consumption':!has('flush-complete')?'consumed-awaiting-flush':'settled';}
async function signalOwned(signal){assert(owner?.stamp);assert.equal(await processStamp(owner.pid),owner.stamp,'Native PID incarnation must still match');process.kill(-owner.pid,signal);event('native-signal',null,{signal,pid:owner.pid,scope:'owned-native-group'});}
try{
 assert.equal(process.platform,'linux');
 session=new OmpTuiSession({role:'frontdesk',home:path.join(root,'home'),cwd,tools:[],command:path.resolve(import.meta.dirname,'../runtime/omp/omp'),ompSystemSource:{private:true,root,agentDir:seed},onSpawn:async pid=>{owner={pid,stamp:await processStamp(pid)};assert(owner.stamp);}});
 await session.start();assert.equal(session.promptsDelivered,0);const runtime=session.collab,guest=runtime.guest,ws=guest.ws;assert.equal(ws.readyState,1);
 restoreHooks=observeSyncBarrier(runtime,{decodeFrame:openFrame,onEvent:row=>{if(row.phase==='drain-enter')operationCases.set(row.operationId,activeCase);result.events.push({...row,case:operationCases.get(row.operationId)||activeCase});}});
 const observedFlush=runtime.flushSnapshot;
 runtime.flushSnapshot=async function(...args){if(activeCase==='hold-flush'){event('probe-flush-held');await new Promise(resolve=>releaseFlush=resolve);}return observedFlush.apply(this,args);};
 activeCase='baseline';await runtime.drain();assert.equal(classify(activeCase),'settled');result.cases.push({name:activeCase,outcome:'settled'});
 activeCase='before-handoff';guest.closing=true;let beforeError;try{await runtime.drain();}catch(error){beforeError=error;}finally{guest.closing=false;}assert(beforeError);assert.equal(classify(activeCase),'not-sent');result.cases.push({name:activeCase,outcome:classify(activeCase),originalError:beforeError.message});
 activeCase='hold-consumer';guest.chain=guest.chain.then(()=>new Promise(resolve=>releaseConsumer=resolve));const queued=runtime.drain();await until(()=>result.events.some(row=>row.case==='hold-consumer'&&row.phase==='raw-sync-return'),'actual sync returned');assert.equal(classify(activeCase),'returned-awaiting-consumption');result.cases.push({name:activeCase,observed:classify(activeCase)});releaseConsumer();releaseConsumer=null;await queued;assert.equal(classify(activeCase),'settled');
 activeCase='hold-flush';const flushing=runtime.drain();await until(()=>typeof releaseFlush==='function','flush hold after barrier');assert.equal(classify(activeCase),'consumed-awaiting-flush');result.cases.push({name:activeCase,observed:classify(activeCase)});releaseFlush();releaseFlush=null;await flushing;assert.equal(classify(activeCase),'settled');
 activeCase='native-stopped';await signalOwned('SIGSTOP');stopped=true;let timeoutError,stoppedObservation;const started=Date.now();try{await runtime.drain();}catch(error){timeoutError=error;stoppedObservation=classify(activeCase);}finally{await signalOwned('SIGCONT');stopped=false;}assert.equal(timeoutError?.message,'collab-drain-timeout');assert.equal(stoppedObservation,'no-return-observed');result.cases.push({name:activeCase,observed:stoppedObservation,originalError:timeoutError.message,elapsedMs:Date.now()-started});
 await until(()=>result.events.some(row=>row.case==='native-stopped'&&row.phase==='consume-complete'),'late actual host response after SIGCONT');
 activeCase='after-resume';await runtime.drain();assert.equal(classify(activeCase),'settled');assert.equal(session.promptsDelivered,0);assert.equal(inference,0);assert.deepEqual(restoreHooks.errors,[],'Passive observer must not lose metadata');result.cases.push({name:activeCase,outcome:'settled'});result.owner=owner;result.ok=true;
}catch(error){result.failure={name:error.name,message:error.message};process.exitCode=1;}
finally{releaseConsumer?.();releaseFlush?.();if(stopped&&owner&&await processStamp(owner.pid)===owner.stamp){process.kill(-owner.pid,'SIGCONT');stopped=false;}restoreHooks();try{result.stopReceipt=await session?.stop();}catch(error){result.stopError={name:error.name,message:error.message};process.exitCode=1;}if(owner?.stamp&&await processStamp(owner.pid)===owner.stamp){result.forcedCleanup={at:Date.now(),signal:'SIGKILL',pid:owner.pid};process.kill(-owner.pid,'SIGKILL');await session.exitPromise;process.exitCode=1;}result.nativeExited=!owner||await processStamp(owner.pid)!==owner.stamp;result.modelHttp=inference;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.writeFile(path.join(root,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({root,ok:result.ok,cases:result.cases,failure:result.failure,modelHttp:inference,nativeExited:result.nativeExited,stopError:result.stopError}));}
