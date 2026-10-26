// Real-Electron smoke for the inline workspace attention notifications.
// Real bundled native OMP residents answer a deterministic loopback OpenAI-protocol
// model (no paid credentials, isolated profiles only); distinct labeled result and
// recovery records are seeded offline through the app's own AttentionLedger store
// while the app is closed. No fake UI runtime status is injected anywhere: every
// status is read from managed.status / the real DOM.
//   Development tree (source): NOZELI_TEST_APP_ROOT=/abs/apps/desktop NOZELI_TEST_BINARY=/abs/node_modules/.bin/electron node apps/desktop/tests/installed-attention-notifications-live.mjs
//   Installed release:        NOZELI_INSTALLED_BINARY=/abs/release/nozeli node apps/desktop/tests/installed-attention-notifications-live.mjs
// The final stdout line is the evidence directory (report.json, screenshots, main.log).
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';

assert.equal(process.platform,'linux','Native notification smoke currently requires Linux');
if(Boolean(process.env.NOZELI_TEST_APP_ROOT)!==Boolean(process.env.NOZELI_TEST_BINARY))throw Error('Development mode requires both NOZELI_TEST_APP_ROOT and NOZELI_TEST_BINARY');
const mode=process.env.NOZELI_INSTALLED_BINARY?'installed':process.env.NOZELI_TEST_APP_ROOT?'development':null;
if(!mode)throw Error('Pass NOZELI_INSTALLED_BINARY or both NOZELI_TEST_APP_ROOT and NOZELI_TEST_BINARY');
const binary=await fs.realpath(mode==='installed'?process.env.NOZELI_INSTALLED_BINARY:process.env.NOZELI_TEST_BINARY);
const installedApp=mode==='installed'?path.join(path.dirname(binary),'resources/app'):await fs.realpath(process.env.NOZELI_TEST_APP_ROOT);
const manifest=JSON.parse(await fs.readFile(path.join(installedApp,'package.json'),'utf8'));
await fs.access(path.join(installedApp,mode==='installed'?(manifest.main||'src/main/main.cjs'):'src/main/main.cjs'));
await fs.access(path.join(installedApp,'runtime/omp/omp'),fs.constants.X_OK);

const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-notify-smoke-'));
const logFile=createWriteStream(path.join(out,'main.log'));
const alpha=path.join(out,'notify-source-project'),beta=path.join(out,'notify-quiet-project'),unrelated=path.join(out,'unrelated-launch-directory'),home=path.join(out,'home');
for(const directory of [alpha,beta,unrelated,home])await fs.mkdir(directory);
await fs.writeFile(path.join(alpha,'sample.txt'),'notification smoke source project\n');
await fs.writeFile(path.join(beta,'sample.txt'),'NOTIFY_QUIET_DOCUMENT 前台静默项目样本\n');

// Deterministic loopback model: every RUN_ tag gets exactly one native ask turn;
// only the frontdesk ask is ever answered, so exactly one continuation happens.
const scenarios={
  FRONTDESK:{tag:'RUN_NOTIFY_FRONTDESK',toolCallId:'notify-ask-frontdesk',marker:'ATTENTION_NOTIFY_FRONT',answer:'修改路线',question:'ATTENTION_NOTIFY_FRONT：通知验收请选择前台处理路线',options:[{label:'保留路线'},{label:'修改路线'}]},
  ORCHESTRATOR:{tag:'RUN_NOTIFY_ORCH',toolCallId:'notify-ask-orchestrator',marker:'ATTENTION_NOTIFY_ORCH',question:'ATTENTION_NOTIFY_ORCH：通知验收请选择主控处理路线',options:[{label:'保留方案'},{label:'修改方案'}]},
  LATE:{tag:'RUN_NOTIFY_LATE',toolCallId:'notify-ask-late',marker:'ATTENTION_NOTIFY_LATE',question:'ATTENTION_NOTIFY_LATE：通知验收请选择后续路线',options:[{label:'保持现状'},{label:'调整现状'}]},
};
const modelInputs=[],protocolErrors=[],chosenByRequest=[];
const report={ok:false,mode,scope:'Real Electron ('+mode+') + bundled native OMP residents + real workspace UI clicks; deterministic loopback OpenAI SSE model (never a paid model); labeled result/recovery records seeded offline through the app AttentionLedger store. No fake UI runtime status.',binary,installedApp,out,checks:[],screenshots:[],errors:[],console:[],seeded:{}};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=90000){const deadline=Date.now()+ms;while(Date.now()<deadline){if(protocolErrors.length)throw Error('Loopback model protocol error before "'+label+'":\n'+protocolErrors.join('\n---\n'));const value=await fn();if(value)return value;await pause(100);}throw Error('Timeout: '+label);}
const mark=text=>{report.checks.push(text);console.log('PASS '+text);};

const server=http.createServer((req,res)=>{
  let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
    let delta,expectResult=null;
    try{
      assert.equal(req.method,'POST');assert.match(req.url,/^\/v1\/chat\/completions\/?$/);
      const input=JSON.parse(body);modelInputs.push(input);
      // OMP threads can embed earlier turns (including other scenarios' prompts)
      // inside history wrappers, so a bare "messages include tag" match misbinds
      // requests. The original input is always the LAST user message: choose the
      // scenario whose marker occurs latest there.
      const lastUser=[...input.messages].reverse().find(message=>message.role==='user');
      const lastUserText=JSON.stringify(lastUser?.content??'');
      const candidate=Object.values(scenarios)
        .map(item=>({item,index:lastUserText.lastIndexOf(item.tag)}))
        .filter(entry=>entry.index>=0)
        .sort((a,b)=>b.index-a.index)[0]?.item;
      const ask=candidate&&!input.messages.some(message=>message.role==='tool'&&message.tool_call_id===candidate.toolCallId)?candidate:null;
      const continued=ask?null:Object.values(scenarios).find(item=>input.messages.some(message=>message.role==='tool'&&message.tool_call_id===item.toolCallId));
      assert(ask||continued,'Unexpected model request outside the scripted scenarios');
      assert(input.tools?.some(tool=>tool.function?.name==='ask'),'Real OMP must advertise its native ask tool');
      const scenario=ask??continued;
      chosenByRequest.push({tag:scenario.tag,kind:ask?'ask':'continuation'});
      const bound=chosenByRequest.filter(entry=>entry.tag===scenario.tag);
      assert(bound.length<=2&&bound.filter(entry=>entry.kind==='ask').length===1,'Each scripted scenario allows exactly one original ask and at most one continuation');
      if(ask){
        delta={role:'assistant',tool_calls:[{index:0,id:ask.toolCallId,type:'function',function:{name:'ask',arguments:JSON.stringify({questions:[{id:'route',question:ask.question,options:ask.options}]})}}]};
      }else{
        const tool=input.messages.find(message=>message.role==='tool'&&message.tool_call_id===continued.toolCallId);
        assert(tool,'Continuation must carry the native ask tool result');
        expectResult=continued.answer;
        if(expectResult)assert(JSON.stringify(tool.content).includes(expectResult),'The chosen option must reach the native tool result');
        delta={role:'assistant',content:'NOTIFY_SMOKE_DONE_'+continued.toolCallId};
      }
      // Real SSE framing exactly like installed-attention-dialogue-live: status
      // and content type, the delta frame, the finish_reason frame, then DONE.
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const [fragment,finish] of [[delta,null],[{},ask?'tool_calls':'stop']]){
        res.write('data: '+JSON.stringify({id:'notify-'+modelInputs.length,object:'chat.completion.chunk',choices:[{index:0,delta:fragment,finish_reason:finish}]})+'\n\n');
      }
      res.end('data: [DONE]\n\n');
    }catch(error){
      protocolErrors.push(error.stack);
      res.writeHead(500,{'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:error.message}}));
    }
  });
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const debugPort=await new Promise(resolve=>{const socket=net.createServer();socket.listen(0,'127.0.0.1',()=>{const port=socket.address().port;socket.close(()=>resolve(port));});});
const env={...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_CACHE_HOME:path.join(home,'.cache'),NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:path.join(out,'.Nozeli'),NOZELI_USER_DATA:path.join(out,'.Nozeli/desktop'),NOZELI_TEST_PICK:alpha+'\n'+beta,NOZELI_DEBUG_PORT:String(debugPort),NOZELI_HIDDEN:'0'};
env.NOZELI_SHOT_DIR=out;
for(const key of Object.keys(env))if(/^(?:CCB_|CODEX_|PI_|OMP_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key))delete env[key];
delete env.ELECTRON_RUN_AS_NODE;delete env.NOZELI_AGENT_FIXTURE;

let child,exit,browser,shell,mainLog='',alphaId,betaId,frontTodo,orchTodo,lateTodo;
async function invoke(op,payload={},page=shell){
  const result=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});
  if(!result.ok)throw Object.assign(Error(op+': '+result.error.message),{code:result.error.code});
  return result.value;
}
const status=async(projectId=alphaId)=>(await invoke('managed.status',{projectId})).state;
function attachEarlyCapture(target){
  // Capture renderer errors from the moment the debug endpoint answers — before
  // any page search — so startup failures are never swallowed by late listeners.
  void (async()=>{try{
    const page=await target.page();if(!page)return;
    const label=()=>page.url().slice(0,120)||'about:blank';
    page.on('pageerror',error=>report.errors.push('pageerror['+label()+']: '+(error?.stack??String(error))));
    page.on('console',message=>{if(message.type()==='error'){report.console.push('console['+label()+']: '+message.text());}});
    page.on('requestfailed',request=>{if(['document','script','stylesheet'].includes(request.resourceType()))report.errors.push('requestfailed['+label()+']: '+request.url()+' '+(request.failure()?.errorText??''));});
  }catch{}})();
}
async function launch(){
  child=spawn(binary,[...(mode==='development'?[path.join(installedApp,'src/main/main.cjs')]:[]),'--ozone-platform='+(process.env.NOZELI_TEST_OZONE_PLATFORM||'wayland')],{cwd:unrelated,env,stdio:['ignore','pipe','pipe']});
  exit=new Promise((resolve,reject)=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',reject);});
  // Child output streams to disk from the first byte, so evidence survives even
  // a hard teardown; CDP calls are bounded so no evaluate can hang a full 180s.
  for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{mainLog+=data;logFile.write(data);});
  await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+debugPort,defaultViewport:null,protocolTimeout:120000});return true;}catch{return false;}},'smoke browser');
  browser.on('targetcreated',attachEarlyCapture);
  for(const target of browser.targets())attachEarlyCapture(target);
  shell=await until(async()=>{for(const page of await browser.pages())try{if((await page.evaluate(()=>window.__workspaceScope))?.role==='shell')return page;}catch{}},'workspace shell');
  await shell.waitForFunction(()=>window.__nozeliReady);
}
async function closeNormally(){
  await invoke('session.requestClose');
  const confirm=shell.waitForSelector('#quit-choice[open]',{timeout:45000}).then(()=>true,()=>false);
  if(await Promise.race([exit.then(()=>false),confirm]))await shell.click('#quit-cancel');
  assert.deepEqual(await Promise.race([exit,pause(45000).then(()=>null)]),{code:0,signal:null},'The app must exit normally, never be killed');
  await browser.disconnect();browser=undefined;
}
const bounded=(promise,ms=15000)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(Error('bounded wait exceeded '+ms+'ms')),ms))]);
async function screenshot(page,name){await page.bringToFront();await bounded(page.screenshot({path:path.join(out,name+'.png')}));report.screenshots.push(name+'.png');}
async function setAppearance(theme){
  await invoke('settings.appearance.save',{theme,palette:'sage',font:'system',size:13});
  for(const page of new Set([shell,...await browser.pages()]))if(await page.evaluate(()=>window.__workspaceScope??null).catch(()=>null))await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,{timeout:45000},theme);
}
async function rawAck(page,projectId,todoId,occurrence){
  return page.evaluate(payload=>nozeli.invoke('managed.attention.ack',payload),{projectId,ids:[todoId],...(occurrence?{occurrences:[occurrence]}:{})});
}
const promptFacts=()=>shell.evaluate(()=>{
  const node=document.querySelector('[data-attention-prompt]');
  if(!node)return {missing:true};
  const rect=node.getBoundingClientRect(),current=node.querySelector('.attention-current');
  return {hidden:node.hidden,parent:node.parentElement?.id,position:getComputedStyle(node).position,role:node.getAttribute('role'),label:node.getAttribute('aria-label'),
    rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
    text:current?.querySelector('p')?.textContent??node.textContent,kind:current?.querySelector('[data-attention-kind]')?.getAttribute('data-attention-kind'),
    count:(()=>{const span=current?.querySelector('[data-attention-count]');return span&&!span.hidden?span.textContent:null;})(),
    openText:current?.querySelector('button[data-attention-open]')?.textContent??null,openCategory:current?.querySelector('button[data-attention-open]')?.dataset.attentionCategory??null,
    expanded:node.querySelector('[data-attention-expand]')?.getAttribute('aria-expanded')??null,
    feedback:document.querySelector('#workspace-groups > [data-attention-feedback]')?.textContent??null};
});
const promptItems=()=>shell.$$eval('[data-attention-prompt] [data-attention-item]',nodes=>nodes.map(node=>({key:node.getAttribute('data-attention-item'),selected:node.getAttribute('aria-current')==='true'})));
async function visibleSurfaces(projectId){return (await invoke('workspace.windows.list',{projectId})).flatMap(window=>window.surfaces).filter(surface=>surface.visible===true&&surface.bounds.width>0&&surface.bounds.height>0);}
const noOverlap=(prompt,surfaces)=>surfaces.every(({bounds})=>prompt.rect.x+prompt.rect.width<=bounds.x||bounds.x+bounds.width<=prompt.rect.x||prompt.rect.y+prompt.rect.height<=bounds.y||bounds.y+bounds.height<=prompt.rect.y);
const askTodo=async marker=>until(async()=>{const state=await status();return state.todos.find(item=>item.origin==='instance-attention'&&item.status==='open'&&item.destination?.kind==='conversation'&&JSON.stringify(item.destination.question??{}).includes(marker));},'native ask todo '+marker);

try{
  await launch();
  await invoke('config.initialize',{mode:'independent'});
  await invoke('settings.providers.save',{provider:'notify-local',model:'scripted',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',key:'local-only',api:'openai-completions'});
  await invoke('settings.models.save',{frontdesk:'notify-local/scripted',orchestrator:'notify-local/scripted',worker:'notify-local/scripted'});
  if(await shell.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell.click('#configuration-cancel');
  await shell.click('#pick-project');
  alphaId=await until(async()=>(await invoke('workspace.bootstrap')).projectId,'source project');
  report.alphaId=alphaId;
  await invoke('managed.enable',{projectId:alphaId});
  await until(async()=>(await invoke('managed.status',{projectId:alphaId})).ready,'bundled OMP residents ready');

  // Unsolicited-change probes: window focus, opened pages and the foreground
  // project are recorded before any ask exists and must stay untouched by arrivals.
  const instrumented=await shell.evaluate(()=>{window.__notifyFocusEvents=0;window.addEventListener('focus',()=>window.__notifyFocusEvents++);return true;});
  assert(instrumented);
  const pagesBefore=(await browser.pages()).length;

  const frontSent=await invoke('managed.send',{projectId:alphaId,target:'frontdesk',text:scenarios.FRONTDESK.tag+': call the native ask tool once.',requestKey:'notify-smoke-front'});
  frontTodo=await askTodo(scenarios.FRONTDESK.marker);
  assert.equal((await invoke('workspace.bootstrap')).projectId,alphaId,'an arriving ask must not navigate the foreground project');
  const orchSent=await invoke('managed.send',{projectId:alphaId,target:'orchestrator',text:scenarios.ORCHESTRATOR.tag+': call the native ask tool once.',requestKey:'notify-smoke-orch'});
  orchTodo=await askTodo(scenarios.ORCHESTRATOR.marker);
  mark('two simultaneous native source asks pending in one real project');
  assert.equal(await shell.evaluate(()=>window.__notifyFocusEvents),0,'arriving notifications must never steal window focus');
  assert.equal((await browser.pages()).length,pagesBefore,'arriving notifications must never open views by themselves');
  // The notification appears even while the source project is the foreground
  // project, without stealing focus or opening anything.
  await shell.waitForSelector('[data-attention-prompt]:not([hidden])',{visible:true});
  await until(async()=>(await promptFacts()).count==='2 项','both asks notify on the source project itself');
  const earlyFacts=await promptFacts();
  assert.equal(earlyFacts.count,'2 项','both asks notify on the source project itself');
  assert.ok(earlyFacts.text.includes(scenarios.FRONTDESK.marker));
  assert.equal(await shell.evaluate(()=>window.__notifyFocusEvents),0,'notifying must never steal window focus');

  // Leave for an unrelated foreground project; the notification must appear inline there.
  await invoke('project.pick',{directory:beta});
  betaId=await until(async()=>{const id=(await invoke('workspace.bootstrap')).projectId;return id&&id!==alphaId?id:false;},'quiet project active');
  await shell.reload({waitUntil:'domcontentloaded'});await shell.waitForFunction(()=>window.__nozeliReady);
  await shell.locator('[data-project-id="'+betaId+'"]').click();await shell.waitForFunction(()=>document.querySelector('#project-name')?.textContent==='notify-quiet-project');
  assert.equal((await invoke('workspace.bootstrap')).projectId,betaId);
  await shell.waitForSelector('[data-attention-prompt]:not([hidden])',{visible:true});
  let facts=await promptFacts(),items=await promptItems();
  assert.equal(facts.parent,'workspace-groups','the notification is an inline child of #workspace-groups');
  assert.ok(['static','relative'].includes(facts.position),'the inline notification is not an overlay');
  assert.equal(facts.role,'region');assert.equal(facts.label,'后台待办提醒');
  assert.equal(facts.kind,'answer','a pending native ask is an answer notification');
  assert.equal(facts.count,'2 项','both simultaneous asks are counted');
  assert.equal(facts.openText,'回答问题');
  assert.ok(facts.text.includes(scenarios.FRONTDESK.marker),'the current row names its source ask');
  assert.doesNotMatch(facts.text,/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,'human-facing text never leaks raw UUIDs');
  assert.ok(!facts.text.includes(alphaId),'source identity stays in the row key, not the display text');

  mark('inline notification appears on an unrelated foreground project with action text and source title');

  // Stable inline bounds: a real native DOCUMENT surface for the foreground
  // project must never be covered, across foreground switches. Opening a
  // conversation instead would start native owners and consume the global
  // process budget — a plain foreground document proves the same bounds.
  await shell.waitForSelector('#file-tree button[data-path="sample.txt"]',{visible:true});
  await shell.click('#file-tree button[data-path="sample.txt"]');
  await until(async()=>{const surfaces=await visibleSurfaces(betaId);return surfaces.length>0;},'native foreground file opens');
  const betaSurfaces=await until(async()=>{const surfaces=await visibleSurfaces(betaId);return surfaces.length?surfaces:false;},'foreground document surfaces');
  const documentPage=await until(async()=>{for(const candidate of await browser.pages())try{const scope=await candidate.evaluate(()=>window.__workspaceScope??null);if(scope&&scope.role!=='shell'&&scope.kind==='document'&&scope.relPath==='sample.txt')return candidate;}catch{}},'foreground document surface page');
  assert.ok((await documentPage.evaluate(()=>document.body.innerText)).includes('NOTIFY_QUIET_DOCUMENT'),'the foreground document stays readable beside the notification');
  facts=await promptFacts();
  assert.ok(facts.rect.width>0&&facts.rect.height>0,'the prompt is rendered');
  assert.ok(await shell.evaluate(()=>{const rect=document.querySelector('[data-attention-prompt]').getBoundingClientRect();return rect.x>=0&&rect.y>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight;}),'the prompt stays inside the shell viewport');
  assert.ok(noOverlap(facts,betaSurfaces),'the inline notification must not overlap the native document bounds');
  await shell.click('[data-project-id="'+alphaId+'"]');
  await until(async()=>(await invoke('workspace.bootstrap')).projectId===alphaId,'source project activated');
  await shell.waitForSelector('[data-attention-prompt]:not([hidden])',{visible:true});
  facts=await promptFacts();
  assert.equal(facts.parent,'workspace-groups');assert.ok(['static','relative'].includes(facts.position));
  await invoke('project.pick',{directory:beta});
  await until(async()=>(await invoke('workspace.bootstrap')).projectId===betaId,'quiet project active again');
  await shell.reload({waitUntil:'domcontentloaded'});await shell.waitForFunction(()=>window.__nozeliReady);
  await shell.locator('[data-project-id="'+betaId+'"]').click();await shell.waitForFunction(()=>document.querySelector('#project-name')?.textContent==='notify-quiet-project');
  await shell.waitForSelector('[data-attention-prompt]:not([hidden])',{visible:true});
  const surfacesBack=await until(async()=>{const surfaces=await visibleSurfaces(betaId);return surfaces.length?surfaces:false;},'foreground document surfaces return');
  assert.ok(noOverlap(facts,surfacesBack),'stable inline bounds across foreground switches and reload');
  mark('inline native bounds stay stable without covering the native foreground document');
  await screenshot(shell,'01-cross-project-inline-notification');

  // Expand, select and defer: the orchestrator ask is acknowledged, never resolved.
  const requestsBeforeDefer=modelInputs.length;
  await shell.click('[data-attention-expand]');
  await until(async()=>(await shell.$eval('[data-attention-expand]',node=>node.getAttribute('aria-expanded')))==='true','expand opens the pending list');
  items=await promptItems();
  assert.deepEqual(items.map(item=>item.key),[alphaId+':'+frontTodo.id,alphaId+':'+orchTodo.id],'list rows key the source project and todo');
  await shell.click('[data-attention-item="'+alphaId+':'+orchTodo.id+'"]');
  await until(async()=>(await promptItems()).find(item=>item.key===alphaId+':'+orchTodo.id)?.selected,'row selection marks aria-current');
  await shell.click('[data-attention-defer]');
  await until(async()=>(await status()).attentionNotified.includes(orchTodo.id),'defer acknowledgement persisted by the real ledger');
  assert.equal((await status()).todos.find(item=>item.id===orchTodo.id).status,'open','defer never resolves the source todo');
  assert.equal(modelInputs.length,requestsBeforeDefer,'defer never touches the model');
  await until(async()=>(await promptFacts()).count===null,'the deferred row leaves the pending set');
  facts=await promptFacts();
  assert.ok(facts.text.includes(scenarios.FRONTDESK.marker));
  assert.equal((facts.feedback??'').includes('此请求已结束'),false,'acknowledgement is not resolution feedback');
  mark('expand/select/defer acknowledges without resolving or resuming the model');

  // Open: solicited navigation to the source project, real workspace dialogue.
  await shell.click('[data-attention-open]');
  await until(async()=>(await invoke('workspace.bootstrap')).projectId===alphaId,'open activates the source project');
  const selector='[data-attention-conversation="'+frontTodo.id+'"]';
  const conversation=await until(async()=>{for(const page of await browser.pages())try{if(await page.$(selector))return page;}catch{}},'source ask workspace dialogue');
  await conversation.waitForSelector(selector+' [data-attention-submit]');
  await until(async()=>(await status()).attentionNotified.includes(frontTodo.id),'open acknowledgement persisted');
  await until(async()=>(await shell.$eval('[data-attention-prompt]',node=>node.hidden))===true,'no pending rows hides the prompt');
  const frontJob=(await status()).jobs.find(job=>job.id===frontSent.jobId);
  assert.equal(frontJob.status,'running','opening the dialogue never answers the ask');
  await conversation.click(selector+' [data-attention-option="'+scenarios.FRONTDESK.answer+'"] label');
  await conversation.waitForSelector(selector+' [data-attention-option="'+scenarios.FRONTDESK.answer+'"][data-attention-selected="true"]');
  assert.equal((await status()).todos.find(item=>item.id===frontTodo.id).status,'open','selecting a choice card never submits');
  await conversation.click(selector+' [data-attention-submit]');
  await until(async()=>{const state=await status();return state.todos.find(item=>item.id===frontTodo.id)?.status==='resolved'&&state.jobs.find(job=>job.id===frontSent.jobId)?.status==='completed';},'submitted answer resolves the same source todo and completes the native job');
  await until(async()=>((await promptFacts()).feedback??'').includes('此请求已结束'),'resolved produces authoritative completion feedback');
  facts=await promptFacts();
  assert.ok(facts.feedback.includes(scenarios.FRONTDESK.marker),'feedback names the settled request');
  assert.equal(facts.hidden,true,'resolved feedback never keeps pending rows alive');
  const stale=await conversation.evaluate(payload=>nozeli.invoke('managed.attention.respond',payload),{projectId:alphaId,todoId:frontTodo.id,answer:{kind:'submit',results:[{id:'route',selectedOptions:['保留路线']}]}});
  assert.equal(stale.ok,false);assert(['ATTENTION_STALE','INTERACTION_STALE'].includes(stale.error.code),'repeat submit is refused as stale');
  mark('real dialogue answer resolves authoritatively; resolved feedback and stale refusal observed');

  // A fresh ask drives the theme and narrow-width captures.
  await invoke('managed.send',{projectId:alphaId,target:'frontdesk',text:scenarios.LATE.tag+': call the native ask tool once.',requestKey:'notify-smoke-late'});
  lateTodo=await askTodo(scenarios.LATE.marker);
  await shell.waitForSelector('[data-attention-prompt]:not([hidden])',{visible:true});
  await setAppearance('light');await screenshot(shell,'02-notification-light');
  await setAppearance('dark');await screenshot(shell,'03-notification-dark');
  await setAppearance('light');
  await invoke('session.resize',{width:480,height:860});
  await shell.waitForFunction(width=>innerWidth>0&&innerWidth<=width,{timeout:45000},480);
  const overflow=await shell.evaluate(()=>({row:(()=>{const node=document.querySelector('[data-attention-prompt]');return node?{scrollWidth:node.scrollWidth,clientWidth:node.clientWidth}:null;})(),document:document.documentElement.scrollWidth,inner:innerWidth}));
  assert(overflow.row&&overflow.row.scrollWidth<=overflow.row.clientWidth+1,'narrow width must not overflow the notification row: '+JSON.stringify(overflow));
  assert(overflow.document<=overflow.inner+1,'narrow width must not force horizontal scrolling');
  await screenshot(shell,'04-notification-narrow-480');
  await invoke('session.resize',{width:1280,height:860});
  mark('light, dark and 480px narrow captures with no horizontal overflow');

  // Normal restart; offline real-host seeding of labeled records while closed.
  const requestsBeforeRestart=modelInputs.length;
  await closeNormally();
  const {ProjectStorage}=await import(pathToFileURL(path.join(installedApp,'src/main/project-storage.mjs')).href);
  const {AttentionLedger}=await import(pathToFileURL(path.join(installedApp,'src/agents/managed/attention-ledger.mjs')).href);
  const store=new ProjectStorage(env.NOZELI_USER_DATA);
  const ledger=new AttentionLedger(store);
  await ledger.observe(betaId,'seed-result',[{key:'seeded-result',target:'frontdesk',title:'SEEDED_RESULT_RESOLVED · 已结束结果样本',text:'离线真实宿主种子：已结束的结果记录不应再提醒。',destination:{kind:'connection',target:'frontdesk'}}]);
  await ledger.observe(betaId,'seed-result',[]);
  await ledger.observe(betaId,'seed-recovery',[{key:'seeded-recovery',target:'frontdesk',title:'SEEDED_RECOVERY_OPEN · 恢复待处理样本',text:'离线真实宿主种子：中断恢复记录需明确处理。',destination:{kind:'conversation',target:'frontdesk',ownerId:'seed-owner',interactionId:'seed-interaction'}}]);
  const seededRecovery=await ledger.observe(betaId,'seed-recovery',[],{interrupted:true});
  const recoveryTodo=seededRecovery.todos.find(item=>item.title?.includes('SEEDED_RECOVERY_OPEN'));
  await store.db.close();
  report.seeded={result:'SEEDED_RESULT_RESOLVED (resolved, must never notify)',recovery:'SEEDED_RECOVERY_OPEN (open interrupted, must notify once)',recoveryTodoId:recoveryTodo.id};
  mark('labeled result/recovery records seeded through the app AttentionLedger while closed');

  await launch();
  await until(async()=>{const factsNow=await promptFacts();return factsNow.hidden===false&&factsNow.count==='3 项';},'startup replay shows the pending recovery rows and the seeded recovery');
  facts=await promptFacts();
  await shell.click('[data-attention-expand]');
  await until(async()=>(await shell.$eval('[data-attention-expand]',node=>node.getAttribute('aria-expanded')))==='true','expand opens the pending list');
  items=await promptItems();
  assert.deepEqual([...items.map(item=>item.key)].sort(),[alphaId+':'+lateTodo.id,alphaId+':'+orchTodo.id,betaId+':'+recoveryTodo.id].sort(),'restart replays the disconnected asks as recovery rows plus the seeded recovery');
  assert.equal(await shell.$eval('[data-attention-prompt]',node=>node.textContent.includes('SEEDED_RESULT_RESOLVED')),false,'a resolved seeded record never notifies');
  assert.equal((await status(alphaId)).todos.find(item=>item.id===frontTodo.id).status,'resolved','resolved asks stay settled');
  // Real authority: disconnected pending asks are interrupted recoveries after restart,
  // and the previously acknowledged orchestrator ask re-notifies exactly once.
  const lateAfter=(await status(alphaId)).todos.find(item=>item.id===lateTodo.id);
  const orchAfter=(await status(alphaId)).todos.find(item=>item.id===orchTodo.id);
  assert.equal(lateAfter.status,'open');assert.equal(lateAfter.interrupted,true);assert.equal(lateAfter.destination.kind,'connection');
  assert.equal(orchAfter.status,'open');assert.equal(orchAfter.interrupted,true);
  assert.equal((await status(alphaId)).attentionNotified.includes(orchTodo.id),false,'the first interruption re-notifies a previously acknowledged ask');
  // All pending rows are blockers now; the action label follows the selected category.
  await shell.click('[data-attention-item="'+betaId+':'+recoveryTodo.id+'"]');
  await until(async()=>(await promptFacts()).openText==='处理阻断','blocker rows relabel the open action');
  // Real host phase guard: a stale waiting-phase acknowledgement is refused atomically.
  const stalePhase=await rawAck(shell,betaId,recoveryTodo.id,{id:recoveryTodo.id,interrupted:false});
  assert.equal(stalePhase.ok,false,'a stale phase acknowledgement must be refused');
  assert.equal(stalePhase.error.code,'ATTENTION_STALE');
  assert.equal((await status(betaId)).attentionNotified.includes(recoveryTodo.id),false,'the refused acknowledgement applied nothing');
  // Selecting a row is one click; clicking an already-selected row means open —
  // never re-click the row that the label check left selected.
  for(const [projectId,todoId] of [[betaId,recoveryTodo.id],[alphaId,orchTodo.id],[alphaId,lateTodo.id]]){
    const key=projectId+':'+todoId;
    if(!(await promptItems()).some(item=>item.key===key&&item.selected)){
      await shell.click('[data-attention-item="'+key+'"]');
      await until(async()=>(await promptItems()).some(item=>item.key===key&&item.selected),'row selected: '+key);
    }
    await shell.click('[data-attention-defer]');
    await until(async()=>(await status(projectId)).attentionNotified.includes(todoId),'deferred with its captured phase: '+todoId);
    assert.equal((await status(projectId)).todos.find(item=>item.id===todoId).status,'open','a recovery row defers without resolving: '+todoId);
  }
  // Reload: acknowledged rows never re-render; nothing duplicates.
  await shell.reload({waitUntil:'domcontentloaded'});await shell.waitForFunction(()=>window.__nozeliReady);
  await until(async()=>(await shell.$eval('[data-attention-prompt]',node=>node.hidden))===true,'acknowledged rows do not re-render after reload');
  assert.equal(await shell.$$eval('[data-attention-prompt]',nodes=>nodes.length),1,'no duplicate notification sections after reload');
  assert.equal(modelInputs.length,requestsBeforeRestart,'restart, notifications and reload never replay a model request');
  await screenshot(shell,'05-restart-no-replay');
  await closeNormally();
  assert.deepEqual(protocolErrors,[]);
  assert.deepEqual(report.errors,[]);
  report.restart={ok:true,normalExit:true,requestsBefore:requestsBeforeRestart,requestsAfter:modelInputs.length};
  report.ok=true;
}catch(error){
  process.exitCode=1;report.error=error.stack;report.protocolErrors=protocolErrors;
  if(shell){
    report.failureUrl=shell.url();
    report.failureReady=await shell.evaluate(()=>({ready:window.__nozeliReady===true,scope:window.__workspaceScope??null,bodyText:(document.body?.innerText??'').slice(0,4000)})).catch(reason=>String(reason));
  }
  report.mainReadyLine=/NOZELI_DESKTOP_READY[^\n]*/.exec(mainLog)?.[0]??null;
  if(shell)await bounded(shell.screenshot({path:path.join(out,'failure.png')})).catch(()=>{});
  console.error(error.stack);
}finally{
  report.modelBindings=chosenByRequest;
  if(child?.exitCode===null){
    await shell?.evaluate(()=>nozeli.invoke('session.requestClose')).catch(()=>{});
    await Promise.race([exit.catch(()=>{}),pause(15000)]);
    if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exit.catch(()=>{}),pause(5000)]);}
    if(child.exitCode===null)child.kill('SIGKILL');
  }
  await browser?.disconnect().catch(()=>{});
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  logFile.end();
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(out,'model-requests.json'),JSON.stringify(modelInputs,null,2));
  console.log(out);
}
