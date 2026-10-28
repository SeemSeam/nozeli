import {createHash} from 'node:crypto';

// 人工审校（managed.review.*）的纯逻辑与durable草稿存储。
// 契约：候选/基线是不可变Git对象；人工草稿是宿主durable记录（recovery库），
// 与业务账本同事务CAS；任何草稿保存都不写worktree/主仓库/模型来源。
export const reviewFail=(code,message)=>{throw Object.assign(Error(message),{code});};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

export const REVIEW_TEXT_MAX_BYTES=2*1024*1024;
export const REVIEW_STORE_MAX_BYTES=12*1024*1024;
export const REVIEW_HISTORY_LIMIT=20;
export const REVIEW_TEXT_INLINE_MAX=1024*1024;
export const REVIEW_REQUEST_KEY=/^[a-zA-Z0-9:_-]{8,160}$/;

// 人工Markdown正文：LF规整、无NUL、受预算约束（与文档管线一致）。
export function normalizeReviewText(text){
  if(typeof text!=='string')reviewFail('INVALID_PAYLOAD','审校正文必须是字符串。');
  const normalized=text.replace(/\r\n?/g,'\n');
  if(normalized.includes('\0'))reviewFail('INVALID_PAYLOAD','审校正文不允许包含NUL字符。');
  if(Buffer.byteLength(normalized,'utf8')>REVIEW_TEXT_MAX_BYTES)reviewFail('REVIEW_TEXT_TOO_LARGE','审校正文超过2MiB上限；请缩减内容。');
  return normalized;
}
export function reviewDraftBytes(text){const bytes=Buffer.from(text,'utf8');return {bytes,digest:sha256(bytes)};}

export function activeDrafts(work){const drafts=work.review?.drafts;return drafts&&typeof drafts==='object'&&!Array.isArray(drafts)?drafts:{};}
export function hasActiveDrafts(work){return Object.keys(activeDrafts(work)).length>0;}

// 审校版本令牌绑定整个Work被审校的文件集：每个候选文件的冻结摘要 + 每个活跃
// 人工草稿的版本与摘要。任何文件的新草稿都会改变令牌，接受/续作回显旧令牌即
// 被拒绝——两文件编辑无法借旧accept漏掉另一个（staleaccept）。
export function computeReviewVersion({workId,revision,candidateCommit,objectId,files}){
  const rows=files.map(f=>[f.relPath,f.candidateDigest??null,f.draftRevision??0,f.draftDigest??null]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  return sha256(Buffer.from(JSON.stringify({schema:1,workId,revision,candidateCommit,objectId,files:rows})));
}

export function draftRecordKey(workId){return 'managed:review-drafts:'+workId;}
export async function readDraftRecord(storage,projectId,workId){
  const record=await storage.getRecovery(projectId,draftRecordKey(workId));
  return record&&typeof record==='object'&&record.files&&!Array.isArray(record.files)?record:{schema:1,workId,files:{}};
}
export async function writeDraftRecord(storage,projectId,workId,record){
  if(Buffer.byteLength(JSON.stringify(record))>REVIEW_STORE_MAX_BYTES)reviewFail('REVIEW_DRAFT_BUDGET','此工作的审校草稿历史超过存储上限；请先继续或接受当前版本，再保存新草稿。');
  await storage.putRecovery(projectId,draftRecordKey(workId),structuredClone(record));
}
// 字节先于账本版本落盘（write-before-state），历史保留旧文本，因此按状态版本
// 一定能解析到对应正文；崩溃留下的孤儿字节不会被引用。
export function draftTextFor(record,relPath,revision){
  const file=record.files?.[relPath];
  if(!file)return null;
  if(file.revision===revision&&typeof file.text==='string')return file.text;
  const hit=(file.history||[]).find(entry=>entry.revision===revision&&typeof entry.text==='string');
  return hit?hit.text:null;
}
export function appendDraftEntry(record,relPath,{revision,text,textDigest,savedAt},keep=[]){
  const file=record.files[relPath]??{revision:0,history:[]};
  let history=[...(file.history||[]),{revision,text,textDigest,savedAt}].slice(-REVIEW_HISTORY_LIMIT);
  // 失败写留下的orphan不得把账本active版本或未完成续作/接受仍引用的正文挤出。
  const keepSet=new Set([...keep,revision].filter(value=>Number.isSafeInteger(value)&&value>=1));
  for(const entry of (file.history||[]))if(keepSet.has(entry.revision)&&!history.some(row=>row.revision===entry.revision))history.push(entry);
  history.sort((a,b)=>a.revision-b.revision);
  return {...record,files:{...record.files,[relPath]:{revision,text,textDigest,savedAt,history}}};
}

// DTO内联正文规则：UTF-8可解码且≤1MiB才内联，否则只给摘要与omitted原因。
export function decodeInline(bytes){
  if(bytes===null)return {text:null,omitted:'absent'};
  if(bytes.length>REVIEW_TEXT_INLINE_MAX)return {text:null,omitted:'size'};
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return {text:null,omitted:'binary'};}
  if(text.includes('\0'))return {text:null,omitted:'binary'};
  return {text,omitted:null};
}

export function reviewMergeProjection(closure){
  const merge=closure?.merge;
  if(!merge)return null;
  return {status:merge.status,targetRef:merge.targetRef??null,commit:merge.commit??null,blockedCode:merge.blockedCode??null,message:merge.message??null,at:merge.at,actor:merge.actor??null,executor:merge.executor??null,completedAt:merge.completedAt??null,attempts:(merge.attempts||[]).slice(-20)};
}
