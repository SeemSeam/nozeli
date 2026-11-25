import {createHash} from 'node:crypto';
import {runGit} from './git-runtime.mjs';

export const capacitySkillPath='skills/paracloud-gpu-capacity/SKILL.md';
export const capacityCapability='paracloud-capacity-v1';
export const jobsCapability='paracloud-jobs-v2';
export const capacityConfigKey='store:paracloud-capacity-v1';
const objectHash=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const sha256=/^[a-f0-9]{64}$/;
const denied=()=>Object.assign(Error('未找到此项目已接受并合入的容量技能成果。'),{code:'STORE_REVIEWED_SKILL_UNAVAILABLE'});

export function reviewedCapacityIdentity(state,workId,objectId){
 const work=state.works.find(row=>row.id===workId),closure=work?.closure,git=closure?.git;
 if(work?.status!=='ended'||closure?.phase!=='complete'||closure.decision!=='accept'||closure.binding?.objectId!==objectId||git?.complete!==true||git.status!=='merged'||!objectHash.test(git.commit??''))return null;
 const receipt=state.receipts.find(row=>row.workId===workId&&row.objectId===objectId&&row.kind==='result');
 if(!receipt?.snapshot?.files?.some(row=>row.relPath===capacitySkillPath))return null;
 const rows=git.operations?.filter(row=>row.relPath===capacitySkillPath)??[];
 const op=rows[0];
 if(rows.length!==1||op.workId!==workId||op.commit!==git.commit||!sha256.test(op.afterDigest??''))return null;
 return {workId,objectId,commit:git.commit,relPath:capacitySkillPath,digest:op.afterDigest};
}

export async function readReviewedCapacity({state,project,workId,objectId,relPath}){
 const provenance=reviewedCapacityIdentity(state,workId,objectId);
 if(!provenance||relPath!==capacitySkillPath)throw denied();
 const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('GIT_'))),GIT_NO_REPLACE_OBJECTS:'1',GIT_LITERAL_PATHSPECS:'1'};
 const options={env,timeout:8000,maxBuffer:32768};
 const tree=(await runGit(project.root,['ls-tree','-z',provenance.commit,'--',relPath],options)).toString('utf8');
 const blob=/^100644 blob ([a-f0-9]{40,64})\t([^\0]+)\0$/.exec(tree);
 if(!blob||blob[2]!==relPath)throw denied();
 const bytes=await runGit(project.root,['cat-file','blob',blob[1]],options);
 if(createHash('sha256').update(bytes).digest('hex')!==provenance.digest)throw denied();
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
 return {text,name:'paracloud-gpu-capacity',description:'ParaCloud 容量查询与作业管理',digest:provenance.digest,capability:jobsCapability,provenance:{instanceId:project.instanceId,...provenance}};
}
