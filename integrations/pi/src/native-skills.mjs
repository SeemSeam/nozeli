import path from 'node:path';
import {realpathSync,lstatSync} from 'node:fs';
import {loadSkillsFromDir,createReadTool,SettingsManager} from '@earendil-works/pi-coding-agent';

const invalid=message=>Object.assign(Error(message),{code:'PI_SKILL_SCOPE'});
// Keep the SDK's settings/model authority, but never resolve user/project
// packages or instruction resource paths (even before final catalog filtering).
export function roleResourceSettings(settings,cwd,agentDir){
 const manager=settings??SettingsManager.create(cwd,agentDir);
 const resourceGetters=new Set(['getPackages','getExtensionPaths','getSkillPaths','getPromptTemplatePaths','getThemePaths']);
 return new Proxy(manager,{get(target,key){
  if(resourceGetters.has(key))return ()=>[];
  // SDK cache warming can otherwise outlive the tool authority of a turn.
  if(key==='getCacheWarmingMode')return ()=>'off';
  const value=Reflect.get(target,key,target);
  if(['getSettings','getGlobalSettings','getProjectSettings'].includes(key))return ()=>({...value.call(target),packages:[],extensions:[],skills:[],prompts:[],themes:[]});
  return typeof value==='function'?value.bind(target):value;
 }});
}
// Also used before the owner has selected a role: provider/settings discovery
// must not execute project extensions or scan external instruction packages.
export function ownerRuntimeResources(cwd,agentDir,extensions=[],settingsIO=null){
 return {settingsManager:roleResourceSettings(settingsIO?.createSettingsManager(cwd),cwd,agentDir),
  ...(settingsIO?{readSettings:scope=>settingsIO.readRecord(cwd,scope),createPersistentSettingsManager:()=>settingsIO.createSettingsManager(cwd)}:{}),
  loaderOptions:{noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,
   systemPrompt:'',appendSystemPrompt:[],
   additionalExtensionPaths:[],additionalSkillPaths:[],additionalPromptTemplatePaths:[],additionalThemePaths:[],
   extensionFactories:extensions.slice(),
   agentsFilesOverride:()=>({agentsFiles:[]}),systemPromptOverride:()=>undefined,appendSystemPromptOverride:()=>[]},
  resolvePaths:async()=>({extensions:[],skills:[],prompts:[],themes:[]})};
}
export async function trustedRoleResources(role,catalog,rolePackageRoot,roleSkillIO=null){
 if(!['frontdesk','orchestrator','worker','admin'].includes(role)||!Array.isArray(catalog)||typeof rolePackageRoot!=='string'||!path.isAbsolute(rolePackageRoot))throw invalid('Trusted host role package and catalog are required');
 const names=new Set();
 const allowed=new Map();
 const retained=new Map();
 const loaded=[];
 for(const row of catalog){
  const file=path.resolve(row.filePath);
  if(typeof row.name!=='string'||!new RegExp(`^nozeli-${role}-[a-z0-9-]+$`).test(row.name)||file!==path.join(rolePackageRoot,role,'skills',row.name,'SKILL.md')||names.has(row.name))throw invalid('Skill is outside the exact host role catalog');
  names.add(row.name);
  if(roleSkillIO){
   // Registered Windows owners retain bytes and identities first; the SDK
   // parses the staged retained copy and the read tool serves those bytes.
   const entry=await roleSkillIO.readRoleSkill(role,row,rolePackageRoot);
   if(allowed.has(file))throw invalid('Invalid or colliding trusted role skill');
   allowed.set(file,row.name);retained.set(file,entry);loaded.push(entry.skill);
   continue;
  }
  if(realpathSync(file)!==file||!lstatSync(file).isFile())throw invalid('Role skill must be a regular release-package file');
  const result=loadSkillsFromDir({dir:path.dirname(file),source:'nozeli-role-package'});
  if(result.diagnostics.length||result.skills.length!==1||result.skills[0].name!==row.name||path.resolve(result.skills[0].filePath)!==file||allowed.has(file))throw invalid('Invalid or colliding trusted role skill');
  allowed.set(file,row.name);loaded.push(result.skills[0]);
 }
 return {allowed,retained:retained.size?retained:null,readOperations:roleSkillIO?roleSkillIO.readOperations:null,options:{noSkills:true,noContextFiles:true,noPromptTemplates:true,noExtensions:true,noThemes:true,
  systemPrompt:'',appendSystemPrompt:[],
  additionalSkillPaths:[],additionalExtensionPaths:[],additionalPromptTemplatePaths:[],additionalThemePaths:[],
  skillsOverride:()=>({skills:loaded,diagnostics:[]}),agentsFilesOverride:()=>({agentsFiles:[]}),
  systemPromptOverride:()=>undefined,appendSystemPromptOverride:()=>[],promptsOverride:()=>({prompts:[],diagnostics:[]})}};
}
export function restrictedPolicy(mode,{maxTurns,maxToolCalls}={}){
 if(mode==null)return null;
 const defaults=['frontdesk-memory','work-handoff','handoff-worker'].includes(mode)?[48,48]:mode==='project-initialization'||mode==='admin'?[12,24]:mode==='project-diagnosis'?[6,12]:mode==='handoff-dispatch'?[6,6]:null;
 if(!defaults)throw Object.assign(Error('Unknown restricted mode'),{code:'PI_INVALID_PARAMS'});
 const limit=(value,max)=>value===undefined?max:Number.isSafeInteger(value)&&value>0&&value<=max?value:(()=>{throw Object.assign(Error('Invalid restricted budget'),{code:'PI_INVALID_PARAMS'});})();
 return {mode,maxTurns:limit(maxTurns,defaults[0]),maxToolCalls:limit(maxToolCalls,defaults[1]),turns:0,toolCalls:0};
}
export function validateRestrictedTools(policy,tools){
 const handoff=policy.mode==='handoff-dispatch'?['nozeli_handoff_dispatch']:policy.mode==='handoff-worker'?['nozeli_frontdesk_work_memory','nozeli_publish']:null;
 if(handoff){
  if(tools.length!==handoff.length||handoff.some(name=>!tools.some(tool=>tool.name===name)))throw Object.assign(Error('Invalid handoff tool catalog'),{code:'PI_INVALID_PARAMS'});
  return tools;
 }
 if(policy.mode==='frontdesk-memory'||policy.mode==='work-handoff'){
  if(tools.length!==1||tools[0].name!=='nozeli_frontdesk_work_memory')throw Object.assign(Error('Invalid Frontdesk memory tool catalog'),{code:'PI_INVALID_PARAMS'});
  return tools;
 }
 const names=policy.mode==='admin'?['nozeli_admin_registry','nozeli_admin_configuration','nozeli_admin_prepare_defaults','nozeli_admin_suggest_project','nozeli_admin_suggest_settings','nozeli_admin_diagnostics','nozeli_admin_prepare_repair','nozeli_admin_prepare_force_recovery','nozeli_admin_prepare_development']:policy.mode==='project-initialization'?['nozeli_project_inventory','nozeli_project_read','nozeli_project_map']:['nozeli_debug','nozeli_maintenance'];
 if(tools.some(tool=>!names.includes(tool.name)))throw Object.assign(Error('Unrestricted tool in restricted job catalog'),{code:'PI_INVALID_PARAMS'});
 return tools;
}
export function nativeRoleExtension({cwd,resources,definitions=[],getTurn,onApi}){
 return pi=>{
  const nativeRead=createReadTool(cwd,resources?.readOperations?{operations:resources.readOperations()}:undefined);
  onApi(pi,nativeRead);
  for(const definition of definitions)pi.registerTool(definition);
  pi.registerTool({...nativeRead,execute:async(id,args,signal,onUpdate,ctx)=>{
   const turn=getTurn();
   if(turn?.restricted){
    const file=path.resolve(cwd,args.path??'');
    if(!resources.allowed.has(file)||(resources.retained?!resources.retained.has(file):realpathSync(file)!==file))return {content:[{type:'text',text:'Restricted read permits only the exact trusted role SKILL.md paths.'}],isError:true};
   }
   return nativeRead.execute(id,args,signal,onUpdate,ctx);
  }});
  pi.on('tool_call',async(event,ctx)=>{
   const turn=getTurn(),policy=turn?.restricted;
   if(turn?.toolCatalog&&!turn.toolCatalog.tools.some(tool=>tool.name===event.toolName))return {block:true,reason:'Tool is outside the authorized turn catalog'};
   if(!policy)return;
   if(++policy.toolCalls>policy.maxToolCalls){turn.limitError=Object.assign(Error('Restricted tool budget exhausted'),{code:'PI_JOB_BUDGET'});ctx.abort();return {block:true,reason:turn.limitError.message};}
   if(!turn.allowedTools.has(event.toolName)&&(event.toolName!=='read'||['frontdesk-memory','work-handoff','handoff-dispatch','handoff-worker'].includes(policy.mode)))return {block:true,reason:'Tool not supplied for this restricted job'};
  });
  pi.on('turn_start',async(_event,ctx)=>{
   const turn=getTurn(),policy=turn?.restricted;
   if(policy&&++policy.turns>policy.maxTurns){turn.limitError=Object.assign(Error('Restricted model-turn budget exhausted'),{code:'PI_JOB_BUDGET'});await ctx.abort();}
  });
 };
}
