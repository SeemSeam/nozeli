// Minimal real-Electron regression for the doodle card's 提交后台任务:
// a real click routes the SAME frozen attachment (digest + capture sources)
// through managed.task, the same task is received exactly once, a real host
// gate refusal keeps the draft, and a real native Pi Worker runs one minimal
// goal through the loopback scripted provider — the frontdesk is never
// invoked. Reuses the existing helpers (pi-provider fixture, DesktopHost
// seeding, aria/window-control/appearance patterns). Narrow-screen 320/390
// light/dark evidence rides the same run as real reachability screenshots.
// Parent run (from apps/desktop):
//   DISPLAY=:1 TMPDIR=/var/tmp NOZELI_OZONE=x11 node tests/desktop-workspace-drawing-background-live.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {serve} from './pi-provider.fixture.mjs';

const source=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-drawing-background-')),project=path.join(out,'project'),config=path.join(out,'config'),profile=path.join(config,'desktop');
await fs.mkdir(project);await fs.writeFile(path.join(project,'input.txt'),'USER INPUT MUST REMAIN UNCHANGED\n');
const host=new DesktopHost(profile),projectId=(await host.registerDirectory(project)).id;
const captureDirectory=path.join(await host.storage.recoveryDirectory(projectId),'drawing-captures');
const registered=await host.storage.requireRegistered(projectId);registered.semanticInitializationEligible=false;await host.storage.db.request(host.storage.catalog,'put',{collection:'instances',id:projectId,value:registered});
await host.storage.db.close();
const requests=[];
const provider=await serve(request=>{
  const names=request.tools.map(tool=>tool.function?.name||tool.name),role=names.includes('nozeli_dispatch')?'orchestrator':names.includes('nozeli_publish')?'worker':'frontdesk';requests.push(role);
  if(role==='orchestrator')return {id:'dispatch-drawing',tool:'nozeli_dispatch',args:{name:'DRAWING_BACKGROUND',brief:'Create result.txt containing exactly DRAWING_BACKGROUND in the dedicated execution worktree, then publish result.txt with a static HTML result.'}};
  if(role==='worker'&&requests.filter(r=>r==='worker').length===1)return {id:'write-drawing',tool:'bash',args:{command:"printf DRAWING_BACKGROUND > result.txt"}};
  if(role==='worker')return {id:'publish-drawing',tool:'nozeli_publish',args:{kind:'result',content:'<!doctype html><html><head><title>Drawing background result</title></head><body><main><h1>DRAWING_BACKGROUND complete</h1></main></body></html>',files:['result.txt']}};
  return {text:'FRONTDESK_MUST_NOT_BE_CALLED'};
});
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
const report={ok:false,out,project:projectId,checks:[],shots:[],scope:'Actual source Electron, native Pi owners, real host intake and real Git worktree; loopback scripted provider only; isolated synthetic project, no user data'};
let child,browser,shell,log='',exited;const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){if(child&&child.exitCode!==null)throw Error('App exited '+log.slice(-3000));const value=await fn();if(value)return value;await pause(60);}throw Error('Timeout '+label);}
async function call(page,op,args={}){const result=await page.evaluate(({op,args})=>window.nozeli.invoke(op,args),{op,args});assert(result.ok,op+': '+JSON.stringify(result.error));return result.value;}
async function state(){return (await call(shell,'managed.status',{projectId})).state;}
const raf=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
function check(name,ok,detail){report.checks.push({name,ok:!!ok,detail});}
// Real reachability: rendered, inside the viewport, and the element (or a
// descendant) is the top hit at its center — not mere DOM presence.
const reachableSource=sel=>{
  const el=document.querySelector(sel);if(!el)return {ok:false,sel,why:'missing'};
  if(!el.getClientRects().length)return {ok:false,sel,why:'not-rendered'};
  const r=el.getBoundingClientRect();
  if(r.width<=0||r.height<=0)return {ok:false,sel,why:'zero-size'};
  if(r.right<4||r.bottom<4||r.left>innerWidth-4||r.top>innerHeight-4)return {ok:false,sel,why:'outside-viewport',rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight}};
  const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
  return {ok:!!hit&&(hit===el||el.contains(hit)),sel,hit:hit?String(hit.className||hit.tagName).slice(0,60):null};
};
async function assertReachable(label){
  const results=[];for(const sel of ['.snapshot-card-title','.snapshot-card-text','.snapshot-card-send','.snapshot-card-task'])results.push(await shell.evaluate(reachableSource,sel));
  const failed=results.filter(r=>!r.ok);
  check('reachable · '+label,failed.length===0,failed.length?failed:results.map(r=>r.sel));
  (report.layout??=[]).push({label,results});
}
async function openDoodle(){
  await shell.click('#workspace-drawing');
  await shell.waitForSelector('dialog[aria-label="工作面涂鸦"] .drawing-area',{visible:true});
  const area=await shell.$eval('dialog[aria-label="工作面涂鸦"] .drawing-area',n=>n.getBoundingClientRect().toJSON());
  await shell.mouse.move(area.x+area.width*.25,area.y+area.height*.3);await shell.mouse.down();
  await shell.mouse.move(area.x+area.width*.55,area.y+area.height*.55,{steps:12});await shell.mouse.up();
  await shell.click('#snapshot-drawing-finish');
  await shell.waitForSelector('[data-local-window-owner-kind="snapshot"]',{visible:true});
  await shell.waitForSelector('.snapshot-card-task',{visible:true});
  await shell.waitForSelector('.snapshot-card-send',{visible:true});
}
try{
  const binary=process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron');report.binary=binary;
  child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(source,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||'x11')],{cwd:source,env,stdio:['ignore','pipe','pipe']});
  exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);
  browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
  shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'shell');
  shell.on('pageerror',e=>{(report.errors??=[]).push(e.message);});
  if(await shell.$eval('#configuration-setup',n=>n.open).catch(()=>false))await shell.click('#configuration-cancel');
  await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForSelector('#file-tree [data-path="input.txt"]');
  await shell.click('#file-tree [data-path="input.txt"]');await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath==='input.txt').catch(()=>false))return true;return false;},'visible input document');

  // ---- Failure retention against the real host gate: no agent is enabled
  // yet, so the click is refused, the draft stays and nothing dispatches.
  await openDoodle();
  check('dual actions rendered: 发送讨论 + 提交后台任务',
    await shell.$eval('.snapshot-card-task',n=>!n.disabled&&!n.hidden)
    &&await shell.$eval('.snapshot-card-send',n=>n.textContent==='发送讨论'&&!n.hidden));
  await shell.type('.snapshot-card-text','REFUSED_BEFORE_AGENT');
  await shell.click('.snapshot-card-task');
  await shell.waitForFunction(()=>document.querySelector('.snapshot-card-status')?.textContent.includes('提交失败'));
  check('real gate refusal keeps the draft and dispatches nothing',
    await shell.$eval('.snapshot-card-text',n=>n.value==='REFUSED_BEFORE_AGENT')&&(await state()).jobs.length===0&&requests.filter(r=>typeof r==='string').length===0,
    {status:await shell.$eval('.snapshot-card-status',n=>n.textContent)});
  await shell.click('aria/仅保存本地');
  await shell.waitForFunction(()=>!document.querySelector('dialog[aria-label="工作面涂鸦"]')?.open);

  // ---- Real managed + native Pi through the loopback scripted provider.
  const cfg=await call(shell,'config.status');if(cfg.choiceRequired)await call(shell,'config.initialize',{mode:'independent'});
  await call(shell,'settings.providers.save',{operation:'create',provider:'drawing-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'nonsecret-local-fixture'}});
  await call(shell,'settings.models.save',Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>[role,{model:{mode:'explicit',selector:'drawing-local/scripted'},thinking:{mode:'native-default'}}])));
  await call(shell,'managed.enable',{projectId});

  // ---- The core background path: real click → real managed.task reception.
  await openDoodle();
  const threadBefore=await shell.$$eval('.snapshot-card-thread .tag-message',nodes=>nodes.length);
  await shell.type('.snapshot-card-text','REAL_BACKGROUND_QUESTION');
  const firstClick=shell.click('.snapshot-card-task');const secondClick=shell.click('.snapshot-card-task');await Promise.all([firstClick,secondClick]);
  const intake=await until(async()=>{const s=await state();return s.jobs.find(j=>j.type==='intake'&&j.target==='orchestrator');},'real managed.task intake',90000);
  await pause(700);
  const s=await state();
  check('repeated real clicks create exactly one orchestrator intake and never a frontdesk round',
    s.jobs.filter(j=>j.type==='intake'&&j.target==='orchestrator').length===1&&s.jobs.filter(j=>j.type==='front').length===0&&requests.filter(r=>r==='frontdesk').length===0,
    {jobs:s.jobs.map(j=>({id:j.id,type:j.type,target:j.target,key:j.key,status:j.status}))});
  check('the intake is a manual task keyed by the submission requestKey',typeof intake.key==='string'&&intake.key.startsWith('task:')&&intake.context?.manual===true,{key:intake.key});
  const resultFiles=await fs.readdir(captureDirectory).catch(()=>[]);
  const receipts=await Promise.all(resultFiles.filter(n=>n.endsWith('.result.json')).map(async n=>JSON.parse(await fs.readFile(path.join(captureDirectory,n),'utf8'))));
  const receipt=receipts.find(r=>(r.card?.backgroundSubmissions||[]).some(row=>row.question==='REAL_BACKGROUND_QUESTION'));
  const intakeAttachment=(intake.context?.imageAttachments||[])[0];
  const intakeSources=intake.context?.drawingSources?.[0]?.sources??intakeAttachment?.sources??null;
  check('the frozen doodle attachment and its capture sources reach the host intake verbatim',
    Boolean(receipt&&intakeAttachment&&intakeAttachment.digest===receipt.attachment.digest&&receipt.attachment.sources?.length>0
      &&JSON.stringify(intakeSources)===JSON.stringify(receipt.attachment.sources)),
    {receiptDigest:receipt?.attachment?.digest??null,intakeDigest:intakeAttachment?.digest??null,receiptSources:receipt?.attachment?.sources??null,intakeSources});
  const work=await until(async()=>{const latest=await state();return latest.works.find(w=>w.name==='DRAWING_BACKGROUND'&&w.status==='review');},'real direct background work in review',90000);
  check('a real native Worker executed the one minimal goal in its own worktree; the project stays untouched',
    await fs.readFile(path.join(work.execution.directory,'result.txt'),'utf8').then(t=>t==='DRAWING_BACKGROUND').catch(()=>false)
    &&await fs.stat(path.join(project,'result.txt')).then(()=>false,()=>true)
    &&await fs.readFile(path.join(project,'input.txt'),'utf8').then(t=>t==='USER INPUT MUST REMAIN UNCHANGED\n'),
    {worktree:work.execution.directory});
  await shell.waitForFunction(()=>document.querySelector('.snapshot-card-text')?.value==='');
  check('accepted submission clears the card input and adds no discussion round',
    await shell.$$eval('.snapshot-card-thread .tag-message',nodes=>nodes.length)===threadBefore
    &&await shell.$eval('.snapshot-card-task-receipt',n=>!n.hidden&&n.textContent.includes('后台提交记录')&&n.textContent.includes('REAL_BACKGROUND_QUESTION')));
  await shell.screenshot({path:path.join(out,'card-after-submit.png')});report.shots.push('card-after-submit.png');

  // ---- Narrow-screen evidence rides the same run: real 320/390 light/dark
  // screenshots with title/input/dual actions reachable by hit-testing.
  await shell.type('.snapshot-card-text','后写的新输入');
  for(const theme of ['light','dark']){
    await call(shell,'settings.appearance.save',{theme,palette:'sage',font:'system',size:14});
    await shell.waitForFunction(theme=>document.documentElement.dataset.theme===theme,{},theme);
    for(const width of [390,320]){
      await call(shell,'workspace.control',{type:'window-control',action:'resize',width,height:640});
      await until(async()=>Math.abs((await call(shell,'workspace.control',{type:'window-control',action:'state'})).contentSize.width-width)<=2,'resize '+width);
      await raf(shell);await pause(120);
      await assertReachable(theme+'-'+width);
      const shot='layout-'+theme+'-'+width+'.png';await shell.screenshot({path:path.join(out,shot)});report.shots.push(shot);
    }
  }
  check('later typed input survives every layout change',await shell.$eval('.snapshot-card-text',n=>n.value==='后写的新输入'));
  assert.deepEqual(requests.filter(r=>typeof r==='string'),['orchestrator','worker','worker'],'exactly the one scripted background goal ran; no replay and no frontdesk turn');
  const exitReceipt=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
  await call(shell,'session.requestClose');
  report.exit=await Promise.race([exitReceipt,pause(30000).then(()=>null)]);
  assert.deepEqual(report.exit,{code:0,signal:null},'clean app exit');
  report.ok=report.checks.every(c=>c.ok);
}catch(error){
  report.error=error.stack;process.exitCode=1;
  report.ui=await shell?.evaluate(()=>({status:document.querySelector('.snapshot-card-status')?.textContent??null,value:document.querySelector('.snapshot-card-text')?.value??null,taskButton:document.querySelector('.snapshot-card-task')?.outerHTML??null,text:document.body.innerText.slice(-1200)})).catch(()=>null);
  await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
}finally{
  if(child?.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
  await browser?.disconnect().catch(()=>{});
  await provider.close();
  await fs.writeFile(path.join(out,'electron.log'),log);
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({ok:report.ok,out,error:report.error,checks:report.checks,shots:report.shots},null,2));
}
