// Production main/renderer, real native queue and visible document surfaces.
// Only synthetic profiles/launches; CDP input is not physical Explorer/IME.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import puppeteer from 'puppeteer-core';

const [output,application,executable]=process.argv.slice(2);
assert.equal(process.platform,'win32');assert(output&&path.isAbsolute(output));await fs.mkdir(output);
const appRoot=path.resolve(application||path.join(import.meta.dirname,'..')),command=executable||createRequire(import.meta.url)('electron');
const config=path.join(output,'.Nozeli'),profile=path.join(config,'desktop'),project=path.join(output,'项目 空格'),singleton=path.join(output,'singleton');
const externalWinner='# Independent external winner 外部版本\n';
await fs.mkdir(project);const source='# Routed Windows source 中文 🧭\n';
await fs.writeFile(path.join(project,'first.md'),source);await fs.writeFile(path.join(project,'second.txt'),'Second Windows document\n');await fs.writeFile(path.join(project,'unsupported.xyz'),Buffer.from([0,255,0,1]));
const queueFile=path.join(profile,'nozeli/external-open-v1/queue.json'),checks=[],errors=[],runs=[];
let child,browser,shell,exited,stage='',log='';const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=45000){const end=Date.now()+ms;while(Date.now()<end){const value=await fn();if(value)return value;if(child?.exitCode!==null)throw Error('Electron exited '+child?.exitCode+' '+log);await pause(80);}throw Error('Timeout '+label);}
function environment(){const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_|GIT_)/i.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|ASKPASS/i.test(key)||/^path$/i.test(key)||['NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE'].includes(key))delete env[key];env.Path=path.join(env.SystemRoot??env.SYSTEMROOT,'System32');return {...env,NOZELI_TEST_INSTANCE:'1',NOZELI_TEST_SINGLETON_ROOT:singleton,NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_HIDDEN:'0',NOZELI_SHOT_DIR:output};}
const args=values=>executable?values:[path.join(appRoot,'src/main/main.cjs'),...values];
async function invoke(op,payload={},page=shell){const response=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert.equal(response.ok,true,op+': '+JSON.stringify(response));return response.value;}
const status=()=>invoke('session.external.status');
async function launch(values=[]){
 const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
 child=spawn(command,args(values),{cwd:project,env:{...environment(),NOZELI_DEBUG_PORT:String(port)},stdio:['ignore','pipe','pipe']});log='';
 runs.push({pid:child.pid,command,args:values,packaged:Boolean(executable)});for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>log+=bytes);
 exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 browser.on('targetcreated',async target=>{const page=await target.page();page?.on('pageerror',error=>errors.push(error.message));});
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'shell');shell.on('pageerror',error=>errors.push(error.message));
 if(await shell.$eval('#configuration-setup',node=>node.open))await shell.click('#configuration-cancel');await invoke('session.resize',{width:1280,height:900});
 assert((await invoke('workspace.windows.list')).some(row=>row.visible));
}
async function route(values){
 const peer=spawn(command,args(values),{cwd:project,env:environment(),stdio:['ignore','pipe','pipe']});let peerLog='';for(const stream of [peer.stdout,peer.stderr])stream.on('data',bytes=>peerLog+=bytes);
 const result=await new Promise((resolve,reject)=>{peer.once('error',reject);peer.once('exit',(code,signal)=>resolve({code,signal}));});assert.deepEqual(result,{code:0,signal:null},peerLog);
}
async function document(rel){return until(async()=>{for(const page of await browser.pages())if(await page.evaluate(rel=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath===rel&&Boolean(window.__nozeliInput?.text),rel).catch(()=>false))return page;},'document '+rel);}
async function disk(){return JSON.parse(await fs.readFile(queueFile,'utf8'));}
async function empty(){await until(async()=>{const state=await status();return state.status==='ready'&&state.requests.length===0&&!state.terminalPending;},'durable actual display receipt');}
async function close(){void invoke('session.requestClose').catch(()=>{});const result=await Promise.race([exited,pause(20000).then(()=>null)]);assert.deepEqual(result,{code:0,signal:null},log);runs.at(-1).exit=result;runs.at(-1).log=log;await browser.disconnect();browser=null;}
async function explicitOpen(){await shell.click('[data-external-open="status"]');await shell.waitForSelector('dialog[data-external-open][open]');const buttons=await shell.$$('dialog[data-external-open] button');for(const button of buttons)if((await button.evaluate(node=>node.textContent))==='打开／重试'){await button.click();return;}throw Error('retry button absent');}
let result;
try{
 stage='initial argv admitted with setup modal';await launch(['first.md']);
 // The setup modal can defer automatic opening; both outcomes retain a row or
 // a positively confirmed receipt. Explicit retry is the user action below.
 await until(async()=>{const state=await status();return state.requests[0]?.state==='blocked'||state.requests.length===0;},'initial attempt settles');
 if((await status()).requests.length)await explicitOpen();const first=await document('first.md');await first.waitForFunction(()=>window.__nozeliInput.text().includes('Routed Windows source'));await empty();
 assert.equal((await disk()).receipts.at(-1).outcome,'opened');checks.push('startup argv reaches actual document renderer and durable opened receipt follows successful display');
 await first.screenshot({path:path.join(output,'actual-first-document.png')});
 const unsent=await first.evaluate(()=>window.__nozeliInput.insert('\nUnsent original editor draft 未发送\n'));
 assert(unsent.includes('未发送'));assert.equal(await fs.readFile(path.join(project,'first.md'),'utf8'),source);
 // Text autosaves by design. A real external winner makes the unsaved-draft
 // fixture deterministic without disabling product timers or retention logic.
 await fs.writeFile(path.join(project,'first.md'),externalWinner);
 stage='unsupported input retained';await route(['unsupported.xyz']);await until(async()=>{const q=await status();return q.requests[0]?.state==='blocked';},'unsupported retained');
 assert.equal((await status()).requests.length,1);assert.equal((await disk()).requests[0].state,'blocked');checks.push('unsupported external file remains durably blocked instead of destructive takeOpen loss');
 assert.equal(await first.evaluate(()=>window.__nozeliInput.text()),unsent);assert.equal(await fs.readFile(path.join(project,'first.md'),'utf8'),externalWinner);checks.push('failed external open preserves the actual original editor buffer and the independent external disk winner');
 stage='pending FIFO and restart';await route(['second.txt']);let before=await status();assert.equal(before.requests.length,2);assert.equal(before.requests[1].requiresUserAction,true);const ids=before.requests.map(row=>row.requestId);await close();
 await launch();const cold=await status();assert.deepEqual(cold.requests.map(row=>row.requestId),ids);assert(cold.requests.every(row=>row.requiresUserAction));assert.equal(await shell.evaluate(()=>window.__workspaceScope.projectId),null);checks.push('complete process restart retains FIFO identities and never automatically replays pending requests');
 stage='explicit removal UI';await shell.click('[data-external-open="status"]');await shell.waitForSelector('dialog[data-external-open][open]');
 await shell.screenshot({path:path.join(output,'pending-recovery.png')});
 await shell.evaluate(()=>{const button=[...document.querySelectorAll('dialog[data-external-open] button')].find(node=>node.textContent==='移除请求');button.click();});assert.equal((await status()).requests.length,2);
 await shell.evaluate(()=>[...document.querySelectorAll('dialog[data-external-open] button')].find(node=>node.textContent==='确认移除请求').click());await until(async()=>((await status()).requests.length===1),'explicit remove');assert.deepEqual(await fs.readFile(path.join(project,'unsupported.xyz')),Buffer.from([0,255,0,1]));
 stage='explicit retry displays next file';await shell.evaluate(()=>document.querySelector('dialog[data-external-open]').close());await explicitOpen();const second=await document('second.txt');await second.screenshot({path:path.join(output,'actual-second-document.png')});await empty();checks.push('explicit two-step request removal preserves source and explicit FIFO retry opens the next real document');
 const projectId=await shell.evaluate(()=>window.__workspaceScope.projectId);const retained=await invoke('file.read',{projectId,relPath:'first.md'});assert.equal(retained.draft.text,unsent);assert.equal(retained.text,externalWinner);assert.equal(await fs.readFile(path.join(project,'first.md'),'utf8'),externalWinner);checks.push('complete Electron restart retains the unsent original draft independently from the unchanged external disk winner');
 stage='foreign display ack refused';const rejected=await shell.evaluate(()=>nozeli.invoke('workspace.externalDisplayed',{requestId:crypto.randomUUID(),ok:true,snapshot:{ready:true}}));assert.equal(rejected.ok,false);assert.equal(rejected.error.code,'OPEN_DISPLAY_DENIED');checks.push('unsolicited display acknowledgement is refused by the production IPC handler');
 stage='native directory display';await route([project]);await empty();assert.equal((await disk()).receipts.at(-1).outcome,'opened');checks.push('external directory completes only after the actual ready project shell confirms display');
 await shell.screenshot({path:path.join(output,'final-window.png')});await close();assert.deepEqual(errors,[]);
 result={ok:true,stage,checks,errors,runs,application:appRoot,packaged:Boolean(executable),scope:'Production external launch routing, synthetic native account singleton, durable queue and real document/shell renderer confirmation; no physical Explorer or IME qualification'};
}catch(error){
 await shell?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});const pages=[];for(const page of await browser?.pages()??[])pages.push(await page.evaluate(()=>({scope:window.__workspaceScope,ready:window.__nozeliReady,text:document.body.innerText.slice(-12000),lastOpen:window.__lastOpen})).catch(error=>({error:error.message})));
 result={ok:false,stage,error:error.stack,checks,errors,runs,log,pages,queue:await fs.readFile(queueFile,'utf8').catch(()=>null)};process.exitCode=1;
}finally{
 await browser?.disconnect();if(child?.exitCode===null){child.kill();await Promise.race([exited,pause(5000)]);}if(runs.length&&!runs.at(-1).log)runs.at(-1).log=log;
 for(let i=0;i<runs.length;i++){await fs.writeFile(path.join(output,'main-'+(i+1)+'.log'),runs[i].log??'');delete runs[i].log;}
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
