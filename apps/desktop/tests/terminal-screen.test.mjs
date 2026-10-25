import test from 'node:test';
import assert from 'node:assert/strict';
import {createTerminalScreen} from '../src/agents/managed/terminal-screen.mjs';
import {ManagedProjects} from '../src/agents/managed-projects.mjs';
const text=s=>s.lines.map(r=>r.map(c=>c.text).join(''));

test('screen parses split ANSI, cursor erasure, RGB, wide and combining characters',async t=>{
 const s=createTerminalScreen({cols:16,rows:3});t.after(()=>s.dispose());
 await s.write('\x1b[3',1);await s.write('1mOld\r\x1b[2K\x1b[38;2;12;34;56m红e\u0301\x1b[0m',2);
 const view=await s.snapshot();assert.equal(view.seq,2);assert.equal(text(view)[0].trim(),'红é');assert.equal(view.lines[0][0].cells,2);assert.equal(view.lines[0][0].fg,'#0c2238');assert.equal(view.lines[0][1].text,'é');assert.equal(view.lines[0][1].cells,1);assert.equal(view.lines[0].at(-1).fg,null);
});
test('full parsed screen survives truncated replay length and preserves color state',async t=>{
 const s=createTerminalScreen({cols:20,rows:3});t.after(()=>s.dispose());
 await s.write('\x1b[32m'+('abcdefghijklmnopqrstuvwxyz\r\n'.repeat(10000)),1);
 await s.write('\x1b[2J\x1b[HStill green',2);const view=await s.snapshot();assert.equal(view.lines.length,3);assert.equal(view.lines[0][0].fg,'#00cd00');assert.equal(text(view)[0].trim(),'Still green');assert.ok(JSON.stringify(view).length<3000);
});
test('ordered resize and alternate screen transitions produce authoritative snapshots',async t=>{
 const s=createTerminalScreen({cols:8,rows:3});t.after(()=>s.dispose());
 const a=s.write('normal',1),b=s.resize(14,4),c=s.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[44;97;1mALT',2);await Promise.all([a,b,c]);let view=await s.snapshot();assert.equal(view.cols,14);assert.equal(view.rows,4);assert.equal(view.seq,2);assert.equal(view.version,3);assert.equal(text(view)[0].trim(),'ALT');assert.equal(view.lines[0][0].bg,'#0000ee');assert.equal(view.lines[0][0].bold,true);
 await s.write('\x1b[?1049l',3);view=await s.snapshot();assert.equal(text(view)[0].trim(),'normal');
});
test('terminal queries have no reply transport and change notifications are bounded',async t=>{
 const changes=[],s=createTerminalScreen({onChange:c=>changes.push(c)});t.after(()=>s.dispose());
 for(let i=1;i<=30;i++)await s.write('x\x1b[6n\x1b[c',i);
 await new Promise(r=>setTimeout(r,100));assert.equal(changes.length,1);assert.equal(changes[0].seq,30);assert.equal((await s.snapshot()).seq,30);
});
test('read-only work screen does not wait for attach, create, control or take system ownership',async()=>{
 let snapshots=0;const c={started:true,store:{state:{works:[{id:'w',status:'review'},{id:'q',status:'queued'},{id:'e',status:'ended'},{id:'missing',status:'paused'}]}},terminals:new Map([['w',{terminalId:'pty',threadId:'thread',snapshot:async()=>{snapshots++;return {version:1,seq:1,cols:2,rows:2,lines:[]};},input(){throw Error('input called');},resize(){throw Error('resize called');},close(){throw Error('close called');}}]])};
 const m=new ManagedProjects({userDataDir:'/unused',host:{requireProject:async id=>{assert.equal(id,'p');}},legacy:{},attachTerminal:()=>{throw Error('attach called');}});m.controllers.set('p',c);m.terminalFlights.set('p:w',new Promise(()=>{}));m.systemTerminals.owns=()=>{throw Error('ownership access');};
 const read=target=>m.invoke('managed.terminal.screen',{projectId:'p',target});
 assert.equal((await read('w')).threadId,'thread');assert.equal(snapshots,1);for(const id of ['q','e','missing'])assert.equal((await read(id)).available,false);assert.equal(snapshots,1);await assert.rejects(read('frontdesk'),/工作Agent/);await assert.rejects(m.invoke('managed.terminal.screen',{projectId:'p',target:'w',cols:100}),/payload/);
 c.terminals.get('w').snapshot=async()=>{c.store.state.works=c.store.state.works.map(w=>w.id==='w'?{...w,status:'ended'}:w);return {};};assert.equal((await read('w')).available,false);
});
test('cold screen preview never creates a controller or restores a session',async()=>{
 const m=new ManagedProjects({userDataDir:'/unused',host:{requireProject:async()=>{}},legacy:{}});
 m.controller=()=>{throw Error('must not restore controller');};
 const result=await m.invoke('managed.terminal.screen',{projectId:'cold',target:'work'});
 assert.equal(result.available,false);assert.match(result.reason,/不会启动新会话/);assert.equal(m.controllers.has('cold'),false);
});
