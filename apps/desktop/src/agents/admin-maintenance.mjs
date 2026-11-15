import {randomUUID,createHash} from 'node:crypto';

const fail=code=>{throw Object.assign(Error(code),{code});};
const text=(v,max=32768)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v);
const exact=(p,keys)=>{if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!keys.includes(k)))fail('ADMIN_INVALID_PAYLOAD');};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same=(a,b)=>hash(a)===hash(b);
const modes=['repair','finalize'];
const scope='仅已声明技术恢复；不批准业务重放，未知结果不重复执行。恢复成功后，宿主可能按原有安全门继续原尚未开始的工作；已开始或未知效果不会重放。';
const bounded=value=>{if(Buffer.byteLength(JSON.stringify(value))>16000)fail('ADMIN_MAINTENANCE_TOO_LARGE');return value;};
const bindingKeys=['projectId','bugId','fingerprint','phase','jobId','workId','revision'];
export function validateRepair(p){
 exact(p,['kind','projectId','projectInstanceId','projectRoot','bugId','binding','retryMode','expectedRevision','faultStatus','pageCursor','pageLimit','project','fault','action','scope','expectedVersion','id','status','receipt']);exact(p.project,['id','name','root']);exact(p.fault,['id','phase','status','stateLabel','reason']);exact(p.action,['mode','label']);
 if(!text(p.fault.phase,256)||!text(p.fault.stateLabel,512)||p.fault.status!==p.faultStatus||p.fault.reason!==null&&!text(p.fault.reason,256)||!text(p.action.label,256)||p.receipt!==undefined&&(!['repaired','not-repaired','blocked','unknown'].includes(p.receipt.status)||![true,false,null].includes(p.receipt.repaired)||!text(p.receipt.message,1024)||p.receipt.projectId!==p.projectId||p.receipt.bugId!==p.bugId||p.receipt.operationId!==p.id))fail('ADMIN_STORAGE_SCHEMA');
 if(p.kind!=='repair'||!text(p.projectId,256)||!text(p.projectInstanceId,256)||!text(p.projectRoot)||!text(p.bugId,256)||!text(p.expectedRevision,256)||!modes.includes(p.retryMode)||!p.binding||Object.keys(p.binding).length!==bindingKeys.length||bindingKeys.some(k=>!Object.hasOwn(p.binding,k))||p.binding.projectId!==p.projectId||p.binding.bugId!==p.bugId||bindingKeys.filter(k=>k!=='revision').some(k=>p.binding[k]!==null&&!text(p.binding[k],256))||p.binding.revision!==null&&!Number.isSafeInteger(p.binding.revision)||!text(p.faultStatus,256)||!Number.isSafeInteger(p.pageLimit)||p.pageLimit<1||p.pageLimit>24||p.pageCursor!==null&&!text(p.pageCursor,8192)||p.project?.id!==p.projectId||!text(p.project?.name)||p.project?.root!==p.projectRoot||p.fault?.id!==p.bugId||p.action?.mode!==p.retryMode)fail('ADMIN_STORAGE_SCHEMA');
 if(p.expectedVersion!==repairVersion(p))fail('ADMIN_STORAGE_SCHEMA');
}
export const repairVersion=p=>hash([p.projectId,p.projectInstanceId,p.projectRoot,p.bugId,p.binding,p.retryMode,p.expectedRevision,p.faultStatus,p.pageCursor,p.pageLimit,p.project,p.fault,p.action]);
export const repairDTO=p=>({id:p.id,kind:'repair',project:p.project,fault:p.fault,action:p.action,scope,status:p.status,expectedVersion:p.expectedVersion,...(p.receipt?{receipt:p.receipt}:{})});

/** Read-only metadata adapter. Tokens are process-local evidence, never authority. */
export class AdminMaintenance {
 constructor({host,managed,recovery,now=Date.now,ttl=5*60*1000}={}){this.host=host;this.managed=managed;this.recovery=recovery;this.now=now;this.ttl=ttl;this.tokens=new Map();}
 token(value){for(const [key,row] of this.tokens)if(row.expires<=this.now())this.tokens.delete(key);while(this.tokens.size>=1024)this.tokens.delete(this.tokens.keys().next().value);const key=randomUUID();this.tokens.set(key,{...value,expires:this.now()+this.ttl});return key;}
 evidence(token,type){const value=this.tokens.get(token);if(!value||value.type!==type||value.expires<=this.now())fail('ADMIN_MAINTENANCE_SOURCE_STALE');return value;}
 async identity(id){const p=await this.host.requireRegisteredProject(id);if(p.id!==id||!text(p.instanceId,256)||!text(p.root)||p.removed)fail('ADMIN_MAINTENANCE_IDENTITY');return p;}
 async read(args){
  exact(args,['projectId','cursor','limit']);if(!text(args.projectId,256)||args.cursor!=null&&!text(args.cursor,256)||args.limit!=null&&(!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>24))fail('ADMIN_INVALID_PAYLOAD');
  try{
   const p=await this.identity(args.projectId),registry=(await this.host.recent()).projects.find(row=>row.id===p.id);
   if(!registry)fail('ADMIN_MAINTENANCE_IDENTITY');
   const project={id:p.id,instanceId:p.instanceId,name:p.name,root:p.root,available:registry.available===true};
   let cursor=null;if(args.cursor){const e=this.evidence(args.cursor,'cursor');if(e.projectId!==p.id||e.instanceId!==p.instanceId||e.root!==p.root)fail('ADMIN_MAINTENANCE_SOURCE_STALE');cursor=e.cursor;}
   let limit=args.limit??24;
   while(true){
    const page=await this.managed.maintenanceStatus(p.id,{cursor,limit});
    const rows=page.rows.map(row=>({id:row.id,phase:row.phase,status:row.status,stateLabel:row.stateLabel,reason:row.reason,capabilities:{retry:row.capabilities.retry===true,retryMode:row.capabilities.retryMode,retryReason:row.capabilities.retryReason},source:row.capabilities.retry&&modes.includes(row.capabilities.retryMode)?this.token({type:'source',projectId:p.id,instanceId:p.instanceId,root:p.root,cursor,limit,revision:page.revision,row:structuredClone(row)}):null}));
    const result={readOnly:true,continueTurn:true,supported:true,project,revision:page.revision,summary:page.summary,total:page.total,rows,nextCursor:page.nextCursor?this.token({type:'cursor',projectId:p.id,instanceId:p.instanceId,root:p.root,cursor:page.nextCursor}):null};
    if(Buffer.byteLength(JSON.stringify(result))<=16000)return result;
    if(limit===1)fail('ADMIN_MAINTENANCE_TOO_LARGE');limit=Math.max(1,Math.floor(limit/2));
   }
  }catch(error){const reason=['ADMIN_MAINTENANCE_TOO_LARGE','MAINTENANCE_PAGE_TOO_LARGE'].includes(error?.code)?'maintenance-page-too-large':['ADMIN_MAINTENANCE_SOURCE_STALE','MAINTENANCE_CURSOR_STALE'].includes(error?.code)?'maintenance-page-stale':'maintenance-unavailable';return {readOnly:true,continueTurn:true,supported:false,reason,message:'项目身份、维修元数据或分页状态不可用；未连接项目或执行修复。请刷新注册项目和诊断；元数据问题不能由此安全修复。',rows:[],nextCursor:null};}
 }
 async current(p){
  const identity=await this.identity(p.projectId);if(identity.instanceId!==p.projectInstanceId||identity.root!==p.projectRoot)fail('ADMIN_MAINTENANCE_IDENTITY');
  const page=await this.managed.maintenanceStatus(p.projectId,{cursor:p.pageCursor,limit:p.pageLimit});
  const row=page.rows.find(row=>row.id===p.bugId);
  if(page.revision!==p.expectedRevision||!row||!same(row.binding,p.binding)||row.status!==p.faultStatus||row.capabilities?.retry!==true||row.capabilities.retryMode!==p.retryMode)fail('ADMIN_MAINTENANCE_STALE');
  return row;
 }
 async prepare(args){
  exact(args,['source']);if(!text(args.source,256))fail('ADMIN_INVALID_PAYLOAD');
  const e=this.evidence(args.source,'source'),identity=await this.identity(e.projectId),row=e.row;
  const p={kind:'repair',projectId:e.projectId,projectInstanceId:e.instanceId,projectRoot:e.root,bugId:row.id,binding:structuredClone(row.binding),retryMode:row.capabilities.retryMode,expectedRevision:e.revision,faultStatus:row.status,pageCursor:e.cursor,pageLimit:e.limit,project:{id:e.projectId,name:identity.name,root:e.root},fault:{id:row.id,phase:row.phase,status:row.status,stateLabel:row.stateLabel,reason:row.reason},action:{mode:row.capabilities.retryMode,label:row.capabilities.retryMode==='finalize'?'完成维修收尾':'重试修复'},scope};
  p.expectedVersion=repairVersion(p);validateRepair(p);await this.current(p);return bounded(p);
 }
 async execute(p){
  validateRepair(p);
  const receipt=(status,repaired,message)=>({status,repaired,message,projectId:p.projectId,bugId:p.bugId,operationId:p.id});
  try{await this.current(p);}catch{return receipt('blocked',false,'项目身份、故障状态或实时维修能力已变化；未执行，请重新诊断。');}
  try{await this.managed.invoke('managed.maintenance.retry',{projectId:p.projectId,bugId:p.bugId,binding:structuredClone(p.binding),expectedRetryMode:p.retryMode});}
  catch{return receipt('unknown',null,'维修执行结果未知；不会重复执行，请重新读取诊断。');}
  try{
   const identity=await this.identity(p.projectId);if(identity.instanceId!==p.projectInstanceId||identity.root!==p.projectRoot)throw Error();
   let cursor=null;
   for(let i=0;i<256;i++){
    const page=await this.managed.maintenanceStatus(p.projectId,{cursor,limit:24}),row=page.rows.find(row=>row.id===p.bugId);
    if(row){if(!same(row.binding,p.binding))throw Error();return row.status==='repaired'?receipt('repaired',true,'原故障的宿主状态已核验为已修复。'):receipt('not-repaired',false,'原故障尚未修复；诊断或受理不等于修复，不会自动重复执行。');}
    cursor=page.nextCursor;if(!cursor)break;
   }
  }catch{}
  return receipt('unknown',null,'未能核验原故障最终状态；不会重复执行。');
 }
}
