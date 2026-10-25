import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {createAcceptanceCollector} from './acceptance-request-control.mjs';
const run=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
const release=process.argv[2];assert(release&&path.isAbsolute(release));
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-real-workflow-')),project=path.join(out,'sensor-audit'),other=path.join(out,'reading-room');
// Use the existing private broker/config in place. Never copy/read credential files.
const privateRoot='/home/bfly/.Nozeli',profile=path.join(privateRoot,'acceptance-profiles',path.basename(out));
const report={out,release,profile,checks:[],events:[],screenshots:[],results:[],modelRequests:'not yet admitted',scope:'Fixed candidate, actual Electron and native OMP, new synthetic projects; no simulated model replies.'};
let child,browser,shell,chat,collector,exit,log='',stage='G1',projectId;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(fn,label,ms=120000){const end=Date.now()+ms;do{if(child?.exitCode!==null&&child?.exitCode!==undefined)throw Error('Application exited '+log.slice(-1200));const value=await fn();if(value)return value;await pause(300);}while(Date.now()<end);throw Error('Observation deadline: '+label+'; no automatic retry');}
async function call(op,payload={},page=shell){const r=await page.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);if(!r.ok)throw Object.assign(Error(op+': '+r.error.message),{code:r.error.code});return r.value;}
async function state(){return (await call('managed.status',{projectId})).state;}
async function shot(label,page=chat||shell){const file=label+'.png';await page.screenshot({path:path.join(out,file)});report.screenshots.push({label,file,at:Date.now()});}
async function checkpoint(){await fs.writeFile(path.join(out,'report.json'),JSON.stringify({...report,stage},null,2));}
async function compose(text,background=false){await chat.locator('#composer').click();await chat.keyboard.down('Control');await chat.keyboard.press('A');await chat.keyboard.up('Control');await chat.keyboard.sendCharacter(text);assert.equal(await chat.$eval('#composer',n=>n.value),text);const before=new Set((await state()).jobs.map(j=>j.id));const t0=Date.now();if(background)await chat.locator('#managed-submit-task').click();else{await chat.keyboard.down('Control');await chat.keyboard.press('Enter');await chat.keyboard.up('Control');}const job=await wait(async()=>{const s=await state();return s.jobs.find(j=>!before.has(j.id));},'input admission',30000);report.events.push({kind:'sent',jobId:job.id,target:job.target,t0});return job;}
async function settle(job){return wait(async()=>{const s=await state(),j=s.jobs.find(j=>j.id===job.id);if(['failed','interrupted','unknown'].includes(j?.status))throw Error('Native job '+j.status+': '+(j.error||''));if(j?.status==='completed'){report.results.push({jobId:j.id,target:j.target,status:j.status,at:Date.now()});await fs.writeFile(path.join(out,'state-'+j.id+'.json'),JSON.stringify(s,null,2));return s;}return false;},'real round '+job.id,600000);}
try{
 for(const dir of ['materials','src','docs','checks','tools'])await fs.mkdir(path.join(project,dir),{recursive:true});await fs.mkdir(other);await fs.mkdir(profile,{recursive:true});
 const files={
 'materials/readings.csv':'id,time,value\na,2026-01-01T15:59:00Z,10\nb,2026-01-01T16:00:00Z,20\nb,2026-01-01T16:00:00Z,22\nc,2026-01-02T16:00:00Z,\nd,2026-01-02T16:00:01Z,-1\n',
 'materials/schema.md':'CSV id,time,value. Missing is empty. Negative values invalid. Duplicate key=id+time. Units Celsius.\n',
 'materials/policy.md':'Original policy: UTC calendar days. Means use valid readings only.\n',
 'materials/amendment.md':'This amendment overrides policy: group calendar days in UTC+08. Duplicate conflicts require user clarification. All-missing groups must be discussed.\n',
 'src/aggregate.ts':'declare const require:any; const fs=require("node:fs");const rows=fs.readFileSync(process.argv[2],"utf8").trim().split("\\n").slice(1);declare const process:any;const groups:any={};for(const row of rows){const [id,time,v]=row.split(",");const day=time.slice(0,10);(groups[day]??=[]).push(Number(v));}console.log(JSON.stringify(Object.keys(groups).sort().map(day=>({day,mean:groups[day].reduce((a:number,b:number)=>a+b,0)/groups[day].length}))));\n',
 'docs/method.md':'# Method\nThe implementation currently follows UTC days. Pending audit.\n',
 'docs/operator-guide.md':'# Operator guide\nPending implementation.\n','user-notes.txt':'Human owned baseline.\n'};
 for(const [name,text]of Object.entries(files))await fs.writeFile(path.join(project,name),text);
 const compiler=path.resolve(import.meta.dirname,'../node_modules/typescript/bin/tsc');
 await fs.writeFile(path.join(project,'checks/verify.mjs'),`import assert from 'node:assert/strict';import{execFileSync}from'node:child_process';const result=JSON.parse(execFileSync(process.execPath,['build/aggregate.js','materials/readings.csv'],{encoding:'utf8'}));assert.deepEqual(result,[{day:'2026-01-01',mean:10},{day:'2026-01-02',mean:22},{day:'2026-01-03',mean:null}]);console.log('ORACLE PASS');`);
 await fs.writeFile(path.join(project,'tools/wait-gate.mjs'),`import fs from 'node:fs/promises';const seconds=Number(process.argv[2]||75);await fs.writeFile('gate-start.json',JSON.stringify({pid:process.pid,at:Date.now()}));await new Promise(r=>setTimeout(r,seconds*1000));await fs.writeFile('gate-end.json',JSON.stringify({at:Date.now()}));console.log('gate complete');`);
 await fs.writeFile(path.join(project,'TASK.md'),`Compile: node ${compiler} src/aggregate.ts --target es2022 --module commonjs --outDir build --skipLibCheck\nVerify: node checks/verify.mjs\nDo not edit materials or checks. Inputs read-only. No dependency installation/network required.\n`);
 await fs.writeFile(path.join(other,'reading.md'),'# Independent reading\nKeep focus and draft in this project.\n');
 const git=async(...args)=>(await run('git',['-c','user.name=Audit Fixture','-c','user.email=audit@example.invalid',...args],{cwd:project})).stdout.trim();await git('init','--initial-branch=main');await git('add','.');await git('commit','-m','Synthetic audit baseline');
 await run(process.execPath,[compiler,'src/aggregate.ts','--target','es2022','--module','commonjs','--outDir','build','--skipLibCheck'],{cwd:project});let failed=false;try{await run(process.execPath,['checks/verify.mjs'],{cwd:project});}catch{failed=true;}assert(failed);report.checks.push('Independent frozen oracle fails against initial implementation');
 report.materialHashes=Object.fromEntries(await Promise.all(Object.keys(files).filter(p=>p.startsWith('materials/')).concat(['checks/verify.mjs']).map(async p=>[p,hash(await fs.readFile(path.join(project,p)))])));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key))delete env[key];Object.assign(env,{HOME:'/home/bfly',NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:privateRoot,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_HIDDEN:'0'});
 child=spawn(path.join(release,'nozeli'),['--ozone-platform=wayland'],{cwd:project,env,stdio:['ignore','pipe','pipe']});exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);
 await wait(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'desktop',30000);
 shell=await wait(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.role==='shell'&&window.__nozeliReady).catch(()=>false))return p;},'shell');
 await shell.locator('#pick-project').click();projectId=await wait(async()=>{const value=await call('workspace.bootstrap');return value.projectId;},'project bound');
 const settings=await call('settings.providers.status');report.models=settings.defaults;report.sources=settings.sources.map(s=>({provider:s.provider,baseUrl:s.baseUrl}));const selectors=Object.values(settings.defaults).filter(Boolean);assert(selectors.length,'No authorized role defaults; no inference started');
 const destinations=settings.sources.filter(s=>s.baseUrl&&selectors.some(m=>m.startsWith(s.provider+'/'))).flatMap(s=>['/responses','/chat/completions','/messages','/v1/responses','/v1/chat/completions','/v1/messages'].map(route=>s.baseUrl.replace(/\/$/,'')+route));assert(destinations.length,'No observable authorized destination');
 collector=await createAcceptanceCollector({ledgerPath:path.join(out,'requests.json'),maxAttempts:null,maxInputOutput:null,deadlineAt:null,allowedDestinations:destinations,allowedModels:[...new Set(selectors.flatMap(v=>[v,v.slice(v.indexOf('/')+1)]))]});
 const ext=path.join(project,'.omp/extensions');await fs.mkdir(ext,{recursive:true});await fs.writeFile(path.join(ext,'audit-observer.ts'),`import{installAcceptanceControl}from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname,'acceptance-request-control.mjs')).href)};export default pi=>installAcceptanceControl(pi,{endpoint:${JSON.stringify(collector.endpoint)},roleInstance:process.env.PI_CODING_AGENT_DIR||process.env.NOZELI_AGENT_DIR,brokerURL:process.env.OMP_AUTH_BROKER_URL||null});`);
 await git('add','TASK.md','checks','tools','.omp');await git('commit','-m','Freeze independent oracle and observation setup');report.baselineCommit=await git('rev-parse','HEAD');
 await shell.locator('#workspace-open-conversation').click();chat=await wait(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__workspaceScope?.kind==='conversation'&&window.__nozeliReady).catch(()=>false))return p;},'native conversation');
 report.initialState=await state();assert.equal(report.initialState.jobs.length,0);await checkpoint();
 stage='A02';const first=await compose('阅读 materials 四份材料，指出优先级及未决问题。先只修改 docs/method.md 中可以确定的规则，不改算法，不创建后台任务。重复冲突处理和全缺测日请向我澄清。请使用真实文件，不需要联网。');await settle(first);assert.equal((await state()).works.length,0);assert((await fs.readFile(path.join(project,'docs/method.md'),'utf8')).includes('08'));await shot('A02-frontdesk');report.checks.push('Real GUI frontdesk read and modified method without Worker');
 const clarification=await compose('重复键冲突保留最后出现的有效记录；全缺测日输出 null，不写成 0。请把这项澄清写入 docs/method.md。沿原前台讨论，不创建后台任务。');await settle(clarification);await shot('A02-clarification');await checkpoint();
 stage='A03';const dispatch=await compose('请通过主控开展两个独立后台工作：算法工作只修 src/aggregate.ts，按 TASK.md 实际编译并运行 checks/verify.mjs；文档工作只修 docs/operator-guide.md，说明 UTC+08、最后有效重复值和全缺测日 null，含跨日示例。两项工作分别提交，不互改文件，不改 materials/checks。先不要采用候选。',true);await settle(dispatch);
 await wait(async()=>{const s=await state();if(s.works.some(w=>w.status==='paused'))throw Error('Work paused: '+JSON.stringify(s.works.filter(w=>w.status==='paused').map(w=>({id:w.id,problem:w.problem}))));return s.works.length>=2&&s.works.every(w=>['review','ended'].includes(w.status))&&s.busyTargets.length===0;},'two independent real results',900000);
 report.finalState=await state();await fs.writeFile(path.join(out,'final-state.json'),JSON.stringify(report.finalState,null,2));await shot('A03-real-results');report.checks.push('Two real background work results reached review');
 for(const [p,digest]of Object.entries(report.materialHashes))assert.equal(hash(await fs.readFile(path.join(project,p))),digest);report.checks.push('Original materials and independent checks unchanged');stage='complete-normal-subset';report.ok=true;
}catch(error){report.failure={stage,code:error.code,message:error.message,stack:error.stack};if(shell){await shot('failure',chat||shell).catch(()=>{});if(projectId)await fs.writeFile(path.join(out,'failure-state.json'),JSON.stringify(await state().catch(()=>null),null,2));}process.exitCode=1;}
finally{report.requests=collector?.snapshot();report.modelRequests=report.requests?Object.keys(report.requests.attempts).length:0;await checkpoint();await fs.writeFile(path.join(out,'electron.log'),log);if(shell&&child?.exitCode===null){await call('session.requestClose').catch(()=>{});await pause(300);if(await shell.$eval('#quit-choice',n=>n.open).catch(()=>false))await shell.click('#quit-cancel');await Promise.race([exit,pause(90000)]);}await browser?.disconnect();await collector?.stop('audit-finished');await collector?.close();report.exit=child?{code:child.exitCode,signal:child.signalCode}:null;await checkpoint();console.log(JSON.stringify({out,stage,ok:report.ok,failure:report.failure,modelRequests:report.modelRequests,exit:report.exit}));}
