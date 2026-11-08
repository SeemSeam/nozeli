import {EventEmitter} from 'node:events';
import {createInterface} from 'node:readline';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostProcessTree} from './process-ownership.mjs';
import {reapOwnedPiGroup} from './pi-process-ownership.mjs';
import {scrubProviderEnv} from './omp-credentials.mjs';
import {isolatedLaunch} from './process-isolation.mjs';
import {platformPersistence} from '../../platform/shared/persistence.mjs';
import {here as roleRuntimeRoot,roleSkillCatalog} from './runtime.mjs';

const defaultEntry=fileURLToPath(new URL('../../../../../integrations/pi/src/owner.mjs',import.meta.url));
const fail=(code,message)=>Object.assign(Error(message),{code});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const modelSelector=value=>typeof value==='string'?value:value?.provider&&value?.modelId?value.provider+'/'+value.modelId:null;
// Remote error frames may carry bounded structured provider-failure
// evidence. Trust nothing outside the picklist; classify from fields only.
// Rows may carry an OPAQUE per-turn correlation id (host-generated UUID from
// the owner's fetch observer scope) — identity only, never a secret.
const sanitizeHttpRow=value=>{
 if(!value||typeof value!=='object')return null;
 const status=value.status;
 const row={origin:typeof value.origin==='string'&&/^https?:\/\//.test(value.origin)&&value.origin.length<=300?value.origin:null,pathname:typeof value.pathname==='string'&&value.pathname.length<=300?value.pathname:null,method:typeof value.method==='string'&&/^[A-Z]{1,16}$/.test(value.method)?value.method:null,status:Number.isSafeInteger(status)&&status>=0?status:null,at:typeof value.at==='string'&&value.at.length<=64?value.at:null};
 if(typeof value.context==='string'&&/^[A-Za-z0-9:_-]{1,64}$/.test(value.context))row.context=value.context;
 if(typeof value.networkCode==='string'&&/^[A-Z0-9_]{1,32}$/.test(value.networkCode))row.networkCode=value.networkCode;
 if(Number.isSafeInteger(value.durationMs)&&value.durationMs>=0)row.durationMs=value.durationMs;
 return row.origin&&row.method?row:null;
};
const boundedCount=value=>Number.isSafeInteger(value)&&value>=0&&value<=1000000?value:null;
const sanitizeAutoRetry=value=>{
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const attempt=boundedCount(value.attempt);if(attempt===null)return null;
 const out={attempt};
 const maxAttempts=boundedCount(value.maxAttempts);if(maxAttempts!==null)out.maxAttempts=maxAttempts;
 const delayMs=boundedCount(value.delayMs);if(delayMs!==null)out.delayMs=delayMs;
 if(typeof value.success==='boolean')out.success=value.success;
 return out;
};
const sanitizeFailureEvidence=evidence=>{
 if(!evidence||typeof evidence!=='object'||Array.isArray(evidence))return null;
 const out={schema:1,phase:evidence.phase==='pre-admission'||evidence.phase==='post-entry'?evidence.phase:null};
 if(typeof evidence.networkCode==='string'&&/^[A-Z0-9_]{1,32}$/.test(evidence.networkCode))out.networkCode=evidence.networkCode;
 if(!out.phase)return null;
 if(Number.isSafeInteger(evidence.httpStatus)&&evidence.httpStatus>=400&&evidence.httpStatus<=599)out.httpStatus=evidence.httpStatus;
 for(const field of ['provider','model','api','stopReason','rawStopReason'])if(typeof evidence[field]==='string'&&evidence[field].length<=200)out[field]=evidence[field];
 if(Array.isArray(evidence.diagnosticCodes)&&evidence.diagnosticCodes.length<=8&&evidence.diagnosticCodes.every(code=>Number.isInteger(code)||typeof code==='string'&&code.length<=64))out.diagnosticCodes=evidence.diagnosticCodes.slice();
 if(typeof evidence.willRetry==='boolean')out.willRetry=evidence.willRetry;
 const autoRetry=sanitizeAutoRetry(evidence.autoRetry);if(autoRetry)out.autoRetry=autoRetry;
 if(typeof evidence.deliveryPhase==='string'&&evidence.deliveryPhase.length<=64)out.deliveryPhase=evidence.deliveryPhase;
 if(Array.isArray(evidence.http)&&evidence.http.length<=4){const rows=evidence.http.map(sanitizeHttpRow).filter(Boolean);if(rows.length)out.http=rows;}
 return out;
};

/** One host-owned Pi process per role. Only the Host submits admitted inputs. */
export class PiSession extends EventEmitter {
 constructor(spec){
  super();this.spec=spec;this.home=spec.home;this.cwd=spec.cwd;this.role=spec.role;
  // Platform process service (group spawn, identity stamp, group termination)
  // is injected per host; the default comes from the shared capability
  // contract, so a session never guesses group semantics for a platform
  // without a verified adapter.
  this.processTree=spec.processTree??hostProcessTree();
  this.tools=spec.tools??[];this.toolsDigest=digest(this.tools);this.viewOwnerId=spec.nativeContext?.ownerId??randomUUID();
  this.epoch=randomUUID();this.pending=new Map();this.inFlightToolCalls=new Map();this.toolAdmissions=new Map();
  this.nativeDrain=Promise.resolve();this.nativeError=null;this.closed=false;this.busy=false;
  this.phase='new';this.model=spec.model??null;this.effort=spec.effort??null;this.interactions=[];
  this.hasPrompted=false;this.agentEnds=[];this.configurationStatus='unconfigured';
  this.thinkingLevels=null;this.admissionTail=Promise.resolve();
  // Delivery evidence state: last nozeliDelivery fact for the admitted
  // request, and the native compaction epoch (set only from a confirmed
  // nozeliCompaction fact or a start/prompt result — never guessed).
  this.lastDelivery=null;this.contextEpoch=null;
  this.nativeActivity=null;this.activityRevision=0;this.nativePending=0;this.activityUnknown=false;
  this.capabilities={terminal:false,model:true,thinkingLevel:true,reload:true,compact:true,diagnostics:true};
 }
 get metadataFile(){return path.join(this.home,'nozeli-session-tools.json');}
 // Admission policy for a resumed native conversation: host tools may gain
 // definitions between runs, so a CHANGED tools digest is diagnostic
 // evidence, never a refusal. This only loads the durable pinned record
 // (threadId/sessionFile/last-run digest); it is republished by
 // saveMetadata() after start() has re-verified the exact thread identity
 // through the native owner. A record this host cannot interpret is a
 // genuine persisted-metadata error and still refuses the resume.
 async preflightToolsDigest(expected){
  let saved;try{saved=JSON.parse(await fs.readFile(this.metadataFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(saved){
   if(saved.schema!==1||typeof saved.threadId!=='string'||!saved.threadId||saved.sessionFile!=null&&typeof saved.sessionFile!=='string')throw fail('PI_TOOLS_METADATA_SCHEMA','Pi session tools metadata is not an interpretable pinned record; refusing to resume from it');
   this.sessionFile=saved.sessionFile;this.pinnedThreadId=saved.threadId;
   this.pinnedToolsDigest=typeof saved.toolsDigest==='string'?saved.toolsDigest:null;
  }
  return {equivalent:(expected==null||expected===this.toolsDigest)&&(!saved||saved.toolsDigest===this.toolsDigest),toolsDigest:this.toolsDigest,
   ...(expected!=null&&expected!==this.toolsDigest?{expectedToolsDigest:expected}:{}),...(saved?{pinnedToolsDigest:this.pinnedToolsDigest}:{})};
 }
 // Post-start lineage assertion. Pure in-memory: it never reads or repins
 // metadata and never touches pending RPCs, so admission/tool paths can call
 // it without disturbing the live owner's pending tool protocol. The running
 // owner's spec cannot be hot-mutated: an expected digest that is neither
 // the running schema nor the pinned historical schema of the resumed
 // conversation is a genuine lineage error, not an ordinary tool upgrade.
 assertToolsDigest(expected){
  if(expected==null||expected===this.toolsDigest)return {equivalent:true,toolsDigest:this.toolsDigest};
  if(this.pinnedToolsDigest&&expected===this.pinnedToolsDigest)return {equivalent:false,resumedWithChangedTools:true,toolsDigest:this.toolsDigest,expectedToolsDigest:expected,pinnedToolsDigest:this.pinnedToolsDigest};
  throw fail('PI_TOOLS_DIGEST_MISMATCH',`Pi session tool lineage mismatch: expected ${expected}, running ${this.toolsDigest}, pinned ${this.pinnedToolsDigest??'none'}; explicit context handoff required`);
 }
 async saveMetadata(){
  // Shared durable atomic publish (temp + fsync + rename + directory barrier);
  // the home directory itself is created by start() before this runs.
  await platformPersistence.writeAtomic(this.metadataFile,JSON.stringify({schema:1,threadId:this.threadId,sessionFile:this.sessionFile,toolsDigest:this.toolsDigest}));
 }
 bindOwnerInput(child){
  child.stdin.on('error',cause=>{
   if(this.child!==child)return;
   this.transportError??=Object.assign(fail('PI_RUNTIME_PIPE_FAILED','Pi owner input pipe failed; native settlement is unknown and input will not be replayed'),{cause});
   this.activityUnknown=true;
   for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(this.transportError);}
   this.pending.clear();this.activityChanged();
  });
 }
 write(value){
  if(this.transportError)throw this.transportError;
  if(!this.child?.stdin?.writable)throw fail('PI_RUNTIME_CLOSED','Pi runtime input closed');
  this.child.stdin.write(JSON.stringify(value)+'\n');
 }
 request(method,params={},timeout=30000){
  if(this.closed)return Promise.reject(fail('PI_RUNTIME_CLOSED','Pi session closed'));
  if(this.transportError)return Promise.reject(this.transportError);
  const id=randomUUID();
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(fail('PI_REQUEST_TIMEOUT','Pi '+method+' acknowledgement timed out; no automatic replay'));},timeout);
   this.pending.set(id,{resolve,reject,timer,method,requestId:params.requestId,current:method==='prompt'||method==='recover'?this.current:null,ownerId:this.viewOwnerId,sessionId:this.threadId,ownerGeneration:this.nativeActivity?.ownerGeneration});
   try{this.write({id,method,params});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
  });
 }
 activityChanged(){this.activityRevision++;this.emit('activity',this.activitySnapshot());}
 activitySnapshot(){
  const native=this.nativeActivity;
  const settling=this.phase==='settling'||this.nativePending>0;
  const known=!!native?.known&&!this.activityUnknown&&!this.nativeError&&!this.protocolError&&!this.closed&&this.phase!=='exited';
  return {...(native??{}),ownerId:this.viewOwnerId,epoch:this.epoch,sessionId:this.threadId??native?.sessionId??null,activityRevision:this.activityRevision,nativeActivityRevision:native?.activityRevision??null,
   known,freshness:known?'confirmed':'unknown',phase:this.phase,hostBusy:this.busy,hostToolCount:this.inFlightToolCalls.size,nativeDrainPending:this.nativePending,
   settling:settling||native?.settling===true,configuration:!!this.modelSubmission||native?.configuration===true,
   busy:this.busy||settling||this.inFlightToolCalls.size>0||!!this.modelSubmission||native?.busy===true,modelError:this.modelError?{code:this.modelError.code??'PI_MODEL_FAILED',message:this.modelError.message}:null};
 }
 acceptActivity(value){
  if(!value||value.ownerId!==this.viewOwnerId||!Number.isSafeInteger(value.activityRevision))return false;
  const boundSession=this.threadId??this.nativeActivity?.sessionId;if(boundSession&&value.sessionId&&value.sessionId!==boundSession)return false;
  if(this.nativeActivity&&(value.ownerGeneration!==this.nativeActivity.ownerGeneration||value.activityRevision<=this.nativeActivity.activityRevision))return false;
  this.nativeActivity=value;this.activityChanged();return true;
 }
 async refreshActivity(){const value=await this.request('activity');this.acceptActivity(value);return this.activitySnapshot();}
 enqueueNative(fn){
  this.nativePending++;this.activityChanged();
  const operation=this.nativeDrain.then(fn);
  this.nativeDrain=operation.catch(error=>{this.nativeError??=error;this.emit('projection-error',error);}).finally(()=>{this.nativePending--;this.activityChanged();});
 }
 receive(line){
  let message;try{message=JSON.parse(line);}catch{this.protocolError=fail('PI_PROTOCOL_INVALID','Invalid Pi runtime JSONL frame');this.child?.kill();return;}
  if(message.ownerId&&message.ownerId!==this.viewOwnerId)return;
  if(message.ownerGeneration&&this.nativeActivity&&message.ownerGeneration!==this.nativeActivity.ownerGeneration)return;
  if(message.sessionId&&this.threadId&&message.sessionId!==this.threadId)return;
  if(message.activity){
   if(this.nativeActivity&&message.activityRevision<=this.nativeActivity.activityRevision)return;
   this.acceptActivity(message.activity);
  }
  if(message.event==='activity')return;
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
   const fact={sessionId:message.sessionId??this.threadId,epoch:this.epoch,ownerId:this.viewOwnerId,ownerGeneration:message.ownerGeneration,activityRevision:message.activityRevision,seq:message.seq,entry:message.entry,...(current?.recoveryAttemptId?{recoveryAttemptId:current.recoveryAttemptId}:{}),...(message.requestId?{requestId:message.requestId,jobId:message.jobId??current?.job?.id}:{}),...(message.streamId?{streamId:message.streamId}:{})};
   this.enqueueNative(()=>this.spec.onNativeEntry?.(fact));return;
  }
  if(message.event==='admitted'){
   const current=this.current;
   // Admission ends only this prompt's acknowledgement phase, not its RPC:
   // keep the pending result/error and exit/cancel cleanup until settlement.
   // Never let another request (including cancel/flush) lose its deadline.
   if(current&&message.requestId===current.requestId&&message.ownerId===current.ownerId&&current.sessionId&&message.sessionId===current.sessionId&&current.ownerGeneration&&message.ownerGeneration===current.ownerGeneration){
    for(const waiting of this.pending.values()){
     if(!['prompt','recover'].includes(waiting.method)||waiting.current!==current||waiting.requestId!==message.requestId||waiting.ownerId!==message.ownerId||!waiting.sessionId||waiting.sessionId!==message.sessionId||!waiting.ownerGeneration||waiting.ownerGeneration!==message.ownerGeneration||waiting.timer===null)continue;
     clearTimeout(waiting.timer);waiting.timer=null;
     break;
    }
    // A timeout removes the RPC, not a later truthful admission fact. Keep
    // evidence while the current turn drains without reviving its promise.
    if(!current.admissionObserved){current.admissionObserved=true;if(!current.recoveryAttemptId)this.enqueueNative(()=>this.transport('admitted',current));}
   }
   return;
  }
 if(message.event==='native'){
  const event=message.eventData;
  if(event?.type==='agent_end')this.agentEnds.push(event);
  const current=this.current;
  const fact={sessionId:message.sessionId??this.threadId,epoch:this.epoch,ownerId:this.viewOwnerId,ownerGeneration:message.ownerGeneration,activityRevision:message.activityRevision,seq:message.seq,requestId:current?.requestId,jobId:current?.job?.id,...(current?.recoveryAttemptId?{recoveryAttemptId:current.recoveryAttemptId}:{}),streamId:event?.streamId,event};
  // Typed host-authored facts are consumed for binding evidence and epoch
  // bookkeeping in the SAME serialized drain as entries, and only when the
  // fact provably belongs to THIS owner session and admitted request —
  // unknown fields or another owner's facts are forwarded, never trusted.
  this.enqueueNative(async()=>{
   if(event?.type==='nozeliDelivery'&&current&&this.current===current&&event.sessionId===this.threadId&&event.requestId===current.requestId){
    this.lastDelivery=event;
    // A provider failure after journal confirmation still owes the host the
    // record-confirmed stage: emit it here, inside the drain and before any
    // error 'unknown' fact, with the immutable request tuple plus the
    // separate nativeEntryDigest evidence field.
    if(event.phase==='native-record-confirmed'&&!current.recordConfirmedTransported){
     current.recordConfirmedTransported=true;
     await this.transport('native-record-confirmed',current,{entryId:event.text?.entryId??null,nativeEntryDigest:event.text?.sha256??null,...(Array.isArray(event.materials)&&event.materials.length?{materials:event.materials.map(({id,version,entryId})=>({id,version,entryId}))}:{})});
    }
   }else if(event?.type==='nozeliCompaction'&&event.sessionId===this.threadId){
    this.contextEpoch=typeof event.contextEpoch==='string'?event.contextEpoch:this.contextEpoch;
   }
   await this.spec.onNativeEvent?.(fact);
  });
  this.emit('event',event);return;
 }
  if(message.event==='interaction'){
   this.interactions.push(message.interaction);this.emit('interaction',message.interaction);this.activityChanged();return;
  }
  const waiting=this.pending.get(message.id);if(!waiting)return;
  clearTimeout(waiting.timer);this.pending.delete(message.id);
 if(message.error){
  const error=fail(message.error.code??'PI_RUNTIME_ERROR',message.error.message??'Pi runtime request failed');
  // Keep the remote structured facts (delivery phase, sanitized provider
  // failure evidence) on the rejected error; code/message alone would strip
  // the only non-guess classification evidence.
  if(typeof message.error.deliveryPhase==='string'&&message.error.deliveryPhase.length<=64)error.deliveryPhase=message.error.deliveryPhase;
  if(['host','provider','runtime'].includes(message.error.failureOrigin))error.failureOrigin=message.error.failureOrigin;
  if(typeof message.error.hostToolCode==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(message.error.hostToolCode))error.hostToolCode=message.error.hostToolCode;
  const evidence=sanitizeFailureEvidence(message.error.providerFailure);
  if(evidence){error.providerFailureEvidence=evidence;this.lastProviderFailure=evidence;}
  waiting.reject(error);
 }else waiting.resolve(message.result);
 }
 async start(resumeId){
  if(this.child)throw fail('PI_OWNER_EXISTS','Pi session already owns a process');
  // The durable pinned record must name exactly the thread being resumed;
  // the native owner then independently re-verifies the pinned file's own
  // header identity during the same open. Refuse before any side effect.
  if(resumeId&&this.pinnedThreadId&&this.pinnedThreadId!==resumeId)throw fail('PI_SESSION_IDENTITY',`Pi pinned session metadata names thread ${this.pinnedThreadId}, not the requested ${resumeId}`);
  if(!this.processTree.verified)throw fail('PI_PLATFORM_UNSUPPORTED',`Pi owner process ownership is not verified on ${this.processTree.platform}; refusing to start an unverified owner process`);
  const skillCatalog=await roleSkillCatalog(this.role,{skills:this.spec.skills});
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
  this.child=this.processTree.spawn({command:launch.command,args:launch.args,cwd:this.cwd,env:{...env,...launch.env},stdio:['pipe','pipe','pipe'],windowsHide:true});
  const child=this.child;
  this.bindOwnerInput(child);
  this.exitPromise=new Promise(resolve=>{child.once('exit',(code,signal)=>{this.exit={code,signal};this.phase='exited';for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(this.protocolError??fail('PI_RUNTIME_EXITED','Pi owner exited before acknowledgement; input will not be replayed'));}this.pending.clear();resolve(this.exit);this.emit('exit',this.exit);});child.once('error',error=>{this.spawnError=error;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();resolve({error:error.message});});});
  createInterface({input:child.stdout,crlfDelay:Infinity}).on('line',line=>this.receive(line));
  this.diagnostics='';child.stderr.on('data',chunk=>{this.diagnostics=(this.diagnostics+chunk.toString()).slice(-16384);});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  this.pid=child.pid;this.groupRecord={pid:this.pid,home:this.home,ownerId:this.viewOwnerId,stamp:await this.processTree.stamp(this.pid),kind:'pi-node'};
  await this.spec.onSpawn?.(this.pid);
  const result=await this.request('start',{cwd:this.cwd,home:this.home,agentDir:env.PI_CODING_AGENT_DIR,instructions:[this.spec.baseInstructions,this.spec.instructions].filter(Boolean).join('\n'),tools:this.tools,rolePackageRoot:path.join(roleRuntimeRoot,'roles'),roleSkillCatalog:skillCatalog,sessionId:resumeId,sessionFile:this.sessionFile,model:this.model,effort:this.effort,role:this.role,...(this.spec.budget?{budget:this.spec.budget}:{})},60000);
  this.threadId=result.sessionId;this.sessionFile=result.sessionFile;
  if(!this.threadId||resumeId&&this.threadId!==resumeId)throw fail('PI_SESSION_IDENTITY','Pi owner did not confirm exact original session identity');
  this.model=modelSelector(result.model)??this.model;this.effort=result.effort??this.effort;this.effective=result.effective;this.thinkingLevels=result.thinkingLevels??this.thinkingLevels;this.hasPrompted=result.hasPrompted===true;
  this.contextDelivery=result.contextDelivery??null;this.contextEpoch=result.contextDelivery?.contextEpoch??null;await this.saveMetadata();this.phase='idle';this.configurationStatus=this.model?'configured':'unconfigured';await this.refreshActivity();
  if(this.pendingModel!=null){await this.nativeDrain;await this.applyPendingModel();}
  return {threadId:this.threadId,sessionFile:this.sessionFile};
 }
 async transport(status,current,extra={}){
  const fact={status,kind:'prompt',sessionId:this.threadId,epoch:this.epoch,requestId:current.requestId,jobId:current.job.id,attempt:1,contentDigest:current.contentDigest,...extra};
  // The transport identity tuple (requestId/jobId/attempt/contentDigest/epoch)
  // is immutable across stages: stage-specific evidence may only ADD fields
  // (e.g. nativeEntryDigest), never rewrite the binding keys.
  fact.requestId=current.requestId;fact.jobId=current.job.id;fact.attempt=1;fact.contentDigest=current.contentDigest;
  return this.spec.onTransportFact?.(fact);
 }
 async handleTool(message){
  const current=this.current;
  const admission={cancelled:current?.cancelled===true,cancelReason:null,preEffect:async()=>{
   await this.nativeDrain;
   if(this.nativeError)throw this.nativeError;
   if(this.transportError)throw this.transportError;
   if(!current||this.current!==current||current.cancelled||admission.cancelled||message.requestId!==current.requestId||this.stopping)throw fail('PI_TOOL_STALE','Tool no longer belongs to the active admitted input');
   await this.spec.onBeforeAgentStart?.();
   if(current.cancelled||admission.cancelled||this.current!==current)throw fail('PI_TOOL_CANCELLED','Input cancelled before tool effect');
  }};
  this.toolAdmissions.set(message.id,admission);
  const operation=(async()=>{
   await admission.preEffect();
   const result=await this.spec.onTool?.({tool:message.tool,arguments:message.arguments??{},callId:message.callId??message.id,promptId:current.requestId,...(current.recoveryAttemptId?{recoveryAttemptId:current.recoveryAttemptId,jobId:current.job.id}:{}),admission});
   if(current.cancelled||admission.cancelled)throw fail('PI_TOOL_CANCELLED','Input cancelled after tool execution; effect may have happened');
   if(this.spec.finishOnHostControl&&result?.continueTurn!==true&&result?.readOnly!==true&&message.tool!=='nozeli_inspect_work'){
    current.hostControl=true;
    if(result?.ok===false&&result?.userDecisionRequired!==true||!['dispatch','continue','status','cancel','clarify'].includes(result?.action)&&!['accepted','saved','blocked','maintenance','transferred','userDecisionRequired','responded'].some(key=>result?.[key]===true))current.hostControlError={code:result?.error?.code??'HOST_CONTROL_UNCLASSIFIED',message:String(result?.error?.message??'宿主控制已停止当前回合，但未确认成功结果；原任务保留，不自动重放。').slice(0,400)};
   }
   this.write({id:message.id,result});
  })();
  this.inFlightToolCalls.set(message.id,operation);
  this.activityChanged();
  try{await operation;}catch(error){try{this.write({id:message.id,error:{code:error.code??'HOST_TOOL_ERROR',message:error.message,...(['host','provider','runtime'].includes(error.failureOrigin)?{failureOrigin:error.failureOrigin}:{}),...(typeof error.hostToolCode==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(error.hostToolCode)?{hostToolCode:error.hostToolCode}:{})}});}catch{};}finally{this.inFlightToolCalls.delete(message.id);this.toolAdmissions.delete(message.id);this.activityChanged();}
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
 // timeout bounds native admission, not the admitted provider/tool turn.
 // Its RPC remains pending until the owner returns a result/error or exits.
 async prompt(text,{timeout=600000,images=[],materials,projection,job,admissionCheck,restrictedMode,tools,maxTurns,maxToolCalls}={}){
  if(this.busy||!job?.id)throw fail('PI_INPUT_ADMISSION','Pi prompt requires an idle owner and durable host job');
  if(this.nativeError)throw this.nativeError;
  const gate=this.beginAdmission();
  try{
   await gate.previous;
   if(this.busy||this.stopping)throw fail('PI_INPUT_ADMISSION','Pi prompt requires an idle owner and durable host job');
   const current={requestId:randomUUID(),job,contentDigest:digest({text,images,materials}),cancelled:false,hostControl:false,ownerId:this.viewOwnerId,sessionId:this.threadId,ownerGeneration:this.nativeActivity?.ownerGeneration};
   this.current=current;this.busy=true;this.phase='prompt-inflight';
   this.activityChanged();
   try{
    await this.spec.onBeforeAgentStart?.();
    await this.transport('prepared',current);await this.transport('submitted',current);
    if(current.cancelled||this.stopping)throw fail('PI_INPUT_CANCELLED','Input cancelled before runtime submission');
    const hold=admissionCheck?.();
    if(hold){
     await this.transport('rejected',current,{reason:hold});
     const error=fail(hold,'Input held before native dispatch');error.definitiveNonDispatch=true;throw error;
    }
    const result=await this.request('prompt',{text,images,requestId:current.requestId,job,restrictedMode:restrictedMode??job.context?.restrictedMode,tools,maxTurns,maxToolCalls,...(materials?{materials}:{}),...(projection?{projection}:{})},timeout);
    this.hasPrompted=true;this.phase='settling';this.activityChanged();await this.request('flush',{},30000);await this.nativeDrain;
    if(this.nativeError)throw this.nativeError;
    await Promise.all(this.inFlightToolCalls.values());
    // Delivery evidence is separate from the turn outcome, and it must never
    // mutate the transport binding: status/epoch/contentDigest stay the
    // request identity tuple (contentDigest = SHA of the submitted
    // {text,images,materials}); the native entry's own raw-text digest rides
    // the separate nativeEntryDigest field. The drain above usually already
    // emitted this stage from the nozeliDelivery fact; never emit twice.
    if(result.nativeEntry?.persisted&&!current.recordConfirmedTransported)await this.transport('native-record-confirmed',current,{entryId:result.nativeEntry.id,nativeEntryDigest:result.nativeEntry.contentDigest,...(result.delivery?.materials?.length?{materials:result.delivery.materials.map(({id,version,entryId})=>({id,version,entryId}))}:{})});
    if(typeof result.contextEpoch==='string')this.contextEpoch=result.contextEpoch;
    await this.transport('settled',current);
   return {threadId:this.threadId,turnId:current.requestId,text:result.text??'',completion:current.hostControl?'host-control':result.completion??'provider-completed',...(current.hostControlError?{hostControlError:current.hostControlError}:{}),providerStatus:current.cancelled?'cancelled':'completed',metrics:result.metrics,effective:result.effective??this.effective,projectedNative:true,nativeEntry:result.nativeEntry??null,delivery:result.delivery??null,contextEpoch:result.contextEpoch??null};
  }catch(error){
    if(error?.code==='PI_SETTLEMENT_UNKNOWN'||error?.code==='PI_REQUEST_TIMEOUT'||error?.code==='PI_PERSISTENCE_UNCONFIRMED'){this.activityUnknown=true;this.activityChanged();}
    // Drain first: a provider failure after journal confirmation must still
    // surface the record-confirmed stage BEFORE the unknown fact, and the
    // error carries the last truthful delivery fact for the host.
    await this.nativeDrain.catch(()=>{});
    if(this.lastDelivery&&this.lastDelivery.requestId===current.requestId&&!(error&&error.delivery))error.delivery=this.lastDelivery;
    if(!error.definitiveNonDispatch)await this.transport('unknown',current,{reason:error.code??error.message}).catch(()=>{});throw error;
   }
   finally{if(this.current===current){this.current=null;this.busy=false;this.phase=this.stopping?'stopping':'idle';this.activityChanged();}}
  }finally{gate.end();if(this.pendingModel!=null&&!this.stopping)await this.applyPendingModel();}
 }
 async inspectRecovery(identity){
  if(identity?.sessionId!==this.threadId)throw fail('RESTART_RECONCILIATION_REQUIRED','Recovery thread identity mismatch');
  try{return await this.request('inspectRecovery',identity);}
  catch(error){if(error.code?.startsWith('PI_RECOVERY_'))error.code='RESTART_RECONCILIATION_REQUIRED';throw error;}
 }
 async recover({job,admissionCheck,timeout=600000,...identity}={}){
  if(this.busy||!job?.id||identity.sessionId!==this.threadId||identity.jobId!==job.id)throw fail('RESTART_RECONCILIATION_REQUIRED','Recovery requires exact idle job/session identity');
  if(this.nativeError)throw this.nativeError;
  const gate=this.beginAdmission();
  try{
   await gate.previous;
   if(this.busy||this.stopping)throw fail('PI_INPUT_ADMISSION','Recovery owner unavailable');
   const current={requestId:identity.requestId,job,contentDigest:null,cancelled:false,hostControl:false,ownerId:this.viewOwnerId,sessionId:this.threadId,ownerGeneration:this.nativeActivity?.ownerGeneration,recoveryAttemptId:identity.recoveryAttemptId};
   this.current=current;this.busy=true;this.phase='prompt-inflight';this.activityChanged();
   try{
    await this.spec.onBeforeAgentStart?.();
    if(current.cancelled||this.stopping)throw fail('PI_INPUT_CANCELLED','Recovery cancelled before native dispatch');
    const hold=admissionCheck?.();if(hold)throw fail(hold,'Recovery held before native dispatch');
    const result=await this.request('recover',{...identity,job},timeout);
    this.phase='settling';this.activityChanged();await this.request('flush',{},30000);await this.nativeDrain;
    if(this.nativeError)throw this.nativeError;
    await Promise.all(this.inFlightToolCalls.values());
    if(typeof result.contextEpoch==='string')this.contextEpoch=result.contextEpoch;
    return {threadId:this.threadId,turnId:identity.requestId,text:result.text??'',completion:current.hostControl?'host-control':result.completion??'provider-completed',...(current.hostControlError?{hostControlError:current.hostControlError}:{}),providerStatus:current.cancelled?'cancelled':'completed',effective:result.effective??this.effective,projectedNative:true,recovery:result.recovery,entries:result.entries,settlement:result.settlement,contextEpoch:result.contextEpoch};
   }catch(error){
    await this.nativeDrain.catch(()=>{});
    if(error.code?.startsWith('PI_RECOVERY_')||error.code==='EEXIST')error.code='RESTART_RECONCILIATION_REQUIRED';
    if(['PI_SETTLEMENT_UNKNOWN','PI_REQUEST_TIMEOUT','PI_PERSISTENCE_UNCONFIRMED'].includes(error.code)){this.activityUnknown=true;this.activityChanged();}
    throw error;
   }finally{if(this.current===current){this.current=null;this.busy=false;this.phase=this.stopping?'stopping':'idle';this.activityChanged();}}
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
  catch(error){this.modelError=error;this.emit('model-error',error);this.activityChanged();}
 }
 cancelModelIntent({intentRevision,operationId}={}){
  const matches=value=>value&&value.intentRevision===intentRevision&&value.operationId===operationId;
  if(matches(this.modelSubmission))return {state:this.modelSubmission.state??'submitted',cancelled:false,intentRevision,operationId};
  if(matches(this.lastModelIntent))return {...this.lastModelIntent,cancelled:false};
  if(!matches(this.pendingModel)&&!matches(this.queuedModelIntent))return {state:'unknown',cancelled:false,intentRevision,operationId};
  this.desiredGeneration=(this.desiredGeneration??0)+1;this.pendingModel=null;this.queuedModelIntent=null;this.desiredModel=null;this.activityChanged();
  return {state:'cancelled',cancelled:true,intentRevision,operationId};
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
   this.activityChanged();
   return {state:'unchanged',cleared:true};
  }
  const selector=change.selector??this.desiredModel??this.model;
  if(!selector||!selector.includes('/'))return {state:'unchanged'};
  this.desiredModel=selector;
  const desired={selector,...(change.effort!=null?{effort:change.effort}:{}),...(change.refreshProvider===true?{refreshProvider:true}:{}),...(change.intentRevision!=null?{intentRevision:change.intentRevision}:{}),...(change.operationId?{operationId:change.operationId}:{}),...(change.beforeSubmit?{beforeSubmit:change.beforeSubmit}:{})};
  // Synchronous acceptance: this generation is what a later clear supersedes.
  const generation=this.desiredGeneration=(this.desiredGeneration??0)+1;
  this.queuedModelIntent=desired;
  if(this.busy||['new','starting'].includes(this.phase)){this.pendingModel=desired;this.activityChanged();return {state:'pending',desired};}
  const gate=this.beginAdmission();
  try{
   // Configuration runs under the same admission boundary as prompts, so a
   // model request can never mutate mid-admitted execution.
   await gate.previous;
   if(generation!==this.desiredGeneration)return {state:'cancelled',superseded:true,desired};
   if(this.busy||this.stopping){this.pendingModel=desired;this.activityChanged();return {state:'pending',desired};}
   await this.nativeDrain;
   if(generation!==this.desiredGeneration)return {state:'cancelled',superseded:true,desired};
   if(!this.activitySnapshot().known)throw fail('PI_ACTIVITY_UNKNOWN','Pi activity requires reconciliation before model mutation');
   const identity={intentRevision:desired.intentRevision,operationId:desired.operationId};
   this.modelSubmission={...identity,state:'submitted'};this.activityChanged();
   await desired.beforeSubmit?.(identity);
   const result=await this.request('model',{selector,...(desired.effort?{effort:desired.effort}:{}),...(desired.refreshProvider?{refreshProvider:true}:{})});
   this.model=modelSelector(result.model)??selector;this.effort=result.effort??this.effort;this.effective=result.effective??this.effective;this.thinkingLevels=result.thinkingLevels??this.thinkingLevels;
   this.lastModelIntent={...identity,state:'applied'};
   if(generation===this.desiredGeneration){this.pendingModel=null;this.queuedModelIntent=null;}
   this.modelError=null;this.emit('model-changed',{...result,...identity});this.activityChanged();
   return {state:'applied',...identity,effective:this.effective??{model:this.model,effort:this.effort},requested:desired.effort!=null?{effort:desired.effort}:null,clamped:result.clamped??null,thinkingLevels:this.thinkingLevels};
  }catch(error){
   Object.assign(error,{intentRevision:desired.intentRevision,operationId:desired.operationId});
   this.lastModelIntent={intentRevision:desired.intentRevision,operationId:desired.operationId,state:this.modelSubmission?'unknown':'failed'};
   if(generation===this.desiredGeneration){this.pendingModel=null;this.queuedModelIntent=null;}
   this.modelError=error;this.emit('model-error',error);this.activityChanged();throw error;
  }
  finally{this.modelSubmission=null;this.activityChanged();gate.end();}
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
   this.busy=true;this.phase=method==='compact'?'compacting':'reloading';this.activityChanged();
   try{const result=await this.request(method,{},method==='compact'?600000:30000);await this.request('flush');await this.nativeDrain;if(this.nativeError)throw this.nativeError;return result;}
   finally{this.busy=false;this.phase=this.stopping?'stopping':'idle';this.activityChanged();}
  }finally{gate.end();if(this.pendingModel!=null&&!this.stopping)await this.applyPendingModel();}
 }
 reload(){return this.sessionCommand('reload');}
 compact(){return this.sessionCommand('compact');}
 async respondInteraction(id,answer,{cancel=false}={}){const result=await this.request('respond',{id,answer,cancel});this.interactions=this.interactions.filter(value=>value.id!==id);this.activityChanged();return result;}
 async stopIdle(){const activity=this.activitySnapshot();if(!activity.known||activity.busy||this.inFlightToolCalls.size)throw fail('PI_BUSY','Cannot reclaim a busy or unverified Pi owner');return this.stop();}
 stop({discardState=false}={}){
  if(this.stopPromise)return discardState?this.stopPromise.catch(error=>{
   if(error.code!=='PI_PERSISTENCE_UNCONFIRMED'||!this.closed||!this.lastExitReceipt?.confirmationComplete)throw error;
   return {...this.lastExitReceipt,persistenceDiscarded:true};
  }):this.stopPromise;
  this.stopPromise=this.stopOwner({discardState});return this.stopPromise;
 }
 async stopOwner({discardState=false}={}){
  this.stopping=true;
  this.activityChanged();
  if(!this.child){this.closed=true;return this.lastExitReceipt={confirmationComplete:true,reason:'never-spawned'};}
  if(this.current)this.current.cancelled=true;
  let persistenceError;
  if(this.child.exitCode===null&&this.child.signalCode===null){
   await this.request('stop',{discardState},15000).catch(error=>{persistenceError=error;});
   const exited=await Promise.race([this.exitPromise,new Promise(resolve=>{const timer=setTimeout(()=>resolve(null),3000);timer.unref();})]);
   if(!exited){try{this.processTree.terminateGroup(this.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}}
  }
  const result=await reapOwnedPiGroup(this.groupRecord);
  await this.exitPromise;await Promise.allSettled(this.inFlightToolCalls.values());
  await this.nativeDrain.catch(error=>{if(!discardState)throw error;persistenceError??=error;});
  this.lastExitReceipt={confirmationComplete:result.verified===true,exit:this.exit,...result};this.closed=result.verified===true;
  if(!this.closed)throw fail('PI_EXIT_UNCONFIRMED','Pi process-tree exit has not been verified on this platform');
  if(persistenceError||this.nativeError||this.transportError){
   if(!discardState)throw Object.assign(fail('PI_PERSISTENCE_UNCONFIRMED','Pi owner exited but journal/projection persistence was not confirmed'),{cause:persistenceError??this.nativeError??this.transportError,exitReceipt:this.lastExitReceipt});
   this.lastExitReceipt.persistenceDiscarded=true;
  }
  return this.lastExitReceipt;
 }
}
