import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
const {version}=JSON.parse(await fs.readFile(new URL('../../../package.json',import.meta.url),'utf8'));
const now=()=>new Date().toISOString();
export function maintenanceBoundary(error){
 const code=String(error?.code??'');
 if(code==='OMP_TOOLS_DIGEST_MISMATCH'||code==='WORKER_CONTEXT_RECOVERY_REQUIRED')return true;
 const guarded=new Set(['USER_DIRTY','INPUT_OVERLAP','TARGET_OVERLAP','HEAD_DRIFT','USER_STAGED','INDEX_CHANGED','SOURCE_CHANGED','IDENTITY_CHANGED','UNPUBLISHED_CHANGES','GIT_BUSY','GIT_LOCKED','WORK_BUSY','MISSING_THREAD','OMP_SESSION_FILE_NOT_FOUND','ENOENT','ENOTDIR','EISDIR','EINVAL','ELOOP','ENOSPC','EROFS']);
 return guarded.has(code)||/PERMISSION|EACCES|EPERM|CONFLICT|STALE|CONSENT|AUTHORIZATION|DENIED|DEVIATION|DRAFT|PROCESS_LIMIT|STOPPED|STOPPING|EFFECT_|COLLAB_HOLD|EXIT_UNCONFIRMED|COMMIT|^PROJECT_|^STORAGE_|^REPORT_|^HTML_|^INVALID_|^UNSUPPORTED_/.test(code)||/invalid publication|invalid report|report resource|report image must|成果引用无法核验|missing.*resource|stale or inactive run/i.test(String(error?.message??''));
}
// Error messages can contain entire user documents, commands and credentials.
// Persist only a bounded machine code and a host-classified symptom, never raw messages/stacks.
export function maintenanceError(error){
 const raw=String(error?.code??'INTERNAL_FAILURE'),message=String(error?.message??'');
 const symptom=/cannot lock ref|unable to create.*\.lock|another git process/i.test(message)?'git-ref-lock':/snapshot/i.test(message)?'snapshot':/artifact|frozen candidate/i.test(message)?'artifact-publication':/session|spawn|startup/i.test(message)?'session-start':'host-transaction';
 const frames=[];for(const line of String(error?.stack??'').split('\n').slice(1)){const match=/\/apps\/desktop\/(src\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js):\d+:\d+)(?:\)|\s|$)/.exec(line);if(match&&!match[1].includes('..')&&!frames.includes(match[1]))frames.push(match[1]);if(frames.length===8)break;}
 return {code:/^[A-Z][A-Z0-9_]{0,79}$/.test(raw)?raw:'INTERNAL_FAILURE',symptom,...(frames.length?{frames}:{})};
}
export class MaintenanceLedger{
 constructor(storage,projectId){this.storage=storage;this.projectId=projectId;this.serial=Promise.resolve();}
 async read(){return structuredClone(await this.storage.getLocal(this.projectId,'managed:maintenance')??{schema:1,bugs:[]});}
 mutate(fn){const flight=this.serial.catch(()=>{}).then(async()=>{const state=await this.read();const value=await fn(state);await this.storage.putLocal(this.projectId,'managed:maintenance',state);return structuredClone(value);});this.serial=flight;return flight;}
 record({phase,jobId=null,workId=null,revision=null,error,capability=null}){const context=maintenanceError(error),fingerprint=createHash('sha256').update(JSON.stringify({phase,jobId,workId,revision,...context})).digest('hex');return this.mutate(s=>{let bug=s.bugs.find(b=>b.fingerprint===fingerprint);if(!bug){bug={id:'bug:'+fingerprint,projectId:this.projectId,fingerprint,phase,jobId,workId,revision,error:context,version,platform:os.platform()+'/'+os.arch(),firstSeen:now(),occurrences:0,attempts:[],status:'detected',capability};s.bugs.push(bug);}bug.occurrences++;bug.lastSeen=now();return bug;});}
 attempt(id){return this.mutate(s=>{const b=s.bugs.find(b=>b.id===id);if(!b||b.projectId!==this.projectId||b.status==='repaired'||b.attempts.length>=2||b.attempts.some(a=>a.status==='started'))return null;const a={number:b.attempts.length+1,at:now(),status:'started'};b.attempts.push(a);b.status='repairing';return b;});}
 finish(id,{verified=false,outcome='needs-version-fix'}={}){return this.mutate(s=>{const b=s.bugs.find(b=>b.id===id);if(!b)return null;const a=b.attempts.at(-1);if(a?.status==='started'){a.status=verified?'verified':'unverified';a.finishedAt=now();a.outcome=outcome;}b.status=verified?'repaired':outcome;b.lastOutcome={verified,outcome,at:now()};return b;});}
}
