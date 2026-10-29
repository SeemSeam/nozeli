import fs from 'node:fs/promises';
import {platformNative} from './native.mjs';
export async function bootSession(){
  if(process.platform==='darwin')return platformNative().bootSession();
  if(process.platform==='linux')return (await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
  throw Object.assign(Error('Process identity is unavailable on '+process.platform),{code:'PROCESS_UNVERIFIED'});
}
export function validStamp(stamp){return typeof stamp==='string'&&(process.platform==='linux'?/^[a-f0-9-]{36}:\d+$/.test(stamp):process.platform==='darwin'&&/^darwin:[a-fA-F0-9-]{36}:\d+:\d+$/.test(stamp));}
export async function sameBoot(stamp){if(!validStamp(stamp))throw Object.assign(Error('Process stamp is missing, foreign or invalid'),{code:'PROCESS_UNVERIFIED'});return stamp.startsWith((process.platform==='darwin'?'darwin:':'')+await bootSession()+':');}
export async function processInfo(pid,{full=false,ownership=false}={}){
  if(!Number.isInteger(pid)||pid<=0)throw Error('invalid PID');
  try{
    if(process.platform==='darwin')return platformNative().processInfo(pid,ownership?2:full?1:0);
    if(process.platform!=='linux')throw Object.assign(Error('Process query unavailable'),{code:'PROCESS_UNVERIFIED'});
    const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8'),parts=stat.slice(stat.lastIndexOf(')')+2).split(' ');
    if(parts[0]==='Z')return null;
    const uid=(await fs.stat(`/proc/${pid}`)).uid;
    const value={pid,ppid:Number(parts[1]),pgid:Number(parts[2]),state:parts[0],uid,stamp:await bootSession()+':'+parts[19]};
    if(full||ownership){value.argv=(await fs.readFile(`/proc/${pid}/cmdline`)).toString().split('\0');value.environ=(await fs.readFile(`/proc/${pid}/environ`)).toString().split('\0');const after=await processInfo(pid);if(!after)return null;if(after.stamp!==value.stamp||after.uid!==value.uid||after.pgid!==value.pgid||after.ppid!==value.ppid)throw Object.assign(Error('Process changed during query'),{code:'PROCESS_CHANGED'});}
    return value;
  }catch(error){if(['ESRCH','ENOENT'].includes(error.code))return null;throw error;}
}
export async function listUserProcesses(){
  if(process.platform==='darwin')return platformNative().listProcesses();
  if(process.platform!=='linux')throw Object.assign(Error('Process enumeration unavailable'),{code:'PROCESS_UNVERIFIED'});
  const pids=[];
  for(const name of await fs.readdir('/proc'))if(/^\d+$/.test(name)){
    try{if((await fs.stat('/proc/'+name)).uid===process.getuid())pids.push(Number(name));}
    catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
  }
  return pids;
}
export const processQuery={processInfo,listUserProcesses,sameBoot,validStamp};

// Kept separate so synthetic Linux /proc regressions run on every build host.
export async function linuxProcessStamp(pid){
 try{const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8'),parts=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(parts[0]==='Z')return null;return (await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()+':'+parts[19];}
 catch(error){if(['ENOENT','ESRCH'].includes(error.code))return null;throw error;}
}
