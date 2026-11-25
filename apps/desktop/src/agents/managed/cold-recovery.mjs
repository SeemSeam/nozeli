// Manager-owned explicit cold recovery: pure validation/DTO helpers only.
// The main process retains the original inspection handles; public DTOs carry
// only the manager-issued random challenge token and the original host lease
// identity — never paths, native identities, private source bytes or retained
// stdout/stderr. Mutating recovery lives in managed-projects.mjs.
import {HostError} from '../../main/host.mjs';

export const COLD_RECOVERY_PREPARED='prepared',COLD_RECOVERY_CONFIRMING='confirming',COLD_RECOVERY_UNKNOWN='outcome-unknown';

export function validateColdRecoveryConfirm(payload){
  const {token,hostLeaseId,hostRevision}=payload??{};
  if(typeof token!=='string'||!token.trim()||token.trim()!==token||token.length>200||
     typeof hostLeaseId!=='string'||!hostLeaseId.trim()||hostLeaseId.trim()!==hostLeaseId||hostLeaseId.length>200||
     !Number.isSafeInteger(hostRevision)||hostRevision<1)
    throw new HostError('INVALID_PAYLOAD','异常退出恢复核对参数无效。');
  return {token,hostLeaseId,hostRevision};
}

// Serializable status/prepare DTO. A preparation is confirmable only while
// untouched (or mid-confirm, for the frame that already holds it); a mutated
// preparation with an unresolved outcome never re-offers its challenge, and a
// preparation bound to another registered instance never speaks for the
// current project.
export function coldRecoveryDTO(record,{instanceId}={}){
  if(!record)return null;
  if(instanceId!==undefined&&record.instanceId!==instanceId)return null;
  if(record.phase===COLD_RECOVERY_UNKNOWN)
    return {available:false,reason:'outcome-unknown',automaticReplay:false,code:record.error?.code??null};
  if(record.phase!==COLD_RECOVERY_PREPARED&&record.phase!==COLD_RECOVERY_CONFIRMING)return null;
  return {available:true,token:record.token,hostLeaseId:record.hostLeaseId,hostRevision:record.hostRevision,automaticReplay:false};
}

// Bounded serializable connect failure for status surfaces: no stack, no
// native stdout, bounded message text. The original error object is always
// rethrown by callers; this shape is for persistence/display only.
export function boundedConnectionError(error){
  if(!error)return {code:'MANAGED_CONNECT_FAILED',message:'连接失败；原会话与执行现场保留。',role:null};
  const bounded={code:typeof error.code==='string'&&error.code?error.code:'MANAGED_CONNECT_FAILED',
    message:String(error.message??error).slice(0,300),role:typeof error.target==='string'?error.target:null};
  // The native lease authority marks an exact anchor-open sharing denial
  // (original helpers still retain the original anchor) as recovery-required
  // while keeping its low-level WIN32 identity for native callers and tests.
  // Status surfaces consume only this bounded structured recovery refusal,
  // with the native cause code retained; the original error itself is always
  // rethrown unchanged by callers.
  if(error.recoveryRequired===true){
    bounded.code='HOST_LEASE_RECOVERY_REQUIRED';
    bounded.recoveryRequired=true;
    if(typeof error.code==='string'&&error.code)
      bounded.cause={code:error.code,...(Number.isSafeInteger(error.win32Code)?{win32Code:error.win32Code}:{})};
  }
  return bounded;
}
