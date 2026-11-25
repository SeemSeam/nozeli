// Copy only explicit Nozeli configuration into each owner, never ambient homes.
// Each target update is CAS against the last copied bytes; owner/external edits
// are retained as conflicts. Source HANDLEs stay verified through publication.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createWindowsDesktopProfileIO} from './desktop-profile.mjs';
import {createExperimentalWindowsPersistence,openExperimentalPersistenceParent} from './experimental-persistence.mjs';
import {experimentalPrivateDirectoryComponents} from './experimental-directories.mjs';

const names=['models.json','auth.json','models-store.json','settings.json'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=()=>Object.assign(Error('Private owner configuration changed independently; source and owner versions retained'),{code:'PI_CONFIGURATION_CONFLICT'});
export function createOwnerConfigurationSource({sourceRoot,sourceDirectory,targetRoot,home,agentDir}){
 const sourceRelative=experimentalPrivateDirectoryComponents(sourceRoot,sourceDirectory).join('/');
 const io=createWindowsDesktopProfileIO(targetRoot),persistence=createExperimentalWindowsPersistence(targetRoot);
 const manifestFile=path.join(home,'configuration-source.json');
 let pending;
 const synchronize=async()=>{
  const previous=await io.read(manifestFile,{maxBytes:65536});
  let state=null;
  if(previous.bytes){try{state=JSON.parse(previous.bytes.toString('utf8'));}catch{throw fail();}
   if(state.schema!==1||state.sourceDirectory!==sourceDirectory||!state.files||Object.keys(state.files).length!==names.length||names.some(name=>!Object.hasOwn(state.files,name)||!state.files[name]||(state.files[name].sha256!==null&&!/^[a-f0-9]{64}$/.test(state.files[name].sha256))))throw fail();}
  const next={schema:1,sourceDirectory,files:{}};
  for(const name of names){
   let parent,file;
   try{
    parent=openExperimentalPersistenceParent(sourceRoot,sourceRelative+'/'+name);
    try{file=parent.openPrivateObjectRead(name);}catch(error){if(error.code!=='WIN32_IO_ERROR'||error.win32Code!==2)throw error;}
    let bytes=null,identity=null;
    if(file){const stat=file.stat();if(stat.size>8n*1024n*1024n)throw Object.assign(Error('Private configuration exceeds 8 MiB'),{code:'PI_CONFIGURATION_LIMIT'});
     const chunks=[];let offset=0;while(offset<Number(stat.size)){const chunk=file.readAt(offset,Math.min(262144,Number(stat.size)-offset));if(!chunk.length)throw fail();chunks.push(chunk);offset+=chunk.length;}bytes=Buffer.concat(chunks,offset);identity=stat.identity;file.verify();}
    const sourceSha256=bytes===null?null:sha(bytes),target=path.join(agentDir,name),current=await io.read(target,{maxBytes:8*1024*1024});
    const expected=state?.files[name]?.sha256??null;
    // Never adopt an unknown pre-existing owner file, even if its bytes happen
    // to equal the source: an independently written auth version has authority.
    if(current.sha256!==expected&&(!state||sourceSha256!==expected))throw fail();
    const verify=()=>{if(file)file.verify();else if(parent.inspectEntry(name))throw fail();parent.verify();};
    verify();
    if(sourceSha256!==expected){
     if(bytes===null)await persistence.removeVersioned(experimentalPrivateDirectoryComponents(targetRoot,target).join('/'),{expectedSha256:expected});
     else await persistence.writeStream(experimentalPrivateDirectoryComponents(targetRoot,target).join('/'),[bytes],{expectedSha256:expected,expectedNewSha256:sourceSha256,beforePublish:verify});
    }
    verify();next.files[name]={sha256:sourceSha256,sourceIdentity:identity,sourceParentIdentity:parent.identity()};
   }finally{file?.close();parent?.close();}
  }
  await io.write(manifestFile,Buffer.from(JSON.stringify(next)),{expectedSha256:previous.sha256});
 };
 return Object.freeze({synchronize(){if(pending)return pending;pending=synchronize().finally(()=>{pending=null;});return pending;}});
}
