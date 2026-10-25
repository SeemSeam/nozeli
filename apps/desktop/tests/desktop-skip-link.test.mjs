import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import puppeteer from 'puppeteer-core';

const root=path.resolve(import.meta.dirname,'..'),out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-skip-link-'));
const configRoot=path.join(out,'.Nozeli'),profile=path.join(configRoot,'desktop');
const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const env={...process.env};for(const key of Object.keys(env))if(/^(NOZELI_|CCB_|CODEX_|OMP_|PI_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key))delete env[key];
Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:configRoot,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_SHOT_DIR:out,NOZELI_HIDDEN:'0'});
const child=spawn(createRequire(import.meta.url)('electron'),[path.join(root,'src/main/main.cjs'),'--ozone-platform=wayland'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
let log='',browser,page;for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk;});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),report={out,checks:[],scenes:[]};
async function until(fn,label){const end=Date.now()+25000;do{if(child.exitCode!==null)throw Error(log);const value=await fn();if(value)return value;await pause(80);}while(Date.now()<end);throw Error('Timeout: '+label);}
async function invoke(op,payload={}){const result=await page.evaluate((op,payload)=>window.nozeli.invoke(op,payload),op,payload);assert.equal(result.ok,true,JSON.stringify(result.error));return result.value;}
try{
 await until(async()=>{try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'debug endpoint');
 page=await until(async()=>{for(const candidate of await browser.pages()){if(await candidate.evaluate(()=>window.__nozeliReady===true&&window.__workspaceScope?.role==='shell').catch(()=>false))return candidate;}},'ready shell');
 if(await page.$('#configuration-setup[open]')){await page.click('#configuration-cancel');await page.waitForFunction(()=>!document.querySelector('#configuration-setup').open);}
 for(const [width,height]of [[1440,900],[480,700]]){
  await invoke('session.resize',{width,height});await page.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height,{}, {width,height});
  await page.focus('.skip');await page.keyboard.press('Tab');await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');
  const state=await page.evaluate(()=>{
   const link=document.querySelector('.skip'),rect=link.getBoundingClientRect(),logo=document.querySelector('.nozeli-window-logo')?.getBoundingClientRect();
   const hit=([x,y])=>{const node=document.elementFromPoint(x,y);return node===link||link.contains(node);};
   return{focused:document.activeElement===link,rect:rect.toJSON(),logo:logo?.toJSON(),hitPoints:[[rect.left+2,rect.top+2],[rect.right-2,rect.top+2],[rect.left+rect.width/2,rect.top+rect.height/2],[rect.right-2,rect.bottom-2]].map(hit),appRegion:getComputedStyle(link).getPropertyValue('-webkit-app-region')};
  });
  report.scenes.push({width,height,...state});await page.screenshot({path:path.join(out,'focused-'+width+'.png')});
  assert.equal(state.focused,true,'Shift+Tab returns to the keyboard reading shortcut');
  assert(state.rect.left>=0&&state.rect.top>=0&&state.rect.right<=width&&state.rect.bottom<=height,'the complete link fits the viewport');
  assert(state.hitPoints.every(Boolean),'the whole reading shortcut is above the titlebar and logo, not obscured');
  assert(state.rect.bottom<=state.logo.top||state.rect.top>=state.logo.bottom||state.rect.right<=state.logo.left||state.rect.left>=state.logo.right,'the focused shortcut does not overlap the product mark');
  await page.keyboard.press('Enter');await page.waitForFunction(()=>document.activeElement?.id==='reader');
  assert.equal(await page.$eval('.skip',node=>{const rect=node.getBoundingClientRect();return rect.bottom<=0||rect.top>=innerHeight;}),true,'after activation the shortcut leaves the visible surface');
  await page.focus('.skip');await page.click('.skip');await page.waitForFunction(()=>document.activeElement?.id==='reader');
 }
 assert.equal((await invoke('workspace.bootstrap')).role,'shell','skip activation retains the authorized window identity');
 assert.equal(await page.evaluate(()=>location.hash),'','skip activation does not navigate the window');
 report.checks.push('wide and narrow: keyboard focus exposes a complete non-overlapping shortcut','Enter and real pointer click move focus to the reader','blur hides the shortcut without changing the logo');
 const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));await invoke('session.requestClose').catch(error=>{if(!/closed/i.test(error.message))throw error;});report.exit=await Promise.race([exit,pause(15000).then(()=>null)]);assert.deepEqual(report.exit,{code:0,signal:null});report.ok=true;
}catch(error){report.failure=error.stack;process.exitCode=1;console.error(error.stack);}
finally{await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'electron.log'),log);await browser?.disconnect();if(child.exitCode===null&&child.signalCode===null){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await Promise.race([exit,pause(3000)]);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}console.log(JSON.stringify(report,null,2));}
