import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
let probe;

// 只读系统运行时域：解释器、动态链接器、合法系统配置与证书。除此之外默认不可见（不 ro-bind 整个 / ）。
const SYSTEM_RO=['/usr','/bin','/sbin','/lib','/lib64','/etc'];
// 整体目录禁止作为任何挂载根（含可写根）：打开其中任一个都等于放弃读域隔离。
const FORBIDDEN_ROOTS=new Set(['/','/home','/tmp','/root','/var','/opt','/srv','/run','/sys','/proc','/dev','/boot','/efi','/mnt','/media','/dev/shm',...SYSTEM_RO]);
const covers=(root,target)=>root===target||target.startsWith(root+path.sep);
const depth=target=>target.split(path.sep).filter(Boolean).length;
const absolute=(kind,value)=>{if(typeof value!=='string'||!path.isAbsolute(value))throw Error(`隔离${kind}必须是绝对路径：${String(value)}`);return path.resolve(value);};

function rejectDangerous(kind,target){
 if(FORBIDDEN_ROOTS.has(target)||target===os.homedir()||target===path.join(os.homedir(),'.Nozeli'))throw Error(`隔离${kind}（${target}）指向整体目录：拒绝以此放宽读域，请改用精确子路径`);
 if(kind!=='只读路径'&&SYSTEM_RO.some(system=>covers(system,target)))throw Error(`隔离${kind}（${target}）位于系统运行时目录：系统域由隔离统一只读提供`);
}

async function requireIdentity(kind,target){
 let real;try{real=await fs.realpath(target);}catch(error){throw Error(`隔离${kind}不可用（${target}：${error.code??error.message}）：未放宽隔离根，请向宿主申请精确挂载该路径`);}
 if(real!==target)throw Error(`隔离${kind}经过链接（${target}→${real}）：拒绝挂载以防别名绕过`);
 return real;
}

// 读域隔离（默认拒绝）：沙箱内只可见 系统运行时只读域、私有 /tmp、自有 /dev与/proc、home、cwd、
// 显式 readable 根、readOnly 路径与命令实际运行时目录（链接已解析）。缺少具体路径时报错给宿主申请精确挂载，
// 绝不回退成 ro-bind 整个 / 或 /home、/tmp、用户Nozeli根。深路径挂载覆盖浅路径（cwd/.git 只读指针可盖住可写 cwd）。
export async function isolatedLaunch({command,args=[],home,cwd,writable=[],readOnly=[],readable=[]}){
 if(process.platform!=='linux')throw Error('受管Agent进程读/写隔离尚未在此平台实现；基础阅读仍可使用。');
 const system=[];for(const target of SYSTEM_RO)if(await fs.stat(target).catch(()=>null))system.push(target);
 if(!system.includes('/usr'))throw Error('隔离系统运行时缺少 /usr：未放宽隔离根，请先修复系统运行时');
 // /etc/resolv.conf commonly points into /run on systemd desktops. Expose
 // only that system resolver file, never the containing runtime directory.
 const resolver=await fs.realpath('/etc/resolv.conf').catch(()=>null);
 const resolverArgs=resolver&&!system.some(root=>covers(root,resolver))&&(await fs.stat(resolver)).isFile()?['--ro-bind',resolver,resolver]:[];
 const trueBin=(await fs.stat('/usr/bin/true').then(()=>true,()=>false))?'/usr/bin/true':'/bin/true';
 await (probe??=exec('bwrap',[...system.flatMap(target=>['--ro-bind',target,target]),...resolverArgs,'--tmpfs','/tmp','--dev','/dev','--proc','/proc','--unshare-pid','--die-with-parent','--',trueBin],{timeout:10000}).catch(error=>{probe=null;throw Error('无法建立Agent隔离，请安装/启用bubblewrap；未以非隔离模式启动：'+error.message);}));
 // 命令按真实路径执行并暴露其运行时目录：系统二进制由系统域覆盖，bundle/home 内二进制由链接解析后的目录只读挂载。
 const realCommand=await requireIdentity('命令',absolute('命令',command));
 const commandDir=path.dirname(realCommand);
 if(commandDir===path.sep)throw Error(`隔离命令位于根目录（${realCommand}）：拒绝挂载根目录`);
 const bindRoots=[...new Set([absolute('home',home),...(Array.isArray(writable)?writable:[]).map(entry=>absolute('可写根',entry))])];
 for(const root of bindRoots){rejectDangerous('可写根',root);await fs.mkdir(root,{recursive:true,mode:0o700});if(await fs.realpath(root)!==root)throw Error('隔离可写目录不能经过链接：'+root);}
 const roPaths=[];
 for(const entry of (Array.isArray(readOnly)?readOnly:[])){const target=absolute('只读路径',entry);rejectDangerous('只读路径',target);await requireIdentity('只读路径',target);const stat=await fs.lstat(target);if(!stat.isFile()&&!stat.isDirectory())throw Error('隔离只读路径身份不安全：'+target);roPaths.push(target);}
 const bindSet=new Set(bindRoots);
 for(const target of roPaths)if(bindSet.has(target))throw Error(`隔离路径同时要求可写与只读：${target}`);
 const roSet=new Set(roPaths);
 for(const entry of (Array.isArray(readable)?readable:[])){const target=absolute('可读根',entry);rejectDangerous('可读根',target);await requireIdentity('可读根',target);if(!(await fs.stat(target)).isDirectory())throw Error('隔离可读根必须是目录：'+target);if(!bindSet.has(target))roSet.add(target);}
 const roRoots=[...roSet].filter(target=>![...roSet].some(other=>other!==target&&covers(other,target)));
 const workDir=absolute('工作目录',cwd);rejectDangerous('工作目录',workDir);await requireIdentity('工作目录',workDir);
 const covered=target=>system.some(entry=>covers(entry,target))||bindRoots.some(entry=>covers(entry,target))||roRoots.some(entry=>covers(entry,target));
 const mounts=[...bindRoots.map(src=>({src,flag:'--bind'})),...roRoots.map(src=>({src,flag:'--ro-bind'}))];
 if(!covered(workDir))mounts.push({src:workDir,flag:'--ro-bind'});
 if(!covered(commandDir)){rejectDangerous('命令运行时目录',commandDir);mounts.push({src:commandDir,flag:'--ro-bind'});}
 mounts.sort((a,b)=>depth(a.src)-depth(b.src));
 const homeRoot=bindRoots[0];
 const tmp=path.join(homeRoot,'tmp');await fs.mkdir(tmp,{recursive:true,mode:0o700});
 const xdg={XDG_CONFIG_HOME:path.join(homeRoot,'.config'),XDG_CACHE_HOME:path.join(homeRoot,'.cache'),XDG_DATA_HOME:path.join(homeRoot,'.local','share')};
 await Promise.all(Object.values(xdg).map(dir=>fs.mkdir(dir,{recursive:true,mode:0o700})));
 // 用户 HOME/XDG 不再暴露：env 重定向到自有 home，凭据只经 auth-broker URL/token env 注入，不复制用户密钥。
 return {command:'bwrap',args:['--unshare-pid','--unshare-ipc','--unshare-uts','--die-with-parent','--tmpfs','/tmp','--dev','/dev','--proc','/proc',...system.flatMap(target=>['--ro-bind',target,target]),...resolverArgs,...mounts.flatMap(mount=>[mount.flag,mount.src,mount.src]),'--chdir',workDir,'--',realCommand,...args],env:{HOME:homeRoot,TMPDIR:tmp,TMP:tmp,TEMP:tmp,...xdg}};
}

// bwrap 可用性探测（缓存）：仅回答“能否建立隔离”，不抛错。
let availability;
export async function isolationAvailable(){
 if(process.platform!=='linux')return false;
 if(availability!==undefined)return availability;
 try{
  const system=[];for(const target of SYSTEM_RO)if(await fs.stat(target).catch(()=>null))system.push(target);
  if(!system.includes('/usr'))throw Error('missing /usr');
  const resolver=await fs.realpath('/etc/resolv.conf').catch(()=>null);
  const resolverArgs=resolver&&!system.some(root=>covers(root,resolver))&&(await fs.stat(resolver)).isFile()?['--ro-bind',resolver,resolver]:[];
  const trueBin=(await fs.stat('/usr/bin/true').then(()=>true,()=>false))?'/usr/bin/true':'/bin/true';
  await exec('bwrap',[...system.flatMap(target=>['--ro-bind',target,target]),...resolverArgs,'--tmpfs','/tmp','--dev','/dev','--proc','/proc','--unshare-pid','--die-with-parent','--',trueBin],{timeout:10000});
  availability=true;
 }catch{availability=false;}
 return availability;
}

// Ordinary execution trusts the current user; sandboxing requires an explicit opt-in probe.
export async function optionalIsolatedLaunch(spec,{probe=async()=>false}={}){
 if(await probe())return {launch:await isolatedLaunch(spec),isolated:true};
 return {launch:{command:spec.command,args:spec.args,env:{}},isolated:false};
}
