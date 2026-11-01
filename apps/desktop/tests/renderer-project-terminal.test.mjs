import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import xterm from '@xterm/xterm';

const source=await readFile(new URL('../src/renderer/project-terminal-view.mjs',import.meta.url),'utf8');
const create=new Function('Terminal','FitAddon','ResizeObserver',source.split('\n').filter(line=>!line.startsWith('import ')).join('\n').replace('export async function','async function')+';return mountProjectTerminal;');
const tick=()=>new Promise(resolve=>setTimeout(resolve,2));
async function until(check){for(let i=0;i<500;i++){if(check())return;await tick();}assert.fail('Timed out waiting for terminal controller');}

async function harness(t,{cold=false}={}){
  const calls=[],events=new Map(),windowEvents=new Map(),timers=new Set();let terminal,sendInput;
  const win={matchMedia:()=>({matches:true}),navigator:{clipboard:{writeText:async()=>{}}},
    setTimeout(fn,ms){const id=setTimeout(()=>{timers.delete(id);fn();},ms);timers.add(id);return id;},
    requestAnimationFrame:()=>1,cancelAnimationFrame(){},addEventListener:(name,fn)=>windowEvents.set(name,fn),removeEventListener(){}};
  const doc={defaultView:win,hidden:false,querySelector:()=>null,hasFocus:()=>false,addEventListener(){},removeEventListener(){}};
  doc.createElement=()=>({ownerDocument:doc,dataset:{},clientWidth:640,clientHeight:480,children:[],setAttribute(){},append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},addEventListener(){},focus(){}});
  const root=doc.createElement();
  class Terminal extends xterm.Terminal{
    constructor(options){super(options);terminal=this;}
    open(){}
    onData(fn){sendInput=fn;return super.onData(fn);}
    attachCustomKeyEventHandler(){}
  }
  class FitAddon{activate(){}fit(){}dispose(){}}
  class ResizeObserver{observe(){}disconnect(){}}
  t.after(()=>{windowEvents.get('beforeunload')?.();for(const timer of timers)clearTimeout(timer);});
  const mount=create(Terminal,FitAddon,ResizeObserver);
  await mount({root,scope:{projectId:'project',viewId:'view'},subscribe:(name,fn)=>{events.set(name,fn);return()=>{};},invoke:async(op,args)=>{
    calls.push({op,args});let value={};
    if(op==='project-terminal.attach')value=cold&&!args.restart?{instanceId:null,status:'not-started'}:{instanceId:'shell-1',status:'running',shell:{name:'sh'}};
    if(op==='project-terminal.read')value={instanceId:'shell-1',status:'running',nextSeq:1,frames:args.afterSeq?[]:[{seq:1,data:'\x1b[32mREAL ANSI\x1b[0m\r\n'}]};
    return {ok:true,value};
  }});
  return {calls,root,events,terminal,input:sendInput,win,host:root.children[0]};
}

test('cold restore mounts a ready disconnected pane without explicit restart or commands',async t=>{
  const h=await harness(t,{cold:true});
  assert.equal(h.host.dataset.terminalState,'not-started');assert.equal(h.win.__nozeliReady,true);
  assert.equal(h.calls.filter(c=>c.op==='project-terminal.attach').length,1);
  assert.equal(h.calls.find(c=>c.op==='project-terminal.attach').args.restart,undefined);
  assert.equal(h.calls.some(c=>c.op==='project-terminal.write'||c.op==='project-terminal.open'),false);
  h.host.children[0].children[2].onclick();
  await until(()=>h.host.dataset.terminalState==='running');
  assert.equal(h.calls.filter(c=>c.op==='project-terminal.attach').at(-1).args.restart,true);
});

test('real ANSI parser and bounded ordered input use exact terminal instance identity',async t=>{
  const h=await harness(t);await until(()=>h.terminal.buffer.active.getLine(0)?.translateToString(true)==='REAL ANSI');
  const text='汉😀'.repeat(5000);h.input(text);await h.events.get('session.flush')();
  const writes=h.calls.filter(c=>c.op==='project-terminal.write');assert.ok(writes.length>1);
  assert.equal(writes.map(c=>c.args.data).join(''),text);
  for(const {args} of writes){assert.equal(args.projectId,'project');assert.equal(args.viewId,'view');assert.equal(args.instanceId,'shell-1');assert.ok(Buffer.byteLength(args.data)<=16384);assert.equal('cwd' in args,false);assert.equal('command' in args,false);}
  h.events.get('workspace.control')({type:'transfer-hold',held:true});h.input('must-not-send');
  await h.events.get('session.flush')();assert.equal(h.calls.filter(c=>c.op==='project-terminal.write').length,writes.length);
  h.events.get('workspace.control')({type:'transfer-hold',held:false});
  assert.equal(h.calls.filter(c=>c.op==='project-terminal.attach').length,1);
});
