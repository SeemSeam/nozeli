// Actual UI timeline-ordering acceptance: production Electron (or the packaged
// ELF via NOZELI_TEST_BINARY) + private native Pi owners + deterministic
// loopback HTTP. Real persisted conversation and two real Tasks; no renderer or
// backend replacement, no paid model, no install and no user data. The expected
// top-to-bottom order below is stated literally from the scenario; it is never
// computed by any sorting code, old or new.
// Scenario: plain conversation A -> Task One first submission (background) ->
// plain conversation B -> Task Two first submission (foreground input explicitly
// handed off to background; the Task must keep the original foreground user
// row's entry position, never re-placed by job/Work creation time) -> plain
// conversation C -> one explicit Task One supplement round (card must not move)
// -> plain conversation D (must land at the bottom) -> cold restart (same
// order, zero replay).
// Run from apps/desktop: TMPDIR=/var/tmp DISPLAY=:1 node tests/desktop-timeline-order-live.mjs
// Headless ozone is selected automatically when no DISPLAY/WAYLAND_DISPLAY is set.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {runGit} from '../src/agents/managed/git-runtime.mjs';
import {serve} from './pi-provider.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';

const app=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'nozeli-timeline-order-'));
const project=path.join(out,'project'),home=path.join(out,'home'),config=path.join(out,'config'),profile=path.join(config,'desktop');
await fs.mkdir(project);await fs.mkdir(home);await fs.writeFile(path.join(project,'original.txt'),'ORIGINAL_UNCHANGED\n');
const git=async(...args)=>(await runGit(project,args)).toString().trim();
await git('init','-b','main');await git('config','user.name','Timeline Order Fixture');await git('config','user.email','timeline-order@localhost');await git('add','--all');await git('commit','-m','Synthetic baseline');
const sourceCommit=await git('rev-parse','HEAD');
const seed=new DesktopHost(profile),projectId=(await seed.registerDirectory(project)).id;
// Existing project's conversation timeline, not first-run AI inventory.
const registered=await seed.storage.requireRegistered(projectId);registered.semanticInitializationEligible=false;await seed.storage.db.request(seed.storage.catalog,'put',{collection:'instances',id:projectId,value:registered});await seed.storage.db.close();

// Scenario vocabulary: chain markers are the literal expected order; NESTED_ONLY
// markers must only ever render inside their Task card, never as bare rows.
const CHAIN={aUser:'CONVERSATION_A:',aReply:'CONVERSATION_A_REPLY:',bUser:'CONVERSATION_B:',bReply:'CONVERSATION_B_REPLY:',cUser:'CONVERSATION_C:',cReply:'CONVERSATION_C_REPLY:',dUser:'CONVERSATION_D:',dReply:'CONVERSATION_D_REPLY:'};
const NESTED_ONLY=['TASK_ONE:','TASK_TWO:','TASK_ONE_MODIFY_1','TASK_ONE_V2'];
const MARKERS=[...Object.values(CHAIN),...NESTED_ONLY];
const wireText=message=>typeof message?.content==='string'?message.content:message?.content?.filter(part=>part.type==='text').map(part=>part.text).join('')||'';
const provider=await serve(async(request,ordinal)=>{
  const tools=request.tools?.map(t=>t.function?.name||t.name)||[];
  const last=request.messages.filter(row=>row.role==='user').map(wireText).findLast(text=>text.trim())||'';
  if(tools.includes('nozeli_dispatch')){ // orchestrator intake: a Task's first submission
    const name=last.includes('TASK_TWO:')?'TASK_TWO':'TASK_ONE';
    return {id:'dispatch-'+name+'-'+ordinal,tool:'nozeli_dispatch',args:{name,brief:'Create '+name+'.txt in the isolated execution worktree and publish its static report for review.'}};
  }
  if(tools.includes('nozeli_publish')){ // worker rounds inside one Task
    if(last.includes('TASK_ONE_MODIFY_1')){
      if(!request.messages.some(row=>row.tool_call_id?.startsWith('write-modify-one-')))return {id:'write-modify-one-'+ordinal,tool:'write',args:{path:'TASK_ONE.txt',content:'TASK_ONE_V2\n'}};
      return {id:'publish-modify-one-'+ordinal,tool:'nozeli_publish',args:{kind:'result',content:staticReport('TASK_ONE_MODIFY_1 retained publication'),files:['TASK_ONE.txt']}};
    }
    const name=last.includes('TASK_TWO:')?'TASK_TWO':'TASK_ONE';
    if(!request.messages.some(row=>row.tool_call_id?.startsWith('write-initial-'+name+'-')))return {id:'write-initial-'+name+'-'+ordinal,tool:'write',args:{path:name+'.txt',content:name+'_INITIAL_CONTENT\n'}};
    return {id:'publish-initial-'+name+'-'+ordinal,tool:'nozeli_publish',args:{kind:'result',content:staticReport(name+' first publication'),files:[name+'.txt']}};
  }
  // frontdesk: plain conversation replies; the explicit Task Two foreground
  // request is escalated to background under the original user request.
  if(last.includes('TASK_TWO:'))return {id:'handoff-two-'+ordinal,tool:'nozeli_handoff',args:{reason:'Run the explicitly requested TASK_TWO as an isolated background task under the original request.'}};
  const reply=last.includes('CONVERSATION_D:')?'CONVERSATION_D_REPLY':last.includes('CONVERSATION_C:')?'CONVERSATION_C_REPLY':last.includes('CONVERSATION_B:')?'CONVERSATION_B_REPLY':'CONVERSATION_A_REPLY';
  return {text:reply+': 独立前台对话的固定回复。'};
});
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
const ozone=process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':process.env.WAYLAND_DISPLAY?'wayland':'headless');
Object.assign(env,{HOME:home,NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_OZONE:ozone});
const report={ok:false,out,binary:process.env.NOZELI_TEST_BINARY||null,ozone,scope:(process.env.NOZELI_TEST_BINARY?'Actual packaged app and bundled Pi':'Source Electron and private Pi')+', local scripted HTTP, real Git/files, real persisted conversation and Tasks. Synthetic isolated project/profile only; host fixture setup uses repository classes. No paid model, personal account, business acceptance decision or webpage backend stub.',checks:[],screenshots:[],timelineOrders:[]};
let child,exit,browser,shell,chat,observer,log='';const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=120000){const end=Date.now()+ms;while(Date.now()<end){if(provider.errors.length)throw provider.errors[0];if(child?.exitCode!=null)throw Error('App exited: '+log);const v=await fn();if(v)return v;await pause(80);}throw Error('Timeout: '+label);}
async function call(op,payload={},page=shell){const r=await page.evaluate(({op,payload})=>window.nozeli.invoke(op,payload),{op,payload});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
const state=async()=>(await call('managed.status',{projectId})).state;
async function scoped(predicate,label){return until(async()=>{for(const p of await browser.pages())if(await p.evaluate(predicate).catch(()=>false))return p;},label);}
async function launch(){child=spawn(process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(app,'src/main/main.cjs')]),...(process.platform==='linux'?['--ozone-platform='+ozone]:[]),'--inspect=0'],{cwd:out,env,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');shell=await scoped(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell','shell');observer=await MainObserver.connect(await until(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'Inspector'));}
async function openChat(){await shell.locator('[data-project-id="'+projectId+'"]').click();await shell.waitForFunction(id=>window.__workspaceScope?.projectId===id&&window.__workspaceGroups?.snapshot()?.projectId===id,{},projectId);await call('workspace.control',{type:'conversation-action',projectId,action:'open',target:'frontdesk'});chat=await scoped(()=>window.__nozeliReady&&window.__workspaceScope?.kind==='conversation','conversation');}
async function submit(text,background){await chat.locator('#composer').fill(text);await chat.click(background?'#submit-background':'#send-message');await chat.waitForFunction(()=>document.querySelector('#composer').value==='');}
async function replySettled(userMarker,replyMarker){await chat.waitForFunction(reply=>document.querySelector('#conversation').textContent.includes(reply),{},replyMarker);await until(async()=>!(await state()).busyTargets.length,userMarker+' settled');}
async function reviewWork(name){return until(async()=>{const s=await state();const w=s.works.find(w=>w.name===name&&w.status==='review');return w&&!s.busyTargets.length?w:null;},name+' first publication in review');}
const card=id=>'.session-task-card[data-workflow-work="'+id+'"]';
// DOM identity order: every top-level timeline row with its durable identity
// attributes and matched scenario markers. Assertions below run on labels
// derived from these descriptors only.
const readOrder=()=>chat.evaluate(markers=>[...document.querySelectorAll('.session-timeline > article')].map(node=>{const text=node.textContent||'';return {flow:node.dataset.workflowId||null,work:node.dataset.workflowWork||null,message:node.dataset.message||null,delta:node.dataset.hostDelta||null,role:node.dataset.role||null,markers:markers.filter(marker=>text.includes(marker))};}),MARKERS);
async function stableOrder(required){let prev=null;for(let i=0;i<200;i++){const rows=await readOrder();const labels=rows.flatMap(row=>row.markers);if(prev&&JSON.stringify(prev)===JSON.stringify(rows)&&required.every(marker=>labels.includes(marker)))return rows;prev=rows;await pause(100);}throw Error('timeline order never stabilized for '+required.join(','));}
const knownLabels=(rows,works)=>rows.map(row=>row.flow?'CARD:'+(row.work||row.flow):(row.markers.find(marker=>Object.values(CHAIN).includes(marker))??null)).filter(label=>label===null||!label.startsWith('CARD:')||works.some(id=>'CARD:'+id===label)).filter(Boolean);
function expectOrder(stage,rows,expected,works){
  report.timelineOrders.push({stage,rows});
  const cards=rows.filter(row=>row.flow).map(row=>'CARD:'+(row.work||row.flow));
  assert.deepEqual(cards,works.map(id=>'CARD:'+id),stage+': exactly the two Tasks appear as cards, in first-submission order');
  const leaked=rows.filter(row=>!row.flow&&row.role==='user'&&row.markers.some(marker=>NESTED_ONLY.includes(marker)));
  assert.deepEqual(leaked,[],stage+': Task inputs and supplement records never surface as bare conversation rows');
  assert.deepEqual(knownLabels(rows,works),expected,stage+': top-to-bottom conversation/card order');
}
async function contained(workId,marker){await chat.waitForFunction(({workId,marker})=>[...document.querySelectorAll('.session-message[data-role="user"]')].some(node=>node.textContent.includes(marker)&&node.closest('.session-task-card')?.dataset.workflowWork===workId),{},{workId,marker});const owners=await chat.$$eval('.session-message[data-role="user"]',(nodes,marker)=>nodes.filter(node=>node.textContent.includes(marker)).map(node=>node.closest('.session-task-card')?.dataset.workflowWork||null),marker);assert.deepEqual([...new Set(owners)],[workId],marker+' stays inside its exact Task, including retained handoff records, and nowhere else');}
async function shot(name,page=chat){const file=path.join(out,name+'.png');await page.screenshot({path:file});report.screenshots.push(file);}
async function closeNormally(){
 if(process.platform==='darwin')await observer.evaluate('setTimeout(()=>process.mainModule.require("electron").app.quit(),0);true');
 else await shell.evaluate(()=>{setTimeout(()=>void window.nozeli.invoke('session.requestClose'),0);});
 observer?.close();observer=null;
 assert.deepEqual(await Promise.race([exit,pause(30000).then(()=>null)]),{code:0,signal:null});await browser.disconnect();browser=null;
}
try{
  await launch();await call('config.initialize',{mode:'independent'});await call('settings.providers.save',{operation:'create',provider:'timeline-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-nonsecret'}});await call('settings.models.save',Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>[role,{model:{mode:'explicit',selector:'timeline-local/scripted'},thinking:{mode:'native-default'}}])));
  await openChat();await call('managed.enable',{projectId});
  // Two Tasks sit in review simultaneously; the default project work quota is
  // one, which would leave Task Two queued forever. Production resource
  // settings API (synthetic profile only) — no review acceptance to free slots.
  await call('settings.agents.save',{projectId,projectLimit:2,globalLimit:6});
  await until(()=>chat.$eval('#send-message',node=>!node.disabled).catch(()=>false),'composer ready');await until(()=>chat.$eval('#submit-background',node=>!node.disabled).catch(()=>false),'background submit ready');
  await submit('CONVERSATION_A: 普通对话A，不派任务。',false);await replySettled('CONVERSATION_A:','CONVERSATION_A_REPLY:');
  await submit('TASK_ONE: 创建独立后台任务，写入 TASK_ONE.txt 并发布报告。',true);const one=await reviewWork('TASK_ONE');
  await submit('CONVERSATION_B: 普通对话B，不派任务。',false);await replySettled('CONVERSATION_B:','CONVERSATION_B_REPLY:');
  // Task Two starts as a foreground input and is explicitly escalated to the
  // background under the original request: its card must anchor at this exact
  // user row's position, not at the later job/Work creation time.
  await submit('TASK_TWO: 前台输入后明确转后台独立执行，写入 TASK_TWO.txt 并发布报告。',false);const two=await reviewWork('TASK_TWO');
  await submit('CONVERSATION_C: 新对话C，排在最底部。',false);await replySettled('CONVERSATION_C:','CONVERSATION_C_REPLY:');
  const works=[one.id,two.id];
  const initial=await stableOrder(Object.values(CHAIN).slice(0,6));
  expectOrder('after C',initial,[CHAIN.aUser,CHAIN.aReply,'CARD:'+one.id,CHAIN.bUser,CHAIN.bReply,'CARD:'+two.id,CHAIN.cUser,CHAIN.cReply],works);
  await shot('01-initial-order');report.checks.push('A, Task One, B, Task Two (foreground input handed off to background), C render top-to-bottom in submission order; C lands at the bottom');
  // One explicit supplement round inside Task One: a new revision and
  // publication must extend the card in place, never move either card.
  await chat.waitForSelector(card(one.id)+' [data-task-action="result"]');await chat.click(card(one.id)+' [data-task-action="result"]');
  const reportPage=await scoped(()=>window.__nozeliReady&&window.__workspaceScope?.kind==='report','Task One report');
  await reportPage.waitForSelector('[data-review-action="open-discussion"]');await reportPage.click('[data-review-action="open-discussion"]');
  const discussion=await scoped(()=>window.__nozeliReady&&window.__workspaceScope?.role==='review-discussion','Task One discussion');
  await discussion.waitForSelector('[data-review-instruction]:not([disabled])',{visible:true});
  await discussion.$eval('[data-review-instruction]',(node,text)=>{node.value=text;node.dispatchEvent(new Event('input',{bubbles:true}));},'TASK_ONE_MODIFY_1');
  await discussion.waitForSelector('[data-review-action="send"]:not([disabled])',{visible:true});await discussion.click('[data-review-action="send"]');
  await until(async()=>{const s=await state();const job=s.jobs.findLast(row=>row.text==='TASK_ONE_MODIFY_1');return job?.status==='completed'&&s.works.find(work=>work.id===one.id)?.status==='review'&&!s.jobs.some(row=>row.target===one.id&&['queued','running'].includes(row.status));},'supplement settles');
  const supplemented=(await state()).works.find(work=>work.id===one.id);assert.equal((await state()).receipts.filter(r=>r.workId===one.id&&r.kind==='result').length,2,'supplement published a second immutable result');assert.ok(supplemented.revision>0,'supplement advanced the Work revision');
  if(await discussion.$('[data-local-window-hide]'))await discussion.click('[data-local-window-hide]');
  await chat.bringToFront();
  const afterSupplement=await stableOrder(Object.values(CHAIN).slice(0,6));
  expectOrder('after Task One supplement',afterSupplement,[CHAIN.aUser,CHAIN.aReply,'CARD:'+one.id,CHAIN.bUser,CHAIN.bReply,'CARD:'+two.id,CHAIN.cUser,CHAIN.cReply],works);
  await contained(one.id,'TASK_ONE:');await contained(one.id,'TASK_ONE_MODIFY_1');await contained(two.id,'TASK_TWO:');
  await shot('02-after-supplement');report.checks.push('Explicit Task One supplement (new revision and publication) extends its card in place; both cards keep their first-submission positions and C stays last');
  await submit('CONVERSATION_D: 补充后的新对话，仍排最底部。',false);await replySettled('CONVERSATION_D:','CONVERSATION_D_REPLY:');
  const final=await stableOrder(Object.values(CHAIN));
  expectOrder('after D',final,[CHAIN.aUser,CHAIN.aReply,'CARD:'+one.id,CHAIN.bUser,CHAIN.bReply,'CARD:'+two.id,CHAIN.cUser,CHAIN.cReply,CHAIN.dUser,CHAIN.dReply],works);
  await chat.$eval('.session-timeline > article:last-child',node=>node.scrollIntoView({block:'end'}));
  await shot('03-new-conversation-bottom');report.checks.push('A new conversation after the supplement still lands at the bottom, below both Tasks');
  const requestsBeforeRestart=provider.requests.length,preRestart=final;
  await closeNormally();log='';
  await launch();await openChat();await chat.waitForSelector(card(one.id));
  const identities=rows=>rows.map(({markers,...identity})=>identity);
  const reopened=await until(async()=>{const rows=await readOrder();return JSON.stringify(identities(rows))===JSON.stringify(identities(preRestart))?rows:null;},'cold persisted identity order');
  report.timelineOrders.push({stage:'cold reopen',rows:reopened});
  assert.deepEqual(identities(reopened),identities(preRestart),'cold reopen renders the identical persisted identity order without forcing deferred native bodies to load');
  assert.equal(provider.requests.length,requestsBeforeRestart,'cold reopen replays no model turn');
  assert.equal(await git('rev-parse','HEAD'),sourceCommit);assert.equal(await fs.readFile(path.join(project,'original.txt'),'utf8'),'ORIGINAL_UNCHANGED\n');
  await chat.$eval('.session-timeline > article:last-child',node=>node.scrollIntoView({block:'end'}));
  await shot('04-cold-restart');report.checks.push('Cold reopen keeps the exact persisted identity order with zero model replay and zero source changes');report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;report.orderAtFailure=await readOrder().catch(()=>null);const failureState=await state().catch(()=>null);if(failureState)report.stateAtFailure={limit:(await call('settings.agents.status',{projectId}).catch(()=>null))?.projectLimit??null,jobs:failureState.jobs.map(job=>({id:job.id,target:job.target,name:job.routing?.name??null,type:job.type,status:job.status,routing:job.routing??null,error:job.error??null,text:(job.text||'').slice(0,120)})),works:failureState.works.map(work=>({id:work.id,name:work.name??null,status:work.status,revision:work.revision??null}))};await shell?.screenshot({path:path.join(out,'failure-shell.png')}).catch(()=>{});await chat?.screenshot({path:path.join(out,'failure-conversation.png')}).catch(()=>{});}
finally{observer?.close();await browser?.disconnect().catch(()=>{});if(child?.exitCode===null)child.kill('SIGTERM');await provider.close();report.providerRequests=provider.requests.length;report.providerErrors=provider.errors.map(e=>e.stack);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
