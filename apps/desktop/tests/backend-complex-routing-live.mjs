import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openTestController} from './project-storage.fixture.mjs'
import {auditRuntime} from '../src/agents/managed/runtime-audit.mjs';
import {assertSameWork,assertSlots,assertReview,assertNoReplay} from './complex-routing-evidence.mjs';

if(process.env.NOZELI_REAL_CODEX!=='1'||!process.env.NOZELI_CODEX_SOURCE_HOME)throw Error('explicit NOZELI_REAL_CODEX=1 and NOZELI_CODEX_SOURCE_HOME required');
if(!process.env.NOZELI_COMPLEX_LAB_PARENT||!path.isAbsolute(process.env.NOZELI_COMPLEX_LAB_PARENT))throw Error('explicit external NOZELI_COMPLEX_LAB_PARENT required');
const parent=await fs.realpath(process.env.NOZELI_COMPLEX_LAB_PARENT);
if(parent.split(path.sep).includes('.ccb'))throw Error('test data must not be stored under .ccb');
const root=await fs.mkdtemp(path.join(parent,'complex-routing-'));
const content=path.join(root,'project'),runtime=path.join(root,'app-data','runtime');
await fs.mkdir(content);await fs.mkdir(path.join(root,'evidence'));
let c,failure,stage='startup';const checks=[],inputs=[],timeline=[];let maxParallel=0;
const now=()=>new Date().toISOString(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const json=async(name,value)=>fs.writeFile(path.join(root,'evidence',name+'.json'),JSON.stringify(value,null,2)+'\n');
const sourceFiles=['controller.mjs','workspace.mjs','codex-session.mjs','roles.json','context-delivery.mjs','execution-workspace.mjs','process-isolation.mjs'];
const snapshot=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async f=>[f,createHash('sha256').update(await fs.readFile(new URL('../src/agents/managed/'+f,import.meta.url))).digest('hex')])));
const beforeSource=await snapshot();await json('source-before',beforeSource);
const options={runtimeRoot:runtime,contentRoot:content,sourceHome:process.env.NOZELI_CODEX_SOURCE_HOME,isolateProcesses:true};
const record=()=>{const s=c.snapshot(),running=s.jobs.filter(j=>j.status==='running'&&!['frontdesk','orchestrator'].includes(j.target));maxParallel=Math.max(maxParallel,running.length);const row={at:now(),stage,quota:s.quotaUsed,running:running.map(j=>j.target),works:s.works.map(w=>({id:w.id,name:w.name,status:w.status,threadId:w.threadId,revision:w.revision})),jobs:s.jobs.map(j=>({id:j.id,target:j.target,status:j.status,turnId:j.turnId,error:j.error}))};if(JSON.stringify(timeline.at(-1)?.jobs)!==JSON.stringify(row.jobs))timeline.push(row);};
const check=async(name,fn)=>{await fn();checks.push({name,at:now()});await json('progress',{stage,checks,inputs});console.log(JSON.stringify({check:name,root}));};
const wait=async(fn,label,{allowFailure=false}={})=>{stage=label;const end=Date.now()+720000;while(Date.now()<end){record();if(await fn())return;if(!allowFailure){const failed=c.store.state.jobs.find(j=>j.status==='failed');if(failed)throw Error(`${label}: ${failed.target}: ${failed.error}`);}await sleep(200);}throw Error('timeout: '+label);};
const idle=()=>wait(()=>!c.running.size&&!c.store.state.jobs.some(j=>['queued','running','transferring'].includes(j.status)),'idle');
const send=async(text)=>{const sent=await c.send('frontdesk',text);inputs.push({at:now(),text,jobId:sent.jobId});await json('progress',{stage,checks,inputs});return sent;};
const work=name=>{const w=c.store.state.works.find(w=>w.name===name);assert.ok(w,'named Work '+name);return w;};
const front=async(text)=>{await send(text);await wait(()=>!c.running.has('frontdesk')&&!c.running.has('orchestrator')&&!c.store.state.jobs.some(j=>['frontdesk','orchestrator'].includes(j.target)&&['queued','running','transferring'].includes(j.status)),'front-routing');};
const constraints='仅操作本独立样本，禁止Git提交或推送，禁止CCB/tmux/其他Agent。发布问题或结果必须使用受管工具，结果文件必须列在files中。不要自行结束Work。';
const readArtifact=async(name)=>{const owner=c.store.state.works.find(w=>w.execution?.candidate?.files?.includes(name));return fs.readFile(path.join(owner&&owner.closure?.phase!=='complete'?c.execution.directory(owner.id):content,name),'utf8');};
const end=async(w,decision='accept')=>{await c.endWork(w.id,{revision:w.revision,decision});await wait(()=>c.store.find(w.id).status==='ended'&&c.store.find(w.id).closure?.phase==='complete','user-end:'+w.name);assert.equal(c.store.find(w.id).outcome,decision);};
try{
 console.log(JSON.stringify({root,scope:'real Backend CLI; no GUI',version:execFileSync('codex',['--version'],{encoding:'utf8'}).trim()}));
 await fs.writeFile(path.join(content,'people.txt'),'Mira: apple\nMira: pear\nNia: plum\n');
 c=await openTestController(options);c.on('state',record);await c.store.mutate(()=>{c.store.state.limit=2;});await c.start();
 await front('仅用一句中文说明平均数是什么，不读取文件，不创建任务。');await check('light answer has no Work',()=>assert.equal(c.store.state.works.length,0));
 await front('新建独立任务，严格命名“人物计数”：读取people.txt，为我指定的人物统计条目，写count.md并读回核验。人物未指定，必须先用问题待办问我，不猜。'+constraints);
 await wait(()=>c.store.state.works.some(w=>w.name==='人物计数'&&w.status==='paused')&&!c.running.size,'A-question');const a0=structuredClone(work('人物计数'));
 await check('A question callback pauses original thread and holds slot',()=>{assert.ok(a0.threadId);assertSlots(c.snapshot(),1);assert.ok(c.store.state.todos.some(t=>t.workId===a0.id&&t.kind==='problem'&&t.status==='open'));});
 await front('这是另一个全新独立目标，不是人物计数的补充。新建任务严格命名“格式检查”：输出style.md，说明用户指定的格式。格式未指定，先用问题待办问我，不猜、不改count.md。'+constraints);
 await wait(()=>c.store.state.works.some(w=>w.name==='格式检查'&&w.status==='paused')&&!c.running.size,'B-question');const b0=structuredClone(work('格式检查'));
 await check('new goal creates distinct Work/thread and both waiting slots count',()=>{assert.notEqual(a0.id,b0.id);assert.notEqual(a0.threadId,b0.threadId);assert.equal(c.store.state.works.length,2);assertSlots(c.snapshot(),2);});
 await front('第三个全新独立目标：新建任务严格命名“队列标记”，仅创建queued.txt，内容QUEUED_OK，读回后发布结果。不是前两个任务的补充。'+constraints);
 const q0=structuredClone(work('队列标记'));await check('full quota queues third without native thread',()=>{assert.equal(q0.status,'queued');assert.ok(!q0.threadId);assertSlots(c.snapshot(),2);});
 const soakMs=Number(process.env.NOZELI_COMPLEX_SOAK_MS||60000);assert.ok(Number.isFinite(soakMs)&&soakMs>=60000,'soak at least 60 seconds');stage='waiting-soak';const until=Date.now()+soakMs;while(Date.now()<until){assertSlots(c.snapshot(),2);assert.equal(work('队列标记').status,'queued');await sleep(1000);}await check('two waiting Workers preserve full quota through measured soak',()=>assertSlots(c.snapshot(),2));
 const beforeRestart=c.snapshot();await c.setDraft(a0.id,'保留但不发送的续问草稿');await c.stop();c=await openTestController(options);c.on('state',record);await c.start();await check('real stop/reopen retains paused threads, draft and queue without replay',()=>{assertNoReplay(beforeRestart,c.snapshot());assert.equal(c.store.state.drafts[a0.id],'保留但不发送的续问草稿');assertSlots(c.snapshot(),2);assert.equal(work('队列标记').status,'queued');});await c.setDraft(a0.id,'');
 // Answers are accepted concurrently; each is routed by real low frontdesk/high Orchestrator.
 await send('回答“人物计数”：目标人物是Mira，请原Agent继续，count.md包含人物和数字2。');await send('回答“格式检查”：采用Markdown表格，style.md包含FORMAT_TABLE，并读回核验。');await idle();
 await check('both answers resume original Workers and produce actual verified bytes',async()=>{assertSameWork(a0,assertReview(c.snapshot(),a0.id));assertSameWork(b0,assertReview(c.snapshot(),b0.id));assert.match(await readArtifact('count.md'),/Mira/);assert.match(await readArtifact('count.md'),/2/);assert.match(await readArtifact('style.md'),/FORMAT_TABLE/);assertSlots(c.snapshot(),2);});
 for(const [round,prompt,expected] of [[1,'仍不满意，原“人物计数”报告太长。不要新建目标，保持Mira，count.md改为一句含COUNT_V2和数字2的中文，核验后重新报告。','COUNT_V2'],[2,'还是不满意，继续原“人物计数”，将同一统计目标人物改成Nia。count.md改为一句含COUNT_V3、Nia和数字1的中文；不创建独立任务。','COUNT_V3']]){const previous=structuredClone(work('人物计数'));await front(prompt+constraints);await idle();await check('dissatisfaction '+round+' keeps original Work/thread and revises real output',async()=>{assertSameWork(previous,assertReview(c.snapshot(),a0.id));assert.equal(c.store.state.works.length,3);assert.match(await readArtifact('count.md'),new RegExp(expected));assert.equal(work('队列标记').status,'queued');});}
 const reviewed=c.snapshot();await c.stop();c=await openTestController(options);c.on('state',record);await c.start();await check('review restart preserves completed side effects and queued Work',()=>{assertNoReplay(reviewed,c.snapshot());assertSlots(c.snapshot(),2);assertReview(c.snapshot(),a0.id);});
 await end(work('格式检查'));await wait(()=>work('队列标记').status==='review'&&!c.running.size,'queued-autostart');await check('normal user end cleans only B and starts actual queued worker',async()=>{assert.ok(work('队列标记').threadId);assert.notEqual(work('队列标记').threadId,a0.threadId);assert.equal((await readArtifact('queued.txt')).trim(),'QUEUED_OK');assertSlots(c.snapshot(),2);await assert.rejects(fs.stat(c.store.agentHome(b0.id)),{code:'ENOENT'});assert.ok(await readArtifact('style.md'));});
 await end(work('人物计数'));await end(work('队列标记'),'discard');await check('explicit outcomes preserve adopted output and discard only owned candidate',async()=>{assertSlots(c.snapshot(),0);assert.equal(work('队列标记').outcome,'discard');assert.match(await readArtifact('count.md'),/COUNT_V3/);await assert.rejects(fs.stat(path.join(content,'queued.txt')),{code:'ENOENT'});for(const w of c.store.state.works)assert.ok(w.closure.report);assert(!c.store.state.jobs.some(j=>['curate','git'].includes(j.type)));});
 await json('final-state',c.snapshot());
}catch(e){failure=e;console.error(e.stack);if(c)await json('failure-state',c.snapshot());}
finally{try{await c?.stop();}catch(e){failure??=e;}const audit=await auditRuntime(runtime);if(audit.complete!==true||audit.processes.length||audit.authCopies.length)failure??=Error('cleanup audit found owned processes or auth copies');await json('timeline',timeline);await json('source-after',await snapshot());const result={status:failure?'FAIL':'PASS',scope:'Linux real Backend/Codex only, not GUI/platform release',root,stage,checks,inputs,maxParallelWorkerTurns:maxParallel,error:failure?.message,audit,cli:execFileSync('codex',['--version'],{encoding:'utf8'}).trim(),node:process.version,platform:os.platform(),limitations:['source may change concurrently; before/after hashes retained','no GUI','soak measures waiting capacity, not continuous execution CPU','unexpected SIGKILL recovery separately tested']};await json('result',result);console.log(JSON.stringify(result));if(failure)process.exitCode=1;}
