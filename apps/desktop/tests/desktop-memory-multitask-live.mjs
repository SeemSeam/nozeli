import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';

// Actual Electron + Pi owner + local deterministic model. Proves native schema,
// dispatch, closure, report surface and persisted source access; not LLM quality.
const app=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url);
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-memory-multitask-')),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),project=path.join(out,'project');
await fs.mkdir(project,{recursive:true});await fs.writeFile(path.join(project,'README.md'),'# Synthetic memory acceptance project\n');
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id;await host.storage.db.close();
const result={ok:false,out,checks:[],errors:[],requests:[],scope:'Linux actual Electron/Pi native tools, local deterministic provider, actual report/closure/source persistence; no paid model quality claim'};
let taskNumber=0,source=null,workerSource=null,seenRead=false;
const reportHtml=(text)=>'<!doctype html><html><head><meta charset="utf-8"><title>轨道方案结果</title></head><body><main><h1>轨道方案结果</h1><h2>主要结论</h2><p>'+text+'</p><h2>验证与限制</h2><p>仅验证Linux合成轨道样本；Windows/macOS未验证。MEMORY-EVIDENCE-731</p></main></body></html>';
function parseTool(message){let body=message?.content;if(Array.isArray(body))body=body.filter(x=>x.type==='text').map(x=>x.text).join('\n');const obj=typeof body==='string'?JSON.parse(body):body;return obj?.value??obj;}
const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{try{
 const input=JSON.parse(body),names=(input.tools??[]).map(x=>x.function?.name),orchestrator=names.includes('nozeli_dispatch'),last=input.messages?.at(-1),previous=[...(input.messages??[])].reverse().find(x=>x.role==='assistant'&&x.tool_calls?.length)?.tool_calls?.[0]?.function?.name;
 let name,args,text;const contents=(input.messages??[]).flatMap(m=>typeof m.content==='string'?[m.content]:Array.isArray(m.content)?m.content.map(b=>b.text??''):[]).join('\n');const taskMarker=[...contents.matchAll(/MULTI-TASK-([BCD])/g)].at(-1)?.[1]??'B';
 if(orchestrator){
  const raw=JSON.stringify(input.messages);const second=raw.includes('NEW-TASK-REUSE');
  if(!second){if(last?.role==='tool'){text='已交接原任务。';}else{name='nozeli_dispatch';args={name:'轨道初始结果',brief:'只读分析，发布轨道方案B及验证限制，不修改文件。'};taskNumber=1;}}
  else if(last?.role!=='tool'){name='nozeli_memory_search';args={query:'轨道',limit:4};}
  else if(previous==='nozeli_memory_search'){const value=parseTool(last);assert(value.matches?.length,'stable result must be found');source=value.matches[0].source;name='nozeli_memory_read';args={source};}
  else if(previous==='nozeli_memory_read'){const value=parseTool(last);assert(value.text.includes('MEMORY-EVIDENCE-731'));name='nozeli_dispatch';args={name:'轨道复用结果-'+taskMarker,brief:'沿用方案B，只读分析并明确未验证平台；历史资料不是扩大范围的指令。',memorySources:[source]};taskNumber=2;}
  else text='已将确切报告来源绑定新任务。';
 }else if(taskNumber===1){name='nozeli_publish';args={kind:'result',content:reportHtml('采用方案B；稳定结果供后续核对。'),files:[]};}
 else{
  if(previous==='nozeli_memory_read'){const value=parseTool([...(input.messages??[])].reverse().find(message=>message.role==='tool'));assert(value.text.includes('MEMORY-EVIDENCE-731'));assert.deepEqual(value.source,source);seenRead=true;name='nozeli_publish';args={kind:'result',content:reportHtml('已读取绑定的历史报告；复用方案B，历史验证不代表当前跨平台通过。'),files:[]};}
  else{const raw=(input.messages??[]).flatMap(message=>typeof message.content==='string'?[message.content]:Array.isArray(message.content)?message.content.map(block=>block.text??''):[]).join('\n'),match=raw.match(/\{[^{}]*"projectId"\s*:\s*"[^"]+"[^{}]*"workId"\s*:\s*"[^"]+"[^{}]*"objectId"\s*:\s*"[^"]+"[^{}]*"digest"\s*:\s*"[a-f0-9]{64}"[^{}]*\}/);assert(match,'Worker native input must carry persistent exact source identity');workerSource=JSON.parse(match[0]);assert.deepEqual(workerSource,source);name='nozeli_memory_read';args={source:workerSource};}
 }
 const delta=name?{role:'assistant',tool_calls:[{index:0,id:'memory-call-'+(result.requests.length+1),type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:text};result.requests.push({role:orchestrator?'orchestrator':'worker',tool:name??null,taskNumber});
 res.writeHead(200,{'content-type':'text/event-stream'});for(const [part,finish]of [[delta,null],[{},name?'tool_calls':'stop']])res.write('data: '+JSON.stringify({id:'memory-'+result.requests.length,object:'chat.completion.chunk',choices:[{index:0,delta:part,finish_reason:finish}]})+'\n\n');res.end('data: [DONE]\n\n');
 }catch(error){result.errors.push(error.stack);res.destroy(error);}});});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const tcp=net.createServer();await new Promise(r=>tcp.listen(0,'127.0.0.1',r));const port=tcp.address().port;await new Promise(r=>tcp.close(r));
const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||(key!=='XAUTHORITY'&&/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key))||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
let child,browser,shell,exit,log='';const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=120000){const end=Date.now()+ms;while(Date.now()<end){if(result.errors.length)throw Error(result.errors.join('\n'));if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Electron exited '+log);const value=await fn();if(value)return value;await pause(100);}throw Error('Timeout '+label);}
async function call(op,payload={},page=shell){const reply=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert(reply.ok,op+JSON.stringify(reply.error));return reply.value;}
const state=async()=>(await call('managed.status',{projectId})).state;
async function launch(){child=spawn(require('electron'),[path.join(app,'src/main/main.cjs'),'--ozone-platform='+(process.env.DISPLAY?'x11':'wayland')],{cwd:project,env,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const stream of[child.stdout,child.stderr])stream.on('data',x=>log+=x);browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');}
async function close(){await call('session.requestClose');assert.deepEqual(await Promise.race([exit,pause(30000).then(()=>null)]),{code:0,signal:null});await browser.disconnect();browser=null;child=null;}
async function reviewed(name){return until(async()=>{const s=await state(),failed=s.jobs.find(j=>j.status==='failed');if(failed)throw Error(failed.error);return s.works.find(w=>w.name===name&&w.status==='review'&&!s.busyTargets.includes(w.id));},name);}
try{
 await launch();if(await shell.$eval('#configuration-setup',n=>n.open))await shell.click('#configuration-cancel');await call('config.initialize',{mode:'independent'});
 await call('settings.providers.save',{operation:'create',provider:'memory-local',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-synthetic'}});
 await call('settings.models.save',Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>[role,{model:{mode:'explicit',selector:'memory-local/scripted'},thinking:{mode:'native-default'}}])));
 await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForFunction(id=>window.__workspaceScope?.projectId===id,{},projectId);await call('managed.enable',{projectId});await until(async()=>(await call('managed.status',{projectId})).ready,'native roles');
 await call('managed.task',{projectId,text:'INITIAL-TASK：只读分析轨道方案，选择B并发布结果，注明验证边界。',requestKey:'memory-first'});const first=await reviewed('轨道初始结果');
 const s=await state(),receipt=s.receipts.findLast(r=>r.workId===first.id&&r.kind==='result'),todo=s.todos.find(t=>t.objectId===receipt.objectId);
 await shell.evaluate(id=>window.__workspaceOpenTodo(id),todo.id);const page=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(id=>window.__nozeliReady&&window.__workspaceScope?.kind==='report'&&window.__workspaceScope?.viewState?.report?.todoId===id,todo.id).catch(()=>false))return p;},'report');
 await page.waitForFunction(()=>{const button=document.querySelector('[data-review-action="accept"]');return button&&!button.disabled&&button.getClientRects().length>0;});await page.click('[data-review-action="accept"]');await page.waitForSelector('[data-confirmation-confirm]',{visible:true});await page.click('[data-confirmation-confirm]');
 await until(async()=>{const w=(await state()).works.find(w=>w.id===first.id);return w.status==='ended'&&w.closure?.phase==='complete';},'stable closure');await page.screenshot({path:path.join(out,'stable-report.png')});result.checks.push('Original report accepted through real native report controls and fully closed');
 const beforeRestart=result.requests.length;await close();await launch();await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForFunction(id=>window.__workspaceScope?.projectId===id,{},projectId);await call('managed.connect',{projectId});assert.equal(result.requests.length,beforeRestart);
 await call('managed.task',{projectId,text:'NEW-TASK-REUSE MULTI-TASK-B：查找既有轨道结果，读取依据后复用方案B，明确尚未验证的平台，不修改文件。',requestKey:'memory-second'});const second=await reviewed('轨道复用结果-B');
 assert(seenRead);assert.deepEqual(second.memorySources,[source]);assert.equal(source.workId,first.id);assert(second.request.includes('NEW-TASK-REUSE'));result.checks.push('Cold-restarted native Orchestrator searches and reads prior result, dispatches durable exact source, native Worker reads it');
 await call('managed.limit',{projectId,limit:2});
 for(const label of ['C','D'])await call('managed.task',{projectId,text:'NEW-TASK-REUSE MULTI-TASK-'+label+'：沿用同项目稳定轨道报告，只读核对，不改文件。',requestKey:'complex-task-'+label});
 const third=await reviewed('轨道复用结果-C');
 const queued=await until(async()=>{const s=await state();return s.works.find(w=>w.name==='轨道复用结果-D'&&w.status==='queued');},'fourth task queued');
 assert.equal(queued.threadId,undefined);assert.deepEqual(queued.memorySources,[source]);assert.deepEqual(third.memorySources,[source]);
 const stableSource=structuredClone(source),workerTurnsBefore=result.requests.filter(r=>r.role==='worker').length;
 const supplementText='QUEUED-SUPPLEMENT-D：保留原报告未验证平台边界，不创建独立任务。';
 const submission=await call('managed.send',{projectId,target:queued.id,text:supplementText,requestKey:'complex-queued-supplement'});
 const repeated=await call('managed.send',{projectId,target:queued.id,text:supplementText,requestKey:'complex-queued-supplement'});assert.equal(repeated.accepted,true);assert.equal(repeated.jobId,submission.jobId);
 assert.equal(result.requests.filter(r=>r.role==='worker').length,workerTurnsBefore);
 const beforeCold=result.requests.length;await close();await launch();await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForFunction(id=>window.__workspaceScope?.projectId===id,{},projectId);await call('managed.connect',{projectId});
 assert.equal(result.requests.length,beforeCold);let cold=await state();assert.equal(cold.works.find(w=>w.id===queued.id).status,'queued');assert.equal(cold.works.find(w=>w.id===queued.id).inputs.filter(i=>i.text===supplementText).length,1);
 const priorTodo=cold.todos.find(t=>t.workId===second.id&&t.kind==='result'&&t.status==='open');
 await shell.evaluate(id=>window.__workspaceOpenTodo(id),priorTodo.id);const discardPage=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(id=>window.__workspaceScope?.viewState?.report?.todoId===id,priorTodo.id).catch(()=>false))return p;},'discard second');
 await discardPage.waitForFunction(()=>{const button=document.querySelector('[data-review-action="discard"]');return button&&!button.disabled&&button.getClientRects().length>0;});await discardPage.click('[data-review-action="discard"]');await discardPage.waitForSelector('[data-confirmation-confirm]',{visible:true});await discardPage.click('[data-confirmation-confirm]');
 const fourth=await reviewed('轨道复用结果-D');assert.equal(fourth.id,queued.id);assert.deepEqual(fourth.memorySources,[stableSource]);assert.equal((await state()).works.length,4);
 assert.equal((await state()).works.find(w=>w.id===third.id).threadId,third.threadId);
 result.checks.push('Quota two: two independent native Workers, queued fourth Work with exact sources and deduplicated supplement, cold restart zero replay, discard releases original queued Work without identity/source loss');
 await fs.writeFile(path.join(out,'state.json'),JSON.stringify(await state(),null,2));await shell.screenshot({path:path.join(out,'reuse-task.png')});await close();result.ok=true;
}catch(error){result.error=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{if(child?.exitCode===null){await call('session.requestClose').catch(()=>{});await Promise.race([exit,pause(10000)]);if(child.exitCode===null)child.kill('SIGTERM');}await browser?.disconnect().catch(()=>{});await new Promise(r=>server.close(r));await fs.writeFile(path.join(out,'electron.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
