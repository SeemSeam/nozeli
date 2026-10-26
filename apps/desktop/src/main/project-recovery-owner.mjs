import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {processStamp} from '../agents/managed/process-ownership.mjs';
const fail=(code,message)=>Object.assign(Error(message),{code});
const commandLine=async pid=>{const args=(await fs.readFile(`/proc/${pid}/cmdline`)).toString().split('\0');if(args.at(-1)==='')args.pop();return args;};
const userManager=args=>args.length===2&&['/usr/lib/systemd/systemd','/lib/systemd/systemd'].includes(args[0])&&args[1]==='--user';
async function fixedDesktopService(pid,args,uid){
 if(userManager(args))return true;
 if(args.length===2&&args[0]==='/usr/bin/ssh-agent'&&args[1]==='-D')return true;
 if(args.length===1&&['/usr/lib/x86_64-linux-gnu/libexec/polkit-kde-authentication-agent-1','/usr/lib/x86_64-linux-gnu/libexec/org_kde_powerdevil'].includes(args[0]))return true;
 if(args.length===14&&args[0]==='/usr/bin/kwin_wayland'&&args[1]==='--wayland-fd'&&args[3]==='--socket'&&args[5]==='--xwayland-fd'&&args[7]==='--xwayland-fd'&&args[9]==='--xwayland-display'&&args[11]==='--xwayland-xauthority'&&args[13]==='--xwayland'&&[args[2],args[6],args[8]].every(value=>/^\d+$/.test(value))&&/^wayland-\d+$/.test(args[4])&&/^:\d+$/.test(args[10])&&path.dirname(args[12])===`/run/user/${uid}`&&/^xauth_[A-Za-z0-9]+$/.test(path.basename(args[12])))return true;
 if(args.length===1&&args[0]==='(sd-pam)'){
  const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8'),parent=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]);
  if(!Number.isInteger(parent)||parent<=0||parent===pid)return false;
  const parentStamp=await processStamp(parent);if(!parentStamp||(await fs.stat(`/proc/${parent}`)).uid!==uid)return false;
  return userManager(await commandLine(parent))&&await processStamp(parent)===parentStamp;
 }
 return false;
}

// Only explicit recovery uses this conservative same-user Linux probe. It is
// not a cross-user lease and never authorizes a recovery after an unknown scan.
export async function assertRecoverySourceStopped(root){
 if(process.platform!=='linux')throw fail('RECOVERY_OWNER_UNVERIFIED','此平台尚不能核验其他实例；特殊项目恢复不可用，原状态已保留。');
 const ownExe=await fs.readlink('/proc/self/exe');
 for(const entry of await fs.readdir('/proc')){
  if(!/^\d+$/.test(entry)||Number(entry)===process.pid)continue;
  const pid=Number(entry);let stamp;
  try{
   const stat=await fs.stat('/proc/'+entry);if(stat.uid!==process.getuid())continue;
   stamp=await processStamp(pid);if(!stamp)continue;
   const args=await commandLine(pid);
   // Only complete fixed desktop-service argv shapes qualify. PAM additionally
   // requires the stable same-uid systemd --user parent, never its name alone.
   if(await fixedDesktopService(pid,args,stat.uid)){
    if(await processStamp(pid)!==stamp)throw fail('RECOVERY_OWNER_UNVERIFIED','核验期间进程身份发生变化，请稍后重试；未恢复项目。');
    continue;
   }
   const exe=await fs.readlink(`/proc/${pid}/exe`);
   // Exact executable identity, not a substring in a user-supplied process name.
   if(!(exe===ownExe&&['electron','nozeli'].includes(path.basename(ownExe)))&&!['nozeli','electron'].includes(path.basename(exe)))continue;
   // Chromium can rewrite argv into a single process-title string. Only an
   // exact leading executable + first --type flag identifies a child here.
   const childTypes=new Set(['zygote','renderer','gpu-process','utility','broker']);
   const first=args.length===1&&args[0].startsWith(exe+' ')?args[0].slice(exe.length+1).split(' ',1)[0]:null;
   if(args.some(arg=>arg.startsWith('--type=')&&childTypes.has(arg.slice(7)))||first?.startsWith('--type=')&&childTypes.has(first.slice(7)))continue;
   // Electron rewrites its initial environ as well. Never guess the default
   // profile from missing keys: the open catalog inode is ownership evidence.
   let catalogs=0;
   for(const fd of await fs.readdir(`/proc/${pid}/fd`)){
    const file=`/proc/${pid}/fd/${fd}`;let target;
    try{target=await fs.readlink(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    const catalog=target.endsWith(' (deleted)')?target.slice(0,-10):target;
    if(!path.isAbsolute(catalog)||!catalog.endsWith('/nozeli/storage-v2/catalog.sqlite'))continue;
    catalogs++;const before=await fs.stat(file);let db;
    try{
     db=new DatabaseSync(file,{readOnly:true});
     for(const row of db.prepare("SELECT value FROM records WHERE collection='instances'").all()){
      const project=JSON.parse(row.value);
      if(project.root===root)throw fail('RECOVERY_SOURCE_ACTIVE','另一个 Nozeli 实例仍登记此目录；请正常退出该实例后再恢复。');
     }
    }finally{db?.close();}
    const after=await fs.stat(file);if(before.dev!==after.dev||before.ino!==after.ino)throw fail('RECOVERY_OWNER_UNVERIFIED','核验期间登记数据库句柄已变化；未恢复项目。');
   }
   if(!catalogs)throw fail('RECOVERY_OWNER_UNVERIFIED','Electron 主进程的实际登记数据库无法核验；未推测默认配置目录。');
   if(await processStamp(pid)!==stamp)throw fail('RECOVERY_OWNER_UNVERIFIED','核验期间实例身份发生变化，请稍后重试；未恢复项目。');
  }catch(error){
   if(error.code==='RECOVERY_SOURCE_ACTIVE'||error.code==='RECOVERY_OWNER_UNVERIFIED')throw error;
   if(['ENOENT','ESRCH'].includes(error.code)&&!(await processStamp(pid)))continue;
   throw fail('RECOVERY_OWNER_UNVERIFIED','无法完整核验另一个 Electron/Nozeli 进程（可能是无关程序）是否使用此目录；未恢复项目。');
  }
 }
}
