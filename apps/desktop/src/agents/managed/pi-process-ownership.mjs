// Shared Pi process-ownership contract. The Pi business identity (owner id,
// private owner home under <root>/agents, bundled integrations/pi executable)
// is validated here; the Linux /proc mechanics — incarnation stamps, owner-tag
// verified descendant reaping and kill(-pgid) group termination — live in the
// Linux platform adapter selected through platform-capabilities. Platforms
// without a verified adapter never reap and never recover: the persisted owner
// registration and its process-budget slot are retained.
import path from 'node:path';
import {selectCapability} from '../../platform/platform-capabilities.mjs';
import * as linux from '../../platform/linux/process-ownership.mjs';
import * as macos from '../../platform/darwin/process-ownership.mjs';

const validStamp=value=>typeof value==='string'&&/^[a-f0-9-]{36}:\d+$/.test(value);
const validOwner=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);

const select=()=>selectCapability({capability:'verified-process-ownership',implementations:{linux,macos}});

// Pi ownership proof: the host stamps every owned process with the owner home
// and owner id env tags; the leader must also be running the bundled
// integrations/pi owner executable.
const piOwnership={
  member:(env,record)=>env.includes(`NOZELI_PI_OWNER_HOME=${record.home}`)&&env.includes(`NOZELI_PI_OWNER_ID=${record.ownerId}`),
  leader:(env,command,record)=>piOwnership.member(env,record)&&command.some(part=>/[\\/]integrations[\\/]pi[\\/]/.test(part)),
  messages:{
    groupReused:'Pi owner PID was reused; process group retained',
    leaderReused:'Pi owner PID reused; refusing to signal unrelated process',
    memberUnverified:'Pi group contains an unverified member; refusing to release ownership',
    leaderUnverified:'Pi owner executable identity cannot be verified',
    leaderChanged:'Pi owner changed during recovery',
    leaderDidNotExit:'Pi owner exit unconfirmed; original registration retained',
    descendantsDidNotExit:'Pi owner descendants did not exit; process budget retained'
  }
};

// Node owners run in separate process groups. A leader exit alone cannot
// release the host's process-budget slot: native bash grandchildren must be
// gone too, and each one must be individually verified before it is signalled.
export async function reapOwnedPiGroup(record,deps={}){
  const selection=deps.selection??select();
  if(selection.state!=='available'||!validStamp(record?.stamp)||!validOwner(record?.ownerId))
    return {verified:false,platform:selection.platform,descendantsReaped:0,reason:selection.state==='available'?'invalid Pi owner identity record':(selection.reason??`verified process ownership unavailable on ${selection.platform}`)};
  return selection.implementation.reapOwnerTaggedTree(record,piOwnership);
}

export async function recoverPiProvider(record,root,deps={}){
  const selection=deps.selection??select();
  if(selection.state!=='available')throw Object.assign(Error('Pi orphan recovery has not been verified on '+selection.platform),{code:'PI_PROCESS_OWNERSHIP_UNSUPPORTED',capability:selection.capability,platform:selection.platform,...(selection.status?{status:selection.status}:{})});
  if(!Number.isInteger(record?.pid)||record.pid<=0||record.kind!=='pi-node'||!validStamp(record.stamp)||!validOwner(record.ownerId))throw Error('Invalid Pi owner identity; original registration retained');
  const relative=path.relative(path.join(root,'agents'),record.home);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Pi owner home outside private project agents');
  return selection.implementation.recoverOwnerTaggedLeader(record,piOwnership);
}
