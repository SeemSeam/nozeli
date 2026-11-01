// Shared execution-isolation contract. Managed workers ask for an isolated
// launch through this module; the real read/write domain implementation is the
// Linux bubblewrap adapter selected via platform-capabilities. On platforms
// without a verified implementation, isolatedLaunch fails explicitly with a
// structured capability error — a managed process is never silently spawned
// unsandboxed. optionalIsolatedLaunch keeps its explicit opt-in probe: the
// caller decides up front that ordinary current-user execution is acceptable,
// and a failed probe never degrades an isolation request into a normal spawn.
import {selectCapability} from '../../platform/platform-capabilities.mjs';
import * as linuxBwrap from '../../platform/linux/bwrap-isolation.mjs';

const select=()=>selectCapability({capability:'execution-isolation',implementations:{linux:linuxBwrap}});

export function isolationCapability(deps={}){
  const selection=deps.selection??select();
  return selection.state==='available'
    ?{capability:selection.capability,platform:selection.platform,state:'available',mechanism:selection.implementation.mechanism,failureSemantics:'isolation requests that cannot be established throw; no unsandboxed fallback'}
    :{capability:selection.capability,platform:selection.platform,state:'unavailable',status:selection.status,reason:selection.reason,failureSemantics:'managed execution that requires isolation is refused with ISOLATION_UNSUPPORTED, never spawned unsandboxed'};
}

export async function isolatedLaunch(spec,deps={}){
  const selection=deps.selection??select();
  if(selection.state!=='available')throw Object.assign(Error('受管Agent进程读/写隔离尚未在此平台实现；基础阅读仍可使用。'),{code:'ISOLATION_UNSUPPORTED',capability:isolationCapability({selection})});
  return selection.implementation.launch(spec);
}

// bwrap 可用性探测：仅回答“能否建立隔离”，不抛错；无已验证实现的平台恒为 false。
export async function isolationAvailable(deps={}){
  const selection=deps.selection??select();
  return selection.state==='available'&&selection.implementation.available();
}

// Ordinary execution trusts the current user; sandboxing requires an explicit opt-in probe.
export async function optionalIsolatedLaunch(spec,{probe=async()=>false,selection}={}){
  if(await probe())return {launch:await isolatedLaunch(spec,{selection}),isolated:true};
  return {launch:{command:spec.command,args:spec.args,env:{}},isolated:false};
}
