// Parent-only serial smoke: NOZELI_TEST_BINARY=/candidate/nozeli node tests/desktop-frozen-navigation-live.mjs
// Existing archive fixture + real Git and native ready; synthetic history, NOT Worker inference.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';
import {prepareFrozenWorkflow, git} from './desktop-frozen-workflow.fixture.mjs';
import {configureNativeConversation} from './native-conversation-ready.fixture.mjs';
import {staticReport} from './static-report.fixture.mjs';
import {Controller} from '../src/agents/managed/controller.mjs';
import {WorkChanges} from '../src/agents/managed/work-changes.mjs';

const source = path.resolve(import.meta.dirname, '..');
const lock = path.join(os.tmpdir(), 'nozeli-ui-design-live.lock');
await fs.mkdir(lock);
let out, fixture, child, browser, shell, chat, doc, cleanupReady, exited, launchError, log = '';
const report = {checks: [], scenes: [], errors: [], evidence: '真实 Git、宿主、原生 ready；复用 archive fixture 并预置合成历史；非 Worker 推理；模型请求必须为零。'};
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 45000;
  do { if (launchError) throw launchError; if (child && (child.exitCode !== null || child.signalCode)) throw Error(log); const value = await fn(); if (value) return value; await pause(80); } while (Date.now() < end);
  throw Error('Timed out: ' + label);
}
async function call(page, op, payload = {}) {
  const result = await page.evaluate((op, payload) => window.nozeli.invoke(op, payload), op, payload);
  assert(result.ok, op + ': ' + JSON.stringify(result.error)); return result.value;
}
async function scoped(predicate) {
  return until(async () => {
    for (const page of await browser.pages()) {
      const scope = await page.evaluate(() => window.__workspaceScope).catch(() => null);
      if (scope && predicate(scope) && await page.evaluate(() => window.__nozeliReady === true)) return {page, scope};
    }
  }, 'native surface');
}
const status = () => call(shell, 'managed.status', {projectId: fixture.a.id});
const windows = () => call(shell, 'workspace.windows.list', {projectId: fixture.a.id});
async function visible(viewId) { return until(async () => (await windows()).flatMap(w => w.surfaces).find(s => s.viewId === viewId && s.visible && s.bounds.width > 0), 'visible owner ' + viewId); }
async function capture(label, owner) {
  await owner.page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const data = await owner.page.evaluate(() => {
    const select = selector => [...document.querySelectorAll(selector)].map(n => ({text:n.innerText, bounds:n.getBoundingClientRect().toJSON(), font:getComputedStyle(n).fontSize, disabled:n.disabled}));
    return {viewport:{width:innerWidth,height:innerHeight},theme:document.documentElement.dataset.theme,chromeFont:getComputedStyle(document.documentElement).getPropertyValue('--chrome-font-size'),head:select('.document-diff-head'),buttons:select('.document-diff-head button'),versions:select('.frozen-change-versions'),counts:select('.diff-navigation span'),editors:select('.cm-mergeViewEditor'),active:document.activeElement?.outerHTML,bodyWidth:document.querySelector('.document-diff-body')?.getBoundingClientRect().width};
  });
  const surface = await visible(owner.scope.viewId), file = label + '-actual-content-WCV.png';
  await owner.page.screenshot({path:path.join(out,file)}); report.scenes.push({label,file,surface,...data}); return data;
}
async function appearance(theme, size, width, palette='sage') {
  await call(shell, 'session.resize', {width:1440,height:1000}); await shell.waitForFunction(() => innerWidth === 1440);
  await shell.click('#open-settings'); await shell.click('[data-settings-section="settings-appearance"]');
  await shell.select('[data-appearance="theme"]', theme); await shell.select('[data-appearance="size"]', String(size)); await shell.click('#settings-close');
  if(process.env.NOZELI_PALETTE_MATRIX==='1'){await shell.click('#open-settings');await shell.click('[data-settings-section="settings-appearance"]');await shell.select('[data-appearance="palette"]',palette);await shell.click('#settings-close');}
  await call(shell, 'session.resize', {width,height:1000}); await shell.waitForFunction(width => innerWidth === width, {}, width);
}
async function settledConversation() {
  await visible(chat.scope.viewId);
  await chat.page.evaluate(async()=>{
    await Promise.race([document.fonts.ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('Conversation fonts did not load')),5000))]);
    const scroll=document.querySelector('#conversation');let last='',stable=0;const deadline=performance.now()+6000;
    while(performance.now()<deadline){
      await new Promise(resolve=>{const frame=requestAnimationFrame(()=>{clearTimeout(timer);resolve();});const timer=setTimeout(()=>{cancelAnimationFrame(frame);resolve();},100);});
      const geometry=JSON.stringify([scroll.scrollTop,scroll.scrollHeight,scroll.clientHeight,scroll.clientWidth,...[...scroll.querySelectorAll('[data-frozen-file]')].map(n=>{const b=n.getBoundingClientRect();return [b.x,b.y,b.width,b.height];})]);
      stable=geometry===last?stable+1:0;last=geometry;if(stable>=8)return;
    }
    throw Error('Conversation reading geometry did not settle');
  });
}
async function prepareEntry(file) {
  await settledConversation();
  const box=await chat.page.$eval('#conversation',n=>n.getBoundingClientRect().toJSON());
  await chat.page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await chat.page.mouse.wheel({deltaY:1}); // Genuine user reading releases initial saved-position restoration.
  await settledConversation();
  const selector='[data-frozen-file="'+file.fileId+'"]';
  await chat.page.waitForSelector(selector,{visible:true});
  await chat.page.$eval(selector,n=>n.scrollIntoView({block:'center',behavior:'instant'}));
  await settledConversation();
}
async function retained() {
  return {editor:await doc.page.evaluate(() => ({same:window.__diffEditor === document.querySelector('#text-host .cm-editor'),text:window.__nozeliInput.text(),selection:window.__nozeliInput.selection(),scroll:document.querySelector('#text-host .cm-scroller').scrollTop})),
    chat:await chat.page.evaluate(() => ({draft:document.querySelector('#composer').value,scroll:document.querySelector('#conversation').scrollTop,ids:[...document.querySelectorAll('[data-message],[data-worker-round]')].map(n=>n.dataset.message||n.dataset.workerRound),files:[...document.querySelectorAll('[data-frozen-file]')].map(n=>n.dataset.frozenFile)}))};
}
async function openFile(file) {
  await visible(chat.scope.viewId);
  const selector = '[data-frozen-file="' + file.fileId + '"]';
  await chat.page.waitForSelector(selector, {visible:true});
  const beforeClick = await chat.page.evaluate(()=>({top:document.querySelector('#conversation').scrollTop,height:document.querySelector('#conversation').scrollHeight,client:document.querySelector('#conversation').clientHeight}));
  report.checks.push({name:'immediate before click',...beforeClick});
  const originGroup = await shell.$eval('.workspace-pane:has([data-view-id="' + chat.scope.viewId + '"])', n => n.dataset.workspaceGroup);
  const originSurface = (await windows()).flatMap(w=>w.surfaces).find(s=>s.viewId===chat.scope.viewId);
  const hit=await chat.page.$eval(selector,n=>{const b=n.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};});await chat.page.mouse.click(hit.x,hit.y);
  const diff = await scoped(s => s.kind === 'diff' && s.projectId === fixture.a.id);
  await visible(diff.scope.viewId); await diff.page.waitForSelector('.frozen-change-reader', {visible:true});
  await diff.page.waitForFunction(() => !document.querySelector('.document-diff-body')?.innerText.includes('正在读取冻结版本'));
  const snapshot = await call(shell, 'workspace.snapshot', {projectId:fixture.a.id});
  const binding = snapshot.layout.views[diff.scope.viewId].viewState.target;
  assert.deepEqual(binding, {projectId:fixture.a.id,changeSetId:report.identity.changeSetId,fileId:file.fileId});
  diff.originGroup = originGroup;
  diff.originSurface = originSurface;
  return diff;
}
async function closeDiff(diff, before) {
  report.stage='close Diff button';
  assert.equal(await diff.page.$eval('.document-diff-head header:first-child button',n=>n.textContent),'关闭对比');
  await diff.page.click('.document-diff-head header:first-child button');
  // Host invoke may ACK forwarding: wait for actual surface deletion AND same pane destination.
  report.stage='await Diff surface removal';
  await until(async () => !(await windows()).flatMap(w=>w.surfaces).some(s=>s.viewId===diff.scope.viewId), 'diff surface removed');
  const chatViewId = chat.scope.viewId;
  report.stage='scope restored conversation';
  chat = await scoped(s=>s.kind==='conversation'&&s.viewId===chatViewId);
  const returnedSurface = await visible(chatViewId);
  report.stage='await restored composer and frozen list';
  await chat.page.waitForSelector('#composer',{visible:true});
  await until(async()=>chat.page.$$eval('[data-frozen-file]',(nodes,count)=>nodes.length===count,before.chat.files.length),'restored complete frozen list');
  report.stage='settle restored conversation geometry';
  await settledConversation();
  report.checks.push({name:'conversation surface lifecycle',viewId:chatViewId,before:diff.originSurface,after:returnedSurface,sameWebContents:diff.originSurface.webContentsId===returnedSurface.webContentsId,note:'Pane history may recreate the conversation WCV; no same-DOM claim. Original floated document still requires identical editor.'});
  const pane = await shell.$eval('.workspace-pane:has([data-view-id="' + chat.scope.viewId + '"])', n => ({group:n.dataset.workspaceGroup,current:n.querySelector('[data-view-id]')?.dataset.viewId}));
  assert.equal(pane.current,chat.scope.viewId);
  assert.equal(pane.group,diff.originGroup,'Close restores the original pane owner, not another pane');
  report.stage='measure retained editor and chat state';
  const after = await retained();
  const hostState = await call(shell,'workspace.snapshot',{projectId:fixture.a.id});
  report.checks.push({name:'retained reading state',before,after,hostConversationView:hostState.layout.views[chatViewId]});
  assert.deepEqual(after,before,'Original editor DOM/buffer/selection/scroll plus restored durable chat draft/messages/frozen list and reading position retained');
  const focus = await chat.page.evaluate(() => ({hasFocus:document.hasFocus(),active:document.activeElement?.outerHTML}));
  report.checks.push({name:'returned focus ownership',chat:focus,shell:await shell.evaluate(()=>({hasFocus:document.hasFocus(),active:document.activeElement?.outerHTML})),document:await doc.page.evaluate(()=>({hasFocus:document.hasFocus(),active:document.activeElement?.outerHTML}))});
  assert(focus.hasFocus,'Returned conversation WCV owns focus, not the destroyed Diff');
  report.checks.push({name:'close destination',diff:diff.scope.viewId,pane,focus});
  await capture('closed-' + report.checks.length,chat);
}
try {
  out = await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-frozen-navigation-')); report.out = out;
  fixture = await prepareFrozenWorkflow(out);
  const directory = '冻结版本来源/长中文路径用于完整路径键盘展开核对';
  const paths = {changes:directory+'/多处正文差异.txt',same:directory+'/内容相同模式变化.txt',unreadable:directory+'/不可读版本.txt'};
  await fs.mkdir(path.join(fixture.project,directory),{recursive:true});
  const before = Array.from({length:180},(_,i)=>'输入 '+i+'：保留中文上下文。').join('\n')+'\n';
  const after = before.split('\n').map((s,i)=>[8,65,142].includes(i)?'候选 '+i+'：真实归档差异。':s).join('\n');
  for (const [key,rel] of Object.entries(paths)) await fs.writeFile(path.join(fixture.project,rel),key==='changes'?before:'只读输入正文\n');
  await git(fixture.project,['add','.']); await git(fixture.project,['commit','-m','navigation fixture input']);
  const inputCommit = await git(fixture.project,['rev-parse','HEAD']);
  await fs.writeFile(path.join(fixture.project,paths.changes),after); await fs.chmod(path.join(fixture.project,paths.same),0o755);
  await fs.writeFile(path.join(fixture.project,paths.unreadable),Buffer.from([255,254,97]));
  await git(fixture.project,['add','.']); await git(fixture.project,['commit','-m','navigation fixture candidate']);
  const candidateCommit = await git(fixture.project,['rev-parse','HEAD']);
  const c = await Controller.open({storage:fixture.storage,projectId:fixture.a.id,runtimeRoot:fixture.runtimeRoot,contentRoot:fixture.project});
  let binding;
  try {
    const work = await c.store.submit('冻结导航合成历史','禁止重放或推理',{name:'冻结导航历史'}); await c.store.activate(work.id);
    const jobId='diff-navigation-history',receiptId='diff-navigation-receipt',requestId='diff-navigation-request';
    await c.store.mutate(()=>c.store.state.jobs.push({id:jobId,target:work.id,revision:1,type:'work',status:'completed',text:'合成历史，非推理',context:{},collabAttempts:[{requestId,sessionId:'diff-history',epoch:'diff-history#0',kind:'prompt',status:'settled'}],completedAt:new Date().toISOString()}));
    binding = await c.changes.capture({projectId:fixture.a.id,workId:work.id,revision:1,jobId,receiptId,repo:fixture.project,commonDir:await fs.realpath(path.join(fixture.project,'.git')),inputCommit,candidateCommit});
    await c.store.publish(work.id,1,'result',staticReport('冻结导航合成历史；真实 Git；非 Worker 推理。'),receiptId,{jobId,changeSetId:binding.changeSetId});
    await c.recordNativeEntries(work.id,{sessionId:'diff-history',epoch:'diff-history#0',jobId,requestId,entry:{type:'message',id:'diff-navigation-answer',message:{role:'assistant',content:[{type:'text',text:'只读归档导航历史，无模型执行。'}]}}});
    if(process.env.NOZELI_INSTALLED_ROLE_AUDIT==='1'){
      for(const [target,role,text] of [['frontdesk','user','请解释这份材料。合成持久历史，不发送请求。'],['frontdesk','assistant','先核对来源，再阅读结论。这里保留中文、English 和 `code`，配色不代表批准。'],['orchestrator','assistant','主控仅记录已有任务归属；本次没有执行或派工。'],['frontdesk','toolResult','合成历史工具记录：不可读取的来源；未执行工具。']])await c.recordNativeEntries(target,{sessionId:'installed-role-'+role+'-'+target,epoch:'installed-role#0',entry:{type:'message',id:'installed-role-'+role+'-'+target,message:{role,content:[{type:'text',text}],...(role==='toolResult'?{toolName:'历史记录',isError:true}:{})}}});
    }
    await c.store.mutate(()=>{const w=c.store.find(work.id);w.status='ended';w.endedAt=new Date().toISOString();w.closure={phase:'complete',decision:'discard',revision:1};for(const t of c.store.state.todos)t.status='resolved';});
  } finally {await c.stop();}
  const files = (await new WorkChanges({runtimeRoot:fixture.runtimeRoot,storage:fixture.storage,projectId:fixture.a.id}).list({changeSetId:binding.changeSetId})).files;
  report.identity = {projectId:fixture.a.id,changeSetId:binding.changeSetId,inputCommit,candidateCommit,files};
  const port = await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  const env={...process.env}; for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key))delete env[key];
  Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:fixture.configRoot,NOZELI_USER_DATA:fixture.profile,NOZELI_TEST_PICK:fixture.project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_SHOT_DIR:out});
  child=spawn(process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron'),[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(source,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{cwd:os.tmpdir(),env,stdio:['ignore','pipe','pipe']});
  child.on('error',e=>{launchError=e;}); for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{log+=b;}); exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'debug endpoint');
  shell=(await scoped(s=>s.role==='shell')).page;
  if(await shell.$eval('#configuration-setup',n=>n.open))await shell.click('#configuration-cancel');
  await shell.click('[data-project-id="'+fixture.a.id+'"]'); await shell.waitForSelector('#file-tree [data-path="reading.txt"]'); await shell.click('#file-tree [data-path="reading.txt"]');
  doc=await scoped(s=>s.kind==='document'&&s.relPath==='reading.txt'); await visible(doc.scope.viewId);
  await doc.page.waitForSelector('#text-host .cm-content',{visible:true}); await doc.page.click('#text-host .cm-content'); await doc.page.keyboard.type('UNSENT-DIFF ');
  await doc.page.evaluate(()=>{window.__diffEditor=document.querySelector('#text-host .cm-editor');window.__nozeliInput.select(2,7);document.querySelector('#text-host .cm-scroller').scrollTop=520;});
  // Keep the original live editor outside the conversation pane. Opening chat
  // in its pane would replace that document surface instead of retaining it.
  const documentContents = await windows();
  const originalDocument = documentContents.flatMap(w=>w.surfaces).find(s=>s.viewId===doc.scope.viewId);
  await shell.locator('#workspace-open-editors [data-editor-view="'+doc.scope.viewId+'"]').click({button:'right'});
  await shell.waitForSelector('.nozeli-context-menu:not([hidden]) [data-command="float"]',{visible:true});
  await shell.click('.nozeli-context-menu:not([hidden]) [data-command="float"]');
  await until(async()=>(await call(doc.page,'workspace.bootstrap')).windowId!=='main','original document floated');
  const floatedDocument = (await windows()).flatMap(w=>w.surfaces).find(s=>s.viewId===doc.scope.viewId);
  assert.equal(floatedDocument.webContentsId,originalDocument.webContentsId,'Float preserves the exact original editor WCV');
  report.checks.push({name:'original editor floated unchanged',viewId:doc.scope.viewId,webContentsId:floatedDocument.webContentsId});
  await shell.bringToFront();
  cleanupReady=await configureNativeConversation(shell); await until(async()=>(await status()).ready,'real native ready');
  await shell.click('#workspace-open-conversation'); chat=await scoped(s=>s.kind==='conversation'&&s.projectId===fixture.a.id); await visible(chat.scope.viewId);
  await chat.page.waitForFunction(()=>!document.querySelector('#composer').disabled);
  await chat.page.locator('#composer').fill('未发送 Diff 导航草稿 — never submit');
  const jobs=(await status()).state.jobs.map(j=>j.id);
  // Collapse existing sidebars; one ordinary pane yields ~350px actual content at a 390px host.
  await call(shell,'session.resize',{width:1440,height:1000});
  for(const [name,selector]of [['files-collapsed','#file-toggle'],['side-collapsed','#toggle-sidebar']])if(!await shell.$eval('#app',(n,c)=>n.classList.contains(c),name))await shell.click(selector);
  for(const palette of (process.env.NOZELI_PALETTE_MATRIX==='1'?['sage','slate']:['sage']))for(const [theme,size,width]of [['light',13,450],['dark',13,450],['light',20,450],['dark',20,450],['light',13,1440],['dark',20,1440]]) {
    await appearance(theme,size,width,palette);
    if(process.env.NOZELI_INSTALLED_ROLE_AUDIT==='1'){
      await settledConversation();
      await capture(palette+'-'+theme+'-'+size+'-'+width+'-role-history',chat);
      const summary=await chat.page.$('.session-worker>details>summary');
      if(summary){await summary.click();await capture(palette+'-'+theme+'-'+size+'-'+width+'-worker-expanded',chat);await summary.click();await summary.dispose();}
      const scroll=await chat.page.$eval('#conversation',n=>n.getBoundingClientRect().toJSON());await chat.page.mouse.move(scroll.x+scroll.width/2,scroll.y+scroll.height/2);await chat.page.mouse.wheel({deltaY:-100000});await settledConversation();await capture(palette+'-'+theme+'-'+size+'-'+width+'-role-history-start',chat);
      if(process.env.NOZELI_ROLE_CAPTURE_ONLY==='1')continue;
    }
    for(const key of ['changes','same']) {
      const file=files.find(f=>f.path===paths[key]); assert(file);
      await prepareEntry(file);
      const beforeState=await retained(); assert(beforeState.chat.ids.length>0,'Real message IDs measured');
      const diff=await openFile(file);
      const read=await call(diff.page,'managed.changes.read',{projectId:fixture.a.id,changeSetId:binding.changeSetId,fileId:file.fileId});
      if(key==='changes'){assert.equal(read.before.text,before);assert.equal(read.after.text,after);await diff.page.waitForSelector('.cm-mergeView',{visible:true});
        const count=()=>diff.page.$eval('.diff-navigation span',n=>n.textContent);
        const first=await count(); await diff.page.click('[aria-label="下一处差异"]');const next=await count();assert.notEqual(next,first);await diff.page.click('[aria-label="上一处差异"]');assert.notEqual(await count(),next);
      }else{assert.equal(await diff.page.$eval('.diff-navigation span',n=>n.textContent),'内容相同');assert.match(await diff.page.$eval('.frozen-change-mode',n=>n.textContent),/100644 → 100755/);}
      // Keyboard disclosure, not hover/title access.
      await diff.page.focus('.frozen-change-path summary'); await diff.page.keyboard.press('Enter');
      assert.equal(await diff.page.$eval('.frozen-change-path',n=>n.open),true); assert.equal(await diff.page.$eval('.frozen-change-path p',n=>n.textContent),file.path);
      await diff.page.keyboard.press('Enter');
      const data=await capture(palette+'-'+theme+'-'+size+'-'+width+'-'+key,diff);
      if(width===450)assert(data.bodyWidth>=320&&data.bodyWidth<=400,'Actual Diff width must be approximately 350, not root window width: '+data.bodyWidth);
      for(const b of data.buttons)assert.equal(parseFloat(b.font),size); for(const v of [...data.versions,...data.counts])assert.equal(parseFloat(v.font),Math.max(12,size-1));
      await closeDiff(diff,beforeState);
    }
  }
  if(process.env.NOZELI_ROLE_CAPTURE_ONLY!=='1'){
  await appearance('dark',20,450);
  const unreadable=files.find(f=>f.path===paths.unreadable); await prepareEntry(unreadable);
  const retainedBefore=await retained(), failed=await openFile(unreadable);
  assert.match(await failed.page.$eval('.document-diff-body',n=>n.innerText),/UTF-8/); await capture('unreadable-diff',failed); await closeDiff(failed,retainedBefore);
  // Isolated fixture only: make its retained manifest genuinely unavailable.
  // No IPC interception, authored result envelope or live-file substitution.
  const manifest = path.join(fixture.runtimeRoot,'work-changes','sets',binding.changeSetId+'.json');
  const parkedManifest = manifest+'.navigation-smoke';
  await fs.rename(manifest,parkedManifest);
  let manifestRestored=false;
  try {
    await prepareEntry(unreadable);
    const stateBeforeFailure = await retained(), readFailure = await openFile(unreadable);
    await readFailure.page.click('.document-diff-body details summary');assert((await readFailure.page.$eval('.document-diff-body details pre',n=>n.textContent)).trim());
    await capture('archive-read-failure-diff',readFailure);
    // The displayed error remains genuine. Restore the fixture archive before
    // returning so the newly mounted conversation can read its original list.
    await fs.rename(parkedManifest,manifest);manifestRestored=true;
    await closeDiff(readFailure,stateBeforeFailure);
  } finally { if(!manifestRestored)await fs.rename(parkedManifest,manifest); }
  }else report.notCovered=['Visual-only installed role/Worker sampling; no Diff recovery assertion in this run. Original failing recovery report remains authoritative.'];
  assert.deepEqual((await status()).state.jobs.map(j=>j.id),jobs,'No new jobs');
  await cleanupReady(); cleanupReady=null; report.modelRequests=0;
  report.stage='close owned floated document and main window';
  const documentScope=await call(doc.page,'workspace.bootstrap');
  const detached=await scoped(s=>s.role==='detached'&&s.windowId===documentScope.windowId);
  await call(detached.page,'session.requestClose');
  await until(async()=>detached.page.isClosed(),'owned floated fixture window closed');
  await call(shell,'session.requestClose'); assert.deepEqual(await Promise.race([exited,pause(15000).then(()=>null)]),{code:0,signal:null});
  report.ok=true;
} catch(error) {report.ok=false;report.error=error.stack; if(out)await shell?.screenshot({path:path.join(out,'failure-host.png')}).catch(()=>{});process.exitCode=1;}
finally {
  if(cleanupReady)try{await cleanupReady();}catch(error){report.ok=false;report.errors.push(error.stack);process.exitCode=1;}
  await browser?.disconnect(); if(child?.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await Promise.race([exited,pause(5000)]);if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await exited;}}
  if(out){await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify({ok:report.ok,out,error:report.error}));}
  await fs.rmdir(lock);
}
