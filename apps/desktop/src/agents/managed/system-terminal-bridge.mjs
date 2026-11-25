import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {launchDefaultTerminal} from './system-terminal-launch.mjs';
import {createWindowsTerminalTicket} from '../../platform/windows/system-terminal-ticket.mjs';
const {WebSocketServer}=createRequire(import.meta.url)('ws');
export class SystemTerminalBridge {
 constructor({root,profileRoot,launch=launchDefaultTerminal,helper,timeoutMs=15000}){Object.assign(this,{root,profileRoot,launch,helper,timeoutMs});this.entries=new Map();this.flights=new Map();this.stopping=false;}
 async open({key,terminal,cwd,onState=()=>{}}){
  if(this.stopping)throw Error('Nozeli 正在关闭，不能打开系统终端。');
  if(this.flights.has(key))return this.flights.get(key).flight;
  if(this.entries.has(key)){const entry=this.entries.get(key);if(entry.closing){await entry.close();return this.open({key,terminal,cwd,onState});}return {attached:true,reused:true,threadId:terminal.threadId};}
  const abort=new AbortController();
  const flight=this.start({key,terminal,cwd,onState,abort}).finally(()=>this.flights.delete(key));
  this.flights.set(key,{flight,abort});return flight;
 }
 async start({key,terminal,cwd,onState,abort}){
  let socket;
  const token=randomBytes(32).toString('hex'),server=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:65536,verifyClient:info=>!socket&&!info.origin&&info.req.headers.authorization===`Bearer ${token}`});
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  let ticket;
  const payload={url:`ws://127.0.0.1:${server.address().port}`,token};
  try{
   abort.signal.throwIfAborted();
   if(process.platform==='win32'){
    if(!this.profileRoot)throw Error('A private Windows profile root is required for terminal tickets');
    ticket=await createWindowsTerminalTicket(this.profileRoot,this.root,payload);
   }
   else{
    const file=path.join(this.root,randomUUID()+'.json');
    await fs.mkdir(this.root,{recursive:true,mode:0o700});
    await fs.writeFile(file,JSON.stringify(payload),{mode:0o600,flag:'wx'});
    ticket={argument:file,close:()=>fs.rm(file,{force:true})};
   }
   if(this.stopping)throw Error('Nozeli 正在关闭');
   abort.signal.throwIfAborted();
  }catch(error){await new Promise(resolve=>server.close(resolve));await ticket?.close();throw error;}
  let ticketCleanup;
  const consumeTicket=()=>ticketCleanup??=Promise.resolve().then(()=>ticket.close());
  let timer,resolveReady,rejectReady,closing,launchFlight,release,transportClosed;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
  const entry={terminal,ticket,get closing(){return abort.signal.aborted;},connected:false,send:data=>{if(socket?.readyState===1){if(socket.bufferedAmount>1024*1024){socket.terminate();return;}socket.send(JSON.stringify(data));}},close:()=>{
   if(closing)return closing;
   clearTimeout(timer);rejectReady(Error('系统终端连接已关闭'));abort.abort();entry.connected=false;
   transportClosed??=new Promise(resolve=>{
    for(const client of server.clients)client.terminate();
    server.close(resolve);
   });
   closing=(async()=>{
    await transportClosed;
    const [cleanup]=await Promise.allSettled([consumeTicket(),launchFlight]);
    await release?.();
    if(this.entries.get(key)===entry){this.entries.delete(key);onState(false);}
    if(cleanup.status==='rejected')throw cleanup.reason;
   })().finally(()=>{closing=undefined;});return closing;
  }};
  this.entries.set(key,entry);
  server.on('connection',client=>{
   if(socket){client.close(1008,'one client');return;}socket=client;
   client.on('error',()=>{});client.on('close',()=>{void entry.close().catch(()=>{});});
   let authenticating=false;
   client.on('message',raw=>{try{
    if(entry.closing)return;
    const value=JSON.parse(raw.toString());
    if(!entry.connected){
     if(authenticating||value.type!=='hello')throw Error('hello required');
     authenticating=true;
     void consumeTicket().then(()=>{
      if(entry.closing)return;
      onState(true);
      if(entry.closing)return;
      entry.connected=true;clearTimeout(timer);entry.send({type:'ready',threadId:terminal.threadId,terminalId:terminal.terminalId,replay:terminal.replay});resolveReady();
     }).catch(error=>{rejectReady(error);void entry.close().catch(()=>{});});
     return;
    }
    if(value.type==='input'&&typeof value.data==='string'&&value.data.length<=10000)terminal.input(value.data);
    else if(value.type==='resize'&&Number.isInteger(value.cols)&&Number.isInteger(value.rows)&&value.cols>=2&&value.cols<=500&&value.rows>=2&&value.rows<=200)terminal.resize(value.cols,value.rows);
    else throw Error('invalid terminal message');
   }catch(error){entry.send({type:'error',message:error.message});}});
  });
  timer=setTimeout(()=>{rejectReady(Error('系统终端未完成附着，请检查终端启动状态后重试。'));void entry.close().catch(()=>{});},this.timeoutMs);
  try{
   onState(true);
   launchFlight=Promise.resolve().then(()=>{
    abort.signal.throwIfAborted();
    return this.launch({...this.helper,args:[...this.helper.args,'--ticket',ticket.argument],cwd,signal:abort.signal,retainRelease:fn=>{release=fn;}});
   });
   const [{terminal:name,pid}]=await Promise.all([launchFlight,ready]);abort.signal.throwIfAborted();
   return {attached:true,threadId:terminal.threadId,terminalId:terminal.terminalId,terminal:name,...(pid===undefined?{}:{pid})};
  }
  catch(error){await entry.close();throw error;}
 }
 output(key,data,seq){const entry=this.entries.get(key);if(entry?.connected)entry.send({type:'output',data,seq});}
 owns(key){return this.entries.has(key);}
 async close(key){
  const entry=this.entries.get(key);
  if(entry)return entry.close();
  const pending=this.flights.get(key);
  if(pending){pending.abort.abort();await Promise.allSettled([pending.flight]);}
 }
 async stop(){
  this.stopping=true;
  const keys=new Set([...this.entries.keys(),...this.flights.keys()]);
  const results=await Promise.allSettled([...keys].map(key=>this.close(key)));
  await Promise.allSettled([...this.flights.values()].map(({flight})=>flight));
  if(this.entries.size)throw results.find(result=>result.status==='rejected')?.reason??Error('Terminal Job exit unconfirmed');
 }
}
