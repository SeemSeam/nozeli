// Actual Electron + private Pi Node owners + loopback provider. No user profile.
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

const appRoot=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-pi-electron-'));
const config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),projectRoot=path.join(out,'project');
await fs.mkdir(projectRoot);await fs.writeFile(path.join(projectRoot,'reading.txt'),'Pi GUI source stays unchanged.\n');
const host=new DesktopHost(profile),project=(await host.pick(projectRoot)).project;await host.storage.db.close();
const provider=await serve(()=>({text:'Pi GUI live response.'}));
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
const ozone=process.env.NOZELI_OZONE||(process.env.DISPLAY?'x11':process.env.WAYLAND_DISPLAY?'wayland':'headless');
Object.assign(env,{NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_HIDDEN:'0',NOZELI_OZONE:ozone});
const binary=process.env.NOZELI_TEST_BINARY;
let child,exited;
let log='',browser,shell;const errors=[],result={ok:false,out,checks:[],scope:'Actual Electron/Pi owners and real private files; loopback scripted provider, no paid model or personal credentials'};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function launch(){
 child=spawn(binary||createRequire(import.meta.url)('electron'),[...(binary?[]:[path.join(appRoot,'src/main/main.cjs')]),'--ozone-platform='+ozone],{cwd:projectRoot,env,stdio:['ignore','pipe','pipe']});
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>log+=chunk);
 exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
}
async function until(fn,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;if(child.exitCode!==null)throw Error('Electron exited: '+log);await pause(80);}throw Error('Timed out: '+label);}
async function call(page,op,payload={}){const response=await page.evaluate(({op,payload})=>nozeli.invoke(op,payload),{op,payload});assert.equal(response.ok,true,op+': '+JSON.stringify(response));return response.value;}
async function surface(kind){return until(async()=>{for(const page of await browser.pages())if(await page.evaluate(kind=>window.__nozeliReady&&window.__workspaceScope?.kind===kind,kind).catch(()=>false))return page;},kind+' content surface');}
try{
 launch();
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'ready shell');
 for(const page of await browser.pages())page.on('pageerror',error=>errors.push(error.message));
 await call(shell,'config.initialize',{mode:'independent'});
 if(await shell.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell.click('#configuration-cancel');
 await call(shell,'settings.providers.save',{operation:'create',provider:'gui-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-nonsecret'}});
 await call(shell,'settings.models.save',{frontdesk:{model:{mode:'explicit',selector:'gui-local/scripted'},thinking:{mode:'native-default'}},orchestrator:{model:{mode:'explicit',selector:'gui-local/scripted'},thinking:{mode:'native-default'}},worker:{model:{mode:'explicit',selector:'gui-local/scripted'},thinking:{mode:'native-default'}}});
 const status=await call(shell,'settings.providers.status');assert.equal(status.sources.find(row=>row.provider==='gui-local').credential.configured,true);assert.equal(JSON.stringify(status).includes('local-nonsecret'),false);assert.equal(status.sources.find(row=>row.provider==='gui-local').revision,1);
 result.checks.push('real settings IPC saves private Pi endpoint and three-role defaults without exposing the test key');
 await shell.click('[data-project-id="'+project.id+'"]');
 await shell.waitForSelector('#workspace-open-conversation:not([disabled])',{visible:true});await shell.click('#workspace-open-conversation');
 const conversation=await surface('conversation');conversation.on('pageerror',error=>errors.push(error.message));
 await conversation.waitForFunction(()=>!document.querySelector('#chat-session-model')&&!document.querySelector('#session-model-menu'));
 const current=await call(conversation,'managed.status',{projectId:project.id});assert.equal(current.state.agents.find(row=>row.target==='frontdesk').model,'gui-local/scripted');
 result.checks.push('per-session model switching is absent; the connected owner uses the model configured in project settings');
 const stale=await conversation.evaluate(projectId=>nozeli.invoke('managed.model.set',{projectId,target:'frontdesk',ownerId:'stale-replaced-owner',model:'gui-local/scripted',requestKey:'stale-native-model-owner'}),project.id);
 assert.equal(stale.ok,false);assert.equal(stale.error.code,'INTERACTION_STALE');
 assert.equal((await call(conversation,'managed.status',{projectId:project.id})).state.agents.find(row=>row.target==='frontdesk').ownerId,current.state.agents.find(row=>row.target==='frontdesk').ownerId);
 result.checks.push('host rejects stale session owner even without a conversation model-switch control');
 await conversation.click('#composer');await conversation.type('#composer','Hello Pi GUI');await conversation.click('#send-message');
 await until(async()=>{const state=(await call(conversation,'managed.status',{projectId:project.id})).state;const job=state.jobs.find(row=>row.text==='Hello Pi GUI');if(job?.status==='failed')throw Error(JSON.stringify(job));return job?.status==='completed';},'Pi GUI response');
 await conversation.waitForFunction(()=>document.body.textContent.includes('Pi GUI live response.'));
 assert.equal(provider.requests.length,1);assert.equal(provider.errors.length,0);await conversation.screenshot({path:path.join(out,'pi-conversation.png')});
 result.checks.push('real composer input reaches Pi and its original journal reply renders in the native conversation surface');
 assert.equal(await fs.readFile(path.join(projectRoot,'reading.txt'),'utf8'),'Pi GUI source stays unchanged.\n');
 await conversation.click('#composer');await conversation.type('#composer','Unsent Pi GUI draft');
 await conversation.waitForFunction(()=>document.querySelector('#composer').value==='Unsent Pi GUI draft');
 await conversation.evaluate(()=>{const panel=document.querySelector('#conversation-panel');panel.classList.add('compact-composer');panel.style.flex='0 0 190px';panel.style.width='190px';panel.style.maxWidth='190px';});
 await conversation.waitForFunction(()=>getComputedStyle(document.querySelector('#conversation-panel .composer-wrap')).flexDirection==='column');
 const compactLayout=await conversation.evaluate(()=>{const panel=document.querySelector('#conversation-panel'),box=panel.getBoundingClientRect(),footer=panel.querySelector('.composer-footer'),cm=footer.querySelector('.cm-add'),status=footer.querySelector('#compose-status'),head=panel.querySelector('#conversation-head'),controlsNode=head.querySelector('.conversation-controls'),headerChildren=[...head.children].map(node=>({id:node.id||node.className||node.textContent,tag:node.tagName,text:node.innerText,rect:node.getBoundingClientRect().toJSON(),scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,flexShrink:getComputedStyle(node).flexShrink,whiteSpace:getComputedStyle(node).whiteSpace,buttons:[...node.querySelectorAll('button')].map(button=>({id:button.id,text:button.innerText,rect:button.getBoundingClientRect().toJSON(),flexShrink:getComputedStyle(button).flexShrink,whiteSpace:getComputedStyle(button).whiteSpace,display:getComputedStyle(button).display}))})),controls=[...panel.querySelectorAll('#conversation-head,#composer,.composer-footer,.composer-footer>*')].filter(node=>!node.hidden).map(node=>({id:node.id||node.className,text:node.innerText,rect:node.getBoundingClientRect().toJSON(),clientWidth:node.clientWidth,scrollWidth:node.scrollWidth})),actions=[...panel.querySelectorAll('.composer-footer button')].filter(node=>!node.hidden).map(node=>({id:node.id||node.className,text:node.innerText,height:node.getBoundingClientRect().height,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth}));return {width:box.width,headerChildren,controlsBox:controlsNode.getBoundingClientRect().toJSON(),controlsScroll:controlsNode.scrollWidth,viewportWidth:innerWidth,statusDisplay:getComputedStyle(status).display,footerGrid:getComputedStyle(footer).gridTemplateColumns,cmGrid:[getComputedStyle(cm).gridColumn,getComputedStyle(cm).gridRow],controls,actions,overflow:controls.filter(item=>item.rect.width&&(item.rect.left<box.left-1||item.rect.right>box.right+1)).map(item=>item.id),clippedActions:actions.filter(item=>item.scrollWidth>item.clientWidth+1).map(item=>item.id),modelSwitch:Boolean(document.querySelector('#chat-session-model'))};});
 result.compactLayout=compactLayout;assert(compactLayout.width<=200&&compactLayout.modelSwitch===false&&compactLayout.overflow.length===0&&compactLayout.clippedActions.length===0&&compactLayout.actions.every(item=>item.height<=30),JSON.stringify(compactLayout));await conversation.screenshot({path:path.join(out,'compact-pane-190px.png')});result.checks.push('narrow compact conversation pane keeps action labels legible and inside pane without per-session model switching');
 await call(shell,'session.requestClose');await until(async()=>child.exitCode!==null||await shell.$eval('#quit-choice',node=>node.open).catch(()=>false),'native close or explicit cancellation confirmation');if(child.exitCode===null)await shell.click('#quit-cancel');result.exit=await Promise.race([exited,pause(15000).then(()=>null)]);assert.deepEqual(result.exit,{code:0,signal:null});
 result.checks.push('normal Electron close confirms private Pi owner exit and preserves original source');
 await browser.disconnect();browser=null;launch();
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'cold CDP');
 shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'cold shell');
 await shell.click('[data-project-id="'+project.id+'"]');
 await shell.waitForSelector('#workspace-open-conversation:not([disabled])',{visible:true});await shell.click('#workspace-open-conversation');
 const reopened=await surface('conversation');await reopened.waitForFunction(()=>document.querySelector('#composer').value==='Unsent Pi GUI draft');
 assert.equal(provider.requests.length,1,'cold restore must not replay accepted model input');
 result.checks.push('cold Electron restart restores the unsent native conversation draft without replaying the previous Pi request');
 await call(shell,'session.requestClose');await until(async()=>child.exitCode!==null||await shell.$eval('#quit-choice',node=>node.open).catch(()=>false),'cold native close or explicit cancellation confirmation');if(child.exitCode===null)await shell.click('#quit-cancel');assert.deepEqual(await Promise.race([exited,pause(15000).then(()=>null)]),{code:0,signal:null});
 assert.deepEqual(errors,[]);result.ok=true;
}catch(error){result.error=error.stack;process.exitCode=1;if(browser)for(const page of await browser.pages())await Promise.race([page.screenshot({path:path.join(out,'failure-'+page.target()._targetId+'.png')}).catch(()=>{}),pause(2000)]);}
finally{
 await browser?.disconnect();if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([exited,pause(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}
 await provider.close();await fs.writeFile(path.join(out,'report.json'),JSON.stringify({...result,errors,requests:provider.requests},null,2));await fs.writeFile(path.join(out,'main.log'),log);console.log(JSON.stringify(result,null,2));
}
