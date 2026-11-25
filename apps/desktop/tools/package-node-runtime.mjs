import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {assertBundledExecutable, sha256File} from '../src/platform/shared/runtime-assets.mjs';

async function readLock(source) {
  let lock;
  try { lock=JSON.parse(await fs.readFile(path.join(source,'tools','node-runtime.lock.json'),'utf8')); }
  catch(error) { if(error.code==='ENOENT')throw Error('No pinned standalone Node for this packaging platform');throw error; }
  if(lock.schema===2) {
    const selected=lock.platforms?.[`${process.platform}-${process.arch}`];
    if(!selected)throw Error('No pinned standalone Node for this packaging platform');
    lock={...selected,schema:1,version:lock.version};
  }
  if(lock.schema!==1||lock.platform!==process.platform||lock.arch!==process.arch)throw Error('No pinned standalone Node for this packaging platform');
  if(!/^[a-f0-9]{64}$/.test(lock.sha256Archive)||path.basename(lock.archive)!==lock.archive)throw Error('Invalid standalone Node archive lock');
  return lock;
}

async function download(lock,archive) {
  const temporary=archive+'.'+randomUUID()+'.partial';
  try {
    const response=await fetch(lock.url);
    if(!response.ok)throw Error('Standalone Node download failed: '+response.status);
    await fs.writeFile(temporary,new Uint8Array(await response.arrayBuffer()),{flag:'wx'});
    if(await sha256File(temporary)!==lock.sha256Archive)throw Error('Standalone Node archive integrity mismatch');
    await fs.rename(temporary,archive);
  } finally { await fs.rm(temporary,{force:true}); }
}

async function extractWindowsZip(archive,directory,lock) {
  if(!lock.archivePrefix||!lock.archive.endsWith('.zip'))throw Error('Windows Node requires a pinned ZIP layout');
  const {default:JSZip}=await import('jszip');
  const zip=await JSZip.loadAsync(await fs.readFile(archive));
  for(const entry of Object.values(zip.files)) {
    const original=entry.unsafeOriginalName??entry.name;
    const components=original.split('/');
    if(components[0]!==lock.archivePrefix||components.some(part=>part==='..'||part==='.')||/[\\:\0]/.test(original))throw Error('Unsafe standalone Node ZIP entry');
    if((Number(entry.unixPermissions)&0o170000)===0o120000)throw Error('Standalone Node ZIP contains a symlink');
    const relative=components.slice(1).join('/');
    if(!relative)continue;
    const target=path.join(directory,relative);
    const within=path.relative(directory,target);
    if(!within||within==='..'||within.startsWith('..'+path.sep)||path.isAbsolute(within))throw Error('Standalone Node ZIP entry escapes staging');
    if(entry.dir)await fs.mkdir(target,{recursive:true});
    else { await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,await entry.async('nodebuffer'),{flag:'wx'}); }
  }
}

// Build artifact publication only: this does not enable the product's
// filesystem/persistence capabilities or write into a user installation.
export async function packageNodeRuntime({source,application,archive:providedArchive=process.env.NOZELI_NODE_ARCHIVE}) {
  const lock=await readLock(source);
  const cache=path.join(source,'.test-output','node-runtime');
  await fs.mkdir(cache,{recursive:true});
  const archive=providedArchive??path.join(cache,lock.archive);
  try { await fs.access(archive); }
  catch(error) { if(error.code!=='ENOENT'||providedArchive)throw error;await download(lock,archive); }
  if(await sha256File(archive)!==lock.sha256Archive)throw Error('Standalone Node archive integrity mismatch');
  const directory=path.join(application,'runtime','node');
  try { await fs.lstat(directory);throw Object.assign(Error('Standalone Node destination already exists'),{code:'EEXIST'}); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  const parent=path.dirname(directory);
  await fs.mkdir(parent,{recursive:true});
  const staging=await fs.mkdtemp(path.join(parent,'.node-runtime-'));
  let published=false;
  try {
    if(process.platform==='win32')await extractWindowsZip(archive,staging,lock);
    else if(process.platform==='linux')execFileSync('tar',['-xJf',archive,'--strip-components=1','-C',staging],{stdio:'inherit'});
    else if(process.platform==='darwin')execFileSync('tar',['-xf',archive,'--strip-components=1','-C',staging],{stdio:'inherit'});
    else throw Error('No standalone Node extraction implementation for this platform');
    const executable=lock.executable??'bin/node';
    if(executable!== (process.platform==='win32'?'node.exe':'bin/node'))throw Error('Unexpected standalone Node executable layout');
    const file=path.join(staging,executable);
    await assertBundledExecutable(file);
    const manifest={...lock,executable,sha256Executable:await sha256File(file)};
    await fs.writeFile(path.join(staging,'NODE-RUNTIME.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
    await fs.rename(staging,directory);published=true;
    return {directory,manifest};
  } finally { if(!published)await fs.rm(staging,{recursive:true,force:true}); }
}
