import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
import {launchDefaultTerminal} from './system-terminal-launch.mjs';
const {WebSocketServer}=createRequire(import.meta.url)('ws');
export class SystemTerminalBridge {
 constructor({root,launch=launchDefaultTerminal,helper,timeoutMs=15000}){Object.assign(this,{root,launch,helper,timeoutMs});this.entries=new Map();this.flights=new Map();this.stopping=false;}
 async open({key,terminal,cwd,onState=()=>{}}){
  if(this.stopping)throw Error('Nozeli 正在关闭，不能打开系统终端。');
  if(this.flights.has(key))return this.flights.get(key);
  if(this.entries.has(key)){const entry=this.entries.get(key);if(entry.closing){await entry.close();return this.open({key,terminal,cwd,onState});}return {attached:true,reused:true,threadId:terminal.threadId};}
  const flight=this.start({key,terminal,cwd,onState}).finally(()=>this.flights.delete(key));this.flights.set(key,flight);return flight;
 }
 async start({key,terminal,cwd,onState}){
  const token=randomBytes(32).toString('hex'),server=new WebSocketServer({host:'127.0.0.1',port:0,maxPayload:65536,verifyClient:info=>!info.origin&&info.req.headers.authorization===`Bearer ${token}`});
  await new Promise((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
  const ticket=path.join(this.root,randomUUID()+'.json');
  try{await fs.mkdir(this.root,{recursive:true,mode:0o700});await fs.writeFile(ticket,JSON.stringify({url:`ws://127.0.0.1:${server.address().port}`,token}),{mode:0o600,flag:'wx'});if(this.stopping)throw Error('Nozeli 正在关闭');}
  catch(error){await new Promise(resolve=>server.close(resolve));await fs.rm(ticket,{force:true});throw error;}
  let socket,timer,resolveReady,rejectReady,closing;
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
  const entry={terminal,ticket,get closing(){return !!closing;},connected:false,send:data=>{if(socket?.readyState===1){if(socket.bufferedAmount>1024*1024){socket.terminate();return;}socket.send(JSON.stringify(data));}},close:()=>{
   if(closing)return closing;
   closing=(async()=>{clearTimeout(timer);rejectReady(Error('系统终端连接已关闭'));for(const client of server.clients)client.terminate();await new Promise(resolve=>server.close(resolve));await fs.rm(ticket,{force:true});if(this.entries.get(key)===entry){this.entries.delete(key);onState(false);}})();return closing;
  }};
  this.entries.set(key,entry);onState(true);
  server.on('connection',client=>{
   if(socket){client.close(1008,'one client');return;}socket=client;
   client.on('error',()=>{});client.on('close',()=>{void entry.close().catch(()=>{});});
   client.on('message',raw=>{try{
    const value=JSON.parse(raw.toString());
    if(!entry.connected){if(value.type!=='hello')throw Error('hello required');entry.connected=true;clearTimeout(timer);void fs.rm(ticket,{force:true}).catch(()=>{});entry.send({type:'ready',threadId:terminal.threadId,terminalId:terminal.terminalId,replay:terminal.replay});resolveReady();onState(true);return;}
    if(value.type==='input'&&typeof value.data==='string'&&value.data.length<=10000)terminal.input(value.data);
    else if(value.type==='resize'&&Number.isInteger(value.cols)&&Number.isInteger(value.rows)&&value.cols>=2&&value.cols<=500&&value.rows>=2&&value.rows<=200)terminal.resize(value.cols,value.rows);
    else throw Error('invalid terminal message');
   }catch(error){entry.send({type:'error',message:error.message});}});
  });
  timer=setTimeout(()=>{rejectReady(Error('系统终端未完成附着，请检查终端启动状态后重试。'));void entry.close().catch(()=>{});},this.timeoutMs);
  try{const launched=await this.launch({...this.helper,args:[...this.helper.args,'--ticket',ticket],cwd});await ready;return {attached:true,threadId:terminal.threadId,terminalId:terminal.terminalId,...launched};}
  catch(error){await entry.close();throw error;}
 }
 output(key,data,seq){const entry=this.entries.get(key);if(entry?.connected)entry.send({type:'output',data,seq});}
 owns(key){return this.entries.has(key);}
 async close(key){await this.entries.get(key)?.close();}
 async stop(){this.stopping=true;await Promise.allSettled([...this.entries.values()].map(e=>e.close()));await Promise.allSettled([...this.flights.values()]);}
}
