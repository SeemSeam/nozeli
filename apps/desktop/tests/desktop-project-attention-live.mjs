// Real installed/source Electron, registered projects, SQLite and pending reports; no model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {randomUUID,createHash} from 'node:crypto';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {Workspace} from '../src/agents/managed/workspace.mjs';
import {managedRuntime,readManagedState} from '../src/agents/managed/managed-storage.mjs';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';
const app=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-project-attention-')),profile=path.join(out,'config/desktop'),home=path.join(out,'home');
await fs.mkdir(home);const host=new DesktopHost(profile),projects=[],before=new Map();
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
for(const [name,count] of [['甲项目',2],['乙项目',100],['丙项目',0]]){
 const root=path.join(out,name);await fs.mkdir(root);await fs.writeFile(path.join(root,'paper.md'),'# '+name+'\noriginal paper\n');
 const project=(await host.pick(root)).project,store=await Workspace.open(await managedRuntime(host.storage,project.id),root,{storage:host.storage,projectId:project.id});
 const works=[],todos=[];for(let i=0;i<count;i++){const id=randomUUID(),objectId=randomUUID();works.push({id,name:'同名工作',status:'review',revision:1,result:{objectId,revision:1}});todos.push({id:name+'-'+i,kind:'result',status:'open',workId:id,objectId,revision:1,createdAt:'2026-11-07T00:00:00Z'});}
 todos.push({id:name+'-ignored',kind:'system',status:'resolved',userActionable:false});
 await store.mutate(()=>Object.assign(store.state,{works,todos,jobs:[],messages:[],receipts:[],drafts:{frontdesk:'retained draft '+name},limit:4}));
 before.set(project.id,digest({works:store.state.works,todos:store.state.todos,jobs:store.state.jobs,messages:store.state.messages}));await store.close();
 await host.storage.putLocal(project.id,'managed:binding',{schema:1,enabled:true,roles:{frontdesk:{provider:'pi'},orchestrator:{provider:'pi'},worker:{provider:'pi'}}});projects.push({...project,root,name});
}
await host.storage.db.close();
const report={ok:false,out,checks:[],screenshots:[],matrix:[],scope:'Actual Electron binary, isolated registered SQLite projects, no provider/model calls'};
let child,browser,shell,observer,exit,log='';const errors=[],pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+30000;while(Date.now()<end){if(child?.exitCode!=null)throw Error('App exited '+log);const result=await fn();if(result)return result;await pause(70);}throw Error('Timeout '+label);}
async function invoke(op,payload={}){const result=await shell.evaluate(({op,payload})=>window.nozeli.invoke(op,payload),{op,payload});assert(result.ok,op+': '+JSON.stringify(result.error));return result.value;}
const button=id=>'#recent [data-project-id="'+id+'"]';
async function count(id){return shell.$eval(button(id),n=>n.querySelector('[data-project-attention-count]')?.textContent);}
async function shot(name){const file=path.join(out,name+'.png');await shell.screenshot({path:file});report.screenshots.push(file);}
try{
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const env={...process.env};for(const k of Object.keys(env))if(k!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(k)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k)||k==='ELECTRON_RUN_AS_NODE'))delete env[k];
 Object.assign(env,{HOME:home,NOZELI_CONFIG_ROOT:path.join(out,'config'),NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
 const binary=process.env.NOZELI_TEST_BINARY||require('electron');child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(app,'src/main/main.cjs')]),'--inspect=0','--ozone-platform='+(process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':'wayland'))],{cwd:app,env,stdio:['ignore','pipe','pipe']});exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=b);
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'debug');shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');shell.on('pageerror',e=>errors.push(e.message));
 observer=await MainObserver.connect(await until(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'native observer'));
 const [a,b,c]=projects;await until(async()=>await count(a.id)==='2'&&await count(b.id)==='99+','all-project badges');
 assert.equal(await shell.$eval(button(c.id)+' [data-project-attention-badge]',n=>n.hidden),true);assert.match(await shell.$eval(button(b.id),n=>n.getAttribute('aria-label')),/100/);
 const summary=await invoke('project.attention.summary',{projectIds:projects.map(p=>p.id)});assert.deepEqual(summary.projects.map(p=>p.pendingCount),[2,100,0]);report.checks.push('Inactive projects show authoritative independent 2 / 99+ / zero-hidden badges; aria reads exact 100');
 await shell.click(button(a.id));await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,a.id),'project A');await until(()=>shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')==='true'),'open sidebar');
 await shell.click('#toggle-sidebar');assert.equal(await count(a.id),'2');assert.equal(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')),'false');await shot('collapsed-project-badges');
 await shell.click(button(a.id));await until(()=>shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')==='true'),'explicit current badge opens sidebar');await until(()=>shell.$eval('#inbox-count',n=>n.textContent==='2'),'right count agrees');
 assert.equal(await shell.$eval('#managed-todo-heading',n=>document.activeElement===n),true);await shell.keyboard.press('Escape');assert.equal(await shell.$eval(button(a.id),n=>document.activeElement===n),true);assert.equal(await shell.$eval('#toggle-sidebar',n=>n.getAttribute('aria-expanded')),'false');await shell.keyboard.press('Enter');await until(()=>shell.$eval('#managed-todo-heading',n=>document.activeElement===n),'keyboard reopens pending heading');
 await invoke('managed.attention.ack',{projectId:a.id,ids:['甲项目-0'],occurrences:[{id:'甲项目-0',interrupted:false}]});assert.equal(await count(a.id),'2');report.checks.push('Collapsed right sidebar preserves project count; current-project explicit click opens pending list; reminder ack does not clear count');
 await shell.click(button(b.id));await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,b.id),'project B');assert.equal(await count(a.id),'2');assert.equal(await count(b.id),'99+');await shell.click(button(a.id));await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,a.id),'return A');
 await fs.rename(c.root,c.root+'-held');try{const missing=await invoke('project.attention.summary',{projectIds:[c.id]});assert.equal(missing.projects[0].pendingCount,null);assert.equal(missing.projects[0].complete,false);await shell.evaluate(()=>window.dispatchEvent(new Event('focus')));await until(()=>shell.$eval(button(c.id),n=>n.dataset.attentionState==='stale'||n.dataset.attentionState==='unknown'),'missing project not healthy zero');assert.equal(await count(c.id),'?');await shot('missing-project-unknown');}finally{await fs.rename(c.root+'-held',c.root);}
 await shell.evaluate(()=>window.dispatchEvent(new Event('focus')));await until(()=>shell.$eval(button(c.id)+' [data-project-attention-badge]',n=>n.hidden),'restored zero');report.checks.push('Temporarily missing project is unknown, not zero; restored original identity can return to confirmed zero');
 for(const theme of ['light','dark'])for(const palette of ['sage','slate']){
  await invoke('settings.appearance.save',{theme,palette,font:'system',size:14});await shell.waitForFunction(({theme,palette})=>document.documentElement.dataset.theme===theme&&document.documentElement.dataset.palette===palette,{}, {theme,palette});
  const visual=await shell.$eval(button(b.id),n=>{const badge=n.querySelector('[data-project-attention-badge]'),s=getComputedStyle(badge),r=badge.getBoundingClientRect(),p=n.getBoundingClientRect(),rgb=v=>v.match(/[\d.]+/g).slice(0,3).map(Number),lum=v=>rgb(v).map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0),a=lum(s.color),b=lum(s.backgroundColor);return {color:s.color,bg:s.backgroundColor,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),width:r.width,height:r.height,inside:r.left>=p.left-1&&r.right<=p.right+1&&r.top>=p.top-1,buttonWidth:p.width,buttonHeight:p.height};});assert(visual.inside);assert(visual.contrast>=4.5);assert(visual.buttonWidth>=44&&visual.buttonHeight>=44);report.matrix.push({theme,palette,...visual});await shot(theme+'-'+palette);
 }
 for(const width of [390,320]){await invoke('workspace.control',{type:'window-control',action:'resize',width,height:600});await shell.waitForFunction(()=>document.querySelector('#app').classList.contains('narrow-layout'));await until(()=>shell.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'narrow no overflow');assert.equal(await count(b.id),'99+');assert.equal(await shell.$eval(button(b.id),n=>{const r=n.getBoundingClientRect();return n.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));}),true,'left project remains reachable beside open drawer');await shot('narrow-'+width);}
 await invoke('workspace.control',{type:'window-control',action:'resize',width:1280,height:900});
 const zoom=async factor=>observer.evaluate(`(async()=>{const{webContents}=process.mainModule.require('electron');for(const wc of webContents.getAllWebContents()){const scope=await wc.executeJavaScript('window.__workspaceScope').catch(()=>null);if(scope?.role==='shell'){wc.setZoomFactor(${factor});return wc.getZoomFactor();}}throw Error('Shell not found');})()`);
 assert.equal(await zoom(2),2);await until(()=>shell.evaluate(()=>innerWidth<=650),'real 200 percent zoom');assert.equal(await count(b.id),'99+');assert.equal(await shell.$eval(button(b.id),n=>{const b=n.querySelector('[data-project-attention-badge]').getBoundingClientRect(),r=n.getBoundingClientRect();return b.right<=r.right+1&&b.left>=r.left-1;}),true);await shot('zoom200');await zoom(1);report.checks.push('Four theme combinations, 390/320px and real Electron 200% zoom preserve red count, project identity and reachable rail');
 observer.close();observer=null;
 await invoke('session.requestClose');assert.deepEqual(await Promise.race([exit,pause(20000).then(()=>null)]),{code:0,signal:null});child=null;await browser.disconnect();browser=null;
 const finalHost=new DesktopHost(profile);for(const p of projects){const s=await readManagedState(finalHost.storage,p.id);assert.equal(digest({works:s.works,todos:s.todos,jobs:s.jobs,messages:s.messages}),before.get(p.id));assert.equal(await fs.readFile(path.join(p.root,'paper.md'),'utf8'),'# '+p.name+'\noriginal paper\n');}await finalHost.storage.db.close();report.checks.push('Normal exit retains every original business record and file; summary and badge interactions create no jobs/messages');assert.deepEqual(errors,[]);report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{observer?.close();if(child?.exitCode===null)child.kill('SIGTERM');await browser?.disconnect().catch(()=>{});report.errors=errors;await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
