// Kernel custody prerequisite, never a production owner recovery selector.
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openExperimentalAnchoredRead} from './experimental-read.mjs';
const require=createRequire(import.meta.url);
const held=new WeakMap();
const helper=fileURLToPath(new URL('../../../native/windows-process/build/Release/nozeli_windows_supervisor.exe',import.meta.url));
const binding=()=>{
  if(process.platform!=='win32'||process.arch!=='x64')throw Object.assign(Error('Native Windows x64 required'),{code:'PROCESS_PLATFORM_UNSUPPORTED'});
  return require('../../../native/windows-process/build/Release/nozeli_windows_process.node');
};
function image(){
  const pin=openExperimentalAnchoredRead(path.dirname(helper),path.basename(helper));
  try{const hash=createHash('sha256');for(;;){const bytes=pin.read(256*1024);if(!bytes.length)break;hash.update(bytes);}pin.verify();return {pin,sha256:hash.digest('hex')};}
  catch(error){pin.close();throw error;}
}
function wrap(native,image,job){
  const record=Object.freeze({schema:1,scope:'supervisor-endpoint-observation-only',pipe:native.pipe,
    custodyEntityCount:native.custodyEntityCount,custodySha256:native.custodySha256,
    custodyRoles:native.custodyRoles,sourceSha256:native.sourceSha256,ownerHomeIdentity:native.ownerHomeIdentity,outputCustodyVerified:native.outputCustodyVerified,inputCustodyVerified:native.inputCustodyVerified,
    supervisorPid:native.supervisorPid,supervisorCreationTime100ns:native.supervisorCreationTime100ns,
    hostPid:native.hostPid,hostCreationTime100ns:native.hostCreationTime100ns,
    leaderPid:native.leaderPid,leaderCreationTime100ns:native.leaderCreationTime100ns,helperFileIdentity:native.helperFileIdentity,helperSha256:image.sha256});
  const check=receiver=>{if(receiver!==pin)throw Object.assign(Error('Original supervisor wrapper required'),{code:'SUPERVISOR_RECEIVER'});};
  const value={record,job,shutdownObserved:false};
  const pin=Object.freeze({snapshot(){check(this);image.pin.verify();return native.snapshot();},
    readOutput(channel,offset){check(this);image.pin.verify();return native.readOutput(channel,offset);},
    readInput(offset){check(this);image.pin.verify();return native.readInput(offset);},
    writeInput(bytes){check(this);image.pin.verify();return native.writeInput(bytes);},
    pollInput(){check(this);image.pin.verify();return native.pollInput();},
    closeInput(){check(this);image.pin.verify();return native.closeInput();},
    abortInput(){check(this);image.pin.verify();return native.abortInput();},
    claimColdAnchor(){check(this);image.pin.verify();return native.claimColdAnchor();},
    // Exit observation neither repeats shutdown nor creates release authority.
    observeExit(){check(this);return native.observeExit();},
    shutdown(){check(this);image.pin.verify();const result=native.shutdown();value.shutdownObserved=result.supervisorExited===true;return result;},close(){check(this);native.close();image.pin.close();}});
  held.set(pin,value);return pin;
}
export function experimentalSupervisorShutdownObserved(pin){return held.get(pin)?.shutdownObserved===true;}
export function createExperimentalHostLaunchSet(leaseId,source){
  return binding().createHostLaunchSet(leaseId,createHash('sha256').update(JSON.stringify(source)).digest('hex'));
}
export function startExperimentalProcessSupervisor(lease,custody,claim){
  const native=binding(),runtime=image();
  try{return wrap(claim?native.startProcessSupervisor(lease,custody,claim):custody===undefined?native.startProcessSupervisor(lease):native.startProcessSupervisor(lease,custody),runtime,lease);}catch(error){runtime.pin.close();throw error;}
}
export function connectExperimentalProcessSupervisor(record){
  if(!record||record.schema!==1||record.scope!=='supervisor-endpoint-observation-only')throw Object.assign(Error('Versioned supervisor endpoint required'),{code:'SUPERVISOR_SPEC_INVALID'});
  const native=binding(),runtime=image();
  try{
    if(runtime.sha256!==record.helperSha256)throw Object.assign(Error('Supervisor helper bytes differ from the endpoint'),{code:'SUPERVISOR_IMAGE_UNVERIFIED'});
    return wrap(native.connectProcessSupervisor(record.pipe,record.supervisorPid,record.supervisorCreationTime100ns,
      record.hostPid,record.hostCreationTime100ns,record.leaderPid,record.leaderCreationTime100ns,record.helperFileIdentity,record.custodyEntityCount,record.custodySha256,record.custodyRoles,record.sourceSha256,record.outputCustodyVerified,record.inputCustodyVerified,record.ownerHomeIdentity??''),runtime,null);
  }catch(error){runtime.pin.close();throw error;}
}
export function experimentalSupervisorEndpoint(pin){
  if(!held.has(pin))throw Object.assign(Error('Original supervisor wrapper required'),{code:'SUPERVISOR_RECEIVER'});
  pin.snapshot();return held.get(pin).record;
}
export function verifyExperimentalPreparedSupervisor(pin,identity){
  const value=held.get(pin);
  if(!value?.job)throw Object.assign(Error('Original prepared Job supervisor required'),{code:'SUPERVISOR_IDENTITY_UNVERIFIED'});
  const original=value.job.snapshot(),facts=pin.snapshot();
  if(original.resumed||original.terminationRequested||facts.hostExited||facts.stamp!==identity?.stamp||original.stamp!==facts.stamp)
    throw Object.assign(Error('Supervisor no longer belongs to the unresumed owner'),{code:'SUPERVISOR_IDENTITY_UNVERIFIED'});
  return value.record;
}
