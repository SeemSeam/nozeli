import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {build} from 'esbuild';
import puppeteer from 'puppeteer-core';

// Real Electron consumes the production widget. The deterministic gateway is a
// stateful read/action oracle, not a native Pi qualification or response echo.
const root=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-repair-consumer-'));
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
await build({absWorkingDir:root,stdin:{resolveDir:root,contents:String.raw`
import {mountCollaborationStatus} from './src/renderer/collaboration-status.mjs';
let project='p1',revision=1,mode='normal',held=null,ack=null,mutations=[],statusReads=0,permission=false,finalizing=false;
const binding=(id,p=project)=>({projectId:p,bugId:id,fingerprint:'fp-'+id,phase:'apply',jobId:'job-original',workId:'work-original',revision:7});
const repair=(id,retry,reason)=>({id,projectId:project,workId:'work-original',workRevision:7,jobId:'job-original',phase:'apply',status:id==='active'?'running':'blocked',stateLabel:id==='active'?'修复执行中':'修复受阻',reason:'原线程保留',attemptCount:reason==='attempt_limit'?2:1,maxAttempts:2,binding:binding(id),capabilities:{retry,retryReason:reason,retryMode:retry?(finalizing?'finalize':'repair'):null}});
function page(cursor){const all=[repair('active',false,'in_flight'),repair('retryable',true,null),repair('cold',false,'cold'),repair('limit',false,'attempt_limit'),repair('unknown',false,'unknown'),repair('permission',false,'permission')];const offset=cursor?Number(cursor.split(':')[1]):0;if(cursor&&Number(cursor.split(':')[0])!==revision)throw Error('cursor stale');return {schema:1,projectId:project,revision:'r'+revision,rows:all.slice(offset,offset+2),total:all.length,nextCursor:offset+2<all.length?revision+':'+(offset+2):null,summary:{inFlight:1,queued:0,blocked:5,repaired:0}};}
async function call(op,p,id){
 if(op==='collaboration.status')return {schema:1,projectId:id,revision:'owners',agents:['frontdesk','decision','review'].map(target=>({target,displayName:target,workName:target==='frontdesk'?null:'Original Work',primaryState:target==='frontdesk'?'sleeping':'waiting',stateLabel:target==='frontdesk'?'休眠':target==='decision'?'等待用户决策':'等待用户验收',model:{},capabilities:{model:false}})),totalAgents:3,nextCursor:null,project:{projectKeepsRunning:true},freshness:'live'};
 if(op==='maintenance.status'){statusReads++;const value=page(p.cursor);if(mode==='hold'){mode='normal';return new Promise(resolve=>held=()=>resolve(value));}if(mode==='mismatch'&&p.cursor)return {...value,revision:'unexpected'};return value;}
 if(op==='maintenance.retry'){if(id!==project||p.bugId!=='retryable'||JSON.stringify(p.binding)!==JSON.stringify(binding('retryable',id)))throw Error('Incorrect original binding');mutations.push({id,...structuredClone(p)});if(permission)throw Error('权限不足，原动作保持');return new Promise(resolve=>ack=()=>resolve({accepted:true}));}
 if(op==='model.options')return {revision:1,available:false,ownerAvailable:false,state:'unknown',models:[],recorded:{model:'p/original'}};
 throw Error('Forbidden operation '+op);
}
const widget=mountCollaborationStatus({root:document.getElementById('root'),call,current:()=>({projectId:project,target:'frontdesk'}),onSelect:()=>{}});
window.fixture={refresh:()=>widget.refresh(),mode:value=>mode=value,finalize(value){finalizing=value;return widget.refresh();},hold(){mode='hold';widget.update();},release(){held?.();held=null;},switch(){project='p2';widget.update();},ack(){ack?.();ack=null;},permission(value=true){permission=value;},reads:()=>statusReads,mutations:()=>mutations,held:()=>!!held,bump(){revision++;},dispose:()=>widget.dispose()};
widget.update();
`},bundle:true,format:'iife',platform:'browser',outfile:path.join(out,'entry.js'),loader:{'.css':'css'}});
await fs.writeFile(path.join(out,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="entry.css"><style>:root{--ink:#24382b;--muted:#657366;--line:#ddd;--bg:white;--surface:#fafafa;--accent:#38624b}body{margin:12px;font-family:system-ui}button,input{font:inherit}</style></head><body><div id="root"></div><textarea id="draft">Original unsent draft</textarea><div id="history">Original thread history</div><script src="entry.js"></script></body></html>');
await fs.writeFile(path.join(out,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const win=new BrowserWindow({width:1000,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(path.join(out,'index.html'))});});app.on('window-all-closed',()=>app.quit());`);
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(out,'main.cjs'),'--remote-debugging-port='+port,'--ozone-platform='+(process.env.NOZELI_OZONE||'x11'),'--user-data-dir='+path.join(out,'profile')],{cwd:root,stdio:['ignore','pipe','pipe']});
let log='',browser;for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);const exited=new Promise(resolve=>child.once('exit',resolve));
try{
 for(let i=0;i<150;i++){try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});break;}catch{if(child.exitCode!==null)throw Error(log);await new Promise(resolve=>setTimeout(resolve,100));}}
 assert(browser,log);const target=await browser.waitForTarget(t=>t.type()==='page'&&t.url().endsWith('index.html')),page=await target.page(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.waitForSelector('.collaboration-repair[data-bug-id="retryable"]');
 await page.click('.collaboration-details');
 assert.equal(await page.evaluate(()=>fixture.mutations().length),0,'opening is pure read');
 await page.click('.collaboration-repairs>summary');
 await page.click('.collaboration-repairs>button');await page.waitForSelector('[data-bug-id="limit"]');
 await page.click('.collaboration-repairs>button');await page.waitForSelector('[data-bug-id="permission"]');
 assert.equal(await page.$$eval('.collaboration-repair button',nodes=>nodes.filter(node=>!node.disabled).length),1,'only exact capability enables retry');
 assert.equal(await page.$eval('.collaboration-repairs>button',node=>node.hidden),true);
 await page.click('[data-bug-id="retryable"]>summary');
 assert.match(await page.$eval('[data-bug-id="retryable"] .collaboration-repair-facts',node=>node.textContent),/Work work-original.*版本 7.*阶段 apply.*尝试 1\/2.*job-original.*fp-retryable/);
 await page.keyboard.press('Escape');await page.focus('#draft');await page.keyboard.press('End');await page.type('#draft',' kept');
 await page.evaluate(()=>fixture.refresh());
 assert.equal(await page.evaluate(()=>document.activeElement.id),'draft');
 await page.click('.collaboration-details');
 assert.equal(await page.$$eval('.collaboration-repair',nodes=>nodes.length),6,'refresh retains loaded page depth');
 assert.equal(await page.$eval('[data-bug-id="retryable"]',node=>node.open),true,'expanded facts preserved');
 // Inconsistent versions retain the prior complete snapshot, never a partial merge.
 await page.evaluate(()=>{fixture.mode('mismatch');return fixture.refresh();});
 assert.equal(await page.$$eval('.collaboration-repair',nodes=>nodes.length),6);
 assert.equal(await page.$eval('[data-bug-id="retryable"] button',node=>node.disabled),true);
 await page.evaluate(()=>{fixture.mode('normal');return fixture.refresh();});
 // Cursor expiry in a later page also leaves old facts visible and disabled.
 await page.evaluate(()=>{fixture.hold();});await page.waitForFunction(()=>fixture.held());await page.evaluate(()=>{fixture.bump();fixture.release();});
 await page.waitForFunction(()=>document.querySelector('[data-bug-id="retryable"] button').disabled);
 await page.evaluate(()=>fixture.refresh());
 await page.evaluate(()=>fixture.finalize(true));
 await page.evaluate(()=>fixture.finalize(false));assert.equal(await page.$eval('[data-bug-id="retryable"] button',node=>node.disabled),false);
 await page.click('[data-bug-id="retryable"] button');
 await page.waitForFunction(()=>fixture.mutations().length===1);
 await page.evaluate(()=>fixture.refresh());assert.equal(await page.$eval('[data-bug-id="retryable"] button',node=>node.disabled),true,'busy-safe refresh cannot enable a pending original command');
 await page.evaluate(()=>{document.querySelector('[data-bug-id="retryable"] button').click();});
 assert.equal(await page.evaluate(()=>fixture.mutations().length),1,'pending repair is single flight');
 assert.equal(await page.$eval('[data-bug-id="retryable"] button',node=>node.disabled),true);
 const sent=await page.evaluate(()=>fixture.mutations()[0]);assert.equal(sent.id,'p1');assert.deepEqual(sent.binding,{projectId:'p1',bugId:'retryable',fingerprint:'fp-retryable',phase:'apply',jobId:'job-original',workId:'work-original',revision:7});
 // Closing does not replay a pending command or perform acknowledgement refresh.
 await page.click('.collaboration-repairs>summary');const beforeAck=await page.evaluate(()=>fixture.reads());
 await page.evaluate(async()=>{fixture.ack();await new Promise(resolve=>setTimeout(resolve,0));});assert.equal(await page.evaluate(()=>fixture.reads()),beforeAck);
 await page.click('.collaboration-repairs>summary');
 await page.evaluate(()=>fixture.permission());await page.click('[data-bug-id="retryable"] button');
 await page.waitForFunction(()=>document.querySelector('[data-bug-id="retryable"] button').disabled);
 assert.equal(await page.evaluate(()=>fixture.mutations().length),2);
 assert.match(await page.$eval('.collaboration-agent-dialog',node=>node.textContent),/权限不足/);
 await page.evaluate(()=>fixture.refresh());
 await page.evaluate(()=>fixture.permission(false));await page.click('[data-bug-id="retryable"] button');await page.waitForFunction(()=>fixture.mutations().length===3);
 // Held old-project responses cannot replace the new project's bindings or state.
 await page.evaluate(()=>fixture.hold());await page.waitForFunction(()=>fixture.held());
 await page.evaluate(()=>{fixture.switch();fixture.release();});
 await page.waitForFunction(()=>document.querySelector('[data-bug-id="retryable"] .collaboration-repair-facts')?.textContent.includes('"projectId":"p2"'));
 assert.equal(await page.$eval('.collaboration-repairs',node=>node.textContent.includes('"projectId":"p1"')),false);
 const newProjectReads=await page.evaluate(()=>fixture.reads());await page.evaluate(async()=>{fixture.ack();await new Promise(resolve=>setTimeout(resolve,0));});assert.equal(await page.evaluate(()=>fixture.reads()),newProjectReads,'late old-project acknowledgement cannot refresh new project');
 await page.click('.collaboration-details');await page.click('.collaboration-repairs>summary');await page.click('[data-bug-id="retryable"]>summary');
 await page.setViewport({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 assert.equal(await page.$eval('#draft',node=>node.value),'Original unsent draft kept');assert.equal(await page.$eval('#history',node=>node.textContent),'Original thread history');
 assert.deepEqual(errors,[]);await page.screenshot({path:path.join(out,'repair-narrow.png'),fullPage:true});
 const report={ok:true,out,scope:'production renderer in real Electron; deterministic gateway, no native Pi qualification',checks:['owner sleep independent from active repair','decision and review preserved','bounded paging and expanded details survive refresh','exact binding and capability-only retry','version/cursor failures preserve stale disabled facts','pending single flight and close without replay','late project response ignored','draft focus/history preserved','390px no overflow']};await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await fs.writeFile(path.join(out,'report.json'),JSON.stringify({ok:false,out,error:error.stack},null,2));throw error;}
finally{await fs.writeFile(path.join(out,'main.log'),log);await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');await exited;}
