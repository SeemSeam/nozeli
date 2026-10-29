// Host-authoritative, task-bound sensitive-effect authorization ledger.
// Records live in instance-local managed storage (attention-ledger family)
// and never migrate with portable project records. One ledger serves every
// effect family: host-managed privileged execution (effectType 'host-exec')
// and structured consent effects (e.g. merge-override) — never two tables
// that do not recognize each other's authority.
// Grants are generation-bound (a restart stales every prior grant and keeps
// only the pending request todo), task-bound (admission permissionTaskId),
// hash-frozen (the exact effect the user saw), and expiring. A grant is an
// admission decision, never OS-authentication evidence: real root identity
// comes only from the privilege broker's actualIdentity facts.
import {randomUUID,createHash} from 'node:crypto';
import pathModule from 'node:path';

const KEY='managed:task-permissions';
export const EFFECT_TTL_MS=30*60*1000;

// Canonical frozen-effect JSON: recursively key-sorted, no whitespace, arrays
// preserved as arrays — the SINGLE shared canon (brokers must import this
// module's computeEffectHash, never reimplement it). The hash covers the full
// frozen effect, so elevation (action) and any approved content digest are
// pinned at prepare time; execution-time tunables (timeouts, output bounds)
// stay outside the frozen effect and can never alter an approved hash.
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
// The frozen effect is exactly what the user approved; the hash binds it.
export const effectHash=frozen=>createHash('sha256').update(canonical(frozen)).digest('hex');
export const computeEffectHash=effectHash;


const str=(value,max)=>typeof value==='string'&&value.length<=max;

// Host-managed execution freeze: literal argv, OS-absolute cwd, no shell string.
// pathImpl is injectable so tests can validate the win32 parser on any host;
// production always uses the current platform's node:path semantics.
export function normalizeExecutionEffect({command,args,cwd,elevation='user'}={},pathImpl=pathModule){
  if(!str(command,4096)||!command.trim()||command.includes('\0'))throw Object.assign(Error('提权执行命令无效。'),{code:'INVALID_EFFECT'});
  if(!Array.isArray(args)||args.length>256||args.some(arg=>!str(arg,65536)||arg.includes('\0')))throw Object.assign(Error('提权执行参数必须是不超过256项的字符串数组。'),{code:'INVALID_EFFECT'});
  if(typeof cwd!=='string'||!cwd||cwd.length>4096||cwd.includes('\0')||!pathImpl.isAbsolute(cwd))throw Object.assign(Error('提权执行需要当前平台的绝对工作目录。'),{code:'INVALID_EFFECT'});
  if(!['user','admin'].includes(elevation))throw Object.assign(Error('提权级别只能为 user 或 admin。'),{code:'INVALID_EFFECT'});
  return {version:1,command,args,cwd,scope:'host-exec',action:elevation,elevation};
}

// Recognized concrete effects, not a shell sandbox or an ordinary-command
// allowlist. Native OMP remains trusted; opaque scripts are not classified.
export function executionDanger(effect){
  if(effect.elevation==='admin'||effect.action==='admin')return '系统管理员提权';
  if(effect.dangerousEffect)return typeof effect.dangerousEffect==='string'?effect.dangerousEffect:JSON.stringify(effect.dangerousEffect);
  const command=pathModule.basename(effect.command).toLowerCase().replace(/\.exe$/,'');
  const args=effect.args??[];
  if(['sudo','doas','pkexec','runas'].includes(command))return '系统管理员提权';
  if(/^(mkfs(?:\..+)?|format|diskpart|shred|wipefs|blkdiscard)$/.test(command))return '格式化或不可逆销毁数据';
  if(command==='dd'&&args.some(arg=>/^of=\/dev\//.test(arg)))return '覆盖块设备';
  if(command==='rm'&&args.some(arg=>/^-[^-]*r/i.test(arg)||arg==='--recursive')){
    const cwd=pathModule.resolve(effect.cwd),home=process.env.HOME?pathModule.resolve(process.env.HOME):null;
    let options=true;
    for(const arg of args){
      if(options&&arg==='--'){options=false;continue;}if(options&&arg.startsWith('-'))continue;
      const target=pathModule.resolve(cwd,arg),relative=pathModule.relative(target,cwd),withinTask=pathModule.relative(cwd,target);
      if(target===pathModule.parse(target).root||target===home||relative===''||(!relative.startsWith('..'+pathModule.sep)&&relative!=='..'&&!pathModule.isAbsolute(relative)))return '删除工作目录、用户目录或其祖先';
      if(withinTask==='..'||withinTask.startsWith('..'+pathModule.sep)||pathModule.isAbsolute(withinTask))return '递归删除任务目录外的数据树';
    }
  }
  return null;
}

const live=grant=>grant.status==='granted';
const sameExecution=(left,right)=>{if(!left||!right)return false;const {dangerousEffect:ignoredLeft,...a}=left,{dangerousEffect:ignoredRight,...b}=right;return effectHash(a)===effectHash(b);};

export class TaskPermissions {
  constructor(storage){this.storage=storage;this.flights=new Map();this.generation=randomUUID();}
  async update(projectId,change){
    const previous=this.flights.get(projectId)??Promise.resolve();
    const flight=previous.catch(()=>{}).then(async()=>{
      const saved=await this.storage.getLocal(projectId,KEY)??{schema:1,requests:[],grants:[],decisions:[]};
      const state=structuredClone(saved),result=change(state);
      if(JSON.stringify(state)!==JSON.stringify(saved))await this.storage.putLocal(projectId,KEY,state);
      return result??state;
    });
    this.flights.set(projectId,flight);try{return await flight;}finally{if(this.flights.get(projectId)===flight)this.flights.delete(projectId);}
  }
  read(projectId){return this.update(projectId,state=>{
    state.requests??=[];state.grants??=[];state.decisions??=[];state.executions??=[];
    // Obsolete ordinary permission requests close without user authorization
    // or automatic command replay; original sources remain backstage facts.
    if(state.schema!==2){
      state.schema=2;const now=new Date().toISOString();
      for(const request of state.requests)if(request.kind==null&&request.status==='pending'){request.status='migrated';request.migratedAt=now;}
    }
    for(const request of state.requests)if(request.status==='pending'&&request.effectType==='host-exec'&&request.frozenEffect&&!executionDanger(request.frozenEffect)){request.status='migrated';request.migratedAt=new Date().toISOString();request.migrationReason='default-yolo';}
    if(state.generation!==this.generation){
      state.generation=this.generation;
      // Stale only grants minted by an EARLIER generation: a grant written
      // before any read() persisted state.generation belongs to THIS
      // generation and must survive its first read.
      for(const grant of state.grants)if(live(grant)&&grant.generation!==this.generation){grant.status='stale-generation';grant.staledAt=new Date().toISOString();}
    }
  });}
  async prepareOrdinary(projectId,input){
    await this.read(projectId);
    const hash=effectHash(input.frozenEffect);
    const refusal=await this.update(projectId,state=>{
      const settled=state.executions.findLast(execution=>execution.permissionTaskId===input.permissionTaskId&&execution.effectHash===hash&&execution.operationKey===input.operationKey&&['completed','failed','auth-cancelled','auth-failed','unavailable'].includes(execution.status));
      if(settled)return {status:'executed',execution:structuredClone(settled),request:null,effectHash:hash};
      const denied=state.requests.find(r=>sameExecution(r.frozenEffect,input.frozenEffect)&&r.permissionTaskId===input.permissionTaskId&&['denied','cancelled'].includes(r.status));
      const revoked=state.grants.find(g=>sameExecution(g.frozenEffect,input.frozenEffect)&&g.permissionTaskId===input.permissionTaskId&&g.status==='revoked');
      if(denied||revoked)return {status:'denied',effectHash:hash,request:denied??null,grant:revoked??null,...(revoked?{reason:'revoked'}:{})};
      if(state.grants.some(g=>g.effectHash===hash&&g.permissionTaskId===input.permissionTaskId&&live(g)&&g.generation===this.generation))return null;
      const id=randomUUID();state.grants.push({id,requestId:'policy:'+id,kind:'effect',authority:'default-yolo',status:'granted',mode:'task',generation:this.generation,permissionTaskId:input.permissionTaskId,sourceJobId:input.sourceJobId,effectType:'host-exec',frozenEffect:input.frozenEffect,effectHash:hash,grantedAt:new Date().toISOString(),expiresAt:null});
    });
    if(['denied','executed'].includes(refusal?.status))return refusal;
    return this.prepareEffect(projectId,input);
  }
  // Gate one frozen sensitive effect. 'allowed' means a still-live grant of
  // this exact hash already covers this task; 'required' minted/kept a
  async prepareEffect(projectId,{sourceJobId,permissionTaskId,role=null,effectType,frozenEffect,ttlMs=EFFECT_TTL_MS,originalText=null,reason=null,remainingActions=null,completedOperations=null,operationKey=null}){
    if(sourceJobId!==null&&(!str(sourceJobId,200)||!sourceJobId.trim()))throw Object.assign(Error('效果授权请求参数无效'),{code:'INVALID_PERMISSION_REQUEST'});
    if(!str(permissionTaskId,200)||!permissionTaskId.trim()||typeof projectId!=='string'||!projectId)throw Object.assign(Error('效果授权请求参数无效'),{code:'INVALID_PERMISSION_REQUEST'});
    if(!str(effectType,64)||!effectType.trim())throw Object.assign(Error('效果类型无效。'),{code:'INVALID_PERMISSION_REQUEST'});
    let json;try{json=JSON.stringify(frozenEffect);}catch{throw Object.assign(Error('冻结效果必须可序列化。'),{code:'INVALID_PERMISSION_REQUEST'});}
    if(json.length>65536)throw Object.assign(Error('冻结效果过大。'),{code:'INVALID_PERMISSION_REQUEST'});
    const hash=effectHash(frozenEffect);
    if(ttlMs!==null&&(!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>7*24*60*60*1000))ttlMs=EFFECT_TTL_MS;
    return this.update(projectId,state=>{
      const now=new Date().toISOString();
      for(const grant of state.grants)if(live(grant)&&grant.expiresAt&&grant.expiresAt<=now){grant.status='expired';grant.endedAt=now;}
      const matchesExecution=execution=>execution.effectHash===hash||sameExecution((state.grants.find(g=>g.effectHash===execution.effectHash)??state.requests.find(r=>r.effectHash===execution.effectHash))?.frozenEffect,frozenEffect);
      // Crash-after-effect-before-receipt first: a durable started intent (or
      // unknown result) blocks EVERY path, including live task/root grants —
      // a crashed effect is never retried automatically.
      const startedOnly=(state.executions??[]).findLast(e=>e.permissionTaskId===permissionTaskId&&matchesExecution(e)&&['started','unknown'].includes(e.status));
      if(startedOnly)return {status:'unknown',request:null,effectHash:hash,execution:structuredClone(startedOnly)};
      // Same exact effect + same host operation id: idempotent receipt replay
      // FIRST — even under a still-live task grant, a settled operation never
      // repeats its action. A re-run needs a NEW operation id.
      const settled=(state.executions??[]).findLast(e=>e.permissionTaskId===permissionTaskId&&matchesExecution(e)&&['completed','failed','auth-cancelled','auth-failed','unavailable'].includes(e.status)&&(operationKey==null||e.operationKey===operationKey));
      if(settled)return {status:'executed',execution:structuredClone(settled),request:structuredClone((state.requests??[]).find(r=>r.id===settled.requestId)??null),effectHash:hash};
      const grant=state.grants.find(g=>live(g)&&g.effectHash===hash&&g.generation===this.generation&&g.permissionTaskId===permissionTaskId);
      if(grant)return {status:'allowed',grant:structuredClone(grant),request:structuredClone(state.requests.find(r=>r.id===grant.requestId)??null),effectHash:hash};
      // A user revoke of a task grant closes future admission for that exact
      // effect: silently re-requesting the same frozen command is refused.
      const revokedGrant=state.grants.find(g=>g.kind==='effect'&&g.status==='revoked'&&sameExecution(g.frozenEffect,frozenEffect)&&g.permissionTaskId===permissionTaskId);
      if(revokedGrant)return {status:'denied',request:null,grant:structuredClone(revokedGrant),effectHash:hash,reason:'revoked'};
      const denied=state.requests.find(r=>['denied','cancelled'].includes(r.status)&&r.permissionTaskId===permissionTaskId&&sameExecution(r.frozenEffect,frozenEffect));
      if(denied)return {status:'denied',request:structuredClone(denied),effectHash:hash};
      const unknown=(state.executions??[]).find(e=>e.effectHash===hash&&e.permissionTaskId===permissionTaskId&&e.status==='unknown');
      if(unknown)return {status:'unknown',request:null,effectHash:hash,execution:structuredClone(unknown)};
      const pending=state.requests.find(r=>r.status==='pending'&&r.permissionTaskId===permissionTaskId&&r.effectHash===hash);
      if(pending)return {status:'required',request:structuredClone(pending),effectHash:hash};
      const request={id:randomUUID(),version:1,kind:'effect',status:'pending',effectType,sourceJobId,permissionTaskId,sourceProjectId:projectId,role:str(role,64)?role:null,frozenEffect:structuredClone(frozenEffect),effectHash:hash,ttlMs,originalText:originalText==null?null:String(originalText).slice(0,400),reason:reason==null?null:String(reason).slice(0,400),remainingActions:remainingActions==null?null:String(remainingActions).slice(0,400),completedOperations:Array.isArray(completedOperations)?structuredClone(completedOperations).slice(0,50):null,createdAt:now};
      state.requests.push(request);return {status:'required',request:structuredClone(request),effectHash:hash};
    });
  }
  // Version-bound, idempotent user decision on one pending effect request.
  async decideEffect(projectId,{requestId,expectedVersion,action,requestKey,binding}){
    if(!['approve-once','approve-task','deny','cancel'].includes(action))throw Object.assign(Error('效果授权决定动作无效。'),{code:'INVALID_PAYLOAD'});
    return this.update(projectId,state=>{
      state.decisions??=[];
      const identity=JSON.stringify([requestId,expectedVersion,action]);
      const prior=state.decisions.find(d=>d.requestKey===requestKey);
      if(prior){if(prior.identity!==identity)throw Object.assign(Error('效果授权决定键冲突'),{code:'PERMISSION_DECISION_COLLISION'});return {duplicate:true,result:prior.result,grant:prior.result.grantId?structuredClone(state.grants.find(g=>g.id===prior.result.grantId)??null):null};}
      const request=state.requests.find(r=>r.id===requestId);
      if(!request||request.status!=='pending'||request.version!==expectedVersion)throw Object.assign(Error('效果授权请求已过期，请刷新核对'),{code:'STALE_ATTENTION'});
      if(binding&&request.sourceJobId!==binding.sourceJobId)throw Object.assign(Error('效果授权请求来源不符，请刷新核对'),{code:'STALE_ATTENTION'});
      const now=new Date().toISOString();request.version++;request.decidedAt=now;
      if(binding&&binding.taskCurrent===false){
        request.status='superseded';request.decision={action:'superseded',originalAction:action,requestKey,at:now,authority:'user-choice'};
        const superseded={accepted:true,action:'superseded',version:request.version,requestId,grantId:null};
        state.decisions.push({requestKey,identity,result:superseded});return {result:superseded,grant:null};
      }
      request.decision={action,requestKey,at:now,authority:'user-choice'};
      let grant=null;
      if(action==='approve-once'||action==='approve-task'){
        grant={id:randomUUID(),requestId,kind:'effect',status:'granted',version:1,mode:action==='approve-once'?'once':'task',generation:this.generation,sourceProjectId:request.sourceProjectId,sourceJobId:request.sourceJobId,role:request.role,permissionTaskId:request.permissionTaskId,effectType:request.effectType,frozenEffect:request.frozenEffect,effectHash:request.effectHash,grantedAt:now,expiresAt:request.ttlMs==null?null:new Date(Date.now()+request.ttlMs).toISOString()};
        state.grants.push(grant);request.status='approved';
      }else request.status=action==='deny'?'denied':'cancelled';
      const result={accepted:true,action,version:request.version,requestId,grantId:grant?grant.id:null};
      state.decisions.push({requestKey,identity,result});
      return {result,grant:grant?structuredClone(grant):null};
    });
  }
  // Last gate before any side effect: current generation, task binding,
  // expiry, revocation, and the exact frozen hash. Fail-closed.
  async preEffect(projectId,{effectHash:hash,permissionTaskId,sourceJobId=null,grantId=null,frozenEffect=null}){
    return this.update(projectId,state=>{
      const now=new Date().toISOString();
      for(const grant of state.grants)if(live(grant)&&grant.expiresAt&&grant.expiresAt<=now){grant.status='expired';grant.endedAt=now;}
      const candidates=(state.grants??[]).filter(g=>g.kind==='effect');
      let grant=grantId?candidates.find(g=>g.id===grantId):null;
      if(!grant)grant=candidates.find(g=>g.effectHash===hash&&g.permissionTaskId===permissionTaskId&&live(g));
      const refused=(state.requests??[]).find(r=>r.effectHash===hash&&r.permissionTaskId===permissionTaskId&&['denied','cancelled'].includes(r.status));
      const deny=(code,message)=>({ok:false,code,message,grant:grant?structuredClone(grant):null});
      if(!grant){
        // No live grant: surface the precise terminal state of any grant of
        // this exact effect+task instead of a generic "required".
        const priorGrant=candidates.find(g=>g.effectHash===hash&&g.permissionTaskId===permissionTaskId);
        if(priorGrant?.status==='stale-generation')return deny('EFFECT_STALE_GENERATION','授权属于重启前的会话，已失效；需用户在本代会话重新批准。');
        if(priorGrant?.status==='revoked')return deny('EFFECT_REVOKED','此授权已被用户撤销；未来准入已关闭，不自动重试。');
        if(priorGrant?.status==='task-ended')return deny('EFFECT_TASK_ENDED','原任务已结束，授权随之失效。');
        if(priorGrant?.status==='expired')return deny('EFFECT_EXPIRED','授权已过期；需重新申请。');
        return refused?deny('EFFECT_PERMISSION_DENIED','用户已拒绝此效果；不重试同一效果，继续原范围内其他工作或向用户说明。'):deny('EFFECT_PERMISSION_REQUIRED','等待用户批准该效果；批准后宿主会自动继续原任务。');
      }
      if(grant.generation!==this.generation)return deny('EFFECT_STALE_GENERATION','授权属于重启前的会话，已失效；需用户在本代会话重新批准。');
      if(grant.permissionTaskId!==permissionTaskId)return deny('EFFECT_HASH_MISMATCH','授权任务身份不符，未执行。');
      // The binding identity is the admission permissionTaskId (inherited only
      // by host continuations); the re-issuing job may be that continuation.
      if(grant.status==='revoked')return deny('EFFECT_REVOKED','此授权已被用户撤销；未来准入已关闭，不自动重试。');
      if(grant.status==='task-ended')return deny('EFFECT_TASK_ENDED','原任务已结束，授权随之失效。');
      if(grant.status==='expired')return deny('EFFECT_EXPIRED','授权已过期；需重新申请。');
      if(grant.status!=='granted')return deny('EFFECT_REVOKED','授权已消耗或失效（'+grant.status+'）。');
      // An unknown execution result is never replayed: the durable record
      // itself blocks a second attempt until the user resolves it explicitly.
      const unknown=(state.executions??[]).find(e=>(e.grantId===grant.id||e.requestId===grant.requestId)&&['unknown','started'].includes(e.status)&&e.effectHash===hash);
      if(unknown)return deny('EFFECT_RESULT_UNKNOWN','此效果上次执行结果未知或已在执行中，不自动重放；请在待办中核对实际结果后重新申请。');
      if(grant.effectHash!==hash)return deny('EFFECT_HASH_MISMATCH','效果与用户批准的冻结内容不一致，未执行；请重新申请。');
      const request=(state.requests??[]).find(r=>r.id===grant.requestId);
      return {ok:true,grant:structuredClone(grant),request:structuredClone(request??null)};
    });
  }
  // Durable execution outcome. Recorded exactly once per requestId for
  // once-mode grants; unknown results never auto-replay.
  async recordExecution(projectId,{requestId,grantId,effectHash:hash,result,operationKey=null}){
    if(!str(requestId,200)||!str(grantId,200)||!/^[a-f0-9]{64}$/.test(String(hash))||!result||!['started','completed','failed','unknown','cancelled','unavailable','auth-cancelled','auth-failed'].includes(result.status))throw Object.assign(Error('执行回执无效。'),{code:'INVALID_PAYLOAD'});
    return this.update(projectId,state=>{
      state.executions??=[];
      const grant=(state.grants??[]).find(g=>g.id===grantId);
      const prior=state.executions.find(e=>e.requestId===requestId&&e.operationKey===operationKey);
      const now=new Date().toISOString();
      if(prior&&prior.status!=='started')return {execution:structuredClone(prior),duplicate:true};
      if(prior&&result.status==='started')return {execution:structuredClone(prior),duplicate:true};
      if(prior&&prior.status==='started'){prior.status=result.status;prior.at=now;if(Number.isSafeInteger(result.exitCode))prior.exitCode=result.exitCode;if(result.actualIdentity&&typeof result.actualIdentity==='object')prior.actualIdentity=structuredClone(result.actualIdentity);if(str(result.receiptId,256))prior.receiptId=result.receiptId;if(grant&&live(grant)&&grant.mode==='once'&&['completed','failed','unknown'].includes(result.status)){grant.status='used';grant.usedAt=now;}return {execution:structuredClone(prior),duplicate:false};}
      const execution={id:randomUUID(),requestId,grantId,permissionTaskId:grant?.permissionTaskId??null,effectHash:hash,at:now,status:result.status,...(operationKey?{operationKey}:{}),...(Number.isSafeInteger(result.exitCode)?{exitCode:result.exitCode}:{}),...(result.actualIdentity&&typeof result.actualIdentity==='object'?{actualIdentity:structuredClone(result.actualIdentity)}:{}),...(str(result.receiptId,256)?{receiptId:result.receiptId}:{})};
      state.executions.push(execution);
      if(grant&&live(grant)&&grant.mode==='once'&&['completed','failed','unknown'].includes(result.status)){grant.status='used';grant.usedAt=now;}
      return {execution:structuredClone(execution),duplicate:false};
    });
  }
  // Consume a once-grant without an execution receipt (consent effects).
  async consumeGrant(projectId,{grantId,effectHash:hash}){
    return this.update(projectId,state=>{
      const grant=(state.grants??[]).find(g=>g.id===grantId);
      if(!grant||grant.effectHash!==hash||!live(grant)||grant.generation!==this.generation)throw Object.assign(Error('授权不存在、已失效或与冻结内容不符。'),{code:'STALE_ATTENTION'});
      const now=new Date().toISOString();grant.status='used';grant.usedAt=now;
      return {consumed:true,grantId,at:now};
    });
  }
  // User revoke of future admission. Never claims to reverse executed effects;
  // unresolved (unknown) executions are reported for explicit reconciliation.
  async revokeGrant(projectId,{grantId}){
    return this.update(projectId,state=>{
      const grant=(state.grants??[]).find(g=>g.id===grantId);
      if(!grant)throw Object.assign(Error('授权不存在，请刷新核对。'),{code:'STALE_ATTENTION'});
      const now=new Date().toISOString();
      if(live(grant)){grant.status='revoked';grant.revokedAt=now;grant.version=(grant.version??1)+1;}
      const unresolved=(state.executions??[]).filter(e=>e.grantId===grantId&&e.status==='unknown').map(e=>e.id);
      return {admissionRevoked:true,grant:structuredClone(grant),unresolvedExecutionIds:unresolved};
    });
  }
  // Task end invalidates every live grant of that admission identity.
  async endTask(projectId,permissionTaskId){
    return this.update(projectId,state=>{
      const now=new Date().toISOString();let ended=0;
      for(const grant of state.grants??[])if(live(grant)&&grant.permissionTaskId===permissionTaskId){grant.status='task-ended';grant.endedAt=now;ended++;}
      return {ended};
    });
  }
  // A pending effect request blocks automatic background handoff: the
  // wait-for-user decision must never be erased or bypassed.
  async heldFor(projectId,job){
    const state=await this.read(projectId);
    const permissionTaskId=job?.context?.permissionTaskId??job?.id??null;
    return (state.requests??[]).some(r=>r.status==='pending'&&r.kind==='effect'&&(r.sourceJobId===job?.id||r.permissionTaskId===permissionTaskId));
  }
  effectRequest(projectId,requestId){return this.update(projectId,state=>structuredClone((state.requests??[]).find(r=>r.id===requestId)??null));}
  effectGrant(projectId,grantId){return this.update(projectId,state=>structuredClone((state.grants??[]).find(g=>g.id===grantId)??null));}
}
