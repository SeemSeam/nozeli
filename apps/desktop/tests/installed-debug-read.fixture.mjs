import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import puppeteer from 'puppeteer-core';
import {serve} from './pi-provider.fixture.mjs';
import {MainObserver} from './post-install-startup-recovery-fixture.mjs';

// Shared boot contract for the two installed-app gates (debug activation and
// read protocol). Boots the ACTUAL locally installed release resolved through
// /home/bfly/.local/opt/nozeli/current — never a source main, node-host
// surrogate or installed-byte edit. The owned child gets an isolated config
// root, profile, CDP port and Inspector port, a credential-scrubbed
// environment, and exits 0 through session.requestClose. Project registration
// uses ONLY the installed DesktopHost under the installed bundled Node; a
// registration failure fails the gate instead of falling back to a dev host.
// Every behavior under test runs in the installed main. No model requests happen
// during boot: the returned provider serves the caller's handler and the only
// business input is the caller's explicit managed.task.
export const CURRENT_LINK=path.join(os.userInfo().homedir,'.local','opt','nozeli','current');
const exec=promisify(execFile);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const sha256file=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
const scrubEnv=base=>{
  const env={...base};
  for(const key of Object.keys(env))if(key!=='XAUTHORITY'&&(/^(NOZELI_|CCB_|OMP_|PI_|CODEX_)/.test(key)||/AUTH|TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(key)||['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(key)))delete env[key];
  return env;
};
const freePort=()=>new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const identityFiles=['src/main/main.cjs','src/agents/managed/controller.mjs','src/agents/managed/debug-protocol.mjs','src/agents/managed/pi-runtime.mjs','src/agents/managed/git-runtime.mjs','src/agents/managed/context-reader.mjs','src/agents/managed/document-reader.mjs'];
// Inspector Runtime.evaluate runs without a dynamic-import callback, so plain
// observer expressions cannot `await import(...)`. Compile module expressions
// with the main context default loader instead: installed files resolve through
// the actual running main's module registry (no separate loader, no installs).
export async function evaluateModule(observer,expression,ms=30000){
  const wrapped=`(async()=>{const vm=process.mainModule.require('node:vm');return await vm.runInThisContext(${JSON.stringify(expression)},{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});})()`;
  return observer.evaluate(wrapped,ms);
}

export async function bootInstalled({scenario={},files={},handler}={}){
  assert(typeof handler==='function','bootInstalled requires an async HTTP handler(request) for the local provider');
  const name=typeof scenario?.name==='string'&&scenario.name.trim()?scenario.name.trim():'installed-gate';
  const out=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48)+'-'));
  const config=path.join(out,'.Nozeli'),profile=path.join(config,'desktop'),root=path.join(out,'project');
  // Owned resources are mirrored into state so ANY boot failure after creation
  // gets the same cleanup discipline as a normal close.
  const state={provider:null,child:null,exit:null,browser:null,shell:null,observer:null,release:null,appRoot:null,binary:null,digests:null,gitIdentity:null,registration:null,registrationErrors:[],head:null,readLog:()=>''};
  try{
    return await bootInstalledBody({scenario,files,handler},{name,out,config,profile,root,state});
  }catch(error){
    try{await state.phase?.('boot-failed',{error:String(error?.message??error),stack:String(error?.stack??error).slice(0,4000)});}catch{/* phase log is best effort */}
    try{
      if(state.child&&state.child.exitCode===null){
        try{await state.shell?.evaluate(()=>window.nozeli.invoke('session.requestClose',{}));}catch{/* shell unavailable */}
        await Promise.race([state.exit,pause(10000)]);
        if(state.child.exitCode===null){state.child.kill('SIGTERM');await Promise.race([state.exit,pause(5000)]);}
        if(state.child.exitCode===null){state.child.kill('SIGKILL');await Promise.race([state.exit,pause(3000)]);}
      }
    }catch{/* cleanup must never mask the boot error */}
    try{if(state.browser)await Promise.resolve(state.browser.disconnect());}catch{/* CDP already gone */}
    try{await state.provider?.close();}catch{/* provider already closed */}
    const report={ok:false,phase:'boot',scenario:name,out,bootPhases:path.join(out,'boot-phases.jsonl'),bootError:String(error?.stack??error),installed:{currentLink:CURRENT_LINK,release:state.release,appRoot:state.appRoot,binary:state.binary,digests:state.digests,gitIdentity:state.gitIdentity,registration:state.registration,registrationErrors:state.registrationErrors,head:state.head},providerRequests:state.provider?.requests?.length??0,providerErrors:(state.provider?.errors??[]).map(row=>String(row?.stack??row)),childExit:state.child&&state.exit?await Promise.race([state.exit,pause(0)]):null,electronLogTail:state.readLog().slice(-20000)};
    await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)).catch(()=>{});
    await fs.writeFile(path.join(out,'electron.log'),state.readLog()).catch(()=>{});
    throw error;
  }
}
async function bootInstalledBody({scenario,files,handler},{name,out,config,profile,root,state}){
  await fs.mkdir(root,{recursive:true});
  const bootStart=Date.now(),phasesFile=path.join(out,'boot-phases.jsonl');
  // Bounded one-line-per-stage progress so any boot failure pinpoints fast.
  const phase=async(stage,details={})=>{
    await fs.appendFile(phasesFile,JSON.stringify({at:new Date().toISOString(),stage,elapsedMs:Date.now()-bootStart,...details})+'\n',{mode:0o600}).catch(()=>{});
  };
  state.phase=phase;
  assert(Object.keys(files).length>0,'bootInstalled requires at least one project file for the Git baseline');
  for(const [rel,content] of Object.entries(files)){
    assert(typeof rel==='string'&&rel&&!path.isAbsolute(rel)&&!rel.split('/').includes('..'),'project file keys must be safe relative paths: '+rel);
    assert(typeof content==='string','project file content must be UTF-8 text: '+rel);
    const target=path.join(root,rel);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,content);
  }
  await phase('files-written',{count:Object.keys(files).length});
  // Actual installed artifact identity. current must resolve to a real release
  // directory; every gate asserts this instead of trusting ambient env.
  assert(process.env.DISPLAY,'Actual X11 capture required');
  const release=await fs.realpath(CURRENT_LINK);
  assert(/\/releases\/[^/]+$/.test(release),'installed current must resolve to a release directory: '+release);
  const binary=path.join(release,'nozeli');
  const appRoot=await fs.realpath(path.join(release,'resources','app'));
  const installation=JSON.parse(await fs.readFile(path.join(release,'INSTALLATION.json'),'utf8'));
  const digests={nozeli:await sha256file(binary),'INSTALLATION.json':await sha256file(path.join(release,'INSTALLATION.json'))};
  for(const rel of identityFiles)digests[rel]=await sha256file(path.join(appRoot,rel));
  state.release=release;state.appRoot=appRoot;state.binary=binary;state.digests=digests;
  await phase('installed-identity-read',{release,appRoot});
  // Git baseline through the INSTALLED bundled Git (never ambient system Git).
  // gitRaw keeps exact bytes (trailing newline) for content comparisons; git is
  // the trimmed convenience view for identity commands.
  const {runGit,ensureGit}=await import(pathToFileURL(path.join(appRoot,'src','agents','managed','git-runtime.mjs')).href);
  const gitEnv={...scrubEnv(process.env),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  // Identity only: ensureGit() also returns a full runtime env map which must
  // never be persisted into reports.
  const {command:gitCommand,version:gitVersion,source:gitSource}=await ensureGit();
  const gitIdentity={command:gitCommand,version:gitVersion,source:gitSource};
  state.gitIdentity=gitIdentity;
  const gitRaw=async(...args)=>runGit(root,args,{encoding:'utf8',env:gitEnv});
  const git=async(...args)=>String(await gitRaw(...args)).trim();
  await git('init','-b','main');
  await git('config','user.name','Nozeli Installed Gate Synthetic');
  await git('config','user.email','installed-gate@localhost');
  await git('add','--all');
  await git('commit','-m','Installed gate synthetic baseline');
  const head=await git('rev-parse','HEAD');
  state.head=head;
  await phase('git-baseline',{head});
  // Project registration: ONLY the installed DesktopHost under the installed
  // bundled Node. No dev/source-host fallback: a failure here fails the gate.
  const registerScript=path.join(out,'register-project.mjs');
  await fs.writeFile(registerScript,[
    "const hostModule=await import(process.argv[4]);",
    "const host=new hostModule.DesktopHost(process.argv[2]);",
    "const picked=await host.pick(process.argv[3]);",
    "if(!picked||!picked.project||!picked.project.id)throw Error('project registration returned no project');",
    "const localDirectory=await host.storage.localDirectory(picked.project.id);",
    "await host.storage.db.close();",
    "const payload=JSON.stringify({projectId:picked.project.id,instanceId:picked.project.instanceId,localDirectory});",
    // The registration process must never linger on host-owned worker handles:
    // flush stdout, then exit explicitly (setup-only throwaway process).
    "process.stdout.write(payload,()=>process.exit(0));",
    "setTimeout(()=>process.exit(0),2000).unref();"
  ].join('\n'),{mode:0o600});
  const installedHostUrl=pathToFileURL(path.join(appRoot,'src','main','host.mjs')).href;
  const bundledNode=await fs.realpath(path.join(appRoot,'runtime','node','bin','node'));
  let registration=null;const registrationErrors=[];
  state.registrationErrors=registrationErrors;
  await phase('registration-start',{node:bundledNode});
  try{
    const {stdout}=await exec(bundledNode,[registerScript,profile,root,installedHostUrl],{env:scrubEnv(process.env),cwd:out,timeout:30000});
    registration={kind:'installed-host-bundled-node',node:bundledNode,hostUrl:installedHostUrl,...JSON.parse(stdout.trim().split('\n').at(-1))};
  }catch(error){registrationErrors.push({attempt:'installed-host-bundled-node',error:String(error?.message??error),stderr:String(error?.stderr??'').slice(0,4000)});}
  if(!registration)throw new Error('installed project registration failed under the installed bundled Node with the installed DesktopHost; no fallback host is permitted: '+JSON.stringify(registrationErrors));
  const {projectId,instanceId,localDirectory}=registration;
  state.registration=registration;
  await phase('registration-done',{projectId,instanceId,localDirectory});
  const ledgerFile=path.join(localDirectory,'ui.sqlite');
  // Local scripted provider: alive during boot, but only listings are allowed
  // until the caller's explicit managed.task.
  const provider=await serve(handler);
  state.provider=provider;
  await phase('provider-ready',{url:provider.url});
  const cdpPort=await freePort();
  const env=scrubEnv(process.env);
  Object.assign(env,{NOZELI_CONFIG_ROOT:config,NOZELI_USER_DATA:profile,NOZELI_TEST_INSTANCE:'1',NOZELI_DEBUG_PORT:String(cdpPort),NOZELI_HIDDEN:'0',NOZELI_OZONE:'x11'});
  const child=spawn(binary,['--ozone-platform=x11','--inspect=0'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  let log='';
  for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{log+=bytes;});
  state.child=child;state.exit=exit;state.readLog=()=>log;
  await phase('app-spawn',{pid:child.pid,cdpPort});
  const errors=[];
  const until=async(fn,label,timeout=60000)=>{
    const end=Date.now()+timeout;
    while(Date.now()<end){
      if(child.exitCode!==null&&child.exitCode!==undefined)throw new Error('Owned installed app exited before '+label+' (code '+child.exitCode+'): '+log.slice(-4000));
      const value=await fn();
      if(value)return value;
      await pause(100);
    }
    throw new Error('Timeout waiting for '+label+'; log tail: '+log.slice(-4000));
  };
  const browser=await until(()=>puppeteer.connect({browserURL:'http://127.0.0.1:'+cdpPort,defaultViewport:null}).catch(()=>null),'installed CDP endpoint');
  await phase('cdp-connected');
  state.browser=browser;
  browser.on('targetcreated',async target=>{const page=await target.page().catch(()=>null);page?.on('pageerror',error=>errors.push(String(error?.message??error)));});
  const shell=await until(async()=>{for(const page of await browser.pages())if(await page.evaluate(()=>window.__nozeliReady&&window.__workspaceScope?.role==='shell').catch(()=>false))return page;},'installed shell surface');
  await phase('shell-found');
  state.shell=shell;
  const observer=await MainObserver.connect(await until(()=>log.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1],'installed main Inspector'));
  await phase('inspector-connected');
  state.observer=observer;
  const windowId=await until(()=>observer.evaluate(`(()=>{try{const {BaseWindow}=process.mainModule.require('electron');const win=BaseWindow.getAllWindows()[0];if(!win)return null;win.show();win.focus();return '0x'+win.getNativeWindowHandle().readUInt32LE(0).toString(16);}catch{return null}})()`).catch(()=>null),'owned installed window');
  await phase('window-found',{windowId});
  // Read-only installed runtime identity: rules out ambient source/system Pi.
  const runtimeIdentity=await evaluateModule(observer,`(async()=>{
    const path=process.mainModule.require('node:path'),{pathToFileURL}=process.mainModule.require('node:url');
    const appRoot=${JSON.stringify(appRoot)},probe=${JSON.stringify(path.join(config,'runtime-probe-pi-home'))};
    const piRuntime=await import(pathToFileURL(path.join(appRoot,'src/agents/managed/pi-runtime.mjs')).href);
    const resolved=await piRuntime.resolveBundledPiRuntime({appRoot,packaged:true,piHome:probe});
    const gitRuntime=await import(pathToFileURL(path.join(appRoot,'src/agents/managed/git-runtime.mjs')).href);
    const git=await gitRuntime.ensureGit();
    return {execPath:process.execPath,resourcesPath:process.resourcesPath,mainFile:process.mainModule?process.mainModule.filename:null,argv:process.argv.slice(1),versions:{node:process.versions.node,electron:process.versions.electron,chrome:process.versions.chrome},pi:{command:resolved.command,args:resolved.args,integrationRoot:resolved.integrationRoot,entry:resolved.entry,nodeManifest:resolved.manifest.node??null,piManifest:resolved.manifest.pi??null},git:{command:git.command,version:git.version,source:git.source}};
  })()`,30000);
  await phase('runtime-identity-read');
  const invoke=async(op,p={})=>{
    const reply=await shell.evaluate(({op,p})=>window.nozeli.invoke(op,p),{op,p});
    assert(reply&&reply.ok,op+': '+JSON.stringify(reply?.error));
    return reply.value;
  };
  const status=async()=>(await invoke('managed.status',{projectId})).state;
  const capture=async label=>{
    const safe=String(label).replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'')||'capture';
    const output=path.join(out,safe+'.png'),native=path.join(out,safe+'-native.png'),clip=path.join(out,safe+'-frames.mkv');
    const record={label,path:output,method:'x11-grab'};
    // Warm every visible surface first so the grab shows the live UI.
    await observer.evaluate(`(async()=>{const {BaseWindow}=process.mainModule.require('electron');for(const win of BaseWindow.getAllWindows())for(const view of win.contentView.children||[])if(view.getVisible?.()&&view.webContents)await view.webContents.capturePage(undefined,{stayAwake:true});return true;})()`,15000).catch(()=>{});
    try{
      const info=(await exec('xwininfo',['-id',windowId],{timeout:5000})).stdout;
      const width=Number(/Width:\s+(\d+)/.exec(info)?.[1]),height=Number(/Height:\s+(\d+)/.exec(info)?.[1]);
      assert(width>0&&height>0,'owned X11 window dimensions required');
      await exec('ffmpeg',['-y','-loglevel','error','-f','x11grab','-framerate','10','-draw_mouse','0','-window_id',windowId,'-video_size',width+'x'+height,'-i',process.env.DISPLAY,'-t','1.2','-c:v','ffv1','-pix_fmt','bgr0',clip],{timeout:10000});
      await exec('ffmpeg',['-y','-loglevel','error','-sseof','-0.15','-i',clip,'-frames:v','1',output],{timeout:10000});
      assert((await fs.stat(output)).size>0,'x11 grab produced a frame');
    }catch(error){
      // A stale compositor frame is never claimed as the screen: fall back to
      // the real native WebContents capture and qualify the capture method.
      const nativeResult=await observer.evaluate(`(async()=>{
        const fs=process.mainModule.require('node:fs');
        const {BaseWindow}=process.mainModule.require('electron');
        const win=BaseWindow.getAllWindows().find(candidate=>!candidate.isDestroyed());
        if(!win)throw Error('no owned window for native capture');
        const image=await win.webContents.capturePage();
        fs.writeFileSync(${JSON.stringify(native)},image.toPNG(),{mode:0o600});
        return {empty:image.isEmpty(),size:image.getSize()};
      })()`,15000);
      if(nativeResult.empty)throw new Error('native WebContents capture empty for '+safe);
      record.method='webcontents-capture';record.path=native;record.reason=String(error?.message??error);
    }
    captures.push(record);screenshots.push(record.path);
    return record.path;
  };
  const screenshots=[],captures=[];
  // Standard installed-first-run wiring: independent config, loopback provider,
  // explicit model selection for every role, project selection, managed enable.
  await invoke('config.initialize',{mode:'independent'});
  await phase('config-initialized');
  if(await shell.$eval('#configuration-setup',node=>node.open).catch(()=>false))await shell.click('#configuration-cancel');
  await invoke('settings.providers.save',{operation:'create',provider:'installed-gate-local',baseUrl:provider.url,api:'openai-completions',models:[{id:'scripted'}],credential:{action:'replace',value:'local-nonsecret'}});
  await phase('providers-saved');
  const model={model:{mode:'explicit',selector:'installed-gate-local/scripted'},thinking:{mode:'native-default'}};
  await invoke('settings.models.save',{frontdesk:model,orchestrator:model,worker:model});
  await phase('models-saved');
  await shell.click('[data-project-id="'+projectId+'"]');
  await until(()=>shell.evaluate(id=>window.__workspaceGroups?.snapshot()?.projectId===id,projectId),'project selection');
  await phase('project-selected');
  await invoke('managed.enable',{projectId});
  const bootRequests=provider.requests.filter(row=>!row.listing);
  assert.equal(bootRequests.length,0,'no model requests during installed boot; the caller drives the only business input via managed.task');
  await phase('managed-enabled',{providerRequests:provider.requests.length});
  const closeInfo={};
  let closed=false,closeResult=null;
  const close=async()=>{
    if(closed)return closeResult;
    closed=true;
    try{
      try{
        await until(async()=>{
          const state=await status().catch(()=>null);
          return state?!state.jobs.some(job=>['queued','running','transferring'].includes(job.status)):null;
        },'owned installed app state settles before close',60000);
      }catch(error){closeInfo.flushError=String(error?.message??error);}
      observer.close();
      if(child.exitCode===null){
        try{await invoke('session.requestClose');}
        catch(error){closeInfo.requestCloseError=String(error?.message??error);}
        closeResult=await Promise.race([exit,pause(20000).then(()=>null)]);
        if(child.exitCode===null){child.kill('SIGTERM');closeResult=await Promise.race([exit,pause(8000).then(()=>null)]);}
        if(child.exitCode===null){child.kill('SIGKILL');closeResult=await Promise.race([exit,pause(5000).then(()=>null)]);}
      }else closeResult=await exit;
    }finally{
      try{await Promise.resolve(browser.disconnect());}catch{/* CDP connection already gone */}
      await provider.close();
      closeInfo.exit=closeResult;
      const drifted=[];
      try{
        if(await fs.realpath(CURRENT_LINK)!==release)drifted.push('current-realpath-changed');
        for(const [rel,expected] of Object.entries(digests)){
          const actual=await sha256file(rel==='nozeli'?binary:rel==='INSTALLATION.json'?path.join(release,'INSTALLATION.json'):path.join(appRoot,rel));
          if(actual!==expected)drifted.push(rel);
        }
      }catch(error){drifted.push('digest-error:'+String(error?.message??error));}
      if(drifted.length)closeInfo.installedBytesChanged=drifted;
    }
    return closeResult;
  };
  await phase('boot-complete');
  return {
    out,root,profile,config,projectId,instanceId,localDirectory,ledgerFile,
    ledgerCollection:'ui',ledgerRecord:'managed:maintenance',
    release,appRoot,binary,browser,shell,observer,provider,child,pid:child.pid,
    git,gitRaw,head,registration,registrationErrors,screenshots,captures,errors,invoke,status,capture,close,closeInfo,bootPhases:phasesFile,
    scenario:name,
    readLog:()=>log,
    identity:{
      currentLink:CURRENT_LINK,release,appRoot,binary,installation,digests,
      gitIdentity,runtimeIdentity,registration,
      testRunner:{node:process.execPath,version:process.version},
      scenario:name
    }
  };
}
