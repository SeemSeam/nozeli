import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PiSession} from './managed/pi-session.mjs';
import {recoverPiProvider} from './managed/pi-process-ownership.mjs';
import {THINKING_LEVELS,validateRoleDefaults} from './managed/provider-settings.mjs';
import {platformPersistence} from '../platform/shared/persistence.mjs';
import {windowsProductionManagedStorage,approvedCommandDigest} from './managed/windows-production-entry.mjs';
import {createWindowsDesktopProfileIO} from '../platform/windows/desktop-profile.mjs';
import {ensureExperimentalPrivateDirectory} from '../platform/windows/experimental-directories.mjs';
import {createExperimentalPiOwnerLaunch} from '../platform/windows/experimental-pi-owner-launch.mjs';
import {createOwnerLaunchRegistry} from '../main/owner-launch-registry.mjs';
import {createOwnerConfigurationSource} from '../platform/windows/owner-configuration-source.mjs';
import {managedStorageLocation} from '../platform/windows/managed-storage-scope.mjs';
import {defineRegisteredOwnerLaunch} from './managed/prepared-owner-launch.mjs';
import {validateRepair,repairDTO} from './admin-maintenance.mjs';
import {DEVELOPMENT_KINDS,validateDevelopment,developmentDTO,developmentReceipt} from './admin-development.mjs';

const packageRoot=fileURLToPath(new URL('./admin/roles',import.meta.url));
const roles=['frontdesk','orchestrator','worker'];
const sections=['settings-provider','settings-models','settings-appearance','settings-agents'];
const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const object=(p,keys)=>{if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!keys.includes(k)))fail('ADMIN_INVALID_PAYLOAD','管理请求字段无效。');};
const string=(v,max=300)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const syncDTO=value=>({applied:Number.isSafeInteger(value?.applied)?value.applied:0,pending:Number.isSafeInteger(value?.pending)?value.pending:0,failed:Array.isArray(value?.failed)?value.failed.map(()=>({code:'ADMIN_MODEL_SYNC_FAILED',message:'已保存，但此在线角色的应用未确认成功。'})):[{code:'ADMIN_MODEL_SYNC_UNKNOWN',message:'在线应用状态未知。'}],sessionCount:Array.isArray(value?.sessions)?value.sessions.length:null});
const schema=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const validView=value=>value?.schema===1&&Number.isSafeInteger(value.revision)&&value.revision>=0&&['auto','manual'].includes(value.placement?.mode)&&(value.placement.mode==='auto'||[value.placement.x,value.placement.y].every(Number.isFinite))&&(value.size===null||value.size&&[value.size.width,value.size.height].every(n=>Number.isFinite(n)&&n>0))&&typeof value.collapsed==='boolean'&&typeof value.hidden==='boolean';
const forceDTO=p=>{const {recoveryToken,...dto}=p;return dto;};
const validateForce=p=>{if(!string(p.project?.id,256)||!string(p.project?.root,32768)||!string(p.recoveryToken)||!string(p.backupDirectory,32768)||p.expectedVersion!==hash([p.project,p.recoveryToken,p.backupDirectory,p.currentProjectId]))fail('ADMIN_STORAGE_SCHEMA','恢复方案无效。');};
const validateState=state=>{
 if(state.schema!==1||typeof state.draft!=='string'||!Number.isSafeInteger(state.draftRevision)||state.draftRevision<0||!Number.isSafeInteger(state.configRevision)||state.configRevision<0||state.model!==null&&!string(state.model)||state.effort!==null&&!THINKING_LEVELS.includes(state.effort)||state.sessionId!==null&&!string(state.sessionId)||state.sessionFile!==null&&!string(state.sessionFile,32768)||!Array.isArray(state.requests)||!Array.isArray(state.proposals)||state.suggestions!==undefined&&!Array.isArray(state.suggestions))fail('ADMIN_STORAGE_SCHEMA','管理存储格式无效。');
 if(state.generation!==undefined&&(!Number.isSafeInteger(state.generation)||state.generation<0))fail('ADMIN_STORAGE_SCHEMA','管理会话代数无效。');
 for(const retained of state.retained??[])if(!retained||typeof retained!=='object'||!Number.isSafeInteger(retained.generation)||retained.generation<0||!string(retained.sessionId)||retained.sessionFile!==null&&!string(retained.sessionFile,32768)||!['retained-unconfirmed','retired'].includes(retained.status)||!string(retained.at))fail('ADMIN_STORAGE_SCHEMA','保留管理会话记录无效。');
 if(state.view!==undefined&&!validView(state.view))fail('ADMIN_STORAGE_SCHEMA','全局助手窗口状态无效，原记录保留。');
 for(const request of state.requests)if(!string(request.id)||!string(request.key,200)||!string(request.fingerprint)||typeof request.text!=='string'||!['executing','completed','cancelled','rejected','unknown'].includes(request.status))fail('ADMIN_STORAGE_SCHEMA','管理请求记录无效。');
 for(const proposal of state.proposals){if(!string(proposal.id)||!['defaults','repair','force-recovery','development'].includes(proposal.kind)||!string(proposal.expectedVersion)||!['prepared','executing','executed','dismissed','rejected','unknown'].includes(proposal.status))fail('ADMIN_STORAGE_SCHEMA','管理方案记录无效。');if(proposal.kind==='development')validateDevelopment(proposal);else if(proposal.kind==='force-recovery')validateForce(proposal);else if(proposal.kind==='repair')validateRepair(proposal);else{if(!roles.includes(proposal.role))fail('ADMIN_STORAGE_SCHEMA','管理角色无效。');validateRoleDefaults(proposal.before);validateRoleDefaults(proposal.after);}}
};
const nullableString={type:['string','null']};
export const ADMIN_TOOLS=[
 {name:'nozeli_admin_registry',description:'只读已注册项目摘要，不读项目内容。',inputSchema:schema({})},
 {name:'nozeli_admin_configuration',description:'只读脱敏全局默认配置及可选模型。',inputSchema:schema({})},
 {name:'nozeli_admin_prepare_defaults',description:'准备一个角色的全局默认方案；不会执行，必须由可信UI确认。null使用原生默认。',inputSchema:schema({role:{type:'string',enum:roles},model:nullableString,effort:{type:['string','null'],enum:[null,...THINKING_LEVELS]}})},
 {name:'nozeli_admin_suggest_project',description:'建议UI打开指定registry项目；不会导航。',inputSchema:schema({projectId:{type:'string'}})},
 {name:'nozeli_admin_suggest_settings',description:'建议UI打开设置；不读取凭据。',inputSchema:schema({section:{type:'string',enum:sections}})},
 {name:'nozeli_admin_diagnostics',description:'只读指定注册项目的脱敏分页维修状态；不连接项目或执行诊断任务。',inputSchema:schema({projectId:{type:'string'},cursor:nullableString,limit:{type:['integer','null'],minimum:1,maximum:24}})},
 {name:'nozeli_admin_prepare_repair',description:'仅凭当前诊断返回的source准备已声明技术恢复；无效果，必须由可信UI确认。',inputSchema:schema({source:{type:'string'}})},
 {name:'nozeli_admin_prepare_force_recovery',description:'准备指定注册项目的强制恢复访问方案；保留旧状态，不执行，必须由可信UI独立勾选确认。',inputSchema:schema({projectId:{type:'string'}})},
 {name:'nozeli_admin_prepare_development',description:'准备既有注册项目的开发交接方案，不执行；必须由可信 UI 独立确认后才提交正常项目任务。',inputSchema:schema({projectId:{type:'string'},kind:{type:'string',enum:DEVELOPMENT_KINDS},request:{type:'string',minLength:1,maxLength:16000}})},
];

/** Application-owned context. The journal stores operations, not a second chat log.
 * An executing operation recovered after a crash is unknown and NEVER replayed.
 * All trusted UI mutations and tool proposals share one serialized journal writer.
 */
export class AdminAgent {
 constructor({userDataDir,host,providerSettings,maintenance,development,piSource,piRuntime,processBudget,sessionFactory=spec=>new PiSession(spec)}={}){
  if(!path.isAbsolute(userDataDir??'')||!host||!providerSettings)throw Error('AdminAgent requires application storage, host and providerSettings');
  Object.assign(this,{host,providerSettings,maintenance,development,piSource,piRuntime,processBudget,sessionFactory});
  this.root=path.join(userDataDir,'admin-agent');this.file=path.join(this.root,'state.json');this.queue=Promise.resolve();this.entries=new Map();this.session=null;this.flight=null;this.stopping=false;
  // Windows production keeps the admin state record on the registered native
  // desktop profile (exclusive ACL, observed-revision CAS writes). Other
  // platforms keep the upstream atomic-JSON persistence.
  this.profile=process.platform==='win32'?createWindowsDesktopProfileIO(userDataDir):null;
  this.adminRetired=new Set();this.stateRevision=null;this.adminRegistry=null;
 }
 serial(fn){const result=this.queue.then(fn);this.queue=result.catch(()=>{});return result;}
 async start(){
  if(this.ready)return this.ready;
  this.ready=(async()=>{
   if(this.profile)await this.profile.ensureDirectory(this.root);
   else await fs.mkdir(this.root,{recursive:true,mode:0o700});
   let bytes=null,observed=null;
   if(this.profile){const record=await this.profile.read(this.file);bytes=record.bytes;observed=record.sha256;}
   else{try{bytes=await fs.readFile(this.file);}catch(e){if(e.code!=='ENOENT')throw e;}}
   this.stateRevision=observed??(bytes===null?null:createHash('sha256').update(bytes).digest('hex'));
   if(bytes===null)this.state={schema:1,draft:'',draftRevision:0,model:null,effort:null,configRevision:0,sessionId:null,sessionFile:null,requests:[],proposals:[]};
   else this.state=JSON.parse(bytes.toString('utf8'));
   this.state.generation??=0;this.state.retained??=[];
   validateState(this.state);
   for(const r of this.state.requests)if(r.status==='executing'){r.status='unknown';this.state.notice='上次请求结果未知，输入已保留，不会自动重放。';}
   this.state.suggestions??=[];
   for(const p of this.state.proposals)if(p.status==='executing'){p.status='unknown';p.receipt=p.kind==='development'?developmentReceipt(p,'unknown','上次开发交接结果未知，不会重新提交。'):p.kind==='repair'?{status:'unknown',repaired:null,message:'上次维修结果未知，不会重复执行。',projectId:p.projectId,bugId:p.bugId,operationId:p.id}:{saved:null,status:'unknown',operationId:p.id};}
   // Every retained owner whose exit was never independently verified keeps a
   // budget slot occupied on every restart (one per generation target); only an
   // actual process-ownership proof may verify and release it.
   this.retainedSlots=new Map();
   for(const row of this.state.retained??[]){
    if(!row.owner)continue;
    const slot=this.processBudget?.restoreSlot(null,this.adminTargetFor(row.generation));
    if(slot)this.retainedSlots.set(row,slot);
    if(row.owner.home===this.adminHomeFor(row.generation)){
     try{
      const receipt=await recoverPiProvider(row.owner,path.resolve(row.owner.home,'..','..'));
      if(receipt.verified){if(slot)this.processBudget?.release(slot);this.retainedSlots.delete(row);delete row.owner;}
     }catch{/* unverified or unsupported recovery: the slot stays occupied */}
    }
   }
   if(this.state.owner)this.recoveredSlot=this.processBudget?.restoreSlot(null,this.adminTargetFor(this.adminOwnerGeneration()));
   await this.save();await this.readHistory();
  })().catch(()=>fail('ADMIN_STORAGE_UNAVAILABLE','管理存储不可用或原生历史格式无效，原记录保留；未启动推理。'));return this.ready;
 }
 async save({supersededTolerated=false}={}){
  if(this.profile){
   // Observed-revision CAS record write. A conflicting revision propagates
   // as a structured error; the state is never overwritten or retried.
   if(this.stateSuperseded)return;
   try{
    const receipt=await this.profile.write(this.file,Buffer.from(JSON.stringify(this.state),'utf8'),{expectedSha256:this.stateRevision??null});
    this.stateRevision=receipt.sha256;return;
   }catch(error){
    // A refused CAS means a newer writer owns the record (for example an
    // agent reloaded after this one lost exclusivity). A stopping agent must
    // still finish its process custody; it never overwrites the newer record
    // and never retries the refused write.
    if(supersededTolerated&&error.code==='FS_VERSION_CONFLICT'){this.stateSuperseded=true;return;}
    throw error;
   }
  }
  await platformPersistence.writeAtomic(this.file,JSON.stringify(this.state));
 }
 busy(){return !!this.flight||!!this.session?.busy;}
 lifecycleBusy(){return this.busy()||(this.pendingMutations??0)>0||this.stopping;}
 referencesProvider(provider){return !this.state||[this.state.model,this.session?.model].some(model=>typeof model==='string'&&model.startsWith(provider+'/'));}
 async configuration(){try{return await this.providerSettings.adminSummary();}catch{return {...await this.providerSettings.defaultsSnapshot(),sources:[],notice:'账号目录暂不可用；全局默认配置仍可读取。'};}}
 async projects(){return (await this.host.recent()).projects.map(p=>({id:p.id,name:p.name,root:p.rootDisplay,available:p.available===true}));}
 async models(){try{return (await this.providerSettings.models()).map(m=>({selector:m.selector,name:m.name,thinking:m.thinking}));}catch{return [];}}
 async readHistory(){
  // Read-only display of the newest retained admin journal: the active
  // session file when present, else the latest archived generation.
  const reference=this.state.sessionFile??this.state.retained?.at(-1)?.sessionFile??null;
  if(!reference)return;
  const file=path.resolve(reference);
  const allowed=new Set([this.adminSessionDirectory(this.adminHomeFor(this.adminOwnerGeneration()))]);
  for(const row of this.state.retained??[]){
   if(!row.sessionFile)continue;
   if(!Number.isSafeInteger(row.generation)||row.generation>=this.adminOwnerGeneration())continue;
   const directory=this.adminSessionDirectory(this.adminHomeFor(row.generation));
   if(path.dirname(path.resolve(row.sessionFile))===directory)allowed.add(directory);
  }
  if(!allowed.has(path.dirname(file)))fail('ADMIN_HISTORY_SCOPE','管理原生历史路径不在独立目录。');
  let text;try{text=await fs.readFile(file,'utf8');}catch(e){if(e.code==='ENOENT')return;throw e;}
  const entries=new Map();let leafId;
  for(const line of text.split('\n')){if(!line.trim())continue;let entry;try{entry=JSON.parse(line);}catch{fail('ADMIN_HISTORY_INVALID','原生历史损坏，拒绝覆盖。');}if(entry.type!=='session'&&entry.id){entries.set(entry.id,entry);leafId=entry.id;}}
  this.entries=entries;this.leafId=leafId;
 }
 recordEntry({entry,sessionId}){
  if(!entry?.id||entry.type==='session'||sessionId&&sessionId!==this.session?.threadId||this.entries.has(entry.id))return;
  this.entries.set(entry.id,entry);this.leafId=entry.id;
 }
 messages(){
  const chain=[],seen=new Set();
  let entry=this.entries.get(this.leafId);
  while(entry&&!seen.has(entry.id)){seen.add(entry.id);chain.push(entry);entry=this.entries.get(entry.parentId);}
  return chain.reverse().flatMap(({id,type,message})=>{
   if(type!=='message'||!['user','assistant','toolResult'].includes(message?.role))return [];
   const {role}=message;
   if(role==='toolResult')return [{id,role,text:'',blocks:[{type:'toolResult',name:message.toolName,error:message.isError===true}]}];
   const content=typeof message.content==='string'?[{type:'text',text:message.content}]:message.content??[];
   const blocks=[];
   for(const part of content){
    if(part.type==='text'&&typeof part.text==='string'&&part.text.trim())blocks.push({type:'text',text:part.text});
    else if(role==='assistant'&&part.type==='toolCall')blocks.push({type:'toolCall',name:part.name});
   }
   if(role==='assistant'&&['error','aborted'].includes(message.stopReason))blocks.push({type:'stop',reason:message.stopReason});
   return blocks.length?[{id,role,text:blocks.filter(part=>part.type==='text').map(part=>part.text).join('\n'),blocks}]:[];
  });
 }
 async status(){await this.start();return {draft:this.state.draft,draftRevision:this.state.draftRevision,model:this.state.model,effort:this.state.effort,configRevision:this.state.configRevision,busy:this.busy(),sessionId:this.state.sessionId,messages:this.messages(),pendingChanges:this.state.proposals.map(p=>structuredClone(p.kind==='development'?developmentDTO(p):p.kind==='force-recovery'?forceDTO(p):p.kind==='repair'?repairDTO(p):p)),suggestions:structuredClone(this.state.suggestions),projects:await this.projects(),models:await this.models(),config:await this.configuration(),notice:this.state.notice??(!this.state.model?'请在默认模型中配置全局助手。':null),error:this.state.error??null};}
 invoke(op,payload={}){
  const mutation=['draft','configure','send','cancel','confirm','dismiss','view.write','prepareForceRecovery','prepareSkillMigration'].includes(op);
  if(mutation)this.pendingMutations=(this.pendingMutations??0)+1;
  return this.serial(async()=>{await this.start();return this.operation(op,payload);}).finally(()=>{if(mutation)this.pendingMutations--;});
 }
 async operation(op,p){
  switch(op){
   case 'prepareSkillMigration':{
    object(p,['projectId']);if(!this.development)fail('ADMIN_DEVELOPMENT_UNAVAILABLE','开发交接服务不可用。');
    const proposal=await this.development.prepare({projectId:p.projectId,kind:'skill',request:'制作 paracloud-gpu-capacity 的 Nozeli 派生技能。产物仅为 skills/paracloud-gpu-capacity/SKILL.md 独立文本，保留容量查询、资源匹配、队列、文件上传与下载、提交、状态、日志及取消能力；不要削减成只读说明。连接由宿主承担：原 cluster-ssh 依赖已核对，ParaCloud 网关固定命令也要求 PTY。容量走 nozeli_paracloud_capacity 的 snapshot/admission；文件和作业走 nozeli_paracloud_job 的 queue/upload/download/submit/status/log/cancel。使用当前项目配置及现有账号权限，写操作须先授权该项目连接；提交须确定是否接受排队，回执不明先核对，不换 requestId 重提；取消绑定同一提交回执。记录传输与操作边界，不复制账号、凭据、集群地址或原脚本。测试使用隔离数据，不连接真实集群、不派发作业、不声称已安装。发布候选须包含此文件，接受合入后在 Store 单独预览、选择角色并安装。'});
    validateDevelopment(proposal);this.state.proposals.push(proposal);await this.save();return developmentDTO(proposal);
   }
   case 'prepareForceRecovery':{
    object(p,['projectId']);if(!string(p.projectId,256)||!this.maintenance?.recovery)fail('ADMIN_INVALID_PAYLOAD','恢复服务或项目无效。');
    const project=(await this.projects()).find(row=>row.id===p.projectId);if(!project)fail('ADMIN_PROJECT_UNAVAILABLE','项目未注册。');
    const preview=await this.maintenance.recovery.preview({projectId:p.projectId,action:'force-recover'});
    const proposal={id:randomUUID(),kind:'force-recovery',status:'prepared',project:{id:project.id,name:project.name,root:preview.root},recoveryToken:preview.token,backupDirectory:preview.forceRecovery.backupDirectory,currentProjectId:preview.currentProjectId,explanation:preview.forceRecovery.reason,scope:'仅恢复文件访问；旧状态保留，不自动重放。',bindingConsequences:'建立独立本机实例，AI保持未连接；旧会话与草稿不自动迁入。'};
    proposal.expectedVersion=hash([proposal.project,proposal.recoveryToken,proposal.backupDirectory,proposal.currentProjectId]);validateForce(proposal);this.state.proposals.push(proposal);await this.save();return this.status();
   }
   case 'status':object(p,[]);return this.status();
   case 'view.read':object(p,[]);return {state:structuredClone(this.state.view??{schema:1,revision:0,placement:{mode:'auto'},size:null,collapsed:false,hidden:true})};
   case 'view.write':{
    object(p,['expectedRevision','next','reason']);
    if(!Number.isSafeInteger(p.expectedRevision)||p.expectedRevision<0||!validView(p.next)||!['move','resize','collapse','show','hide','reset'].includes(p.reason))fail('ADMIN_INVALID_PAYLOAD','全局助手窗口参数无效。');
    const current=this.state.view??{schema:1,revision:0,placement:{mode:'auto'},size:null,collapsed:false,hidden:true};
    if(current.revision!==p.expectedRevision)return {conflict:true,current:structuredClone(current)};
    this.state.view={schema:1,revision:current.revision+1,placement:structuredClone(p.next.placement),size:structuredClone(p.next.size),collapsed:p.next.collapsed,hidden:p.next.hidden};await this.save();return {revision:this.state.view.revision};
   }
   case 'draft':
    object(p,['text','expectedRevision']);if(typeof p.text!=='string'||p.text.length>200000)fail('ADMIN_INVALID_PAYLOAD','草稿过长。');
    if(p.expectedRevision!==this.state.draftRevision)fail('ADMIN_DRAFT_CONFLICT','管理草稿已更新，请刷新。');
    this.state.draft=p.text;this.state.draftRevision++;await this.save();return this.status();
   case 'configure':{
    object(p,['model','effort','expectedRevision']);if(this.stopping||this.busy())fail('ADMIN_BUSY','请在管理回合结束后配置模型。');
    if(p.expectedRevision!==this.state.configRevision)fail('ADMIN_CONFIG_CONFLICT','管理模型配置已更新。');
    if(!string(p.model)||!(await this.models()).some(m=>m.selector===p.model)||p.effort!==null&&!THINKING_LEVELS.includes(p.effort))fail('ADMIN_MODEL_REQUIRED','请选择已配置的独立模型和原生思考档位；账号请前往设置。');
    if(this.session){await this.session.stop();this.session=null;}
    this.state.model=p.model;this.state.effort=p.effort;this.state.configRevision++;await this.save();return this.status();
   }
   case 'send':{
    object(p,['text','requestKey','draftRevision']);if(typeof p.text!=='string'||!p.text.trim()||p.text.length>200000||!string(p.requestKey,200))fail('ADMIN_INVALID_PAYLOAD','管理输入或请求标识无效。');
    const fingerprint=hash({text:p.text,draftRevision:p.draftRevision});const prior=this.state.requests.find(r=>r.key===p.requestKey);
    if(prior){if(prior.fingerprint!==fingerprint)fail('ADMIN_REQUEST_CONFLICT','请求标识已用于不同输入。');return {accepted:true};}
    if(this.stopping||this.busy())fail('ADMIN_BUSY','管理助手仍在工作。');
    if(!this.state.model)fail('ADMIN_MODEL_REQUIRED','管理助手尚未配置独立模型，请先选择模型或打开账号设置。');
    if(p.draftRevision!==this.state.draftRevision)fail('ADMIN_DRAFT_CONFLICT','管理草稿已更新，请刷新后发送。');
    const request={id:randomUUID(),key:p.requestKey,fingerprint,text:p.text,status:'executing',cancelled:false};
    this.state.requests.push(request);this.state.error=null;
    if(this.state.draftRevision===p.draftRevision&&this.state.draft===p.text){this.state.draft='';this.state.draftRevision++;}
    await this.save();
    this.flight=this.run(request).catch(()=>{this.state.error={code:'ADMIN_STORAGE_UNAVAILABLE',message:'管理操作记录未能确认保存；不会自动重放输入。'};}).finally(()=>{this.flight=null;});return {accepted:true};
   }
   case 'cancel':object(p,[]);{const r=this.state.requests.findLast(r=>r.status==='executing');if(r){r.cancelled=true;await this.save();}if(this.session)void this.session.interrupt().catch(()=>this.serial(async()=>{this.state.error={code:'ADMIN_CANCEL_UNCONFIRMED',message:'取消尚未确认，原生工作可能仍在进行；不会自动重放。'};await this.save();}).catch(()=>{}));return this.status();}
   case 'confirm':{
    object(p,['id','expectedVersion','confirmForceRecovery','confirmDevelopment']);const proposal=this.state.proposals.find(x=>x.id===p.id);if(!proposal||p.expectedVersion!==proposal.expectedVersion)fail('ADMIN_PROPOSAL_CONFLICT','方案不存在或版本不匹配。');
    if(proposal.kind==='development'){
     if(p.confirmDevelopment!==true)fail('ADMIN_DEVELOPMENT_CONFIRMATION_REQUIRED','开发交接需要独立勾选确认。');validateDevelopment(proposal);
     if(proposal.status!=='prepared')return {...await this.status(),receipt:proposal.receipt??developmentReceipt(proposal,['executing','unknown'].includes(proposal.status)?'unknown':'blocked','此方案不再可提交，不会重新提交。')};
     if(this.stopping||this.busy())fail('ADMIN_BUSY','请在管理回合结束后确认开发交接。');
     proposal.status='executing';await this.save();
     try{proposal.receipt=this.development?await this.development.execute(structuredClone(proposal)):developmentReceipt(proposal,'blocked','开发交接服务不可用，未提交。');}
     catch{proposal.receipt=developmentReceipt(proposal,'unknown','开发交接结果未知，不会重新提交。');}
     proposal.status=proposal.receipt.status==='submitted'?'executed':proposal.receipt.status==='blocked'?'rejected':'unknown';await this.save();return {...await this.status(),receipt:proposal.receipt};
    }
    if(proposal.status!=='prepared')return {...await this.status(),receipt:proposal.receipt??(proposal.kind==='repair'?{status:proposal.status,repaired:['executing','unknown'].includes(proposal.status)?null:false,message:'此方案不再可执行；不会重复执行。',projectId:proposal.projectId,bugId:proposal.bugId,operationId:proposal.id}:{status:proposal.status,saved:['executing','unknown'].includes(proposal.status)?null:false,operationId:proposal.id})};
    if(proposal.kind==='force-recovery'){
     if(p.confirmForceRecovery!==true)fail('FORCE_RECOVERY_CONFIRMATION_REQUIRED','强制恢复需要独立勾选确认。');validateForce(proposal);if(this.stopping||this.busy())fail('ADMIN_BUSY','请在管理回合结束后确认恢复。');
     proposal.status='executing';await this.save();
     try{proposal.receipt=await this.maintenance.recovery.execute({token:proposal.recoveryToken,confirmForceRecovery:true});}catch(error){proposal.receipt={status:error.code==='LIFECYCLE_CONFIRMATION_EXPIRED'?'blocked':'unknown',recovered:error.code==='LIFECYCLE_CONFIRMATION_EXPIRED'?false:null,message:'恢复未能确认；不会重复执行，请重新准备。',automaticReplay:false};}
     proposal.status=proposal.receipt.status==='unknown'?'unknown':proposal.receipt.recovered===true?'executed':'rejected';await this.save();return {...await this.status(),receipt:proposal.receipt};
    }
    if(proposal.kind==='repair'){
     validateRepair(proposal);if(this.stopping||this.busy())fail('ADMIN_BUSY','请在管理回合结束后确认维修。');
     proposal.status='executing';await this.save();
     try{proposal.receipt=this.maintenance?await this.maintenance.execute(structuredClone(proposal)):{status:'blocked',repaired:false,message:'维修服务不可用；未执行。',projectId:proposal.projectId,bugId:proposal.bugId,operationId:proposal.id};}
     catch{proposal.receipt={status:'unknown',repaired:null,message:'维修结果未知，不会重复执行。',projectId:proposal.projectId,bugId:proposal.bugId,operationId:proposal.id};}
     proposal.status=proposal.receipt.status==='unknown'?'unknown':proposal.receipt.status==='blocked'?'rejected':'executed';await this.save();return {...await this.status(),receipt:proposal.receipt};
    }
    validateRoleDefaults(proposal.after);proposal.status='executing';await this.save();
    try{const result=await this.providerSettings.saveDefaults(proposal.after,{expectedVersion:proposal.expectedVersion});proposal.status='executed';proposal.receipt={saved:result.saved===true,modelSync:syncDTO(result.modelSync),status:'executed',operationId:proposal.id};}
    catch(e){proposal.status=e.code==='SETTINGS_CONFLICT'||e.code==='SETTINGS_INVALID'?'rejected':'unknown';proposal.receipt={saved:proposal.status==='rejected'?false:null,status:proposal.status,operationId:proposal.id,error:{code:proposal.status==='rejected'?'SETTINGS_CONFLICT':'ADMIN_EXECUTION_UNKNOWN',message:proposal.status==='rejected'?'全局配置已变化或方案失效，请重新准备。':'执行结果未知，不会重复执行。'}};}
    await this.save();return {...await this.status(),receipt:proposal.receipt};
   }
   case 'dismiss':object(p,['id']);{const proposal=this.state.proposals.find(x=>x.id===p.id);if(!proposal||proposal.status!=='prepared')fail('ADMIN_PROPOSAL_CONFLICT','只能撤销尚未执行的方案。');proposal.status='dismissed';await this.save();return this.status();}
   case 'openProject':object(p,['projectId']);if(!(await this.projects()).some(x=>x.id===p.projectId&&x.available))fail('ADMIN_PROJECT_UNAVAILABLE','项目未注册或不可用。');return {projectId:p.projectId};
   case 'openSettings':object(p,['section']);if(!sections.includes(p.section))fail('ADMIN_INVALID_PAYLOAD','设置入口无效。');return {section:p.section};
   default:fail('ADMIN_OP_DENIED','不支持的管理操作。');
  }
 }
 async tool(name,args,isCancelled=()=>false){return this.serial(async()=>{
  await this.start();if(isCancelled())fail('ADMIN_CANCELLED','管理请求已取消。');
  switch(name){
   case 'nozeli_admin_prepare_development':{
    object(args,['projectId','kind','request']);if(!this.development)fail('ADMIN_DEVELOPMENT_UNAVAILABLE','开发交接服务不可用。');
    const proposal=await this.development.prepare(args);validateDevelopment(proposal);this.state.proposals.push(proposal);await this.save();return {readOnly:true,continueTurn:true,userDecisionRequired:true,proposal:developmentDTO(proposal)};
   }
   case 'nozeli_admin_prepare_force_recovery':{await this.operation('prepareForceRecovery',args);return {readOnly:true,continueTurn:true,userDecisionRequired:true,proposal:forceDTO(this.state.proposals.at(-1))};}
   case 'nozeli_admin_registry':object(args,[]);return {readOnly:true,projects:await this.projects()};
   case 'nozeli_admin_configuration':object(args,[]);return {readOnly:true,...await this.configuration(),models:await this.models(),scope:'全局默认；项目 overrides 保持不变'};
   case 'nozeli_admin_diagnostics':{
    object(args,['projectId','cursor','limit']);if(Object.keys(args).length!==3||!string(args.projectId,256)||args.cursor!==null&&!string(args.cursor,256)||args.limit!==null&&(!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>24))fail('ADMIN_INVALID_PAYLOAD','诊断分页参数无效。');
    return this.maintenance?this.maintenance.read(args):{readOnly:true,continueTurn:true,supported:false,reason:'maintenance-unavailable',message:'维修服务不可用；项目注册和全局配置仍可查询。',rows:[],nextCursor:null};
   }
   case 'nozeli_admin_prepare_repair':{
    object(args,['source']);if(!string(args.source,256))fail('ADMIN_INVALID_PAYLOAD','维修来源无效。');if(!this.maintenance)fail('ADMIN_MAINTENANCE_UNAVAILABLE','维修服务不可用。');
    let frozen;try{frozen=await this.maintenance.prepare(args);}catch{fail('ADMIN_MAINTENANCE_STALE','维修来源已过期、状态变化或当前不可恢复；未执行，请重新诊断。');}
    const proposal={...frozen,id:randomUUID(),status:'prepared'};validateRepair(proposal);this.state.proposals.push(proposal);await this.save();return {readOnly:true,continueTurn:true,userDecisionRequired:true,proposal:repairDTO(proposal)};
   }
   case 'nozeli_admin_prepare_defaults':{
    object(args,['role','model','effort']);if(!roles.includes(args.role)||args.model!==null&&!string(args.model)||args.effort!==null&&!THINKING_LEVELS.includes(args.effort))fail('ADMIN_INVALID_PAYLOAD','单角色默认方案无效。');
    if(args.model!==null&&!(await this.models()).some(m=>m.selector===args.model))fail('ADMIN_MODEL_REQUIRED','模型不在已配置目录中，请打开设置。');
    const {defaults:before,version}=await this.providerSettings.defaultsSnapshot();const after=structuredClone(before);
    after[args.role]={model:args.model===null?{mode:'native-default'}:{mode:'explicit',selector:args.model},thinking:args.effort===null?{mode:'native-default'}:{mode:'explicit',level:args.effort}};
    validateRoleDefaults(after);const proposal={id:randomUUID(),kind:'defaults',role:args.role,before,after,expectedVersion:version,status:'prepared',scope:'全局默认/新生效；项目 overrides 保持不变'};
    this.state.proposals.push(proposal);await this.save();return {readOnly:true,userDecisionRequired:true,proposal:structuredClone(proposal)};
   }
   case 'nozeli_admin_suggest_project':{
    const {projectId}=await this.operation('openProject',args);const project=(await this.projects()).find(p=>p.id===projectId);
    const suggestion={id:randomUUID(),action:'openProject',projectId,name:project.name,root:project.root};this.state.suggestions.push(suggestion);await this.save();return {readOnly:true,...suggestion};
   }
   case 'nozeli_admin_suggest_settings':{
    const {section}=await this.operation('openSettings',args);const suggestion={id:randomUUID(),action:'openSettings',section};this.state.suggestions.push(suggestion);await this.save();return {readOnly:true,...suggestion};
   }
   default:fail('ADMIN_TOOL_DENIED','管理助手不能调用此工具。');
  }
 });}
 // ── Windows native admin owner: isolated generations ─────────────────────
 // The global assistant owns its private native owner home and launch-registry
 // target per generation. An unconfirmed prior owner (crash, restart, fenced
 // prepared registration) is never touched, retired or replayed: its home,
 // registration, journal and unknown request states are retained read-only,
 // and the next explicit admin input starts a genuinely new generation.
 adminOwnerGeneration(){return this.state?.generation??0;}
 adminHomeFor(generation){
  if(windowsProductionManagedStorage(this.host?.storage)){
   const root=managedStorageLocation(this.host.storage,this.host.storage.catalog,{code:'ADMIN_OWNER_INVALID'}).root;
   return path.join(root,'admin','agents',generation===0?'admin':'admin-g'+generation);
  }
  return path.join(this.root,'agents','admin');
 }
 adminTargetFor(generation){return generation===0?'admin':'admin-g'+generation;}
 async settleUncertainOwner(){
  const target=this.adminTargetFor(this.adminOwnerGeneration());
  if(!this.state.owner){
   // No live owner recorded. A durable registration for this target that only
   // another process instance could have retired still cannot be CAS-relaunched
   // by this fresh registry, so an explicit new input starts a new generation.
   if(this.adminRegistry&&!this.adminRetired.has(target)){
    let existing=null;
    try{existing=await this.adminRegistry.read(target);}catch{/* unreadable registration: treat as unknown, never reuse */}
    if(existing)this.retainCurrentGeneration(existing.value?.phase==='retired'?'retired':'retained-unconfirmed');
   }
   return;
  }
  let verified=false;
  try{await this.recoverOwner();verified=true;}
  catch(error){if(error.code!=='ADMIN_OWNER_UNCONFIRMED')throw error;}
  // A verified exit alone does not authorize reuse: the native registry only
  // admits a same-target launch CAS against a retirement recorded by THIS
  // process. Every other case keeps the old generation and starts a new one.
  if(verified&&this.adminRetired.has(target))return;
  this.retainCurrentGeneration('retained-unconfirmed');
 }
 retainCurrentGeneration(status='retained-unconfirmed'){
  const generation=this.adminOwnerGeneration();
  this.state.retained??=[];
  if(this.state.sessionId??this.state.sessionFile??this.state.owner)
   this.state.retained.push({generation,sessionId:this.state.sessionId??null,sessionFile:this.state.sessionFile??null,status,at:new Date().toISOString(),...(this.state.owner?{owner:this.state.owner}:{})});
  // The uncertain owner record moves into the retained row so it no longer
  // gates later generations, while its budget slot stays occupied in this
  // process and is restored again on every restart until an independent
  // process-ownership proof verifies and releases it.
  this.state.owner=null;
  this.state.generation=generation+1;
  this.state.sessionId=null;this.state.sessionFile=null;
  this.state.notice='上次全局助手会话未确认结束；原会话已保留为只读，新输入将开启全新会话，不会接续原会话。';
 }
 async ensureAdminRegistry(){
  if(!windowsProductionManagedStorage(this.host?.storage))return null;
  if(this.adminRegistry)return this.adminRegistry;
  const {root}=managedStorageLocation(this.host.storage,this.host.storage.catalog,{code:'ADMIN_OWNER_INVALID'});
  const registryDirectory=path.join(root,'admin','registry');
  await ensureExperimentalPrivateDirectory(root,registryDirectory);
  // App-global registry view: same durable CAS registrations and tool custody
  // as projects, bound to the fixed admin identity instead of a project.
  this.adminRegistry=createOwnerLaunchRegistry(Object.freeze({
   assertLocalOpen(){},
   async requireRegistered(){return {id:'admin',instanceId:'admin-agent'};},
   async localDirectory(){return registryDirectory;},
   db:this.host.storage.db}),'admin');
  return this.adminRegistry;
 }
 async adminRegisteredOwnerLaunch({generation,home,isCurrent}){
  if(!windowsProductionManagedStorage(this.host?.storage))return null;
  const piRuntime=this.piRuntime??{};
  if(typeof piRuntime.command!=='string'||!path.isAbsolute(piRuntime.command)||typeof piRuntime.entry!=='string'||!path.isAbsolute(piRuntime.entry))return null;
  const hex64=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:null;
  const approved=await approvedCommandDigest(piRuntime);
  const commandSha256=typeof approved==='string'?approved:null;
  const entrySha256=hex64(piRuntime.entrySha256)??hex64(piRuntime.manifest?.pi?.files?.['src/owner.mjs']);
  if(!commandSha256||!entrySha256)
   throw Object.assign(Error('未获批准的 Windows 管理助手 owner 启动来源证：'+(approved&&typeof approved==='object'?approved.message:commandSha256?'runtime entry digest':'bundled executable digest')),{code:approved&&typeof approved==='object'?approved.code:'PI_RUNTIME_UNAVAILABLE'});
  const {root}=managedStorageLocation(this.host.storage,this.host.storage.catalog,{code:'ADMIN_OWNER_INVALID'});
  await this.ensureAdminRegistry();
  const agentDir=path.join(home,'config'),target=this.adminTargetFor(generation);
  const runtime={command:piRuntime.command,commandSha256,entry:piRuntime.entry,entrySha256,agentDir,
   ...(piRuntime.nativeTools!==undefined?{nativeTools:piRuntime.nativeTools}:{}),
   ...(piRuntime.toolPath!==undefined?{toolPath:piRuntime.toolPath}:{}),
   ...(piRuntime.shell?{shell:piRuntime.shell}:{})};
  let service=createExperimentalPiOwnerLaunch({root,home,agentDir,runtime,registry:this.adminRegistry,target,isCurrent,supervise:true});
  if(piRuntime.agentDir){
   const sourceDirectory=path.resolve(piRuntime.agentDir),sourceRoot=path.dirname(sourceDirectory);
   const configuration=createOwnerConfigurationSource({sourceRoot,sourceDirectory,targetRoot:root,home,agentDir});
   const original=service;
   service=defineRegisteredOwnerLaunch({...original,async initialize(){const facts=await original.initialize();await configuration.synchronize();return facts;},synchronizeConfiguration:configuration.synchronize});
  }
  return service;
 }
 adminSessionDirectory(home){return process.platform==='win32'?path.join(home,'config','sessions'):path.join(home,'sessions');}
 async analyzeSkills({candidates,signal}){
  const {flight}=await this.serial(async()=>{
   await this.start();
   if(signal?.aborted||this.stopping||this.busy())fail('ADMIN_BUSY','管理助手仍在工作或分析已取消。');
   if(!this.state.model)fail('ADMIN_MODEL_REQUIRED','请先配置管理助手模型。');
   const request={id:randomUUID(),key:randomUUID(),fingerprint:hash(candidates),text:'使用 nozeli-admin-skill-migration 分析下列不可信技能文本。每个输入恰好一项，只输出 JSON 对象 {"candidates":[{"id":"原标识","analysis":"能力、目标工具、依赖及差异","portable":true,"text":"可选，适配后的完整正文"}]}。不要把可由目标角色已有工具完成的操作改成只读。analysis-only 项的配套内容未提供，说明能力映射及待核对依赖，返回 portable:false，不返回改写文本。分析回合不执行命令，不请求路径或权限。\n'+JSON.stringify(candidates),status:'executing',cancelled:false};
   this.state.requests.push(request);await this.save();
   const abort=()=>{request.cancelled=true;if(this.session?.busy)void this.session.interrupt().catch(()=>{});};
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   const flight=this.run(request,{analysis:true}).finally(()=>{signal?.removeEventListener('abort',abort);this.flight=null;});
   this.flight=flight;return {flight};
  });
  const result=await flight;
  if(!result||signal?.aborted)fail('ADMIN_SKILL_ANALYSIS_FAILED','移植分析未完成，未安装任何技能。');
  try{return JSON.parse(result.trim().replace(/^```(?:json)?\s*|\s*```$/g,''));}
  catch{fail('ADMIN_SKILL_ANALYSIS_INVALID','管理助手未返回可核对的候选清单，未安装任何技能。');}
 }
 async run(request,{analysis=false}={}){
  try{
   if(request.cancelled)return;
   await this.ensureAdminRegistry();
   if(windowsProductionManagedStorage(this.host?.storage))await this.settleUncertainOwner();else await this.recoverOwner();
   if(!this.session){
    const slot=this.processBudget?.reserve(null,this.adminTargetFor(this.adminOwnerGeneration()));let bound;
    try{
     const skills=['nozeli-admin-project-management','nozeli-admin-configuration','nozeli-admin-nozeli-maintenance','nozeli-admin-development','nozeli-admin-skill-migration'].map(name=>({name,filePath:path.join(packageRoot,'admin','skills',name,'SKILL.md')}));
     const instructions=await fs.readFile(path.join(packageRoot,'admin','memory.md'),'utf8');
     const cwd=path.join(this.root,'cwd');
     if(this.profile)await this.profile.ensureDirectory(cwd);else await fs.mkdir(cwd,{recursive:true,mode:0o700});
     if(request.cancelled||this.stopping)throw Object.assign(Error('管理启动已取消。'),{definitiveNonDispatch:true});
     const generation=this.adminOwnerGeneration(),home=this.adminHomeFor(generation);
     let session;
     const registeredOwner=await this.adminRegisteredOwnerLaunch({generation,home,isCurrent:token=>!this.stopping&&this.session===session&&token.ownerId===session.viewOwnerId});
     session=this.sessionFactory({role:'admin',home,sessionDir:this.adminSessionDirectory(home),cwd,model:this.state.model,effort:this.state.effort,piSystemSource:this.piSource,piRuntime:{...this.piRuntime,roleDefaultsFor:async()=>({selector:this.state.model,effort:this.state.effort}),modelFor:async()=>this.state.model},instructions,tools:ADMIN_TOOLS,nativeTools:['read'],roleSkillCatalog:skills,rolePackageRoot:packageRoot,...(registeredOwner?{registeredOwnerLaunch:registeredOwner}:{}),onSpawn:async()=>{bound?.spawned();if(this.session.groupRecord){this.state.owner=this.session.groupRecord;await this.serial(()=>this.save());}},onNativeEntry:fact=>this.recordEntry(fact),onTool:({tool,arguments:args,admission})=>{if(request.cancelled)fail('ADMIN_CANCELLED','管理请求已取消。');return admission.preEffect().then(()=>this.tool(tool,args,()=>request.cancelled));}});
     this.session=session;if(slot)bound=this.processBudget.bind(slot,session);
     await session.preflightToolsDigest?.();await session.start(this.state.sessionId??undefined);bound?.started();
     this.state.sessionId=session.threadId;this.state.sessionFile=session.sessionFile;await this.serial(()=>this.save());
     await this.readHistory();
     await session.applyDefaultModel({selector:this.state.model,...(this.state.effort!==null?{effort:this.state.effort}:{})});
    }catch(e){if(this.session){try{await this.session.stop();this.session=null;}catch{}}else if(slot)this.processBudget.release(slot);throw e;}
   }
   if(request.cancelled)return;
   const result=await this.session.prompt(request.text,{job:{id:request.id},restrictedMode:'admin',tools:analysis?[]:ADMIN_TOOLS,maxTurns:12,maxToolCalls:24,admissionCheck:()=>request.cancelled?'ADMIN_CANCELLED':null});
   request.status=request.cancelled||result.providerStatus==='cancelled'?'cancelled':'completed';
   if(analysis&&request.status==='completed')return result.text;
  }catch(e){request.status=e.definitiveNonDispatch?'rejected':'unknown';this.state.error={code:'ADMIN_REQUEST_UNCONFIRMED',message:'管理请求未确认完成；输入与原生历史保留，不会自动重放。'};}
  finally{if(request.status==='executing')request.status=request.cancelled?'cancelled':'unknown';await this.serial(()=>this.save());}
 }
 async recoverOwner(){
  if(!this.state.owner||this.session)return;
  if(this.state.owner.home!==this.adminHomeFor(this.adminOwnerGeneration()))fail('ADMIN_OWNER_SCOPE','原生管理进程身份目录无效，拒绝清理。');
  // The recorded owner home may be the shared userData layout or an isolated
  // native generation home; recovery always validates against that home's own
  // private agents base, never a different root.
  const receipt=await recoverPiProvider(this.state.owner,path.resolve(this.state.owner.home,'..','..'));
  if(!receipt.verified)fail('ADMIN_OWNER_UNCONFIRMED','管理进程退出未确认，保留占用。');
  this.state.owner=null;if(this.recoveredSlot)this.processBudget.release(this.recoveredSlot);this.recoveredSlot=null;await this.serial(()=>this.save());
 }
 stop(){
  if(this.stopFlight)return this.stopFlight;
  this.stopping=true;
  this.stopFlight=this.stopOwner().then(receipt=>{this.stopping=false;return receipt;}).finally(()=>{this.stopFlight=null;});
  return this.stopFlight;
 }
 async stopOwner(){
  await this.start();
  await this.serial(async()=>{const r=this.state.requests.findLast(x=>x.status==='executing');if(r)r.cancelled=true;await this.save({supersededTolerated:true});});
  if(this.session){
   await this.session.stop();
   // A retirement completed by this process is the only custody that admits a
   // same-target relaunch; record it before any later send reuses the home.
   if(this.session.registeredOwnerLaunch)this.adminRetired.add(this.adminTargetFor(this.adminOwnerGeneration()));
  }
  await this.flight;
  await this.recoverOwner();
  const receipt=this.session?await this.session.stop():{confirmationComplete:true,reason:'never-spawned'};
  if(receipt.confirmationComplete){this.state.owner=null;await this.serial(()=>this.save({supersededTolerated:true}));}
  this.session=null;return receipt;
 }
}
