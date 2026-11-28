// Host-owned private model/config storage. SDK parsers, credential orchestration
// and persistent catalog semantics stay upstream. Raw bytes remain private.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {AsyncLocalStorage} from 'node:async_hooks';
import {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {windowsBridge} from './journal-io.mjs';
import {createReadEvidenceJournal} from './read-evidence-journal.mjs';
const sdkRoot=path.resolve(import.meta.dirname,'../node_modules/@earendil-works/pi-coding-agent');
const {AuthStorage}=await import(pathToFileURL(path.join(sdkRoot,'dist/core/auth-storage.js')));
const {ModelConfig}=await import(pathToFileURL(path.join(sdkRoot,'dist/core/model-config.js')));
const {FileModelsStore}=await import(pathToFileURL(path.join(sdkRoot,'dist/core/models-store.js')));
const fail=(code,message,cause)=>Object.assign(Error(message,{cause}),{code});
const missing=e=>e.code==='WIN32_IO_ERROR'&&e.win32Code===2;
const names=new Set(['models.json','auth.json','models-store.json']);
const limit=8*1024*1024;

export async function createOwnerModelAuthIO({agentDir,privateRoot=process.env.NOZELI_PI_PRIVATE_ROOT,directorySync=p=>p.syncDirectory(),beforeProviderRequest}={}){
 if(process.platform!=='win32'||!privateRoot)return null;
 const relative=path.relative(privateRoot,agentDir);
 if(!path.isAbsolute(privateRoot)||!path.isAbsolute(agentDir)||!relative||path.isAbsolute(relative)||relative.split(path.sep).includes('..'))
  throw fail('PI_MODEL_AUTH_SCOPE','Model/auth directory is outside the bound owner root');
 const native=await windowsBridge(),agentRelative=relative.split(path.sep).join('/'),streamId=randomUUID();
 let poisoned=null;
 const check=()=>{if(poisoned)throw poisoned;};
 const poison=cause=>poisoned??=fail('PI_MODEL_AUTH_UNCONFIRMED','Private model/auth storage requires reconciliation',cause);
 const openAgent=()=>native.openAnchoredPersistenceParent(privateRoot,agentRelative+'/__model_auth_anchor__');
 const evidence=createReadEvidenceJournal({openAgent,member:'model-auth-reads',streamId,schema:2,
  mechanism:'windows-native-model-auth-read-journal',directory:path.join(agentDir,'model-auth-reads'),byteLimit:limit,directorySync});
 const flushEvidence=()=>{check();try{evidence.flush();}catch(cause){throw poison(cause);}};
 const close=(resources,primary)=>{
  const errors=[];for(const resource of resources)try{resource?.close();}catch(e){errors.push(e);}
  if(errors.length){const error=poison(errors[0]);if(primary)primary.cleanupErrors=errors;else throw error;}
 };
 const boundedRead=file=>{
  const size=file.stat().size;if(size<0n||size>BigInt(limit))throw fail('PI_MODEL_AUTH_LIMIT','Private configuration exceeds 8 MiB');
  const chunks=[];for(let offset=0;offset<Number(size);){const b=file.readAt(offset,Math.min(262144,Number(size)-offset));if(!b.length)throw fail('PI_MODEL_AUTH_CHANGED','Private configuration truncated');chunks.push(b);offset+=b.length;}
  file.verify();return Buffer.concat(chunks,Number(size));
 };
 const writeChunks=(write,bytes)=>{for(let offset=0;offset<bytes.length;offset+=262144)write(bytes.subarray(offset,offset+262144));};
 function retain({name,parentIdentity,identity,bytes}){
  evidence.retain({name,path:path.join(agentDir,name),parentIdentity,fileIdentity:identity??null},bytes);
 }
 function observe(name){
  check();if(!names.has(name))throw fail('PI_MODEL_AUTH_SCOPE','Unsupported private configuration member');
  let parent,file,primary;
  try{
   parent=openAgent();const observation={name,parentIdentity:parent.identity(),bytes:null};
   try{file=parent.openPrivateObjectRead(name);}catch(error){if(!missing(error))throw error;}
   if(file){observation.bytes=boundedRead(file);observation.identity=file.stat().identity;}
   parent.verify();retain(observation);
   // Upstream credential reload can swallow parse failures and reuse cached
   // values. Validate before handing bytes over, without retaining V8 excerpts.
   if(observation.bytes!==null&&name!=='models.json'){
    const content=observation.bytes.toString('utf8').replace(/^\uFEFF/,'');
    if(content){
     let parsed;try{parsed=JSON.parse(content);}catch{throw fail('PI_MODEL_AUTH_INVALID','Invalid private configuration JSON');}
     if(parsed===null||typeof parsed!=='object'||Array.isArray(parsed))throw fail('PI_MODEL_AUTH_INVALID','Private configuration JSON must contain an object');
    }
   }
   return observation;
  }catch(cause){primary=poison(cause);throw primary;}finally{close([file,parent],primary);}
 }
 function write(observation,next){
  check();if(typeof next!=='string'||Buffer.byteLength(next)>limit)throw fail('PI_MODEL_AUTH_LIMIT','Private configuration candidate exceeds its bound');
  flushEvidence();
  let parent,transaction,stage,primary,published=false;
  try{
   parent=openAgent();if(parent.identity()!==observation.parentIdentity)throw fail('PI_MODEL_AUTH_CONFLICT','Private configuration directory changed');
   const bytes=Buffer.from(next);
   if(observation.bytes===null){stage=parent.createPrivateExclusive('.model-auth-'+randomUUID()+'.pending');writeChunks(chunk=>stage.write(chunk),bytes);stage.sync();stage.publishNew(observation.name);published=true;}
   else{
    transaction=parent.beginReplacement(observation.name);
    const stat=transaction.stat();
    if(stat.identity!==observation.identity||stat.size!==BigInt(observation.bytes.length))throw fail('PI_MODEL_AUTH_CONFLICT','Private configuration changed during callback; external version retained');
    for(let offset=0;offset<observation.bytes.length;){
     const chunk=transaction.readChunk(offset,Math.min(262144,observation.bytes.length-offset));
     if(!chunk.length||!chunk.equals(observation.bytes.subarray(offset,offset+chunk.length)))throw fail('PI_MODEL_AUTH_CONFLICT','Private configuration changed during callback; external version retained');
     offset+=chunk.length;
    }
    transaction.beginCandidate('.model-auth-'+randomUUID()+'.pending');
    writeChunks(chunk=>transaction.writeCandidate(chunk),bytes);transaction.finishCandidate();transaction.commit();published=true;
   }
   close([transaction,stage]);transaction=stage=null;directorySync(parent);parent.verify();
  }catch(cause){
   primary=cause;
   if(!published&&!cause.committed&&observation.bytes===null&&cause.code==='FS_TARGET_EXISTS')primary=fail('PI_MODEL_AUTH_CONFLICT','Private configuration appeared during callback; external version retained',cause);
   if(published||cause.committed||cause.transactionOutcome==='unknown'){primary=poison(cause);primary.committed=published||cause.committed===true;primary.transactionOutcome=cause.transactionOutcome;}
   throw primary;
  }finally{close([transaction,stage,parent],primary);}
 }
 const queues=new Map(),busy=new Set(),callbackContext=new AsyncLocalStorage();
 const contextFor=name=>{const inherited=new Map(callbackContext.getStore()),token={active:true};inherited.set(name,token);return {inherited,token};};
 const callbackResult=value=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.then==='function'||(value.next!==undefined&&typeof value.next!=='string'))
   throw new TypeError('Private configuration callback must return an object with an optional string next value');
  return value;
 };
 function storage(name){
  if(!names.has(name))throw fail('PI_MODEL_AUTH_SCOPE','Unsupported private configuration member');
  return Object.freeze({
   withLock(fn){
    check();if(busy.has(name)||queues.has(name))throw fail('PI_MODEL_AUTH_BUSY','An asynchronous private configuration callback is active or queued');
    busy.add(name);
    try{
     const observation=observe(name),{inherited,token}=contextFor(name);let value;
     try{value=callbackContext.run(inherited,()=>fn(observation.bytes?.toString('utf8')));}finally{token.active=false;}
     if(typeof value?.then==='function'){
      void Promise.resolve(value).catch(()=>{});
      throw new TypeError('Synchronous configuration callback returned a Promise');
     }
     callbackResult(value);check();if(value.next!==undefined)write(observation,value.next);return value.result;
    }finally{busy.delete(name);}
   },
   withLockAsync(fn,options){
    if(callbackContext.getStore()?.get(name)?.active)return Promise.reject(fail('PI_MODEL_AUTH_BUSY','Recursive private configuration acquisition is not permitted'));
    const run=async()=>{
     check();options?.signal?.throwIfAborted();busy.add(name);
     try{
      const observation=observe(name),{inherited,token}=contextFor(name);let value;
      try{value=callbackResult(await callbackContext.run(inherited,()=>fn(observation.bytes?.toString('utf8'))));}finally{token.active=false;}
      options?.signal?.throwIfAborted();check();if(value.next!==undefined)write(observation,value.next);return value.result;
     }finally{busy.delete(name);}
    };
    const previous=queues.get(name)??Promise.resolve(),operation=previous.then(run,run),settled=operation.catch(()=>{});
    queues.set(name,settled);void settled.then(()=>{if(queues.get(name)===settled)queues.delete(name);});return operation;
   },
  });
 }
 const guarded=target=>new Proxy(target,{get(object,key){const value=Reflect.get(object,key,object);if(typeof value!=='function')return value;
  return (...args)=>{check();const result=value.apply(object,args);check();return result?.then?result.then(v=>{check();return v;},cause=>{check();throw cause;}):result;};
 }});
 const loadModelConfig=async file=>{
  check();if(file!==path.join(agentDir,'models.json'))throw fail('PI_MODEL_AUTH_SCOPE','Unexpected model configuration path');
  const observation=observe('models.json');
  const config=await ModelConfig.load(file,async()=>observation.bytes===null?' {"providers":{}} ':observation.bytes.toString('utf8'));
  // SDK parse messages include V8 excerpts; schema messages include field names.
  // Preserve the invalid-config outcome, not content-derived diagnostics.
  return config.getError()?new ModelConfig(new Map(),'Invalid models.json schema or JSON; inspect the private configuration file locally'):config;
 };
 return Object.freeze({
  storage,
  readModels(){return observe('models.json').bytes?.toString('utf8');},
  async updateModels(fn){return storage('models.json').withLockAsync(fn);},
  createCredentials(){
   const credentials=AuthStorage.fromStorage(storage('auth.json'));
   const modify=credentials.modify.bind(credentials);
   // Pi refreshes OAuth credentials inside the locked modify callback.
   // Confirm the native read before the callback can contact the provider.
   credentials.modify=(provider,callback,options)=>modify(provider,current=>{
    options?.signal?.throwIfAborted();
    (beforeProviderRequest??flushEvidence)();
    return callback(current);
   },options);
   check();return guarded(credentials);
  },
  createModelsStore(){return guarded(new FileModelsStore(undefined,storage('models-store.json')));},
  async createModelRuntime(options={}){
   const runtime=await ModelRuntime.create({...options,authPath:path.join(agentDir,'auth.json'),modelsPath:path.join(agentDir,'models.json'),
    credentials:this.createCredentials(),modelsStore:this.createModelsStore(),loadModelConfig});
   // Pi 1.4.0 resolves request-time credentials here, immediately before
   // calling the provider adapter, including adapters that do not use fetch.
   const prepareRequest=runtime.prepareRequest.bind(runtime);
   runtime.prepareRequest=async (model,requestOptions)=>{
    const prepared=await prepareRequest(model,requestOptions);
    requestOptions?.signal?.throwIfAborted();
    (beforeProviderRequest??flushEvidence)();
    return prepared;
   };
   check();return guarded(runtime);
  },
  flush:flushEvidence,close:evidence.close,
  snapshot(){flushEvidence();return evidence.snapshot();},
 });
}
