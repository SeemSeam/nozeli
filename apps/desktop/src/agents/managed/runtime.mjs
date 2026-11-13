import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const here=path.dirname(fileURLToPath(import.meta.url));
export const roles=JSON.parse(await fs.readFile(path.join(here,'roles.json'),'utf8')).roles;
export const FRONTDESK_LEGACY_DEFAULT_SKILLS=Object.freeze(['nozeli-frontdesk-read-material','nozeli-frontdesk-handoff']);
export const FRONTDESK_DEFAULT_SKILLS=Object.freeze([...FRONTDESK_LEGACY_DEFAULT_SKILLS,'nozeli-frontdesk-project-analysis','nozeli-frontdesk-project-progress','nozeli-frontdesk-history-handoff']);
const packages={frontdesk:FRONTDESK_DEFAULT_SKILLS.map(name=>name.slice('nozeli-frontdesk-'.length)),orchestrator:['handoff','followup','clarification','project-maintenance','project-initialization','project-diagnosis'],worker:['report','question','material','task-boundary']};
export async function roleSkillCatalog(role,{skills}={}){
 if(!Object.hasOwn(packages,role))throw Error('unknown role');
 const available=packages[role].map(name=>({name:`nozeli-${role}-${name}`,filePath:path.join(here,roles[role].package,'skills',`nozeli-${role}-${name}`,'SKILL.md')}));
 if(skills!==undefined&&(!Array.isArray(skills)||skills.some(name=>!available.some(row=>row.name===name))))throw Error('unknown role skill');
 const required=role==='worker'?['nozeli-worker-report','nozeli-worker-task-boundary']:[];
 return available.filter(row=>skills===undefined||skills.includes(row.name)||required.includes(row.name));
}
export async function rolePrompt(role,{skills}={}){
 await roleSkillCatalog(role,{skills});
 // Pi's native resource loader supplies the sole metadata catalog. Skill bodies
 // are read by Pi on demand, never concatenated into role or event instructions.
 return fs.readFile(path.join(here,roles[role].package,'memory.md'),'utf8');
}
