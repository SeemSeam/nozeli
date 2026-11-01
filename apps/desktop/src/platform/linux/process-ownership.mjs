// Linux native process identity, owner discovery and verified process-tree
// termination. This adapter owns the platform facts only: /proc/<pid>/stat
// start-time stamps bound to the boot id, process groups created at spawn,
// kill(-pgid) group signalling and /proc table scans. The business ownership
// markers (which env tags prove a descendant belongs to a host-owned provider)
// and all user-visible error text are supplied as a narrow `identity`
// descriptor by the managed contracts that call this adapter; nothing here
// guesses behaviour for a platform it cannot verify.
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';

export const platform='linux';
export const mechanisms={
  identity:'/proc/<pid>/stat start time + /proc/sys/kernel/random/boot_id',
  ownerDiscovery:'/proc/<pid>/environ host env-tag proof',
  groupTermination:'spawned process group + kill(-pgid), members verified individually',
  descendantScan:'/proc table scan with per-member identity re-stamping'
};

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export async function bootId(){return (await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();}

export async function processStamp(pid){
  try{const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');const parts=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(parts[0]==='Z')return null;const boot=(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();return `${boot}:${parts[19]}`;}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return null;throw e;}
}

export async function ownerAlive(owner){
  const stamp=await processStamp(owner.pid);return Boolean(stamp&&(!owner.stamp||stamp===owner.stamp));
}

export function signalProcessGroup(pid,signal){try{process.kill(-pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}}
export function signalProcess(pid,signal){try{process.kill(pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}}
export function spawnGroupLeader({command,args=[],cwd,env,stdio=['pipe','pipe','pipe'],windowsHide=true}){
  // A new process group makes the owner a group leader so the whole tree can
  // be signalled and later verified member-by-member.
  return spawn(command,args,{cwd,env,detached:true,stdio,windowsHide});
}

// Verified termination for an owned process group (OMP/Codex style): scan the
// group's members, prove each one through the host env tag, then TERM/KILL
// until the table is empty. A dead group leader does not imply its
// subprocesses have exited, so an empty verified member list is the only
// release condition. `identity.member(env, record)` decides ownership.
export async function reapOwnedProcessGroup(record,identity){
  const messages=identity.messages;
  if(typeof record.stamp!=='string'||!/^[a-f0-9-]{36}:\d+$/.test(record.stamp))return {descendantsReaped:0,verified:false};
  const boot=await bootId();
  if(!record.stamp.startsWith(boot+':'))return {descendantsReaped:0,verified:true,reason:'previous-boot'};
  const touched=new Set();
  for(let attempt=0;attempt<25;attempt++){
    const leader=await processStamp(record.pid);if(leader&&leader!==record.stamp)throw new Error(messages.groupReused);
    const members=[];let retryScan=false;
    for(const entry of await fs.readdir('/proc')){
      if(!/^\d+$/.test(entry))continue;
      try{const stat=await fs.readFile(`/proc/${entry}/stat`,'utf8'),parts=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(parts[0]==='Z'||Number(parts[2])!==record.pid)continue;
        const env=(await fs.readFile(`/proc/${entry}/environ`)).toString().split('\0');
        if(!identity.member(env,record)){if(!(await processStamp(Number(entry))))continue;if(!env.some(Boolean)&&attempt<5){retryScan=true;break;}throw new Error(messages.memberUnverified);}
        members.push({pid:Number(entry),stamp:`${boot}:${parts[19]}`});
      }catch(e){if(e.code==='EACCES'){if(!(await processStamp(Number(entry))))continue;if(attempt<5){retryScan=true;break;}}if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e;}
    }
    if(retryScan){await delay(20);continue;}
    if(!members.length)return {descendantsReaped:touched.size,verified:true};
    for(const member of members){if(await processStamp(member.pid)!==member.stamp)continue;try{process.kill(member.pid,attempt<10?'SIGTERM':'SIGKILL');touched.add(member.pid);}catch(e){if(e.code!=='ESRCH')throw e;}}
    await delay(100);
  }
  throw new Error(messages.descendantsDidNotExit);
}

// Cold recovery of an owned group leader (OMP/Codex style): verify the
// persisted stamp still identifies the same process incarnation, prove the
// leader through `identity.leader(env, command, record)`, then stop the group
// and reap the verified tree. Every unproven step throws; nothing is released
// on assumption.
export async function recoverOwnedProcessGroupLeader(record,root,identity,attempt=0){
  const messages=identity.messages;
  const boot=await bootId();
  if(!record.stamp.startsWith(boot+':'))return {pid:record.pid,status:'previous-boot',descendantsReaped:0,verified:true};
  const stamp=await processStamp(record.pid);
  if(!stamp)return {pid:record.pid,status:'already-exited',...await reapOwnedProcessGroup(record,identity)};
  if(stamp!==record.stamp)throw new Error(messages.leaderReused);
  let env,cmd;try{env=(await fs.readFile(`/proc/${record.pid}/environ`)).toString().split('\0');cmd=(await fs.readFile(`/proc/${record.pid}/cmdline`)).toString().split('\0');}
  catch(e){if(['ENOENT','ESRCH','EACCES'].includes(e.code)&&!(await processStamp(record.pid)))return {pid:record.pid,status:'exited-during-check',...await reapOwnedProcessGroup(record,identity)};if(['ENOENT','ESRCH','EACCES'].includes(e.code)&&attempt<5){await delay(20);return recoverOwnedProcessGroupLeader(record,root,identity,attempt+1);}throw e;}
  if(await processStamp(record.pid)!==record.stamp)return recoverOwnedProcessGroupLeader(record,root,identity);
  if(!identity.leader(env,cmd,record)){if(attempt<5&&(!env.some(Boolean)||!cmd.some(Boolean))){await delay(20);return recoverOwnedProcessGroupLeader(record,root,identity,attempt+1);}throw new Error(messages.leaderUnverified);}
  signalProcessGroup(record.pid,'SIGTERM');for(let i=0;i<20;i++){if(await processStamp(record.pid)!==record.stamp)return {pid:record.pid,status:'stopped',...await reapOwnedProcessGroup(record,identity)};await delay(100);}
  signalProcessGroup(record.pid,'SIGKILL');for(let i=0;i<20;i++){if(await processStamp(record.pid)!==record.stamp)return {pid:record.pid,status:'killed',...await reapOwnedProcessGroup(record,identity)};await delay(100);}
  throw new Error(messages.leaderDidNotExit);
}

// Verified termination for a Pi owner and everything it tagged (Pi style).
// Pi owners run in separate process groups, but an inherited native-tool
// process can escape the group, so the scan covers the whole user process
// table: every same-uid process carrying the owner tags is reaped, and a
// same-group member without the tags blocks the release as unverified.
//
// options.strict (host-owned interactive terminals): same-uid processes whose
// environment cannot be read (non-dumpable jobs) are proven through kernel
// session/group provenance instead — a process holds the owner's session or
// process group only by descent. An uninspectable process that is not in the
// caller's pre-spawn baseline is an UNKNOWN: it is never signalled and never
// certified away; the reap fails unverified instead. Legacy Pi callers
// (no options) keep the exact previous semantics.
export async function reapOwnerTaggedTree(record,identity,options={}){
  const messages=identity.messages;
  const strict=options.strict===true,baseline=options.baseline??null;
  const boot=await bootId();
  if(!record.stamp.startsWith(boot+':'))return {verified:true,platform:'linux',reason:'previous-boot',descendantsReaped:0};
  const touched=new Set(),unknown=new Map();
  for(let attempt=0;attempt<30;attempt++){
    unknown.clear();
    const leader=await processStamp(record.pid);
    if(leader&&leader!==record.stamp)throw new Error(messages.groupReused);
    const members=[];
    for(const name of await fs.readdir('/proc')){
      if(!/^\d+$/.test(name))continue;
      const pid=Number(name);
      let sameGroup=false;
      try{
        const raw=await fs.readFile(`/proc/${pid}/stat`,'utf8'),parts=raw.slice(raw.lastIndexOf(')')+2).split(' ');
        if(parts[0]==='Z')continue;
        sameGroup=Number(parts[2])===record.pid;
        const sameSession=strict&&Number(parts[3])===record.pid;
        if(!sameGroup&&!sameSession&&(await fs.stat(`/proc/${pid}`)).uid!==process.getuid())continue;
        if(strict&&(sameGroup||sameSession)){members.push({pid,stamp:`${boot}:${parts[19]}`});continue;} // terminal-only kernel provenance
        let env;
        try{env=(await fs.readFile(`/proc/${pid}/environ`)).toString().split('\0');}
        catch(error){
          if(!['EACCES','EPERM'].includes(error.code))throw error;
          if(!strict){if(sameGroup)throw error;continue;}
          const incarnation=`${pid}:${parts[19]}`;
          if(baseline?.has(incarnation))continue;            // securely captured before the spawn
          unknown.set(incarnation,pid);                       // post-spawn unknown: never killed, never certified
          continue;
        }
        if(!identity.member(env,record)){
          if(!sameGroup||await processStamp(pid)!==`${boot}:${parts[19]}`)continue;
          throw new Error(messages.memberUnverified);
        }
        members.push({pid,stamp:`${boot}:${parts[19]}`});
      }catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw error;}
    }
    if(!members.length){
      if(unknown.size){await delay(100);continue;}            // bounded grace for unknowns to exit on their own
      return {verified:true,platform:'linux',descendantsReaped:touched.size};
    }
    for(const member of members)if(await processStamp(member.pid)===member.stamp){signalProcess(member.pid,attempt<15?'SIGTERM':'SIGKILL');touched.add(member.pid);}
    await delay(100);
  }
  if(unknown.size)throw new Error(`${messages.memberUnverified}: ${unknown.size} uninspectable same-uid process(es) appeared after spawn and cannot be proven foreign`);
  throw new Error(messages.descendantsDidNotExit);
}

// Cold recovery of a Pi owner: same incarnation proof as the group reaper,
// with `identity.leader(env, command, record)` additionally proving the
// executable really is the bundled Pi owner before any signal is sent.
export async function recoverOwnerTaggedLeader(record,identity){
  const messages=identity.messages;
  const boot=await bootId();
  if(!record.stamp.startsWith(boot+':'))return {pid:record.pid,status:'previous-boot',verified:true,descendantsReaped:0};
  const stamp=await processStamp(record.pid);
  if(!stamp)return {pid:record.pid,status:'already-exited',...await reapOwnerTaggedTree(record,identity)};
  if(stamp!==record.stamp)throw new Error(messages.leaderReused);
  const env=(await fs.readFile(`/proc/${record.pid}/environ`)).toString().split('\0');
  const command=(await fs.readFile(`/proc/${record.pid}/cmdline`)).toString().split('\0');
  if(!identity.leader(env,command,record))throw new Error(messages.leaderUnverified);
  if(await processStamp(record.pid)!==stamp)throw new Error(messages.leaderChanged);
  signalProcessGroup(record.pid,'SIGTERM');
  for(let attempt=0;attempt<40;attempt++){
    if(await processStamp(record.pid)!==stamp)return {pid:record.pid,status:'stopped',...await reapOwnerTaggedTree(record,identity)};
    if(attempt===20)signalProcessGroup(record.pid,'SIGKILL');
    await delay(100);
  }
  throw new Error(messages.leaderDidNotExit);
}
