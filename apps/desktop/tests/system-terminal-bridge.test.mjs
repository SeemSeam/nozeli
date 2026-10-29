import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createRequire} from 'node:module';
import {SystemTerminalBridge} from '../src/agents/managed/system-terminal-bridge.mjs';import {terminalArguments,defaultTerminal} from '../src/agents/managed/system-terminal-launch.mjs';
const {WebSocket}=createRequire(import.meta.url)('ws');
const tick=()=>new Promise(r=>setTimeout(r,20));
test('authenticated bridge preserves identity, exclusive lease, IO and terminal across detach/reopen',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-sys-bridge-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let socket,ticket;const sent=[],sizes=[],states=[];let launches=0;
 const terminal={threadId:'original-thread',terminalId:'original-pty',replay:'原始终端',input:s=>sent.push(s),resize:(...s)=>sizes.push(s)};
 const launch=async spec=>{launches++;ticket=spec.args.at(-1);assert.equal((await fs.stat(ticket)).mode&0o777,0o600);const {url,token}=JSON.parse(await fs.readFile(ticket));socket=new WebSocket(url,{headers:{Authorization:'Bearer '+token}});socket.once('open',()=>socket.send(JSON.stringify({type:'hello'})));return {terminal:'fixture'};};
 const bridge=new SystemTerminalBridge({root,launch,helper:{command:'helper',args:[]}});t.after(()=>bridge.stop());
 const open=()=>bridge.open({key:'project:worker',terminal,cwd:root,onState:s=>states.push(s)});
 const r=await open();assert.equal(r.threadId,'original-thread');assert(bridge.owns('project:worker'));assert.equal((await open()).reused,true);assert.equal(launches,1);
 socket.send(JSON.stringify({type:'input',data:'中文补充'}));socket.send(JSON.stringify({type:'resize',cols:90,rows:28}));await tick();assert.deepEqual(sent,['中文补充']);assert.deepEqual(sizes,[[90,28]]);
 const next=new Promise(r=>socket.once('message',r));bridge.output('project:worker','new output',1);assert.equal(JSON.parse((await next).toString()).data,'new output');
 socket.close();for(let i=0;i<50&&bridge.owns('project:worker');i++)await tick();assert(!bridge.owns('project:worker'));assert.equal(terminal.threadId,'original-thread');await assert.rejects(fs.access(ticket));
 await open();assert.equal(launches,2);await bridge.close('project:worker');assert.equal(states.at(-1),false);
});
test('unknown token rejected and timed out launcher releases ownership/ticket',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-sys-timeout-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let rejected=false;
 const bridge=new SystemTerminalBridge({root,timeoutMs:100,helper:{command:'helper',args:[]},launch:async spec=>{const {url}=JSON.parse(await fs.readFile(spec.args.at(-1)));const bad=new WebSocket(url);bad.on('error',()=>{rejected=true;});return {};}});t.after(()=>bridge.stop());
 await assert.rejects(bridge.open({key:'x',terminal:{threadId:'t'},cwd:root}),/未完成附着/);assert(rejected);assert(!bridge.owns('x'));assert.deepEqual(await fs.readdir(root),[]);
});
test('terminal adapter keeps helper arguments literal and other platforms explicit',async()=>{
 assert.deepEqual(terminalArguments({name:'x-terminal-emulator',resolved:'konsole'},'/path with spaces/nozeli',['--ticket','/a/$(literal).json'],'/project'),['--separate','--workdir','/project','-e','/path with spaces/nozeli','--ticket','/a/$(literal).json']);assert.equal((await defaultTerminal({platform:'darwin'})).name,'Terminal.app');assert.match(terminalArguments({name:'Terminal.app'},'/path with spaces/nozeli',['--ticket',"/a/quote'$(literal).json"],'/中文 project').at(-1),/env -u ELECTRON_RUN_AS_NODE/);
});
test('launcher and ticket failures release resources; host stop rejects new attachments',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nozeli-sys-failure-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const states=[];
 const bridge=new SystemTerminalBridge({root,helper:{command:'helper',args:[]},launch:async()=>{throw Error('launcher unavailable');}});t.after(()=>bridge.stop());
 await assert.rejects(bridge.open({key:'failed',terminal:{threadId:'t'},cwd:root,onState:s=>states.push(s)}),/launcher unavailable/);assert.deepEqual(states,[true,false]);assert(!bridge.owns('failed'));assert.deepEqual(await fs.readdir(root),[]);
 const file=path.join(root,'file');await fs.writeFile(file,'not a directory');const blocked=new SystemTerminalBridge({root:file,helper:{command:'helper',args:[]}});await assert.rejects(blocked.open({key:'x',terminal:{threadId:'t'},cwd:root}));await blocked.stop();assert(!blocked.owns('x'));
 await bridge.stop();await assert.rejects(bridge.open({key:'new',terminal:{threadId:'t'},cwd:root}),/正在关闭/);
});
