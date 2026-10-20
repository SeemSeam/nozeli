import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
export async function defaultTerminal({platform=process.platform,env=process.env}={}) {
 if(platform!=='linux')throw Error('系统终端附着目前仅在 Linux 开放；macOS/Windows 适配尚未验收。');
 for(const name of ['xdg-terminal-exec','x-terminal-emulator','konsole','gnome-terminal','wezterm','kitty','alacritty','foot'])for(const dir of (env.PATH||'').split(path.delimiter)){
  if(!dir)continue;const file=path.join(dir,name);try{await fs.access(file,fs.constants.X_OK);return {command:file,name,resolved:path.basename(await fs.realpath(file))};}catch{}
 }
 throw Error('未找到系统终端，请安装或配置桌面终端后重试。');
}
export function terminalArguments(terminal,command,args,cwd) {
 if(terminal.name==='xdg-terminal-exec')return [command,...args];
 if(terminal.resolved==='konsole'||terminal.name==='konsole')return ['--separate','--workdir',cwd,'-e',command,...args];
 if(terminal.name==='gnome-terminal')return ['--working-directory',cwd,'--',command,...args];
 if(terminal.name==='wezterm')return ['start','--cwd',cwd,'--',command,...args];
 return ['-e',command,...args];
}
export async function launchDefaultTerminal({command,args,cwd}) {
 const terminal=await defaultTerminal();
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(terminal.command,terminalArguments(terminal,command,args,cwd),{cwd,env,detached:true,stdio:'ignore',shell:false});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
 return {terminal:terminal.name,pid:child.pid};
}
