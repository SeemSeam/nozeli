// Isolated real Nozeli shell with a Demo-only Store panel. No daily profile or production wiring.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const app=path.resolve(import.meta.dirname,'../../../apps/desktop'),require=createRequire(path.join(app,'package.json')),puppeteer=require('puppeteer-core');
const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-store-integrated-')),config=path.join(out,'config'),profile=path.join(config,'desktop');
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const env={...process.env};for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
Object.assign(env,{NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0',NOZELI_PI_NODE:process.execPath});
const child=spawn(require('electron'),[path.join(app,'src/main/main.cjs'),'--ozone-platform=x11'],{cwd:app,env,stdio:['ignore','pipe','pipe']});
let log='',browser,shell;const errors=[];for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{log+=b;});
const exited=new Promise(resolve=>child.once('exit',resolve));
async function until(fn,label){const end=Date.now()+45000;while(Date.now()<end){if(child.exitCode!==null)throw Error(log);const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,75));}throw Error('Timeout '+label);}
try{
 browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null}).catch(()=>null),'browser');
 shell=await until(async()=>{for(const p of await browser.pages())if(await p.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return p;},'shell');
 shell.on('pageerror',e=>errors.push(e.message));
 if(await shell.$('#configuration-setup[open]'))await shell.click('#configuration-cancel');
 const html=await fs.readFile(path.join(import.meta.dirname,'index.html'),'utf8'),css=await fs.readFile(path.join(import.meta.dirname,'style.css'),'utf8'),script=await fs.readFile(path.join(import.meta.dirname,'app.mjs'),'utf8');
 await shell.evaluate(({html,css})=>{
  const drawing=document.getElementById('workspace-drawing'),entry=document.createElement('button');entry.id='store-demo-launch';entry.type='button';entry.className='rail-action';entry.setAttribute('aria-label','Store · 交互演示');entry.title='Store · 交互演示';entry.innerHTML='<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 9h16v12H4zM3 9l2-6h14l2 6M8 21v-7h8v7M3 9c0 3 4 3 4 0 0 3 5 3 5 0 0 3 5 3 5 0 0 3 4 3 4 0"/></svg>';drawing.before(entry);
  const panel=document.createElement('section');panel.id='store-integrated-panel';panel.hidden=true;panel.setAttribute('aria-label','Store 融合交互Demo');panel.style.cssText='position:fixed;left:56px;right:0;top:40px;bottom:0;z-index:120;background:var(--paper,#fffefa);display:flex;flex-direction:column';
  const head=document.createElement('div');head.style.cssText='display:flex;align-items:center;gap:16px;padding:10px 18px;border-bottom:1px solid var(--line);flex:none';const back=document.createElement('button');back.id='store-demo-back';back.textContent='← 返回工作区';back.type='button';const note=document.createElement('span');note.textContent='Store 融合 Demo · 独立内存，不安装、不派工';note.style.cssText='font-size:12px;color:var(--muted)';head.append(back,note);
  const iframe=document.createElement('iframe');iframe.id='store-demo-frame';iframe.title='Nozeli Store 交互演示';iframe.style.cssText='border:0;flex:1;min-height:0;width:100%';
  const nonce=document.querySelector('meta[name="nozeli-style-nonce"]')?.content||'';
  iframe.srcdoc=html.replace('<link rel="stylesheet" href="./style.css">','<style nonce="'+nonce+'">'+css+'</style>').replace('<script type="module" src="./app.mjs"></script>','').replace('href="./index.html"','href="#"');
  panel.append(head,iframe);document.body.append(panel);
  panel.style.display='none';entry.onclick=()=>{panel.hidden=false;panel.style.display='flex';entry.setAttribute('aria-pressed','true');back.focus();};back.onclick=()=>{panel.hidden=true;panel.style.display='none';entry.setAttribute('aria-pressed','false');entry.focus();};
  window.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden&&document.activeElement!==iframe)back.click();});
 },{html,css});
 const frame=await until(async()=>{const f=await (await shell.$('#store-demo-frame')).contentFrame();return f&&await f.$('#main')?f:null;},'Store frame');
 await frame.evaluate(script);
 await shell.click('#store-demo-launch');await frame.waitForSelector('[data-resource="researcher"]');
 const geometry=await shell.evaluate(()=>{const a=document.getElementById('store-demo-launch'),b=document.getElementById('workspace-drawing'),ar=a.getBoundingClientRect(),br=b.getBoundingClientRect();return {adjacent:a.nextElementSibling===b,above:ar.bottom<=br.top+1,left:ar.left,store:ar.toJSON(),drawing:br.toJSON()};});assert(geometry.adjacent&&geometry.above);
 await shell.screenshot({path:path.join(out,'store-open.png')});
 await frame.click('[data-resource="researcher"] [data-action="detail"]');await frame.waitForSelector('#dialog[open]');await shell.screenshot({path:path.join(out,'store-detail.png')});await frame.click('#dialog-actions [data-action="close"]');
 await shell.click('#store-demo-back');assert.equal(await shell.$eval('#store-integrated-panel',n=>n.hidden),true);await shell.screenshot({path:path.join(out,'workspace-entry.png')});
 await shell.click('#store-demo-launch');await frame.click('[data-view="installed"]');await shell.click('#store-demo-back');await shell.click('#store-demo-launch');assert.match(await frame.$eval('#main',n=>n.textContent),/你的资源库/);
 await frame.click('[data-view="discover"]');assert.deepEqual(errors,[]);
 const report={ok:true,out,port,pid:child.pid,geometry,errors,checks:['real isolated Nozeli shell','Store immediately above drawing in lower-left rail','in-app Store detail and return','reopen preserves Store memory view'],scope:'Demo injection in isolated Electron only; no production Store IPC, accounts, projects, downloads or model calls'};await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'main.log'),log);console.log('NOZELI_STORE_INTEGRATED_READY '+JSON.stringify(report));await browser.disconnect();browser=null;await exited;
}catch(error){console.error(error);await fs.writeFile(path.join(out,'main.log'),log);await shell?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});await browser?.disconnect();if(child.exitCode===null)child.kill('SIGTERM');process.exitCode=1;}
