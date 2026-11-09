// Darwin native recovery-source ownership verification (narrower algorithm
// under the recovery-source-ownership capability: conservative same-user
// probe, mirroring platform/linux/recovery-owner.mjs). Platform facts owned
// here: KERN_PROC_ALL same-user snapshot with argv/env/executable identity,
// open vnode-descriptor catalog evidence (path + device + inode from the
// kernel) and per-step incarnation re-stamping. There is no second proof
// path — the managed wrapper either delegates here or refuses explicitly.
//
// Differences forced by the platform, none of them weaker than Linux:
//   - The executable identity is the exact resolved path from proc_pidpath;
//     bundle executables are case-folded only for the basename comparison
//     (Nozeli.app/Contents/MacOS/Nozeli vs packaged Electron helpers).
//   - Catalog handles cannot be opened through another process's descriptor
//     (no /proc/<pid>/fd open path), so the exact inode the instance holds
//     (vst_dev + vst_ino from PROC_PIDFDVNODEINFO) is compared against the
//     opened file before AND after reading the database: a swapped catalog
//     path never satisfies the proof.
//   - Every unprovable fact fails closed with RECOVERY_OWNER_UNVERIFIED —
//     never a default-profile guess, never a skip.
import path from 'node:path';
import fs from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {bootId,processStamp,processExePath,processFds,sameUserSnapshot} from './process-ownership.mjs';

const fail=(code,message)=>Object.assign(Error(message),{code});
const CATALOG_SUFFIX='/nozeli/storage-v2/catalog.sqlite';
const childTypes=new Set(['zygote','renderer','gpu-process','utility','broker']);

// Exact executable identity, not a substring in a user-supplied process name.
// The packaged macOS bundle executable is capitalized (…/Nozeli.app/Contents/
// MacOS/Nozeli; dev runs …/Electron.app/Contents/MacOS/Electron), so the
// basename comparison is case-folded; the own-executable match stays exact.
const exeLooksLikeApp=(exe,ownExe)=>Boolean(exe)&&(path.basename(exe).toLowerCase()==='nozeli'||path.basename(exe).toLowerCase()==='electron')
  ||(exe===ownExe&&['nozeli','electron'].includes(path.basename(ownExe).toLowerCase()));

// Only explicit recovery uses this conservative same-user probe. It is not a
// cross-user lease and never authorizes a recovery after an unknown scan.
export async function assertRecoverySourceStopped(root){
  const boot=await bootId();
  const ownExe=await processExePath(process.pid);
  for(const row of await sameUserSnapshot()){
    const pid=row.pid;
    if(pid===process.pid)continue;
    const stamp=`${boot}:${row.startSec}${String(row.startUsec).padStart(6,'0')}`;
    try{
      if(row.pathDenied||typeof row.path!=='string'||!row.path)
        throw fail('RECOVERY_OWNER_UNVERIFIED','无法完整核验另一个 Electron/Nozeli 进程（可能是无关程序）是否使用此目录；未恢复项目。');
      if(!exeLooksLikeApp(row.path,ownExe))continue;
      const args=Array.isArray(row.argv)?row.argv:[];
      // Electron rewrites argv into a single process-title string on some
      // paths. Only an exact leading executable + first --type flag
      // identifies a child here.
      const first=args.length===1&&args[0].startsWith(row.path+' ')?args[0].slice(row.path.length+1).split(' ',1)[0]:null;
      if(args.some(arg=>arg.startsWith('--type=')&&childTypes.has(arg.slice(7)))||first?.startsWith('--type=')&&childTypes.has(first.slice(7)))continue;
      // Catalog evidence: the instance must actually hold this project's
      // registration database open — the open descriptor inode is the proof.
      let catalogs=0;
      for(const fd of await processFds(pid)){
        const catalog=fd.path;
        if(!path.isAbsolute(catalog)||!catalog.endsWith(CATALOG_SUFFIX))continue;
        catalogs++;
        // Bind to the exact inode the other process holds, before and after
        // the read: a path swap during the probe invalidates the evidence.
        const before=await fs.stat(catalog);
        if(before.dev!==fd.dev||before.ino!==fd.ino)
          throw fail('RECOVERY_OWNER_UNVERIFIED','核验期间登记数据库句柄已变化；未恢复项目。');
        let db;
        try{
          db=new DatabaseSync(catalog,{readOnly:true});
          for(const openRecord of db.prepare("SELECT value FROM records WHERE collection='instances'").all()){
            const project=JSON.parse(openRecord.value);
            if(project.root===root)throw fail('RECOVERY_SOURCE_ACTIVE','另一个 Nozeli 实例仍登记此目录；请正常退出该实例后再恢复。');
          }
        }finally{db?.close();}
        const after=await fs.stat(catalog);
        if(after.dev!==fd.dev||after.ino!==fd.ino)
          throw fail('RECOVERY_OWNER_UNVERIFIED','核验期间登记数据库句柄已变化；未恢复项目。');
      }
      if(!catalogs)throw fail('RECOVERY_OWNER_UNVERIFIED','Electron 主进程的实际登记数据库无法核验；未推测默认配置目录。');
      if(await processStamp(pid)!==stamp)throw fail('RECOVERY_OWNER_UNVERIFIED','核验期间实例身份发生变化，请稍后重试；未恢复项目。');
    }catch(error){
      if(error.code==='RECOVERY_SOURCE_ACTIVE'||error.code==='RECOVERY_OWNER_UNVERIFIED')throw error;
      if(await processStamp(pid)===null)continue; // the candidate exited during the check
      throw fail('RECOVERY_OWNER_UNVERIFIED','无法完整核验另一个 Electron/Nozeli 进程（可能是无关程序）是否使用此目录；未恢复项目。');
    }
  }
}
