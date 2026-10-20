import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const hex=/^[a-f0-9]{64}$/;
const privatePath=/^(\/tmp\/nozeli-c1-worker3-package-[^/]+)\/install-root\/\.local\/opt\/nozeli\/releases\//;
const sensitive=/AUTH|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY/i;
function fail(code){const e=new Error(code);e.code=code;throw e;}
export async function fileSHA256(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
async function regular(file,code){try{const stat=await fs.lstat(file);if(!stat.isFile()||await fs.realpath(file)!==file)fail(code);return stat;}catch{fail(code);}}
export function childEnvironment(base,own={}){
 const allowed=new Set(['HOME','USER','LOGNAME','LANG','LANGUAGE','TZ','TMPDIR','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','XDG_SESSION_TYPE','XDG_CURRENT_DESKTOP','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME']);
 const result={};for(const [key,value] of Object.entries(base))if((allowed.has(key)||key.startsWith('LC_'))&&!sensitive.test(key))result[key]=value;
 return {...result,...own};
}

// File/path/hash checks precede installed-module imports and all process creation.
export async function validateReleaseEntry(env){
 const raw=env.NOZELI_C1_RELEASE;
 if(typeof raw!=='string'||!raw||!path.isAbsolute(raw)||path.normalize(raw)!==raw)fail('RELEASE_ABSOLUTE_REQUIRED');
 if(raw.split(path.sep).some(p=>['current','current-next','bin'].includes(p)))fail('RELEASE_ALIAS_REFUSED');
 if(path.basename(path.dirname(raw))!=='releases'||path.basename(path.dirname(path.dirname(raw)))!=='nozeli'||!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(path.basename(raw)))fail('VERSIONED_RELEASE_REQUIRED');
 try{if(!(await fs.lstat(raw)).isDirectory()||await fs.realpath(raw)!==raw)fail('RELEASE_LINK_REFUSED');}catch{fail('RELEASE_LINK_REFUSED');}
 const privateMatch=raw.match(privatePath),mode=env.NOZELI_C1_MODE||(privateMatch?'private':'installed');
 if(!['private','installed'].includes(mode)||(mode==='private'&&!privateMatch))fail('RELEASE_MODE_INVALID');
 let expectedExe=env.NOZELI_C1_EXPECTED_EXE_SHA256,manifest=env.NOZELI_C1_BUILT_MANIFEST,expectedManifest=env.NOZELI_C1_EXPECTED_MANIFEST_SHA256;
 if(mode==='private'&&(!expectedExe||!manifest||!expectedManifest)){
  const root=privateMatch[1];
  if(!expectedExe){try{expectedExe=JSON.parse(await fs.readFile(path.join(root,'runtime-origins.json'),'utf8')).sourceAndInstalledExeSHA256;}catch{fail('PRIVATE_PROVENANCE_REQUIRED');}}
  if(!expectedManifest){try{expectedManifest=JSON.parse(await fs.readFile(path.join(root,'installer-isolation-patch.json'),'utf8')).builtManifestSHA256;}catch{fail('PRIVATE_PROVENANCE_REQUIRED');}}
  manifest??=path.join(root,'built-manifest.json');
 }
 if(!hex.test(expectedExe||''))fail('EXPECTED_EXE_HASH_REQUIRED');
 if(!manifest||!path.isAbsolute(manifest)||path.normalize(manifest)!==manifest||path.basename(manifest)!=='built-manifest.json')fail('BUILT_MANIFEST_REQUIRED');
 if(!hex.test(expectedManifest||''))fail('EXPECTED_MANIFEST_HASH_REQUIRED');
 const mst=await regular(manifest,'MANIFEST_FILE_UNSAFE');if(mst.size>4*1024*1024)fail('MANIFEST_TOO_LARGE');
 const manifestBytes=await fs.readFile(manifest),manifestSHA256=createHash('sha256').update(manifestBytes).digest('hex');
 if(expectedManifest&&manifestSHA256!==expectedManifest)fail('MANIFEST_HASH_MISMATCH');
 let rows;try{rows=JSON.parse(manifestBytes);}catch{fail('MANIFEST_INVALID');}
 if(!Array.isArray(rows)||!rows.length||rows.length>10000)fail('MANIFEST_INVALID');
 const seen=new Set();let src=false,dist=false;
 for(const row of rows){
  if(!row||typeof row.path!=='string'||!hex.test(row.sha256||'')||!/^(src|dist)\//.test(row.path)||path.posix.normalize(row.path)!==row.path||row.path.includes('\\')||row.path.split('/').some(p=>['..','.ccb','.nozeli','auth.json','state.json'].includes(p))||seen.has(row.path))fail('MANIFEST_PATH_INVALID');
  seen.add(row.path);src||=row.path.startsWith('src/');dist||=row.path.startsWith('dist/');
 }
 if(!src||!dist||!seen.has('src/agents/detect.mjs')||!seen.has('src/main/host.mjs'))fail('MANIFEST_INCOMPLETE');
 const installed=path.join(raw,'resources/app');
 const actual=new Set();
 async function walk(dir,prefix){try{if(!(await fs.lstat(dir)).isDirectory()||await fs.realpath(dir)!==dir)fail('BUILT_FILE_UNSAFE');}catch{fail('BUILT_FILE_UNSAFE');}for(const item of await fs.readdir(dir,{withFileTypes:true})){if(item.isSymbolicLink())fail('BUILT_FILE_UNSAFE');const rel=prefix+'/'+item.name;if(item.isDirectory())await walk(path.join(dir,item.name),rel);else if(item.isFile())actual.add(rel);else fail('BUILT_FILE_UNSAFE');}}
 await walk(path.join(installed,'src'),'src');await walk(path.join(installed,'dist'),'dist');
 if(actual.size!==seen.size||[...actual].some(p=>!seen.has(p)))fail('MANIFEST_COVERAGE_MISMATCH');
 const exe=path.join(raw,'nozeli'),st=await regular(exe,'EXECUTABLE_UNSAFE');if(!(st.mode&0o111))fail('EXECUTABLE_UNSAFE');
 if(await fileSHA256(exe)!==expectedExe)fail('EXE_HASH_MISMATCH');
 for(const row of rows){const file=path.join(installed,row.path);await regular(file,'BUILT_FILE_UNSAFE');if(await fileSHA256(file)!==row.sha256)fail('BUILT_FILE_HASH_MISMATCH');}
 return {release:raw,exe,installed,mode,expectedExeSHA256:expectedExe,builtManifest:manifest,builtManifestSHA256:manifestSHA256,builtFiles:rows.length};
}

export async function prepareOpenEntry(env){
 const entry=await validateReleaseEntry(env);
 let root=env.NOZELI_C1_EVIDENCE_ROOT;
 if(root){if(!path.isAbsolute(root)||path.normalize(root)!==root||!root.startsWith('/tmp/nozeli-'))fail('EVIDENCE_ROOT_UNSAFE');try{if(!(await fs.lstat(root)).isDirectory()||await fs.realpath(root)!==root)fail('EVIDENCE_ROOT_UNSAFE');}catch{fail('EVIDENCE_ROOT_UNSAFE');}}
 else root=os.tmpdir();
 const output=await fs.mkdtemp(path.join(root,'nozeli-c1-open-'));await fs.chmod(output,0o700);
 const emptyHome=path.join(output,'empty-source-home'),emptyBin=path.join(output,'empty-bin');await fs.mkdir(emptyHome);await fs.mkdir(emptyBin);
 try{
  const {detectProviders}=await import(pathToFileURL(path.join(entry.installed,'src/agents/detect.mjs')));
  const preflight=await detectProviders({env:{PATH:emptyBin}});
  if(!preflight||!Array.isArray(preflight.providers)||preflight.providers.length!==3||preflight.providers.some(p=>p.available!==false)||Object.keys(preflight.commands||{}).length)fail('PROVIDER_PREFLIGHT_FAILED');
  if((await fs.readdir(emptyHome)).length||(await fs.readdir(emptyBin)).length)fail('PROVIDER_HOME_NOT_EMPTY');
  return {...entry,output,emptyHome,emptyBin,preflight};
 }catch(e){await fs.writeFile(path.join(output,'entry-rejection.json'),JSON.stringify({code:e.code||'PROVIDER_PREFLIGHT_FAILED',spawned:false}));fail(e.code||'PROVIDER_PREFLIGHT_FAILED');}
}
