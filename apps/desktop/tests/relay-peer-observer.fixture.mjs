import {createHash} from 'node:crypto';

// Test-only relay peer observation. Does not touch frames, ping/pong policy,
// reconnects, timers or application state. Never emits URL/capability/body.
export function observeRelayPeers(WebSocketServer,{onEvent}){
 const original=WebSocketServer.prototype.handleUpgrade,owners=new Map(),errors=[];
 const roomKey=value=>createHash('sha256').update(new URL(value,'http://localhost').pathname).digest('hex');
 const record=row=>{try{onEvent({at:Date.now(),...owners.get(row.roomHash),...row});}catch(error){errors.push({name:['Error','TypeError','SyntaxError'].includes(error.name)?error.name:'Error',code:typeof error.code==='string'?error.code:'UNKNOWN'});}};
 WebSocketServer.prototype.handleUpgrade=function(request,socket,head,callback){
  let address,role;try{address=new URL(request.url,'http://localhost');role=address.searchParams.get('role');}catch{return original.call(this,request,socket,head,callback);}
  if(!['host','guest'].includes(role)||!/^\/r\/[A-Za-z0-9_-]{8,128}$/.test(address.pathname))return original.call(this,request,socket,head,callback);
  const roomHash=roomKey(address.href);
  return original.call(this,request,socket,head,(ws,...args)=>{
   record({phase:'relay-peer-connected',role,roomHash});
   ws.prependListener('message',(data,binary)=>{let controlType=null;if(!binary)try{const frame=JSON.parse(data.toString());controlType=['ping','pong','bye','welcome','heartbeat','host-heartbeat','error'].includes(frame.t)?frame.t:'other';}catch{controlType='non-json';}record({phase:'relay-peer-message',role,roomHash,binary,bytes:data.length,controlType});});
   for(const event of ['ping','pong'])ws.on(event,data=>record({phase:'relay-peer-'+event,role,roomHash,bytes:data.length}));
   ws.on('error',error=>record({phase:'relay-peer-error',role,roomHash,code:typeof error.code==='string'?error.code:'UNKNOWN'}));
   ws.prependListener('close',(code,reason)=>record({phase:'relay-peer-closed',role,roomHash,code,reason:['idle timeout','ping timeout','backpressure'].includes(reason.toString())?reason.toString():reason.length?'redacted':''}));
   callback(ws,...args);
  });
 };
 const bind=(runtime,identity)=>{const roomHash=roomKey(runtime.guest.ws.url);owners.set(roomHash,identity);record({phase:'relay-owner-bound',roomHash});return roomHash;};
 const restore=()=>{WebSocketServer.prototype.handleUpgrade=original;owners.clear();};
 return {bind,restore,errors};
}
