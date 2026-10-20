import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, symlink, writeFile, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'work-intake-'));
const root = path.join(output, 'app');
await mkdir(root);
for (const item of ['src', 'tools', 'package.json']) await cp(path.join(source, item), path.join(root, item), { recursive: true });
for(const item of ['node_modules','vendor','assets'])await symlink(path.join(source,item),path.join(root,item),'dir');
const panelPath=path.join(root,'src/renderer/managed-agent-panel.mjs');
let panel=await readFile(panelPath,'utf8');
panel=panel.replace(" const call=async(op,p={},id=projectId)=>{",` const call=async(op,p={},id=projectId)=>{window.__uiCalls??=[];window.__uiCalls.push({op,p});if(op==='message.task'){if(window.__conversionFailure)throw Error('受控暂时失败');if(window.__conversionPending){const s=window.__intakeState;s.jobs.push({id:'pending-transfer',target:'orchestrator',type:'intake',text:'待转交请求',status:'transferring',context:{manual:true,sourceMessageId:p.messageId,frontJobId:'active-source'},transfer:{status:'waiting',sourceJobIds:['active-source']},at:new Date().toISOString()});}return {accepted:true,jobId:'source-intake',transferring:Boolean(window.__conversionPending)};}if(op==='terminal.screen')return window.__previewScreens?.[p.target]||{available:false,reason:'尚未就绪'};if(op==='draft'){window.__intakeState.drafts[p.target]=p.text;return {};}if(op==='status')return {state:window.__intakeState};if(op==='task'){const s=window.__intakeState,j={id:'intake-'+(s.jobs.filter(j=>j.context?.manual).length+1),target:'orchestrator',type:'intake',text:p.text,status:'queued',context:{manual:true},at:new Date().toISOString()};s.jobs.push(j);s.messages.push({id:'m-'+j.id,speaker:'user',target:'frontdesk',text:p.text,jobId:j.id,taskRequestId:j.id});window.__previewTest(s,id);await new Promise(r=>setTimeout(r,window.__taskDelay||0));return {accepted:true,jobId:j.id};}if(op==='intake.retry'){window.__intakeState.jobs.push({id:'retry-'+p.jobId,type:'intake',target:'orchestrator',text:'另一任务',status:'queued',context:{retryOf:p.jobId}});return {accepted:true};}`);
panel=panel.replace("subscribe:fn=>window.nozeli.subscribe('agent',fn)","subscribe:fn=>{window.__previewNotify=fn;return ()=>{window.__previewNotify=null;};}");
panel=panel.replace(' return {get active()',` window.__previewTest=(s,id='preview-project')=>{projectId=id;state=s;ready=true;show(true);render();}; window.__previewClear=clear; return {get active()`);
await writeFile(panelPath,panel);
const projectionPath=path.join(root,'src/renderer/work-terminal-preview.mjs');
await writeFile(projectionPath,(await readFile(projectionPath,'utf8')).replace('function close(){',`function close(){if(current){window.__previewTrace??=[];window.__previewTrace.push({stack:new Error().stack,hover:current.anchor.parentElement.matches(':hover'),app:doc.querySelector('#app').className,rect:current.anchor.getBoundingClientRect().toJSON()});}`));
// Layout coverage owns injected state and must not auto-start real Providers.
const agentPanelPath=path.join(root,'src/renderer/agent-panel.mjs');
await writeFile(agentPanelPath,(await readFile(agentPanelPath,'utf8')).replace('async function loadProjectSettings(id, gen) {','async function loadProjectSettings(id, gen) { return;'));
const build = spawn(process.execPath, [path.join(root, 'tools/build-renderer.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let buildLog = '';
build.stdout.on('data', chunk => { buildLog += chunk; });
build.stderr.on('data', chunk => { buildLog += chunk; });
assert.equal(await new Promise(resolve => build.once('exit', resolve)), 0, buildLog);
const project = path.join(output, 'project');
await mkdir(project);
await writeFile(path.join(project, 'sample.md'), '# Reading\n\nA real project document.\n');
const port = await new Promise(resolve => {
  const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const require = createRequire(import.meta.url);
const ozone = process.env.NOZELI_OZONE || 'wayland';
const child = spawn(require('electron'), ['--ozone-platform=' + ozone, path.join(root, 'src/main/main.cjs')], {
  cwd: root,
  env: { ...process.env, NOZELI_TEST_INSTANCE: '1', NOZELI_USER_DATA: path.join(output, 'profile'), NOZELI_TEST_PICK: project, NOZELI_DEBUG_PORT: String(port), NOZELI_AGENT_FIXTURE: '1', NOZELI_HIDDEN: ozone === 'headless' ? '1' : '0', NOZELI_OZONE: ozone },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = new Promise(resolve => child.once('exit', resolve));
let log = '', browser, page;
child.stdout.on('data', chunk => { log += chunk; });
child.stderr.on('data', chunk => { log += chunk; });
const report = { checks: [], errors: [] };
try {
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) throw new Error(log);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Startup timeout: ' + log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  page = (await browser.pages()).find(page => page.url().includes('127.0.0.1'));
  page.on('pageerror', error => report.errors.push(error.message));
  await page.waitForFunction(() => window.__nozeliReady);
  await page.setViewport({ width: 1440, height: 900 });
  await page.click('#pick-project'); await page.waitForFunction(()=>document.querySelector('#project-name').textContent==='project');
  await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-close').click(); });
  if(await page.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await page.click('#toggle-sidebar');
  const id=await page.evaluate(async()=>{const r=await nozeli.invoke('project.recent',{});return r.value.projects[0].id;});
  const s={works:[],quotaUsed:0,limit:2,busyTargets:['frontdesk','orchestrator'],bindings:{frontdesk:{model:'gpt-6.1-sol',effort:'low'},orchestrator:{model:'gpt-6.1-sol',effort:'high'}},messages:[],todos:[],jobs:[],receipts:[],drafts:{},agents:[],contentRoot:project};
  await page.evaluate(({s,id})=>{window.__intakeState=s;window.__previewTest(s,id);window.__intakeProject=id;window.__taskDelay=250;window.__uiCalls=[];window.__nozeliInput={text:()=> 'UNSAVED MATERIAL'};}, {s,id});
  const check=name=>report.checks.push(name);
  await page.$eval('#composer',n=>{n.value='先核对';n.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.$eval('#attach-file',n=>n.checked=true);
  await page.evaluate(()=>{window.__taskPromise=window.__agentSend({background:true});});
  await page.waitForSelector('[data-managed-request="request:intake-1"]');
  await page.evaluate(()=>window.__firstRow=document.querySelector('[data-managed-request="request:intake-1"]'));
  assert.match(await page.$eval('[data-managed-request="request:intake-1"]',n=>n.textContent),/等待主控安排/);
  check('accepted task appears immediately before Worker exists');
  await page.evaluate(()=>window.__taskPromise);assert.equal(await page.$eval('#composer',n=>n.value),'');
  assert.equal(await page.evaluate(()=>window.__uiCalls.filter(c=>c.op==='send').length),0);assert.equal(await page.evaluate(()=>window.__uiCalls.filter(c=>c.op==='task').length),1);
  assert.match(await page.$eval('.managed-task-reference',n=>n.textContent),/后台/);check('manual task bypasses frontend and leaves compact reference');
  await page.evaluate(()=>{const s=window.__intakeState;s.jobs[0].routing={action:'clarify',at:new Date().toISOString()};s.jobs[0].status='completed';s.todos.push({id:'q',kind:'routing',status:'open',sourceJobId:s.jobs[0].id,text:'选择 1 或 2'});window.__previewTest(s,window.__intakeProject);});
  await page.click('#inbox-reports [data-managed-todo="q"]');await page.waitForFunction(()=>document.querySelector('#managed-doc').textContent.includes('选择 1 或 2'));assert.match(await page.$eval('#managed-todo-context',n=>n.textContent),/待回答/);check('unbound clarification opens durable frontend todo without terminal');
  await page.evaluate(()=>{const s=window.__intakeState;s.todos[0].status='resolved';s.jobs.push({id:'answer',target:'orchestrator',type:'intake',status:'completed',text:'1',context:{routingQuestionId:'q'},routing:{action:'dispatch',workId:'w'},at:new Date().toISOString()});s.works.push({id:'w',name:'核对',sourceJob:'answer',request:'先核对\n1',status:'review'});s.receipts.push({id:'r',objectId:'report',workId:'w',kind:'result',text:'核对结果',at:new Date().toISOString()});s.todos.push({id:'result',workId:'w',kind:'result',objectId:'report',revision:1,status:'open'});window.__previewScreens={w:{available:false,reason:'Worker 终端尚未就绪'}};s.busyTargets.push('w');window.__previewTest(s,window.__intakeProject);});
  assert.equal(await page.evaluate(()=>window.__firstRow===document.querySelector('[data-managed-work="w"]')),true);assert.equal(await page.$$eval('.managed-work-entry',ns=>ns.length),1);check('clarification and dispatch retain same DOM item');assert.equal(await page.$eval('#managed-todo-context',n=>n.hidden),true);check('resolved routing context clears before the next unrelated task');
  await page.click('[data-managed-work="w"] .managed-work-preview');await page.waitForSelector('.work-terminal-preview:not([hidden])');assert.match(await page.$eval('.work-terminal-preview',n=>n.textContent),/尚未就绪/);await page.keyboard.press('Escape');check('Worker popup remains independent of result action');
  await page.evaluate(()=>{const s=window.__intakeState;s.jobs.push({id:'supplement',target:'orchestrator',type:'intake',text:'补充',status:'completed',context:{},routing:{action:'continue',workId:'w'}});window.__previewTest(s,window.__intakeProject);});assert.equal(await page.$$eval('.managed-work-entry',ns=>ns.length),1);check('supplement maps to original work');
  await page.evaluate(()=>{const s=window.__intakeState;s.jobs.push({id:'failed',target:'orchestrator',type:'intake',text:'另一任务',status:'interrupted',context:{},error:'host interrupted'});s.todos.push({id:'failed-intake-todo',kind:'system',status:'open',sourceJobId:'failed',text:'host interrupted，请重试主控处理'});window.__previewTest(s,window.__intakeProject);});await page.click('#inbox-reports [data-managed-todo="failed-intake-todo"]');await page.waitForFunction(()=>document.querySelector('#managed-doc').textContent.includes('host interrupted'));await page.$$eval('#managed-result-actions button',ns=>ns.find(n=>n.textContent==='重试主控处理').click());await page.waitForFunction(()=>document.querySelector('[data-managed-request="request:failed"]').textContent.includes('等待主控安排'));assert.equal(await page.$$eval('.managed-work-entry',ns=>ns.length),2);check('inbox retry preserves failed root without duplicating work');
  await page.$$eval('#managed-todo-context button',ns=>ns.find(n=>n.textContent==='回到前台讨论').click());assert.equal(await page.$eval('#composer',n=>n.disabled),false);
  await page.$eval('#composer',n=>{n.value='上一稿';n.dispatchEvent(new Event('input',{bubbles:true}));});await page.evaluate(()=>window.__taskPromise=window.__agentSend({background:true}));await page.waitForFunction(()=>window.__uiCalls.filter(c=>c.op==='task').length===2);await page.$eval('#composer',n=>{n.value='新的草稿';n.dispatchEvent(new Event('input',{bubbles:true}));});await page.evaluate(()=>window.__taskPromise);assert.equal(await page.$eval('#composer',n=>n.value),'新的草稿');check('new draft typed while submit resolves is preserved');
  await page.evaluate(()=>window.__taskDelay=0);
  for(const width of [1440,600]){await page.setViewport({width,height:800});await page.waitForFunction(()=>document.querySelector('#app').classList.contains('narrow-layout')===(innerWidth<=1000));if(await page.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await page.click('#toggle-sidebar');await page.screenshot({path:path.join(output,'intake-'+width+'.png')});const bounds=await page.$eval('#managed-submit-task',n=>{const r=n.getBoundingClientRect();return {x:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});assert(bounds.x>=0&&bounds.right<=bounds.width&&bounds.bottom<=bounds.height,JSON.stringify(bounds));check(width+'px composer task action fits');}
  await page.evaluate(()=>document.querySelector('#toggle-sidebar').click());await page.evaluate(()=>document.querySelector('.managed-task-reference').click());await page.waitForFunction(()=>document.querySelector('#toggle-sidebar').getAttribute('aria-expanded')==='true');check('frontend reference reveals work sidebar');
  const keys=await page.evaluate(()=>window.__uiCalls.filter(c=>c.op==='task').map(c=>c.p.requestKey));assert.equal(new Set(keys).size,keys.length);check('independent actions receive distinct request keys');
  await page.setViewport({width:1440,height:800});await page.click('[data-path="sample.md"]');await page.waitForFunction(()=>document.querySelector('#file-path').textContent==='sample.md');await page.evaluate(()=>{document.querySelector('#conversation-panel').classList.add('compact-composer');document.querySelector('#composer').value='短问题';});for(const width of [1440,600]){await page.setViewport({width,height:800});await page.waitForFunction(()=>document.querySelector('#app').classList.contains('narrow-layout')===(innerWidth<=1000));await page.evaluate(()=>{document.querySelector('#conversation-panel').classList.add('compact-composer');document.querySelector('#app').classList.remove('drawer-side-open');});const b=await page.$eval('#managed-submit-task',n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});assert(b.left>=0&&b.right<=b.width&&b.bottom<=b.height,JSON.stringify(b));await page.screenshot({path:path.join(output,'compact-'+width+'.png')});check(width+'px reading composer keeps task action visible');}
  await page.setViewport({width:1440,height:900});await page.waitForFunction(()=>!document.querySelector('#app').classList.contains('narrow-layout'));
  await page.evaluate(()=>{const s=window.__intakeState;s.messages.push({id:'source-answer',target:'frontdesk',speaker:'agent',text:'旧答案，作为候选材料。'});window.__previewTest(s,window.__intakeProject);});
  await page.$eval('#composer',n=>{n.value='保留无关草稿';n.dispatchEvent(new Event('input',{bubbles:true}));});
  if(await page.$eval('#conversation-panel',n=>n.classList.contains('compact-composer')))await page.click('#chat-history-toggle');
  await page.click('[data-managed-message="source-answer"] .managed-message-task');
  assert.equal(await page.$eval('#composer',n=>n.value),'保留无关草稿');check('source reference keeps unrelated composer draft');
  assert.equal(await page.$eval('#managed-source-task',n=>getComputedStyle(n).backgroundColor),await page.$eval('#reader',n=>getComputedStyle(n).backgroundColor));check('reference colors follow current application theme');
  await page.$eval('#managed-source-task textarea',n=>n.value='检查候选材料并输出清单');
  await page.evaluate(()=>window.__conversionFailure=true);await page.$$eval('#managed-source-task button',ns=>ns.find(n=>n.textContent==='提交此引用到后台').click());
  await page.waitForFunction(()=>!document.querySelector('#managed-source-task button').disabled);
  assert.equal(await page.$eval('#managed-source-task',n=>n.hidden),false);assert.equal(await page.$eval('#composer',n=>n.value),'保留无关草稿');check('failed conversion keeps reference, supplementary goal and original draft');
  await page.evaluate(()=>window.__conversionFailure=false);await page.$$eval('#managed-source-task button',ns=>ns.find(n=>n.textContent==='提交此引用到后台').click());await page.waitForFunction(()=>document.querySelector('#managed-source-task').hidden);
  const receipts=await page.evaluate(()=>window.__uiCalls.filter(c=>c.op==='message.task'));
  assert.equal(receipts.length,2);assert.equal(receipts[0].p.requestKey,receipts[1].p.requestKey);assert.equal(receipts[1].p.messageId,'source-answer');check('conversion retry preserves exact source and request identity');
  assert.equal(await page.$eval('#composer',n=>n.value),'保留无关草稿');check('successful reference submission leaves original draft intact');
  await page.click('[data-managed-message="source-answer"] .managed-message-task');
  await page.setViewport({width:600,height:800});await page.waitForFunction(()=>document.querySelector('#app').classList.contains('narrow-layout'));
  const sourceBounds=await page.$eval('#managed-source-task',n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});assert(sourceBounds.left>=0&&sourceBounds.right<=sourceBounds.width&&sourceBounds.bottom<=sourceBounds.height,JSON.stringify(sourceBounds));check('reference entry fits 600px viewport');
  await page.screenshot({path:path.join(output,'source-reference-600.png')});await page.setViewport({width:1440,height:900});await page.screenshot({path:path.join(output,'source-reference-1440.png')});
  await page.$$eval('#managed-source-task button',ns=>ns.find(n=>n.textContent==='移除引用').click());assert.equal(await page.$eval('#composer',n=>n.value),'保留无关草稿');check('removing reference leaves original draft intact');
  await page.click('[data-managed-message="source-answer"] .managed-message-task');await page.evaluate(()=>window.__conversionPending=true);await page.$$eval('#managed-source-task button',ns=>ns.find(n=>n.textContent==='提交此引用到后台').click());await page.waitForFunction(()=>document.querySelector('#managed-source-task').hidden);assert.match(await page.$eval('[data-managed-request="request:pending-transfer"] .managed-work-summary',n=>n.textContent),/等待前台停稳/);check('active conversion shows durable waiting state rather than already dispatched');
  await page.evaluate(()=>{const s=window.__intakeState;s.jobs.find(j=>j.id==='pending-transfer').transfer.error='中断请求失败';s.todos.push({id:'transfer-fault',kind:'system',status:'open',sourceJobId:'pending-transfer',text:'中断请求失败，前台尚未停稳，请重试转交'});s.messages.push({id:'partial-answer',target:'frontdesk',speaker:'agent',jobId:'active-source',text:'未验证的部分回答',partial:true});window.__previewTest(s,window.__intakeProject);});
  await page.waitForSelector('[data-managed-request="request:pending-transfer"]');const row=await page.$('[data-managed-request="request:pending-transfer"]');assert.match(await row.$eval('.managed-work-summary',n=>n.textContent),/尚未停稳/);assert.equal(await row.$$eval('.managed-work-retry',ns=>ns.length),0);await page.click('#inbox-reports [data-managed-todo="transfer-fault"]');await page.waitForFunction(()=>document.querySelector('#managed-doc').textContent.includes('中断请求失败'));assert.equal(await page.$$eval('#managed-result-actions button',ns=>ns.some(n=>n.textContent==='重试转交')),true);check('failed settlement is visible with distinct inbox transfer retry');assert.match(await page.$eval('[data-managed-message="partial-answer"] strong',n=>n.textContent),/部分回答/);check('partial frontend text is clearly labelled');
  await page.evaluate(()=>{const j=window.__intakeState.jobs.find(j=>j.id==='pending-transfer');j.status='queued';j.transfer.status='settled';j.transfer.settledAt=new Date().toISOString();delete j.transfer.error;window.__intakeState.todos.find(t=>t.id==='transfer-fault').status='resolved';window.__previewTest(window.__intakeState,window.__intakeProject);});assert(await row.evaluate(n=>n===document.querySelector('[data-managed-request="request:pending-transfer"]')));assert.equal(await page.$$eval('#inbox-reports [data-managed-todo="transfer-fault"]',ns=>ns.length),0);check('settled transfer keeps original summary and resolves retry todo');await page.screenshot({path:path.join(output,'settled-transfer.png')});

  assert.deepEqual(report.errors,[]);await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report}));
} catch (error) {
  report.failure = error.stack;report.trace=await page?.evaluate(()=>window.__previewTrace?.slice(-5)).catch(()=>null);
  await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.error('Evidence: ' + output);
  throw error;
} finally {
  await browser?.disconnect();
  if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  let timer;
  const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
  clearTimeout(timer);
  if (!stopped) { child.kill('SIGKILL'); await exited; }
}
