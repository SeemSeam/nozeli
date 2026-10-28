import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const here=path.dirname(fileURLToPath(import.meta.url));
export const roles=JSON.parse(await fs.readFile(path.join(here,'roles.json'),'utf8')).roles;
const fixedWorkerSkills=['report.md','task-boundary.md'];
export async function rolePrompt(role,{skills}={}){
 const root=path.join(here,roles[role].package),dir=path.join(root,'skills');
 const available=(await fs.readdir(dir)).filter(f=>f.endsWith('.md')).sort(),selected=skills??available;
 if(!Array.isArray(selected)||selected.some(f=>!available.includes(f)))throw new Error('unknown role skill');
 const files=role==='orchestrator'?['project-maintenance.md']:role==='worker'?[...new Set([...fixedWorkerSkills,...selected.filter(f=>f!=='material.md')])]:selected;
 return [await fs.readFile(path.join(root,'memory.md'),'utf8'),...(await Promise.all(files.map(async f=>`\n## Injected skill: ${f}\n${await fs.readFile(path.join(dir,f),'utf8')}`)))].join('\n');
}

export async function eventSkill(role,type,{skills,boundWork=false,routingQuestion=false}={}){
 const file=role==='orchestrator'&&type==='intake'?(routingQuestion?'clarification.md':boundWork?'followup.md':'handoff.md'):null;
 if(!file||skills&&!skills.includes(file))return '';
 return fs.readFile(path.join(here,roles[role].package,'skills',file),'utf8');
}

export async function readRoleSkill(role,name,{skills}={}){
 if(!Object.hasOwn(roles,role)||!String(name).match(/^[a-z0-9_-]+\.md$/))throw Error('unknown role skill');
 const available=await fs.readdir(path.join(here,roles[role].package,'skills'));
 if(!available.includes(name)||skills&&!skills.includes(name)&&!(role==='worker'&&fixedWorkerSkills.includes(name)))throw Error('role skill not granted');
 const text=await fs.readFile(path.join(here,roles[role].package,'skills',name),'utf8');
 return {name,text,version:(await import('node:crypto')).createHash('sha256').update(text).digest('hex'),readOnly:true,continueTurn:true};
}
