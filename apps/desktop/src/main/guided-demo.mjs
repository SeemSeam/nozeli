import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {loadDemoTemplate,createDemoDirectory,demoDirectoryIdentity,sameDemoDirectory,compareDemoFiles} from './guided-demo-files.mjs';
import {demoChapters,demoCommands} from '../domain/guided-demo.mjs';
import {tagMaterialSnapshot} from '../agents/managed/tag-material-delivery.mjs';
import {preferredRegionAssets} from '../domain/region-drawing.mjs';

const fail=(code,message)=>Object.assign(new Error(message),{code});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(parent,child)=>{const rel=path.relative(parent,child);return rel===''||!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel);};
const clone=value=>structuredClone(value);
const source='demo-fixture';
const commands=new Set(Object.values(demoCommands));
const chapterIds=new Set(demoChapters.map(chapter=>chapter.id));
const recordLimit=200;
const fixedReply='【演示内容 · 本地固定回复】我已收到这处材料与问题。示例比较了两种方法的测量结果：方法 B 的平均误差较低，但还需要结合样本数与适用条件判断。你可以继续提问，或回到原文修改与批注。本回复不来自模型，也没有启动后台 Worker。';
const demoNotices={
 'task-a':'已提交后台任务 A【演示】·目标：整理两种方法的测量数据。提交后即可继续其他工作，不必等待。',
 'task-b':'已提交后台任务 B【演示】·目标：汇总采样条件说明。两个后台任务并行推进，前台问答不受影响。',
 'progress':'后台进展【演示】：任务 A 正在核对测量表；任务 B 正在整理采样说明。完成的任务会进入待办，等你审核。',
 'task-a-done':'任务 A 完成【演示】·成果《方法比较报告》已生成并进入待办。注意：任务尚未结束——审核决定后才闭环。',
 'task-b-done':'任务 B 完成【演示】·成果《数据整理报告》已生成，同样等待你的审核。',
 'decision-continue':'你选择了“继续”【演示】：要求补充采样时段说明。Agent 继续完善，任务保持打开。',
 'decision-accept':'你选择了“接受”【演示】：采纳示例结论，任务闭环结束；未改动真实任务或论文。',
 'decision-discard':'你选择了“丢弃”【演示】：保留原文、不采纳修改，任务闭环结束。',
};
const demoConversationMarkers={'frontdesk-ask':'同一时段观测','task-a':'已提交后台任务 A','task-b':'已提交后台任务 B','progress':'后台进展','decision-continue':'要求补充采样时段说明'};
const fixtureTitles={'task-a-done':'【演示内容】任务 A · 方法比较报告','task-b-done':'【演示内容】任务 B · 数据整理报告'};
const blankProjection=()=>({source,demo:true,works:[],jobs:[],todos:[],receipts:[],messages:[],drafts:{},agents:[],limit:0,quotaUsed:0,configuringTargets:[],externalTerminalTargets:[],nativeDraftTargets:[],busyTargets:[],stopping:false});
export async function createGuidedDemo(options){const manager=new GuidedDemo(options);await manager.initialize();return manager;}
export class GuidedDemo {
 constructor({host,userDataDir,appRoot,examplesRoot,workspace,onEvent=()=>{}}){
  Object.assign(this,{host,userDataDir:path.resolve(userDataDir),appRoot:path.resolve(appRoot),examplesRoot:path.resolve(examplesRoot),workspace,onEvent});
  this.file=path.join(this.userDataDir,'guided-demo','registry.json');this.data={schemaVersion:1,projects:{}};this.serial=Promise.resolve();this.pending=new Map();
  this.pointerOrigins=new Map();
 }
 async initialize(){
  if(inside(this.userDataDir,this.examplesRoot)||inside(this.examplesRoot,this.userDataDir))throw fail('DEMO_ROOT_DENIED','演示副本必须位于应用配置目录之外。');
  await fs.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
  const directory=await fs.lstat(path.dirname(this.file));if(!directory.isDirectory()||directory.isSymbolicLink())throw fail('DEMO_REGISTRY_INVALID','演示私有登记目录无效。');
  try{const stat=await fs.lstat(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw fail('DEMO_REGISTRY_INVALID','演示登记文件无效。');this.data=JSON.parse(await fs.readFile(this.file,'utf8'));if(this.data.schemaVersion!==1||!this.data.projects||Array.isArray(this.data.projects))throw fail('DEMO_REGISTRY_INVALID','演示登记版本无效。');}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const [id,row] of Object.entries(this.data.projects)){
   if(row.projectId!==id||!row.session||row.session.projectId!==id||!path.isAbsolute(row.root)||!row.identity||!row.manifestDigest||!row.instanceId)throw fail('DEMO_REGISTRY_INVALID','演示身份登记损坏；未启用模型回退。');
   row.session.epoch++;if(!['stopped','finished','removed'].includes(row.session.status))row.session.status='paused';row.session.recovered=true;
   if(row.inflight){row.session.error={code:'DEMO_ACTION_UNCONFIRMED',message:'上次动作结果未确认；请核对原文件，可以随时结束并保留现场。'};row.inflight.status='unknown';}
  }
  await this.save();
 }
 async save(){const temporary=this.file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,JSON.stringify(this.data),{flag:'wx',mode:0o600});await fs.rename(temporary,this.file);}finally{await fs.rm(temporary,{force:true});}}
 mutate(fn){
  const operation=this.serial.then(async()=>{
   const prior=clone(this.data);
   try{const value=await fn();await this.save();return value;}
   catch(error){
    // Native pending receipts retain row references. Roll back rows in place.
    const projects=this.data.projects;
    for(const id of Object.keys(projects))if(!Object.hasOwn(prior.projects,id))delete projects[id];
    for(const [id,snapshot]of Object.entries(prior.projects)){
     if(projects[id]){for(const key of Object.keys(projects[id]))delete projects[id][key];Object.assign(projects[id],snapshot);}
     else projects[id]=snapshot;
    }
    this.data={...prior,projects};throw error;
   }
  });
  this.serial=operation.catch(()=>{});return operation;
 }
 isDemo(projectId){return Boolean(projectId&&Object.hasOwn(this.data.projects,projectId));}
 row(projectId){const row=this.data.projects[projectId];if(!row)throw fail('DEMO_NOT_OWNED','项目不是本机登记的演示副本。');return row;}
 async verify(projectId,{allowRemoved=false}={}){
  const row=this.row(projectId),project=await this.host.requireRegisteredProject(projectId);
  if(row.removed&&!allowRemoved||project.instanceId!==row.instanceId||project.root!==row.root||!sameDemoDirectory(row.identity,project.identity)||!sameDemoDirectory(row.identity,await demoDirectoryIdentity(row.root)))throw fail('DEMO_IDENTITY_CHANGED','演示项目身份或目录已变化，自动操作已停止。');
  const manifest=path.join(row.root,'.nozeli','project.json'),stat=await fs.lstat(manifest,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536||!sameDemoDirectory(row.manifestIdentity,{dev:String(stat.dev),ino:String(stat.ino)})||digest(await fs.readFile(manifest))!==row.manifestDigest)throw fail('DEMO_IDENTITY_CHANGED','演示项目清单已变化，原授权不再适用。');
  return {row,project};
 }
 async bound(payload,{playing=false}={}){const checked=await this.verify(payload.projectId),s=checked.row.session;if(payload.sessionId!==s.id||payload.epoch!==s.epoch)throw fail('DEMO_SESSION_STALE','演示会话已变化，旧动作未执行。');if(playing&&s.status!=='playing')throw fail('DEMO_PAUSED','演示已暂停，未执行新动作。');return checked;}
 public(row){return {isDemo:true,demo:true,source,project:clone(row.project),session:clone(row.session),returnProjectId:row.returnProjectId??null,templateVersion:row.templateVersion,templateDigest:row.templateDigest,cleanup:clone(row.cleanup??null)};}
 emit(row){const value=this.public(row);this.onEvent({type:'demo.changed',...value});this.workspace?.broadcast('nozeli:demo-changed',value,row.projectId);const shell=this.workspace?.shell;if(shell&&!shell.dead&&shell.projectId!==row.projectId)shell.wc.send('nozeli:demo-changed',value);const state=this.projection(row);this.workspace?.broadcast('nozeli:agent',{projectId:row.projectId,kind:'managed-state',source,demo:true,state},row.projectId);return value;}
 projection(row){return {...blankProjection(),...clone(row.projection),source,demo:true,contentRoot:row.root,attentionNotified:row.projection.todos.filter(todo=>todo.notified).map(todo=>todo.id),timeline:this.page(row,{})};}
 async create(payload={}){
  const operation=(this.opening??Promise.resolve()).catch(()=>{}).then(()=>this.openDemo(payload));this.opening=operation;
  try{return await operation;}finally{if(this.opening===operation)this.opening=null;}
 }
 async openDemo({confirmed=false,chapterId='learn',returnProjectId=null}={}){
  if(confirmed!==true)throw fail('DEMO_CONFIRM_REQUIRED','请先确认创建独立演示副本及离线固定回复。');if(!chapterIds.has(chapterId))throw fail('DEMO_CHAPTER_INVALID','未知演示章节。');
  const template=await loadDemoTemplate(this.appRoot),templateDigest=digest(JSON.stringify(template.manifest));
  const rows=Object.values(this.data.projects),current=this.workspace?.shell?.projectId;
  const existing=rows.find(row=>row.projectId===current&&!row.cleanup?.trashed)??rows.find(row=>!row.cleanup?.trashed);
  if(existing&&existing.templateDigest===templateDigest){
   await this.verify(existing.projectId,{allowRemoved:true});
   for(const row of rows)if(row!==existing&&!row.removed)await this.exit({...row.session,sessionId:row.session.id});
   if(existing.inflight)throw fail('DEMO_ACTION_PENDING','原演示动作尚在收尾，请稍后重新进入。');
   const publicProject=await this.host.registerDirectory(existing.root);
   await this.mutate(()=>{existing.removed=false;existing.project={...publicProject,demo:true,source};existing.cleanup=null;existing.returnProjectId=returnProjectId;existing.projection=blankProjection();existing.requests={};existing.reports={};existing.lastAction=null;existing.session={id:randomUUID(),projectId:existing.projectId,epoch:existing.session.epoch+1,status:'paused',chapterId,stepIndex:0,createdAt:new Date().toISOString()};});
   return this.emit(existing);
  }
  if(existing){
   // A copy made from an older template cannot serve the current catalog:
   // its recorded expectedFiles no longer match the shipped steps (for
   // example a step that opens sample.tex on a copy created before that file
   // existed). Retire it through the normal lifecycle — registration removed,
   // every file on disk kept — and start the new session from the current
   // template instead of reusing stale expectedFiles.
   await this.verify(existing.projectId,{allowRemoved:true});
   for(const row of rows)if(row!==existing&&!row.removed)await this.exit({...row.session,sessionId:row.session.id});
   if(existing.inflight)throw fail('DEMO_ACTION_PENDING','原演示动作尚在收尾，请稍后重新进入。');
   const retireSession=existing.session.id;
   await this.host.registerDirectory(existing.root);
   await this.mutate(()=>{if(existing.session.status!=='removed')existing.session.status='stopped';existing.session.epoch++;});
   this.emit(existing);
   await this.lifecycle.removeProject(existing.projectId,{operationId:'demo-template-retire:'+retireSession});
   await this.mutate(()=>{delete this.data.projects[existing.projectId];});
  }
  const created=await createDemoDirectory({template,examplesRoot:this.examplesRoot});
  // Register privately before any renderer can open this directory. Normal
  // project registration owns .nozeli and the Git baseline; no real agent runs.
  const publicProject=await this.host.registerDirectory(created.root),project=await this.host.requireRegisteredProject(publicProject.id),manifest=path.join(created.root,'.nozeli','project.json');
  const manifestStat=await fs.lstat(manifest,{bigint:true}),manifestIdentity={dev:String(manifestStat.dev),ino:String(manifestStat.ino)};
  const row={...created,projectId:project.id,instanceId:project.instanceId,manifestIdentity,manifestDigest:digest(await fs.readFile(manifest)),project:{...publicProject,demo:true,source},returnProjectId,templateDigest,projection:blankProjection(),requests:{},session:{id:randomUUID(),projectId:project.id,epoch:1,status:'paused',chapterId,stepIndex:0,createdAt:new Date().toISOString()},createdAt:new Date().toISOString()};
  await this.mutate(()=>{this.data.projects[project.id]=row;});return this.emit(row);
 }
 async state({projectId}={}){if(!projectId)return {isDemo:false,demo:false,source,projects:Object.values(this.data.projects).filter(row=>!row.removed).map(row=>this.public(row))};if(!this.isDemo(projectId))return {isDemo:false,demo:false,projectId};const row=this.row(projectId);try{await this.verify(projectId);}catch(error){return {...this.public(row),isDemo:true,available:false,error:{code:error.code,message:error.message}};}return {...this.public(row),isDemo:true,messages:clone(row.projection.messages),todos:clone(row.projection.todos),available:true};}
 async transition(payload){
  const {row}=await this.bound(payload),{action}=payload;
  if(!['play','pause','stop','chapter','finish','advance','seek'].includes(action))throw fail('DEMO_TRANSITION_INVALID','未知播放动作。');
  if(payload.chapterId!==undefined&&!chapterIds.has(payload.chapterId))throw fail('DEMO_CHAPTER_INVALID','未知演示章节。');
  if(payload.stepIndex!==undefined&&(!Number.isSafeInteger(payload.stepIndex)||payload.stepIndex<0||payload.stepIndex>demoChapters.find(chapter=>chapter.id===(payload.chapterId??row.session.chapterId)).steps.length))throw fail('DEMO_STEP_INVALID','演示步骤不存在。');
  if(row.inflight&&['play','chapter'].includes(action))throw fail('DEMO_ACTION_PENDING','原动作尚未核实，暂停后不会重放。');
  if(action==='play'&&['DEMO_SCOPE_CHANGED','DEMO_ACTION_TIMEOUT'].includes(row.session.error?.code)&&!['file.open','report.open','diff.open','pdf.page'].includes(row.lastAction?.command))throw fail('DEMO_ACTION_UNCONFIRMED','原动作可能已部分完成，不能自动重放；请核对当前示例，可以随时结束。');
  if(action==='seek'&&!['playing','paused'].includes(row.session.status))throw fail('DEMO_SESSION_STALE','演示已结束，不能跳转。');
  if(action==='seek'&&payload.resume!==undefined&&typeof payload.resume!=='boolean')throw fail('DEMO_TRANSITION_INVALID','跳转播放意图无效。');
  await this.mutate(async()=>{const checked=await this.bound(payload);const s=checked.row.session;
   if(action==='advance'&&s.status!=='playing')throw fail('DEMO_PAUSED','演示未在播放，advance 不得恢复播放；请显式继续。');
   if(!['advance','pause'].includes(action)&&s.status==='removed')throw fail('DEMO_SESSION_STALE','演示项目已清理。');
   if(action==='seek'&&s.status!=='playing'&&s.status!=='paused')throw fail('DEMO_SESSION_STALE','演示已结束，不能跳转。');
   s.epoch++;delete s.error;if(action==='play')s.status='playing';else if(action==='stop')s.status='stopped';else if(action==='finish')s.status='finished';else if(action==='advance'){s.stepIndex++;}else if(action==='seek'){s.chapterId=payload.chapterId;s.stepIndex=payload.stepIndex??0;if(payload.resume===true)s.status='playing';}else{s.status='paused';if(action==='chapter'){s.chapterId=payload.chapterId;s.stepIndex=payload.stepIndex??0;}}s.updatedAt=new Date().toISOString();});
  if(action==='play'&&this.workspace?.screen?.getCursorScreenPoint)this.pointerOrigins.set(row.projectId,this.workspace.screen.getCursorScreenPoint());
  return this.emit(row);
 }
 async pauseProject(projectId,reason='用户介入，演示已暂停。'){
  if(!this.isDemo(projectId))return;const row=this.row(projectId);if(row.session.status!=='playing')return;
  await this.mutate(()=>{row.session.status='paused';row.session.epoch++;row.session.reason=reason;});this.emit(row);
 }
 async perform(scope,payload){
  const {row}=await this.bound(payload,{playing:true});if(!commands.has(payload.command))throw fail('DEMO_COMMAND_DENIED','未允许的演示语义动作。');
  if(scope.role!=='shell'||scope.projectId!==row.projectId)throw fail('DEMO_SCOPE_DENIED','播放动作只允许原演示项目主窗发起。');
  if(row.inflight)throw fail('DEMO_ACTION_PENDING','已有原子动作正在收尾。');
  const args=payload.args??{};if(!args||typeof args!=='object'||Array.isArray(args)||Buffer.byteLength(JSON.stringify(args))>65536)throw fail('DEMO_ARGUMENTS_INVALID','演示参数无效。');if(args.semantic!==undefined&&(typeof args.semantic!=='string'||(demoCommands[args.semantic]??null)!==payload.command))throw fail('DEMO_ARGUMENTS_INVALID','演示语义与宿主命令不一致。');
  if(payload.relPath&&!Object.hasOwn(row.expectedFiles,payload.relPath))throw fail('DEMO_FILE_DENIED','演示动作不能访问模板外的文件。');
  if(payload.relPath&&!['file.open','report.open','diff.open','pdf.page'].includes(payload.command)){
   const file=path.join(row.root,...payload.relPath.split('/')),stat=await fs.lstat(file);
   if(!stat.isFile()||stat.isSymbolicLink()||digest(await fs.readFile(file))!==row.expectedFiles[payload.relPath])throw fail('DEMO_CONTENT_CHANGED','来源文件已变化；自动操作已暂停，保留所有探索内容，可以随时结束。');
  }
  let todoId=null;
  if(payload.command==='conversation.ask'){
   // The offline reply commits first (idempotent by step key); the step only
   // settles after the real conversation surface shows the exchange.
   const sent=await this.send({...payload,target:'frontdesk',text:'两种方法是否在同一时段观测？请快速回答。',requestKey:'demo-step:'+args.stepId});
   await this.workspace.performDemoAction(scope,{...payload,args:{...args,expect:demoConversationMarkers[args.semantic]??'本地固定回复'}},{manager:this,row});
   return sent;
  }
  if(payload.command==='notification.show'){
   const semantic=args.semantic;
   if(['task-a','task-b','progress','decision-continue'].includes(semantic)){
    await this.notice(row,semantic);
    await this.workspace.performDemoAction(scope,{...payload,args:{...args,expect:demoConversationMarkers[semantic]}},{manager:this,row});
    return {ok:true,source,noticed:true,conversation:true};
   }
   if(['task-a-done','task-b-done'].includes(semantic)){todoId=(await this.publishFixture(row,payload)).todoId;await this.notice(row,semantic);}
   else if(['decision-accept','decision-discard'].includes(semantic)){
    todoId=row.projection.todos.filter(todo=>todo.kind==='result'&&todo.status==='open').at(-1)?.id;
    if(!todoId)throw fail('DEMO_TODO_MISSING','没有待审核的演示任务。');
    const decision=semantic==='decision-accept'?'accept':'discard';
    // The decision is a real click in the visible report footer (the same
    // button a user presses); the host only appends the timeline notice after
    // the report surface confirms the settled todo.
    const receipt=await this.workspace.performDemoAction(scope,{...payload,args:{...args,todoId,decision}},{manager:this,row});
    await this.notice(row,semantic);
    return receipt;
   }
  }
  if(payload.command==='report.open'){todoId=row.projection.todos.filter(todo=>todo.kind==='result'&&todo.status==='open').at(-1)?.id;if(!todoId)throw fail('DEMO_TODO_MISSING','原演示报告事项已不存在；没有创建替代任务。');}
  return this.workspace.performDemoAction(scope,{...payload,args:{...args,...(todoId?{todoId}:{})}},{manager:this,row});
 }
 async acceptAction(row,{requestId,command,viewId,generation,sessionId,epoch,relPath}){await this.mutate(()=>{if(row.inflight||row.session.id!==sessionId||row.session.epoch!==epoch||row.session.status!=='playing')throw fail('DEMO_ACTION_PENDING','动作身份已变化或已有动作执行中。');row.inflight={requestId,command,viewId,generation,sessionId,epoch,relPath,chapterId:row.session.chapterId,stepIndex:row.session.stepIndex,status:'accepted',at:new Date().toISOString()};});}
 async settleAction(row,requestId,result){
  await this.mutate(()=>{
   const pending=row.inflight;if(pending?.requestId!==requestId)return;
   row.lastAction={...pending,status:result.ok?'completed':'failed',result:clone(result),settledAt:new Date().toISOString()};
   delete row.inflight;
   const s=row.session;
   if(result.ok&&s.status!=='playing'&&s.id===pending.sessionId&&s.chapterId===pending.chapterId&&s.stepIndex===pending.stepIndex){s.stepIndex++;row.lastAction.checkpointAdvanced=true;}
   if(!result.ok){if(s.status==='playing'){s.status='paused';s.epoch++;}s.error=result.error;}
  });
  if(!result.ok||row.session.status!=='playing')this.emit(row);
 }
 async recordTutorialSave(scope,op,payload,value){
  if(!this.isDemo(payload.projectId))return;const {row}=await this.verify(payload.projectId),pending=row.inflight;
  if(!pending||pending.status!=='accepted'||pending.generation!==scope.generation||pending.viewId!==scope.viewId||pending.relPath!==payload.relPath||pending.sessionId!==row.session.id||pending.epoch!==row.session.epoch||row.session.status!=='playing'||!['document.edit','word.edit','sheet.edit'].includes(pending.command))return;
  if(!['file.save','word.save','sheet.save'].includes(op)||!Object.hasOwn(row.expectedFiles,payload.relPath))return;
  const before=payload.baseDigest,after=value?.digest;if(before!==row.expectedFiles[payload.relPath]||typeof after!=='string')return;
  const located=await this.host.resolveFile(await this.host.requireProject(payload.projectId),payload.relPath);if(located.missing||digest(await fs.readFile(located.abs))!==after)return;
  await this.mutate(()=>{if(row.inflight?.requestId===pending.requestId&&row.session.epoch===pending.epoch)row.expectedFiles[payload.relPath]=after;});
 }
 result(scope,payload){return this.workspace.demoActionResult(scope,payload,this);}
 page(row,{cursor,limit=100}){if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw fail('DEMO_PAGE_INVALID','消息分页无效。');let before=Infinity;if(cursor!=null){if(typeof cursor!=='string'||!/^before:\d+$/.test(cursor))throw fail('DEMO_PAGE_INVALID','游标无效。');before=Number(cursor.slice(7));if(!Number.isSafeInteger(before))throw fail('DEMO_PAGE_INVALID','游标无效。');}const all=row.projection.messages.filter(m=>m.sequence<before),entries=all.slice(-limit);return {version:1,source,demo:true,entries:clone(entries),deltas:[],hasMore:all.length>entries.length,nextCursor:all.length>entries.length?'before:'+entries[0].sequence:null};}
 async freezeMaterials(projectId,payload){
  const refs=payload.tags??[],images=payload.context?.imageAttachments??[];
  if(!Array.isArray(refs)||refs.length>20||!Array.isArray(images)||images.length>8)throw fail('DEMO_INPUT_INVALID','备注最多20项，图片最多8张。');
  const packets=[];for(const ref of refs)packets.push(await this.host.tagMaterial(projectId,ref));
  const snapshot=packets.length?tagMaterialSnapshot(packets):null;
  if(snapshot){const object=await this.host.storage.putObject(projectId,Buffer.from(snapshot.full));if(object.digest!==snapshot.version)throw fail('DEMO_MATERIAL_MISMATCH','冻结材料摘要不一致。');}
  const assets=preferredRegionAssets(packets);
  if(assets.length+images.length>8)throw fail('DEMO_INPUT_INVALID','每次最多8张冻结图片。');
  const attachments=[],drawingSources=[];let imageBytes=0;
  for(const asset of assets){
   const bytes=await this.host.storage.readObject(projectId,asset.digest);imageBytes+=bytes.length;
   if(bytes.length>8*1024*1024||imageBytes>24*1024*1024)throw fail('DEMO_INPUT_INVALID','冻结图片超过大小限制。');
   const packet=packets.find(packet=>packet.information?.assets?.some(item=>item.digest===asset.digest));
   const sources=[{sourceId:'annotation:'+packet.tagId,projectId,relPath:packet.relPath,annotationId:packet.tagId,materialDigest:packet.origin.materialDigest,locationStatus:packet.resolution?.locationStatus,location:packet.information?.location?.label}];
   const ref=await this.host.attachMaterial({projectId,name:path.basename(packet.relPath).slice(0,180)+'-选区.png',mime:'image/png',source:'drawing',bytes:bytes.toString('base64')});
   const promoted=await this.host.attachments.promote(projectId,ref,{sources});attachments.push(promoted);drawingSources.push({digest:promoted.digest,sourceManifest:promoted.sourceManifest,sources});
  }
  for(const ref of images){
   const sources=await this.host.drawingImageSources(projectId,ref),promoted=await this.host.attachments.promote(projectId,ref,{sources});
   if(promoted.mime!=='image/png'||promoted.source!=='drawing')throw fail('DEMO_INPUT_INVALID','仅支持已登记的涂鸦 PNG。');
   imageBytes+=promoted.size;if(imageBytes>24*1024*1024)throw fail('DEMO_INPUT_INVALID','冻结图片超过24MiB。');
   attachments.push(promoted);drawingSources.push({digest:promoted.digest,sourceManifest:promoted.sourceManifest,sources});
  }
  const materialSources=packets.map(packet=>({relPath:packet.relPath,annotationId:packet.tagId,materialDigest:packet.origin.materialDigest,quote:packet.origin.anchor?.quote||'',location:packet.information?.location?.label||'',changed:packet.resolution?.targetDigest!==packet.origin.materialDigest}));
  return {material:snapshot?{version:snapshot.version,binding:snapshot.binding,reusable:snapshot.reusable}:null,materialSources,attachments,drawingSources};
 }
 async send(payload){
  this.host.storage.assertActive(payload.projectId);
  const {row}=await this.verify(payload.projectId);if(typeof payload.text!=='string'||!payload.text.trim()||payload.text.length>32000)throw fail('DEMO_INPUT_INVALID','请输入演示问题。');if(payload.target&&!['frontdesk','orchestrator'].includes(payload.target))throw fail('DEMO_TARGET_INVALID','演示内容没有原生 Worker 会话。');
  if(payload.sessionId!==undefined)await this.bound(payload);
  const key=payload.requestKey??randomUUID(),fingerprint=digest(JSON.stringify([payload.text,payload.target??'frontdesk',payload.tags??[],payload.context?.imageAttachments??[]]));
  let idempotent=null,committed=false;
  // prior-check lives INSIDE the serialized transaction: concurrent sends with
  // the same requestKey commit exactly one pair; the loser returns the same receipt.
  await this.mutate(async()=>{
   const prior=row.requests[key];if(prior){if(prior.fingerprint!==fingerprint)throw fail('DEMO_REQUEST_COLLISION','发送身份已用于不同内容。');idempotent=prior.result;return;}
   const frozen=await this.freezeMaterials(payload.projectId,payload);
   const id=randomUUID(),at=new Date().toISOString(),target=payload.target??'frontdesk';
   const first=row.projection.messages.length+1,common={source,demo:true,sessionId:row.session.id,requestId:id,jobId:id,target,at,durable:true,complete:true,status:'completed',availability:'available'};
   if(row.projection.messages.length+2>recordLimit)throw fail('DEMO_HISTORY_FULL','演示会话已达记录上限，记录已保留，可以随时结束。');row.projection.messages.push({...common,id:randomUUID(),speaker:'user',text:payload.text,sequence:first,materialSources:frozen.materialSources,attachments:frozen.attachments,drawingSources:frozen.drawingSources},{...common,id:randomUUID(),speaker:'agent',text:fixedReply,sequence:first+1});
   const result={accepted:true,source,demo:true,jobId:id,requestId:id,sessionId:row.session.id};row.requests[key]={fingerprint,result,material:frozen.material};idempotent=result;
   committed=true;
  });
  if(committed)this.emit(row);
  if(idempotent)return clone(idempotent);throw fail('DEMO_SEND_UNSETTLED','发送未落账；请重试。');
 }
 async notice(row,semantic){
  const text=demoNotices[semantic];if(typeof text!=='string')throw fail('DEMO_SEMANTIC_INVALID','未定义的演示通知。');
  if(row.projection.messages.some(message=>message.requestId===semantic))return {noticed:true,already:true};
  await this.mutate(()=>{if(row.projection.messages.length+1>recordLimit)throw fail('DEMO_HISTORY_FULL','演示会话已达记录上限，记录已保留，可以随时结束。');row.projection.messages.push({id:randomUUID(),source,demo:true,sessionId:row.session.id,requestId:semantic,jobId:semantic,target:'frontdesk',at:new Date().toISOString(),speaker:'agent',text,sequence:row.projection.messages.length+1,durable:true,complete:true,status:'completed',availability:'available'});});
  this.emit(row);return {noticed:true};
 }
 async publishFixture(row,payload){
  const stepId=payload.args?.stepId??'manual-report',prior=row.projection.todos.find(todo=>todo.demoStepId===stepId);
  if(prior)return {source,demo:true,todoId:prior.id};
  const bytes=await fs.readFile(path.join(row.root,'report.html'));
  if(digest(bytes)!==row.expectedFiles['report.html'])throw fail('DEMO_CONTENT_CHANGED','示例报告已修改，文件保留，自动展示已暂停。');
  const object=await this.host.storage.putObject(row.projectId,bytes),id=randomUUID(),objectId=randomUUID(),at=new Date().toISOString();
  await this.mutate(()=>{
   row.reports??={};row.reports[objectId]={digest:object.digest,byteLength:bytes.length,title:fixtureTitles[payload.args?.semantic]??'【演示内容】方法比较报告'};
   row.projection.todos.push({id,kind:'result',status:'open',source,demo:true,title:fixtureTitles[payload.args?.semantic]??'【演示内容】方法比较报告',revision:1,managementRevision:0,objectId,demoStepId:stepId,text:'固定教学样本；没有执行真实 Worker。查看或稍后处理不表示接受。',createdAt:at});
  });
  this.emit(row);return {source,demo:true,todoId:id};
 }
 async reportSource(projectId,objectId){
  const {row}=await this.verify(projectId);
  if(!Object.hasOwn(row.reports??{},objectId))throw fail('DEMO_REPORT_MISSING','此报告不是本项目登记的冻结演示材料。');
  const report=row.reports[objectId];
  return {report:{objectId,format:'html-static',mime:'text/html',title:report.title,source,demo:true,digest:report.digest,byteLength:report.byteLength},read:()=>this.host.storage.readObject(projectId,report.digest),readManifest:async()=>({references:[]})};
 }
 async managed(op,payload){
  const {row}=await this.verify(payload.projectId),action=op.replace(/^managed\./,'');
  if(['status','connect','enable','project.active'].includes(action))return {enabled:true,ready:false,demo:true,source,state:this.projection(row),session:clone(row.session),connectionError:null,handoff:null};
  if(['send','task'].includes(action))return this.send(payload);
  if(action==='draft'){if(typeof payload.text!=='string'||payload.text.length>32000)throw fail('DEMO_INPUT_INVALID','草稿无效。');await this.mutate(()=>{row.projection.drafts[payload.target??'frontdesk']=payload.text;});return {saved:true,source,demo:true};}
  if(action==='timeline.page')return this.page(row,payload);
  if(action==='timeline.request')return {ids:row.projection.messages.filter(m=>m.requestId===payload.requestId&&m.speaker==='agent').map(m=>m.id),nextOffset:null,source,demo:true};
  if(action==='timeline.read'){const entry=row.projection.messages.find(m=>m.id===payload.id);if(!entry)throw fail('DEMO_MESSAGE_MISSING','演示消息不存在。');return {entry:clone(entry),source,demo:true};}
  if(action==='history.list')return {items:[],nextOffset:null,version:1,source,demo:true};
  if(action==='history.read'){const report=await this.reportSource(payload.projectId,payload.objectId);return {report:report.report,body:(await report.read()).toString('utf8'),source,demo:true};}
  if(action==='attention.ack'){await this.mutate(()=>{for(const todo of row.projection.todos)if(payload.ids?.includes(todo.id))todo.notified=true;});return {accepted:true,source,demo:true};}
  if(action==='todo.manage'){
   const todo=row.projection.todos.find(todo=>todo.id===payload.todoId);if(!todo)throw fail('DEMO_TODO_MISSING','演示待办不存在。');
   if(!['close','reopen','remove','demo-accept','demo-discard'].includes(payload.action))throw fail('DEMO_ACTION_DENIED','无效的演示待办操作。');
   await this.mutate(()=>{
    if(payload.expectedRevision!==undefined&&payload.expectedRevision!==(todo.managementRevision||0))throw fail('DEMO_TODO_STALE','演示事项已经变化，请重新查看。');
    if(payload.action==='remove')row.projection.todos=row.projection.todos.filter(item=>item!==todo);
    else if(payload.action.startsWith('demo-')){
     if(todo.status!=='open')throw fail('DEMO_TODO_STALE','演示事项已有决定，不会重复处理。');
     const choice=payload.action==='demo-accept'?'accept':'discard';todo.status=choice==='accept'?'resolved':'cancelled';todo.resolution={source,demo:true,choice,note:'仅处理固定演示结论；不改变真实任务或论文。'};todo.settledAt=new Date().toISOString();
    }else todo.status=payload.action==='close'?'closed':'open';
    todo.managementRevision=(todo.managementRevision||0)+1;
   });
   this.emit(row);return {accepted:true,source,demo:true,status:todo.status,managementRevision:todo.managementRevision};
  }
  throw fail('DEMO_NATIVE_DISABLED','此项目为离线演示副本；不会启动原生 Agent、模型、终端或真实任务。');
 }
 async exit(payload){
  const row=this.row(payload.projectId);
  if(payload.sessionId!==row.session.id)throw fail('DEMO_SESSION_STALE','演示会话已变化。');
  if(row.removed)return {removed:true,projectId:row.projectId};
  await this.mutate(()=>{row.session.status='stopped';row.session.epoch++;});this.emit(row);
  return this.lifecycle.removeProject(row.projectId,{operationId:'demo-exit:'+row.session.id});
 }
 async cleanupPreview(payload){const {row}=await this.bound(payload);const changes=await compareDemoFiles(row.root,row.expectedFiles);const lifecycle=await this.lifecycle.preview({projectId:row.projectId,action:payload.action??'delete-project'});return {...this.public(row),changes,preserveByDefault:changes.length>0,requiresUserConfirmation:true,canAutomaticallyDelete:false,lifecycle};}
 async guardLifecycle(projectId,{allowChanged=false,allowPending=false}={}){const {row}=await this.verify(projectId);await this.pauseProject(projectId,'项目清理已暂停演示。');if(row.inflight&&!allowPending)throw fail('DEMO_ACTION_PENDING','演示动作尚未核实，不能清理。');const changes=await compareDemoFiles(row.root,row.expectedFiles);if(changes.length&&!allowChanged)throw fail('DEMO_USER_CONTENT_RETAINED','副本存在修改或新增内容，默认保留文件；请重新预览并明确确认整个目录范围。');return changes;}
 async recordLifecycle(projectId,result){if(!this.isDemo(projectId))return;const row=this.row(projectId);await this.mutate(()=>{row.cleanup=clone(result);if(result?.removed||result?.trashed){if(result.action==='remove'&&row.inflight){row.lastAction={...row.inflight,status:'unknown',preservedOnExit:true};delete row.inflight;}row.removed=true;row.session.status='removed';}else row.session.status='stopped';row.session.epoch++;});this.emit(row);}
 async invoke(scope,op,payload){
  if(payload.projectId&&scope.projectId!==payload.projectId&&!(scope.role==='shell'&&(op==='demo.state'||op==='demo.exit'||op==='demo.transition'&&payload.action==='stop')))throw fail('DEMO_SCOPE_DENIED','演示请求不属于当前项目。');
  if(op==='demo.interrupt'){if(scope.projectId!==payload.projectId)throw fail('DEMO_SCOPE_DENIED','只能从原演示项目暂停。');await this.bound(payload);if(payload.reason==='pointermove'){const origin=this.pointerOrigins.get(payload.projectId),current=this.workspace?.screen?.getCursorScreenPoint?.();if(origin&&current&&origin.x===current.x&&origin.y===current.y)return this.state(payload);}await this.pauseProject(payload.projectId,payload.reason);return this.state(payload);}
  if(op==='demo.create'){if(scope.role!=='shell')throw fail('DEMO_SCOPE_DENIED','只能从主窗创建演示。');const projectId=scope.projectId;return this.create({...payload,returnProjectId:projectId&&!this.isDemo(projectId)?projectId:this.data.projects[projectId]?.returnProjectId??null});}
  if(op==='demo.state')return this.state(payload);
  if(op==='demo.exit'){if(scope.role!=='shell')throw fail('DEMO_SCOPE_DENIED','只能从主窗结束演示。');return this.exit(payload);}
  if(op==='demo.result')return this.result(scope,payload);
  if(op==='demo.transition')return this.transition(payload);
  if(op==='demo.send')return this.send(payload);
  if(op==='demo.perform')return this.perform(scope,payload);
  if(op==='demo.cleanupPreview'){if(scope.role!=='shell')throw fail('DEMO_SCOPE_DENIED','只能从主窗预览清理。');return this.cleanupPreview(payload);}
  throw fail('DEMO_OPERATION_INVALID','未知演示操作。');
 }
}
