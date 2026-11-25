import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {ensureExperimentalPrivateDirectory,experimentalPrivateDirectoryComponents} from './experimental-directories.mjs';
import {openExperimentalPersistenceParent} from './experimental-persistence.mjs';

const maxBytes=512;
const identityPattern=/^[a-f0-9]{16}:[a-f0-9]{32}$/;
const namePattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;
const invalid=()=>Object.assign(Error('Invalid private terminal ticket'),{code:'TERMINAL_TICKET_INVALID'});
const valid=({url,token}={})=>typeof url==='string'&&/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(url)&&Number(url.slice(15))<=65535&&typeof token==='string'&&/^[a-f0-9]{64}$/.test(token);
const verifyParent=(parent,identity)=>{parent.verify();if(parent.identity()!==identity)throw invalid();};
function read(file,identity){
 const stat=file.stat();
 if(stat.identity!==identity||stat.size<1n||stat.size>BigInt(maxBytes))throw invalid();
 const bytes=file.readAt(0,Number(stat.size));
 if(bytes.length!==Number(stat.size))throw invalid();
 return {bytes,security:stat.security};
}

// Only identities and paths are passed on the command line, never the bearer token.
export function readWindowsTerminalTicket(argument){
 let descriptor;
 try{descriptor=JSON.parse(argument);}catch{throw invalid();}
 const {root,relative,parentIdentity,fileIdentity}=descriptor??{};
 if(typeof root!=='string'||!path.isAbsolute(root)||typeof relative!=='string'||
    !identityPattern.test(parentIdentity??'')||!identityPattern.test(fileIdentity??''))throw invalid();
 const name=relative.split('/').at(-1);
 if(!namePattern.test(name)||experimentalPrivateDirectoryComponents(root,path.join(root,relative)).join('/')!==relative)throw invalid();
 const parent=openExperimentalPersistenceParent(root,relative);
 let file;
 try{
  verifyParent(parent,parentIdentity);
  file=parent.openPrivateObjectRead(name);
  const {bytes}=read(file,fileIdentity);
  file.verify();verifyParent(parent,parentIdentity);
  let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{throw invalid();}
  if(!value||!valid(value))throw invalid();
  return {url:value.url,token:value.token};
 }finally{try{file?.close();}finally{parent.close();}}
}

export async function createWindowsTerminalTicket(root,directory,payload){
 if(!payload||!valid(payload))throw invalid();
 const bytes=Buffer.from(JSON.stringify({url:payload.url,token:payload.token}));
 const name=randomUUID()+'.json',relative=experimentalPrivateDirectoryComponents(root,path.join(directory,name)).join('/');
 await ensureExperimentalPrivateDirectory(root,directory);
 const parent=openExperimentalPersistenceParent(root,relative);
 let stage,pin,handedOff=false;
 try{
  const parentIdentity=parent.identity();
  stage=parent.createPrivateExclusive('.terminal-'+randomUUID()+'.pending');
  stage.write(bytes);stage.sync();
  const fileIdentity=stage.identity();
  stage.publishNew(name);stage.close();stage=null;
  pin=parent.openPrivateObjectRead(name);
  const observed=read(pin,fileIdentity);
  if(!observed.bytes.equals(bytes))throw invalid();
  verifyParent(parent,parentIdentity);
  const argument=JSON.stringify({root,relative,parentIdentity,fileIdentity});
  let closed=false;
  const ticket=Object.freeze({argument,close(){
   if(closed)return;
   closed=true;
   let deletion;
   try{
    pin.verify();pin.close();pin=null;
    verifyParent(parent,parentIdentity);
    deletion=parent.openPrivateDeleteFile(name);
    const current=read(deletion,fileIdentity);
    if(!current.security.equals(observed.security)||!current.bytes.equals(bytes))throw invalid();
    verifyParent(parent,parentIdentity);deletion.remove();
   }finally{try{deletion?.close();}finally{try{pin?.close();}finally{parent.close();}}}
  }});
  handedOff=true;
  return ticket;
 }finally{if(!handedOff){try{stage?.close();}finally{try{pin?.close();}finally{parent.close();}}}}
}
