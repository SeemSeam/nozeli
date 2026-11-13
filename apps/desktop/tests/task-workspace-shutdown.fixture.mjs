import fs from 'node:fs/promises';
import path from 'node:path';
async function processIdentity(pid){
 const [exe,stat]=await Promise.all([fs.realpath(`/proc/${pid}/exe`),fs.readFile(`/proc/${pid}/stat`,'utf8')]);
 const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');
 return {pid,exe,start:fields[19],parent:Number(fields[1]),group:Number(fields[2])};
}

// Opt-in, test-owned observation only. The recorder survives Inspector detach:
// keeping Inspector attached can itself keep Node waiting at exit.
export async function installShutdownDiagnostics(observer,out){
 return observer.evaluate(`(async()=>{
  const req=process.mainModule.require.bind(process.mainModule),fs=req('node:fs'),path=req('node:path');
  const {app,BaseWindow,webContents}=req('electron');
  const {forWindow}=req(path.join(path.dirname(process.mainModule.filename),'window-recovery.cjs'));
  const file=${JSON.stringify(path.join(out,'shutdown-events.jsonl'))};
  const owners=new Set();
  const snapshot=()=>({pid:process.pid,resources:process.getActiveResourcesInfo(),pi:[...owners].map(s=>({pid:s.pid,role:s.role,phase:s.phase,stopping:s.stopping,closed:s.closed,pending:s.pending.size,tools:s.inFlightToolCalls.size,nativePending:s.nativePending,exit:s.exit,receipt:s.lastExitReceipt,error:s.nativeError?.code??s.transportError?.code})),windows:BaseWindow.getAllWindows().map(w=>({id:w.id,destroyed:w.isDestroyed(),recovery:forWindow(w)?.snapshot()}))});
  const trace=(event,details={})=>fs.appendFileSync(file,JSON.stringify({at:Date.now(),event,details,state:snapshot()})+'\\n',{mode:0o600});
  const vm=req('node:vm');
  const load=vm.compileFunction('return import(specifier)',['specifier'],{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  const {PiSession}=await load(req('node:url').pathToFileURL(path.join(path.dirname(process.mainModule.filename),'../agents/managed/pi-session.mjs')).href);
  const stopOwner=PiSession.prototype.stopOwner;
  PiSession.prototype.stopOwner=function(...args){owners.add(this);trace('pi:stop-enter',{pid:this.pid,role:this.role});const result=stopOwner.apply(this,args);result.then(()=>trace('pi:stop-complete',{pid:this.pid}),error=>trace('pi:stop-error',{pid:this.pid,code:error.code}));return result;};
  for(const name of ['before-quit','window-all-closed','will-quit','quit'])app.on(name,()=>trace(name));
  for(const w of BaseWindow.getAllWindows()){const id=w.id;for(const name of ['close','closed','unresponsive','responsive'])w.on(name,()=>trace('window:'+name,{id}));}
  for(const wc of webContents.getAllWebContents()){
   const send=wc.send.bind(wc);wc.send=(channel,...args)=>{if(['nozeli:flush','nozeli:quit-confirm'].includes(channel))trace(channel,{id:wc.id,requestId:channel==='nozeli:flush'?args[0]:undefined});return send(channel,...args);};
  }
  let last;const timer=setInterval(()=>{const state=snapshot(),key=JSON.stringify(state);if(key!==last){last=key;trace('state');}},250);timer.unref();
  trace('installed');return snapshot();
 })()`);
}

export async function ownedProcessTree(child){
 if(process.platform!=='linux'||child.exitCode!==null||child.signalCode!==null)return [];
 const root=await processIdentity(child.pid).catch(()=>null);if(!root)return [];
 const rows=(await Promise.all((await fs.readdir('/proc')).filter(name=>/^\d+$/.test(name)).map(name=>processIdentity(Number(name)).catch(()=>null)))).filter(Boolean);
 const owned=new Map([[root.pid,root]]);let changed=true;
 while(changed){changed=false;for(const row of rows)if(!owned.has(row.pid)&&owned.has(row.parent)){owned.set(row.pid,row);changed=true;}}
 // No environment, command text, or credentials are written into the report.
 return [...owned.values()].map(({pid,parent,group,start,exe})=>({pid,parent,group,start,exe}));
}

export async function reclaimOwnedProcesses(child,identities,exit){
 const same=async identity=>{const current=await processIdentity(identity.pid).catch(()=>null);return current&&current.start===identity.start&&current.exe===identity.exe;};
 const signal=async name=>{
  if(process.platform==='linux'){
   for(const identity of [...identities].reverse())if(await same(identity)){try{process.kill(identity.pid,name);}catch(error){if(error.code!=='ESRCH')throw error;}}
  }else if(child?.exitCode===null&&child.signalCode===null)child.kill(name);
 };
 await signal('SIGTERM');
 // This is failed-test reclamation, never an app quit timeout or acceptance path.
 await Promise.race([exit,new Promise(resolve=>setTimeout(resolve,1000))]);
 await signal('SIGKILL');
 if(child?.exitCode===null&&child.signalCode===null)await Promise.race([exit,new Promise(resolve=>setTimeout(resolve,3000))]);
 return identities.length?Promise.all(identities.map(async identity=>({...identity,remaining:Boolean(await same(identity))}))):[];
}
