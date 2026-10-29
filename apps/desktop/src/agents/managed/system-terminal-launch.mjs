import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
export async function defaultTerminal({platform=process.platform,env=process.env}={}) {
 if(platform==='darwin')return {command:'/usr/bin/osascript',name:'Terminal.app'};
 if(platform!=='linux')throw Error('系统终端附着目前仅在 Linux 开放；macOS/Windows 适配尚未验收。');
 for(const name of ['xdg-terminal-exec','x-terminal-emulator','konsole','gnome-terminal','wezterm','kitty','alacritty','foot'])for(const dir of (env.PATH||'').split(path.delimiter)){
  if(!dir)continue;const file=path.join(dir,name);try{await fs.access(file,fs.constants.X_OK);return {command:file,name,resolved:path.basename(await fs.realpath(file))};}catch{}
 }
 throw Error('未找到系统终端，请安装或配置桌面终端后重试。');
}
export const shellQuote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
export function terminalArguments(terminal,command,args,cwd) {
 if(terminal.name==='Terminal.app'){
  const line='cd -- '+shellQuote(cwd)+' && /usr/bin/env -u ELECTRON_RUN_AS_NODE '+[command,...args].map(shellQuote).join(' ')+'; exit';
  return ['-e','on run argv','-e','tell application id "com.apple.Terminal"','-e','do script (item 1 of argv)','-e','activate','-e','end tell','-e','end run',line];
 }
 if(terminal.name==='xdg-terminal-exec')return [command,...args];
 if(terminal.resolved==='konsole'||terminal.name==='konsole')return ['--separate','--workdir',cwd,'-e',command,...args];
 if(terminal.name==='gnome-terminal')return ['--working-directory',cwd,'--',command,...args];
 if(terminal.name==='wezterm')return ['start','--cwd',cwd,'--',command,...args];
 return ['-e',command,...args];
}
export async function launchDefaultTerminal({command,args,cwd}) {
 const terminal=await defaultTerminal();
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 const child=spawn(terminal.command,terminalArguments(terminal,command,args,cwd),{cwd,env,detached:true,stdio:terminal.name==='Terminal.app'?['ignore','ignore','pipe']:'ignore',shell:false});
 if(terminal.name==='Terminal.app'){let stderr='';child.stderr.on('data',b=>stderr+=b);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('Terminal.app 启动超时或授权被取消'));},15000);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Terminal.app 未能打开：'+stderr.trim()));});});}
 else await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
 return {terminal:terminal.name,pid:child.pid};
}
