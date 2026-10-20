import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

// Test-only observer/control over the owned packaged process's main Inspector.
// It never loads a different main, changes installed bytes, or adds recovery UI.
export class MainObserver {
 static async connect(url){
  assert.match(url,/^ws:\/\/127\.0\.0\.1:\d+\//);
  const client=new MainObserver();client.socket=new WebSocket(url);
  client.socket.addEventListener('message',event=>{const m=JSON.parse(String(event.data)),p=client.pending.get(m.id);if(p){client.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
  client.socket.addEventListener('close',()=>{for(const p of client.pending.values()){clearTimeout(p.timer);p.reject(Error('Owned Inspector closed'));}client.pending.clear();});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{client.socket.close();reject(Error('Owned Inspector connect timeout'));},7000);client.socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});client.socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('Inspector connect failed'));},{once:true});});return client;
 }
 constructor(){this.pending=new Map();this.next=0;}
 rpc(method,params,ms=7000){const id=++this.next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Inspector timeout '+method));},ms);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
 async evaluate(expression,ms=7000){const r=await this.rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},ms);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
 async install(auditDir,tag){return this.evaluate(`(()=>{
  const req=process.mainModule.require.bind(process.mainModule),{BrowserWindow}=req('electron'),fs=req('node:fs'),path=req('node:path');
  const win=BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());if(!win)throw Error('No owned window');
  const dir=${JSON.stringify(auditDir)},tag=${JSON.stringify(tag)},wc=win.webContents;
  const trace=(type,details={})=>fs.appendFileSync(path.join(dir,'events.jsonl'),JSON.stringify({type,at:Date.now(),details})+String.fromCharCode(10),{mode:0o600});
  const sends=[];let responsive=true;const originalTitle=win.getTitle();
  for(const event of ['unresponsive','responsive','closed'])win.on(event,()=>{if(event==='unresponsive')responsive=false;if(event==='responsive')responsive=true;trace(event);});
  win.on('close',event=>trace('close',{prevented:event.defaultPrevented}));
  wc.on('render-process-gone',(_,details)=>trace('render-process-gone',details));
  wc.on('did-finish-load',()=>trace('did-finish-load',{url:wc.getURL()}));
  const send=wc.send.bind(wc);wc.send=(channel,...args)=>{if(['nozeli:flush','nozeli:open-request','nozeli:quit-confirm'].includes(channel)){const row={channel,requestId:channel==='nozeli:flush'?args[0]:null,at:Date.now()};sends.push(row);trace('send',row);}return send(channel,...args);};
  const state=()=>({pid:process.pid,windowId:win.id,destroyed:win.isDestroyed(),visible:!win.isDestroyed()&&win.isVisible(),title:!win.isDestroyed()?win.getTitle():null,originalTitle,responsive,rendererPid:!wc.isDestroyed()?wc.getOSProcessId():null,crashed:!wc.isDestroyed()&&wc.isCrashed(),sends:[...sends],windows:BrowserWindow.getAllWindows().map(w=>({id:w.id,title:w.getTitle(),visible:w.isVisible()}))});
  globalThis.__startupAudit={state,close:()=>win.close(),crash:()=>wc.forcefullyCrashRenderer(),reload:()=>wc.reload(),capture:async name=>{if(!/^[a-z0-9-]+$/.test(name))throw Error('Invalid screenshot label');const image=await wc.capturePage();const result={empty:image.isEmpty(),size:image.getSize()};fs.writeFileSync(path.join(dir,name+'.png'),image.toPNG(),{mode:0o600});trace('capture',{name,...result});return result;}};
  win.setTitle('Nozeli startup audit '+tag);win.showInactive();trace('observer-installed',state());return state();
 })()`);}
 state(){return this.evaluate('globalThis.__startupAudit.state()');}
 action(name){assert(['close','crash','reload'].includes(name));return this.evaluate(`globalThis.__startupAudit.${name}(); true`);}
 capture(name){return this.evaluate(`globalThis.__startupAudit.capture(${JSON.stringify(name)})`,4000);}
 close(){this.socket.close();}
}

export async function processIdentity(pid){
 const [exe,stat,environment]=await Promise.all([fs.realpath(`/proc/${pid}/exe`),fs.readFile(`/proc/${pid}/stat`,'utf8'),fs.readFile(`/proc/${pid}/environ`)]);
 const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
 return {pid,exe,start:fields[19],parent:Number(fields[1]),group:Number(fields[2]),environment:environment.toString().split('\0'),cwd:await fs.readlink(`/proc/${pid}/cwd`),command:(await fs.readFile(`/proc/${pid}/cmdline`)).toString().split('\0')};
}
export async function assertOwned(run){
 const actual=await processIdentity(run.child.pid);
 assert.equal(actual.exe,run.exe);assert.equal(actual.start,run.identity.start);assert.equal(actual.group,run.child.pid);
 // Electron's process title can overwrite /proc environ after initial capture.
 assert(run.identity.environment.includes('NOZELI_USER_DATA='+run.profile));assert(run.identity.environment.includes('NOZELI_STARTUP_AUDIT_ID='+run.tag));
 assert.equal(actual.cwd,run.record.dir);assert(actual.command.some(s=>s.includes(run.record.project)));return {pid:actual.pid,exe:actual.exe,start:actual.start,group:actual.group};
}
