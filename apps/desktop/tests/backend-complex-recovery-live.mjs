import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import {Controller} from '../src/agents/managed/controller.mjs';
import {auditRuntime} from '../src/agents/managed/runtime-audit.mjs';
import {recoverProvider} from '../src/agents/managed/process-ownership.mjs';
import {assertSlots,assertNoReplay,assertReview} from './complex-routing-evidence.mjs';

if(process.env.NOZELI_REAL_CODEX!=='1'||!process.env.NOZELI_CODEX_SOURCE_HOME)throw Error('explicit real Codex opt-in and source home required');
const isChild=process.argv[2]==='child';
let root=process.argv[3];
if(!isChild){const parent=process.env.NOZELI_COMPLEX_LAB_PARENT;if(!parent||!path.isAbsolute(parent)||parent.split(path.sep).includes('.ccb'))throw Error('external NOZELI_COMPLEX_LAB_PARENT required');root=await fs.mkdtemp(path.join(await fs.realpath(parent),'complex-crash-'));}
const runtime=path.join(root,'app-data/runtime'),content=path.join(root,'project');
const options={runtimeRoot:runtime,contentRoot:content,sourceHome:process.env.NOZELI_CODEX_SOURCE_HOME,isolateProcesses:true};
const write=async(name,value)=>{await fs.mkdir(path.join(root,'evidence'),{recursive:true});await fs.writeFile(path.join(root,'evidence',name+'.json'),JSON.stringify(value,null,2)+'\n');};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let c,failure,stage='open';const checks=[];
const check=(name,fn)=>{fn();checks.push(name);console.log(JSON.stringify({check:name,root}));};
const wait=async(fn,label,{allowFailure=false}={})=>{stage=label;const until=Date.now()+720000;while(Date.now()<until){if(await fn())return;if(!allowFailure){const f=c.store.state.jobs.find(j=>j.status==='failed');if(f)throw Error(label+': '+f.error);}await sleep(100);}throw Error('timeout: '+label);};
if(isChild){
 try{
  await fs.mkdir(content,{recursive:true});await fs.writeFile(path.join(content,'input.txt'),'alpha\nbeta\ngamma\n');c=await Controller.open(options);await c.store.mutate(()=>{c.store.state.limit=2;});await c.start();
  for(const name of ['故障A','故障B']){await c.send('frontdesk',`新建全新独立任务，严格命名“${name}”，不是其他任务的补充。读取input.txt，写${name==='故障A'?'a':'b'}.md，按我指定的前缀编号三行；前缀未指定，必须先发布problem问我，然后结束当前回合等待。禁止Git、CCB、tmux和其他Agent。`);await wait(()=>c.store.state.works.some(w=>w.name===name&&w.status==='paused')&&!c.running.size,'question:'+name);}
  const works=c.snapshot().works;const sessions=await Promise.all(works.map(w=>c.session(w.id)));
  const started=sessions.map(s=>once(s,'turn-started'));
  await Promise.all(works.map(w=>c.send(w.id,`前缀使用${w.name}。请写一个Python程序读取input.txt，输出编号Markdown到${w.name==='故障A'?'a':'b'}.md；编写并运行unittest验证行数和前缀，读回后发布result，列出实际文件。禁止Git、CCB、tmux。`)));
  const turns=await Promise.all(started);assertSlots(c.snapshot(),2);assert.equal(c.running.size,2);await write('prekill',{state:c.snapshot(),turns});
  process.kill(process.pid,'SIGKILL');
 }catch(e){await write('child-failure',{error:e.stack,state:c?.snapshot()});await c?.stop();throw e;}
}else{
 console.log(JSON.stringify({root}));
 try{
  const child=spawn(process.execPath,[new URL(import.meta.url).pathname,'child',root],{env:process.env,stdio:['ignore','pipe','pipe']});let log='';for(const s of [child.stdout,child.stderr])s.on('data',x=>log+=x);let timer;const exit=await Promise.race([once(child,'close').then(([code,signal])=>({code,signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('child bounded startup timeout'));},1500000);})]).finally(()=>clearTimeout(timer));await fs.writeFile(path.join(root,'evidence/child.log'),log);
  check('independent real host SIGKILL after two acknowledged native worker turns',()=>assert.equal(exit.signal,'SIGKILL'));
  const before=JSON.parse(await fs.readFile(path.join(root,'evidence/prekill.json'))).state;
  c=await Controller.open(options);
  check('stale host recovery retains both slots, original threads and recovery todos without replay',()=>{assertNoReplay(before,c.snapshot());assertSlots(c.snapshot(),2);for(const w of before.works){assert.equal(c.store.find(w.id).status,'paused');assert.ok(c.store.state.todos.some(t=>t.workId===w.id&&t.kind==='recovery'&&t.status==='open'));}for(const j of before.jobs.filter(j=>j.status==='running'))assert.equal(c.store.state.jobs.find(x=>x.id===j.id).status,'interrupted');});
  await write('recovered-before-input',c.snapshot());await c.start();
  for(const w of before.works)await c.send(w.id,`宿主被终止，用户明确要求在原会话继续。先核对input.txt和实际已写文件，保留已发生结果，不重复不必要写入。最终确保${w.name==='故障A'?'a':'b'}.md包含${w.name}前缀、三行编号，读回验证并发布result。禁止Git/CCB/tmux。`);
  await wait(()=>before.works.every(w=>c.store.find(w.id).status==='review')&&!c.running.size,'explicit-resume');
  check('explicit continuation uses same two native threads and publishes real results',()=>{for(const w of before.works){const current=assertReview(c.snapshot(),w.id);assert.equal(current.threadId,w.threadId);}assertSlots(c.snapshot(),2);});
  for(const w of before.works)assert.match(await fs.readFile(path.join(c.execution.directory(w.id),w.name==='故障A'?'a.md':'b.md'),'utf8'),new RegExp(w.name));
  const b=c.store.find(before.works[1].id),session=await c.session(b.id),started=once(session,'turn-started');await c.send(b.id,'继续原工作：检查全部实际文件，写额外核验程序并运行，交详细但简短报告。禁止Git/CCB/tmux。');await started;
  await c.endWork(b.id,{revision:c.store.find(b.id).revision,decision:'discard'});await wait(()=>c.store.find(b.id).status==='ended'&&c.store.find(b.id).closure?.phase==='complete','active-discard');
  check('explicit discard ends active business without ending other Work',()=>{assert.equal(c.store.find(b.id).outcome,'discard');assert.equal(c.store.find(before.works[0].id).status,'review');assertSlots(c.snapshot(),1);assert.ok(c.store.state.jobs.some(j=>j.target===b.id&&j.status==='cancelled'));});
  const a=c.store.find(before.works[0].id);await c.endWork(a.id,{revision:a.revision,decision:'accept'});await wait(()=>c.store.find(a.id).status==='ended'&&c.store.find(a.id).closure?.phase==='complete','normal-end');check('accept safely adopts original result while discarded result stays absent',()=>{assertSlots(c.snapshot(),0);assert.equal(c.store.find(a.id).outcome,'accept');});assert.match(await fs.readFile(path.join(content,'a.md'),'utf8'),/故障A/);await assert.rejects(fs.stat(path.join(content,'b.md')),{code:'ENOENT'});await write('final-state',c.snapshot());
 }catch(e){failure=e;console.error(e.stack);if(c)await write('failure-state',c.snapshot());}
 finally{
  try{await c?.stop();}catch(e){failure??=e;}
  // On an early parent failure, recover only provider records in this new owned lab.
  try{const saved=JSON.parse(await fs.readFile(path.join(runtime,'state.json')));for(const record of Object.values(saved.providers||{}))await recoverProvider(record,runtime);for(const dir of await fs.readdir(path.join(runtime,'agents')))await fs.rm(path.join(runtime,'agents',dir,'auth.json'),{force:true});}catch(e){failure??=e;}
  const audit=await auditRuntime(runtime);if(audit.processes.length||audit.authCopies.length)failure??=Error('cleanup failed');const result={status:failure?'FAIL':'PASS',root,stage,checks,error:failure?.message,audit,cli:execFileSync('codex',['--version'],{encoding:'utf8'}).trim(),node:process.version,platform:os.platform(),scope:'real Backend SIGKILL/two native worker turns; no GUI'};await write('result',result);console.log(JSON.stringify(result));if(failure)process.exitCode=1;
 }
}
