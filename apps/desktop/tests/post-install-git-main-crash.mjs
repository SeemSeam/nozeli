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
const output=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-git-main-crash-'));
const app=path.join(output,'app'),profile=path.join(output,'profile'),project=path.join(output,'project');
const report={request:'job_fbbb2b4b9884',kind:'real-host-git-electron-model-transport-only',output,checks:[],errors:[],launches:[],unmeasured:['Windows/macOS','real Provider/model semantics','power loss/fsync guarantees']};
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
const transport=path.join(app,'transport-fixture.mjs');await fs.copyFile(path.join(source,'tests/post-install-git-main-crash-transport.fixture.mjs'),transport);await fs.chmod(transport,0o755);
await fs.mkdir(path.join(app,'bin'));await fs.symlink('../transport-fixture.mjs',path.join(app,'bin','codex'));
const mainPath=path.join(app,'src/main/main.cjs'),originalMain=await fs.readFile(mainPath,'utf8');
const anchor='managedAgents=new ManagedProjects({userDataDir:app.getPath(\'userData\'),host,legacy:agents,beforeDocumentOperation:syncDocument});';
assert(originalMain.includes(anchor),'production injection anchor changed');
let injected=originalMain.replace(anchor,"await fs.writeFile(process.env.NOZELI_FAULT_ROOT+'/main-identity-'+process.pid+'.json',JSON.stringify({pid:process.pid,argv:process.argv,profile:app.getPath('userData'),cwd:process.cwd(),exe:process.execPath,sourceHome:process.env.NOZELI_CODEX_SOURCE_HOME}));\nconst {openTransportController}=await import('../../transport-fixture.mjs');\n  managedAgents=new ManagedProjects({userDataDir:app.getPath('userData'),host,legacy:agents,beforeDocumentOperation:syncDocument,openController:openTransportController,sourceHome:process.env.NOZELI_CODEX_SOURCE_HOME});");
const dispatch="if (typeof op==='string' && op.startsWith('managed.')) return {ok:true,value:await managedAgents.invoke(op,payload??{})};";
assert(injected.includes(dispatch));
injected=injected.replace(dispatch,"if (typeof op==='string' && op.startsWith('managed.')) { const value=await managedAgents.invoke(op,payload??{}); const {afterInvoke}=await import('../../fault-fixture.mjs'); await afterInvoke(op,payload,value); return {ok:true,value}; }");
await fs.copyFile(path.join(source,'tests/post-install-git-main-crash-fault.fixture.mjs'),path.join(app,'fault-fixture.mjs'));
await fs.writeFile(mainPath,injected);
await fs.writeFile(path.join(output,'transport-injection.json'),JSON.stringify({originalMainHash:hash(Buffer.from(originalMain)),injectedMainHash:hash(await fs.readFile(mainPath)),transportHash:hash(await fs.readFile(transport)),faultHash:hash(await fs.readFile(path.join(app,'fault-fixture.mjs'))),injection:'Private copy only: model transport/empty-home bootstrap; actual main identity recorder; fault after production managed invocation resolves, before IPC return; no business value/state changes'},null,2));
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
 child=spawn(createRequire(import.meta.url)('electron'),['--ozone-platform='+ozone,path.join(app,'src/main/main.cjs')],{cwd:app,env:{...process.env,PATH:path.join(app,'bin')+path.delimiter+process.env.PATH,NOZELI_FAULT_ROOT:output,NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_AGENT_FIXTURE:'1',NOZELI_CODEX_SOURCE_HOME:path.join(output,'empty-provider-source'),NOZELI_HIDDEN:ozone==='headless'?'1':'0',NOZELI_OZONE:ozone},stdio:['ignore','pipe','pipe']});
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

async function stamp(pid){
 const root='/proc/'+pid,stat=await fs.readFile(root+'/stat','utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
 const env=(await fs.readFile(root+'/environ','utf8')).split('\0');
 return {pid:Number(pid),ppid:Number(fields[1]),start:fields[19],exe:await fs.readlink(root+'/exe'),cwd:await fs.readlink(root+'/cwd'),cmd:(await fs.readFile(root+'/cmdline','utf8')).split('\0'),profile:env.find(x=>x.startsWith('NOZELI_USER_DATA=')),sourceHome:env.find(x=>x.startsWith('NOZELI_CODEX_SOURCE_HOME='))};
}
async function ownedTree(){
 const all=[];for(const n of await fs.readdir('/proc'))if(/^\d+$/.test(n))try{all.push(await stamp(n));}catch{}
 const main=all.find(x=>x.pid===child.pid);assert(main);assert.equal(main.ppid,process.pid);assert.equal(main.cwd,app);const actual=JSON.parse(await fs.readFile(path.join(output,'main-identity-'+main.pid+'.json'),'utf8'));assert.equal(actual.pid,main.pid);assert.equal(actual.profile,profile);assert.equal(actual.sourceHome,path.join(output,'empty-provider-source'));main.actual=actual;assert(actual.argv.includes(path.join(app,'src/main/main.cjs')));assert.equal(main.exe,await fs.realpath(createRequire(import.meta.url)('electron')));
 const ids=new Set([main.pid]);let changed=true;while(changed){changed=false;for(const x of all)if(ids.has(x.ppid)&&!ids.has(x.pid)){ids.add(x.pid);changed=true;}}
 const parent=[];let id=main.ppid;while(id){const x=all.find(x=>x.pid===id);if(!x)break;parent.push(x);id=x.ppid;}
 return {main,parent,children:all.filter(x=>ids.has(x.pid)&&x.pid!==main.pid)};
}
async function killExact(s,signal){let now;try{now=await stamp(s.pid);}catch{await event('owned-process-already-gone',{pid:s.pid,start:s.start});return;}assert.equal(now.start,s.start);assert.equal(now.exe,s.exe);assert.equal(now.cwd,s.cwd);assert.deepEqual(now.cmd,s.cmd);await event('owned-process-signal',{stamp:now,signal});try{process.kill(s.pid,signal);}catch(error){if(error.code!=='ESRCH')throw error;}}
async function event(event,data={}){await fs.appendFile(path.join(output,'fault-timeline.jsonl'),JSON.stringify({at:new Date().toISOString(),event,...data})+'\n');}
async function disk(){return JSON.parse(await fs.readFile(path.join(runtime,'state.json'),'utf8'));}
async function waitFile(file){for(let n=0;n<300;n++){try{return await fs.readFile(file,'utf8');}catch{}await pause(100);}throw Error('missing fault marker '+file);}
async function reconnect(){await launch();await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-toggle').click(); });await page.waitForFunction(()=>document.body.dataset.managedAgents==='true');await must('managed.connect',{projectId});}
let crashedTree;
try{
 assert.deepEqual(await fs.readdir(path.join(output,'empty-provider-source')),[]);
 await launch();report.startup=await ownedTree();await page.click('#pick-project');await page.waitForFunction(()=>document.querySelector('#project-name').textContent==='project');await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-toggle').click(); });projectId=(await must('project.recent')).projects[0].id;
 runtime=(await must('managed.enable',{projectId})).runtimeRoot;await must('managed.limit',{projectId,limit:4});await page.reload();await page.waitForFunction(()=>window.__nozeliReady&&document.body.dataset.managedAgents==='true');
 const a=await submit('GIT-A'),b=await submit('GIT-B'),c=await submit('FAIL-C');let s=await status();const ta=todo(s,a,'git'),tb=todo(s,b,'git');assert(ta&&tb&&todo(s,c,'recovery'));await writeSnapshot('01-real-failures');
 const jobs=s.jobs.length,unrelated=s.todos.filter(t=>t.workId!==a.id),works=s.works,staging=unownedIndex(),head=git('rev-parse','HEAD');
 await fs.writeFile(hook,'#!/bin/sh\nprintf "entered %s\\n" "$$" > .git/nozeli-hook-entered\nsleep 120\nexit 0\n',{mode:0o755});
 await openTodo(ta);await page.click('[data-managed-recovery-action]');let marker;
 for(let n=0;n<100&&!marker;n++){for(const dir of await fs.readdir(path.join(runtime,'evidence/git'))){const candidate=path.join(runtime,'evidence/git',dir,'project/.git/nozeli-hook-entered');try{await fs.access(candidate);marker=candidate;break;}catch{}}if(!marker)await pause(100);}assert(marker,'sandbox hook timing marker absent');
 const durable=await disk(),pending=durable.todoActions.find(x=>x.identity.includes(ta.id)&&!x.result);assert(pending);assert.equal(git('rev-parse','HEAD'),head);await writeSnapshot('02-durable-pending');await event('durable-pending-hook-blocked',{pending,head,marker,markerBytes:await fs.readFile(marker,'utf8')});
 crashedTree=await ownedTree();await fs.writeFile(path.join(output,'crash-ownership.json'),JSON.stringify(crashedTree,null,2));assert(crashedTree.children.some(x=>x.exe.endsWith('/git')));
 await event('main-sigkill-issued',{pid:child.pid,start:crashedTree.main.start});await killExact(crashedTree.main,'SIGKILL');assert.deepEqual(await exited,{code:null,signal:'SIGKILL'});await event('main-exited-sigkill');await browser.disconnect();browser=null;page=null;
 for(const x of crashedTree.children.reverse())await killExact(x,'SIGKILL');await pause(300);
 assert.equal(git('rev-parse','HEAD'),head);await fs.writeFile(path.join(output,'post-crash-durable.json'),JSON.stringify(await disk(),null,2));
 await fs.writeFile(hook,'#!/bin/sh\nexit 0\n',{mode:0o755});await reconnect();s=await status();assert.equal(s.jobs.length,jobs);assert.equal(s.quotaUsed,3);assert.deepEqual(s.todos.filter(t=>t.workId!==a.id),unrelated);assert.deepEqual(unownedIndex(),staging);
 const payload={projectId,todoId:ta.id,workId:a.id,revision:ta.revision,sourceJob:ta.sourceJobId,requestKey:pending.requestKey};
 // Identity comes from production pending claim/real todo, never constructed runtime state.
 const identity=JSON.parse(pending.identity);Object.assign(payload,{revision:identity[4],sourceJob:identity[5]});
 const recovery=await invoke('managed.git.retry',payload);report.pendingRecovery={payload,recovery};await fs.writeFile(path.join(output,'pending-recovery-original.json'),JSON.stringify(report.pendingRecovery,null,2));await writeSnapshot('03-explicit-pending-recovery');
 assert.equal(recovery.ok,true);assert.equal(recovery.value.accepted,true);assert.equal(recovery.value.git.commit,git('rev-parse','HEAD'));assert.equal(git('rev-list','--count','HEAD'),'2');assert.deepEqual(await must('managed.git.retry',payload),recovery.value);assert.equal((await status()).jobs.length,jobs);assert.deepEqual(unownedIndex(),staging);s=await status();assert.deepEqual(s.todos.filter(t=>t.workId!==a.id),unrelated);assert.equal(s.quotaUsed,3);assert.deepEqual(s.works,works);
 check('durable pending real main SIGKILL and restart; same key recovers once, protecting unrelated state',{response:recovery});
 // Create D against the NEW HEAD through the ordinary task API; B's older intent is intentionally untouched.
 await rejectHook();await must('managed.task',{projectId,text:'GIT-D',requestKey:randomUUID()});s=await settled(s=>s.works.some(w=>w.name==='GIT-D'&&w.status==='review'));const d=s.works.find(w=>w.name==='GIT-D'),td=todo(s,d,'git');assert(td);const secondJobs=s.jobs.length,secondWorks=s.works,secondOther=s.todos.filter(t=>t.workId!==d.id),secondIndex=git('ls-files','--stage').split('\n').filter(r=>!r.endsWith('\tGIT-D.txt'));
 await fs.writeFile(hook,'#!/bin/sh\nexit 0\n',{mode:0o755});await fs.writeFile(path.join(output,'receipt-fault-arm'),'armed');await openTodo(td);await page.click('[data-managed-recovery-action]');
 await page.waitForFunction(()=>document.querySelector('#managed-review-error')?.textContent.includes('OWNED_POST_COMMIT_IPC_TRANSPORT_FAULT'));const timeline=await fs.readFile(path.join(output,'fault-timeline.jsonl'),'utf8');assert(timeline.includes('production-result-before-ipc-return'));
 s=await settled(s=>s.todos.find(t=>t.id===td.id)?.status==='resolved');const receipt=s.todos.find(t=>t.id===td.id).resolution,oid=git('rev-parse','HEAD');assert.equal(receipt.git.commit,oid);assert.equal(git('rev-list','--count','HEAD'),'3');assert.equal(git('show','HEAD:GIT-D.txt'),'GIT-D result from real Host apply');assert.equal(git('show','HEAD:GIT-B.txt'),'baseline');assert.equal(git('show','HEAD:GIT-A.txt'),'GIT-A result from real Host apply');assert.equal(git('show','HEAD:user.txt'),'baseline');assert.equal(git('show',':user.txt'),'USER_PREEXISTING_STAGE');assert.deepEqual(s.todos.filter(t=>t.workId!==d.id),secondOther);assert.deepEqual(git('ls-files','--stage').split('\n').filter(r=>!r.endsWith('\tGIT-D.txt')),secondIndex);
 await writeSnapshot('04-post-commit-ipc-exception');const beforeRepeat=await fs.readFile(path.join(project,'.git/index'));
 const repeatPayload={projectId,todoId:receipt.todoId,workId:receipt.workId,revision:receipt.revision,sourceJob:receipt.sourceJob,requestKey:receipt.requestKey};assert.deepEqual(await must('managed.git.retry',repeatPayload),receipt);assert.equal(git('rev-list','--count','HEAD'),'3');assert.deepEqual(await fs.readFile(path.join(project,'.git/index')),beforeRepeat);assert.equal((await status()).jobs.length,secondJobs);assert.equal((await status()).quotaUsed,4);
 await close();await reconnect();assert.deepEqual(await must('managed.git.retry',repeatPayload),receipt);assert.deepEqual(await must('managed.git.retry',payload),recovery.value);assert.equal(git('rev-list','--count','HEAD'),'3');assert.deepEqual(await fs.readFile(path.join(project,'.git/index')),beforeRepeat);s=await status();assert.equal(s.jobs.length,secondJobs);assert.equal(s.quotaUsed,4);assert.deepEqual(s.todos.filter(t=>t.workId!==d.id),secondOther);assert.deepEqual(s.works,secondWorks);await writeSnapshot('05-cold-restart-same-key');
 check('real commit before IPC exception; same key before/after cold restart returns real receipt without duplicate commit/jobs',{oid,requestKey:receipt.requestKey});
 report.status='PASS';
}catch(error){report.status='FAIL';report.failure=error.stack;await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});if(runtime)await fs.copyFile(path.join(runtime,'state.json'),path.join(output,'failure-state.json')).catch(()=>{});console.error(error.stack);process.exitCode=1;
}finally{
 try{await close();}catch(error){report.closeFailure=error.stack;try{const tree=await ownedTree();await killExact(tree.main,'SIGKILL');for(const x of tree.children.reverse())await killExact(x,'SIGKILL');}catch(e){report.cleanupFailure=e.stack;}}
 const survivors=[];for(const n of await fs.readdir('/proc'))if(/^\d+$/.test(n))try{const x=await stamp(n);if(x.cwd.startsWith(output)||x.profile==='NOZELI_USER_DATA='+profile||x.cmd.some(v=>v.includes(app)))survivors.push(x);}catch{}
 for(const x of crashedTree?.children||[])try{const now=await stamp(x.pid);if(now.start===x.start)survivors.push(now);}catch{}
 const auth=[];async function scan(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())continue;const p=path.join(dir,e.name);if(e.isDirectory())await scan(p);else if(/^(auth\.json|credentials.*)$/.test(e.name))auth.push(p);}}await scan(profile).catch(()=>{});await scan(path.join(output,'empty-provider-source'));
 report.audit={survivors,auth};if(survivors.length||auth.length||report.cleanupFailure){report.status='FAIL';process.exitCode=1;}await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,output,checks:report.checks.length,audit:report.audit}));
}
