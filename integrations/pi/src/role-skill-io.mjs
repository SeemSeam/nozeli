// Windows trusted role skill custody. The exact release-package SKILL.md
// bytes and their parent/file identities are retained through anchored native
// HANDLEs BEFORE the SDK consumes them. The published staged copy's FileID is
// retained, a native read lease is opened and identity/byte-verified BEFORE
// the SDK loader runs, held across the parse (its sharing denies write and
// delete, so the name cannot be retargeted mid-parse), and re-verified after
// the parse — the SDK can only have parsed the published retained bytes. The
// native read tool is served exactly the retained bytes. Other platforms and
// unregistered owners keep the plain catalog-checked path in native-skills.
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {access as fsAccess,readFile as fsReadFile} from 'node:fs/promises';
import {loadSkillsFromDir,createSyntheticSourceInfo,detectSupportedImageMimeTypeFromFile} from '@earendil-works/pi-coding-agent';
import {windowsBridge} from './journal-io.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=(code,message,cause)=>Object.assign(Error(message,{cause}),{code});
const missing=error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===2;
const limit=1024*1024;
const skillFileName='SKILL.md';
const roleSource='nozeli-role-package';

function readBytes(file){
 const size=file.stat().size;
 if(size<0n||size>BigInt(limit))throw fail('PI_ROLE_SKILL_LIMIT','Trusted role skill exceeds the 1 MiB read bound');
 const chunks=[];
 for(let offset=0;offset<Number(size);){
  const bytes=file.readAt(offset,Math.min(256*1024,Number(size)-offset));
  if(!bytes.length)throw fail('PI_ROLE_SKILL_CHANGED','Trusted role skill truncated during native read');
  chunks.push(bytes);offset+=bytes.length;
 }
 file.verify();return Buffer.concat(chunks,Number(size));
}
function closeAll(resources,primary){
 const errors=[];for(const resource of resources)try{resource?.close();}catch(error){errors.push(error);}
 if(errors.length){if(primary)primary.cleanupErrors=errors;else throw fail('PI_ROLE_SKILL_UNCONFIRMED','Role skill HANDLE closure requires reconciliation',errors[0]);}
}
// Read operations for the SDK read tool: catalog skill paths return the exact
// retained bytes; every other path keeps the tool's ordinary file behavior
// (including image detection), so no read semantics are narrowed or widened.
// Retained serving refuses once the owner's custody has been closed.
const roleReadOperations=(retained,assertOpen)=>({
 readFile:async file=>{const entry=retained.get(path.resolve(file));
  if(entry){assertOpen();return Buffer.from(entry.bytes);}
  return fsReadFile(file);},
 access:async file=>{if(retained.has(path.resolve(file))){assertOpen();return;}return fsAccess(file,constants.R_OK);},
 // Retained skills are validated markdown; classification never rereads a
 // drifted catalog file. Other paths keep the SDK's ordinary image sniff.
 detectImageMimeType:async file=>{if(retained.has(path.resolve(file))){assertOpen();return undefined;}return detectSupportedImageMimeTypeFromFile(file);}});

export async function createOwnerRoleSkillIO({agentDir,privateRoot=process.env.NOZELI_PI_PRIVATE_ROOT,directorySync=parent=>parent.syncDirectory()}={}){
 if(process.platform!=='win32'||!privateRoot)return null;
 const relative=path.relative(privateRoot,agentDir);
 if(!path.isAbsolute(privateRoot)||!path.isAbsolute(agentDir)||!relative||path.isAbsolute(relative)||relative.split(path.sep).includes('..'))
  throw fail('PI_ROLE_SKILL_SCOPE','Role skill evidence directory is outside the bound owner root');
 const native=await windowsBridge(),agentRelative=relative.split(path.sep).join('/');
 const streamId=randomUUID();
 let sequence=0,headSha256=null,headFileIdentity=null,poisoned=null,closed=false;
 let agentParent=null,evidenceDir=null,parseDir=null,evidenceBoundIdentity=null,parseBoundIdentity=null;
 const retained=new Map();
 const verifyOpen=()=>{
  if(poisoned)throw poisoned;
  if(closed)throw fail('PI_ROLE_SKILL_CLOSED','Trusted role skill custody is closed with the owner');
 };
 const openAgent=()=>native.openAnchoredPersistenceParent(privateRoot,agentRelative+'/__role_skills_anchor__');
 function publish(parent,name,bytes){
  let stage,primary,published=false;
  try{stage=parent.createPrivateExclusive('.role-'+randomUUID()+'.pending');stage.write(bytes);stage.sync();stage.publishNew(name);published=true;directorySync(parent);parent.verify();return stage.identity();}
  catch(cause){primary=published||cause.committed?fail('PI_ROLE_SKILL_UNCONFIRMED','Role skill evidence publication requires reconciliation',cause):cause;if(published||cause.committed)primary.committed=true;throw primary;}
  finally{closeAll([stage],primary);}
 }
 // The evidence and parse directories are allocated once, their identities
 // bound, and their handles pinned for the owner lifetime: later observations
 // verify the SAME original directory entities (a replaced or contender
 // directory refuses) without repeating allocation barriers. Every file
 // publication still flushes its own parent inside publish().
 function openEvidence(){
  if(evidenceDir){
   if(evidenceDir.identity()!==evidenceBoundIdentity||parseDir.identity()!==parseBoundIdentity)
    throw fail('PI_ROLE_SKILL_UNCONFIRMED','Retained role skill evidence directory was replaced');
   agentParent.verify();evidenceDir.verify();parseDir.verify();
   return {evidence:evidenceDir,parse:parseDir};
  }
  let agent,evidence,parse;
  try{
   agent=openAgent();
   evidence=agent.openPrivateDirectory('role-reads',true);evidence.syncDirectory();agent.syncDirectory();
   parse=evidence.openPrivateDirectory('parse',true);parse.syncDirectory();evidence.syncDirectory();
   evidenceBoundIdentity=evidence.identity();parseBoundIdentity=parse.identity();
   agentParent=agent;evidenceDir=evidence;parseDir=parse;
   return {evidence,parse};
  }catch(error){closeAll([parse,evidence,agent],null);throw error;}
 }
 // Observe the release package through anchored read-only HANDLEs: reparse or
 // hard-link escapes, replaced parents and concurrent namespace changes fail
 // instead of silently retargeting the trusted catalog paths.
 function observe(role,row,rolePackageRoot){
  verifyOpen();
  let root,roleDir,skillsDir,skillDir,file,primary;
  const target=path.resolve(row.filePath);
  const openDirectory=(parent,name)=>{
   try{return parent.openDirectory(name);}
   catch(error){if(!missing(error))throw error;throw fail('PI_ROLE_SKILL_MISSING','Trusted role skill catalog directory is missing from the release package');}
  };
  try{
   root=native.openAnchoredSourceDirectory(rolePackageRoot,'__role_skills_anchor__');
   roleDir=openDirectory(root,role);
   skillsDir=openDirectory(roleDir,'skills');
   skillDir=openDirectory(skillsDir,row.name);
   try{file=skillDir.openFile(skillFileName);}
   catch(error){if(!missing(error))throw error;throw fail('PI_ROLE_SKILL_MISSING','Trusted role skill is missing from the exact release catalog');}
   const bytes=readBytes(file);
   const observation={role,name:row.name,path:target,rolePackageRoot:path.resolve(rolePackageRoot),
    rootIdentity:root.identity(),roleIdentity:roleDir.identity(),skillsIdentity:skillsDir.identity(),parentIdentity:skillDir.identity(),
    fileIdentity:file.stat().identity,bytes};
   skillDir.verify();skillsDir.verify();roleDir.verify();root.verify();
   return observation;
  }catch(error){primary=error;throw error;}finally{closeAll([file,skillDir,skillsDir,roleDir,root],primary);}
 }
 // Retain bytes and identities, publish the staged copy, pin its exact
 // published entity with a native read lease BEFORE the SDK parses it, keep
 // the lease across the parse, then re-verify identity and bytes through the
 // same lease and through a fresh name binding. Only then chain the receipt.
 async function readRoleSkill(role,row,rolePackageRoot){
  verifyOpen();
  const observation=observe(role,row,rolePackageRoot);
  let stagedDirectory=null,stagedLease=null,stagedRecheck=null,primary,wrote=false;
  try{
   const {evidence,parse}=openEvidence();wrote=true;
   const next=sequence+1,base=String(next).padStart(8,'0')+'-'+randomUUID();
   const bytes=observation.bytes;
   const blobIdentity=publish(evidence,base+'.bytes',bytes);
   stagedDirectory=parse.openPrivateDirectory(base,true);stagedDirectory.syncDirectory();parse.syncDirectory();
   const publishedIdentity=publish(stagedDirectory,skillFileName,bytes);
   stagedLease=stagedDirectory.openPrivateObjectRead(skillFileName);
   if(stagedLease.stat().identity!==publishedIdentity||!readBytes(stagedLease).equals(bytes))
    throw fail('PI_ROLE_SKILL_UNCONFIRMED','Staged role skill differs from its publication before SDK parsing');
   stagedLease.verify();
   const loaded=loadSkillsFromDir({dir:stagedDirectory.path,source:roleSource});
   stagedLease.verify();
   if(stagedLease.stat().identity!==publishedIdentity||!readBytes(stagedLease).equals(bytes))
    throw fail('PI_ROLE_SKILL_UNCONFIRMED','The SDK parse window changed the staged role skill');
   stagedRecheck=stagedDirectory.openPrivateObjectRead(skillFileName);
   if(stagedRecheck.stat().identity!==publishedIdentity||!readBytes(stagedRecheck).equals(bytes))
    throw fail('PI_ROLE_SKILL_UNCONFIRMED','The staged role skill name no longer binds the published entity');
   closeAll([stagedRecheck],null);stagedRecheck=null;
   stagedDirectory.verify();parse.verify();
   if(loaded.diagnostics.length||loaded.skills.length!==1||loaded.skills[0].name!==row.name)
    throw fail('PI_SKILL_SCOPE','Invalid or colliding trusted role skill');
   const record={schema:2,streamId,sequence:next,previousSha256:headSha256,previousFileIdentity:headFileIdentity,
    role:observation.role,name:observation.name,path:observation.path,rolePackageRoot:observation.rolePackageRoot,
    rootIdentity:observation.rootIdentity,roleIdentity:observation.roleIdentity,skillsIdentity:observation.skillsIdentity,
    parentIdentity:observation.parentIdentity,fileIdentity:observation.fileIdentity,
    evidenceIdentity:evidenceBoundIdentity,parseRootIdentity:parseBoundIdentity,parseDirectoryIdentity:stagedDirectory.identity(),
    byteLength:bytes.length,sha256:hash(bytes),blob:'role-reads/'+base+'.bytes',blobIdentity,
    parse:'role-reads/parse/'+base+'/'+skillFileName,parseIdentity:publishedIdentity};
   const encoded=Buffer.from(JSON.stringify(record)),identity=publish(evidence,base+'.json',encoded);
   sequence=next;headSha256=hash(encoded);headFileIdentity=identity;
   const skillDirPath=path.dirname(observation.path);
   const skill={...loaded.skills[0],filePath:observation.path,baseDir:skillDirPath,
    sourceInfo:createSyntheticSourceInfo(observation.path,{source:roleSource,baseDir:skillDirPath})};
   retained.set(observation.path,{bytes,record});
   return {skill,record};
  }catch(error){
   primary=error;
   if(wrote)poisoned=fail('PI_ROLE_SKILL_UNCONFIRMED','Retained role skill evidence is incomplete; owner must reconcile',error);
   throw primary;
  }finally{
   try{closeAll([stagedRecheck,stagedLease,stagedDirectory],primary);}
   catch(error){poisoned??=error;throw error;}
  }
 }
 // Idempotent orderly release of the pinned custody HANDLEs (reverse
 // acquisition order). Closure failures are retained as an unknown custody
 // outcome: the first error is thrown with every other error attached, and
 // later use refuses. Closing grants no deletion, release or replay authority.
 function close(){
  if(closed)return;
  closed=true;
  const errors=[];
  for(const handle of [parseDir,evidenceDir,agentParent]){
   if(!handle)continue;
   try{handle.close();}catch(error){errors.push(error);}
  }
  parseDir=null;evidenceDir=null;agentParent=null;
  if(errors.length){
   const error=fail('PI_ROLE_SKILL_UNCONFIRMED','Role skill custody closure requires reconciliation',errors[0]);
   error.cleanupErrors=errors;poisoned=error;throw error;
  }
 }
 return Object.freeze({
  readRoleSkill,
  close,
  readOperations:()=>roleReadOperations(retained,verifyOpen),
  snapshot(){verifyOpen();return {schema:2,streamId,mechanism:'windows-native-role-read-bytes',reads:sequence,headSha256,headFileIdentity,
   directory:path.join(agentDir,'role-reads'),fullRecoveryClosureQualified:false};},
 });
}
