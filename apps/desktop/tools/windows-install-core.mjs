import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openExperimentalSourceDirectory} from '../src/platform/windows/experimental-source-directory.mjs';
import {openExperimentalPersistenceParent,createExperimentalWindowsPersistence} from '../src/platform/windows/experimental-persistence.mjs';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const json=value=>JSON.stringify(value,null,2)+'\n';
export const reject=(code,message)=>Object.assign(Error(message),{code,automaticReplay:false});
export function absolute(value){if(typeof value!=='string'||!path.isAbsolute(value)||path.resolve(value)!==value||path.dirname(value)===value)throw reject('INSTALL_PATH_REJECTED','Explicit normalized absolute dedicated path required');return value;}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function readBytes(lease,size){const result=Buffer.alloc(size);for(let offset=0;offset<size;){const bytes=lease.readAt(offset,Math.min(262144,size-offset));if(!bytes.length)throw reject('INSTALL_CHANGED','Record truncated');result.set(bytes,offset);offset+=bytes.length;}lease.verify();return result;}
// The manual launcher literal is byte-frozen: every owner record binds its
// exact SHA-256, and both the installer and the updater refuse any drift.
// It lives in this cycle-free core so the updater's shared records reader can
// enforce the known digest without importing the installer tool.
export const windowsLauncher=`# Tool-owned manual isolated installation. Automatic updating is unsupported.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$ioRoot='\\\\?\\'+$root
$owner = [IO.File]::ReadAllText([IO.Path]::Combine($ioRoot, 'WINDOWS-INSTALL.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$state = [IO.File]::ReadAllText([IO.Path]::Combine($ioRoot, 'ACTIVE.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
if ($owner.kind -ne 'windows-isolated-install' -or $state.installationId -ne $owner.installationId -or $state.active -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid installation ownership/state; use install-windows.mjs status' }
$env:NOZELI_WINDOWS_INSTALL_PROFILE = Join-Path $root 'profile'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:NOZELI_TEST_INSTANCE -ErrorAction SilentlyContinue
Remove-Item Env:NOZELI_CONFIG_ROOT -ErrorAction SilentlyContinue
Remove-Item Env:NOZELI_USER_DATA -ErrorAction SilentlyContinue
$payload = Join-Path $root ('versions\\' + $state.active)
$ioPayload='\\\\?\\'+$payload
$manifestFile = [IO.Path]::Combine($ioPayload, 'WINDOWS-CANDIDATE.json')
$pins = [Collections.Generic.List[IDisposable]]::new()
try {
$manifestStream = [IO.File]::Open($manifestFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
$pins.Add($manifestStream)
if ((Get-FileHash -InputStream $manifestStream -Algorithm SHA256).Hash.ToLowerInvariant() -ne $state.versions.($state.active)) { throw 'Installed manifest changed; refusing launch' }
$manifest = [IO.File]::ReadAllText($manifestFile, [Text.Encoding]::UTF8) | ConvertFrom-Json
foreach ($entry in $manifest.entries) {
  if (($entry.path.Split('/') -contains '..') -or $entry.path.Contains(':') -or $entry.path.Contains([char]92) -or $entry.path.StartsWith('/')) { throw 'Invalid manifest path' }
  $file = [IO.Path]::Combine($ioPayload, $entry.path.Replace([char]47,[char]92))
  $attributes = [IO.File]::GetAttributes($file)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse payload entry rejected' }
  if ($entry.type -eq 'file') {
    $stream = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $pins.Add($stream)
    if ($stream.Length -ne $entry.bytes -or (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw 'Installed payload changed; refusing launch' }
  }
}
& (Join-Path $payload 'resources\\app\\runtime\\node\\node.exe') (Join-Path $payload 'resources\\app\\tools\\install-windows.mjs') launch --root $root -- @args
$launchExit = $LASTEXITCODE
} finally { foreach ($pin in $pins) { $pin.Dispose() } }
exit $launchExit
`;
export const knownWindowsLauncherDigest=()=>sha256(windowsLauncher);

// Native HANDLEs reject reparse points, hard links and entity replacement and
// retain every observed member until the operation completes.
export async function openPayload(directory){
 absolute(directory);const directories=[],files=[],entries=[];
 async function hash(lease,size){const h=createHash('sha256');for(let offset=0;offset<size;){const bytes=lease.readAt(offset,Math.min(262144,size-offset));if(!bytes.length)throw reject('INSTALL_CHANGED','Truncated payload');h.update(bytes);offset+=bytes.length;}lease.verify();return h.digest('hex');}
 async function walk(lease,relative){
  const record={lease,rows:null};directories.push(record);const rows=lease.entries(10000);record.rows=rows;if(relative)entries.push({path:relative,type:'directory'});
  const names=new Set();for(const row of rows){const folded=row.name.normalize('NFKC').toUpperCase().toLowerCase();if(!row.name.isWellFormed()||names.has(folded))throw reject('INSTALL_CHANGED','Ambiguous Windows payload names');names.add(folded);}
  for(const row of [...rows].sort((a,b)=>a.name<b.name?-1:1)){
   const name=relative?relative+'/'+row.name:row.name;
   if(row.directory){const child=lease.openDirectory(row.name);if(child.identity()!==row.identity){child.close();throw reject('INSTALL_CHANGED','Payload directory entity changed');}await walk(child,name);}
   else {const file=lease.openFile(row.name);files.push({lease:file,path:name});const stat=file.stat();if(stat.identity!==row.identity||stat.attributes!==row.attributes||stat.size>BigInt(Number.MAX_SAFE_INTEGER))throw reject('INSTALL_CHANGED','Payload entity changed');const bytes=Number(stat.size);entries.push({path:name,type:'file',bytes,sha256:await hash(file,bytes)});}
  }
  lease.verify();if(!equal(rows,lease.entries(10000)))throw reject('INSTALL_CHANGED','Payload membership changed');
 }
 const close=()=>{const errors=[];for(const row of [...files,...directories.slice().reverse()])try{row.lease.close();}catch(error){errors.push(error);}if(errors.length)throw Object.assign(errors[0],{cleanupErrors:errors});};
 try{await walk(openExperimentalSourceDirectory(path.dirname(directory),directory),'');entries.sort((a,b)=>a.path<b.path?-1:1);}catch(error){close();throw error;}
 const filesByPath=new Map(),entriesByPath=new Map();for(const row of files)filesByPath.set(row.path,row);for(const entry of entries)entriesByPath.set(entry.path,entry);
 return {entries,close,
  readAt(name,offset,length){const file=filesByPath.get(name);if(!file||!Number.isSafeInteger(offset)||offset<0||length>65536)throw reject('INSTALL_READ_REJECTED','Invalid bounded payload read');return file.lease.readAt(offset,length);},
  async verify(){for(const row of directories){row.lease.verify();if(!equal(row.rows,row.lease.entries(10000)))throw reject('INSTALL_CHANGED','Payload membership changed');}for(const row of files){const entry=entriesByPath.get(row.path);if(await hash(row.lease,entry.bytes)!==entry.sha256)throw reject('INSTALL_CHANGED','Payload digest changed');}},
  read(name){const file=filesByPath.get(name),entry=entriesByPath.get(name);if(!file||entry.bytes>16777216)throw reject('INSTALL_MANIFEST_REJECTED','Missing or oversized manifest');return readBytes(file.lease,entry.bytes);},
  async copyTo(root,relative){
   const parent=openExperimentalPersistenceParent(root,relative);const retained=[];
   try{
    const top=parent.createPrivateTreeRootExclusive(relative.split('/').at(-1));retained.push(top);const dirs=new Map([['',top]]);
    for(const entry of [...entries].sort((a,b)=>a.path.split('/').length-b.path.split('/').length||(a.path<b.path?-1:1))){
     const name=path.posix.basename(entry.path),dir=dirs.get(path.posix.dirname(entry.path)==='.'?'':path.posix.dirname(entry.path));
     if(entry.type==='directory'){const next=dir.openPrivateDirectory(name,true);retained.push(next);dirs.set(entry.path,next);}
     else {const input=filesByPath.get(entry.path).lease;const output=dir.createPrivateExclusive('.copy-'+sha256(entry.path));try{for(let offset=0;offset<entry.bytes;){const bytes=input.readAt(offset,Math.min(262144,entry.bytes-offset));if(!bytes.length)throw reject('INSTALL_CHANGED','Source truncated');output.write(bytes);offset+=bytes.length;}output.sync();output.publishNew(name);}finally{output.close();}}
    }
    await this.verify();for(const dir of [...dirs.values()].reverse())dir.syncDirectory();parent.syncDirectory();
   }finally{for(const lease of retained.reverse())lease.close();parent.close();}
  }
 };
}
export async function readRegular(file){const directory=path.dirname(file);const parent=openExperimentalSourceDirectory(path.dirname(directory),directory);try{const lease=parent.openFile(path.basename(file));try{const stat=lease.stat();if(stat.size>16777216n)throw reject('INSTALL_MANIFEST_REJECTED','Record too large');return readBytes(lease,Number(stat.size));}finally{lease.close();}}finally{parent.close();}}
export async function writeRecord(root,name,value,expected=null){return createExperimentalWindowsPersistence(root).writeAtomic(name,json(value),{expectedSha256:expected});}
export async function exists(file){try{await fs.lstat(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
