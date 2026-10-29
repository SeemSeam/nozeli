// Real Terminal.app + packaged helper + a synthetic PTY. No model or account.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const bundle=process.env.NOZELI_TEST_BUNDLE;if(process.platform!=='darwin'||!path.isAbsolute(bundle||''))throw Error('extracted macOS bundle required');
const app=path.join(bundle,'Contents/Resources/app'),req=createRequire(path.join(app,'package.json'));
const {SystemTerminalBridge}=await import(pathToFileURL(path.join(app,'src/agents/managed/system-terminal-bridge.mjs')));
const {processStamp}=await import(pathToFileURL(path.join(app,'src/agents/managed/process-ownership.mjs')));
const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'nozeli-terminal-')),cwd=path.join(root,"中文 空格 ' $(literal)");await fs.mkdir(cwd);
const marker='NOZELI_TERMINAL_'+Date.now(),pty=req('node-pty').spawn('/bin/cat',[],{cwd,env:{PATH:''},cols:80,rows:24}),stamp=await processStamp(pty.pid),input=[],states=[],tabs=[];
const bridge=new SystemTerminalBridge({root:path.join(cwd,'tickets'),helper:{command:path.join(bundle,'Contents/MacOS/Nozeli'),args:['--nozeli-terminal-client']}});
const terminal={threadId:'synthetic-original-thread',terminalId:'synthetic-original-pty',replay:marker+'\r\n',input:data=>{input.push(data);pty.write(data);},resize:(cols,rows)=>pty.resize(cols,rows)};
pty.onData(data=>bridge.output('test:terminal',data,1));
const pause=ms=>new Promise(r=>setTimeout(r,ms)),until=async(fn,label)=>{const end=Date.now()+15000;while(Date.now()<end){const r=await fn();if(r)return r;await pause(100);}throw Error('Timed out: '+label);};
function apple(lines,args=[]){return execFileSync('/usr/bin/osascript',['-e','on run argv',...lines.flatMap(line=>['-e',line]),'-e','end run',...args],{encoding:'utf8',timeout:15000}).trim();}
const findTab=()=>apple(['tell application id "com.apple.Terminal"','repeat with w in windows','repeat with i from 1 to count of tabs of w','set t to tab i of w','if (history of t) contains (item 1 of argv) then return tty of t','end repeat','end repeat','end tell','return ""'],[marker]);
const tabAction=(tty,action,args=[])=>apple(['tell application id "com.apple.Terminal"','repeat with w in windows','repeat with i from 1 to count of tabs of w','set t to tab i of w','if (tty of t) is (item 1 of argv) then',action,'end if','end repeat','end repeat','end tell'],[tty,...args]);
const checks=[];let error;
try{
 for(let round=0;round<2;round++){
  const result=await bridge.open({key:'test:terminal',terminal,cwd,onState:value=>states.push(value)});assert.equal(result.terminal,'Terminal.app');assert.equal(result.terminalId,terminal.terminalId);assert.equal(await processStamp(pty.pid),stamp);
  const tty=await until(findTab,'owned terminal tab');tabs.push(tty);const text='中文 附着 '+round;
  tabAction(tty,'do script (item 2 of argv) in t\nreturn "sent"',[text]);await until(()=>input.join('').includes(text),'real Terminal input');
  assert.equal((await fs.readdir(path.join(cwd,'tickets'))).length,0);await bridge.close('test:terminal');await until(()=>tabAction(tty,'return (busy of t) as string')==='false','helper exited');tabAction(tty,'if (count of tabs of w) is not 1 then error "Owned tab shares a window; retained"\nclose w\nreturn "closed"');
  assert.equal(await processStamp(pty.pid),stamp,'detach keeps original PTY alive');checks.push('round '+round+': real Terminal attaches, sends Chinese input, consumes private ticket and detaches without replacing PTY/thread');
 }
 assert.equal(states.at(-1),false);assert.equal(bridge.owns('test:terminal'),false);
}catch(failure){error=failure;}
finally{
 await bridge.stop();for(const tty of tabs)try{if(tabAction(tty,'return (busy of t) as string')==='false')tabAction(tty,'if (count of tabs of w) is not 1 then error "Owned tab shares a window; retained"\nclose w\nreturn "closed"');}catch{}
 if(await processStamp(pty.pid)===stamp)pty.kill();await until(async()=>await processStamp(pty.pid)!==stamp,'synthetic PTY stopped');
 const report={ok:!error,root,bundle,checks,error:error?.stack,scope:'actual Terminal.app and packaged helper; synthetic cat PTY; no model'};await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
if(error)process.exitCode=1;
