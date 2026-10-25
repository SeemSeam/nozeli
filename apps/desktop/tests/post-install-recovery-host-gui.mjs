import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import puppeteer from 'puppeteer-core';

// Real Electron -> unchanged IPC/Host/ManagedProjects/Controller/GitService.
// Only provider transport/bootstrap is injected into a separately copied app.
const source=path.resolve(import.meta.dirname,'..');
const output=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-recovery-host-gui-'));
const app=path.join(output,'app'),profile=path.join(output,'profile'),project=path.join(output,'project');
const report={request:'job_45b954e614a5',kind:'real-host-git-electron-model-transport-only',output,checks:[],errors:[],launches:[],unmeasured:['pending main-process crash/restart','explicit IPC exception injection without renderer reload','Windows/macOS','real model semantics']};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const git=(...args)=>execFileSync('git',args,{cwd:project,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},encoding:'utf8',timeout:15000}).trim();
const unownedIndex=()=>git('ls-files','--stage').split('\n').filter(row=>!row.endsWith('\tGIT-A.txt'));
await fs.mkdir(app);await fs.mkdir(project);await fs.mkdir(path.join(output,'empty-provider-source'));
for(const entry of ['src','tools','package.json'])await fs.cp(path.join(source,entry),path.join(app,entry),{recursive:true});
for(const entry of ['node_modules','vendor','assets'])await fs.symlink(path.join(source,entry),path.join(app,entry),'dir');
const sourceHashes={};
async function manifest(dir,prefix=''){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const rel=path.join(prefix,entry.name);if(entry.isDirectory())await manifest(path.join(dir,entry.name),rel);else if(entry.isFile())sourceHashes[rel]=hash(await fs.readFile(path.join(dir,entry.name)));}}
await manifest(path.join(app,'src'),'src');await manifest(path.join(app,'tools'),'tools');sourceHashes['package.json']=hash(await fs.readFile(path.join(app,'package.json')));
await fs.writeFile(path.join(output,'source-hashes.json'),JSON.stringify(sourceHashes,null,2));
const transport=path.join(app,'transport-fixture.mjs');await fs.copyFile(path.join(source,'tests/post-install-recovery-transport.fixture.mjs'),transport);await fs.chmod(transport,0o755);
await fs.copyFile(path.join(source,'tests/static-report.fixture.mjs'),path.join(app,'static-report.fixture.mjs'));
await fs.mkdir(path.join(app,'bin'));await fs.symlink('../transport-fixture.mjs',path.join(app,'bin','codex'));
const mainPath=path.join(app,'src/main/main.cjs'),originalMain=await fs.readFile(mainPath,'utf8');
const anchor='managedAgents=new ManagedProjects({userDataDir:app.getPath(\'userData\'),host,legacy:agents,beforeDocumentOperation:syncDocument});';
assert(originalMain.includes(anchor),'production injection anchor changed');
await fs.writeFile(mainPath,originalMain.replace(anchor,"const {openTransportController}=await import('../../transport-fixture.mjs');\n  managedAgents=new ManagedProjects({userDataDir:app.getPath('userData'),host,legacy:agents,beforeDocumentOperation:syncDocument,openController:openTransportController,sourceHome:process.env.NOZELI_CODEX_SOURCE_HOME});"));
await fs.writeFile(path.join(output,'transport-injection.json'),JSON.stringify({originalMainHash:hash(Buffer.from(originalMain)),injectedMainHash:hash(await fs.readFile(mainPath)),transportHash:hash(await fs.readFile(transport)),injection:'ManagedProjects.openController dependency: model transport and empty private-home bootstrap only; preserve all execution/Git/Host options'},null,2));
for(const name of ['GIT-A','GIT-B','FAIL-C','GIT-D','user'])await fs.writeFile(path.join(project,name+'.txt'),'baseline\n');
git('init','-q');git('config','user.name','Recovery GUI fixture');git('config','user.email','fixture@example.invalid');git('add','.');git('commit','-qm','baseline');
await fs.writeFile(path.join(project,'user.txt'),'USER_PREEXISTING_STAGE\n');git('add','user.txt');
const hook=path.join(project,'.git/hooks/pre-commit');
const rejectHook=()=>fs.writeFile(hook,'#!/bin/sh\necho RECOVERY_GUI_HOOK_DENIED >&2\nexit 7\n',{mode:0o755});
await rejectHook();
const build=spawn(process.execPath,[path.join(app,'tools/build-renderer.mjs')],{cwd:app,stdio:['ignore','pipe','pipe']});let buildLog='';for(const stream of [build.stdout,build.stderr])stream.on('data',b=>buildLog+=b);const buildExit=await new Promise(r=>build.once('exit',r));await fs.writeFile(path.join(output,'build.log'),buildLog);assert.equal(buildExit,0,'copied renderer build failed');
let child,browser,page,exited,projectId,runtime,launchIndex=0;
const invoke=async(op,payload={})=>page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});
async function must(op,payload={}){const r=await invoke(op,payload);if(!r.ok)throw Error(op+': '+r.error.message);return r.value;}
async function status(){return (await must('managed.status',{projectId})).state;}
async function settled(predicate){const deadline=Date.now()+45000;let s;while(Date.now()<deadline){s=await status();if(predicate(s)&&!s.busyTargets.length&&!s.jobs.some(j=>['queued','running','transferring'].includes(j.status)))return s;await pause(100);}throw Error('Host queue timeout '+JSON.stringify(s));}
async function launch(){
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));});});
 const index=++launchIndex,record={index,port,profile};report.launches.push(record);
 const ozone=process.env.NOZELI_OZONE||'wayland';
 child=spawn(createRequire(import.meta.url)('electron'),['--ozone-platform='+ozone,path.join(app,'src/main/main.cjs')],{cwd:app,env:{...process.env,PATH:path.join(app,'bin')+path.delimiter+process.env.PATH,NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_AGENT_FIXTURE:'1',NOZELI_CODEX_SOURCE_HOME:path.join(output,'empty-provider-source'),NOZELI_HIDDEN:ozone==='headless'?'1':'0',NOZELI_OZONE:ozone},stdio:['ignore','pipe','pipe']});
 record.pid=child.pid;let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);
 exited=new Promise(resolve=>child.once('exit',(code,signal)=>{record.exit={code,signal};void fs.writeFile(path.join(output,'electron-'+index+'.log'),log);resolve(record.exit);}));
 const deadline=Date.now()+25000;for(;;){if(child.exitCode!==null||child.signalCode)throw Error(log);try{if((await fetch('http://127.0.0.1:'+port+'/json/version')).ok)break;}catch{}if(Date.now()>deadline)throw Error('Electron start timeout '+log);await pause(100);}
 browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});page=(await browser.pages()).find(p=>p.url().includes('127.0.0.1'));assert(page);page.on('pageerror',e=>report.errors.push(e.stack));await page.waitForFunction(()=>window.__nozeliReady);await page.setViewport({width:1440,height:900});
}
async function close(){if(!child||child.exitCode!==null||child.signalCode)return;assert((await invoke('session.requestClose')).ok);const result=await Promise.race([exited,pause(15000).then(()=>null)]);assert.deepEqual(result,{code:0,signal:null},'owned Electron must close normally');await browser.disconnect();browser=null;page=null;}
async function writeSnapshot(label){
 const dir=path.join(output,label);await fs.mkdir(dir);const s=await status();
 await page.waitForFunction(count=>Number(document.querySelector('#work-count').textContent)===count,{},s.quotaUsed);
 const dom=await page.evaluate(()=>({target:document.querySelector('#conversation-panel').dataset.managedConversation,composerDisabled:document.querySelector('#composer').disabled,composer:document.querySelector('#composer').value,quota:Number(document.querySelector('#work-count').textContent),status:document.querySelector('#compose-status').textContent,report:document.querySelector('#managed-doc').textContent,error:document.querySelector('#managed-review-error')?.textContent||null}));
 assert.equal(dom.quota,s.quotaUsed);await fs.writeFile(path.join(dir,'dom.json'),JSON.stringify(dom,null,2));
 await fs.writeFile(path.join(dir,'state.json'),JSON.stringify(s,null,2));await fs.copyFile(path.join(runtime,'state.json'),path.join(dir,'durable-state.json'));await fs.copyFile(path.join(project,'.git/index'),path.join(dir,'index.bin'));await fs.writeFile(path.join(dir,'git.txt'),git('log','--format=fuller','--stat')+'\n'+git('status','--porcelain=v1'));await page.screenshot({path:path.join(dir,'gui.png')});return s;
}
async function sidebar(){if(await page.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')!=='true'))await page.click('#toggle-sidebar');}
async function openTodo(todo){await sidebar();await page.click('#inbox-reports [data-managed-todo="'+todo.id+'"]');await page.waitForSelector('#managed-result-actions');await page.waitForFunction(text=>document.querySelector('#managed-doc').textContent.includes(text),{},todo.text.slice(0,20));}
async function draft(text){await page.$eval('#composer',(n,text)=>{n.value=text;n.dispatchEvent(new Event('input',{bubbles:true}));},text);}
async function submit(name){await draft(name);await page.click('#managed-submit-task');const s=await settled(s=>s.works.some(w=>w.name===name&&['review','paused'].includes(w.status)));return s.works.find(w=>w.name===name);}
const todo=(s,w,kind)=>s.todos.findLast(t=>t.workId===w.id&&t.kind===kind&&t.status==='open');
const check=(name,data={})=>{report.checks.push({name,...data});console.log('PASS '+name);};
try{
 await launch();await page.click('#pick-project');await page.waitForFunction(()=>document.querySelector('#project-name').textContent==='project');await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-close').click(); });projectId=(await must('project.recent')).projects[0].id;
 const enabled=await must('managed.enable',{projectId});runtime=enabled.runtimeRoot;await must('managed.limit',{projectId,limit:4});await page.reload();await page.waitForFunction(()=>window.__nozeliReady&&document.body.dataset.managedAgents==='true');
 const a=await submit('GIT-A'),b=await submit('GIT-B'),c=await submit('FAIL-C');let s=await status(),ta=todo(s,a,'git'),tb=todo(s,b,'git'),tc=todo(s,c,'recovery');assert(ta&&tb&&tc,'production events must create three real todos');assert.equal(git('rev-list','--count','HEAD'),'1');assert.equal(await fs.readFile(path.join(project,'GIT-A.txt'),'utf8'),'GIT-A result from real Host apply\n');
 await writeSnapshot('01-hook-failed');check('production Host tool writes and real rejecting hook create bound Git todos plus failed Worker recovery',{workIds:[a.id,b.id,c.id]});
 await openTodo(ta);assert.equal(await page.$eval('[data-managed-recovery-action]',n=>n.disabled),false);const jobsBefore=s.jobs.length,indexBefore=unownedIndex(),otherBefore=structuredClone(s.todos.filter(t=>t.workId!==a.id));await fs.writeFile(hook,'#!/bin/sh\nsleep 4\nexit 0\n',{mode:0o755});await page.click('[data-managed-recovery-action]');
 const pendingState=await settled(s=>s.todoActions?.some(r=>!r.result&&r.identity.includes(ta.id))),pending=pendingState.todoActions.find(r=>!r.result&&r.identity.includes(ta.id));
 await writeSnapshot('01b-real-pending');
 await page.reload();await page.waitForFunction(()=>window.__nozeliReady&&document.body.dataset.managedAgents==='true');await openTodo(ta);
 const reloadedPending=(await status()).todoActions.find(r=>r.identity===pending.identity);assert(reloadedPending&&!reloadedPending.result);assert.equal(reloadedPending.requestKey,pending.requestKey);
 await fs.writeFile(path.join(output,'pending-reload-proof.json'),JSON.stringify({before:pending,afterReload:reloadedPending},null,2));await page.click('[data-managed-recovery-action]');
 s=await settled(s=>s.todos.find(t=>t.id===ta.id)?.status==='resolved');const resolved=s.todos.find(t=>t.id===ta.id),oid=git('rev-parse','HEAD');assert.equal(resolved.resolution.git.commit,oid);assert.equal(git('show','HEAD:GIT-A.txt'),'GIT-A result from real Host apply');assert.equal(git('show','HEAD:GIT-B.txt'),'baseline');assert.equal(git('show','HEAD:user.txt'),'baseline');assert.equal(git('show',':user.txt'),'USER_PREEXISTING_STAGE');assert.equal(git('rev-list','--count','HEAD'),'2');assert.equal(s.jobs.length,jobsBefore);assert.equal(s.quotaUsed,3);assert.deepEqual(s.todos.filter(t=>t.workId!==a.id),otherBefore);assert.deepEqual(unownedIndex(),indexBefore);await page.waitForFunction(oid=>document.querySelector('#managed-recovery-receipt').textContent.includes(oid),{},oid);
 assert.equal(await page.$eval('#managed-doc',n=>n.firstElementChild.id),'managed-recovery-receipt');assert.equal(await page.$eval('#managed-original-issue',n=>n.open),false);await page.click('#managed-original-issue > summary');assert.match(await page.$eval('#managed-original-issue',n=>n.textContent),/RECOVERY_GUI_HOOK_DENIED/);assert.equal(s.todos.find(t=>t.id===ta.id).text,ta.text);await writeSnapshot('02-git-success');check('GUI Git retry uses actual OID, preserves unrelated user staging and resolves only target todo without jobs or quota release',{oid,requestKey:resolved.resolution.requestKey});
 assert.equal(resolved.resolution.requestKey,pending.requestKey);assert.equal(s.todoActions.filter(r=>r.identity===pending.identity).length,1);check('real pending Git survives lost renderer context; reloaded GUI reuses Host key and publishes only one commit',{requestKey:pending.requestKey});await fs.unlink(hook);
 // Same actual request through production IPC proves durable idempotency; no fabricated result.
 const p=resolved.resolution;const again=await must('managed.git.retry',{projectId,todoId:p.todoId,workId:p.workId,revision:p.revision,sourceJob:p.sourceJob,requestKey:p.requestKey});assert.deepEqual(again,p);assert.equal(git('rev-list','--count','HEAD'),'2');check('same completed production request key returns original receipt without double commit');
 await openTodo(tc);await page.$$eval('#managed-result-actions button',ns=>ns.find(n=>n.textContent==='查看原工作，核对后显式补充').click());await page.waitForFunction(id=>document.querySelector('#conversation-panel').dataset.managedConversation===id&&!document.querySelector('#composer').disabled,{},c.id);await draft('RECOVERY_GUI_UNSENT_DRAFT');await settled(s=>s.drafts[c.id]==='RECOVERY_GUI_UNSENT_DRAFT');await openTodo(tc);assert.equal(await page.$eval('[data-managed-recovery-action]',n=>n.disabled),true);await writeSnapshot('03-draft-gate');await page.$$eval('#managed-result-actions button',ns=>ns.find(n=>n.textContent==='查看原工作，核对后显式补充').click());assert.equal(await page.$eval('#composer',n=>n.value),'RECOVERY_GUI_UNSENT_DRAFT');await draft('');await settled(s=>!s.drafts[c.id]);await openTodo(tc);s=await status();const recoveryJobs=s.jobs.length,thread=s.works.find(w=>w.id===c.id).threadId;await page.click('[data-managed-recovery-action]');s=await settled(s=>s.todos.find(t=>t.id===tc.id)?.status==='resolved');assert.equal(s.works.find(w=>w.id===c.id).threadId,thread);assert.equal(s.jobs.length,recoveryJobs);assert.equal(s.quotaUsed,3);assert.equal(s.todos.find(t=>t.id===tb.id).status,'open');assert.equal(s.todos.find(t=>t.id===tc.id).resolution.automaticReplay,false);await page.waitForFunction(id=>document.querySelector('#conversation-panel').dataset.managedConversation===id&&!document.querySelector('#composer').disabled,{},c.id);assert.match(await page.$eval('#compose-status',n=>n.textContent),/未重放原执行/);await writeSnapshot('04-worker-inspection');check('original Worker draft persists and gates recovery; explicit recovery returns same thread with no new input job',{thread,jobCount:recoveryJobs});
 // Return to frontdesk through normal toolbar, not by replacing renderer state.
 await page.$$eval('#managed-todo-context button',ns=>ns.find(n=>n.textContent==='回到前台讨论')?.click());
 // Inspection clears the toolbar. Closing the displayed managed document emits the normal content-closed event.
 await page.click('#close-subject');
 await page.waitForSelector('#action-confirmation[open]');await page.click('#action-confirmation-accept');
 await page.waitForFunction(()=>document.querySelector('#conversation-panel').dataset.managedConversation==='frontdesk'&&!document.querySelector('#composer').disabled);
 await rejectHook();const d=await submit('GIT-D');s=await status();const td=todo(s,d,'git');assert(td);await fs.unlink(hook);await fs.writeFile(path.join(project,'user.txt'),'USER_EXTERNAL_STAGED_BYTES\n');git('add','user.txt');const externalIndex=await fs.readFile(path.join(project,'.git/index')),headBefore=git('rev-parse','HEAD');await openTodo(td);await page.click('[data-managed-recovery-action]');s=await settled(s=>s.todoActions?.some(a=>a.result?.todoId===td.id&&a.result.accepted===false));const denial=s.todoActions.findLast(a=>a.result?.todoId===td.id).result;assert.equal(denial.accepted,false);assert.equal(s.todos.find(t=>t.id===td.id).status,'open');assert.equal(git('rev-parse','HEAD'),headBefore);assert.deepEqual(await fs.readFile(path.join(project,'.git/index')),externalIndex);assert.equal(s.quotaUsed,4);assert.equal(await page.$eval('#composer',n=>n.disabled),true);await page.waitForFunction(()=>document.querySelector('[data-managed-recovery-note]')?.textContent.length>0);assert((await page.$eval('[data-managed-recovery-note]',n=>n.textContent)).includes(denial.error.message));assert.equal(await page.$eval('#managed-doc',(n,message)=>n.textContent.split(message).length-1,denial.error.message),1);await writeSnapshot('05-external-index-refusal');check('external index change returns real accepted:false in GUI and preserves todo, HEAD, index and quota',{code:denial.error.code,message:denial.error.message});
 await close();await launch();await page.waitForFunction(()=>window.__nozeliReady);await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-close').click(); });await page.waitForFunction(()=>document.body.dataset.managedAgents==='true');s=await settled(s=>s.works.length===4);assert.equal(s.jobs.length,recoveryJobs+3);assert.equal(s.todos.find(t=>t.id===tc.id).resolution.threadId,thread);assert.equal(s.todos.find(t=>t.id===td.id).status,'open');assert.equal(git('rev-parse','HEAD'),headBefore);assert.deepEqual(await fs.readFile(path.join(project,'.git/index')),externalIndex);assert.deepEqual(await must('managed.git.retry',{projectId,todoId:p.todoId,workId:p.workId,revision:p.revision,sourceJob:p.sourceJob,requestKey:p.requestKey}),p);assert.equal(git('rev-list','--count','HEAD'),'2');await writeSnapshot('06-restart-preserved');check('normal application restart preserves real resolutions/refusal, original thread and durable idempotency without replay');
 assert.deepEqual(report.errors,[]);report.status='PASS';
}catch(error){report.status='FAIL';report.failure=error.stack;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});if(runtime){await fs.copyFile(path.join(runtime,'state.json'),path.join(output,'failure-state.json')).catch(()=>{});}throw error;
}finally{
 try{await close();}catch(error){report.closeFailure=error.stack;if(child?.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await Promise.race([exited,pause(5000)]);if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await exited;}}await browser?.disconnect();}
 const owned=[],auth=[];for(const entry of await fs.readdir('/proc'))if(/^\d+$/.test(entry)){try{const cmd=(await fs.readFile('/proc/'+entry+'/cmdline','utf8')).replaceAll('\0',' ');if(cmd.includes(app))owned.push({pid:Number(entry),command:cmd});}catch{}}
 async function scanAuth(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const p=path.join(dir,entry.name);if(entry.isDirectory())await scanAuth(p);else if(entry.name==='auth.json')auth.push(p);}}
 await scanAuth(profile).catch(()=>{});report.audit={ownedProcesses:owned,authFiles:auth};if(owned.length||auth.length||report.closeFailure)report.status='FAIL';await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,output,checks:report.checks.length,audit:report.audit}));if(report.status!=='PASS')process.exitCode=1;
}
