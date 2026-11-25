// Shared sequencing for a prepared transport and durable local registration.
// PiSession remains the session/epoch/request owner. This does not qualify a
// processTree implementation or create a second admission/recovery machine.
import {randomUUID} from 'node:crypto';

const fail=(code,message)=>Object.assign(Error(message),{code});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const services=new WeakSet();
export function defineRegisteredOwnerLaunch(service){
  for(const key of ['initialize','environment','prepare','writeMetadata','readMetadata','verify'])
    if(typeof service?.[key]!=='function')throw fail('PI_LAUNCH_CONTRACT_INVALID','Registered launch service lacks '+key);
  const value=Object.freeze(service);services.add(value);return value;
}
export const isRegisteredOwnerLaunch=service=>services.has(service);

export async function prepareRegisteredOwner(session,{launch,prepare,registry,target,isCurrent,onPrepared,onRegistered}={}){
  if(session.child||session.launchAttempt)throw fail('PI_OWNER_EXISTS','Pi session already has a launch attempt; no automatic retry');
  if(typeof prepare!=='function'||typeof registry?.begin!=='function'||typeof registry?.register!=='function'||typeof isCurrent!=='function')
    throw fail('PI_LAUNCH_CONTRACT_INVALID','Prepared launch requires a registry and a synchronous current-owner guard');
  const token=Object.freeze({launchId:randomUUID(),ownerId:session.viewOwnerId,generation:session.epoch,target,home:session.home});
  session.launchAttempt=token;session.phase='launch-intent';
  const current=()=>{
    if(typeof registry.assertAdmission==='function'&&registry.assertAdmission(token)!==true)
      throw fail('PI_LAUNCH_SUPERSEDED','Host admission no longer belongs to this launch');
    if(session.stopping||session.closed||session.launchAttempt!==token||session.epoch!==token.generation||
       session.viewOwnerId!==token.ownerId||isCurrent(token)!==true)
      throw fail('PI_LAUNCH_SUPERSEDED','Prepared owner is no longer current; execution refused');
  };
  try{
    current();session.launchRegistration=await registry.begin(token);current();
    // prepare must acquire and return the kernel object synchronously, so no
    // rejection gap can hide a live child from session/budget error handling.
    const child=prepare({...launch,ownerLaunch:token});
    if(!child||typeof child.then==='function')throw fail('PI_LAUNCH_CONTRACT_INVALID','prepare must synchronously return a retained transport');
    session.child=child;session.pid=child.pid;session.phase='prepared';
    session.observeOwnerChild(child);
    session.emit('prepared',{pid:child.pid,launchId:token.launchId});
    const identity=child.preparedIdentity();
    session.groupRecord={pid:child.pid,home:session.home,ownerId:token.ownerId,stamp:identity.stamp,
      identity,generation:token.generation,launchId:token.launchId,kind:'pi-node'};
    current();await onPrepared?.(child,token);current();
    session.launchRegistration=await registry.register(session.launchRegistration,identity,child.supervisor);current();
    await onRegistered?.(session.launchRegistration);current();
    if(typeof registry.confirmAdmission==='function'){await registry.confirmAdmission(session.launchRegistration);current();}
    if(!equal(child.preparedIdentity(),identity))throw fail('PI_LAUNCH_IDENTITY_CHANGED','Prepared process identity changed; execution refused');
    // Set before calling: a failure/unknown return cannot authorize retry.
    session.launchResumeAttempted=true;session.phase='starting';child.resume();
    return session.launchRegistration;
  }catch(error){
    session.launchError=error;session.phase='launch-unconfirmed';
    if(session.child){
      try{session.child.terminate();session.launchCleanup={localProcessFacts:await session.child.waitForJobEmpty(),confirmationComplete:false};}
      catch(cleanupError){error.cleanupError=cleanupError;}
    }
    error.launchId=token.launchId;throw error;
  }
}
