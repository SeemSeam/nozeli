// Local durable launch registrations. Reuse the shared storage worker's CAS,
// receipts, native database leases and UNKNOWN fence; never export kernel
// ownership into portable project collections or infer cold stop from a PID.
import path from 'node:path';
import {createOwnerToolCustody} from './owner-tool-custody.mjs';
import {verifyExperimentalOwnerExitProof} from '../platform/windows/experimental-owner-exit-proof.mjs';
import {verifyExperimentalHostLease,verifyExperimentalHostRegistration,retainExperimentalHostLaunch,completeExperimentalHostLaunch,startExperimentalHostSupervisor,verifyExperimentalHostSupervisor,readExperimentalHostRetiredOwner} from '../platform/windows/experimental-host-lease.mjs';
import {verifyExperimentalPreparedSupervisor,startExperimentalProcessSupervisor} from '../platform/windows/experimental-process-supervisor.mjs';

const fail=(code,message)=>Object.assign(Error(message),{code});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function freeze(value){for(const item of Object.values(value))if(item&&typeof item==='object')freeze(item);return Object.freeze(value);}
const targetValid=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);

export function createOwnerLaunchRegistry(storage,projectId,{hostLease}={}){
  const issued=new WeakMap(),retired=new Map(),hostClaims=new WeakMap();let fence=null;
  const check=()=>{if(fence)throw fence;storage.assertLocalOpen(projectId);if(hostLease)verifyExperimentalHostLease(hostLease,{storage,projectId});};
  const request=async(op,args,expectedInstanceId)=>{
    check();if(hostLease)await verifyExperimentalHostRegistration(hostLease,{storage,projectId});
    const binding=await storage.requireRegistered(projectId);
    const directory=await storage.localDirectory(projectId);check();
    const current=await storage.requireRegistered(projectId);
    if(binding.instanceId!==current.instanceId||expectedInstanceId!==undefined&&binding.instanceId!==expectedInstanceId)
      throw fail('PROJECT_IDENTITY_CONFLICT','Local owner registration binding changed before request');
    const file=path.join(directory,'ui.sqlite');
    let result,completed=false;
    try{
      result=await storage.db.request(file,op,{collection:'managed_owner_launches',...args});completed=true;
      if(hostLease)await verifyExperimentalHostRegistration(hostLease,{storage,projectId});
      check();const after=await storage.requireRegistered(projectId);
      if(binding.instanceId!==after.instanceId||binding.id!==after.id)
        throw fail('PROJECT_IDENTITY_CONFLICT','Local owner registration instance changed');
      return {result,binding};
    }catch(cause){
      if(cause.code==='STORAGE_RESULT_UNKNOWN'||cause.commitUnknown||completed&&op==='put'){
        fence=Object.assign(fail('STORAGE_RESULT_UNKNOWN','Owner launch registration requires explicit reconciliation; no replay'),
          {cause,commitUnknown:{projectId,file,operationId:args.operationId},automaticReplay:false});
        throw fence;
      }
      throw cause;
    }
  };
  const toolCustody=createOwnerToolCustody({request,assertPrepared:prepared=>{
    check();if(!issued.has(prepared)||prepared.record.phase!=='prepared')throw fail('PI_TOOL_RECEIPT_INVALID','Exact live prepared owner receipt required');
  },fenceUnknown:(cause,id)=>fence??=Object.assign(fail('STORAGE_RESULT_UNKNOWN','Host tool handler custody requires explicit reconciliation; no replay'),
    {cause,commitUnknown:{projectId,toolId:id},automaticReplay:false})});
  return Object.freeze({
    beginTool:toolCustody.begin,finishTool:toolCustody.finish,
    startSupervisor(job,launchId,ownerHome){check();if(hostLease&&!uuid(launchId))throw fail('HOST_LAUNCH_SET_INVALID','Registered launch UUID required before native supervision');return hostLease?startExperimentalHostSupervisor(hostLease,{storage,projectId,launchId,ownerHome},job):startExperimentalProcessSupervisor(job);},
    assertAdmission(){check();if(hostLease)verifyExperimentalHostLease(hostLease,{storage,projectId,admission:true});return true;},
    async confirmAdmission(prepared){
      if(!issued.has(prepared)||prepared.record.phase!=='prepared')throw fail('OWNER_LAUNCH_INVALID','Expected this registry\'s exact prepared receipt');
      check();if(hostLease)verifyExperimentalHostLease(hostLease,{storage,projectId,admission:true});
      const current=await request('record',{id:prepared.record.target},prepared.record.instanceId);
      if(current.result?.revision!==prepared.revision||!equal(current.result.value,prepared.record))
        throw fail('STORAGE_CONFLICT','Prepared owner registration changed before resume');
      check();if(hostLease)verifyExperimentalHostLease(hostLease,{storage,projectId,admission:true});return true;
    },
    async read(target){
      if(!targetValid(target))throw fail('OWNER_LAUNCH_INVALID','Invalid owner target');
      return structuredClone((await request('record',{id:target})).result);
    },
    async begin(binding){
      if(!targetValid(binding?.target)||!uuid(binding.ownerId)||!uuid(binding.generation)||!uuid(binding.launchId)||
         typeof binding.home!=='string'||!path.isAbsolute(binding.home))
        throw fail('OWNER_LAUNCH_INVALID','Expected exact target, owner, generation, launch and absolute home');
      check();
      const hostClaim=hostLease&&retainExperimentalHostLaunch(hostLease,{storage,projectId,launchId:binding.launchId});
      const local=await storage.requireRegistered(projectId);
      const record=freeze({schema:1,scope:'local-prepared-launch-only',toolCustodySchema:1,projectId,instanceId:local.instanceId,
        ...(hostLease?{hostLeaseId:verifyExperimentalHostLease(hostLease,{storage,projectId}).leaseId}:{}),
        target:binding.target,ownerId:binding.ownerId,generation:binding.generation,launchId:binding.launchId,
        home:binding.home,phase:'intent',automaticReplay:false,createdAt:new Date().toISOString()});
      const previous=retired.get(record.target)??(hostLease&&await readExperimentalHostRetiredOwner(hostLease,{storage,projectId,target:record.target}));
      const {result}=await request('put',{id:record.target,value:record,expectedRevision:previous?.revision??0,operationId:record.launchId+':intent'},record.instanceId);
      retired.delete(record.target);
      const receipt=freeze({record,revision:result.revision});issued.set(receipt,receipt);if(hostClaim)hostClaims.set(receipt,hostClaim);return receipt;
    },
    async register(intent,identity,supervisor){
      if(!issued.has(intent)||intent.record.phase!=='intent')throw fail('OWNER_LAUNCH_INVALID','Expected this registry\'s exact launch intent receipt');
      // Only the current explicit Windows transport contract is qualified.
      // A string stamp or caller-supplied PID cannot serve as cold ownership.
      if(!identity||!equal(Object.keys(identity).sort(),['schema','platform','pid','creationTime100ns','stamp'].sort())||
         identity.schema!==1||identity.platform!=='win32'||!Number.isSafeInteger(identity.pid)||identity.pid<1||identity.pid>0xffffffff||
         typeof identity.creationTime100ns!=='string'||!/^[1-9][0-9]{0,19}$/.test(identity.creationTime100ns)||BigInt(identity.creationTime100ns)>0xffffffffffffffffn||
         identity.stamp!==`win32:${identity.pid}:${identity.creationTime100ns}`)
        throw fail('OWNER_LAUNCH_IDENTITY_INVALID','Expected versioned Windows process incarnation');
      const supervision=supervisor&&verifyExperimentalPreparedSupervisor(supervisor,identity);
      if(hostLease&&supervisor)verifyExperimentalHostSupervisor(hostLease,supervisor,intent.record.launchId);
      const record=freeze({...intent.record,phase:'prepared',identity:structuredClone(identity),...(supervision?{supervision}: {})});
      const {result}=await request('put',{id:record.target,value:record,expectedRevision:intent.revision,operationId:record.launchId+':prepared'},record.instanceId);
      if(supervisor)try{verifyExperimentalPreparedSupervisor(supervisor,identity);}catch(cause){fence=Object.assign(fail('STORAGE_RESULT_UNKNOWN','Supervisor postcheck failed after prepared registration'),{cause,commitUnknown:{projectId,launchId:record.launchId},automaticReplay:false});throw fence;}
      issued.delete(intent);
      const receipt=freeze({record,revision:result.revision});issued.set(receipt,receipt);if(hostLease)hostClaims.set(receipt,hostClaims.get(intent));return receipt;
    },
    async retire(prepared,exitProof){
      if(!issued.has(prepared)||prepared.record.phase!=='prepared')
        throw fail('OWNER_EXIT_INVALID','Expected this registry\'s exact prepared receipt and retained exit verifier');
      const verify=()=>verifyExperimentalOwnerExitProof(exitProof);
      const proof=verify();
      if(!proof||proof.scope!=='same-host-exact-job-and-journal'||proof.identity?.stamp!==prepared.record.identity.stamp||
         proof.allProcessIncarnationsObserved!==true||proof.stdoutEOF!==true||proof.stderrEOF!==true||proof.protocolComplete!==true||
         typeof proof.journalSha256!=='string'||!/^[a-f0-9]{64}$/.test(proof.journalSha256))
        throw fail('OWNER_EXIT_UNVERIFIED','Complete retained local exit and journal proof required');
      const current=await request('record',{id:prepared.record.target},prepared.record.instanceId);
      if(current.result?.revision!==prepared.revision||!equal(current.result.value,prepared.record))
        throw fail('STORAGE_CONFLICT','Owner exit registration has another winner');
      if(!equal(verify(),proof))throw fail('OWNER_EXIT_UNVERIFIED','Exit proof changed before retirement');
      const record=freeze({...prepared.record,phase:'retired',exit:structuredClone(proof),retiredAt:new Date().toISOString()});
      const {result}=await request('put',{id:record.target,value:record,expectedRevision:prepared.revision,operationId:record.launchId+':retired'},record.instanceId);
      try{if(!equal(verify(),proof))throw fail('OWNER_EXIT_UNVERIFIED','Exit proof changed after retirement');}
      catch(cause){fence=Object.assign(fail('STORAGE_RESULT_UNKNOWN','Owner retirement postcheck failed; no new launch'),{cause,commitUnknown:{projectId,launchId:record.launchId},automaticReplay:false});throw fence;}
      const receipt=freeze({record,revision:result.revision});
      if(hostLease)try{completeExperimentalHostLaunch(hostLease,hostClaims.get(prepared),receipt,exitProof);}
      catch(cause){fence=Object.assign(fail('STORAGE_RESULT_UNKNOWN','Host custody postcheck failed; no new launch'),{cause,commitUnknown:{projectId,launchId:record.launchId},automaticReplay:false});throw fence;}
      issued.delete(prepared);retired.set(record.target,receipt);return receipt;
    },
    // No delete/adopt/replay API. Only this live registry's verified retired
    // receipt permits a later CAS launch. Cold records remain fenced.
  });
}
