import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {staticReport} from './static-report.fixture.mjs';

const args=process.argv.slice(2), releaseAt=args.indexOf('--release');
const release=releaseAt<0?null:path.resolve(args[releaseAt+1]);
const realModel=args.includes('--real-model');
const source=path.resolve(import.meta.dirname,'..');
const app=release?path.join(release,'resources/app'):source;
const {DesktopHost}=await import(pathToFileURL(path.join(app,'src/main/host.mjs')));
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-trusted-permissions-'));
const realHome=os.userInfo({encoding:'utf8'}).homedir;
const config=realModel?path.join(realHome,'.Nozeli'):path.join(out,'.Nozeli');
const profile=realModel?path.join(config,'acceptance-profiles',path.basename(out)):path.join(config,'desktop');
const project=path.join(out,'project'),external=path.join(out,'external');
await fs.mkdir(project);await fs.mkdir(external);
await fs.writeFile(path.join(project,'README.md'),'Synthetic trusted execution fixture\n');
await fs.writeFile(path.join(external,'input.txt'),'TRUSTED_EXTERNAL_READ');
const host=new DesktopHost(profile),id=(await host.pick(project)).project.id;
await host.storage.db.close();
const command=process.execPath;
const argsFor=name=>['-e',`require('node:fs').appendFileSync(${JSON.stringify(path.join(external,name))},'EXECUTED_ONCE\\n')`];
const nativeCommand=name=>JSON.stringify(command)+' -e '+JSON.stringify(`const fs=require('node:fs');const value=fs.readFileSync(${JSON.stringify(path.join(external,'input.txt'))},'utf8');if(value!=='TRUSTED_EXTERNAL_READ')throw Error(value);fs.writeFileSync(${JSON.stringify(path.join(external,name))},value);console.log(value);`);
const effect=(name,elevation='user')=>({command,args:argsFor(name),cwd:external,purpose:'Synthetic authorized execution; wait for the user todo',elevation});
let turn=0,stage=0,workerStep=0,workerResumed=false,workerResumeStep=0,orchestratorStep=0;
let child,browser,shell,exit,log='';
const report={out,app,release,realModel,profile,ok:false,checks:[],requests:[],errors:[],boundary:'Real Electron/private OMP/current-user processes and synthetic files. Administrator request is rejected before OS authentication. No actual system elevation.'};
const tool=(name,values,callId)=>({role:'assistant',tool_calls:[{index:0,id:callId,type:'function',function:{name,arguments:JSON.stringify(values)}}]});
const server=realModel?null:http.createServer((req,res)=>{
  let body='';req.on('data',b=>body+=b);req.on('end',()=>{
    try{
      const input=JSON.parse(body),names=(input.tools??[]).map(t=>t.function?.name??t.name);
      const lastTool=(input.messages??[]).findLast(message=>message.role==='tool');
      if(lastTool){report.toolReplies??=[];report.toolReplies.push({turn,content:JSON.stringify(lastTool.content).slice(0,8192)});report.toolReplies=report.toolReplies.slice(-12);}
      if(report.requests.length>100)throw Error('Native tool sequence exceeded scenario bounds; inspect actual tool replies');
      let delta,finish='tool_calls',role='frontdesk';
      if(turn===5&&names.includes('nozeli_publish')){
        role='worker';
        if(!workerResumed){
          if(workerStep++===0)delta=tool('bash',{command:nativeCommand('worker-ordinary.txt')},'worker-native');
          else delta=tool('nozeli_privileged_execute',effect('worker-approved.txt'),'worker-pending');
        }else if(workerResumeStep++===0)delta=tool('nozeli_privileged_execute',effect('worker-approved.txt'),'worker-approved');
        else delta=tool('nozeli_publish',{kind:'result',html:staticReport('Verified native ordinary execution and approved sensitive command exactly once. Only synthetic external markers were changed.'),files:[]},'worker-publish');
      }else if(turn===5&&names.includes('nozeli_dispatch')){
        role='orchestrator';
        if(orchestratorStep++===0)delta=tool('bash',{command:nativeCommand('orchestrator-ordinary.txt')},'orchestrator-native');
        else delta=tool('nozeli_dispatch',{name:'授权执行核验',brief:'Execute native ordinary and approved sensitive synthetic commands, then publish a result.'},'dispatch-worker');
      }else if(turn===1&&stage++===0)delta=tool('bash',{command:nativeCommand('ordinary.txt')},'ordinary-bash');
      else if((turn===2||turn===3)&&stage++===0)delta=tool('nozeli_privileged_execute',effect(turn===2?'approved.txt':'denied.txt',turn===3?'admin':'user'),'sensitive-'+turn);
      else if(turn===4&&stage++===0)delta=tool('nozeli_privileged_execute',effect('approved.txt'),'approved-continuation');
      else{delta={role:'assistant',content:'Observed host execution result; no additional actions.'};finish='stop';}
      report.requests.push({turn,role,tool:delta.tool_calls?.[0]?.function.name??null});
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const[part,end]of[[delta,null],[{},finish]])res.write('data: '+JSON.stringify({id:'trusted-'+report.requests.length,object:'chat.completion.chunk',choices:[{index:0,delta:part,finish_reason:end}]})+'\n\n');
      res.end('data: [DONE]\n\n');
    }catch(error){report.errors.push(error.stack);res.destroy(error);}
  });
});
if(server)await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const env={...process.env};
for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];
Object.assign(env,{HOME:realModel?realHome:os.homedir(),NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=realModel?600000:120000){
  const end=Date.now()+ms;
  while(Date.now()<end){
    if(report.errors.length)throw Error(report.errors.join('\n'));
    if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error(log);
    const value=await fn();if(value)return value;await pause(100);
  }
  throw Error('Timed out '+label+'; no automatic replay');
}
async function call(op,p={},page=shell){const r=await page.evaluate(({op,p})=>nozeli.invoke(op,p),{op,p});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
const state=async()=>(await call('managed.status',{projectId:id})).state;
async function send(text,next){turn=next;stage=0;return call('managed.send',{projectId:id,target:'frontdesk',text,requestKey:'trusted-'+next});}
async function permission(target){return until(async()=>{
  const s=await state(),failed=s.jobs.find(j=>j.status==='failed');if(failed)throw Error(failed.error);
  return s.todos.find(t=>t.status==='open'&&t.destination?.kind==='effect-permission'&&(!target||s.jobs.find(j=>j.id===t.sourceJobId)?.target===target));
},'sensitive todo');}
async function choose(todo,action,label){
  await shell.evaluate(id=>window.__workspaceOpenTodo(id),todo.id);
  const selector='section[data-attention-kind="effect-permission"][data-attention-id="'+todo.destination.requestId+'"]';
  const page=await until(async()=>{for(const p of await browser.pages())if(await p.$(selector).catch(()=>null))return p;},'effect decision surface');
  assert.equal(await page.$$eval(selector+' input',nodes=>nodes.some(n=>n.checked)),false,'no implicit agreement');
  await page.screenshot({path:path.join(out,label+'-before.png')});
  await page.click(selector+' input[data-attention-permission-action="'+action+'"]');
  await page.click(selector+' [data-attention-submit]');
  await page.screenshot({path:path.join(out,label+'-decided.png')});
}
async function checkMarker(name,expected){await until(()=>fs.readFile(path.join(external,name),'utf8').then(v=>v===expected,()=>false),'marker '+name);}
async function absent(name){assert.equal(await fs.access(path.join(external,name)).then(()=>true,()=>false),false,name+' must not be executed');}
async function settled(){await until(async()=>{const s=await state(),failed=s.jobs.find(j=>j.status==='failed');if(failed)throw Error(failed.error);return !s.busyTargets.length;},'native settlement');}
function requestedEffect(name,elevation='user'){return '直接调用 nozeli_privileged_execute，参数严格为 '+JSON.stringify(effect(name,elevation))+'。这是用户明确请求的合成验收。不得改用bash绕过待办，不得修改参数，不得自行执行；先等待待办决定。批准后仅执行该命令一次并据实报告，不要重复执行，不要派其他任务。';}
try{
  const executable=release?path.join(release,'nozeli'):createRequire(import.meta.url)('electron');
  child=spawn(executable,[...(release?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform=wayland'],{cwd:project,env,stdio:['ignore','pipe','pipe']});
  exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  for(const s of[child.stdout,child.stderr])s.on('data',b=>log+=b);
  browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP',30000);
  shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
  shell.on('pageerror',error=>report.errors.push(error.message));
  if(await shell.$eval('#configuration-setup',n=>n.open))await shell.click('#configuration-cancel');
  if(!realModel){
    await call('config.initialize',{mode:'independent'});
    await call('settings.providers.save',{provider:'trusted-local',model:'scripted',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',api:'openai-completions',key:'synthetic-local-only'});
    await call('settings.models.save',{frontdesk:'trusted-local/scripted',orchestrator:'trusted-local/scripted',worker:'trusted-local/scripted'});
  }
  await shell.click('[data-project-id="'+id+'"]');
  await shell.waitForFunction(id=>window.__workspaceScope?.projectId===id,{},id);
  await call('managed.enable',{projectId:id});
  await until(async()=>(await call('managed.status',{projectId:id})).ready,'native owners');
  await send('请直接使用原生bash执行这条用户明确授权的普通命令，无需额外授权、不要派后台任务：'+nativeCommand('ordinary.txt')+'。仅读取并创建指定合成文件。',1);
  await checkMarker('ordinary.txt','TRUSTED_EXTERNAL_READ');await settled();
  report.checks.push('frontdesk native bash reads/writes external synthetic files without bwrap or path permission gate');
  await send(requestedEffect('approved.txt'),2);
  const approved=await permission('frontdesk');await absent('approved.txt');turn=4;stage=0;
  await choose(approved,'approve-once','frontdesk-approval');
  await checkMarker('approved.txt','EXECUTED_ONCE\n');await settled();
  assert.equal(await fs.readFile(path.join(external,'approved.txt'),'utf8'),'EXECUTED_ONCE\n');
  report.checks.push('frontdesk todo approval resumes native Agent and actual broker command exactly once');
  await send(requestedEffect('denied.txt','admin'),3);
  const denied=await permission('frontdesk');await absent('denied.txt');
  await choose(denied,'deny','administrator-denial');
  await until(async()=>!(await state()).todos.some(t=>t.id===denied.id&&t.status==='open'),'deny settled');
  await settled();await absent('denied.txt');
  report.checks.push('administrator request has no default agreement; rejection never launches an elevated command');
  turn=5;
  await call('managed.task',{projectId:id,requestKey:'trusted-worker',text:'新建独立工作，名称“授权执行核验”。主控先使用原生bash执行普通命令 '+nativeCommand('orchestrator-ordinary.txt')+'，再派给Worker，不要自行完成Worker工作。Worker先使用原生bash执行 '+nativeCommand('worker-ordinary.txt')+'，然后 '+requestedEffect('worker-approved.txt')+' 完成批准命令后通过nozeli_publish发布result，text说明真实验证，files为空。不修改项目文件，不调用其他Agent，不操作Git。'});
  const work=await until(async()=>(await state()).works.find(w=>w.name==='授权执行核验'),'actual Worker');
  const workerTodo=await permission(work.id),before=(await state()).works.find(w=>w.id===work.id);
  await checkMarker('orchestrator-ordinary.txt','TRUSTED_EXTERNAL_READ');
  await checkMarker('worker-ordinary.txt','TRUSTED_EXTERNAL_READ');await absent('worker-approved.txt');
  workerResumed=true;
  await choose(workerTodo,'approve-once','worker-approval');
  await checkMarker('worker-approved.txt','EXECUTED_ONCE\n');
  const reviewed=await until(async()=>{const s=await state(),w=s.works.find(w=>w.id===work.id),failed=s.jobs.find(j=>j.target===work.id&&j.status==='failed');if(failed)throw Error(failed.error);return w?.status==='review'&&!s.busyTargets.includes(work.id)?w:null;},'Worker publishes after authorization');
  assert.equal(reviewed.threadId,before.threadId,'approval resumes the original native Worker');
  assert.equal(await fs.readFile(path.join(external,'worker-approved.txt'),'utf8'),'EXECUTED_ONCE\n');
  report.checks.push('orchestrator and Worker native commands are not clipped by role; Worker approval resumes same thread, executes once and publishes real result');
  await fs.writeFile(path.join(out,'settled-state.json'),JSON.stringify(await state(),null,2));
  await call('session.requestClose');report.exit=await Promise.race([exit,pause(30000).then(()=>null)]);
  assert.deepEqual(report.exit,{code:0,signal:null});report.ok=true;
}catch(error){
  report.error=error.stack;process.exitCode=1;
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  if(shell)await fs.writeFile(path.join(out,'failure-state.json'),JSON.stringify(await Promise.race([state().catch(()=>null),pause(2000).then(()=>null)]),null,2));
}finally{
  await fs.writeFile(path.join(out,'main.log'),log);
  if(child?.exitCode===null){
    await Promise.race([call('session.requestClose').catch(()=>{}),pause(2000)]);await Promise.race([exit,pause(10000)]);
    if(child.exitCode===null){report.forcedCleanup=true;child.kill('SIGTERM');await Promise.race([exit,pause(3000)]);if(child.exitCode===null){child.kill('SIGKILL');await Promise.race([exit,pause(3000)]);}}
  }
  await browser?.disconnect().catch(()=>{});
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await fs.writeFile(path.join(out,'main.log'),log);
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}
