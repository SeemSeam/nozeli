// Explicit local Pi owner launch; never selected by production capabilities.
// Kernel pins cover the private directory entities and exact executable/entry
// bytes. SDK resource/journal/cold ownership qualification remains separate.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {setImmediate} from 'node:timers/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {defineRegisteredOwnerLaunch} from '../../agents/managed/prepared-owner-launch.mjs';
import {ensureExperimentalPrivateDirectory,experimentalPrivateDirectoryComponents} from './experimental-directories.mjs';
import {openExperimentalAnchoredRead} from './experimental-read.mjs';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';
import {prepareExperimentalProcessTransport} from './experimental-process-transport.mjs';
import {retainExperimentalOwnerExitProof} from './experimental-owner-exit-proof.mjs';
import {verifyExperimentalPreparedSupervisor} from './experimental-process-supervisor.mjs';
import {createOwnerMetadataCustody} from './owner-metadata-custody.mjs';

const require=createRequire(import.meta.url);
const fail=(code,message)=>Object.assign(Error(message),{code});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export function createExperimentalPiOwnerLaunch({root,home,agentDir,runtime,registry,target,isCurrent,supervise=false}){
  runtime=Object.freeze({...runtime});
  if(process.platform!=='win32'||process.arch!=='x64')throw fail('PI_PLATFORM_UNSUPPORTED','Windows x64 required');
  for(const file of [runtime?.command,runtime?.entry])if(typeof file!=='string'||!path.isAbsolute(file))throw fail('PI_RUNTIME_INVALID','Exact absolute runtime command and owner entry required');
  for(const value of [runtime.commandSha256,runtime.entrySha256])if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw fail('PI_RUNTIME_INVALID','Approved runtime executable/entry digests required');
  if(runtime.shell!==undefined&&(typeof runtime.shell!=='string'||!path.isAbsolute(runtime.shell)))throw fail('PI_RUNTIME_INVALID','Pinned worker shell must be an absolute path');
  if(runtime.toolPath!==undefined&&(typeof runtime.toolPath!=='string'||runtime.toolPath.includes('\0')))throw fail('PI_RUNTIME_INVALID','Worker tool PATH must be a string without NUL');
  for(const directory of [home,agentDir])experimentalPrivateDirectoryComponents(root,directory);
  if(typeof isCurrent!=='function')throw fail('PI_LAUNCH_CONTRACT_INVALID','Current-owner guard required');
  const directories=[],directoryPins=new Map(),files=[],transports=new WeakSet(),supervisors=new Set();
  const environmentRoot=path.join(home,'environment'),temporary=path.join(home,'temporary');
  let initializing,closed=false,metadata,facts,nativeSha,ownerHome;
  const nativeFile=fileURLToPath(new URL('../../../native/windows/build/Release/nozeli_windows_read.node',import.meta.url));
  const relative=file=>experimentalPrivateDirectoryComponents(root,file).join('/');
  const verify=()=>{if(closed)throw fail('PI_OWNER_HOME_CLOSED','Owner launch pins closed');for(const pin of [...directories,...files])pin.verify();return facts;};
  const metadataCustody=createOwnerMetadataCustody({home,openParent:()=>openExperimentalPersistenceParent(root,relative(path.join(home,'nozeli-session-tools.json')))});
  const initialize=()=>initializing??=(async()=>{
    try{
      for(const directory of [...new Set([home,agentDir,environmentRoot,temporary])]){
        await ensureExperimentalPrivateDirectory(root,directory);
        const pin=require('../../../native/windows/build/Release/nozeli_windows_read.node').openAnchoredDirectoryIdentity(root,relative(directory)+'/__owner_anchor__');
        directories.push(pin);directoryPins.set(directory,pin);
      }
      ownerHome=openExperimentalPersistenceParent(root,relative(path.join(home,'__owner_custody__')));directories.push(ownerHome);
      if(ownerHome.identity()!==directoryPins.get(home).identity())throw fail('PI_OWNER_HOME_CHANGED','Original owner home differs before helper custody');
      const pinned=[];nativeSha=digest(await (await import('node:fs/promises')).readFile(nativeFile));
      for(const [file,expected] of [[runtime.command,runtime.commandSha256],[runtime.entry,runtime.entrySha256],[nativeFile,nativeSha]]){
        const pin=openExperimentalAnchoredRead(path.dirname(file),path.basename(file));files.push(pin);
        const hash=createHash('sha256');for(;;){const bytes=pin.read(256*1024);if(!bytes.length)break;hash.update(bytes);await setImmediate();}
        if(hash.digest('hex')!==expected)throw fail('PI_RUNTIME_IDENTITY_CHANGED','Runtime executable or entry differs from its approved digest');
        pinned.push({path:file,identity:pin.identity(),sha256:expected});
      }
      metadata=metadataCustody.read();
      facts=Object.freeze({schema:1,scope:'local-registered-owner-launch-only',home,homeIdentity:directoryPins.get(home).identity(),agentDir,
        agentDirectoryIdentity:directoryPins.get(agentDir).identity(),runtime:pinned,productionSelected:false});
      verify();return facts;
    }catch(error){for(const pin of [...files,...directories].reverse())pin.close();closed=true;throw error;}
  })();
  return defineRegisteredOwnerLaunch({home,agentDir,target,registry,isCurrent,initialize,verify,
    async beginTool(session,frame){verify();return registry.beginTool(session.launchRegistration,frame,{sessionId:session.threadId,requestId:session.current?.requestId,jobId:session.current?.job.id});},
    async finishTool(session,receipt,reply){verify();return registry.finishTool(session.launchRegistration,receipt,reply);},
    environment(ownerId){
      verify();return {SystemRoot:process.env.SystemRoot,windir:process.env.SystemRoot,
        PATH:[path.dirname(runtime.command),path.join(process.env.SystemRoot,'System32'),runtime.toolPath].filter(Boolean).join(path.delimiter),
        HOME:environmentRoot,USERPROFILE:environmentRoot,APPDATA:environmentRoot,LOCALAPPDATA:environmentRoot,
        XDG_CONFIG_HOME:environmentRoot,XDG_DATA_HOME:environmentRoot,XDG_STATE_HOME:environmentRoot,XDG_CACHE_HOME:environmentRoot,
        TEMP:temporary,TMP:temporary,ELECTRON_RUN_AS_NODE:'1',PI_CODING_AGENT_DIR:agentDir,
        NOZELI_PI_OWNER_HOME:home,NOZELI_PI_OWNER_ID:ownerId,PI_SKIP_VERSION_CHECK:'1',
        NOZELI_PI_WINDOWS_NATIVE_BRIDGE:nativeFile,NOZELI_PI_WINDOWS_NATIVE_SHA256:nativeSha,NOZELI_PI_PRIVATE_ROOT:root,
        ...(runtime.shell?{NOZELI_PI_SHELL:runtime.shell}:{})};
    },
    prepare(spec){
      verify();if(spec.command!==runtime.command||spec.args?.length!==1||spec.args[0]!==runtime.entry)throw fail('PI_RUNTIME_IDENTITY_CHANGED','Launch differs from the pinned runtime');
      const binding=spec.ownerLaunch,uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
      if(!binding||binding.home!==home||binding.target!==target||binding.ownerId!==spec.env.NOZELI_PI_OWNER_ID||
         ![binding.ownerId,binding.generation,binding.launchId].every(uuid))throw fail('PI_LAUNCH_CONTRACT_INVALID','Exact shared launch token required before native preparation');
      const env=Object.entries({...spec.env,NOZELI_PI_OWNER_GENERATION:binding.generation,NOZELI_PI_LAUNCH_ID:binding.launchId}).map(([key,value])=>key+'='+value);
      const child=prepareExperimentalProcessTransport({...spec,env});transports.add(child);
      if(supervise){
        try{
          const supervisor=registry.startSupervisor(child.lease,binding.launchId,ownerHome);supervisors.add(supervisor);child.attachSupervisor(supervisor);
          const supervised=supervisor.snapshot();
          if(supervised.ownerHomeDirectoryCustodyVerified&&supervised.ownerHomeIdentity!==facts.homeIdentity)
            throw fail('PI_OWNER_HOME_CHANGED','Helper retained another owner home');
          const resume=child.resume;child.resume=()=>{verifyExperimentalPreparedSupervisor(supervisor,child.preparedIdentity());return resume();};
        }catch(error){
          // Return the actual retained child so the shared session installs its
          // handlers and owns cleanup/budget even when supervision failed.
          child.preparedIdentity=()=>{throw error;};
        }
      }
      return child;
    },
    assertSessionFile(file){
      verify();experimentalPrivateDirectoryComponents(agentDir,file);return true;
    },
    async readMetadata(){await initialize();verify();return structuredClone(metadata);},
    metadataEvidence(){verify();return metadataCustody.snapshot();},
    verifyMetadata(){verify();return metadataCustody.verify();},
    async writeMetadata(file,value){
      await initialize();verify();if(file!==path.join(home,'nozeli-session-tools.json'))throw fail('PI_METADATA_INVALID','Unexpected metadata destination');
      metadataCustody.write(value);metadata=structuredClone(value);verify();
    },
    async retireOwner(session,{timeoutMs=5000}={}){
      verify();const child=session.child,registration=session.launchRegistration;
      const stageFail=(stage,error)=>Object.assign(error,{stage});
      if(!child||!transports.has(child)||!registration||session.launchError||session.startError)throw stageFail('retire-owner-prerequisites',fail('PI_EXIT_UNCONFIRMED','Retained successful owner startup required'));
      // One total deadline from retireOwner ENTRY bounds process drain and the
      // incarnation reconciliation below alike. Job TotalProcesses accounting
      // is monotonic while member observation enumerates the live list, so a
      // churned Job (native tool children) can briefly report more incarnations
      // than the retained observed-member set even after Job-empty: reconcile
      // the exact lease facts within the SAME budget, then keep every refusal.
      const deadline=performance.now()+timeoutMs;
      let processFacts=await child.waitForExitAndDrain({timeoutMs:Math.trunc(Math.max(0,deadline-performance.now()))}),ack=session.ownerStopAck;
      if(!child||!registration||registration.record.phase!=='prepared'||session.launchError||session.startError||
         !ack?.confirmationComplete||ack.sessionId!==session.threadId||ack.finalJournal?.sessionFile!==session.sessionFile||
         ack.finalJournal?.persistence?.mechanism!=='windows-private-file-handle'||ack.finalJournal.persistence.file!=='flushed'||
         ack.finalJournal.persistence.directory!=='flushed')throw stageFail('retire-owner-ack-journal',fail('PI_EXIT_UNCONFIRMED','A final acknowledged native journal and exact prepared registration are required'));
      while(!processFacts.allProcessIncarnationsObserved||!processFacts.jobEmptyObserved){
        if(performance.now()>=deadline)throw stageFail('retire-owner-incarnations',fail('PI_EXIT_UNCONFIRMED','Job contains unobserved process incarnations; registration retained'));
        await delay(5);processFacts=child.lease.snapshot();
      }
      while(session.inFlightToolCalls.size||session.current||session.busy){if(performance.now()>=deadline)throw stageFail('retire-owner-settle',fail('PI_EXIT_UNCONFIRMED','Host tools or the admitted turn have not settled'));await delay(5);}
      let drainTimer;
      try{await Promise.race([session.nativeDrain,new Promise((_,reject)=>{drainTimer=setTimeout(()=>reject(stageFail('retire-owner-native-drain',fail('PI_EXIT_UNCONFIRMED','Native projection drain timed out'))),Math.max(1,deadline-performance.now()));})]);}finally{clearTimeout(drainTimer);}
      if(session.nativeError||session.protocolError||!session.protocolReader.completed||session.pending.size)
        throw stageFail('retire-owner-protocol-pending',fail('PI_EXIT_UNCONFIRMED','Protocol, pending requests or native projection remain unconfirmed'));
      const file=session.sessionFile,parent=openExperimentalPersistenceParent(root,relative(file));let journal;
      try{
        journal=parent.openPrivateTreeFile(path.basename(file));const stat=journal.stat();
        if(stat.identity!==ack.finalJournal.persistence.identity||stat.size>64n*1024n*1024n)throw stageFail('retire-owner-journal-proof',fail('PI_EXIT_UNCONFIRMED','Final journal identity or size changed'));
        const hash=createHash('sha256');for(let offset=0;offset<Number(stat.size);){const bytes=journal.readAt(offset,Math.min(256*1024,Number(stat.size)-offset));if(!bytes.length)throw stageFail('retire-owner-journal-proof',fail('PI_EXIT_UNCONFIRMED','Final journal truncated'));hash.update(bytes);offset+=bytes.length;await setImmediate();}
        if(hash.digest('hex')!==ack.finalJournal.sha256File)throw stageFail('retire-owner-journal-proof',fail('PI_EXIT_UNCONFIRMED','Final journal differs from the acknowledged digest'));
        journal.sync();parent.syncDirectory();
        const proof=Object.freeze({schema:1,scope:'same-host-exact-job-and-journal',identity:registration.record.identity,homeIdentity:facts.homeIdentity,
          allProcessIncarnationsObserved:true,stdoutEOF:true,stderrEOF:true,protocolComplete:true,journalIdentity:stat.identity,
          journalSha256:ack.finalJournal.sha256File,journalRelative:path.relative(home,file).split(path.sep).join('/'),namespace:'not-qualified',coldRecoveryQualified:false});
        const verifyExit=()=>{
          verify();journal.verify();parent.verify();const facts=child.lease.snapshot();
          if(!facts.jobEmptyObserved||!facts.allProcessIncarnationsObserved||facts.stamp!==proof.identity.stamp||
             child.errors.length||!child.stdout.readableEnded||!child.stderr.readableEnded||!session.protocolReader.completed||
             session.nativeError||session.protocolError||session.pending.size||session.inFlightToolCalls.size||session.current||session.busy)
            throw stageFail('retire-owner-proof-recheck',fail('PI_EXIT_UNCONFIRMED','Retained local exit proof changed'));return proof;
        };
        const retired=await registry.retire(registration,retainExperimentalOwnerExitProof(child,verifyExit));verifyExit();child.close();
        if(child.supervisor){child.supervisor.shutdown();child.supervisor.close();supervisors.delete(child.supervisor);}
        return {confirmationComplete:true,scope:proof.scope,exit:session.exit,registration:retired,proof};
      }finally{journal?.close();parent.close();}
    },
    close(){
      for(const supervisor of supervisors){supervisor.shutdown();supervisor.close();supervisors.delete(supervisor);}
      if(closed)return;for(const pin of [...files,...directories].reverse())pin.close();closed=true;
    },
  });
}
