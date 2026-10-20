import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {parse,stringify} from 'yaml';
 import {createReadStream} from 'node:fs';
 import {createInterface} from 'node:readline';
import {scrubProviderEnv} from './omp-credentials.mjs';

const roles=['frontdesk','orchestrator','worker'];
const fail=message=>{throw Object.assign(new Error(message),{code:'SETTINGS_INVALID'});};
const text=(value,max=200)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
export function validateApiSource(p){
 if(!p||Object.keys(p).some(k=>!['provider','baseUrl','model','key','api'].includes(k)))fail('源配置字段无效。');
 if(!text(p.provider,64)||!/^[-a-z0-9_.]+$/.test(p.provider)||['__proto__','constructor','prototype'].includes(p.provider))fail('Provider ID只能含小写字母、数字、点、横线和下划线。');
 if(!text(p.model,200)||p.model.trim()!==p.model||p.model.startsWith('!'))fail('请输入有效模型ID。');
 let url;try{url=new URL(p.baseUrl);}catch{fail('请输入有效API地址。');}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!text(p.baseUrl,2048))fail('API地址须为无凭据和查询参数的HTTP(S)地址。');
 if(!text(p.key,16384)||p.key.trim()!==p.key)fail('请输入有效API密钥。');
 if(!['openai-completions','openai-responses','anthropic-messages'].includes(p.api))fail('请选择支持的API协议。');
 return {...p,baseUrl:url.href.replace(/\/$/,'')};
}
async function atomic(file,value){const temp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,value,{flag:'wx',mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}}
async function optional(file,fallback){try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
 export function loginDisplay(output){
  return output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split('\n').filter(line=>{
   const value=line.trim();
   if(/^(?:https?:\/\/)/.test(value))return !/[\s"<>]/.test(value)&&value.length<8192;
   if(/token|secret|password|api.?key|credentials saved|logged in to/i.test(value))return false;
   return /^(?:Select a provider:|\d+\. |Enter number|Open this URL|Local shortcut|Paste the authorization|Enter |Please |Visit |User code|Code:|Waiting|Opening|You can|To authenticate)/i.test(value);
  }).join('\n');
 }
 export async function hasProviderReferences(root,provider){
  const matches=value=>typeof value==='string'&&value.startsWith(provider+'/');
  async function walk(dir){
   let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return false;throw error;}
   for(const entry of entries){
    if(entry.isSymbolicLink())continue;const file=path.join(dir,entry.name);
    if(entry.isDirectory()){if(await walk(file))return true;}
    else if(entry.name==='state.json'){
     const state=JSON.parse(await fs.readFile(file,'utf8'));
     if(Object.values(state.bindings??{}).some(b=>matches(b.model))||(state.works??[]).some(w=>matches(w.binding?.model))||Object.values(state.legacyNativeSeeds??{}).some(b=>matches(b.model)))return true;
    }else if(entry.name.endsWith('.jsonl')){
     const stream=createReadStream(file,{encoding:'utf8'}),lines=createInterface({input:stream,crlfDelay:Infinity});
     try{for await(const line of lines){let row;try{row=JSON.parse(line);}catch{return true;}if(matches(row.model)||row.message?.provider===provider)return true;}}
     finally{lines.close();stream.destroy();}
    }
   }
   return false;
  }
  return walk(root);
 }
export class ProviderSettings {
 constructor({source,broker,command,sourceEnv=process.env,isReferenced=async()=>false,spawnFn=spawn}){Object.assign(this,{source,broker,command,sourceEnv,isReferenced,spawnFn});this.queue=Promise.resolve();this.login=null;}
 serial(fn){const result=this.queue.then(fn);this.queue=result.catch(()=>{});return result;}
 get file(){return path.join(this.source.agentDir,'nozeli-role-defaults.json');}
 async defaults(){const value=JSON.parse(await optional(this.file,'{"schema":1,"roles":{}}'));if(value.schema!==1||!value.roles||typeof value.roles!=='object')fail('全局模型配置无效，原文件已保留。');return value.roles;}
 async modelFor(role){return (await this.defaults())[role]??null;}
 async env(){const {env}=scrubProviderEnv(this.sourceEnv);for(const key of ['OMP_AUTH_BROKER_URL','OMP_AUTH_BROKER_TOKEN','OMP_PROFILE','PI_PROFILE','PI_CODING_AGENT_DIR','PI_CONFIG_DIR'])delete env[key];return {...env,NOZELI_CONFIG_ROOT:this.source.root,NOZELI_AGENT_DIR:this.source.agentDir,NO_COLOR:'1',FORCE_COLOR:'0'};}
 async request(route,body){const grant=await this.broker.acquire();const response=await fetch(new URL(route,grant.url),{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+grant.token,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('OMP认证操作未完成，请检查私有运行环境。');return response.json();}
 async models(){
  if(!this.command)throw Error('私有OMP不可用。');
  const grant=await this.broker.acquire();
  const env={...await this.env(),OMP_AUTH_BROKER_URL:grant.url,OMP_AUTH_BROKER_TOKEN:grant.token,OMP_AUTH_BROKER_SNAPSHOT_TTL_MS:'0'};
  return new Promise((resolve,reject)=>{
   let data='',diagnostic='',settled=false;
   const child=this.spawnFn(this.command,['models','ls','--json','--no-extensions'],{cwd:this.source.agentDir,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
   const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(Error('OMP模型目录读取失败；请检查源配置。')):resolve(value);};
   const timer=setTimeout(()=>{child.kill();finish(true);},45000);
   child.on('error',()=>finish(true));
   child.stdout.on('data',chunk=>{data+=chunk;if(data.length>8*1024*1024){child.kill();finish(true);}});
   child.stderr.on('data',chunk=>{diagnostic=(diagnostic+String(chunk)).slice(-65536);});
   child.on('exit',code=>{
    try{
     if(code!==0||/validation failed|failed to load config|Validate\(models\).*error/i.test(diagnostic))throw Error();
     const value=JSON.parse(data);if(!Array.isArray(value.models))throw Error();
     finish(false,value.models.filter(m=>text(m.selector,300)&&text(m.provider,64)&&text(m.id,200)).map(m=>({selector:m.selector,provider:m.provider,id:m.id,name:text(m.name,300)?m.name:m.id})));
    }catch{finish(true);}
   });
  });
 }
 async loginProviders(){
  if(!this.command)fail('私有OMP不可用。');
  const env=await this.env();
  return new Promise((resolve,reject)=>{
   let output='',settled=false;
   const child=this.spawnFn(this.command,['auth-broker','list','--json'],{cwd:this.source.agentDir,env,stdio:['ignore','pipe','ignore'],windowsHide:true});
   const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(Error('无法读取OMP支持的登录源，请刷新后重试。')):resolve(value);};
   const timer=setTimeout(()=>{child.kill();finish(true);},20000);
   child.on('error',()=>finish(true));child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1024*1024){child.kill();finish(true);}});
   child.on('close',code=>{try{if(code!==0)throw Error();const rows=JSON.parse(output);if(!Array.isArray(rows)||rows.some(p=>!text(p.id,64)||!/^[-a-z0-9_.]+$/.test(p.id)||!text(p.name,300)))throw Error();finish(false,rows.map(({id,name})=>({id,name})));}catch{finish(true);}});
  });
 }
 async status(){await this.queue;const [snapshot,models,defaults]=await Promise.all([this.request('/v1/snapshot'),this.models(),this.defaults()]);const doc=await this.readModels();const sources=new Map();for(const entry of snapshot.credentials??[])sources.set(entry.provider,{provider:entry.provider,type:entry.credential?.type==='oauth'?'oauth':'api',configured:true});for(const [provider,config]of Object.entries(doc.value.providers??{}))sources.set(provider,{provider,type:'api',configured:true,baseUrl:typeof config.baseUrl==='string'?this.safeUrl(config.baseUrl):'',models:(config.models??[]).map(m=>m.id).filter(id=>text(id,200))});return {sources:[...sources.values()],models,defaults,login:this.loginStatus(),notice:'全局默认仅绑定新会话；已有会话及其原生配置保持不变。新增API源只自动进入新建Agent配置目录，已有目录请在项目原生OMP设置中管理。'};}
 safeUrl(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash?u.href:'';}catch{return '';}}
 async readModels(){let file=path.join(this.source.agentDir,'models.yml');if(await optional(file,null)===null&&await optional(path.join(this.source.agentDir,'models.yaml'),null)!==null)file=path.join(this.source.agentDir,'models.yaml');let value;try{value=parse(await optional(file,''))??{};}catch{fail('原生模型配置无效，原文件已保留。');}if(typeof value!=='object'||Array.isArray(value)||value.providers&&(typeof value.providers!=='object'||Array.isArray(value.providers)))fail('原生模型配置无效，原文件已保留。');return {file,value};}
 saveApi(payload){const p=validateApiSource(payload);return this.serial(async()=>{
  const doc=await this.readModels();doc.value.providers??={};
  if(Object.hasOwn(doc.value.providers,p.provider))fail('此Provider已有配置；请使用新的源ID，避免覆盖现有会话。');
  const snapshot=await this.request('/v1/snapshot');if(snapshot.credentials?.some(e=>e.provider===p.provider))fail('此Provider已有凭据；请使用新的源ID。');
  await this.request('/v1/credential',{provider:p.provider,credential:{type:'api_key',key:p.key,source:'login'}});
  // Official custom-model validation requires apiKey even with a broker.
  // Native configuration stays private (0600), and status projects no secrets.
  doc.value.providers[p.provider]={api:p.api,baseUrl:p.baseUrl,apiKey:p.key,models:[{id:p.model,name:p.model}]};
  try{await atomic(doc.file,stringify(doc.value));}catch(error){
   const current=await this.request('/v1/snapshot');
   for(const entry of current.credentials??[])if(entry.provider===p.provider)await this.request('/v1/credential/'+entry.id+'/disable',{cause:'Nozeli source configuration write failed'});
   throw error;
  }
  return {saved:true};
 });}
 saveDefaults(payload){if(!payload||Object.keys(payload).some(k=>!roles.includes(k))||roles.some(role=>typeof payload[role]!=='string'))fail('三角色默认配置无效。');const value=structuredClone(payload);return this.serial(async()=>{const models=await this.models();for(const role of roles)if(value[role]&&!models.some(m=>m.selector===value[role]))fail('所选模型不在当前已配置OMP目录中，请刷新。');await atomic(this.file,JSON.stringify({schema:1,roles:value},null,2)+'\n');return {saved:true};});}
 remove(payload){if(!payload||Object.keys(payload).some(k=>!['provider','confirm'].includes(k))||!text(payload.provider,64)||payload.confirm!==payload.provider)fail('请输入完整源ID确认移除。');return this.serial(async()=>{const provider=payload.provider;const defaults=await this.defaults();if(Object.values(defaults).some(s=>s.startsWith(provider+'/'))||await this.isReferenced(provider))fail('此源仍被全局默认或已有会话引用，未移除。请先解除引用。');const doc=await this.readModels();const snapshot=await this.request('/v1/snapshot');for(const entry of snapshot.credentials??[])if(entry.provider===provider)await this.request('/v1/credential/'+entry.id+'/disable',{cause:'removed explicitly in Nozeli settings'});if(doc.value.providers&&Object.hasOwn(doc.value.providers,provider)){delete doc.value.providers[provider];await atomic(doc.file,stringify(doc.value));}return {removed:true};});}
 loginStatus(){if(!this.login)return null;const {id,provider,name,state,output}=this.login;return {id,provider,name,state,output};}
 async startLogin(payload){
  if(!payload||Object.keys(payload).some(k=>k!=='provider')||!text(payload.provider,64)||!/^[-a-z0-9_.]+$/.test(payload.provider))fail('请先选择OMP支持的登录源。');
  if(this.login?.state==='running')fail('已有登录流程，请完成或取消。');if(!this.command)fail('私有OMP不可用。');
  const providers=await this.loginProviders();if(!providers.some(p=>p.id===payload.provider))fail('所选源不在OMP支持的登录列表中，请刷新。');
  await this.broker.acquire();
  const env=await this.env();const child=this.spawnFn(this.command,['login',payload.provider],{cwd:this.source.agentDir,env,stdio:['pipe','pipe','ignore'],windowsHide:true});
  const login={id:randomUUID(),provider:payload.provider,name:providers.find(p=>p.id===payload.provider).name,state:'running',output:'',child,buffer:''};this.login=login;
  login.exited=new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
  login.timer=setTimeout(()=>{login.state='expired';this.terminateLogin(login).catch(()=>{});},10*60*1000);
  child.stdout.on('data',chunk=>{
   if(login.state!=='running')return;
   login.buffer+=String(chunk);
   if(login.buffer.length>65536){login.state='failed';login.output='登录输出超出限制，已取消。';this.terminateLogin(login).catch(()=>{});return;}
   login.output=loginDisplay(login.buffer);
  });
  child.on('error',()=>{clearTimeout(login.timer);login.state='failed';login.output='私有OMP登录启动失败。';});
  child.on('exit',code=>{clearTimeout(login.timer);login.buffer='';if(login.state==='running')login.state=code===0?'complete':'failed';if(login.state==='failed')login.output='登录未完成。请重试；凭据和错误详情未回传。';});return this.loginStatus();
 }
 inputLogin(p){if(!p||Object.keys(p).some(k=>!['id','text'].includes(k))||p.id!==this.login?.id||this.login.state!=='running'||typeof p.text!=='string'||p.text.length>8192||/[\x00-\x1f\x7f]/.test(p.text))fail('登录输入无效或流程已结束。');this.login.child.stdin.write(p.text+'\n');return {sent:true};
 }
 async terminateLogin(login){
  clearTimeout(login.timer);if(login.child.exitCode!=null||login.child.signalCode!=null)return;
  login.child.kill('SIGTERM');
  let timer;await Promise.race([login.exited,new Promise(resolve=>{timer=setTimeout(resolve,3000);})]);clearTimeout(timer);
  if(login.child.exitCode==null&&login.child.signalCode==null){login.child.kill('SIGKILL');await login.exited;}
 }
 async cancelLogin(p){if(!p||Object.keys(p).some(k=>k!=='id')||p.id!==this.login?.id)fail('登录流程无效。');this.login.state='cancelled';this.login.output='登录已取消。';await this.terminateLogin(this.login);return this.loginStatus();}
 async stop(){if(this.login)await this.terminateLogin(this.login);}
}
