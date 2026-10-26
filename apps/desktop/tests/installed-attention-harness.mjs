import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import puppeteer from 'puppeteer-core';

export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function freePort() { return await new Promise(resolve => { const s=net.createServer(); s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));}); }); }
export async function until(fn,label,timeout=90000) { const end=Date.now()+timeout; while(Date.now()<end){const v=await fn();if(v)return v;await pause(100);} throw Error('timeout: '+label); }
export async function makeHarness(binary) {
  if (!binary || !path.isAbsolute(binary)) throw Error('NOZELI_INSTALLED_BINARY must be an absolute installed release executable');
  const release=path.dirname(binary), app=path.join(release,'resources','app');
  await fs.access(path.join(app,'package.json'));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-installed-attention-'));
  const project=path.join(root,'project'); await fs.mkdir(project); await fs.writeFile(path.join(project,'sample.txt'),'attention recovery proof\n');
  const port=await freePort();
  const env={...process.env,HOME:process.env.NOZELI_TEST_HOME||os.homedir(),NOZELI_TEST_INSTANCE:'1',NOZELI_CONFIG_ROOT:path.join(root,'config'),NOZELI_USER_DATA:path.join(root,'config','desktop'),NOZELI_TEST_PICK:project,NOZELI_DEBUG_PORT:String(port),NOZELI_HIDDEN:'0'};
  for(const key of Object.keys(env)) if(/^(?:CCB_|CODEX_|PI_|OMP_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE_?KEY/i.test(key)) delete env[key];
  delete env.ELECTRON_RUN_AS_NODE; delete env.NOZELI_AGENT_FIXTURE;
  let child,browser,shell,log='';
  async function launch(){child=spawn(binary,['--ozone-platform=wayland'],{cwd:root,env,stdio:['ignore','pipe','pipe']});for(const s of [child.stdout,child.stderr])s.on('data',b=>log+=b);await until(async()=>{if(child.exitCode!==null)throw Error('Installed binary exited: '+log);try{browser=await puppeteer.connect({browserURL:'http://127.0.0.1:'+port,defaultViewport:null});return true;}catch{return false;}},'installed debug endpoint',60000);shell=await until(async()=>{for(const p of await browser.pages())try{if((await p.evaluate(()=>window.__workspaceScope))?.role==='shell')return p;}catch{}},'installed workspace shell',60000);await shell.waitForFunction(()=>window.__nozeliReady);}
  async function invoke(op,p={}){const r=await shell.evaluate(({op,p})=>nozeli.invoke(op,p),{op,p});if(!r.ok)throw Object.assign(Error(op+': '+r.error?.message),{code:r.error?.code});return r.value;}
  async function close(){if(!child)return;const exited=child.exitCode!==null||child.signalCode!==null?Promise.resolve({code:child.exitCode,signal:child.signalCode}):new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));await invoke('session.requestClose');const confirm=shell.waitForSelector('#quit-choice[open]',{timeout:45000}).then(()=>true,()=>false);if(await Promise.race([exited.then(()=>false),confirm])){await fs.writeFile(path.join(root,'exit-confirmation.json'),JSON.stringify({choice:'取消任务并退出',scope:'Owned isolated test instance only'}));await shell.click('#quit-cancel');}const result=await Promise.race([exited,pause(45000).then(()=>null)]);await browser?.disconnect();await fs.writeFile(path.join(root,'main.log'),log);if(!result||result.code!==0||result.signal)throw Error('Installed application did not exit normally: '+JSON.stringify(result));}
  return {root,project,env,port,app,launch,invoke,get browser(){return browser;},get shell(){return shell;},get child(){return child;},close};
}
