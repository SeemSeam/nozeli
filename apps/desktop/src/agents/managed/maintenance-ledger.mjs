import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
const {version}=JSON.parse(await fs.readFile(new URL('../../../package.json',import.meta.url),'utf8'));
const now=()=>new Date().toISOString();
export function maintenanceBoundary(error,{phase}={}){
 const code=String(error?.code??'');
 if(['OMP_TOOLS_DIGEST_MISMATCH','PI_TOOLS_DIGEST_MISMATCH','WORKER_CONTEXT_RECOVERY_REQUIRED'].includes(code))return true;
 // Host closure filesystem faults are not new user decisions.
 if(code==='GIT_LOCKED'||phase==='closure'&&['ENOENT','ENOTDIR','EISDIR','EINVAL','ELOOP','ENOSPC','EROFS'].includes(code))return false;
 const guarded=new Set(['USER_DIRTY','INPUT_OVERLAP','TARGET_OVERLAP','HEAD_DRIFT','USER_STAGED','INDEX_CHANGED','SOURCE_CHANGED','IDENTITY_CHANGED','UNPUBLISHED_CHANGES','GIT_BUSY','WORK_BUSY','MISSING_THREAD','OMP_SESSION_FILE_NOT_FOUND','PI_SESSION_FILE_NOT_FOUND','ENOENT','ENOTDIR','EISDIR','EINVAL','ELOOP','ENOSPC','EROFS']);
 return guarded.has(code)||/PERMISSION|EACCES|EPERM|CONFLICT|STALE|CONSENT|AUTHORIZATION|DENIED|DEVIATION|DRAFT|PROCESS_LIMIT|STOPPED|STOPPING|EFFECT_|COLLAB_HOLD|EXIT_UNCONFIRMED|COMMIT|^PROJECT_|^STORAGE_|^REPORT_|^HTML_|^INVALID_|^UNSUPPORTED_/.test(code)||/invalid publication|invalid report|report resource|report image must|成果引用无法核验|missing.*resource|stale or inactive run/i.test(String(error?.message??''));
}
// Structured host-tool failure evidence (schema 1) is provenance, not proof of
// safety: it survives only through this allowlist — known host tool identity,
// explicit stage/effect enums, machine codes, bounded counts and hex digests.
// Unrecognized input is dropped or clamped toward `unknown`; a pre-effect
// (`none`) claim is honored only for the pure offline diagram renderer. Raw
// messages, tool arguments, stacks and free-form labels never enter.
const HOST_TOOL_NAMES=new Set(['nozeli_backstage_respond','nozeli_diagram','nozeli_diagram_schema','nozeli_dispatch','nozeli_document_apply','nozeli_document_create','nozeli_document_read','nozeli_handoff','nozeli_history_read','nozeli_inspect_work','nozeli_maintenance','nozeli_manage','nozeli_memory_read','nozeli_memory_search','nozeli_privileged_execute','nozeli_problem_continue','nozeli_project_list','nozeli_project_search','nozeli_publish','nozeli_report_bug','nozeli_report_deviation','nozeli_report_read','nozeli_source_read']);
const PURE_HOST_TOOLS=new Set(['nozeli_diagram']);
const HOST_TOOL_STAGES=new Set(['render','tool']);
const HOST_TOOL_EFFECTS=new Set(['none','unknown']);
const HOST_TOOL_VALIDATION_KINDS=new Set(['json-schema','render-output','spec-canonicalization','diagram-type','html-embed']);
const DIAGRAM_EVIDENCE_STAGES=new Set(['render','validation']);
// Closed vocabulary mirroring archify-diagram.mjs RULE_CATEGORY (keep in sync).
const DIAGRAM_EVIDENCE_CATEGORIES=new Set(['schema','layout','guided-view','relationship','engineering-profile','brand','type','spec','policy','render-output','output-size','validation']);
const DIAGRAM_RULE_CODE=/^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
const MACHINE_RULE_CODE=/^[a-z0-9][a-z0-9_.-]{0,63}$/;
const HEX_DIGEST=/^[a-f0-9]{64}$/;
const boundedCount=value=>Number.isSafeInteger(value)&&value>=0&&value<=1000000?value:null;
const sanitizeDiagramEvidence=value=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||value.tool!=='nozeli_diagram')return null;
 if(!DIAGRAM_EVIDENCE_STAGES.has(value.stage)||!HOST_TOOL_EFFECTS.has(value.effect)||!DIAGRAM_EVIDENCE_CATEGORIES.has(value.category))return null;
 const rules=[];
 if(Array.isArray(value.rules))for(const row of value.rules){
  if(rules.length>=16)break;
  if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.code!=='string'||!DIAGRAM_RULE_CODE.test(row.code))continue;
  const count=boundedCount(row.count);if(count===null||count<1)continue;
  rules.push({code:row.code,count});
 }
 return {tool:'nozeli_diagram',stage:value.stage,effect:value.effect,category:value.category,...(rules.length?{rules}:{})};
};
export function sanitizeHostToolFailure(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||value.schema!==1)return null;
 if(typeof value.tool!=='string'||!HOST_TOOL_NAMES.has(value.tool)||!HOST_TOOL_STAGES.has(value.stage)||typeof value.callId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.callId))return null;
 // A pre-effect claim is host-provable only for the pure renderer; anything
 // else degrades to `unknown`, never into a safe-effect proof.
 if(!HOST_TOOL_EFFECTS.has(value.effect))return null;
 const effect=value.effect==='none'&&!PURE_HOST_TOOLS.has(value.tool)?'unknown':value.effect;
 const out={schema:1,tool:value.tool,callId:value.callId,stage:value.stage,effect,code:typeof value.code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)?value.code:'HOST_TOOL_ERROR'};
 if(typeof value.validationKind==='string'&&HOST_TOOL_VALIDATION_KINDS.has(value.validationKind))out.validationKind=value.validationKind;
 if(Array.isArray(value.ruleCodes)&&value.ruleCodes.length<=16&&value.ruleCodes.every(code=>typeof code==='string'&&MACHINE_RULE_CODE.test(code)))out.ruleCodes=value.ruleCodes.slice();
 const issueCount=boundedCount(value.issueCount);if(issueCount!==null)out.issueCount=issueCount;
 if(typeof value.argumentsDigest==='string'&&HEX_DIGEST.test(value.argumentsDigest))out.argumentsDigest=value.argumentsDigest;
 const diagramEvidence=sanitizeDiagramEvidence(value.diagramEvidence);if(diagramEvidence)out.diagramEvidence=diagramEvidence;
 return out;
}
// Error messages can contain entire user documents, commands and credentials.
// Persist only a bounded machine code and a host-classified symptom, never raw messages/stacks.
export function maintenanceError(error){
 const raw=String(error?.code??'INTERNAL_FAILURE'),message=String(error?.message??'');
 const symptom=/cannot lock ref|unable to create.*\.lock|another git process/i.test(message)?'git-ref-lock':/snapshot/i.test(message)?'snapshot':/artifact|frozen candidate/i.test(message)?'artifact-publication':/session|spawn|startup/i.test(message)?'session-start':'host-transaction';
 const frames=[];for(const line of String(error?.stack??'').split('\n').slice(1)){const match=/\/apps\/desktop\/(src\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js):\d+:\d+)(?:\)|\s|$)/.exec(line);if(match&&!match[1].includes('..')&&!frames.includes(match[1]))frames.push(match[1]);if(frames.length===8)break;}
 const hostToolFailure=sanitizeHostToolFailure(error?.hostToolFailure);
 return {code:/^[A-Z][A-Z0-9_]{0,79}$/.test(raw)?raw:'INTERNAL_FAILURE',symptom,...(frames.length?{frames}:{}),...(hostToolFailure?{hostToolFailure}:{})};
}
export class MaintenanceLedger{
 constructor(storage,projectId){this.storage=storage;this.projectId=projectId;this.serial=Promise.resolve();}
 async read(){return structuredClone(await this.storage.getLocal(this.projectId,'managed:maintenance')??{schema:1,bugs:[]});}
 mutate(fn){const flight=this.serial.catch(()=>{}).then(async()=>{const state=await this.read();const value=await fn(state);await this.storage.putLocal(this.projectId,'managed:maintenance',state);return structuredClone(value);});this.serial=flight;return flight;}
 record({phase,jobId=null,workId=null,revision=null,error,capability=null,identity=null}){const context=maintenanceError(error),fingerprint=createHash('sha256').update(JSON.stringify({phase,jobId,workId,revision,...context,...(identity?{identity}:{})})).digest('hex');return this.mutate(s=>{let bug=s.bugs.find(b=>b.fingerprint===fingerprint);if(!bug){bug={id:'bug:'+fingerprint,projectId:this.projectId,fingerprint,phase,jobId,workId,revision,error:context,version,platform:os.platform()+'/'+os.arch(),firstSeen:now(),occurrences:0,attempts:[],status:'detected',capability};s.bugs.push(bug);}else if(capability==='same-turn-read-correction'&&bug.status==='repaired'){bug.status='detected';bug.finalizationPending=false;}bug.occurrences++;bug.lastSeen=now();return bug;});}
 attempt(id){return this.mutate(s=>{const b=s.bugs.find(b=>b.id===id);if(!b||b.projectId!==this.projectId||['repaired','finalizing','cancelled','human-boundary'].includes(b.status)||maintenanceBoundary(b.error,{phase:b.phase})||b.attempts.length>=2||b.attempts.some(a=>a.status==='started'))return null;const a={number:b.attempts.length+1,at:now(),status:'started'};b.attempts.push(a);b.status='repairing';return b;});}
 finish(id,{verified=false,outcome='needs-version-fix',finalizationPending=false}={}){return this.mutate(s=>{const b=s.bugs.find(b=>b.id===id&&b.projectId===this.projectId);if(!b||b.status==='repaired')return b??null;const a=b.attempts.at(-1);if(a?.status==='started'){a.status=verified?'verified':'unverified';a.finishedAt=now();a.outcome=outcome;}b.status=verified?(finalizationPending?'finalizing':'repaired'):outcome;b.finalizationPending=verified&&finalizationPending;b.lastOutcome={verified,outcome,at:now()};return b;});}
}
