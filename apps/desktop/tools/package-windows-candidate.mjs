import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {applicationSourceIncluded,dependencyIncluded} from './local-release.mjs';
import {packagePiRuntime} from './package-pi-runtime.mjs';
import {absolute,openPayload,sha256,json,reject,readRegular} from './windows-install-core.mjs';

const prefix='resources/app/';
const platformListAllows=(list,target)=>list===undefined||(!list.includes('!'+target)&&(!list.some(value=>!value.startsWith('!'))||list.includes(target)));
export function windowsDependencyIncluded(lock,relative){
 if(!dependencyIncluded(lock,relative))return false;
 const normalized=relative.split(path.sep).join('/');
 if(/(?:^|\/)\.bin(?:\/|$)/.test(normalized)||/(?:^|\/)node-pty\/(?:build|bin)(?:\/|$)/.test(normalized))return false;
 if(normalized.startsWith('@earendil-works/pi-tui/native/darwin/')||normalized.startsWith('@earendil-works/pi-tui/native/linux/'))return false;
 const prebuild=normalized.match(/(?:^|\/)prebuilds\/([^/]+)/);
 if(prebuild&&!/^win32-x64(?:-|$)/.test(prebuild[1]))return false;
 for(let name='node_modules/'+normalized;name.startsWith('node_modules/');name=path.posix.dirname(name)){
  const entry=lock.packages?.[name];
  if(entry&&(!platformListAllows(entry.os,'win32')||!platformListAllows(entry.cpu,'x64')))return false;
 }
 return true;
}
export async function validateWindowsCandidate(candidate,{arch=process.arch}={}){
 const tree=await openPayload(absolute(candidate));
 try{
  const manifest=JSON.parse(tree.read('WINDOWS-CANDIDATE.json'));
  if(manifest.schema!==1||manifest.application!=='Nozeli'||manifest.platform!=='win32'||manifest.arch!==arch||manifest.kind!=='windows-manual-candidate'||!['unsupported','native-windows-health-v1'].includes(manifest.automaticUpdater)||typeof manifest.version!=='string')throw reject('CANDIDATE_REJECTED','Wrong Windows candidate identity/architecture');
  const actual=tree.entries.filter(e=>e.path!=='WINDOWS-CANDIDATE.json');
  if(JSON.stringify(actual)!==JSON.stringify(manifest.entries))throw reject('CANDIDATE_TAMPERED','Complete candidate membership/digests differ');
  validateContents(tree,manifest);
  await tree.verify();return {tree,manifest,digest:sha256(tree.read('WINDOWS-CANDIDATE.json'))};
 }catch(error){tree.close();throw error;}
}
function validateContents(tree,manifest){
 const has=name=>tree.entries.some(e=>e.path===name&&e.type==='file');
 for(const name of ['Nozeli.exe','resources/app/package.json','resources/app/dist/renderer/app.js',prefix+'runtime/node/node.exe',prefix+'runtime/node/NODE-RUNTIME.json',prefix+'integrations/pi/build.mjs',prefix+'integrations/pi/tools/patch-sdk.mjs',prefix+'integrations/pi/patches/sdk/model-storage-1.4.0.json'])if(!has(name))throw reject('CANDIDATE_INCOMPLETE','Missing required payload: '+name);
 let application;
 try{application=JSON.parse(tree.read(prefix+'package.json'));}catch(cause){throw Object.assign(reject('CANDIDATE_PROVENANCE','Invalid packaged application metadata'),{cause});}
 if(application?.version!==manifest.version)throw reject('CANDIDATE_PROVENANCE','Packaged application version differs from the candidate');
 if(manifest.automaticUpdater==='native-windows-health-v1')for(const name of ['auto-update-windows.mjs','auto-update-windows-helper.mjs','auto-update-windows-package.mjs'])if(!has(prefix+'src/main/'+name))throw reject('CANDIDATE_INCOMPLETE','Missing Windows update protocol component: '+name);
 if(manifest.automaticUpdater==='native-windows-health-v1'){
  if(!/^[a-f0-9]{40}$/.test(manifest.commit??'')||manifest.nativeProvenance?.commit!==manifest.commit||!has('RELEASE.json'))throw reject('CANDIDATE_PROVENANCE','Windows updater requires exact source commit binding');
  const release=JSON.parse(tree.read('RELEASE.json'));
  if(release.application!=='Nozeli'||release.platform!=='win32'||release.arch!==manifest.arch||release.version!==manifest.version||release.commit!==manifest.commit||release.autoUpdate!==manifest.automaticUpdater)throw reject('CANDIDATE_PROVENANCE','Windows updater release metadata differs from the candidate');
 }
 if(/^0\.1\.0-beta\.(?:[89]|[1-9]\d+)(?:[.+-]|$)/.test(manifest.version)&&!has(prefix+'node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe'))throw reject('CANDIDATE_INCOMPLETE','Bundled Windows x64 search runtime required');
 for(const name of ['install-windows.mjs','windows-install-core.mjs','package-windows-candidate.mjs','local-release.mjs','release-retention.mjs','package-pi-runtime.mjs','package-node-runtime.mjs'])if(!has(prefix+'tools/'+name))throw reject('CANDIDATE_INCOMPLETE','Missing bundled installation tool: '+name);
 for(const entry of tree.entries.filter(e=>e.type==='file'&&(/\.node$/i.test(e.path)||['Nozeli.exe',prefix+'runtime/node/node.exe'].includes(e.path)||e.path.endsWith('/git.exe')||e.path.endsWith('/rg.exe')||(/\/native\//i.test(e.path)&&/\.exe$/i.test(e.path))||/supervisor.*\.exe$/i.test(e.path)))){
  const dos=tree.readAt(entry.path,0,64);if(dos.length!==64||dos.toString('ascii',0,2)!=='MZ')throw reject('CANDIDATE_ARCH','Invalid Windows PE: '+entry.path);
  const pe=tree.readAt(entry.path,dos.readUInt32LE(60),6);if(pe.length!==6||pe.readUInt32LE(0)!==0x4550||pe.readUInt16LE(4)!==0x8664)throw reject('CANDIDATE_ARCH','Expected Windows x64 PE: '+entry.path);
 }
 const node=JSON.parse(tree.read(prefix+'runtime/node/NODE-RUNTIME.json')),nodeEntry=tree.entries.find(e=>e.path===prefix+'runtime/node/node.exe');if(node.platform!=='win32'||node.arch!=='x64'||node.executable!=='node.exe'||node.sha256Executable!==nodeEntry.sha256)throw reject('CANDIDATE_PROVENANCE','Standalone Node provenance differs from actual bundled executable');
 const spec=JSON.parse(tree.read(prefix+'integrations/pi/patches/sdk/model-storage-1.4.0.json'));
 const sdkOutputs=['dist/core/model-config.js','dist/core/model-runtime.js','dist/core/models-store.js','dist/core/model-config.d.ts','dist/core/model-runtime.d.ts','dist/core/models-store.d.ts','dist/utils/paths.js'];
 if(!Array.isArray(spec.files)||spec.files.length!==sdkOutputs.length||new Set(spec.files.map(file=>file.path)).size!==sdkOutputs.length||sdkOutputs.some(name=>!spec.files.some(file=>file.path===name)))throw reject('CANDIDATE_INCOMPLETE','Complete exact SDK storage and path-resolution patch outputs required');
 for(const file of spec.files){const entry=tree.entries.find(e=>e.path===prefix+'integrations/pi/node_modules/@earendil-works/pi-coding-agent/'+file.path);if(!entry||entry.sha256!==file.sha256)throw reject('CANDIDATE_TAMPERED','SDK patch output differs: '+file.path);}
 if(!tree.entries.some(e=>e.path.startsWith(prefix+'node_modules/dugite/')&&e.path.endsWith('/git.exe')))throw reject('CANDIDATE_INCOMPLETE','Bundled Git required');
 const provenance=manifest.nativeProvenance;
 if(provenance?.schema!==1||!provenance.files||!provenance.buildInputs||!Object.keys(provenance.buildInputs).length)throw reject('CANDIDATE_PROVENANCE','Exact native binary and build-input provenance required');
 for(const [name,digest] of Object.entries({...provenance.files,...provenance.buildInputs})){const entry=tree.entries.find(e=>e.path===name);if(!entry||entry.type!=='file'||entry.sha256!==digest)throw reject('CANDIDATE_PROVENANCE','Native provenance differs: '+name);}
 const binaries=tree.entries.filter(e=>e.type==='file'&&(/\.node$/i.test(e.path)||(/\/native\//i.test(e.path)&&/\.exe$/i.test(e.path))||/supervisor.*\.exe$/i.test(e.path)));
 if(!binaries.length||binaries.some(e=>provenance.files[e.path]!==e.sha256))throw reject('CANDIDATE_PROVENANCE','Every native component requires exact provenance');
}

// No build, signing, migration or qualification is implied by packaging. Source
// must already contain the intended renderer/native/SDK outputs.
export async function packageWindowsCandidate({source,candidate,input,nativeProvenance,recordNativeProvenance=false,releaseRecord}){
 if(process.platform!=='win32'||process.arch!=='x64')throw reject('INSTALL_PLATFORM','Native Windows x64 packaging required');
 absolute(candidate);
 if(Boolean(source)===Boolean(input))throw reject('CANDIDATE_INPUT','Supply exactly one validated source or candidate input');
 const origin=absolute(source??input);const rel=path.relative(origin,candidate),back=path.relative(candidate,origin);const contains=value=>value===''||value!=='..'&&!value.startsWith('..'+path.sep)&&!path.isAbsolute(value);if(contains(rel)||contains(back))throw reject('CANDIDATE_INPUT','Input and output must be disjoint dedicated directories');
 if(input){const verified=await validateWindowsCandidate(input);try{await verified.tree.copyTo(path.dirname(candidate),path.basename(candidate));return verified.manifest;}finally{verified.tree.close();}}
 absolute(source);const pkg=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8')),lock=JSON.parse(await fs.readFile(path.join(source,'package-lock.json'),'utf8'));
 const require=createRequire(path.join(source,'package.json'));const electron=path.dirname(require('electron'));
 await fs.mkdir(candidate); // Exclusive; failed preparations remain for review.
 await fs.cp(electron,candidate,{recursive:true,errorOnExist:false,force:false});
 await fs.rename(path.join(candidate,'electron.exe'),path.join(candidate,'Nozeli.exe'));
 const application=path.join(candidate,'resources/app');await fs.mkdir(application,{recursive:true});
 for(const name of ['src','dist','tests','assets','runtime','native','tools','package.json','package-lock.json','SOURCES.md','README.md'])await fs.cp(path.join(source,name),path.join(application,name),{recursive:true,filter:file=>{const parts=path.relative(source,file).split(path.sep);return applicationSourceIncluded(source,file)&&!parts.some(p=>['.git','.test-output'].includes(p))&&!(parts[0]==='runtime'&&parts[1]==='node');}});
 const modules=path.join(source,'node_modules');await fs.cp(modules,path.join(application,'node_modules'),{recursive:true,filter:file=>windowsDependencyIncluded(lock,path.relative(modules,file))});
 await packagePiRuntime({source,application,includeDependency:windowsDependencyIncluded});
 await fs.copyFile(path.resolve(source,'../../LICENSE'),path.join(candidate,'NOZELI-LICENSE'));
 if(releaseRecord)await fs.writeFile(path.join(candidate,'RELEASE.json'),json(releaseRecord),{flag:'wx'});
 const tree=await openPayload(candidate);let manifest;
 if(recordNativeProvenance){
  const files={},buildInputs={};
  for(const entry of tree.entries.filter(e=>e.type==='file')){
   if(/\.node$/i.test(entry.path)||(/\/native\//i.test(entry.path)&&/\.exe$/i.test(entry.path))||/supervisor.*\.exe$/i.test(entry.path))files[entry.path]=entry.sha256;
   if(entry.path.startsWith(prefix+'native/')&&/\.(?:cc|h|inc|gyp)$/.test(entry.path)||[prefix+'tools/build-windows-native.mjs',prefix+'tools/build-windows-process.mjs',prefix+'package-lock.json'].includes(entry.path))buildInputs[entry.path]=entry.sha256;
  }
  nativeProvenance={schema:1,files,buildInputs,node:process.versions.node,commit:releaseRecord?.commit};
 }
 try{manifest={schema:1,application:'Nozeli',kind:'windows-manual-candidate',platform:'win32',arch:'x64',version:pkg.version,commit:releaseRecord?.commit??nativeProvenance?.commit,automaticUpdater:releaseRecord?.autoUpdate==='native-windows-health-v1'?'native-windows-health-v1':'unsupported',qualification:'not-implied-by-packaging',nativeProvenance,entries:tree.entries};validateContents(tree,manifest);await tree.verify();}finally{tree.close();}
 await fs.writeFile(path.join(candidate,'WINDOWS-CANDIDATE.json'),json(manifest),{flag:'wx'});
 const verified=await validateWindowsCandidate(candidate);verified.tree.close();return manifest;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2){if(!['--source','--candidate','--input','--native-provenance'].includes(args[i])||!args[i+1]||options[args[i]])throw Error('usage: package-windows-candidate.mjs --candidate ABS (--source ABS --native-provenance ABS | --input ABS)');options[args[i]]=args[i+1];}
 console.log(json(await packageWindowsCandidate({source:options['--source'],candidate:options['--candidate'],input:options['--input'],nativeProvenance:options['--native-provenance']?JSON.parse(await readRegular(options['--native-provenance'])):undefined})));
}
