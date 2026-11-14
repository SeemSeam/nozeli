// Manual paid installed-runtime gate; excluded from automatic test suites.
// --run-real-frontdesk --project <absolute-root> --model <provider/model> --effort low
// Read-only test hooks are not an OS sandbox. Only this run's history is exposed.
import fs from 'node:fs/promises';
import sfs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
const {parseArgs}=await import('node:util');
const {homedir,tmpdir}=await import('node:os');
const observer=process.env.NOZELI_INSTALLED_EVAL_LEDGER;
const values=observer?{}:parseArgs({options:{'run-real-frontdesk':{type:'boolean'},project:{type:'string'},model:{type:'string'},effort:{type:'string'},'history-source':{type:'string'},'max-completions':{type:'string'}}}).values;
if(!observer&&(!values['run-real-frontdesk']||!path.isAbsolute(values.project??'')||!values.model?.includes('/')||!values.effort))throw Error('Require explicit --run-real-frontdesk --project --model --effort');
const completionLimit=observer?JSON.parse(sfs.readFileSync(observer,'utf8')).completionLimit:Number(values['max-completions']??24);
if(!Number.isSafeInteger(completionLimit)||completionLimit<1||completionLimit>24)throw Error('max-completions must be 1–24');
const APP=await fs.realpath(process.env.NOZELI_LARGE_EVALUATION_APP??path.join(homedir(),'.local/opt/nozeli/current/resources/app'));
const ROOT=observer?JSON.parse(sfs.readFileSync(observer,'utf8')).projectRoot:await fs.realpath(values.project);
const SELF=fileURLToPath(import.meta.url);
const sha=x=>createHash('sha256').update(x).digest('hex');
const imp=p=>import(pathToFileURL(path.join(APP,p)).href);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const denied=()=>Object.assign(Error('Evaluation read-only boundary'),{code:'EVAL_EFFECT_BLOCKED'});
const publicRel=rel=>typeof rel==='string'&&!path.isAbsolute(rel)&&!rel.split(/[\\/]/).some(x=>!x||x==='..'||x.startsWith('.')||['node_modules','venv','site-packages','__pycache__','AGENTS.md','CLAUDE.md'].includes(x))&&!/(^|\/)(auth|credentials|secrets)(\.|\/|$)/i.test(rel);
if(process.env.NOZELI_INSTALLED_EVAL_LEDGER){
 const ledger=process.env.NOZELI_INSTALLED_EVAL_LEDGER;
 const get=()=>JSON.parse(sfs.readFileSync(ledger,'utf8'));
 const put=x=>sfs.writeFileSync(ledger,JSON.stringify(x),{mode:0o600});
 const {OwnerRuntime}=await imp('integrations/pi/src/bridge.mjs');
 const start=OwnerRuntime.prototype.start;
 OwnerRuntime.prototype.start=async function(params){
  const result=await start.call(this,params);
  if(!this.roleApi?.on)throw Error('EVAL_NATIVE_GATE_UNAVAILABLE');
  const skills=new Set((params.roleSkillCatalog??[]).map(x=>x.filePath));
  this.roleApi.on('tool_call',async event=>{
   let allowed=event.toolName!=='read',canonical=null,before=null;
   if(event.toolName==='read'){
    allowed=false;
    try{
     const candidate=path.resolve(params.cwd,event.input?.path??'');canonical=await fs.realpath(candidate);
     const state=get();
     const rel=path.relative(ROOT,candidate);
     allowed=canonical===candidate&&(await fs.lstat(candidate)).isFile()&&(skills.has(candidate)||(publicRel(rel)&&candidate.startsWith(ROOT+path.sep)&&(await fs.stat(candidate)).size<=2*1024*1024));
     if(allowed){before=sha(await fs.readFile(candidate));if(Object.hasOwn(state.originalDigests,candidate)&&before!==state.originalDigests[candidate])allowed=false;else if(!Object.hasOwn(state.originalDigests,candidate)){state.originalDigests[candidate]=before;put(state);}}
    }catch{}
    const state=get();state.nativeReads.push({path:canonical,allowed,before,input:event.input,skill:skills.has(canonical),at:new Date().toISOString()});put(state);
   }else if(!event.toolName.startsWith('nozeli_'))allowed=false;
   if(!allowed)return {block:true,reason:'EVAL_NATIVE_SCOPE_DENIED'};
  });
  return result;
 };
 const original=globalThis.fetch;let stopped=false;
 globalThis.fetch=async function(input,init){
  const state=get();
  if(stopped||state.refused||state.count>=completionLimit){state.stopReason=state.count>=completionLimit?'EVAL_HTTP_LIMIT':'EVAL_TRANSPORT_STOPPED';put(state);throw Object.assign(Error('Completion cap reached'),{code:'EVAL_HTTP_LIMIT'});}
  if((init?.method??'GET').toUpperCase()!=='POST'||typeof init?.body!=='string')throw denied();
  const body=JSON.parse(init.body);
  if(body.model!==state.transportModel)throw Error('EVAL_MODEL_CHANGED');
  if('max_completion_tokens'in body)body.max_completion_tokens=Math.min(body.max_completion_tokens??2500,2500);else body.max_tokens=Math.min(body.max_tokens??2500,2500);
  const index=++state.count;state.requests.push({index,model:body.model,maxOutputTokens:body.max_completion_tokens??body.max_tokens,effort:body.reasoning_effort??body.thinking??null,at:new Date().toISOString()});put(state);
  try{const response=await original.call(this,input,{...init,body:JSON.stringify(body)});const fresh=get();fresh.statuses.push({index,status:response.status});if(!response.ok){fresh.refused=true;stopped=true;}put(fresh);return response;}
  catch(error){stopped=true;const fresh=get();fresh.refused=true;fresh.transportError=error.code??'NETWORK_ERROR';put(fresh);throw error;}
 };
}else{
 const out=await fs.mkdtemp(path.join(tmpdir(),'nozeli-large-project-evaluation-'));await fs.chmod(out,0o700);
 const ledger=path.join(out,'http.json'),agentDir=path.join(out,'private-agent');
 const report={schema:3,out,installedApp:APP,contentRoot:ROOT,requested:{model:values.model,effort:values.effort},limits:{completions:completionLimit,inputs:values['history-source']?1:3,perInputMs:120000,maxOutputTokens:2500,retry:false},cases:[],errors:[],cost:'unknown',scope:'Installed runtime; real project; isolated state; test-side guards not an OS sandbox; authentic test-session history only'};
 let host,controller,active;const originals={};
 const remember=async file=>{originals[file]=sha(await fs.readFile(file));};
 try{
  const [{DesktopHost},{Controller},{PiSession},{createFrontdeskDocuments},{roleSkillCatalog},{createProviderHistoryReader},{OwnerRuntime}]=await Promise.all([imp('src/main/host.mjs'),imp('src/agents/managed/controller.mjs'),imp('src/agents/managed/pi-session.mjs'),imp('src/agents/managed/frontdesk-documents.mjs'),imp('src/agents/managed/runtime.mjs'),imp('src/agents/managed/provider-history.mjs'),imp('integrations/pi/src/bridge.mjs')]);
  const catalog=await roleSkillCatalog('frontdesk');for(const row of catalog)await remember(row.filePath);
  const moduleFiles=['src/agents/managed/controller.mjs','src/agents/managed/pi-session.mjs','src/agents/managed/runtime.mjs','integrations/pi/src/bridge.mjs','package.json'];for(const rel of moduleFiles)await remember(path.join(APP,rel));
  report.installedVersions=JSON.parse(await fs.readFile(path.join(APP,'package.json'),'utf8')).version;
  report.skillCatalog=await Promise.all(catalog.map(async row=>({...row,digest:originals[row.filePath],metadata:(await fs.readFile(row.filePath,'utf8')).split('---')[1]})));
  host=new DesktopHost(path.join(out,'profile'));
  const project=await host.storage.register(ROOT);
  const {ManagedProjects}=await imp('src/agents/managed-projects.mjs');
  const manager=Object.create(ManagedProjects.prototype);manager.host=host;
  const resolveRegisteredProject=value=>manager.resolveRegisteredProject(project.id,value);
  const resolved=await resolveRegisteredProject(ROOT);
  if(resolved.projectId!==project.id||resolved.root!==ROOT)throw Error('EVAL_PROJECT_RESOLUTION_FAILED');
  const documents=createFrontdeskDocuments({host,projectId:project.id,sync:async()=>()=>{}});
  const probeId=randomUUID(),actor={id:'nozeli:frontdesk:'+probeId,kind:'agent1',role:'frontdesk',sessionId:probeId,sessionInstance:probeId,requestId:probeId,sourceJobId:probeId};
  const preflight=await documents({op:'list',arguments:{relPath:'',limit:1},actor,isActive:()=>true});
  if(!preflight.ok)throw Object.assign(Error('EVAL_PROJECT_LIST_PREFLIGHT_FAILED'),{code:preflight.error?.code});
  report.preflight={resolver:'installed ManagedProjects.resolveRegisteredProject',projectId:resolved.projectId,root:resolved.root,list:preflight};
  await fs.mkdir(agentDir,{mode:0o700});for(const name of ['models.json','auth.json']){await fs.copyFile(path.join(homedir(),'.Nozeli/pi',name),path.join(agentDir,name));await fs.chmod(path.join(agentDir,name),0o600);}
  await fs.writeFile(path.join(agentDir,'settings.json'),JSON.stringify({retry:{enabled:false},compaction:{enabled:false}}),{mode:0o600});
  const owner=new OwnerRuntime({send:()=>{}});const models=await owner.modelsList({agentDir,cwd:ROOT,home:path.join(out,'catalog-home')});const selected=models.models.find(x=>x.selector===report.requested.model);if(!selected?.authed)throw Error('EVAL_MODEL_NOT_AUTHENTICATED');report.catalog={selector:selected.selector,modelId:selected.modelId,thinkingLevels:selected.thinkingLevels};
  await fs.writeFile(ledger,JSON.stringify({count:0,completionLimit,requests:[],statuses:[],refused:false,nativeReads:[],projectRoot:ROOT,transportModel:selected.modelId,originalDigests:originals}),{mode:0o600});
  const sessionFactory=(spec,target)=>{if(!['frontdesk','orchestrator'].includes(target))throw denied();const session=new PiSession(spec),request=session.request.bind(session);session.request=(method,params={},timeout)=>{if(target!=='frontdesk'&&['prompt','recover'].includes(method))throw denied();return request(method,method==='start'?{...params,nativeTools:['read']}:params,timeout);};return session;};
  controller=await Controller.open({storage:host.storage,projectId:project.id,runtimeRoot:path.join(out,'runtime'),contentRoot:ROOT,sessionFactory,resolveRegisteredProject,frontdeskDocuments:documents,piSource:{agentDir,modelFor:async()=>report.requested.model,roleDefaultsFor:async()=>({selector:report.requested.model,effort:report.requested.effort})},piRuntime:{agentDir,entry:path.join(APP,'integrations/pi/src/owner.mjs'),args:['--import',SELF],env:{NOZELI_INSTALLED_EVAL_LEDGER:ledger,NOZELI_LARGE_EVALUATION_APP:APP}}});
  const roots=Object.fromEntries(['codex','claude','pi'].map(p=>[p,path.join(out,'authentic-history',p)]));for(const root of Object.values(roots))await fs.mkdir(root,{recursive:true,mode:0o700});
  controller.providerHistory=createProviderHistoryReader({projectRoot:ROOT,projectIdentity:project.id+':'+controller.store.state.workspaceId,providerRoots:roots,home:path.join(out,'empty-home')});
  const originalTool=controller.onTool.bind(controller);
  const allow=new Set(['nozeli_source_read','nozeli_project_list','nozeli_project_search','nozeli_document_read','nozeli_project_progress','nozeli_provider_history_search','nozeli_provider_history_read','nozeli_memory_search','nozeli_memory_read','nozeli_history_read']);
  controller.onTool=async(target,p)=>{
   const row={name:p.tool,arguments:p.arguments,at:new Date().toISOString()};active?.tools.push(row);
   if(target!=='frontdesk'||!allow.has(p.tool)){row.blocked=true;throw denied();}
   const a=p.arguments??{};
   if(a.projectId&&a.projectId!==project.id||a.projectPath&&path.resolve(a.projectPath)!==ROOT){row.blocked=true;throw denied();}
   const rel=p.tool==='nozeli_document_read'?a.relPath:p.tool==='nozeli_source_read'&&a.selector?.startsWith('file:')?a.selector.slice(5).replace(/ @offset:\d+$/,''):null;
   if(rel!==null){const file=path.resolve(ROOT,rel);if(!publicRel(rel)||await fs.realpath(file)!==file||!file.startsWith(ROOT+path.sep)||(await fs.stat(file)).size>2*1024*1024){row.blocked=true;throw denied();}if(!Object.hasOwn(originals,file))await remember(file);}
   if(p.tool==='nozeli_project_search'&&!['DeePoly_git/src','DeePoly_git/docs','DeePoly_git/test','DeePoly_git_jianhua_fitting/src'].some(prefix=>(a.relPath??'')===prefix||(a.relPath??'').startsWith(prefix+'/'))){row.blocked=true;throw denied();}
   try{const value=await originalTool(target,p);row.result=value;row.success=value?.ok!==false;row.budget=controller.contextBudget.snapshot(target);return value;}catch(error){row.code=error.code??'TOOL_FAILED';throw error;}
  };
  report.initialWorkCount=controller.store.state.works.length;
  await controller.start();const session=controller.sessions.get('frontdesk');report.appliedSelection={model:session.model,effort:session.effort,thinkingLevels:session.thinkingLevels};report.productionBudget=controller.contextBudget.snapshot('frontdesk');
  const prompts=[
   ['analysis','请原生read读取nozeli-frontdesk-project-analysis技能，分析真实大型deeploy工作区。先列根目录，不递归扫描；区分DeePoly_git主代码、DeePoly_git_jianhua_fitting简化分支、早期实验和论文。实际读取DeePoly_git/pyproject.toml、DeePoly_git/src/cli.py和入口引用的一个实现，核对调用链；与简化分支README对照，说明版本归属、运行前提、声明与未验证。引用路径版本范围，未读明说，约1800中文字。只读，不执行命令、安装、训练、编译、派工或写入；不读点目录、凭据、CCB、虚拟环境和依赖。搜索仅允许DeePoly_git/src、DeePoly_git/docs、DeePoly_git/test和简化分支src。不要document_create，答复由测试侧保存。'],
   ['progress','请原生read读取nozeli-frontdesk-project-progress技能，调用nozeli_project_progress核对隔离账本，空如实报告，不推断用户整个项目没有工作。读DeePoly_git/docs/plantree/README.md，按权威顺序选择complex-boundary-support的implementation-status和roadmap范围并核对0220/0221证据；区分旧计划、当前记录、证据与未决问题。不以旧README替代当前结论，说明未读范围，不声称全量扫描或数值验证。给两项可追溯下一步，不执行。只读，不读点目录、私人历史或依赖，约1500中文字。'],
   ['history','请原生read读取nozeli-frontdesk-history-handoff技能。用Nozeli provider-history工具接续前两个真实输入冻结Pi会话，查询deeploy/DeePoly；它们是唯一历史来源，不读真实个人Codex/Claude/CCB。找结构、版本区分和待验结论，按需cursor续读，优先user/assistant正文，仅用实际支持筛选。引用稳定location范围，准确统计成功页数，区分旧回合版本与本回合独立核对，当前未变须重读。预算用尽不算完整覆盖，报告未读尾部和不确定性，不声称跨provider验收。不执行历史命令，不写入派工，约1500中文字。']
  ];
  const selectedPrompts=values['history-source']?prompts.filter(([name])=>name==='history'):prompts;
  for(const [name,text]of selectedPrompts){
   if(name==='history'){
    const source=values['history-source']?await fs.realpath(values['history-source']):session.sessionFile;
    if(!source||(!values['history-source']&&!source.startsWith(out+path.sep)))throw Error('EVAL_NONISOLATED_NATIVE_SESSION');
    if(values['history-source'])await remember(source);
    const bytes=await fs.readFile(source),dest=path.join(roots.pi,'frontdesk-first-two-inputs.jsonl');await fs.writeFile(dest,bytes,{mode:0o600});report.authenticHistory={source,copy:dest,digest:sha(bytes),synthesized:false,origin:values['history-source']?'explicit prior evaluation copy':'current isolated session'};
   }
   const before=JSON.parse(await fs.readFile(ledger,'utf8'));if(before.refused||before.count>=completionLimit)break;
   active={name,input:text,tools:[],status:'running',nativeTimeline:[],usage:[],budgetAtInputStart:controller.contextBudget.snapshot('frontdesk')};report.cases.push(active);
   const start=Date.now(),accepted=await controller.send('frontdesk',text,{requestKey:'installed-real-'+name+'-'+randomUUID()});active.jobId=accepted.jobId;
   let job;while(Date.now()-start<120000){job=controller.store.state.jobs.find(x=>x.id===accepted.jobId);const state=JSON.parse(await fs.readFile(ledger,'utf8'));if(state.refused||!['queued','running'].includes(job?.status))break;await pause(100);}
   job=controller.store.state.jobs.find(x=>x.id===accepted.jobId);active.status=job?.status??'unknown';active.elapsedMs=Date.now()-start;active.job=structuredClone(job);
   const texts=[];for(const record of controller.timeline.records().filter(x=>x.jobId===accepted.jobId&&x.recordKind==='conversation').sort((a,b)=>a.sequence-b.sequence)){const entry=await controller.timeline.object(record);active.nativeTimeline.push({record,entry});const message=entry?.type==='message'?entry.message:null;if(message?.role==='assistant'){if(message.usage)active.usage.push(message.usage);for(const part of message.content??[])if(part.type==='text')texts.push(part.text);}}
   active.final=texts.join('\n');active.nativeReads=JSON.parse(await fs.readFile(ledger,'utf8')).nativeReads.slice(before.nativeReads.length);active.workCount=controller.store.state.works.length;active.budgetAfter=controller.contextBudget.snapshot('frontdesk');
   await fs.writeFile(path.join(out,name+'-native-answer.md'),active.final,{mode:0o600});await fs.writeFile(path.join(out,name+'-native-timeline.json'),JSON.stringify(active.nativeTimeline,null,2),{mode:0o600});
   if(['queued','running'].includes(active.status)){active.status='timeout';break;}
  }
 }catch(error){report.errors.push({code:error.code??'EVALUATION_FAILED',message:String(error.message).replace(/https?:\/\/[^\s"<>]+/g,'[endpoint]')});}
 finally{
  if(controller){report.finalWorkCount=controller.store.state.works.length;try{await controller.stop();}catch(error){report.errors.push({code:'STOP_FAILED',message:error.code??error.name});}}
  if(host)try{await host.storage.db.close();}catch{report.errors.push({code:'CLOSE_FAILED'});}
  await fs.rm(agentDir,{recursive:true,force:true});report.credentialCopiesRemoved=!sfs.existsSync(agentDir);
  try{const http=JSON.parse(await fs.readFile(ledger,'utf8'));for(const [file,before]of Object.entries(http.originalDigests??{}))if(!Object.hasOwn(originals,file))originals[file]=before;delete http.originalDigests;report.http=http;await fs.writeFile(ledger,JSON.stringify(http,null,2),{mode:0o600});}catch{}
  report.digests=await Promise.all(Object.entries(originals).map(async([file,before])=>{let after=null;try{after=sha(await fs.readFile(file));}catch{}return {file,before,after,unchanged:before===after};}));report.originalsUnchanged=report.digests.every(x=>x.unchanged);
  report.attemptedInputs=report.cases.length;report.unrunInputs=['analysis','progress','history'].filter(x=>!report.cases.some(c=>c.name===x));report.usage=report.cases.flatMap(c=>c.usage);report.cost='unknown; SDK token usage does not establish settled billing';
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log('EVIDENCE_ROOT='+out);console.log(JSON.stringify({cases:report.cases.map(c=>({name:c.name,status:c.status,tools:c.tools.map(t=>t.name)})),errors:report.errors,http:report.http?.count,originalsUnchanged:report.originalsUnchanged,credentialCopiesRemoved:report.credentialCopiesRemoved}));
  if(report.errors.length||report.cases.length!==report.limits.inputs||report.cases.some(row=>row.status!=='completed'))process.exitCode=1;
 }
}
