import path from 'node:path';
import {processQuery} from './process-query.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const belongs=(info,record,keys)=>{const values=(info.ownershipEnviron??info.environ??[]).filter(value=>keys.some(key=>value.startsWith(key+'=')));return values.length>0&&values.every(value=>keys.some(key=>value===key+'='+record.home));};
const fail=message=>{throw Object.assign(Error(message),{code:'PROCESS_UNVERIFIED'});};
// This capability exists only in the spawning process. A persisted owner record
// cannot recreate it. Mutable argv/environment are not the ownership evidence
// for this still-live direct child; its spawn exit promise and kernel identity are.
const directChildren=new WeakMap();
export async function captureDirectChild(record,exited){
  const fact=await processQuery.processInfo(record.pid);
  if(!fact||fact.stamp!==record.stamp||fact.ppid!==process.pid||fact.pgid!==record.pid||fact.uid!==process.getuid())fail('spawned child identity could not be acquired');
  const token=Object.freeze({}),proof={...fact,exited:false};directChildren.set(token,proof);
  Promise.resolve(exited).then(()=>{proof.exited=true;},()=>{proof.exited=true;});return token;
}
export async function reapGroup(record,keys,{query=processQuery,signal=(pid,sig)=>process.kill(pid,sig),sleep=delay,directChild}={}){
  if(!Number.isInteger(record?.pid)||record.pid<=1||!query.validStamp(record.stamp))return {descendantsReaped:0,verified:false,platform:process.platform};
  if(!await query.sameBoot(record.stamp))return {descendantsReaped:0,verified:true,reason:'previous-boot',platform:process.platform};
  const touched=new Set();let emptyScans=0;
  const direct=info=>{const p=directChild&&directChildren.get(directChild);return Boolean(p&&!p.exited&&info&&info.pid===record.pid&&info.stamp===record.stamp&&info.stamp===p.stamp&&info.ppid===p.ppid&&info.uid===p.uid&&info.pgid===record.pid);};
  for(let attempt=0;attempt<25;attempt++){
    const leader=await query.processInfo(record.pid);
    if(leader&&leader.stamp!==record.stamp)fail('provider group identity reused');
    if(leader&&leader.pgid!==record.pid)fail('provider is not the recorded group leader');
    const members=[];
    for(const pid of await query.listUserProcesses()){
      const fact=await query.processInfo(pid);if(!fact||fact.pgid!==record.pid)continue;
      const info=direct(fact)?fact:await query.processInfo(pid,{full:true,ownership:true});if(!info)continue;
      if(info.stamp!==fact.stamp||info.pgid!==record.pid)fail('provider group changed during scan');
      if(!direct(info)&&!belongs(info,record,keys))fail('provider descendant ownership cannot be verified');
      members.push(info);
    }
    if(!members.length){if(++emptyScans===2)return {descendantsReaped:touched.size,verified:true,platform:process.platform};await sleep(20);continue;}
    emptyScans=0;
    for(const member of members){
      const basic=await query.processInfo(member.pid);if(!basic)continue;
      const current=direct(basic)?basic:await query.processInfo(member.pid,{full:true,ownership:true});if(!current)continue;
      if(current.stamp!==member.stamp||current.pgid!==record.pid||(!direct(current)&&!belongs(current,record,keys)))fail('provider descendant identity changed before signal');
      const currentLeader=await query.processInfo(record.pid);if(currentLeader&&currentLeader.stamp!==record.stamp)fail('provider group identity reused');
      try{signal(member.pid,attempt<10?'SIGTERM':'SIGKILL');touched.add(member.pid);}catch(error){if(error.code!=='ESRCH')throw error;}
    }
    await sleep(100);
  }
  fail('owned provider descendants did not exit');
}
export async function recoverOwned(record,root,keys,commandMatches,{query=processQuery,...options}={}){
  const rel=path.relative(path.join(root,'agents'),record.home);
  if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))fail('provider home outside owned agents root');
  if(!Number.isInteger(record.pid)||record.pid<=1||!query.validStamp(record.stamp))fail('provider process identity invalid');
  if(!await query.sameBoot(record.stamp))return {pid:record.pid,status:'previous-boot',descendantsReaped:0,verified:true};
  const leader=await query.processInfo(record.pid,{full:true,ownership:true});
  if(leader&&(leader.stamp!==record.stamp||leader.pgid!==record.pid||!belongs(leader,record,keys)||!commandMatches(leader.argv)))fail('provider identity cannot be verified');
  const reaped=await reapGroup(record,keys,{query,...options});
  return {pid:record.pid,status:leader?'stopped':'already-exited',...reaped};
}
