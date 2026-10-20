import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
let probe;
export async function isolatedLaunch({command,args=[],home,cwd,writable=[],readOnly=[]}){
 if(process.platform!=='linux')throw Error('受管Agent写入隔离尚未在此平台实现；基础阅读仍可使用。');
 await (probe??=exec('bwrap',['--ro-bind','/','/','--unshare-pid','--die-with-parent','--','/usr/bin/true'],{timeout:10000}).catch(error=>{probe=null;throw Error('无法建立Agent隔离，请安装/启用bubblewrap；未以非隔离模式启动：'+error.message);}));
 const roots=[...new Set([home,...writable].map(p=>path.resolve(p)))];
 for(const root of roots){await fs.mkdir(root,{recursive:true,mode:0o700});if(await fs.realpath(root)!==root)throw Error('隔离可写目录不能经过链接');}
 const protectedPaths=[...new Set(readOnly.map(p=>path.resolve(p)))];
 for(const file of protectedPaths){const stat=await fs.lstat(file);if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory()||await fs.realpath(file)!==file)throw Error('隔离只读路径身份不安全');}
 const tmp=path.join(home,'tmp');await fs.mkdir(tmp,{recursive:true,mode:0o700});
 return {command:'bwrap',args:['--ro-bind','/','/','--dev','/dev','--proc','/proc','--unshare-pid','--unshare-ipc','--unshare-uts','--die-with-parent',...roots.flatMap(root=>['--bind',root,root]),...protectedPaths.flatMap(file=>['--ro-bind',file,file]),'--chdir',cwd,'--',command,...args],env:{TMPDIR:tmp,TMP:tmp,TEMP:tmp}};
}
