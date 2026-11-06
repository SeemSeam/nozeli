import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {bootInstalled} from './installed-debug-read.fixture.mjs';
import {recordedBugScenario,recordedBugTask,chaosDemoHtml} from './recorded-bug-scenario.fixture.mjs';

// Real installed ELF/main/private Pi, exact recorded input and empty arguments.
// The repaired source must handle them normally, without DEBUG or state injection.
const scenario=recordedBugScenario();let gate;
const result={ok:false,checks:[],scope:'Actual installed ELF/private Pi; exact recorded Chinese task and three empty cursors followed by empty brief; source-level contract fix with no maintenance workaround, real native HTML candidate/publication; loopback provider only, not remote model quality'};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,timeout=180000){const end=Date.now()+timeout;while(Date.now()<end){if(gate?.provider.errors.length)throw gate.provider.errors[0];const value=await fn();if(value)return value;await pause(100);}throw Error('Timed out: '+label);}
function readLedger(){const db=new DatabaseSync(gate.ledgerFile,{readOnly:true});try{const row=db.prepare("SELECT value FROM records WHERE collection='ui' AND id='managed:maintenance'").get();return row?JSON.parse(row.value):{schema:1,bugs:[]};}finally{db.close();}}
try{
 gate=await bootInstalled({scenario:{name:'installed-recorded-bug-fixed'},files:{'1.md':'# 混沌系统 HTML 演示\n原项目资料，不得覆盖。\n'},handler:scenario.handler});
 result.out=gate.out;result.installed=gate.identity;
 await gate.shell.click('#workspace-open-conversation');
 const submitted=await gate.invoke('managed.task',{projectId:gate.projectId,text:recordedBugTask,requestKey:'recorded-bug-fixed-'+randomUUID()});
 const settled=await until(async()=>{const state=await gate.status(),work=state.works.find(item=>item.status==='review'&&item.result?.objectId);return work&&state.jobs.some(job=>job.target===work.id&&job.type==='initial'&&job.status==='completed')&&!state.jobs.some(job=>['queued','running','transferring'].includes(job.status))?state:null;},'installed original request and Worker settle their real candidate as review without either recorded fault');
 const jobs=settled.jobs,intakes=jobs.filter(j=>j.type==='intake'),events=jobs.filter(j=>j.type==='maintenance');assert.equal(intakes.length,1);assert.equal(settled.works.length,1);assert.equal(events.length,0);const original=intakes[0],work=settled.works[0];
 assert.equal(original.id,submitted.jobId);assert.equal(original.status,'completed');assert.equal(original.maintenanceBugId,undefined);assert.equal(original.routing.hostContinuation,undefined);assert.equal(original.routing.workId,work.id);assert.equal(work.sourceJob,original.id);assert.equal(work.request,recordedBugTask);assert.equal(work.brief,recordedBugTask);assert.equal(jobs.filter(j=>j.target===work.id&&j.type==='initial').length,1);
 assert.equal(scenario.intakeRequests,5);assert.equal(scenario.debugRequests,0);assert.equal(scenario.workerRequests,2);
 const maintenance=await gate.invoke('managed.maintenance.status',{projectId:gate.projectId});assert.equal(maintenance.total,0,'production persistence query reports no new parameter bugs');assert.deepEqual(maintenance.rows,[]);result.maintenancePage=maintenance;assert.equal(settled.receipts.filter(r=>r.kind==='result'&&r.workId===work.id).length,1);
 const candidateFile=path.join(work.execution.directory,'chaos-demo.html'),candidate=await fs.readFile(candidateFile,'utf8');assert.equal(candidate,chaosDemoHtml);await assert.rejects(fs.stat(path.join(gate.root,'chaos-demo.html')),{code:'ENOENT'});assert.equal(await gate.git('rev-parse','HEAD'),gate.head);assert.equal(await fs.readFile(path.join(gate.root,'1.md'),'utf8'),'# 混沌系统 HTML 演示\n原项目资料，不得覆盖。\n');
 result.checks.push('installed same three empty cursors succeed as first-page reads; same empty brief performs a normal original-sourceJob dispatch');result.checks.push('one original request/job/Work/Worker; zero maintenance jobs, runtime workarounds or new bugs');result.checks.push('actual HTML candidate published for review; original request/source/Git unchanged and no auto-acceptance');
 const pages=await gate.browser.pages(),ui=[];for(const page of pages){if(!page.url().startsWith('http://127.0.0.1:'))continue;const text=await page.evaluate(()=>document.body.innerText).catch(()=>'');ui.push({url:page.url(),text});}await fs.writeFile(path.join(gate.out,'settled-ui.json'),JSON.stringify(ui,null,2));
 const badges=await until(async()=>{const rows=[];for(const page of await gate.browser.pages()){if(!page.url().startsWith('http://127.0.0.1:'))continue;rows.push(...await page.$$eval('span.session-execution-state',nodes=>nodes.map(n=>({state:n.dataset.executionState,label:n.textContent}))).catch(()=>[]));}return rows.length&&rows.every(row=>row.state==='completed')?rows:null;},'real conversation settles both normal dispatch and Worker delivery');
 assert(!badges.some(row=>['debugging','debugPending','awaitingFix','continuing','continued','failed'].includes(row.state)),'source-fixed scenario must not display failure or a DEBUG workaround');result.uiExecutionBadges=badges;result.checks.push('actual conversation shows normal dispatch/delivery, not failure or system recovery');
 await gate.capture('source-fixed-delivered');
 // Render exact bytes actually produced by the native Worker. This additional
 // Chromium page is artifact behavior proof, not a substitute for app execution.
 const demoUrl='data:text/html;charset=utf-8,'+encodeURIComponent(candidate);
 await gate.observer.evaluate(`(async()=>{const {BrowserWindow}=process.mainModule.require('electron');const win=new BrowserWindow({width:1140,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});globalThis.__runtimeDebugArtifactWindow=win;await win.loadURL(${JSON.stringify(demoUrl)});return win.id;})()`);
 const demo=await until(async()=>{for(const page of await gate.browser.pages())if(page.url().startsWith('data:text/html')&&await page.title()==='混沌系统 · Lorenz 演示')return page;return null;},'owned artifact viewer');
 await demo.waitForFunction(()=>Number(document.getElementById('steps').textContent)>=400);
 await demo.click('#pause');const stopped=await demo.$eval('#steps',n=>Number(n.textContent));await demo.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await demo.$eval('#steps',n=>Number(n.textContent)),stopped);
 await demo.$eval('#rho',n=>{n.value='30';n.dispatchEvent(new Event('input',{bubbles:true}));});assert.equal(await demo.$eval('#rhoValue',n=>n.textContent),'30');assert.equal(await demo.$eval('#steps',n=>n.textContent),'0');
 await demo.click('#pause');await demo.waitForFunction(()=>Number(document.getElementById('steps').textContent)>=400);await demo.screenshot({path:path.join(gate.out,'actual-worker-chaos-demo.png')});
 await gate.observer.evaluate('(()=>{globalThis.__runtimeDebugArtifactWindow.destroy();delete globalThis.__runtimeDebugArtifactWindow;return true;})()');result.checks.push('native-produced offline Lorenz HTML renders, advances simulation, pauses and responds to parameter changes in an owned sandboxed Electron artifact window');
 result.projectId=gate.projectId;result.originalJobId=original.id;result.work=work;result.jobs=jobs;result.scenario={...scenario,handler:undefined};result.candidateFile=candidateFile;
 const before=gate.provider.requests.length;const exit=await gate.close();assert.deepEqual(exit,{code:0,signal:null});assert(!gate.closeInfo.installedBytesChanged);assert.equal(gate.provider.requests.length,before);result.exit=exit;
 // Read the raw durable ledger only after all owned writers have exited;
 // while the app is live, use its serialized production read API above.
 const ledger=readLedger();assert.deepEqual(ledger.bugs,[],'raw persistent ledger also contains no newly recorded bug');result.ledger=ledger;
 result.checks.push('owned installed app exits normally; persisted raw ledger remains empty; installed bytes unchanged; no extra model requests');result.ok=true;
}catch(error){result.error=error.stack;result.providerErrors=gate?.provider.errors.map(e=>e.stack);process.exitCode=1;}
finally{await gate?.close().catch(error=>{result.cleanupError=error.message;process.exitCode=1;});if(gate){await fs.writeFile(path.join(gate.out,'report.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(gate.out,'electron.log'),gate.readLog());}console.log(JSON.stringify({ok:result.ok,out:gate?.out,checks:result.checks,error:result.error}));}
