import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, symlink, writeFile, readFile } from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {runGit} from '../src/agents/managed/git-runtime.mjs';
import {waitForDesktopPage} from './reading-setup.fixture.mjs';

const source = path.resolve(import.meta.dirname, '..');
const output = await mkdtemp(path.join(source, '.test-output', 'managed-lifecycle-'));
const report={checks:[],errors:[],stages:[],browserEvents:[]};
const stage=async name=>{report.stage=name;report.stages.push({name,at:new Date().toISOString()});await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));};
await stage('preparing-isolated-app');
const root = path.join(output, 'app');
await mkdir(root);
for (const item of ['src', 'tools', 'package.json']) await cp(path.join(source, item), path.join(root, item), { recursive: true });
for(const item of ['node_modules','vendor','assets','runtime'])await symlink(path.join(source,item),path.join(root,item),'dir');
await cp(path.join(source,'tests/managed-lifecycle-session.fixture.mjs'),path.join(root,'src/agents/managed-lifecycle-session.fixture.mjs'));
const hostPath=path.join(root,'src/agents/managed-projects.mjs');
let hostSource=await readFile(hostPath,'utf8');
hostSource="import {Session} from './managed-lifecycle-session.fixture.mjs';\n"+hostSource.replace('openController=Controller.open','openController=args=>Controller.open({...args,isolateProcesses:false,projectHome:async home=>fs.mkdir(home,{recursive:true}),sessionFactory:(spec,target)=>new Session(spec,target)})');
// This deterministic UI fixture uses real managed worktrees but no native model/PTY.
// Native process isolation and actual model acceptance run in the installed journey.
await writeFile(hostPath,hostSource);
const panelPath=path.join(root,'src/renderer/managed-agent-panel.mjs');
let panelSource=await readFile(panelPath,'utf8');
panelSource=panelSource.replace(' let projectId='," const realInvoke=invoke;invoke=(op,p)=>{if(op==='managed.connect'&&window.__failManagedConnect){window.__failManagedConnect--;return Promise.resolve({ok:false,error:{message:'controlled startup failure'}});}return realInvoke(op,p);}; let projectId=");
panelSource=panelSource.replace(' return {get active()', ' window.__managedLifecycle={load,send,projectState:value=>{state=value;render();}}; return {get active()');
await writeFile(panelPath,panelSource);
const build = spawn(process.execPath, [path.join(root, 'tools/build-renderer.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let buildLog = '';
build.stdout.on('data', chunk => { buildLog += chunk; });
build.stderr.on('data', chunk => { buildLog += chunk; });
const buildExit=await new Promise(resolve=>build.once('exit',resolve));await writeFile(path.join(output,'build.log'),buildLog);assert.equal(buildExit,0,buildLog);await stage('renderer-built');
const project = path.join(output, 'project');
await mkdir(project);
await writeFile(path.join(project, 'sample.md'), '# Reading\n\nA real project document.\n');
await runGit(project,['init','--initial-branch=main']);await runGit(project,['add','sample.md']);await runGit(project,['-c','user.name=Nozeli GUI Fixture','-c','user.email=fixture@example.invalid','commit','-qm','GUI fixture baseline']);await stage('project-repository-initialized');
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
const launcherLog=createWriteStream(path.join(output,'launcher.log'),{flags:'a'});launcherLog.on('error',error=>{report.launcherLogError=error.message;});
let log = '', browser, page;
child.stdout.on('data',chunk=>{log+=chunk;launcherLog.write(chunk);});
child.stderr.on('data',chunk=>{log+=chunk;launcherLog.write(chunk);});
child.on('exit',(code,signal)=>{report.browserEvents.push({type:'electron-exit',code,signal,at:new Date().toISOString(),stage:report.stage});});
try {
  await stage('waiting-debug-endpoint');
  const deadline = Date.now() + 25000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode) throw new Error(log);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error('Startup timeout: ' + log);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  browser.on('disconnected',()=>report.browserEvents.push({type:'browser-disconnected',stage:report.stage,at:new Date().toISOString()}));
  page = await waitForDesktopPage(browser);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('error',error=>report.browserEvents.push({type:'page-crash',message:error.message,stage:report.stage,at:new Date().toISOString()}));
  page.on('close',()=>report.browserEvents.push({type:'page-closed',stage:report.stage,at:new Date().toISOString()}));
  page.on('console',message=>report.browserEvents.push({type:'console-'+message.type(),text:message.text(),stage:report.stage,at:new Date().toISOString()}));
  page.on('framenavigated',frame=>report.browserEvents.push({type:'frame-navigated',url:frame.url(),stage:report.stage,at:new Date().toISOString()}));
  page.on('framedetached',frame=>report.browserEvents.push({type:'frame-detached',url:frame.url(),stage:report.stage,at:new Date().toISOString()}));
  await stage('waiting-renderer-ready');
  await page.waitForFunction(() => window.__nozeliReady);
  await page.setViewport({ width: 1440, height: 900 });
  const invoke=async(op,args={})=>{const r=await page.evaluate(({op,args})=>window.nozeli.invoke(op,args),{op,args});assert.equal(r.ok,true,r.error?.message);return r.value;};
  await stage('initializing-isolated-configuration');
  await page.waitForSelector('#configuration-setup[open]');
  await page.click('#configuration-independent');
  await page.waitForFunction(()=>!document.querySelector('#configuration-setup').open);
  assert.equal((await invoke('config.status')).initialized,true);
  await stage('picking-project');
  await page.click('#pick-project');await page.waitForFunction(()=>document.querySelectorAll('#recent button').length===1);
  await stage('project-picked');
  const id=(await invoke('project.recent')).projects[0].id;
  await stage('waiting-managed-ready');
  await page.waitForFunction(async id=>(await window.nozeli.invoke('managed.status',{projectId:id})).value?.ready,{},id).catch(async error=>{report.managedFailure=await page.evaluate(async id=>({status:await window.nozeli.invoke('managed.status',{projectId:id}),label:document.querySelector('#ai-status')?.textContent}),id);throw error;});
  assert.equal(await page.$eval('#managed-settings',n=>n.open),false);await page.waitForSelector('[data-managed-terminal=frontdesk]');await page.waitForSelector('[data-managed-terminal=orchestrator]');report.checks.push('opening project auto-enables managed agents and mounts resident cards without setup');
  await stage('managed-ready');
  const state=async()=>(await invoke('managed.status',{projectId:id})).state;
  const wait=async predicate=>{for(let i=0;i<200;i++){const s=await state();if(predicate(s))return s;await new Promise(r=>setTimeout(r,25));}throw Error('state timeout');};
  const send=async text=>{const frontend=await page.$eval('#conversation-panel',n=>!n.dataset.managedConversation||n.dataset.managedConversation==='frontdesk');await page.$eval('#composer',(el,text)=>{el.value=text;el.dispatchEvent(new Event('input',{bubbles:true}));},text);await page.click('#send-message');if(frontend&&!/^(?:LIGHT|FAIL)/.test(text)){await page.waitForSelector('[data-frontdesk-route-action="background"]');await page.click('[data-frontdesk-route-action="background"]');}};
  const confirmClick=async(selector,expected)=>{
    let timer,listener;const confirmation=new Promise((resolve,reject)=>{listener=async dialog=>{try{assert.equal(dialog.type(),'confirm');assert.match(dialog.message(),expected);report.browserEvents.push({type:'confirmed-user-action',message:dialog.message(),stage:report.stage,at:new Date().toISOString()});await dialog.accept();resolve();}catch(error){await dialog.dismiss().catch(()=>{});reject(error);}};page.once('dialog',listener);timer=setTimeout(()=>reject(Error('Expected confirmation dialog did not appear for '+selector)),5000);});
    try{await Promise.all([page.click(selector),confirmation]);}finally{clearTimeout(timer);page.off('dialog',listener);}
  };
  await send('LIGHT hello');await wait(s=>s.jobs[0]?.status==='completed'&&!s.busyTargets.length);assert.equal((await state()).works.length,0);report.checks.push('light question stays frontdesk');
  const copyText='Copy full plain text\n\n| column | 中文 |\n| --- | --- |\n| value | 𝛼 😀 |\n\n'+('unabridged clipboard content\n'.repeat(300));
  await send('LIGHT '+copyText);await wait(s=>s.jobs.at(-1)?.status==='completed'&&!s.busyTargets.length);
  if(await page.$eval('#conversation-panel',node=>node.classList.contains('compact-composer')))await page.click('#chat-history-toggle');
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-managed-message].agent-message-user')].some(node=>node.textContent.includes('unabridged clipboard content')&&node.querySelector('[data-message-copy]')));
  const copyId=await page.$$eval('[data-managed-message].agent-message-user',nodes=>nodes.find(node=>node.textContent.includes('unabridged clipboard content'))?.dataset.managedMessage);
  assert(copyId,'submitted full text must render a copy action');
  const copySelector='[data-managed-message="'+copyId+'"] [data-message-copy]';
  await page.locator(copySelector).click();await page.waitForFunction(selector=>document.querySelector(selector)?.dataset.messageCopy==='copied',{},copySelector);
  assert.equal(await invoke('document.clipboard',{action:'read'}),'LIGHT '+copyText);report.checks.push('message copy acknowledges real host clipboard write and preserves full plain text');
  await page.evaluate(()=>Promise.all([window.__managedLifecycle.send('LIGHT duplicate'),window.__managedLifecycle.send('LIGHT duplicate')]));await wait(s=>!s.busyTargets.length&&s.jobs.filter(j=>j.text==='LIGHT duplicate').length===1&&s.jobs.at(-1).status==='completed');report.checks.push('concurrent same-input submission is accepted once');
  const beforeClosed=await state();
  await page.evaluate(value=>window.__managedLifecycle.projectState({...value,agents:value.agents.map(agent=>agent.target==='frontdesk'?{...agent,closed:true,phase:'closed',exit:{signal:1}}:agent)}),beforeClosed);
  assert.equal(await page.$eval('#ai-status',node=>node.dataset.state),'failed');
  assert.match(await page.$eval('#ai-status',node=>node.textContent),/原生会话已退出/);
  await page.$eval('#composer',node=>{node.value='LIGHT preserved closed draft';});
  await page.$eval('#composer',node=>node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})));
  assert.equal(await page.$eval('#composer',node=>node.value),'LIGHT preserved closed draft');
  assert.match(await page.$eval('#compose-status',node=>node.textContent),/发送未发出/);
  assert.equal((await state()).jobs.length,beforeClosed.jobs.length);
  assert.equal(await page.$eval('#provider-console',node=>node.hidden),true);
  await page.click('[data-managed-session-recovery="frontdesk"]');
  await page.waitForFunction(()=>document.querySelector('#ai-status').dataset.state==='ready');
  assert.equal(await page.$eval('#composer',node=>node.value),'LIGHT preserved closed draft');
  assert.equal((await state()).jobs.length,beforeClosed.jobs.length,'explicit recovery must not replay draft or prior jobs');
  const beforeKeys=(await state()).jobs.length;
  await page.$eval('#composer',node=>{for(const extra of [{isComposing:true},{keyCode:229},{repeat:true}])node.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,...extra}));});
  assert.equal((await state()).jobs.length,beforeKeys);
  await page.focus('#composer');await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');
  await wait(s=>s.jobs.length===beforeKeys+1&&s.jobs.at(-1).status==='completed'&&!s.busyTargets.length);
  report.checks.push('closed selected session rejects visibly, reading recovery preserves input without replay, keyboard shares send and guards IME/repeat');
  await send('NEW Alpha task');let s=await wait(s=>s.works[0]?.status==='paused'&&!s.busyTargets.length);const first=s.works[0],thread=first.threadId;const failed=s.jobs.find(job=>job.status==='failed');assert.equal(failed,undefined,failed?.error||'initial question must not mask a failed job');assert.equal(typeof thread,'string');assert(thread.length>0,'initial Worker has a real session identity');const question=s.receipts.find(receipt=>receipt.workId===first.id&&receipt.kind==='problem'&&receipt.revision===first.revision);assert(question,'paused Worker must have published its controlled question');assert.equal(question.text,'请选择核验方向');assert.equal(s.quotaUsed,1);
  await stage('first-worker-paused');
  await send('NEW Beta task');await wait(s=>s.works.length===2&&!s.busyTargets.length);assert.equal((await state()).works[1].status,'queued');report.checks.push('worker question holds quota; new independent work queues');
  await send('CONTINUE Alpha detail');s=await wait(s=>s.works[0].status==='review'&&!s.busyTargets.length);assert.equal(s.works[0].threadId,thread);assert.equal(s.works.length,2);report.checks.push('frontdesk supplement routes to same worker');
  const beta=(await state()).works[1];await invoke('managed.end',{projectId:id,workId:beta.id,revision:beta.revision,decision:'discard'});s=await wait(s=>s.works[1].status==='ended'&&!s.busyTargets.length);assert.equal(s.quotaUsed,1);report.checks.push('explicit queued discard preserves other Work quota');
  await send('CLARIFY ALL Which work');s=await wait(s=>s.todos.some(t=>t.kind==='routing'&&t.status==='open')&&!s.busyTargets.length);assert.equal(s.works.length,2);report.checks.push('routing ambiguity creates clarification');
  if(await page.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await page.click('#toggle-sidebar');
  const result=s.todos.find(t=>t.workId===first.id&&t.kind==='result'&&t.status==='open');
  await page.click('#inbox-reports [data-managed-todo="'+result.id+'"]');await page.waitForSelector('#managed-result-actions');assert.equal(await page.$eval('#conversation-panel',n=>n.dataset.managedConversation),first.id);
  await send('worker followup');s=await wait(s=>s.works[0].revision===3&&s.works[0].status==='review'&&!s.busyTargets.length);assert.equal(s.works[0].threadId,thread);report.checks.push('todo discussion continues original worker');
  await page.waitForSelector('[data-managed-latest-report]');assert.equal(await page.$eval('[data-managed-end-result]',n=>n.disabled),true);assert.ok(await page.$eval('#managed-result-update',n=>n.textContent.includes('第 3 版')));
  await page.$$eval('[data-worker-round] > details',nodes=>nodes.forEach(node=>{node.open=true;}));
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-managed-message]')].some(node=>node.textContent.includes('Controlled result')));report.checks.push('published result readable in expanded worker conversation and stale review cannot end new revision');
  await page.click('[data-managed-latest-report]');await page.waitForFunction(()=>!document.querySelector('#managed-result-update'));report.checks.push('latest result opens without replacing historical report');
  const beforeEnd=s.jobs.length;await stage('confirming-worker-acceptance');await confirmClick('[data-managed-end-result]',/接受当前成果/);s=await wait(s=>s.works[0].status==='ended'&&s.works[0].closure?.phase==='complete'&&!s.busyTargets.length);assert.equal(s.quotaUsed,0);assert.equal(s.works[0].outcome,'accept');assert.equal(s.jobs.length,beforeEnd);assert.equal(s.works[0].closure.report.kind,'worker-report');report.checks.push('user acceptance archives Worker report without another model turn and frees quota');
  await stage('first-worker-accepted');
  await send('FAIL unavailable');await wait(s=>s.jobs.at(-1)?.status==='failed'&&!s.busyTargets.length);assert.ok(await page.$eval('#conversation',n=>n.textContent.includes('本次处理未完成')));report.checks.push('provider failure visible in conversation');
  if(await page.$('[data-managed-session-recovery="frontdesk"]')){await page.click('[data-managed-session-recovery="frontdesk"]');await page.waitForFunction(()=>document.querySelector('#ai-status').dataset.state==='ready');}
  await send('LIGHT recovery');await wait(s=>s.jobs.at(-1)?.status==='completed'&&!s.busyTargets.length);report.checks.push('explicit recovery and later input continue original provider without replay');
  const ids=(await state()).residents,jobs=(await state()).jobs.length;
  await page.evaluate(async id=>{window.__failManagedConnect=1;await window.__managedLifecycle.load(id);},id);
  await page.waitForSelector('[data-managed-session-recovery="frontdesk"]');assert.equal(await page.$eval('#provider-console',n=>n.hidden),true);
  await page.click('[data-managed-session-recovery="frontdesk"]');await page.waitForFunction(()=>document.querySelector('#ai-status').dataset.state==='ready');
  s=await state();assert.deepEqual(s.residents,ids);assert.equal(s.jobs.length,jobs);report.checks.push('project recovery failure offers retry, preserves thread and jobs');
  assert.deepEqual(report.errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, ...report }));
} catch (error) {
  report.failure = error.stack;
  report.failureStage=report.stage;report.electronAtFailure={exitCode:child.exitCode,signalCode:child.signalCode};report.pageUrl=page?.url();
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
  await new Promise(resolve=>launcherLog.end(resolve));await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
}
