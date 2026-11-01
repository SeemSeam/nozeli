// Actual production Electron and host; isolated synthetic credentials, no model or discovery requests.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import {observeResponses} from './response-observer.fixture.mjs';
const root=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-provider-ui-'));
const config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop');
const report={out,scope:'Actual Electron production renderer/host, isolated synthetic configuration; no model/discovery requests',checks:[],screenshots:[],errors:[]};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const port=async()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
const debugPort=await port(),inspectPort=await port();
const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY/i.test(key)))delete env[key];
Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(debugPort),NOZELI_SHOT_DIR:out,NOZELI_HIDDEN:'0'});
const binary=process.env.NOZELI_TEST_BINARY||createRequire(import.meta.url)('electron');
const child=spawn(binary,[...(process.env.NOZELI_TEST_BINARY?[]:[path.join(root,'src/main/main.cjs')]),'--ozone-platform='+(process.env.NOZELI_OZONE||'wayland'),'--inspect='+inspectPort],{cwd:os.tmpdir(),env,stdio:['ignore','pipe','pipe']});
let browser,shell,observer,log='',launchError;child.on('error',error=>{launchError=error;});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
async function until(fn,label){const end=Date.now()+90000;do{if(launchError)throw launchError;if(child.exitCode!==null||child.signalCode)throw Error('Electron exited during '+label+'\n'+log);const value=await fn();if(value)return value;await pause(80);}while(Date.now()<end);throw Error('Timeout '+label);}
async function call(op,payload={}){const result=await shell.evaluate((op,payload)=>nozeli.invoke(op,payload),op,payload);assert.equal(result.ok,true,op+': '+JSON.stringify(result.error));return result.value;}
async function tab(id){await shell.click('[data-settings-section="'+id+'"]');await shell.waitForSelector('#'+id+':not([hidden])');}
async function shot(label){await shell.screenshot({path:path.join(out,label+'.png')});report.screenshots.push(label+'.png');}
try{
 await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+debugPort,defaultViewport:null});return true;}catch{return false;}},'debug endpoint');
 shell=await until(async()=>{for(const page of await browser.pages()){if(await page.evaluate(()=>window.__workspaceScope?.role==='shell'&&window.__nozeliReady).catch(()=>false))return page;}},'production shell');
 shell.on('pageerror',error=>report.errors.push(error.stack));observer=await observeResponses(inspectPort);
 await call('config.initialize',{mode:'independent'});if(await shell.$eval('#configuration-setup',node=>node.open))await shell.click('#configuration-cancel');
 await call('session.resize',{width:985,height:900});await shell.setViewport({width:985,height:900});
 await shell.click('#open-settings');await tab('settings-provider');
 const provider='settings-ui-models',otherProvider='settings-ui-other';
 const fixtureModels=Array.from({length:80},(_,index)=>({id:'model-'+String(index+1).padStart(3,'0')}));
 for(const name of [provider,otherProvider])await call('settings.providers.save',{operation:'create',provider:name,baseUrl:'https://settings-ui.invalid/v1',api:'openai-completions',credential:{action:'replace',value:'synthetic-not-a-real-key'},models:name===provider?fixtureModels:[{id:'other-model'}]});
 await shell.waitForFunction(()=>!document.querySelector('[data-provider-refresh]').disabled);await shell.click('[data-provider-refresh]');await shell.waitForSelector('[data-provider-row="'+provider+'"]');await shot('provider-simple-list');
 const panel='[data-provider-model-panel="'+provider+'"]';await shell.click(panel+' summary');await shell.waitForSelector(panel+' [data-provider-model-list] li');assert.equal(await shell.$$eval(panel+' li',rows=>rows.length),80);await shot('provider-models-expanded');
 await shell.type(panel+' input[type="search"]','model-080');assert.equal(await shell.$$eval(panel+' li',rows=>rows.length),1);assert.equal(await shell.$eval(panel+' li',row=>row.textContent),'model-080');await shot('provider-models-filtered');report.checks.push('80 configured models and local search');
 await call('settings.models.save',{frontdesk:{model:{mode:'explicit',selector:provider+'/model-001'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'native-default'},thinking:{mode:'native-default'}},worker:{model:{mode:'native-default'},thinking:{mode:'native-default'}}});
 const remove='[data-provider-remove="'+provider+'"]',confirm='[data-provider-confirm-remove="'+provider+'"]';
 await shell.click(remove);await shell.click(remove);assert.equal(await shell.$$eval('[data-provider-removal]',rows=>rows.length),1);
 await shell.click('[data-provider-remove="'+otherProvider+'"]');assert.equal(await shell.$$eval('[data-provider-removal]',rows=>rows.length),1);await shell.click(remove);
 await shell.click(confirm);await shell.waitForFunction(()=>!!document.querySelector('[data-provider-removal-error]')?.textContent&&!document.querySelector('[data-provider-confirm-remove]')?.disabled);
 assert.equal(await shell.$$eval('[data-provider-removal]',rows=>rows.length),1);await shell.click(remove);assert.equal(await shell.$$eval('[data-provider-confirm-remove]',rows=>rows.length),1);await shot('provider-referenced-remove-error');
 const statusRequests=(await observer.events()).filter(event=>event.op==='settings.providers.status').length;
 await shell.click('[data-provider-cancel-remove]');assert.equal(await shell.$$eval('[data-provider-removal]',rows=>rows.length),0);assert.equal((await observer.events()).filter(event=>event.op==='settings.providers.status').length,statusRequests);assert((await call('settings.providers.status')).sources.some(source=>source.provider===provider));report.checks.push('Singleton confirmation across repeated/cross-source/async attempts; real referenced rejection; local cancellation');
 await call('session.resize',{width:390,height:900});await shell.setViewport({width:390,height:900});await tab('settings-appearance');await shell.select('[data-appearance="theme"]','dark');await tab('settings-provider');await shell.waitForSelector('[data-provider-row="'+provider+'"]');await shell.waitForFunction(()=>!document.querySelector('[data-provider-refresh]').disabled);await shot('provider-narrow-dark');
 assert(await shell.$eval('#settings-provider',node=>node.scrollWidth<=node.clientWidth+1));await shell.click(remove);await shot('provider-narrow-confirm');assert(await shell.$eval('[data-provider-removal]',node=>node.scrollWidth<=node.clientWidth+1));await shell.click('[data-provider-cancel-remove]');report.checks.push('390px dark source list and removal confirmation fit content width');
 await call('settings.models.save',Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>[role,{model:{mode:'native-default'},thinking:{mode:'native-default'}}])));
 await shell.click(remove);await observer.hold('settings.providers.remove');await shell.click(confirm);await until(()=>observer.held('settings.providers.remove'),'held successful removal');await shell.$eval(remove,node=>node.click());assert.equal(await shell.$$eval('[data-provider-removal]',rows=>rows.length),1);assert(await shell.$eval(confirm,node=>node.disabled));await observer.release('settings.providers.remove');await shell.waitForFunction(provider=>!document.querySelector('[data-provider-row="'+provider+'"]'),{},provider);assert.equal(await shell.$$eval('[data-provider-removal]',rows=>rows.length),0);
 await call('settings.providers.remove',{provider:otherProvider,confirm:otherProvider});report.checks.push('Successful removal after clearing role references');
 assert.deepEqual(report.errors,[]);observer.close();observer=null;await call('session.requestClose');const closed=await Promise.race([exit,pause(15000).then(()=>null)]);assert.equal(closed?.code,0);report.checks.push('Normal production exit0');report.pass=true;
}catch(error){report.failure=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{observer?.close();await browser?.disconnect();if(child.exitCode===null&&!child.signalCode){child.kill('SIGTERM');await Promise.race([exit,pause(5000)]);if(child.exitCode===null&&!child.signalCode){child.kill('SIGKILL');await exit;}}await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);console.log(JSON.stringify(report,null,2));}
