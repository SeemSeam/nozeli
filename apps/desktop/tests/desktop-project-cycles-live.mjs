// Real Electron + bundled OMP + local scripted OpenAI SSE; synthetic directories only.
// Run serially after npm run build:renderer: node tests/desktop-project-cycles-live.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import puppeteer from 'puppeteer-core';
import {processStamp} from '../src/agents/managed/process-ownership.mjs';
import {ProjectStorage} from '../src/main/project-storage.mjs';
const require=createRequire(import.meta.url),app=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-project-cycles-'));
const roots=[];for(let i=0;i<4;i++){const root=path.join(out,'project-'+i);await fs.mkdir(root);await fs.writeFile(path.join(root,'original.txt'),'SOURCE_PRESERVED_'+i+'\n');roots.push(root);}
const report={out,ok:false,checks:[],cycles:[],errors:[],modelRequests:[],qualification:'Linux source Electron, real bundled native OMP processes and tools, synthetic projects, deterministic local model; chooser and confirmation decisions are fixtures, no production admission bypass'};
let round,main,other;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
async function until(fn,label,ms=90000){const start=Date.now();while(Date.now()-start<ms){const result=await fn();if(result)return result;await pause(100);}throw Error('Timed out: '+label);}
const tool=(name,args,id)=>({role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const server=http.createServer((req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{
 try{
  const input=JSON.parse(body),names=(input.tools||[]).map(t=>t.function?.name),controller=names.includes('nozeli_dispatch');
  assert(round,'unexpected model request without active round');const ordinal=++round[controller?'controllerRequests':'workerRequests'];
  let delta,finish='tool_calls';
  if(controller){if(ordinal===1)delta=tool('nozeli_dispatch',{name:round.nonce,brief:'Create '+round.filename+' with exact content '+round.nonce+' and publish the verified file.'},round.nonce+'-dispatch');else{delta={role:'assistant',content:'Dispatched '+round.nonce};finish='stop';}}
  else if(ordinal===1)delta=tool('bash',{command:'printf '+round.nonce+' > '+round.filename+(round.interrupt?' ; sleep 30':' ; cat '+round.filename)},round.nonce+'-write');
  else if(ordinal===2)delta=tool('nozeli_publish',{kind:'result',html:'<!doctype html><html><head><meta charset="utf-8"><title>Verified result</title></head><body><h1>'+round.nonce+'</h1><p>Real native tool created the candidate.</p></body></html>',files:[round.filename]},round.nonce+'-publish');
  else{delta={role:'assistant',content:'Verified '+round.nonce};finish='stop';}
  report.modelRequests.push({nonce:round.nonce,role:controller?'orchestrator':'worker',ordinal,tool:delta.tool_calls?.[0].function.name??null});
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const [part,end] of [[delta,null],[{},finish]])res.write('data: '+JSON.stringify({id:'cycle-'+report.modelRequests.length,object:'chat.completion.chunk',choices:[{index:0,delta:part,finish_reason:end}]})+'\n\n');
  res.end('data: [DONE]\n\n');
 }catch(error){report.errors.push(error.stack);res.destroy(error);}
});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
async function launch(label){
 const config=path.join(out,label,'.Nozeli'),profile=path.join(config,'desktop'),control=path.join(out,label+'-control.json'),launcher=path.join(out,label+'-launcher.cjs');
 await fs.writeFile(control,JSON.stringify({pick:roots[0],confirm:1}));
 await fs.writeFile(launcher,`const fs=require('node:fs'),e=require('electron');const state=()=>JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));e.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[state().pick]});e.dialog.showMessageBox=async(...args)=>{const o=args.at(-1);fs.appendFileSync(${JSON.stringify(path.join(out,label+'-dialogs.jsonl'))},JSON.stringify(o)+'\\n');return {response:o.title==='重新登记已移除的项目'?state().confirm:0};};require(${JSON.stringify(path.join(app,'src/main/main.cjs'))});`);
 const port=await freePort(),env={...process.env};
 for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key))delete env[key];
 delete env.ELECTRON_RUN_AS_NODE;
 Object.assign(env,{HOME:path.join(out,label,'home'),NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
 await fs.mkdir(env.HOME,{recursive:true});
 const child=spawn(require('electron'),[launcher,'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{cwd:app,env,stdio:['ignore','pipe','pipe']});
 const h={label,config,profile,control,child,log:'',exit:new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})))};
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>h.log+=b);
 h.browser=await until(async()=>{if(child.exitCode!==null)throw Error(h.log);try{return await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});}catch{return false;}},label+' CDP');
 h.shell=await until(async()=>{for(const page of await h.browser.pages())if(await page.evaluate(()=>window.__workspaceScope?.role==='shell'&&window.__nozeliReady).catch(()=>false))return page;},label+' shell');
 const watched=new WeakSet(),watch=page=>{if(!watched.has(page)){watched.add(page);page.on('pageerror',error=>report.errors.push(label+': '+error.message));}};
 for(const page of await h.browser.pages())watch(page);h.browser.on('targetcreated',async target=>{const page=await target.page().catch(()=>null);if(page)watch(page);});
 if(await h.shell.$eval('#configuration-setup',node=>node.open))await h.shell.click('#configuration-cancel');
 return h;
}
async function raw(h,op,payload={}){return h.shell.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);}
async function call(h,op,payload={}){const result=await raw(h,op,payload);assert.equal(result.ok,true,op+': '+JSON.stringify(result.error));return result.value;}
async function choose(h,root){await fs.writeFile(h.control,JSON.stringify({pick:root,confirm:1}));const start=Date.now();await h.shell.click('#pick-project');
 const project=await until(async()=>{const p=(await call(h,'project.recent')).projects.find(p=>p.rootDisplay===root);if(!p)return;const scope=await call(h,'workspace.bootstrap');return scope.projectId===p.id&&await h.shell.$eval('#project-name',node=>node.textContent)===p.name?p:null;},'pick and activate '+root);return {project,ms:Date.now()-start};}
async function status(id){return call(main,'managed.status',{projectId:id});}
async function close(h){if(!h||h.child.exitCode!==null)return;await call(h,'session.requestClose');const confirm=await until(async()=>{if(h.child.exitCode!==null)return 'exited';for(const page of await h.browser.pages())if(await page.$eval('#quit-choice',n=>n.open).catch(()=>false))return page;},'normal app close',30000);if(confirm!=='exited')await confirm.click('#quit-cancel');assert.deepEqual(await Promise.race([h.exit,pause(45000).then(()=>null)]),{code:0,signal:null});await h.browser.disconnect();await fs.writeFile(path.join(out,h.label+'-main.log'),h.log);}
async function providerPids(projectId){
 const catalog=new DatabaseSync(path.join(main.profile,'nozeli/storage-v2/catalog.sqlite'),{readOnly:true});let project;
 try{project=JSON.parse(catalog.prepare("SELECT value FROM records WHERE collection='instances' AND id=?").get(projectId).value);}finally{catalog.close();}
 const local=new DatabaseSync(path.join(main.profile,'nozeli/storage-v2/instances',project.instanceId,'ui.sqlite'),{readOnly:true});let providers;
 try{providers=JSON.parse(local.prepare("SELECT value FROM records WHERE collection='ui' AND id='managed:providers'").get().value);}finally{local.close();}
 return Promise.all(Object.entries(providers).map(async([target,owner])=>{assert.equal(await processStamp(owner.pid),owner.stamp,'live native owner '+target);return {target,pid:owner.pid,stamp:owner.stamp};}));
}
async function remove(project,record){
 const owners=await providerPids(project.id);assert(owners.length>=2,'real native resident PIDs are required');if(record.interrupt)assert(owners.some(owner=>owner.target===record.workId),'in-flight native Worker PID is required');const start=Date.now(),requests=report.modelRequests.length;
 if(record.interrupt){const current=(await status(project.id)).state.jobs.filter(job=>job.target===record.workId);assert(current.some(job=>job.status==='running'),'Worker tool must still be running immediately before removal');record.jobsImmediatelyBeforeRemove=current.map(job=>({id:job.id,status:job.status}));}
 const result=await call(main,'project.remove',{projectId:project.id,operationId:'cycle-remove-'+record.nonce});record.removeMs=Date.now()-start;record.removeReceipt=result;
 assert.equal((await call(main,'project.recent')).projects.some(p=>p.id===project.id),false);
 for(const owner of owners)assert.notEqual(await processStamp(owner.pid),owner.stamp,'native owner stopped '+owner.pid);
 // Regenerable native extraction caches only, after confirmed process exit;
 // preserve source, SQLite/history/drafts and evidence. This is test cleanup,
 // not a production lifecycle bypass or a product disk-usage fix.
 const agentRoot=path.dirname(record.worker.configurationStatus.agentDir);
 assert(agentRoot.startsWith(out+path.sep));for(const name of await fs.readdir(agentRoot))await fs.rm(path.join(agentRoot,name,'natives'),{recursive:true,force:true});
 record.stoppedNativeCachesPruned=true;
 record.nativeOwners=owners;record.modelRequestsAtRemove=requests;
 await main.shell.reload({waitUntil:'domcontentloaded'});await main.shell.waitForFunction(()=>window.__nozeliReady);await pause(200);
 assert.equal(report.modelRequests.length,requests,'removal/reload must not replay model jobs');
}
async function execute(project,root,label,{interrupt=false}={}){
 const nonce='CYCLE_'+label,filename=nonce+'.txt';round={nonce,filename,controllerRequests:0,workerRequests:0,interrupt:false};
 const record={nonce,projectId:project.id,root,interrupt};report.cycles.push(record);
 const enabled=Date.now();await call(main,'managed.enable',{projectId:project.id});await until(async()=>(await status(project.id)).ready,'bundled OMP residents ready');record.enableMs=Date.now()-enabled;
 const previous=report.cycles.slice(0,-1).findLast(c=>c.projectId===project.id);if(previous){assert.equal((await status(project.id)).state.drafts.frontdesk,'UNSENT_'+previous.nonce,'ordinary reload preserves the original unsent draft');record.reloadDraftPreserved=true;}
 const liveOwners=await providerPids(project.id);assert(liveOwners.length>=2,'native residents must have persisted process identities');
 await call(main,'managed.draft',{projectId:project.id,target:'frontdesk',text:'UNSENT_'+nonce});
 const start=Date.now();await call(main,'managed.task',{projectId:project.id,text:'Create exact nonce '+nonce+' in '+filename+' and publish the result.',requestKey:'task-'+nonce});
 const work=await until(async()=>{const s=(await status(project.id)).state;const failed=s.jobs?.find(j=>j.status==='failed');if(failed)throw Error(JSON.stringify(failed));const w=s.works.find(w=>w.name===nonce);if(!w?.execution?.directory)return;try{if(await fs.readFile(path.join(w.execution.directory,filename),'utf8')!==nonce)return;}catch{return;}return w.status==='review'?w:null;},'real worker tool and result '+nonce);
 record.workId=work.id;record.executionDirectory=work.execution.directory;record.workMs=Date.now()-start;record.candidateContent=await fs.readFile(path.join(work.execution.directory,filename),'utf8');
 const s=(await status(project.id)).state;assert(s.agents.some(a=>a.target===work.id&&!a.closed),'actual native Worker attached');record.worker=s.agents.find(a=>a.target===work.id);record.jobs=s.jobs.filter(j=>j.target===work.id).map(j=>({id:j.id,status:j.status}));
 await until(async()=>!(await status(project.id)).state.busyTargets.includes(work.id),'Worker turn and host cleanup fully idle before terminal attachment');
 record.terminalAttachment=await call(main,'managed.terminal.attach',{projectId:project.id,target:work.id,ownerId:record.worker.ownerId});
 const screen=await call(main,'managed.terminal.screen',{projectId:project.id,target:work.id});assert.equal(screen.available,true,'real Worker PTY screen is observable');record.terminalScreen={available:screen.available,terminalId:screen.terminalId,version:screen.version,lines:screen.lines};
 if(await main.shell.$eval('#toggle-sidebar',node=>node.getAttribute('aria-expanded')!=='true'))await main.shell.click('#toggle-sidebar');
 await main.shell.screenshot({path:path.join(out,nonce+'-worker.png')});record.screenshot=nonce+'-worker.png';
 if(!interrupt){const disposition=await call(main,'managed.disposition',{projectId:project.id,workId:work.id});assert.equal(disposition.accept.allowed,true);await call(main,'managed.end',{projectId:project.id,workId:work.id,revision:work.revision,decision:'accept',binding:disposition.binding,requestKey:'accept-'+nonce});await until(async()=>{try{return await fs.readFile(path.join(root,filename),'utf8')===nonce;}catch{return false;}},'accepted source artifact');record.sourceContent=await fs.readFile(path.join(root,filename),'utf8');}
 if(interrupt){
  const filename='INFLIGHT_'+nonce+'.txt';round={...round,filename,workerRequests:0,interrupt:true};
  await call(main,'managed.send',{projectId:project.id,target:work.id,text:'Continue this same work: create '+filename+' with exact content '+nonce+' then wait.',requestKey:'continue-'+nonce});
  const active=await until(async()=>{const state=(await status(project.id)).state,current=state.works.find(w=>w.id===work.id);if(!state.jobs.some(job=>job.target===work.id&&job.status==='running'))return;try{if(await fs.readFile(path.join(current.execution.directory,filename),'utf8')===nonce)return current;}catch{}},'attached Worker continuation real tool is running');
  record.inFlightFile={path:path.join(active.execution.directory,filename),text:await fs.readFile(path.join(active.execution.directory,filename),'utf8')};
 }
 await remove(project,record);
 assert.equal(await fs.readFile(path.join(root,'original.txt'),'utf8'),'SOURCE_PRESERVED_'+roots.indexOf(root)+'\n');
 const storage=new ProjectStorage(main.profile);try{assert.equal((await storage.requireRegistered(project.id)).removed,true);const facts=await storage.getRecovery(project.id,'managed:native-facts');assert(facts,'native facts retained');const drafts=await storage.getRecovery(project.id,'managed:drafts');assert.equal(drafts.frontdesk,'UNSENT_'+nonce,'unsent draft retained after removal');record.recoveryPreserved=true;record.draftPreserved=true;record.instanceId=(await storage.requireRegistered(project.id)).instanceId;}finally{await storage.db.close();}
 return record;
}
try{
 main=await launch('main');await call(main,'config.initialize',{mode:'independent'});await call(main,'settings.providers.save',{operation:'create',provider:'cycle-local',baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'synthetic-local-only'}});await call(main,'settings.models.save',{frontdesk:{model:{mode:'explicit',selector:'cycle-local/scripted'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'explicit',selector:'cycle-local/scripted'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'cycle-local/scripted'},thinking:{mode:'native-default'}}});
 for(let i=0;i<3;i++){
  const first=await choose(main,roots[i]);const a=await execute(first.project,roots[i],i+'_NEW');a.openMs=first.ms;
  const again=await choose(main,roots[i]);assert.equal(again.project.id,first.project.id,'ordinary reload identity remains');
  const b=await execute(again.project,roots[i],i+'_RELOAD',{interrupt:i===2});b.openMs=again.ms;assert.equal(b.instanceId,a.instanceId,'ordinary reload instance remains');
 }
 report.checks.push('three new roots, each real Worker execution/remove followed by same-identity reload/re-execution/remove; final Worker removed while real tool still running');
 const original=await choose(main,roots[3]);await execute(original.project,roots[3],'SPECIAL_BEFORE');
 other=await launch('other');await choose(other,roots[3]);
 await fs.writeFile(main.control,JSON.stringify({pick:roots[3],confirm:1}));const refused=await raw(main,'project.pick');report.ownerRefusal=refused.error;assert.equal(refused.ok,false);assert.equal(refused.error.code,'RECOVERY_SOURCE_ACTIVE');
 await close(other);other=null;
 const restored=await choose(main,roots[3]);assert.notEqual(restored.project.id,original.project.id);await execute(restored.project,roots[3],'SPECIAL_AFTER');
 report.checks.push('independent real Electron same-root owner rejected; after normal owner exit explicit native recovery creates independent identity, then real Worker runs and removes');
 await close(main);main=null;assert.equal(report.errors.length,0);report.ok=true;
}catch(error){report.error=error.stack;if(main?.shell)await main.shell.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;}
finally{
 for(const h of [other,main])if(h){await close(h).catch(error=>{report.errors.push('cleanup: '+error.message);if(h.child.exitCode===null)h.child.kill('SIGTERM');});await fs.writeFile(path.join(out,h.label+'-main.log'),h.log).catch(error=>report.errors.push('log write: '+error.message));}
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,error:report.error,cycles:report.cycles.map(c=>({nonce:c.nonce,openMs:c.openMs,enableMs:c.enableMs,workMs:c.workMs,removeMs:c.removeMs}))},null,2));
}
