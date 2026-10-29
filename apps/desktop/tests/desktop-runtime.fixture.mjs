import path from 'node:path';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const sourceDiagnosticPath=name=>path.resolve(import.meta.dirname,'../.test-output/native-format-'+name+'.png');
export function desktopLaunch(sourceRoot,{ozone='headless',inspect=false}={}){
 const bundle=process.env.NOZELI_TEST_BUNDLE;
 if(bundle){
  if(process.platform!=='darwin'||!path.isAbsolute(bundle)||!bundle.endsWith('.app'))throw Error('NOZELI_TEST_BUNDLE requires an absolute macOS application bundle');
  const command=path.join(fs.realpathSync(bundle),'Contents/MacOS/Nozeli');fs.accessSync(command,fs.constants.X_OK);
  return {command,args:inspect?['--inspect=0']:[],application:path.join(bundle,'Contents/Resources/app')};
 }
 return {command:require('electron'),args:[...(inspect?['--inspect=0']:[]),...(process.platform==='linux'?['--ozone-platform='+ozone]:[]),path.join(sourceRoot,'src/main/main.cjs')],application:sourceRoot};
}

// Older format journeys address one Page. The current product gives each file
// its own native content page: retain physical navigation on the shell, then
// route the journey's document interactions to that registered surface.
export function nativeDocumentNavigation(shell,browser){
 if(process.env.NOZELI_TEST_NATIVE_NAV!=='1')return shell;
 let current=shell;const listeners=[];
 return new Proxy(shell,{
  get(target,key){
   if(key==='__nativeDocumentNavigation')return true;
   if(key==='click')return async(selector,options)=>{
    const legacyZoom={'#word-zoom-reset':'actual','#word-zoom-in':'zoom-in','#word-zoom-out':'zoom-out','#word-fit':'fit'};
    if(legacyZoom[selector]){const {contentToolForPage}=await import('./native-content-tools.fixture.mjs');return contentToolForPage(current,['view',legacyZoom[selector]]);}
    if(!selector.startsWith('#file-tree '))return current.click(selector,options);
    const rel=await shell.$eval(selector,n=>n.dataset.path);
    const hidden=await shell.$eval('#app',n=>n.classList.contains('narrow-layout')?!n.classList.contains('drawer-files-open'):n.classList.contains('files-collapsed'));
    if(hidden)await shell.click('#file-toggle');
    await shell.click(selector,options);
    const deadline=Date.now()+30000;
    while(Date.now()<deadline){
     for(const page of await browser.pages())if(await page.evaluate(rel=>window.__nozeliReady&&window.__workspaceScope?.kind==='document'&&window.__workspaceScope.relPath===rel,rel).catch(()=>false)){
      const scope=await page.evaluate(()=>window.__workspaceScope);
      const visible=await shell.evaluate(async s=>{const r=await nozeli.invoke('workspace.windows.list',{projectId:s.projectId});return r.ok&&r.value.flatMap(w=>w.surfaces).some(v=>v.viewId===s.viewId&&v.visible===true);},scope);
      if(!visible)continue;
      current=page;for(const [event,fn]of listeners)current.on(event,fn);await current.bringToFront();await current.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));return;
     }
     await new Promise(r=>setTimeout(r,80));
    }
    await shell.screenshot({path:sourceDiagnosticPath('shell')}).catch(()=>{});await current.screenshot({path:sourceDiagnosticPath('document')}).catch(()=>{});
    throw Error('Native document surface did not open: '+rel+' '+JSON.stringify(await shell.evaluate(()=>({body:document.body.innerText.slice(-1500),layout:window.__workspaceGroups?.snapshot()}))));
   };
   if(key==='on')return (event,fn)=>{listeners.push([event,fn]);current.on(event,fn);};
   if(key==='waitForFunction')return (fn,options,...args)=>current.waitForFunction(fn,{polling:100,...options},...args);
   const value=Reflect.get(current,key,current);return typeof value==='function'?value.bind(current):value;
  },
 });
}
