import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {spawn} from 'node:child_process';
const require=createRequire(import.meta.url);
export async function run(){
 const {openTestController}=await import('./project-storage.fixture.mjs'),{attachNativeTerminal}=await import('../src/agents/managed/native-terminal.mjs'),{auditRuntime}=await import('../src/agents/managed/runtime-audit.mjs'),{Terminal}=require('@xterm/xterm');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-native-compat-')),checks=[],methods=[],x=new Terminal({cols:120,rows:32,allowProposedApi:true});await fs.mkdir(root+'/project');await fs.writeFile(root+'/project/README.md','# Native Codex terminal check\n');
 const c=await openTestController({runtimeRoot:root+'/runtime',contentRoot:root+'/project',sourceHome:process.env.NOZELI_CODEX_SOURCE_HOME||path.join(os.homedir(),'.codex')});let output='',t,failure;
 const pause=ms=>new Promise(r=>setTimeout(r,ms)),wait=async(fn,timeout=15000)=>{const end=Date.now()+timeout;while(!await fn()){if(Date.now()>end)throw Error('condition timeout');await pause(50);}},check=(name,ok)=>{assert(ok,name);checks.push(name);console.log(JSON.stringify({check:name}));};
 x.onData(d=>c.terminals.get('frontdesk')?.input(d));
 const attach=()=>attachNativeTerminal(c,'frontdesk',{onMethod:m=>methods.push(m),onData:d=>{output+=d;x.write(d);}});
 const submit=async command=>{const count=c.store.state.jobs.length;t.input('!'+command);await pause(150);t.input('\r');await wait(()=>c.store.state.jobs.length>count);return c.store.state.jobs.at(-1);};
 try{
  await c.start();t=await attach();await pause(1000);const thread=t.threadId;
  check('fresh Codex starts with real ANSI colors despite parent NO_COLOR and dumb TERM',!t.closed&&/\x1b\[(?:[0-9;]*;)?(?:3[0-7]|9[0-7]|38;[25];[0-9;]+)m/.test(output));
  const job=await submit("printf 'NOZELI_SHELL_OK\\n'");await wait(()=>job.status==='completed');check('native ! command executes on original thread without exiting TUI',!t.closed&&job.threadId===thread&&job.exitCode===0&&output.includes('NOZELI_SHELL_OK'));
  const failed=await submit("sh -c 'exit 7'");await wait(()=>failed.status!=='running');check('nonzero shell exit is reported without killing terminal',failed.exitCode===7&&!t.closed);
  const long=await submit("sleep 5; printf 'NOZELI_SHELL_FINISHED\\n'");await wait(()=>c.sessions.get('frontdesk').busy&&!c.nativeDraftTargets.has('frontdesk'));
  const queued=await c.send('frontdesk','只回复 TERMINAL_QUEUE_OK，不使用工具。');await pause(250);check('model input remains queued while native command owns the target',c.store.state.jobs.find(j=>j.id===queued.jobId).status==='queued');
  t.input('\x1b');await wait(()=>long.status!=='running');check('native interrupt releases command scheduling slot',methods.includes('turn/interrupt')&&!t.closed);
  await wait(()=>c.store.state.jobs.find(j=>j.id===queued.jobId).status==='completed',150000);check('queued real model reply completes on original thread after command',c.store.state.messages.some(m=>m.speaker==='agent'&&m.text?.includes('TERMINAL_QUEUE_OK'))&&c.sessions.get('frontdesk').threadId===thread&&!t.closed);
  const previous=t.terminalId;await t.close();x.reset();t=await attach();await pause(500);check('reconnect resumes shell history and original thread',!t.closed&&t.threadId===thread&&t.terminalId!==previous);
  await submit('sleep 30');await wait(()=>c.sessions.get('frontdesk').busy);await c.stop();check('host stop interrupts active shell and clears running slot',!c.running.size&&c.store.state.jobs.at(-1).status==='interrupted');
 }catch(e){failure=e;console.error(e.stack);}finally{await c.stop();x.dispose();const audit=await auditRuntime(root+'/runtime');if(audit.processes.length||audit.authCopies.length)failure??=Error('cleanup failed');await fs.writeFile(root+'/terminal-ansi.log',output);const result={status:failure?'FAIL':'PASS',root,checks,methods,audit,error:failure?.message};await fs.writeFile(root+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(failure)throw failure;}
}
if(!process.versions.electron){const child=spawn(require('electron'),['--ozone-platform=headless',path.join(import.meta.dirname,'native-terminal-compat-entry.cjs')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'',NO_COLOR:'1',TERM:'dumb'},stdio:'inherit'});process.exitCode=await new Promise(resolve=>child.once('exit',code=>resolve(code??1)));}
