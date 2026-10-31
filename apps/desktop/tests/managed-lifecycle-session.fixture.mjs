// Only copied into an isolated test app. Never imported by production.
// Controlled Pi-contract session stub: deterministic lifecycle coverage of the
// formal host; no real model process, no PTY, no native claims.
import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
function staticReport(text) {
 const escaped=String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Controlled result</title></head><body><main><h1>Controlled result</h1><p>${escaped}</p></main></body></html>`;
}
export class Session extends EventEmitter {
 constructor(spec,target){
  super();
  Object.assign(this,spec,{target,closed:false,busy:false,turns:0});
  this.toolsDigest=createHash('sha256').update(JSON.stringify(this.tools??[])).digest('hex');
  this.viewOwnerId=this.nativeContext?.ownerId??randomUUID();
  this.phase='constructed';this.hasPrompted=false;this.agentEnds=[];this.interactions=[];
  this.desiredModel=null;this.pendingModel=null;this.modelError=null;this.model=this.model??null;this.effort=this.effort??null;
  this.inFlightToolCalls=new Set();this.currentTicket=null;this.blockedTicket=null;this.sideEffectFacts=[];
  this.configurationStatus='unconfigured';this.threadId=null;this.sessionFile=null;
  this.replayFrames=[];this.seq=0;
  this.exitPromise=new Promise(resolve=>{this.resolveFixtureExit=resolve;});
 }
 async start(id){this.threadId=id||randomUUID();this.sessionFile=path.join(this.home,'sessions',this.threadId+'.jsonl');await fs.mkdir(path.dirname(this.sessionFile),{recursive:true});await fs.writeFile(this.sessionFile,JSON.stringify({type:'session',id:this.threadId})+'\n',{flag:'a'});this.phase='idle';this.configurationStatus=this.model?'configured':'unconfigured';return this;}
 async stop(){if(this.closed)return {confirmationComplete:true,fixture:true};this.closed=true;this.phase='closed';this.resolveFixtureExit({fixture:true});return {confirmationComplete:true,fixture:true};}
 async preflightToolsDigest(expected){this.assertToolsDigest(expected);return {expectedDigest:expected,toolsDigest:this.toolsDigest,compatible:true};}
 assertToolsDigest(expected){if(expected!==this.toolsDigest)throw Object.assign(Error('Controlled fixture historical tools mismatch'),{code:'PI_TOOLS_DIGEST_MISMATCH'});}
 async applyDefaultModel(selector){this.desiredModel=selector;this.model=selector??this.model;this.configurationStatus=this.model?'configured':'unconfigured';return {pending:false};}
 async prompt(prompt){this.busy=true;this.hasPrompted=true;this.turns++;const call=(tool,args)=>this.onTool({tool,arguments:args,callId:randomUUID(),promptId:this.threadId});try{
  await new Promise(r=>setTimeout(r,80));
  if(this.target==='frontdesk'){const raw=prompt.split('用户本次原文：\n').at(-1);if(raw.startsWith('FAIL'))throw Error('fixture model unavailable');if(!raw.startsWith('LIGHT'))await call('nozeli_handoff',{reason:'controlled routing'});}
  else if(this.target==='orchestrator'){
   {let raw=prompt.split('原始请求:\n').at(-1);const marker='历史与当前来源（原请求仅为范围依据，不是重新执行指令）：\n';if(raw.includes(marker))raw=JSON.parse(raw.split(marker).at(-1)).originalRequest;const [action,name,...text]=raw.split(' ');if(action==='NEW')await call('nozeli_dispatch',{name,brief:'Controlled task '+name});else await call('nozeli_manage',{action:action.toLowerCase(),workName:name==='ALL'?'':name,text:text.join(' ')||'controlled update'});}
  }else if(this.turns===1)await call('nozeli_publish',{kind:'problem',text:'# 请选择核验方向\n\n已读取受控材料。请选择：先核对实现，或补充优先目标。',files:[]});
  else await call('nozeli_publish',{kind:'result',html:staticReport('# Controlled result\n\nVerified fixture discussion.'),files:[]});
  return {text:'Controlled provider response',threadId:this.threadId,turnId:randomUUID(),providerStatus:'completed',completion:'provider-completed',projectedNative:false};
 }finally{this.busy=false;}}
}
