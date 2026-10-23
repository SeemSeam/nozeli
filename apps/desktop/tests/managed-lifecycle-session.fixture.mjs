// Only copied into an isolated test app. Never imported by production.
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {OmpTuiSession} from './managed/omp-tui-session.mjs';
import {createTerminalScreen} from './managed/terminal-screen.mjs';
function staticReport(text) {
 const escaped=String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Controlled result</title></head><body><main><h1>Controlled result</h1><p>${escaped}</p></main></body></html>`;
}
export class Session extends OmpTuiSession {
 constructor(spec,target){super(spec);Object.assign(this,spec,{target,closed:false,busy:false,turns:0});this.replayFrames=[];this.seq=0;this.exitPromise=new Promise(resolve=>{this.resolveFixtureExit=resolve;});this.pty={write:()=>{throw Error('Controlled GUI fixture does not provide native keyboard execution; use managed input');},resize:(cols,rows)=>{this.fixtureSize={cols,rows};}};}
 async start(id){this.threadId=id||randomUUID();this.sessionFile=path.join(this.home,'sessions',this.threadId+'.jsonl');await fs.mkdir(path.dirname(this.sessionFile),{recursive:true});await fs.writeFile(this.sessionFile,JSON.stringify({type:'session',id:this.threadId})+'\n',{flag:'a'});this.screen=createTerminalScreen({cols:120,rows:32});this.phase='ready';await this.screen.write('Controlled provider view — no native model process\r\n',++this.seq);return this;}
 async stop(){if(this.closed)return;this.closed=true;this.phase='closed';this.resolveFixtureExit({fixture:true});await this.screen?.dispose();}
 async preflightToolsDigest(expected){this.assertToolsDigest(expected);return {expectedDigest:expected,toolsDigest:this.toolsDigest,compatible:true};}
 assertToolsDigest(expected){if(expected!==this.toolsDigest)throw Object.assign(Error('Controlled fixture historical tools mismatch'),{code:'OMP_TOOLS_DIGEST_MISMATCH'});}
 async rpc(method){if(method==='model/list')return {data:['gpt-6-luna','gpt-6.1-sol'].map(model=>({model,supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}))};throw Error('unsupported fixture RPC');}
 async prompt(prompt){this.busy=true;this.hasPrompted=true;this.turns++;const call=(tool,args)=>this.onTool({tool,arguments:args,callId:randomUUID()});try{
  await new Promise(r=>setTimeout(r,80));
  if(this.target==='frontdesk'){const raw=prompt.split('用户本次原文：\n').at(-1);if(raw.startsWith('FAIL'))throw Error('fixture model unavailable');if(!raw.startsWith('LIGHT'))await call('nozeli_handoff',{reason:'controlled routing'});}
  else if(this.target==='orchestrator'){
   {let raw=prompt.split('原始请求:\n').at(-1);const marker='历史与当前来源（原请求仅为范围依据，不是重新执行指令）：\n';if(raw.includes(marker))raw=JSON.parse(raw.split(marker).at(-1)).originalRequest;const [action,name,...text]=raw.split(' ');if(action==='NEW')await call('nozeli_dispatch',{name,brief:'Controlled task '+name});else await call('nozeli_manage',{action:action.toLowerCase(),workName:name==='ALL'?'':name,text:text.join(' ')||'controlled update'});}
  }else if(this.turns===1)await call('nozeli_publish',{kind:'problem',text:'# 请选择核验方向\n\n已读取受控材料。请选择：先核对实现，或补充优先目标。',files:[]});
  else await call('nozeli_publish',{kind:'result',html:staticReport('# Controlled result\n\nVerified fixture discussion.'),files:[]});
  return {text:'Controlled provider response',threadId:this.threadId,turnId:randomUUID(),providerStatus:'completed'};
 }finally{this.busy=false;}}
}
