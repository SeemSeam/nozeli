export function reviewInlineAvailable(file){
 if(file.candidateOmitted||file.baselineOmitted||file.textOmitted)return false;
 if(file.draft&&typeof file.draft.text!=='string')return false;
 const candidate=typeof file.candidateText==='string'||file.change==='removed'&&file.candidateDigest===null;
 const baseline=typeof file.baselineText==='string'||file.change==='added'&&file.baselineDigest===null;
 return candidate&&baseline;
}
export const reviewVersionAvailable=data=>typeof data?.reviewVersion==='string'&&data.reviewVersion.length>0;
export function reviewStaleMessage(stale){
 if(!stale)return '';
 const code=stale.code||stale.reason||stale.detail?.reason;
 return ({SUPERSEDED:'已有新一轮工作或新发布候选；此旧报告保持冻结，不能继续修改或接受。',WORKTREE_DRIFT:'工作树内容已偏离冻结候选；为保护并发修改，不能继续或接受此版本。'})[code]||'冻结候选状态已变化，不能继续或接受；请核对最新报告。';
}
export const reviewReportOutdated=files=>files.some(file=>file.draft&&file.draft.textDigest!==file.candidateDigest);
