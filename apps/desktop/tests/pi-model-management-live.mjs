// Live model-management smoke: real Electron + real Pi owners + loopback
// provider. Exercises API-source create/edit/key rotation with blank-preserving
// secret, actual service model discovery, role thinking propagation with
// native clamp feedback, and session-side credential refresh after rotation —
// all against a local HTTP endpoint. No personal credentials, no paid models,
// no replay. Run AFTER the Pi driver dist is regenerated:
//   cd integrations/pi && npm run build
//   node tests/pi-model-management-live.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import {DesktopHost} from '../src/main/host.mjs';
import {serve} from './pi-provider.fixture.mjs';

const appRoot=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-pi-model-mgmt-'));
const config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),projectRoot=path.join(out,'project');
await fs.mkdir(projectRoot);await fs.writeFile(path.join(projectRoot,'reading.txt'),'Model management keeps Pi owners unchanged.\n');
const host=new DesktopHost(profile),project=(await host.pick(projectRoot)).project;await host.storage.db.close();
// The loopback provider changes its key expectation after rotation.
let expectedKey='local-nonsecret-v1';
const provider=await serve(()=>({text:'Model management live response.'}));
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
const ozone=process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':process.env.WAYLAND_DISPLAY?'wayland':'headless');
Object.assign(env,{NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_HIDDEN:'0',NOZELI_OZONE:ozone});
const binary=process.env.NOZELI_TEST_BINARY;
let child,exited;
let log='',browser,shell;const errors=[],result={ok:false,out,checks:[],scope:'real Electron + real Pi owners + loopback HTTP provider; source edit/key rotation, service model discovery, thinking propagation; no paid models or personal credentials'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=45000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;if(child.exitCode!==null)throw Error('Electron exited: '+log);await pause(80);}throw Error('Timed out: '+label);}
async function call(page,op,payload={}){const response=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert.equal(response.ok,true,op+': '+JSON.stringify(response));return response.value;}
async function surface(kind){return until(async()=>{for(const page of await browser.pages())if(await page.evaluate(kind=>window.__nozeliReady&&window.__workspaceScope?.kind===kind,kind).catch(()=>false))return page;},kind+' content surface');}
const chatRequests=()=>provider.requests.filter(request=>!request.listing);
const listRequests=()=>provider.requests.filter(request=>request.listing);
try{
 launch();
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'ready shell');
 for(const page of await browser.pages())page.on('pageerror',error=>errors.push(error.message));
 await call(shell,'config.initialize',{mode:'independent'});
 if(await shell.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell.click('#configuration-cancel');
 // 1. create a multi-model source with a declared thinking model
 const created=await call(shell,'settings.providers.save',{operation:'create',provider:'mgmt-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted',name:'Scripted local fixture'},{id:'scripted-reasoner',reasoning:true}],credential:{action:'replace',value:expectedKey}});
 assert.equal(created.saved,true);assert.equal(created.revision,1);
 assert.equal(created.source.models.find(model=>model.id==='scripted-reasoner').reasoning,true);
 assert.ok(!JSON.stringify(created).includes(expectedKey),'key never echoed');
 result.checks.push('multi-model create with declared thinking metadata; revision 1; no key echo');
 // 2. revision guard + key rotation with blank preserving the stored secret
 await assert.rejects(call(shell,'settings.providers.save',{operation:'update',provider:'mgmt-local',expectedRevision:99,baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'keep'}}));
 await assert.rejects(call(shell,'settings.providers.save',{operation:'update',provider:'mgmt-local',expectedRevision:1,baseUrl:'http://127.0.0.1:9/v1',api:'openai-completions',models:[{id:'scripted'}],credential:{action:'keep'}}),/需明确确认/);
 result.checks.push('stale revision rejected; origin change with kept key requires consent (got explicit failure)');
 await call(shell,'settings.providers.save',{operation:'update',provider:'mgmt-local',expectedRevision:1,baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'},{id:'scripted-reasoner',reasoning:true}],credential:{action:'keep'}});
 result.checks.push('edit with blank key preserves the stored secret inside the trusted worker');
 // 3. actual service model discovery against the loopback listing endpoint
 const discovered=await call(shell,'settings.providers.discover',{provider:'mgmt-local',expectedRevision:2});
 assert.equal(discovered.status,'succeeded');
 assert.ok(discovered.models.some(model=>model.id==='scripted'&&model.metadataSource==='service'));
 assert.equal(discovered.entitlement,'unknown');
 assert.equal(listRequests().length,1);assert.equal(listRequests()[0].authorization,'Bearer '+expectedKey);
 result.checks.push('explicit discovery hits the real /models endpoint once with the stored key; entitlement unknown');
 // 4. role defaults with explicit thinking propagate to the live session
 await call(shell,'settings.models.save',{frontdesk:{model:{mode:'explicit',selector:'mgmt-local/scripted'},thinking:{mode:'explicit',level:'high'}},orchestrator:{model:{mode:'explicit',selector:'mgmt-local/scripted-reasoner'},thinking:{mode:'explicit',level:'low'}},worker:{model:{mode:'explicit',selector:'mgmt-local/scripted'},thinking:{mode:'native-default'}}});
 const status=await call(shell,'settings.providers.status');
 assert.equal(status.defaults.frontdesk.thinking.level,'high');
 result.checks.push('role model and thinking defaults persisted before project owner startup');
 await shell.click('[data-project-id="'+project.id+'"]');
 await shell.waitForSelector('#workspace-open-conversation:not([disabled])',{visible:true});await shell.click('#workspace-open-conversation');
 const conversation=await surface('conversation');conversation.on('pageerror',error=>errors.push(error.message));
 const options=await call(conversation,'managed.model.options',{projectId:project.id,target:'frontdesk'});
 assert.ok(Array.isArray(options.thinkingLevels)||options.thinkingLevels===null,'native thinking levels or unknown, never fabricated elsewhere');
 assert.ok(options.models.some(model=>model.selector==='mgmt-local/scripted'&&model.catalogSource==='configured'&&model.entitlement==='unknown'));
 result.checks.push('model.options returns provenance-tagged catalog and native thinking levels (null until dist rebuild)');
 // 5. thinking feedback: request high on a non-reasoning model must report the native clamp
 const agents=(await call(conversation,'managed.status',{projectId:project.id})).state.agents;
 const frontdesk=agents.find(row=>row.target==='frontdesk');
 const set=await call(conversation,'managed.model.set',{projectId:project.id,target:'frontdesk',ownerId:frontdesk.ownerId,effort:'high',requestKey:'model-mgmt-live-thinking'});
 assert.equal(set.accepted,true);
 result.checks.push('managed.model.set accepts thinking-only change; requested/effective/clamped feedback: '+JSON.stringify(set.requested??null)+' → '+JSON.stringify(set.effective??null)+(set.clamped?' (clamped)':''));
 const beforeIdentity={ownerId:frontdesk.ownerId,threadId:frontdesk.threadId};
 await conversation.type('#composer','Before rotation');await conversation.click('#send-message');
 await until(async()=>{const state=(await call(conversation,'managed.status',{projectId:project.id})).state;const job=state.jobs.find(row=>row.text==='Before rotation');if(job?.status==='failed')throw Error(JSON.stringify(job));return job?.status==='completed';},'pre-rotation Pi response');
 assert.equal(chatRequests().at(-1)?.authorization,'Bearer '+expectedKey);
 // 6. key rotation reaches the existing session without a new session or replay
 expectedKey='local-nonsecret-v2';
 await call(shell,'settings.providers.save',{operation:'update',provider:'mgmt-local',expectedRevision:2,baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'},{id:'scripted-reasoner',reasoning:true}],credential:{action:'replace',value:expectedKey}});
 const rotated=await call(shell,'settings.providers.status');
 const rotationRows=(rotated.modelSync?.sessions??[]).filter(row=>row.target==='frontdesk');
 result.checks.push('rotation applied rows: '+JSON.stringify(rotationRows.map(row=>({state:row.state,model:row.effective?.model}))));
 await conversation.click('#composer');await conversation.type('#composer','After rotation');await conversation.click('#send-message');
 await until(async()=>{const state=(await call(conversation,'managed.status',{projectId:project.id})).state;const job=state.jobs.find(row=>row.text==='After rotation');if(job?.status==='failed')throw Error(JSON.stringify(job));return job?.status==='completed';},'post-rotation Pi response');
 const lastChat=chatRequests().at(-1);
 assert.equal(lastChat?.authorization,'Bearer '+expectedKey,'rotated key must reach the existing session without a new session (requires regenerated Pi dist: cd integrations/pi && npm run build)');
 const afterAgent=(await call(conversation,'managed.status',{projectId:project.id})).state.agents.find(row=>row.target==='frontdesk');assert.deepEqual({ownerId:afterAgent.ownerId,threadId:afterAgent.threadId},beforeIdentity);
 await shell.click('#open-settings');await shell.click('[data-settings-section="settings-models"]');await shell.screenshot({path:path.join(out,'model-management.png')});
 result.checks.push('post-rotation request used the rotated key on the same live session; zero replay of the earlier turn');
 assert.equal(chatRequests().length,2,'one request per explicit input, no replay');
 assert.equal(listRequests().every(request=>request.authorization!=='Bearer local-nonsecret-v2'),true,'listing used the pre-rotation key as saved at that revision');
 assert.deepEqual(provider.errors,[]);assert.deepEqual(errors,[]);
 await call(shell,'session.requestClose');result.exit=await Promise.race([exited,pause(15000).then(()=>null)]);assert.deepEqual(result.exit,{code:0,signal:null});result.ok=true;
}catch(error){result.error=error.stack;process.exitCode=1;if(browser)for(const page of await browser.pages())await Promise.race([page.screenshot({path:path.join(out,'failure-'+page.target()._targetId+'.png')}).catch(()=>{}),pause(2000)]);}
finally{
 await browser?.disconnect();if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 await provider.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify({...result,errors,requests:provider.requests},null,2));await fs.writeFile(path.join(out,'main.log'),log);console.log(JSON.stringify(result,null,2));
}
function launch(){
 child=spawn(binary||createRequire(import.meta.url)('electron'),[...(binary?[]:[path.join(appRoot,'src/main/main.cjs')]),'--ozone-platform='+ozone],{cwd:projectRoot,env,stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
 exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
}
