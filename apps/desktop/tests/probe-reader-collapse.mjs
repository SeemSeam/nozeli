// MINIMAL probe (parent directive): collapse a reader WHILE one page request
// is in flight. The already-started request may finish; ZERO new page requests
// may START after the collapse. Assertion uses request START timestamps vs
// collapse time (never completion-count deltas). Raw-message injection fixture;
// no Provider, no native owner.
import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';import {prepareReading} from './reading-setup.fixture.mjs';
const source=path.resolve(import.meta.dirname,'..');await fs.mkdir(source+'/.test-output',{recursive:true});const out=await fs.mkdtemp(source+'/.test-output/probe-collapse-'),app=out+'/app';await fs.mkdir(app);
for(const name of ['src','tools','package.json'])await fs.cp(source+'/'+name,app+'/'+name,{recursive:true});for(const name of ['node_modules','vendor','assets','runtime'])await fs.symlink(source+'/'+name,app+'/'+name,'dir');
const rendererPath=app+'/src/renderer/app.mjs',rendererSource=await fs.readFile(rendererPath,'utf8'),marker='window.__nozeliReady = false;';
const hook=`let fixtureMessages=[];window.__collapse={starts:[],release:null};window.__tagProbe={deliver(rows){fixtureMessages=rows;applyAgentMessages([], {projectId:ui.project.id,getMessages:()=>fixtureMessages,ensureMessage:async()=>{},readMessage:async(id,options)=>{if(!options)return {read:{version:'v1',maxBytes:65536,fields:[{field:'text',totalBytes:131072}]}};window.__collapse.starts.push({offset:options.offset,at:performance.now()});if(options.offset===0&&!window.__collapse.released)return new Promise(resolve=>{window.__collapse.release=resolve;}).then(()=>({version:'v1',field:'text',offset:0,nextOffset:65536,totalBytes:131072,content:'FIRST PAGE MARKER inflight-completed'}));return {version:'v1',field:'text',offset:options.offset,nextOffset:options.offset+65536>=131072?null:options.offset+65536,totalBytes:131072,content:'PAGE '+options.offset};}});}};window.__agentSelectionAction=async()=>({accepted:true,requestId:'probe-1'});`;
assert.equal(rendererSource.split(marker).length-1,1);await fs.writeFile(rendererPath,rendererSource.replace(marker,marker+'\n      '+hook));
const build=spawn(process.execPath,[app+'/tools/build-renderer.mjs'],{cwd:app,stdio:'inherit'});assert.equal(await new Promise(r=>build.once('exit',r)),0);
await fs.mkdir(out+'/project');await fs.writeFile(out+'/project/a.txt','Collapse probe source statement.\n');
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const env={...process.env,NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:out+'/.Nozeli',NOZELI_USER_DATA:out+'/.Nozeli/desktop',NOZELI_TEST_PICK:out+'/project',NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(createRequire(import.meta.url)('electron'),[app+'/src/main/main.cjs','--ozone-platform='+(process.env.NOZELI_OZONE||'wayland')],{env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const exit=new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));
const surface=async predicate=>{for(let i=0;i<150;i++){for(const candidate of await browser.pages()){const scope=await candidate.evaluate(()=>window.__workspaceScope).catch(()=>null);if(scope&&predicate(scope)&&await candidate.evaluate(()=>window.__nozeliReady).catch(()=>false))return candidate;}await new Promise(r=>setTimeout(r,100));}throw Error('surface not found');};
let browser,page;const report={probe:'reader-collapse-inflight',out,starts:null,collapseAt:null};
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{await new Promise(r=>setTimeout(r,100));}}
 const shell=await surface(s=>s.role==='shell');await prepareReading(shell);await shell.locator('#pick-project').click();await shell.locator('#file-tree button[data-path="a.txt"]').click();
 page=await surface(s=>s.role==='surface'&&s.kind==='document'&&s.relPath==='a.txt');await page.waitForFunction(()=>window.__nozeliInput?.text().startsWith('Collapse probe'));
 await page.evaluate(()=>window.__nozeliInput.select(2,10));await page.locator('#selection-discuss').click();await page.waitForSelector('.tag-composer .tag-editor');
 await page.locator('.tag-composer .tag-editor').click();await page.keyboard.type('collapse probe');await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');
 await page.waitForFunction(()=>[...document.querySelectorAll('.tag-message-user')].some(node=>node.textContent.includes('collapse probe')));
 await page.evaluate(()=>__tagProbe.deliver([{id:'m1',requestId:'probe-1',role:'qa',sequence:10,text:'',durable:true,availability:'read-required'}]));
 await page.waitForSelector('.tag-original[data-tag-original]',{timeout:20000});
 await page.evaluate(()=>document.querySelector('.tag-original').scrollIntoView({block:'center'}));
 // Exactly one page request (offset 0) must START and stay in flight.
 await page.waitForFunction(()=>__collapse.starts.some(start=>start.offset===0),{timeout:20000});
 // Collapse WHILE the first page is still held unresolved.
 await page.evaluate(()=>document.querySelector('.tag-discuss .tag-close')?.click());
 report.collapseAt=await page.evaluate(()=>performance.now());
 await page.waitForFunction(()=>document.querySelector('.tag-discuss .note-projection')?.classList.contains('is-collapsed'),{timeout:10000});
 // Release the in-flight page: it may complete, but NOTHING new may START.
 await page.evaluate(()=>__collapse.release&&__collapse.release());
 await new Promise(r=>setTimeout(r,1200));
 report.starts=await page.evaluate(()=>__collapse.starts);
 const startedAfterCollapse=report.starts.filter(start=>start.at>report.collapseAt);
 assert.equal(startedAfterCollapse.length,0,'ZERO new page requests started after collapse; started-after='+JSON.stringify(startedAfterCollapse)+' all='+JSON.stringify(report.starts));
 assert(report.starts.some(start=>start.offset===0),'the in-flight first page did start before collapse');
 report.inflightCompleted=await page.$eval('.tag-original-body',node=>node.textContent.includes('FIRST PAGE MARKER')).catch(()=>false);
 report.ok=true;
 console.log(JSON.stringify(report));
 await page.evaluate(()=>nozeli.invoke('session.requestClose',{}));assert.deepEqual(await Promise.race([exit,new Promise(r=>setTimeout(()=>r(null),10000))]),{code:0,signal:null});
}catch(error){console.error(log,out);report.error=String(error&&error.stack||error);throw error;}
finally{await browser?.disconnect();if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exit.catch(()=>{}),new Promise(r=>setTimeout(r,3000))]);if(child.exitCode===null)child.kill('SIGKILL');}await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));}
