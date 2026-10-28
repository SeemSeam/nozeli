import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import net from 'node:net';import{spawn}from'node:child_process';import{createRequire}from'node:module';import assert from'node:assert/strict';import puppeteer from'puppeteer-core';
import{DesktopHost}from'../src/main/host.mjs';import{Controller}from'../src/agents/managed/controller.mjs';import{managedRuntime}from'../src/agents/managed/managed-storage.mjs';import{staticReport}from'./static-report.fixture.mjs';
const app=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-legacy-closure-ui-')),config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),project=path.join(out,'project');
const release=process.argv[2]?path.resolve(process.argv[2]):null;
await fs.mkdir(project);await fs.writeFile(path.join(project,'README.md'),'Original README\n');
const host=new DesktopHost(profile),projectId=(await host.pick(project)).project.id;
const c=await Controller.open({storage:host.storage,projectId,runtimeRoot:await managedRuntime(host.storage,projectId),contentRoot:project});
const submitted=await c.store.submit('Light README edit; no automatic commit','Keep original user scope',{name:'Legacy README'}),workId=submitted.id;
await c.store.activate(workId);await c.execution.prepare(workId);await fs.writeFile(path.join(c.execution.directory(workId),'README.md'),'Reviewed README candidate\n');
await c.execution.publish(c.store.find(workId),{id:'worker-completed'},()=>true);
await c.store.publish(workId,1,'result',staticReport('Candidate README for review'),'fixture-report',{jobId:'worker-completed',files:[{relPath:'README.md'}]});
await c.store.settle(workId);await c.store.mutate(()=>{c.store.state.jobs.push({id:'worker-completed',target:workId,revision:1,status:'completed',type:'initial'});c.store.find(workId).inputs=[{text:'No commit during execution',userAction:'no-commit'}];});
await c.endWork(workId,{revision:1,decision:'accept'});
const objectId=c.store.find(workId).result.objectId;
await c.store.mutate(()=>{const w=c.store.find(workId);delete w.closure.merge;delete w.closure.mergeAuthorization;delete w.closure.reviewedVersion;delete w.mergeConstraint;w.inputs=[];w.closure.phase='blocked';w.closure.error='此工作明确要求不提交Git；请先明确更新这一约束，再选择接受';c.store.state.mergeQueue=[];});
await c.stop();await host.storage.db.close();
let child,browser,shell,exit,log='';const report={out,ok:false,checks:[],errors:[],scope:'Actual Electron + real host IPC + real Git legacy closure recovery, no native Agent/provider startup or mock managed operations'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await pause(75);}throw Error('Timed out '+label);}
async function call(op,p={}){const r=await shell.evaluate(({op,p})=>nozeli.invoke(op,p),{op,p});assert(r.ok,op+': '+JSON.stringify(r.error));return r.value;}
const state=async()=>(await call('managed.status',{projectId})).state;
try{
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const env={...process.env};for(const k of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(k))delete env[k];
 Object.assign(env,{NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
 child=spawn(release?path.join(release,'nozeli'):createRequire(import.meta.url)('electron'),[...(release?[]:[path.join(app,'src/main/main.cjs')]),'--ozone-platform=wayland'],{cwd:project,env,stdio:['ignore','pipe','pipe']});exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));for(const s of[child.stdout,child.stderr])s.on('data',b=>log+=b);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'shell');shell.on('pageerror',error=>report.errors.push(error.message));
 if(await shell.$eval('#configuration-setup',n=>n.open))await shell.click('#configuration-cancel');
 await shell.click('[data-project-id="'+projectId+'"]');await shell.waitForFunction(id=>window.__workspaceScope?.projectId===id,{},projectId);
 await call('managed.review.read',{projectId,workId,objectId});
 await call('managed.status',{projectId});
 const before=await state(),todo=before.todos.find(t=>t.workId===workId&&t.kind==='merge-constraint'&&t.status==='open');assert(todo);
 assert.equal((await call('managed.status',{projectId})).ready,false,'cold policy must not need active Agents');
 await shell.evaluate(id=>window.__workspaceOpenTodo(id),todo.id);
 const page=await until(async()=>{for(const p of await browser.pages())if(await p.$('[data-merge-constraint-gate="'+workId+'"] [data-merge-choice="hold"]:not([disabled])').catch(()=>null))return p;},'usable policy card without Agent');
 await page.screenshot({path:path.join(out,'policy-before.png')});
 assert.equal(await fs.readFile(path.join(project,'README.md'),'utf8'),'Original README\n');
 await page.click('[data-merge-constraint-gate="'+workId+'"] [data-merge-choice="hold"]');
 const final=await until(async()=>{const s=await state(),w=s.works.find(w=>w.id===workId);return w.closure.phase==='complete'?s:null;},'actual policy receipt and original closure');
 await page.waitForFunction(id=>!document.querySelector('[data-merge-constraint-gate="'+id+'"]'),{},workId);
 assert.equal(await fs.readFile(path.join(project,'README.md'),'utf8'),'Reviewed README candidate\n');
 assert.deepEqual(final.jobs.map(j=>j.id),before.jobs.map(j=>j.id));assert.equal(Object.keys(final.providers??{}).length,0);assert.equal(final.works.find(w=>w.id===workId).outcome,'accept');
 report.checks.push('legacy error-only record migrates to a visible user policy without model startup','cold-local policy button invokes actual version-bound host endpoint','user decision completes exact original accepted candidate through real Git','original jobs and outcome retained; no Worker or provider replay');
 assert.deepEqual(report.errors,[]);await fs.writeFile(path.join(out,'final-state.json'),JSON.stringify(final,null,2));const windows=new Set();for(const p of await browser.pages()){if(p===shell)continue;const scope=await p.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope?.windowId&&!windows.has(scope.windowId)){windows.add(scope.windowId);await p.evaluate(()=>nozeli.invoke('session.requestClose')).catch(()=>{});}}await call('session.requestClose').catch(()=>{});report.exit=await Promise.race([exit,pause(30000).then(()=>null)]);assert.deepEqual(report.exit,{code:0,signal:null});report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;if(browser)report.remainingWindows=await Promise.all((await browser.pages()).map(p=>p.evaluate(()=>({url:location.href,scope:window.__workspaceScope,dialogs:[...document.querySelectorAll('dialog[open]')].map(n=>({id:n.id,text:n.innerText})),text:document.body.innerText.slice(-1800)})).catch(()=>null)));if(shell)await fs.writeFile(path.join(out,'failure-state.json'),JSON.stringify(await state().catch(()=>null),null,2));}
finally{if(child?.exitCode===null){await Promise.race([call('session.requestClose').catch(()=>{}),pause(2000)]);await Promise.race([exit,pause(8000)]);if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exit,pause(3000)]);}}await browser?.disconnect().catch(()=>{});await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
