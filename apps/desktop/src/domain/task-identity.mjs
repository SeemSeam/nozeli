import {intakeLineage} from './managed-work-records.mjs';
// Display identity only; never use names, revision numbers or update timestamps.
export function taskIdentityKey(projectId,state,{workId,sourceJobId,workflowId}={}){
 const work=state?.works?.find(work=>work.id===workId);
 const source=work?.sourceJob||sourceJobId;
 const job=state?.jobs?.find(job=>job.id===source&&job.type==='intake');
 const root=job?intakeLineage(state,job)[0]?.id:source;
 return JSON.stringify([projectId,root?'intake:'+root:workId?'work:'+workId:workflowId||'unbound']);
}
export function taskIdentityTone(key){let hash=2166136261;for(const char of String(key)){hash^=char.charCodeAt(0);hash=Math.imul(hash,16777619);}return ['sage','blue','violet','teal','rose','sand'][(hash>>>0)%6];}
