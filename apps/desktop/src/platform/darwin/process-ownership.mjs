// Darwin native process identity, owner discovery and verified process-tree
// termination. Same contract as platform/linux/process-ownership.mjs; the
// platform facts come from the kernel's public interfaces instead of /proc:
//   identity      — sysctl KERN_BOOTTIME (boot id, encoded UUID-shaped) plus
//                   each process's start timeval from kinfo_proc, bound into
//                   one `<bootId>:<startSec><startUsec>` stamp. A stamp can
//                   never outlive its boot, and PID reuse shows as a start
//                   time change (a recycled pid is never the same owner).
//   ownerDiscovery— KERN_PROCARGS2 environment blocks of same-user processes
//                   carry the host env tags; `identity.member(env, record)`
//                   decides ownership exactly as on Linux.
//   groupTerm     — owners spawn as process-group leaders (detached spawn)
//                   and are signalled with kill(-pgid); every member is
//                   re-verified as the same incarnation before each signal.
//   descendantScan— whole-table KERN_PROC_ALL scans (the readdir('/proc')
//                   equivalent) with getsid(2) session provenance for strict
//                   reaping; both are double-checked against start times so a
//                   recycled pid is never attributed to the old incarnation.
// The facts are gathered by the bundled helper runtime/native/nozeli-procinfo
// (built from native/nozeli-procinfo.c by tools/build-darwin-procinfo.mjs);
// there is no kill(pid,0) existence guess anywhere. If the helper cannot be
// executed, every operation throws DARWIN_PROCINFO_UNAVAILABLE — callers keep
// their locks, budget slots and registrations (nothing is released, nothing is
// signalled). An unreadable fact is never translated into a liveness verdict.
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {constants as fsConstants, accessSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export const platform='macos';

export const mechanisms={
  identity:'kinfo_proc start timevals bound to the sysctl KERN_BOOTTIME boot id (UUID-shaped, µs resolution)',
  ownerDiscovery:'KERN_PROCARGS2 same-user environment host env-tag proof',
  groupTermination:'spawned process group + kill(-pgid), members verified individually',
  descendantScan:'whole-table KERN_PROC_ALL scan with per-member identity re-stamping and getsid session provenance'
};

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const ZOMBIE=5; // kernel p_stat SZOMB: the process already exited
const uid=typeof process.getuid==='function'?process.getuid():-1;

// ---------------------------------------------------------------- helper ---

// Resolution order: explicit override (absolute path, dev/test), then the
// packaged/dev layout runtime/native/ next to this adapter's app root. There
// is no PATH lookup — a fact source must be exactly the bundled helper.
const helperCandidates=()=>process.env.NOZELI_DARWIN_PROCINFO
  ?[process.env.NOZELI_DARWIN_PROCINFO]
  :[fileURLToPath(new URL('../../../runtime/native/nozeli-procinfo',import.meta.url))];

const unavailable=message=>Object.assign(new Error(message),{code:'DARWIN_PROCINFO_UNAVAILABLE'});

let helperPromise=null;
const resolveHelper=()=>{
  if(!helperPromise)helperPromise=(async()=>{
    const problems=[];
    for(const candidate of helperCandidates()){
      try{await fs.access(candidate,fsConstants.X_OK);return candidate;}
      catch(error){problems.push(`${candidate}: ${error.code??error.message}`);}
    }
    throw unavailable(`Darwin process facts helper is missing or not executable (${problems.join('; ')}). Build it with: node tools/build-darwin-procinfo.mjs`);
  })().catch(error=>{helperPromise=null;throw error;});
  return helperPromise;
};

// Run the helper and parse its NDJSON output. Any non-zero exit, spawn failure
// or malformed line is a hard failure: facts are never guessed.
async function runHelper(args){
  const helper=await resolveHelper();
  return await new Promise((resolve,reject)=>{
    const child=spawn(helper,args,{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.on('error',error=>reject(unavailable(`Darwin process facts helper could not be executed (${helper}): ${error.message}`)));
    child.on('close',code=>{
      if(code!==0){
        reject(unavailable(`Darwin process facts helper ${helper} ${args.join(' ')} exited with ${code}${stderr?`: ${stderr.trim().split('\n')[0]}`:''}`));
        return;
      }
      let rows;
      try{rows=stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line));}
      catch(error){reject(unavailable(`Darwin process facts helper emitted unparseable output: ${error.message}`));return;}
      if(rows.some(row=>row===null||typeof row!=='object'||Array.isArray(row))){
        reject(unavailable('Darwin process facts helper emitted an unknown record shape'));
        return;
      }
      resolve(rows);
    });
  });
}

let bootPromise=null;


// The boot id is kern.boottime (tv_sec,tv_usec) encoded into the shared
// 36-char lowercase hex-and-dash shape so persisted stamps keep ONE grammar
// across platforms: /^[a-f0-9-]{36}:\d+$/. It is a pure encoding of the
// kernel's boot instant — it changes exactly when the machine reboots, so a
// persisted stamp from an earlier boot can never validate against this one.
export async function bootId(){
  if(!bootPromise)bootPromise=(async()=>{
    const [row]=await runHelper(['boot']);
    if(!Number.isInteger(row?.bootSec)||!Number.isInteger(row?.bootUsec))throw unavailable('Darwin boot time facts are malformed');
    const hex=(value,width)=>value.toString(16).padStart(width,'0');
    return `${hex(row.bootSec,8)}-0000-4000-8000-${hex(row.bootUsec,8)}0000`;
  })().catch(error=>{bootPromise=null;throw error;});
  return bootPromise;
}

const startDigits=row=>`${row.startSec}${String(row.startUsec).padStart(6,'0')}`;
const rowStamp=async row=>`${await bootId()}:${startDigits(row)}`;

export async function processStamp(pid){
  if(!Number.isInteger(pid)||pid<=0)return null;
  const [row]=await runHelper(['info',String(pid)]);
  if(!row||row.gone||row.status===ZOMBIE)return null;
  if(!Number.isInteger(row.startSec)||!Number.isInteger(row.startUsec))throw unavailable(`Darwin process facts for pid ${pid} are malformed`);
  return rowStamp(row);
}

export async function ownerAlive(owner){
  const stamp=await processStamp(owner.pid);
  return Boolean(stamp&&(!owner.stamp||stamp===owner.stamp));
}

// ------------------------------------------------------------- signalling ---

export function signalProcessGroup(pid,signal){try{process.kill(-pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}}
export function signalProcess(pid,signal){try{process.kill(pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}}

export function spawnGroupLeader({command,args=[],cwd,env,stdio=['pipe','pipe','pipe'],windowsHide=true}){
  // Refuse before spawning: an owner started without the facts helper could
  // never be stamped or provably reaped, so it must not start at all.
  if(!helperCandidates().some(candidate=>{try{accessSync(candidate,fsConstants.X_OK);return true;}catch{return false;}}))
    throw unavailable(`Darwin process facts helper is missing (${helperCandidates()[0]}); refusing to start an owner that could never be verified. Build it with: node tools/build-darwin-procinfo.mjs`);
  // A new process group makes the owner a group leader so the whole tree can
  // be signalled and later verified member-by-member.
  return spawn(command,args,{cwd,env,detached:true,stdio,windowsHide});
}

// ------------------------------------------------------------------ scans ---

async function scanTable({sessions=false,argv:withArgv=false,paths=false}={}){
  const args=['scan',...(sessions?['--sessions']:[]),...(withArgv?['--argv']:[]),...(paths?['--paths']:[])];
  const rows=await runHelper(args);
  for(const row of rows){
    if(![row.pid,row.pgid,row.euid,row.ruid,row.status,row.startSec,row.startUsec].every(Number.isInteger))
      throw unavailable('Darwin process table facts are malformed');
  }
  return rows;
}

// Same-user processes with their environment blocks (runtime audit surface).
// Unreadable environments are skipped — exactly the Linux EACCES behaviour.
export async function listSameUserEnvironment(){
  const rows=await scanTable();
  return rows
    .filter(row=>row.status!==ZOMBIE&&(row.euid===uid||row.ruid===uid)&&Array.isArray(row.env))
    .map(row=>({pid:row.pid,env:row.env}));
}

// Pre-spawn snapshot of uninspectable same-user incarnations: only these can
// be excluded later by the strict reaper; anything uninspectable that appears
// afterwards is an unknown it refuses to certify or kill. A failed snapshot
// just narrows exclusions, so it never blocks a spawn.
export async function captureUninspectableBaseline(){
  try{
    const baseline=new Set();
    for(const row of await scanTable()){
      if(row.status===ZOMBIE||row.pid===process.pid)continue;
      if(row.euid!==uid&&row.ruid!==uid)continue;
      if(row.envDenied)baseline.add(`${row.pid}:${startDigits(row)}`);
    }
    return baseline;
  }catch{return null;}
}

// Batched incarnation re-check between a scan and signalling: only members
// whose start time still matches the scanned snapshot are signalled.
async function currentStarts(pids){
  if(!pids.length)return new Map();
  const rows=await runHelper(['stamps',...pids.map(String)]);
  const map=new Map();
  for(const row of rows)map.set(row.pid,row.gone||row.status===ZOMBIE?null:row);
  return map;
}

// ------------------------------------------------------------- group reap ---

// Verified termination for an owned process group (OMP/Codex style): scan the
// group's members (pgid == leader pid, any owner uid), prove each one through
// the host env tag, then TERM/KILL until the table is empty. A dead group
// leader does not imply its subprocesses have exited, so an empty verified
// member list is the only release condition.
export async function reapOwnedProcessGroup(record,identity){
  const messages=identity.messages;
  if(typeof record.stamp!=='string'||!/^[a-f0-9-]{36}:\d+$/.test(record.stamp))return {descendantsReaped:0,verified:false};
  const boot=await bootId();
  if(!record.stamp.startsWith(boot+':'))return {descendantsReaped:0,verified:true,reason:'previous-boot'};
  const touched=new Set();
  for(let attempt=0;attempt<25;attempt++){
    const leader=await processStamp(record.pid);if(leader&&leader!==record.stamp)throw new Error(messages.groupReused);
    const rows=await scanTable();
    const members=[];let retryScan=false;
    for(const row of rows){
      if(row.status===ZOMBIE||row.pgid!==record.pid)continue;
      const stamp=await rowStamp(row);
      if(row.env===undefined){
        // Alive without a readable block: a protected environment, a
        // group member of another uid, or the block simply not settled —
        // none of these can be tag-proven, so retry briefly, then fail.
        if(await processStamp(row.pid)===null)continue;  // exited mid-scan
        if(attempt<5){retryScan=true;break;}
        throw new Error(messages.memberUnverified);
      }
      if(!identity.member(row.env,record)){
        if(await processStamp(row.pid)===null)continue;
        if(!row.env.some(Boolean)&&attempt<5){retryScan=true;break;} // block not settled yet
        throw new Error(messages.memberUnverified);
      }
      members.push({pid:row.pid,stamp});
    }
    if(retryScan){await delay(20);continue;}
    if(!members.length)return {descendantsReaped:touched.size,verified:true};
    const starts=await currentStarts(members.map(member=>member.pid));
    for(const member of members){
      const current=starts.get(member.pid);
      if(!current||current.startSec===undefined||`${boot}:${startDigits(current)}`!==member.stamp)continue;
      try{process.kill(member.pid,attempt<10?'SIGTERM':'SIGKILL');touched.add(member.pid);}catch(e){if(e.code!=='ESRCH')throw e;}
    }
    await delay(100);
  }
  throw new Error(messages.descendantsDidNotExit);
}

// Cold recovery of an owned group leader: verify the persisted stamp still
// identifies the same process incarnation, prove the leader through
// `identity.leader(env, command, record)`, then stop the group and reap the
// verified tree. Every unproven step throws; nothing is released on
// assumption.
export async function recoverOwnedProcessGroupLeader(record,root,identity,attempt=0){
  const messages=identity.messages;
  const boot=await bootId();
  if(!record.stamp.startsWith(boot+':'))return {pid:record.pid,status:'previous-boot',descendantsReaped:0,verified:true};
  const stamp=await processStamp(record.pid);
  if(!stamp)return {pid:record.pid,status:'already-exited',...await reapOwnedProcessGroup(record,identity)};
  if(stamp!==record.stamp)throw new Error(messages.leaderReused);
  let args;
  try{[args]=await runHelper(['argsenv',String(record.pid)]);}
  catch(error){
    if(await processStamp(record.pid)===null)return {pid:record.pid,status:'exited-during-check',...await reapOwnedProcessGroup(record,identity)};
    if(attempt<5){await delay(20);return recoverOwnedProcessGroupLeader(record,root,identity,attempt+1);}
    throw error;
  }
  if(args.gone){
    if(await processStamp(record.pid)===null)return {pid:record.pid,status:'exited-during-check',...await reapOwnedProcessGroup(record,identity)};
    return recoverOwnedProcessGroupLeader(record,root,identity);
  }
  if(args.denied){
    if(await processStamp(record.pid)===null)return {pid:record.pid,status:'exited-during-check',...await reapOwnedProcessGroup(record,identity)};
    if(attempt<5){await delay(20);return recoverOwnedProcessGroupLeader(record,root,identity,attempt+1);}
    throw new Error(messages.leaderUnverified);
  }
  const env=args.env??[],cmd=args.argv??[];
  if(await processStamp(record.pid)!==record.stamp)return recoverOwnedProcessGroupLeader(record,root,identity);
  if(!identity.leader(env,cmd,record)){
    if(attempt<5&&(!env.some(Boolean)||!cmd.some(Boolean))){await delay(20);return recoverOwnedProcessGroupLeader(record,root,identity,attempt+1);}
    throw new Error(messages.leaderUnverified);
  }
  signalProcessGroup(record.pid,'SIGTERM');for(let i=0;i<20;i++){if(await processStamp(record.pid)!==record.stamp)return {pid:record.pid,status:'stopped',...await reapOwnedProcessGroup(record,identity)};await delay(100);}
  signalProcessGroup(record.pid,'SIGKILL');for(let i=0;i<20;i++){if(await processStamp(record.pid)!==record.stamp)return {pid:record.pid,status:'killed',...await reapOwnedProcessGroup(record,identity)};await delay(100);}
  throw new Error(messages.leaderDidNotExit);
}

// -------------------------------------------------------- tagged-tree reap ---

// Verified termination for a Pi owner and everything it tagged (Pi style).
// Pi owners run in separate process groups, but an inherited native-tool
// process can escape the group, so the scan covers the whole process table:
// every same-user process carrying the owner tags is reaped, and a same-group
// member without the tags blocks the release as unverified.
//
// options.strict (host-owned interactive terminals): same-user processes
// whose environment cannot be read (protected blocks) are proven through
// kernel provenance instead — a process holds the owner's process group
// (kinfo e_pgid) or session (getsid(2), start-time double-checked) only by
// descent. An uninspectable process that is not in the caller's pre-spawn
// baseline is an UNKNOWN: it is never signalled and never certified away;
// the reap fails unverified instead. Legacy callers keep those semantics.
export async function reapOwnerTaggedTree(record,identity,options={}){
  const messages=identity.messages;
  const strict=options.strict===true,baseline=options.baseline??null;
  const boot=await bootId();
  if(!record.stamp.startsWith(boot+':'))return {verified:true,platform:'macos',reason:'previous-boot',descendantsReaped:0};
  const touched=new Set(),unknown=new Map();
  for(let attempt=0;attempt<30;attempt++){
    unknown.clear();
    const leader=await processStamp(record.pid);
    if(leader&&leader!==record.stamp)throw new Error(messages.groupReused);
    const rows=await scanTable({sessions:strict});
    const members=[];
    for(const row of rows){
      if(row.status===ZOMBIE)continue;
      const sameGroup=row.pgid===record.pid;
      const sameSession=strict&&Number.isInteger(row.sid)&&row.sid===record.pid;
      if(!sameGroup&&!sameSession&&row.euid!==uid&&row.ruid!==uid)continue;
      if(strict&&(sameGroup||sameSession)){members.push({pid:row.pid,stamp:await rowStamp(row)});continue;} // terminal-only kernel provenance
      if(row.env===undefined){
        if(row.envDenied){
          // Same-user protected block: provable only through the pre-spawn
          // baseline; anything else is an unknown that is never signalled.
          if(!strict){
            if(sameGroup&&await processStamp(row.pid)!==null)throw new Error(messages.memberUnverified);
            continue;
          }
          const incarnation=`${row.pid}:${startDigits(row)}`;
          if(baseline?.has(incarnation))continue;  // securely captured before the spawn
          unknown.set(incarnation,row.pid);        // post-spawn unknown: never killed, never certified
          continue;
        }
        // Block not fetched: either the process exited mid-scan, or it is a
        // same-group member running as another uid — the latter can never be
        // tag-proven, so the release fails unverified instead of skipping it.
        if(sameGroup&&await processStamp(row.pid)!==null&&!strict)throw new Error(messages.memberUnverified);
        continue;
      }
      if(!identity.member(row.env,record)){
        if(!sameGroup||await processStamp(row.pid)!==`${boot}:${startDigits(row)}`)continue;
        throw new Error(messages.memberUnverified);
      }
      members.push({pid:row.pid,stamp:await rowStamp(row)});
    }
    if(!members.length){
      if(unknown.size){await delay(100);continue;} // bounded grace for unknowns to exit on their own
      return {verified:true,platform:'macos',descendantsReaped:touched.size};
    }
    const starts=await currentStarts(members.map(member=>member.pid));
    for(const member of members){
      const current=starts.get(member.pid);
      if(!current||current.startSec===undefined||`${boot}:${startDigits(current)}`!==member.stamp)continue;
      signalProcess(member.pid,attempt<15?'SIGTERM':'SIGKILL');
      touched.add(member.pid);
    }
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
  const [args]=await runHelper(['argsenv',String(record.pid)]);
  if(args.gone||args.denied||!Array.isArray(args.argv)||!Array.isArray(args.env))throw new Error(messages.leaderUnverified);
  if(!identity.leader(args.env,args.argv,record))throw new Error(messages.leaderUnverified);
  if(await processStamp(record.pid)!==stamp)throw new Error(messages.leaderChanged);
  signalProcessGroup(record.pid,'SIGTERM');
  for(let attempt=0;attempt<40;attempt++){
    if(await processStamp(record.pid)!==stamp)return {pid:record.pid,status:'stopped',...await reapOwnerTaggedTree(record,identity)};
    if(attempt===20)signalProcessGroup(record.pid,'SIGKILL');
    await delay(100);
  }
  throw new Error(messages.leaderDidNotExit);
}

// ------------------------------------------- recovery-source ownership facts ---

// Executable backing a pid (proc_pidpath). `null` means the process is gone;
// a denied lookup throws — an unreadable executable identity is never
// translated into "unrelated, skip".
export async function processExePath(pid){
  if(!Number.isInteger(pid)||pid<=0)return null;
  const [row]=await runHelper(['path',String(pid)]);
  if(!row||row.gone)return null;
  if(row.denied||typeof row.path!=='string'||!row.path)throw unavailable(`executable path of pid ${pid} cannot be inspected`);
  return row.path;
}

// Open vnode descriptors of a pid with the exact inode behind each. An empty
// list means the process is gone; a denied table throws.
export async function processFds(pid){
  const rows=await runHelper(['fds',String(pid)]);
  if(rows.some(row=>row.denied))throw Object.assign(new Error(`file descriptors of pid ${pid} cannot be inspected`),{code:'PROCINFO_FD_DENIED'});
  return rows.filter(row=>Number.isInteger(row.fd)&&typeof row.path==='string'&&Number.isInteger(row.dev)&&Number.isInteger(row.ino))
    .map(row=>({pid:row.pid,fd:row.fd,dev:row.dev,ino:row.ino,path:row.path}));
}

// Same-user snapshot with argv, env and executable path for the conservative
// recovery-source probe (platform/darwin/recovery-owner.mjs).
export async function sameUserSnapshot(){
  const rows=await scanTable({argv:true,paths:true});
  return rows.filter(row=>row.status!==ZOMBIE&&(row.euid===uid||row.ruid===uid));
}
