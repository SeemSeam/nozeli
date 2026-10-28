export function dispositionBinding(work){return {workId:work.id,revision:work.revision,objectId:work.result?.objectId??null,candidateCommit:work.execution?.candidate?.commit??null};}
export function sameDispositionBinding(a,b){return Boolean(a&&b&&['workId','revision','objectId','candidateCommit'].every(key=>a[key]===b[key]));}

// ── 合入同意（merge consent）─────────────────────────────────────────────
// 明确永久“永不提交”的窄检测：只认毫无歧义的永久措辞（永不/决不/再也不/
// never commit）。宽泛的“不要/暂时别提交”是临时no-auto-commit暂缓，用户
// 接受即本地合入授权；永久禁入必须经用户可见的版本绑定待办显式确认，
// 绝不靠扫描原文永久veto，也绝不把明确永久禁令静默当作临时。
const EXPLICIT_NEVER_COMMIT=/(?:永不|永远不|永远别|决不|绝不|绝对不|再也不|以后都不?|从今以后不?)\s*(?:要|得|会|能)?\s*(?:提交|commit|做\s*git|git\s*commit)|(?:\bnever\b|\bnot\s+ever\b)\s+(?:git\s+)?commit/i;
export function explicitNeverCommitStatement(text){return typeof text==='string'&&EXPLICIT_NEVER_COMMIT.test(text);}
export const mergeConstraintChoices=['never-commit','hold','none'];
// mergeConstraint（可设置/可撤回，版本绑定）：
//  mode:'unresolved'——检测到明确永久措辞（origin:'detected'）或旧限制无法
//    溯源（origin:'legacy-unresolved'），等待用户一次性选择；此间接受仍可
//    记录决定，但本地合入零写入阻断（可解析，绝不永久veto）。
//  mode:'never-commit'——用户确认“禁止合入直到另行授权”；合入需另经一次性
//    merge-consent覆盖（绑定精确候选）。
//  mode:'hold'|'none'——临时暂缓/无约束；用户接受即本地合入授权。
export function mergeConsentRequirement(work){
  const constraint=work.mergeConstraint;
  if(constraint?.mode==='never-commit')return {required:true,reasonCode:'NO_COMMIT_EXPLICIT',origin:'structured',message:'此任务已按用户明确选择“禁止合入直到另行授权”；接受会记录决定，本地合入还需一次性人工覆盖'};
  // 最新显式策略决定优先：用户确认临时暂缓/无约束后，历史结构化输入标记
  // 不再把合入当作永久禁入（支持设置/撤回，不自动忽略任何一方）。
  if(constraint&&(constraint.mode==='hold'||constraint.mode==='none')&&constraint.resolvedAt)return {required:false,reasonCode:null,origin:null,message:null};
  if((work.inputs||[]).some(i=>i&&i.userAction==='no-commit'))return {required:true,reasonCode:'NO_COMMIT_EXPLICIT',origin:'structured',message:'此工作带有明确的“不提交Git”约束；接受会记录决定，本地合入还需在专门待办中一次性批准（绑定当前候选）'};
  if(constraint?.mode==='unresolved')return constraint.origin==='legacy-unresolved'
    ?{required:true,reasonCode:'NO_COMMIT_LEGACY_UNTRUSTED',origin:'legacy-untrusted',message:'旧版“不提交Git”限制无法溯源；请在待办中一次性确认合入约束策略，原请求不改写'}
    :{required:true,reasonCode:'NO_COMMIT_POLICY_UNRESOLVED',origin:'detected',message:'此任务的原文包含明确“永不提交”表述；请在待办中一次性确认这是永久禁入还是临时暂缓'};
  const merge=work.closure?.merge;
  if(merge?.blockedCode==='USER_NO_COMMIT'||merge?.consentOrigin==='legacy-untrusted')return {required:true,reasonCode:'NO_COMMIT_LEGACY_UNTRUSTED',origin:'legacy-untrusted',message:'旧版“不提交Git”限制无法溯源，未自动解除；本地合入需在专门待办中一次性批准（绑定当前候选）'};
  return {required:false,reasonCode:null,origin:null,message:null};
}

// 合入授权的精确身份字段：接受候选、人工审校版本集、仓库与目标ref一次绑定。
export const mergeConsentBindingFields=['workId','revision','objectId','candidateCommit','reviewVersion','repo','targetRef','targetHead'];
export function mergeConsentBinding(authorization){
  if(!authorization)return null;
  return Object.fromEntries(mergeConsentBindingFields.map(key=>[key,authorization[key]??null]));
}
export function sameMergeConsentBinding(a,b){
  return Boolean(a&&b&&Object.keys(a).length===mergeConsentBindingFields.length&&Object.keys(b).length===mergeConsentBindingFields.length&&mergeConsentBindingFields.every(key=>a[key]===b[key]));
}

// 当前合入同意状态：未结束时预暴露已知阻断与约束策略（暴露在前）；已结束按
// 与决定同事务落账的mergeAuthorization呈现 pending/approved/denied。
export function mergeConsentState(work){
  const requirement=mergeConsentRequirement(work),authorization=work.closure?.mergeAuthorization??null;
  const required=Boolean(authorization?authorization.consentRequired:requirement.required);
  const origin=required?(authorization?.consentOrigin??requirement.origin):null;
  const consent=authorization?.consent??null;
  const status=consent?consent.status:(required&&work.status==='ended'?'pending':null);
  const reasonCode=required?(requirement.reasonCode??(origin==='legacy-untrusted'?'NO_COMMIT_LEGACY_UNTRUSTED':'NO_COMMIT_EXPLICIT')):null;
  return {
    required,
    reasonCode,
    origin,
    message:required?(requirement.message||'本地合入需在专门待办中一次性批准（绑定当前候选）'):null,
    status,
    request:authorization?.request??null,
    constraint:work.mergeConstraint?{mode:work.mergeConstraint.mode,version:work.mergeConstraint.version,origin:work.mergeConstraint.origin,detectedAt:work.mergeConstraint.detectedAt??null,resolvedAt:work.mergeConstraint.resolvedAt??null}:null,
    binding:mergeConsentBinding(authorization),
    approvedAt:consent?.status==='approved'?consent.at:null,
    deniedAt:consent?.status==='denied'?consent.at:null,
  };
}

export function workDisposition(state,work,{localState='available',sessionState='notStarted'}={}){
 const binding=dispositionBinding(work),gate=(allowed,reasonCode,message)=>({allowed,reasonCode,message});
 const ended=work.status==='ended',blocked=work.readOnly===true;
 const jobs=(state.jobs??[]).filter(j=>j.target===work.id&&j.revision===work.revision),receipt=(state.receipts??[]).find(r=>r.workId===work.id&&r.revision===work.revision&&r.objectId===binding.objectId&&r.kind==='result');
 const sourceId=receipt?.sourceJobId??receipt?.jobId,source=jobs.find(job=>job.id===sourceId);
 const transportSettled=job=>(job.collabAttempts??[]).every(attempt=>attempt.definitiveRejection===true||attempt.status==='settled');
 const settled=Boolean(sourceId&&source?.status==='completed'&&receipt?.snapshot?.candidate?.jobId===sourceId&&jobs.every(j=>['completed','cancelled'].includes(j.status)&&transportSettled(j)));
 const accept=blocked?gate(false,'HISTORICAL_SESSION_READ_ONLY','历史执行资源只读'):ended?gate(false,'WORK_ENDED','决定已记录'):!receipt||!binding.candidateCommit||receipt.snapshot?.candidate?.commit!==binding.candidateCommit?gate(false,'RESULT_BINDING_REQUIRED','需要当前版本与冻结候选一致的结果报告'):!settled?gate(false,'TURN_UNSETTLED','执行回合尚未明确成功结算'):gate(true,'LOCAL_VERIFICATION_REQUIRED','可发起接受；宿主将核实来源、进程与Git');
 const discard=blocked?gate(false,'HISTORICAL_SESSION_READ_ONLY','历史执行资源只读'):ended?gate(false,'WORK_ENDED','决定已记录'):gate(true,'LOCAL_VERIFICATION_REQUIRED','可发起丢弃；宿主将核实资源身份与进程');
 const pending=ended&&['accept','discard'].includes(work.closure?.decision)&&work.closure.phase!=='complete';
 const retryClosure=pending&&!work.closure.binding?gate(false,'LEGACY_CONFIRMATION_UNVERIFIED','旧版决定缺少原始确认绑定；决定、证据和资源已保留，不能猜测当前报告后重试'):pending?gate(true,'LOCAL_VERIFICATION_REQUIRED','可重试原决定的技术收尾'):gate(false,'NO_RETRYABLE_CLOSURE','没有待收尾决定');
 return {localState,sessionState,binding,accept,discard,retryClosure,mergeConsent:mergeConsentState(work)};
}
