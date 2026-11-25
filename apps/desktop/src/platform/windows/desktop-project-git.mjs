// Explicit Windows effects for the shared project Git state machine. Namespace
// durability and the complete desktop product remain under qualification.
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {runGit} from '../../agents/managed/git-runtime.mjs';
import {experimentalWindowsReadFilesystem as reads} from './experimental-filesystem.mjs';
import {ensureExperimentalPrivateDirectory} from './experimental-directories.mjs';
import {openExperimentalPersistenceParent,createExperimentalWindowsPersistence} from './experimental-persistence.mjs';
import {openExperimentalSourceDirectory} from './experimental-source-directory.mjs';
import {openExperimentalPrivateTree} from './experimental-private-tree.mjs';
import {openExperimentalAnchoredRead} from './experimental-read.mjs';
const require=createRequire(import.meta.url),fail=(code,message)=>Object.assign(Error(message),{code});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const missing=error=>error.code==='WIN32_IO_ERROR'&&[2,3].includes(error.win32Code);
const identity=text=>{const [dev,ino]=text.split(':');return {dev,ino,kind:'windows-file-id-128'};};
const gitConfig=['-c','core.fsync=all','-c','core.fsyncMethod=fsync'];

export function createWindowsDesktopProjectGitIO(project){
 if(process.platform!=='win32'||process.arch!=='x64')throw fail('FS_PLATFORM_UNSUPPORTED','Native Windows x64 project Git required');
 project=path.resolve(project);const bridge=require('../../../native/windows/build/Release/nozeli_windows_read.node'),pins=new Map(),layoutPins=[];let closed=false,repositoryRoot=null;
 const check=()=>{
  if(closed)throw fail('PROJECT_GIT_CLOSED','Git operation scope closed');
  for(const pin of pins.values())pin.verify();
  for(const pin of layoutPins)if(!pin.verify())throw fail('PROJECT_GIT_CONFLICT','Linked worktree binding changed');
 };
 const relative=file=>path.relative(path.parse(file).root,file).split(path.sep).join('/');
 const parent=file=>openExperimentalPersistenceParent(path.parse(file).root,relative(file));
 const persistence=file=>createExperimentalWindowsPersistence(path.parse(file).root);
 const pinExactGitFile=(file,expected)=>{
  check();let directory,pin;
  const verify=()=>{check();directory.verify();pin.verify();};
  const close=()=>{try{pin?.close();}finally{directory?.close();}};
  try{
   directory=parent(file);pin=directory.openPrivateObjectRead(path.basename(file));
   if(pin.stat().size!==BigInt(expected.length)||!pin.readAt(0,expected.length).equals(expected))throw fail('PROJECT_GIT_HEAD_CONFLICT','Baseline Git ref changed');
   verify();return {verify,close};
  }catch(error){close();if(missing(error))throw Object.assign(fail('PROJECT_GIT_HEAD_CONFLICT','Expected loose baseline Git ref is missing'),{cause:error});throw error;}
 };
 const directoryIdentity=async directory=>{
  check();directory=path.resolve(directory);let pin=pins.get(directory);
  if(!pin){pin=bridge.openAnchoredDirectoryIdentity(path.dirname(directory),path.basename(directory)+'/__git_identity__');pins.set(directory,pin);}
  pin.verify();return identity(pin.identity());
 };
 const exists=async file=>{
  check();let p;
  try{
   // A single relative component means every directory belongs to the existing
   // root: this constructor cannot provision any relative directory. Observation
   // needs no write/flush access to ordinary ancestor directories or the volume.
   p=bridge.openAnchoredWriteParent(path.dirname(file),path.basename(file));
   const entry=p.inspectEntry(path.basename(file));if(!entry)return null;
   if(path.basename(file)==='.git'){
    if(entry.reparse)throw fail('PROJECT_GIT_LAYOUT_UNSUPPORTED','Reparse Git metadata is unsupported');
    if(entry.directory)await directoryIdentity(file);
   }
   return {...identity(entry.identity),isDirectory:()=>entry.directory,isSymbolicLink:()=>entry.reparse,isFile:()=>!entry.directory&&!entry.reparse};
  }catch(error){if(missing(error))return null;throw error;}finally{p?.close();}
 };
 const unsupported=()=>fail('PROJECT_GIT_LAYOUT_UNSUPPORTED','Expected a local Git linked worktree with reciprocal ownership');
 const key=file=>path.normalize(file).replace(/^[a-z]:/i,drive=>drive.toUpperCase());
 const resolveLink=(base,text)=>{
  const input=text.replaceAll('/','\\'),absolute=/^[a-z]:\\/i.test(input);
  let named=absolute;
  // Only a leading relative ascent is allowed: never normalize away a named entry.
  for(const part of (absolute?input.slice(3):input).split('\\')){
   if(part==='..'&&!named)continue;
   if(!part||/[<>:"|?*]/.test(part)||/[ .]$/.test(part))throw unsupported();
   named=true;
  }
  return path.resolve(base,input);
 };
 const pinRecord=file=>{
  const pin=openExperimentalAnchoredRead(path.parse(file).root,relative(file));layoutPins.push(pin);
  const {size}=pin.stat();if(size<1n||size>32768n)throw unsupported();
  const bytes=pin.readAt(0,Number(size));if(bytes.length!==Number(size))throw unsupported();
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes).replace(/\r?\n$/,'');
  if(!text||/[\x00-\x1f\x7f\ufeff]/.test(text))throw unsupported();
  return {text,id:pin.identity()};
 };
 const prepareRepository=async(root,dotGit)=>{
  repositoryRoot=root;
  if(dotGit.isDirectory())return null;
  const pointer=path.join(root,'.git');
  try{
   const forward=pinRecord(pointer);
   if(forward.id!==`${dotGit.dev}:${dotGit.ino}`)throw fail('PROJECT_GIT_CONFLICT','Linked worktree pointer was replaced');
   if(!forward.text.startsWith('gitdir: '))throw unsupported();
   const gitDirectory=resolveLink(root,forward.text.slice(8));
   const worktrees=path.dirname(gitDirectory),commonDirectory=path.dirname(worktrees);
   if(path.basename(worktrees)!=='worktrees'||path.basename(commonDirectory)!=='.git')throw unsupported();
   const admin=await directoryIdentity(gitDirectory),common=await directoryIdentity(commonDirectory);
   const shared=pinRecord(path.join(gitDirectory,'commondir')),back=pinRecord(path.join(gitDirectory,'gitdir'));
   if(key(resolveLink(gitDirectory,shared.text))!==key(commonDirectory)||key(resolveLink(gitDirectory,back.text))!==key(pointer))throw unsupported();
   check();return {gitDirectory,commonDirectory,binding:{pointer:forward.id,admin,common,commondir:shared.id,gitdir:back.id}};
  }catch(error){
   if(error.code?.startsWith('PROJECT_GIT_'))throw error;
   throw Object.assign(unsupported(),{cause:error});
  }
 };
 const capture=async(file,{maxBytes=16*1024*1024}={})=>{
  check();const reader=await reads.openAnchoredFile(path.parse(file).root,relative(file));if(!reader)return null;
  try{if(reader.stat.size>BigInt(maxBytes))throw fail('PROJECT_GIT_FILE_LIMIT','Git metadata exceeds the bounded read size');const chunks=[];for await(const chunk of reader.stream())chunks.push(chunk);if(!(await reader.verify()).stable)throw fail('PROJECT_GIT_FILE_CONFLICT','File changed while reading Git metadata');check();return Buffer.concat(chunks);}
  finally{await reader.close();}
 };
 const lock=async(file,busy)=>{
  const p=parent(file);let stage;
  try{stage=p.createPrivateExclusive(path.basename(file));stage.write(Buffer.from('nozeli-git:'+randomUUID()));stage.sync();p.syncDirectory();}
  catch(error){try{stage?.close();}finally{p.close();}if(error.code==='FS_TARGET_EXISTS'||error.code==='WIN32_IO_ERROR'&&[80,183].includes(error.win32Code))throw fail(busy,'Git lock is occupied; retry explicitly');throw error;}
  return {verify(){check();if(!stage.verify())throw fail('PROJECT_GIT_LOCK_CONFLICT','Owned Git lock changed');},close(){try{stage.close();p.syncDirectory();}finally{p.close();}}};
 };
 return Object.freeze({
  requireSupported:check,directoryIdentity,exists,prepareRepository,gitConfig,beforeGit:check,
  async canonicalDirectory(directory){await directoryIdentity(path.resolve(directory));return path.resolve(directory);},
  async readText(file){const bytes=await capture(file);if(bytes===null)throw fail('ENOENT','Git operation marker missing');return bytes.toString('utf8');},
  async listDirectory(directory){
   check();const lease=openExperimentalSourceDirectory(path.dirname(directory),directory);
   try{const rows=lease.entries(10000);lease.verify();return rows.map(row=>({name:row.name,isDirectory:()=>row.directory,isFile:()=>!row.directory,isSymbolicLink:()=>false}));}finally{lease.close();}
  },
  async createScratch(){const scratch=path.join(project,'.nozeli','git-initialization',randomUUID());await ensureExperimentalPrivateDirectory(project,scratch);return scratch;},
  async removeScratch(scratch){
   check();const tree=await openExperimentalPrivateTree(project,scratch,{deletion:true});
   try{await tree.remove({expectedManifestSha256:tree.manifest.sha256});}finally{tree.close();}
  },
  async allocateRepository(ownGit,marker,operationId){
   check();if(ownGit!==path.join(project,'.git')||marker!==path.join(ownGit,'nozeli-initialization'))throw fail('PROJECT_GIT_SCOPE_REQUIRED','Repository allocation outside selected project');
   const p=parent(ownGit);let dir;
   try{dir=p.createPrivateDirectoryExclusive('.git');dir.syncDirectory();p.syncDirectory();await persistence(marker).writeStream(relative(marker),[Buffer.from(operationId)],{expectedSha256:null});}
   finally{try{dir?.close();}finally{p.close();}}
   const skeleton=['refs','refs/heads','refs/tags','refs/remotes','objects','objects/info','objects/pack','info','hooks','logs','logs/refs','logs/refs/heads','logs/refs/remotes','worktrees'];for(let n=0;n<256;n++)skeleton.push('objects/'+n.toString(16).padStart(2,'0'));for(const component of skeleton)await ensureExperimentalPrivateDirectory(project,path.join(ownGit,component));
   await directoryIdentity(ownGit);repositoryRoot=project;
  },
  async ensureIgnore(file,rule,effective,verifyRoot){
   check();if(!repositoryRoot||file!==path.join(repositoryRoot,'.gitignore'))throw fail('PROJECT_GIT_SCOPE_REQUIRED','Ignore file outside discovered repository');
   if(await effective())return {path:file,rule,changed:false};
   const held=await lock(file+'.lock','PROJECT_GIT_IGNORE_BUSY');
   try{
    const original=await capture(file);if(await effective())return {path:file,rule,changed:false};
    const before=original??Buffer.alloc(0),newline=before.includes(Buffer.from('\r\n'))?'\r\n':'\n',separator=before.length&&before.at(-1)!==10?newline:'';
    const next=Buffer.concat([before,Buffer.from(separator+rule+newline)]);await verifyRoot();held.verify();
    await persistence(file).writeStream(relative(file),[next],{expectedSha256:original===null?null:sha(original),expectedNewSha256:sha(next)});
    return {path:file,rule,changed:true};
   }finally{held.close();}
  },
  async captureFile(file,config,root,env){
   check();const reader=await reads.openAnchoredFile(root,path.relative(root,file).split(path.sep).join('/'));if(!reader)throw fail('PROJECT_GIT_FILE_CONFLICT','Baseline file disappeared');
   try{const oid=(await runGit(root,[...config,...gitConfig,'hash-object','--no-filters','-w','--stdin'],{env,encoding:'utf8',input:reader.stream()})).trim();if(!(await reader.verify()).stable)throw fail('PROJECT_GIT_FILE_CONFLICT','Baseline source changed');check();return {oid,mode:'100644'};}
   finally{await reader.close();}
  },
 // Git's files backend cannot verify symbolic HEAD and create its referent in
 // one transaction. Deny writes and replacements of the exact HEAD while Git
 // still owns the branch's lock, zero-OID check and durability barriers.
 pinInitialHead(ownGit){
  if(ownGit!==path.join(project,'.git'))throw fail('PROJECT_GIT_SCOPE_REQUIRED','Initial HEAD outside selected project');
  return pinExactGitFile(path.join(ownGit,'HEAD'),Buffer.from('ref: refs/heads/main\n'));
 },
 pinInitialBranch(ownGit,commit){
  if(ownGit!==path.join(project,'.git')||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))throw fail('PROJECT_GIT_SCOPE_REQUIRED','Invalid initial branch binding');
  return pinExactGitFile(path.join(ownGit,'refs','heads','main'),Buffer.from(commit+'\n'));
 },
  async publishInitialIndex(ownGit,baselineIndex,verifyRoot){
   if(ownGit!==path.join(project,'.git'))throw fail('PROJECT_GIT_SCOPE_REQUIRED','Initial index outside selected project');
   const file=path.join(ownGit,'index'),held=await lock(file+'.lock','PROJECT_GIT_INDEX_BUSY');
   try{const bytes=await capture(baselineIndex);if(bytes===null)throw fail('PROJECT_GIT_INDEX_CONFLICT','Prepared index disappeared');await verifyRoot();held.verify();if(await exists(file))return;
    try{await persistence(file).writeStream(relative(file),[bytes],{expectedSha256:null,expectedNewSha256:sha(bytes)});}catch(error){if(error.code!=='FS_TARGET_EXISTS')throw error;}
   }finally{held.close();}
  },
  qualification:Object.freeze({state:'barriers-completed',durability:'namespace-not-qualified',linkedWorktrees:'local-reciprocal',reparseEntries:'unsupported'}),
  close(){for(const pin of layoutPins.reverse())pin.close();for(const pin of [...pins.values()].reverse())pin.close();pins.clear();closed=true;},
 });
}
