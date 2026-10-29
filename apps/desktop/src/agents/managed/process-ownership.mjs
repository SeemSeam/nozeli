import {processInfo,validStamp} from '../../platform/process-query.mjs';
import {reapGroup,recoverOwned} from '../../platform/owned-processes.mjs';
export async function processStamp(pid){if(!Number.isInteger(pid)||pid<=0)return null;return (await processInfo(pid))?.stamp??null;}
export async function ownerAlive(owner){
  if(!Number.isInteger(owner?.pid)||owner.pid<=0)throw Error('invalid owner PID');
  if(owner.stamp&&!validStamp(owner.stamp))throw Object.assign(Error('Unrecognized workspace owner stamp; preserve the workspace'),{code:'PROCESS_UNVERIFIED'});
  const stamp=await processStamp(owner.pid);return Boolean(stamp&&(!owner.stamp||stamp===owner.stamp));
}
export const reapOwnedGroup=record=>reapGroup(record,['CODEX_HOME']);
export const recoverProvider=(record,root)=>recoverOwned(record,root,['CODEX_HOME'],cmd=>cmd.some(v=>v.includes('codex'))&&(record.kind==='native-terminal'?(cmd.includes('resume')&&cmd.includes('--remote')):cmd.includes('app-server')));
