// Shared process-ownership contract (OMP/Codex providers, workspace locks and
// cold recovery). Business modules keep calling these functions; the real
// /proc identity, env-tag verified reaping and kill(-pgid) group termination
// live in the Linux platform adapter selected through platform-capabilities.
// Platforms without a verified implementation keep honest semantics: no stamp,
// no recovery, no verified reaping, no liveness verdict — an unknown identity
// never releases a budget slot or a writer. Windows/macOS adapters must be
// implemented and verified on real hosts (phase2) before those platforms
// report available.
import path from 'node:path';
import {selectCapability} from '../../platform/platform-capabilities.mjs';
import * as linux from '../../platform/linux/process-ownership.mjs';

const select=()=>selectCapability({capability:'verified-process-ownership',implementations:{linux}});

// OMP/Codex ownership proof: descendants carry the private CODEX_HOME env tag;
// the leader must also look like the codex CLI this host launched (native
// terminals resume a --remote session, rpc providers run app-server).
const codexOwnership={
  member:(env,record)=>env.includes(`CODEX_HOME=${record.home}`),
  leader:(env,command,record)=>env.includes(`CODEX_HOME=${record.home}`)&&command.some(value=>value.includes('codex'))&&(record.kind==='native-terminal'?(command.includes('resume')&&command.includes('--remote')):command.includes('app-server')),
  messages:{
    groupReused:'provider group identity reused',
    leaderReused:'provider PID identity reused',
    memberUnverified:'provider descendant identity cannot be verified',
    leaderUnverified:'provider identity cannot be verified',
    leaderDidNotExit:'owned provider did not exit',
    descendantsDidNotExit:'owned provider descendants did not exit'
  }
};

const unavailable=(selection,code)=>Object.assign(new Error(`verified process ownership is not available on ${selection.platform}`),{code,capability:selection.capability,platform:selection.platform,...(selection.status?{status:selection.status}:{})});

export function processIdentityCapability(deps={}){
  const selection=deps.selection??select();
  return selection.state==='available'
    ?{capability:selection.capability,platform:selection.platform,state:'available',mechanisms:selection.implementation.mechanisms}
    :{capability:selection.capability,platform:selection.platform,state:'unavailable',status:selection.status,reason:selection.reason,failureSemantics:'no identity stamps, no orphan recovery, no verified reaping; owners and budget slots are retained'};
}

export async function processStamp(pid,deps={}){
  const selection=deps.selection??select();
  return selection.state==='available'?selection.implementation.processStamp(pid):null;
}

export async function ownerAlive(owner,deps={}){
  if(!Number.isInteger(owner?.pid)||owner.pid<=0)throw new Error('invalid owner PID');
  const selection=deps.selection??select();
  if(selection.state==='available')return selection.implementation.ownerAlive(owner);
  // No verified identity exists on this platform, and a kill(pid,0) liveness
  // answer is not proof: an absent PID does not show the recorded owner's
  // descendants exited, and a free PID says nothing about the incarnation that
  // wrote the record. Releasing a lock, budget slot or writer on such an
  // answer is forbidden, so the boolean API refuses instead of guessing —
  // callers keep the resource and surface this structured error. Phase2
  // adapters must provide a conservative identity distinction before any
  // boolean answer from this contract is trustable.
  throw unavailable(selection,'PROCESS_OWNERSHIP_UNSUPPORTED');
}

export async function recoverProvider(record,root,deps={}){
  const selection=deps.selection??select();
  if(selection.state!=='available')throw Object.assign(new Error('orphan identity recovery is verified on Linux only'),{code:'PROCESS_OWNERSHIP_UNSUPPORTED',capability:selection.capability,platform:selection.platform,...(selection.status?{status:selection.status}:{})});
  const rel=path.relative(path.join(root,'agents'),record.home);
  if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw new Error('provider home outside owned agents root');
  if(!record.stamp)throw new Error('provider process identity missing');
  if(typeof record.stamp!=='string'||!/^[a-f0-9-]{36}:\d+$/.test(record.stamp))throw new Error('provider process identity invalid');
  return selection.implementation.recoverOwnedProcessGroupLeader(record,root,codexOwnership);
}

export async function reapOwnedGroup(record,deps={}){
  const selection=deps.selection??select();
  if(selection.state!=='available'||typeof record?.stamp!=='string'||!/^[a-f0-9-]{36}:\d+$/.test(record.stamp))
    return {descendantsReaped:0,verified:false,platform:selection.platform,reason:selection.state==='available'?'provider process identity invalid':(selection.reason??`verified process ownership unavailable on ${selection.platform}`)};
  return selection.implementation.reapOwnedProcessGroup(record,codexOwnership);
}

// Platform process service consumed by PiSession (spec.processTree) and by
// future runtime owners. Phase2 Windows/macOS adapters implement the same
// shape with their own verified group mechanism (e.g. Job Objects); until a
// platform's capability status is 'implemented' the service reports
// verified:false and every mutating operation refuses explicitly — nothing
// silently succeeds or signals (stamp honestly reports null: no verified
// identity exists to report).
export function hostProcessTree(deps={}){
  const selection=deps.selection??select();
  if(selection.state!=='available')
    return {capability:selection.capability,platform:selection.platform,verified:false,status:selection.status,reason:selection.reason??`verified process ownership unavailable on ${selection.platform}`,
      spawn(){throw unavailable(selection,'PROCESS_OWNERSHIP_UNSUPPORTED');},
      async stamp(){return null;},
      terminateGroup(){throw unavailable(selection,'PROCESS_OWNERSHIP_UNSUPPORTED');}};
  return {capability:selection.capability,platform:selection.platform,verified:true,mechanisms:selection.implementation.mechanisms,
    spawn:spec=>selection.implementation.spawnGroupLeader(spec),
    stamp:pid=>selection.implementation.processStamp(pid),
    terminateGroup:(pid,signal)=>selection.implementation.signalProcessGroup(pid,signal)};
}
