import fs from 'node:fs/promises';
import path from 'node:path';
import {listUserProcesses,processInfo} from '../../platform/process-query.mjs';
export async function auditRuntime(root){
 const agents=path.join(root,'agents'),processes=[],unverified=[];
 try{for(const pid of await listUserProcesses()){
  try{const info=await processInfo(pid,{full:true,ownership:true});if((info?.ownershipEnviron??info?.environ??[]).some(x=>['NOZELI_AGENT_DIR','PI_CODING_AGENT_DIR','CODEX_HOME'].some(key=>x.startsWith(key+'='+agents+path.sep))))processes.push(pid);}
  catch(error){unverified.push({pid,code:error.code??'PROCESS_UNVERIFIED'});}
 }}catch(error){unverified.push({code:error.code??'PROCESS_UNVERIFIED'});}
 const authCopies=[];for(const dir of await fs.readdir(agents).catch(e=>{if(e.code==='ENOENT')return [];throw e;})){const file=path.join(agents,dir,'auth.json');try{await fs.lstat(file);authCopies.push(dir);}catch(e){if(e.code!=='ENOENT')throw e;}}
 return {platform:process.platform,scope:'ownership-keys',processes,authCopies,complete:unverified.length===0,unverified};
}
