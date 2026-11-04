import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {cp,mkdir,mkdtemp,symlink,writeFile,readFile} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

// Shell-owned consumer coverage: inject durable host facts, then use the actual
// directory and request overview. Submission belongs to the conversation surface;
// this test must not bypass that ownership by calling shell.__agentSend.
const source=path.resolve(import.meta.dirname,'..');
const output=await mkdtemp(path.join(source,'.test-output','work-intake-'));
const root=path.join(output,'app');await mkdir(root);
for(const item of ['src','tools','package.json'])await cp(path.join(source,item),path.join(root,item),{recursive:true});
for(const item of ['node_modules','vendor','assets'])await symlink(path.join(source,item),path.join(root,item),'dir');
const panelPath=path.join(root,'src/renderer/managed-agent-panel.mjs');
let panel=await readFile(panelPath,'utf8');
const callAnchor=' const call=async(op,p={},id=projectId)=>{';assert.ok(panel.includes(callAnchor));
panel=panel.replace(callAnchor,`${callAnchor}window.__uiCalls??=[];window.__uiCalls.push({op,p});if(op==='status')return {state:window.__intakeState,ready:true};if(op==='terminal.screen')return {available:false,reason:'尚未就绪'};`);
const previewAnchor=' return {get active()';assert.ok(panel.includes(previewAnchor));
panel=panel.replace(previewAnchor,` window.__previewTest=s=>{projectId='intake-project';state=s;window.__intakeState=s;ready=true;show(true);render();};${previewAnchor}`);
await writeFile(panelPath,panel);
const agentPanelPath=path.join(root,'src/renderer/agent-panel.mjs');
await writeFile(agentPanelPath,(await readFile(agentPanelPath,'utf8')).replace('async function loadProjectSettings(id, gen) {','async function loadProjectSettings(id, gen) { return;'));
const build=spawn(process.execPath,[path.join(root,'tools/build-renderer.mjs')],{cwd:root,stdio:['ignore','pipe','pipe']});
let buildLog='';build.stdout.on('data',c=>buildLog+=c);build.stderr.on('data',c=>buildLog+=c);
assert.equal(await new Promise(resolve=>build.once('exit',resolve)),0,buildLog);
const project=path.join(output,'project');await mkdir(project);await writeFile(path.join(project,'sample.md'),'# Reading\n\nSynthetic consumer fixture.\n');
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const require=createRequire(import.meta.url),ozone=process.env.NOZELI_OZONE||'headless';
const child=spawn(require('electron'),['--ozone-platform='+ozone,path.join(root,'src/main/main.cjs')],{cwd:root,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:path.join(output,'profile'),NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_AGENT_FIXTURE:'1',NOZELI_HIDDEN:ozone==='headless'?'1':'0',NOZELI_OZONE:ozone},stdio:['ignore','pipe','pipe']});
const exited=new Promise(resolve=>child.once('exit',resolve));let log='',browser,page;
child.stdout.on('data',c=>log+=c);child.stderr.on('data',c=>log+=c);
const report={evidenceKind:'injected-durable-state-real-shell-DOM',checks:[],errors:[]};
const check=name=>{report.checks.push(name);console.log(JSON.stringify({check:name}));};
const category=async name=>{await page.$eval('#managed-work-category-more',n=>n.click());await page.waitForFunction(()=>!document.querySelector('#managed-work-filter-menu').hidden);await page.$eval(`[data-command="filter-${name}"]`,n=>n.click());};
try{
 const deadline=Date.now()+60000;
 for(;;){if(child.exitCode!==null||child.signalCode)throw Error(log);try{if((await fetch(`http://127.0.0.1:${port}/json/version`)).ok)break;}catch{}if(Date.now()>deadline)throw Error('Startup timeout: '+log);await new Promise(r=>setTimeout(r,100));}
 browser=await puppeteer.connect({browserURL:`http://127.0.0.1:${port}`,protocolTimeout:30000});page=(await browser.pages()).find(p=>p.url().includes('127.0.0.1'));
 page.on('pageerror',e=>report.errors.push(e.message));await page.waitForFunction(()=>window.__nozeliReady,{timeout:90000,polling:250});await page.setViewport({width:1440,height:900});
 await page.$eval('#pick-project',n=>n.click());await page.waitForFunction(()=>document.querySelector('#project-name').textContent==='project',{timeout:60000,polling:250});
 if(await page.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await page.$eval('#toggle-sidebar',n=>n.click());
 const state={works:[],jobs:[{id:'intake-1',type:'intake',target:'orchestrator',text:'[protocol wrapper]',context:{userGoal:'先核对'},status:'queued',at:'2026-11-03T08:00:00Z'}],todos:[],messages:[],receipts:[],drafts:{},agents:[],busyTargets:[],bindings:{},providers:{},quotaUsed:0,limit:2,contentRoot:project};
 await page.evaluate(s=>{window.__uiCalls=[];window.__previewTest(s);},state);
 await category('submitted');await page.waitForSelector('[data-managed-request="request:intake-1"]');
 assert.match(await page.$eval('[data-managed-request="request:intake-1"]',n=>n.textContent),/先核对.*等待主控安排/);
 await page.$eval('[data-managed-category="active"]',n=>n.click());await page.evaluate(()=>window.__firstRow=document.querySelector('[data-managed-request="request:intake-1"]'));
 check('durable pending intake appears under submitted and active directory controls before Work exists');
 await page.evaluate(()=>{const s=window.__intakeState;s.jobs[0].status='completed';s.jobs[0].routing={action:'clarify'};s.todos.push({id:'q',sourceJobId:'intake-1',kind:'routing',status:'open',text:'后台核对格式'});window.__previewTest(s);});
 assert.match(await page.$eval('[data-managed-request="request:intake-1"]',n=>n.textContent),/后台核对中.*原请求已保留/);
 assert.equal(await page.$$eval('#inbox-reports [data-managed-todo="q"]',ns=>ns.length),0);
 await page.$eval('[data-managed-request="request:intake-1"] .managed-work-open',n=>n.click());await page.waitForFunction(()=>document.querySelector('#managed-agent-details').open);
 assert.equal(await page.$$eval('#managed-current-request button',ns=>ns.length),0);await page.evaluate(()=>document.querySelector('#managed-agent-details').close());
 check('internal routing gate stays read-only rather than becoming a user technical question');
 await page.evaluate(()=>{const s=window.__intakeState;s.todos[0].status='resolved';s.jobs.push({id:'answer',target:'orchestrator',type:'intake',text:'核对完成',status:'completed',context:{routingQuestionId:'q'},routing:{action:'dispatch',workId:'w'}});s.works.push({id:'w',name:'核对',sourceJob:'answer',request:'先核对',status:'queued',revision:1});window.__previewTest(s);});
 assert.equal(await page.evaluate(()=>window.__firstRow===document.querySelector('[data-managed-work="w"]')),true);
 await page.$eval('[data-managed-work="w"] .managed-work-open',n=>n.click());await page.waitForFunction(()=>document.querySelector('#managed-agent-details').open);
 assert.equal(await page.$$eval('#managed-current-work [data-work-control-details]',ns=>ns.length),1);assert.equal(await page.$$eval('#managed-current-work [data-managed-work-end]',ns=>ns.length),1);
 await page.evaluate(()=>document.querySelector('#managed-agent-details').close());check('dispatch preserves the same request row and genuine Work execution/cancellation controls');
 await page.evaluate(()=>{const s=window.__intakeState;s.jobs.push({id:'failed',target:'orchestrator',type:'intake',text:'[protocol wrapper] nozeli_inspect_work @state cursor=""',status:'failed',context:{userGoal:'开始落盘'},error:'INVALID_CURSOR internal stack',maintenanceBugId:'bug-intake',maintenanceFault:{phase:'runtime',code:'INVALID_CURSOR'}});s.todos.push({id:'internal-todo',kind:'system',sourceJobId:'failed',status:'open',text:'INVALID_CURSOR'});window.__previewTest(s);window.__faultCallStart=window.__uiCalls.length;});
 assert.equal(await page.$eval('[data-managed-request="request:failed"] .managed-work-name',n=>n.textContent),'开始落盘');
 assert.match(await page.$eval('[data-managed-request="request:failed"] .managed-work-status',n=>n.textContent),/系统问题待处理.*原请求已保留/);
 await page.$eval('[data-managed-request="request:failed"] .managed-work-open',n=>n.click());await page.waitForFunction(()=>document.querySelector('#managed-agent-details').open);
 assert.equal(await page.$$eval('#managed-current-request button',ns=>ns.length),0);assert.equal(await page.$eval('[data-request-diagnostics]',n=>n.open),false);
 assert.equal(await page.$eval('[data-request-diagnostics] pre',n=>n.checkVisibility()),false);assert.match(await page.$eval('#managed-current-request',n=>n.textContent),/尚未创建后台工作/);
 await page.screenshot({path:path.join(output,'internal-request-readonly.png')});
 await page.$eval('[data-request-diagnostics]',n=>n.open=true);assert.match(await page.$eval('[data-request-diagnostics]',n=>n.textContent),/INVALID_CURSOR/);
 await page.evaluate(()=>document.querySelector('#managed-agent-details').close());
 await page.$eval('[data-managed-request="request:failed"]',n=>n.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})));
 assert.equal(await page.$eval('#managed-agent-details',n=>n.open),true);await page.evaluate(()=>document.querySelector('#managed-agent-details').close());
 assert.equal(await page.$$eval('#inbox-reports [data-managed-todo="internal-todo"]',ns=>ns.length),0);
 assert.deepEqual(await page.evaluate(()=>window.__uiCalls.slice(window.__faultCallStart).filter(c=>['intake.retry','work.control','work.control.status'].includes(c.op))),[]);
 check('internal failed intake keeps exact goal and optional diagnostics with no retry/control dispatch');
 await category('fault');assert.deepEqual(await page.$$eval('#work-items [data-managed-request]',ns=>ns.map(n=>n.dataset.managedRequest)),['request:failed']);
 for(const width of [1440,600]){await page.setViewport({width,height:800});await page.evaluate(()=>document.dispatchEvent(new Event('nozeli-reveal-work-sidebar')));assert.equal(await page.$eval('#app',n=>n.classList.contains('narrow-layout')),width<=1000);assert.equal(await page.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')),'true');await page.screenshot({path:path.join(output,'fault-directory-'+width+'.png')});}
 check('failed intake remains visible in fault category at wide and narrow widths');
 assert.deepEqual(report.errors,[]);await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report}));
}catch(error){report.failure=error.stack;report.processLog=log;report.pageState=await page?.evaluate(()=>({url:location.href,ready:window.__nozeliReady,text:document.body?.innerText})).catch(e=>({error:e.message}));await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.error('Evidence: '+output);throw error;}
finally{await browser?.disconnect();if(child.exitCode===null&&!child.signalCode)child.kill('SIGTERM');let timer;const stopped=await Promise.race([exited.then(()=>true),new Promise(r=>{timer=setTimeout(()=>r(false),3000);})]);clearTimeout(timer);if(!stopped){child.kill('SIGKILL');await exited;}}
