import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {processStamp} from './process-ownership.mjs';
import {reapOwnedPiGroup} from './pi-process-ownership.mjs';
import {scrubProviderEnv} from './omp-credentials.mjs';
import {isolatedLaunch} from './process-isolation.mjs';

const defaultEntry=fileURLToPath(new URL('../../../../../integrations/pi/src/owner.mjs',import.meta.url));
const fail=(code,message)=>Object.assign(Error(message),{code});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const modelSelector=value=>typeof value==='string'?value:value?.provider&&value?.modelId?value.provider+'/'+value.modelId:null;

/** One host-owned Pi process per role. Only the Host submits admitted inputs. */
export class PiSession extends EventEmitter {
 constructor(spec){
  super();this.spec=spec;this.home=spec.home;this.cwd=spec.cwd;this.role=spec.role;
  this.tools=spec.tools??[];this.toolsDigest=digest(this.tools);this.viewOwnerId=spec.nativeContext?.ownerId??randomUUID();
  this.epoch=randomUUID();this.pending=new Map();this.inFlightToolCalls=new Map();this.toolAdmissions=new Map();
  this.nativeDrain=Promise.resolve();this.nativeError=null;this.closed=false;this.busy=false;
  this.phase='new';this.model=spec.model??null;this.effort=spec.effort??null;this.interactions=[];
  this.hasPrompted=false;this.agentEnds=[];this.configurationStatus='unconfigured';
  this.thinkingLevels=null;this.admissionTail=Promise.resolve();
  this.capabilities={terminal:false,model:true,thinkingLevel:true,reload:true,compact:true,diagnostics:true};
 }
 get metadataFile(){return path.join(this.home,'nozeli-session-tools.json');}
 async preflightToolsDigest(expected){
  let saved;try{saved=JSON.parse(await fs.readFile(this.metadataFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(saved){this.sessionFile=saved.sessionFile;this.pinnedThreadId=saved.threadId;}
  if(expected!==this.toolsDigest||saved&&saved.toolsDigest!==this.toolsDigest)throw fail('PI_TOOLS_DIGEST_MISMATCH','Pi session tool schema changed; explicit context handoff required');
  return {equivalent:true,toolsDigest:this.toolsDigest};
 }
 assertToolsDigest(expected){return this.preflightToolsDigest(expected);}
 async saveMetadata(){
  const temp=this.metadataFile+'.'+randomUUID()+'.tmp';
  const handle=await fs.open(temp,'wx',0o600);
  try{await handle.writeFile(JSON.stringify({schema:1,threadId:this.threadId,sessionFile:this.sessionFile,toolsDigest:this.toolsDigest}));await handle.sync();}finally{await handle.close();}
  await fs.rename(temp,this.metadataFile);
 }
 write(value){
  if(!this.child?.stdin?.writable)throw fail('PI_RUNTIME_CLOSED','Pi runtime input closed');
  this.child.stdin.write(JSON.stringify(value)+'\n');
 }
 request(method,params={},timeout=30000){
  if(this.closed)return Promise.reject(fail('PI_RUNTIME_CLOSED','Pi session closed'));
  const id=randomUUID();
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(fail('PI_REQUEST_TIMEOUT','Pi '+method+' acknowledgement timed out; no automatic replay'));},timeout);
   this.pending.set(id,{resolve,reject,timer});
   try{this.write({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
  });
 }
 enqueueNative(fn){
  const operation=this.nativeDrain.then(fn);
  this.nativeDrain=operation.catch(error=>{this.nativeError??=error;this.emit('projection-error',error);});
 }
 receive(line){
  let message;try{message=JSON.parse(line);}catch{this.protocolError=fail('PI_PROTOCOL_INVALID','Invalid Pi runtime JSONL frame');this.child?.kill();return;}
  if(message.event==='tool'){this.handleTool(message).catch(error=>{this.nativeError??=error;});return;}
  if(message.event==='tool-cancel'){
   const admission=this.toolAdmissions.get(message.id);
   if(admission&&message.requestId===this.current?.requestId){admission.cancelled=true;admission.cancelReason='native-tool-aborted';this.current.cancelled=true;}
   return;
  }
  if(message.event==='interaction_closed'){
   this.interactions=this.interactions.filter(value=>value.id!==message.interaction?.id);
   this.emit('interaction-closed',message.interaction);this.emit('change');return;
  }
  if(message.event==='entry'){
   const current=this.current;
   const fact={sessionId:message.sessionId??this.threadId,epoch:this.epoch,entry:message.entry,...(message.requestId?{requestId:message.requestId,jobId:message.jobId??current?.job?.id}:{}),...(message.streamId?{streamId:message.streamId}:{})};
   this.enqueueNative(()=>this.spec.onNativeEntry?.(fact));return;
  }
  if(message.event==='admitted'){
   const current=this.current;
   if(current&&message.requestId===current.requestId)this.enqueueNative(()=>this.transport('admitted',current));
   return;
  }
  if(message.event==='native'){
   const event=message.eventData;
   if(event?.type==='agent_end')this.agentEnds.push(event);
   const current=this.current;
   const fact={sessionId:message.sessionId??this.threadId,epoch:this.epoch,requestId:current?.requestId,jobId:current?.job?.id,streamId:event?.streamId,event};
   this.enqueueNative(()=>this.spec.onNativeEvent?.(fact));
   this.emit('event',event);return;
  }
  if(message.event==='interaction'){
   this.interactions.push(message.interaction);this.emit('interaction',message.interaction);return;
  }
  const waiting=this.pending.get(message.id);if(!waiting)return;
  clearTimeout(waiting.timer);this.pending.delete(message.id);
  if(message.error)waiting.reject(fail(message.error.code??'PI_RUNTIME_ERROR',message.error.message??'Pi runtime request failed'));
  else waiting.resolve(message.result);
 }
 async start(resumeId){
  if(this.child)throw fail('PI_OWNER_EXISTS','Pi session already owns a process');
  await fs.mkdir(this.home,{recursive:true,mode:0o700});
  const runtime=this.spec.piRuntime??{};
  if(!resumeId){
   // New sessions seed the role's configured defaults; resumed sessions keep
   // their own native model/thinking selection.
   const roleSeed=(await this.spec.piRuntime?.roleDefaultsFor?.(this.role))??{};
   this.model??=roleSeed.selector??null;
   this.effort=roleSeed.effort??this.spec.effort??null;
  }else this.model??=await runtime.modelFor?.(this.role)??null;
  this.phase='starting';
  const {env:baseEnv}=scrubProviderEnv(process.env);
  const env={...baseEnv,...runtime.env,ELECTRON_RUN_AS_NODE:'1',NOZELI_PI_OWNER_HOME:this.home,NOZELI_PI_OWNER_ID:this.viewOwnerId,PI_CODING_AGENT_DIR:runtime.agentDir??this.spec.piSystemSource?.agentDir??path.join(this.home,'config')};
  // Explicit private roots prevent ambient user Pi/OMP extensions and auth.
  const entry=runtime.entry??defaultEntry;
  let launch={command:runtime.command??process.execPath,args:[...(runtime.args??[]),entry],env:{}};
  if(this.spec.isolation){
   await fs.mkdir(env.PI_CODING_AGENT_DIR,{recursive:true,mode:0o700});
   const isolation=this.spec.isolation;
   launch=await isolatedLaunch({...launch,home:this.home,cwd:this.cwd,writable:[...(isolation.writable??[]),env.PI_CODING_AGENT_DIR],readOnly:isolation.readOnly??[],readable:[...(isolation.readable??[]),path.resolve(path.dirname(entry),'..')]});
  }
  this.child=spawn(launch.command,launch.args,{cwd:this.cwd,env:{...env,...launch.env},detached:process.platform!=='win32',stdio:['pipe','pipe','pipe'],windowsHide:true});
  const child=this.child;
  this.exitPromise=new Promise(resolve=>{child.once('exit',(code,signal)=>{this.exit={code,signal};this.phase='exited';for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(this.protocolError??fail('PI_RUNTIME_EXITED','Pi owner exited before acknowledgement; input will not be replayed'));}this.pending.clear();resolve(this.exit);this.emit('exit',this.exit);});child.once('error',error=>{this.spawnError=error;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();resolve({error:error.message});});});
  createInterface({input:child.stdout,crlfDelay:Infinity}).on('line',line=>this.receive(line));
  this.diagnostics='';child.stderr.on('data',chunk=>{this.diagnostics=(this.diagnostics+chunk.toString()).slice(-16384);});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  this.pid=child.pid;this.groupRecord={pid:this.pid,home:this.home,ownerId:this.viewOwnerId,stamp:await processStamp(this.pid),kind:'pi-node'};
  await this.spec.onSpawn?.(this.pid);
  const result=await this.request('start',{cwd:this.cwd,home:this.home,agentDir:env.PI_CODING_AGENT_DIR,instructions:[this.spec.baseInstructions,this.spec.instructions].filter(Boolean).join('\n'),tools:this.tools,sessionId:resumeId,sessionFile:this.sessionFile,model:this.model,effort:this.effort,role:this.role},60000);
  this.threadId=result.sessionId;this.sessionFile=result.sessionFile;
  if(!this.threadId||resumeId&&this.threadId!==resumeId)throw fail('PI_SESSION_IDENTITY','Pi owner did not confirm exact original session identity');
  this.model=modelSelector(result.model)??this.model;this.effort=result.effort??this.effort;this.effective=result.effective;this.thinkingLevels=result.thinkingLevels??this.thinkingLevels;this.hasPrompted=result.hasPrompted===true;
  await this.saveMetadata();this.phase='idle';this.configurationStatus=this.model?'configured':'unconfigured';
  return {threadId:this.threadId,sessionFile:this.sessionFile};
 }
 async transport(status,current,extra={}){
  return this.spec.onTransportFact?.({status,kind:'prompt',sessionId:this.threadId,epoch:this.epoch,requestId:current.requestId,jobId:current.job.id,attempt:1,contentDigest:current.contentDigest,...extra});
 }
 async handleTool(message){
  const current=this.current;
  const admission={cancelled:current?.cancelled===true,cancelReason:null,preEffect:async()=>{
   await this.nativeDrain;
   if(!current||this.current!==current||current.cancelled||admission.cancelled||message.requestId!==current.requestId||this.stopping||this.nativeError)throw fail('PI_TOOL_STALE','Tool no longer belongs to the active admitted input');
   await this.spec.onBeforeAgentStart?.();
   if(current.cancelled||admission.cancelled||this.current!==current)throw fail('PI_TOOL_CANCELLED','Input cancelled before tool effect');
  }};
  this.toolAdmissions.set(message.id,admission);
  const operation=(async()=>{
   await admission.preEffect();
   const result=await this.spec.onTool?.({tool:message.tool,arguments:message.arguments??{},callId:message.callId??message.id,promptId:current.requestId,admission});
   if(current.cancelled||admission.cancelled)throw fail('PI_TOOL_CANCELLED','Input cancelled after tool execution; effect may have happened');
   if(this.spec.finishOnHostControl&&result?.continueTurn!==true&&result?.readOnly!==true&&message.tool!=='nozeli_inspect_work')current.hostControl=true;
   this.write({id:message.id,result});
  })();
  this.inFlightToolCalls.set(message.id,operation);
  try{await operation;}catch(error){try{this.write({id:message.id,error:{code:error.code??'HOST_TOOL_ERROR',message:error.message}});}catch{};}finally{this.inFlightToolCalls.delete(message.id);this.toolAdmissions.delete(message.id);}
 }
 // Shared admission queue: the NEXT slot is reserved synchronously at call
 // time, so two callers can never both pass the idle check and run
 // concurrently (a snapshot `await previous` alone is not serialization).
 beginAdmission(){
  const previous=this.admissionTail.catch(()=>{});
  let end;
  this.admissionTail=new Promise(resolve=>{end=resolve;});
  return {previous,end:()=>{try{end();}catch{}}};
 }
 async prompt(text,{timeout=600000,images=[],job}={}){
  if(this.busy||!job?.id)throw fail('PI_INPUT_ADMISSION','Pi prompt requires an idle owner and durable host job');
  if(this.nativeError)throw this.nativeError;
  const gate=this.beginAdmission();
  try{
   await gate.previous;
   if(this.busy||this.stopping)throw fail('PI_INPUT_ADMISSION','Pi prompt requires an idle owner and durable host job');
   const current={requestId:randomUUID(),job,contentDigest:digest({text,images}),cancelled:false,hostControl:false};
   this.current=current;this.busy=true;this.phase='prompt-inflight';
   try{
    const beforeAgentContext=await this.spec.onBeforeAgentStart?.();
    await this.transport('prepared',current);await this.transport('submitted',current);
    if(current.cancelled||this.stopping)throw fail('PI_INPUT_CANCELLED','Input cancelled before runtime submission');
    const result=await this.request('prompt',{text,images,requestId:current.requestId,job,beforeAgentContext},timeout);
    this.hasPrompted=true;await this.request('flush',{},30000);await this.nativeDrain;
    if(this.nativeError)throw this.nativeError;
    await Promise.all(this.inFlightToolCalls.values());
    await this.transport('settled',current);
    return {threadId:this.threadId,turnId:current.requestId,text:result.text??'',completion:current.hostControl?'host-control':result.completion??'provider-completed',providerStatus:current.cancelled?'cancelled':'completed',metrics:result.metrics,effective:result.effective??this.effective,projectedNative:true};
   }catch(error){await this.transport('unknown',current,{reason:error.code??error.message}).catch(()=>{});throw error;}
   finally{if(this.current===current){this.current=null;this.busy=false;this.phase=this.stopping?'stopping':'idle';}}
  }finally{gate.end();if(this.pendingModel!=null&&!this.stopping)await this.applyPendingModel();}
 }
 async interrupt(){const current=this.current;if(!current)return {stopped:false};current.cancelled=true;const receipt=await this.request('cancel',{requestId:current.requestId},30000);if(!receipt.stopped&&this.current===current)current.cancelled=false;await Promise.all(this.inFlightToolCalls.values());await this.nativeDrain;return receipt;}
 // Deferred configuration application runs after a settled turn/command. A
 // failure here must never convert the already-successful turn into a rejected
 // prompt: it stays visible through modelError/modelSync instead.
 async applyPendingModel(){
  const pending=this.pendingModel;
  if(pending==null)return;
  try{await this.applyDefaultModel(pending);}
  catch(error){this.modelError=error;this.emit('model-error',error);}
 }
 async applyDefaultModel(selection){
  const change=typeof selection==='string'?{selector:selection}:selection??{};
  if(change.clear===true||(!change.selector&&change.effort==null)){
   // Explicit clear: the latest desired configuration supersedes any queued
   // choice; no native change is claimed for the session's own selection.
   // Bumping the desired generation synchronously invalidates every
   // queued-but-not-yet-submitted change; an already submitted native
   // mutation keeps its own accurate report.
   this.pendingModel=null;this.desiredModel=null;
   this.desiredGeneration=(this.desiredGeneration??0)+1;
   return {state:'unchanged',cleared:true};
  }
  const selector=change.selector??this.desiredModel??this.model;
  if(!selector||!selector.includes('/'))return {state:'unchanged'};
  this.desiredModel=selector;
  const desired={selector,...(change.effort!=null?{effort:change.effort}:{}),...(change.refreshProvider===true?{refreshProvider:true}:{})};
  // Synchronous acceptance: this generation is what a later clear supersedes.
  const generation=this.desiredGeneration=(this.desiredGeneration??0)+1;
  if(this.busy){this.pendingModel=desired;return {state:'pending',desired};}
  const gate=this.beginAdmission();
  try{
   // Configuration runs under the same admission boundary as prompts, so a
   // model request can never mutate mid-admitted execution.
   await gate.previous;
   if(generation!==this.desiredGeneration)return {state:'cancelled',superseded:true,desired};
   if(this.busy||this.stopping){this.pendingModel=desired;return {state:'pending',desired};}
   const result=await this.request('model',{selector,...(desired.effort?{effort:desired.effort}:{}),...(desired.refreshProvider?{refreshProvider:true}:{})});
   this.model=modelSelector(result.model)??selector;this.effort=result.effort??this.effort;this.effective=result.effective??this.effective;this.thinkingLevels=result.thinkingLevels??this.thinkingLevels;
   this.pendingModel=null;this.modelError=null;this.emit('model-changed',result);
   return {state:'applied',effective:this.effective??{model:this.model,effort:this.effort},requested:desired.effort!=null?{effort:desired.effort}:null,clamped:result.clamped??null,thinkingLevels:this.thinkingLevels};
  }catch(error){this.modelError=error;throw error;}
  finally{gate.end();}
 }
 // Credential/source rotation: re-resolve the current selector so the session
 // picks up the rotated key at its safe idle boundary without a new session.
 // A concurrently queued desired model is preserved, only gaining the refresh.
 async refreshProviderSource(provider){
  if(!this.model||!this.model.startsWith(provider+'/'))return {state:'unchanged'};
  if(this.pendingModel){this.pendingModel={...this.pendingModel,refreshProvider:true};return {state:'pending',desired:this.pendingModel};}
  return this.applyDefaultModel({selector:this.model,...(this.effort?{effort:this.effort}:{}),refreshProvider:true});
 }
 async sessionCommand(method){
  if(this.busy||this.closed||this.stopping)throw fail('PI_BUSY','Session command requires the same idle owner');
  const gate=this.beginAdmission();
  try{
   await gate.previous;
   if(this.busy||this.closed||this.stopping)throw fail('PI_BUSY','Session command requires the same idle owner');
   this.busy=true;this.phase=method==='compact'?'compacting':'reloading';
   try{const result=await this.request(method,{},method==='compact'?600000:30000);await this.request('flush');await this.nativeDrain;if(this.nativeError)throw this.nativeError;return result;}
   finally{this.busy=false;this.phase=this.stopping?'stopping':'idle';}
  }finally{gate.end();if(this.pendingModel!=null&&!this.stopping)await this.applyPendingModel();}
 }
 reload(){return this.sessionCommand('reload');}
 compact(){return this.sessionCommand('compact');}
 async respondInteraction(id,answer,{cancel=false}={}){const result=await this.request('respond',{id,answer,cancel});this.interactions=this.interactions.filter(value=>value.id!==id);return result;}
 async stopIdle(){if(this.busy||this.inFlightToolCalls.size)throw fail('PI_BUSY','Cannot reclaim a busy Pi owner');return this.stop();}
 stop(){if(this.stopPromise)return this.stopPromise;this.stopPromise=this.stopOwner();return this.stopPromise;}
 async stopOwner(){
  this.stopping=true;
  if(!this.child){this.closed=true;return this.lastExitReceipt={confirmationComplete:true,reason:'never-spawned'};}
  if(this.current)this.current.cancelled=true;
  let persistenceError;
  if(this.child.exitCode===null&&this.child.signalCode===null){
   await this.request('stop',{},15000).catch(error=>{persistenceError=error;});
   const exited=await Promise.race([this.exitPromise,new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),3000);timer.unref();})]);
   if(!exited){try{process.platform==='win32'?this.child.kill():process.kill(-this.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}}
  }
  const result=await reapOwnedPiGroup(this.groupRecord);
  await this.exitPromise;await Promise.allSettled(this.inFlightToolCalls.values());await this.nativeDrain;
  this.lastExitReceipt={confirmationComplete:result.verified===true,exit:this.exit,...result};this.closed=result.verified===true;
  if(!this.closed)throw fail('PI_EXIT_UNCONFIRMED','Pi process-tree exit has not been verified on this platform');
  if(persistenceError||this.nativeError)throw Object.assign(fail('PI_PERSISTENCE_UNCONFIRMED','Pi owner exited but journal/projection persistence was not confirmed'),{cause:persistenceError??this.nativeError,exitReceipt:this.lastExitReceipt});
  return this.lastExitReceipt;
 }
}
