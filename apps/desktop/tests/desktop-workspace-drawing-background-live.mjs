// Real-Electron drawing discussion regression: a physical click submits the
// frozen composite through managed.task exactly once, then explicit foreground
// discussion and follow-up reuse the same evidence. The real native Pi owners
// use a loopback scripted provider; received image pixels and frozen coordinates
// are checked, not just attachment references. Actual source editing/Git stays
// real, personal credentials are scrubbed, and model understanding is not claimed.
// Source settings round-trip, pending retention, 320/390 light/dark and actual
// shared-window resize/reachability ride the same run.
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
import {createCanvas,loadImage} from '@napi-rs/canvas';
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
  return {text:requests.filter(role=>role==='frontdesk').length===1?'FRONTDESK_IMAGE_REPLY\n\n'+Array.from({length:12},(_,i)=>'讨论段落 '+(i+1)+'：这是脚本提供的回复，用于核对完整对话可滚动阅读，不冒充真实模型读图。').join('\n\n'):'FRONTDESK_FOLLOWUP_REPLY'};
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
  await shell.click('aria/涂鸦讨论更多操作');
  await shell.click('aria/仅保存本地');
  await shell.waitForFunction(()=>!document.querySelector('dialog[aria-label="工作面涂鸦"]')?.open);

  // ---- Real managed + native Pi through the loopback scripted provider.
  const cfg=await call(shell,'config.status');if(cfg.choiceRequired)await call(shell,'config.initialize',{mode:'independent'});
  await call(shell,'settings.providers.save',{operation:'create',provider:'drawing-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted',images:true}],credential:{action:'replace',value:'nonsecret-local-fixture'}});
  await call(shell,'settings.models.save',Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>[role,{model:{mode:'explicit',selector:'drawing-local/scripted'},thinking:{mode:'native-default'}}])));
  await shell.click('#open-settings');await shell.click('[data-settings-section="settings-provider"]');
  await shell.waitForSelector('[data-provider-edit="drawing-local"]');await shell.click('[data-provider-edit="drawing-local"]');
  await shell.click('[data-provider-api-form] button[type="submit"]');
  await until(async()=>{const status=await call(shell,'settings.providers.status');return status.sources.some(source=>source.provider==='drawing-local'&&source.revision===2);},'real source form saves the existing image declaration without exposing/replacing its key');
  await shell.click('#settings-close');
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
  check('the sent image retains its frozen source identities without inventing a file selection',
    Boolean(receipt&&intakeAttachment&&intakeAttachment.digest===receipt.attachment.digest
      &&intakeSources.some(source=>source.relPath==='input.txt'&&source.locationStatus==='viewport-only'&&source.selection===null)),
    {receiptDigest:receipt?.attachment?.digest??null,intakeDigest:intakeAttachment?.digest??null,intakeSources});
  const work=await until(async()=>{const latest=await state();return latest.works.find(w=>w.name==='DRAWING_BACKGROUND'&&w.status==='review');},'real direct background work in review',90000);
  const wireImages=provider.requests.filter(r=>!r.listing).flatMap(r=>(r.messages||[]).flatMap(m=>Array.isArray(m.content)?m.content:[])).filter(part=>part.type==='image_url').map(part=>part.image_url?.url).filter(url=>url?.startsWith('data:image/png;base64,'));
  const sentPng=wireImages[0]?Buffer.from(wireImages[0].slice('data:image/png;base64,'.length),'base64'):null;
  let receivedInk=false,receivedImage=null;
  if(sentPng){
    const image=await loadImage(sentPng),canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    const stroke=receipt.drawing.strokes[0],point=stroke.points[Math.floor(stroke.points.length/2)],pixel=ctx.getImageData(Math.min(image.width-1,Math.floor(point[0]*image.width)),Math.min(image.height-1,Math.floor(point[1]*image.height)),1,1).data;
    const rgb=stroke.color.slice(1).match(/../g).map(hex=>parseInt(hex,16));
    receivedInk=rgb.every((value,i)=>Math.abs(pixel[i]-value)<=12)&&Math.abs(image.width*receipt.drawing.height-image.height*receipt.drawing.width)<=Math.max(receipt.drawing.width,receipt.drawing.height);
    receivedImage={pixel:Array.from(pixel),color:stroke.color,point,width:image.width,height:image.height,originalWidth:receipt.drawing.width,originalHeight:receipt.drawing.height};
  }
  check('actual native Pi HTTP request carries the composite image with its ink at the same normalized position (SDK proportional resizing allowed)',receivedInk,{imageCount:wireImages.length,receivedImage});
  const focus=intakeSources?.find(source=>source.kind==='drawing-focus');
  const modelText=provider.requests.filter(r=>!r.listing).flatMap(r=>(r.messages||[]).flatMap(m=>typeof m.content==='string'?[m.content]:(m.content||[]).filter(p=>p.type==='text').map(p=>p.text))).join('\n');
  check('the native model request receives frozen-image coordinates and explicit viewport limitations',focus?.drawing?.strokeCount===receipt.drawing.strokes.length&&focus?.image?.width===receipt.drawing.width&&focus?.sourceRegions?.some(region=>region.relPath==='input.txt'&&region.selection===null&&region.locationStatus==='viewport-only')&&modelText.includes('drawing-focus')&&modelText.includes(String(focus?.drawing?.pixelBounds?.x)),{focus:focus??null,focusInModelText:modelText.includes('drawing-focus')});
  check('a real native Worker executed the one minimal goal in its own worktree; the project stays untouched',
    await fs.readFile(path.join(work.execution.directory,'result.txt'),'utf8').then(t=>t==='DRAWING_BACKGROUND').catch(()=>false)
    &&await fs.stat(path.join(project,'result.txt')).then(()=>false,()=>true)
    &&await fs.readFile(path.join(project,'input.txt'),'utf8').then(t=>t==='USER INPUT MUST REMAIN UNCHANGED\n'),
    {worktree:work.execution.directory});
  await shell.waitForFunction(()=>document.querySelector('.snapshot-card-text')?.value==='');
  check('accepted submission clears input without adding a discussion turn or a permanent receipt footer',
    await shell.$$eval('.snapshot-card-thread .tag-message',nodes=>nodes.length)===threadBefore
    &&await shell.$eval('.snapshot-card-task-receipt',n=>n.closest('details').hidden));
  await shell.screenshot({path:path.join(out,'card-after-submit.png')});report.shots.push('card-after-submit.png');
  // Exercise the actual foreground card and a follow-up as well as background intake.
  await shell.type('.snapshot-card-text','REAL_FOREGROUND_QUESTION');await shell.click('.snapshot-card-send');
  await shell.waitForFunction(()=>document.querySelector('.snapshot-card-thread')?.textContent.includes('FRONTDESK_IMAGE_REPLY'),{timeout:90000});
  await shell.type('.snapshot-card-text','REAL_FOREGROUND_FOLLOWUP');await shell.click('.snapshot-card-send');
  await shell.waitForFunction(()=>document.querySelector('.snapshot-card-thread')?.textContent.includes('FRONTDESK_FOLLOWUP_REPLY'),{timeout:90000});
  const followupRequest=provider.requests.findLast(request=>(request.messages||[]).some(message=>message.role==='user'&&JSON.stringify(message.content).includes('REAL_FOREGROUND_FOLLOWUP')));
  const currentInput=followupRequest?.messages.find(message=>message.role==='user'&&JSON.stringify(message.content).includes('REAL_FOREGROUND_FOLLOWUP'));
  check('foreground discussion and follow-up each reach the real native model with the frozen image',requests.filter(role=>role==='frontdesk').length===2&&Array.isArray(currentInput?.content)&&currentInput.content.some(part=>part.type==='image_url'&&part.image_url?.url.startsWith('data:image/png;base64,')));
  const grip=await shell.$eval('[data-local-window-owner-kind="snapshot"] [data-local-window-resize]',node=>node.getBoundingClientRect().toJSON());
  await shell.mouse.move(grip.x+grip.width/2,grip.y+grip.height/2);await shell.mouse.down();await shell.mouse.move(grip.x+grip.width/2+237,grip.y+grip.height/2+266,{steps:14});await shell.mouse.up();await raf(shell);
  const expanded=await shell.evaluate(()=>{const panel=document.querySelector('.snapshot-card-panel').getBoundingClientRect(),thread=document.querySelector('.snapshot-card-thread').getBoundingClientRect();return {panel:panel.height,thread:thread.height};});
  check('enlarging the actual window grows conversation instead of retaining the old 260px cap',expanded.thread>expanded.panel*.7,expanded);
  await shell.screenshot({path:path.join(out,'card-foreground-discussion.png')});report.shots.push('card-foreground-discussion.png');
  const resizeSelector='[data-local-window-owner-kind="snapshot"] [data-local-window-resize]';
  await shell.focus(resizeSelector);
  for(let i=0;i<90;i++)await shell.keyboard.press('ArrowUp');
  await raf(shell);
  const shortWindow=await shell.$eval('[data-local-window-owner-kind="snapshot"]',node=>{const body=node.querySelector('.local-window-body');return {height:node.getBoundingClientRect().height,bodyHeight:body.clientHeight,contentHeight:body.scrollHeight};});
  check('minimum-height discussion keeps a real scroll fallback',shortWindow.height<=102&&shortWindow.contentHeight>shortWindow.bodyHeight,shortWindow);
  for(const selector of ['.snapshot-card-text','.snapshot-card-send','.snapshot-card-task']){
    await shell.$eval(selector,node=>node.scrollIntoView({block:'center'}));
    check('short discussion action reachable after scroll · '+selector,(await shell.evaluate(reachableSource,selector)).ok);
  }
  await shell.screenshot({path:path.join(out,'minimum-height-discussion.png')});report.shots.push('minimum-height-discussion.png');
  await shell.focus(resizeSelector);await shell.keyboard.press('Home');await raf(shell);

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
      const area=await shell.evaluate(()=>{const panel=document.querySelector('.snapshot-card-panel').getBoundingClientRect(),thread=document.querySelector('.snapshot-card-thread').getBoundingClientRect();return {panel:panel.height,thread:thread.height};});
      check('conversation keeps most of the resized discussion surface · '+theme+'-'+width,area.thread>area.panel*.55,area);
      const shot='layout-'+theme+'-'+width+'.png';await shell.screenshot({path:path.join(out,shot)});report.shots.push(shot);
    }
  }
  check('later typed input survives every layout change',await shell.$eval('.snapshot-card-text',n=>n.value==='后写的新输入'));
  assert.deepEqual(requests.filter(role=>role!=='frontdesk'),['orchestrator','worker','worker'],'exactly the one scripted background goal ran; foreground requests never replay it');
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
