// Native arm64 app assembly. No installer, global registration or user data writes.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const run=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',maxBuffer:16*1024*1024,...options});
const hash=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function plist(file,update){const value=JSON.parse(run('/usr/bin/plutil',['-convert','json','-o','-',file]));update(value);await fs.writeFile(file,JSON.stringify(value));run('/usr/bin/plutil',['-convert','xml1',file]);}
async function inventory(root){const files=[],bundles=[];async function visit(dir){for(const item of await fs.readdir(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isSymbolicLink())continue;if(item.isDirectory()){await visit(file);if(/\.(?:app|framework)$/.test(item.name))bundles.push(file);}else if(item.isFile()){const h=await fs.open(file,'r');const b=Buffer.alloc(4);try{await h.read(b,0,4,0);}finally{await h.close();}if(['cffaedfe','cefaedfe','cafebabe','bebafeca','cafebabf'].includes(b.toString('hex')))files.push(file);}}}await visit(root);return {files,bundles};}
export async function signMacApplication(app){
 const {files,bundles}=await inventory(app),architectures=[];
 for(const file of files){const arch=run('/usr/bin/lipo',['-archs',file]).trim();if(!arch.split(' ').includes('arm64'))throw Error('Non-arm64 native artifact: '+file+' ('+arch+')');const loadCommands=run('/usr/bin/xcrun',['llvm-objdump','--macho','--private-headers',file]);const dependencies=loadCommands.split(/Load command \d+/).filter(block=>/cmd LC_(?:LOAD_DYLIB|LOAD_WEAK_DYLIB|REEXPORT_DYLIB|LOAD_UPWARD_DYLIB|RPATH)\b/.test(block)).join('\n');if(/\/(?:Users|opt\/homebrew|usr\/local)\//.test(dependencies))throw Error('Non-relocatable native dependency: '+file);architectures.push({path:path.relative(app,file),arch});run('/usr/bin/codesign',['--force','--sign','-',file],{stdio:'pipe'});}
 // Final executable bytes must be hashed after their last individual signature.
 const application=path.join(app,'Contents/Resources/app');
 const runtime=path.join(application,'runtime/omp/darwin-arm64'),manifestFile=path.join(runtime,'runtime.json');
 const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));for(const name of Object.keys(manifest.files))manifest.files[name]=await hash(path.join(runtime,name));await fs.writeFile(manifestFile,JSON.stringify(manifest,null,2)+'\n');
 for(const bundle of bundles)run('/usr/bin/codesign',['--force','--sign','-',bundle],{stdio:'pipe'});
 await fs.writeFile(path.join(app,'Contents/Resources/native-artifacts.json'),JSON.stringify({platform:'darwin',arch:'arm64',minimumMacOS:'13.0',signing:'ad-hoc',artifacts:architectures},null,2)+'\n');
 run('/usr/bin/codesign',['--force','--sign','-',app],{stdio:'pipe'});
 run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
 return architectures;
}
export async function validateMacApplication(app){
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('macOS arm64 validation requires that host');
 const application=path.join(app,'Contents/Resources/app'),command=path.join(app,'Contents/MacOS/Nozeli');
 await fs.access(command,fs.constants.X_OK);await fs.access(path.join(application,'dist/renderer/app.js'));
 const {resolveBundledOmpRuntime}=await import(pathToFileURL(path.join(application,'src/agents/managed/omp-runtime.mjs')));
 const omp=await resolveBundledOmpRuntime({appRoot:application});
 if(!omp.command.startsWith(application+path.sep))throw Error('OMP escaped application');
 // Use the shipped Electron's Node host with PATH empty to load both addons and
// bundled Git. No developer Node, npm, Bun or system Git is available here.
 const script=`(async()=>{const root=${JSON.stringify(application)};process.chdir(root);const {createRequire}=await import('node:module');const req=createRequire(root+'/package.json');const pty=req('node-pty');await new Promise((resolve,reject)=>{const child=pty.spawn('/bin/sh',['-c','printf NOZELI_PTY_OK'],{cwd:root,env:{PATH:''},cols:80,rows:24});let output='';const timer=setTimeout(()=>{child.kill();reject(Error('bundled PTY timed out'));},10000);child.onData(text=>output+=text);child.onExit(({exitCode})=>{clearTimeout(timer);if(exitCode!==0||!output.includes('NOZELI_PTY_OK'))reject(Error('bundled PTY failed: '+output));else resolve();});});const {platformNative}=await import('file://'+root+'/src/platform/native.mjs');if(!platformNative().processInfo(process.pid,0))throw Error('process identity missing');const {ensureGit,runGit}=await import('file://'+root+'/src/agents/managed/git-runtime.mjs');const git=await ensureGit();await runGit(root,['--version'],{env:{PATH:''}});console.log(JSON.stringify({node:process.versions.node,modules:process.versions.modules,arch:process.arch,git:git.version,native:true,ptySpawn:true}));})().catch(e=>{console.error(e);process.exitCode=1});`;
 const evidence=JSON.parse(run(command,['-e',script],{env:{PATH:'',ELECTRON_RUN_AS_NODE:'1'},timeout:30000}).trim());
 evidence.ompVersion=run(omp.command,['--version'],{cwd:application,env:{PATH:''},timeout:30000}).trim();if(!evidence.ompVersion)throw Error('Bundled OMP did not report its version');
 run('/usr/bin/codesign',['--verify','--deep','--strict',app]);return {application,command,evidence,manifest:JSON.parse(await fs.readFile(path.join(application,'package.json'),'utf8'))};
}
export async function assembleMacRelease({release,source,dependencyIncluded,auditBundledLinks}){
 if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Only macOS arm64 assembly is supported');
 const manifest=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8')),lock=JSON.parse(await fs.readFile(path.join(source,'package-lock.json'),'utf8'));
 const require=createRequire(path.join(source,'package.json')),electronApp=path.resolve(require('electron'),'../../..');
 if(!electronApp.endsWith('Electron.app'))throw Error('Unexpected Electron bundle layout');
 await fs.mkdir(release);
 await fs.writeFile(path.join(release,'INSTALLATION.json'),JSON.stringify({application:'Nozeli',version:manifest.version,installedAt:new Date().toISOString(),kind:'local-development-snapshot',platform:'darwin',arch:'arm64',state:'building'},null,2));
 const app=path.join(release,'Nozeli.app');await fs.cp(electronApp,app,{recursive:true,verbatimSymlinks:true});
 await fs.rename(path.join(app,'Contents/MacOS/Electron'),path.join(app,'Contents/MacOS/Nozeli'));
 const resources=path.join(app,'Contents/Resources'),application=path.join(resources,'app');await fs.mkdir(application);
 await fs.rm(path.join(resources,'default_app.asar'),{force:true});
 for(const name of ['src','dist','assets','runtime','package.json','package-lock.json','SOURCES.md','README.md'])await fs.cp(path.join(source,name),path.join(application,name),{recursive:true,filter:file=>!path.relative(source,file).split(path.sep).some(part=>['.nozeli','.ccb'].includes(part))});
 const dependencies=path.join(source,'node_modules');await fs.cp(dependencies,path.join(application,'node_modules'),{recursive:true,verbatimSymlinks:true,filter:async file=>{const relative=path.relative(dependencies,file);if(relative.startsWith('node-pty/prebuilds')||!dependencyIncluded(lock,relative))return false;if((await fs.lstat(file)).isSymbolicLink()){const target=await fs.realpath(file);if(target===dependencies||relative.split(path.sep).includes('.bin')&&!dependencyIncluded(lock,path.relative(dependencies,target)))return false;}return true;}});
 await fs.copyFile(path.resolve(source,'../../LICENSE'),path.join(resources,'NOZELI-LICENSE'));
 for(const name of ['LICENSE','LICENSES.chromium.html'])await fs.copyFile(path.join(source,'node_modules/electron/dist',name),path.join(resources,name));
 const notices=path.join(application,'assets/licenses/pptist');await fs.mkdir(notices,{recursive:true});for(const name of ['LICENSE','README.md','package-lock.json'])await fs.copyFile(path.join(source,'vendor/pptist',name),path.join(notices,name));
 manifest.productName='Nozeli';await fs.writeFile(path.join(application,'package.json'),JSON.stringify(manifest,null,2)+'\n');
 const iconset=path.join(release,'Nozeli.iconset');await fs.mkdir(iconset);for(const size of [16,32,128,256,512])for(const scale of [1,2])run('/usr/bin/sips',['-z',String(size*scale),String(size*scale),path.join(source,'assets/brand/nozeli-paired-tabs-icon.png'),'--out',path.join(iconset,`icon_${size}x${size}${scale===2?'@2x':''}.png`)]);
 run('/usr/bin/iconutil',['-c','icns',iconset,'-o',path.join(resources,'nozeli.icns')]);await fs.rm(iconset,{recursive:true});
 await plist(path.join(app,'Contents/Info.plist'),p=>Object.assign(p,{CFBundleExecutable:'Nozeli',CFBundleName:'Nozeli',CFBundleDisplayName:'Nozeli',CFBundleIdentifier:'app.nozeli.desktop',CFBundleIconFile:'nozeli.icns',CFBundleShortVersionString:manifest.version.split('-')[0],CFBundleVersion:manifest.version.split('-')[0],LSMinimumSystemVersion:'13.0',NSHighResolutionCapable:true,CFBundleDocumentTypes:[{CFBundleTypeName:'Nozeli documents',CFBundleTypeRole:'Editor',LSHandlerRank:'Alternate',CFBundleTypeExtensions:['txt','md','markdown','tex','bib','js','ts','tsx','py','json','yaml','yml','pdf','png','jpg','jpeg','webp','docx','xlsx','pptx']}]}));
 for(const bundle of (await inventory(app)).bundles.filter(p=>p.endsWith('.app')))await plist(path.join(bundle,'Contents/Info.plist'),p=>{p.CFBundleIdentifier='app.nozeli.desktop.'+path.basename(bundle,'.app').replace(/[^a-z0-9]/gi,'').toLowerCase();});
 await auditBundledLinks(release);await signMacApplication(app);await validateMacApplication(app);
 const marker=JSON.parse(await fs.readFile(path.join(release,'INSTALLATION.json'),'utf8'));marker.state='validated';await fs.writeFile(path.join(release,'INSTALLATION.json'),JSON.stringify(marker,null,2)+'\n');return release;
}
