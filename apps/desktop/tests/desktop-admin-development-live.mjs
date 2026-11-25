// Actual Electron surface and native Skill, private profile and localhost provider only.
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
const require=createRequire(import.meta.url),app=path.resolve(import.meta.dirname,'..');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-development-electron-')),config=path.join(out,'config'),profile=path.join(config,'desktop');
const host=new DesktopHost(profile),root=path.join(out,'explicit-development-copy');await fs.mkdir(root);await fs.writeFile(path.join(root,'README.md'),'Isolated development copy.');const project=await host.storage.register(root);await host.storage.db.close();
let finishTurn;const heldTurn=new Promise(resolve=>finishTurn=resolve);
const provider=await serve(async(request,round)=>{
 if(round===1)return {tool:'read',id:'development-skill',args:{path:path.join(app,'src/agents/admin/roles/admin/skills/nozeli-admin-development/SKILL.md')}};
 if(round===2)return {tool:'nozeli_admin_prepare_development',id:'prepare-development',args:{projectId:project.id,kind:'skill',request:'Create a local reading skill. Validate actual native loading. Do not install or push.'}};
 assert.equal(round,3);await heldTurn;return {text:'已准备开发交接；未提交任务。'};
});
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'});
const child=spawn(require('electron'),[path.join(app,'src/main/main.cjs'),'--ozone-platform=x11'],{cwd:out,env,stdio:['ignore','pipe','pipe']});let log='',browser,shell;for(const stream of [child.stdout,child.stderr])stream.on('data',b=>log+=b);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+60000;while(Date.now()<end){if(provider.errors.length)throw provider.errors[0];if(child.exitCode!==null)throw Error(log);const v=await fn();if(v)return v;await pause(100);}throw Error('Timeout '+label+' '+log.slice(-1500));}
async function invoke(op,payload={}){const r=await shell.evaluate(({op,payload})=>window.nozeli.invoke(op,payload),{op,payload});assert.ok(r.ok,JSON.stringify(r));return r.value;}
const report={ok:false,out,checks:[],errors:[],scope:'Linux isolated actual Electron UI; native localhost scripted provider, no model-quality or completed-development claim'};
try{
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'CDP');
 shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');shell.on('pageerror',e=>report.errors.push(e.message));
 if(await shell.$eval('#configuration-setup',n=>n.open).catch(()=>false))await shell.click('#configuration-cancel');
 await invoke('config.initialize',{mode:'independent'});
 await invoke('settings.providers.save',{operation:'create',provider:'development-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted',reasoning:false}],credential:{action:'replace',value:'local-nonsecret'}});
 await invoke('admin.configure',{model:'development-local/scripted',effort:null,expectedRevision:0});
 await invoke('admin.send',{text:'Prepare development in the explicitly identified project.',requestKey:'development-native-ui',draftRevision:0});
 const state=await until(async()=>{const s=await invoke('admin.status');return s.pendingChanges.some(p=>p.kind==='development')?s:null;},'development proposal');
 const proposal=state.pendingChanges.find(p=>p.kind==='development');assert.equal(proposal.project.id,project.id);
 await shell.evaluate(()=>window.dispatchEvent(new Event('nozeli-open-admin')));await shell.waitForSelector('[data-admin-development-consent]');
 const confirm='[data-admin-confirm="'+proposal.id+'"]';assert.equal(await shell.$eval(confirm,n=>n.disabled),true);
 assert.equal(await shell.$eval('[data-admin-development-consent]',n=>n.disabled),true);assert.equal((await invoke('admin.status')).busy,true);
 finishTurn();await until(async()=>!await shell.$eval('[data-admin-development-consent]',n=>n.disabled),'idle enables renewed consent');report.checks.push('actual management inference disables development consent and confirmation; idle restores consent without a false unknown lock');
 const card=await shell.$eval('[data-admin-proposal-kind="development"]',n=>n.textContent);for(const text of ['沙箱','上下文','本地 Git','实际派工',project.id])assert.ok(card.includes(text),text);
 await shell.$eval('[data-admin-development-consent]',n=>n.scrollIntoView({block:'center'}));await shell.click('[data-admin-development-consent]');assert.equal(await shell.$eval(confirm,n=>n.disabled),false);
 await shell.screenshot({path:path.join(out,'development-confirm.png')});report.checks.push('native Skill creates exact-project proposal; unchecked confirmation disabled; all execution boundaries visible');
 await shell.$eval(confirm,n=>n.scrollIntoView({block:'center'}));await shell.click(confirm);
 await until(async()=>{const s=await invoke('admin.status');return s.pendingChanges.find(p=>p.id===proposal.id)?.receipt;},'blocked receipt');
 await until(()=>shell.$('[data-admin-development-receipt="blocked"]'),'blocked UI');
 assert.equal(await shell.$(confirm),null);report.checks.push('unconnected project rejected without implicit connection or repeat-submit control');
 await shell.screenshot({path:path.join(out,'development-blocked.png')});assert.deepEqual(report.errors,[]);report.ok=true;
}catch(error){report.error=error.stack;process.exitCode=1;await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{finishTurn();await browser?.disconnect();if(child.exitCode===null){child.kill('SIGTERM');await pause(1000);if(child.exitCode===null)child.kill('SIGKILL');}await provider.close();await fs.writeFile(path.join(out,'main.log'),log);await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
