import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {staticReport,historicalMarkdownState} from './static-report.fixture.mjs';

// Real persisted Host history/read/export. Timing instrumentation never changes business values.
const source=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-offline-history-gui-'));
const app=path.join(out,'app'),profile=path.join(out,'profile'),controlFile=path.join(out,'control.json'),callsFile=path.join(out,'calls.jsonl'),opensFile=path.join(out,'provider-opens.jsonl');
const report={out,checks:[],errors:[],launches:[],kind:'real-electron-host-history-with-provider-transport-fixture'};
const pause=ms=>new Promise(r=>setTimeout(r,ms)),hash=b=>createHash('sha256').update(b).digest('hex');
await fs.mkdir(app);for(const name of ['src','tools','package.json'])await fs.cp(path.join(source,name),path.join(app,name),{recursive:true});for(const name of ['node_modules','vendor','assets'])await fs.symlink(path.join(source,name),path.join(app,name),'dir');
const hashes={};async function walk(dir,prefix){for(const e of await fs.readdir(dir,{withFileTypes:true})){const rel=path.join(prefix,e.name);if(e.isDirectory())await walk(path.join(dir,e.name),rel);else if(e.isFile())hashes[rel]=hash(await fs.readFile(path.join(dir,e.name)));}}await walk(path.join(app,'src'),'src');await fs.writeFile(path.join(out,'source-hashes.json'),JSON.stringify(hashes,null,2));
await fs.copyFile(path.join(source,'tests/post-install-recovery-transport.fixture.mjs'),path.join(app,'transport-fixture.mjs'));await fs.chmod(path.join(app,'transport-fixture.mjs'),0o755);await fs.mkdir(path.join(app,'bin'));await fs.symlink('../transport-fixture.mjs',path.join(app,'bin/codex'));
await fs.copyFile(path.join(source,'tests/static-report.fixture.mjs'),path.join(app,'static-report.fixture.mjs'));
await fs.writeFile(controlFile,JSON.stringify({fail:true,providerDelay:4000,delay:0}));await fs.writeFile(callsFile,'');await fs.writeFile(opensFile,'');
const mainFile=path.join(app,'src/main/main.cjs');let main=await fs.readFile(mainFile,'utf8');
const injection="managedAgents=new ManagedProjects({userDataDir:app.getPath('userData'),host,legacy:agents,beforeDocumentOperation:syncDocument,ompSystemSource,ompAuthBroker,ompCommand:ompRuntime?.command});";assert(main.includes(injection));
main=main.replace(injection,`const {openTransportController}=await import('../../transport-fixture.mjs');
  managedAgents=new ManagedProjects({userDataDir:app.getPath('userData'),host,legacy:agents,beforeDocumentOperation:syncDocument,ompSystemSource,ompAuthBroker,ompCommand:ompRuntime?.command,sourceHome:process.env.NOZELI_CODEX_SOURCE_HOME,openController:async options=>{
    const config=JSON.parse(await fs.readFile(process.env.NOZELI_HISTORY_CONTROL,'utf8'));await fs.appendFile(process.env.NOZELI_HISTORY_OPENS,JSON.stringify({phase:'start',at:Date.now(),contentRoot:options.contentRoot})+'\\n');
    if(config.fail){await new Promise(r=>setTimeout(r,config.providerDelay));await fs.appendFile(process.env.NOZELI_HISTORY_OPENS,JSON.stringify({phase:'failed',at:Date.now()})+'\\n');throw Error('OFFLINE_HISTORY_TRANSPORT_START_FAILED');}
    return openTransportController(options);
  }});`);
const detect="agents = new AgentRuntime({userDataDir:app.getPath('userData')});";assert(main.includes(detect));main=main.replace(detect,"agents = new AgentRuntime({userDataDir:app.getPath('userData'),detect:async()=>[]});");
const dispatch="        return {ok:true,value:await managedAgents.invoke(op,payload??{})};";assert(main.includes(dispatch));
main=main.replace(dispatch,`        {
          await fs.appendFile(process.env.NOZELI_HISTORY_CALLS,JSON.stringify({phase:'request',op,payload,at:Date.now()})+'\\n');
          const value=await managedAgents.invoke(op,payload??{});
          await fs.appendFile(process.env.NOZELI_HISTORY_CALLS,JSON.stringify({phase:'result',op,projectId:payload?.projectId,version:value?.version,at:Date.now()})+'\\n');
          const config=JSON.parse(await fs.readFile(process.env.NOZELI_HISTORY_CONTROL,'utf8'));if(config.delayOp===op&&config.delayProject===payload?.projectId)await new Promise(r=>setTimeout(r,config.delay));
          return {ok:true,value};
        }`);
await fs.writeFile(mainFile,main);await fs.writeFile(path.join(out,'injection.json'),JSON.stringify({originalMain:hashes['src/main/main.cjs'],injectedMain:hash(Buffer.from(main)),transport:hash(await fs.readFile(path.join(app,'transport-fixture.mjs'))),scope:'synthetic Provider absence/start failure/success; request logging and delay AFTER real history result, no business response replacement'},null,2));
const {DesktopHost}=await import(pathToFileURL(path.join(app,'src/main/host.mjs'))),{Workspace}=await import(pathToFileURL(path.join(app,'src/agents/managed/workspace.mjs')));
const host=new DesktopHost(profile),projects=[];
for(const [name,count] of [['history-a',55],['history-b',3],['history-empty',0]]){
 const root=path.join(out,name);await fs.mkdir(root);await fs.writeFile(path.join(root,'sample.md'),'# '+name+' ordinary reading\n');const id=(await host.pick(root)).project.id,runtime=path.join(profile,'nozeli/managed-v1',id,'runtime');let items=[];
 if(name==='history-a')await fs.writeFile(path.join(root,'GIT-A.txt'),'baseline\n');
 if(count){const store=await Workspace.open(runtime,root),w=await store.submit('historical fixture only','fixture',{name:'同名历史'});await store.activate(w.id);for(let rev=1;rev<=count;rev++){if(rev>1)await store.continue(w.id);const kind=rev===1?'problem':'result',text='# ORIGIN='+name+' REV='+rev+'\n\nHistorical persisted fixture content; no Provider created this report.\n';const r=await store.publish(w.id,rev,kind,staticReport(text),'historical-'+rev);await store.mutate(()=>{store.state.receipts.find(x=>x.objectId===r.objectId).at=new Date(Date.UTC(2026,0,1,0,0,rev)).toISOString();});items.push({...r,text});await store.settle(w.id);}await historicalMarkdownState(store,new Map(items.map(item=>[item.objectId,item.text])));}
 projects.push({name,root,id,runtime,items});
}
const [a,b,empty]=projects;await host.pick(a.root);await fs.writeFile(path.join(out,'seed.json'),JSON.stringify(projects,null,2));
const originalState=await fs.readFile(path.join(a.runtime,'state.json')),originalMtime=(await fs.stat(path.join(a.runtime,'state.json'),{bigint:true})).mtimeNs;
const build=spawn(process.execPath,[path.join(app,'tools/build-renderer.mjs')],{cwd:app,stdio:['ignore','pipe','pipe']});let buildLog='';for(const s of [build.stdout,build.stderr])s.on('data',c=>buildLog+=c);const buildCode=await new Promise(r=>build.once('exit',r));await fs.writeFile(path.join(out,'build.log'),buildLog);assert.equal(buildCode,0);
let child,browser,page,exited,launchIndex=0;
const invoke=(op,payload={})=>page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});
const rows=async()=> (await fs.readFile(callsFile,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
const opens=async()=> (await fs.readFile(opensFile,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
async function control(patch){const value=JSON.parse(await fs.readFile(controlFile,'utf8'));await fs.writeFile(controlFile,JSON.stringify({...value,...patch}));}
async function until(fn,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(50);}throw Error('bounded harness wait failed');}
async function launch(){
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});}),record={index:++launchIndex,port};report.launches.push(record);const ozone=process.env.NOZELI_OZONE||'wayland';await fs.mkdir(path.join(out,'empty-provider-source'),{recursive:true});
 child=spawn(createRequire(import.meta.url)('electron'),['--ozone-platform='+ozone,path.join(app,'src/main/main.cjs')],{cwd:app,env:{...process.env,PATH:path.join(app,'bin')+path.delimiter+process.env.PATH,NOZELI_TEST_INSTANCE:'1',NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:a.root,NOZELI_DEBUG_PORT:String(port),NOZELI_AGENT_FIXTURE:'1',NOZELI_CODEX_SOURCE_HOME:path.join(out,'empty-provider-source'),NOZELI_HISTORY_CONTROL:controlFile,NOZELI_HISTORY_CALLS:callsFile,NOZELI_HISTORY_OPENS:opensFile,NOZELI_HIDDEN:ozone==='headless'?'1':'0',NOZELI_OZONE:ozone,NOZELI_SHOT_DIR:out},stdio:['ignore','pipe','pipe']});record.pid=child.pid;let log='';for(const s of [child.stdout,child.stderr])s.on('data',c=>log+=c);exited=new Promise(r=>child.once('exit',(code,signal)=>{record.exit={code,signal};void fs.writeFile(path.join(out,'electron-'+record.index+'.log'),log);r(record.exit);}));
 await until(async()=>{if(child.exitCode!==null||child.signalCode)throw Error(log);try{return (await fetch('http://127.0.0.1:'+port+'/json/version')).ok;}catch{return false;}},25000);
 browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});page=(await browser.pages()).find(p=>p.url().includes('127.0.0.1'));page.on('pageerror',e=>report.errors.push(e.stack));await page.waitForFunction(()=>window.__nozeliReady);await invoke('session.resize',{width:1440,height:900});await page.waitForFunction(()=>innerWidth===1440&&innerHeight===900);
 // A fresh profile always auto-opens the one-time setup dialog; dismiss it once
 // here so later real clicks never race the modal.
 await page.waitForSelector('#configuration-setup[open]',{timeout:15000});await page.click('#configuration-cancel');await page.waitForFunction(()=>!document.querySelector('#configuration-setup').open);
}
async function close(){if(child?.exitCode!==null||child?.signalCode)return;assert((await invoke('session.requestClose')).ok);assert.deepEqual(await Promise.race([exited,pause(15000).then(()=>null)]),{code:0,signal:null});await browser.disconnect();browser=null;page=null;}
async function choose(p){await page.click('[data-project-id="'+p.id+'"]');await page.waitForFunction(name=>document.querySelector('#project-name').textContent===name,{},p.name);await page.evaluate(() => { if (document.body.classList.contains('provider-console-open')) document.querySelector('#provider-console-close').click(); });await pause(120);}
async function archive(){if(await page.$eval('#managed-agent-details',n=>!n.open))await page.evaluate(()=>window.dispatchEvent(new Event('nozeli-agent-details')));await page.waitForSelector('#managed-agent-details[open]');
 await page.waitForFunction(()=>{const archive=document.querySelector('#managed-work-archive');return archive&&archive.open;},{timeout:10000}).catch(async()=>{await page.$eval('#managed-work-archive',n=>{n.open=true;});});}
async function historyCount(n){await page.waitForFunction(n=>document.querySelectorAll('[data-managed-history-object]').length===n,{},n);}
let historyView=null;
async function scopedHistory(expect){const end=Date.now()+30000;while(Date.now()<end){for(const p of await browser.pages()){if(!p.url().startsWith('http://127.0.0.1:'))continue;const hit=await p.evaluate(async expectation=>{if(window.__nozeliReady!==true)return false;const r=await nozeli.invoke('workspace.bootstrap',{});const s=r.ok?r.value:null;if(!s||s.role!=='surface'||s.kind!=='history'||s.viewState?.report?.objectId!==expectation.objectId)return false;const doc=document.querySelector('#managed-doc');return document.body.dataset.managedHistory==='true'&&!!doc&&!doc.hidden&&doc.textContent.includes(expectation.text);},expect).catch(()=>null);if(hit)return p;}await pause(100);}throw Error('scoped history surface wait failed: '+expect.objectId+' '+expect.text);}
async function revealHistory(){if(!historyView||historyView.isClosed())return;await page.evaluate(()=>{const d=document.querySelector('#managed-agent-details');if(d&&d.open)d.close();});await until(async()=>{try{return await historyView.evaluate(()=>innerWidth>0&&innerHeight>0);}catch{return true;}},5000);}
async function openItem(p,item){await archive();await page.click('[data-managed-history-object="'+item.objectId+'"]');historyView=await scopedHistory({objectId:item.objectId,text:'ORIGIN='+p.name+' REV='+item.revision});await revealHistory();}
async function closeHistoryView(){if(!historyView||historyView.isClosed()){historyView=null;return;}const closing=historyView;await revealHistory();await page.click('[data-workspace-command="closePane"]');await until(async()=>closing.isClosed(),5000).catch(()=>{});if(historyView===closing)historyView=null;}
const visibleClickOn=async(p,selector)=>{const handle=await p.$(selector);assert(handle,selector);await handle.scrollIntoView();const rect=await handle.evaluate(n=>{const r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,hit:n===hit||n.contains(hit),vw:n.ownerDocument.defaultView.innerWidth,vh:n.ownerDocument.defaultView.innerHeight};});assert(rect.left>=0&&rect.right<=rect.vw&&rect.top>=0&&rect.bottom<=rect.vh&&rect.hit,JSON.stringify({selector,rect}));await handle.click();};
async function snapshot(name){await page.screenshot({path:path.join(out,name+'.png')});if(historyView&&historyView.isClosed())historyView=null;if(historyView&&await historyView.evaluate(()=>innerWidth>0&&innerHeight>0).catch(()=>false))await historyView.screenshot({path:path.join(out,name+'-history.png')}).catch(()=>{});const scoped=historyView?{title:await historyView.$eval('#subject-title',n=>n.textContent).catch(()=>''),caption:await historyView.$eval('#file-path',n=>n.textContent).catch(()=>''),report:await historyView.$eval('#managed-doc',n=>n.textContent).catch(()=>''),locked:await historyView.$eval('#compose-form',n=>n.inert).catch(()=>null)}:{title:null,caption:null,report:null,locked:null};await fs.writeFile(path.join(out,name+'-dom.json'),JSON.stringify({project:await page.$eval('#project-name',n=>n.textContent),...scoped,draft:await page.$eval('#composer',n=>n.value),history:await page.$eval('#managed-work-archive',n=>n.textContent)},null,2));}
const check=name=>{report.checks.push(name);console.log('PASS '+name);};
try{
 await launch();await choose(a);await archive();await historyCount(50);
 await openItem(a,a.items.at(-1));
 await pause(400);
 console.log('CHROME '+JSON.stringify(await page.evaluate(()=>{const g=document.querySelector('#workspace-groups');const cmds=[...document.querySelectorAll('[data-workspace-command]')].map(n=>({k:n.dataset.workspaceCommand,t:(n.textContent||'').slice(0,10),vis:!!n.getClientRects().length&&n.getBoundingClientRect().width>0}));const tabs=[...document.querySelectorAll('[data-view-id]')].map(n=>({t:(n.textContent||'').slice(0,20),vis:!!n.getClientRects().length}));return {hasGroups:!!g,groupsDisplay:g?getComputedStyle(g).display:null,groupsRect:g?(()=>{const r=g.getBoundingClientRect();return {w:r.width,h:r.height};})():null,cmds,tabs,paneHeaders:[...document.querySelectorAll('.workspace-pane-header')].map(n=>(n.textContent||'').slice(0,30))};})));
 report.status='PASS';
}catch(error){report.status='FAIL';report.failure=error.stack;await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;
}finally{try{await close();}catch(error){report.closeError=error.stack;if(child?.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await Promise.race([exited,pause(5000)]);if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await exited;}}await browser?.disconnect();}const processes=[],auth=[];for(const id of await fs.readdir('/proc'))if(/^\d+$/.test(id)){try{const cmd=(await fs.readFile('/proc/'+id+'/cmdline','utf8')).replaceAll('\0',' ');if(cmd.includes(app))processes.push({pid:Number(id),cmd});}catch{}}async function scan(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.isSymbolicLink())continue;const p=path.join(dir,e.name);if(e.isDirectory())await scan(p);else if(e.name==='auth.json')auth.push(p);}}await scan(profile);report.audit={processes,auth};if(processes.length||auth.length||report.closeError)report.status='FAIL';await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,out,checks:report.checks.length,audit:report.audit}));if(report.status!=='PASS')process.exitCode=1;}
