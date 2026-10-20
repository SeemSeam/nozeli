import fs from 'node:fs/promises';
import path from 'node:path';
export async function auditRuntime(root){
 const agents=path.join(root,'agents');const processes=[];
 if(process.platform==='linux')for(const pid of await fs.readdir('/proc')){if(!/^\d+$/.test(pid))continue;try{const env=(await fs.readFile(`/proc/${pid}/environ`)).toString().split('\0');if(env.some(x=>x.startsWith(`NOZELI_AGENT_DIR=${agents}${path.sep}`)||x.startsWith(`PI_CODING_AGENT_DIR=${agents}${path.sep}`)||x.startsWith(`CODEX_HOME=${agents}${path.sep}`)))processes.push(Number(pid));}catch(e){if(!['ENOENT','ESRCH','EACCES'].includes(e.code))throw e;}}
 const authCopies=[];for(const dir of await fs.readdir(agents)){const file=path.join(agents,dir,'auth.json');try{await fs.lstat(file);authCopies.push(dir);}catch(e){if(e.code!=='ENOENT')throw e;}}
 return {platform:process.platform,processes,authCopies};
}
