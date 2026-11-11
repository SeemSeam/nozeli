// Explicit, one-time OMP static API import. Never runs during application startup.
// No inference requests, OAuth import, command credentials or secret output.
import fs from 'node:fs/promises';
import path from 'node:path';
import {parse} from 'yaml';
import {resolveSystemOmpSource} from '../src/agents/managed/omp-system-source.mjs';
import {resolveNozeliPaths,initializeNozeliConfiguration,completeNozeliConfiguration,readNozeliConfiguration} from '../src/agents/managed/nozeli-config.mjs';
import {platformPersistence} from '../src/platform/shared/persistence.mjs';

const flags=new Set(process.argv.slice(2));
if([...flags].some(flag=>!['--apply','--discover','--adopt-default'].includes(flag)))throw Error('usage: node tools/import-omp-api.mjs [--discover] [--apply] [--adopt-default]');
const fail=message=>{throw Error(message);};
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const secret=value=>typeof value==='string'&&value.trim()===value&&value.length>0&&value.length<=16384&&!/[\x00-\x1f\x7f]/.test(value)&&!value.startsWith('!')&&!/^[A-Z][A-Z0-9_]*$/.test(value);
async function readFile(file){try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>8*1024*1024)fail('Unsafe or oversized configuration file (contents redacted)');return await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function yaml(names,dir){const docs=[];for(const name of names){const text=await readFile(path.join(dir,name));if(text===null)continue;try{const value=parse(text);if(!plain(value))throw Error();docs.push(value);}catch{fail('Invalid OMP YAML (contents redacted)');}}return Object.assign({},...docs);}
async function json(file,fallback){const text=await readFile(file);if(text===null)return fallback;try{return JSON.parse(text);}catch{fail('Invalid Nozeli JSON; no import performed (contents redacted)');}}
async function listModels(provider){
 const url=new URL(provider.baseUrl);url.pathname=url.pathname.replace(/\/$/,'')+'/models';
 try{const response=await fetch(url,{headers:{authorization:'Bearer '+provider.apiKey},redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)return {status:response.status,models:[]};
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024)throw Error();chunks.push(chunk);}
  const body=JSON.parse(Buffer.concat(chunks).toString()),rows=body.data??body.models;if(!Array.isArray(rows)||rows.length>1000)throw Error();
  return {status:200,models:rows.filter(m=>plain(m)&&typeof m.id==='string'&&m.id.length>0&&m.id.length<=200&&!/[\x00-\x1f\x7f]/.test(m.id)).map(m=>({id:m.id,...(typeof m.name==='string'&&m.name.length<=200?{name:m.name}:{})}))};
 }catch{return {status:'unavailable',models:[]};}
}
try{
 const source=resolveSystemOmpSource(),paths=resolveNozeliPaths();
 if(await fs.realpath(source.agentDir)!==path.resolve(source.agentDir))fail('OMP source must be canonical');
 const rel=path.relative(source.agentDir,paths.root),back=path.relative(paths.root,source.agentDir);if(!rel.startsWith('..')||!back.startsWith('..'))fail('Source and destination overlap');
 const config=await yaml(['config.yml','config.yaml'],source.agentDir),sourceModels=await yaml(['models.yml','models.yaml'],source.agentDir);
 const selected=typeof config.modelRoles?.default==='string'?config.modelRoles.default:null;
 const imports={},summary=[];
 for(const [id,p]of Object.entries(sourceModels.providers??{})){
  if(!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(id)||['__proto__','constructor','prototype'].includes(id)||!plain(p)){summary.push({provider:id,status:'skipped-invalid-provider'});continue;}
  if(!secret(p.apiKey)){summary.push({provider:id,status:'skipped-nonstatic-key'});continue;}
  if(!['openai-completions','openai-responses','anthropic-messages'].includes(p.api)){summary.push({provider:id,status:'skipped-unsupported-api'});continue;}
  let url;try{url=new URL(p.baseUrl);}catch{summary.push({provider:id,status:'skipped-invalid-url'});continue;}
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash){summary.push({provider:id,status:'skipped-unsafe-url'});continue;}
  const provider={baseUrl:p.baseUrl,api:p.api,apiKey:p.apiKey,authHeader:true,piGuiCustomEndpoint:true};
  const compat={};for(const key of ['supportsStore','supportsDeveloperRole','supportsReasoningEffort','supportsUsageInStreaming'])if(typeof p.compat?.[key]==='boolean')compat[key]=p.compat[key];if(Object.keys(compat).length)provider.compat=compat;
  let models=Array.isArray(p.models)?p.models.filter(m=>plain(m)&&typeof m.id==='string').map(m=>({id:m.id,...(typeof m.name==='string'?{name:m.name}:{}),...(typeof m.reasoning==='boolean'?{reasoning:m.reasoning}:{}),...(Array.isArray(m.input)&&m.input.length&&m.input.every(kind=>['text','image'].includes(kind))?{input:[...new Set(m.input)]}:{}),...(Number.isSafeInteger(m.contextWindow)&&m.contextWindow>0?{contextWindow:m.contextWindow}:{}),...(Number.isSafeInteger(m.maxTokens)&&m.maxTokens>0?{maxTokens:m.maxTokens}:{})})):[ ];
  let listing='not-requested';if(flags.has('--discover')){const discovered=await listModels(provider);listing=discovered.status;if(discovered.status!==200){summary.push({provider:id,status:'skipped-listing-failed',listing});continue;}const byId=new Map(models.map(m=>[m.id,m]));for(const m of discovered.models)if(!byId.has(m.id))byId.set(m.id,m);models=[...byId.values()];}
  if(!models.length&&selected?.startsWith(id+'/'))models=[{id:selected.slice(id.length+1)}];
  if(!models.length){summary.push({provider:id,status:'skipped-no-models',listing});continue;}
  provider.models=models;imports[id]=provider;summary.push({provider:id,status:'ready',api:provider.api,baseUrl:provider.baseUrl,models:models.map(m=>m.id),listing});
 }
 if(!Object.keys(imports).length)fail('No eligible static API sources; destination unchanged');
 const adopt=flags.has('--adopt-default');if(adopt&&(!selected||!Object.entries(imports).some(([id,p])=>p.models.some(m=>id+'/'+m.id===selected))))fail('OMP default model is not in the verified import; defaults unchanged');
 const target=path.join(paths.root,'pi'),modelsFile=path.join(target,'models.json'),defaultsFile=path.join(target,'nozeli-role-defaults.json');
 if(flags.has('--apply')){
  await initializeNozeliConfiguration(paths);
  await fs.mkdir(target,{recursive:true,mode:0o700});if(await fs.realpath(target)!==target)fail('Nozeli Pi root must be canonical');
  const lock=path.join(target,'.omp-api-import.lock');let handle;try{handle=await fs.open(lock,'wx',0o600);}catch{fail('Another import is active; destination unchanged');}
  try{
   const before=await readFile(modelsFile),data=before===null?{providers:{}}:await json(modelsFile,null);if(!plain(data)||!plain(data.providers??{}))fail('Invalid existing models configuration');data.providers??={};
   for(const [id,p]of Object.entries(imports)){if(Object.hasOwn(data.providers,id)&&JSON.stringify(data.providers[id])!==JSON.stringify(p))fail('Existing Nozeli provider conflicts; refusing overwrite: '+id);data.providers[id]=p;}
   const defaults=adopt?{schema:2,roles:Object.fromEntries(['frontdesk','orchestrator','worker'].map(role=>[role,{model:{mode:'explicit',selector:selected},thinking:{mode:'native-default'}}]))}:null;
   if(await readFile(modelsFile)!==before)fail('Nozeli models changed concurrently; refusing overwrite');
   await platformPersistence.writeAtomic(modelsFile,JSON.stringify(data,null,2)+'\n');
   if(defaults)await platformPersistence.writeAtomic(defaultsFile,JSON.stringify(defaults,null,2)+'\n');
   if(!(await readNozeliConfiguration(paths)).initialized)await completeNozeliConfiguration(paths,{choice:'independent'});
   for(const file of [modelsFile,...(defaults?[defaultsFile]:[])])if((await fs.stat(file)).mode&0o077)fail('Private configuration permissions are not 0600');
  }finally{await handle.close();await fs.unlink(lock);}
 }
 console.log(JSON.stringify({applied:flags.has('--apply'),source:source.agentDir,destination:target,providers:summary,defaultModel:adopt?selected:null,credentialValues:'redacted',inferenceRequests:0,notice:'Restart Nozeli to load the imported private Pi configuration. OAuth/command keys were not imported; a listed model does not prove inference authorization.'},null,2));
}catch{console.error('OMP API import did not complete. Configuration/credential details redacted; source was not modified. Resolve conflicting or unsupported private configuration before retrying.');process.exitCode=1;}
