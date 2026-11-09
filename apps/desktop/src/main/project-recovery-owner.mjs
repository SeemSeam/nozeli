// Shared recovery-source-ownership contract. The real proof algorithm lives
// in the platform adapters (Linux platform/linux/recovery-owner.mjs, macOS
// platform/darwin/recovery-owner.mjs); this wrapper selects it through the
// platform capability matrix under its own recovery-source-ownership row:
// a narrower algorithm on the same identity foundation, with its own
// explicit status. There is no second proof path: a platform without the
// verified adapter gets the same explicit RECOVERY_OWNER_UNVERIFIED refusal
// and keeps its state.
import {selectCapability} from '../platform/platform-capabilities.mjs';
import * as linuxRecoveryOwner from '../platform/linux/recovery-owner.mjs';
import * as macosRecoveryOwner from '../platform/darwin/recovery-owner.mjs';

const fail=(code,message)=>Object.assign(Error(message),{code});
const select=()=>selectCapability({capability:'recovery-source-ownership',implementations:{linux:linuxRecoveryOwner,macos:macosRecoveryOwner}});

export async function assertRecoverySourceStopped(root,deps={}){
  const selection=deps.selection??select();
  if(selection.state!=='available')throw Object.assign(fail('RECOVERY_OWNER_UNVERIFIED','此平台尚不能核验其他实例；特殊项目恢复不可用，原状态已保留。'),{platform:selection.platform,...(selection.status?{status:selection.status}:{})});
  return selection.implementation.assertRecoverySourceStopped(root);
}
