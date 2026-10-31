import fs from 'node:fs/promises';
import path from 'node:path';
import {processStamp} from './process-ownership.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const validStamp=value=>typeof value==='string'&&/^[a-f0-9-]{36}:\d+$/.test(value);
const validOwner=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const signal=(pid,value)=>{try{process.kill(pid,value);}catch(error){if(error.code!=='ESRCH')throw error;}};

// Node owners run in separate process groups. A leader exit alone cannot release
// the host's process-budget slot: native bash grandchildren must be gone too.
export async function reapOwnedPiGroup(record){
 if(process.platform!=='linux'||!validStamp(record?.stamp)||!validOwner(record?.ownerId))return {verified:false,platform:process.platform,descendantsReaped:0};
 const boot=(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
 if(!record.stamp.startsWith(boot+':'))return {verified:true,platform:'linux',reason:'previous-boot',descendantsReaped:0};
 const touched=new Set();
 for(let attempt=0;attempt<30;attempt++){
  const leader=await processStamp(record.pid);
  if(leader&&leader!==record.stamp)throw Error('Pi owner PID was reused; process group retained');
  const members=[];
  for(const name of await fs.readdir('/proc')){
   if(!/^\d+$/.test(name))continue;
   const pid=Number(name);
   let sameGroup=false;
   try{
    const raw=await fs.readFile(`/proc/${pid}/stat`,'utf8'),parts=raw.slice(raw.lastIndexOf(')')+2).split(' ');
    if(parts[0]==='Z')continue;
    sameGroup=Number(parts[2])===record.pid;
    if(!sameGroup&&(await fs.stat(`/proc/${pid}`)).uid!==process.getuid())continue;
    const stamp=`${boot}:${parts[19]}`,env=(await fs.readFile(`/proc/${pid}/environ`)).toString().split('\0');
    const owned=env.includes(`NOZELI_PI_OWNER_HOME=${record.home}`)&&env.includes(`NOZELI_PI_OWNER_ID=${record.ownerId}`);
    if(!owned){
     if(!sameGroup||await processStamp(pid)!==stamp)continue;
     throw Error('Pi group contains an unverified member; refusing to release ownership');
    }
    members.push({pid,stamp});
   }catch(error){if(['ENOENT','ESRCH'].includes(error.code)||error.code==='EACCES'&&!sameGroup)continue;throw error;}
  }
  if(!members.length)return {verified:true,platform:'linux',descendantsReaped:touched.size};
  for(const member of members)if(await processStamp(member.pid)===member.stamp){signal(member.pid,attempt<15?'SIGTERM':'SIGKILL');touched.add(member.pid);}
  await pause(100);
 }
 throw Error('Pi owner descendants did not exit; process budget retained');
}

export async function recoverPiProvider(record,root){
 if(process.platform!=='linux')throw Error('Pi orphan recovery has not been verified on '+process.platform);
 if(!Number.isInteger(record?.pid)||record.pid<=0||record.kind!=='pi-node'||!validStamp(record.stamp)||!validOwner(record.ownerId))throw Error('Invalid Pi owner identity; original registration retained');
 const relative=path.relative(path.join(root,'agents'),record.home);
 if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Pi owner home outside private project agents');
 const boot=(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
 if(!record.stamp.startsWith(boot+':'))return {pid:record.pid,status:'previous-boot',verified:true,descendantsReaped:0};
 const stamp=await processStamp(record.pid);
 if(!stamp)return {pid:record.pid,status:'already-exited',...await reapOwnedPiGroup(record)};
 if(stamp!==record.stamp)throw Error('Pi owner PID reused; refusing to signal unrelated process');
 const env=(await fs.readFile(`/proc/${record.pid}/environ`)).toString().split('\0');
 const command=(await fs.readFile(`/proc/${record.pid}/cmdline`)).toString().split('\0');
 if(!env.includes(`NOZELI_PI_OWNER_HOME=${record.home}`)||!env.includes(`NOZELI_PI_OWNER_ID=${record.ownerId}`)||!command.some(part=>/[\\/]integrations[\\/]pi[\\/]/.test(part)))throw Error('Pi owner executable identity cannot be verified');
 if(await processStamp(record.pid)!==stamp)throw Error('Pi owner changed during recovery');
 signal(-record.pid,'SIGTERM');
 for(let attempt=0;attempt<40;attempt++){
  if(await processStamp(record.pid)!==stamp)return {pid:record.pid,status:'stopped',...await reapOwnedPiGroup(record)};
  if(attempt===20)signal(-record.pid,'SIGKILL');
  await pause(100);
 }
 throw Error('Pi owner exit unconfirmed; original registration retained');
}
