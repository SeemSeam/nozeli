import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createRequire} from 'node:module';
import {SystemTerminalBridge} from '../src/agents/managed/system-terminal-bridge.mjs';import {terminalArguments,defaultTerminal} from '../src/agents/managed/system-terminal-launch.mjs';
import {createWindowsTerminalTicket,readWindowsTerminalTicket} from '../src/platform/windows/system-terminal-ticket.mjs';
import {createExperimentalProcessJob,waitExperimentalJobEmpty} from '../src/platform/windows/experimental-process-job.mjs';
const windows=process.platform==='win32';
const ticketPayload=async argument=>windows?readWindowsTerminalTicket(argument):JSON.parse(await fs.readFile(argument));
const ticketFile=argument=>{if(!windows)return argument;const {root,relative}=JSON.parse(argument);return path.join(root,relative);};
const {WebSocket}=createRequire(import.meta.url)('ws');
const tick=()=>new Promise(r=>setTimeout(r,20));
test('authenticated bridge preserves identity, exclusive lease, IO and terminal across detach/reopen',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-sys-bridge-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let socket,ticket;const sent=[],sizes=[],states=[];let launches=0;
 const terminal={threadId:'original-thread',terminalId:'original-pty',replay:'原始终端',input:s=>sent.push(s),resize:(...s)=>sizes.push(s)};
 let credentials;
 const launch=async spec=>{launches++;const argument=spec.args.at(-1);ticket=ticketFile(argument);if(!windows)assert.equal((await fs.stat(ticket)).mode&0o777,0o600);credentials=await ticketPayload(argument);const {url,token}=credentials;socket=new WebSocket(url,{headers:{Authorization:'Bearer '+token}});socket.once('open',()=>socket.send(JSON.stringify({type:'hello'})));return {terminal:'fixture'};};
 const bridge=new SystemTerminalBridge({root:path.join(root,'tickets'),profileRoot:root,launch,helper:{command:'helper',args:[]}});t.after(()=>bridge.stop());
 const open=()=>bridge.open({key:'project:worker',terminal,cwd:root,onState:s=>states.push(s)});
 const r=await open();assert.equal(r.threadId,'original-thread');assert(bridge.owns('project:worker'));assert.equal((await open()).reused,true);assert.equal(launches,1);
 await new Promise((resolve,reject)=>{const replay=new WebSocket(credentials.url,{headers:{Authorization:'Bearer '+credentials.token}});replay.once('unexpected-response',(_,response)=>{const status=response.statusCode;response.resume();resolve(status);});replay.once('error',reject);replay.once('open',()=>{replay.terminate();reject(Error('bearer was accepted twice'));});}).then(status=>assert.equal(status,401));
 socket.send(JSON.stringify({type:'input',data:'中文补充'}));socket.send(JSON.stringify({type:'resize',cols:90,rows:28}));await tick();assert.deepEqual(sent,['中文补充']);assert.deepEqual(sizes,[[90,28]]);
 const next=new Promise(r=>socket.once('message',r));bridge.output('project:worker','new output',1);assert.equal(JSON.parse((await next).toString()).data,'new output');
 socket.close();for(let i=0;i<50&&bridge.owns('project:worker');i++)await tick();assert(!bridge.owns('project:worker'));assert.equal(terminal.threadId,'original-thread');await assert.rejects(fs.access(ticket));
 await open();assert.equal(launches,2);await bridge.close('project:worker');assert.equal(states.at(-1),false);
});
test('unknown token rejected and timed out launcher releases ownership/ticket',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-sys-timeout-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let rejected=false;
 const tickets=path.join(root,'tickets');
 const bridge=new SystemTerminalBridge({root:tickets,profileRoot:root,timeoutMs:300,helper:{command:'helper',args:[]},launch:async spec=>{const {url}=await ticketPayload(spec.args.at(-1));const bad=new WebSocket(url);bad.on('error',()=>{rejected=true;});return {};}});t.after(()=>bridge.stop());
 await assert.rejects(bridge.open({key:'x',terminal:{threadId:'t'},cwd:root}),/未完成附着/);assert(rejected);assert(!bridge.owns('x'));assert.deepEqual(await fs.readdir(tickets),[]);
});
test('terminal adapter keeps helper arguments literal and other platforms explicit',async()=>{
 assert.deepEqual(terminalArguments({name:'x-terminal-emulator',resolved:'konsole'},'/path with spaces/nozeli',['--ticket','/a/$(literal).json'],'/project'),['--separate','--workdir','/project','-e','/path with spaces/nozeli','--ticket','/a/$(literal).json']);await assert.rejects(defaultTerminal({platform:'darwin'}),/尚未验收/);
});
test('launcher and ticket failures release resources; host stop rejects new attachments',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-sys-failure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const states=[];
 const tickets=path.join(root,'tickets');
 const bridge=new SystemTerminalBridge({root:tickets,profileRoot:root,helper:{command:'helper',args:[]},launch:async()=>{throw Error('launcher unavailable');}});t.after(()=>bridge.stop());
 await assert.rejects(bridge.open({key:'failed',terminal:{threadId:'t'},cwd:root,onState:s=>states.push(s)}),/launcher unavailable/);assert.deepEqual(states,[true,false]);assert(!bridge.owns('failed'));assert.deepEqual(await fs.readdir(tickets),[]);
 const file=path.join(root,'file');await fs.writeFile(file,'not a directory');const blocked=new SystemTerminalBridge({root:file,profileRoot:root,helper:{command:'helper',args:[]}});await assert.rejects(blocked.open({key:'x',terminal:{threadId:'t'},cwd:root}));await blocked.stop();assert(!blocked.owns('x'));
 await bridge.stop();await assert.rejects(bridge.open({key:'new',terminal:{threadId:'t'},cwd:root}),/正在关闭/);
});

test('a state notification failure before launch releases the ticket and ownership',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-sys-observer-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const tickets=path.join(root,'tickets');
 const bridge=new SystemTerminalBridge({root:tickets,profileRoot:root,helper:{args:[]},launch:()=>assert.fail('launch after notification failure')});
 t.after(()=>bridge.stop());
 await assert.rejects(bridge.open({key:'observer',terminal:{threadId:'t'},cwd:root,onState:active=>{if(active)throw Error('observer failed');}}),/observer failed/);
 assert(!bridge.owns('observer'));
 assert.deepEqual(await fs.readdir(tickets),[]);
});

test('a state notification failure at readiness rejects attachment before announcing ready',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-sys-ready-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let notifications=0,ready=false,released=false;
 const bridge=new SystemTerminalBridge({root:path.join(root,'tickets'),profileRoot:root,helper:{args:[]},launch:async spec=>{
  const {url,token}=await ticketPayload(spec.args.at(-1));
  const socket=new WebSocket(url,{headers:{Authorization:'Bearer '+token}});
  const closed=new Promise(resolve=>socket.once('close',resolve));
  socket.on('error',()=>{});socket.on('message',data=>{if(JSON.parse(data).type==='ready')ready=true;});
  socket.once('open',()=>socket.send(JSON.stringify({type:'hello'})));
  spec.retainRelease(async()=>{await closed;released=true;});
  return {terminal:'fixture'};
 }});t.after(()=>bridge.stop());
 await assert.rejects(bridge.open({key:'ready',terminal:{threadId:'t'},cwd:root,onState:active=>{if(active&&++notifications===2)throw Error('ready observer failed');}}),/ready observer failed/);
 assert.equal(ready,false);assert.equal(released,true);assert(!bridge.owns('ready'));
});

test('Windows managed terminal attach refuses before resolving a project or opening a bridge',{skip:process.platform!=='win32'},async()=>{
 const {ManagedProjects}=await import('../src/agents/managed-projects.mjs');
 const manager={
  host:{requireProject(){assert.fail('unsupported attach accessed the project');}},
  systemTerminals:{open(){assert.fail('unsupported attach opened a bridge');}},
 };
 await assert.rejects(ManagedProjects.prototype.invoke.call(manager,'managed.terminal.system',{projectId:'synthetic-project',target:'frontdesk'}),{
  code:'NOZELI_CAPABILITY_UNAVAILABLE',capability:'system-terminal-attach',platform:'win32',
 });
});

test('Windows ticket refuses a same-byte different File ID and removes only its own file',{skip:!windows},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-ticket-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const directory=path.join(root,'tickets'),payload={url:'ws://127.0.0.1:12345',token:'a'.repeat(64)};
 const first=await createWindowsTerminalTicket(root,directory,payload);
 try{
  const second=await createWindowsTerminalTicket(root,directory,payload);
  try{
   const original=JSON.parse(first.argument),other=JSON.parse(second.argument);
   assert.throws(()=>readWindowsTerminalTicket(JSON.stringify({...original,relative:other.relative})),{code:'TERMINAL_TICKET_INVALID'});
   assert.throws(()=>readWindowsTerminalTicket(JSON.stringify({...original,parentIdentity:'0'.repeat(16)+':'+ '0'.repeat(32)})),{code:'TERMINAL_TICKET_INVALID'});
   assert(!first.argument.includes(payload.token));
   await assert.rejects(fs.rename(ticketFile(first.argument),path.join(directory,'replacement')));
   first.close();
   await assert.rejects(fs.access(ticketFile(first.argument)),{code:'ENOENT'});
   assert.deepEqual(readWindowsTerminalTicket(second.argument),payload);
  }finally{second.close();}
 }finally{first.close();}
});

test('Windows private ticket attaches the real console client and is consumed before readiness',{skip:!windows,timeout:20000},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli 终端 & ')),tickets=path.join(root,'tickets');
 const client=new URL('../src/agents/system-terminal-client.mjs',import.meta.url).href;
 const code=`import(${JSON.stringify(client)}).then(m=>m.run()).catch(e=>{console.error(e);process.exitCode=1;})`;
 let lease,resolveSize;
 const size=new Promise(resolve=>{resolveSize=resolve;});
 const terminal={threadId:'original-thread',terminalId:'original-terminal',replay:'合成终端',resize:(...value)=>resolveSize(value)};
 const bridge=new SystemTerminalBridge({root:tickets,profileRoot:root,timeoutMs:8000,helper:{command:process.execPath,args:['-e',code,'--']},launch:async spec=>{
  lease=createExperimentalProcessJob({...spec,env:[`SystemRoot=${process.env.SystemRoot}`],stdio:'new-console'});
  lease.resume();return {terminal:'native-console-fixture'};
 }});
 try{
  const result=await bridge.open({key:'synthetic',terminal,cwd:root});
  assert.equal(result.threadId,terminal.threadId);assert.equal(result.terminalId,terminal.terminalId);
  assert.deepEqual(await fs.readdir(tickets),[]);
  const dimensions=await Promise.race([size,new Promise((_,reject)=>setTimeout(()=>reject(Error('No console resize')),3000).unref())]);
  assert(dimensions.every(value=>Number.isInteger(value)&&value>=2));
  await bridge.close('synthetic');assert(!bridge.owns('synthetic'));
  assert.equal((await waitExperimentalJobEmpty(lease)).leaderExitCode,0);
 }finally{
  await bridge.stop();
  if(lease){if(!lease.snapshot().jobEmptyObserved)lease.terminate();await waitExperimentalJobEmpty(lease);lease.close();}
  await fs.rm(root,{recursive:true,force:true});
 }
});

test('return before ticket preparation completes cancels the launch',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-early-return-'));
 const bridge=new SystemTerminalBridge({root:path.join(root,'tickets'),profileRoot:root,helper:{args:[]},launch:()=>assert.fail('unexpected launch')});
 t.after(async()=>{await bridge.stop();await fs.rm(root,{recursive:true,force:true});});
 const opening=bridge.open({key:'preparing',terminal:{threadId:'original'},cwd:root});
 const rejected=assert.rejects(opening,{name:'AbortError'});
 await bridge.close('preparing');await rejected;
 assert(!bridge.owns('preparing'));
});

test('readiness timeout retains a late launch until its Job exit is confirmed',{timeout:5000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-late-console-')),tickets=path.join(root,'tickets');
 let attempts=0;
 const unconfirmed=Object.assign(Error('Job exit unconfirmed'),{code:'PROCESS_JOB_EXIT_UNCONFIRMED'});
 const bridge=new SystemTerminalBridge({root:tickets,profileRoot:root,timeoutMs:100,helper:{args:[]},launch:async({signal,retainRelease})=>{
  await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  retainRelease(async()=>{if(++attempts===1)throw unconfirmed;});
  return {terminal:'late-console'};
 }});
 t.after(async()=>{await bridge.stop();await fs.rm(root,{recursive:true,force:true});});
 await assert.rejects(bridge.open({key:'late',terminal:{threadId:'original'},cwd:root}),{code:unconfirmed.code});
 assert(bridge.owns('late'));assert.deepEqual(await fs.readdir(tickets),[]);
 await bridge.close('late');assert.equal(attempts,2);assert(!bridge.owns('late'));
});

test('Windows console never launches a missing or manifest-endorsed replacement Node',{skip:!windows,timeout:5000},async t=>{
 const {launchWindowsSystemTerminal}=await import('../src/platform/windows/system-terminal-launch.mjs');
 const {createHash}=await import('node:crypto');
 const appRoot=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-runtime-integrity-')),runtime=path.join(appRoot,'runtime','node');
 t.after(()=>fs.rm(appRoot,{recursive:true,force:true}));
 const spec={appRoot,args:['--ticket','synthetic'],signal:new AbortController().signal,retainRelease:()=>assert.fail('unexpected Job')};
 await fs.mkdir(runtime,{recursive:true});
 await assert.rejects(launchWindowsSystemTerminal(spec));
 const replacement=Buffer.from('synthetic replacement');
 await fs.writeFile(path.join(runtime,'node.exe'),replacement);
 const manifest={schema:1,platform:'win32',arch:'x64',executable:'node.exe',version:'22.23.4',sha256Archive:'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'};
 const metadata=path.join(runtime,'NODE-RUNTIME.json');
 await fs.writeFile(metadata,JSON.stringify({...manifest,sha256Executable:createHash('sha256').update(replacement).digest('hex')}));
 await assert.rejects(launchWindowsSystemTerminal(spec),{code:'TERMINAL_RUNTIME_UNAVAILABLE'});
 await fs.writeFile(metadata,JSON.stringify({...manifest,sha256Executable:'dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f'}));
 await assert.rejects(launchWindowsSystemTerminal(spec),{code:'TERMINAL_RUNTIME_UNAVAILABLE'});
});
