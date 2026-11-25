import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const here=path.dirname(fileURLToPath(import.meta.url));
export const roles=JSON.parse(await fs.readFile(path.join(here,'roles.json'),'utf8')).roles;
export const FRONTDESK_LEGACY_DEFAULT_SKILLS=Object.freeze(['nozeli-frontdesk-read-material','nozeli-frontdesk-handoff']);
const skillName=(role,name)=>`nozeli-${role}-${name}`;
export const FRONTDESK_DEFAULT_SKILLS=Object.freeze(roles.frontdesk.skills.map(name=>skillName('frontdesk',name)));
export async function roleSkillCatalog(role,{skills}={}){
 if(!Object.hasOwn(roles,role))throw Error('unknown role');
 const spec=roles[role];
 const available=(spec.skills??[]).map(name=>({name:skillName(role,name),filePath:path.join(here,spec.package,'skills',skillName(role,name),'SKILL.md')}));
 if(skills!==undefined&&(!Array.isArray(skills)||skills.some(name=>!available.some(row=>row.name===name))))throw Error('unknown role skill');
 const required=(spec.requiredSkills??[]).map(name=>skillName(role,name));
 return available.filter(row=>skills===undefined||skills.includes(row.name)||required.includes(row.name));
}
export async function rolePrompt(role,{skills}={}){
 await roleSkillCatalog(role,{skills});
 // Pi's native resource loader supplies the sole metadata catalog. Skill bodies
 // are read by Pi on demand, never concatenated into role or event instructions.
 return fs.readFile(path.join(here,roles[role].package,'memory.md'),'utf8');
}
