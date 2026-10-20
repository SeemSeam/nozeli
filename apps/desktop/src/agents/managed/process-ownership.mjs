import fs from 'node:fs/promises';
import path from 'node:path';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function processStamp(pid){
  if(process.platform!=='linux')return null;
  try{const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');const parts=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(parts[0]==='Z')return null;const boot=(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();return `${boot}:${parts[19]}`;}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return null;throw e;}
}
export async function ownerAlive(owner){
  if(!Number.isInteger(owner?.pid)||owner.pid<=0)throw new Error('invalid owner PID');
  if(process.platform==='linux'){const stamp=await processStamp(owner.pid);return Boolean(stamp && (!owner.stamp||stamp===owner.stamp));}
  try{process.kill(owner.pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}
}
export async function recoverProvider(record,root,attempt=0){
  if(process.platform!=='linux')throw new Error('orphan identity recovery is verified on Linux only');
  const rel=path.relative(path.join(root,'agents'),record.home);
  if(!rel || rel.startsWith('..')||path.isAbsolute(rel))throw new Error('provider home outside owned agents root');
  if(!record.stamp)throw new Error('provider process identity missing');
  if(typeof record.stamp!=='string'||!/^[a-f0-9-]{36}:\d+$/.test(record.stamp))throw new Error('provider process identity invalid');
  const boot=(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
  if(!record.stamp.startsWith(boot+':'))return {pid:record.pid,status:'previous-boot',descendantsReaped:0,verified:true};
  const stamp=await processStamp(record.pid);if(!stamp)return {pid:record.pid,status:'already-exited',...await reapOwnedGroup(record)};if(stamp!==record.stamp)throw new Error('provider PID identity reused');
  let env,cmd;try{env=(await fs.readFile(`/proc/${record.pid}/environ`)).toString().split('\0');cmd=(await fs.readFile(`/proc/${record.pid}/cmdline`)).toString().split('\0');}catch(e){if(['ENOENT','ESRCH','EACCES'].includes(e.code)&&!(await processStamp(record.pid)))return {pid:record.pid,status:'exited-during-check',...await reapOwnedGroup(record)};if(['ENOENT','ESRCH','EACCES'].includes(e.code)&&attempt<5){await delay(20);return recoverProvider(record,root,attempt+1);}throw e;}
  if(await processStamp(record.pid)!==record.stamp)return recoverProvider(record,root);
  if(!env.includes(`CODEX_HOME=${record.home}`)||!cmd.some(v=>v.includes('codex'))||!(record.kind==='native-terminal'?(cmd.includes('resume')&&cmd.includes('--remote')):cmd.includes('app-server'))){if(attempt<5&&(!env.some(Boolean)||!cmd.some(Boolean))){await delay(20);return recoverProvider(record,root,attempt+1);}throw new Error('provider identity cannot be verified');}
  const signal=sig=>{try{process.kill(-record.pid,sig);}catch(e){if(e.code!=='ESRCH')throw e;}};
  signal('SIGTERM');for(let i=0;i<20;i++){if(await processStamp(record.pid)!==record.stamp)return {pid:record.pid,status:'stopped',...await reapOwnedGroup(record)};await delay(100);}
  signal('SIGKILL');for(let i=0;i<20;i++){if(await processStamp(record.pid)!==record.stamp)return {pid:record.pid,status:'killed',...await reapOwnedGroup(record)};await delay(100);}throw new Error('owned provider did not exit');
}

// A dead group leader does not imply its subprocesses have exited.
export async function reapOwnedGroup(record){
  if(process.platform!=='linux'||!record?.stamp)return {descendantsReaped:0,verified:false};
  if(typeof record.stamp!=='string'||!/^[a-f0-9-]{36}:\d+$/.test(record.stamp))return {descendantsReaped:0,verified:false};
  const boot=(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
  if(!record.stamp.startsWith(boot+':'))return {descendantsReaped:0,verified:true,reason:'previous-boot'};
  const touched=new Set();
  for(let attempt=0;attempt<25;attempt++){
    const leader=await processStamp(record.pid);if(leader&&leader!==record.stamp)throw new Error('provider group identity reused');
    const members=[];let retryScan=false;
    for(const entry of await fs.readdir('/proc')){
      if(!/^\d+$/.test(entry))continue;
      try{const stat=await fs.readFile(`/proc/${entry}/stat`,'utf8'),parts=stat.slice(stat.lastIndexOf(')')+2).split(' ');if(parts[0]==='Z'||Number(parts[2])!==record.pid)continue;
        const env=(await fs.readFile(`/proc/${entry}/environ`)).toString().split('\0');if(!env.includes(`CODEX_HOME=${record.home}`)){if(!(await processStamp(Number(entry))))continue;if(!env.some(Boolean)&&attempt<5){retryScan=true;break;}throw new Error('provider descendant identity cannot be verified');}
        members.push({pid:Number(entry),stamp:`${boot}:${parts[19]}`});
      }catch(e){if(e.code==='EACCES'){if(!(await processStamp(Number(entry))))continue;if(attempt<5){retryScan=true;break;}}if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e;}
    }
    if(retryScan){await delay(20);continue;}
    if(!members.length)return {descendantsReaped:touched.size,verified:true};
    for(const member of members){if(await processStamp(member.pid)!==member.stamp)continue;try{process.kill(member.pid,attempt<10?'SIGTERM':'SIGKILL');touched.add(member.pid);}catch(e){if(e.code!=='ESRCH')throw e;}}
    await delay(100);
  }
  throw new Error('owned provider descendants did not exit');
}
