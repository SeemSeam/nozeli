import {installFileTreeClicks} from './file-tree-clicks.fixture.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(import.meta.url);
await fs.mkdir(path.join(root,'.test-output'),{recursive:true});
const out=await fs.mkdtemp(path.join(root,'.test-output','desktop-close-'));
const project=path.join(out,'project'),configurationRoot=path.join(out,'.Nozeli'),profile=path.join(configurationRoot,'desktop');
await fs.mkdir(project);await fs.writeFile(path.join(project,'close.txt'),'initial text\n');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const checks=[];let active;
const stage=name=>{console.log('close smoke: '+name);if(active)active.stage=name;};
async function launch(){
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const child=spawn(require('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform='+(process.env.NOZELI_OZONE||'headless')],{cwd:root,env:{...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:configurationRoot,NOZELI_USER_DATA:profile,NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:process.env.NOZELI_TEST_VISIBLE==='1'?'0':'1',NOZELI_OZONE:process.env.NOZELI_OZONE||'headless'},stdio:['ignore','pipe','pipe']});
 const run={child,port,log:'',exit:null};active=run;child.stdout.on('data',d=>run.log+=d);child.stderr.on('data',d=>run.log+=d);run.exited=new Promise(resolve=>child.once('exit',(code,signal)=>{run.exit={code,signal};resolve(run.exit);}));
 for(let i=0;i<100;i++){try{run.browser=await require('puppeteer-core').connect({browserURL:'http://127.0.0.1:'+port});break;}catch{await pause(100);}}
 assert.ok(run.browser,'test app starts: '+run.log);const target=await run.browser.waitForTarget(target=>target.type()==='page'&&target.url().startsWith('http://127.0.0.1:'),{timeout:30000});run.page=await target.page();const p=run.page;
 await p.waitForFunction(()=>window.__nozeliReady===true,{polling:100});
 installFileTreeClicks(p,stage);
 const status=await p.evaluate(()=>window.nozeli.invoke('config.status',{}));assert.equal(status.ok,true);
 if(!status.value.initialized){await p.waitForSelector('#configuration-setup[open]');await p.click('#configuration-cancel');}return run;
}
async function close(run){
 void run.page.evaluate(()=>window.nozeli.invoke('session.requestClose',{})).catch(()=>{});
 const exit=await Promise.race([run.exited,pause(12000).then(()=>null)]);
 assert.deepEqual(exit,{code:0,signal:null},'must exit normally after flushing; cleanup kill does not count');
 let endpointOpen=false;try{endpointOpen=(await fetch('http://127.0.0.1:'+run.port+'/json/version')).ok;}catch{}
 assert.equal(endpointOpen,false,'debug listener closes with app');await run.browser.disconnect().catch(()=>{});active=null;
}
let error;
try{
 stage('empty workspace launch/close');let run=await launch();await close(run);checks.push('empty workspace closes with exit code 0 and releases listener');
 stage('picking project and opening close.txt');
 run=await launch();let p=run.page;await p.click('#pick-project');await p.waitForSelector('#file-tree button[data-path="close.txt"]');assert.equal(await p.$eval('#configuration-setup',e=>e.open),false);await p.click('#file-tree button[data-path="close.txt"]');await p.waitForFunction(()=>window.__nozeliInput?.text?.().includes('initial text'),{polling:100});
 stage('saving source and draft on close');
 await p.evaluate(()=>{document.querySelector('#composer').value='unsent conversation draft';document.querySelector('#composer').dispatchEvent(new Event('input',{bubbles:true}));window.__nozeliInput.insert('saved on close');});
 await close(run);assert.ok((await fs.readFile(path.join(project,'close.txt'),'utf8')).includes('saved on close'));checks.push('dirty text is saved before process exits');
 stage('reopening saved source and draft');
 run=await launch();p=run.page;assert.ok(await p.evaluate(()=>window.__nozeliInput.text().includes('saved on close')));assert.equal(await p.$eval('#composer',e=>e.value),'unsent conversation draft');checks.push('same profile reopens after exit with source and unsent conversation draft');
 stage('composition close veto');
 await p.evaluate(()=>document.querySelector('#text-host .cm-editor').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''})));
 await p.evaluate(()=>window.nozeli.invoke('session.requestClose',{}));await pause(500);assert.equal(run.exit,null);assert.equal(p.isClosed(),false);checks.push('active input composition vetoes close and keeps the window alive');
 await p.evaluate(()=>document.querySelector('#text-host .cm-editor').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
 await close(run);checks.push('ending composition permits clean exit and releases the profile again');
}catch(e){error=e.stack;console.error('Close smoke failed at '+active?.stage+'; main logs: '+path.join(out,'failure-main.log')+'\n'+(active?.log||''));if(active?.page&&!active.page.isClosed())await active.page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{
 if(active){await fs.writeFile(path.join(out,'failure-main.log'),active.log);await active.browser?.disconnect().catch(()=>{});if(!active.exit){active.child.kill('SIGTERM');await Promise.race([active.exited,pause(1500)]);if(!active.exit)active.child.kill('SIGKILL');}}
 const report={ok:!error,checks,error};await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,...report},null,2));process.exitCode=error?1:0;
}
