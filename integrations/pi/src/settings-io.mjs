// SDK storage boundary: the SDK retains parsing, merging, migration, trust and
// dirty-field semantics. Windows buffers exact bytes from native HANDLE reads
// for the next durable evidence boundary.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SettingsManager} from '@earendil-works/pi-coding-agent';
import {windowsBridge} from './journal-io.mjs';
import {createReadEvidenceJournal} from './read-evidence-journal.mjs';

const fail=(code,message,cause)=>Object.assign(Error(message,{cause}),{code});
const missing=error=>error.code==='WIN32_IO_ERROR'&&error.win32Code===2;
const limit=1024*1024;
function readBytes(file){
 const size=file.stat().size;
 if(size<0n||size>BigInt(limit))throw fail('PI_SETTINGS_LIMIT','Settings exceed the 1 MiB read bound');
 const chunks=[];
 for(let offset=0;offset<Number(size);){
  const bytes=file.readAt(offset,Math.min(256*1024,Number(size)-offset));
  if(!bytes.length)throw fail('PI_SETTINGS_CHANGED','Settings truncated during native read');
  chunks.push(bytes);offset+=bytes.length;
 }
 file.verify();return Buffer.concat(chunks,Number(size));
}
function closeAll(resources,primary){
 const errors=[];for(const resource of resources)try{resource?.close();}catch(error){errors.push(error);}
 if(errors.length){if(primary)primary.cleanupErrors=errors;else throw fail('PI_SETTINGS_UNCONFIRMED','Settings HANDLE closure requires reconciliation',errors[0]);}
}
// All effects are synchronous because SettingsStorage.withLock is synchronous.
// No global SDK monkey patch and no path-only write fallback.
export async function createOwnerSettingsIO({agentDir,privateRoot=process.env.NOZELI_PI_PRIVATE_ROOT,directorySync=parent=>parent.syncDirectory()}={}){
 if(process.platform!=='win32'||!privateRoot)return null;
 const relative=path.relative(privateRoot,agentDir);
 if(!path.isAbsolute(privateRoot)||!path.isAbsolute(agentDir)||!relative||path.isAbsolute(relative)||relative.split(path.sep).includes('..'))
  throw fail('PI_SETTINGS_SCOPE','Agent settings are outside the bound owner root');
 const native=await windowsBridge(),agentRelative=relative.split(path.sep).join('/');
 let poisoned=null;
 const check=()=>{if(poisoned)throw poisoned;};
 const openAgent=()=>native.openAnchoredPersistenceParent(privateRoot,agentRelative+'/__settings_anchor__');
 const evidence=createReadEvidenceJournal({openAgent,member:'settings-reads',streamId:randomUUID(),schema:3,
  mechanism:'windows-native-settings-read-journal',directory:path.join(agentDir,'settings-reads'),byteLimit:limit,directorySync});
 const flushEvidence=()=>{check();try{evidence.flush();}catch(cause){throw poisoned=fail('PI_SETTINGS_UNCONFIRMED','Settings read evidence requires reconciliation',cause);}};
 function retain({scope,cwd,path:target,projectIdentity,parentIdentity,absentParent,identity,bytes}){
  evidence.retain({scope,cwd,path:target,projectIdentity:projectIdentity??null,parentIdentity:parentIdentity??null,
   absentParent:absentParent??false,fileIdentity:identity??null},bytes);
 }
 function observe(cwd,scope){
  check();let project,parent,file,primary;
  const target=scope==='global'?path.join(agentDir,'settings.json'):path.join(cwd,'.pi','settings.json');
  try{
   if(scope==='global')parent=openAgent();
   else{
    project=native.openAnchoredSourceDirectory(cwd,'__settings_anchor__');
    try{parent=project.openDirectory('.pi');}
    catch(error){if(!missing(error))throw error;project.verify();return {scope,cwd,path:target,bytes:null,projectIdentity:project.identity(),absentParent:true};}
   }
   const fact={scope,cwd,path:target,projectIdentity:project?.identity(),parentIdentity:parent.identity(),bytes:null};
   try{file=scope==='global'?parent.openPrivateObjectRead('settings.json'):parent.openFile('settings.json');}
   catch(error){if(!missing(error))throw error;parent.verify();project?.verify();return fact;}
   fact.bytes=readBytes(file);fact.identity=file.stat().identity;parent.verify();project?.verify();return fact;
  }catch(error){primary=error;throw error;}finally{closeAll([file,parent,project],primary);}
 }
 function write(cwd,scope,expected,next){
  check();if(typeof next!=='string'||Buffer.byteLength(next)>limit)throw fail('PI_SETTINGS_LIMIT','Settings candidate must be a string of at most 1 MiB');
  flushEvidence();
  let project,parent,created,transaction,stage,primary,published=false;
  try{
   if(scope==='global')parent=openAgent();
   else{
    project=native.openAnchoredPublicMutationParent(cwd,'.pi');
    if(project.identity()!==expected.projectIdentity)throw fail('PI_SETTINGS_CONFLICT','Project directory identity changed');
    if(expected.absentParent){created=project.createPublicDirectoryExclusive('.pi');created.syncDirectory();project.syncDirectory();parent=created;}
    else{parent=native.openAnchoredPublicMutationParent(cwd,'.pi/settings.json');if(parent.identity()!==expected.parentIdentity)throw fail('PI_SETTINGS_CONFLICT','Project settings directory identity changed');}
   }
   if(scope==='global'&&parent.identity()!==expected.parentIdentity)throw fail('PI_SETTINGS_CONFLICT','Global settings directory identity changed');
   const bytes=Buffer.from(next);
   if(expected.bytes===null){
    stage=scope==='global'?parent.createPrivateExclusive('.settings-'+randomUUID()+'.pending'):parent.createPublicExclusive('.settings-'+randomUUID()+'.pending');
    stage.write(bytes);stage.sync();stage.publishNew('settings.json');published=true;
   }else{
    transaction=parent.beginReplacement('settings.json');
    if(transaction.stat().identity!==expected.identity||!transaction.read().equals(expected.bytes))throw fail('PI_SETTINGS_CONFLICT','Settings changed after the actual read; external version retained');
    transaction.prepare(bytes,'.settings-'+randomUUID()+'.pending');transaction.commit();published=true;
   }
   closeAll([transaction,stage]);transaction=stage=null;directorySync(parent);parent.verify();project?.verify();
  }catch(cause){
   primary=cause;
   if(published||cause.committed||cause.transactionOutcome==='unknown'){
    primary=fail('PI_SETTINGS_UNCONFIRMED','Settings publication requires reconciliation; do not retry',cause);
    primary.committed=published||cause.committed===true;primary.transactionOutcome=cause.transactionOutcome;poisoned=primary;
   }
   throw primary;
  }finally{
   try{closeAll([transaction,stage,created===parent?null:created,parent,project],primary);}
   catch(error){poisoned=error;throw error;}
   if(primary?.cleanupErrors?.length)poisoned=fail('PI_SETTINGS_UNCONFIRMED','Settings cleanup outcome requires reconciliation',primary);
  }
 }
 function storage(cwd){
  cwd=path.resolve(cwd);
  return {withLock(scope,fn){
   if(!['global','project'].includes(scope)||typeof fn!=='function')throw new TypeError('Expected SDK settings scope and callback');
   let observation;
   try{observation=observe(cwd,scope);retain(observation);}
   catch(cause){poisoned=fail('PI_SETTINGS_UNCONFIRMED','Native settings observation could not be confirmed',cause);throw poisoned;}
   const next=fn(observation.bytes===null?undefined:observation.bytes.toString('utf8'));
   if(next!==undefined)write(cwd,scope,observation,next);
  }};
 }
 return Object.freeze({
  createSettingsManager(cwd){
   const manager=SettingsManager.fromStorage(storage(cwd));check();
   return new Proxy(manager,{get(target,key){
    const value=Reflect.get(target,key,target);
    if(typeof value!=='function')return value;
    return (...args)=>{check();const result=value.apply(target,args);check();return result?.then?result.then(value=>{check();return value;}):result;};
   }});
  },
  async readRecord(cwd,scope){
   let observation;
   try{observation=observe(path.resolve(cwd),scope);retain(observation);}
   catch(cause){poisoned=fail('PI_SETTINGS_UNCONFIRMED','Native settings observation could not be confirmed',cause);throw poisoned;}
   try{const parsed=JSON.parse(observation.bytes?.toString('utf8')??'');return typeof parsed==='object'&&parsed!==null?parsed:{};}catch{return {};}
  },
  flush:flushEvidence,close:evidence.close,
  snapshot(){flushEvidence();return evidence.snapshot();},
 });
}
