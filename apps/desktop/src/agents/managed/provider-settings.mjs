import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';

const roles=['frontdesk','orchestrator','worker'];
// Native SDK thinking vocabulary (input syntax only). Per-model support and
// clamping stay with the native session; the host never fabricates levels.
export const THINKING_LEVELS=['off','minimal','low','medium','high','xhigh'];
const fail=message=>{throw Object.assign(new Error(message),{code:'SETTINGS_INVALID'});};
const text=(value,max=200)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const unavailable=()=>Object.assign(new Error('Nozeli 私有 Pi 运行环境不可用，设置未变更。'),{code:'PI_RUNTIME_UNAVAILABLE'});
const originOf=value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)?url.origin:null;}catch{return null;}};
const sourceFields=['operation','provider','expectedRevision','baseUrl','api','credential','models'];
const modelFields=['id','name','reasoning','contextWindow'];

export function validateApiSource(p){
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!sourceFields.includes(k)))fail('源配置字段无效。');
 const operation=p.operation==='create'||p.operation==='update'?p.operation:null;
 if(!operation)fail('请选择新增或更新源。');
 if(!text(p.provider,64)||!/^[-a-z0-9_.]+$/.test(p.provider)||['__proto__','constructor','prototype'].includes(p.provider))fail('Provider ID只能含小写字母、数字、点、横线和下划线。');
 if(operation==='update'&&!(Number.isInteger(p.expectedRevision)&&p.expectedRevision>=1))fail('缺少源修订号；请刷新源列表后重试。');
 if(operation==='create'&&p.expectedRevision!==undefined)fail('新增源不需要修订号。');
 let url;try{url=new URL(p.baseUrl);}catch{fail('请输入有效API地址。');}
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||!text(p.baseUrl,2048))fail('API地址须为无凭据和查询参数的HTTP(S)地址。');
 if(!['openai-completions','openai-responses','anthropic-messages'].includes(p.api))fail('请选择支持的API协议。');
 if(!Array.isArray(p.models)||!p.models.length||p.models.length>100)fail('请提供1到100个模型。');
 const models=p.models.map(m=>{
  if(!m||typeof m!=='object'||Array.isArray(m)||Object.keys(m).some(k=>!modelFields.includes(k)))fail('模型配置字段无效。');
  if(!text(m.id,200)||m.id.trim()!==m.id||m.id.startsWith('!'))fail('请输入有效模型ID。');
  if(m.name!==undefined&&(!text(m.name,200)||m.name.trim()!==m.name))fail('模型名称无效。');
  if(m.reasoning!==undefined&&typeof m.reasoning!=='boolean')fail('模型思考能力声明无效。');
  if(m.contextWindow!==undefined&&(!Number.isInteger(m.contextWindow)||m.contextWindow<1024||m.contextWindow>10000000))fail('模型上下文窗口无效。');
  return {id:m.id,...(m.name?{name:m.name}:{}),...(m.reasoning!==undefined?{reasoning:m.reasoning}:{}),...(m.contextWindow?{contextWindow:m.contextWindow}:{})};
 });
 const seen=new Set();for(const m of models){if(seen.has(m.id))fail('模型ID重复：'+m.id);seen.add(m.id);}
 const credential=p.credential;
 if(!credential||typeof credential!=='object'||Array.isArray(credential)||Object.keys(credential).some(k=>!['action','value','confirmNewOrigin'].includes(k)))fail('凭据操作无效。');
 if(credential.action==='replace'){
  if(!text(credential.value,16384)||credential.value.trim()!==credential.value)fail('请输入有效API密钥。');
 }else if(credential.action==='keep'){
  if(credential.value!==undefined)fail('保留密钥时不能同时提交新密钥；替换请清空后输入。');
  if(operation==='create')fail('新增源必须输入API密钥。');
 }else fail('凭据操作无效。');
 return {operation,provider:p.provider,baseUrl:url.href.replace(/\/+$/,''),api:p.api,...(p.expectedRevision!==undefined?{expectedRevision:p.expectedRevision}:{}),credential:{action:credential.action,...(credential.action==='replace'?{value:credential.value}:{}),...(credential.confirmNewOrigin===true?{confirmNewOrigin:true}:{})},models};
}

export function validateRoleDefaults(payload){
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>!roles.includes(k))||roles.some(role=>!payload[role]||typeof payload[role]!=='object'||Array.isArray(payload[role])))fail('三角色默认配置无效。');
 const value={};
 for(const role of roles){
  const entry=payload[role];
  if(Object.keys(entry).some(k=>!['model','thinking'].includes(k)))fail('三角色默认配置无效。');
  const model=entry.model??{mode:'native-default'};
  if(model.mode==='explicit'){
   if(Object.keys(model).some(k=>!['mode','selector'].includes(k))||!text(model.selector,300)||!model.selector.includes('/'))fail('所选模型无效。');
  }else if(model.mode!=='native-default'||Object.keys(model).some(k=>!['mode','selector'].includes(k)))fail('模型默认模式无效。');
  const thinking=entry.thinking??{mode:'native-default'};
  if(thinking.mode==='explicit'){
   if(Object.keys(thinking).some(k=>!['mode','level'].includes(k))||!THINKING_LEVELS.includes(thinking.level))fail('思考档位须为原生档位：'+THINKING_LEVELS.join('、')+'。');
  }else if(thinking.mode!=='native-default'||Object.keys(thinking).some(k=>!['mode','level'].includes(k)))fail('思考默认模式无效。');
  value[role]={model:{mode:model.mode,...(model.mode==='explicit'?{selector:model.selector}:{})},thinking:{mode:thinking.mode,...(thinking.mode==='explicit'?{level:thinking.level}:{})}};
 }
 return value;
}
const nativeDefaultEntry=()=>({model:{mode:'native-default'},thinking:{mode:'native-default'}});
function migrateRoleDefaults(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('全局模型配置无效，原文件已保留。');
 if(raw.schema===1){
  // schema 1 stored bare selector strings ('' meant "use Pi native default").
  const migrated={};
  const source=raw.roles&&typeof raw.roles==='object'&&!Array.isArray(raw.roles)?raw.roles:{};
  for(const role of roles){
   const legacy=source[role];
   migrated[role]=typeof legacy==='string'&&legacy?{model:{mode:'explicit',selector:legacy},thinking:{mode:'native-default'}}:nativeDefaultEntry();
  }
  return migrated;
 }
 if(raw.schema!==2||!raw.roles||typeof raw.roles!=='object'||Array.isArray(raw.roles))fail('全局模型配置无效，原文件已保留。');
 const value={};
 for(const role of roles)value[role]=raw.roles[role]??nativeDefaultEntry();
 return value;
}
async function atomic(file,value){const temp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,value,{flag:'wx',mode:0o600});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}}
async function optional(file,fallback){try{return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
async function readJson(file,fallback){try{return JSON.parse(await optional(file,fallback));}catch{return null;}}

export function loginDisplay(output){
 return output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').split('\n').filter(line=>{
  const value=line.trim();
  if(/^(?:https?:\/\/)/.test(value))return !/[\s"<>]/.test(value)&&value.length<8192;
  if(/token|secret|password|api.?key|credentials saved|logged in to/i.test(value))return false;
  return /^(?:Select a provider:|\d+\. |Enter number|Open this URL|Local shortcut|Paste the authorization|Enter |Please |Visit |User code|Code:|Waiting|Opening|You can|To authenticate)/i.test(value);
 }).join('\n');
}
export async function hasProviderReferences({storage,agentDir},provider){
 if(!storage||!text(provider,64))fail('Provider reference scan requires project storage and a provider ID');
 const matches=value=>typeof value==='string'&&value.startsWith(provider+'/');
 const bindingUses=value=>value?.provider===provider||matches(value?.model);
 async function walk(directory){
  const stat=await fs.lstat(directory).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!stat)return false;if(stat.isSymbolicLink()||!stat.isDirectory())return true;
  for(const entry of await fs.readdir(directory,{withFileTypes:true})){
   if(entry.isSymbolicLink())return true;
   const file=path.join(directory,entry.name);
   if(entry.isDirectory()){if(await walk(file))return true;}
   else if(entry.isFile()&&entry.name.endsWith('.jsonl')){
    const stream=createReadStream(file,{encoding:'utf8'}),lines=createInterface({input:stream,crlfDelay:Infinity});
    try{for await(const line of lines){if(!line.trim())continue;let row;try{row=JSON.parse(line);}catch{return true;}
     if(matches(row.model)||row.provider===provider||row.model?.provider===provider||row.message?.provider===provider||matches(row.message?.model))return true;
    }}finally{lines.close();stream.destroy();}
   }
  }
  return false;
 }
 // Missing/corrupt project authority cannot prove that a credential is unused.
 try{
  for(const project of await storage.list()){
   await storage.requireOnline(project.id);
   const roles=await storage.getLocal(project.id,'managed:bindings')??{};
   if(Object.values(roles).some(bindingUses))return true;
   for(const row of await storage.listProject(project.id,'managed_works')){
    if(bindingUses(row.value.binding)||bindingUses((await storage.getLocal(project.id,'managed:works:'+row.id))?.binding))return true;
   }
   if(await walk(path.join(await storage.localDirectory(project.id),'execution','agents')))return true;
  }
  if(agentDir&&await walk(path.join(agentDir,'sessions')))return true;
  return false;
 }catch{return true;}
}
const sanitizeLine=value=>String(value??'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,200);
function renderInteraction(interaction){
 const lines=[];
 if(interaction.kind==='url'&&text(interaction.url,8192)&&/^https?:\/\//.test(interaction.url))lines.push('Open this URL in your browser:',interaction.url);
 else if(interaction.kind==='select'&&Array.isArray(interaction.options)&&interaction.options.length){
  lines.push('Select a provider:');
  for(const option of interaction.options.slice(0,20))lines.push((option.index??option.position??lines.length)+'. '+sanitizeLine(option.label??option.name??option.id));
 }else{lines.push(sanitizeLine(interaction.message??interaction.prompt??'Continue the authorization flow in the official app.'));}
 return lines.join('\n');
}
function discoveryDTO(stored){
 if(!stored||typeof stored!=='object')return {status:'none'};
 const base={...(stored.protocol?{protocol:stored.protocol}:{})};
 if(stored.status==='succeeded'&&!stored.stale)return {status:'succeeded',...base,fetchedAt:stored.fetchedAt??null,models:stored.models??[]};
 if(stored.stale&&Array.isArray(stored.models)&&stored.models.length)return {status:'stale',...base,fetchedAt:stored.lastSucceededAt??stored.fetchedAt??null,models:stored.models,...(stored.error?{error:stored.error}:{})};
 if(stored.status==='unsupported')return {status:'unsupported',fetchedAt:stored.fetchedAt??null,...(stored.error?{error:stored.error}:{})};
 return {status:'failed',fetchedAt:stored.fetchedAt??null,...(stored.error?{error:stored.error}:{})};
}
function normalizeDiscoveryResult(result){
 if(!result||typeof result!=='object')return {status:'failed',protocol:null,fetchedAt:new Date().toISOString(),models:[],error:{code:'DISCOVERY_MALFORMED',message:'模型列表返回无法解析。'}};
 const models=(Array.isArray(result.models)?result.models:[]).filter(m=>m&&text(m.id,200)).slice(0,1000).map(m=>({id:m.id,...(text(m.name,200)?{name:m.name}:{}),metadataSource:'service'}));
 return {status:result.status==='succeeded'?'succeeded':result.status==='unsupported'?'unsupported':'failed',protocol:text(result.protocol,64)?result.protocol:null,fetchedAt:text(result.fetchedAt,64)?result.fetchedAt:new Date().toISOString(),models,...(result.error&&text(result.error.code,64)&&text(result.error.message,400)?{error:{code:result.error.code,message:result.error.message}}:{})};
}
export class ProviderSettings {
 constructor({source,worker=null,isReferenced=async()=>false,onDefaultsSaved=async()=>({applied:0,pending:0,failed:[],sessions:[]}),getModelSync=()=>({applied:0,pending:0,failed:[],sessions:[]}),onSourceSaved=null}={}){
  if(!source)throw Error('ProviderSettings requires the private Pi source.');
  Object.assign(this,{source,worker,isReferenced,onDefaultsSaved,getModelSync,onSourceSaved});this.queue=Promise.resolve();this.login=null;
 }
 serial(fn){const result=this.queue.then(fn);this.queue=result.catch(()=>{});return result;}
 get file(){return path.join(this.source.agentDir,'nozeli-role-defaults.json');}
 get revisionsFile(){return path.join(this.source.agentDir,'nozeli-source-revisions.json');}
 get discoveryFile(){return path.join(this.source.agentDir,'nozeli-source-discovery.json');}
 async defaults(){const raw=await readJson(this.file,'{"schema":2,"roles":{}}');return validateRoleDefaults(migrateRoleDefaults(raw));}
 async modelFor(role){if(!roles.includes(role))throw Error('unknown role');const entry=(await this.defaults())[role];return entry.model.mode==='explicit'?entry.model.selector:null;}
 async roleDefaultsFor(role){
  if(!roles.includes(role))throw Error('unknown role');
  const entry=(await this.defaults())[role];
  return {selector:entry.model.mode==='explicit'?entry.model.selector:null,effort:entry.thinking.mode==='explicit'?entry.thinking.level:null};
 }
 async readRevisions(){const value=await readJson(this.revisionsFile,'{"schema":1,"sources":{}}');if(!value||value.schema!==1||!value.sources||typeof value.sources!=='object')return {schema:1,sources:{}};return value;}
 async writeRevisions(value){await fs.mkdir(path.dirname(this.revisionsFile),{recursive:true,mode:0o700});await atomic(this.revisionsFile,JSON.stringify(value,null,2)+'\n');}
 async readDiscovery(){const value=await readJson(this.discoveryFile,'{"schema":1,"sources":{}}');if(!value||value.schema!==1||!value.sources||typeof value.sources!=='object')return {schema:1,sources:{}};return value;}
 async writeDiscovery(value){await fs.mkdir(path.dirname(this.discoveryFile),{recursive:true,mode:0o700});await atomic(this.discoveryFile,JSON.stringify(value,null,2)+'\n');}
 requireWorker(){if(!this.worker)throw unavailable();return this.worker;}
 safeUrl(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.search&&!u.hash?u.href:'';}catch{return '';}}
 async models(){
  // Catalog entries carry provenance and native capability metadata. A listed
  // model is never claimed to be inference-entitled: credential configuration
  // only means a key exists, and SDK availability is an offline status.
  const worker=this.requireWorker();
  const [catalog,providers]=await Promise.all([worker.request('models'),worker.request('providerList')]);
  const custom=new Map((providers?.providers??[]).map(entry=>[entry.provider,entry]));
  const list=new Map();
  for(const m of catalog?.models??[]){
   if(!text(m.provider,64)||!text(m.modelId,200))continue;
   const entry=custom.get(m.provider);
   const credentialConfigured=entry?entry.hasApiKey===true:m.authed===true;
   if(!credentialConfigured)continue;
   const selector=m.provider+'/'+m.modelId;
   const levels=Array.isArray(m.thinkingLevels)&&m.thinkingLevels.length?m.thinkingLevels:null;
   list.set(selector,{selector,provider:m.provider,id:m.modelId,name:text(m.name,300)?m.name:m.modelId,credentialConfigured,catalogSource:entry?'configured':'native',entitlement:'unknown',thinking:{supported:m.reasoning===true,levels,source:levels?'native-model-definition':entry?'configured-metadata':'native-model-definition'}});
  }
  return [...list.values()];
 }
 sourceSummary(entry,credential,revision,storedDiscovery){
  const models=(entry.models??[]).map(m=>m&&text(m.id,200)?{id:m.id,...(text(m.name,200)?{name:m.name}:{}),reasoning:m.reasoning===true?true:m.reasoning===false?false:null,metadataSource:'configured'}:null).filter(Boolean);
  const oauth=credential?.type==='oauth'&&credential.hasAuth!==false;
  const keyConfigured=entry.hasApiKey===true||credential?.hasAuth===true;
  return {provider:entry.provider,revision,type:oauth?'oauth':'api',baseUrl:this.safeUrl(entry.baseUrl),...(entry.api?{api:entry.api}:{}),credential:{configured:keyConfigured,kind:oauth?'oauth':keyConfigured?'api-key':'none'},models,discovery:discoveryDTO(storedDiscovery)};
 }
 async status(){await this.queue;const worker=this.requireWorker();
  const [credentials,providers,models,defaults,revisions,discovery]=await Promise.all([worker.request('authList'),worker.request('providerList'),this.models(),this.defaults(),this.readRevisions(),this.readDiscovery()]);
  const credentialBy=new Map((credentials?.credentials??[]).map(c=>[c.provider,c]));
  const sources=new Map();
  for(const entry of providers?.providers??[]){if(!text(entry.provider,64))continue;sources.set(entry.provider,this.sourceSummary(entry,credentialBy.get(entry.provider),revisions.sources[entry.provider]?.revision??1,discovery.sources[entry.provider]));}
  for(const [provider,credential] of credentialBy){
   if(credential.hasAuth===false||sources.has(provider))continue;
   sources.set(provider,{provider,revision:revisions.sources[provider]?.revision??1,type:credential.type==='oauth'?'oauth':'api',baseUrl:'',credential:{configured:true,kind:credential.type==='oauth'?'oauth':'api-key'},models:[],discovery:discoveryDTO(discovery.sources[provider])});
  }
  const configured=models.length;
  return {sources:[...sources.values()],models,defaults,modelSync:await this.getModelSync(),login:this.loginStatus(),notice:configured?`目录模型 ${models.length} 个（手动配置/内置目录；凭据已配置不代表服务端授权）。保存默认模型后同步在线角色；忙会话在当前回合结束后应用，原会话身份保持。`:'尚无已配置凭据的目录模型：请登录账号、配置API源或刷新。凭据可用不代表服务端授权任何模型。'};
 }
 saveApi(payload){const p=validateApiSource(payload);return this.serial(async()=>{
  const worker=this.requireWorker();
  // Revision validation, credential resolution and the revision bump all live
  // inside this serialized section; the trusted worker resolves a retained
  // key against the very record it replaces.
  const revisions=await this.readRevisions();
  const [credentials,providers]=await Promise.all([worker.request('authList'),worker.request('providerList')]);
  const existing=(providers?.providers??[]).find(e=>e.provider===p.provider);
  if(p.operation==='create'){
   if(existing)fail('此Provider已有配置；请使用编辑或新的源ID，避免覆盖现有会话。');
   if((credentials?.credentials??[]).some(e=>e.provider===p.provider&&e.hasAuth!==false))fail('此Provider已有凭据；请使用新的源ID。');
  }else{
   if(!existing)fail('此源不存在；请刷新源列表后重试。');
   let current=revisions.sources[p.provider]?.revision;
   if(!Number.isInteger(current)){
    // Sources created before revisions existed adopt the revision status()
    // already reports, inside this same serialized boundary; later saves
    // advance from that initialized value.
    current=1;
    revisions.sources[p.provider]={revision:1,updatedAt:new Date().toISOString(),initializedFrom:'pre-existing-source'};
   }
   if(p.expectedRevision!==current)fail('此源已被其他修改更新；请刷新后重试，不覆盖他人改动。');
   if(p.credential.action==='keep'&&originOf(existing.baseUrl)!==originOf(p.baseUrl)&&p.credential.confirmNewOrigin!==true)fail('API地址来源已变化；保留原密钥复用到新地址需明确确认，或改为输入新密钥。');
  }
  await worker.request('providerUpsert',{provider:p.provider,baseUrl:p.baseUrl,api:p.api,...(p.credential.action==='replace'?{apiKey:p.credential.value}:{preserveApiKey:true,...(p.credential.confirmNewOrigin===true?{confirmNewOrigin:true}:{})}),models:p.models});
  const revision=(revisions.sources[p.provider]?.revision??0)+1;
  revisions.sources[p.provider]={revision,updatedAt:new Date().toISOString()};
  await this.writeRevisions(revisions);
  const discovery=await this.readDiscovery();
  const stored=discovery.sources[p.provider];
  if(stored&&stored.status==='succeeded'&&!stored.stale){stored.stale=true;stored.lastSucceededAt=stored.fetchedAt;stored.revision=revision;await this.writeDiscovery(discovery);}
  let application={applied:0,pending:0,failed:[],sessions:[]};
  if(this.onSourceSaved){
   try{application=await this.onSourceSaved(p.provider,{revision})??application;}
   catch{
    // Persistence succeeded; report that live application could not be
    // confirmed instead of swallowing it behind saved:true.
    application={applied:0,pending:0,failed:[{message:'源已保存，但未能确认在线Agent已刷新；原会话保持，可重试保存源。',code:'PI_PROVIDER_APPLY_UNKNOWN'}],sessions:[]};
   }
  }
  const [afterProviders,afterCredentials,afterDiscovery]=await Promise.all([worker.request('providerList'),worker.request('authList'),this.readDiscovery()]);
  const saved=(afterProviders?.providers??[]).find(e=>e.provider===p.provider);
  if(!saved)fail('源保存后未出现在私有目录中；请刷新。');
  return {saved:true,revision,source:this.sourceSummary(saved,(afterCredentials?.credentials??[]).find(c=>c.provider===p.provider),revision,afterDiscovery.sources[p.provider]),application};
 });}
 saveDefaults(payload){
  const value=validateRoleDefaults(payload);
  return this.serial(async()=>{
   const models=await this.models();
   const current=await this.defaults();
   for(const role of roles){
    const model=value[role].model;
    // Only changed selections are validated against the live catalog; an
    // unchanged stored default stays preservable even when the catalog
    // currently cannot list it.
    if(model.mode==='explicit'&&model.selector!==current[role].model.selector&&!models.some(m=>m.selector===model.selector))fail('所选模型不在当前已配置Pi目录中，请刷新。');
   }
   await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
   await atomic(this.file,JSON.stringify({schema:2,roles:value},null,2)+'\n');
   return {saved:true,modelSync:await this.onDefaultsSaved(value)};
  });
 }
 async discover(payload){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('发现请求无效。');
  if(payload.provider!==undefined){
   if(!text(payload.provider,64)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(payload.provider)||!Number.isInteger(payload.expectedRevision))fail('发现请求无效。');
   return this.serial(async()=>{
    const worker=this.requireWorker();
    const revisions=await this.readRevisions();
    const current=revisions.sources[payload.provider]?.revision;
    if(!Number.isInteger(current))fail('此源尚未保存；请先保存源后再发现模型。');
    if(payload.expectedRevision!==current)fail('此源已被其他修改更新；请刷新后重试。');
    const normalized=normalizeDiscoveryResult(await worker.request('providerDiscover',{provider:payload.provider},{timeoutMs:40000}));
    const discovery=await this.readDiscovery();
    const previous=discovery.sources[payload.provider];
    if(normalized.status==='succeeded'){
     discovery.sources[payload.provider]={status:'succeeded',protocol:normalized.protocol,fetchedAt:normalized.fetchedAt,models:normalized.models,stale:false,revision:current};
    }else{
    const kept=Array.isArray(previous?.models)&&previous.models.length?{models:previous.models,lastSucceededAt:previous.lastSucceededAt??previous.fetchedAt,stale:true}:{};
    discovery.sources[payload.provider]={status:normalized.status,protocol:normalized.protocol,fetchedAt:normalized.fetchedAt,...kept,...(normalized.error?{error:normalized.error}:{})};
    }
    await this.writeDiscovery(discovery);
    return {...normalized,entitlement:'unknown',provider:payload.provider,sourceRevision:current};
   });
  }
  // Draft discovery: the key is write-only for this one bounded listing
  // request and is never stored or echoed.
  if(Object.keys(payload).some(k=>!['baseUrl','api','credential'].includes(k))||!text(payload.baseUrl,2048))fail('草稿发现请求无效。');
  const credential=payload.credential;
  if(!credential||typeof credential!=='object'||credential.action!=='replace'||!text(credential.value,16384))fail('草稿发现需要一次性API密钥。');
  let url;try{url=new URL(payload.baseUrl);}catch{fail('请输入有效API地址。');}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)fail('API地址须为无凭据和查询参数的HTTP(S)地址。');
  if(!['openai-completions','openai-responses','anthropic-messages'].includes(payload.api??'openai-completions'))fail('请选择支持的API协议。');
  return this.serial(async()=>{
   const worker=this.requireWorker();
   const normalized=normalizeDiscoveryResult(await worker.request('providerDiscover',{baseUrl:url.href.replace(/\/+$/,''),api:payload.api??'openai-completions',apiKey:credential.value},{timeoutMs:40000}));
   return {...normalized,entitlement:'unknown',draftToken:randomUUID()};
  });
 }
 remove(payload){if(!payload||Object.keys(payload).some(k=>!['provider','confirm'].includes(k))||!text(payload.provider,64)||payload.confirm!==payload.provider)fail('请输入完整源ID确认移除。');return this.serial(async()=>{
  const provider=payload.provider;const defaults=await this.defaults();
  if(Object.values(defaults).some(s=>s.model.mode==='explicit'&&s.model.selector.startsWith(provider+'/'))||await this.isReferenced(provider))fail('此源仍被全局默认或已有会话引用，未移除。请先解除引用。');
  const worker=this.requireWorker();
  const credentials=await worker.request('authList');
  if((credentials?.credentials??[]).some(e=>e.provider===provider))await worker.request('authDisable',{provider});
  await worker.request('providerRemove',{provider});
  const [revisions,discovery]=await Promise.all([this.readRevisions(),this.readDiscovery()]);
  delete revisions.sources[provider];delete discovery.sources[provider];
  await Promise.all([this.writeRevisions(revisions),this.writeDiscovery(discovery)]);
  return {removed:true};});}
 loginStatus(){if(!this.login)return null;const {id,state,output}=this.login;return {id,state,output};}
 async loginProviders(){
  const worker=this.requireWorker();
  const credentials=await worker.request('authList');
  return (credentials?.credentials??[]).filter(row=>row.oauthSupported===true).map(row=>({id:row.provider,name:text(row.name,200)?row.name:row.provider}));
 }
 async startLogin(payload){
  if(!payload||Object.keys(payload).some(k=>k!=='provider')||payload.provider!==undefined&&(!text(payload.provider,64)||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(payload.provider)))fail('登录Provider无效。');
  if(this.login?.state==='running')fail('已有登录流程，请完成或取消。');
  const worker=this.requireWorker();await worker.acquire();
  const login={id:randomUUID(),state:'running',output:'',provider:payload.provider??null,pending:null,cleanup:null};
  this.login=login;
  login.timer=setTimeout(()=>{if(login.state!=='running')return;login.state='expired';login.pending=null;login.output='登录超时，已取消。';void worker.request('cancel',{}).catch(()=>{});},10*60*1000); // cleanup runs via the authLogin settlement below
  const onInteraction=interaction=>{
   if(login.state!=='running')return;
   if(login.provider&&interaction.provider&&interaction.provider!==login.provider)return;
   if(!interaction||typeof interaction.id!=='string')return;
   login.pending=interaction.kind==='url'?null:{...interaction};
   login.output=loginDisplay(renderInteraction(interaction))||'Waiting for authorization…';
  };
  const onStatus=status=>{
   if(login.state!=='running')return;
   if(status?.state==='done'){login.state='complete';login.pending=null;login.output=login.output||'登录完成。';}
   else if(status?.state==='error'){login.state='failed';login.pending=null;login.output='登录未完成。请重试；凭据和错误详情未回传。';}
   else return;
   login.cleanup?.();login.cleanup=null;
  };
  worker.events.on('interaction',onInteraction);worker.events.on('authStatus',onStatus);
  login.cleanup=()=>{clearTimeout(login.timer);worker.events.off('interaction',onInteraction);worker.events.off('authStatus',onStatus);};
  void worker.request('authLogin',login.provider?{provider:login.provider}:{},{timeoutMs:10*60*1000+15000})
   .then(()=>{if(login.state==='running'){login.state='complete';login.pending=null;login.output=login.output||'登录完成。';}})
   .catch(()=>{if(login.state==='running'){login.state='failed';login.pending=null;login.output='登录未完成。请重试；凭据和错误详情未回传。';}})
   .finally(()=>{login.cleanup?.();login.cleanup=null;});
  return this.loginStatus();
 }
 inputLogin(p){
  if(!p||Object.keys(p).some(k=>!['id','text'].includes(k))||p.id!==this.login?.id||this.login.state!=='running'||typeof p.text!=='string'||p.text.length>8192||/[\x00-\x1f\x7f]/.test(p.text))fail('登录输入无效或流程已结束。');
  const pending=this.login.pending;
  if(!pending||pending.kind==='url')fail('登录输入无效或流程已结束。');
  let value=p.text;
  if(pending.kind==='select'&&Array.isArray(pending.options)&&pending.options.length){
   const index=Number(p.text);
   const option=Number.isInteger(index)&&index>=1&&index<=pending.options.length?pending.options[index-1]:pending.options.find(option=>option.id===p.text);
   if(!option||typeof option.id!=='string')fail('请输入列表序号或选项ID。');
   value=option.id;
  }
  this.login.pending=null;
  void this.worker.respond(pending.id,{text:value}).catch(()=>{});
  return {sent:true};
 }
 async cancelLogin(p){
  if(!p||Object.keys(p).some(k=>k!=='id')||p.id!==this.login?.id)fail('登录流程无效。');
  this.login.state='cancelled';this.login.pending=null;this.login.output='登录已取消。';
  this.login.cleanup?.();this.login.cleanup=null;clearTimeout(this.login.timer);
  await this.worker.request('cancel',{}).catch(()=>{});
  return this.loginStatus();
 }
 async stop(){
  if(this.login){
   this.login.cleanup?.();this.login.cleanup=null;clearTimeout(this.login.timer);
   this.login.state='cancelled';this.login=null;
  }
  await this.worker?.stop();
 }
}
