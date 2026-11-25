import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {roles} from './runtime.mjs';

export const contextTransfer = 'nozeli-context-transfer';
const catalog = [{id:contextTransfer, name:'工作状态继承', description:'继承 Agent 的上下文与工作状态，以便在 Nozeli 继续开展工作。支持可识别的同项目会话。', revision:1, roles:['frontdesk']}];
const fail = (code,message)=>Object.assign(Error(message),{code});

const matchesSkill=(row,skill,role)=>row.skillId===skill.id&&row.role===role&&row.revision===skill.revision;
const matchesProject=(row,project)=>row.projectId===project.id&&row.instanceId===project.instanceId;
const installed=(state,skill,role)=>state.installs.some(row=>matchesSkill(row,skill,role));
const enabled=(state,skill,role,project)=>Boolean(project?.id&&project.instanceId&&installed(state,skill,role)&&!state.disabled.some(row=>matchesSkill(row,skill,role)&&matchesProject(row,project)));

// Schema 1 stored only positive bindings; their absence did not record a close.
// Schema 2 keeps installations and stores explicit per-instance opt-outs.
export class StoreSkills {
 constructor(file){this.file=file;this.serial=Promise.resolve();}
 enqueue(run){const result=this.serial.then(run);this.serial=result.catch(()=>{});return result;}
 async load(){
  try{
   const state=JSON.parse(await fs.readFile(this.file,'utf8'));
   if(Array.isArray(state.installs)){
    if(state.schema===1&&Array.isArray(state.bindings))return {schema:2,installs:state.installs,disabled:[]};
    if(state.schema===2&&Array.isArray(state.disabled))return state;
   }
   throw Error('资源商店记录格式无效。');
  }catch(error){if(error.code!=='ENOENT')throw error;return {schema:2,installs:[],disabled:[]};}
 }
 async save(state){
  const candidate=this.file+'.'+randomUUID();
  await fs.mkdir(path.dirname(this.file),{recursive:true});
  try{await fs.writeFile(candidate,JSON.stringify(state),{mode:0o600,flag:'wx'});await fs.rename(candidate,this.file);}
  finally{await fs.rm(candidate,{force:true});}
 }
 async invoke(action,p,{project,assertCurrent,active}){
  const keys=action==='list'?['projectId']:['projectId','skillId','role'];
  if(!['list','install','uninstall','enable','disable'].includes(action)||Object.keys(p).some(key=>!keys.includes(key)))throw fail('INVALID_PAYLOAD','资源商店操作或参数无效。');
  const run=async()=>{
   const state=await this.load();assertCurrent();
   const describe=()=>catalog.map(({roles:compatible,...skill})=>({...skill,roles:compatible.filter(role=>Object.hasOwn(roles,role)).map(role=>({id:role,name:roles[role].displayName,installed:installed(state,skill,role),enabled:enabled(state,skill,role,project)}))}));
   if(action==='list')return describe();
   const {skillId,role}=p,skill=catalog.find(row=>row.id===skillId);
   if(typeof role!=='string'||!Object.hasOwn(roles,role)||!skill?.roles.includes(role))throw fail('STORE_ROLE_INCOMPATIBLE','此技能不兼容所选角色。');
   const row={skillId,role,revision:skill.revision},matches=value=>matchesSkill(value,skill,role);
   if(action==='install'){
    if(!state.installs.some(matches))state.installs.push(row);
   }else if(action==='uninstall'){
    if(active(skillId,role))throw fail('STORE_SKILL_IN_USE','此技能正在整理，请等待整理结束后再卸载。');
    state.installs=state.installs.filter(value=>!matches(value));
   }else{
    if(!project?.id||!project.instanceId)throw fail('PROJECT_SCOPE_DENIED','请先打开项目。');
    if(!installed(state,skill,role))throw fail('STORE_SKILL_NOT_INSTALLED','请先为所选角色安装技能。');
    const override=value=>matches(value)&&matchesProject(value,project);
    if(action==='disable'){
     if(!state.disabled.some(override))state.disabled.push({...row,projectId:project.id,instanceId:project.instanceId});
    }else state.disabled=state.disabled.filter(value=>!override(value));
   }
   assertCurrent();await this.save(state);return describe();
  };
  return this.enqueue(run);
 }
 async use(skillId,role,project,assertCurrent,run){
  return this.enqueue(async()=>{
   const skill=catalog.find(row=>row.id===skillId&&row.roles.includes(role));
   const state=await this.load();assertCurrent();
   if(!skill||!Object.hasOwn(roles,role)||!enabled(state,skill,role,project))throw fail('STORE_SKILL_NOT_ENABLED','请在资源商店安装「工作状态继承」，并确认当前项目未关闭此技能。');
   return run();
  });
 }
}
