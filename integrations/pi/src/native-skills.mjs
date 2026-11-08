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
  const value=Reflect.get(target,key,target);
  if(['getSettings','getGlobalSettings','getProjectSettings'].includes(key))return ()=>({...value.call(target),packages:[],extensions:[],skills:[],prompts:[],themes:[]});
  return typeof value==='function'?value.bind(target):value;
 }});
}
export async function trustedRoleResources(role,catalog,rolePackageRoot){
 if(!['frontdesk','orchestrator','worker'].includes(role)||!Array.isArray(catalog)||typeof rolePackageRoot!=='string'||!path.isAbsolute(rolePackageRoot))throw invalid('Trusted host role package and catalog are required');
 const names=new Set();
 const allowed=new Map();
 const loaded=[];
 for(const row of catalog){
  const file=path.resolve(row.filePath);
  if(typeof row.name!=='string'||!new RegExp(`^nozeli-${role}-[a-z0-9-]+$`).test(row.name)||file!==path.join(rolePackageRoot,role,'skills',row.name,'SKILL.md')||names.has(row.name))throw invalid('Skill is outside the exact host role catalog');
  names.add(row.name);
  if(realpathSync(file)!==file||!lstatSync(file).isFile())throw invalid('Role skill must be a regular release-package file');
  const result=loadSkillsFromDir({dir:path.dirname(file),source:'nozeli-role-package'});
  if(result.diagnostics.length||result.skills.length!==1||result.skills[0].name!==row.name||path.resolve(result.skills[0].filePath)!==file||allowed.has(file))throw invalid('Invalid or colliding trusted role skill');
  allowed.set(file,row.name);loaded.push(result.skills[0]);
 }
 return {allowed,options:{noSkills:true,noContextFiles:true,noPromptTemplates:true,noExtensions:true,
  additionalSkillPaths:[],additionalExtensionPaths:[],additionalPromptTemplatePaths:[],
  skillsOverride:()=>({skills:loaded,diagnostics:[]}),agentsFilesOverride:()=>({agentsFiles:[]}),
  systemPromptOverride:()=>undefined,appendSystemPromptOverride:()=>[],promptsOverride:()=>({prompts:[],diagnostics:[]})}};
}
export function restrictedPolicy(mode,{maxTurns,maxToolCalls}={}){
 if(mode==null)return null;
 const defaults=mode==='project-initialization'?[12,24]:mode==='project-diagnosis'?[6,12]:null;
 if(!defaults)throw Object.assign(Error('Unknown restricted mode'),{code:'PI_INVALID_PARAMS'});
 const limit=(value,max)=>value===undefined?max:Number.isSafeInteger(value)&&value>0&&value<=max?value:(()=>{throw Object.assign(Error('Invalid restricted budget'),{code:'PI_INVALID_PARAMS'});})();
 return {mode,maxTurns:limit(maxTurns,defaults[0]),maxToolCalls:limit(maxToolCalls,defaults[1]),turns:0,toolCalls:0};
}
export function validateRestrictedTools(policy,tools){
 const names=policy.mode==='project-initialization'?['nozeli_project_inventory','nozeli_project_read','nozeli_project_map']:['nozeli_debug','nozeli_maintenance'];
 if(tools.some(tool=>!names.includes(tool.name)))throw Object.assign(Error('Unrestricted tool in restricted job catalog'),{code:'PI_INVALID_PARAMS'});
 return tools;
}
export function nativeRoleExtension({cwd,resources,getTurn,onApi}){
 return pi=>{
  onApi(pi);
  const nativeRead=createReadTool(cwd);
  pi.registerTool({...nativeRead,execute:async(id,args,signal,onUpdate,ctx)=>{
   const turn=getTurn();
   if(turn?.restricted){
    const file=path.resolve(cwd,args.path??'');
    if(!resources.allowed.has(file)||realpathSync(file)!==file)return {content:[{type:'text',text:'Restricted read permits only the exact trusted role SKILL.md paths.'}],isError:true};
   }
   return nativeRead.execute(id,args,signal,onUpdate,ctx);
  }});
  pi.on('tool_call',async(event,ctx)=>{
   const turn=getTurn(),policy=turn?.restricted;
   if(!policy)return;
   if(++policy.toolCalls>policy.maxToolCalls){turn.limitError=Object.assign(Error('Restricted tool budget exhausted'),{code:'PI_JOB_BUDGET'});ctx.abort();return {block:true,reason:turn.limitError.message};}
   if(event.toolName!=='read'&&!turn.allowedTools.has(event.toolName))return {block:true,reason:'Tool not supplied for this restricted job'};
  });
  pi.on('turn_start',async(_event,ctx)=>{
   const turn=getTurn(),policy=turn?.restricted;
   if(policy&&++policy.turns>policy.maxTurns){turn.limitError=Object.assign(Error('Restricted model-turn budget exhausted'),{code:'PI_JOB_BUDGET'});await ctx.abort();}
  });
 };
}
